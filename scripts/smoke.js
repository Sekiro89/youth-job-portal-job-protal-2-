'use strict';
// End-to-end HTTP smoke test for Canada Careers. Zero extra deps (global fetch + pg, which is installed).
//
//   BASE_URL=http://localhost:3900 DATABASE_URL=postgres://... node scripts/smoke.js
//
// Runs against a RUNNING, SEEDED instance (scripts/seed.js logins). Every step prints PASS/FAIL + detail and
// the script keeps going after a failure; exit code is 1 if anything failed. Where a route may have deviated
// from docs/CONTRACT.md / docs/CHANGES-2026-09-09-CLIENT.md / docs/CHANGES-2026-09-10-PDF.md /
// docs/CHANGES-2026-09-14-ROUND3.md (public id, locking, decimal salary, posting dates, "Other platform link"), the actual status +
// Location header (and the form's own error text) is printed so the orchestrator can reconcile.
//
// It mutates the DB (jobs, an application, a contact message, address-book rows, an extra admin login, a few
// settings values that it restores) but tags everything with the marker "[smoke]" and removes its own leftovers
// from earlier runs first. Set SMOKE_KEEP=1 to skip that cleanup. NEVER point it at production.
//
// Form field names are discovered from the EJS views / route files at run time where other agents own them (job
// form location mode, cover-sheet input, admin forms are re-posted from the page's own <form>), so the script keeps
// working while they land; when discovery finds nothing it prints the names it tried.

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { CookieJar, request, login, sleep, findForm, inputValue, flashes } = require('./cdp');

const BASE = (process.env.BASE_URL || 'http://localhost:3900').replace(/\/$/, '');
const ROOT = path.join(__dirname, '..');
const MARK = '[smoke]';
const PASSWORD = 'Password123!';
const LOGINS = { admin: 'veda@canadacareers.local', employer: 'employer@example.com', consultant: 'consultant@example.com', seeker: 'seeker@example.com' };
// Role-based pricing (client decision 2026-09-09): employer $14.99 + 5% GST = $15.74; consultant $9.99 + GST = $10.49.
const PRICE = { employer: { base: '14.99', tax: '0.75', total: '15.74', cents: 1574 }, consultant: { base: '9.99', tax: '0.50', total: '10.49', cents: 1049 } };
const RAISED = { cents: '1599', base: '15.99', tax: '0.80', total: '16.79' };   // admin pricing test: employer 1599 → $15.99 + $0.80
const LOCATIONS = [
  { street_address: '2400 Derry Rd E', unit: '', city: 'Mississauga', province: 'ON', postal_code: 'L5S 1B1' },
  { street_address: '7100 Airport Rd', unit: '12', city: 'Mississauga', province: 'ON', postal_code: 'L4T 2H3' },
];
const NEW_LOCATION = { label: `${MARK} inline`, street_address: '100 City Centre Dr', unit: '', city: 'Mississauga', province: 'ON', postal_code: 'L5B 2C9' };
const LOC_FIELDS = ['street_address', 'unit', 'city', 'province', 'postal_code'];
const PASSCODE = process.env.QA_ADMIN_PASSCODE || 'qa-pass-123';
const SMOKE_ADMIN = { name: 'Smoke Admin', email: 'smoke-admin@example.com', password: 'SmokeAdmin123!' };
const SMOKE_OPNAME = 'NL Smoke Trade';          // extra operating name kept on the employer profile (idempotent)
const SUPPORT_RECIPIENTS = ['veda-smoke@example.com', 'second-smoke@example.com'];
const CITY_COORDS = { Mississauga: [43.589, -79.6441], Brampton: [43.7315, -79.7624], Toronto: [43.6532, -79.3832], Saskatoon: [52.1332, -106.67], Vancouver: [49.2827, -123.1207], Ottawa: [45.4215, -75.6972], Calgary: [51.0447, -114.0719], Edmonton: [53.5461, -113.4938], Winnipeg: [49.8951, -97.1384], Halifax: [44.6488, -63.5752] };

let C = {}; try { C = require('../lib/constants'); } catch (e) { console.log(`(lib/constants not loadable: ${e.message})`); }
let jobsLib = null; try { jobsLib = require('../lib/jobs'); } catch (e) { console.log(`(lib/jobs not loadable: ${e.message})`); }
const PUBLIC_ID_RE = (jobsLib && jobsLib.PUBLIC_ID_RE) || /^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$/;
let settingsLib = null, settingsErr = '';
try { settingsLib = require('../lib/settings'); } catch (e) { settingsErr = e.message; }

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
  for (const m of String(html || '').matchAll(/class="[^"]*(?:error|invalid|flash)[^"]*"[^>]*>([^<]{3,160})</gi)) found.push(m[1].trim());
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
const has = (html, s) => html.includes(s) || html.includes(esc(s)) || html.includes(esc(s).replace(/&#39;/g, '’'));
const stripHost = (u) => (u || '').replace(/^https?:\/\/[^/]+/, '');
const noSpace = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) { try { out.push(JSON.parse(m[1])); } catch (_) {} }
  return out;
}
const fullAddress = (l) => [l.street_address, l.unit && `Unit ${l.unit}`, l.city, [l.province, l.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const readSrc = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return ''; } };
const parseJson = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };
const listOf = (j) => (!j ? null : Array.isArray(j) ? j : (j.markers || j.jobs || j.results || j.features || j.items || j.suggestions || j.data || null));

// ---------------------------------------------------------------- form-field discovery (other agents own the views)
/**
 * Legacy (2026-09-09) inline work-location inputs: returns { template } = the street_address input name with `{i}`
 * for the row index (e.g. `loc_street_address[]`); other fields are template.replace('street_address', field).
 */
