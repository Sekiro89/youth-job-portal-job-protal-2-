'use strict';
// Billing core — provider-agnostic API used by routes/billing.js and jobs/renewals.js.
// One subscription per job posting, priced by the PAYER's role (client decision 2026-09-09):
//   employers   $14.99 + GST 5% ($0.75) = $15.74 CAD per month
//   consultants  $9.99 + GST 5% ($0.50) = $10.49 CAD per month
// renewing until cancelled. getPricing(role) resolves the current price; ensureSubscription() snapshots it onto the
// subscriptions row (price_cents/tax_rate/tax_cents/total_cents) and EVERYTHING after that — checkout, sandbox card
// page, renewals, receipts, emails, /billing totals — reads the snapshot, never the current price.
// EVERY piece of configuration (Stripe keys, GST rate/number, prices, public URL, Stripe Tax) is read through
// lib/settings at call time — the client edits them in /admin/integrations and they take effect on the next request,
// no restart. Precedence is settings.get()'s: DB (panel) > .env > lib/constants. `await mode()` is 'stripe' when a
// Stripe secret key is configured, otherwise 'sandbox' (simulated card, always succeeds on renewal). The Stripe client
// is built lazily and cached PER KEY STRING, so pasting a new key in the panel swaps the client on the next call.
// Every successful charge goes through recordPayment(), which is the single place that writes a payments row,
// issues a receipt number, activates the job and emails the receipt.
//
// Admin-panel API (never throws; all return plain objects): testConnection(), catalogStatus(), setupCatalog(),
// createWebhookEndpoint(url). scripts/stripe-setup.js is a thin CLI over the same functions.
//
// Stripe notes (SDK 17.7.0, API version 2025-02-24.acacia pinned by the SDK):
//  - Checkout Session in `subscription` mode. Line items come from Prices with role-specific lookup_keys
//    (`cc_posting_employer_monthly` / `cc_gst_employer_monthly`, `cc_posting_consultant_monthly` /
//    `cc_gst_consultant_monthly`, created by setupCatalog()) when they exist and match the subscription's
//    snapshot, else inline `price_data`. With setting stripe_tax=1 the GST line is dropped and Stripe Tax
//    computes Canadian taxes (needs a tax registration in the Stripe dashboard).
//  - One Stripe Customer per Canada Careers user: created on the first checkout, reused afterwards (found through
//    subscriptions.provider_customer_id), so the Customer Portal shows all of a user's postings.
//  - Activation happens ONLY on `invoice.paid` (idempotent on the invoice id). `checkout.session.completed` just
//    links ids. Period fields are parsed defensively because newer API versions moved `current_period_*` from
//    the Subscription to its items and invoice lines carry their own `period`.
//  - BILLING_FAKE_STRIPE=1 (never in production) swaps the SDK client for the in-memory fake exported by
//    scripts/test-stripe.js so the whole Stripe path can be proven offline; signature verification stays real.
const crypto = require('crypto');
const db = require('./db');
const jobs = require('./jobs');
const mail = require('./mail');
const auth = require('./auth');
const C = require('./constants');
const settings = require('./settings');
const { escapeHtml, money, formatDate } = require('./helpers');

const isProd = process.env.NODE_ENV === 'production';
const flag = (v) => /^(1|true|yes)$/i.test(String(v || ''));

// ------------------------------------------------------------------ provider (everything read from lib/settings at call time)
const ROLES = ['employer', 'consultant'];
const LOOKUP_KEYS = {
  employer: { posting: 'cc_posting_employer_monthly', gst: 'cc_gst_employer_monthly' },
  consultant: { posting: 'cc_posting_consultant_monthly', gst: 'cc_gst_consultant_monthly' },
};
const ROLE_LABEL = { employer: 'employer', consultant: 'third party consultant' };
/** Pricing role for a payer: consultants pay the consultant price, everyone else (employers, admins testing) the employer price. */
const pricingRole = (roleOrUser) => ((roleOrUser && typeof roleOrUser === 'object' ? roleOrUser.role : roleOrUser) === 'consultant' ? 'consultant' : 'employer');
const WEBHOOK_EVENTS = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'];

/** Public site URL without a trailing slash (settings public_url > env PUBLIC_URL > default). */
async function publicUrl() { return (await settings.get('public_url') || 'http://localhost:3900').replace(/\/$/, ''); }
/** Configured secret key ('' when none). */
const secretKey = () => settings.get('stripe_secret_key');
/** 'test' | 'live' | null from a key prefix. */
const keyMode = (key) => (/^sk_live_/.test(key || '') ? 'live' : key ? 'test' : null);

let _injected = null;                 // test hook (setStripeClient)
let _fake = null;                     // BILLING_FAKE_STRIPE client (built once)
let _client = { key: null, client: null };   // lazily built SDK client, cached by key string
const fakeRequested = () => !isProd && flag(process.env.BILLING_FAKE_STRIPE);
/**
 * The Stripe client for the CURRENTLY configured key, or null when no key is set. Rebuilt whenever the key string
 * changes (a new key pasted in /admin/integrations is used on the very next call — no restart).
 * Non-production: BILLING_FAKE_STRIPE=1 returns the in-memory fake from scripts/test-stripe.js (built once).
 */
async function stripe() {
  if (_injected) return _injected;
  if (fakeRequested()) {
    if (!_fake) _fake = require('../scripts/test-stripe').createFakeStripe({ webhookSecret: await settings.get('stripe_webhook_secret') || undefined });
    return _fake;
  }
  const key = await secretKey();
  if (!key) { _client = { key: null, client: null }; return null; }
  if (_client.key !== key) _client = { key, client: require('stripe')(key, { appInfo: { name: 'Youth Careers Canada', url: await publicUrl() } }) };
  return _client.client;
}
/** Test hook: inject a client (non-production only); null removes the injection. */
function setStripeClient(client) { if (isProd) throw new Error('setStripeClient is not available in production'); _injected = client || null; priceCache = {}; }
/** 'stripe' when a secret key is configured (or the fake is requested outside production), else 'sandbox'. */
async function mode() { return (fakeRequested() || await secretKey()) ? 'stripe' : 'sandbox'; }
const providerName = (p) => (p === 'stripe' ? 'Stripe' : 'Sandbox (test payment)');
async function useStripeTax() { return flag(await settings.get('stripe_tax')); }

// Startup diagnostics (async: they read settings from the DB): production running without real payments must be loud.
setImmediate(async () => {
  try {
    const [key, whsec] = await Promise.all([secretKey(), settings.get('stripe_webhook_secret')]);
    if (isProd && !key) console.warn('[billing] WARNING: SANDBOX payment mode in production — postings are "paid" with a simulated card and no money is collected. Paste the Stripe keys in /admin/integrations (see docs/STRIPE-GO-LIVE.md).');
    if (key && !whsec) console.warn('[billing] WARNING: a Stripe secret key is configured but no webhook signing secret — Stripe webhooks will be rejected (400) and postings will not activate until /billing/success reconciles them. Use "Create prices & webhook" in /admin/integrations.');
  } catch (e) { console.warn('[billing] startup check skipped:', e.message); }
  if (isProd && flag(process.env.BILLING_FAKE_STRIPE)) console.warn('[billing] BILLING_FAKE_STRIPE is ignored in production.');
  if (process.env.POSTING_PRICE_CENTS) console.warn('[billing] POSTING_PRICE_CENTS is no longer used (pricing is per role since 2026-09-09) — set the prices in /admin/integrations (or EMPLOYER_PRICE_CENTS / CONSULTANT_PRICE_CENTS in .env) and remove it.');
});

