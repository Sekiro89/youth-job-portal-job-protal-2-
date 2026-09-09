'use strict';
// ADMIN (Veda): /admin overview, /admin/messages (support inbox), /admin/jobs, /admin/users, /admin/payments,
// /admin/outbox (every email the site produced, viewable without SMTP), /admin/settings.
// Everything here is requireAuth('admin') + noindex.
const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const mail = require('../lib/mail');
const jobs = require('../lib/jobs');
const C = require('../lib/constants');
const { escapeHtml, paragraphs } = require('../lib/helpers');

const router = express.Router();
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3900}`;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'veda@example.com';
const SUPPORT_NAME = process.env.SUPPORT_NAME || 'Veda';
const isProd = process.env.NODE_ENV === 'production';

const CONTACT_STATUSES = ['new', 'in_progress', 'resolved'];
const CATEGORY_KEYS = C.CONTACT_CATEGORIES.map(([k]) => k);
const CATEGORY_NAME = Object.fromEntries(C.CONTACT_CATEGORIES);
const ROLES = ['employer', 'consultant', 'seeker', 'admin'];
const PAGE_SIZE = 50;

const s = (v) => String(v ?? '').trim();
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Render inside the admin shell. */
function page(res, view, active, data) {
  res.render(`admin/${view}`, {
    noindex: true, extraCss: ['/css/admin.css'], extraJs: ['/js/admin.js'], bodyClass: 'is-admin',
    active, supportName: SUPPORT_NAME, supportEmail: SUPPORT_EMAIL, contactStatuses: CONTACT_STATUSES, categoryName: CATEGORY_NAME,
    ...data,
  });
}

// ---------------------------------------------------------------- dev login (never in production)
if (!isProd) {
  router.get('/admin-dev-login/:email', wrap(async (req, res) => {
    const user = await db.one('SELECT id, email, role, name FROM users WHERE email=$1 AND is_active', [req.params.email]);
    if (!user) return res.status(404).send('no such user');
    req.session.userId = user.id;
    const next = s(req.query.next);
    res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : auth.homeFor(user));
  }));
}

router.use('/admin', auth.requireAuth('admin'));

// ---------------------------------------------------------------- overview
router.get('/admin', wrap(async (req, res) => {
  const [counts, roles, pay, messages, latestJobs] = await Promise.all([
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
  ]);
  const usersByRole = Object.fromEntries(ROLES.map(r => [r, 0]));
  roles.forEach(r => { usersByRole[r.role] = r.n; });
  page(res, 'overview', 'overview', { title: 'Admin overview', counts, usersByRole, pay, messages, latestJobs, mailConfigured: mail.configured });
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
  const [rows, tally] = await Promise.all([
    db.many(`SELECT m.id, m.name, m.email, m.category, m.subject, m.status, m.user_id, m.created_at, m.updated_at, u.role AS user_role
             FROM contact_messages m LEFT JOIN users u ON u.id=m.user_id
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY CASE m.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, m.created_at DESC LIMIT 200`, params),
    db.many('SELECT status, count(*)::int AS n FROM contact_messages GROUP BY status'),
  ]);
  const counts = { all: 0 }; CONTACT_STATUSES.forEach(k => { counts[k] = 0; });
  tally.forEach(t => { counts[t.status] = t.n; counts.all += t.n; });
  page(res, 'messages', 'messages', { title: 'Support messages', rows, counts, status, category, q });
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
    const signature = `<p style="margin-top:20px;color:#5A6B7E">— ${escapeHtml(SUPPORT_NAME)}<br>Technical support, Canada Careers<br><a href="mailto:${escapeHtml(SUPPORT_EMAIL)}">${escapeHtml(SUPPORT_EMAIL)}</a> · Ticket #${id}</p>`;
    const quoted = `<div style="margin-top:20px;padding-left:12px;border-left:3px solid #E1E7EF;color:#8593A6;font-size:13px"><p>On ${escapeHtml(new Date(m.created_at).toLocaleString('en-CA', { timeZone: 'America/Toronto' }))}, you wrote:</p><div style="white-space:pre-wrap">${escapeHtml(m.message)}</div></div>`;
    await mail.send({
      to: m.email, subject,
      html: mail.layout(subject, `${paragraphs(body)}${signature}${quoted}`, { href: `${PUBLIC_URL}/contact`, label: 'Need more help? Contact us' }),
      text: `${body}\n\n— ${SUPPORT_NAME}\nTechnical support, Canada Careers\n${SUPPORT_EMAIL} · Ticket #${id}\n\n> ${m.message.replace(/\n/g, '\n> ')}`,
    });
    const stamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' });
    const note = `[${stamp}] ${req.user.name} replied by email: "${subject}"`;
    const newStatus = alsoResolve ? 'resolved' : (m.status === 'resolved' ? 'resolved' : 'in_progress');
    await db.query(`UPDATE contact_messages SET status=$2::contact_status, resolved_at = CASE WHEN $2='resolved' THEN coalesce(resolved_at, now()) ELSE NULL END,
                    admin_notes = CASE WHEN admin_notes IS NULL OR admin_notes='' THEN $3 ELSE admin_notes || E'\n' || $3 END, updated_at=now() WHERE id=$1`, [id, newStatus, note]);
    await auth.audit(req.user.id, 'contact.reply', 'contact_message', id, { to: m.email, subject, resolved: alsoResolve });
    req.flash('success', `Reply sent to ${m.email}${mail.configured ? '' : ' (SMTP not configured — recorded in the mail outbox)'}.`);
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
  const [rows, tally] = await Promise.all([
    db.many(`SELECT j.id, j.title, j.slug, j.status, j.city, j.province, j.published_at, j.expires_at, j.archived_at, j.views, j.created_at,
                    p.id AS profile_id, p.company_name, p.slug AS company_slug, u.id AS owner_id, u.name AS owner_name, u.email AS owner_email, u.role AS owner_role,
                    (SELECT count(*) FROM applications a WHERE a.job_id=j.id)::int AS applicants,
                    sub.status AS sub_status, sub.current_period_end AS sub_period_end, sub.cancel_at_period_end AS sub_cancel_at_end,
                    (sub.status='active' AND sub.current_period_end > now()) AS restorable
             FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id JOIN users u ON u.id=p.owner_user_id
             LEFT JOIN subscriptions sub ON sub.job_id=j.id
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY j.created_at DESC LIMIT 300`, params),
    db.many('SELECT status, count(*)::int AS n FROM jobs GROUP BY status'),
  ]);
  const counts = { all: 0, archived: 0 }; C.JOB_STATUSES.forEach(k => { counts[k] = 0; });
  tally.forEach(t => { counts[t.status] = t.n; counts.all += t.n; if (C.ARCHIVED_STATUSES.includes(t.status)) counts.archived += t.n; });
  page(res, 'jobs', 'jobs', { title: 'All jobs', rows, counts, status, q });
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

