'use strict';
// QA helper module — ZERO npm dependencies (node:http, node:net, node:child_process only).
//
//  1. A hand-rolled WebSocket client + Chrome DevTools Protocol (CDP) session (class CDP).
//  2. launchChromium(): starts the snap chromium headless with --remote-debugging-port and
//     returns { browser, port, kill }. Profile dir lives under $HOME (snap cannot write /tmp).
//  3. Shared HTTP helpers used by smoke.js AND shots.js: CookieJar, request(), login().
//
// Usage:
//   const { launchChromium, CDP, CookieJar, request, login } = require('./cdp');
//   const chrome = await launchChromium();
//   const cdp = await CDP.connect(chrome.port);        // attaches to the first page target
//   await cdp.send('Page.enable');
//   await cdp.send('Page.navigate', { url: 'http://localhost:3900/' });
//   await cdp.waitFor('Page.loadEventFired', 10000);
//   const { result } = await cdp.send('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true });
//   cdp.close(); chrome.kill();

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------- WebSocket (RFC 6455 client)
class WebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = new URL(url);
    this.buf = Buffer.alloc(0);
    this.frags = [];          // continuation frames
    this.open = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const u = this.url;
      const secure = u.protocol === 'wss:';
      const port = Number(u.port) || (secure ? 443 : 80);
      const key = crypto.randomBytes(16).toString('base64');
      const sock = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
      this.sock = sock;
      sock.setNoDelay(true);
      const onErr = (e) => { if (!this.open) reject(e); else this.emit('error', e); };
      sock.on('error', onErr);
      sock.once(secure ? 'secureConnect' : 'connect', () => {
        sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let head = Buffer.alloc(0);
      const onHead = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const i = head.indexOf('\r\n\r\n');
        if (i < 0) return;
        const status = head.slice(0, i).toString();
        if (!/^HTTP\/1\.1 101/.test(status)) { sock.destroy(); return reject(new Error('WebSocket handshake failed: ' + status.split('\r\n')[0])); }
        const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!status.includes(expect)) { sock.destroy(); return reject(new Error('WebSocket handshake: bad Sec-WebSocket-Accept')); }
        sock.removeListener('data', onHead);
        this.open = true;
        sock.on('data', (d) => this._onData(d));
        sock.on('close', () => { this.open = false; this.emit('close'); });
        if (head.length > i + 4) this._onData(head.slice(i + 4));
        resolve(this);
      };
      sock.on('data', onHead);
    });
  }
  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4;
      if (b.length < off + len) return;                       // wait for the rest of the frame
      let payload = b.slice(off, off + len);
      if (masked) { const k = b.slice(off - 4, off); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= k[i & 3]; }
      this.buf = b.slice(off + len);
      if (op === 0x8) { this.open = false; this._sendFrame(0x8, Buffer.alloc(0)); this.sock.end(); this.emit('close'); return; }
      if (op === 0x9) { this._sendFrame(0xA, payload); continue; }   // ping -> pong
      if (op === 0xA) continue;                                       // pong
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frags.push(payload);
        if (fin) { const msg = Buffer.concat(this.frags); this.frags = []; this.emit('message', msg.toString('utf8')); }
      }
    }
  }
  _sendFrame(op, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | op;
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, body]));
  }
  send(text) { if (!this.open) throw new Error('WebSocket not open'); this._sendFrame(0x1, Buffer.from(text, 'utf8')); }
  close() { if (this.open) { try { this._sendFrame(0x8, Buffer.alloc(0)); } catch (_) {} } this.open = false; try { this.sock.destroy(); } catch (_) {} }
}

// ---------------------------------------------------------------- CDP session
class CDP extends EventEmitter {
  constructor(ws) { super(); this.ws = ws; this.id = 0; this.pending = new Map(); ws.on('message', (m) => this._onMessage(m)); ws.on('close', () => { for (const p of this.pending.values()) p.reject(new Error('CDP connection closed')); this.pending.clear(); this.emit('close'); }); }