// ------------------------------------------------------------------ pricing
/** Test hook: forget cached settings + resolved Stripe prices (non-production only). */
function resetPricingCache() { if (isProd) throw new Error('resetPricingCache is not available in production'); settings.invalidate(); priceCache = {}; }

const posInt = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
const PRICING_KEYS = ['employer_price_cents', 'consultant_price_cents', 'gst_rate', 'gst_number'];
/**
 * Current price for a payer role ('employer' | 'consultant'; a user object is accepted too).
 * Settings employer_price_cents / consultant_price_cents / gst_rate / gst_number (each: panel > .env > default;
 * lib/constants PRICING as the last resort); tax rounded to the cent.
 * Returns { role, price_cents, gst_rate, tax_cents, total_cents, currency, gst_label, gst_number }.
 */
async function getPricing(role) {
  role = pricingRole(role);
  const s = await settings.getMany(PRICING_KEYS);
  const price_cents = posInt(s[`${role}_price_cents`]) || C.priceCentsFor(role);
  const rate = Number(s.gst_rate);
  const gst_rate = s.gst_rate !== '' && Number.isFinite(rate) && rate >= 0 ? rate : C.PRICING.gst_rate;
  const tax_cents = Math.round(price_cents * gst_rate);
  const gst_number = (s.gst_number || '').trim() || null;
  return { role, price_cents, gst_rate, tax_cents, total_cents: price_cents + tax_cents, currency: C.PRICING.currency, gst_label: gstLabel(gst_rate), gst_number };
}
/** { employer: pricing, consultant: pricing } — for the landing copy, the Stripe catalog and admin pages. */
async function getAllPricing() {
  const out = {};
  for (const r of ROLES) out[r] = await getPricing(r);
  return out;
}
/** The pricing snapshot stored on a subscription row, in the same shape as getPricing() (gst_number from settings).
 *  `role` is the payer's role (used only to pick the Stripe lookup keys); defaults to the row's payer. */
async function snapshotPricing(sub, role) {
  if (!role) { const u = await db.one('SELECT role FROM users WHERE id=$1', [sub.payer_user_id]); role = u && u.role; }
  const gst_rate = Number(sub.tax_rate);
  return { role: pricingRole(role), price_cents: sub.price_cents, gst_rate, tax_cents: sub.tax_cents, total_cents: sub.total_cents, currency: sub.currency || C.PRICING.currency,
           gst_label: gstLabel(gst_rate), gst_number: (await settings.get('gst_number') || '').trim() || null };
}
/** Branding for receipts/emails: { site_name, contact_address, public_url, gst_number }. */
async function billFrom() {
  const s = await settings.getMany(['site_name', 'contact_address', 'public_url', 'gst_number']);
  return { site_name: s.site_name || 'Youth Careers Canada', contact_address: (s.contact_address || '').trim(), public_url: (s.public_url || 'http://localhost:3900').replace(/\/$/, ''), gst_number: (s.gst_number || '').trim() || null };
}
function gstLabel(rate) {
  const pct = Number(rate) * 100;
  return `GST (${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '')}%)`;
}
/** Same calendar day next month (clamped to month end): Jan 31 -> Feb 28/29. */
function addMonth(d, n = 1) {
  const s = new Date(d);
  const r = new Date(s.getTime());
  r.setUTCMonth(r.getUTCMonth() + n);
  if (r.getUTCDate() !== s.getUTCDate()) r.setUTCDate(0);
  return r;
}

// ------------------------------------------------------------------ lookups
async function loadJob(jobId) {
  return db.one(`SELECT j.*, p.company_name, p.slug AS company_slug, p.owner_user_id, p.contact_email
                 FROM jobs j JOIN employer_profiles p ON p.id = j.employer_profile_id WHERE j.id = $1`, [jobId]);
}
const loadSubscriptionByJob = (jobId) => db.one('SELECT * FROM subscriptions WHERE job_id=$1', [jobId]);
const loadSubscriptionByCheckout = (checkoutId) => db.one('SELECT * FROM subscriptions WHERE provider_checkout_id=$1', [checkoutId]);
const idOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && v.id ? v.id : null);
const isId = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

/** Create or reset the subscription row for a job so it is `pending` with the current pricing snapshot for the
 *  PAYER's role (user.role). If the row is still paid-up (active and period not over) it is returned untouched. */
async function ensureSubscription(job, user) {
  const p = await getPricing(user);
  const m = await mode();
  const existing = await loadSubscriptionByJob(job.id);
  if (existing && existing.status === 'active' && existing.current_period_end && new Date(existing.current_period_end) > new Date()) return existing;
  // Still-pending row with the same price snapshot: keep it (and its checkout link) so Back/refresh does not invalidate an open checkout.
  if (existing && existing.status === 'pending' && existing.provider === m && existing.price_cents === p.price_cents && Number(existing.tax_rate) === p.gst_rate && existing.tax_cents === p.tax_cents && Number(existing.payer_user_id) === Number(user.id)) return existing;
  const s = existing && existing.provider === 'stripe' && existing.provider_subscription_id && ['active', 'past_due'].includes(existing.status) ? await stripe() : null;
  if (s) {
    try { await s.subscriptions.cancel(existing.provider_subscription_id); } catch (e) { if (e.code !== 'resource_missing') console.warn('[billing] could not cancel stale stripe subscription', e.message); }
  }
  const vals = [job.employer_profile_id, user.id, m, p.price_cents, p.gst_rate, p.tax_cents, p.total_cents, p.currency];
  if (existing) {
    // provider_customer_id is kept on purpose: it is how we reuse the Stripe Customer.
    return db.one(`UPDATE subscriptions SET status='pending', employer_profile_id=$2, payer_user_id=$3, provider=$4, price_cents=$5, tax_rate=$6, tax_cents=$7,
                   total_cents=$8, currency=$9, cancel_at_period_end=false, cancelled_at=NULL, provider_checkout_id=NULL, provider_subscription_id=NULL, updated_at=now()
                   WHERE id=$1 RETURNING *`, [existing.id, ...vals]);
  }
  return db.one(`INSERT INTO subscriptions(job_id, employer_profile_id, payer_user_id, provider, price_cents, tax_rate, tax_cents, total_cents, currency, status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`, [job.id, ...vals]);
}

