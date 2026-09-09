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

const router = express.Router();
const ROOT = path.join(__dirname, '..');
const UPLOAD_DIR = path.isAbsolute(process.env.UPLOAD_DIR || '') ? process.env.UPLOAD_DIR : path.join(ROOT, process.env.UPLOAD_DIR || 'data/uploads');
const LOGO_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/svg+xml': '.svg', 'image/webp': '.webp' };
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const APP_STATUSES = ['submitted', 'viewed', 'shortlisted', 'rejected', 'hired'];
const APP_STATUS_NAME = { submitted: 'Submitted', viewed: 'Viewed', shortlisted: 'Shortlisted', rejected: 'Not selected', hired: 'Hired' };
const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
const PRICE = C.PRICING.price_cents, GST = Math.round(C.PRICING.price_cents * C.PRICING.gst_rate), TOTAL = PRICE + GST;
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
const landingFaq = {
  employer: [
    ['How much does it cost to post a job?', 'Each posting is $9.99 per month plus 5% GST — $10.49 CAD in total. It renews automatically every month until you cancel. There are no setup fees and no contracts.'],
    ['Can I cancel at any time?', 'Yes. Cancel from your dashboard with one click. Your posting stays live until the end of the paid month and is then archived. You can also cancel immediately.'],
    ['How long does approval take?', 'There is no approval queue. Your posting goes live the moment your payment is confirmed — usually within a few seconds.'],
    ['Who will see my posting?', 'Everyone who searches Canada Careers, plus every job seeker whose saved profile matches your posting gets an instant email alert. Postings are indexed by Google for Jobs.'],
    ['How do I receive applications?', 'Applicants apply on Canada Careers with their resume and cover letter. You review, shortlist and download resumes from your dashboard; applicants are notified of every status change. You can also add an external apply link or email.'],
    ['Do I get a receipt?', 'Every charge produces a GST receipt with your company name and a unique receipt number, available any time under Billing.'],
  ],
  consultant: [
    ['Who is the consultant account for?', 'Recruitment agencies, staffing firms, HR consultants and immigration consultants who post jobs on behalf of more than one employer.'],
    ['How many employer profiles can I add?', 'Unlimited. Each client gets its own company profile with logo, description and contact details, and each posting is published under the client company name.'],
    ['How is billing handled?', 'Every posting is $9.99 + GST per month, billed to your account. Billing shows one list of subscriptions and receipts across all your clients, so you can pass costs through cleanly.'],
    ['Can my clients see the applicants?', 'Applicants land in your dashboard. You can download resumes and update statuses; forward what you need to your client. Client logins for shared access are on our roadmap.'],
    ['Can I switch between companies quickly?', 'Yes — a company selector appears on every job list, and the posting form asks which client you are posting for.'],
    ['Is there a volume discount?', 'Not yet. Pricing is a flat $9.99 + GST per posting per month for everyone, with no contracts.'],
  ],
};
const faqJsonLd = (items) => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });

router.get('/employer', (req, res) => {
  if (req.user && ['employer', 'consultant'].includes(req.user.role)) return res.redirect(baseFor(req.user) + '/dashboard');
  res.render('portal/landing-employer', {
    title: 'Post a Job in Canada for $9.99/month — Employers',
    metaDescription: 'Post a job on Canada Careers for $9.99 + GST per month. Reach professionals, new immigrants, Indigenous peoples, refugees and youth across Canada. No contracts, cancel any time.',
    extraCss: ['/css/portal.css'], extraJs: ['/js/portal.js'], bodyClass: 'portal-landing',
    faq: landingFaq.employer, jsonLd: [faqJsonLd(landingFaq.employer)], PRICE, GST, TOTAL,
  });
});
router.get('/consultant', (req, res) => {
  if (req.user && ['employer', 'consultant'].includes(req.user.role)) return res.redirect(baseFor(req.user) + '/dashboard');
  res.render('portal/landing-consultant', {
    title: 'Third Party Consultants & Recruiters — Post Jobs for All Your Clients',
    metaDescription: 'One login, unlimited employer profiles. Recruiters, staffing agencies and immigration consultants post jobs on behalf of any client for $9.99 + GST per posting per month.',
    extraCss: ['/css/portal.css'], extraJs: ['/js/portal.js'], bodyClass: 'portal-landing',
    faq: landingFaq.consultant, jsonLd: [faqJsonLd(landingFaq.consultant)], PRICE, GST, TOTAL,
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
    res.locals.extraCss = ['/css/portal.css'];
    res.locals.extraJs = ['/js/portal.js'];
    res.locals.bodyClass = 'portal';
    res.locals.APP_STATUSES = APP_STATUSES;
    res.locals.APP_STATUS_NAME = APP_STATUS_NAME;
    res.locals.PRICE = PRICE; res.locals.GST = GST; res.locals.TOTAL = TOTAL;
    try { req.profiles = res.locals.profiles = await profilesFor(req.user); } catch (e) { return next(e); }
    next();
  }];
}

/** Load a job the user may manage (404 otherwise). */
async function loadJob(req, res, next) {
  try {
    if (!(await jobs.userCanManageJob(req.user, req.params.id))) return res.status(404).render('error', { title: 'Job not found', code: 404, message: 'That posting does not exist or is not yours.', noindex: true });
    req.job = await db.one(`SELECT j.*, p.company_name, p.slug AS company_slug, p.logo_path,
        (SELECT count(*)::int FROM applications a WHERE a.job_id=j.id) AS applicants
      FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE j.id=$1`, [req.params.id]);
    if (!req.job) return res.status(404).render('error', { title: 'Job not found', code: 404, message: 'That posting does not exist.', noindex: true });
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
    const recent = await db.many(`SELECT a.id, a.status, a.created_at, u.name, u.email, j.id AS job_id, j.title
      FROM applications a JOIN jobs j ON j.id=a.job_id JOIN employer_profiles p ON p.id=j.employer_profile_id JOIN users u ON u.id=a.seeker_user_id
      WHERE p.owner_user_id=$1 ORDER BY a.created_at DESC LIMIT 6`, [uid]);
    const active = await db.many(`SELECT j.id, j.title, j.status, j.city, j.province, j.expires_at, j.published_at, j.views, p.company_name,
        (SELECT count(*)::int FROM applications a WHERE a.job_id=j.id) AS applicants,
        s.cancel_at_period_end, s.current_period_end
      FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id LEFT JOIN subscriptions s ON s.job_id=j.id
      WHERE p.owner_user_id=$1 AND j.status IN ('active','pending_payment','draft') ORDER BY (j.status='active') DESC, j.updated_at DESC LIMIT 8`, [uid]);
    let byCompany = [];
    if (req.user.role === 'consultant') {
      byCompany = await db.many(`SELECT p.id, p.company_name, p.logo_path,
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
    if (!profile) return res.render('portal/profile-form', { title: 'Company profile', nav: 'company', profile: {}, values: {}, errors: {}, mode: 'employer-create', COMPANY_SIZES });
    res.render('portal/profile-form', { title: 'Company profile', nav: 'company', profile, values: profile, errors: {}, mode: 'employer', COMPANY_SIZES });
  } catch (e) { next(e); }
});
area.post('/profile', logoMiddleware, async (req, res, next) => {
  if (req.user.role === 'consultant') return res.redirect('/consultant/profiles');
  try {
    const profile = req.profiles[0];
    const { values, errors } = validateProfile(req);
    if (Object.keys(errors).length) return res.status(422).render('portal/profile-form', { title: 'Company profile', nav: 'company', profile: profile || {}, values, errors, mode: profile ? 'employer' : 'employer-create', COMPANY_SIZES });
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
area.get('/profiles/new', consultantOnly, (req, res) => res.render('portal/profile-form', { title: 'Add a company', nav: 'company', profile: {}, values: {}, errors: {}, mode: 'consultant-new', COMPANY_SIZES, then: req.query.then }));
area.post('/profiles/new', consultantOnly, logoMiddleware, async (req, res, next) => {
  try {
    const { values, errors } = validateProfile(req);
    if (Object.keys(errors).length) return res.status(422).render('portal/profile-form', { title: 'Add a company', nav: 'company', profile: {}, values, errors, mode: 'consultant-new', COMPANY_SIZES, then: req.query.then });
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
area.get('/profiles/:id(\\d+)/edit', consultantOnly, loadOwnProfile, (req, res) => res.render('portal/profile-form', { title: 'Edit ' + req.profile.company_name, nav: 'company', profile: req.profile, values: req.profile, errors: {}, mode: 'consultant-edit', COMPANY_SIZES }));
area.post('/profiles/:id(\\d+)/edit', consultantOnly, loadOwnProfile, logoMiddleware, async (req, res, next) => {
  try {
    const { values, errors } = validateProfile(req);
    if (Object.keys(errors).length) return res.status(422).render('portal/profile-form', { title: 'Edit ' + req.profile.company_name, nav: 'company', profile: req.profile, values, errors, mode: 'consultant-edit', COMPANY_SIZES });
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

function validateProfile(req) {
  const b = req.body || {};
  const values = {
    company_name: clean(b.company_name, 120), website: clean(b.website, 200), industry: clean(b.industry, 120),
    company_size: clean(b.company_size, 20), city: clean(b.city, 80), province: clean(b.province, 2).toUpperCase(),
    description: clean(b.description, 4000), contact_name: clean(b.contact_name, 120), contact_email: clean(b.contact_email, 160).toLowerCase(), contact_phone: clean(b.contact_phone, 40),
  };
  const errors = {};
  if (values.company_name.length < 2) errors.company_name = 'Enter the company name.';
  if (values.website && !/^https?:\/\//i.test(values.website)) values.website = 'https://' + values.website;
  if (values.website && !URL_RE.test(values.website)) errors.website = 'Enter a valid website address (https://…).';
  if (values.company_size && !COMPANY_SIZES.includes(values.company_size)) errors.company_size = 'Choose a company size.';
  if (values.province && !C.PROVINCE_NAME[values.province]) errors.province = 'Choose a province or territory.';
  if (values.contact_email && !EMAIL_RE.test(values.contact_email)) errors.contact_email = 'Enter a valid email address.';
  if (req.logoError) errors.logo = req.logoError;
  return { values, errors };
}
async function upsertProfile(req, existing, v) {
  let id;
  if (existing) {
    await db.query(`UPDATE employer_profiles SET company_name=$2, website=$3, industry=$4, company_size=$5, city=$6, province=$7, description=$8, contact_name=$9, contact_email=$10, contact_phone=$11, updated_at=now() WHERE id=$1`,
      [existing.id, v.company_name, v.website || null, v.industry || null, v.company_size || null, v.city || null, v.province || null, v.description || null, v.contact_name || null, v.contact_email || null, v.contact_phone || null]);
    id = existing.id;
  } else {
    const slug = await jobs.uniqueProfileSlug(v.company_name);
    id = (await db.one(`INSERT INTO employer_profiles(owner_user_id, company_name, slug, website, industry, company_size, city, province, description, contact_name, contact_email, contact_phone)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [req.user.id, v.company_name, slug, v.website || null, v.industry || null, v.company_size || null, v.city || null, v.province || null, v.description || null, v.contact_name || null, v.contact_email || null, v.contact_phone || null])).id;
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
    const list = await db.many(`SELECT j.id, j.title, j.status, j.city, j.province, j.published_at, j.expires_at, j.archived_at, j.cancelled_at, j.created_at, j.updated_at, j.views, j.employer_profile_id, p.company_name,
        (SELECT count(*)::int FROM applications a WHERE a.job_id=j.id) AS applicants,
        s.status AS sub_status, s.cancel_at_period_end, s.current_period_end
      FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id LEFT JOIN subscriptions s ON s.job_id=j.id
      WHERE ${where.join(' AND ')} ORDER BY j.updated_at DESC`, params);
    const counts = await db.one(`SELECT count(*)::int AS all, count(*) FILTER (WHERE j.status='active')::int AS active, count(*) FILTER (WHERE j.status='pending_payment')::int AS pending_payment,
        count(*) FILTER (WHERE j.status='draft')::int AS draft, count(*) FILTER (WHERE j.status IN ('expired','cancelled','inactive'))::int AS archived
      FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE p.owner_user_id=$1 ${profileId ? 'AND j.employer_profile_id=$2' : ''}`, profileId ? [req.user.id, profileId] : [req.user.id]);
    res.render('portal/jobs', { title: 'My jobs', nav: 'jobs', list, status, profileId, counts, TABS: PROFILE_TABS });
  } catch (e) { next(e); }
});