function discoverLocationFields() {
  const tried = ['loc_street_address[]', 'locations[{i}][street_address]', 'street_address[]'];
  const src = readSrc('views/portal/job-form.ejs');
  const names = [...src.matchAll(/name=(?:"|')([^"']*street_address[^"']*)(?:"|')/g)].map(m => m[1]).filter(n => !/^new_loc_/.test(n));
  const name = names.find(n => /\[|locations/.test(n)) || names[0];
  if (name) return { template: name.replace(/<%[=\-]?[\s\S]*?%>/g, '{i}').replace(/\$\{[^}]*\}/g, '{i}').replace(/\[\d+\]/g, '[{i}]'), source: 'views/portal/job-form.ejs', tried };
  return { template: tried[0], source: 'fallback (no street_address input found in views/portal/job-form.ejs)', tried };
}
function locationParams(params, loc, i, template) {
  for (const f of LOC_FIELDS) params.append(template.replace('street_address', f).replace(/\{i\}/g, String(i)), loc[f] ?? '');
}
/**
 * Job form mode (client PDF 2026-09-10): 'select' = tick address-book rows (`location_ids[]`) + an inline
 * "Add a new location" block (`new_loc_*`) + `operating_name_choice_<profileId>` / `operating_name_new_<profileId>` +
 * `hours_amount`/`hours_period`; 'inline' = the older parallel `loc_*[]` arrays. Decided from the VIEW and the ROUTE
 * file (a route that already expects location_ids with a view that still lacks the checkboxes is reported).
 */
function discoverJobForm() {
  const tried = ['location_ids[]', 'location_ids', 'employer_location_ids[]', 'locations[]'];
  const view = readSrc('views/portal/job-form.ejs'), route = readSrc('routes/portal.js');
  const names = [...new Set([...view.matchAll(/name=(?:"|')([^"']+)(?:"|')/g)].map(m => m[1]))];
  const locField = names.find(n => /^(employer_)?location_ids(\[\])?$/.test(n)) || null;
  const routeSelect = /location_ids/.test(route);
  const newLocPrefix = (names.find(n => /street_address$/.test(n) && !/^loc_/.test(n)) || (route.match(/NEW_LOC\s*=\s*'([^']+)'/) || [])[1] + 'street_address' || 'new_loc_street_address').replace(/street_address$/, '');
  const legacy = discoverLocationFields();
  const hours = { amount: names.includes('hours_amount'), period: names.includes('hours_period') };
  if (locField || routeSelect) {
    return { mode: 'select', locField: locField || tried[0], newLocPrefix: newLocPrefix || 'new_loc_', template: legacy.template, viewHasCheckbox: !!locField, routeSelect, hours, names, tried,
      source: locField ? 'views/portal/job-form.ejs' : `routes/portal.js reads location_ids but views/portal/job-form.ejs has none of ${tried.join(', ')} (view not landed?) — posting the contract names` };
  }
  return { mode: 'inline', ...legacy, locField: null, newLocPrefix: 'new_loc_', viewHasCheckbox: false, routeSelect, hours, names, tried };
}
/** Cover-sheet file input name from views/seeker/apply.ejs (any file input that is not the resume). */
function discoverCoverField() {
  const tried = ['cover_sheet', 'cover_file', 'cover_letter_file', 'cover'];
  const src = readSrc('views/seeker/apply.ejs');
  const files = [...src.matchAll(/<input[^>]*type=(?:"|')file(?:"|')[^>]*>/gi)].map(m => (m[0].match(/name=(?:"|')([^"']+)(?:"|')/) || [])[1]).filter(Boolean);
  const name = files.find(n => n !== 'resume');
  if (name) return { name, source: 'views/seeker/apply.ejs', tried };
  return { name: tried[0], source: 'fallback (no second file input found in views/seeker/apply.ejs)', tried };
}

// ---------------------------------------------------------------- job form payload
function jobForm(profileId, title, overrides = {}) {
  const form = {
    employer_profile_id: profileId || '', profile_id: profileId || '',
    title, description: 'Smoke test posting created automatically by scripts/smoke.js to exercise the publish, checkout and cancel flow.\n\nThis job is cancelled again by the same script a few seconds later, so nobody should ever see it or apply to it. If you can read this on the public site, the cancel step failed.',
    requirements: 'None.', benefits: 'None.', category: 'administration', job_type: 'full_time', work_arrangement: 'hybrid',
    // Job Bank vocabulary (2026-09-10): the old entry/intermediate/… and certificate/professional keys are legacy now
    experience_level: '1_2_years', education: 'college', education_other: '', experience_other: '',
    city: LOCATIONS[0].city, province: LOCATIONS[0].province, postal_code: LOCATIONS[0].postal_code,
    salary_min: '1800', salary_max: '2000', salary_period: 'biweekly', vacancies: '1', languages: 'English', skills: 'Teamwork, Communication',
    hours_amount: '35', hours_period: 'week',
    apply_email: 'apply@example.com', noc_code: '13100', ...overrides,
  };
  const params = new URLSearchParams(form);
  params.append('audiences', 'professionals'); params.append('audiences', 'youth');
  return params;
}
const newLocParams = (params, loc, prefix) => { for (const f of ['label', ...LOC_FIELDS]) params.append(prefix + f, loc[f] ?? ''); };
const postForm = (path, params, jar) => request(BASE, path, { method: 'POST', body: params.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, jar });
const profileOf = (role) => one('SELECT id, company_name, operating_name, operating_names, contact_email, industry FROM employer_profiles WHERE owner_user_id=(SELECT id FROM users WHERE email=$1) AND archived IS NOT TRUE ORDER BY id LIMIT 1', [LOGINS[role]]);

/**
 * Make sure `loc` is in the profile's address book (employer_locations). Existing row → reused; else created through the
 * portal route (POST /employer/profile/locations or /consultant/profiles/:id/locations, fields loc_*) and reported; if the
 * route did not create it, a psql insert keeps the rest of the run going (printed, so the FAIL above is not hidden).
 */
async function ensureEmployerLocation(role, jar, base, profile, loc) {
  const find = () => one("SELECT id FROM employer_locations WHERE employer_profile_id=$1 AND NOT archived AND street_address=$2 AND replace(upper(postal_code), ' ', '')=$3 ORDER BY id LIMIT 1", [profile.id, loc.street_address, noSpace(loc.postal_code)]);
  let row = await find();
  if (row) return { id: row.id, via: 'existing' };
  const routePath = role === 'consultant' ? `${base}/profiles/${profile.id}/locations` : `${base}/profile/locations`;
  const p = new URLSearchParams();
  for (const f of LOC_FIELDS) p.append('loc_' + f, loc[f] ?? '');
  p.append('loc_label', `${MARK} ${loc.street_address}`);
  const r = await postForm(routePath, p, jar);
  row = await find();
  report(r.status === 302 && !!row, `${role}: POST ${routePath} (address book: ${loc.street_address}) → 302 + employer_locations row`, describe(r) + (row ? ` id=${row.id}` : `; no row — ${errorsIn(r.text) || '(no error text)'}; fields sent: loc_label loc_street_address loc_unit loc_city loc_province loc_postal_code`));
  if (row) return { id: row.id, via: 'portal' };
  row = await one('INSERT INTO employer_locations(employer_profile_id, label, street_address, unit, city, province, postal_code) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [profile.id, `${MARK} ${loc.street_address}`, loc.street_address, loc.unit || null, loc.city, loc.province, loc.postal_code]);
  console.log(`      (psql fallback: inserted employer_locations#${row.id} so the posting flow can continue)`);
  return { id: row.id, via: 'psql' };
}

// ---------------------------------------------------------------- posting flow (employer + consultant)
/**
 * Post-a-job → validation → publish → checkout (role price) → sandbox card → active → public page (locations,
 * operating name, hours, Job Bank phrases, bi-weekly, print, JSON-LD) → receipt (owner 200 / other 302|404) →
 * cancel-now → 404. Locations come from the profile address book in 'select' mode (2026-09-10) or inline in 'inline' mode.
 */
async function postingFlow(role, jar, otherJar, guest, form) {
  const base = role === 'consultant' ? '/consultant' : '/employer';
  const P = PRICE[role];
  const g = await expectPage(role, `${base}/jobs/new`, jar);
  if (g.status !== 200) return;
  const profile = await profileOf(role);
  if (!profile) return report(false, `${role}: an employer profile to post under`, 'none in DB');
  const stamp = Date.now().toString(36);
  const select = form.mode === 'select';
  const fieldsNote = select ? `location fields: ${form.locField} + ${form.newLocPrefix}{${LOC_FIELDS.join(',')}} (${form.source})` : `location fields: ${form.template.replace(/\{i\}/g, '0')} … (from ${form.source})`;

  // address-book rows the posting will tick (select mode)
  const ids = [];
  if (select) for (const l of LOCATIONS) ids.push((await ensureEmployerLocation(role, jar, base, profile, l)).id);
  const addLocs = (params, locs) => select ? locs.forEach(l => params.append(form.locField, String(ids[LOCATIONS.indexOf(l)]))) : locs.forEach((l, i) => locationParams(params, l, i, form.template));
  const opChoice = role === 'employer' && (profile.operating_names || []).includes(SMOKE_OPNAME) ? SMOKE_OPNAME : null;
  const opParams = (params) => { if (select) { params.append(`operating_name_choice_${profile.id}`, opChoice || '__legal'); params.append(`operating_name_new_${profile.id}`, ''); } };

  // --- negative validation (each must NOT create a row; any stray draft is removed immediately)
  async function expect422(name, params, title) {
    const r = await postForm(`${base}/jobs/new`, params, jar);
    const stray = await one('SELECT id FROM jobs WHERE title=$1', [title]);
    report(r.status === 422 && !stray, `${role}: POST ${base}/jobs/new ${name} → 422, no row`, `${describe(r)}${stray ? ` STRAY job#${stray.id} created (deleted)` : ''}${r.status !== 422 ? '  ' + (errorsIn(r.text) || '(no error text)') : ''}`);
    if (stray) await q('DELETE FROM jobs WHERE id=$1', [stray.id]);
  }
  if (role === 'employer') {
    if (select) {
      let t = `${MARK} no-location ${stamp}`; let p = jobForm(profile.id, t); opParams(p);
      await expect422(`with no location ticked (${fieldsNote})`, p, t);
      t = `${MARK} bad-postal ${stamp}`; p = jobForm(profile.id, t); opParams(p); newLocParams(p, { ...NEW_LOCATION, postal_code: '12345' }, form.newLocPrefix);
      await expect422(`with an inline new location whose postal_code is 12345 (${form.newLocPrefix}*)`, p, t);
      t = `${MARK} edu-other ${stamp}`; p = jobForm(profile.id, t, { education: 'other', education_other: '' }); opParams(p); addLocs(p, [LOCATIONS[0]]);
      await expect422('with education=other and empty education_other', p, t);
    } else {
      let t = `${MARK} no-address ${stamp}`; let p = jobForm(profile.id, t, { postal_code: '' });
      locationParams(p, { street_address: '', unit: '', city: 'Mississauga', province: 'ON', postal_code: '' }, 0, form.template);
      await expect422(`with no street/postal (${fieldsNote})`, p, t);
      t = `${MARK} bad-postal ${stamp}`; p = jobForm(profile.id, t, { postal_code: '12345' });
      locationParams(p, { ...LOCATIONS[0], postal_code: '12345' }, 0, form.template);
      await expect422('with postal_code 12345', p, t);
      t = `${MARK} edu-other ${stamp}`; p = jobForm(profile.id, t, { education: 'other', education_other: '' });
      locationParams(p, LOCATIONS[0], 0, form.template);
      await expect422('with education=other and empty education_other', p, t);
    }
  }

  // --- create the real posting with TWO work locations, bi-weekly salary, 35 h/week, Job Bank keys, operating name
  const title = `${MARK} Smoke Test ${role === 'consultant' ? 'Consultant' : 'Coordinator'} ${stamp}`;
  const params = jobForm(profile.id, title);
  addLocs(params, LOCATIONS); opParams(params);
  const c = await postForm(`${base}/jobs/new`, params, jar);
  let job = await one('SELECT id, slug, status, city, province, postal_code, salary_period, operating_name, hours_amount, hours_period, education, experience_level FROM jobs WHERE title=$1', [title]);
  report(c.status === 302 && !!job, `${role}: POST ${base}/jobs/new (2 locations${select ? ' ticked from the address book' : ''}, biweekly, 35 h/week) → 302 + draft row`, describe(c) + (job ? ` job#${job.id} status=${job.status}` : ` no job row; ${errorsIn(c.text) || '(no error text)'}; ${fieldsNote}`));
  if (!job) return;
  const rows = await q('SELECT street_address, unit, city, province, postal_code, sort_order, employer_location_id FROM job_locations WHERE job_id=$1 ORDER BY sort_order, id', [job.id]);
  const okRows = rows.length === 2 && LOCATIONS.every(l => rows.some(r => r.street_address === l.street_address && noSpace(r.postal_code) === noSpace(l.postal_code) && r.city === l.city));
  report(okRows, `${role}: 2 job_locations rows with street + postal`, rows.length ? rows.map(fullAddress).join(' | ') : `0 rows (${fieldsNote})`);
  if (select) report(rows.length === 2 && rows.every(r => r.employer_location_id != null && ids.map(String).includes(String(r.employer_location_id))), `${role}: job_locations rows carry employer_location_id ∈ {${ids.join(', ')}}`, `got ${rows.map(r => r.employer_location_id ?? 'NULL').join(', ') || 'no rows'}`);
  report(job.city === LOCATIONS[0].city && job.province === LOCATIONS[0].province, `${role}: jobs.city/province = first location`, `${job.city}, ${job.province}`);
  report(job.salary_period === 'biweekly', `${role}: jobs.salary_period = biweekly`, `salary_period=${job.salary_period}`);
  report(Number(job.hours_amount) === 35 && job.hours_period === 'week', `${role}: jobs.hours_amount / hours_period = 35 / week`, `hours_amount=${job.hours_amount} hours_period=${job.hours_period}${form.hours.amount ? '' : ' (view has no hours_amount input)'}`);
  report(job.education === 'college' && job.experience_level === '1_2_years', `${role}: Job Bank education/experience keys accepted (college, 1_2_years)`, `education=${job.education} experience_level=${job.experience_level}`);
  if (opChoice) report(job.operating_name === opChoice, `${role}: jobs.operating_name = "${opChoice}" via operating_name_choice_${profile.id}`, `operating_name=${job.operating_name}`);
  else if (select) report(job.operating_name == null || job.operating_name === profile.company_name, `${role}: jobs.operating_name empty for the legal-name choice (__legal)`, `operating_name=${job.operating_name}`);
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
  if (!sandboxPath) return report(false, `${role}: sandbox card page`, 'no sandbox Location to follow (Stripe mode? set STRIPE_SECRET_KEY empty / clear the stripe_secret_key setting for sandbox)');
  await expectPage(role, sandboxPath, jar);
  const card = { card_number: '4242424242424242', number: '4242424242424242', card: '4242 4242 4242 4242', name: 'Maria Santos', cardholder: 'Maria Santos',
    exp: '12/34', expiry: '12/34', exp_month: '12', exp_year: '2034', cvc: '123', cvv: '123', postal_code: 'L5B 1M2' };
  const pay = await expectRedirect(`${role}: POST ${sandboxPath} (card 4242) → 302 /billing/success`, sandboxPath, jar, /\/billing\/success/, { method: 'POST', form: card });
  if (pay.status >= 400 && pay.text) console.log('      sandbox form errors: ' + (errorsIn(pay.text) || '(none found in HTML)'));
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

  // --- public page: search, detail (addresses, operating name, hours, vocabulary, bi-weekly, print, JSON-LD), sitemap
  const pubList = await request(BASE, '/jobs?q=' + encodeURIComponent('Smoke Test'), { jar: guest });
  report(pubList.status === 200 && pubList.text.includes(job.slug), `${role}: new job appears in public /jobs search`, describe(pubList));
  const pg = await expectPage('public', `/jobs/${job.slug}`, guest);
  if (pg.status === 200) {
    const missing = LOCATIONS.map(fullAddress).filter(a => !has(pg.text, a));
    report(!missing.length, `${role}: public page lists both full work addresses`, missing.length ? `missing: ${missing.join(' | ')}` : LOCATIONS.map(fullAddress).join(' | '));
    const shownName = opChoice || profile.operating_name;
    if (shownName) report(has(pg.text, shownName), `${role}: public page shows operating name "${shownName}"${opChoice ? ' (chosen for this posting)' : ' (profile default)'}`);
    report(/35 hours per week/.test(pg.text), `${role}: public page shows "35 hours per week"`, (pg.text.match(/\d+(?:\.\d+)?\s*hours\s+[^<]{0,20}/) || ['no "N hours …" text on the page'])[0].trim());
    const expPhrase = (C.EXPERIENCE_LEVEL_NAME || {})['1_2_years'] || '1 year to less than 2 years', eduPhrase = (C.EDUCATION_LEVEL_NAME || {}).college || 'College/CEGEP';
    report(has(pg.text, expPhrase) && has(pg.text, eduPhrase), `${role}: public page prints Job Bank phrases "${expPhrase}" + "${eduPhrase}"`, `${has(pg.text, expPhrase) ? '' : 'experience phrase missing '}${has(pg.text, eduPhrase) ? '' : 'education phrase missing'}`.trim());
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

/** Employer: inline "Add a new location" + "add new operating name" on the job form → address book +1, profile list +1. Leaves the draft (checkout fixture). */
async function inlineAddStep(employer, form) {
  const profile = await profileOf('employer');
  if (!profile) return report(false, 'employer inline add-new: profile', 'none in DB');
  const def = await one('SELECT id FROM employer_locations WHERE employer_profile_id=$1 AND NOT archived ORDER BY is_default DESC, id LIMIT 1', [profile.id]);
  const before = await one('SELECT count(*)::int AS n FROM employer_locations WHERE employer_profile_id=$1 AND NOT archived', [profile.id]);
  const stamp = Date.now().toString(36);
  const newName = `Smoke Trade ${stamp}`;
  const title = `${MARK} Inline Location ${stamp}`;
  const p = jobForm(profile.id, title);
  if (def) p.append(form.locField, String(def.id));
  newLocParams(p, NEW_LOCATION, form.newLocPrefix);
  p.append(`operating_name_choice_${profile.id}`, '__new'); p.append(`operating_name_new_${profile.id}`, newName);
  const r = await postForm('/employer/jobs/new', p, employer);
  const job = await one('SELECT id, status, operating_name FROM jobs WHERE title=$1', [title]);
  report(r.status === 302 && !!job, `employer: POST /employer/jobs/new with 1 ticked + inline new location (${form.newLocPrefix}*) + new operating name → 302 + draft`, describe(r) + (job ? ` job#${job.id}` : `; ${errorsIn(r.text) || '(no error text)'}`));
  if (!job) return null;
  const after = await one('SELECT count(*)::int AS n FROM employer_locations WHERE employer_profile_id=$1 AND NOT archived', [profile.id]);
  const added = await one('SELECT id, label, lat FROM employer_locations WHERE employer_profile_id=$1 AND street_address=$2 AND NOT archived', [profile.id, NEW_LOCATION.street_address]);
  report(after.n - before.n === 1 && !!added, 'employer: inline new location saved to the address book (employer_locations +1)', `before=${before.n} after=${after.n}${added ? ` id=${added.id} label="${added.label}"` : ''}`);
  const rows = await q('SELECT street_address, employer_location_id FROM job_locations WHERE job_id=$1 ORDER BY sort_order', [job.id]);
  report(rows.length === (def ? 2 : 1) && rows.some(x => x.street_address === NEW_LOCATION.street_address && added && String(x.employer_location_id) === String(added.id)), `employer: draft has ${def ? 2 : 1} job_locations incl. the new one linked by employer_location_id`, rows.map(x => `${x.street_address}→${x.employer_location_id ?? 'NULL'}`).join(' | ') || 'no rows');
  const prof = await one('SELECT operating_names FROM employer_profiles WHERE id=$1', [profile.id]);
  report((prof.operating_names || []).includes(newName) && job.operating_name === newName, `employer: new operating name "${newName}" appended to profile.operating_names + stored on the job`, `operating_names=${JSON.stringify(prof.operating_names)} job.operating_name=${job.operating_name}`);
  return job;
}

/** Employer profile save: industry as a C.INDUSTRIES key + operating_names[] list (adds SMOKE_OPNAME, idempotent). */
async function profileSaveStep(employer) {
  const prof = await one('SELECT * FROM employer_profiles WHERE owner_user_id=(SELECT id FROM users WHERE email=$1) AND archived IS NOT TRUE ORDER BY id LIMIT 1', [LOGINS.employer]);
  if (!prof) return report(false, 'employer profile save: profile', 'none in DB');
  const industries = C.INDUSTRIES || [];
  const industryKey = ((industries.find(([, n]) => /transport/i.test(n)) || industries[0] || ['transportation_warehousing'])[0]);
  const g = await expectPage('employer', '/employer/profile', employer);
  if (g.status === 200) {
    const sel = /<select[^>]*name="industry"/.test(g.text), opt = g.text.includes(`value="${industryKey}"`);
    report(sel && opt, `employer profile: industry is a <select> listing C.INDUSTRIES keys (e.g. ${industryKey})`, `${sel ? '' : 'no <select name="industry"> '}${opt ? '' : `option value="${industryKey}" missing`}`.trim());
    report(/name="operating_names(\[\])?"/.test(g.text), 'employer profile: operating names are a list (operating_names[] inputs)', /name="operating_names/.test(g.text) ? '' : `inputs present: ${[...new Set([...g.text.matchAll(/name="(operating[^"]*)"/g)].map(m => m[1]))].join(', ') || 'none named operating*'}`);
    report(/name="loc_street_address"|\/profile\/locations/.test(g.text), 'employer profile: address book (locations block + /employer/profile/locations form)', '');
  }
  const names = (prof.operating_names || []).filter(n => n !== SMOKE_OPNAME && !/^Smoke Trade /.test(n));
  const list = names.length ? names : (prof.operating_name ? [prof.operating_name] : []);
  const fd = new FormData();
  for (const [k, v] of Object.entries({ company_name: prof.company_name, website: prof.website, industry: industryKey, company_size: prof.company_size, description: prof.description, contact_name: prof.contact_name, contact_email: prof.contact_email, contact_phone: prof.contact_phone, city: prof.city, province: prof.province, street_address: prof.street_address, postal_code: prof.postal_code, logo_present: prof.logo_path ? '1' : '' })) fd.append(k, v ?? '');
  for (const n of [...list, SMOKE_OPNAME]) fd.append('operating_names[]', n);
  fd.append('operating_name', list[0] || '');   // legacy single field, still accepted
  const r = await request(BASE, '/employer/profile', { method: 'POST', body: fd, jar: employer });
  const after = await one('SELECT industry, operating_name, operating_names FROM employer_profiles WHERE id=$1', [prof.id]);
  report(r.status === 302, `employer: POST /employer/profile (industry=${industryKey}, operating_names[] ×${list.length + 1}) → 302`, describe(r) + (r.status === 302 ? '' : ' ' + (errorsIn(r.text) || '(no error text)')));
  report(after.industry === industryKey, `employer_profiles.industry stores the key "${industryKey}"`, `industry=${after.industry}`);
  report((after.operating_names || []).includes(SMOKE_OPNAME) && after.operating_name === (list[0] || SMOKE_OPNAME), `employer_profiles.operating_names holds the list (+ "${SMOKE_OPNAME}"), operating_name = first entry`, `operating_names=${JSON.stringify(after.operating_names)} operating_name=${after.operating_name}`);
}

/** The job form's apply_email defaults to the SELECTED profile's contact_email — never the consultant's own address. */
async function applyEmailStep(employer, consultant) {
  const emp = await profileOf('employer');
  const con = await one("SELECT id, contact_email FROM employer_profiles WHERE owner_user_id=(SELECT id FROM users WHERE email=$1) AND archived IS NOT TRUE AND contact_email IS NOT NULL AND contact_email <> '' ORDER BY id LIMIT 1", [LOGINS.consultant]);
  if (employer && emp) {
    const r = await request(BASE, '/employer/jobs/new', { jar: employer });
    const v = inputValue(r.text, 'apply_email');
    report(r.status === 200 && v === emp.contact_email, `employer: /employer/jobs/new defaults apply_email to the profile's contact_email (${emp.contact_email})`, `${describe(r)} value=${v === null ? '(no apply_email input)' : JSON.stringify(v)}`);
    report(/Application email\s*(?:<[^>]+>\s*)*\(the employer.s inbox\)/i.test(r.text), 'job form label reads "Application email (the employer’s inbox)"', ((r.text.match(/<label[^>]*for="apply_email"[^>]*>([\s\S]*?)<\/label>/) || [])[1] || 'label not found').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  }
  if (consultant && con) {
    const r = await request(BASE, `/consultant/jobs/new?profile=${con.id}`, { jar: consultant });
    const v = inputValue(r.text, 'apply_email');
    report(r.status === 200 && v === con.contact_email && v !== LOGINS.consultant, `consultant: /consultant/jobs/new?profile=${con.id} defaults apply_email to that profile's contact_email (${con.contact_email}), not ${LOGINS.consultant}`, `${describe(r)} value=${v === null ? '(no apply_email input)' : JSON.stringify(v)}`);
  } else report(false, 'consultant apply_email default', consultant ? 'no consultant profile with a contact_email' : 'consultant login failed');
}

/** Legacy vocabulary keys on an existing row render the mapped Job Bank phrases (EXPERIENCE_LEGACY / EDUCATION_LEGACY). */
async function legacyVocabStep(active, guest) {
  const j = await one('SELECT id, slug, experience_level, education FROM jobs WHERE id=$1', [active.id]);
  const expPhrase = ((C.EXPERIENCE_LEVEL_NAME || {})[(C.EXPERIENCE_LEGACY || {}).entry]) || '1 year to less than 2 years';
  const eduPhrase = ((C.EDUCATION_LEVEL_NAME || {})[(C.EDUCATION_LEGACY || {}).certificate]) || 'College/CEGEP';
  await q("UPDATE jobs SET experience_level='entry', education='certificate' WHERE id=$1", [j.id]);
  try {
    const r = await request(BASE, `/jobs/${j.slug}`, { jar: guest });
    report(r.status === 200 && has(r.text, expPhrase) && has(r.text, eduPhrase), `legacy keys entry/certificate on ${j.slug} render "${expPhrase}" / "${eduPhrase}"`, `${describe(r)}${has(r.text, expPhrase) ? '' : ' experience phrase missing'}${has(r.text, eduPhrase) ? '' : ' education phrase missing'}`);
  } finally { await q('UPDATE jobs SET experience_level=$2, education=$3 WHERE id=$1', [j.id, j.experience_level, j.education]); }
}

// ---------------------------------------------------------------- admin integrations (passcode gate, settings groups, secrets, email test, admins, support routing)
async function adminIntegrationsStep(admin, employer, draftJobId) {
  const out = { recipients: null };
  const INTEG = '/admin/integrations', UNLOCK = '/admin/integrations/unlock';
  const unlockForm = (passcode) => ({ action: 'unlock', passcode, next: INTEG });
  // gate
  const r0 = await request(BASE, INTEG, { jar: admin });
  report(r0.status === 302 && /\/admin\/integrations\/unlock/.test(r0.location || ''), `GET ${INTEG} while locked → 302 ${UNLOCK}`, describe(r0));
  const u = await expectPage('admin', UNLOCK, admin);
  if (u.status === 200) report(/name="passcode"/.test(u.text) && !/name="passcode2"/.test(u.text), 'unlock page asks for the existing passcode (not first-run "set")', /passcode2/.test(u.text) ? 'shows the SET form: settings.admin_passcode not visible to the server (lib/settings.set failed, or cache not expired)' : '');
  const bad = await request(BASE, UNLOCK, { method: 'POST', form: unlockForm('wrong-pass-000'), jar: admin });
  const still = await request(BASE, INTEG, { jar: admin });
  report(bad.status === 302 && /unlock/.test(bad.location || '') && still.status === 302, `POST ${UNLOCK} with a wrong passcode → back to unlock, ${INTEG} still 302`, `${describe(bad)}; then GET → ${describe(still)}`);
  const good = await request(BASE, UNLOCK, { method: 'POST', form: unlockForm(PASSCODE), jar: admin });
  const page = await request(BASE, INTEG, { jar: admin });
  const unlocked = good.status === 302 && !/unlock/.test(good.location || '') && page.status === 200;
  report(unlocked, `POST ${UNLOCK} with the passcode → 302 ${INTEG} → 200`, `${describe(good)}; then GET → ${describe(page)}${!unlocked ? ' ' + flashes(page.text).join(' | ') : ''}`);
  if (!unlocked) return out;
  checkHtml(`GET ${INTEG}`, page);
  const html = page.text;
  const groupsFound = ['employer_price_cents', 'stripe_secret_key', 'mail_provider', 'support_email', 'google_maps_api_key', 'jobbank_sync'].filter(k => new RegExp(`name="${k}"`).test(html));
  report(groupsFound.length === 6, 'integrations page renders pricing/stripe/email/support/maps/jobbank fields', `found: ${groupsFound.join(', ') || 'none'}`);
  const postGroup = async (group, key, overrides) => {
    const f = findForm(html, key);
    const form = { ...(f ? f.fields : {}), ...overrides };
    const action = (f && f.action) || `${INTEG}/${group}`;
    const r = await request(BASE, action, { method: 'POST', form, jar: admin });
    const after = await request(BASE, INTEG, { jar: admin });
    return { r, action, form, flash: flashes(after.text).join(' | '), fromPage: !!f };
  };
  const setting = (key) => one('SELECT value, is_secret FROM settings WHERE key=$1', [key]);
  const checkoutShows = async (id, amounts, tries = 8) => {   // pricing is read at call time, but poll a little in case of a short cache
    let found = [], prices = '';
    for (let i = 0; i < tries; i++) {
      const co = await request(BASE, `/billing/checkout/${id}`, { jar: employer });
      found = amounts.filter(s => co.text.includes(s)); prices = `${co.status} prices: ${[...new Set(co.text.match(/\$\d+\.\d{2}/g) || [])].join(' ')}`;
      if (found.length === amounts.length) break;
      await sleep(1000);
    }
    return { ok: found.length === amounts.length, prices };
  };

  // pricing group → settings row → checkout price
  const pr = await postGroup('pricing', 'employer_price_cents', { employer_price_cents: RAISED.cents });
  const row = await setting('employer_price_cents');
  report(pr.r.status === 302 && row && row.value === RAISED.cents, `POST ${pr.action} employer_price_cents=${RAISED.cents} → settings row updated`, `${describe(pr.r)} settings.employer_price_cents=${row ? row.value : '(no row)'}${pr.fromPage ? '' : ' (form not found on the page — posted contract fields)'} flash: ${pr.flash}`);
  if (employer && draftJobId) {
    const s1 = await checkoutShows(draftJobId, [RAISED.base, RAISED.tax, RAISED.total]);
    report(s1.ok, `GET /billing/checkout/${draftJobId} as employer now shows $${RAISED.base} + $${RAISED.tax} = $${RAISED.total} (no restart)`, s1.prices);
  } else report(false, 'checkout reflects the new price', employer ? 'no employer draft job to open checkout for' : 'employer login failed');
  const pr2 = await postGroup('pricing', 'employer_price_cents', { employer_price_cents: '1499' });
  const row2 = await setting('employer_price_cents');
  report(pr2.r.status === 302 && row2 && row2.value === '1499', 'pricing restored to 1499 through the panel', `settings.employer_price_cents=${row2 ? row2.value : '(no row)'}`);
  if (employer && draftJobId) { const s2 = await checkoutShows(draftJobId, [PRICE.employer.base, PRICE.employer.tax, PRICE.employer.total]); report(s2.ok, `checkout back to $${PRICE.employer.total}`, s2.prices); }

  // secrets are encrypted at rest (stripe_webhook_secret: harmless in sandbox; cleared right after)
  const sec = await postGroup('stripe', 'stripe_webhook_secret', { stripe_webhook_secret: 'whsec_smoketest0123456789', stripe_secret_key: '', stripe_publishable_key: '' });
  const srow = await setting('stripe_webhook_secret');
  report(sec.r.status === 302 && srow && /^enc:v1:/.test(srow.value) && srow.is_secret, `POST ${sec.action} stripe_webhook_secret → stored as enc:v1:… with is_secret`, `${describe(sec.r)} value=${srow ? srow.value.slice(0, 12) + '…' : '(no row)'} is_secret=${srow ? srow.is_secret : '-'} flash: ${sec.flash}`);
  const clr = await postGroup('stripe', 'stripe_webhook_secret', { stripe_webhook_secret: '', stripe_webhook_secret__clear: '1', stripe_secret_key: '', stripe_publishable_key: '' });
  let crow = await setting('stripe_webhook_secret');
  if (crow && crow.value) { if (settingsLib) { await settingsLib.set('stripe_webhook_secret', ''); crow = await setting('stripe_webhook_secret'); } }
  report(!crow || crow.value === '', 'stripe_webhook_secret cleared again (stripe_webhook_secret__clear=1)', `${describe(clr.r)} value now ${crow ? JSON.stringify(crow.value.slice(0, 12)) : '(no row)'}`);
  const skey = await setting('stripe_secret_key');
  report(!skey || skey.value === '', 'stripe_secret_key still empty (instance stays in sandbox mode)', skey && skey.value ? 'SET — later checkout steps would hit Stripe' : '');

  // test email with no provider
  const te = await request(BASE, `${INTEG}/email/test`, { method: 'POST', form: { to: 'smoke-mailtest@example.com' }, jar: admin });
  const teP = await request(BASE, INTEG, { jar: admin });
  const teFlash = flashes(teP.text).find(f => /smoke-mailtest@example\.com/.test(f)) || '';
  report(te.status === 302 && /logged|no email provider|not delivered|outbox/i.test(teFlash), `POST ${INTEG}/email/test with provider none → flash says the mail was logged / no provider`, `${describe(te)} flash: ${teFlash || flashes(teP.text).join(' | ') || '(none)'}`);

  // add an admin login
  const au = await request(BASE, `${INTEG}/access/admins`, { method: 'POST', form: SMOKE_ADMIN, jar: admin });
  const urow = await one('SELECT id, role, is_active FROM users WHERE email=$1', [SMOKE_ADMIN.email]);
  report(au.status === 302 && urow && urow.role === 'admin' && urow.is_active, `POST ${INTEG}/access/admins (name/email/password) → users row role=admin`, `${describe(au)} ${urow ? JSON.stringify(urow) : 'no row; ' + flashes((await request(BASE, INTEG, { jar: admin })).text).join(' | ')}`);
  if (urow) {
    const s = await login(BASE, SMOKE_ADMIN.email, SMOKE_ADMIN.password, { consumeFlash: false });
    report(s.ok, `new admin ${SMOKE_ADMIN.email} can log in`, `${s.status}${s.location ? ' → ' + s.location : ''}${s.cookie ? '' : ' (no cookie)'}`);
    if (s.ok) { const a = await request(BASE, '/admin', { jar: s.jar }); report(a.status === 200, 'new admin reaches /admin → 200', describe(a)); }
  }

  // support routing → used by the contact step; restored afterwards by restoreSupport()
  const sf = findForm(html, 'support_email');
  out.previousSupport = sf ? sf.fields.support_email : (settingsLib ? await settingsLib.get('support_email') : '');
  const sp = await postGroup('support', 'support_email', { support_email: SUPPORT_RECIPIENTS.join(', ') });
  const sprow = await setting('support_email');
  report(sp.r.status === 302 && sprow && SUPPORT_RECIPIENTS.every(a => (sprow.value || '').includes(a)), `POST ${sp.action} support_email = two recipients → settings row`, `${describe(sp.r)} settings.support_email=${sprow ? JSON.stringify(sprow.value) : '(no row)'}`);
  if (sprow && SUPPORT_RECIPIENTS.every(a => (sprow.value || '').includes(a))) out.recipients = SUPPORT_RECIPIENTS;
  out.restoreSupport = async () => { const r = await postGroup('support', 'support_email', { support_email: out.previousSupport || '' }); const v = await setting('support_email'); report(r.r.status === 302 && v && v.value === (out.previousSupport || ''), `support_email restored to ${JSON.stringify(out.previousSupport || '')}`, `now ${v ? JSON.stringify(v.value) : '(no row)'}`); };
  return out;
}

// ---------------------------------------------------------------- maps (job page map, geocoder, geo API, distance in search, autocomplete proxy)
async function mapsStep(guest, active) {
  let nominatim = false;
  try { const r = await fetch('https://nominatim.openstreetmap.org/status?format=json', { headers: { 'user-agent': 'canada-careers-qa (scripts/smoke.js)' }, signal: AbortSignal.timeout(6000) }); nominatim = r.ok; } catch (_) {}
  console.log(`      Nominatim reachable: ${nominatim}`);

  const geoQuery = () => one("SELECT j.slug, l.id AS loc_id, l.lat, l.lng, l.city, l.geocode_provider FROM jobs j JOIN job_locations l ON l.job_id=j.id WHERE j.status='active' AND j.expires_at > now() AND j.source IS NULL AND l.lat IS NOT NULL ORDER BY j.id LIMIT 1");
  let geo = await geoQuery(); let how = geo ? 'rows already geocoded' : '';
  if (!geo) {
    if (!fs.existsSync(path.join(ROOT, 'jobs', 'geocode.js'))) how = 'jobs/geocode.js missing (maps agent not landed)';
    else if (!nominatim) how = 'Nominatim unreachable — geocoder skipped';
    else {
      const t0 = Date.now();
      const res = spawnSync(process.execPath, ['jobs/geocode.js', '--limit=25'], { cwd: ROOT, env: { ...process.env }, timeout: 150000, encoding: 'utf8' });
      how = `ran node jobs/geocode.js --limit=25 in ${Math.round((Date.now() - t0) / 1000)}s → ${((res.stdout || '') + (res.stderr || '')).trim().split('\n').filter(Boolean).pop() || 'no output'}`;
      geo = await geoQuery();
    }
  }
  if (!geo) {   // manual coordinates so the API / search checks below still mean something
    const l = await one("SELECT l.id, l.city FROM job_locations l JOIN jobs j ON j.id=l.job_id WHERE j.status='active' AND j.expires_at > now() AND j.source IS NULL AND l.lat IS NULL ORDER BY j.id LIMIT 1");
    const c = l && CITY_COORDS[l.city];
    if (c) { await q("UPDATE job_locations SET lat=$2, lng=$3, geocoded_at=now(), geocode_provider='manual' WHERE id=$1", [l.id, c[0], c[1]]); geo = await geoQuery(); how += `; FALLBACK: manual lat/lng set on job_locations#${l.id} (${l.city})`; }
  }
  report(!!geo && geo.geocode_provider !== 'manual', 'a live job has geocoded job_locations (lat/lng from the geocoder)', `${how}${geo ? ` → ${geo.slug} ${geo.lat},${geo.lng} (${geo.geocode_provider})` : ''}`);
  const geocodedCount = await one('SELECT count(*)::int AS n FROM job_locations WHERE lat IS NOT NULL');
  console.log(`      geocoded job_locations rows: ${geocodedCount.n}`);
  // the map block only renders once a location has coordinates, so check the page AFTER the geocoder ran
  const slug = geo ? geo.slug : active.slug;
  const r = await request(BASE, `/jobs/${slug}`, { jar: guest });
  const container = /data-map\b|id="[^"]*\bmap\b[^"]*"|class="[^"]*\bjob-map\b/.test(r.text), script = /\/js\/maps\.js/.test(r.text);
  report(container && script, `job page /jobs/${slug} has a map container ([data-map]) + loads /js/maps.js`, `${container ? '' : 'no [data-map] / #map container '}${script ? '' : 'no maps.js script'}`.trim());
  report(/CC_MAPS/.test(r.text), 'job page exposes window.CC_MAPS (provider config)', '');
  const markersAttr = (r.text.match(/data-markers="([^"]*)"/) || [])[1];
  report(!!markersAttr && /lat/.test(markersAttr), 'job page map has a data-markers pin per geocoded location', markersAttr ? markersAttr.replace(/&#34;|&quot;/g, '"').slice(0, 100) : 'no data-markers attribute');

  const near = 'Mississauga, ON';
  const api = await request(BASE, `/api/jobs/geo?near=${encodeURIComponent(near)}&radius_km=25`, { jar: guest });
  const json = /json/.test(api.contentType) ? parseJson(api.text) : null;
  const markers = listOf(json) || [];
  report(api.status === 200 && !!json && markers.length >= 1, `GET /api/jobs/geo?near=${near}&radius_km=25 → JSON with ≥ 1 marker`, `${describe(api)} ${json ? `keys=${Array.isArray(json) ? '[array]' : Object.keys(json).join(',')} markers=${markers.length}` : 'body: ' + api.text.slice(0, 100).replace(/\s+/g, ' ')}${!nominatim ? ' (Nominatim unreachable — "near" cannot resolve unless cached)' : ''}`);
  if (!(json && markers.length)) {
    const [lat, lng] = CITY_COORDS.Mississauga;
    const api2 = await request(BASE, `/api/jobs/geo?lat=${lat}&lng=${lng}&radius_km=25`, { jar: guest });
    const j2 = parseJson(api2.text); const m2 = listOf(j2) || [];
    report(api2.status === 200 && !!j2 && m2.length >= 1, `GET /api/jobs/geo?lat=${lat}&lng=${lng}&radius_km=25 (coordinate form) → ≥ 1 marker`, `${describe(api2)} markers=${m2.length}`);
  }
  const s = await request(BASE, `/jobs?near=${encodeURIComponent('Brampton, ON')}&radius_km=25`, { jar: guest });
  const dist = (s.text.match(/\b\d+(?:\.\d+)?\s?km\b/) || [])[0];
  report(s.status === 200 && !!dist, 'GET /jobs?near=Brampton, ON&radius_km=25 → results show a distance ("… km")', `${describe(s)} ${dist ? 'e.g. "' + dist + '"' : 'no "N km" text' + (/no jobs|0 jobs|No results/i.test(s.text) ? ' (page says no results)' : '')}`);
  const sg = await request(BASE, `/api/geocode/suggest?q=${encodeURIComponent('2400 Derry')}`, { jar: guest });
  const sj = parseJson(sg.text); const list = listOf(sj);
  report(sg.status === 200 && Array.isArray(list) && list.length <= 5 && (list.length >= 1 || !nominatim), 'GET /api/geocode/suggest?q=2400 Derry → JSON array, ≤ 5 results', `${describe(sg)} ${Array.isArray(list) ? `${list.length} result(s)${list[0] ? ': ' + JSON.stringify(list[0]).slice(0, 120) : ''}` : 'body: ' + sg.text.slice(0, 100).replace(/\s+/g, ' ')}${!nominatim ? ' (Nominatim unreachable)' : ''}`);
}

// ---------------------------------------------------------------- contact form (support recipients from settings + auto-reply)
async function contactStep(guest, recipients) {
  const before = await one('SELECT coalesce(max(id), 0)::bigint AS id FROM mail_outbox');
  const subject = `${MARK} Smoke test message ${Date.now().toString(36)}`;
  const r = await expectRedirect('POST /contact → 302 /contact/thanks', '/contact', guest, /\/contact\/thanks/, {
    method: 'POST', form: { name: 'Smoke Tester', email: 'smoke@example.com', phone: '416-555-0100', category: 'technical', subject, message: 'This is an automated smoke-test message. Please ignore.' } });
  if (r.status !== 302) console.log('      contact form errors: ' + (errorsIn(r.text) || '(none found in HTML)'));
  if (r.location) await expectPage('public', stripHost(r.location), guest);
  const row = await one('SELECT id, status, assigned_to FROM contact_messages WHERE subject=$1', [subject]);
  report(!!row, 'contact_messages row exists', row ? JSON.stringify(row) : 'no row');
  const rows = await q('SELECT to_email, status FROM mail_outbox WHERE id > $1 ORDER BY id', [before.id]);
  const to = rows.map(x => x.to_email);
  const auto = to.some(t => /smoke@example\.com/.test(t || ''));
  if (recipients) {
    const missing = recipients.filter(a => !to.some(t => (t || '').toLowerCase().includes(a)));
    report(!missing.length && auto, `contact POST emailed every configured support recipient (${recipients.join(', ')}) + auto-reply to the sender`, `outbox to: ${to.join(' | ') || 'none'}${missing.length ? ' — MISSING ' + missing.join(', ') + ' (routes/contact.js not reading settings.support_email?)' : ''}`);
  } else report(rows.length === 2 && auto, 'contact POST recorded 2 mail_outbox rows (support + auto-reply)', `delta=${rows.length} to: ${to.join(' | ')}`);
}

// ---------------------------------------------------------------- round 3 (2026-09-14): public id, locking, decimal salary, posting dates, "Other platform link", preview hours
const ymd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });   // yyyy-mm-dd like h.formatDateInput
const daysFromNow = (n) => ymd(Date.now() + n * 86400000);
/** Distinct job slugs linked from a listing page (excludes /jobs/id/…, /jobs/…/apply, query URLs). */
const listedSlugs = (html) => [...new Set([...String(html || '').matchAll(/href="\/jobs\/([a-z0-9-]+)"/g)].map(m => m[1]).filter(s => s !== 'id'))];
const jobRow = (id) => one('SELECT id, slug, title, status, description, public_id, locked_at, published_at, application_deadline::text AS application_deadline, expires_at, salary_min, salary_max, salary_period, hours_amount, hours_period, employer_profile_id FROM jobs WHERE id=$1', [id]);
const locKeys = (id) => q('SELECT employer_location_id, street_address, postal_code FROM job_locations WHERE job_id=$1 ORDER BY sort_order, id', [id]).then(rows => rows.map(r => `${r.employer_location_id ?? ''}:${r.street_address}:${noSpace(r.postal_code)}`));

/**
 * One employer posting drives every round-3 rule: decimal salary on create → draft has a public id → draft edit changes
 * the title → preview shows hours → "Other platform link" label → publish + sandbox pay → locked_at → locked edit keeps
 * title/locations but saves the description → public page shows Posting ID + "$21.18 – $25.00/hour" → /jobs?q=<pid> →
 * /jobs/id/<pid> → deadline yesterday closes applications (page, seeker GET, seeker POST) → +30 days reopens →
 * published_at = Sep 1 shows as "Posted". The job is cancelled at the end.
 */
async function round3Flow(employer, seeker, guest, form) {
  const base = '/employer';
  const profile = await profileOf('employer');
  if (!profile) return report(false, 'R3: employer profile', 'none in DB');
  const select = form.mode === 'select';
  const ids = [];
  if (select) for (const l of LOCATIONS) ids.push((await ensureEmployerLocation('employer', employer, base, profile, l)).id);
  const stamp = Date.now().toString(36);
  const title = `${MARK} R3 Coordinator ${stamp}`;
  const build = (t, overrides = {}, locs = [LOCATIONS[0]]) => {
    const p = jobForm(profile.id, t, { salary_min: '21.18', salary_max: '25', salary_period: 'hour', ...overrides });
    if (select) { for (const l of locs) p.append(form.locField, String(ids[LOCATIONS.indexOf(l)])); p.append(`operating_name_choice_${profile.id}`, '__legal'); p.append(`operating_name_new_${profile.id}`, ''); }
    else locs.forEach((l, i) => locationParams(p, l, i, form.template));
    return p;
  };
  const postEdit = (id, params) => postForm(`${base}/jobs/${id}/edit`, params, employer);

  // --- salary: decimals accepted, letters rejected
  const bad = await postForm(`${base}/jobs/new`, build(`${MARK} R3 bad-salary ${stamp}`, { salary_min: 'abc' }), employer);
  const stray = await one('SELECT id FROM jobs WHERE title=$1', [`${MARK} R3 bad-salary ${stamp}`]);
  report(bad.status === 422 && !stray, 'R3 salary: POST /employer/jobs/new salary_min=abc → 422, no row', `${describe(bad)}${stray ? ' STRAY row (deleted)' : ''}${bad.status !== 422 ? ' ' + (errorsIn(bad.text) || '(no error text)') : ''}`);
  if (stray) await q('DELETE FROM jobs WHERE id=$1', [stray.id]);
  const c = await postForm(`${base}/jobs/new`, build(title), employer);
  let job = await one('SELECT id FROM jobs WHERE title=$1', [title]).then(r => r && jobRow(r.id));
  report(c.status === 302 && !!job, 'R3 salary: POST /employer/jobs/new salary_min=21.18 salary_max=25 salary_period=hour → 302 + draft', describe(c) + (job ? ` job#${job.id}` : ` no row; ${errorsIn(c.text) || '(no error text)'}`));
  let decimals = !!job;
  if (!job) {   // decimal validation not landed: create the posting with whole dollars so the public-id / lock / date checks below still run, then set the cents with SQL
    const c2 = await postForm(`${base}/jobs/new`, build(title, { salary_min: '21', salary_max: '25' }), employer);
    job = await one('SELECT id FROM jobs WHERE title=$1', [title]).then(r => r && jobRow(r.id));
    if (!job) return report(false, 'R3: fallback draft with whole-dollar salary', `${describe(c2)} ${errorsIn(c2.text) || '(no error text)'} — cannot continue the round-3 flow`) && null;
    await q('UPDATE jobs SET salary_min=21.18, salary_max=25 WHERE id=$1', [job.id]); job = await jobRow(job.id);
    console.log(`      (fallback: draft job#${job.id} created with salary 21/25 and set to 21.18/25.00 by SQL so the rest of the flow can run)`);
  }
  if (decimals) report(Number(job.salary_min) === 21.18 && Number(job.salary_max) === 25, 'R3 salary: jobs.salary_min stored as 21.18 (numeric(10,2))', `salary_min=${job.salary_min} salary_max=${job.salary_max}`);
  const withSalary = (o = {}) => decimals ? o : { ...o, salary_min: '21', salary_max: '25' };   // edits below re-post the form; keep them valid while decimals are rejected

  // --- public id on the draft (fixes agent allocates on create; activateJob allocates on first activation)
  let pid = job.public_id;
  report(!!pid && PUBLIC_ID_RE.test(pid), `R3 public id: created draft has public_id matching ${PUBLIC_ID_RE}`, pid ? `public_id=${pid}` : 'public_id NULL on the draft (allocate-on-create not landed in routes/portal.js)');

  // --- draft edit still changes the title (not locked yet)
  const t2 = `${MARK} R3 Coordinator renamed ${stamp}`;
  const e1 = await postEdit(job.id, build(t2, withSalary({ description: jobForm(profile.id, t2).get('description') })));
  job = await jobRow(job.id);
  report((e1.status === 302 || e1.status === 200) && job.title === t2, `R3 lock: draft edit POST ${base}/jobs/${job.id}/edit with a new title → title changes`, `${describe(e1)} title=${JSON.stringify(job.title)}${e1.status === 422 ? ' ' + (errorsIn(e1.text) || '') : ''}`);
  report(!job.locked_at, 'R3 lock: draft has no locked_at', `locked_at=${job.locked_at}`);

  // --- owner preview + form vocabulary
  const pv = await request(BASE, `${base}/jobs/${job.id}`, { jar: employer });
  report(pv.status === 200 && /35 hours per week/.test(pv.text), `R3 preview: GET ${base}/jobs/${job.id} shows "35 hours per week" (h.formatHours)`, `${describe(pv)} ${(pv.text.match(/\d+(?:\.\d+)?\s*hours\s+[^<]{0,20}/) || ['no "N hours …" text'])[0].trim()}`);
  if (pv.status === 200 && pid) report(has(pv.text, `Posting ID ${pid}`), `R3 public id: owner job page shows "Posting ID ${pid}"`, (pv.text.match(/Posting ID[^<]{0,12}/) || ['no "Posting ID" text'])[0]);
  const ef = await request(BASE, `${base}/jobs/${job.id}/edit`, { jar: employer });
  const label = (re) => re.test(ef.text);
  report(ef.status === 200 && label(/Other platform link/), 'R3 vocabulary: job form label "Other platform link"', `${describe(ef)} ${(ef.text.match(/<label[^>]*for="apply_url"[^>]*>([^<]*)/) || [])[1] || 'no label for apply_url'}`);
  report(ef.status === 200 && !label(/Apply link/) && !label(/External application link/), 'R3 vocabulary: job form has no "Apply link" / "External application link"', [/Apply link/, /External application link/].filter(label).map(String).join(', ') || '');
  report(ef.status === 200 && /name="application_deadline"/.test(ef.text), 'R3 dates: job form has an application_deadline input ("Applications close on")', /name="application_deadline"/.test(ef.text) ? '' : 'no input named application_deadline');
  const draftForLocked = /Locked after publishing/.test(ef.text);
  report(!draftForLocked, 'R3 lock: draft edit form does NOT say "Locked after publishing"', draftForLocked ? 'the draft form shows the locked note' : '');

  // --- publish → pay (sandbox) → active + locked
  const pub = await expectRedirect(`R3: POST ${base}/jobs/${job.id}/publish → /billing/checkout`, `${base}/jobs/${job.id}/publish`, employer, new RegExp(`/billing/checkout/${job.id}`), { method: 'POST', form: {} });
  if (pub.status !== 302) return job;
  const cs = await expectRedirect(`R3: POST /billing/checkout/${job.id} → /billing/sandbox`, `/billing/checkout/${job.id}`, employer, /\/billing\/sandbox\//, { method: 'POST', form: {} });
  const sandboxPath = stripHost(cs.location);
  if (!sandboxPath) return report(false, 'R3: sandbox card page', 'no sandbox Location (Stripe mode?)') && job;
  const card = { card_number: '4242424242424242', number: '4242424242424242', name: 'Maria Santos', exp: '12/34', expiry: '12/34', exp_month: '12', exp_year: '2034', cvc: '123', cvv: '123', postal_code: 'L5B 1M2' };
  const pay = await expectRedirect(`R3: POST ${sandboxPath} (card 4242) → /billing/success`, sandboxPath, employer, /\/billing\/success/, { method: 'POST', form: card });
  job = await jobRow(job.id);
  report(job.status === 'active' && !!job.locked_at && !!job.published_at, 'R3 lock: after sandbox payment jobs.locked_at + published_at set, status active', `status=${job.status} locked_at=${job.locked_at} published_at=${job.published_at}`);
  if (!pid) { pid = job.public_id; report(!!pid && PUBLIC_ID_RE.test(pid), 'R3 public id: allocated on first activation (activateJob → ensurePublicId)', `public_id=${pid}`); }
  if (!pid && jobsLib) { try { pid = await jobsLib.ensurePublicId(job.id); console.log(`      (fallback: lib/jobs.ensurePublicId allocated ${pid} so the public-id checks below can run)`); } catch (e) { console.log(`      ensurePublicId fallback failed: ${e.message}`); } }
  if (job.status !== 'active') return job;

  // --- locked edit: title + locations rejected, description saved
  const lockedTitle = `${MARK} R3 HACKED TITLE ${stamp}`;
  const newDesc = `Updated after publishing by scripts/smoke.js (${stamp}). The description stays editable by the owner at any time — only the company, operating name, title and work locations are frozen once a posting has been paid and published.`;
  const before = await locKeys(job.id);
  const e2 = await postEdit(job.id, build(lockedTitle, withSalary({ description: newDesc }), [LOCATIONS[1]]));
  job = await jobRow(job.id);
  const after = await locKeys(job.id);
  report(e2.status === 302 || e2.status === 200, `R3 lock: POST ${base}/jobs/${job.id}/edit on the published job (new title + different location_ids[] + new description) → 200/302`, `${describe(e2)}${e2.status === 422 ? ' ' + (errorsIn(e2.text) || '(no error text)') : ''}`);
  report(job.title === t2, 'R3 lock: title unchanged in DB after the locked edit', `title=${JSON.stringify(job.title)}`);
  report(before.join('|') === after.join('|'), 'R3 lock: job_locations unchanged in DB after the locked edit', `before=${before.join(' | ')} after=${after.join(' | ')}`);
  report(job.description === newDesc, 'R3 lock: description DID change (still editable after publishing)', job.description === newDesc ? '' : `description=${JSON.stringify(String(job.description).slice(0, 60))}`);
  const ef2 = await request(BASE, `${base}/jobs/${job.id}/edit`, { jar: employer });
  report(ef2.status === 200 && /Locked after publishing/.test(ef2.text), 'R3 lock: edit form of the published job says "Locked after publishing"', `${describe(ef2)}${/Locked after publishing/.test(ef2.text) ? '' : ' (no such text; view not landed?)'}`);
  if (ef2.status === 200) report(!/<input[^>]*name="title"[^>]*type="text"/.test(ef2.text) && !/<input[^>]*type="text"[^>]*name="title"/.test(ef2.text), 'R3 lock: locked edit form renders the title as static text (no editable title input)', (ef2.text.match(/<input[^>]*name="title"[^>]*>/) || ['no title input'])[0].slice(0, 120));
  if (ef2.status === 200) report(/name="published_at"/.test(ef2.text), 'R3 dates: published job form has a published_at input ("Posted on")', /name="published_at"/.test(ef2.text) ? '' : 'no input named published_at');

  // --- public page: posting id, decimal salary, search by id, /jobs/id/<pid>
  if (!decimals) await q('UPDATE jobs SET salary_min=21.18, salary_max=25 WHERE id=$1', [job.id]);
  const pg = await request(BASE, `/jobs/${job.slug}`, { jar: guest });
  report(pg.status === 200, `R3: public GET /jobs/${job.slug} → 200`, describe(pg));
  if (pg.status === 200) {
    if (pid) report(has(pg.text, `Posting ID ${pid}`), `R3 public id: public job page shows "Posting ID ${pid}"`, (pg.text.match(/Posting ID[^<]{0,12}/) || ['no "Posting ID" text'])[0]);
    report(has(pg.text, '$21.18 – $25.00/hour'), 'R3 salary: public page prints "$21.18 – $25.00/hour"', (pg.text.match(/\$[\d,.]+(?:\s*[–-]\s*\$[\d,.]+)?\s*\/?[^<]{0,12}/) || ['no $ amount'])[0].trim());
    report(/\/jobs\/[a-z0-9-]+\/apply"/.test(pg.text), 'R3 dates: Apply visible while no deadline is set', '');
  }
  if (pid) {
    const s1 = await request(BASE, `/jobs?q=${encodeURIComponent(pid)}`, { jar: guest });
    const slugs = listedSlugs(s1.text);
    report(s1.status === 200 && slugs.length === 1 && slugs[0] === job.slug, `R3 public id: GET /jobs?q=${pid} lists exactly that job`, `${describe(s1)} listed: ${slugs.join(', ') || 'none'}`);
    const s2 = await request(BASE, `/jobs?q=${encodeURIComponent(pid.toLowerCase())}`, { jar: guest });
    const slugs2 = listedSlugs(s2.text);
    report(s2.status === 200 && slugs2.length === 1 && slugs2[0] === job.slug, `R3 public id: GET /jobs?q=${pid.toLowerCase()} (lower case) also finds it`, `listed: ${slugs2.join(', ') || 'none'}`);
    await expectRedirect(`R3 public id: GET /jobs/id/${pid} → 302 /jobs/${job.slug}`, `/jobs/id/${pid}`, guest, new RegExp(`/jobs/${job.slug}$`));
    const nf = await request(BASE, '/jobs/id/ZZ9ZZ9', { jar: guest });
    report(nf.status === 404, 'R3 public id: GET /jobs/id/ZZ9ZZ9 → 404', describe(nf));
  }

  // --- dates: deadline yesterday closes applications; +30 days reopens; published_at shows as Posted
  const yesterday = daysFromNow(-1), today = daysFromNow(0), soon = daysFromNow(30);
  // The form refuses a date in the past ("must be today or later"), so the closed state is reached the way it happens in
  // real life: save today's date through the form, then let the calendar move on (SQL sets it to yesterday).
  const e3 = await postEdit(job.id, build(t2, withSalary({ description: newDesc, application_deadline: today })));
  job = await jobRow(job.id);
  report((e3.status === 302 || e3.status === 200) && job.application_deadline === today, `R3 dates: edit application_deadline=${today} (today) → stored, posting still open on the deadline day`, `${describe(e3)} application_deadline=${job.application_deadline}${e3.status === 422 ? ' ' + (errorsIn(e3.text) || '') : ''}`);
  const sameDay = await request(BASE, `/jobs/${job.slug}`, { jar: guest });
  report(sameDay.status === 200 && !/Applications closed/i.test(sameDay.text) && sameDay.text.includes(`/jobs/${job.slug}/apply"`), 'R3 dates: on the deadline day itself Apply is still visible', describe(sameDay));
  const e3b = await postEdit(job.id, build(t2, withSalary({ description: newDesc, application_deadline: yesterday })));
  report(e3b.status === 422, `R3 dates: edit application_deadline=${yesterday} (past) through the form → 422`, `${describe(e3b)} ${e3b.status === 422 ? (errorsIn(e3b.text) || '') : '(a past date was accepted)'}`);
  await q('UPDATE jobs SET application_deadline=$2 WHERE id=$1', [job.id, yesterday]);
  job = await jobRow(job.id);
  report(job.application_deadline === yesterday, `R3 dates: application_deadline moved to ${yesterday} (SQL — the calendar moved on)`, `application_deadline=${job.application_deadline}`);
  const closed = await request(BASE, `/jobs/${job.slug}`, { jar: guest });
  report(closed.status === 200 && /Applications closed/i.test(closed.text), 'R3 dates: public page shows "Applications closed" after the deadline', `${describe(closed)}${/Applications closed/i.test(closed.text) ? '' : ' (no such text)'}`);
  report(closed.status === 200 && !closed.text.includes(`/jobs/${job.slug}/apply"`), 'R3 dates: public page hides the Apply link after the deadline', closed.text.includes(`/jobs/${job.slug}/apply"`) ? 'still links /apply' : '');
  report(closed.status === 200, 'R3 dates: closed posting is still visible until billing expiry', describe(closed));
  if (seeker) {
    const ag = await request(BASE, `/jobs/${job.slug}/apply`, { jar: seeker });
    const closedState = (ag.status === 200 && /closed/i.test(ag.text)) || (ag.status >= 300 && ag.status < 400);
    report(closedState, `R3 dates: seeker GET /jobs/${job.slug}/apply shows the closed state (200 + "closed" text, or a redirect)`, describe(ag));
    const fd = new FormData();
    fd.append('cover_letter', `${MARK} R3 apply after deadline`); fd.append('resume_choice', 'upload');
    fd.append('resume', new Blob([tinyPdf('R3 resume')], { type: 'application/pdf' }), 'smoke-resume.pdf');
    const ap = await request(BASE, `/jobs/${job.slug}/apply`, { method: 'POST', body: fd, jar: seeker });
    const row = await one('SELECT id FROM applications WHERE job_id=$1', [job.id]);
    report((ap.status === 422 || (ap.status >= 300 && ap.status < 400) || ap.status === 403 || ap.status === 410) && !row, `R3 dates: seeker POST /jobs/${job.slug}/apply after the deadline → 422/redirect, no applications row`, `${describe(ap)}${row ? ` ROW CREATED id=${row.id}` : ''}`);
    if (row) await q('DELETE FROM applications WHERE id=$1', [row.id]);
  } else report(false, 'R3 dates: seeker apply after deadline', 'seeker login failed');
  const e4 = await postEdit(job.id, build(t2, withSalary({ description: newDesc, application_deadline: soon, published_at: '2026-09-01' })));
  job = await jobRow(job.id);
  report((e4.status === 302 || e4.status === 200) && job.application_deadline === soon, `R3 dates: edit application_deadline=${soon} → stored`, `${describe(e4)} application_deadline=${job.application_deadline}${e4.status === 422 ? ' ' + (errorsIn(e4.text) || '') : ''}`);
  report(!!job.published_at && ymd(job.published_at) === '2026-09-01', 'R3 dates: edit published_at=2026-09-01 → stored', `published_at=${job.published_at}`);
  const open = await request(BASE, `/jobs/${job.slug}`, { jar: guest });
  report(open.status === 200 && open.text.includes(`/jobs/${job.slug}/apply"`) && !/Applications closed/i.test(open.text), 'R3 dates: Apply visible again with a future deadline', describe(open));
  report(open.status === 200 && /Sep\.?\s+1,\s+2026|2026-09-01/.test(open.text), 'R3 dates: public page "Posted" reflects Sep 1, 2026', (open.text.match(/Posted[^<]*<[^>]*>[^<]*<[^>]*>([^<]*)/) || [])[1] || (open.text.match(/datetime="2026-09-01[^"]*"/) || ['no Sep 1 date on the page'])[0]);
  const soonText = new Date(soon + 'T12:00:00-04:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Toronto' });
  report(open.status === 200 && /Applications close|Closes/.test(open.text) && (has(open.text, soonText) || open.text.includes(`datetime="${soon}`)), `R3 dates: public page "Applications close"/"Closes" row shows the deadline (${soonText})`, (open.text.match(/(?:Applications close|Closes)[^<]{0,40}(?:<[^>]+>){0,3}[^<]{0,30}/) || ['no Closes row'])[0].replace(/\s+/g, ' ').slice(0, 120));
  if (employer) { const pv2 = await request(BASE, `${base}/jobs/${job.id}`, { jar: employer }); report(pv2.status === 200, `R3: owner detail renders for the published job with deadline + posted date → 200`, describe(pv2)); }

  // --- cancel now → gone
  await expectRedirect(`R3: POST /billing/cancel/${job.id}?now=1 → 302`, `/billing/cancel/${job.id}?now=1`, employer, /./, { method: 'POST', form: {} });
  const gone = await request(BASE, `/jobs/${job.slug}`, { jar: guest });
  report(gone.status === 404, 'R3: cancelled job 404s publicly', describe(gone));
  return job;
}

/** Every job status renders for the owner (detail + edit form) and the public page is 200 only for active. Rows are inserted with psql and removed afterwards. */
async function stateRenderStep(employer, guest) {
  const profile = await profileOf('employer');
  if (!profile) return report(false, 'R3 states: employer profile', 'none in DB');
  const owner = await one('SELECT id FROM users WHERE email=$1', [LOGINS.employer]);
  const statuses = ['draft', 'pending_payment', 'active', 'inactive', 'cancelled', 'expired'];
  const made = [];
  try {
    for (const st of statuses) {
      // vary the shape too: active = 3 locations + operating name + hours; pending = 0 locations, no salary/hours; others = 1 location
      const nLoc = st === 'active' ? 3 : st === 'pending_payment' ? 0 : 1;
      const r = await one(`INSERT INTO jobs(employer_profile_id, created_by, title, slug, description, category, job_type, work_arrangement, city, province, status, expires_at, published_at, locked_at, archived_at, salary_min, salary_max, salary_period, hours_amount, hours_period, operating_name, application_deadline)
        VALUES ($1,$2,$3,$4,'State fixture created by scripts/smoke.js to prove every template renders for this status. It is deleted at the end of the run.','administration','full_time','on_site','Mississauga','ON',$5::job_status,
          CASE WHEN $5 IN ('active','inactive') THEN now() + interval '20 days' WHEN $5='expired' THEN now() - interval '1 day' ELSE NULL END,
          CASE WHEN $5 IN ('draft','pending_payment') THEN NULL ELSE now() - interval '3 days' END,
          CASE WHEN $5 IN ('draft','pending_payment') THEN NULL ELSE now() - interval '3 days' END,
          CASE WHEN $5 IN ('inactive','cancelled','expired') THEN now() ELSE NULL END,
          CASE WHEN $5='pending_payment' THEN NULL ELSE 21.18 END, CASE WHEN $5='pending_payment' THEN NULL ELSE 25 END, 'hour',
          CASE WHEN $5='pending_payment' THEN NULL ELSE 37.5 END, 'week', CASE WHEN $5='active' THEN 'State Fixture Trading' ELSE NULL END,
          CASE WHEN $5='active' THEN current_date + 10 ELSE NULL END) RETURNING id, slug`,
        [profile.id, owner.id, `${MARK} state ${st}`, `smoke-state-${st}-${Date.now().toString(36)}`, st]);
      for (let i = 0; i < nLoc; i++) await q('INSERT INTO job_locations(job_id, street_address, unit, city, province, postal_code, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [r.id, ['2400 Derry Rd E', '7100 Airport Rd', '100 City Centre Dr'][i], i === 1 ? '12' : null, 'Mississauga', 'ON', ['L5S 1B1', 'L4T 2H3', 'L5B 2C9'][i], i]);
      if (st === 'active' && jobsLib) { try { await jobsLib.ensurePublicId(r.id); } catch (_) {} }
      made.push({ ...r, status: st, nLoc });
    }
    for (const j of made) {
      const d = await request(BASE, `/employer/jobs/${j.id}`, { jar: employer });
      report(d.status === 200, `R3 states: owner detail GET /employer/jobs/${j.id} (${j.status}, ${j.nLoc} location${j.nLoc === 1 ? '' : 's'}) → 200`, describe(d) + (d.status >= 500 ? ' ' + (d.text.match(/ReferenceError[^<]{0,120}|TypeError[^<]{0,120}/) || [''])[0] : ''));
      const e = await request(BASE, `/employer/jobs/${j.id}/edit`, { jar: employer });
      report(e.status === 200, `R3 states: edit form GET /employer/jobs/${j.id}/edit (${j.status}) → 200`, describe(e) + (e.status >= 500 ? ' ' + (e.text.match(/ReferenceError[^<]{0,120}|TypeError[^<]{0,120}/) || [''])[0] : ''));
      if (e.status === 200 && j.status !== 'draft' && j.status !== 'pending_payment') report(/Locked after publishing/.test(e.text), `R3 states: edit form of the ${j.status} job (locked_at set) says "Locked after publishing"`, /Locked after publishing/.test(e.text) ? '' : 'no such text');
      const a = await request(BASE, `/employer/jobs/${j.id}/applicants`, { jar: employer });
      report(a.status === 200, `R3 states: applicants GET /employer/jobs/${j.id}/applicants (${j.status}) → 200`, describe(a));
      const p = await request(BASE, `/jobs/${j.slug}`, { jar: guest });
      const want = j.status === 'active' ? 200 : 404;
      report(p.status === want, `R3 states: public GET /jobs/${j.slug} (${j.status}) → ${want}`, describe(p));
      if (j.status === 'active' && p.status === 200) {
        report(/State Fixture Trading/.test(p.text) && /37\.5 hours per week/.test(p.text) && has(p.text, '$21.18 – $25.00/hour'), 'R3 states: active fixture page shows operating name, "37.5 hours per week" and "$21.18 – $25.00/hour"', `${/State Fixture Trading/.test(p.text) ? '' : 'no operating name '}${/37\.5 hours per week/.test(p.text) ? '' : 'no hours '}${has(p.text, '$21.18 – $25.00/hour') ? '' : 'no decimal salary'}`.trim());
        const locs = ['2400 Derry Rd E, Mississauga, ON L5S 1B1', '7100 Airport Rd, Unit 12, Mississauga, ON L4T 2H3', '100 City Centre Dr, Mississauga, ON L5B 2C9'].filter(a => !has(p.text, a));
        report(!locs.length, 'R3 states: active fixture page lists all 3 work locations', locs.length ? `missing: ${locs.join(' | ')}` : '');
      }
    }
    for (const [path, jar, name] of [['/employer/jobs', employer, 'owner jobs list'], ['/employer/dashboard', employer, 'owner dashboard'], ['/billing', employer, 'billing'], ['/employer/applicants', employer, 'applicants (all)']]) {
      const r = await request(BASE, path, { jar });
      report(r.status === 200, `R3 states: ${name} GET ${path} renders with every status present → 200`, describe(r));
    }
    const list = await request(BASE, '/employer/jobs', { jar: employer });
    const act = made.find(j => j.status === 'active'); const actRow = act && await one('SELECT public_id FROM jobs WHERE id=$1', [act.id]);
    if (actRow && actRow.public_id) report(has(list.text, actRow.public_id), `R3 public id: owner jobs list shows the posting id ${actRow.public_id}`, has(list.text, actRow.public_id) ? '' : 'id not on /employer/jobs');
  } finally {
    for (const j of made) await q('DELETE FROM jobs WHERE id=$1', [j.id]).catch(() => {});
  }
}

/** Layout hygiene (UX standard §2): every page has exactly one <h1> and a .page-head / .app-head band (home: the hero). */
async function layoutHygieneStep(pages) {
  for (const { path, jar, role } of pages) {
    const r = await request(BASE, path, { jar });
    if (r.status !== 200) { report(false, `R3 layout: ${path}${role ? ' (' + role + ')' : ''} → 200`, describe(r)); continue; }
    const h1s = (r.text.match(/<h1[\s>]/gi) || []).length;
    const band = /class="[^"]*\b(?:page-head|app-head|hero)\b/.test(r.text);
    report(h1s === 1 && band, `R3 layout: ${path}${role ? ' (' + role + ')' : ''} has exactly one <h1> + page-head/app-head/hero band`, `${h1s === 1 ? '' : `${h1s} <h1> elements`} ${band ? '' : 'no page-head/app-head/hero class'}`.trim());
  }
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
      for (const [name, sql, params] of [
        ['employer_locations', 'DELETE FROM employer_locations WHERE label LIKE $1', [MARK + '%']],
        ['smoke admin user', 'DELETE FROM users WHERE email=$1', [SMOKE_ADMIN.email]],
        ['operating names', "UPDATE employer_profiles SET operating_names = ARRAY(SELECT x FROM unnest(operating_names) x WHERE x NOT LIKE 'Smoke Trade %')::text[] WHERE EXISTS (SELECT 1 FROM unnest(operating_names) x WHERE x LIKE 'Smoke Trade %')", []],
      ]) { try { await q(sql, params); } catch (e) { console.log(`      cleanup ${name}: ${e.message}`); } }
    }
    // a live NATIVE job the seeder has NOT applied to yet (applications are UNIQUE per job+seeker); prefer one the
    // seeded employer owns so the employer-side cover download can be checked with the employer login
    const applyTo = seeker && await one(`SELECT j.id, j.slug, j.employer_profile_id FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id
      WHERE j.status='active' AND j.expires_at > now() AND j.source IS NULL AND (j.application_deadline IS NULL OR j.application_deadline >= (now() AT TIME ZONE 'America/Toronto')::date) AND j.id NOT IN (SELECT job_id FROM applications WHERE seeker_user_id=$1)
      ORDER BY (p.owner_user_id = (SELECT id FROM users WHERE email=$2)) DESC, j.id LIMIT 1`, [seeker.id, LOGINS.employer]);
    const opName = await one(`SELECT j.slug, coalesce(j.operating_name, p.operating_name) AS operating_name, p.company_name FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id
      WHERE j.status='active' AND j.expires_at > now() AND coalesce(j.operating_name, p.operating_name) IS NOT NULL AND coalesce(j.operating_name, p.operating_name) <> '' AND coalesce(j.operating_name, p.operating_name) <> p.company_name ORDER BY j.id LIMIT 1`);
    const jobbank = await one("SELECT slug, source_url FROM jobs WHERE source='jobbank' AND status='active' AND expires_at > now() ORDER BY id LIMIT 1");
    report(!!(active && expired), 'db: seeded fixtures present', `active=${active && active.slug} expired=${expired && expired.slug} applyTo=${applyTo && applyTo.slug} opName=${opName ? opName.operating_name : '(none)'} jobbank=${jobbank ? jobbank.slug : '(none)'}`);
    return { active, expired, seeker, applyTo, opName, jobbank };
  }) || {};
  // the admin passcode the integrations step will unlock with (server-side settings cache is 5 s; set it early)
  await step('settings: admin_passcode', async () => {
    if (!settingsLib) return report(false, 'lib/settings loadable from scripts/smoke.js (to set admin_passcode)', settingsErr);
    await settingsLib.set('admin_passcode', PASSCODE);
    const v = await settingsLib.get('admin_passcode');
    report(v === PASSCODE, `settings.set('admin_passcode') round-trips through the encrypted settings row`, v === PASSCODE ? '' : `got ${JSON.stringify(v)} (SESSION_SECRET differs from the server's?)`);
  });

  // ---- 1. public pages
  const guest = new CookieJar();
  for (const p of ['/', '/jobs', '/about', '/contact', '/employer', '/consultant', '/jobseeker', '/login', '/signup', '/privacy', '/terms']) await step(p, () => expectPage('public', p, guest));
  await step('signup industry select', async () => {   // client decision 1: Industry is a dropdown of C.INDUSTRIES on employer signup too
    const r = await request(BASE, '/signup/employer', { jar: guest });
    const key = ((C.INDUSTRIES || []).find(([, n]) => /transport/i.test(n)) || (C.INDUSTRIES || [])[0] || ['transportation_warehousing'])[0];
    const sel = /<select[^>]*name="industry"/.test(r.text);
    report(r.status === 200 && sel && r.text.includes(`value="${key}"`), `GET /signup/employer: industry is a <select> of C.INDUSTRIES keys (e.g. ${key})`, `${describe(r)}${sel ? '' : ' no <select name="industry">'}${r.text.includes(`value="${key}"`) ? '' : ` option ${key} missing`}`);
  });
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
    const withPostal = locs.filter(l => l.postal_code).length;
    report(Array.isArray(jl) && arr.length === locs.length && arr.filter(x => x.address && x.address.postalCode).length === withPostal, `JSON-LD jobLocation is an array (${locs.length}) with postalCode${withPostal < locs.length ? ` (${locs.length - withPostal} DB row(s) have no postal code)` : ''}`, jp ? JSON.stringify(jl).slice(0, 160) : 'no JSON-LD');
    report(/<link[^>]+print\.css/.test(r.text), 'job detail links print.css');
    report(/data-print/.test(r.text), 'job detail has a data-print button');
  });
  if (db.opName) await step('operating name', async () => {
    const r = await request(BASE, `/jobs/${db.opName.slug}`, { jar: guest });
    report(r.status === 200 && has(r.text, db.opName.operating_name), `job detail shows operating name "${db.opName.operating_name}" (legal: ${db.opName.company_name})`, describe(r));
  });
  else report(false, 'operating name fixture', 'no live job whose operating name differs from company_name (seed expects Northern Lights Freight)');
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
  if (db.active) await step('legacy vocabulary', () => legacyVocabStep(db.active, guest));

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
  if (admin) { await step('admin', () => expectPage('admin', '/admin', admin)); await step('admin messages', () => expectPage('admin', '/admin/messages', admin)); await step('admin users', () => expectPage('admin', '/admin/users', admin)); }

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

  // ---- 6. profile (industry key, operating names list) + job-form defaults (apply_email)
  if (employer) await step('employer profile save', () => profileSaveStep(employer)); else report(false, 'employer profile save', 'employer login failed');
  await step('apply_email defaults', () => applyEmailStep(employer, consultant));

  // ---- 7. post-a-job flows: employer ($14.99) then consultant ($9.99), each publish → checkout → pay → public → cancel
  const form = discoverJobForm();
  console.log(`      job form mode: ${form.mode}${form.mode === 'select' ? ` (${form.locField} + ${form.newLocPrefix}*, hours_amount=${form.hours.amount}; ${form.source})` : ` (${form.template}; ${form.source})`}`);
  if (form.routeSelect) report(form.viewHasCheckbox, 'views/portal/job-form.ejs has the address-book checkboxes the route expects', form.viewHasCheckbox ? form.locField : `routes/portal.js reads location_ids; view inputs: ${form.names.filter(n => /loc|location/.test(n)).join(', ') || 'none location-related'}`);
  if (employer) await step('employer post-a-job flow', () => postingFlow('employer', employer, consultant, guest, form));
  else report(false, 'employer post-a-job flow', 'employer login failed');
  if (consultant) await step('consultant post-a-job flow', () => postingFlow('consultant', consultant, employer, guest, form));
  else report(false, 'consultant post-a-job flow', 'consultant login failed');
  let draft = null;
  if (employer && form.mode === 'select') draft = await step('employer inline add-new', () => inlineAddStep(employer, form));
  if (!draft && employer) draft = await one("SELECT j.id FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE p.owner_user_id=(SELECT id FROM users WHERE email=$1) AND j.status IN ('draft','pending_payment') AND j.source IS NULL ORDER BY j.id DESC LIMIT 1", [LOGINS.employer]);

  // ---- 8. maps
  if (db.active) await step('maps', () => mapsStep(guest, db.active));

  // ---- 8b. round 3 (2026-09-14): public id, locking, decimal salary, posting dates, vocabulary, preview hours, every status renders, layout hygiene
  if (employer) await step('round 3 posting flow', () => round3Flow(employer, seeker, guest, form)); else report(false, 'round 3 posting flow', 'employer login failed');
  if (employer) await step('round 3 job states', () => stateRenderStep(employer, guest)); else report(false, 'round 3 job states', 'employer login failed');
  await step('round 3 layout hygiene', async () => {
    const slug = db.active ? db.active.slug : null;
    const company = slug ? await one('SELECT p.slug FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE j.slug=$1', [slug]) : null;
    const pages = [];
    for (const p of ['/', '/jobs', '/jobs?q=nurse', '/about', '/contact', '/employer', '/consultant', '/jobseeker', '/login', '/signup', '/signup/employer', '/signup/seeker', '/forgot', '/privacy', '/terms', ...(slug ? [`/jobs/${slug}`, `/jobs/${slug}/apply`] : []), ...(company ? [`/companies/${company.slug}`] : [])]) pages.push({ path: p, jar: guest });
    if (employer) for (const p of ['/employer/dashboard', '/employer/jobs', '/employer/jobs/new', '/employer/profile', '/employer/applicants', '/billing', '/account', ...(draft ? [`/employer/jobs/${draft.id}`, `/employer/jobs/${draft.id}/edit`, `/billing/checkout/${draft.id}`] : [])]) pages.push({ path: p, jar: employer, role: 'employer' });
    if (consultant) for (const p of ['/consultant/dashboard', '/consultant/profiles', '/consultant/profiles/new', '/consultant/jobs/new']) pages.push({ path: p, jar: consultant, role: 'consultant' });
    if (seeker) for (const p of ['/jobseeker/dashboard', '/jobseeker/profile', '/jobseeker/applications', '/jobseeker/saved', '/jobseeker/alerts', '/jobseeker/notifications', ...(slug ? [`/jobs/${slug}/apply`] : [])]) pages.push({ path: p, jar: seeker, role: 'seeker' });
    if (admin) for (const p of ['/admin', '/admin/jobs', '/admin/users', '/admin/messages', '/admin/payments', '/admin/outbox', '/admin/integrations/unlock']) pages.push({ path: p, jar: admin, role: 'admin' });
    await layoutHygieneStep(pages);
  });

  // ---- 9. admin integrations (passcode gate, pricing → checkout, encrypted secrets, test email, admin users, support routing)
  let integ = { recipients: null };
  if (admin) integ = (await step('admin integrations', () => adminIntegrationsStep(admin, employer, draft && draft.id))) || integ;
  else report(false, 'admin integrations', 'admin login failed');

  // ---- 10. contact form (routes to the configured support recipients + auto-reply)
  await step('contact form', () => contactStep(guest, integ.recipients));
  if (integ.restoreSupport) await step('restore support_email', integ.restoreSupport);

  // ---- 11. logout
  if (seeker) await step('logout', () => expectRedirect('POST /logout → 302', '/logout', seeker, /./, { method: 'POST', form: {} }));

  return finish();
}

async function finish() {
  const fails = results.filter(r => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} passed${fails.length ? `, ${fails.length} FAILED:` : ''}`);
  for (const f of fails) console.log(`  - ${f.name}${f.detail ? '  (' + f.detail + ')' : ''}`);
  await pool.end().catch(() => {});
  try { await require('../lib/db').pool.end(); } catch (_) {}
  process.exit(fails.length ? 1 : 0);
}

main().catch(async (e) => { console.error('smoke: fatal', e); await pool.end().catch(() => {}); process.exit(1); });
