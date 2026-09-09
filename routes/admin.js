'use strict';
// ADMIN: /admin overview, /admin/messages (support inbox), /admin/jobs, /admin/users, /admin/payments,
// /admin/outbox (every email the site produced, viewable without SMTP), /admin/integrations (the client's own
// control panel: Stripe, email, support routing, pricing, branding, maps, Job Bank sync, admin users — passcode-gated).
// Everything here is requireAuth('admin') + noindex. Runtime config comes from lib/settings (DB > .env > default).
const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const auth = require('../lib/auth');
const mail = require('../lib/mail');
const jobs = require('../lib/jobs');
const settings = require('../lib/settings');
const C = require('../lib/constants');
const { escapeHtml, paragraphs } = require('../lib/helpers');

const router = express.Router();
const isProd = process.env.NODE_ENV === 'production';

const CONTACT_STATUSES = ['new', 'in_progress', 'resolved'];
const CATEGORY_KEYS = C.CONTACT_CATEGORIES.map(([k]) => k);
const CATEGORY_NAME = Object.fromEntries(C.CONTACT_CATEGORIES);
const ROLES = ['employer', 'consultant', 'seeker', 'admin'];
const PAGE_SIZE = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// NUL bytes are stripped (Postgres rejects them in text params → 500). Ids must be plain digits: parseInt('1e3') === 1
// would otherwise silently open ticket #1 for /admin/messages/1e3.
const s = (v) => String(v ?? '').replace(/\0/g, '').trim();
const int = (v) => { const t = s(v); if (!/^\d{1,15}$/.test(t)) return null; const n = Number(t); return Number.isSafeInteger(n) && n > 0 ? n : null; };
/** Same-origin redirect target only: an absolute path that is not protocol-relative ("//host") or backslash-tricked ("/\host"). */
const safePath = (v, fallback) => { const t = s(v); return /^\/(?![\/\\])/.test(t) ? t : fallback; };
/** Pagination helper for the list pages. */
const paging = (query, total) => { const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)); const pageNo = Math.min(int(query.page) || 1, pages); return { pageNo, pages, total, offset: (pageNo - 1) * PAGE_SIZE }; };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
/** Comma-separated support recipients → valid, de-duplicated, lower-cased list. */
const supportList = (v) => [...new Set(String(v || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(x => EMAIL_RE.test(x)))];

/** Render inside the admin shell. Support name/recipients are loaded per request by the middleware below. */
function page(res, view, active, data) {
  res.render(`admin/${view}`, {
    noindex: true, extraCss: ['/css/admin.css'], extraJs: ['/js/admin.js'], bodyClass: 'is-admin',
    active, contactStatuses: CONTACT_STATUSES, categoryName: CATEGORY_NAME,
    ...data,
  });
}

// ---------------------------------------------------------------- dev login (never in production)
if (!isProd) {
  router.get('/admin-dev-login/:email', wrap(async (req, res) => {
    const user = await db.one('SELECT id, email, role, name FROM users WHERE email=$1 AND is_active', [req.params.email]);
    if (!user) return res.status(404).send('no such user');
    req.session.userId = user.id;
    res.redirect(safePath(req.query.next, auth.homeFor(user)));
  }));
}

router.use('/admin', auth.requireAuth('admin'));
// Runtime support/branding values for every admin page (no restart needed when they change in Integrations).
router.use('/admin', wrap(async (req, res, next) => {
  const v = await settings.getMany(['support_email', 'support_name', 'site_name', 'public_url']);
  res.locals.supportName = v.support_name || 'Support';
  res.locals.supportEmails = supportList(v.support_email);
  res.locals.supportEmail = res.locals.supportEmails.join(', ');
  res.locals.siteName = v.site_name || 'Canada Careers';
  res.locals.publicUrl = (v.public_url || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3900}`).replace(/\/$/, '');
  next();
}));

// ---------------------------------------------------------------- overview
router.get('/admin', wrap(async (req, res) => {
  const [counts, roles, pay, messages, latestJobs, mailCfg] = await Promise.all([
    db.one(`SELECT
      (SELECT count(*) FROM contact_messages WHERE status='new')::int AS new_messages,
      (SELECT count(*) FROM contact_messages WHERE status='in_progress')::int AS open_messages,
      (SELECT count(*) FROM jobs WHERE ${jobs.PUBLIC_WHERE})::int AS active_jobs,
      (SELECT count(*) FROM jobs WHERE status='pending_payment')::int AS pending_jobs,
      (SELECT count(*) FROM jobs WHERE status='draft')::int AS draft_jobs,
      (SELECT count(*) FROM jobs WHERE status = ANY($1::job_status[]))::int AS archived_jobs,
      (SELECT count(*) FROM users)::int AS users_total,
      (SELECT count(*) FROM mail_outbox WHERE status='failed')::int AS failed_mail`, [C.ARCHIVED_STATUSES]),
    db.many('SELECT role, count(*)::int AS n FROM users GROUP BY role'),
    db.one(`SELECT coalesce(sum(total_cents),0)::bigint AS total, count(*)::int AS n FROM payments WHERE status='paid' AND paid_at >= date_trunc('month', now())`),
    db.many('SELECT id, name, email, category, subject, status, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 5'),
    db.many(`SELECT j.id, j.title, j.status, j.created_at, j.published_at, j.expires_at, p.company_name FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id ORDER BY j.created_at DESC LIMIT 5`),
    mail.config(),
  ]);
  const usersByRole = Object.fromEntries(ROLES.map(r => [r, 0]));
  roles.forEach(r => { usersByRole[r.role] = r.n; });
  const status = await paymentsStatus(mailCfg);
  page(res, 'overview', 'overview', { title: 'Admin overview', counts, usersByRole, pay, messages, latestJobs, mailConfigured: mailCfg.provider !== 'none', mailProvider: mailCfg.provider, status });
}));

// ---------------------------------------------------------------- messages (support inbox)
router.get('/admin/messages', wrap(async (req, res) => {
  const status = ['all', ...CONTACT_STATUSES].includes(req.query.status) ? req.query.status : 'all';
  const category = CATEGORY_KEYS.includes(req.query.category) ? req.query.category : '';
  const q = s(req.query.q).slice(0, 100);
  const where = []; const params = [];
  if (status !== 'all') { params.push(status); where.push(`m.status=$${params.length}::contact_status`); }
  if (category) { params.push(category); where.push(`m.category=$${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(m.subject ILIKE $${params.length} OR m.name ILIKE $${params.length} OR m.email ILIKE $${params.length} OR m.message ILIKE $${params.length})`); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const pg = paging(req.query, (await db.one(`SELECT count(*)::int AS n FROM contact_messages m ${W}`, params)).n);
  const [rows, tally] = await Promise.all([
    db.many(`SELECT m.id, m.name, m.email, m.category, m.subject, m.status, m.user_id, m.created_at, m.updated_at, u.role AS user_role
             FROM contact_messages m LEFT JOIN users u ON u.id=m.user_id ${W}
             ORDER BY CASE m.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, m.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${pg.offset}`, params),
    db.many('SELECT status, count(*)::int AS n FROM contact_messages GROUP BY status'),
  ]);
  const counts = { all: 0 }; CONTACT_STATUSES.forEach(k => { counts[k] = 0; });
  tally.forEach(t => { counts[t.status] = t.n; counts.all += t.n; });
  page(res, 'messages', 'messages', { title: 'Support messages', rows, counts, status, category, q, pg, unit: 'messages' });
}));

router.get('/admin/messages/:id', wrap(async (req, res, next) => {
  const id = int(req.params.id); if (!id) return next();
  const m = await db.one(`SELECT m.*, u.name AS user_name, u.email AS user_email, u.role AS user_role, u.is_active AS user_active
                          FROM contact_messages m LEFT JOIN users u ON u.id=m.user_id WHERE m.id=$1`, [id]);
  if (!m) return next();
  const [others, emails] = await Promise.all([
    db.many('SELECT id, subject, status, created_at FROM contact_messages WHERE email=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 10', [m.email, id]),
    db.many(`SELECT id, subject, status, created_at FROM mail_outbox WHERE to_email=$1 AND (subject LIKE $2 OR subject LIKE $3) ORDER BY created_at DESC LIMIT 20`, [m.email, `%#${id}%`, `Re: %`]),
  ]);
  page(res, 'message', 'messages', { title: `Message #${id}`, m, others, emails, reply: { subject: `Re: ${m.subject}`, body: '' } });
}));

