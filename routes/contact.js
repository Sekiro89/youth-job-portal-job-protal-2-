'use strict';
// CONTACT US: GET|POST /contact, GET /contact/thanks
// Flow: form -> contact_messages row -> email to Veda (SUPPORT_EMAIL) + auto-acknowledgement to sender -> /contact/thanks?ref=<id>
const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const mail = require('../lib/mail');
const C = require('../lib/constants');
const { escapeHtml } = require('../lib/helpers');

const router = express.Router();
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3900}`;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'veda@example.com';
const SUPPORT_NAME = process.env.SUPPORT_NAME || 'Veda';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CATEGORY_KEYS = C.CONTACT_CATEGORIES.map(([k]) => k);
const CATEGORY_NAME = Object.fromEntries(C.CONTACT_CATEGORIES);
const RATE_MAX = 5, RATE_WINDOW_MS = 60 * 60 * 1000;

// Postgres rejects NUL bytes in text (would 500) — strip them from every user string.
const s = (v) => String(v ?? '').replace(/\0/g, '').trim();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const META = {
  title: 'Contact Us',
  metaDescription: 'Contact Canada Careers. Technical issues go straight to Veda, our technical support — plus help with billing, job postings and your account. We reply within one business day.',
  extraCss: ['/css/contact.css'],
};
const jsonLd = () => [{
  '@context': 'https://schema.org',
  '@type': 'ContactPage',
  name: 'Contact Canada Careers',
  url: `${PUBLIC_URL}/contact`,
  description: META.metaDescription,
  mainEntity: {
    '@type': 'Organization', name: 'Canada Careers', url: PUBLIC_URL,
    contactPoint: [{ '@type': 'ContactPoint', contactType: 'technical support', email: SUPPORT_EMAIL, availableLanguage: ['English', 'French'], areaServed: 'CA' }],
  },
}];

function defaults(user) {
  return { name: user ? user.name : '', email: user ? user.email : '', phone: (user && user.phone) || '', category: 'technical', subject: '', message: '', include_account: !!user };
}

router.get('/contact', (req, res) => {
  const values = { ...defaults(req.user), ...(req.query.category && CATEGORY_KEYS.includes(req.query.category) ? { category: req.query.category } : {}) };
  res.render('contact/index', { ...META, jsonLd: jsonLd(), values, errors: {}, supportName: SUPPORT_NAME });
});

router.post('/contact', wrap(async (req, res) => {
  const b = req.body || {};
  // Honeypot: real users never see the `website` field. Bots that fill it get a convincing "success" and nothing is stored.
  if (s(b.website)) return res.redirect('/contact/thanks?ref=0');

  const useAccount = !!(req.user && b.include_account);
  const v = {
    name: useAccount ? req.user.name : s(b.name),
    email: useAccount ? req.user.email : s(b.email).toLowerCase(),
    phone: s(b.phone).slice(0, 40),
    category: CATEGORY_KEYS.includes(s(b.category)) ? s(b.category) : 'technical',
    subject: s(b.subject).slice(0, 200),
    message: s(b.message).slice(0, 10000),
    include_account: useAccount,
  };
  const errors = {};
  if (v.name.length < 2) errors.name = 'Please enter your name.';
  if (!EMAIL_RE.test(v.email)) errors.email = 'Please enter a valid email address so we can reply.';
  if (v.subject.length < 3) errors.subject = 'Please add a short subject.';
  if (v.message.length < 20) errors.message = 'Please describe the issue in at least 20 characters — what you did, what you expected and what happened.';

  // Rate limit: 5 submissions per session per hour.
  const now = Date.now();
  const stamps = (req.session.contactStamps || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (!Object.keys(errors).length && stamps.length >= RATE_MAX) errors.form = 'You have sent several messages in the last hour. Please wait a little while before sending another — Veda already has your earlier messages.';

  if (Object.keys(errors).length) {
    return res.status(422).render('contact/index', { ...META, jsonLd: jsonLd(), values: v, errors, supportName: SUPPORT_NAME });
  }

  const ip = req.ip || null;
  const ua = s(req.get('user-agent')).slice(0, 500) || null;
  const row = await db.one(
    'INSERT INTO contact_messages(name,email,phone,category,subject,message,user_id,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at',
    [v.name, v.email, v.phone || null, v.category, v.subject, v.message, req.user ? req.user.id : null, ip, ua]);
  const id = row.id;
  stamps.push(now); req.session.contactStamps = stamps;

  const adminLink = `${PUBLIC_URL}/admin/messages/${id}`;
  const catName = CATEGORY_NAME[v.category] || v.category;
  const accountLine = req.user
    ? `<tr><th align="left" style="padding:4px 8px 4px 0;white-space:nowrap">Account</th><td style="padding:4px 0">#${req.user.id} · ${escapeHtml(req.user.role)} · <a href="${PUBLIC_URL}/admin/users?q=${encodeURIComponent(req.user.email)}">${escapeHtml(req.user.email)}</a></td></tr>`
    : `<tr><th align="left" style="padding:4px 8px 4px 0;white-space:nowrap">Account</th><td style="padding:4px 0">Not signed in</td></tr>`;

  // 1) Email Veda (support inbox) with everything she needs to resolve it directly.
  await mail.send({
    to: SUPPORT_EMAIL,
    subject: `[Contact #${id}] ${catName}: ${v.subject}`,
    html: mail.layout(`New ${catName.toLowerCase()} message — ticket #${id}`,
      `<p style="background:#FDF0DA;border:1px solid #F4A62A;border-radius:8px;padding:10px 12px;font-weight:600">Reply to: <a href="mailto:${escapeHtml(v.email)}">${escapeHtml(v.email)}</a>${v.phone ? ` · ${escapeHtml(v.phone)}` : ''}</p>
      <table style="font-size:14px;border-collapse:collapse;margin:8px 0 16px">
        <tr><th align="left" style="padding:4px 8px 4px 0">From</th><td style="padding:4px 0">${escapeHtml(v.name)} &lt;${escapeHtml(v.email)}&gt;</td></tr>
        <tr><th align="left" style="padding:4px 8px 4px 0">Category</th><td style="padding:4px 0">${escapeHtml(catName)}</td></tr>
        <tr><th align="left" style="padding:4px 8px 4px 0">Subject</th><td style="padding:4px 0">${escapeHtml(v.subject)}</td></tr>
        ${accountLine}
        <tr><th align="left" style="padding:4px 8px 4px 0">IP / device</th><td style="padding:4px 0">${escapeHtml(ip || '—')}<br><span style="color:#6b7a8c">${escapeHtml(ua || '—')}</span></td></tr>
      </table>
      <h2 style="font-size:15px;margin:0 0 6px;color:#1F3A5F">Message</h2>
      <div style="background:#F6F8FB;border-radius:8px;padding:12px 14px;white-space:pre-wrap">${escapeHtml(v.message)}</div>
      <p style="margin-top:16px;color:#6b7a8c;font-size:13px">Hi ${escapeHtml(SUPPORT_NAME)} — you can reply straight from your mail client (Reply to: ${escapeHtml(v.email)}) or from the admin area, where the ticket status and notes are tracked.</p>`,
      { href: adminLink, label: `Open ticket #${id} in admin` }),
    text: `New contact message #${id}\nReply to: ${v.email}${v.phone ? ' / ' + v.phone : ''}\nFrom: ${v.name}\nCategory: ${catName}\nSubject: ${v.subject}\nAccount: ${req.user ? `#${req.user.id} ${req.user.role} ${req.user.email}` : 'not signed in'}\nIP: ${ip || '-'}\nUA: ${ua || '-'}\n\n${v.message}\n\nOpen in admin: ${adminLink}`,
  });

  // 2) Auto-acknowledgement to the sender.
  const first = escapeHtml(v.name.split(' ')[0]);
  await mail.send({
    to: v.email,
    subject: `We received your message — ticket #${id}`,
    html: mail.layout(`Thanks, ${first} — we have your message`,
      `<p>Your ticket number is <strong>#${id}</strong>. Keep it handy if you need to follow up.</p>
      <p><strong>${escapeHtml(SUPPORT_NAME)} or a member of the team will get back to you</strong> at <strong>${escapeHtml(v.email)}</strong>, usually within one business day.</p>
      <table style="font-size:14px;border-collapse:collapse;margin:8px 0 16px">
        <tr><th align="left" style="padding:4px 8px 4px 0">Category</th><td style="padding:4px 0">${escapeHtml(catName)}</td></tr>
        <tr><th align="left" style="padding:4px 8px 4px 0">Subject</th><td style="padding:4px 0">${escapeHtml(v.subject)}</td></tr>
      </table>
      <div style="background:#F6F8FB;border-radius:8px;padding:12px 14px;white-space:pre-wrap;color:#5A6B7E">${escapeHtml(v.message)}</div>
      <p style="margin-top:16px">If you did not send this message, you can ignore this email.</p>`,
      { href: `${PUBLIC_URL}/jobs`, label: 'Browse jobs while you wait' }),
    text: `Thanks ${v.name}, we received your message (ticket #${id}). ${SUPPORT_NAME} or a member of the team will get back to you at ${v.email}, usually within one business day.\n\nCategory: ${catName}\nSubject: ${v.subject}\n\n${v.message}`,
  });

  await auth.audit(req.user ? req.user.id : null, 'contact.submit', 'contact_message', id, { category: v.category, email: v.email, ip });
  res.redirect(`/contact/thanks?ref=${id}`);
}));

router.get('/contact/thanks', (req, res) => {
  const ref = String(req.query.ref || '').replace(/\D/g, '') || '0';
  res.render('contact/thanks', {
    title: 'Message received', metaDescription: 'Thanks for contacting Canada Careers. We will reply within one business day.',
    extraCss: ['/css/contact.css'], noindex: true, ref, supportName: SUPPORT_NAME,
  });
});

module.exports = router;
