'use strict';
// Responsive screenshot + overflow audit for Canada Careers. Zero extra deps: drives snap chromium over CDP
// via scripts/cdp.js (hand-rolled WebSocket) so real 390px viewports work (the CLI --window-size clamps at ~500px).
//
//   BASE_URL=http://localhost:3900 node scripts/shots.js            # all pages × [390, 768, 1024, 1440]
//   node scripts/shots.js --only=home,jobs --widths=390,1440         # subset (page keys / widths)
//   node scripts/shots.js --url=/some/path                            # one ad-hoc URL (guest)
//
// For every URL × width: Emulation.setDeviceMetricsOverride (mobile + DSF 2 at 390), navigate, wait for load + 1.5s,
// read {scrollWidth, innerWidth, scrollHeight} and flag horizontal overflow (scrollWidth > innerWidth) as FAIL, then
// save a full-page PNG to shots/qa/<key>-<width>.png. Logged-in pages log in over HTTP first (cookie jar) and
// inject the httpOnly cc_session cookie with Network.setCookie. Console errors (Runtime.consoleAPICalled,
// Runtime.exceptionThrown, Log.entryAdded) are collected per page. Writes shots/qa/REPORT.md. Exit 1 on any
// overflow / navigation failure / non-2xx page.

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const fs = require('node:fs');
const path = require('node:path');
const { launchChromium, CDP, request, login, sleep } = require('./cdp');

const BASE = (process.env.BASE_URL || 'http://localhost:3900').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'shots', 'qa');
const WIDTHS_ALL = [390, 768, 1024, 1440];
const MAX_HEIGHT = 8000;            // css px; taller pages are clipped so PNGs stay sane
const SETTLE_MS = 1500;
const PASSWORD = 'Password123!';
const LOGINS = { admin: 'veda@canadacareers.local', employer: 'employer@example.com', consultant: 'consultant@example.com', seeker: 'seeker@example.com' };

const argv = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const WIDTHS = argv.widths ? String(argv.widths).split(',').map(Number).filter(Boolean) : WIDTHS_ALL;

// ---------------------------------------------------------------- page list (key, path, role|null)
// Add a page: push { key, path, as, expect? } here. `as` = null (guest) | employer | consultant | seeker | admin; `expect` = a non-2xx status that is correct for that page; `redirect: true` if landing on another URL is expected.
// {slug} is replaced with a live job slug discovered from /sitemap.xml (or DATABASE_URL as fallback).
function pageList() {
  return [
    { key: 'home', path: '/' }, { key: 'jobs', path: '/jobs' }, { key: 'jobs-search', path: '/jobs?q=nurse&province=SK' },
    { key: 'job-detail', path: '/jobs/{slug}' }, { key: 'about', path: '/about' }, { key: 'contact', path: '/contact' },
    { key: 'employer-landing', path: '/employer' }, { key: 'consultant-landing', path: '/consultant' }, { key: 'jobseeker-landing', path: '/jobseeker' },
    { key: 'privacy', path: '/privacy' }, { key: 'terms', path: '/terms' }, { key: 'not-found', path: '/this-page-does-not-exist', expect: 404 },
    { key: 'login', path: '/login' }, { key: 'signup', path: '/signup' }, { key: 'signup-employer', path: '/signup/employer' },
    { key: 'signup-seeker', path: '/signup/seeker' },
    { key: 'employer-dashboard', path: '/employer/dashboard', as: 'employer' }, { key: 'employer-jobs', path: '/employer/jobs', as: 'employer' },
    { key: 'employer-job-new', path: '/employer/jobs/new', as: 'employer' }, { key: 'employer-profile', path: '/employer/profile', as: 'employer' },
    { key: 'billing', path: '/billing', as: 'employer' }, { key: 'account', path: '/account', as: 'employer' },
    { key: 'consultant-dashboard', path: '/consultant/dashboard', as: 'consultant' }, { key: 'consultant-profiles', path: '/consultant/profiles', as: 'consultant' },
    { key: 'seeker-dashboard', path: '/jobseeker/dashboard', as: 'seeker' }, { key: 'seeker-profile', path: '/jobseeker/profile', as: 'seeker' },
    { key: 'seeker-applications', path: '/jobseeker/applications', as: 'seeker' }, { key: 'seeker-alerts', path: '/jobseeker/alerts', as: 'seeker' },
    { key: 'apply', path: '/jobs/{slug}/apply', as: 'seeker' },
    { key: 'admin', path: '/admin', as: 'admin' }, { key: 'admin-messages', path: '/admin/messages', as: 'admin' },
    { key: 'admin-jobs', path: '/admin/jobs', as: 'admin' },
  ];
}