router.post('/admin/messages/:id', wrap(async (req, res, next) => {
  const id = int(req.params.id); if (!id) return next();
  const m = await db.one('SELECT * FROM contact_messages WHERE id=$1', [id]);
  if (!m) return next();
  const action = s(req.body.action);

  if (action === 'status') {
    const status = s(req.body.status);
    if (!CONTACT_STATUSES.includes(status)) { req.flash('error', 'Unknown status.'); return res.redirect(`/admin/messages/${id}`); }
    await db.query(`UPDATE contact_messages SET status=$2::contact_status, resolved_at = CASE WHEN $2='resolved' THEN coalesce(resolved_at, now()) ELSE NULL END, updated_at=now() WHERE id=$1`, [id, status]);
    await auth.audit(req.user.id, 'contact.status', 'contact_message', id, { from: m.status, to: status });
    req.flash('success', `Ticket #${id} marked ${status.replace('_', ' ')}.`);
    return res.redirect(`/admin/messages/${id}`);
  }

  if (action === 'notes') {
    const notes = s(req.body.admin_notes).slice(0, 20000);
    await db.query('UPDATE contact_messages SET admin_notes=$2, updated_at=now() WHERE id=$1', [id, notes || null]);
    await auth.audit(req.user.id, 'contact.notes', 'contact_message', id, { length: notes.length });
    req.flash('success', 'Notes saved.');
    return res.redirect(`/admin/messages/${id}`);
  }

  if (action === 'reply') {
    const subject = s(req.body.subject).slice(0, 200) || `Re: ${m.subject}`;
    const body = s(req.body.body).slice(0, 20000);
    const alsoResolve = !!req.body.resolve;
    if (body.length < 2) {
      req.flash('error', 'Please write a reply before sending.');
      return res.redirect(`/admin/messages/${id}`);
    }
    const { supportName, supportEmails, siteName, publicUrl } = res.locals;
    const replyAddr = supportEmails[0] || null;
    const signature = `<p style="margin-top:20px;color:#5A6B7E">— ${escapeHtml(supportName)}<br>Technical support, ${escapeHtml(siteName)}${replyAddr ? `<br><a href="mailto:${escapeHtml(replyAddr)}">${escapeHtml(replyAddr)}</a>` : ''} · Ticket #${id}</p>`;
    const quoted = `<div style="margin-top:20px;padding-left:12px;border-left:3px solid #E1E7EF;color:#8593A6;font-size:13px"><p>On ${escapeHtml(new Date(m.created_at).toLocaleString('en-CA', { timeZone: 'America/Toronto' }))}, you wrote:</p><div style="white-space:pre-wrap">${escapeHtml(m.message)}</div></div>`;
    await mail.send({
      to: m.email, subject, replyTo: replyAddr || undefined,
      html: mail.layout(subject, `${paragraphs(body)}${signature}${quoted}`, { href: `${publicUrl}/contact`, label: 'Need more help? Contact us' }, { publicUrl, siteName }),
      text: `${body}\n\n— ${supportName}\nTechnical support, ${siteName}\n${replyAddr ? replyAddr + ' · ' : ''}Ticket #${id}\n\n> ${m.message.replace(/\n/g, '\n> ')}`,
    });
    const stamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' });
    const note = `[${stamp}] ${req.user.name} replied by email: "${subject}"`;
    const newStatus = alsoResolve ? 'resolved' : (m.status === 'resolved' ? 'resolved' : 'in_progress');
    await db.query(`UPDATE contact_messages SET status=$2::contact_status, resolved_at = CASE WHEN $2='resolved' THEN coalesce(resolved_at, now()) ELSE NULL END,
                    admin_notes = CASE WHEN admin_notes IS NULL OR admin_notes='' THEN $3 ELSE admin_notes || E'\n' || $3 END, updated_at=now() WHERE id=$1`, [id, newStatus, note]);
    await auth.audit(req.user.id, 'contact.reply', 'contact_message', id, { to: m.email, subject, resolved: alsoResolve });
    const configured = await mail.configured();
    req.flash('success', `Reply sent to ${m.email}${configured ? '' : ' (no email provider configured — recorded in the mail outbox only)'}.`);
    return res.redirect(`/admin/messages/${id}`);
  }

  req.flash('error', 'Unknown action.');
  res.redirect(`/admin/messages/${id}`);
}));

