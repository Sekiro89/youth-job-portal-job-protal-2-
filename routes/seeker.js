'use strict';
// Job seeker area: /jobseeker/* plus /jobs/:slug/apply|save|unsave. Mounted at '/' BEFORE the public router.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../lib/db');
const auth = require('../lib/auth');
const mail = require('../lib/mail');
const settings = require('../lib/settings');
const C = require('../lib/constants');
const h = require('../lib/helpers');
const { PUBLIC_WHERE } = require('../lib/jobs');
const matching = require('../lib/matching');
const jd = require('../lib/job-dates');   // application_deadline / applications_closed (round 3)

const router = express.Router();
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const RESUME_DIR = path.join(UPLOAD_DIR, 'resumes');
const COVER_DIR = path.join(UPLOAD_DIR, 'covers');
const EXT_OK = new Set(Object.values(C.RESUME_MIME));
const COVER_MAX = 3000;

// ------------------------------------------------------------------ helpers
const seekerOnly = auth.requireAuth('seeker');
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(String);
const pickKeys = (vals, list) => { const ok = new Set(list.map(x => x[0])); return [...new Set(toArray(vals).filter(v => ok.has(v)))]; };
const csvToArray = (s, max = 20, len = 40) => [...new Set(String(s || '').split(/[,\n]/).map(x => x.trim().slice(0, len)).filter(Boolean))].slice(0, max);
const clean = (s, max) => String(s || '').trim().slice(0, max);
const isSafeReturn = (u) => typeof u === 'string' && u.startsWith('/') && !u.startsWith('//');
const isId = (v) => /^\d{1,18}$/.test(String(v || ''));

function resumeExt(file) {
  const byMime = C.RESUME_MIME[file.mimetype];
  const byName = path.extname(file.originalname || '').toLowerCase();
  if (byMime && (byName === byMime || !EXT_OK.has(byName))) return byMime;
  if (EXT_OK.has(byName) && (byMime || file.mimetype === 'application/octet-stream')) return byName;
  return null;
}
/** multer in memory so validation errors never leave orphan files on disk. Two optional fields: `resume` and `cover_file`
 *  (the apply form). Errors land on req.uploadError (resume) / req.coverError (cover sheet) keyed by field name. */
const FILE_LABEL = { resume: 'resume', cover_file: 'cover sheet' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: C.RESUME_MAX_BYTES, files: 2 },
  fileFilter: (req, file, cb) => {
    if (resumeExt(file)) return cb(null, true);
    setUploadError(req, file.fieldname, `That file type is not accepted. Please upload a PDF, DOC or DOCX ${FILE_LABEL[file.fieldname] || 'file'}.`);
    cb(null, false);
  },
}).fields([{ name: 'resume', maxCount: 1 }, { name: 'cover_file', maxCount: 1 }]);
function setUploadError(req, field, msg) { if (field === 'cover_file') req.coverError = msg; else req.uploadError = msg; }
function resumeUpload(req, res, next) {
  upload(req, res, (err) => {
    const field = (err && err.field) || 'resume';
    if (err && err.code === 'LIMIT_FILE_SIZE') setUploadError(req, field, `${field === 'cover_file' ? 'Cover sheet' : 'Resume'} must be ${Math.round(C.RESUME_MAX_BYTES / 1024 / 1024)} MB or smaller.`);
    else if (err) setUploadError(req, field, 'We could not read that file. Please upload a PDF, DOC or DOCX.');
    // normalise multer's fields() shape to the single-file shape the rest of this router uses
    req.file = (req.files && req.files.resume && req.files.resume[0]) || null;
    req.coverFile = (req.files && req.files.cover_file && req.files.cover_file[0]) || null;
    checkResumeFile(req);
    checkCoverFile(req);
    next();
  });
}
/** Content sniffing: the extension/MIME a browser sends is derived from the file NAME, so an .exe renamed to .pdf
 *  arrives as application/pdf. Check the magic bytes match the claimed type before anything touches disk. */