// ------------------------------------------------------------------ Stripe customers & prices
/** The user's Stripe Customer id if any of their subscriptions already carries one. */
async function findStripeCustomerId(userId) {
  const row = await db.one(`SELECT provider_customer_id FROM subscriptions WHERE payer_user_id=$1 AND provider='stripe' AND provider_customer_id IS NOT NULL
                            ORDER BY updated_at DESC, id DESC LIMIT 1`, [userId]);
  return row ? row.provider_customer_id : null;
}
/** Find-or-create the Stripe Customer for a user and remember it on the given subscription row. */
async function ensureStripeCustomer(user, sub) {
  let customerId = await findStripeCustomerId(user.id);
  if (!customerId) {
    const c = await (await stripe()).customers.create({ email: user.email, name: user.name || undefined, metadata: { user_id: String(user.id), source: 'canada-careers' } });
    customerId = c.id;
  }
  if (sub && sub.provider_customer_id !== customerId) await db.query("UPDATE subscriptions SET provider='stripe', provider_customer_id=$2, updated_at=now() WHERE id=$1", [sub.id, customerId]);
  return customerId;
}

let priceCache = {};   // role -> { at, ids }
/** Price ids for the posting fee and the GST line of one role: env STRIPE_PRICE_POSTING_<ROLE>/STRIPE_PRICE_GST_<ROLE>, else the
 *  role's lookup_keys (cached 10 min per role). A price is only used when its amount/currency/interval match the
 *  subscription snapshot `p` — so a stale catalog silently falls back to inline price_data rather than mischarging. */
async function resolvePriceIds(p) {
  const s = await stripe();
  const role = pricingRole(p.role);
  const keys = LOOKUP_KEYS[role];
  if (!s || !s.prices || typeof s.prices.list !== 'function') return { posting: null, gst: null };
  const cached = priceCache[role];
  if (cached && cached.ids && Date.now() - cached.at < 600000 && cached.price_cents === p.price_cents && cached.tax_cents === p.tax_cents && cached.client === s) return cached.ids;
  const R = role.toUpperCase();
  const ids = { posting: process.env[`STRIPE_PRICE_POSTING_${R}`] || null, gst: process.env[`STRIPE_PRICE_GST_${R}`] || null };
  if (!ids.posting || (!ids.gst && !(await useStripeTax()))) {
    try {
      const list = await s.prices.list({ lookup_keys: [keys.posting, keys.gst], active: true, limit: 10 });
      const ok = (price, cents) => price && price.active !== false && price.currency === 'cad' && price.unit_amount === cents && price.recurring && price.recurring.interval === 'month' && price.recurring.interval_count === 1;
      for (const price of list.data || []) {
        if (price.lookup_key === keys.posting && !ids.posting) ids.posting = ok(price, p.price_cents) ? price.id : null;
        if (price.lookup_key === keys.gst && !ids.gst) ids.gst = ok(price, p.tax_cents) ? price.id : null;
      }
    } catch (e) { console.warn('[billing] prices.list failed, using inline price_data:', e.message); }
  }
  priceCache[role] = { at: Date.now(), ids, price_cents: p.price_cents, tax_cents: p.tax_cents, client: s };
  return ids;
}

/** Build the Checkout Session line items from the subscription snapshot `p`: a Price by id when available, else inline price_data. */
async function checkoutLineItems(job, profile, p) {
  const ids = await resolvePriceIds(p);
  const roleLabel = ROLE_LABEL[pricingRole(p.role)];
  const items = [ids.posting
    ? { price: ids.posting, quantity: 1 }
    : { quantity: 1, price_data: { currency: 'cad', unit_amount: p.price_cents, recurring: { interval: 'month' },
        product_data: { name: `Job posting (monthly, ${roleLabel})`, description: `${job.title} · ${profile.company_name} · renews monthly until cancelled`, metadata: { job_id: String(job.id), payer_role: pricingRole(p.role) } } } }];
  if (!(await useStripeTax())) items.push(ids.gst
    ? { price: ids.gst, quantity: 1 }
    : { quantity: 1, price_data: { currency: 'cad', unit_amount: p.tax_cents, recurring: { interval: 'month' }, product_data: { name: p.gst_label, description: 'Goods and Services Tax (Canada)' } } });
  return items;
}

// ------------------------------------------------------------------ checkout
/** Returns { url, subscription }. Stripe mode -> hosted Checkout (subscription mode); sandbox -> /billing/sandbox/:id.
 *  Amounts sent to Stripe are the subscription row's snapshot (set by ensureSubscription for the payer's role). */
async function createCheckout(job, user, profile) {
  const sub = await ensureSubscription(job, user);
  const p = await snapshotPricing(sub, user.role);
  if (await mode() === 'stripe') {
    const s = await stripe();
    const site = await billFrom();
    const PUBLIC_URL = site.public_url;
    const meta = { job_id: String(job.id), subscription_id: String(sub.id), user_id: String(user.id), employer_profile_id: String(job.employer_profile_id), payer_role: p.role };
    let customer = null;
    try { customer = await ensureStripeCustomer(user, sub); } catch (e) { console.warn('[billing] customer create failed, falling back to customer_email:', e.message); }
    const params = {
      mode: 'subscription',
      ...(customer ? { customer, customer_update: { address: 'auto', name: 'auto' } } : { customer_email: user.email }),
      client_reference_id: String(sub.id),
      line_items: await checkoutLineItems(job, profile, p),
      currency: 'cad',
      locale: 'en',                        // Checkout has no 'en-CA'; amounts are shown in CAD regardless
      billing_address_collection: 'auto',
      metadata: meta,
      subscription_data: { metadata: meta, description: `${site.site_name} job posting #${job.id}: ${job.title}`.slice(0, 500) },
      ...(await useStripeTax() ? { automatic_tax: { enabled: true } } : {}),
      success_url: `${PUBLIC_URL}/billing/success?job=${job.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/billing/cancelled?job=${job.id}`,
    };
    const session = await s.checkout.sessions.create(params);
    await db.query("UPDATE subscriptions SET provider='stripe', provider_checkout_id=$2, provider_customer_id=COALESCE($3, provider_customer_id), updated_at=now() WHERE id=$1", [sub.id, session.id, idOf(session.customer) || customer]);
    return { url: session.url, subscription: sub, session };
  }
  const checkoutId = crypto.randomBytes(16).toString('hex');
  await db.query("UPDATE subscriptions SET provider='sandbox', provider_checkout_id=$2, updated_at=now() WHERE id=$1", [sub.id, checkoutId]);
  return { url: `/billing/sandbox/${checkoutId}`, subscription: sub };
}

/** Stripe Customer Portal (update card, see invoices, cancel). Returns the portal URL or null when the user has no Stripe customer. */
async function portalUrl(user, returnPath = '/billing') {
  const s = await stripe();
  if (!s || await mode() !== 'stripe') return null;
  const customer = await findStripeCustomerId(user.id);
  if (!customer) return null;
  const session = await s.billingPortal.sessions.create({ customer, return_url: `${await publicUrl()}${returnPath}` });
  return session.url;
}