// ---------------------------------------------------------------- jobs (all statuses incl. archived)
router.get('/admin/jobs', wrap(async (req, res) => {
  const status = ['all', 'archived', ...C.JOB_STATUSES].includes(req.query.status) ? req.query.status : 'all';
  const q = s(req.query.q).slice(0, 100);
  const where = []; const params = [];
  if (status === 'archived') { params.push(C.ARCHIVED_STATUSES); where.push(`j.status = ANY($${params.length}::job_status[])`); }
  else if (status !== 'all') { params.push(status); where.push(`j.status=$${params.length}::job_status`); }
  if (q) { params.push(`%${q}%`); where.push(`(j.title ILIKE $${params.length} OR p.company_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.name ILIKE $${params.length} OR j.city ILIKE $${params.length})`); }
  const FROM = `FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id JOIN users u ON u.id=p.owner_user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const pg = paging(req.query, (await db.one(`SELECT count(*)::int AS n ${FROM}`, params)).n);
  const [rows, tally] = await Promise.all([
    db.many(`SELECT j.id, j.title, j.slug, j.status, j.city, j.province, j.published_at, j.expires_at, j.archived_at, j.views, j.created_at,
                    p.id AS profile_id, p.company_name, p.slug AS company_slug, u.id AS owner_id, u.name AS owner_name, u.email AS owner_email, u.role AS owner_role,
                    (SELECT count(*) FROM applications a WHERE a.job_id=j.id)::int AS applicants,
                    sub.status AS sub_status, sub.current_period_end AS sub_period_end, sub.cancel_at_period_end AS sub_cancel_at_end,
                    (sub.status='active' AND sub.current_period_end > now()) AS restorable,
                    (SELECT pay.id FROM payments pay WHERE pay.job_id=j.id AND pay.status='paid' ORDER BY pay.paid_at DESC LIMIT 1) AS last_receipt_id
             FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id JOIN users u ON u.id=p.owner_user_id
             LEFT JOIN subscriptions sub ON sub.job_id=j.id
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY j.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${pg.offset}`, params),
    db.many('SELECT status, count(*)::int AS n FROM jobs GROUP BY status'),
  ]);
  const counts = { all: 0, archived: 0 }; C.JOB_STATUSES.forEach(k => { counts[k] = 0; });
  tally.forEach(t => { counts[t.status] = t.n; counts.all += t.n; if (C.ARCHIVED_STATUSES.includes(t.status)) counts.archived += t.n; });
  page(res, 'jobs', 'jobs', { title: 'All jobs', rows, counts, status, q, pg, unit: 'jobs' });
}));

router.post('/admin/jobs/:id/archive', wrap(async (req, res, next) => {
  const id = int(req.params.id); if (!id) return next();
  const job = await db.one('SELECT id, title, status FROM jobs WHERE id=$1', [id]);
  if (!job) return next();
  if (C.ARCHIVED_STATUSES.includes(job.status)) { req.flash('info', `"${job.title}" is already archived (${job.status}).`); return res.redirect(back(req)); }
  if (job.status !== 'active') { req.flash('error', `"${job.title}" is ${job.status.replace('_', ' ')} and not public, so there is nothing to take down.`); return res.redirect(back(req)); }
  await jobs.archiveJob(id, 'inactive');
  await auth.audit(req.user.id, 'job.admin_archive', 'job', id, { from: job.status, to: 'inactive', reason: s(req.body.reason).slice(0, 200) || null });
  req.flash('success', `"${job.title}" was taken down (inactive). It is no longer visible publicly.`);
  res.redirect(back(req));
}));

router.post('/admin/jobs/:id/restore', wrap(async (req, res, next) => {
  const id = int(req.params.id); if (!id) return next();
  const job = await db.one(`SELECT j.id, j.title, j.status, sub.status AS sub_status, sub.current_period_end
                            FROM jobs j LEFT JOIN subscriptions sub ON sub.job_id=j.id WHERE j.id=$1`, [id]);
  if (!job) return next();
  if (job.status === 'active') { req.flash('info', `"${job.title}" is already active.`); return res.redirect(back(req)); }
  if (job.sub_status !== 'active' || !job.current_period_end || new Date(job.current_period_end) <= new Date()) {
    req.flash('error', `"${job.title}" cannot be restored: it has no active, paid-up subscription. The owner needs to publish and pay again.`);
    return res.redirect(back(req));
  }
  await jobs.activateJob(id, job.current_period_end);
  await auth.audit(req.user.id, 'job.admin_restore', 'job', id, { from: job.status, to: 'active', until: job.current_period_end });
  req.flash('success', `"${job.title}" is live again until ${new Date(job.current_period_end).toLocaleDateString('en-CA')}.`);
  res.redirect(back(req));
}));

function back(req, fallback = '/admin/jobs') {
  const ref = req.get('referer') || '';
  try { const u = new URL(ref); if (u.pathname.startsWith('/admin')) return u.pathname + u.search + u.hash; } catch (_) {}
  return fallback;
}

// ---------------------------------------------------------------- users
router.get('/admin/users', wrap(async (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : '';
  const q = s(req.query.q).slice(0, 100);
  const where = []; const params = [];
  if (role) { params.push(role); where.push(`u.role=$${params.length}::user_role`); }
  if (q) { params.push(`%${q}%`); where.push(`(u.name ILIKE $${params.length} OR u.email::text ILIKE $${params.length})`); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const pg = paging(req.query, (await db.one(`SELECT count(*)::int AS n FROM users u ${W}`, params)).n);
  const [rows, tally] = await Promise.all([
    db.many(`SELECT u.id, u.name, u.email, u.role, u.phone, u.is_active, u.email_verified, u.created_at, u.last_login_at,
                    (SELECT count(*) FROM employer_profiles p WHERE p.owner_user_id=u.id)::int AS profiles,
                    (SELECT count(*) FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE p.owner_user_id=u.id)::int AS jobs,
                    (SELECT count(*) FROM applications a WHERE a.seeker_user_id=u.id)::int AS applications,
                    (SELECT count(*) FROM contact_messages m WHERE m.user_id=u.id)::int AS messages
             FROM users u ${W} ORDER BY u.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${pg.offset}`, params),
    db.many('SELECT role, count(*)::int AS n FROM users GROUP BY role'),
  ]);
  const counts = { all: 0 }; ROLES.forEach(r => { counts[r] = 0; });
  tally.forEach(t => { counts[t.role] = t.n; counts.all += t.n; });
  page(res, 'users', 'users', { title: 'Users', rows, counts, role, q, roles: ROLES, pg, unit: 'users' });
}));

router.post('/admin/users/:id/toggle-active', wrap(async (req, res, next) => {
  const id = int(req.params.id); if (!id) return next();
  const u = await db.one('SELECT id, name, email, role, is_active FROM users WHERE id=$1', [id]);
  if (!u) return next();
  if (u.id === req.user.id) { req.flash('error', 'You cannot deactivate your own admin account.'); return res.redirect('/admin/users'); }
  await db.query('UPDATE users SET is_active = NOT is_active, updated_at=now() WHERE id=$1', [id]);
  if (u.is_active) await db.query(`DELETE FROM "session" WHERE (sess->>'userId')::bigint = $1`, [id]).catch(() => {});
  await auth.audit(req.user.id, u.is_active ? 'user.deactivate' : 'user.activate', 'user', id, { email: u.email });
  req.flash('success', `${u.name} (${u.email}) is now ${u.is_active ? 'deactivated and signed out everywhere' : 'active'}.`);
  res.redirect(back(req, '/admin/users'));
}));

// ---------------------------------------------------------------- payments
router.get('/admin/payments', wrap(async (req, res) => {
  const [rows, months, totals, pricing] = await Promise.all([
    db.many(`SELECT pay.id, pay.receipt_number, pay.amount_cents, pay.tax_cents, pay.total_cents, pay.currency, pay.status, pay.provider, pay.period_start, pay.period_end, pay.paid_at,
                    j.id AS job_id, j.title AS job_title, j.status AS job_status, p.company_name, u.name AS payer_name, u.email AS payer_email
             FROM payments pay JOIN jobs j ON j.id=pay.job_id JOIN employer_profiles p ON p.id=j.employer_profile_id JOIN users u ON u.id=pay.payer_user_id
             ORDER BY pay.paid_at DESC LIMIT 500`),
    db.many(`SELECT to_char(date_trunc('month', paid_at AT TIME ZONE 'America/Toronto'), 'YYYY-MM') AS month,
                    count(*) FILTER (WHERE status='paid')::int AS n, coalesce(sum(amount_cents) FILTER (WHERE status='paid'),0)::bigint AS amount,
                    coalesce(sum(tax_cents) FILTER (WHERE status='paid'),0)::bigint AS tax, coalesce(sum(total_cents) FILTER (WHERE status='paid'),0)::bigint AS total,
                    count(*) FILTER (WHERE status='refunded')::int AS refunded, count(*) FILTER (WHERE status='failed')::int AS failed
             FROM payments GROUP BY 1 ORDER BY 1 DESC`),
    db.one(`SELECT count(*) FILTER (WHERE status='paid')::int AS n, coalesce(sum(total_cents) FILTER (WHERE status='paid'),0)::bigint AS total,
                   coalesce(sum(tax_cents) FILTER (WHERE status='paid'),0)::bigint AS tax,
                   (SELECT count(*) FROM subscriptions WHERE status='active')::int AS active_subs FROM payments`),
    settings.getMany(['employer_price_cents', 'consultant_price_cents', 'gst_rate']),
  ]);
  const status = await paymentsStatus();
  page(res, 'payments', 'payments', { title: 'Payments', rows, months, totals, pricing, status });
}));

// ---------------------------------------------------------------- mail outbox
router.get('/admin/outbox', wrap(async (req, res) => {
  const status = ['queued', 'sent', 'failed', 'logged'].includes(req.query.status) ? req.query.status : '';
  const q = s(req.query.q).slice(0, 100);
  const pageNo = int(req.query.page) || 1;
  const where = []; const params = [];
  if (status) { params.push(status); where.push(`status=$${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(to_email ILIKE $${params.length} OR subject ILIKE $${params.length})`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await db.one(`SELECT count(*)::int AS n FROM mail_outbox ${w}`, params)).n;
  const rows = await db.many(`SELECT id, to_email, subject, status, error, sent_at, created_at FROM mail_outbox ${w} ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(pageNo - 1) * PAGE_SIZE}`, params);
  const tally = await db.many('SELECT status, count(*)::int AS n FROM mail_outbox GROUP BY status');
  const counts = { all: 0 }; tally.forEach(t => { counts[t.status] = t.n; counts.all += t.n; });
  const cfg = await mail.config();
  page(res, 'outbox', 'outbox', { title: 'Mail outbox', rows, counts, status, q, pageNo, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total, mailConfigured: cfg.provider !== 'none', mailProvider: cfg.provider, mailFrom: cfg.from });
}));

router.get('/admin/outbox/:id', wrap(async (req, res, next) => {
  const id = int(req.params.id); if (!id) return next();
  const m = await db.one('SELECT * FROM mail_outbox WHERE id=$1', [id]);
  if (!m) return next();
  const cfg = await mail.config();
  page(res, 'outbox-item', 'outbox', { title: `Email #${id}`, m, mailConfigured: cfg.provider !== 'none', mailProvider: cfg.provider, mailFrom: cfg.from });
}));