function resumeMagicOk(file) {
  const ext = resumeExt(file); const b = file.buffer || Buffer.alloc(0);
  if (ext === '.pdf') return b.subarray(0, 1024).includes('%PDF');           // header may be preceded by a BOM/junk
  if (ext === '.doc') return b.subarray(0, 8).equals(Buffer.from('D0CF11E0A1B11AE1', 'hex'));   // OLE compound file
  if (ext === '.docx') return b.subarray(0, 4).equals(Buffer.from('504B0304', 'hex'));           // zip container
  return false;
}
function checkResumeFile(req) {
  if (req.uploadError || !req.file) return;
  if (!req.file.buffer || !req.file.buffer.length) { req.uploadError = 'That file is empty. Please upload your resume as a PDF, DOC or DOCX.'; req.file = null; return; }
  if (!resumeMagicOk(req.file)) { req.uploadError = 'That file does not look like a real PDF, DOC or DOCX. Please export your resume again and upload it.'; req.file = null; }
}
function checkCoverFile(req) {
  if (req.coverError || !req.coverFile) return;
  if (!req.coverFile.buffer || !req.coverFile.buffer.length) { req.coverError = 'That cover sheet is empty. Please upload it as a PDF, DOC or DOCX.'; req.coverFile = null; return; }
  if (!resumeMagicOk(req.coverFile)) { req.coverError = 'That cover sheet does not look like a real PDF, DOC or DOCX. Please export it again and upload it.'; req.coverFile = null; }
}
/** Write an in-memory upload to <kind>/<userId>-<rand>.<ext> (kind = resumes | covers); returns { path (relative), name }. */
function storeUpload(userId, file, kind) {
  const ext = resumeExt(file);
  fs.mkdirSync(kind === 'covers' ? COVER_DIR : RESUME_DIR, { recursive: true });
  const rel = path.posix.join(kind, `${userId}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  fs.writeFileSync(path.join(UPLOAD_DIR, rel), file.buffer);
  let orig = file.originalname || '';
  try { orig = Buffer.from(orig, 'latin1').toString('utf8'); } catch (_) {}
  return { path: rel, name: clean(orig, 120) || `${kind === 'covers' ? 'cover-sheet' : 'resume'}${ext}` };
}
const storeResume = (userId, file) => storeUpload(userId, file, 'resumes');
const storeCover = (userId, file) => storeUpload(userId, file, 'covers');
/** Delete an old resume file — unless an application still references it (employers must keep their copy). */
async function removeFile(rel) {
  if (!rel || rel.startsWith('seed/')) return;
  const abs = path.join(UPLOAD_DIR, rel);
  if (!abs.startsWith(path.join(UPLOAD_DIR, 'resumes'))) return;
  if (await db.one('SELECT 1 FROM applications WHERE resume_path=$1', [rel])) return;
  await fs.promises.unlink(abs).catch(() => {});
}
/** Resolve a stored upload (resumes/… or covers/…) to an absolute path inside UPLOAD_DIR, or null. */
function uploadAbs(rel, kind) {
  if (!rel) return null;
  const abs = path.join(UPLOAD_DIR, rel);
  const root = kind ? path.join(UPLOAD_DIR, kind) + path.sep : UPLOAD_DIR + path.sep;
  return abs.startsWith(root) && fs.existsSync(abs) ? abs : null;
}
/** Locations of a job, primary first. Imported reference postings may have only city/province. */
const jobLocations = (jobId) => db.many('SELECT * FROM job_locations WHERE job_id=$1 ORDER BY sort_order, id', [jobId]);
const LOCATION_COUNT = `(SELECT count(*)::int FROM job_locations l WHERE l.job_id = jobs.id) AS location_count`;
/** Company columns for anything shown to a seeker: the operating name chosen for THIS posting wins over the profile default
 *  (h.displayCompany then falls back to company_name). Listed AFTER jobs.* so ep.operating_name never overwrites jobs.operating_name. */
const JOB_COMPANY = `ep.company_name, COALESCE(NULLIF(jobs.operating_name, ''), ep.operating_name) AS operating_name, jobs.hours_amount, jobs.hours_period`;
const publicUrl = async () => (await settings.get('public_url')).replace(/\/$/, '');

async function getProfile(userId) {
  return (await db.one('SELECT * FROM seeker_profiles WHERE user_id=$1', [userId])) || {
    user_id: userId, headline: '', summary: '', city: '', province: '', categories: [], job_types: [], work_arrangements: [],
    provinces: [], keywords: [], skills: [], audiences: [], resume_path: null, resume_name: null, resume_uploaded_at: null,
    notify_email: true, notify_frequency: 'instant',
  };
}
function completeness(p) {
  const items = [
    ['headline', 'Add a headline', !!(p.headline && p.headline.trim())],
    ['summary', 'Write a short summary', !!(p.summary && p.summary.trim())],
    ['resume', 'Upload your resume', !!p.resume_path],
    ['categories', 'Pick job categories', (p.categories || []).length > 0],
    ['provinces', 'Choose where you will work', (p.provinces || []).length > 0],
    ['keywords', 'Add keywords for alerts', (p.keywords || []).length > 0],
  ];
  const done = items.filter(i => i[2]).length;
  return { items, done, total: items.length, percent: Math.round((done / items.length) * 100) };
}
async function publicJob(slug) {
  return jd.decorateJob(await db.one(`SELECT jobs.*, ${JOB_COMPANY}, ep.slug AS company_slug, ep.contact_email, ep.owner_user_id, ${LOCATION_COUNT}
                 FROM jobs JOIN employer_profiles ep ON ep.id = jobs.employer_profile_id WHERE jobs.slug=$1 AND ${PUBLIC_WHERE}`, [slug]));
}
const CLOSED_MSG = 'Applications for this posting have closed';
/** Show a flash on THIS response (req.flash only surfaces on the next request). */
const flashNow = (res, type, message) => { res.locals.flash = (res.locals.flash || []).concat([{ type, message }]); };
const backTo = (req, fallback) => {
  const ref = req.get('referer');
  try { if (ref && new URL(ref).host === req.get('host')) return new URL(ref).pathname + new URL(ref).search; } catch (_) {}
  return fallback;
};

/** Locals for every seeker page: side-nav unread badge. */
async function seekerLocals(req, res, next) {
  res.locals.noindex = true;
  res.locals.extraCss = ['/css/seeker.css'];
  res.locals.extraJs = ['/js/seeker.js'];
  res.locals.unreadCount = 0;
  if (req.user && req.user.role === 'seeker') {
    try { res.locals.unreadCount = Number((await db.one('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user.id])).n); }
    catch (e) { return next(e); }
  }
  next();
}
router.use('/jobseeker', seekerLocals);

// ------------------------------------------------------------------ dev-only login (auth routes belong to another agent)
if (process.env.NODE_ENV !== 'production') {
  router.get('/seeker-dev-login/:email', async (req, res, next) => {
    try {
      const u = await db.one('SELECT id, role FROM users WHERE email=$1 AND is_active', [req.params.email]);
      if (!u) return res.status(404).send('no such user');
      req.session.userId = u.id;
      const next_ = isSafeReturn(req.query.next) ? req.query.next : auth.homeFor(u);
      req.session.save(() => res.redirect(next_));
    } catch (e) { next(e); }
  });
}

// ------------------------------------------------------------------ 1. public landing
router.get('/jobseeker', async (req, res, next) => {
 try {
  if (req.user && req.user.role === 'seeker') return res.redirect('/jobseeker/dashboard');
  // Same live category counts + broad-group mapping as the homepage's "Find your lane" (views/partials/lane.ejs)
  // — real data, not a second hardcoded catalogue.
  const catRows = await db.many(`SELECT category, count(*)::int AS n FROM jobs WHERE ${PUBLIC_WHERE} GROUP BY category`);
  const catCount = Object.fromEntries(catRows.map(r => [r.category, r.n]));
  const categories = C.CATEGORIES.map(([key, name]) => ({ key, name, n: catCount[key] || 0, path: C.CATEGORY_TO_PATH[key] || '' }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const compassPaths = C.CAREER_PATHS.map(({ key, name }) => ({ key, name }));
  const faqs = [
    ['Does it actually cost anything to job hunt here?', 'Nothing. Creating a profile, uploading your resume, applying to jobs and getting alerts are all free, and always will be. Employers pay a small monthly fee to post — you never do.'],
    ['Do I need to upload a resume for every job?', 'Just once. Upload it (PDF, DOC or DOCX, up to 5 MB) and every application uses it automatically — or swap in a different one for a specific role whenever you want.'],
    ['How do I hear about matching jobs first?', 'Your alerts run off your profile: the categories you choose, the provinces you\'ll work in, your keywords and your skills. A match goes live and you get an in-app notification, plus an email if you want one — instantly or as a daily digest.'],
    ['I\'m new to Canada with no Canadian experience — can I still apply?', 'Yes. Youth Futures Canada is built for young people at every career stage, including those exploring Canadian opportunities for the first time. Filter by career stage — internships, graduate roles, early-career, skilled — to find postings that match where you actually are.'],
    ['Who gets to see my resume?', 'Only the employer or consultant behind a job you applied to, and only the copy you sent them. It\'s never publicly listed, never searchable, and only reaches signed-in owners of that posting.'],
    ['Changed your mind after applying?', 'While an application is still marked "Submitted" you can withdraw it yourself from your Applications page.'],
  ];
  res.render('seeker/landing', {
    title: 'Job Seekers — free profile, one-click apply, job alerts',
    metaDescription: 'Create a free Youth Futures Canada profile, upload your resume once and apply to Canadian jobs in one click. Get job alerts matched to your skills — internships, graduate roles, entry-level jobs and skilled careers.',
    extraCss: ['/css/seeker.css', '/css/public.css'], extraJs: ['/js/seeker.js', '/js/public.js'], noindex: false, faqs,
    categories, compassPaths,
    jsonLd: [{
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    }],
  });
 } catch (e) { next(e); }
});

// ------------------------------------------------------------------ 2. dashboard
router.get('/jobseeker/dashboard', seekerOnly, async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [profile, matches, matchCount, applications, notifications, counts] = await Promise.all([
      getProfile(uid),
      matching.matchesForSeeker(uid, 6),
      matching.countMatchesForSeeker(uid),
      db.many(`SELECT a.id, a.status, a.created_at, jobs.title, jobs.slug, jobs.public_id, jobs.application_deadline, ${JOB_COMPANY}, (${PUBLIC_WHERE}) AS is_public
               FROM applications a JOIN jobs ON jobs.id=a.job_id JOIN employer_profiles ep ON ep.id=jobs.employer_profile_id
               WHERE a.seeker_user_id=$1 ORDER BY a.created_at DESC LIMIT 5`, [uid]).then(jd.decorateJobs),
      db.many('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5', [uid]),
      db.one(`SELECT (SELECT count(*)::int FROM applications WHERE seeker_user_id=$1) AS applications,
                     (SELECT count(*)::int FROM saved_jobs s JOIN jobs ON jobs.id=s.job_id WHERE s.user_id=$1 AND ${PUBLIC_WHERE}) AS saved`, [uid]),
    ]);
    const hasCriteria = (profile.categories || []).length + (profile.keywords || []).length + (profile.skills || []).length > 0;
    res.render('seeker/dashboard', { title: 'My dashboard', nav: 'dashboard', profile, meter: completeness(profile), matches, matchCount, applications, notifications, counts, hasCriteria });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ 3. profile + resume
function profileForm(body, existing) {
  return {
    headline: clean(body.headline, 120),
    summary: clean(body.summary, 2000),
    city: clean(body.city, 80),
    province: C.PROVINCE_NAME[body.province] ? body.province : '',
    categories: pickKeys(body.categories, C.CATEGORIES),
    job_types: pickKeys(body.job_types, C.JOB_TYPES),
    work_arrangements: pickKeys(body.work_arrangements, C.WORK_ARRANGEMENTS),
    provinces: pickKeys(body.provinces, C.PROVINCES),
    keywords: csvToArray(body.keywords),
    skills: csvToArray(body.skills, 30),
    audiences: pickKeys(body.audiences, C.AUDIENCES),
    resume_path: existing.resume_path, resume_name: existing.resume_name, resume_uploaded_at: existing.resume_uploaded_at,
    notify_email: existing.notify_email, notify_frequency: existing.notify_frequency,
  };
}
router.get('/jobseeker/profile', seekerOnly, async (req, res, next) => {
  try {
    const profile = await getProfile(req.user.id);
    res.render('seeker/profile', { title: 'My profile', nav: 'profile', profile, meter: completeness(profile), errors: {} });
  } catch (e) { next(e); }
});
router.post('/jobseeker/profile', seekerOnly, resumeUpload, async (req, res, next) => {
  try {
    const uid = req.user.id;
    const existing = await getProfile(uid);
    const p = profileForm(req.body, existing);
    const errors = {};
    if (req.uploadError) errors.resume = req.uploadError;
    if (p.summary.length > 2000) errors.summary = 'Summary must be 2000 characters or fewer.';
    if (Object.keys(errors).length) return res.status(422).render('seeker/profile', { title: 'My profile', nav: 'profile', profile: p, meter: completeness(p), errors });
    let newFile = null;
    if (req.file) { newFile = storeResume(uid, req.file); p.resume_path = newFile.path; p.resume_name = newFile.name; p.resume_uploaded_at = new Date(); }
    await db.query(`INSERT INTO seeker_profiles(user_id, headline, summary, city, province, categories, job_types, work_arrangements, provinces, keywords, skills, audiences, resume_path, resume_name, resume_uploaded_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
      ON CONFLICT (user_id) DO UPDATE SET headline=EXCLUDED.headline, summary=EXCLUDED.summary, city=EXCLUDED.city, province=EXCLUDED.province,
        categories=EXCLUDED.categories, job_types=EXCLUDED.job_types, work_arrangements=EXCLUDED.work_arrangements, provinces=EXCLUDED.provinces,
        keywords=EXCLUDED.keywords, skills=EXCLUDED.skills, audiences=EXCLUDED.audiences, resume_path=EXCLUDED.resume_path, resume_name=EXCLUDED.resume_name,
        resume_uploaded_at=EXCLUDED.resume_uploaded_at, updated_at=now()`,
      [uid, p.headline || null, p.summary || null, p.city || null, p.province || null, p.categories, p.job_types, p.work_arrangements, p.provinces, p.keywords, p.skills, p.audiences, p.resume_path, p.resume_name, p.resume_uploaded_at]);
    if (newFile && existing.resume_path && existing.resume_path !== newFile.path) await removeFile(existing.resume_path);
    await auth.audit(uid, 'seeker.profile.update', 'seeker_profile', uid, { resume: !!newFile });
    req.flash('success', newFile ? 'Profile saved and resume uploaded.' : 'Profile saved.');
    res.redirect('/jobseeker/profile');
  } catch (e) { next(e); }
});
router.post('/jobseeker/resume/remove', seekerOnly, async (req, res, next) => {
  try {
    const existing = await getProfile(req.user.id);
    if (existing.resume_path) {
      await db.query('UPDATE seeker_profiles SET resume_path=NULL, resume_name=NULL, resume_uploaded_at=NULL, updated_at=now() WHERE user_id=$1', [req.user.id]);
      await removeFile(existing.resume_path);
      await auth.audit(req.user.id, 'seeker.resume.remove', 'seeker_profile', req.user.id);
      req.flash('success', 'Resume removed.');
    }
    res.redirect('/jobseeker/profile');
  } catch (e) { next(e); }
});
router.get('/jobseeker/resume', seekerOnly, async (req, res, next) => {
  try {
    const p = await getProfile(req.user.id);
    if (!p.resume_path) { req.flash('info', 'You have not uploaded a resume yet.'); return res.redirect('/jobseeker/profile'); }
    const abs = path.join(UPLOAD_DIR, p.resume_path);
    if (!abs.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(abs)) { req.flash('error', 'Your resume file could not be found. Please upload it again.'); return res.redirect('/jobseeker/profile'); }
    res.download(abs, p.resume_name || path.basename(abs));
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ 4. apply
const applyLocals = (res) => { res.locals.noindex = true; res.locals.extraCss = ['/css/seeker.css']; res.locals.extraJs = ['/js/seeker.js']; };
/** Loads the public job and decides who may apply. Guests see an in-page interstitial (GET) or are sent to sign in (POST);
 *  employers/consultants get a clear in-page message. Seekers continue. */
async function applyGate(req, res, next) {
  try {
    const job = await publicJob(req.params.slug);
    if (!job) return next('route');  // falls through to the public router / 404
    req.job = job; applyLocals(res);
    const applyPath = `/jobs/${job.slug}/apply`;
    if (!req.user) {
      req.session.returnTo = applyPath;   // login + seeker signup both honour returnTo (lib/auth.login)
      if (req.method !== 'GET') { req.flash('info', 'Sign in or create a free job seeker account to apply.'); return res.redirect(`/login?next=${encodeURIComponent(applyPath)}`); }
      job.locations = await jobLocations(job.id);
      return res.render('seeker/apply', { title: `Apply — ${job.title}`, job, gate: 'guest', returnTo: applyPath });
    }
    if (req.user.role !== 'seeker') {
      job.locations = await jobLocations(job.id);
      return res.status(403).render('seeker/apply', { title: `Apply — ${job.title}`, job, gate: 'role' });
    }
    next();
  } catch (e) { next(e); }
}
function renderApply(res, req, extra) {
  return res.render('seeker/apply', Object.assign({ title: `Apply — ${req.job.title}`, job: req.job, gate: null, bodyClass: 'has-sticky-submit', values: { cover_letter: '', resume_choice: 'profile', save_to_profile: true }, errors: {} }, extra));
}
router.get('/jobs/:slug/apply', applyGate, async (req, res, next) => {
  try {
    const [profile, existing, locations] = await Promise.all([getProfile(req.user.id), db.one('SELECT * FROM applications WHERE job_id=$1 AND seeker_user_id=$2', [req.job.id, req.user.id]), jobLocations(req.job.id)]);
    req.job.locations = locations;
    // Past application deadline: the template renders the closed state from job.applications_closed (no form).
    renderApply(res, req, { profile, existing, values: { cover_letter: '', resume_choice: profile.resume_path ? 'profile' : 'upload', save_to_profile: true } });
  } catch (e) { next(e); }
});
router.post('/jobs/:slug/apply', applyGate, resumeUpload, async (req, res, next) => {
  try {
    const uid = req.user.id; const job = req.job;
    const [profile, existing, locations] = await Promise.all([getProfile(uid), db.one('SELECT * FROM applications WHERE job_id=$1 AND seeker_user_id=$2', [job.id, uid]), jobLocations(job.id)]);
    job.locations = locations;
    const company = h.displayCompany(job);
    if (existing) { req.flash('info', `You already applied to this job on ${h.formatDate(existing.created_at)}.`); return res.redirect('/jobseeker/applications'); }
    if (job.applications_closed) { flashNow(res, 'error', CLOSED_MSG); res.status(422); return renderApply(res, req, { profile, existing: null, errors: { closed: CLOSED_MSG } }); }
    const values = { cover_letter: clean(req.body.cover_letter, COVER_MAX + 1), resume_choice: req.body.resume_choice === 'upload' ? 'upload' : 'profile', save_to_profile: !!req.body.save_to_profile };
    const errors = {};
    if (values.cover_letter.length > COVER_MAX) errors.cover_letter = `Cover letter must be ${COVER_MAX} characters or fewer.`;
    if (req.coverError) errors.cover_file = req.coverError;
    if (values.resume_choice === 'profile' && !profile.resume_path) { values.resume_choice = 'upload'; errors.resume = 'You have no resume on file yet — upload one to apply.'; }
    else if (values.resume_choice === 'upload') {
      if (req.uploadError) errors.resume = req.uploadError;
      else if (!req.file) errors.resume = 'Please choose a PDF, DOC or DOCX resume to upload.';
    }
    if (Object.keys(errors).length) { res.status(422); return renderApply(res, req, { profile, existing: null, values, errors }); }
    let resume = { path: profile.resume_path, name: profile.resume_name };
    if (values.resume_choice === 'upload') {
      resume = storeResume(uid, req.file);
      if (values.save_to_profile) {
        await db.query(`INSERT INTO seeker_profiles(user_id, resume_path, resume_name, resume_uploaded_at) VALUES ($1,$2,$3,now())
          ON CONFLICT (user_id) DO UPDATE SET resume_path=EXCLUDED.resume_path, resume_name=EXCLUDED.resume_name, resume_uploaded_at=now(), updated_at=now()`, [uid, resume.path, resume.name]);
        if (profile.resume_path) await removeFile(profile.resume_path);
      }
    }
    const cover = req.coverFile ? storeCover(uid, req.coverFile) : { path: null, name: null };
    const app = await db.one('INSERT INTO applications(job_id, seeker_user_id, resume_path, resume_name, cover_letter, cover_letter_path, cover_letter_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at',
      [job.id, uid, resume.path, resume.name, values.cover_letter || null, cover.path, cover.name]);
    await db.query(`INSERT INTO notifications(user_id, type, title, body, link, job_id) VALUES ($1,'application_update',$2,$3,'/jobseeker/applications',$4)`,
      [uid, 'Application sent', `Your application for ${job.title} at ${company} was sent.`, job.id]);
    const PUBLIC_URL = await publicUrl();
    const jobLink = `${PUBLIC_URL}/jobs/${job.slug}`;
    const hours = h.formatHours(job);
    const pid = job.public_id ? `Posting ID ${job.public_id}` : '';
    const jobLine = `${h.escapeHtml(h.location(job))}${hours ? ` · ${h.escapeHtml(hours)}` : ''}${pid ? ` · ${h.escapeHtml(pid)}` : ''}`;
    const attached = `your resume (<strong>${h.escapeHtml(resume.name)}</strong>)${cover.path ? ` and cover sheet (<strong>${h.escapeHtml(cover.name)}</strong>)` : ''}`;
    await mail.send({
      to: req.user.email,
      subject: `Application sent: ${job.title} at ${company}`,
      html: mail.layout('Your application was sent', `<p>Hi ${h.escapeHtml(req.user.name || 'there')},</p><p>We sent your application and ${attached} to <strong>${h.escapeHtml(company)}</strong> for:</p><p><strong>${h.escapeHtml(job.title)}</strong><br>${jobLine}</p><p>You can follow its status and withdraw it from your applications page.</p>`, { href: `${PUBLIC_URL}/jobseeker/applications`, label: 'My applications' }),
      text: `Hi ${req.user.name || 'there'},\n\nYour application for ${job.title} at ${company} was sent with resume ${resume.name}${cover.path ? ` and cover sheet ${cover.name}` : ''}.${pid ? `\n${pid}` : ''}\n${jobLink}\n\nTrack it: ${PUBLIC_URL}/jobseeker/applications`,
    });
    const employerTo = job.apply_email || job.contact_email || (await db.one('SELECT email FROM users WHERE id=$1', [job.owner_user_id]) || {}).email;
    if (employerTo) {
      const applicantsHref = `${PUBLIC_URL}/employer/jobs/${job.id}/applicants`;
      const note = values.cover_letter ? `<div style="border-left:3px solid #E1E7EF;padding-left:12px;margin:12px 0">${h.paragraphs(values.cover_letter)}</div>` : '';
      const files = `Their resume (<strong>${h.escapeHtml(resume.name)}</strong>)${cover.path ? ` and cover sheet (<strong>${h.escapeHtml(cover.name)}</strong>) are` : ' is'} available on your applicants page.`;
      await mail.send({
        to: employerTo,
        replyTo: `${req.user.name.replace(/["<>\r\n]/g, '')} <${req.user.email}>`,   // "Reply" in the employer's mail client goes to the applicant, never to the system sender
        subject: `New applicant for ${job.title}`,
        html: mail.layout(`New applicant for ${job.title}`, `<p><strong>${h.escapeHtml(req.user.name)}</strong> (${h.escapeHtml(req.user.email)}) applied to <strong>${h.escapeHtml(job.title)}</strong> at ${h.escapeHtml(company)}${pid ? ` <span style="color:#5A6B7E">(${h.escapeHtml(pid)})</span>` : ''}.</p>${profile.headline ? `<p style="color:#5A6B7E">${h.escapeHtml(profile.headline)}</p>` : ''}${note}<p>${files}</p>`, { href: applicantsHref, label: 'View applicants' }),
        text: `${req.user.name} (${req.user.email}) applied to ${job.title} at ${company}${pid ? ` (${pid})` : ''}.\n\n${values.cover_letter ? values.cover_letter + '\n\n' : ''}Resume: ${resume.name}${cover.path ? `\nCover sheet: ${cover.name}` : ''}\nView applicants: ${applicantsHref}`,
      });
    }
    await auth.audit(uid, 'application.create', 'application', app.id, { job_id: job.id, resume: resume.path, cover_sheet: cover.path });
    req.flash('success', `Your application for ${job.title} was sent to ${company}.`);
    res.redirect('/jobseeker/applications');
  } catch (e) {
    if (e.code === '23505') { req.flash('info', 'You have already applied to this job.'); return res.redirect('/jobseeker/applications'); }
    next(e);
  }
});

