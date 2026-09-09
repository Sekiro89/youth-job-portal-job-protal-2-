'use strict';
// Every email is written to mail_outbox. If SMTP_URL is set it is also sent via nodemailer;
// otherwise status='logged' (visible in /admin/outbox) so flows are demonstrable without SMTP.
const nodemailer = require('nodemailer');
const db = require('./db');
const { escapeHtml } = require('./helpers');

let transport = null;
if (process.env.SMTP_URL) transport = nodemailer.createTransport(process.env.SMTP_URL);

const FROM = process.env.MAIL_FROM || 'Canada Careers <no-reply@canadacareers.local>';
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3900';

/** Wrap body html in the branded shell. `body` is trusted html; escape user content yourself. */
function layout(title, bodyHtml, cta) {
  const button = cta ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.href)}" style="background:#1F3A5F;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(cta.label)}</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f7fb;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#1b2b3f">
<div style="max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e1e7ef">
    <div style="margin-bottom:20px"><img src="${PUBLIC_URL}/img/logo-email.png" alt="Canada Careers" width="180" style="display:block"></div>
    <h1 style="font-size:20px;margin:0 0 12px;color:#1F3A5F">${escapeHtml(title)}</h1>
    <div style="font-size:15px;line-height:1.55">${bodyHtml}</div>
    ${button}
  </div>
  <p style="font-size:12px;color:#6b7a8c;text-align:center;margin-top:16px">Canada Careers · Jobs for every Canadian. Opportunities for all.<br>
  <a href="${PUBLIC_URL}" style="color:#6b7a8c">${PUBLIC_URL.replace(/^https?:\/\//, '')}</a></p>
</div></body></html>`;
}

/** send({ to, subject, html, text }) -> outbox row id. Never throws. */
async function send({ to, subject, html, text }) {
  const row = await db.one('INSERT INTO mail_outbox(to_email, subject, html, text, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [to, subject, html || null, text || null, transport ? 'queued' : 'logged']);
  if (!transport) { console.log(`[mail:logged] to=${to} subject="${subject}"`); return row.id; }
  try {
    await transport.sendMail({ from: FROM, to, subject, html, text });
    await db.query("UPDATE mail_outbox SET status='sent', sent_at=now() WHERE id=$1", [row.id]);
  } catch (e) {
    console.error('[mail:failed]', e.message);
    await db.query("UPDATE mail_outbox SET status='failed', error=$2 WHERE id=$1", [row.id, e.message]);
  }
  return row.id;
}

module.exports = { send, layout, PUBLIC_URL, FROM, configured: !!transport };