async function liveJobSlug() {
  try {
    const r = await request(BASE, '/sitemap.xml');
    const m = r.text.match(/<loc>[^<]*\/jobs\/([^<\/]+)<\/loc>/);
    if (m) return m[1];
  } catch (_) {}
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      const r = await pool.query("SELECT slug FROM jobs WHERE status='active' AND expires_at > now() ORDER BY id LIMIT 1"); await pool.end();
      if (r.rows[0]) return r.rows[0].slug;
    } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------- main
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let pages = pageList();
  if (argv.url) pages = [{ key: require('./cdp').slugify(String(argv.url)), path: String(argv.url), as: argv.as || null }];
  if (argv.only) { const keys = String(argv.only).split(','); pages = pages.filter(p => keys.includes(p.key)); }

  let ok = false;
  try { ok = (await request(BASE, '/healthz')).status === 200; } catch (_) {}
  if (!ok) { console.error(`shots: ${BASE} is not reachable (GET /healthz failed)`); process.exit(1); }

  const slug = pages.some(p => p.path.includes('{slug}')) ? await liveJobSlug() : null;
  if (pages.some(p => p.path.includes('{slug}'))) console.log(`live job slug: ${slug || '(none found — {slug} pages will be skipped)'}`);
  pages = pages.filter(p => !(p.path.includes('{slug}') && !slug)).map(p => ({ ...p, path: p.path.replace('{slug}', slug || '') }));

  // Log in once per role over HTTP; keep the raw cc_session cookie for Network.setCookie.
  const sessions = {};
  for (const role of [...new Set(pages.map(p => p.as).filter(Boolean))]) {
    try {
      const s = await login(BASE, LOGINS[role], PASSWORD);
      if (s.ok) sessions[role] = s; else console.log(`login ${role}: FAILED (${s.status}${s.location ? ' → ' + s.location : ''}) — its pages will be captured as guest`);
    } catch (e) { console.log(`login ${role}: threw ${e.message}`); }
  }

  const chrome = await launchChromium();
  console.log(`chromium ${chrome.bin} debugging on :${chrome.port}; base ${BASE}; widths ${WIDTHS.join('/')}`);
  const cdp = await CDP.connect(chrome.port);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Network.enable');
  const host = new URL(BASE).hostname;

  // console capture — attributed to whatever page is being loaded right now
  let consoleBucket = [];
  const push = (kind, text) => consoleBucket.push(`${kind}: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`);
  cdp.on('Runtime.consoleAPICalled', (p) => { if (['error', 'warning', 'assert'].includes(p.type)) push('console.' + p.type, p.args.map(a => a.value ?? a.description ?? a.type).join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => push('exception', (p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text));
  cdp.on('Log.entryAdded', (p) => { if (p.entry.level === 'error' || p.entry.level === 'warning') push('log.' + p.entry.level, `${p.entry.text}${p.entry.url ? ' (' + p.entry.url + ')' : ''}`); });
  let docStatus = null;
  cdp.on('Network.responseReceived', (p) => { if (p.type === 'Document' && docStatus == null) docStatus = p.response.status; });

  const rows = [];   // { key, path, as, width, status, iw, sw, h, overflow, file, errors, err }
  let failures = 0;
  for (const page of pages) {
    const sess = page.as && sessions[page.as];
    for (const width of WIDTHS) {
      const row = { key: page.key, path: page.path, as: page.as || 'guest', width, expect: page.expect, file: `${page.key}-${width}.png` };
      rows.push(row);
      try {
        await cdp.send('Network.clearBrowserCookies');
        if (sess) await cdp.send('Network.setCookie', { name: sess.cookieName, value: sess.cookie, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 844 : width < 1100 ? 1024 : 900, deviceScaleFactor: width < 500 ? 2 : 1, mobile: width < 500, screenWidth: width, screenHeight: width < 500 ? 844 : 1024 });
        if (width < 500) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        consoleBucket = []; docStatus = null;
        const loaded = cdp.waitFor('Page.loadEventFired', 20000);
        const nav = await cdp.send('Page.navigate', { url: BASE + page.path });
        if (nav.errorText) throw new Error('navigate: ' + nav.errorText);
        await loaded.catch(() => { row.note = 'load event timeout'; });
        await sleep(SETTLE_MS);
        const m = await cdp.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth, h: document.documentElement.scrollHeight, bw: document.body ? document.body.scrollWidth : 0, title: document.title, href: location.pathname + location.search })');
        Object.assign(row, { iw: m.iw, sw: Math.max(m.sw, m.bw), h: m.h, title: m.title, status: docStatus, finalPath: m.href });
        row.overflow = row.sw > row.iw;
        // Chrome only reports the FINAL document after a redirect, so a logged-in page bouncing to /login would look like a 200.
        row.redirected = row.finalPath !== page.path && !page.redirect;
        if (row.overflow) {
          // name the widest offenders so the owning agent can fix them without guessing
          row.offenders = await cdp.eval(`(() => { const iw = innerWidth, out = []; for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (r.right > iw + 1 && r.width > 0) out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '') + ' right=' + Math.round(r.right)); } return out.slice(0, 5); })()`);
        }
        const clipH = Math.min(row.h || 800, MAX_HEIGHT);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: clipH, scale: 1 } }, 60000);
        fs.writeFileSync(path.join(OUT, row.file), Buffer.from(shot.data, 'base64'));
        row.errors = consoleBucket.slice();
        const bad = row.overflow || row.redirected || !(page.expect ? row.status === page.expect : row.status >= 200 && row.status < 300);
        if (bad) failures++;
        console.log(`${bad ? 'FAIL' : 'PASS'}  ${page.key.padEnd(22)} ${String(width).padStart(4)}px  status=${row.status ?? '?'}  iw=${row.iw} sw=${row.sw} h=${row.h}${row.overflow ? '  OVERFLOW ' + (row.offenders || []).join(', ') : ''}${row.redirected ? '  REDIRECTED→' + row.finalPath : ''}${row.errors.length ? `  console:${row.errors.length}` : ''}`);
      } catch (e) {
        row.err = e.message; failures++;
        console.log(`FAIL  ${page.key.padEnd(22)} ${String(width).padStart(4)}px  ${e.message}`);
      }
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  cdp.close(); chrome.kill();

  writeReport(rows, Object.keys(sessions));
  console.log(`\n${rows.length - failures}/${rows.length} captures OK, ${failures} FAIL → ${path.join(OUT, 'REPORT.md')}`);
  process.exit(failures ? 1 : 0);
}