// ---------------------------------------------------------------- legacy settings → integrations
router.get('/admin/settings', (req, res) => res.redirect(301, '/admin/integrations'));
router.post('/admin/settings', (req, res) => res.redirect(303, '/admin/integrations'));

// ================================================================ INTEGRATIONS (passcode-gated control panel)
const UNLOCK_TTL_MS = 15 * 60 * 1000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
const PASSCODE_MIN = 6;
const PASSWORD_MIN = 10;

const GROUPS = [
  { key: 'branding', label: 'Branding', blurb: 'Name, public address and the contact details printed in the footer and on receipts.' },
  { key: 'pricing', label: 'Pricing & GST', blurb: 'What a posting costs per month, before tax, and the GST details printed on every receipt. Changes apply to new checkouts immediately.' },
  { key: 'stripe', label: 'Stripe (payments)', blurb: 'Leave the secret key empty for sandbox mode (simulated card, no money collected). Paste a test key (sk_test_…) to try real checkout, then a live key (sk_live_…) to go live.' },
  { key: 'email', label: 'Email delivery', blurb: 'Every email the site sends (acknowledgements, receipts, alerts, password resets) goes out from the sender below through SMTP or Resend. With no provider, emails are only recorded in the Mail outbox.' },
  { key: 'support', label: 'Contact Us routing', blurb: 'Where Contact Us messages are delivered. Add one or more addresses separated by commas. Nothing is ever sent FROM these addresses — replies go to the visitor with their own address as Reply-To.' },
  { key: 'maps', label: 'Google Maps', blurb: 'With a Google key: address autocomplete on location forms and Google maps on postings. Without one the site uses OpenStreetMap automatically (free, no key).' },
  { key: 'jobbank', label: 'Job Bank import', blurb: 'The daily reference import of Government of Canada Job Bank postings.' },
  { key: 'access', label: 'Access & admins', blurb: 'Who can sign in to this admin area, and the passcode that protects this page.' },
];
const GROUP_KEYS = GROUPS.map(g => g.key);
const fieldsFor = (group) => Object.entries(settings.DEFS).filter(([, d]) => d.group === group).map(([key, d]) => ({ key, ...d }));