// ---- job form (new + edit)
function blankJob(req) {
  return { title: '', category: '', job_type: 'full_time', work_arrangement: 'on_site', experience_level: '', education: '', city: '', province: '', postal_code: '',
    salary_min: '', salary_max: '', salary_period: 'year', vacancies: 1, languages: ['English'], language_other: '', skills: '', audiences: [],
    description: '', requirements: '', benefits: '', apply_email: req.user.email, apply_url: '', noc_code: '', employer_profile_id: intOrNull(req.query.profile) || (req.profiles.length === 1 ? req.profiles[0].id : '') };
}
function jobToValues(j) {
  const langs = j.languages || [];
  const other = langs.filter(l => !['English', 'French'].includes(l));
  return Object.assign({}, j, { languages: langs.filter(l => ['English', 'French'].includes(l)).concat(other.length ? ['Other'] : []), language_other: other.join(', '), skills: (j.skills || []).join(', '), salary_min: j.salary_min ?? '', salary_max: j.salary_max ?? '' });
}
function validateJob(req) {
  const b = req.body || {};
  const langs = arr(b.languages).filter(l => ['English', 'French', 'Other'].includes(l));
  const values = {
    title: clean(b.title, 120), category: clean(b.category, 60), job_type: clean(b.job_type, 30), work_arrangement: clean(b.work_arrangement, 20),
    experience_level: clean(b.experience_level, 30), education: clean(b.education, 160), city: clean(b.city, 80), province: clean(b.province, 2).toUpperCase(),
    postal_code: clean(b.postal_code, 10).toUpperCase(), salary_min: clean(b.salary_min, 12), salary_max: clean(b.salary_max, 12), salary_period: b.salary_period === 'hour' ? 'hour' : 'year',
    vacancies: clean(b.vacancies, 5), languages: langs, language_other: clean(b.language_other, 120), skills: clean(b.skills, 600),
    audiences: arr(b.audiences).filter(a => C.AUDIENCE_NAME[a]), description: clean(b.description, 12000), requirements: clean(b.requirements, 6000), benefits: clean(b.benefits, 6000),
    apply_email: clean(b.apply_email, 160).toLowerCase(), apply_url: clean(b.apply_url, 300), noc_code: clean(b.noc_code, 10),
    // Employers own exactly one profile: the posted id is never trusted. Consultants choose among THEIR profiles (checked below).
    employer_profile_id: req.user.role === 'consultant' ? intOrNull(b.employer_profile_id) : (req.profiles[0] ? req.profiles[0].id : null),
  };
  // Once billing exists the company is locked to the job's profile, whatever the form says.
  if (req.job && ['active', 'pending_payment', 'inactive', 'expired', 'cancelled'].includes(req.job.status)) values.employer_profile_id = Number(req.job.employer_profile_id);
  const errors = {};
  if (values.title.length < 3) errors.title = 'Enter a job title (at least 3 characters).';
  if (!C.CATEGORY_NAME[values.category]) errors.category = 'Choose a category.';
  if (!C.JOB_TYPE_NAME[values.job_type]) errors.job_type = 'Choose a job type.';
  if (!C.WORK_ARRANGEMENT_NAME[values.work_arrangement]) errors.work_arrangement = 'Choose a work arrangement.';
  if (values.experience_level && !C.EXPERIENCE_LEVEL_NAME[values.experience_level]) errors.experience_level = 'Choose an experience level.';
  if (values.city.length < 2) errors.city = 'Enter the city.';
  if (!C.PROVINCE_NAME[values.province]) errors.province = 'Choose a province or territory.';
  if (values.postal_code && !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(values.postal_code)) errors.postal_code = 'Enter a valid Canadian postal code (e.g. M5V 3L9).';
  const smin = values.salary_min === '' ? null : intOrNull(values.salary_min), smax = values.salary_max === '' ? null : intOrNull(values.salary_max);
  if (values.salary_min !== '' && (smin == null || smin < 0)) errors.salary_min = 'Enter a whole number.';
  if (values.salary_max !== '' && (smax == null || smax < 0)) errors.salary_max = 'Enter a whole number.';
  if (smin != null && smax != null && smax < smin) errors.salary_max = 'Maximum must be at least the minimum.';
  const vac = intOrNull(values.vacancies); if (vac == null || vac < 1 || vac > 999) errors.vacancies = 'Enter the number of positions (1–999).';
  if (!langs.length) errors.languages = 'Select at least one language.';
  if (langs.includes('Other') && !values.language_other) errors.language_other = 'Name the other language(s).';
  if (values.description.length < 100) errors.description = `Describe the role in at least 100 characters (${values.description.length} so far).`;
  if (values.apply_email && !EMAIL_RE.test(values.apply_email)) errors.apply_email = 'Enter a valid email address.';
  if (values.apply_url && !/^https?:\/\//i.test(values.apply_url)) values.apply_url = 'https://' + values.apply_url;
  if (values.apply_url && !URL_RE.test(values.apply_url)) errors.apply_url = 'Enter a valid link (https://…).';
  if (values.noc_code && !/^\d{4,5}$/.test(values.noc_code)) errors.noc_code = 'NOC codes are 5 digits (2021 NOC).';
  if (!values.employer_profile_id || !req.profiles.some(p => p.id === values.employer_profile_id)) errors.employer_profile_id = req.user.role === 'consultant' ? 'Choose which company this posting is for.' : 'Create your company profile first.';
  const row = {
    title: values.title, category: values.category, job_type: values.job_type, work_arrangement: values.work_arrangement, experience_level: values.experience_level || null,
    education: values.education || null, city: values.city, province: values.province, postal_code: values.postal_code || null, salary_min: smin, salary_max: smax, salary_period: values.salary_period,
    vacancies: vac || 1, languages: langs.filter(l => l !== 'Other').concat(langs.includes('Other') ? values.language_other.split(/[,;]/).map(s => s.trim()).filter(Boolean) : []),
    skills: values.skills.split(/[,;\n]/).map(s => s.trim()).filter(Boolean).slice(0, 30), audiences: values.audiences, description: values.description, requirements: values.requirements || null,
    benefits: values.benefits || null, apply_email: values.apply_email || null, apply_url: values.apply_url || null, noc_code: values.noc_code || null, employer_profile_id: values.employer_profile_id,
  };
  return { values, errors, row };
}
const jobFormLocals = (req, extra) => Object.assign({ nav: 'post', errors: {}, COMPANY_SIZES }, extra);

area.get('/jobs/new', (req, res) => {
  if (!req.profiles.length) {
    req.flash('info', req.user.role === 'consultant' ? 'Add a company first — every posting is published under a company profile.' : 'Set up your company profile first.');
    return res.redirect(req.user.role === 'consultant' ? '/consultant/profiles/new?then=post' : '/employer/profile');
  }
  res.render('portal/job-form', jobFormLocals(req, { title: 'Post a job', values: blankJob(req), job: null }));
});
area.post('/jobs/new', async (req, res, next) => {
  try {
    if (!req.profiles.length) return res.redirect(res.locals.base + '/jobs/new');
    const { values, errors, row } = validateJob(req);
    if (Object.keys(errors).length) return res.status(422).render('portal/job-form', jobFormLocals(req, { title: 'Post a job', values, errors, job: null }));
    // Double submit guard (double-click / retry): an identical draft created by this user in the last 20 s is reused instead of duplicated.
    // A per-user advisory lock serialises two simultaneous POSTs so the second one sees the first one's row.
    const slug = await jobs.uniqueJobSlug(row.title, row.city);
    const cols = Object.keys(row);
    const { id, dup } = await db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1, $2)', [7001, Number(req.user.id)]);
      const d = (await c.query(`SELECT id, status FROM jobs WHERE created_by=$1 AND employer_profile_id=$2 AND title=$3 AND description=$4 AND created_at > now() - interval '20 seconds' ORDER BY id LIMIT 1`, [req.user.id, row.employer_profile_id, row.title, row.description])).rows[0];
      if (d) return { id: d.id, dup: d };
      const r = await c.query(`INSERT INTO jobs(${cols.join(',')}, created_by, slug, status) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}, $${cols.length + 1}, $${cols.length + 2}, 'draft') RETURNING id`, [...cols.map(c => row[c]), req.user.id, slug]);
      return { id: r.rows[0].id, dup: null };
    });
    if (dup) {
      if (req.body.action === 'publish' && ['draft', 'pending_payment'].includes(dup.status)) return publish(req, res, next, dup.id);
      return res.redirect(`${res.locals.base}/jobs/${dup.id}`);
    }
    await auth.audit(req.user.id, 'job.create', 'job', id, { title: row.title, employer_profile_id: row.employer_profile_id });
    if (req.body.action === 'publish') return publish(req, res, next, id);
    req.flash('success', 'Draft saved. Publish it whenever you are ready.');
    res.redirect(`${res.locals.base}/jobs/${id}`);
  } catch (e) { next(e); }
});
area.get('/jobs/:id(\\d+)/edit', loadJob, (req, res) => res.render('portal/job-form', jobFormLocals(req, { title: 'Edit posting', nav: 'jobs', values: jobToValues(req.job), job: req.job })));
area.post('/jobs/:id(\\d+)/edit', loadJob, async (req, res, next) => {
  try {
    const { values, errors, row } = validateJob(req);
    if (Object.keys(errors).length) return res.status(422).render('portal/job-form', jobFormLocals(req, { title: 'Edit posting', nav: 'jobs', values, errors, job: req.job }));
    if (['active', 'pending_payment'].includes(req.job.status)) row.employer_profile_id = req.job.employer_profile_id; // company is locked once billing exists
    const cols = Object.keys(row);
    await db.query(`UPDATE jobs SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [req.job.id, ...cols.map(c => row[c])]);
    await auth.audit(req.user.id, 'job.update', 'job', req.job.id, { title: row.title, status: req.job.status });
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
    const cols = ['employer_profile_id', 'description', 'requirements', 'benefits', 'category', 'noc_code', 'job_type', 'work_arrangement', 'experience_level', 'education', 'city', 'province', 'postal_code', 'salary_min', 'salary_max', 'salary_period', 'vacancies', 'languages', 'skills', 'audiences', 'apply_email', 'apply_url'];
    const title = j.title.replace(/\s*\(copy\)$/i, '') + ' (copy)';
    const slug = await jobs.uniqueJobSlug(j.title, j.city);
    const id = (await db.one(`INSERT INTO jobs(${cols.join(',')}, title, slug, created_by, status) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}, $${cols.length + 1}, $${cols.length + 2}, $${cols.length + 3}, 'draft') RETURNING id`,
      [...cols.map(c => j[c]), title, slug, req.user.id])).id;
    await auth.audit(req.user.id, 'job.duplicate', 'job', id, { from: j.id });
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
const APPLICANT_SQL = `SELECT a.id, a.status, a.created_at, a.updated_at, a.viewed_at, a.employer_notes, a.resume_name, a.resume_path, a.seeker_user_id, a.cover_letter,
    u.name, u.email, u.phone, j.id AS job_id, j.title AS job_title, j.status AS job_status, p.company_name
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
    const jobsList = await db.many(`SELECT j.id, j.title, p.company_name, (SELECT count(*)::int FROM applications a WHERE a.job_id=j.id) AS n FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE p.owner_user_id=$1 ORDER BY j.title`, [req.user.id]);
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
    const a = req.application;
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
      await db.query(`INSERT INTO notifications(user_id, type, title, body, link, job_id, emailed_at) VALUES ($1,'application_update',$2,$3,'/jobseeker/applications',$4, now())`, [a.seeker_user_id, title, msg, a.job_id]);
      await mail.send({ to: a.email, subject: title, text: `${msg}\n\n${mail.PUBLIC_URL}/jobseeker/applications`,
        html: mail.layout(title, `<p>Hi ${h.escapeHtml(a.name)},</p><p>${h.escapeHtml(msg)}</p><p>Status: <strong>${h.escapeHtml(APP_STATUS_NAME[status])}</strong></p>`, { href: `${mail.PUBLIC_URL}/jobseeker/applications`, label: 'View my applications' }) });
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

router.use('/employer', guard('/employer'), area);
router.use('/consultant', guard('/consultant'), area);

module.exports = router;