// ------------------------------------------------------------------ payments
/**
 * Record a successful charge: payments row (receipt CC-YYYYMM-NNNNNN), subscription -> active with the new
 * period, job activated through period_end, receipt email, seeker notifications on the first payment.
 * Idempotent on (provider, provider_payment_id). Amounts default to the subscription snapshot; Stripe passes the
 * invoice's real amounts (so Stripe Tax totals are recorded exactly). Runs in its own transaction unless a client is given.
 */
async function recordPayment(subscriptionId, { provider, provider_payment_id, period_start, period_end, amount_cents, tax_cents, total_cents, customer_id }, client) {
  provider = provider || 'sandbox';
  const run = async (c) => {
    if (provider_payment_id) {
      const dup = (await c.query('SELECT * FROM payments WHERE provider=$1 AND provider_payment_id=$2', [provider, provider_payment_id])).rows[0];
      if (dup) return { payment: dup, duplicate: true };
    }
    const sub = (await c.query('SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [subscriptionId])).rows[0];
    if (!sub) throw new Error(`subscription ${subscriptionId} not found`);
    const amounts = paymentAmounts(sub, { amount_cents, tax_cents, total_cents });
    if (amounts.total_cents !== sub.total_cents) console.warn(`[billing] payment total ${amounts.total_cents} differs from subscription snapshot ${sub.total_cents} (sub ${sub.id}, ${provider} ${provider_payment_id || ''})`);
    const prior = (await c.query("SELECT count(*)::int AS n FROM payments WHERE job_id=$1 AND status='paid'", [sub.job_id])).rows[0].n;
    const payment = (await c.query(`
      INSERT INTO payments(subscription_id, job_id, payer_user_id, provider, provider_payment_id, receipt_number, amount_cents, tax_cents, total_cents, currency, status, period_start, period_end)
      VALUES ($1,$2,$3,$4,$5, 'CC-' || to_char(now() AT TIME ZONE 'America/Toronto', 'YYYYMM') || '-' || lpad(nextval('receipt_seq')::text, 6, '0'),
              $6,$7,$8,$9,'paid',$10,$11) RETURNING *`,
      [sub.id, sub.job_id, sub.payer_user_id, provider, provider_payment_id || null, amounts.amount_cents, amounts.tax_cents, amounts.total_cents, sub.currency, period_start, period_end])).rows[0];
    await c.query(`UPDATE subscriptions SET status='active', provider=$2, current_period_start=$3, current_period_end=$4, provider_customer_id=COALESCE($5, provider_customer_id), updated_at=now() WHERE id=$1`,
      [sub.id, provider, period_start, period_end, customer_id || null]);
    await jobs.activateJob(sub.job_id, period_end, c);
    return { payment, sub, first: prior === 0 };
  };
  const out = client ? await run(client) : await db.tx(run);
  if (out.duplicate) return out.payment;

  await auth.audit(out.sub.payer_user_id, 'billing.payment', 'payment', out.payment.id, { job_id: out.sub.job_id, receipt: out.payment.receipt_number, total_cents: out.payment.total_cents, provider, first: out.first });
  try { await sendReceiptEmail(out.payment.id); } catch (e) { console.error('[billing] receipt email failed', e.message); }
  if (out.first) {
    try {
      const matching = require('./matching');
      if (matching && typeof matching.notifySeekersForJob === 'function') await matching.notifySeekersForJob(out.sub.job_id);
    } catch (e) { console.warn('[billing] notifySeekersForJob skipped:', e.message); }
  }
  return out.payment;
}
/** Amounts for a payment row: explicit values win, otherwise the subscription snapshot; lines always add up to the total. */
function paymentAmounts(sub, given) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const total = num(given.total_cents) ?? ((num(given.amount_cents) ?? sub.price_cents) + (num(given.tax_cents) ?? sub.tax_cents));
  const tax = num(given.tax_cents) ?? (num(given.amount_cents) !== null ? total - num(given.amount_cents) : Math.min(sub.tax_cents, total));
  return { total_cents: total, tax_cents: tax, amount_cents: total - tax };
}

/** payment + job + payer + company in one row (for receipts and emails). */
async function loadPayment(paymentId) {
  return db.one(`SELECT pay.*, s.tax_rate, s.cancel_at_period_end, j.title AS job_title, j.slug AS job_slug, j.public_id AS job_public_id, j.city, j.province,
                        u.name AS payer_name, u.email AS payer_email, u.role AS payer_role, p.company_name, p.operating_name, p.id AS employer_profile_id, p.owner_user_id, p.city AS company_city, p.province AS company_province
                 FROM payments pay JOIN subscriptions s ON s.id = pay.subscription_id JOIN jobs j ON j.id = pay.job_id
                 JOIN users u ON u.id = pay.payer_user_id JOIN employer_profiles p ON p.id = j.employer_profile_id WHERE pay.id = $1`, [paymentId]);
}

async function sendReceiptEmail(paymentId) {
  const r = await loadPayment(paymentId);
  if (!r) return;
  const site = await billFrom();
  const PUBLIC_URL = site.public_url;
  const receiptUrl = `${PUBLIC_URL}/billing/receipt/${r.id}`;
  const rateLabel = pricingRole(r.payer_role) === 'consultant' ? 'third party consultant rate' : 'employer rate';
  const td = 'padding:8px 0;border-bottom:1px solid #e1e7ef';
  const gstNo = site.gst_number ? `<br>GST/HST registration no. <strong>${escapeHtml(site.gst_number)}</strong>` : '';
  const from = `${escapeHtml(site.site_name)}${site.contact_address ? ` · ${escapeHtml(site.contact_address)}` : ''}`;
  const pid = r.job_public_id ? ` · Posting ID ${escapeHtml(r.job_public_id)}` : '';
  const body = `
<p>Thank you — your payment for the posting <strong>${escapeHtml(r.job_title)}</strong> (${escapeHtml(r.company_name)}${pid}) was received.
The posting is live until <strong>${escapeHtml(formatDate(r.period_end))}</strong> and will renew automatically unless you cancel from Billing.</p>
<table style="width:100%;border-collapse:collapse;font-size:15px;margin:16px 0">
  <tr><td style="${td}">Job posting — monthly fee (${rateLabel})</td><td style="${td};text-align:right">${money(r.amount_cents)}</td></tr>
  <tr><td style="${td}">${escapeHtml(gstLabel(r.tax_rate))}</td><td style="${td};text-align:right">${money(r.tax_cents)}</td></tr>
  <tr><td style="padding:10px 0;font-weight:700">Total paid (CAD)</td><td style="padding:10px 0;text-align:right;font-weight:700">${money(r.total_cents)}</td></tr>
</table>
<p style="font-size:14px;color:#5a6b7e">Receipt number <strong>${escapeHtml(r.receipt_number)}</strong> · Paid ${escapeHtml(formatDate(r.paid_at))} via ${escapeHtml(providerName(r.provider))}<br>
Billing period ${escapeHtml(formatDate(r.period_start))} – ${escapeHtml(formatDate(r.period_end))}${gstNo}<br>
Billed by ${from}</p>
<p style="font-size:14px;color:#5a6b7e">All your receipts can be viewed and downloaded as PDF any time from <a href="${PUBLIC_URL}/billing">Billing</a> in your account.</p>`;
  const text = `Receipt ${r.receipt_number}\nJob posting: ${r.job_title} (${r.company_name})${r.job_public_id ? `\nPosting ID ${r.job_public_id}` : ''}\nMonthly fee (${rateLabel}) ${money(r.amount_cents)}\n${gstLabel(r.tax_rate)} ${money(r.tax_cents)}\nTotal ${money(r.total_cents)} CAD\nPeriod ${formatDate(r.period_start)} – ${formatDate(r.period_end)}${site.gst_number ? `\nGST/HST no. ${site.gst_number}` : ''}\nBilled by ${site.site_name}${site.contact_address ? `, ${site.contact_address}` : ''}\nView: ${receiptUrl}`;
  // No `from`: mail.js always sends from the configured system sender.
  await mail.send({ to: r.payer_email, subject: `Receipt ${r.receipt_number} — ${money(r.total_cents)} for "${r.job_title}"`, html: mail.layout('Payment receipt', body, { href: receiptUrl, label: 'View receipt' }, { publicUrl: PUBLIC_URL, siteName: site.site_name }), text });
}

async function sendPaymentFailedEmail(sub, reason) {
  const job = await loadJob(sub.job_id);
  const user = await db.one('SELECT name, email FROM users WHERE id=$1', [sub.payer_user_id]);
  if (!job || !user) return;
  const site = await billFrom();
  const where = sub.provider === 'stripe' ? `${site.public_url}/billing/portal` : `${site.public_url}/billing`;
  const body = `<p>We could not collect the monthly fee of <strong>${money(sub.total_cents)}</strong> for the posting <strong>${escapeHtml(job.title)}</strong>.</p>
<p>${reason ? escapeHtml(reason) + ' ' : ''}Please update your card. The posting stays live until <strong>${escapeHtml(formatDate(sub.current_period_end))}</strong>; if payment is not received by then it will be removed from public view.</p>`;
  await mail.send({ to: user.email, subject: `Payment failed for "${job.title}" — action needed`, html: mail.layout('Payment failed', body, { href: where, label: 'Update payment method' }, { publicUrl: site.public_url, siteName: site.site_name }), text: `Payment failed for ${job.title}. Update your card at ${where}` });
}

// ------------------------------------------------------------------ cancel / resume
/** now=true: cancel immediately and archive the job. Otherwise the posting stays live until current_period_end. */
async function cancel(jobId, user, { now = false } = {}) {
  const sub = await loadSubscriptionByJob(jobId);
  if (!sub) { const e = new Error('No subscription for this posting'); e.status = 404; throw e; }
  const immediate = now || sub.status !== 'active' || !sub.current_period_end || new Date(sub.current_period_end) <= new Date();
  const s = sub.provider === 'stripe' && sub.provider_subscription_id ? await stripe() : null;
  if (s) {
    try {
      if (immediate) await s.subscriptions.cancel(sub.provider_subscription_id, { invoice_now: false, prorate: false });
      else await s.subscriptions.update(sub.provider_subscription_id, { cancel_at_period_end: true });
    } catch (e) { if (e.code !== 'resource_missing') throw e; }
  }
  if (immediate) {
    await db.tx(async (c) => {
      await c.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now(), cancel_at_period_end=false, updated_at=now() WHERE id=$1", [sub.id]);
      await jobs.archiveJob(jobId, 'cancelled', c);
    });
  } else {
    await db.query('UPDATE subscriptions SET cancel_at_period_end=true, updated_at=now() WHERE id=$1', [sub.id]);
  }
  await auth.audit(user && user.id, immediate ? 'billing.cancel_now' : 'billing.cancel_at_period_end', 'job', jobId, { subscription_id: sub.id, provider: sub.provider });
  return { immediate, period_end: sub.current_period_end };
}

/** Undo cancel-at-period-end (only while the subscription is still active). */
async function resume(jobId, user) {
  const sub = await loadSubscriptionByJob(jobId);
  if (!sub) { const e = new Error('No subscription for this posting'); e.status = 404; throw e; }
  if (sub.status !== 'active' || !sub.cancel_at_period_end) { const e = new Error('This subscription is not scheduled to cancel.'); e.status = 409; throw e; }
  const s = sub.provider === 'stripe' && sub.provider_subscription_id ? await stripe() : null;
  if (s) {
    try { await s.subscriptions.update(sub.provider_subscription_id, { cancel_at_period_end: false }); }
    catch (e) {
      if (e.code !== 'resource_missing') throw e;
      const err = new Error('This subscription has already ended at Stripe. Publish the posting again to start a new one.'); err.status = 409; throw err;
    }
  }
  await db.query('UPDATE subscriptions SET cancel_at_period_end=false, updated_at=now() WHERE id=$1', [sub.id]);
  await auth.audit(user && user.id, 'billing.resume', 'job', jobId, { subscription_id: sub.id, provider: sub.provider });
  return sub;
}

// ------------------------------------------------------------------ Stripe object parsing (defensive across API versions)
const sec = (s) => (typeof s === 'number' && s > 0 ? new Date(s * 1000) : null);
/** Stripe subscription id an invoice belongs to: `subscription` (<= 2025-02) or `parent.subscription_details.subscription` (>= 2025-03). */
function invoiceSubscriptionId(inv) {
  return idOf(inv.subscription) || idOf(inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || null;
}
/** Metadata Stripe copies onto the invoice from the subscription. */
function invoiceMetadata(inv) {
  return (inv.subscription_details && inv.subscription_details.metadata) || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.metadata) || null;
}
/** Billing period covered by an invoice: the widest line period, else the invoice's own period fields. */
function invoicePeriod(inv) {
  const lines = (inv.lines && inv.lines.data) || [];
  let start = null, end = null;
  for (const l of lines) {
    if (!l.period) continue;
    if (l.period.start && (!start || l.period.start < start)) start = l.period.start;
    if (l.period.end && (!end || l.period.end > end)) end = l.period.end;
  }
  if (end) return { period_start: sec(start), period_end: sec(end) };
  return { period_start: sec(inv.period_start), period_end: sec(inv.period_end) };
}
/** Tax amount on an invoice: `tax` (<= 2025-02) or the sum of `total_taxes[]` (>= 2025-03). null when the invoice has no tax lines. */
function invoiceTaxCents(inv) {
  if (typeof inv.tax === 'number') return inv.tax;
  if (Array.isArray(inv.total_taxes)) return inv.total_taxes.reduce((a, t) => a + (Number(t.amount) || 0), 0);
  return null;
}
function invoiceIsPaid(inv) {
  if (inv.status) return inv.status === 'paid';
  if (typeof inv.paid === 'boolean') return inv.paid;
  return typeof inv.amount_paid === 'number' && inv.amount_paid > 0 && inv.amount_paid >= (inv.amount_due || 0);
}
/** current period of a Stripe subscription: on the subscription (<= 2025-02) or on its items (>= 2025-03). */
function subscriptionPeriod(s) {
  const item = s.items && s.items.data && s.items.data[0];
  return { start: sec(s.current_period_start) || (item ? sec(item.current_period_start) : null), end: sec(s.current_period_end) || (item ? sec(item.current_period_end) : null) };
}

/** Find our subscription for a Stripe subscription id; falls back to the metadata Stripe copied onto the subscription/invoice, then to the API. */
async function subForStripeSubscription(stripeSubId, metadata) {
  if (!stripeSubId) return null;
  let sub = await db.one('SELECT * FROM subscriptions WHERE provider_subscription_id=$1', [stripeSubId]);
  if (sub) return sub;
  let meta = metadata;
  const s = !(meta && isId(meta.subscription_id)) ? await stripe() : null;
  if (s) {
    try { meta = (await s.subscriptions.retrieve(stripeSubId)).metadata; }
    catch (e) { if (e.code === 'resource_missing') return null; throw e; }   // API outage etc. -> throw so the webhook returns 500 and Stripe retries
  }
  if (meta && isId(meta.subscription_id)) {
    sub = await db.one("UPDATE subscriptions SET provider='stripe', provider_subscription_id=$2, updated_at=now() WHERE id=$1 AND provider_subscription_id IS DISTINCT FROM $2 RETURNING *", [Number(meta.subscription_id), stripeSubId])
       || await db.one('SELECT * FROM subscriptions WHERE id=$1', [Number(meta.subscription_id)]);
  }
  return sub;
}

async function cancelSubscriptionRow(sub) {
  await db.tx(async (c) => {
    await c.query("UPDATE subscriptions SET status='cancelled', cancelled_at=COALESCE(cancelled_at, now()), cancel_at_period_end=false, updated_at=now() WHERE id=$1", [sub.id]);
    await jobs.archiveJob(sub.job_id, 'cancelled', c);
  });
}

/** Handle a verified Stripe event. Returns a short description of what happened (for logs). Throws on failure so the webhook route answers 500 and Stripe retries. */
async function handleStripeEvent(event) {
  const obj = event.data && event.data.object;
  if (!obj) return 'event without data.object';
  switch (event.type) {
    case 'checkout.session.completed': {
      // Link ids only. The job is activated by invoice.paid (money actually collected), never here.
      const subId = obj.metadata && obj.metadata.subscription_id || obj.client_reference_id;
      if (!isId(subId)) return 'no subscription_id in metadata';
      const r = await db.query(`UPDATE subscriptions SET provider='stripe', provider_customer_id=COALESCE($2, provider_customer_id), provider_subscription_id=COALESCE($3, provider_subscription_id), provider_checkout_id=$4, updated_at=now() WHERE id=$1`,
        [Number(subId), idOf(obj.customer), idOf(obj.subscription), obj.id]);
      return r.rowCount ? `linked subscription ${subId} (${idOf(obj.subscription) || 'no stripe sub yet'})` : `subscription ${subId} not found`;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const stripeSubId = invoiceSubscriptionId(obj);
      if (!stripeSubId) return 'invoice without subscription (ignored)';
      if (!invoiceIsPaid(obj)) return `invoice ${obj.id} not paid (${obj.status})`;
      const sub = await subForStripeSubscription(stripeSubId, invoiceMetadata(obj));
      if (!sub) return `invoice ${obj.id} for unknown subscription ${stripeSubId}`;
      const { period_start, period_end } = invoicePeriod(obj);
      if (!period_end) return `invoice ${obj.id} without period`;
      const tax = invoiceTaxCents(obj);
      const pay = await recordPayment(sub.id, {
        provider: 'stripe', provider_payment_id: obj.id, period_start: period_start || new Date(), period_end,
        total_cents: typeof obj.amount_paid === 'number' ? obj.amount_paid : undefined,
        tax_cents: tax !== null && tax > 0 ? tax : undefined,       // Stripe Tax; with the explicit GST line the snapshot split is kept
        customer_id: idOf(obj.customer),
      });
      return `payment ${pay.receipt_number} (invoice ${obj.id})`;
    }
    case 'invoice.payment_failed': {
      const stripeSubId = invoiceSubscriptionId(obj);
      if (!stripeSubId) return 'failed invoice without subscription (ignored)';
      const sub = await subForStripeSubscription(stripeSubId, invoiceMetadata(obj));
      if (!sub) return `failed invoice ${obj.id} for unknown subscription`;
      const r = await db.query("UPDATE subscriptions SET status='past_due', updated_at=now() WHERE id=$1 AND status IN ('active','past_due') RETURNING id", [sub.id]);
      if (!r.rowCount) return `subscription ${sub.id} is ${sub.status}; failed invoice noted`;
      if (sub.status !== 'past_due') {
        try { await sendPaymentFailedEmail(sub, obj.last_finalization_error && obj.last_finalization_error.message); } catch (e) { console.error('[billing] failed email', e.message); }
      }
      return `subscription ${sub.id} past_due`;
    }
    case 'customer.subscription.deleted': {
      const sub = await subForStripeSubscription(obj.id, obj.metadata);
      if (!sub) return `deleted unknown subscription ${obj.id}`;
      if (sub.status === 'cancelled') return `subscription ${sub.id} already cancelled`;
      await cancelSubscriptionRow(sub);
      return `subscription ${sub.id} cancelled, job ${sub.job_id} archived`;
    }
    case 'customer.subscription.updated': {
      const sub = await subForStripeSubscription(obj.id, obj.metadata);
      if (!sub) return `updated unknown subscription ${obj.id}`;
      if (['canceled', 'incomplete_expired'].includes(obj.status)) {
        if (sub.status !== 'cancelled') await cancelSubscriptionRow(sub);
        return `subscription ${sub.id} cancelled (status ${obj.status})`;
      }
      const period = subscriptionPeriod(obj);
      // Status: only the active <-> past_due transitions are mirrored here; activation is invoice.paid's job.
      let status = null;
      if (['past_due', 'unpaid'].includes(obj.status) && ['active', 'past_due'].includes(sub.status)) status = 'past_due';
      if (['active', 'trialing'].includes(obj.status) && sub.status === 'past_due') status = 'active';
      await db.query(`UPDATE subscriptions SET cancel_at_period_end=$2, status=COALESCE($3::subscription_status, status),
                        current_period_start=CASE WHEN status IN ('active','past_due') THEN COALESCE($4, current_period_start) ELSE current_period_start END,
                        current_period_end=CASE WHEN status IN ('active','past_due') THEN COALESCE($5, current_period_end) ELSE current_period_end END,
                        provider_customer_id=COALESCE(provider_customer_id, $6), updated_at=now() WHERE id=$1`,
        [sub.id, !!obj.cancel_at_period_end, status, period.start, period.end, idOf(obj.customer)]);
      return `subscription ${sub.id} synced (status ${obj.status}, cancel_at_period_end=${!!obj.cancel_at_period_end}${period.end ? `, period_end ${period.end.toISOString().slice(0, 10)}` : ''})`;
    }
    default:
      return `ignored ${event.type}`;
  }
}

/** After a Stripe success redirect: pull the session so the page is correct even before the webhook lands.
 *  `expectedJobId` guards against a session id that belongs to another posting. */
async function reconcileCheckoutSession(sessionId, expectedJobId) {
  const s = await stripe();
  if (!s || !sessionId) return null;
  const session = await s.checkout.sessions.retrieve(sessionId, { expand: ['subscription.latest_invoice'] });
  if (expectedJobId && session.metadata && session.metadata.job_id && String(session.metadata.job_id) !== String(expectedJobId)) {
    console.warn(`[billing] reconcile: session ${sessionId} is for job ${session.metadata.job_id}, not ${expectedJobId}`);
    return null;
  }
  if (session.status && session.status !== 'complete') return session;
  await handleStripeEvent({ type: 'checkout.session.completed', data: { object: session } });
  const sub = typeof session.subscription === 'object' ? session.subscription : null;
  const inv = sub && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  if (inv && invoiceIsPaid(inv)) await handleStripeEvent({ type: 'invoice.paid', data: { object: inv } });
  return session;
}

// ------------------------------------------------------------------ Stripe catalog + webhook endpoint (admin panel / setup CLI)
// The Products/Prices are found again by metadata (cc_product) / lookup_key on later runs, so nothing is duplicated.
// If a price changed, a new Price is created and the lookup_key moved to it (transfer_lookup_key); existing Stripe
// subscriptions keep the Price they were created with — renewals never re-price.
const priceMatches = (price, cents) => !!price && price.active !== false && price.currency === 'cad' && price.unit_amount === cents && !!price.recurring && price.recurring.interval === 'month' && (price.recurring.interval_count || 1) === 1;
async function findProduct(client, key) {
  const r = await client.products.search({ query: `active:'true' AND metadata['cc_product']:'${key}'`, limit: 5 });
  return (r.data || [])[0] || null;
}
async function findPrice(client, lookupKey) {
  const r = await client.prices.list({ lookup_keys: [lookupKey], active: true, limit: 5 });
  return (r.data || [])[0] || null;
}
/** Ensure Product + Price for one catalog line. Returns { price, created }. */
async function ensureLine(client, { key, name, description, lookupKey, cents, taxBehavior }, log) {
  let product = await findProduct(client, key);
  if (!product) { product = await client.products.create({ name, description, metadata: { cc_product: key, app: 'canada-careers' } }); log(`created product ${product.id} "${name}"`); }
  else log(`product ${product.id} "${product.name}" exists`);
  let price = await findPrice(client, lookupKey);
  if (priceMatches(price, cents)) { log(`price ${price.id} (${lookupKey}) = ${cents} CAD cents / month exists`); return { price, created: false }; }
  if (price) log(`price ${price.id} (${lookupKey}) is ${price.unit_amount} ${price.currency}/${price.recurring && price.recurring.interval} — creating a new one and moving the lookup_key`);
  price = await client.prices.create({ product: product.id, currency: 'cad', unit_amount: cents, recurring: { interval: 'month', interval_count: 1 }, lookup_key: lookupKey, transfer_lookup_key: true, nickname: `${name} — ${(cents / 100).toFixed(2)} CAD/month`, ...(taxBehavior ? { tax_behavior: taxBehavior } : {}), metadata: { app: 'canada-careers' } });
  log(`created price ${price.id} (${lookupKey}) = ${cents} CAD cents / month`);
  return { price, created: true };
}
/** Idempotently create the catalog for ONE role. Returns { posting, gst } Prices (gst null with Stripe Tax) plus `_created` (lookup keys created this run). */
async function ensureRoleCatalog(client, role, pricing, { log = console.log, stripeTax = false } = {}) {
  const keys = LOOKUP_KEYS[role]; if (!keys) throw new Error(`unknown pricing role ${role}`);
  const created = [];
  const posting = await ensureLine(client, { key: `posting_${role}`, name: `Job posting (monthly) — ${ROLE_LABEL[role]}`, description: `One job posting at the ${ROLE_LABEL[role]} rate, renewed monthly until cancelled.`, lookupKey: keys.posting, cents: pricing.price_cents, taxBehavior: 'exclusive' }, log);
  if (posting.created) created.push(keys.posting);
  let gst = null;
  if (!stripeTax) {
    gst = await ensureLine(client, { key: `gst_${role}`, name: `${pricing.gst_label || 'GST (5%)'} — ${role} posting`, description: `Goods and Services Tax (Canada), charged on the ${ROLE_LABEL[role]} posting fee.`, lookupKey: keys.gst, cents: pricing.tax_cents }, log);
    if (gst.created) created.push(keys.gst);
  }
  return { posting: posting.price, gst: gst ? gst.price : null, _created: created };
}
/** Idempotently create the whole catalog with an explicit client: `pricings` = { employer, consultant } (getAllPricing()).
 *  Returns { employer: { posting, gst }, consultant: { posting, gst } }. */
async function ensureCatalog(client, pricings, opts = {}) {
  const out = {};
  for (const role of ROLES) { if (pricings[role]) out[role] = await ensureRoleCatalog(client, role, pricings[role], opts); }
  return out;
}
/** Find the webhook endpoint for `url` or create it with WEBHOOK_EVENTS (the signing secret is only returned on creation). Explicit client. */
async function ensureWebhook(client, url, { log = console.log, create = true } = {}) {
  const list = await client.webhookEndpoints.list({ limit: 100 });
  const existing = (list.data || []).find(e => e.url === url);
  if (existing) { log(`webhook endpoint ${existing.id} for ${url} exists (${existing.status}); its secret is only shown in the Dashboard`); return existing; }
  if (!create) return null;
  const ep = await client.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, description: 'Youth Careers Canada — job posting subscriptions' });
  log(`created webhook endpoint ${ep.id} for ${url}`);
  return ep;
}
const errMessage = (e) => (e && (e.message || String(e))) || 'unknown error';
/** No key configured → the shared "not configured" result. */
const NOT_CONFIGURED = 'No Stripe secret key configured — paste sk_test_… / sk_live_… in /admin/integrations and save first.';

