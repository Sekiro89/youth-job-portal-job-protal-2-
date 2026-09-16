'use strict';
// Employer + Third-Party Consultant portal. One set of handlers mounted under BOTH
// /employer and /consultant; res.locals.base tells templates which prefix to link to.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('../lib/db');
const auth = require('../lib/auth');
const h = require('../lib/helpers');
const C = require('../lib/constants');
const jobs = require('../lib/jobs');
const mail = require('../lib/mail');
const jd = require('../lib/job-dates');   // application_deadline / published_at rules (round 3)

const router = express.Router();
const ROOT = path.join(__dirname, '..');
const UPLOAD_DIR = path.isAbsolute(process.env.UPLOAD_DIR || '') ? process.env.UPLOAD_DIR : path.join(ROOT, process.env.UPLOAD_DIR || 'data/uploads');
const LOGO_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/svg+xml': '.svg', 'image/webp': '.webp' };
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const APP_STATUSES = ['submitted', 'viewed', 'shortlisted', 'rejected', 'hired'];
const APP_STATUS_NAME = { submitted: 'Submitted', viewed: 'Viewed', shortlisted: 'Shortlisted', rejected: 'Not selected', hired: 'Hired' };
const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
/** Price is decided by the PAYER's role: employers $14.99, third-party consultants $9.99, + 5% GST. */
const pricingFor = (role) => { const PRICE = C.priceCentsFor(role); const GST = Math.round(PRICE * C.PRICING.gst_rate); return { PRICE, GST, TOTAL: PRICE + GST }; };
const $ = (cents) => (cents / 100).toFixed(2);
const PROFILE_TABS = { all: 'All', active: 'Active', pending_payment: 'Awaiting payment', draft: 'Drafts', archived: 'Archived' };

