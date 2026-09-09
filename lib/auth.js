'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const hashPassword = (pw) => bcrypt.hash(pw, 10);
const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash || '');
const randomToken = (n = 32) => crypto.randomBytes(n).toString('hex');

/** Loads req.user from the session and exposes it to templates. Mounted globally in server.js. */
async function loadUser(req, res, next) {
  req.user = null;
  if (req.session && req.session.userId) {
    try {
      req.user = await db.one('SELECT id, email, role, name, phone, email_verified, created_at FROM users WHERE id=$1 AND is_active', [req.session.userId]);
      if (!req.user) req.session.userId = null;
    } catch (e) { return next(e); }
  }
  res.locals.user = req.user;
  next();
}

/** requireAuth() -> any logged-in user; requireAuth('employer','consultant') -> only those roles */
function requireAuth(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      req.session.returnTo = req.originalUrl;
      req.flash('info', 'Please sign in to continue.');
      return res.redirect('/login');
    }
    if (roles.length && !roles.includes(req.user.role)) {
      req.flash('error', 'That page is not available for your account type.');
      return res.redirect(homeFor(req.user));
    }
    next();
  };
}

/** Where each role lands after login. */
function homeFor(user) {
  if (!user) return '/';
  return { employer: '/employer/dashboard', consultant: '/consultant/dashboard', seeker: '/jobseeker/dashboard', admin: '/admin' }[user.role] || '/';
}

/** Log a user in (sets session) and return the redirect target. */
async function login(req, user) {
  // Regenerate the session id on login (prevents session fixation) but keep returnTo/flash.
  const keep = { returnTo: req.session.returnTo, flash: req.session.flash };
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  Object.assign(req.session, keep);
  req.session.userId = user.id;
  await db.query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
  const to = req.session.returnTo || homeFor(user);
  delete req.session.returnTo;
  return to;
}

/** Flash messages: req.flash('error'|'success'|'info', msg); read in layout via res.locals.flash */
function flashMiddleware(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  next();
}

/** CSRF-light: reject state-changing requests whose Origin/Referer is not our own host. */
function sameOriginGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.path.startsWith('/billing/webhook')) return next();
  const origin = req.get('origin') || req.get('referer');
  if (!origin) return next(); // curl / non-browser clients
  const host = req.get('host');
  try { if (new URL(origin).host === host) return next(); } catch (_) {}
  return res.status(403).send('Cross-site request blocked');
}

async function audit(userId, action, entity, entityId, meta) {
  try { await db.query('INSERT INTO audit_log(user_id, action, entity, entity_id, meta) VALUES ($1,$2,$3,$4,$5)', [userId || null, action, entity || null, entityId || null, meta ? JSON.stringify(meta) : null]); }
  catch (e) { console.error('[audit]', e.message); }
}

module.exports = { hashPassword, verifyPassword, randomToken, loadUser, requireAuth, homeFor, login, flashMiddleware, sameOriginGuard, audit };