// Per-field UI hints (input type / options / help). Anything not listed renders as a plain text input.
const FIELD_UI = {
  public_url: { type: 'url', placeholder: 'https://jobs.example.ca', help: 'Used in every email link, receipts and the Stripe webhook address. Must start with https://.' },
  contact_phone: { type: 'tel', placeholder: '+1 613 555 0100' },
  contact_address: { type: 'textarea', placeholder: '123 Main St, Suite 4\nOttawa, ON K1A 0A6' },
  employer_price_cents: { type: 'int', help: '1499 = $14.99 per posting per month, before GST.' },
  consultant_price_cents: { type: 'int', help: '999 = $9.99 per posting per month, before GST.' },
  gst_rate: { type: 'decimal', help: '0.05 = 5%. Allowed range 0 to 0.3.' },
  gst_number: { placeholder: '123456789 RT0001', help: 'Printed on receipts. Leave empty until registered.' },
  stripe_secret_key: { placeholder: 'sk_test_… or sk_live_…', help: 'Stripe Dashboard → Developers → API keys. Never share this key.' },
  stripe_publishable_key: { placeholder: 'pk_test_… or pk_live_…' },
  stripe_webhook_secret: { placeholder: 'whsec_…', help: 'Filled in automatically by "Create prices & webhook", or copy it from Stripe → Developers → Webhooks.' },
  stripe_tax: { type: 'checkbox', help: 'On: Stripe Tax calculates tax per customer. Off (default): the fixed GST rate above is added as one line.' },
  mail_provider: { type: 'select', options: [['none', 'None — record emails in the outbox only'], ['smtp', 'SMTP server'], ['resend', 'Resend (API key)']] },
  smtp_url: { placeholder: 'smtps://user:password@smtp.example.com:465', help: 'Full URL including user and password. Use smtps:// for port 465, smtp:// for 587 (STARTTLS).' },
  resend_api_key: { placeholder: 're_…', help: 'resend.com → API Keys. Your sender domain must be verified in Resend.' },
  mail_from_email: { type: 'email', placeholder: 'no-reply@yourdomain.ca', help: 'Must be an address your provider is allowed to send from.' },
  support_email: { placeholder: 'support@yourdomain.ca, owner@yourdomain.ca', help: 'Comma-separated. Each address receives every Contact Us message with the visitor as Reply-To.' },
  support_name: { placeholder: 'Support', help: 'Shown on the Contact page and in reply signatures, e.g. "our technical support team".' },
  google_maps_api_key: { placeholder: 'AIza…', help: 'Google Cloud Console → APIs & Services → Credentials. Enable Maps JavaScript API, Places API and Geocoding API.' },
  maps_provider: { type: 'select', options: [['auto', 'Automatic — Google when a key is set, otherwise OpenStreetMap'], ['google', 'Google Maps only'], ['osm', 'OpenStreetMap only']] },
  jobbank_sync: { type: 'select', options: [['on', 'On — import daily'], ['off', 'Off — do not import']] },
};

const timingEqual = (a, b) => { const A = crypto.createHash('sha256').update(String(a)).digest(); const B = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(A, B); };
const isUnlocked = (req) => !!(req.session.integrationsUnlockedAt && Date.now() - req.session.integrationsUnlockedAt < UNLOCK_TTL_MS);
const lockedFor = (req) => Math.max(0, (req.session.integrationsLockedUntil || 0) - Date.now());
const keyMode = (key) => (!key ? 'sandbox' : /^(sk|rk)_live_/.test(key) ? 'live' : 'test');
const lazyBilling = () => { try { return require('../lib/billing'); } catch (e) { console.error('[admin] billing not loadable:', e.message); return null; } };

/** "Payments status" card data (also used on the overview). */
async function paymentsStatus(mailCfg) {
  const v = await settings.getMany(['stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret', 'google_maps_api_key', 'maps_provider', 'jobbank_sync', 'support_email', 'stripe_tax']);
  const cfg = mailCfg || await mail.config();
  const mode = keyMode(v.stripe_secret_key);
  const mapsEffective = v.maps_provider === 'google' ? 'google' : v.maps_provider === 'osm' ? 'osm' : (v.google_maps_api_key ? 'google' : 'osm');
  return {
    mode, modeLabel: { sandbox: 'Sandbox (simulated payments — no money collected)', test: 'Stripe test mode', live: 'Stripe LIVE' }[mode],
    publishableSet: !!v.stripe_publishable_key, webhookSet: !!v.stripe_webhook_secret, stripeTax: v.stripe_tax === '1',
    mailProvider: cfg.provider, mailFrom: cfg.from,
    mapsProvider: mapsEffective, mapsKeySet: !!v.google_maps_api_key, mapsSetting: v.maps_provider || 'auto',
    jobbank: v.jobbank_sync !== 'off', supportEmails: supportList(v.support_email),
  };
}

// ---- unlock / lock (outside the gate)
router.get('/admin/integrations/unlock', wrap(async (req, res) => {
  const hasPasscode = !!(await settings.get('admin_passcode'));
  if (hasPasscode && isUnlocked(req)) return res.redirect(safePath(req.query.next, '/admin/integrations'));
  page(res, 'integrations-unlock', 'integrations', { title: hasPasscode ? 'Unlock Integrations' : 'Set the Integrations passcode', hasPasscode, lockedMs: lockedFor(req), next: safePath(req.query.next, '/admin/integrations'), passcodeMin: PASSCODE_MIN });
}));

router.post('/admin/integrations/unlock', wrap(async (req, res) => {
  const next = safePath(req.body.next, '/admin/integrations');
  const current = await settings.get('admin_passcode');
  const action = s(req.body.action);

  if (action === 'set') {                                   // first run only: no passcode exists yet
    if (current) { req.flash('error', 'A passcode is already set. Change it from Access & admins after unlocking.'); return res.redirect('/admin/integrations/unlock'); }
    const pc = s(req.body.passcode), pc2 = s(req.body.passcode2);
    if (pc.length < PASSCODE_MIN) { req.flash('error', `The passcode must be at least ${PASSCODE_MIN} characters.`); return res.redirect('/admin/integrations/unlock'); }
    if (pc !== pc2) { req.flash('error', 'The two passcodes do not match.'); return res.redirect('/admin/integrations/unlock'); }
    await settings.set('admin_passcode', pc, req.user.id);
    req.session.integrationsUnlockedAt = Date.now(); req.session.integrationsFails = 0;
    await auth.audit(req.user.id, 'integrations.passcode_set', 'settings', null, { first_run: true });
    req.flash('success', 'Passcode set. Keep it somewhere safe — every admin needs it to open Integrations.');
    return res.redirect(next);
  }

  if (!current) { req.flash('error', 'No passcode is set yet — set one first.'); return res.redirect('/admin/integrations/unlock'); }
  const wait = lockedFor(req);
  if (wait > 0) { await auth.audit(req.user.id, 'integrations.unlock_locked', 'settings', null, { wait_s: Math.ceil(wait / 1000) }); req.flash('error', `Too many wrong passcodes. Try again in ${Math.ceil(wait / 60000)} minute(s).`); return res.redirect('/admin/integrations/unlock'); }
  if (timingEqual(s(req.body.passcode), current)) {
    req.session.integrationsUnlockedAt = Date.now(); req.session.integrationsFails = 0; delete req.session.integrationsLockedUntil;
    await auth.audit(req.user.id, 'integrations.unlock', 'settings', null, { ok: true });
    return res.redirect(next);
  }
  const fails = (req.session.integrationsFails || 0) + 1;
  req.session.integrationsFails = fails;
  if (fails >= LOCK_AFTER) { req.session.integrationsLockedUntil = Date.now() + LOCK_MS; req.session.integrationsFails = 0; }
  await auth.audit(req.user.id, 'integrations.unlock', 'settings', null, { ok: false, fails, locked: fails >= LOCK_AFTER });
  req.flash('error', fails >= LOCK_AFTER ? `Wrong passcode ${LOCK_AFTER} times — Integrations is locked for 15 minutes.` : `Wrong passcode (${LOCK_AFTER - fails} attempt${LOCK_AFTER - fails === 1 ? '' : 's'} left).`);
  res.redirect('/admin/integrations/unlock');
}));