/**
 * Admin "Test connection": { ok, mode: 'test'|'live'|null, account: { id, business_name, email, country, default_currency, charges_enabled } | null, error }.
 * Uses accounts.retrieve() (falls back to balance.retrieve() for restricted keys). Never throws.
 */
async function testConnection() {
  const key = fakeRequested() ? 'sk_test_fake' : await secretKey();
  if (!key) return { ok: false, mode: null, account: null, error: NOT_CONFIGURED };
  const m = keyMode(key);
  const client = await stripe();
  if (!client) return { ok: false, mode: m, account: null, error: NOT_CONFIGURED };
  try {
    const a = await client.accounts.retrieve();
    const bp = a.business_profile || {};
    const s = a.settings && a.settings.dashboard || {};
    return { ok: true, mode: m, error: null, account: { id: a.id, business_name: bp.name || s.display_name || null, email: a.email || bp.support_email || null, country: a.country || null, default_currency: a.default_currency || null, charges_enabled: a.charges_enabled !== false, livemode: m === 'live' } };
  } catch (e) {
    if (e && (e.type === 'StripeAuthenticationError' || e.statusCode === 401)) return { ok: false, mode: m, account: null, error: `Stripe rejected the key: ${errMessage(e)}` };
    try {   // restricted keys may not read the account but can read the balance
      const b = await client.balance.retrieve();
      return { ok: true, mode: m, error: null, account: { id: null, business_name: null, email: null, country: null, default_currency: (b.available && b.available[0] && b.available[0].currency) || null, charges_enabled: null, livemode: b.livemode === true || m === 'live' } };
    } catch (e2) { return { ok: false, mode: m, account: null, error: errMessage(e2) }; }
  }
}
/** Which lookup keys exist and match the current pricing: { ok, mode, stripe_tax, keys: { <lookup_key>: { role, line, expected_cents, exists, matches, price_id, unit_amount } }, missing: [...], error }. Never throws. */
async function catalogStatus() {
  const client = await stripe();
  const stripeTax = await useStripeTax();
  const out = { ok: false, mode: keyMode(fakeRequested() ? 'sk_test_fake' : await secretKey()), stripe_tax: stripeTax, keys: {}, missing: [], error: null };
  if (!client) { out.error = NOT_CONFIGURED; return out; }
  try {
    const pricings = await getAllPricing();
    const all = await client.prices.list({ lookup_keys: ROLES.flatMap(r => [LOOKUP_KEYS[r].posting, LOOKUP_KEYS[r].gst]), active: true, limit: 10 });
    const byKey = Object.fromEntries((all.data || []).map(p => [p.lookup_key, p]));
    for (const role of ROLES) {
      for (const line of ['posting', 'gst']) {
        if (line === 'gst' && stripeTax) continue;
        const k = LOOKUP_KEYS[role][line]; const expected = line === 'posting' ? pricings[role].price_cents : pricings[role].tax_cents; const p = byKey[k];
        out.keys[k] = { role, line, expected_cents: expected, exists: !!p, matches: priceMatches(p, expected), price_id: p ? p.id : null, unit_amount: p ? p.unit_amount : null };
        if (!p || !out.keys[k].matches) out.missing.push(k);
      }
    }
    out.ok = out.missing.length === 0;
  } catch (e) { out.error = errMessage(e); }
  return out;
}
/** Admin "Create prices": idempotent. { ok, mode, created: [lookup keys created], existing: [lookup keys already correct], prices: { <lookup_key>: price_id }, error }. Never throws. */
async function setupCatalog({ log = () => {} } = {}) {
  const client = await stripe();
  const out = { ok: false, mode: keyMode(fakeRequested() ? 'sk_test_fake' : await secretKey()), created: [], existing: [], prices: {}, error: null };
  if (!client) { out.error = NOT_CONFIGURED; return out; }
  try {
    const cat = await ensureCatalog(client, await getAllPricing(), { log, stripeTax: await useStripeTax() });
    for (const role of Object.keys(cat)) {
      const keys = LOOKUP_KEYS[role];
      out.prices[keys.posting] = cat[role].posting.id; if (cat[role].gst) out.prices[keys.gst] = cat[role].gst.id;
      for (const k of [keys.posting, keys.gst]) { if (!(k in out.prices)) continue; (cat[role]._created.includes(k) ? out.created : out.existing).push(k); }
    }
    priceCache = {};
    out.ok = true;
  } catch (e) { out.error = errMessage(e); }
  return out;
}
/**
 * Admin "Create webhook": creates the endpoint for `url` (default <public_url>/billing/webhook) with the 5 events, or
 * returns the existing endpoint for that url. { ok, id, url, created, secret, secret_saved, events, note, error }.
 * `secret` is ONLY available on creation (Stripe never shows it again); when created it is also saved to the
 * stripe_webhook_secret setting (opts.saveSecret=false to skip) so no copy/paste is needed. Never throws.
 */