const isProd = process.env.NODE_ENV === 'production';
const baseFor = (user) => user.role === 'consultant' ? '/consultant' : '/employer';
const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const intOrNull = (v) => { const n = parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

/** All non-archived employer profiles owned by this user. */
const profilesFor = async (user) => (await db.many('SELECT * FROM employer_profiles WHERE owner_user_id=$1 AND NOT archived ORDER BY company_name', [user.id])).map(p => Object.assign(p, { id: Number(p.id) })); // bigserial comes back as a string

// ------------------------------------------------------------------ multer (memory; we write the file after we know the profile id)
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
  // Reject by type but remember that a file WAS sent, so the form can complain even without JS (logo_present marker).
  fileFilter: (req, file, cb) => { const ok = !!LOGO_MIME[file.mimetype]; if (!ok) req.logoRejected = true; cb(null, ok); },
}).single('logo');
function logoMiddleware(req, res, next) {
  logoUpload(req, res, (err) => {
    if (err) { req.logoError = err.code === 'LIMIT_FILE_SIZE' ? 'Logo must be 2 MB or smaller.' : 'Could not read the logo file.'; }
    else if (!req.file && (req.logoRejected || (req.body && req.body.logo_present === '1'))) req.logoError = 'Logo must be a PNG, JPG, SVG or WebP image.';
    next();
  });
}
/** Sniff the real image type from the bytes; returns the extension or null. */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return '.webp';
  const head = buf.slice(0, 512).toString('utf8').trim().toLowerCase();
  if (head.includes('<svg') && !/<script|onload=|onerror=/i.test(buf.toString('utf8'))) return '.svg';
  return null;
}
async function saveLogo(profileId, file, oldPath) {
  const ext = sniffImage(file.buffer);
  if (!ext) { const e = new Error('Logo must be a real PNG, JPG, SVG or WebP image.'); e.code = 'BAD_IMAGE'; throw e; }
  const dir = path.join(UPLOAD_DIR, 'logos');
  await fs.promises.mkdir(dir, { recursive: true });
  const rel = path.posix.join('logos', `${profileId}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  await fs.promises.writeFile(path.join(UPLOAD_DIR, rel), file.buffer);
  if (oldPath) fs.promises.unlink(path.join(UPLOAD_DIR, oldPath)).catch(() => {});
  return rel;
}
function sendLogo(res, profile) {
  const abs = path.join(UPLOAD_DIR, profile.logo_path);
  if (!abs.startsWith(path.join(UPLOAD_DIR, 'logos'))) return res.status(404).end();
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.set('Content-Disposition', 'inline');
  res.set('Cache-Control', 'private, max-age=300');
  res.sendFile(abs, (err) => { if (err && !res.headersSent) res.status(404).end(); });
}

// ------------------------------------------------------------------ public routes
const EP = pricingFor('employer'), CP = pricingFor('consultant');
const landingFaq = {
  employer: [
    ['How much does it cost to post a job?', `Each posting is $${$(EP.PRICE)} per month plus 5% GST — $${$(EP.TOTAL)} CAD in total. It renews automatically every month until you cancel. There are no setup fees and no contracts.`],
    ['Can I cancel at any time?', 'Yes. Cancel from your dashboard with one click. Your posting stays live until the end of the paid month and is then archived. You can also cancel immediately.'],
    ['How long does approval take?', 'There is no approval queue. Your posting goes live the moment your payment is confirmed — usually within a few seconds.'],
    ['Who will see my posting?', 'Everyone who searches Youth Futures Canada, plus every job seeker whose saved profile matches your posting gets an instant email alert. Postings are indexed by Google for Jobs.'],
    ['How do I receive applications?', 'Applicants apply on Youth Futures Canada with their resume and cover letter. You review, shortlist and download resumes from your dashboard; applicants are notified of every status change. You can also add an external apply link or email.'],
    ['Do I get a receipt?', 'Every charge produces a GST receipt with your company name and a unique receipt number, available any time under Billing.'],
  ],
  consultant: [
    ['Who is the consultant account for?', 'Recruitment agencies, staffing firms, HR consultants and immigration consultants who post jobs on behalf of more than one employer.'],
    ['How many employer profiles can I add?', 'Unlimited. Each client gets its own company profile with logo, description and contact details, and each posting is published under the client company name.'],
    ['How is billing handled?', `Every posting is $${$(CP.PRICE)} + GST ($${$(CP.TOTAL)}) per month, billed to your account. Billing shows one list of subscriptions and receipts across all your clients, so you can pass costs through cleanly.`],
    ['Can my clients see the applicants?', 'Applicants land in your dashboard. You can download resumes and update statuses; forward what you need to your client. Client logins for shared access are on our roadmap.'],
    ['Can I switch between companies quickly?', 'Yes — a company selector appears on every job list, and the posting form asks which client you are posting for.'],
    ['Is there a volume discount?', `Not yet. Pricing is a flat $${$(CP.PRICE)} + GST per posting per month for third-party consultants, with no contracts.`],
  ],
};
const faqJsonLd = (items) => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });

router.get('/employer', (req, res) => {
  if (req.user && ['employer', 'consultant'].includes(req.user.role)) return res.redirect(baseFor(req.user) + '/dashboard');
  res.render('portal/landing-employer', {
    title: `Post a Job in Canada for $${$(EP.PRICE)}/month — Employers`,
    metaDescription: `Post a job on Youth Futures Canada for $${$(EP.PRICE)} + GST per month. Reach young talent across Canada — students, graduates, early-career and skilled young professionals. No contracts, cancel any time.`,
    extraCss: ['/css/portal.css'], extraJs: ['/js/portal.js'], bodyClass: 'portal-landing',
    faq: landingFaq.employer, jsonLd: [faqJsonLd(landingFaq.employer)], ...EP,
  });
});
router.get('/consultant', (req, res) => {
  if (req.user && ['employer', 'consultant'].includes(req.user.role)) return res.redirect(baseFor(req.user) + '/dashboard');
  res.render('portal/landing-consultant', {
    title: 'Third Party Consultants & Recruiters — Post Jobs for All Your Clients',
    metaDescription: `One login, unlimited employer profiles. Recruiters, staffing agencies and immigration consultants post jobs on behalf of any client for $${$(CP.PRICE)} + GST per posting per month.`,
    extraCss: ['/css/portal.css'], extraJs: ['/js/portal.js'], bodyClass: 'portal-landing',
    faq: landingFaq.consultant, jsonLd: [faqJsonLd(landingFaq.consultant)], ...CP,
  });
});

/** Public company logo (any visitor) — only while the profile is not archived. */
router.get('/logos/:profileId(\\d+)', async (req, res, next) => {
  try {
    const p = await db.one('SELECT id, logo_path FROM employer_profiles WHERE id=$1 AND NOT archived', [req.params.profileId]);
    if (!p || !p.logo_path) return res.status(404).end();
    sendLogo(res, p);
  } catch (e) { next(e); }
});

/** DEV ONLY: log in as any seed user without the auth router. Disabled in production. */
if (!isProd) {
  router.get('/portal-dev-login/:email', async (req, res, next) => {
    try {
      const u = await db.one('SELECT id, role FROM users WHERE email=$1 AND is_active', [req.params.email]);
      if (!u) return res.status(404).send('no such user');
      req.session.userId = u.id;
      const next_ = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : auth.homeFor(u);
      req.session.save(() => res.redirect(next_));
    } catch (e) { next(e); }
  });
}

// ------------------------------------------------------------------ portal area (shared handlers)
const area = express.Router();

function guard(base) {
  return [auth.requireAuth('employer', 'consultant'), async (req, res, next) => {
    const want = baseFor(req.user);
    if (want !== base) return res.redirect(want + req.url);
    res.locals.base = base;
    res.locals.isConsultant = req.user.role === 'consultant';
    res.locals.noindex = true;
    res.locals.extraCss = ['/css/maps.css', '/css/portal.css'];
    res.locals.extraJs = ['/js/maps.js', '/js/portal.js'];
    try { res.locals.mapConfig = await require('../lib/geocode').publicMapConfig(); res.locals.mapConfigInLayout = true; } catch (e) { /* maps optional */ }
    res.locals.bodyClass = 'portal';
    res.locals.APP_STATUSES = APP_STATUSES;
    res.locals.APP_STATUS_NAME = APP_STATUS_NAME;
    Object.assign(res.locals, pricingFor(req.user.role));
    try { req.profiles = res.locals.profiles = await profilesFor(req.user); } catch (e) { return next(e); }
    next();
  }];
}

/** Load a job the user may manage (404 otherwise). */
async function loadJob(req, res, next) {
  try {
    if (!(await jobs.userCanManageJob(req.user, req.params.id))) return res.status(404).render('error', { title: 'Job not found', code: 404, message: 'That posting does not exist or is not yours.', noindex: true });
    // operating_name = the name to DISPLAY (posting's own choice, else the profile default); job_operating_name = the raw per-posting column.
    req.job = await db.one(`SELECT j.*, j.operating_name AS job_operating_name, p.company_name, coalesce(j.operating_name, p.operating_name) AS operating_name, p.industry, p.slug AS company_slug, p.logo_path,
        (SELECT count(*)::int FROM applications a WHERE a.job_id=j.id) AS applicants
      FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE j.id=$1`, [req.params.id]);
    if (!req.job) return res.status(404).render('error', { title: 'Job not found', code: 404, message: 'That posting does not exist.', noindex: true });
    req.job.locations = await db.many('SELECT * FROM job_locations WHERE job_id=$1 ORDER BY sort_order, id', [req.job.id]);
    jd.decorateJob(req.job);   // application_deadline @ Toronto noon, application_deadline_date, applications_closed, locked
    next();
  } catch (e) { next(e); }
}
const back = (req, fallback) => { const r = req.get('referer'); try { if (r && new URL(r).host === req.get('host')) return new URL(r).pathname + new URL(r).search; } catch (_) {} return fallback; };

// ---- dashboard
area.get('/dashboard', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const stats = await db.one(`SELECT
        count(*) FILTER (WHERE j.status='active' AND j.expires_at > now())::int AS active,
        count(*) FILTER (WHERE j.status='pending_payment')::int AS pending,
        count(*) FILTER (WHERE j.status='draft')::int AS drafts,
        coalesce(sum((SELECT count(*) FROM applications a WHERE a.job_id=j.id)),0)::int AS applicants,
        coalesce(sum((SELECT count(*) FROM applications a WHERE a.job_id=j.id AND a.created_at > now() - interval '7 days')),0)::int AS applicants_week
      FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE p.owner_user_id=$1`, [uid]);
    const spend = await db.one(`SELECT coalesce(sum(s.total_cents),0)::int AS cents, count(*)::int AS n FROM subscriptions s JOIN employer_profiles p ON p.id=s.employer_profile_id WHERE p.owner_user_id=$1 AND s.status='active'`, [uid]);
    const recent = await db.many(`SELECT a.id, a.status, a.created_at, u.name, u.email, j.id AS job_id, j.title, j.public_id AS job_public_id
      FROM applications a JOIN jobs j ON j.id=a.job_id JOIN employer_profiles p ON p.id=j.employer_profile_id JOIN users u ON u.id=a.seeker_user_id
      WHERE p.owner_user_id=$1 ORDER BY a.created_at DESC LIMIT 6`, [uid]);
    const active = jd.decorateJobs(await db.many(`SELECT j.id, j.title, j.status, j.city, j.province, j.expires_at, j.published_at, j.views, j.hours_amount, j.hours_period, j.public_id, j.locked_at, j.application_deadline, p.company_name, coalesce(j.operating_name, p.operating_name) AS operating_name,
        (SELECT count(*)::int FROM applications a WHERE a.job_id=j.id) AS applicants,
        s.cancel_at_period_end, s.current_period_end
      FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id LEFT JOIN subscriptions s ON s.job_id=j.id
      WHERE p.owner_user_id=$1 AND j.status IN ('active','pending_payment','draft') ORDER BY (j.status='active') DESC, j.updated_at DESC LIMIT 8`, [uid]));
    let byCompany = [];
    if (req.user.role === 'consultant') {
      byCompany = await db.many(`SELECT p.id, p.company_name, p.operating_name, p.logo_path,
          count(j.id) FILTER (WHERE j.status='active' AND j.expires_at > now())::int AS active,
          count(j.id) FILTER (WHERE j.status='pending_payment')::int AS pending,
          coalesce(sum((SELECT count(*) FROM applications a WHERE a.job_id=j.id)),0)::int AS applicants,
          (SELECT coalesce(sum(total_cents),0)::int FROM subscriptions s WHERE s.employer_profile_id=p.id AND s.status='active') AS spend_cents
        FROM employer_profiles p LEFT JOIN jobs j ON j.employer_profile_id=p.id
        WHERE p.owner_user_id=$1 AND NOT p.archived GROUP BY p.id ORDER BY p.company_name`, [uid]);
    }
    res.render('portal/dashboard', { title: 'Dashboard', nav: 'dashboard', stats, spend, recent, active, byCompany });
  } catch (e) { next(e); }
});

// ---- company profile (employer: single)
area.get('/profile', async (req, res, next) => {
  if (req.user.role === 'consultant') return res.redirect('/consultant/profiles');
  try {
    const profile = req.profiles[0];
    if (!profile) return res.render('portal/profile-form', { title: 'Company profile', nav: 'company', profile: {}, values: {}, errors: {}, mode: 'employer-create', COMPANY_SIZES, locations: [], loc: emptyLoc() });
    req.profile = profile;
    await renderProfileForm(req, res, 200, { loc: await locForEdit(req, profile) });
  } catch (e) { next(e); }
});
area.post('/profile', logoMiddleware, async (req, res, next) => {
  if (req.user.role === 'consultant') return res.redirect('/consultant/profiles');
  try {
    const profile = req.profiles[0];
    const { values, errors } = validateProfile(req, profile);
    if (Object.keys(errors).length) return res.status(422).render('portal/profile-form', { title: 'Company profile', nav: 'company', profile: profile || {}, values, errors, mode: profile ? 'employer' : 'employer-create', COMPANY_SIZES, locations: profile ? await locationsFor(profile.id) : [], loc: emptyLoc() });
    const id = await upsertProfile(req, profile, values);
    req.flash('success', 'Company profile saved.');
    await auth.audit(req.user.id, profile ? 'profile.update' : 'profile.create', 'employer_profile', id, { company_name: values.company_name });
    res.redirect(res.locals.base + '/profile');
  } catch (e) { next(e); }
});
/** Owner-only logo (also works for archived profiles). */
area.get('/logos/:profileId(\\d+)', async (req, res, next) => {
  try {
    const p = await db.one('SELECT id, logo_path FROM employer_profiles WHERE id=$1 AND owner_user_id=$2', [req.params.profileId, req.user.id]);
    if (!p || !p.logo_path) return res.status(404).end();
    sendLogo(res, p);
  } catch (e) { next(e); }
});

// ---- consultant: many profiles
const consultantOnly = (req, res, next) => req.user.role === 'consultant' ? next() : res.redirect('/employer/profile');
area.get('/profiles', consultantOnly, async (req, res, next) => {
  try {
    const list = await db.many(`SELECT p.*,
        count(j.id) FILTER (WHERE j.status='active' AND j.expires_at > now())::int AS active_jobs,
        count(j.id) FILTER (WHERE j.status IN ('draft','pending_payment'))::int AS pending_jobs,
        count(j.id)::int AS total_jobs,
        coalesce(sum((SELECT count(*) FROM applications a WHERE a.job_id=j.id)),0)::int AS applicants
      FROM employer_profiles p LEFT JOIN jobs j ON j.employer_profile_id=p.id
      WHERE p.owner_user_id=$1 GROUP BY p.id ORDER BY p.archived, p.company_name`, [req.user.id]);
    res.render('portal/profiles', { title: 'Companies', nav: 'company', list });
  } catch (e) { next(e); }
});
area.get('/profiles/new', consultantOnly, (req, res) => res.render('portal/profile-form', { title: 'Add a company', nav: 'company', profile: {}, values: {}, errors: {}, mode: 'consultant-new', COMPANY_SIZES, then: req.query.then, locations: [], loc: emptyLoc() }));
area.post('/profiles/new', consultantOnly, logoMiddleware, async (req, res, next) => {
  try {
    const { values, errors } = validateProfile(req, null);
    if (Object.keys(errors).length) return res.status(422).render('portal/profile-form', { title: 'Add a company', nav: 'company', profile: {}, values, errors, mode: 'consultant-new', COMPANY_SIZES, then: req.query.then, locations: [], loc: emptyLoc() });
    const id = await upsertProfile(req, null, values);
    await auth.audit(req.user.id, 'profile.create', 'employer_profile', id, { company_name: values.company_name });
    req.flash('success', `${values.company_name} added. You can now post jobs for this company.`);
    res.redirect(req.query.then === 'post' ? '/consultant/jobs/new?profile=' + id : '/consultant/profiles');
  } catch (e) { next(e); }
});
async function loadOwnProfile(req, res, next) {
  try {
    req.profile = await db.one('SELECT * FROM employer_profiles WHERE id=$1 AND owner_user_id=$2', [req.params.id, req.user.id]);
    if (!req.profile) return res.status(404).render('error', { title: 'Company not found', code: 404, message: 'That company profile does not exist or is not yours.', noindex: true });
    next();
  } catch (e) { next(e); }
}
area.get('/profiles/:id(\\d+)/edit', consultantOnly, loadOwnProfile, async (req, res, next) => { try { await renderProfileForm(req, res, 200, { loc: await locForEdit(req, req.profile) }); } catch (e) { next(e); } });
area.post('/profiles/:id(\\d+)/edit', consultantOnly, loadOwnProfile, logoMiddleware, async (req, res, next) => {
  try {
    const { values, errors } = validateProfile(req, req.profile);
    if (Object.keys(errors).length) return renderProfileForm(req, res, 422, { values, errors });
    await upsertProfile(req, req.profile, values);
    await auth.audit(req.user.id, 'profile.update', 'employer_profile', req.profile.id, { company_name: values.company_name });
    req.flash('success', 'Company profile saved.');
    res.redirect('/consultant/profiles');
  } catch (e) { next(e); }
});
area.post('/profiles/:id(\\d+)/archive', consultantOnly, loadOwnProfile, async (req, res, next) => {
  try {
    const live = await db.one(`SELECT count(*)::int AS n FROM jobs WHERE employer_profile_id=$1 AND status IN ('active','pending_payment')`, [req.profile.id]);
    if (live.n > 0) { req.flash('error', `${req.profile.company_name} still has ${live.n} active or unpaid posting${live.n === 1 ? '' : 's'}. Cancel them first, then archive the company.`); return res.redirect('/consultant/profiles'); }
    await db.query('UPDATE employer_profiles SET archived=true, updated_at=now() WHERE id=$1', [req.profile.id]);
    await auth.audit(req.user.id, 'profile.archive', 'employer_profile', req.profile.id, { company_name: req.profile.company_name });
    req.flash('success', `${req.profile.company_name} archived.`);
    res.redirect('/consultant/profiles');
  } catch (e) { next(e); }
});
area.post('/profiles/:id(\\d+)/unarchive', consultantOnly, loadOwnProfile, async (req, res, next) => {
  try {
    await db.query('UPDATE employer_profiles SET archived=false, updated_at=now() WHERE id=$1', [req.profile.id]);
    await auth.audit(req.user.id, 'profile.unarchive', 'employer_profile', req.profile.id, null);
    req.flash('success', `${req.profile.company_name} restored.`);
    res.redirect('/consultant/profiles');
  } catch (e) { next(e); }
});

// ---- employer address book (employer_locations): managed on the profile, SELECTED when posting.
const MAX_OPERATING_NAMES = 10;
/** Active (non-archived) locations of a profile, default first. */
const locationsFor = (profileId) => db.many('SELECT * FROM employer_locations WHERE employer_profile_id=$1 AND NOT archived ORDER BY is_default DESC, id', [profileId]);
/** Fire-and-forget geocode after a location is saved. lib/geocode is written by the maps agent; missing module or failure is ignored. */
function geocodeLater(locationId) {
  try {
    const p = require('../lib/geocode').geocodeEmployerLocation(locationId);
    if (p && typeof p.catch === 'function') p.catch((e) => console.warn('[portal] geocode failed for location', locationId, e && e.message));
  } catch (_) { /* module not present yet, or threw synchronously — never block the save */ }
}
/** employer_profiles.street_address/city/province/postal_code always mirror the DEFAULT location (public company page, legacy readers). */
async function syncProfileAddress(profileId, c) {
  const q = c || db;
  const d = (await q.query('SELECT * FROM employer_locations WHERE employer_profile_id=$1 AND NOT archived ORDER BY is_default DESC, id LIMIT 1', [profileId])).rows[0];
  if (!d) return;
  if (!d.is_default) await q.query('UPDATE employer_locations SET is_default=true, updated_at=now() WHERE id=$1', [d.id]);   // nothing was default: promote the oldest
  await q.query('UPDATE employer_profiles SET street_address=$2, city=$3, province=$4, postal_code=$5, updated_at=now() WHERE id=$1', [profileId, d.street_address, d.city, d.province, d.postal_code]);
}
/** Parse + validate one address (profile "Add location" form, job form "Add a new location" block, profile create). prefix = field-name prefix. */
function parseLocation(b, prefix, opts) {
  const p = (f) => b[prefix + f];
  const l = { label: clean(p('label'), 80), street_address: clean(p('street_address'), 200), unit: clean(p('unit'), 40), city: clean(p('city'), 80), province: clean(p('province'), 2).toUpperCase(), postal_code: clean(p('postal_code'), 10).toUpperCase() };
  const blank = !l.label && !l.street_address && !l.unit && !l.city && !l.province && !l.postal_code;
  const errors = {};
  if (blank && (opts && opts.optional)) return { values: l, errors, blank: true };
  if (l.street_address.length < 3) errors[prefix + 'street_address'] = 'Enter the street address (number and street).';
  if (l.city.length < 2) errors[prefix + 'city'] = 'Enter the city.';
  if (!C.PROVINCE_NAME[l.province]) errors[prefix + 'province'] = 'Choose a province or territory.';
  if (!l.postal_code) errors[prefix + 'postal_code'] = 'Enter the postal code.';
  else if (!C.POSTAL_CODE_RE.test(l.postal_code)) errors[prefix + 'postal_code'] = 'Enter a valid Canadian postal code (e.g. M5V 3L9).';
  else l.postal_code = h.formatPostal(l.postal_code);
  return { values: l, errors, blank: false };
}
/** Insert a location for a profile (becomes the default when the profile has none). Returns the new row. Call geocodeLater(row.id) after commit. */
async function insertLocation(c, profileId, l, makeDefault) {
  const q = c || db;
  const hasDefault = (await q.query('SELECT 1 FROM employer_locations WHERE employer_profile_id=$1 AND NOT archived AND is_default', [profileId])).rows[0];
  const isDefault = !!makeDefault || !hasDefault;
  if (isDefault) await q.query('UPDATE employer_locations SET is_default=false, updated_at=now() WHERE employer_profile_id=$1 AND is_default', [profileId]);
  const r = await q.query(`INSERT INTO employer_locations(employer_profile_id, label, street_address, unit, city, province, postal_code, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [profileId, l.label || null, l.street_address, l.unit || null, l.city, l.province, l.postal_code, isDefault]);
  await syncProfileAddress(profileId, q);
  return r.rows[0];
}
const profileFormPath = (req, profile) => req.user.role === 'consultant' ? `/consultant/profiles/${profile.id}/edit` : '/employer/profile';
const emptyLoc = () => ({ values: {}, errors: {}, editId: null });
/** ?loc=<id> opens that location in the profile form's location editor (no-JS friendly edit mode). */
async function locForEdit(req, profile) {
  const lid = intOrNull(req.query.loc);
  if (!lid) return emptyLoc();
  const row = await db.one('SELECT * FROM employer_locations WHERE id=$1 AND employer_profile_id=$2 AND NOT archived', [lid, profile.id]);
  return row ? { values: row, errors: {}, editId: row.id } : emptyLoc();
}
async function renderProfileForm(req, res, status, extra) {
  const profile = req.profile;
  const locals = Object.assign({ title: req.user.role === 'consultant' ? 'Edit ' + profile.company_name : 'Company profile', nav: 'company', profile, values: profile, errors: {}, mode: req.user.role === 'consultant' ? 'consultant-edit' : 'employer', COMPANY_SIZES,
    locations: await locationsFor(profile.id), loc: { values: {}, errors: {}, editId: null } }, extra);
  res.status(status || 200).render('portal/profile-form', locals);
}
// Sub-router: expects req.profile (owner-checked). Mounted at /employer/profile/locations and /consultant/profiles/:id/locations.
const locRouter = express.Router();
locRouter.post('/', async (req, res, next) => {
  try {
    const { values, errors } = parseLocation(req.body || {}, 'loc_');
    if (Object.keys(errors).length) return renderProfileForm(req, res, 422, { loc: { values, errors, editId: null } });
    const row = await db.tx((c) => insertLocation(c, req.profile.id, values, req.body.make_default === '1'));
    geocodeLater(row.id);
    await auth.audit(req.user.id, 'location.create', 'employer_location', row.id, { profile: req.profile.id, city: row.city });
    req.flash('success', `Location added${row.is_default ? ' and set as the default' : ''}.`);
    res.redirect(profileFormPath(req, req.profile) + '#locations');
  } catch (e) { next(e); }
});
async function loadLocation(req, res, next) {
  try {
    req.location = await db.one('SELECT * FROM employer_locations WHERE id=$1 AND employer_profile_id=$2 AND NOT archived', [req.params.lid, req.profile.id]);
    if (!req.location) return res.status(404).render('error', { title: 'Location not found', code: 404, message: 'That location does not exist or is not yours.', noindex: true });
    next();
  } catch (e) { next(e); }
}
locRouter.post('/:lid(\\d+)', loadLocation, async (req, res, next) => {
  try {
    const { values, errors } = parseLocation(req.body || {}, 'loc_');
    if (Object.keys(errors).length) return renderProfileForm(req, res, 422, { loc: { values, errors, editId: req.location.id } });
    const changed = ['street_address', 'unit', 'city', 'province', 'postal_code'].some(f => (req.location[f] || '') !== (values[f] || ''));
    await db.tx(async (c) => {
      await c.query(`UPDATE employer_locations SET label=$2, street_address=$3, unit=$4, city=$5, province=$6, postal_code=$7, updated_at=now()${changed ? ', lat=NULL, lng=NULL, geocoded_at=NULL, place_id=NULL' : ''} WHERE id=$1`,
        [req.location.id, values.label || null, values.street_address, values.unit || null, values.city, values.province, values.postal_code]);
      await syncProfileAddress(req.profile.id, c);
    });
    if (changed) geocodeLater(req.location.id);
    await auth.audit(req.user.id, 'location.update', 'employer_location', req.location.id, { profile: req.profile.id, changed });
    req.flash('success', 'Location updated.');
    res.redirect(profileFormPath(req, req.profile) + '#locations');
  } catch (e) { next(e); }
});
locRouter.post('/:lid(\\d+)/archive', loadLocation, async (req, res, next) => {
  try {
    await db.tx(async (c) => {
      await c.query('UPDATE employer_locations SET archived=true, is_default=false, updated_at=now() WHERE id=$1', [req.location.id]);
      await syncProfileAddress(req.profile.id, c);   // promotes the next one when the default was archived
    });
    await auth.audit(req.user.id, 'location.archive', 'employer_location', req.location.id, { profile: req.profile.id });
    req.flash('success', 'Location archived. Postings that already use it keep their address.');
    res.redirect(profileFormPath(req, req.profile) + '#locations');
  } catch (e) { next(e); }
});
locRouter.post('/:lid(\\d+)/default', loadLocation, async (req, res, next) => {
  try {
    await db.tx(async (c) => {
      await c.query('UPDATE employer_locations SET is_default=false, updated_at=now() WHERE employer_profile_id=$1 AND is_default', [req.profile.id]);
      await c.query('UPDATE employer_locations SET is_default=true, updated_at=now() WHERE id=$1', [req.location.id]);
      await syncProfileAddress(req.profile.id, c);
    });
    await auth.audit(req.user.id, 'location.default', 'employer_location', req.location.id, { profile: req.profile.id });
    req.flash('success', `${req.location.label || h.fullAddress(req.location)} is now the default location.`);
    res.redirect(profileFormPath(req, req.profile) + '#locations');
  } catch (e) { next(e); }
});
// employer: their single profile; consultant: any of their profiles by id
area.use('/profile/locations', (req, res, next) => {
  if (req.user.role === 'consultant') return res.redirect('/consultant/profiles');
  if (!req.profiles[0]) { req.flash('error', 'Create your company profile first.'); return res.redirect('/employer/profile'); }
  req.profile = req.profiles[0]; next();
}, locRouter);
area.use('/profiles/:id(\\d+)/locations', consultantOnly, loadOwnProfile, locRouter);

/** Parse the operating-name list: operating_names[] (first = default). Blank entries dropped, duplicates (case-insensitive) collapsed. */
function parseOperatingNames(b) {
  let v = b.operating_names;
  if (v && typeof v === 'object' && !Array.isArray(v)) v = Object.values(v);
  const out = []; const seen = new Set();
  for (const raw of arr(v).concat(b.operating_name != null ? [b.operating_name] : [])) {   // operating_name: legacy single field still accepted
    const s = clean(raw, 120); const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k); out.push(s);
    if (out.length >= MAX_OPERATING_NAMES) break;
  }
  return out;
}
function validateProfile(req, existing) {
  const b = req.body || {};
  const values = {
    company_name: clean(b.company_name, 120), operating_names: parseOperatingNames(b), website: clean(b.website, 200), industry: clean(b.industry, 60),
    company_size: clean(b.company_size, 20), description: clean(b.description, 4000), contact_name: clean(b.contact_name, 120), contact_email: clean(b.contact_email, 160).toLowerCase(), contact_phone: clean(b.contact_phone, 40),
  };
  values.operating_name = values.operating_names[0] || '';
  const errors = {};
  if (values.company_name.length < 2) errors.company_name = 'Enter the company name.';
  if (!C.INDUSTRY_NAME[values.industry]) errors.industry = values.industry ? 'Choose an industry from the list.' : 'Choose the company’s industry.';
  if (values.website && !/^https?:\/\//i.test(values.website)) values.website = 'https://' + values.website;
  if (values.website && !URL_RE.test(values.website)) errors.website = 'Enter a valid website address (https://…).';
  if (values.company_size && !COMPANY_SIZES.includes(values.company_size)) errors.company_size = 'Choose a company size.';
  if (values.contact_email && !EMAIL_RE.test(values.contact_email)) errors.contact_email = 'Enter a valid email address.';
  if (req.logoError) errors.logo = req.logoError;
  // A NEW profile collects its first (default) location inline: loc_* fields. Optional — but if anything is typed, the address must be complete.
  if (!existing) {
    const first = parseLocation(b, 'loc_', { optional: true });
    values.first_location = first.blank ? null : first.values;
    Object.assign(values, { loc_label: first.values.label, loc_street_address: first.values.street_address, loc_unit: first.values.unit, loc_city: first.values.city, loc_province: first.values.province, loc_postal_code: first.values.postal_code });
    Object.assign(errors, first.errors);
  }
  return { values, errors };
}
async function upsertProfile(req, existing, v) {
  let id;
  if (existing) {
    // Address columns are NOT taken from this form any more: they mirror the default employer_locations row (syncProfileAddress).
    await db.query(`UPDATE employer_profiles SET company_name=$2, website=$3, industry=$4, company_size=$5, description=$6, contact_name=$7, contact_email=$8, contact_phone=$9, operating_name=$10, operating_names=$11, updated_at=now() WHERE id=$1`,
      [existing.id, v.company_name, v.website || null, v.industry || null, v.company_size || null, v.description || null, v.contact_name || null, v.contact_email || null, v.contact_phone || null, v.operating_name || null, v.operating_names]);
    id = existing.id;
  } else {
    const slug = await jobs.uniqueProfileSlug(v.company_name);
    const first = v.first_location;
    const row = await db.tx(async (c) => {
      const r = (await c.query(`INSERT INTO employer_profiles(owner_user_id, company_name, slug, website, industry, company_size, city, province, description, contact_name, contact_email, contact_phone, operating_name, operating_names, street_address, postal_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [req.user.id, v.company_name, slug, v.website || null, v.industry || null, v.company_size || null, first ? first.city : null, first ? first.province : null, v.description || null, v.contact_name || null, v.contact_email || null, v.contact_phone || null, v.operating_name || null, v.operating_names, first ? first.street_address : null, first ? first.postal_code : null])).rows[0];
      const loc = first ? await insertLocation(c, r.id, Object.assign({}, first, { label: first.label || 'Main location' }), true) : null;
      return { id: r.id, locId: loc && loc.id };
    });
    id = row.id;
    if (row.locId) geocodeLater(row.locId);
  }
  if (req.file) {
    try {
      const rel = await saveLogo(id, req.file, existing && existing.logo_path);
      await db.query('UPDATE employer_profiles SET logo_path=$2, updated_at=now() WHERE id=$1', [id, rel]);
    } catch (e) { if (e.code !== 'BAD_IMAGE') throw e; req.flash('error', e.message); }
  } else if (req.body.remove_logo === '1' && existing && existing.logo_path) {
    fs.promises.unlink(path.join(UPLOAD_DIR, existing.logo_path)).catch(() => {});
    await db.query('UPDATE employer_profiles SET logo_path=NULL, updated_at=now() WHERE id=$1', [id]);
  }
  return id;
}

// ---- jobs list
area.get('/jobs', async (req, res, next) => {
  try {
    const status = PROFILE_TABS[req.query.status] ? req.query.status : 'all';
    const profileId = intOrNull(req.query.profile);
    const where = ['p.owner_user_id=$1'];
    const params = [req.user.id];
    if (status === 'archived') where.push(`j.status IN ('expired','cancelled','inactive')`);
    else if (status !== 'all') where.push(`j.status='${status}'`);
    if (profileId) { params.push(profileId); where.push(`j.employer_profile_id=$${params.length}`); }
    const list = jd.decorateJobs(await db.many(`SELECT j.id, j.title, j.status, j.city, j.province, j.published_at, j.expires_at, j.archived_at, j.cancelled_at, j.created_at, j.updated_at, j.views, j.employer_profile_id, j.hours_amount, j.hours_period, j.public_id, j.locked_at, j.application_deadline, p.company_name, coalesce(j.operating_name, p.operating_name) AS operating_name,
        (SELECT count(*)::int FROM job_locations l WHERE l.job_id=j.id) AS n_locations,
        (SELECT count(*)::int FROM applications a WHERE a.job_id=j.id) AS applicants,
        s.status AS sub_status, s.cancel_at_period_end, s.current_period_end
      FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id LEFT JOIN subscriptions s ON s.job_id=j.id
      WHERE ${where.join(' AND ')} ORDER BY j.updated_at DESC`, params));
    const counts = await db.one(`SELECT count(*)::int AS all, count(*) FILTER (WHERE j.status='active')::int AS active, count(*) FILTER (WHERE j.status='pending_payment')::int AS pending_payment,
        count(*) FILTER (WHERE j.status='draft')::int AS draft, count(*) FILTER (WHERE j.status IN ('expired','cancelled','inactive'))::int AS archived
      FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE p.owner_user_id=$1 ${profileId ? 'AND j.employer_profile_id=$2' : ''}`, profileId ? [req.user.id, profileId] : [req.user.id]);
    res.render('portal/jobs', { title: 'My jobs', nav: 'jobs', list, status, profileId, counts, TABS: PROFILE_TABS });
  } catch (e) { next(e); }
});

// ---- job form (new + edit)
// Work locations are chosen from the employer profile's address book (employer_locations) and SNAPSHOTTED into job_locations on save.
// Form fields: location_ids[] (employer_locations.id, must belong to the selected profile) · keep_job_locations[] (legacy snapshot rows of THIS
// job that match no address-book entry; edit only) · new_loc_{label,street_address,unit,city,province,postal_code} (inline "Add a new location":
// saved to the profile AND selected) · operating_name_choice_<profileId> ('__legal' | one of profile.operating_names | '__new') +
// operating_name_new_<profileId> · hours_amount + hours_period.
const MAX_JOB_LOCATIONS = 20;
const NEW_LOC = 'new_loc_';
const locKey = (l) => [String(l.street_address || '').toLowerCase().replace(/\s+/g, ' ').trim(), String(l.unit || '').toLowerCase().replace(/\s+/g, ''), String(l.city || '').toLowerCase().replace(/\s+/g, ' ').trim(), l.province || '', h.formatPostal(l.postal_code || '')].join('|');
/** Active address-book rows for every profile the user owns: { [profileId]: rows[] } (default first). */
async function locationsByProfile(req) {
  const out = {}; req.profiles.forEach(p => { out[p.id] = []; });
  if (!req.profiles.length) return out;
  const rows = await db.many('SELECT * FROM employer_locations WHERE employer_profile_id = ANY($1::bigint[]) AND NOT archived ORDER BY is_default DESC, id', [req.profiles.map(p => p.id)]);
  rows.forEach(r => { r.id = Number(r.id); r.employer_profile_id = Number(r.employer_profile_id); (out[r.employer_profile_id] = out[r.employer_profile_id] || []).push(r); });
  return out;
}
/** Split an existing job's snapshot rows into address-book ids to tick and legacy rows (no matching active address-book entry) to keep. */
function matchJobLocations(job, active) {
  const byId = new Map(active.map(l => [l.id, l])); const byKey = new Map(active.map(l => [locKey(l), l]));
  const ids = []; const legacy = [];
  (job.locations || []).forEach(jl => {
    const m = (jl.employer_location_id && byId.get(Number(jl.employer_location_id))) || byKey.get(locKey(jl));
    if (m) { if (!ids.includes(m.id)) ids.push(m.id); } else legacy.push(jl);
  });
  return { ids, legacy };
}
const defaultApplyEmail = (req, profile) => (profile ? (profile.contact_email || req.user.email) : '');   // the EMPLOYER's inbox; the owner's login only when the profile has none; blank until a company is chosen
function blankJob(req, byProfile) {
  const profileId = intOrNull(req.query.profile) || (req.profiles.length === 1 ? req.profiles[0].id : '');
  const profile = req.profiles.find(p => p.id === profileId);
  const active = (profile && byProfile[profile.id]) || [];
  const def = active.find(l => l.is_default) || active[0];
  return { title: '', category: '', job_type: 'full_time', work_arrangement: 'on_site', experience_level: '', experience_other: '', education: '', education_other: '',
    location_ids: def ? [def.id] : [], keep_job_locations: [], new_loc: {},
    operating_name_choice: profile && profile.operating_name ? profile.operating_name : '__legal', operating_name_new: '',
    hours_amount: '', hours_period: 'week',
    salary_min: '', salary_max: '', salary_period: 'year', vacancies: 1, languages: ['English'], language_other: '', skills: '', audiences: [],
    description: '', requirements: '', benefits: '', apply_email: defaultApplyEmail(req, profile), apply_url: '', noc_code: '', employer_profile_id: profileId,
    published_at: '', application_deadline: '' };
}
function jobToValues(req, j, byProfile) {
  const langs = j.languages || [];
  const other = langs.filter(l => !['English', 'French'].includes(l));
  const v = Object.assign({}, j, { languages: langs.filter(l => ['English', 'French'].includes(l)).concat(other.length ? ['Other'] : []), language_other: other.join(', '), skills: (j.skills || []).join(', '), salary_min: j.salary_min ?? '', salary_max: j.salary_max ?? '' });
  // Old vocabulary keys pre-select their Job Bank equivalent; legacy free-text education opens under "Other (specify)".
  if (C.EDUCATION_LEGACY[v.education]) v.education = C.EDUCATION_LEGACY[v.education];
  if (C.EXPERIENCE_LEGACY[v.experience_level]) v.experience_level = C.EXPERIENCE_LEGACY[v.experience_level];
  if (v.education && !C.EDUCATION_LEVEL_NAME[v.education]) { v.education_other = v.education_other || v.education; v.education = 'other'; }
  v.education_other = v.education_other || ''; v.experience_other = v.experience_other || ''; v.experience_level = v.experience_level || ''; v.education = v.education || '';
  const profile = req.profiles.find(p => p.id === Number(j.employer_profile_id));
  const m = matchJobLocations(j, (profile && byProfile[profile.id]) || []);
  v.location_ids = m.ids; v.keep_job_locations = m.legacy.map(l => Number(l.id)); v.new_loc = {};
  const names = (profile && profile.operating_names) || [];
  const own = j.job_operating_name !== undefined ? j.job_operating_name : j.operating_name;   // loadJob exposes the raw per-posting column separately
  v.operating_name_choice = own ? (own === (profile && profile.company_name) && !names.includes(own) ? '__legal' : own) : ((profile && profile.operating_name) || '__legal');
  v.operating_name_new = '';
  v.hours_amount = j.hours_amount == null ? '' : String(Number(j.hours_amount));
  v.hours_period = j.hours_period || 'week';
  v.apply_email = j.apply_email || '';
  v.apply_url = j.apply_url || ''; v.noc_code = j.noc_code || ''; v.requirements = j.requirements || ''; v.benefits = j.benefits || '';
  // Dates (round 3): yyyy-mm-dd strings for <input type=date>. published_at is a timestamptz (Toronto day); application_deadline a DATE.
  v.published_at = j.published_at ? h.formatDateInput(j.published_at) : '';
  v.application_deadline = j.application_deadline_date !== undefined ? (j.application_deadline_date || '') : jd.dateOnly(j.application_deadline);
  return v;
}
/** Money input -> numeric string with 2 decimals ("21.18"), or null when it is not a valid amount. Accepts "$21.18", "21,18", "1,234.50". */
function parseMoney(s) {
  let t = String(s ?? '').replace(/[$\s]/g, '');
  if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');   // European decimal comma
  t = t.replace(/,/g, '');                                 // thousands separators
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(t)) return null;   // range (0.01 – 9,999,999.99) is checked by the caller so it gets its own message
  return Number(t).toFixed(2);
}
const SALARY_MAX = 9999999.99;
async function validateJob(req, byProfile) {
  const b = req.body || {};
  const langs = arr(b.languages).filter(l => ['English', 'French', 'Other'].includes(l));
  // Round 3: once published (jobs.isLocked) the company, operating name, title and work locations are frozen. Whatever
  // the form posts for those fields is ignored and the stored values are echoed back; job_locations rows are left untouched.
  const locked = !!(req.job && jobs.isLocked(req.job));
  const values = {
    title: clean(b.title, 120), category: clean(b.category, 60), job_type: clean(b.job_type, 30), work_arrangement: clean(b.work_arrangement, 20),
    experience_level: clean(b.experience_level, 30), experience_other: clean(b.experience_other, 120), education: clean(b.education, 30), education_other: clean(b.education_other, 160),
    location_ids: arr(b.location_ids).map(intOrNull).filter(Boolean).slice(0, MAX_JOB_LOCATIONS), keep_job_locations: arr(b.keep_job_locations).map(intOrNull).filter(Boolean),
    hours_amount: clean(b.hours_amount, 8), hours_period: C.HOURS_PERIOD_NAME[b.hours_period] ? String(b.hours_period) : 'week',
    salary_min: clean(b.salary_min, 12), salary_max: clean(b.salary_max, 12), salary_period: C.SALARY_PERIOD_NAME[b.salary_period] ? String(b.salary_period) : 'year',
    vacancies: clean(b.vacancies, 5), languages: langs, language_other: clean(b.language_other, 120), skills: clean(b.skills, 600),
    audiences: arr(b.audiences).filter(a => C.AUDIENCE_NAME[a]), description: clean(b.description, 12000), requirements: clean(b.requirements, 6000), benefits: clean(b.benefits, 6000),
    apply_email: clean(b.apply_email, 160).toLowerCase(), apply_url: clean(b.apply_url, 300), noc_code: clean(b.noc_code, 10),
    published_at: clean(b.published_at, 10), application_deadline: clean(b.application_deadline, 10),
    // Employers own exactly one profile: the posted id is never trusted. Consultants choose among THEIR profiles (checked below).
    employer_profile_id: req.user.role === 'consultant' ? intOrNull(b.employer_profile_id) : (req.profiles[0] ? req.profiles[0].id : null),
  };
  // Once billing exists (or the posting is locked) the company is locked to the job's profile, whatever the form says.
  if (req.job && (locked || ['active', 'pending_payment', 'inactive', 'expired', 'cancelled'].includes(req.job.status))) values.employer_profile_id = Number(req.job.employer_profile_id);
  if (locked) values.title = req.job.title;
  if (C.EDUCATION_LEGACY[values.education]) values.education = C.EDUCATION_LEGACY[values.education];
  if (C.EXPERIENCE_LEGACY[values.experience_level]) values.experience_level = C.EXPERIENCE_LEGACY[values.experience_level];
  const errors = {};
  if (!locked && values.title.length < 3) errors.title = 'Enter a job title (at least 3 characters).';
  if (!C.CATEGORY_NAME[values.category]) errors.category = 'Choose a category.';
  if (!C.JOB_TYPE_NAME[values.job_type]) errors.job_type = 'Choose a job type.';
  if (!C.WORK_ARRANGEMENT_NAME[values.work_arrangement]) errors.work_arrangement = 'Choose a work arrangement.';
  if (values.experience_level && !C.EXPERIENCE_LEVEL_NAME[values.experience_level]) errors.experience_level = 'Choose an experience level.';
  if (values.experience_level === 'other' && !values.experience_other) errors.experience_other = 'Describe the experience you are looking for.';
  if (values.education && !C.EDUCATION_LEVEL_NAME[values.education]) errors.education = 'Choose an education level.';
  if (values.education === 'other' && !values.education_other) errors.education_other = 'Describe the education or training required.';
  const profile = req.profiles.find(p => p.id === values.employer_profile_id) || null;
  if (!profile) errors.employer_profile_id = req.user.role === 'consultant' ? 'Choose which company this posting is for.' : 'Create your company profile first.';
  // Operating name for this posting (per-profile field names so the consultant form can carry one select per company).
  let operatingName = null; let appendOperatingName = null;
  values.operating_name_choice = profile ? clean(b['operating_name_choice_' + profile.id], 120) : '';
  values.operating_name_new = profile ? clean(b['operating_name_new_' + profile.id], 120) : '';
  if (locked) {
    operatingName = req.job.job_operating_name || null;   // the raw per-posting column stays exactly as stored
    const stored = jobToValues(req, req.job, byProfile);
    values.operating_name_choice = stored.operating_name_choice; values.operating_name_new = '';
  } else if (profile) {
    const names = profile.operating_names || [];
    const choice = values.operating_name_choice;
    if (choice === '__new') {
      if (values.operating_name_new.length < 2) errors.operating_name = 'Enter the new operating name (or pick one from the list).';
      else { operatingName = values.operating_name_new; if (!names.some(n => n.toLowerCase() === operatingName.toLowerCase())) appendOperatingName = operatingName; else operatingName = names.find(n => n.toLowerCase() === operatingName.toLowerCase()); }
    } else if (!choice || choice === '__legal') {
      operatingName = names.length ? profile.company_name : null;   // explicit "legal name" beats the profile default; NULL when there is nothing to override
    } else {
      const hit = names.find(n => n.toLowerCase() === choice.toLowerCase());
      if (hit) operatingName = hit;
      else if (req.job && req.job.job_operating_name && req.job.job_operating_name.toLowerCase() === choice.toLowerCase()) operatingName = req.job.job_operating_name;   // a name since removed from the profile stays on this posting
      else errors.operating_name = 'Choose an operating name from the list.';
    }
  }
  // Work locations: ticked address-book rows of THIS profile + kept legacy rows of THIS job + an optional new address (saved to the profile).
  const active = (profile && byProfile[profile.id]) || [];
  let chosen = active.filter(l => values.location_ids.includes(l.id));
  values.location_ids = chosen.map(l => l.id);
  const legacy = req.job ? matchJobLocations(req.job, active).legacy : [];
  let kept = legacy.filter(l => values.keep_job_locations.includes(Number(l.id)));
  values.keep_job_locations = kept.map(l => Number(l.id));
  const nl = parseLocation(b, NEW_LOC, { optional: true });
  values.new_loc = nl.values;
  let newLoc = null;
  if (locked) {
    // Locations are frozen: echo the stored selection, ignore ticks and the inline "new location" block entirely.
    const m = matchJobLocations(req.job, active);
    chosen = []; kept = []; values.location_ids = m.ids; values.keep_job_locations = m.legacy.map(l => Number(l.id)); values.new_loc = {};
  } else if (!nl.blank) {
    if (Object.keys(nl.errors).length) { Object.assign(errors, nl.errors); errors.locations = 'Complete the new location (street, city, province and postal code) or clear it.'; }
    else if (active.some(l => locKey(l) === locKey(nl.values))) { const dupe = active.find(l => locKey(l) === locKey(nl.values)); if (!chosen.includes(dupe)) chosen.push(dupe); values.location_ids = chosen.map(l => l.id); values.new_loc = {}; }   // already in the address book: just select it
    else newLoc = nl.values;
  }
  if (!locked && !errors.locations && !chosen.length && !kept.length && !newLoc) errors.locations = 'Select at least one work location.';
  if (chosen.length + kept.length + (newLoc ? 1 : 0) > MAX_JOB_LOCATIONS) errors.locations = `A posting can have at most ${MAX_JOB_LOCATIONS} work locations.`;
  // Hours worked (Job Bank "Number of hours worked" + frequency) — optional
  let hours = null;
  if (values.hours_amount !== '') {
    hours = Number(values.hours_amount.replace(',', '.'));
    if (!Number.isFinite(hours) || hours < 0.5 || hours > 168) { errors.hours_amount = 'Enter the number of hours (0.5 to 168).'; hours = null; }
    else hours = Math.round(hours * 100) / 100;
  }
  // Pay: decimals with 2 places ($21.18/hour), 0.01 – 9,999,999.99; stored as numeric(10,2) strings. Blank = not disclosed.
  const smin = values.salary_min === '' ? null : parseMoney(values.salary_min), smax = values.salary_max === '' ? null : parseMoney(values.salary_max);
  const moneyError = (raw, parsed) => (raw !== '' && parsed == null) ? 'Enter an amount like 21.18 (up to 2 decimals).' : (parsed != null && (Number(parsed) <= 0 || Number(parsed) > SALARY_MAX)) ? 'Enter an amount between 0.01 and 9,999,999.99.' : null;
  if (moneyError(values.salary_min, smin)) errors.salary_min = moneyError(values.salary_min, smin);
  if (moneyError(values.salary_max, smax)) errors.salary_max = moneyError(values.salary_max, smax);
  if (!errors.salary_min && !errors.salary_max && smin != null && smax != null && Number(smax) < Number(smin)) errors.salary_max = 'Maximum must be at least the minimum.';
  if (smin != null && !errors.salary_min) values.salary_min = smin;
  if (smax != null && !errors.salary_max) values.salary_max = smax;
  const vac = intOrNull(values.vacancies); if (vac == null || vac < 1 || vac > 999) errors.vacancies = 'Enter the number of positions (1–999).';
  if (!langs.length) errors.languages = 'Select at least one language.';
  if (langs.includes('Other') && !values.language_other) errors.language_other = 'Name the other language(s).';
  if (values.description.length < 100) errors.description = `Describe the role in at least 100 characters (${values.description.length} so far).`;
  if (values.apply_email && !EMAIL_RE.test(values.apply_email)) errors.apply_email = 'Enter a valid email address.';
  // "Other platform link" (field name apply_url): https only; a bare domain gets https:// prepended.
  if (values.apply_url && !/^https?:\/\//i.test(values.apply_url)) values.apply_url = 'https://' + values.apply_url;
  if (values.apply_url && !isHttpsUrl(values.apply_url)) errors.apply_url = 'Other platform link must be a valid https:// URL';
  if (values.noc_code && !/^\d{4,5}$/.test(values.noc_code)) errors.noc_code = 'NOC codes are 5 digits (2021 NOC).';
  // Dates (round 3). published_at ("Posted on"): only once the posting has been published, <= today (Toronto), stored at 12:00 Toronto;
  // display/sort only — billing (expires_at) is untouched. application_deadline ("Applications close on"): optional, >= today unless unchanged.
  const today = jd.todayToronto();
  const canEditPublishedAt = !!(req.job && req.job.published_at);
  let publishedAt;   // undefined = leave the column alone
  if (canEditPublishedAt) {
    const cur = h.formatDateInput(req.job.published_at);
    if (!values.published_at) values.published_at = cur;   // blank = keep
    const p = jd.parseDateInput(values.published_at);
    if (p.error) errors.published_at = p.error;
    else if (p.value > today) errors.published_at = 'The posted date cannot be in the future.';
    else if (p.value !== cur) publishedAt = jd.torontoNoon(p.value);
  } else values.published_at = '';
  const curDeadline = req.job ? (req.job.application_deadline_date !== undefined ? req.job.application_deadline_date : jd.dateOnly(req.job.application_deadline)) : '';
  const dl = jd.parseDateInput(values.application_deadline);
  let deadline = null;
  if (dl.error) errors.application_deadline = dl.error;
  else if (dl.value && dl.value < today && dl.value !== curDeadline) errors.application_deadline = 'The closing date must be today or later.';
  else deadline = dl.value || null;
  const row = {
    title: values.title, category: values.category, job_type: values.job_type, work_arrangement: values.work_arrangement,
    experience_level: values.experience_level || null, experience_other: values.experience_level === 'other' ? values.experience_other : null,
    education: values.education || null, education_other: values.education === 'other' ? values.education_other : null,
    operating_name: operatingName, hours_amount: hours, hours_period: hours == null ? null : values.hours_period,
    city: '', province: '', postal_code: null,   // filled from the first snapshotted location in persistJobLocations()
    salary_min: smin, salary_max: smax, salary_period: values.salary_period,
    vacancies: vac || 1, languages: langs.filter(l => l !== 'Other').concat(langs.includes('Other') ? values.language_other.split(/[,;]/).map(s => s.trim()).filter(Boolean) : []),
    skills: values.skills.split(/[,;\n]/).map(s => s.trim()).filter(Boolean).slice(0, 30), audiences: values.audiences, description: values.description, requirements: values.requirements || null,
    benefits: values.benefits || null, apply_email: values.apply_email || null, apply_url: values.apply_url || null, noc_code: values.noc_code || null, employer_profile_id: values.employer_profile_id,
    application_deadline: deadline,
  };
  if (publishedAt !== undefined) row.published_at = publishedAt;
  if (locked) {
    // Frozen columns are not part of the UPDATE at all; city/province/postal_code mirror the (untouched) first location.
    row.title = req.job.title; row.operating_name = req.job.job_operating_name || null; row.employer_profile_id = Number(req.job.employer_profile_id);
    delete row.city; delete row.province; delete row.postal_code;
  }
  return { values, errors, row, profile, chosen, kept, newLoc, appendOperatingName, locked };
}
/** https:// URL with a host — the only shape accepted for the "Other platform link". */
function isHttpsUrl(s) { try { const u = new URL(s); return u.protocol === 'https:' && /^[^\s.]+(\.[^\s.]+)+$/.test(u.hostname); } catch (_) { return false; } }
/** Replace a job's snapshot rows. rows = employer_locations rows (id → employer_location_id) and/or job_locations rows being kept. */
async function saveLocations(c, jobId, rows) {
  await c.query('DELETE FROM job_locations WHERE job_id=$1', [jobId]);
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i];
    const elid = l.employer_profile_id != null ? l.id : (l.employer_location_id || null);   // address-book row vs. kept snapshot row
    await c.query(`INSERT INTO job_locations(job_id, employer_location_id, street_address, unit, city, province, postal_code, sort_order, lat, lng, geocoded_at, place_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [jobId, elid, l.street_address || null, l.unit || null, l.city, l.province, l.postal_code || null, i, l.lat ?? null, l.lng ?? null, l.geocoded_at || null, l.place_id || null]);
  }
  if (rows.length) await c.query('UPDATE jobs SET city=$2, province=$3, postal_code=$4 WHERE id=$1', [jobId, rows[0].city, rows[0].province, rows[0].postal_code || null]);
}
/** Inside the save transaction: create the inline "new location" (address book + selected), order = default first, snapshot, append a new operating name to the profile. Returns { rows, newLocId }. */
async function persistJobLocations(c, req, jobId, v) {
  if (v.locked) return { rows: (req.job && req.job.locations) || [], newLocId: null };   // locked posting: job_locations rows are never deleted/reinserted
  let created = null;
  if (v.newLoc) created = await insertLocation(c, v.profile.id, v.newLoc, false);
  const book = v.chosen.slice(); if (created) book.push(created);
  book.sort((a, b) => (b.is_default === true) - (a.is_default === true) || Number(a.id) - Number(b.id));
  const rows = book.concat(v.kept);
  await saveLocations(c, jobId, rows);
  if (v.appendOperatingName) await c.query(`UPDATE employer_profiles SET operating_names = array_append(operating_names, $2), operating_name = COALESCE(operating_name, $2), updated_at=now() WHERE id=$1 AND NOT ($2 = ANY(operating_names))`, [v.profile.id, v.appendOperatingName]);
  return { rows, newLocId: created && created.id };
}
async function jobFormLocals(req, extra) {
  const byProfile = extra.byProfile || await locationsByProfile(req);
  const job = extra.job || null;
  const profile = job ? req.profiles.find(p => p.id === Number(job.employer_profile_id)) : null;
  const legacyLocs = job ? matchJobLocations(job, (profile && byProfile[profile.id]) || []).legacy : [];
  // Round 3 template contract (docs/TEMPLATE-VARS-R3.md): lock state + date inputs.
  const locked = !!(job && jobs.isLocked(job));
  const lockedSummary = locked ? {
    company: job.company_name, operating_name: h.legalNameNote(job) ? job.operating_name : '', title: job.title,
    locations: (job.locations || []).map(l => (l.street_address ? h.fullAddress(l) : h.location(l))),
  } : null;
  const companyLocked = !!(job && (locked || ['active', 'pending_payment', 'inactive', 'expired', 'cancelled'].includes(job.status)));
  const canEditPublishedAt = !!(job && job.published_at);
  const v = extra.values || {};
  const formPublishedAt = canEditPublishedAt ? (v.published_at || h.formatDateInput(job.published_at)) : '';
  const formDeadline = v.application_deadline !== undefined ? v.application_deadline : (job ? (job.application_deadline_date !== undefined ? job.application_deadline_date : jd.dateOnly(job.application_deadline)) : '');
  return Object.assign({ nav: 'post', errors: {}, COMPANY_SIZES, byProfile, legacyLocs, locked, lockedFields: locked ? jobs.LOCKED_FIELDS : [], lockedSummary, companyLocked, canEditPublishedAt, formPublishedAt, formDeadline, today: jd.todayToronto() }, extra);
}

area.get('/jobs/new', (req, res, next) => {
  if (!req.profiles.length) {
    req.flash('info', req.user.role === 'consultant' ? 'Add a company first — every posting is published under a company profile.' : 'Set up your company profile first.');
    return res.redirect(req.user.role === 'consultant' ? '/consultant/profiles/new?then=post' : '/employer/profile');
  }
  jobFormLocals(req, { title: 'Post a job', job: null }).then((l) => { l.values = blankJob(req, l.byProfile); res.render('portal/job-form', l); }).catch(next);
});
area.post('/jobs/new', async (req, res, next) => {
  try {
    if (!req.profiles.length) return res.redirect(res.locals.base + '/jobs/new');
    const byProfile = await locationsByProfile(req);
    const v = await validateJob(req, byProfile);
    const { values, errors, row } = v;
    if (Object.keys(errors).length) return res.status(422).render('portal/job-form', await jobFormLocals(req, { title: 'Post a job', values, errors, job: null, byProfile }));
    // Double submit guard (double-click / retry): an identical draft created by this user in the last 20 s is reused instead of duplicated.
    // A per-user advisory lock serialises two simultaneous POSTs so the second one sees the first one's row.
    const firstCity = (v.chosen[0] || v.newLoc || v.kept[0] || {}).city || '';
    const slug = await jobs.uniqueJobSlug(row.title, firstCity);
    const cols = Object.keys(row);
    const { id, dup, saved } = await db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1, $2)', [7001, Number(req.user.id)]);
      const d = (await c.query(`SELECT id, status FROM jobs WHERE created_by=$1 AND employer_profile_id=$2 AND title=$3 AND description=$4 AND created_at > now() - interval '20 seconds' ORDER BY id LIMIT 1`, [req.user.id, row.employer_profile_id, row.title, row.description])).rows[0];
      if (d) return { id: d.id, dup: d };
      const r = await c.query(`INSERT INTO jobs(${cols.join(',')}, created_by, slug, status) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}, $${cols.length + 1}, $${cols.length + 2}, 'draft') RETURNING id`, [...cols.map(c => row[c]), req.user.id, slug]);
      const saved = await persistJobLocations(c, req, r.rows[0].id, v);
      await jobs.ensurePublicId(r.rows[0].id, c);   // drafts get their Posting ID immediately
      return { id: r.rows[0].id, dup: null, saved };
    });
    if (dup) {
      if (req.body.action === 'publish' && ['draft', 'pending_payment'].includes(dup.status)) return publish(req, res, next, dup.id);
      return res.redirect(`${res.locals.base}/jobs/${dup.id}`);
    }
    if (saved.newLocId) geocodeLater(saved.newLocId);
    await auth.audit(req.user.id, 'job.create', 'job', id, { title: row.title, employer_profile_id: row.employer_profile_id, locations: saved.rows.length, new_location: saved.newLocId || null });
    if (req.body.action === 'publish') return publish(req, res, next, id);
    req.flash('success', 'Draft saved. Publish it whenever you are ready.');
    res.redirect(`${res.locals.base}/jobs/${id}`);
  } catch (e) { next(e); }
});
area.get('/jobs/:id(\\d+)/edit', loadJob, async (req, res, next) => {
  try { const l = await jobFormLocals(req, { title: 'Edit posting', nav: 'jobs', job: req.job }); l.values = jobToValues(req, req.job, l.byProfile); res.render('portal/job-form', l); } catch (e) { next(e); }
});
area.post('/jobs/:id(\\d+)/edit', loadJob, async (req, res, next) => {
  try {
    const byProfile = await locationsByProfile(req);
    const v = await validateJob(req, byProfile);
    const { values, errors, row } = v;
    if (Object.keys(errors).length) return res.status(422).render('portal/job-form', await jobFormLocals(req, { title: 'Edit posting', nav: 'jobs', values, errors, job: req.job, byProfile }));
    if (['active', 'pending_payment'].includes(req.job.status)) row.employer_profile_id = req.job.employer_profile_id; // company is locked once billing exists
    const cols = Object.keys(row);
    const saved = await db.tx(async (c) => {
      await c.query(`UPDATE jobs SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [req.job.id, ...cols.map(c => row[c])]);
      await jobs.ensurePublicId(req.job.id, c);   // legacy rows without a Posting ID get one on their next save
      return persistJobLocations(c, req, req.job.id, v);
    });
    if (saved.newLocId) geocodeLater(saved.newLocId);
    await auth.audit(req.user.id, 'job.update', 'job', req.job.id, { title: row.title, status: req.job.status, locked: !!v.locked, locations: saved.rows.length, new_location: saved.newLocId || null, published_at: row.published_at ? row.published_at.toISOString() : undefined, application_deadline: row.application_deadline });
    if (req.body.action === 'publish' && ['draft', 'pending_payment'].includes(req.job.status)) return publish(req, res, next, req.job.id);
    req.flash('success', req.job.status === 'active' ? 'Posting updated — changes are live.' : 'Posting updated.');
    res.redirect(`${res.locals.base}/jobs/${req.job.id}`);
  } catch (e) { next(e); }
});

// ---- job detail + actions
area.get('/jobs/:id(\\d+)', loadJob, async (req, res, next) => {
  try {
    const sub = await db.one('SELECT * FROM subscriptions WHERE job_id=$1', [req.job.id]);
    const payments = await db.many('SELECT id, receipt_number, total_cents, status, paid_at, period_start, period_end FROM payments WHERE job_id=$1 ORDER BY paid_at DESC LIMIT 12', [req.job.id]);
    const recent = await db.many(`SELECT a.id, a.status, a.created_at, u.name, u.email FROM applications a JOIN users u ON u.id=a.seeker_user_id WHERE a.job_id=$1 ORDER BY a.created_at DESC LIMIT 5`, [req.job.id]);
    const job = req.job;
    job.hours_text = h.formatHours(job); job.salary_text = h.formatSalary(job);   // owner preview convenience (round 3)
    const canReactivate = job.status === 'inactive' && sub && sub.status === 'active' && sub.current_period_end && new Date(sub.current_period_end) > new Date();
    const canDelete = ['draft', 'pending_payment'].includes(job.status) && payments.length === 0;
    res.render('portal/job', { title: job.title, nav: 'jobs', job, sub, payments, recent, canReactivate, canDelete });
  } catch (e) { next(e); }
});
async function publish(req, res, next, id) {
  try {
    const owner = await db.one('SELECT p.archived FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE j.id=$1', [id]);
    if (owner && owner.archived) { req.flash('error', 'This posting belongs to an archived company. Restore the company before publishing.'); return res.redirect(`${res.locals.base}/jobs/${id}`); }
    await db.query(`UPDATE jobs SET status='pending_payment', updated_at=now() WHERE id=$1 AND status IN ('draft','pending_payment')`, [id]);
    await auth.audit(req.user.id, 'job.publish', 'job', id, null);
    res.redirect(`/billing/checkout/${id}`);
  } catch (e) { next(e); }
}
area.post('/jobs/:id(\\d+)/publish', loadJob, (req, res, next) => {
  if (!['draft', 'pending_payment'].includes(req.job.status)) { req.flash('error', 'Only drafts and unpaid postings can be published.'); return res.redirect(`${res.locals.base}/jobs/${req.job.id}`); }
  if (req.job.description.length < 100) { req.flash('error', 'Complete the posting (description of at least 100 characters) before publishing.'); return res.redirect(`${res.locals.base}/jobs/${req.job.id}/edit`); }
  publish(req, res, next, req.job.id);
});
area.post('/jobs/:id(\\d+)/pause', loadJob, async (req, res, next) => {
  try {
    if (req.job.status !== 'active') { req.flash('error', 'Only active postings can be paused.'); return res.redirect(`${res.locals.base}/jobs/${req.job.id}`); }
    await jobs.archiveJob(req.job.id, 'inactive');
    await auth.audit(req.user.id, 'job.pause', 'job', req.job.id, null);
    req.flash('success', 'Posting paused and hidden from job seekers. Your subscription keeps renewing until you cancel it.');
    res.redirect(`${res.locals.base}/jobs/${req.job.id}`);
  } catch (e) { next(e); }
});
area.post('/jobs/:id(\\d+)/reactivate', loadJob, async (req, res, next) => {
  try {
    const sub = await db.one('SELECT * FROM subscriptions WHERE job_id=$1', [req.job.id]);
    const ok = req.job.status === 'inactive' && sub && sub.status === 'active' && sub.current_period_end && new Date(sub.current_period_end) > new Date();
    if (!ok) { req.flash('error', 'This posting cannot be reactivated — its subscription is no longer active. Publish it again to start a new subscription.'); return res.redirect(`${res.locals.base}/jobs/${req.job.id}`); }
    await jobs.activateJob(req.job.id, sub.current_period_end);
    await auth.audit(req.user.id, 'job.reactivate', 'job', req.job.id, null);
    req.flash('success', 'Posting is live again.');
    res.redirect(`${res.locals.base}/jobs/${req.job.id}`);
  } catch (e) { next(e); }
});
area.post('/jobs/:id(\\d+)/duplicate', loadJob, async (req, res, next) => {
  try {
    const j = req.job;
    const cols = ['employer_profile_id', 'description', 'requirements', 'benefits', 'category', 'noc_code', 'job_type', 'work_arrangement', 'experience_level', 'experience_other', 'education', 'education_other', 'city', 'province', 'postal_code', 'salary_min', 'salary_max', 'salary_period', 'vacancies', 'languages', 'skills', 'audiences', 'apply_email', 'apply_url', 'operating_name', 'hours_amount', 'hours_period'];
    const title = j.title.replace(/\s*\(copy\)$/i, '') + ' (copy)';
    const slug = await jobs.uniqueJobSlug(j.title, j.city);
    const id = await db.tx(async (c) => {
      const r = await c.query(`INSERT INTO jobs(${cols.join(',')}, title, slug, created_by, status) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}, $${cols.length + 1}, $${cols.length + 2}, $${cols.length + 3}, 'draft') RETURNING id`,
        [...cols.map(c => c === 'operating_name' ? j.job_operating_name : j[c]), title, slug, req.user.id]);
      await saveLocations(c, r.rows[0].id, j.locations || []);   // every work location comes along (snapshot rows keep their employer_location_id)
      await jobs.ensurePublicId(r.rows[0].id, c);                // new Posting ID; published_at/locked_at/application_deadline are NOT copied, so the copy is an unlocked draft
      return r.rows[0].id;
    });
    await auth.audit(req.user.id, 'job.duplicate', 'job', id, { from: j.id, locations: (j.locations || []).length });
    req.flash('success', 'Copy created as a draft. Review it, then publish.');
    res.redirect(`${res.locals.base}/jobs/${id}/edit`);
  } catch (e) { next(e); }
});
area.post('/jobs/:id(\\d+)/delete', loadJob, async (req, res, next) => {
  try {
    const paid = await db.one('SELECT 1 FROM payments WHERE job_id=$1', [req.job.id]);
    if (!['draft', 'pending_payment'].includes(req.job.status) || paid) { req.flash('error', 'Only unpaid drafts can be deleted. Cancel the posting instead.'); return res.redirect(`${res.locals.base}/jobs/${req.job.id}`); }
    await db.query('DELETE FROM jobs WHERE id=$1', [req.job.id]);
    await auth.audit(req.user.id, 'job.delete', 'job', req.job.id, { title: req.job.title });
    req.flash('success', 'Draft deleted.');
    res.redirect(`${res.locals.base}/jobs`);
  } catch (e) { next(e); }
});

// ---- applicants
const APPLICANT_SQL = `SELECT a.id, a.status, a.created_at, a.updated_at, a.viewed_at, a.employer_notes, a.resume_name, a.resume_path, a.seeker_user_id, a.cover_letter, a.cover_letter_path, a.cover_letter_name,
    u.name, u.email, u.phone, j.id AS job_id, j.title AS job_title, j.status AS job_status, j.public_id AS job_public_id, p.company_name, coalesce(j.operating_name, p.operating_name) AS operating_name
  FROM applications a JOIN jobs j ON j.id=a.job_id JOIN employer_profiles p ON p.id=j.employer_profile_id JOIN users u ON u.id=a.seeker_user_id`;
area.get('/jobs/:id(\\d+)/applicants', loadJob, async (req, res, next) => {
  try {
    const status = APP_STATUSES.includes(req.query.status) ? req.query.status : '';
    const list = await db.many(`${APPLICANT_SQL} WHERE a.job_id=$1 ${status ? 'AND a.status=$2' : ''} ORDER BY a.created_at DESC`, status ? [req.job.id, status] : [req.job.id]);
    res.render('portal/applicants', { title: `Applicants — ${req.job.title}`, nav: 'applicants', list, job: req.job, jobsList: [], filters: { status, job: req.job.id }, scope: 'job', returnTo: req.originalUrl });
  } catch (e) { next(e); }
});
area.get('/applicants', async (req, res, next) => {
  try {
    const status = APP_STATUSES.includes(req.query.status) ? req.query.status : '';
    const jobId = intOrNull(req.query.job);
    const params = [req.user.id]; const where = ['p.owner_user_id=$1'];
    if (status) { params.push(status); where.push(`a.status=$${params.length}`); }
    if (jobId) { params.push(jobId); where.push(`a.job_id=$${params.length}`); }
    const list = await db.many(`${APPLICANT_SQL} WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT 300`, params);
    const jobsList = await db.many(`SELECT j.id, j.title, j.public_id, p.company_name, coalesce(j.operating_name, p.operating_name) AS operating_name, (SELECT count(*)::int FROM applications a WHERE a.job_id=j.id) AS n FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE p.owner_user_id=$1 ORDER BY j.title`, [req.user.id]);
    res.render('portal/applicants', { title: 'Applicants', nav: 'applicants', list, job: null, jobsList, filters: { status, job: jobId }, scope: 'all', returnTo: req.originalUrl });
  } catch (e) { next(e); }
});
async function loadApplication(req, res, next) {
  try {
    const a = await db.one(`${APPLICANT_SQL} WHERE a.id=$1`, [req.params.id]);
    if (!a || !(await jobs.userCanManageJob(req.user, a.job_id))) return res.status(404).render('error', { title: 'Application not found', code: 404, message: 'That application does not exist or is not yours.', noindex: true });
    req.application = a;
    next();
  } catch (e) { next(e); }
}
area.post('/applications/:id(\\d+)/status', loadApplication, async (req, res, next) => {
  try {
    const a = Object.assign({}, req.application, { company_name: h.displayCompany(req.application) });   // seekers know the operating name
    const status = APP_STATUSES.includes(req.body.status) ? req.body.status : a.status;
    const notes = clean(req.body.employer_notes, 4000) || null;
    const changed = status !== a.status;
    await db.query(`UPDATE applications SET status=$2::application_status, employer_notes=$3, viewed_at = COALESCE(viewed_at, CASE WHEN $2::text <> 'submitted' THEN now() END), updated_at=now() WHERE id=$1`, [a.id, status, notes]);
    await auth.audit(req.user.id, 'application.status', 'application', a.id, { from: a.status, to: status, notes: !!notes });
    if (changed) {
      const msg = {
        viewed: `${a.company_name} has viewed your application for ${a.job_title}.`,
        shortlisted: `Good news — you have been shortlisted for ${a.job_title} at ${a.company_name}. The employer may contact you at ${a.email}.`,
        rejected: `${a.company_name} has decided not to move forward with your application for ${a.job_title}. Keep going — new matching jobs are posted every day.`,
        hired: `Congratulations! ${a.company_name} marked you as hired for ${a.job_title}.`,
        submitted: `Your application for ${a.job_title} at ${a.company_name} was reset to “submitted”.`,
      }[status];
      const title = `Application update: ${a.job_title}`;
      const pid = a.job_public_id ? `Posting ID ${a.job_public_id}` : '';
      await db.query(`INSERT INTO notifications(user_id, type, title, body, link, job_id, emailed_at) VALUES ($1,'application_update',$2,$3,'/jobseeker/applications',$4, now())`, [a.seeker_user_id, title, msg, a.job_id]);
      await mail.send({ to: a.email, subject: title, text: `${msg}${pid ? `\n${pid}` : ''}\n\n${mail.PUBLIC_URL}/jobseeker/applications`,
        html: mail.layout(title, `<p>Hi ${h.escapeHtml(a.name)},</p><p>${h.escapeHtml(msg)}</p><p>Status: <strong>${h.escapeHtml(APP_STATUS_NAME[status])}</strong>${pid ? `<br><span style="color:#5A6B7E">${h.escapeHtml(pid)}</span>` : ''}</p>`, { href: `${mail.PUBLIC_URL}/jobseeker/applications`, label: 'View my applications' }) });
    }
    req.flash('success', changed ? `${a.name} marked as ${APP_STATUS_NAME[status].toLowerCase()} — they have been notified.` : 'Notes saved.');
    // Referrer-Policy strips the Referer header, so the form carries its own return path (same portal only).
    const rt = typeof req.body.return_to === 'string' && /^\/(employer|consultant)\/[^\s]*$/.test(req.body.return_to) ? req.body.return_to : null;
    res.redirect(rt || back(req, `${res.locals.base}/jobs/${a.job_id}/applicants`));
  } catch (e) { next(e); }
});
area.get('/applications/:id(\\d+)/resume', loadApplication, async (req, res, next) => {
  try {
    const a = req.application;
    const abs = path.join(UPLOAD_DIR, a.resume_path);
    if (!abs.startsWith(UPLOAD_DIR + path.sep)) return res.status(404).end();
    if (!a.viewed_at) await db.query(`UPDATE applications SET viewed_at=now(), status = CASE WHEN status='submitted' THEN 'viewed'::application_status ELSE status END, updated_at=now() WHERE id=$1`, [a.id]);
    await auth.audit(req.user.id, 'application.resume_download', 'application', a.id, null);
    res.download(abs, a.resume_name || path.basename(a.resume_path), (err) => { if (err && !res.headersSent) next(err); });
  } catch (e) { next(e); }
});
/** Cover sheet uploaded with the application (optional; stored under UPLOAD_DIR/covers/ by the apply flow). Owner only; 404 when none. */
area.get('/applications/:id(\\d+)/cover', loadApplication, async (req, res, next) => {
  try {
    const a = req.application;
    if (!a.cover_letter_path) return res.status(404).render('error', { title: 'No cover sheet', code: 404, message: 'This applicant did not attach a cover sheet.', noindex: true });
    const abs = path.join(UPLOAD_DIR, a.cover_letter_path);
    if (!abs.startsWith(UPLOAD_DIR + path.sep)) return res.status(404).end();
    if (!a.viewed_at) await db.query(`UPDATE applications SET viewed_at=now(), status = CASE WHEN status='submitted' THEN 'viewed'::application_status ELSE status END, updated_at=now() WHERE id=$1`, [a.id]);
    await auth.audit(req.user.id, 'application.cover_download', 'application', a.id, null);
    res.download(abs, a.cover_letter_name || path.basename(a.cover_letter_path), (err) => { if (err && !res.headersSent) { if (err.code === 'ENOENT') return res.status(404).render('error', { title: 'Cover sheet missing', code: 404, message: 'The cover sheet file is no longer available.', noindex: true }); next(err); } });
  } catch (e) { next(e); }
});

router.use('/employer', guard('/employer'), area);
router.use('/consultant', guard('/consultant'), area);

module.exports = router;