router.post('/admin/integrations/lock', wrap(async (req, res) => {
  delete req.session.integrationsUnlockedAt;
  await auth.audit(req.user.id, 'integrations.lock', 'settings', null, null);
  req.flash('info', 'Integrations locked.');
  res.redirect('/admin');
}));

// ---- the gate: every other /admin/integrations route needs a fresh unlock
router.use('/admin/integrations', (req, res, next) => {
  if (isUnlocked(req)) { req.session.integrationsUnlockedAt = Date.now(); return next(); }   // sliding 15-minute window
  if (req.method !== 'GET') { req.flash('error', 'Integrations is locked — enter the passcode and try again.'); return res.redirect('/admin/integrations/unlock'); }
  res.redirect(`/admin/integrations/unlock?next=${encodeURIComponent(req.originalUrl)}`);
});

// ---- the page
async function integrationsData() {
  const groups = [];
  for (const g of GROUPS) {
    const fields = [];
    for (const f of fieldsFor(g.key)) {
      if (f.key === 'admin_passcode') continue;             // handled by its own form
      const [value, source] = await Promise.all([settings.get(f.key), settings.source(f.key)]);
      const ui = FIELD_UI[f.key] || {};
      fields.push({ ...f, ...ui, value: f.secret ? '' : value, display: f.secret ? settings.mask(value) : value, isSet: !!value, source });
    }
    groups.push({ ...g, fields });
  }
  return groups;
}
router.get('/admin/integrations', wrap(async (req, res) => {
  const [groups, status, admins, passcodeSource] = await Promise.all([
    integrationsData(), paymentsStatus(),
    db.many(`SELECT id, name, email, is_active, last_login_at, created_at FROM users WHERE role='admin' ORDER BY created_at, id`),
    settings.source('admin_passcode'),
  ]);
  page(res, 'integrations', 'integrations', { title: 'Integrations', groups, status, admins, passcodeSource, passcodeMin: PASSCODE_MIN, passwordMin: PASSWORD_MIN, unlockMinutes: Math.max(1, Math.round((UNLOCK_TTL_MS - (Date.now() - req.session.integrationsUnlockedAt)) / 60000)), values: req.session.integrationsDraft || {} });
  delete req.session.integrationsDraft;
}));

// ---- Stripe / email / maps actions (all results as flash messages)
router.post('/admin/integrations/stripe/test', wrap(async (req, res) => {
  const b = lazyBilling();
  if (!b || typeof b.testConnection !== 'function') { req.flash('error', 'Stripe test is not available in this build yet (billing.testConnection missing).'); return res.redirect('/admin/integrations#stripe'); }
  let r; try { r = await b.testConnection(); } catch (e) { r = { ok: false, error: e.message }; }
  await auth.audit(req.user.id, 'integrations.stripe_test', 'settings', null, { ok: !!(r && r.ok), mode: r && r.mode, error: r && r.error ? String(r.error).slice(0, 200) : undefined });
  if (r && r.ok) {
    const a = r.account || {};
    const who = [a.business_name, a.id, a.email, a.country && a.default_currency ? `${a.country}/${String(a.default_currency).toUpperCase()}` : a.country].filter(Boolean).join(' · ');
    req.flash('success', `Stripe connected${r.mode ? ` in ${r.mode} mode` : ''}${who ? ` — ${who}` : ''}${a.charges_enabled === false ? ' — WARNING: charges are not enabled on this account yet' : ''}.`);
  } else req.flash('error', `Stripe connection failed: ${String((r && r.error) || 'unknown error').replace(/\.$/, '')}.`);
  res.redirect('/admin/integrations#stripe');
}));