  /** Attach to a page target on the given debugging port (creates one if none exists). */
  static async connect(port, { host = '127.0.0.1', timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let targets = null;
    while (Date.now() < deadline) {
      try { targets = await getJson(`http://${host}:${port}/json/list`); break; } catch (_) { await sleep(200); }
    }
    if (!targets) throw new Error(`Chromium debugging port ${port} did not answer within ${timeoutMs}ms`);
    let page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) page = await getJson(`http://${host}:${port}/json/new?about:blank`, 'PUT');
    const ws = await new WebSocket(page.webSocketDebuggerUrl).connect();
    const cdp = new CDP(ws);
    cdp.target = page;
    return cdp;
  }
  _onMessage(text) {
    let msg; try { msg = JSON.parse(text); } catch (_) { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { cdp: msg.error }));
      else p.resolve(msg.result || {});
    } else if (msg.method) {
      this.emit(msg.method, msg.params || {});
      this.emit('event', msg.method, msg.params || {});
    }
  }
  /** send('Page.navigate', { url }) -> result object. Rejects on protocol error or timeout. */
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { method, resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Resolve with the params of the next `event` (optionally filtered). Rejects on timeout. */
  waitFor(event, timeoutMs = 10000, filter = () => true) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.removeListener(event, h); reject(new Error(`timeout waiting for ${event}`)); }, timeoutMs);
      const h = (p) => { if (!filter(p)) return; clearTimeout(t); this.removeListener(event, h); resolve(p); };
      this.on(event, h);
    });
  }
  /** Evaluate a JS expression in the page and return its JSON value. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result && r.result.value;
  }
  close() { this.ws.close(); }
}

// ---------------------------------------------------------------- chromium launcher
function findChromium() {
  for (const c of [process.env.CHROMIUM_BIN, '/snap/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'chromium';
}

/**
 * Start headless chromium with a remote-debugging port. Returns { port, proc, userDataDir, kill() }.
 * The profile dir is under $HOME because the snap cannot write to /tmp.
 */
async function launchChromium({ port = 20000 + Math.floor(Math.random() * 20000), extraArgs = [], timeoutMs = 20000 } = {}) {
  const home = process.env.HOME || os.homedir();
  // NOT a dot-directory: the snap's home interface cannot write hidden top-level dirs like ~/.cache.
  const userDataDir = path.join(home, 'cc-qa-chromium', String(process.pid) + '-' + port);
  fs.mkdirSync(userDataDir, { recursive: true });
  const bin = findChromium();
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, ...extraArgs, 'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-10000); });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) throw new Error(`chromium exited early (${bin}):\n${stderr.slice(-2000)}`);
    try { await getJson(`http://127.0.0.1:${port}/json/version`); break; } catch (_) {}
    if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error(`chromium did not open port ${port} in ${timeoutMs}ms:\n${stderr.slice(-2000)}`); }
    await sleep(250);
  }
  const kill = () => { try { proc.kill('SIGTERM'); } catch (_) {} setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} fs.rm(userDataDir, { recursive: true, force: true }, () => {}); }, 1500).unref(); };
  return { bin, port, proc, userDataDir, kill, stderr: () => stderr };
}

// ---------------------------------------------------------------- HTTP helpers (cookie jar, login)
/** Minimal single-host cookie jar for global fetch(). */
class CookieJar {
  constructor() { this.cookies = new Map(); }
  /** Absorb Set-Cookie headers from a Response. */
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of list) {
      const [pair, ...attrs] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
      const expired = attrs.some(a => /^\s*max-age=\s*0*\s*$/i.test(a) || /^\s*max-age=-/i.test(a) || /^\s*expires=.*1970/i.test(a));
      if (expired || value === '') this.cookies.delete(name); else this.cookies.set(name, value);
    }
  }
  get(name) { return this.cookies.get(name); }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  clear() { this.cookies.clear(); }
}

/**
 * request(base, path, { method, form, body, headers, jar }) -> { status, headers, location, text, res }.
 * Never follows redirects (redirect: 'manual'); `form` is an object sent urlencoded; `body` may be FormData.
 */
async function request(base, url, { method = 'GET', form, body, headers = {}, jar, timeoutMs = 20000 } = {}) {
  const full = /^https?:/.test(url) ? url : base.replace(/\/$/, '') + url;
  const h = { ...headers };
  if (jar && jar.header()) h.cookie = jar.header();
  let payload = body;
  if (form) { payload = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
  if (method !== 'GET' && method !== 'HEAD' && !h.origin) h.origin = new URL(base).origin;   // same-origin guard expects our own origin
  const res = await fetch(full, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  if (jar) jar.absorb(res);
  const text = await res.text();
  return { status: res.status, headers: res.headers, location: res.headers.get('location'), contentType: res.headers.get('content-type') || '', text, res };
}

/**
 * Log in over HTTP with the contract's form (POST /login {email,password,remember}).
 * Returns { ok, status, location, jar, cookie } where cookie is the raw cc_session value (for Network.setCookie).
 */
async function login(base, email, password = 'Password123!', { consumeFlash = true, cookieName = 'cc_session' } = {}) {
  const jar = new CookieJar();
  await request(base, '/login', { jar });                          // prime a session (not strictly required)
  const r = await request(base, '/login', { method: 'POST', form: { email, password, remember: 'on' }, jar });
  const ok = r.status === 302 && !!jar.get(cookieName);
  if (ok && consumeFlash && r.location && !/\/login/.test(r.location)) {
    try { await request(base, r.location, { jar }); } catch (_) {}  // eat the "Welcome back" flash so screenshots are steady
  }
  return { ok, status: r.status, location: r.location, jar, cookie: jar.get(cookieName) || null, cookieName };
}

// ---------------------------------------------------------------- misc
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, timeout: 3000 }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`bad JSON from ${url}: ${d.slice(0, 100)}`)); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end();
  });
}
const slugify = (s) => String(s).replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'home';

