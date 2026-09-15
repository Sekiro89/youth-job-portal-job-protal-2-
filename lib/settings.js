'use strict';
// Runtime settings = the client's control panel (/admin/integrations). Precedence: DB value (non-empty) > env > default.
// Secrets are stored encrypted with AES-256-GCM under a key derived from SESSION_SECRET (so the DB alone never leaks keys).
const crypto = require('crypto');
const db = require('./db');
const C = require('./constants');

const DEFS = {
  // key: { env, default, secret, label, group }
  site_name:               { env: 'SITE_NAME', default: 'Canada Careers', group: 'branding', label: 'Site name' },
  public_url:              { env: 'PUBLIC_URL', default: 'https://canadacareers.jobs', group: 'branding', label: 'Public URL' },
  contact_phone:           { env: 'CONTACT_PHONE', default: '', group: 'branding', label: 'Contact phone (footer)' },
  contact_address:         { env: 'CONTACT_ADDRESS', default: '', group: 'branding', label: 'Business address (footer / receipts)' },
  employer_price_cents:    { env: 'EMPLOYER_PRICE_CENTS', default: String(C.PRICING.employer_price_cents), group: 'pricing', label: 'Employer price per posting per month (cents, before GST)', type: 'int' },
  consultant_price_cents:  { env: 'CONSULTANT_PRICE_CENTS', default: String(C.PRICING.consultant_price_cents), group: 'pricing', label: 'Consultant price per posting per month (cents, before GST)', type: 'int' },
  gst_rate:                { env: 'GST_RATE', default: '0.05', group: 'pricing', label: 'GST rate (0.05 = 5%)', type: 'decimal' },
  gst_number:              { env: 'GST_NUMBER', default: '', group: 'pricing', label: 'GST/HST registration number (printed on receipts)' },
  stripe_secret_key:       { env: 'STRIPE_SECRET_KEY', default: '', group: 'stripe', label: 'Stripe secret key (sk_test_… / sk_live_…)', secret: true },
  stripe_publishable_key:  { env: 'STRIPE_PUBLISHABLE_KEY', default: '', group: 'stripe', label: 'Stripe publishable key (pk_…)' },
  stripe_webhook_secret:   { env: 'STRIPE_WEBHOOK_SECRET', default: '', group: 'stripe', label: 'Stripe webhook signing secret (whsec_…)', secret: true },
  stripe_tax:              { env: 'STRIPE_TAX', default: '0', group: 'stripe', label: 'Use Stripe Tax instead of the fixed GST line (1 = yes)', type: 'int' },
  mail_provider:           { env: 'MAIL_PROVIDER', default: '', group: 'email', label: 'Email provider: smtp | resend | none' },
  smtp_url:                { env: 'SMTP_URL', default: '', group: 'email', label: 'SMTP URL (smtp://user:pass@host:587)', secret: true },
  resend_api_key:          { env: 'RESEND_API_KEY', default: '', group: 'email', label: 'Resend API key', secret: true },
  mail_from_name:          { env: 'MAIL_FROM_NAME', default: 'Canada Careers', group: 'email', label: 'Sender name' },
  mail_from_email:         { env: 'MAIL_FROM_EMAIL', default: '', group: 'email', label: 'Sender email address (must be verified with your provider)' },
  support_email:           { env: 'SUPPORT_EMAIL', default: '', group: 'support', label: 'Where Contact Us messages are delivered (comma-separated for several)' },
  support_name:            { env: 'SUPPORT_NAME', default: 'Support', group: 'support', label: 'Support contact name shown on the site' },
  google_maps_api_key:     { env: 'GOOGLE_MAPS_API_KEY', default: '', group: 'maps', label: 'Google Maps API key (Maps JavaScript, Places, Geocoding)', secret: true },
  maps_provider:           { env: 'MAPS_PROVIDER', default: 'auto', group: 'maps', label: 'Map provider: auto | google | osm' },
  admin_passcode:          { env: 'ADMIN_PASSCODE', default: '', group: 'access', label: 'Passcode required to open Integrations', secret: true },
  jobbank_sync:            { env: 'JOBBANK_SYNC', default: 'on', group: 'jobbank', label: 'Daily Job Bank reference import: on | off' },
};

const keyBytes = () => crypto.createHash('sha256').update('cc-settings:' + (process.env.SETTINGS_KEY || process.env.SESSION_SECRET || 'dev')).digest();
function encrypt(plain) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function decrypt(v) {
  if (!v || !String(v).startsWith('enc:v1:')) return v;
  try {
    const [, , iv, tag, ct] = String(v).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch (e) { console.error('[settings] cannot decrypt', e.message); return ''; }
}

let cache = null, cacheAt = 0;
const TTL = 5000;
async function loadAll() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const rows = await db.many('SELECT key, value FROM settings');
  cache = Object.fromEntries(rows.map(r => [r.key, decrypt(r.value)])); cacheAt = Date.now();
  return cache;
}
/** Effective value: DB (non-empty) > env > default. */
async function get(key) {
  const def = DEFS[key] || {};
  const all = await loadAll();
  const v = all[key];
  if (v !== undefined && v !== null && String(v) !== '') return String(v);
  if (def.env && process.env[def.env]) return String(process.env[def.env]);
  return def.default === undefined ? '' : String(def.default);
}
async function getMany(keys) { const out = {}; for (const k of keys) out[k] = await get(k); return out; }
/** Where the effective value comes from: 'db' | 'env' | 'default' */
async function source(key) {
  const all = await loadAll(); const def = DEFS[key] || {};
  if (all[key] !== undefined && all[key] !== '') return 'db';
  if (def.env && process.env[def.env]) return 'env';
  return 'default';
}
async function set(key, value, userId) {
  const def = DEFS[key] || {};
  const stored = def.secret && value ? encrypt(value) : String(value ?? '');
  await db.query(`INSERT INTO settings(key, value, is_secret, updated_at, updated_by) VALUES ($1,$2,$3,now(),$4)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, is_secret=EXCLUDED.is_secret, updated_at=now(), updated_by=EXCLUDED.updated_by`, [key, stored, !!def.secret, userId || null]);
  cache = null;
}
const invalidate = () => { cache = null; };
/** Masked display for secrets: "sk_live_••••1234" */
const mask = (v) => (!v ? '' : String(v).length <= 8 ? '••••' : `${String(v).slice(0, 7)}••••${String(v).slice(-4)}`);

module.exports = { DEFS, get, getMany, set, source, invalidate, mask, encrypt, decrypt };