router.post('/admin/integrations/stripe/setup', wrap(async (req, res) => {
  const b = lazyBilling();
  if (!b || typeof b.setupCatalog !== 'function' || typeof b.createWebhookEndpoint !== 'function') { req.flash('error', 'Stripe setup is not available in this build yet (billing.setupCatalog / createWebhookEndpoint missing).'); return res.redirect('/admin/integrations#stripe'); }
  const key = await settings.get('stripe_secret_key');
  if (!key) { req.flash('error', 'Save a Stripe secret key first.'); return res.redirect('/admin/integrations#stripe'); }
  const publicUrl = res.locals.publicUrl;
  if (!/^https:\/\//.test(publicUrl) && isProd) { req.flash('error', `The public URL must be https:// for Stripe webhooks (currently ${publicUrl}). Fix it under Branding first.`); return res.redirect('/admin/integrations#stripe'); }
  const fail = async (step, error) => { await auth.audit(req.user.id, 'integrations.stripe_setup', 'settings', null, { ok: false, step, error: String(error).slice(0, 200) }); req.flash('error', `${step === 'catalog' ? 'Creating prices failed' : 'Prices are ready but the webhook failed'}: ${String(error).replace(/\.$/, '')}.`); return res.redirect('/admin/integrations#stripe'); };
  // billing.setupCatalog() → { ok, created:[lookup keys], existing:[...], prices:{key:id}, error }; never throws.
  let cat; try { cat = await b.setupCatalog(); } catch (e) { cat = { ok: false, error: e.message }; }
  if (!cat || !cat.ok) return fail('catalog', (cat && cat.error) || 'unknown error');
  const priceKeys = Object.keys(cat.prices || {});
  const notes = [`${priceKeys.length} price${priceKeys.length === 1 ? '' : 's'} ready (${(cat.created || []).length} created, ${(cat.existing || []).length} already there)`];
  // billing.createWebhookEndpoint(url, {userId}) → { ok, id, created, secret, secret_saved, note, error }; saves the secret itself when it created the endpoint.
  let wh; try { wh = await b.createWebhookEndpoint(`${publicUrl}/billing/webhook`, { userId: req.user.id }); } catch (e) { wh = { ok: false, error: e.message }; }
  if (!wh || !wh.ok) return fail('webhook', (wh && wh.error) || 'unknown error');
  if (wh.secret && !wh.secret_saved) await settings.set('stripe_webhook_secret', wh.secret, req.user.id);
  const secretSaved = !!(wh.secret_saved || wh.secret) || !!(await settings.get('stripe_webhook_secret'));
  notes.push(wh.created ? `webhook ${wh.id} created and its signing secret ${secretSaved ? 'saved' : 'NOT saved'}` : `webhook ${wh.id} already existed${secretSaved ? ' (signing secret is saved)' : ' — no signing secret is saved here'}`);
  await auth.audit(req.user.id, 'integrations.stripe_setup', 'settings', null, { ok: true, webhook_url: `${publicUrl}/billing/webhook`, webhook_id: wh.id, created: !!wh.created, prices: priceKeys, secret_saved: secretSaved });
  req.flash(secretSaved ? 'success' : 'error', `Stripe set up: ${notes.join('; ')}.${wh.note && !wh.created ? ' ' + wh.note : ''}`);
  res.redirect('/admin/integrations#stripe');
}));

router.post('/admin/integrations/email/test', wrap(async (req, res) => {
  const to = s(req.body.to).toLowerCase() || req.user.email;
  if (!EMAIL_RE.test(to)) { req.flash('error', 'Enter a valid address to send the test to.'); return res.redirect('/admin/integrations#email'); }
  const r = await mail.sendTest(to);
  await auth.audit(req.user.id, 'integrations.email_test', 'settings', null, { to, ok: r.ok, provider: r.provider, error: r.error ? String(r.error).slice(0, 200) : undefined });
  if (r.ok) req.flash('success', `Test email sent to ${to} via ${r.provider} from ${r.from}. Check the inbox (and spam folder).`);
  else req.flash('error', `Test email to ${to} was not delivered${r.provider && r.provider !== 'none' ? ` (${r.provider})` : ''}: ${String(r.error || 'unknown error').replace(/\.$/, '')}${r.outbox_id ? ` — see outbox #${r.outbox_id}` : ''}.`);
  res.redirect('/admin/integrations#email');
}));

router.post('/admin/integrations/maps/test', wrap(async (req, res) => {
  const key = await settings.get('google_maps_api_key');
  if (!key) { req.flash('error', 'No Google Maps key is saved — the site is using OpenStreetMap. Paste a key and save, then test.'); return res.redirect('/admin/integrations#maps'); }
  let result;
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent('Parliament Hill, Ottawa, ON')}&region=ca&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const loc = j.results && j.results[0] && j.results[0].geometry && j.results[0].geometry.location;
    result = j.status === 'OK' && loc ? { ok: true, loc } : { ok: false, error: `${j.status}${j.error_message ? ': ' + j.error_message : ''}` };
  } catch (e) { result = { ok: false, error: e.message }; }
  await auth.audit(req.user.id, 'integrations.maps_test', 'settings', null, { ok: result.ok, error: result.error ? String(result.error).slice(0, 200) : undefined });
  if (result.ok) req.flash('success', `Google Maps key works — Parliament Hill geocoded to ${result.loc.lat.toFixed(4)}, ${result.loc.lng.toFixed(4)}.`);
  else req.flash('error', `Google Maps key test failed: ${result.error}. Check that the Geocoding API is enabled and the key has no referrer restriction for server calls.`);
  res.redirect('/admin/integrations#maps');
}));

// ---- Access: passcode change + admin users
router.post('/admin/integrations/access/passcode', wrap(async (req, res) => {
  const current = await settings.get('admin_passcode');
  if (current && !timingEqual(s(req.body.current), current)) { await auth.audit(req.user.id, 'integrations.passcode_change', 'settings', null, { ok: false }); req.flash('error', 'The current passcode is wrong.'); return res.redirect('/admin/integrations#access'); }
  const pc = s(req.body.passcode), pc2 = s(req.body.passcode2);
  if (pc.length < PASSCODE_MIN) { req.flash('error', `The new passcode must be at least ${PASSCODE_MIN} characters.`); return res.redirect('/admin/integrations#access'); }
  if (pc !== pc2) { req.flash('error', 'The two new passcodes do not match.'); return res.redirect('/admin/integrations#access'); }
  await settings.set('admin_passcode', pc, req.user.id);
  await auth.audit(req.user.id, 'integrations.passcode_change', 'settings', null, { ok: true });
  req.flash('success', 'Passcode changed. Other admins will need the new one the next time they unlock.');
  res.redirect('/admin/integrations#access');
}));

router.post('/admin/integrations/access/admins', wrap(async (req, res) => {
  const name = s(req.body.name).slice(0, 120), email = s(req.body.email).toLowerCase().slice(0, 200), password = String(req.body.password || '').replace(/\0/g, '');
  if (name.length < 2) { req.flash('error', 'Enter the new admin’s name.'); return res.redirect('/admin/integrations#access'); }
  if (!EMAIL_RE.test(email)) { req.flash('error', 'Enter a valid email address for the new admin.'); return res.redirect('/admin/integrations#access'); }
  if (password.length < PASSWORD_MIN) { req.flash('error', `The password must be at least ${PASSWORD_MIN} characters.`); return res.redirect('/admin/integrations#access'); }
  const exists = await db.one('SELECT id, role FROM users WHERE email=$1', [email]);
  if (exists) { req.flash('error', `${email} already has an account (${exists.role}). Use a different address.`); return res.redirect('/admin/integrations#access'); }
  const row = await db.one(`INSERT INTO users(email, password_hash, role, name, email_verified) VALUES ($1,$2,'admin',$3,true) RETURNING id`, [email, await auth.hashPassword(password), name]);
  await auth.audit(req.user.id, 'admin.create', 'user', row.id, { email, name });
  req.flash('success', `${name} (${email}) can now sign in at /login as an admin. Share the password with them privately — they can change it under My account.`);
  res.redirect('/admin/integrations#access');
}));

router.post('/admin/integrations/access/admins/:id/toggle', wrap(async (req, res, next) => {
  const id = int(req.params.id); if (!id) return next();
  const u = await db.one(`SELECT id, name, email, is_active FROM users WHERE id=$1 AND role='admin'`, [id]);
  if (!u) return next();
  if (u.id === req.user.id) { req.flash('error', 'You cannot disable your own admin account.'); return res.redirect('/admin/integrations#access'); }
  await db.query('UPDATE users SET is_active = NOT is_active, updated_at=now() WHERE id=$1', [id]);
  if (u.is_active) await db.query(`DELETE FROM "session" WHERE (sess->>'userId')::bigint = $1`, [id]).catch(() => {});
  await auth.audit(req.user.id, u.is_active ? 'admin.disable' : 'admin.enable', 'user', id, { email: u.email });
  req.flash('success', `${u.name} is now ${u.is_active ? 'disabled and signed out everywhere' : 'enabled'}.`);
  res.redirect('/admin/integrations#access');
}));