// ---------------------------------------------------------------- HTML form helpers (shared by smoke.js / shots.js)
const unescapeHtml = (s) => String(s ?? '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attrOf = (tag, name) => { const r = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, 'i')); return r ? unescapeHtml(r[1] ?? r[2]) : null; };
/**
 * Every <form> in a document → { action, method, fields, html }. `fields` holds the form's current values the way a
 * browser would submit them (inputs, selected <option>, textarea; unchecked checkboxes/radios, file and submit inputs
 * are left out), so a test can re-post a page's own form with one value changed instead of guessing field names.
 */
function parseForms(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = m[1], body = m[2], fields = {};
    for (const i of body.matchAll(/<input\b[^>]*>/gi)) {
      const t = i[0], name = attrOf(t, 'name'); if (!name) continue;
      const type = (attrOf(t, 'type') || 'text').toLowerCase();
      if (['submit', 'button', 'file', 'image', 'reset'].includes(type)) continue;
      if ((type === 'checkbox' || type === 'radio') && !/\schecked(?:\s|=|>|\/)/i.test(t + ' ')) continue;
      fields[name] = attrOf(t, 'value') ?? (type === 'checkbox' ? 'on' : '');
    }
    for (const s of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = attrOf(s[1], 'name'); if (!name) continue;
      const opts = [...s[2].matchAll(/<option\b([^>]*)>/gi)];
      const sel = opts.find(o => /\sselected(?:\s|=|>|\/)/i.test(o[1] + ' ')) || opts[0];
      fields[name] = sel ? (attrOf(sel[1], 'value') ?? '') : '';
    }
    for (const t of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) { const name = attrOf(t[1], 'name'); if (name) fields[name] = unescapeHtml(t[2]); }
    out.push({ action: attrOf(attrs, 'action') || '', method: (attrOf(attrs, 'method') || 'get').toLowerCase(), fields, html: body });
  }
  return out;
}
/** The form whose fields include `fieldName` (or whose action matches a RegExp). */
const findForm = (html, key) => parseForms(html).find(f => key instanceof RegExp ? key.test(f.action) : Object.prototype.hasOwnProperty.call(f.fields, key)) || null;
/** Current value of <input name="x"> (attribute order independent); null when the input is absent. */
function inputValue(html, name) {
  for (const i of String(html || '').matchAll(/<input\b[^>]*>/gi)) if (attrOf(i[0], 'name') === name) return attrOf(i[0], 'value') ?? '';
  const sel = [...String(html || '').matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)].find(s => attrOf(s[1], 'name') === name);
  if (sel) { const o = [...sel[2].matchAll(/<option\b([^>]*)>/gi)].find(o => /\sselected(?:\s|=|>|\/)/i.test(o[1] + ' ')); return o ? (attrOf(o[1], 'value') ?? '') : ''; }
  return null;
}
/** Flash messages rendered by views/partials/flash.ejs. */
const flashes = (html) => [...String(html || '').matchAll(/class="flash flash--(\w+)"[^>]*>([\s\S]*?)<\/div>/g)].map(m => `${m[1]}: ${unescapeHtml(m[2]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}`);

module.exports = { WebSocket, CDP, launchChromium, findChromium, CookieJar, request, login, sleep, getJson, slugify, parseForms, findForm, inputValue, flashes, unescapeHtml };

// `node scripts/cdp.js [url] [width]` — self-test: launch chromium, emulate width, print innerWidth, save a PNG.
if (require.main === module) {
  (async () => {
    const url = process.argv[2] || (process.env.BASE_URL || 'http://localhost:3900') + '/healthz';
    const width = Number(process.argv[3] || 390);
    const out = path.join(__dirname, '..', 'shots', 'qa', `cdp-selftest-${width}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const chrome = await launchChromium();
    console.log(`chromium ${chrome.bin} on port ${chrome.port}`);
    const cdp = await CDP.connect(chrome.port);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: width < 500 ? 2 : 1, mobile: width < 500 });
    const nav = await cdp.send('Page.navigate', { url });
    if (nav.errorText) throw new Error('navigate failed: ' + nav.errorText);
    await cdp.waitFor('Page.loadEventFired', 15000).catch(() => {});
    const m = await cdp.eval('({ iw: innerWidth, sw: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, title: document.title })');
    console.log('page metrics', m);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('wrote', out);
    cdp.close(); chrome.kill();
  })().catch((e) => { console.error(e); process.exit(1); });
}
