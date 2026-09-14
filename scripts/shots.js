'use strict';
// Responsive screenshot + overflow audit for Canada Careers. Zero extra deps: drives snap chromium over CDP
// via scripts/cdp.js (hand-rolled WebSocket) so real 390px viewports work (the CLI --window-size clamps at ~500px).
//
//   BASE_URL=http://localhost:3900 node scripts/shots.js            # all pages × [390, 768, 1024, 1440]
//   node scripts/shots.js --only=home,jobs --widths=390,1440         # subset (page keys / widths)
//   node scripts/shots.js --url=/some/path                            # one ad-hoc URL (guest)
//   node scripts/shots.js --seed-extra                                 # first ensure the DB has the fixtures the new pages need
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
const { launchChromium, CDP, request, login, sleep, findForm } = require('./cdp');

const BASE = (process.env.BASE_URL || 'http://localhost:3900').replace(/\/$/, '');
const OUT = path.join(__dirname, '..', 'shots', 'qa');
const WIDTHS_ALL = [390, 768, 1024, 1440];
const MAX_HEIGHT = 8000;            // css px; taller pages are clipped so PNGs stay sane
const SETTLE_MS = 1500;
const PASSWORD = 'Password123!';
const LOGINS = { admin: 'veda@canadacareers.local', employer: 'employer@example.com', consultant: 'consultant@example.com', seeker: 'seeker@example.com' };
const ADMIN_PASSCODE = process.env.QA_ADMIN_PASSCODE || 'qa-pass-123';   // unlocks /admin/integrations (smoke.js sets the same one; --seed-extra writes it)
const CITY_COORDS = { Mississauga: [43.589, -79.6441], Brampton: [43.7315, -79.7624], Toronto: [43.6532, -79.3832], Saskatoon: [52.1332, -106.67], Vancouver: [49.2827, -123.1207] };

const argv = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const WIDTHS = argv.widths ? String(argv.widths).split(',').map(Number).filter(Boolean) : WIDTHS_ALL;