function back(req) {
  const ref = req.get('referer') || '';
  try { const u = new URL(ref); if (u.pathname.startsWith('/admin')) return u.pathname + u.search; } catch (_) {}
  return '/admin/jobs';
}

// ---------------------------------------------------------------- users
router.get('/admin/users', wrap(async (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : '';
  const q = s(req.query.q).slice(0, 100);
  const where = []; const params = [];
  if (role) { params.push(role); where.push(`u.role=$${params.length}::user_role`); }
  if (q) { params.push(`%${q}%`); where.push(`(u.name ILIKE $${params.length} OR u.email::text ILIKE $${params.length})`); }
  const [rows, tally] = await Promise.all([
    db.many(`SELECT u.id, u.name, u.email, u.role, u.phone, u.is_active, u.email_verified, u.created_at, u.last_login_at,
                    (SELECT count(*) FROM employer_profiles p WHERE p.owner_user_id=u.id)::int AS profiles,
                    (SELECT count(*) FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE p.owner_user_id=u.id)::int AS jobs,
                    (SELECT count(*) FROM applications a WHERE a.seeker_user_id=u.id)::int AS applications,
                    (SELECT count(*) FROM contact_messages m WHERE m.user_id=u.id)::int AS messages
             FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.created_at DESC LIMIT 300`, params),
    db.many('SELECT role, count(*)::int AS n FROM users GROUP BY role'),
  ]);
  const counts = { all: 0 }; ROLES.forEach(r => { counts[r] = 0; });
  tally.forEach(t => { counts[t.role] = t.n; counts.all += t.n; });
  page(res, 'users', 'users', { title: 'Users', rows, counts, role, q, roles: ROLES });
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
  res.redirect(back(req) === '/admin/jobs' ? '/admin/users' : back(req));
}));