function writeReport(rows, roles) {
  const byKey = new Map();
  for (const r of rows) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r); }
  const cell = (r) => r.err ? `ERR` : `${r.overflow ? 'OVERFLOW' : r.redirected ? 'REDIRECT→' + r.finalPath : (r.expect ? r.status === r.expect : r.status >= 200 && r.status < 300) ? 'OK' : 'HTTP ' + r.status}${r.overflow ? ` (${r.sw}>${r.iw})` : ''} ${r.h}px`;
  const lines = [`# QA screenshot report`, '', `- Base: ${BASE}`, `- Generated: ${new Date().toISOString()}`, `- Widths: ${WIDTHS.join(', ')} (390 = mobile, deviceScaleFactor 2)`, `- Logged-in roles: ${roles.join(', ') || 'none (all logins failed)'}`, '',
    `Cell = status + page height. **OVERFLOW** means \`document.scrollWidth > innerWidth\` (horizontal scroll) at that width. PNGs are \`shots/qa/<page>-<width>.png\`.`, '',
    `| page | path | as | ${WIDTHS.map(w => w + 'px').join(' | ')} |`, `|---|---|---|${WIDTHS.map(() => '---').join('|')}|`];
  for (const [key, rs] of byKey) {
    const first = rs[0];
    lines.push(`| ${key} | \`${first.path}\` | ${first.as} | ${WIDTHS.map(w => { const r = rs.find(x => x.width === w); return r ? cell(r) : '—'; }).join(' | ')} |`);
  }
  const overflow = rows.filter(r => r.overflow);
  lines.push('', `## Overflow details (${overflow.length})`, '');
  if (!overflow.length) lines.push('None.');
  for (const r of overflow) lines.push(`- **${r.key} @ ${r.width}px** \`${r.path}\` — scrollWidth ${r.sw} > innerWidth ${r.iw}; widest elements: ${(r.offenders || []).map(o => '`' + o + '`').join(', ') || '(none isolated)'}`);
  const errs = rows.filter(r => r.err);
  lines.push('', `## Navigation / capture errors (${errs.length})`, '');
  if (!errs.length) lines.push('None.');
  for (const r of errs) lines.push(`- ${r.key} @ ${r.width}px \`${r.path}\` — ${r.err}`);
  const withConsole = rows.filter(r => r.errors && r.errors.length);
  lines.push('', `## Console errors / warnings (${withConsole.reduce((n, r) => n + r.errors.length, 0)} on ${withConsole.length} captures)`, '');
  if (!withConsole.length) lines.push('None.');
  for (const r of withConsole) { lines.push(`- **${r.key} @ ${r.width}px** \`${r.path}\``); for (const e of r.errors.slice(0, 8)) lines.push(`  - ${e.replace(/\|/g, '\\|')}`); }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), lines.join('\n') + '\n');
}

main().catch((e) => { console.error('shots: fatal', e); process.exit(1); });
