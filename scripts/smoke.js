'use strict';
// End-to-end HTTP smoke test for Canada Careers. Zero extra deps (global fetch + pg, which is installed).
//
//   BASE_URL=http://localhost:3900 DATABASE_URL=postgres://... node scripts/smoke.js
//
// Runs against a RUNNING, SEEDED instance (scripts/seed.js logins). Every step prints PASS/FAIL + detail and
// the script keeps going after a failure; exit code is 1 if anything failed. Where a route may have deviated
// from docs/CONTRACT.md / docs/CHANGES-2026-09-09-CLIENT.md, the actual status + Location header is printed so
// the orchestrator can reconcile.
//
// It mutates the DB (creates jobs, an application, a contact message) but tags everything with the marker
// "[smoke]" and removes its own leftovers from earlier runs first. Set SMOKE_KEEP=1 to skip that cleanup.
//
// Form field names for the NEW job form (work locations) and the apply form (cover sheet upload) are discovered
// from the EJS views at run time (see discoverLocationFields / discoverCoverField) so this script keeps working
// while the portal/seeker agents land their files; when discovery finds nothing it prints the names it tried.

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { CookieJar, request, login } = require('./cdp');

const BASE = (process.env.BASE_URL || 'http://localhost:3900').replace(/\/$/, '');
const ROOT = path.join(__dirname, '..');
const MARK = '[smoke]';
const PASSWORD = 'Password123!';
const LOGINS = { admin: 'veda@canadacareers.local', employer: 'employer@example.com', consultant: 'consultant@example.com', seeker: 'seeker@example.com' };
// Role-based pricing (client decision 2026-09-09): employer $14.99 + 5% GST = $15.74; consultant $9.99 + GST = $10.49.
const PRICE = { employer: { base: '14.99', tax: '0.75', total: '15.74', cents: 1574 }, consultant: { base: '9.99', tax: '0.50', total: '10.49', cents: 1049 } };
const LOCATIONS = [
  { street_address: '2400 Derry Rd E', unit: '', city: 'Mississauga', province: 'ON', postal_code: 'L5S 1B1' },
  { street_address: '7100 Airport Rd', unit: '12', city: 'Mississauga', province: 'ON', postal_code: 'L4T 2H3' },
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const q = (sql, params) => pool.query(sql, params).then(r => r.rows);
const one = (sql, params) => q(sql, params).then(r => r[0] || null);

// ---------------------------------------------------------------- reporting
const results = [];
function report(ok, name, detail = '') {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}
const describe = (r) => `${r.status}${r.location ? ' → ' + r.location : ''}`;
/** Run a step; an exception becomes a FAIL instead of aborting the run. */
async function step(name, fn) {
  try { return await fn(); }
  catch (e) { report(false, name, `threw: ${e.message}`); return null; }
}
/** Assertions common to every rendered HTML page. */
function checkHtml(name, r) {
  if (!/text\/html/.test(r.contentType)) return report(false, `${name}: html`, `content-type ${r.contentType || '(none)'}`);
  const h1 = /<h1[\s>]/i.test(r.text), vp = /<meta\s+name="viewport"/i.test(r.text);
  return report(h1 && vp, `${name}: has <h1> + viewport meta`, `${h1 ? '' : 'missing <h1> '}${vp ? '' : 'missing viewport meta'}`.trim());
}
async function expectPage(name, path, jar, status = 200) {
  const r = await request(BASE, path, { jar });
  const ok = report(r.status === status, `GET ${path}${name ? ' (' + name + ')' : ''} → ${status}`, describe(r));
  if (ok && status === 200) checkHtml(`GET ${path}`, r);
  return r;
}
async function expectRedirect(name, path, jar, toRe, opts = {}) {
  const r = await request(BASE, path, { jar, ...opts });
  const ok = r.status >= 300 && r.status < 400 && toRe.test(r.location || '');
  report(ok, name, describe(r) + (ok ? '' : `  (expected 3xx → ${toRe})`));
  return r;
}
/** Pull field-error / flash text out of an HTML response so a failed POST explains itself. */
function errorsIn(html) {
  const found = [];
  for (const m of html.matchAll(/class="[^"]*(?:error|invalid|flash)[^"]*"[^>]*>([^<]{3,160})</gi)) found.push(m[1].trim());
  return [...new Set(found)].slice(0, 6).join(' | ');
}
/** A minimal valid one-page PDF (used as the uploaded resume / cover sheet). */
function tinyPdf(text) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const has = (html, s) => html.includes(s) || html.includes(esc(s));
const stripHost = (u) => (u || '').replace(/^https?:\/\/[^/]+/, '');
const noSpace = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) { try { out.push(JSON.parse(m[1])); } catch (_) {} }
  return out;
}
const fullAddress = (l) => [l.street_address, l.unit && `Unit ${l.unit}`, l.city, [l.province, l.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');

// ---------------------------------------------------------------- form-field discovery (other agents own the views)
/**
 * Work-location field names come from views/portal/job-form.ejs. Returns { template, source } where template is
 * the street_address input name with `{i}` for the row index (e.g. `locations[{i}][street_address]`); other
 * fields are template.replace('street_address', field). `{i}` absent (e.g. `street_address[]`) = repeated names.
 */
function discoverLocationFields() {
  const tried = ['locations[{i}][street_address]', 'locations[][street_address]', 'street_address[]', 'location_street_address[]'];
  try {
    const src = fs.readFileSync(path.join(ROOT, 'views', 'portal', 'job-form.ejs'), 'utf8');
    const names = [...src.matchAll(/name=(?:"|')([^"']*street_address[^"']*)(?:"|')/g)].map(m => m[1]);
    const name = names.find(n => /\[|locations/.test(n)) || names[0];
    if (name) {
      const template = name.replace(/<%[=\-]?[\s\S]*?%>/g, '{i}').replace(/\$\{[^}]*\}/g, '{i}').replace(/\[\d+\]/g, '[{i}]');
      return { template, source: 'views/portal/job-form.ejs', tried };
    }
  } catch (_) {}
  return { template: tried[0], source: 'fallback (no street_address input found in views/portal/job-form.ejs)', tried };
}
function locationParams(params, loc, i, template) {
  for (const f of ['street_address', 'unit', 'city', 'province', 'postal_code']) params.append(template.replace('street_address', f).replace(/\{i\}/g, String(i)), loc[f] ?? '');
}
/** Cover-sheet file input name from views/seeker/apply.ejs (any file input that is not the resume). */
function discoverCoverField() {
  const tried = ['cover_sheet', 'cover_file', 'cover_letter_file', 'cover'];
  try {
    const src = fs.readFileSync(path.join(ROOT, 'views', 'seeker', 'apply.ejs'), 'utf8');
    const files = [...src.matchAll(/<input[^>]*type=(?:"|')file(?:"|')[^>]*>/gi)].map(m => (m[0].match(/name=(?:"|')([^"']+)(?:"|')/) || [])[1]).filter(Boolean);
    const name = files.find(n => n !== 'resume');
    if (name) return { name, source: 'views/seeker/apply.ejs', tried };
  } catch (_) {}
  return { name: tried[0], source: 'fallback (no second file input found in views/seeker/apply.ejs)', tried };
}

// ---------------------------------------------------------------- job form payload
function jobForm(profileId, title, overrides = {}) {
  const form = {
    employer_profile_id: profileId || '', profile_id: profileId || '',
    title, description: 'Smoke test posting created automatically by scripts/smoke.js to exercise the publish, checkout and cancel flow.\n\nThis job is cancelled again by the same script a few seconds later, so nobody should ever see it or apply to it. If you can read this on the public site, the cancel step failed.',
    requirements: 'None.', benefits: 'None.', category: 'administration', job_type: 'full_time', work_arrangement: 'hybrid',
    experience_level: 'entry', education: 'secondary', education_other: '', experience_other: '',
    city: LOCATIONS[0].city, province: LOCATIONS[0].province, postal_code: LOCATIONS[0].postal_code,
    salary_min: '1800', salary_max: '2000', salary_period: 'biweekly', vacancies: '1', languages: 'English', skills: 'Teamwork, Communication',
    apply_email: 'apply@example.com', noc_code: '13100', ...overrides,
  };
  const params = new URLSearchParams(form);
  params.append('audiences', 'professionals'); params.append('audiences', 'youth');
  return params;
}
const postForm = (path, params, jar) => request(BASE, path, { method: 'POST', body: params.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, jar });

// ---------------------------------------------------------------- posting flow (employer + consultant)
/**
 * Post-a-job → validation → publish → checkout (role price) → sandbox card → active → public page (locations,
 * operating name, bi-weekly, print, JSON-LD) → receipt (owner 200 / other 302|404) → cancel-now → 404.
 */
async function postingFlow(role, jar, otherJar, guest, loc) {
  const base = role === 'consultant' ? '/consultant' : '/employer';
  const P = PRICE[role];
  const g = await expectPage(role, `${base}/jobs/new`, jar);
  if (g.status !== 200) return;
  const profile = await one('SELECT id, company_name, operating_name FROM employer_profiles WHERE owner_user_id=(SELECT id FROM users WHERE email=$1) AND archived IS NOT TRUE ORDER BY id LIMIT 1', [LOGINS[role]]);
  if (!profile) return report(false, `${role}: an employer profile to post under`, 'none in DB');
  const stamp = Date.now().toString(36);
  const tpl = loc.template;
  const fieldsNote = `location fields: ${tpl.replace(/\{i\}/g, '0')} … (from ${loc.source})`;

  // --- negative validation (each must NOT create a row; any stray draft is removed immediately)
  async function expect422(name, params, title) {
    const r = await postForm(`${base}/jobs/new`, params, jar);
    const stray = await one('SELECT id FROM jobs WHERE title=$1', [title]);
    report(r.status === 422 && !stray, `${role}: POST ${base}/jobs/new ${name} → 422, no row`, `${describe(r)}${stray ? ` STRAY job#${stray.id} created (deleted)` : ''}${r.status !== 422 ? '  ' + (errorsIn(r.text) || '(no error text)') : ''}`);
    if (stray) await q('DELETE FROM jobs WHERE id=$1', [stray.id]);
  }
  if (role === 'employer') {
    let t = `${MARK} no-address ${stamp}`; let p = jobForm(profile.id, t, { postal_code: '' });
    locationParams(p, { street_address: '', unit: '', city: 'Mississauga', province: 'ON', postal_code: '' }, 0, tpl);
    await expect422(`with no street/postal (${fieldsNote})`, p, t);
    t = `${MARK} bad-postal ${stamp}`; p = jobForm(profile.id, t, { postal_code: '12345' });
    locationParams(p, { ...LOCATIONS[0], postal_code: '12345' }, 0, tpl);
    await expect422('with postal_code 12345', p, t);
    t = `${MARK} edu-other ${stamp}`; p = jobForm(profile.id, t, { education: 'other', education_other: '' });
    locationParams(p, LOCATIONS[0], 0, tpl);
    await expect422('with education=other and empty education_other', p, t);
  }

  // --- create the real posting with TWO work locations, bi-weekly salary
  const title = `${MARK} Smoke Test ${role === 'consultant' ? 'Consultant' : 'Coordinator'} ${stamp}`;
  const params = jobForm(profile.id, title);
  LOCATIONS.forEach((l, i) => locationParams(params, l, i, tpl));
  const c = await postForm(`${base}/jobs/new`, params, jar);
  let job = await one('SELECT id, slug, status, city, province, postal_code, salary_period FROM jobs WHERE title=$1', [title]);
  report(c.status === 302 && !!job, `${role}: POST ${base}/jobs/new (2 locations, biweekly) → 302 + draft row`, describe(c) + (job ? ` job#${job.id} status=${job.status}` : ` no job row; ${errorsIn(c.text) || '(no error text)'}; ${fieldsNote}`));
  if (!job) return;
  const rows = await q('SELECT street_address, unit, city, province, postal_code, sort_order FROM job_locations WHERE job_id=$1 ORDER BY sort_order, id', [job.id]);
  const okRows = rows.length === 2 && rows.every((r, i) => r.street_address === LOCATIONS[i].street_address && noSpace(r.postal_code) === noSpace(LOCATIONS[i].postal_code) && r.city === LOCATIONS[i].city);
  report(okRows, `${role}: 2 job_locations rows with street + postal`, rows.length ? rows.map(fullAddress).join(' | ') : `0 rows (${fieldsNote})`);
  report(job.city === LOCATIONS[0].city && job.province === LOCATIONS[0].province, `${role}: jobs.city/province = first location`, `${job.city}, ${job.province}`);
  report(job.salary_period === 'biweekly', `${role}: jobs.salary_period = biweekly`, `salary_period=${job.salary_period}`);
  await expectPage(role, `${base}/jobs/${job.id}`, jar);

  // --- publish → checkout
  const pub = await expectRedirect(`${role}: POST ${base}/jobs/${job.id}/publish → 302 /billing/checkout/${job.id}`, `${base}/jobs/${job.id}/publish`, jar, new RegExp(`/billing/checkout/${job.id}`), { method: 'POST', form: {} });
  job = await one('SELECT id, slug, status FROM jobs WHERE id=$1', [job.id]);
  report(['pending_payment', 'draft'].includes(job.status), `${role}: job status after publish click`, `status=${job.status} (${pub.status})`);
  const co = await expectPage(role, `/billing/checkout/${job.id}`, jar);
  if (co.status === 200) {
    const found = [P.base, P.tax, P.total].filter(s => co.text.includes(s));
    report(found.length === 3, `${role}: checkout shows $${P.base} + $${P.tax} GST = $${P.total}`, found.length === 3 ? '' : `found ${found.join(', ') || 'none'}; page prices: ${[...new Set(co.text.match(/\$\d+\.\d{2}/g) || [])].join(' ')}`);
  }
  const cs = await expectRedirect(`${role}: POST /billing/checkout/${job.id} → 302 /billing/sandbox/:checkoutId`, `/billing/checkout/${job.id}`, jar, /\/billing\/sandbox\//, { method: 'POST', form: {} });
  const sandboxPath = stripHost(cs.location);
  if (!sandboxPath) return report(false, `${role}: sandbox card page`, 'no sandbox Location to follow (Stripe mode? set STRIPE_SECRET_KEY empty for sandbox)');
  await expectPage(role, sandboxPath, jar);
  const card = { card_number: '4242424242424242', number: '4242424242424242', card: '4242 4242 4242 4242', name: 'Maria Santos', cardholder: 'Maria Santos',
    exp: '12/34', expiry: '12/34', exp_month: '12', exp_year: '2034', cvc: '123', cvv: '123', postal_code: 'L5B 1M2' };
  const pay = await expectRedirect(`${role}: POST ${sandboxPath} (card 4242) → 302 /billing/success`, sandboxPath, jar, /\/billing\/success/, { method: 'POST', form: card });
  if (pay.status !== 302 && pay.text) console.log('      sandbox form errors: ' + (errorsIn(pay.text) || '(none found in HTML)'));
  if (pay.location) await expectPage(role, stripHost(pay.location), jar);
  job = await one('SELECT id, slug, status, expires_at > now() AS live FROM jobs WHERE id=$1', [job.id]);
  report(job.status === 'active' && job.live, `${role}: job is active + paid-up in DB after sandbox payment`, `status=${job.status} live=${job.live}`);
  const sub = await one('SELECT status, price_cents, tax_cents, total_cents, current_period_end > now() AS ok FROM subscriptions WHERE job_id=$1', [job.id]);
  report(!!sub && sub.status === 'active' && sub.total_cents === P.cents && sub.ok, `${role}: subscription row active, total ${P.cents} cents`, JSON.stringify(sub));
  const payRow = await one('SELECT id, receipt_number, total_cents FROM payments WHERE job_id=$1 ORDER BY id DESC', [job.id]);
  report(!!payRow && /^CC-\d{6}-\d{6}$/.test(payRow.receipt_number || '') && payRow.total_cents === P.cents, `${role}: payment row with CC-YYYYMM-NNNNNN receipt, total ${P.cents}`, JSON.stringify(payRow));
  if (payRow) {
    const rc = await request(BASE, `/billing/receipt/${payRow.id}`, { jar });
    report(rc.status === 200 && rc.text.includes(payRow.receipt_number), `${role}: GET /billing/receipt/${payRow.id} (owner) → 200 with receipt number`, describe(rc));
    if (otherJar) { const ro = await request(BASE, `/billing/receipt/${payRow.id}`, { jar: otherJar }); report(ro.status === 302 || ro.status === 404, `${role}: GET /billing/receipt/${payRow.id} as a different user → 302/404`, describe(ro)); }
  }

  // --- public page: search, detail (addresses, operating name, bi-weekly, print, JSON-LD), sitemap
  const pubList = await request(BASE, '/jobs?q=' + encodeURIComponent('Smoke Test'), { jar: guest });
  report(pubList.status === 200 && pubList.text.includes(job.slug), `${role}: new job appears in public /jobs search`, describe(pubList));
  const pg = await expectPage('public', `/jobs/${job.slug}`, guest);
  if (pg.status === 200) {
    const missing = LOCATIONS.map(fullAddress).filter(a => !has(pg.text, a));
    report(!missing.length, `${role}: public page lists both full work addresses`, missing.length ? `missing: ${missing.join(' | ')}` : LOCATIONS.map(fullAddress).join(' | '));
    if (profile.operating_name) report(has(pg.text, profile.operating_name), `${role}: public page shows operating name "${profile.operating_name}"`);
    report(/bi-weekly/i.test(pg.text), `${role}: salary rendered as "bi-weekly"`, (pg.text.match(/\$[\d,]+(?:\s*[–-]\s*\$[\d,]+)?\s*[^<]{0,20}/) || [''])[0].trim());
    report(/<link[^>]+print\.css/.test(pg.text), `${role}: job page links print.css`);
    report(/data-print/.test(pg.text), `${role}: job page has a data-print button`);
    const jp = jsonLd(pg.text).find(o => o['@type'] === 'JobPosting');
    const jl = jp && jp.jobLocation;
    const arr = Array.isArray(jl) ? jl : (jl ? [jl] : []);
    report(Array.isArray(jl) && arr.length === 2 && arr.every(x => x.address && x.address.postalCode), `${role}: JSON-LD jobLocation is an array of 2 with postalCode`, jp ? JSON.stringify(jl).slice(0, 200) : 'no JobPosting JSON-LD');
  }
  const sm = await request(BASE, '/sitemap.xml');
  report(sm.text.includes(`/jobs/${job.slug}`), `${role}: new job appears in sitemap.xml`);
  await expectPage(role, '/billing', jar);

  // --- cancel now → gone
  await expectRedirect(`${role}: POST /billing/cancel/${job.id}?now=1 → 302`, `/billing/cancel/${job.id}?now=1`, jar, /./, { method: 'POST', form: {} });
  const after = await one('SELECT status FROM jobs WHERE id=$1', [job.id]);
  report(after.status === 'cancelled', `${role}: job status cancelled in DB`, `status=${after.status}`);
  const gone = await request(BASE, `/jobs/${job.slug}`, { jar: guest });
  report(gone.status === 404, `${role}: cancelled job 404s publicly`, describe(gone));
  const sm2 = await request(BASE, '/sitemap.xml');
  report(!sm2.text.includes(`/jobs/${job.slug}`), `${role}: cancelled job dropped from sitemap.xml`);
  return job;
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`smoke: ${BASE}  db=${(process.env.DATABASE_URL || '').replace(/\/\/.*@/, '//***@')}`);
  let reachable = false;
  try { const r = await request(BASE, '/healthz'); reachable = r.status === 200; report(reachable, 'GET /healthz → 200', r.status + ' ' + r.text.slice(0, 80)); }
  catch (e) { report(false, 'server reachable', e.message); }
  if (!reachable) return finish();

  // ---- DB fixtures: slugs + cleanup of previous smoke runs
  const db = await step('db: fixtures', async () => {
    const active = await one("SELECT id, slug FROM jobs WHERE status='active' AND expires_at > now() AND source IS NULL ORDER BY id LIMIT 1");
    const expired = await one("SELECT id, slug FROM jobs WHERE status='expired' ORDER BY id LIMIT 1");
    const seeker = await one('SELECT id FROM users WHERE email=$1', [LOGINS.seeker]);
    if (!process.env.SMOKE_KEEP) {
      await q('DELETE FROM applications WHERE cover_letter LIKE $1 OR resume_name LIKE $2 OR cover_letter_name LIKE $2', [MARK + '%', 'smoke-%']);
      await q('DELETE FROM contact_messages WHERE subject LIKE $1', [MARK + '%']);
      await q('DELETE FROM jobs WHERE title LIKE $1', [MARK + '%']);
    }
    // a live NATIVE job the seeder has NOT applied to yet (applications are UNIQUE per job+seeker); prefer one the
    // seeded employer owns so the employer-side cover download can be checked with the employer login
    const applyTo = seeker && await one(`SELECT j.id, j.slug, j.employer_profile_id FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id
      WHERE j.status='active' AND j.expires_at > now() AND j.source IS NULL AND j.id NOT IN (SELECT job_id FROM applications WHERE seeker_user_id=$1)
      ORDER BY (p.owner_user_id = (SELECT id FROM users WHERE email=$2)) DESC, j.id LIMIT 1`, [seeker.id, LOGINS.employer]);
    const opName = await one(`SELECT j.slug, p.operating_name, p.company_name FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id
      WHERE j.status='active' AND j.expires_at > now() AND p.operating_name IS NOT NULL AND p.operating_name <> '' AND p.operating_name <> p.company_name ORDER BY j.id LIMIT 1`);
    const jobbank = await one("SELECT slug, source_url FROM jobs WHERE source='jobbank' AND status='active' AND expires_at > now() ORDER BY id LIMIT 1");
    report(!!(active && expired), 'db: seeded fixtures present', `active=${active && active.slug} expired=${expired && expired.slug} applyTo=${applyTo && applyTo.slug} opName=${opName ? opName.operating_name : '(none)'} jobbank=${jobbank ? jobbank.slug : '(none)'}`);
    return { active, expired, seeker, applyTo, opName, jobbank };
  }) || {};

  // ---- 1. public pages
  const guest = new CookieJar();
  for (const p of ['/', '/jobs', '/about', '/contact', '/employer', '/consultant', '/jobseeker', '/login', '/signup', '/privacy', '/terms']) await step(p, () => expectPage('public', p, guest));
  const sitemap = await step('/sitemap.xml', async () => { const r = await request(BASE, '/sitemap.xml', { jar: guest }); report(r.status === 200 && /<urlset/.test(r.text), 'GET /sitemap.xml → 200 + <urlset>', describe(r)); return r; });
  await step('/robots.txt', async () => { const r = await request(BASE, '/robots.txt'); report(r.status === 200 && /sitemap/i.test(r.text), 'GET /robots.txt → 200 + Sitemap line', describe(r)); });

  // ---- 2. job detail: active 200 (+ JSON-LD, locations, operating name, print), archived 404; sitemap only lists live slugs
  if (db.active) await step('active job', async () => {
    const r = await expectPage('active job', `/jobs/${db.active.slug}`, guest);
    if (r.status !== 200) return;
    const jp = jsonLd(r.text).find(o => o['@type'] === 'JobPosting');
    report(!!jp, 'job detail has JobPosting JSON-LD');
    const locs = await q('SELECT street_address, unit, city, province, postal_code FROM job_locations WHERE job_id=$1 ORDER BY sort_order, id', [db.active.id]);
    const missing = locs.map(fullAddress).filter(a => !has(r.text, a));
    report(locs.length > 0 && !missing.length, 'job detail lists every job_locations full address', missing.length ? `missing: ${missing.join(' | ')}` : locs.map(fullAddress).join(' | ') || 'no job_locations rows');
    const jl = jp && jp.jobLocation; const arr = Array.isArray(jl) ? jl : (jl ? [jl] : []);
    report(Array.isArray(jl) && arr.length === locs.length && arr.every(x => x.address && x.address.postalCode), `JSON-LD jobLocation is an array (${locs.length}) with postalCode`, jp ? JSON.stringify(jl).slice(0, 160) : 'no JSON-LD');
    report(/<link[^>]+print\.css/.test(r.text), 'job detail links print.css');
    report(/data-print/.test(r.text), 'job detail has a data-print button');
  });
  if (db.opName) await step('operating name', async () => {
    const r = await request(BASE, `/jobs/${db.opName.slug}`, { jar: guest });
    report(r.status === 200 && has(r.text, db.opName.operating_name), `job detail shows operating name "${db.opName.operating_name}" (legal: ${db.opName.company_name})`, describe(r));
  });
  else report(false, 'operating name fixture', 'no live job whose employer_profiles.operating_name differs from company_name (seed expects Northern Lights Freight)');
  if (db.jobbank) await step('jobbank reference', async () => {
    const r = await request(BASE, `/jobs/${db.jobbank.slug}`, { jar: guest });
    report(r.status === 200 && /Reference posting/i.test(r.text), 'Job Bank row shows "Reference posting" attribution', describe(r));
    report(!r.text.includes(`/jobs/${db.jobbank.slug}/apply`), 'Job Bank row has no internal apply route', r.text.includes(`/jobs/${db.jobbank.slug}/apply`) ? 'found /apply link' : '');
  });
  else report(true, 'jobbank reference rows', 'none in this DB — skipped');
  if (db.expired) await step('archived job', () => expectPage('archived job', `/jobs/${db.expired.slug}`, guest, 404));
  if (sitemap && sitemap.status === 200) await step('sitemap slugs', async () => {
    const listed = [...sitemap.text.matchAll(/<loc>[^<]*\/jobs\/([^<\/]+)<\/loc>/g)].map(m => m[1]);
    const live = new Set((await q("SELECT slug FROM jobs WHERE status='active' AND expires_at > now()")).map(r => r.slug));
    const bad = listed.filter(s => !live.has(s));
    const missing = [...live].filter(s => !listed.includes(s));
    report(listed.length > 0 && bad.length === 0 && missing.length === 0, 'sitemap lists exactly the live job slugs', `listed=${listed.length} live=${live.size}${bad.length ? ' NOT-LIVE:' + bad.join(',') : ''}${missing.length ? ' MISSING:' + missing.join(',') : ''}`);
  });

  // ---- 3. guards
  await step('guest guard', () => expectRedirect('guest GET /employer/dashboard → 302 /login', '/employer/dashboard', new CookieJar(), /\/login/));
  if (db.applyTo) await step('guest apply interstitial', async () => {
    const r = await request(BASE, `/jobs/${db.applyTo.slug}/apply`, { jar: new CookieJar() });
    const links = ['/signup/seeker', '/login'].filter(l => new RegExp(`href="${l}[^"]*"`).test(r.text));
    report(r.status === 200 && links.length === 2, `guest GET /jobs/${db.applyTo.slug}/apply → 200 interstitial linking /signup/seeker + /login`, `${describe(r)}${r.status === 200 ? ' links found: ' + (links.join(', ') || 'none') : ''}`);
  });

  // ---- 4. logins
  const sessions = {};
  for (const role of ['employer', 'consultant', 'seeker', 'admin']) {
    await step(`login ${role}`, async () => {
      const s = await login(BASE, LOGINS[role], PASSWORD, { consumeFlash: false });
      report(s.ok, `POST /login as ${role} → 302 + cc_session cookie`, `${s.status}${s.location ? ' → ' + s.location : ''}${s.cookie ? '' : ' (no cookie)'}`);
      if (s.ok) sessions[role] = s.jar;
    });
  }
  const employer = sessions.employer, consultant = sessions.consultant, seeker = sessions.seeker, admin = sessions.admin;

  if (employer) await step('employer dashboard', () => expectPage('employer', '/employer/dashboard', employer));
  if (consultant) {
    await step('consultant dashboard', () => expectPage('consultant', '/consultant/dashboard', consultant));
    await step('consultant profiles', async () => {
      const r = await expectPage('consultant', '/consultant/profiles', consultant);
      if (r.status === 200) report(/Prairie Health Group/.test(r.text) && /Maple Byte Software/.test(r.text), '/consultant/profiles lists both seeded companies');
    });
  }
  if (seeker) {
    await step('seeker dashboard', () => expectPage('seeker', '/jobseeker/dashboard', seeker));
    await step('role guard', () => expectRedirect('seeker GET /employer/dashboard → 302 (role guard)', '/employer/dashboard', seeker, /./));
  }
  if (admin) { await step('admin', () => expectPage('admin', '/admin', admin)); await step('admin messages', () => expectPage('admin', '/admin/messages', admin)); }

  // ---- 5. seeker apply flow (multipart upload: resume + cover sheet) → cover downloads (seeker + employer side)
  if (seeker && db.applyTo) await step('apply flow', async () => {
    const slug = db.applyTo.slug;
    const g = await expectPage('seeker', `/jobs/${slug}/apply`, seeker);
    if (g.status !== 200) return;
    const cover = discoverCoverField();
    const fd = new FormData();
    fd.append('cover_letter', `${MARK} Smoke-test application. Please ignore.`);
    fd.append('resume', new Blob([tinyPdf('Smoke test resume')], { type: 'application/pdf' }), 'smoke-resume.pdf');
    fd.append(cover.name, new Blob([tinyPdf('Smoke test cover sheet')], { type: 'application/pdf' }), 'smoke-cover.pdf');
    fd.append('resume_choice', 'upload');   // tolerated if the form has no such field
    const r = await request(BASE, `/jobs/${slug}/apply`, { method: 'POST', body: fd, jar: seeker });
    const ok = r.status === 302;
    report(ok, `POST /jobs/${slug}/apply (multipart: resume + cover sheet as "${cover.name}") → 302`, describe(r) + (ok ? '' : ' ' + (errorsIn(r.text) || '(no error text)') + `; cover field from ${cover.source}`));
    const row = await one('SELECT id, resume_name, cover_letter_path, cover_letter_name, status FROM applications WHERE job_id=$1 AND seeker_user_id=$2', [db.applyTo.id, db.seeker.id]);
    report(!!row, 'application row exists in DB', row ? `id=${row.id} resume=${row.resume_name} status=${row.status}` : 'no row');
    if (!row) return;
    report(!!row.cover_letter_path, 'application row has cover_letter_path', row.cover_letter_path ? `${row.cover_letter_path} (${row.cover_letter_name})` : `NULL — cover sheet not stored (field "${cover.name}" from ${cover.source}; tried ${cover.tried.join(', ')})`);
    const isAttachment = (x) => x.status === 200 && /attachment/i.test(x.headers.get('content-disposition') || '');
    const sc = await request(BASE, `/jobseeker/applications/${row.id}/cover`, { jar: seeker });
    report(isAttachment(sc), `GET /jobseeker/applications/${row.id}/cover (owner) → 200 attachment`, `${describe(sc)} ${sc.headers.get('content-disposition') || ''}`.trim());
    const ownerRole = await one('SELECT u.email FROM employer_profiles p JOIN users u ON u.id=p.owner_user_id WHERE p.id=$1', [db.applyTo.employer_profile_id]);
    const ownerJar = ownerRole && ownerRole.email === LOGINS.consultant ? consultant : employer;
    const ownerBase = ownerRole && ownerRole.email === LOGINS.consultant ? '/consultant' : '/employer';
    if (ownerJar) { const ec = await request(BASE, `${ownerBase}/applications/${row.id}/cover`, { jar: ownerJar }); report(isAttachment(ec), `GET ${ownerBase}/applications/${row.id}/cover (job owner) → 200 attachment`, `${describe(ec)} ${ec.headers.get('content-disposition') || ''}`.trim()); }
    else report(false, 'employer-side cover download', 'job owner not logged in');
  });
  else report(false, 'apply flow', seeker ? 'no live job the seeker has not already applied to' : 'seeker login failed');

  // ---- 6. post-a-job flows: employer ($14.99) then consultant ($9.99), each publish → checkout → pay → public → cancel
  const loc = discoverLocationFields();
  console.log(`      job form location fields: ${loc.template} (${loc.source})`);
  if (employer) await step('employer post-a-job flow', () => postingFlow('employer', employer, consultant, guest, loc));
  else report(false, 'employer post-a-job flow', 'employer login failed');
  if (consultant) await step('consultant post-a-job flow', () => postingFlow('consultant', consultant, employer, guest, loc));
  else report(false, 'consultant post-a-job flow', 'consultant login failed');

  // ---- 7. contact form
  await step('contact form', async () => {
    const before = await one('SELECT count(*)::int AS n FROM mail_outbox');
    const subject = `${MARK} Smoke test message ${Date.now().toString(36)}`;
    const r = await expectRedirect('POST /contact → 302 /contact/thanks', '/contact', guest, /\/contact\/thanks/, {
      method: 'POST', form: { name: 'Smoke Tester', email: 'smoke@example.com', phone: '416-555-0100', category: 'technical', subject, message: 'This is an automated smoke-test message. Please ignore.' } });
    if (r.status !== 302) console.log('      contact form errors: ' + (errorsIn(r.text) || '(none found in HTML)'));
    if (r.location) await expectPage('public', stripHost(r.location), guest);
    const row = await one('SELECT id, status, assigned_to FROM contact_messages WHERE subject=$1', [subject]);
    report(!!row, 'contact_messages row exists', row ? JSON.stringify(row) : 'no row');
    const after = await one('SELECT count(*)::int AS n FROM mail_outbox');
    report(after.n - before.n === 2, 'contact POST recorded 2 mail_outbox rows (support + auto-reply)', `delta=${after.n - before.n}`);
  });

  // ---- 8. logout
  if (seeker) await step('logout', () => expectRedirect('POST /logout → 302', '/logout', seeker, /./, { method: 'POST', form: {} }));

  return finish();
}

async function finish() {
  const fails = results.filter(r => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} passed${fails.length ? `, ${fails.length} FAILED:` : ''}`);
  for (const f of fails) console.log(`  - ${f.name}${f.detail ? '  (' + f.detail + ')' : ''}`);
  await pool.end().catch(() => {});
  process.exit(fails.length ? 1 : 0);
}

main().catch(async (e) => { console.error('smoke: fatal', e); await pool.end().catch(() => {}); process.exit(1); });