// ---------------------------------------------------------------- page list (key, path, role|null)
// Add a page: push { key, path, as, expect? } here. `as` = null (guest) | employer | consultant | seeker | admin; `expect` = a non-2xx status that is correct for that page; `redirect: true` if landing on another URL is expected.
// {slug} is replaced with a live job slug discovered from /sitemap.xml (or DATABASE_URL as fallback). {multislug} (a live job
// with >= 2 job_locations), {employerJob} / {consultantJob} (an unpaid draft/pending job owned by that login) and {receiptId}
// (a payment owned by the employer) and {geoslug} (a live job with a geocoded job_locations row) come from DATABASE_URL;
// `--seed-extra` creates them when missing (never on production). `unlock: true` posts the Integrations passcode after the
// admin login so the gated page is captured unlocked (QA_ADMIN_PASSCODE, default qa-pass-123); `locked: true` uses a second, never-unlocked admin session.
// `storage: { key: value }` writes localStorage on the site origin before the page loads (cleared again for the next page).
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
    // client round 2026-09-09: multi-location detail, guest apply interstitial, role-priced checkouts, receipt
    { key: 'job-detail-multi', path: '/jobs/{multislug}' }, { key: 'apply-guest', path: '/jobs/{slug}/apply' },
    { key: 'checkout-employer', path: '/billing/checkout/{employerJob}', as: 'employer' },
    { key: 'checkout-consultant', path: '/billing/checkout/{consultantJob}', as: 'consultant' },
    { key: 'receipt', path: '/billing/receipt/{receiptId}', as: 'employer' },
    { key: 'admin', path: '/admin', as: 'admin' }, { key: 'admin-messages', path: '/admin/messages', as: 'admin' },
    { key: 'admin-jobs', path: '/admin/jobs', as: 'admin' },
    // client round 2 (PDF, 2026-09-10): maps on the job page + search, the passcode-gated integrations panel, admin users, profile address book
    { key: 'job-detail-map', path: '/jobs/{geoslug}' },
    { key: 'jobs-map', path: '/jobs?near=Brampton%2C%20ON&radius_km=50&view=map' },
    { key: 'admin-integrations', path: '/admin/integrations', as: 'admin', unlock: true },
    { key: 'admin-users', path: '/admin/users', as: 'admin' },
    { key: 'profile-locations', path: '/employer/profile#locations', as: 'employer' },
    // round 3 (2026-09-14): locked edit form, closed posting (+ seeker apply closed state), map hidden via localStorage, posting-id search,
    // owner detail/edit of an unpaid draft, applicants, saved jobs, company page, remaining admin pages, consultant job form, locked integrations gate
    { key: 'job-locked-edit', path: '/employer/jobs/{lockedJob}/edit', as: 'employer' },
    { key: 'job-locked-detail', path: '/employer/jobs/{lockedJob}', as: 'employer' },
    { key: 'job-closed', path: '/jobs/{closedslug}' },
    { key: 'job-closed-apply', path: '/jobs/{closedslug}/apply', as: 'seeker' },
    { key: 'jobs-map-hidden', path: '/jobs', storage: { 'cc:jobs-map': 'hide' } },
    { key: 'jobs-search-id', path: '/jobs?q={publicId}' },
    { key: 'employer-job-detail', path: '/employer/jobs/{employerJob}', as: 'employer' },
    { key: 'employer-job-edit', path: '/employer/jobs/{employerJob}/edit', as: 'employer' },
    { key: 'employer-applicants', path: '/employer/applicants', as: 'employer' },
    { key: 'consultant-job-new', path: '/consultant/jobs/new', as: 'consultant' },
    { key: 'seeker-saved', path: '/jobseeker/saved', as: 'seeker' }, { key: 'seeker-notifications', path: '/jobseeker/notifications', as: 'seeker' },
    { key: 'company', path: '/companies/{companySlug}' }, { key: 'forgot', path: '/forgot' }, { key: 'signup-consultant', path: '/signup/consultant' },
    { key: 'admin-payments', path: '/admin/payments', as: 'admin' }, { key: 'admin-outbox', path: '/admin/outbox', as: 'admin' },
    { key: 'admin-integrations-locked', path: '/admin/integrations/unlock', as: 'admin', locked: true },   // a second admin session that was never unlocked
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

