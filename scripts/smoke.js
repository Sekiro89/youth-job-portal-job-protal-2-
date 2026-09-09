'use strict';
// End-to-end HTTP smoke test for Canada Careers. Zero extra deps (global fetch + pg, which is installed).
//
//   BASE_URL=http://localhost:3900 DATABASE_URL=postgres://... node scripts/smoke.js
//
// Runs against a RUNNING, SEEDED instance (scripts/seed.js logins). Every step prints PASS/FAIL + detail and
// the script keeps going after a failure; exit code is 1 if anything failed. Where a route may have deviated
// from docs/CONTRACT.md, the actual status + Location header is printed so the orchestrator can reconcile.
//
// It mutates the DB (creates a job, an application, a contact message) but tags everything with the marker
// "[smoke]" and removes its own leftovers from earlier runs first. Set SMOKE_KEEP=1 to skip that cleanup.

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { CookieJar, request, login } = require('./cdp');

const BASE = (process.env.BASE_URL || 'http://localhost:3900').replace(/\/$/, '');
const MARK = '[smoke]';
const PASSWORD = 'Password123!';
const LOGINS = { admin: 'veda@canadacareers.local', employer: 'employer@example.com', consultant: 'consultant@example.com', seeker: 'seeker@example.com' };

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
/** A minimal valid one-page PDF (used as the uploaded resume). */
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
const seekerHome = /\/jobseeker\/dashboard/;

