'use strict';
// AUTH: /signup/* /login /logout /forgot /reset/:token /account
const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const mail = require('../lib/mail');
const settings = require('../lib/settings');
const C = require('../lib/constants');
const { escapeHtml, formatPostal } = require('../lib/helpers');
const { uniqueProfileSlug } = require('../lib/jobs');

const router = express.Router();
/** Links in emails use the client-configurable public URL (admin panel > env > default). */
const publicUrl = async () => (await settings.get('public_url')).replace(/\/$/, '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PROVINCE_CODES = C.PROVINCES.map(([k]) => k);
const AUDIENCE_KEYS = C.AUDIENCES.map(([k]) => k);
const INDUSTRY_KEYS = C.INDUSTRIES.map(([k]) => k);
const ROLE_LABEL = { employer: 'Employer', consultant: 'Third Party Consultant', seeker: 'Job Seeker', admin: 'Administrator' };
const MAX_FAILS = 5, FAIL_WINDOW_MS = 10 * 60 * 1000;

/** Password policy (shared by signup, reset and account): 8+ chars with at least one letter and one number, not your email. */
function passwordError(pw, email) {
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password must be 128 characters or fewer.';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Password must include at least one letter and one number.';
  if (email && pw.toLowerCase() === String(email).toLowerCase()) return 'Password cannot be the same as your email.';
  return '';
}
const nameError = (name) => name.length < 2 ? 'Please enter your full name.' : /[<>]/.test(name) ? 'Names cannot contain < or >.' : name.length > 100 ? 'Please use 100 characters or fewer.' : '';
/** "Sign out everywhere": drop every other session that belongs to this user (pg session store keeps userId in sess). */
async function endOtherSessions(userId, keepSid) {
  const r = await db.query(`DELETE FROM "session" WHERE (sess->>'userId')::bigint = $1 AND sid <> COALESCE($2, '')`, [userId, keepSid || null]);
  return r.rowCount;
}
const page = (extra) => Object.assign({ extraCss: ['/css/auth.css'], extraJs: ['/js/auth.js'] }, extra);
const s = (v) => String(v ?? '').trim();
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(s);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isSafeReturn = (u) => typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && u.length < 500;
/** `?next=/jobs/x/apply` on a login/signup link (e.g. the apply-page interstitial) becomes the post-login target; lib/auth.login consumes it. */
function rememberNext(req) { if (isSafeReturn(req.query.next)) req.session.returnTo = req.query.next; }
const PRICE = { employer: '$14.99 per posting per month + GST', consultant: '$9.99 per posting per month + GST' };

/** Shared checks for every signup form. Returns { errors, values }. */
async function validateSignup(body, opts = {}) {
  const errors = {};
  const v = {
    name: s(body.name), email: s(body.email).toLowerCase(), phone: s(body.phone),
    password: String(body.password || ''), password_confirm: String(body.password_confirm || ''),
    agree: !!body.agree,
  };
  if (nameError(v.name)) errors.name = nameError(v.name);
  if (!EMAIL_RE.test(v.email)) errors.email = 'Please enter a valid email address.';
  else if (await db.one('SELECT 1 FROM users WHERE email=$1', [v.email])) errors.email = 'An account with this email already exists. Try signing in instead.';
  if (passwordError(v.password, v.email)) errors.password = passwordError(v.password, v.email);
  if (v.password !== v.password_confirm) errors.password_confirm = 'Passwords do not match.';
  if (opts.terms !== false && !v.agree) errors.agree = 'Please accept the Terms of Use and Privacy Policy.';
  return { errors, values: v };
}
function validateLocation(body, errors, required) {
  const city = s(body.city), province = s(body.province).toUpperCase();
  if (required && !city) errors.city = 'Please enter your city.';
  if (province && !PROVINCE_CODES.includes(province)) errors.province = 'Please choose a province or territory.';
  if (required && !province) errors.province = 'Please choose a province or territory.';
  return { city, province };
}
async function createUser(client, v, role) {
  // `client` is either lib/db (pool) or a pg client inside db.tx — both expose .query()
  const hash = await auth.hashPassword(v.password);
  const r = await client.query('INSERT INTO users(email,password_hash,role,name,phone) VALUES ($1,$2,$3,$4,$5) RETURNING id,email,role,name', [v.email, hash, role, v.name, v.phone || null]);
  return r.rows[0];
}
async function welcome(user, role) {
  const first = escapeHtml(user.name.split(' ')[0]);
  const PUBLIC_URL = await publicUrl();
  const bodies = {
    employer: [`<p>Hi ${first}, your employer account is ready.</p><p>Post your first job in minutes — every posting is <strong>${PRICE.employer}</strong>, reaches young talent across Canada at every career stage, and you can cancel any time.</p>`, { href: `${PUBLIC_URL}/employer/jobs/new`, label: 'Post a job' }],
    consultant: [`<p>Hi ${first}, your Third Party Consultant account is ready.</p><p>Add the employers you represent as company profiles, then post and manage jobs for each of them under this one login — ${PRICE.consultant}.</p>`, { href: `${PUBLIC_URL}/consultant/profiles/new`, label: 'Add your first employer' }],
    seeker: [`<p>Hi ${first}, welcome to Youth Futures Canada.</p><p>Upload your resume, set your job preferences and we will email you when new postings match. Applying takes one click.</p>`, { href: `${PUBLIC_URL}/jobseeker/profile`, label: 'Complete your profile' }],
  };
  const [html, cta] = bodies[role];
  await mail.send({
    to: user.email, subject: 'Welcome to Youth Futures Canada',
    html: mail.layout('Welcome to Youth Futures Canada', html, cta),
    text: `Hi ${user.name}, welcome to Youth Futures Canada. Get started: ${cta.href}`,
  });
}

// ---------------------------------------------------------------- signup
router.get('/signup', (req, res) => {
  if (req.user) return res.redirect(auth.homeFor(req.user));
  rememberNext(req);
  res.render('auth/signup', page({ title: 'Create your account', metaDescription: 'Join Youth Futures Canada as an employer ($14.99 per posting per month + GST), third party consultant ($9.99 + GST) or job seeker — applying is always free.' }));
});

const signupPage = { employer: 'auth/signup-employer', consultant: 'auth/signup-consultant', seeker: 'auth/signup-seeker' };
const signupMeta = {
  employer: { title: 'Sign up as an employer', metaDescription: 'Create a Youth Futures Canada employer account and post jobs for your company for $14.99 per posting per month + GST.' },
  consultant: { title: 'Sign up as a third party consultant', metaDescription: 'Create a Youth Futures Canada consultant account to manage job postings for many employers under one login.' },
  seeker: { title: 'Sign up as a job seeker', metaDescription: 'Create a free Youth Futures Canada job seeker account. Upload your resume, apply online and get job alerts by email.' },
};
/** The employer form carries the address-autocomplete widget (public/js/maps.js, maps agent) on top of the auth script. */
const employerPage = (extra) => page({ ...extra, extraJs: ['/js/auth.js', '/js/maps.js'] });
router.get('/signup/:role(employer|consultant|seeker)', (req, res) => {
  if (req.user) return res.redirect(auth.homeFor(req.user));
  rememberNext(req);
  const p = req.params.role === 'employer' ? employerPage : page;
  res.render(signupPage[req.params.role], p({ ...signupMeta[req.params.role], values: { notify_email: true }, errors: {} }));
});

router.post('/signup/employer', wrap(async (req, res) => {
  const { errors, values } = await validateSignup(req.body);
  const loc = validateLocation(req.body, errors, true);
  const company_name = s(req.body.company_name);
  const operating_name = s(req.body.operating_name).slice(0, 160);
  const industry = s(req.body.industry);
  const street_address = s(req.body.street_address).slice(0, 200);
  const unit = s(req.body.unit).slice(0, 40);
  let postal_code = s(req.body.postal_code);
  let website = s(req.body.website);
  if (company_name.length < 2) errors.company_name = 'Please enter your company name.';
  if (/[<>]/.test(operating_name)) errors.operating_name = 'Operating name cannot contain < or >.';
  if (!industry) errors.industry = 'Please choose your industry.';
  else if (!INDUSTRY_KEYS.includes(industry)) errors.industry = 'Please choose an industry from the list.';
  // The business address becomes the profile's first (default) work location, so street + postal are required here.
  if (!street_address) errors.street_address = 'Please enter your street address.';
  else if (/[<>]/.test(street_address)) errors.street_address = 'Street address cannot contain < or >.';
  if (/[<>]/.test(unit)) errors.unit = 'Unit cannot contain < or >.';
  if (!postal_code) errors.postal_code = 'Please enter your postal code.';
  else if (!C.POSTAL_CODE_RE.test(postal_code)) errors.postal_code = 'Please enter a valid Canadian postal code (e.g. M5V 1A1).';
  else postal_code = formatPostal(postal_code);
  if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
  if (website && !/^https?:\/\/[^\s/]+\.[^\s]{2,}$/i.test(website)) errors.website = 'Please enter a valid website address.';
  const vals = { ...values, ...loc, company_name, operating_name, industry, street_address, unit, postal_code, website };
  if (Object.keys(errors).length) return res.status(422).render(signupPage.employer, employerPage({ ...signupMeta.employer, values: vals, errors }));

  const slug = await uniqueProfileSlug(company_name);
  const { user, profile, location } = await db.tx(async (client) => {
    const user = await createUser(client, vals, 'employer');
    // operating_name = the default; operating_names[] = the list the job form picks from (client PDF 2026-09-10)
    const profile = (await client.query(
      `INSERT INTO employer_profiles(owner_user_id,company_name,operating_name,operating_names,industry,slug,website,street_address,city,province,postal_code,contact_name,contact_email,contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [user.id, company_name, operating_name || null, operating_name ? [operating_name] : [], industry, slug, website || null, street_address, loc.city, loc.province, postal_code, vals.name, vals.email, vals.phone || null])).rows[0];
    // first entry in the profile's address book — the default location offered when posting a job
    const location = (await client.query(
      `INSERT INTO employer_locations(employer_profile_id,label,street_address,unit,city,province,postal_code,is_default)
       VALUES ($1,'Main location',$2,$3,$4,$5,$6,true) RETURNING id`,
      [profile.id, street_address, unit || null, loc.city, loc.province, postal_code])).rows[0];
    return { user, profile, location };
  });
  // geocode lazily: lib/geocode.js is written by the maps agent and may not exist yet
  try { await require('../lib/geocode').geocodeEmployerLocation(location.id); }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND') console.error('[signup] geocode failed', e.message); }
  await auth.audit(user.id, 'signup', 'user', user.id, { role: 'employer', profile_id: profile.id, location_id: location.id });
  await welcome(user, 'employer');
  req.flash('success', `Welcome, ${user.name.split(' ')[0]}! Your employer account for ${company_name} is ready.`);
  res.redirect(await auth.login(req, user));
}));

router.post('/signup/consultant', wrap(async (req, res) => {
  const { errors, values } = await validateSignup(req.body);
  if (Object.keys(errors).length) return res.status(422).render(signupPage.consultant, page({ ...signupMeta.consultant, values, errors }));
  const user = await createUser(db, values, 'consultant');
  await auth.audit(user.id, 'signup', 'user', user.id, { role: 'consultant' });
  await welcome(user, 'consultant');
  req.flash('success', `Welcome, ${user.name.split(' ')[0]}! Add the employers you represent to start posting.`);
  res.redirect(await auth.login(req, user));
}));

router.post('/signup/seeker', wrap(async (req, res) => {
  const { errors, values } = await validateSignup(req.body);
  const loc = validateLocation(req.body, errors, false);
  const audiences = arr(req.body.audiences).filter(a => AUDIENCE_KEYS.includes(a));
  const notify_email = !!req.body.notify_email;
  const vals = { ...values, ...loc, audiences, notify_email };
  if (Object.keys(errors).length) return res.status(422).render(signupPage.seeker, page({ ...signupMeta.seeker, values: vals, errors }));
  const user = await db.tx(async (client) => {
    const user = await createUser(client, vals, 'seeker');
    await client.query('INSERT INTO seeker_profiles(user_id,city,province,audiences,notify_email) VALUES ($1,$2,$3,$4,$5)',
      [user.id, loc.city || null, loc.province || null, audiences, notify_email]);
    return user;
  });
  await auth.audit(user.id, 'signup', 'user', user.id, { role: 'seeker' });
  await welcome(user, 'seeker');
  req.flash('success', `Welcome, ${user.name.split(' ')[0]}! Upload your resume to start applying.`);
  res.redirect(await auth.login(req, user));
}));

// ---------------------------------------------------------------- login / logout
const loginMeta = { title: 'Sign in', metaDescription: 'Sign in to your Youth Futures Canada account to post jobs, manage employer profiles, or apply to jobs and manage your alerts.' };
router.get('/login', (req, res) => {
  if (req.user) return res.redirect(auth.homeFor(req.user));
  rememberNext(req);
  const role = ['employer', 'consultant', 'seeker'].includes(req.query.role) ? req.query.role : null;
  res.render('auth/login', page({ ...loginMeta, values: { email: '', remember: true }, errors: {}, roleHint: role }));
});
router.post('/login', wrap(async (req, res) => {
  const email = s(req.body.email).toLowerCase(), password = String(req.body.password || ''), remember = !!req.body.remember;
  const values = { email, remember };
  const fails = req.session.loginFails || { n: 0, since: Date.now() };
  if (Date.now() - fails.since > FAIL_WINDOW_MS) { fails.n = 0; fails.since = Date.now(); }
  const fail = (msg, status = 401) => {
    req.session.loginFails = fails;
    return res.status(status).render('auth/login', page({ ...loginMeta, values, errors: { form: msg }, roleHint: null }));
  };
  if (fails.n >= MAX_FAILS) return fail('Too many sign-in attempts. Please wait 10 minutes and try again, or reset your password.', 429);
  if (!email || !password) { fails.n++; return fail('Please enter your email and password.', 422); }
  const user = await db.one('SELECT id,email,role,name,password_hash,is_active FROM users WHERE email=$1', [email]);
  const ok = user && await auth.verifyPassword(password, user.password_hash);
  if (!ok) { fails.n++; await auth.audit(user ? user.id : null, 'login_failed', 'user', user ? user.id : null, { email }); return fail('That email and password combination is not right.'); }
  if (!user.is_active) return fail('This account has been deactivated. Contact us if you would like to restore it.', 403);
  delete req.session.loginFails;
  if (!remember) req.session.cookie.expires = false; // browser-session cookie
  const to = await auth.login(req, user);
  await auth.audit(user.id, 'login', 'user', user.id, { remember });
  req.flash('success', `Welcome back, ${user.name.split(' ')[0]}.`);
  res.redirect(to);
}));

router.post('/logout', (req, res, next) => {
  const uid = req.user && req.user.id;
  req.session.regenerate((err) => {
    if (err) return next(err);
    if (uid) auth.audit(uid, 'logout', 'user', uid);
    req.flash('info', 'You have been signed out.');
    res.redirect('/');
  });
});

// ---------------------------------------------------------------- forgot / reset
const forgotMeta = { title: 'Reset your password', metaDescription: 'Request a password reset link for your Youth Futures Canada account.', noindex: true };
router.get('/forgot', (req, res) => res.render('auth/forgot', page({ ...forgotMeta, values: { email: '' }, errors: {}, sent: false })));
router.post('/forgot', wrap(async (req, res) => {
  const email = s(req.body.email).toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(422).render('auth/forgot', page({ ...forgotMeta, values: { email }, errors: { email: 'Please enter a valid email address.' }, sent: false }));
  const user = await db.one('SELECT id,email,name FROM users WHERE email=$1 AND is_active', [email]);
  if (user) {
    const token = auth.randomToken(32);
    await db.query("UPDATE users SET reset_token=$2, reset_expires=now() + interval '1 hour', updated_at=now() WHERE id=$1", [user.id, token]);
    const link = `${await publicUrl()}/reset/${token}`;
    await mail.send({
      to: user.email, subject: 'Reset your Youth Futures Canada password',
      html: mail.layout('Reset your password', `<p>Hi ${escapeHtml(user.name.split(' ')[0])}, we received a request to reset the password for <strong>${escapeHtml(user.email)}</strong>.</p><p>This link works for <strong>1 hour</strong>. If you did not ask for this, you can ignore this email — your password will not change.</p>`, { href: link, label: 'Choose a new password' }),
      text: `Reset your Youth Futures Canada password (valid 1 hour): ${link}`,
    });
    await auth.audit(user.id, 'password_reset_requested', 'user', user.id);
  }
  res.render('auth/forgot', page({ ...forgotMeta, values: { email }, errors: {}, sent: true }));
}));

const resetMeta = { title: 'Choose a new password', metaDescription: 'Set a new password for your Youth Futures Canada account.', noindex: true };
async function resetUser(token) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return db.one('SELECT id,email,name FROM users WHERE reset_token=$1 AND reset_expires > now() AND is_active', [token]);
}
router.get('/reset/:token', wrap(async (req, res) => {
  const user = await resetUser(req.params.token);
  if (!user) { req.flash('error', 'That reset link is invalid or has expired. Please request a new one.'); return res.redirect('/forgot'); }
  res.render('auth/reset', page({ ...resetMeta, token: req.params.token, email: user.email, errors: {} }));
}));
router.post('/reset/:token', wrap(async (req, res) => {
  const user = await resetUser(req.params.token);
  if (!user) { req.flash('error', 'That reset link is invalid or has expired. Please request a new one.'); return res.redirect('/forgot'); }
  const errors = {};
  const password = String(req.body.password || ''), confirm = String(req.body.password_confirm || '');
  if (passwordError(password, user.email)) errors.password = passwordError(password, user.email);
  if (password !== confirm) errors.password_confirm = 'Passwords do not match.';
  if (Object.keys(errors).length) return res.status(422).render('auth/reset', page({ ...resetMeta, token: req.params.token, email: user.email, errors }));
  await db.query('UPDATE users SET password_hash=$2, reset_token=NULL, reset_expires=NULL, updated_at=now() WHERE id=$1', [user.id, await auth.hashPassword(password)]);
  const ended = await endOtherSessions(user.id, null);   // a reset means "I may have lost control" — sign out every device
  await auth.audit(user.id, 'password_reset', 'user', user.id, { sessions_ended: ended });
  req.flash('success', 'Your password has been updated and every signed-in device has been signed out. Please sign in.');
  res.redirect('/login');
}));

// ---------------------------------------------------------------- account
const accountMeta = { title: 'My account', metaDescription: 'Manage your Youth Futures Canada account details and password.', noindex: true };
function renderAccount(req, res, extra) {
  return res.render('auth/account', page({ ...accountMeta, roleLabel: ROLE_LABEL[req.user.role] || req.user.role, isAdmin: req.user.role === 'admin', values: { name: req.user.name, phone: req.user.phone || '' }, errors: {}, pwErrors: {}, ...extra }));
}
router.get('/account', auth.requireAuth(), (req, res) => renderAccount(req, res));
router.post('/account', auth.requireAuth(), wrap(async (req, res) => {
  const form = s(req.body.form);
  if (form === 'profile') {
    const name = s(req.body.name), phone = s(req.body.phone);
    const errors = {};
    if (nameError(name)) errors.name = nameError(name);
    if (phone.length > 30) errors.phone = 'Please enter a valid phone number.';
    if (Object.keys(errors).length) { res.status(422); return renderAccount(req, res, { values: { name, phone }, errors }); }
    await db.query('UPDATE users SET name=$2, phone=$3, updated_at=now() WHERE id=$1', [req.user.id, name, phone || null]);
    await auth.audit(req.user.id, 'account_updated', 'user', req.user.id, { fields: ['name', 'phone'] });
    req.flash('success', 'Your details have been saved.');
    return res.redirect('/account');
  }
  if (form === 'password') {
    const current = String(req.body.current_password || ''), password = String(req.body.password || ''), confirm = String(req.body.password_confirm || '');
    const pwErrors = {};
    const row = await db.one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!(await auth.verifyPassword(current, row.password_hash))) pwErrors.current_password = 'Your current password is not right.';
    if (passwordError(password, req.user.email)) pwErrors.password = passwordError(password, req.user.email);
    else if (await auth.verifyPassword(password, row.password_hash)) pwErrors.password = 'New password must be different from your current one.';
    if (password !== confirm) pwErrors.password_confirm = 'Passwords do not match.';
    if (Object.keys(pwErrors).length) { res.status(422); return renderAccount(req, res, { pwErrors }); }
    await db.query('UPDATE users SET password_hash=$2, reset_token=NULL, reset_expires=NULL, updated_at=now() WHERE id=$1', [req.user.id, await auth.hashPassword(password)]);
    const ended = await endOtherSessions(req.user.id, req.sessionID);   // keep this device, sign out all others
    await auth.audit(req.user.id, 'password_changed', 'user', req.user.id, { sessions_ended: ended });
    req.flash('success', ended ? `Your password has been changed and ${ended} other signed-in device${ended === 1 ? ' was' : 's were'} signed out.` : 'Your password has been changed.');
    return res.redirect('/account');
  }
  if (form === 'logout_all') {
    const ended = await endOtherSessions(req.user.id, req.sessionID);
    await auth.audit(req.user.id, 'logout_everywhere', 'user', req.user.id, { sessions_ended: ended });
    req.flash('success', ended ? `Signed out of ${ended} other device${ended === 1 ? '' : 's'}. This device stays signed in.` : 'No other devices were signed in.');
    return res.redirect('/account');
  }
  if (form === 'deactivate') {
    if (s(req.body.confirm_text).toUpperCase() !== 'DEACTIVATE') { res.status(422); return renderAccount(req, res, { deactivateError: 'Type DEACTIVATE to confirm.' }); }
    const uid = req.user.id;
    await db.query('UPDATE users SET is_active=false, reset_token=NULL, reset_expires=NULL, updated_at=now() WHERE id=$1', [uid]);
    await endOtherSessions(uid, null);
    await auth.audit(uid, 'account_deactivated', 'user', uid);
    return req.session.regenerate((err) => {
      if (err) return res.redirect('/');
      req.flash('info', 'Your account has been deactivated. Contact us if you change your mind.');
      res.redirect('/');
    });
  }
  res.status(400); return renderAccount(req, res);
}));

module.exports = router;