// ------------------------------------------------------------------ 5. applications
router.get('/jobseeker/applications', seekerOnly, async (req, res, next) => {
  try {
    const applications = jd.decorateJobs(await db.many(`SELECT a.*, jobs.title, jobs.slug, jobs.city, jobs.province, jobs.public_id, jobs.application_deadline, ${JOB_COMPANY}, (${PUBLIC_WHERE}) AS is_public, ${LOCATION_COUNT}
      FROM applications a JOIN jobs ON jobs.id=a.job_id JOIN employer_profiles ep ON ep.id=jobs.employer_profile_id
      WHERE a.seeker_user_id=$1 ORDER BY a.created_at DESC`, [req.user.id]));
    res.render('seeker/applications', { title: 'My applications', nav: 'applications', applications });
  } catch (e) { next(e); }
});
/** Download the cover sheet you attached to one of YOUR applications (404 for anyone else's). */
router.get('/jobseeker/applications/:id/cover', seekerOnly, async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return next();
    const a = await db.one('SELECT id, cover_letter_path, cover_letter_name FROM applications WHERE id=$1 AND seeker_user_id=$2', [req.params.id, req.user.id]);
    if (!a || !a.cover_letter_path) return next();
    const abs = uploadAbs(a.cover_letter_path, 'covers');
    if (!abs) { req.flash('error', 'That cover sheet file could not be found.'); return res.redirect('/jobseeker/applications'); }
    res.download(abs, a.cover_letter_name || path.basename(abs), (err) => { if (err && !res.headersSent) next(err); });
  } catch (e) { next(e); }
});
router.post('/jobseeker/applications/:id/withdraw', seekerOnly, async (req, res, next) => {
  try {
    if (!isId(req.params.id)) return next();  // 404, not a 500 from pg
    const r = await db.query(`DELETE FROM applications WHERE id=$1 AND seeker_user_id=$2 AND status='submitted' RETURNING job_id`, [req.params.id, req.user.id]);
    if (r.rowCount) { await auth.audit(req.user.id, 'application.withdraw', 'application', Number(req.params.id), { job_id: r.rows[0].job_id }); req.flash('success', 'Application withdrawn.'); }
    else req.flash('error', 'That application can no longer be withdrawn.');
    res.redirect('/jobseeker/applications');
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ 6. saved jobs
async function saveGate(req, res, next) {
  try {
    const job = await publicJob(req.params.slug);
    if (!job) return next('route');
    if (!req.user) { req.session.returnTo = `/jobs/${job.slug}`; req.flash('info', 'Sign in to save jobs.'); return res.redirect('/login'); }
    if (req.user.role !== 'seeker') { req.flash('error', 'Only job seeker accounts can save jobs.'); return res.redirect(`/jobs/${job.slug}`); }
    req.job = job; next();
  } catch (e) { next(e); }
}
router.post('/jobs/:slug/save', saveGate, async (req, res, next) => {
  try {
    await db.query('INSERT INTO saved_jobs(user_id, job_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.job.id]);
    req.flash('success', `Saved "${req.job.title}" to your list.`);
    res.redirect(backTo(req, `/jobs/${req.job.slug}`));
  } catch (e) { next(e); }
});
router.post('/jobs/:slug/unsave', saveGate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM saved_jobs WHERE user_id=$1 AND job_id=$2', [req.user.id, req.job.id]);
    req.flash('info', `Removed "${req.job.title}" from your saved jobs.`);
    res.redirect(backTo(req, `/jobs/${req.job.slug}`));
  } catch (e) { next(e); }
});
router.get('/jobseeker/saved', seekerOnly, async (req, res, next) => {
  try {
    const jobs = jd.decorateJobs(await db.many(`SELECT jobs.*, ${JOB_COMPANY}, s.created_at AS saved_at, (${PUBLIC_WHERE}) AS is_public, ${LOCATION_COUNT},
        EXISTS (SELECT 1 FROM applications a WHERE a.job_id=jobs.id AND a.seeker_user_id=s.user_id) AS applied
      FROM saved_jobs s JOIN jobs ON jobs.id=s.job_id JOIN employer_profiles ep ON ep.id=jobs.employer_profile_id
      WHERE s.user_id=$1 ORDER BY s.created_at DESC`, [req.user.id]));
    res.render('seeker/saved', { title: 'Saved jobs', nav: 'saved', jobs });
  } catch (e) { next(e); }
});
// stale saved (archived) jobs can be removed even though the job is no longer public
router.post('/jobseeker/saved/:jobId/remove', seekerOnly, async (req, res, next) => {
  try {
    if (!isId(req.params.jobId)) return next();
    await db.query('DELETE FROM saved_jobs WHERE user_id=$1 AND job_id=$2', [req.user.id, req.params.jobId]); req.flash('info', 'Removed from saved jobs.'); res.redirect('/jobseeker/saved');
  }
  catch (e) { next(e); }
});

// ------------------------------------------------------------------ 7. alerts
router.get('/jobseeker/alerts', seekerOnly, async (req, res, next) => {
  try { const profile = await getProfile(req.user.id); res.render('seeker/alerts', { title: 'Job alerts', nav: 'alerts', profile }); }
  catch (e) { next(e); }
});
router.post('/jobseeker/alerts', seekerOnly, async (req, res, next) => {
  try {
    const notify = req.body.notify_email === '1' || req.body.notify_email === 'on';
    const freq = req.body.notify_frequency === 'daily' ? 'daily' : 'instant';
    await db.query(`INSERT INTO seeker_profiles(user_id, notify_email, notify_frequency) VALUES ($1,$2,$3)
      ON CONFLICT (user_id) DO UPDATE SET notify_email=EXCLUDED.notify_email, notify_frequency=EXCLUDED.notify_frequency, updated_at=now()`, [req.user.id, notify, freq]);
    await auth.audit(req.user.id, 'seeker.alerts.update', 'seeker_profile', req.user.id, { notify_email: notify, notify_frequency: freq });
    req.flash('success', notify ? `Email alerts on (${freq === 'daily' ? 'daily digest' : 'instant'}).` : 'Email alerts off. You will still see matches in your notifications.');
    res.redirect('/jobseeker/alerts#alerts');
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ 8. notifications
router.get('/jobseeker/notifications', seekerOnly, async (req, res, next) => {
  try {
    const notifications = await db.many('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
    res.render('seeker/notifications', { title: 'Notifications', nav: 'notifications', notifications });
  } catch (e) { next(e); }
});
router.post('/jobseeker/notifications/read', seekerOnly, async (req, res, next) => {
  try {
    const id = /^\d+$/.test(String(req.body.id || '')) ? Number(req.body.id) : null;
    if (id) await db.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id=$2 AND read_at IS NULL', [req.user.id, id]);
    else await db.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
    const go = isSafeReturn(req.body.next) ? req.body.next : '/jobseeker/notifications';
    res.redirect(go);
  } catch (e) { next(e); }
});

module.exports = router;