async function createWebhookEndpoint(url, { saveSecret = true, userId = null, log = () => {} } = {}) {
  const client = await stripe();
  url = (url || `${await publicUrl()}/billing/webhook`).trim();
  const out = { ok: false, id: null, url, created: false, secret: null, secret_saved: false, events: WEBHOOK_EVENTS, note: null, error: null };
  if (!client) { out.error = NOT_CONFIGURED; return out; }
  if (!/^https:\/\//.test(url) && !/^http:\/\/localhost/.test(url)) { out.error = `Webhook URL must be https:// (got ${url}). Set the Public URL in Branding first.`; return out; }
  try {
    const list = await client.webhookEndpoints.list({ limit: 100 });
    const existing = (list.data || []).find(e => e.url === url);
    if (existing) {
      Object.assign(out, { ok: true, id: existing.id, created: false, events: existing.enabled_events || WEBHOOK_EVENTS });
      const have = await settings.get('stripe_webhook_secret');
      out.note = have ? `Endpoint ${existing.id} already exists for this URL and a signing secret is saved.`
                      : `Endpoint ${existing.id} already exists for this URL but no signing secret is saved here. Stripe only reveals the secret once: open Dashboard → Developers → Webhooks → ${existing.id} → "Reveal" and paste it into the Stripe webhook signing secret field, or delete that endpoint in the Dashboard and click this button again.`;
      const missing = WEBHOOK_EVENTS.filter(ev => !(existing.enabled_events || []).includes(ev) && !(existing.enabled_events || []).includes('*'));
      if (missing.length) out.note += ` It is missing these events: ${missing.join(', ')} — add them in the Dashboard.`;
      log(out.note);
      return out;
    }
    const ep = await client.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, description: 'Youth Careers Canada — job posting subscriptions' });
    Object.assign(out, { ok: true, id: ep.id, created: true, secret: ep.secret || null });
    if (ep.secret && saveSecret) { await settings.set('stripe_webhook_secret', ep.secret, userId); out.secret_saved = true; }
    out.note = `Created endpoint ${ep.id}. ${out.secret_saved ? 'The signing secret has been saved to your settings.' : 'Save the signing secret now — Stripe never shows it again.'}`;
    log(out.note);
  } catch (e) { out.error = errMessage(e); }
  return out;
}

module.exports = {
  mode, stripe, setStripeClient, providerName, useStripeTax, publicUrl, billFrom, getPricing, getAllPricing, snapshotPricing, pricingRole, resetPricingCache, gstLabel, addMonth, LOOKUP_KEYS, ROLES, ROLE_LABEL, WEBHOOK_EVENTS,
  loadJob, loadSubscriptionByJob, loadSubscriptionByCheckout, loadPayment, ensureSubscription, findStripeCustomerId,
  createCheckout, portalUrl, recordPayment, sendReceiptEmail, sendPaymentFailedEmail, cancel, resume,
  handleStripeEvent, reconcileCheckoutSession,
  // admin panel / setup CLI
  testConnection, catalogStatus, setupCatalog, createWebhookEndpoint, ensureCatalog, ensureRoleCatalog, ensureWebhook, keyMode,
  // exported for tests / renewals
  invoiceSubscriptionId, invoicePeriod, invoiceTaxCents, invoiceIsPaid, subscriptionPeriod,
};