// ---------------------------------------------------------------- main
async function main() {
  console.log(`smoke: ${BASE}  db=${(process.env.DATABASE_URL || '').replace(/\/\/.*@/, '//***@')}`);
  let reachable = false;
  try { const r = await request(BASE, '/healthz'); reachable = r.status === 200; report(reachable, 'GET /healthz → 200', r.status + ' ' + r.text.slice(0, 80)); }
  catch (e) { report(false, 'server reachable', e.message); }
  if (!reachable) return finish();

  // ---- DB fixtures: slugs + cleanup of previous smoke runs
  const db = await step('db: fixtures', async () => {
    const active = await one("SELECT id, slug FROM jobs WHERE status='active' AND expires_at > now() ORDER BY id LIMIT 1");
    const expired = await one("SELECT id, slug FROM jobs WHERE status='expired' ORDER BY id LIMIT 1");
    const seeker = await one('SELECT id FROM users WHERE email=$1', [LOGINS.seeker]);
    if (!process.env.SMOKE_KEEP) {
      await q('DELETE FROM applications WHERE cover_letter LIKE $1', [MARK + '%']);
      await q('DELETE FROM contact_messages WHERE subject LIKE $1', [MARK + '%']);
      await q('DELETE FROM jobs WHERE title LIKE $1', [MARK + '%']);
    }
    // a live job the seeder has NOT applied to yet (applications are UNIQUE per job+seeker)
    const applyTo = seeker && await one("SELECT id, slug FROM jobs WHERE status='active' AND expires_at > now() AND id NOT IN (SELECT job_id FROM applications WHERE seeker_user_id=$1) ORDER BY id LIMIT 1", [seeker.id]);
    report(!!(active && expired), 'db: seeded fixtures present', `active=${active && active.slug} expired=${expired && expired.slug} applyTo=${applyTo && applyTo.slug}`);
    return { active, expired, seeker, applyTo };
  }) || {};

  // ---- 1. public pages
  const guest = new CookieJar();
  for (const p of ['/', '/jobs', '/about', '/contact', '/employer', '/consultant', '/jobseeker', '/login', '/signup', '/privacy', '/terms']) await step(p, () => expectPage('public', p, guest));
  const sitemap = await step('/sitemap.xml', async () => { const r = await request(BASE, '/sitemap.xml', { jar: guest }); report(r.status === 200 && /<urlset/.test(r.text), 'GET /sitemap.xml → 200 + <urlset>', describe(r)); return r; });
  await step('/robots.txt', async () => { const r = await request(BASE, '/robots.txt'); report(r.status === 200 && /sitemap/i.test(r.text), 'GET /robots.txt → 200 + Sitemap line', describe(r)); });

  // ---- 2. job detail: active 200, archived 404; sitemap only lists live slugs
  if (db.active) await step('active job', async () => { const r = await expectPage('active job', `/jobs/${db.active.slug}`, guest); if (r.status === 200) report(/"@type"\s*:\s*"JobPosting"/.test(r.text), 'job detail has JobPosting JSON-LD'); });
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

  // ---- 5. seeker apply flow (multipart upload)
  if (seeker && db.applyTo) await step('apply flow', async () => {
    const slug = db.applyTo.slug;
    const g = await expectPage('seeker', `/jobs/${slug}/apply`, seeker);
    if (g.status !== 200) return;
    const fd = new FormData();
    fd.append('cover_letter', `${MARK} Smoke-test application. Please ignore.`);
    fd.append('resume', new Blob([tinyPdf('Smoke test resume')], { type: 'application/pdf' }), 'smoke-resume.pdf');
    fd.append('resume_choice', 'upload');   // tolerated if the form has no such field
    const r = await request(BASE, `/jobs/${slug}/apply`, { method: 'POST', body: fd, jar: seeker });
    const ok = r.status === 302;
    report(ok, `POST /jobs/${slug}/apply (multipart, PDF) → 302`, describe(r) + (ok ? '' : ' ' + errorsIn(r.text)));
    const row = await one('SELECT id, resume_name, status FROM applications WHERE job_id=$1 AND seeker_user_id=$2', [db.applyTo.id, db.seeker.id]);
    report(!!row, 'application row exists in DB', row ? `id=${row.id} resume=${row.resume_name} status=${row.status}` : 'no row');
  });
  else report(false, 'apply flow', seeker ? 'no live job the seeker has not already applied to' : 'seeker login failed');

  // ---- 6. employer posts a job → publish → checkout → sandbox card → active → public → cancel-now → 404
  if (employer) await step('post-a-job flow', async () => {
    const g = await expectPage('employer', '/employer/jobs/new', employer);
    if (g.status !== 200) return;
    const profile = await one('SELECT id FROM employer_profiles WHERE owner_user_id=(SELECT id FROM users WHERE email=$1) LIMIT 1', [LOGINS.employer]);
    const title = `${MARK} Smoke Test Coordinator ${Date.now().toString(36)}`;
    const form = {
      employer_profile_id: profile ? profile.id : '', profile_id: profile ? profile.id : '',
      title, description: 'Smoke test posting created automatically by scripts/smoke.js to exercise the publish, checkout and cancel flow.\n\nThis job is cancelled again by the same script a few seconds later, so nobody should ever see it or apply to it. If you can read this on the public site, the cancel step failed.',
      requirements: 'None.', benefits: 'None.', category: 'administration', job_type: 'full_time', work_arrangement: 'hybrid',
      experience_level: 'entry', education: 'High school', city: 'Mississauga', province: 'ON', postal_code: 'L5B 1M2',
      salary_min: '45000', salary_max: '50000', salary_period: 'year', vacancies: '1', languages: 'English', skills: 'Teamwork, Communication',
      apply_email: 'apply@example.com', noc_code: '13100',
    };
    const params = new URLSearchParams(form);
    params.append('audiences', 'professionals'); params.append('audiences', 'youth');
    const c = await request(BASE, '/employer/jobs/new', { method: 'POST', body: params.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, jar: employer });
    let job = await one('SELECT id, slug, status FROM jobs WHERE title=$1', [title]);
    report(c.status === 302 && !!job, 'POST /employer/jobs/new → 302 + draft row', describe(c) + (job ? ` job#${job.id} status=${job.status}` : ' no job row; ' + errorsIn(c.text)));
    if (!job) return;
    await expectPage('employer', `/employer/jobs/${job.id}`, employer);

    const pub = await expectRedirect(`POST /employer/jobs/${job.id}/publish → 302 /billing/checkout/${job.id}`, `/employer/jobs/${job.id}/publish`, employer, new RegExp(`/billing/checkout/${job.id}`), { method: 'POST', form: {} });
    job = await one('SELECT id, slug, status FROM jobs WHERE id=$1', [job.id]);
    report(['pending_payment', 'draft'].includes(job.status), 'job status after publish click', `status=${job.status} (${pub.status})`);

    const co = await expectPage('employer', `/billing/checkout/${job.id}`, employer);
    if (co.status === 200) report(/10\.49/.test(co.text) && /9\.99/.test(co.text), 'checkout shows $9.99 + GST = $10.49', '');
    const cs = await expectRedirect(`POST /billing/checkout/${job.id} → 302 /billing/sandbox/:checkoutId`, `/billing/checkout/${job.id}`, employer, /\/billing\/sandbox\//, { method: 'POST', form: {} });
    const sandboxPath = cs.location && cs.location.replace(/^https?:\/\/[^/]+/, '');
    if (!sandboxPath) return report(false, 'sandbox card page', 'no sandbox Location to follow (Stripe mode? set STRIPE_SECRET_KEY empty for sandbox)');
    await expectPage('employer', sandboxPath, employer);
    const card = { card_number: '4242424242424242', number: '4242424242424242', card: '4242 4242 4242 4242', name: 'Maria Santos', cardholder: 'Maria Santos',
      exp: '12/34', expiry: '12/34', exp_month: '12', exp_year: '2034', cvc: '123', cvv: '123', postal_code: 'L5B 1M2' };
    const pay = await expectRedirect(`POST ${sandboxPath} (card 4242) → 302 /billing/success`, sandboxPath, employer, /\/billing\/success/, { method: 'POST', form: card });
    if (pay.status !== 302 && pay.text) console.log('      sandbox form errors: ' + (errorsIn(pay.text) || '(none found in HTML)'));
    if (pay.location) await expectPage('employer', pay.location.replace(/^https?:\/\/[^/]+/, ''), employer);
    job = await one('SELECT id, slug, status, expires_at > now() AS live FROM jobs WHERE id=$1', [job.id]);
    report(job.status === 'active' && job.live, 'job is active + paid-up in DB after sandbox payment', `status=${job.status} live=${job.live}`);
    const sub = await one('SELECT status, total_cents, current_period_end > now() AS ok FROM subscriptions WHERE job_id=$1', [job.id]);
    report(!!sub && sub.status === 'active' && sub.total_cents === 1049 && sub.ok, 'subscription row active, total 1049 cents', JSON.stringify(sub));
    const payRow = await one('SELECT receipt_number, total_cents FROM payments WHERE job_id=$1', [job.id]);
    report(!!payRow && /^CC-\d{6}-\d{6}$/.test(payRow.receipt_number || ''), 'payment row with CC-YYYYMM-NNNNNN receipt', JSON.stringify(payRow));

    const pubList = await request(BASE, '/jobs?q=' + encodeURIComponent('Smoke Test Coordinator'), { jar: guest });
    report(pubList.status === 200 && pubList.text.includes(job.slug), 'new job appears in public /jobs search', describe(pubList));
    await expectPage('public', `/jobs/${job.slug}`, guest);
    const sm = await request(BASE, '/sitemap.xml');
    report(sm.text.includes(`/jobs/${job.slug}`), 'new job appears in sitemap.xml');
    await expectPage('employer', '/billing', employer);

    await expectRedirect(`POST /billing/cancel/${job.id}?now=1 → 302`, `/billing/cancel/${job.id}?now=1`, employer, /./, { method: 'POST', form: {} });
    job = await one('SELECT status FROM jobs WHERE id=$1', [job.id]);
    report(job.status === 'cancelled', 'job status cancelled in DB', `status=${job.status}`);
    const gone = await request(BASE, `/jobs/${(await one('SELECT slug FROM jobs WHERE title=$1', [title])).slug}`, { jar: guest });
    report(gone.status === 404, 'cancelled job 404s publicly', describe(gone));
    const sm2 = await request(BASE, '/sitemap.xml');
    report(!sm2.text.includes(`/jobs/${(await one('SELECT slug FROM jobs WHERE title=$1', [title])).slug}`), 'cancelled job dropped from sitemap.xml');
  });

  // ---- 7. contact form
  await step('contact form', async () => {
    const before = await one('SELECT count(*)::int AS n FROM mail_outbox');
    const subject = `${MARK} Smoke test message ${Date.now().toString(36)}`;
    const r = await expectRedirect('POST /contact → 302 /contact/thanks', '/contact', guest, /\/contact\/thanks/, {
      method: 'POST', form: { name: 'Smoke Tester', email: 'smoke@example.com', phone: '416-555-0100', category: 'technical', subject, message: 'This is an automated smoke-test message. Please ignore.' } });
    if (r.status !== 302) console.log('      contact form errors: ' + (errorsIn(r.text) || '(none found in HTML)'));
    if (r.location) await expectPage('public', r.location.replace(/^https?:\/\/[^/]+/, ''), guest);
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
