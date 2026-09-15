'use strict';
// Every email is written to mail_outbox. Delivery uses the provider configured in the admin panel (lib/settings):
//   mail_provider = 'smtp' (smtp_url) | 'resend' (resend_api_key) | '' / 'none' → status 'logged' (visible at /admin/outbox).
// The sender is ALWAYS the configured mail_from_name/mail_from_email — never a person's mailbox.
const nodemailer = require('nodemailer');
const db = require('./db');
const settings = require('./settings');
const { escapeHtml } = require('./helpers');

let transportKey = null, transport = null;
async function config() {
  const s = await settings.getMany(['mail_provider', 'smtp_url', 'resend_api_key', 'mail_from_name', 'mail_from_email', 'public_url', 'site_name']);
  let provider = s.mail_provider;
  if (!provider) provider = s.resend_api_key ? 'resend' : s.smtp_url ? 'smtp' : 'none';
  const from = s.mail_from_email ? `${s.mail_from_name || s.site_name} <${s.mail_from_email}>` : (process.env.MAIL_FROM || `${s.site_name} <no-reply@canadacareers.local>`);
  return Object.assign(s, { provider, from });
}
function smtpTransport(url) {
  if (transportKey !== url) { transport = nodemailer.createTransport(url); transportKey = url; }
  return transport;
}
async function sendResend(apiKey, msg) {
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, reply_to: msg.replyTo }) });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/** Wrap body html in the branded shell. `body` is trusted html; escape user content yourself. */
function layout(title, bodyHtml, cta, opts) {
  const PUBLIC_URL = (opts && opts.publicUrl) || process.env.PUBLIC_URL || 'https://canadacareers.jobs';
  const site = (opts && opts.siteName) || 'Canada Careers';
  const button = cta ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.href)}" style="background:#1F3A5F;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(cta.label)}</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f7fb;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#1b2b3f">
<div style="max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e1e7ef">
    <div style="margin-bottom:20px"><img src="${PUBLIC_URL}/img/logo-email.png" alt="${escapeHtml(site)}" width="180" style="display:block"></div>
    <h1 style="font-size:20px;margin:0 0 12px;color:#1F3A5F">${escapeHtml(title)}</h1>
    <div style="font-size:15px;line-height:1.55">${bodyHtml}</div>
    ${button}
  </div>
  <p style="font-size:12px;color:#6b7a8c;text-align:center;margin-top:16px">${escapeHtml(site)} · Jobs for every Canadian. Opportunities for all.<br>
  <a href="${PUBLIC_URL}" style="color:#6b7a8c">${PUBLIC_URL.replace(/^https?:\/\//, '')}</a></p>
</div></body></html>`;
}

/** send({ to, subject, html, text, replyTo }) -> outbox row id. Never throws. */
async function send({ to, subject, html, text, replyTo }) {
  const cfg = await config();
  const row = await db.one('INSERT INTO mail_outbox(to_email, subject, html, text, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [to, subject, html || null, text || null, cfg.provider === 'none' ? 'logged' : 'queued']);
  if (cfg.provider === 'none') { console.log(`[mail:logged] to=${to} subject="${subject}"`); return row.id; }
  try {
    const msg = { from: cfg.from, to, subject, html, text, replyTo };
    if (cfg.provider === 'resend') await sendResend(cfg.resend_api_key, msg);
    else await smtpTransport(cfg.smtp_url).sendMail(msg);
    await db.query("UPDATE mail_outbox SET status='sent', sent_at=now() WHERE id=$1", [row.id]);
  } catch (e) {
    console.error('[mail:failed]', e.message);
    await db.query("UPDATE mail_outbox SET status='failed', error=$2 WHERE id=$1", [row.id, e.message]);
  }
  return row.id;
}
/** For the admin "Send test email" button: returns { ok, error, provider, from } and throws nothing. */
async function sendTest(to) {
  const cfg = await config();
  if (cfg.provider === 'none') return { ok: false, provider: 'none', from: cfg.from, error: 'No email provider configured (choose SMTP or Resend and save first).' };
  const id = await send({ to, subject: `${cfg.site_name} test email`, html: layout('Email is working', '<p>This test message was sent from your admin panel. Outgoing email is configured correctly.</p>'), text: 'Email is working.' });
  const row = await db.one('SELECT status, error FROM mail_outbox WHERE id=$1', [id]);
  return { ok: row.status === 'sent', provider: cfg.provider, from: cfg.from, error: row.error || null, outbox_id: id };
}
async function configured() { return (await config()).provider !== 'none'; }

module.exports = { send, sendTest, layout, config, configured, PUBLIC_URL: process.env.PUBLIC_URL || 'https://canadacareers.jobs' };