// ---------------------------------------------------------------- payments
router.get('/admin/payments', wrap(async (req, res) => {
  const [rows, months, totals] = await Promise.all([
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
  ]);
  page(res, 'payments', 'payments', { title: 'Payments', rows, months, totals });
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
  page(res, 'outbox', 'outbox', { title: 'Mail outbox', rows, counts, status, q, pageNo, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total, mailConfigured: mail.configured, mailFrom: mail.FROM });
}));

router.get('/admin/outbox/:id', wrap(async (req, res, next) => {
  const id = int(req.params.id); if (!id) return next();
  const m = await db.one('SELECT * FROM mail_outbox WHERE id=$1', [id]);
  if (!m) return next();
  page(res, 'outbox-item', 'outbox', { title: `Email #${id}`, m, mailConfigured: mail.configured, mailFrom: mail.FROM });
}));

// ---------------------------------------------------------------- settings
const SETTING_DEFS = [
  { key: 'support_email', label: 'Support email (where Contact Us messages go)', env: 'SUPPORT_EMAIL', type: 'email' },
  { key: 'posting_price_cents', label: 'Posting price per month, in cents (before GST)', env: 'POSTING_PRICE_CENTS', type: 'int' },
  { key: 'gst_rate', label: 'GST rate (0.05 = 5%)', env: 'GST_RATE', type: 'rate' },
];
async function loadSettings() {
  const rows = await db.many('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return SETTING_DEFS.map(d => {
    const envVal = process.env[d.env];
    return { ...d, stored: stored[d.key] ?? '', envVal: envVal ?? '', effective: (envVal !== undefined && envVal !== '') ? envVal : (stored[d.key] ?? ''), overridden: envVal !== undefined && envVal !== '' };
  });
}
router.get('/admin/settings', wrap(async (req, res) => {
  page(res, 'settings', 'settings', { title: 'Settings', settings: await loadSettings(), errors: {}, values: null });
}));
router.post('/admin/settings', wrap(async (req, res) => {
  const errors = {}; const values = {};
  for (const d of SETTING_DEFS) {
    const v = s(req.body[d.key]); values[d.key] = v;
    if (d.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) errors[d.key] = 'Enter a valid email address.';
    if (d.type === 'int' && !/^\d{1,7}$/.test(v)) errors[d.key] = 'Enter a whole number of cents, e.g. 999.';
    if (d.type === 'rate' && !(/^\d(\.\d{1,4})?$/.test(v) && Number(v) >= 0 && Number(v) < 1)) errors[d.key] = 'Enter a rate between 0 and 1, e.g. 0.05.';
  }
  if (Object.keys(errors).length) {
    const settings = (await loadSettings()).map(d => ({ ...d, stored: values[d.key] }));
    return res.status(422).render('admin/settings', { noindex: true, extraCss: ['/css/admin.css'], extraJs: ['/js/admin.js'], bodyClass: 'is-admin', active: 'settings', supportName: SUPPORT_NAME, supportEmail: SUPPORT_EMAIL, title: 'Settings', settings, errors, values });
  }
  await db.tx(async (c) => {
    for (const d of SETTING_DEFS) await c.query('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [d.key, values[d.key]]);
  });
  await auth.audit(req.user.id, 'settings.update', 'settings', null, values);
  req.flash('success', 'Settings saved. Values set in .env still take precedence until the environment is changed.');
  res.redirect('/admin/settings');
}));

module.exports = router;