router.post('/admin/integrations/access/admins/:id/password', wrap(async (req, res, next) => {
  const id = int(req.params.id); if (!id) return next();
  const u = await db.one(`SELECT id, name, email FROM users WHERE id=$1 AND role='admin'`, [id]);
  if (!u) return next();
  const password = String(req.body.password || '').replace(/\0/g, '');
  if (password.length < PASSWORD_MIN) { req.flash('error', `The new password must be at least ${PASSWORD_MIN} characters.`); return res.redirect('/admin/integrations#access'); }
  await db.query('UPDATE users SET password_hash=$2, reset_token=NULL, reset_expires=NULL, updated_at=now() WHERE id=$1', [id, await auth.hashPassword(password)]);
  if (u.id !== req.user.id) await db.query(`DELETE FROM "session" WHERE (sess->>'userId')::bigint = $1`, [id]).catch(() => {});
  await auth.audit(req.user.id, 'admin.password_reset', 'user', id, { email: u.email, self: u.id === req.user.id });
  req.flash('success', `Password for ${u.name} reset${u.id === req.user.id ? '' : ' — they have been signed out everywhere'}.`);
  res.redirect('/admin/integrations#access');
}));

// ---- save one group
const VALIDATORS = {
  site_name: (v) => (v.length < 2 || v.length > 80) && 'Site name: 2–80 characters.',
  public_url: (v) => { if (!v) return 'Public URL is required.'; try { const u = new URL(v); const ok = u.protocol === 'https:' || (!isProd && u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)); return !ok && 'Public URL must start with https://.'; } catch (_) { return 'Public URL is not a valid address.'; } },
  employer_price_cents: (v) => !(/^\d{1,7}$/.test(v) && Number(v) > 0) && 'Employer price: whole number of cents greater than 0 (e.g. 1499).',
  consultant_price_cents: (v) => !(/^\d{1,7}$/.test(v) && Number(v) > 0) && 'Consultant price: whole number of cents greater than 0 (e.g. 999).',
  gst_rate: (v) => !(/^\d(\.\d{1,4})?$/.test(v) && Number(v) >= 0 && Number(v) <= 0.3) && 'GST rate must be between 0 and 0.3 (0.05 = 5%).',
  stripe_secret_key: (v) => v && !/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(v) && 'Stripe secret key should look like sk_test_… or sk_live_….',
  stripe_publishable_key: (v) => v && !/^pk_(test|live)_[A-Za-z0-9]{8,}$/.test(v) && 'Stripe publishable key should look like pk_test_… or pk_live_….',
  stripe_webhook_secret: (v) => v && !/^whsec_[A-Za-z0-9]{8,}$/.test(v) && 'Webhook signing secret should look like whsec_….',
  stripe_tax: (v) => !['0', '1'].includes(v) && 'Stripe Tax: on or off.',
  mail_provider: (v) => !['smtp', 'resend', 'none'].includes(v) && 'Email provider must be SMTP, Resend or None.',
  smtp_url: (v) => v && !/^smtps?:\/\/.+@.+/.test(v) && 'SMTP URL should look like smtps://user:password@host:465.',
  mail_from_email: (v) => v && !EMAIL_RE.test(v) && 'Sender email is not a valid address.',
  mail_from_name: (v) => v.length > 80 && 'Sender name: at most 80 characters.',
  support_email: (v) => { const parts = v.split(/[,;\s]+/).filter(Boolean); const bad = parts.filter(p => !EMAIL_RE.test(p)); return bad.length ? `Not a valid email address: ${bad.join(', ')}.` : false; },
  support_name: (v) => (v.length < 2 || v.length > 80) && 'Support name: 2–80 characters.',
  maps_provider: (v) => !['auto', 'google', 'osm'].includes(v) && 'Map provider must be Automatic, Google or OpenStreetMap.',
  jobbank_sync: (v) => !['on', 'off'].includes(v) && 'Job Bank import must be on or off.',
};

router.post('/admin/integrations/:group', wrap(async (req, res, next) => {
  const group = s(req.params.group);
  if (!GROUP_KEYS.includes(group) || group === 'access') return next();
  const fields = fieldsFor(group).filter(f => f.key !== 'admin_passcode');
  const errors = []; const changes = {}; const draft = {};
  for (const f of fields) {
    const ui = FIELD_UI[f.key] || {};
    let v;
    if (f.secret) {
      if (req.body[`${f.key}__clear`]) v = '';
      else { v = s(req.body[f.key]); if (!v) continue; }        // blank "Replace" box = keep the stored secret
    } else if (ui.type === 'checkbox') v = req.body[f.key] ? '1' : '0';
    else { v = s(req.body[f.key]).slice(0, 2000); draft[f.key] = v; }
    if (f.key === 'public_url') v = v.replace(/\/+$/, '');
    const err = VALIDATORS[f.key] && VALIDATORS[f.key](v);
    if (f.key === 'support_email') v = supportList(v).join(', ');   // normalise after validation so typos are reported, not dropped
    if (err) errors.push(err); else changes[f.key] = v;
  }
  if (errors.length) {
    req.session.integrationsDraft = draft;
    errors.forEach(e => req.flash('error', e));
    return res.redirect(`/admin/integrations#${group}`);
  }
  const changed = [];
  for (const [k, v] of Object.entries(changes)) {
    const before = await settings.get(k);
    if (before === v && (await settings.source(k)) === 'db') continue;
    await settings.set(k, v, req.user.id);
    changed.push(k);
  }
  settings.invalidate();
  const meta = { group, keys: changed, values: Object.fromEntries(changed.filter(k => !settings.DEFS[k].secret).map(k => [k, changes[k]])), secrets: changed.filter(k => settings.DEFS[k].secret).map(k => `${k}:${changes[k] ? 'set' : 'cleared'}`) };
  await auth.audit(req.user.id, 'settings.update', 'settings', null, meta);
  const label = GROUPS.find(g => g.key === group).label;
  req.flash('success', changed.length ? `${label} saved (${changed.length} value${changed.length === 1 ? '' : 's'}). In effect immediately — no restart needed.` : `${label}: nothing changed.`);
  if (group === 'support' && !supportList(changes.support_email).length) req.flash('error', 'No Contact Us recipient is set — messages will be stored in the inbox but not emailed to anyone.');
  res.redirect(`/admin/integrations#${group}`);
}));

module.exports = router;