/** Resolve the DB-backed placeholders; with seed=true create what is missing (tagged "[qa]" / a second address). */
async function dbFixtures(seed) {
  const out = {};
  if (!process.env.DATABASE_URL) return out;
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const one = (sql, p) => pool.query(sql, p).then(r => r.rows[0] || null);
  try {
    const live = "status='active' AND expires_at > now() AND source IS NULL";
    let multi = await one(`SELECT j.slug FROM jobs j WHERE ${live} AND (SELECT count(*) FROM job_locations l WHERE l.job_id=j.id) >= 2 ORDER BY j.id LIMIT 1`);
    if (!multi && seed) {
      const j = await one(`SELECT id, slug, city, province FROM jobs j WHERE ${live} ORDER BY id LIMIT 1`);
      if (j) { await pool.query('INSERT INTO job_locations(job_id, street_address, unit, city, province, postal_code, sort_order) VALUES ($1,$2,$3,$4,$5,$6,1)', [j.id, '7100 Airport Rd', '12', j.city, j.province, 'L4T 2H3']); multi = j; console.log(`seed-extra: added a second work location to job#${j.id} (${j.slug})`); }
    }
    if (multi) out.multislug = multi.slug;
    for (const [key, email] of [['employerJob', LOGINS.employer], ['consultantJob', LOGINS.consultant]]) {
      const owner = `SELECT id FROM users WHERE email=$1`;
      let j = await one(`SELECT j.id FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE p.owner_user_id=(${owner}) AND p.archived IS NOT TRUE AND j.status IN ('draft','pending_payment') AND j.source IS NULL ORDER BY j.id LIMIT 1`, [email]);
      if (!j && seed) {
        const p = await one(`SELECT id FROM employer_profiles WHERE owner_user_id=(${owner}) AND archived IS NOT TRUE ORDER BY id LIMIT 1`, [email]);
        if (p) {
          j = await one(`INSERT INTO jobs(employer_profile_id, created_by, title, slug, description, category, job_type, work_arrangement, city, province, status)
            SELECT $1, (${owner}), '[qa] Checkout fixture', 'qa-checkout-fixture-' || substr(md5(random()::text), 1, 6), 'Fixture posting for QA screenshots of the checkout page.', 'administration', 'full_time', 'on_site', 'Mississauga', 'ON', 'draft' RETURNING id`, [p.id, email]);
          if (j) { await pool.query('INSERT INTO job_locations(job_id, street_address, city, province, postal_code, sort_order) VALUES ($1,$2,$3,$4,$5,0)', [j.id, '2400 Derry Rd E', 'Mississauga', 'ON', 'L5S 1B1']); console.log(`seed-extra: created draft job#${j.id} for ${email}`); }
        }
      }
      if (j) out[key] = String(j.id);
    }
    // skip payments of smoke.js jobs: a concurrent smoke run deletes them mid-capture
    const pay = await one("SELECT p.id FROM payments p JOIN jobs j ON j.id=p.job_id WHERE p.payer_user_id=(SELECT id FROM users WHERE email=$1) AND j.title NOT LIKE '[smoke]%' ORDER BY p.id DESC LIMIT 1", [LOGINS.employer]);
    if (pay) out.receiptId = String(pay.id);
    // a live job with coordinates (maps): the geocoder (jobs/geocode.js) normally fills these; --seed-extra falls back to city coordinates
    let geo = await one(`SELECT j.slug FROM jobs j JOIN job_locations l ON l.job_id=j.id WHERE ${live} AND l.lat IS NOT NULL ORDER BY j.id LIMIT 1`);
    if (!geo && seed) {
      const l = await one(`SELECT l.id, l.city, j.slug FROM job_locations l JOIN jobs j ON j.id=l.job_id WHERE ${live} AND l.lat IS NULL AND l.city = ANY($1) ORDER BY j.id LIMIT 1`, [Object.keys(CITY_COORDS)]);
      if (l) { const c = CITY_COORDS[l.city]; await pool.query("UPDATE job_locations SET lat=$2, lng=$3, geocoded_at=now(), geocode_provider='manual' WHERE id=$1", [l.id, c[0], c[1]]); geo = l; console.log(`seed-extra: set manual coordinates on job_locations#${l.id} (${l.city}) — run node jobs/geocode.js for real ones`); }
    }
    if (geo) out.geoslug = geo.slug;
    // round 3: a job the employer owns that has been published at least once (jobs.isLocked → the edit form shows the locked fields)
    const ownerJobs = `SELECT j.id, j.slug, j.status FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE p.owner_user_id=(SELECT id FROM users WHERE email=$1) AND p.archived IS NOT TRUE AND j.source IS NULL`;
    let locked = await one(`${ownerJobs} AND (j.locked_at IS NOT NULL OR j.published_at IS NOT NULL) ORDER BY (j.status='active') DESC, j.id LIMIT 1`, [LOGINS.employer]);
    if (!locked && seed) {
      const j = await one(`${ownerJobs} AND j.status='active' AND j.expires_at > now() ORDER BY j.id LIMIT 1`, [LOGINS.employer]);
      if (j) { await pool.query('UPDATE jobs SET locked_at=coalesce(locked_at, now()), published_at=coalesce(published_at, now()) WHERE id=$1', [j.id]); locked = j; console.log(`seed-extra: set locked_at/published_at on job#${j.id} (${j.slug})`); }
    }
    if (locked) out.lockedJob = String(locked.id);
    // round 3: a live posting whose application_deadline has passed ("Applications closed"; still visible until billing expiry). Never the first live job ({slug}).
    let closed = await one(`SELECT j.slug FROM jobs j WHERE ${live} AND j.application_deadline < (now() AT TIME ZONE 'America/Toronto')::date ORDER BY j.id LIMIT 1`);
    if (!closed && seed) {
      const j = await one(`SELECT j.id, j.slug FROM jobs j WHERE ${live} AND j.id <> (SELECT min(id) FROM jobs WHERE ${live}) ORDER BY j.id DESC LIMIT 1`);
      if (j) { await pool.query("UPDATE jobs SET application_deadline=(now() AT TIME ZONE 'America/Toronto')::date - 1 WHERE id=$1", [j.id]); closed = j; console.log(`seed-extra: set application_deadline to yesterday on job#${j.id} (${j.slug}) — applications closed`); }
    }
    if (closed) out.closedslug = closed.slug;
    const pidRow = await one(`SELECT j.public_id FROM jobs j WHERE ${live} AND j.public_id IS NOT NULL ORDER BY j.id LIMIT 1`);
    if (pidRow) out.publicId = pidRow.public_id; else console.log('fixtures: no live job has a public_id yet (jobs-search-id skipped)');
    const comp = await one("SELECT p.slug FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE j.status='active' AND j.expires_at > now() AND j.source IS NULL ORDER BY j.id LIMIT 1");
    if (comp) out.companySlug = comp.slug;
    if (seed) {   // the Integrations passcode the admin pages are unlocked with
      try { const settings = require('../lib/settings'); await settings.set('admin_passcode', ADMIN_PASSCODE); console.log('seed-extra: admin_passcode set (lib/settings)'); try { await require('../lib/db').pool.end(); } catch (_) {} }
      catch (e) { console.log(`seed-extra: could not set admin_passcode via lib/settings: ${e.message}`); }
    }
  } catch (e) { console.log(`db fixtures: ${e.message}`); }
  await pool.end().catch(() => {});
  return out;
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
  const vars = { slug, ...(pages.some(p => /\{(multislug|employerJob|consultantJob|receiptId|geoslug|lockedJob|closedslug|publicId|companySlug)\}/.test(p.path) || p.unlock) ? await dbFixtures(!!argv['seed-extra']) : {}) };
  pages = pages.filter(p => {
    const missing = [...p.path.matchAll(/\{(\w+)\}/g)].map(m => m[1]).filter(k => !vars[k]);
    if (missing.length) console.log(`skip ${p.key}: no fixture for {${missing.join('}, {')}}${process.env.DATABASE_URL ? ' (run with --seed-extra)' : ' (set DATABASE_URL)'}`);
    return !missing.length;
  }).map(p => ({ ...p, path: p.path.replace(/\{(\w+)\}/g, (_, k) => vars[k]) }));

  // Log in once per role over HTTP; keep the raw cc_session cookie for Network.setCookie.
  const sessions = {};
  for (const role of [...new Set(pages.map(p => p.as).filter(Boolean))]) {
    try {
      const s = await login(BASE, LOGINS[role], PASSWORD);
      if (s.ok) sessions[role] = s; else console.log(`login ${role}: FAILED (${s.status}${s.location ? ' → ' + s.location : ''}) — its pages will be captured as guest`);
    } catch (e) { console.log(`login ${role}: threw ${e.message}`); }
  }
  // `locked: true` pages need an admin session that was NOT unlocked (the unlock below is per session): log the admin in a second time.
  if (sessions.admin && pages.some(p => p.locked)) {
    try { const s = await login(BASE, LOGINS.admin, PASSWORD); if (s.ok) sessions['admin:locked'] = s; else console.log('second (locked) admin login FAILED'); } catch (e) { console.log(`second (locked) admin login threw ${e.message}`); }
  }
  // Integrations is passcode-gated per session: unlock the admin session once so `unlock: true` pages render the real panel.
  if (sessions.admin && pages.some(p => p.unlock)) {
    try {
      const u = await request(BASE, '/admin/integrations/unlock', { jar: sessions.admin.jar });
      const f = findForm(u.text, 'passcode');
      const form = { ...(f ? f.fields : {}), action: 'unlock', passcode: ADMIN_PASSCODE, next: '/admin/integrations' };
      const r = await request(BASE, (f && f.action) || '/admin/integrations/unlock', { method: 'POST', form, jar: sessions.admin.jar });
      const ok = r.status === 302 && !/unlock/.test(r.location || '');
      console.log(`admin integrations unlock: ${ok ? 'OK' : 'FAILED'} (${r.status}${r.location ? ' → ' + r.location : ''})${ok ? '' : /passcode2/.test(u.text) ? ' — no passcode set yet: run with --seed-extra or set QA_ADMIN_PASSCODE' : ' — wrong QA_ADMIN_PASSCODE?'}`);
    } catch (e) { console.log(`admin integrations unlock: threw ${e.message}`); }
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

  const rows = [];   // { key, path, as, width, status, iw, sw, h, overflow, wide, file, errors, err }
  let failures = 0;
  let storageDirty = false;   // localStorage persists in the profile: clear it before the next page that did not ask for any
  for (const page of pages) {
    const sess = page.as && (sessions[page.locked ? page.as + ':locked' : page.as] || sessions[page.as]);
    for (const width of WIDTHS) {
      const row = { key: page.key, path: page.path, as: page.as || 'guest', width, expect: page.expect, file: `${page.key}-${width}.png` };
      rows.push(row);
      try {
        await cdp.send('Network.clearBrowserCookies');
        if (sess) await cdp.send('Network.setCookie', { name: sess.cookieName, value: sess.cookie, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 844 : width < 1100 ? 1024 : 900, deviceScaleFactor: width < 500 ? 2 : 1, mobile: width < 500, screenWidth: width, screenHeight: width < 500 ? 844 : 1024 });
        if (width < 500) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        // localStorage must be written from the site's own origin BEFORE the page loads (e.g. cc:jobs-map=hide hides the Find Jobs map)
        if (page.storage || storageDirty) {
          const l0 = cdp.waitFor('Page.loadEventFired', 10000);
          await cdp.send('Page.navigate', { url: BASE + '/robots.txt' }); await l0.catch(() => {});
          await cdp.eval(`(() => { try { localStorage.clear(); const s = ${JSON.stringify(page.storage || {})}; for (const k in s) localStorage.setItem(k, s[k]); return Object.keys(localStorage).length; } catch (e) { return 'localStorage: ' + e.message; } })()`);
          storageDirty = !!page.storage;
        }
        // a fresh document every time: navigating to a URL that differs only by #fragment (or is identical) would be a
        // same-document navigation — no new response, status stays "?"; about:blank in between forces a real load
        await cdp.send('Page.navigate', { url: 'about:blank' }); await sleep(100);
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
        const norm = (p) => { try { return decodeURIComponent(String(p).replace(/#.*$/, '')); } catch (_) { return String(p); } };
        row.redirected = norm(row.finalPath) !== norm(page.path) && !page.redirect;
        if (row.overflow) {
          // name the widest offenders so the owning agent can fix them without guessing
          row.offenders = await cdp.eval(`(() => { const iw = innerWidth, out = []; for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (r.right > iw + 1 && r.width > 0) out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '') + ' right=' + Math.round(r.right)); } return out.slice(0, 5); })()`);
        }
        // Round 3 layout hygiene at phone width: no VISIBLE element may start on-screen and run past the viewport, unless an ancestor
        // scrolls/clips it on purpose (tables in .table-wrap, the portal tab strip). Off-screen drawers (translateX(100%)) start at x >= iw and are not counted.
        if (width < 500) {
          row.wide = await cdp.eval(`(() => { const iw = innerWidth, out = [];
            const clipped = (el) => { for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true; } return false; };
            for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.left < iw - 1 && r.right > iw + 1)) continue;
              const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0 || cs.position === 'fixed' && r.left >= iw) continue; if (clipped(el)) continue;
              out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '') + ' ' + Math.round(r.left) + '→' + Math.round(r.right)); }
            return out.slice(0, 6); })()`);
        }
        const clipH = Math.min(row.h || 800, MAX_HEIGHT);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: clipH, scale: 1 } }, 60000);
        fs.writeFileSync(path.join(OUT, row.file), Buffer.from(shot.data, 'base64'));
        row.errors = consoleBucket.slice();
        const wide = !!(row.wide && row.wide.length);
        const bad = row.overflow || wide || row.redirected || !(page.expect ? row.status === page.expect : row.status >= 200 && row.status < 300);
        if (bad) failures++;
        console.log(`${bad ? 'FAIL' : 'PASS'}  ${page.key.padEnd(22)} ${String(width).padStart(4)}px  status=${row.status ?? '?'}  iw=${row.iw} sw=${row.sw} h=${row.h}${row.overflow ? '  OVERFLOW ' + (row.offenders || []).join(', ') : ''}${wide ? '  WIDE ' + row.wide.join(', ') : ''}${row.redirected ? '  REDIRECTED→' + row.finalPath : ''}${row.errors.length ? `  console:${row.errors.length}` : ''}`);
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
  const cell = (r) => r.err ? `ERR` : `${r.overflow ? 'OVERFLOW' : r.wide && r.wide.length ? `WIDE ×${r.wide.length}` : r.redirected ? 'REDIRECT→' + r.finalPath : (r.expect ? r.status === r.expect : r.status >= 200 && r.status < 300) ? 'OK' : 'HTTP ' + r.status}${r.overflow ? ` (${r.sw}>${r.iw})` : ''} ${r.h}px`;
  const lines = [`# QA screenshot report`, '', `- Base: ${BASE}`, `- Generated: ${new Date().toISOString()}`, `- Widths: ${WIDTHS.join(', ')} (390 = mobile, deviceScaleFactor 2)`, `- Logged-in roles: ${roles.join(', ') || 'none (all logins failed)'}`, '',
    `Cell = status + page height. **OVERFLOW** means \`document.scrollWidth > innerWidth\` (horizontal scroll) at that width; **WIDE ×n** (390 only) = n visible elements run past the viewport edge (listed below). PNGs are \`shots/qa/<page>-<width>.png\`.`, '',
    `| page | path | as | ${WIDTHS.map(w => w + 'px').join(' | ')} |`, `|---|---|---|${WIDTHS.map(() => '---').join('|')}|`];
  for (const [key, rs] of byKey) {
    const first = rs[0];
    lines.push(`| ${key} | \`${first.path}\` | ${first.as} | ${WIDTHS.map(w => { const r = rs.find(x => x.width === w); return r ? cell(r) : '—'; }).join(' | ')} |`);
  }
  const overflow = rows.filter(r => r.overflow);
  lines.push('', `## Overflow details (${overflow.length})`, '');
  if (!overflow.length) lines.push('None.');
  for (const r of overflow) lines.push(`- **${r.key} @ ${r.width}px** \`${r.path}\` — scrollWidth ${r.sw} > innerWidth ${r.iw}; widest elements: ${(r.offenders || []).map(o => '`' + o + '`').join(', ') || '(none isolated)'}`);
  const wide = rows.filter(r => r.wide && r.wide.length);
  lines.push('', `## Elements wider than the phone viewport at 390 (${wide.length} captures)`, '', 'Visible elements that start on-screen and run past \`innerWidth\` without a scrolling/clipping ancestor (\`left→right\` in css px).', '');
  if (!wide.length) lines.push('None.');
  for (const r of wide) lines.push(`- **${r.key}** \`${r.path}\` — ${r.wide.map(o => '`' + o + '`').join(', ')}`);
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
