'use strict';
// Billing core — provider-agnostic API used by routes/billing.js and jobs/renewals.js.
// One subscription per job posting: $9.99 + GST (5%) = $10.49 CAD per month, renews until cancelled.
// mode() is 'stripe' when STRIPE_SECRET_KEY is set, otherwise 'sandbox' (simulated card, always succeeds
// on renewal). Every successful charge goes through recordPayment(), which is the single place that
// writes a payments row, issues a receipt number, activates the job and emails the receipt.
//
// Stripe notes (SDK 17.7.0, API version 2025-02-24.acacia pinned by the SDK):
//  - Checkout Session in `subscription` mode. Line items come from Prices with lookup_keys
//    `cc_posting_monthly` / `cc_gst_monthly` (created by scripts/stripe-setup.js) when they exist and match the
//    configured pricing, else inline `price_data`. With STRIPE_TAX=1 the GST line is dropped and Stripe Tax
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
const { escapeHtml, money, formatDate } = require('./helpers');

const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3900';
const isProd = process.env.NODE_ENV === 'production';
const flag = (v) => /^(1|true|yes)$/i.test(String(v || ''));

// ------------------------------------------------------------------ provider
const LOOKUP_KEYS = { posting: 'cc_posting_monthly', gst: 'cc_gst_monthly' };
const WEBHOOK_EVENTS = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'];

let _stripe = null;
const fakeRequested = () => !isProd && flag(process.env.BILLING_FAKE_STRIPE);
function stripe() {
  if (_stripe) return _stripe;
  if (fakeRequested()) { _stripe = require('../scripts/test-stripe').createFakeStripe(); return _stripe; }
  if (!process.env.STRIPE_SECRET_KEY) return null;
  _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, { appInfo: { name: 'Canada Careers', url: PUBLIC_URL } });
  return _stripe;
}
/** Test hook: inject a client (non-production only). */
function setStripeClient(client) { if (isProd) throw new Error('setStripeClient is not available in production'); _stripe = client || null; priceCache = { at: 0, ids: null }; }
const mode = () => (process.env.STRIPE_SECRET_KEY || fakeRequested() ? 'stripe' : 'sandbox');
const providerName = (p) => (p === 'stripe' ? 'Stripe' : 'Sandbox (test payment)');
const useStripeTax = () => flag(process.env.STRIPE_TAX);

// Startup diagnostics: production running without real payments must be loud, never silent.
if (isProd && mode() === 'sandbox') console.warn('[billing] WARNING: SANDBOX payment mode in production — postings are "paid" with a simulated card and no money is collected. Set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (see docs/STRIPE-GO-LIVE.md).');
if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) console.warn('[billing] WARNING: STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing — Stripe webhooks will be rejected (400) and postings will not activate until /billing/success reconciles them. Run: node scripts/stripe-setup.js');
if (isProd && flag(process.env.BILLING_FAKE_STRIPE)) console.warn('[billing] BILLING_FAKE_STRIPE is ignored in production.');

// ------------------------------------------------------------------ pricing
let settingsCache = { at: 0, values: {} };
async function readSettings() {
  if (Date.now() - settingsCache.at < 60000) return settingsCache.values;
  try {
    const rows = await db.many("SELECT key, value FROM settings WHERE key IN ('posting_price_cents','gst_rate','gst_number')");
    settingsCache = { at: Date.now(), values: Object.fromEntries(rows.map(r => [r.key, r.value])) };
  } catch (e) { console.error('[billing] settings read failed', e.message); }
  return settingsCache.values;
}

/** { price_cents, gst_rate, tax_cents, total_cents, currency, gst_label, gst_number } */
async function getPricing() {
  const s = await readSettings();
  const envPrice = Number(process.env.POSTING_PRICE_CENTS);
  const envRate = process.env.GST_RATE !== undefined && process.env.GST_RATE !== '' ? Number(process.env.GST_RATE) : NaN;
  const price_cents = envPrice > 0 ? Math.round(envPrice) : (Number(s.posting_price_cents) > 0 ? Math.round(Number(s.posting_price_cents)) : C.PRICING.price_cents);
  const gst_rate = envRate >= 0 ? envRate : (Number(s.gst_rate) >= 0 && s.gst_rate !== undefined ? Number(s.gst_rate) : C.PRICING.gst_rate);
  const tax_cents = Math.round(price_cents * gst_rate);
  const gst_number = (process.env.GST_NUMBER || s.gst_number || '').trim() || null;
  return { price_cents, gst_rate, tax_cents, total_cents: price_cents + tax_cents, currency: 'CAD', gst_label: gstLabel(gst_rate), gst_number };
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

/** Create or reset the subscription row for a job so it is `pending` with the current pricing snapshot.
 *  If the row is still paid-up (active and period not over) it is returned untouched. */
async function ensureSubscription(job, user) {
  const p = await getPricing();
  const existing = await loadSubscriptionByJob(job.id);
  if (existing && existing.status === 'active' && existing.current_period_end && new Date(existing.current_period_end) > new Date()) return existing;
  // Still-pending row with the same price snapshot: keep it (and its checkout link) so Back/refresh does not invalidate an open checkout.
  if (existing && existing.status === 'pending' && existing.provider === mode() && existing.price_cents === p.price_cents && Number(existing.tax_rate) === p.gst_rate && existing.tax_cents === p.tax_cents && Number(existing.payer_user_id) === Number(user.id)) return existing;
  if (existing && existing.provider === 'stripe' && existing.provider_subscription_id && ['active', 'past_due'].includes(existing.status) && stripe()) {
    try { await stripe().subscriptions.cancel(existing.provider_subscription_id); } catch (e) { if (e.code !== 'resource_missing') console.warn('[billing] could not cancel stale stripe subscription', e.message); }
  }
  const vals = [job.employer_profile_id, user.id, mode(), p.price_cents, p.gst_rate, p.tax_cents, p.total_cents, p.currency];
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
    const c = await stripe().customers.create({ email: user.email, name: user.name || undefined, metadata: { user_id: String(user.id), source: 'canada-careers' } });
    customerId = c.id;
  }
  if (sub && sub.provider_customer_id !== customerId) await db.query("UPDATE subscriptions SET provider='stripe', provider_customer_id=$2, updated_at=now() WHERE id=$1", [sub.id, customerId]);
  return customerId;
}

let priceCache = { at: 0, ids: null };
/** Price ids for the posting fee and the GST line: env STRIPE_PRICE_POSTING/STRIPE_PRICE_GST, else lookup_keys
 *  (cached 10 min). A price is only used when its amount/currency/interval match the configured pricing. */
async function resolvePriceIds(p) {
  const s = stripe();
  if (!s || !s.prices || typeof s.prices.list !== 'function') return { posting: null, gst: null };
  if (priceCache.ids && Date.now() - priceCache.at < 600000) return priceCache.ids;
  const ids = { posting: process.env.STRIPE_PRICE_POSTING || null, gst: process.env.STRIPE_PRICE_GST || null };
  if (!ids.posting || (!ids.gst && !useStripeTax())) {
    try {
      const list = await s.prices.list({ lookup_keys: [LOOKUP_KEYS.posting, LOOKUP_KEYS.gst], active: true, limit: 10 });
      const ok = (price, cents) => price && price.active !== false && price.currency === 'cad' && price.unit_amount === cents && price.recurring && price.recurring.interval === 'month' && price.recurring.interval_count === 1;
      for (const price of list.data || []) {
        if (price.lookup_key === LOOKUP_KEYS.posting && !ids.posting) ids.posting = ok(price, p.price_cents) ? price.id : null;
        if (price.lookup_key === LOOKUP_KEYS.gst && !ids.gst) ids.gst = ok(price, p.tax_cents) ? price.id : null;
      }
    } catch (e) { console.warn('[billing] prices.list failed, using inline price_data:', e.message); }
  }
  priceCache = { at: Date.now(), ids };
  return ids;
}

/** Build the Checkout Session line items: a Price by id when available, else inline price_data. */
async function checkoutLineItems(job, profile, p) {
  const ids = await resolvePriceIds(p);
  const items = [ids.posting
    ? { price: ids.posting, quantity: 1 }
    : { quantity: 1, price_data: { currency: 'cad', unit_amount: p.price_cents, recurring: { interval: 'month' },
        product_data: { name: 'Job posting (monthly)', description: `${job.title} · ${profile.company_name} · renews monthly until cancelled`, metadata: { job_id: String(job.id) } } } }];
  if (!useStripeTax()) items.push(ids.gst
    ? { price: ids.gst, quantity: 1 }
    : { quantity: 1, price_data: { currency: 'cad', unit_amount: p.tax_cents, recurring: { interval: 'month' }, product_data: { name: p.gst_label, description: 'Goods and Services Tax (Canada)' } } });
  return items;
}

// ------------------------------------------------------------------ checkout
/** Returns { url, subscription }. Stripe mode -> hosted Checkout (subscription mode); sandbox -> /billing/sandbox/:id */
async function createCheckout(job, user, profile) {
  const sub = await ensureSubscription(job, user);
  const p = await getPricing();
  if (mode() === 'stripe') {
    const s = stripe();
    const meta = { job_id: String(job.id), subscription_id: String(sub.id), user_id: String(user.id), employer_profile_id: String(job.employer_profile_id) };
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
      subscription_data: { metadata: meta, description: `Canada Careers job posting #${job.id}: ${job.title}`.slice(0, 500) },
      ...(useStripeTax() ? { automatic_tax: { enabled: true } } : {}),
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
  const s = stripe();
  if (!s || mode() !== 'stripe') return null;
  const customer = await findStripeCustomerId(user.id);
  if (!customer) return null;
  const session = await s.billingPortal.sessions.create({ customer, return_url: `${PUBLIC_URL}${returnPath}` });
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
  return db.one(`SELECT pay.*, s.tax_rate, s.cancel_at_period_end, j.title AS job_title, j.slug AS job_slug, j.city, j.province,
                        u.name AS payer_name, u.email AS payer_email, p.company_name, p.id AS employer_profile_id, p.owner_user_id, p.city AS company_city, p.province AS company_province
                 FROM payments pay JOIN subscriptions s ON s.id = pay.subscription_id JOIN jobs j ON j.id = pay.job_id
                 JOIN users u ON u.id = pay.payer_user_id JOIN employer_profiles p ON p.id = j.employer_profile_id WHERE pay.id = $1`, [paymentId]);
}

async function sendReceiptEmail(paymentId) {
  const r = await loadPayment(paymentId);
  if (!r) return;
  const pricing = await getPricing();
  const receiptUrl = `${PUBLIC_URL}/billing/receipt/${r.id}`;
  const td = 'padding:8px 0;border-bottom:1px solid #e1e7ef';
  const gstNo = pricing.gst_number ? `<br>GST/HST registration no. <strong>${escapeHtml(pricing.gst_number)}</strong>` : '';
  const body = `
<p>Thank you — your payment for the posting <strong>${escapeHtml(r.job_title)}</strong> (${escapeHtml(r.company_name)}) was received.
The posting is live until <strong>${escapeHtml(formatDate(r.period_end))}</strong> and will renew automatically unless you cancel from Billing.</p>
<table style="width:100%;border-collapse:collapse;font-size:15px;margin:16px 0">
  <tr><td style="${td}">Job posting — monthly fee</td><td style="${td};text-align:right">${money(r.amount_cents)}</td></tr>
  <tr><td style="${td}">${escapeHtml(gstLabel(r.tax_rate))}</td><td style="${td};text-align:right">${money(r.tax_cents)}</td></tr>
  <tr><td style="padding:10px 0;font-weight:700">Total paid (CAD)</td><td style="padding:10px 0;text-align:right;font-weight:700">${money(r.total_cents)}</td></tr>
</table>
<p style="font-size:14px;color:#5a6b7e">Receipt number <strong>${escapeHtml(r.receipt_number)}</strong> · Paid ${escapeHtml(formatDate(r.paid_at))} via ${escapeHtml(providerName(r.provider))}<br>
Billing period ${escapeHtml(formatDate(r.period_start))} – ${escapeHtml(formatDate(r.period_end))}${gstNo}</p>`;
  const text = `Receipt ${r.receipt_number}\nJob posting: ${r.job_title} (${r.company_name})\nMonthly fee ${money(r.amount_cents)}\n${gstLabel(r.tax_rate)} ${money(r.tax_cents)}\nTotal ${money(r.total_cents)} CAD\nPeriod ${formatDate(r.period_start)} – ${formatDate(r.period_end)}${pricing.gst_number ? `\nGST/HST no. ${pricing.gst_number}` : ''}\nView: ${receiptUrl}`;
  await mail.send({ to: r.payer_email, subject: `Receipt ${r.receipt_number} — ${money(r.total_cents)} for "${r.job_title}"`, html: mail.layout('Payment receipt', body, { href: receiptUrl, label: 'View receipt' }), text });
}

async function sendPaymentFailedEmail(sub, reason) {
  const job = await loadJob(sub.job_id);
  const user = await db.one('SELECT name, email FROM users WHERE id=$1', [sub.payer_user_id]);
  if (!job || !user) return;
  const where = sub.provider === 'stripe' ? `${PUBLIC_URL}/billing/portal` : `${PUBLIC_URL}/billing`;
  const body = `<p>We could not collect the monthly fee of <strong>${money(sub.total_cents)}</strong> for the posting <strong>${escapeHtml(job.title)}</strong>.</p>
<p>${reason ? escapeHtml(reason) + ' ' : ''}Please update your card. The posting stays live until <strong>${escapeHtml(formatDate(sub.current_period_end))}</strong>; if payment is not received by then it will be removed from public view.</p>`;
  await mail.send({ to: user.email, subject: `Payment failed for "${job.title}" — action needed`, html: mail.layout('Payment failed', body, { href: where, label: 'Update payment method' }), text: `Payment failed for ${job.title}. Update your card at ${where}` });
}

// ------------------------------------------------------------------ cancel / resume
/** now=true: cancel immediately and archive the job. Otherwise the posting stays live until current_period_end. */
async function cancel(jobId, user, { now = false } = {}) {
  const sub = await loadSubscriptionByJob(jobId);
  if (!sub) { const e = new Error('No subscription for this posting'); e.status = 404; throw e; }
  const immediate = now || sub.status !== 'active' || !sub.current_period_end || new Date(sub.current_period_end) <= new Date();
  if (sub.provider === 'stripe' && sub.provider_subscription_id && stripe()) {
    try {
      if (immediate) await stripe().subscriptions.cancel(sub.provider_subscription_id, { invoice_now: false, prorate: false });
      else await stripe().subscriptions.update(sub.provider_subscription_id, { cancel_at_period_end: true });
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
  if (sub.provider === 'stripe' && sub.provider_subscription_id && stripe()) {
    try { await stripe().subscriptions.update(sub.provider_subscription_id, { cancel_at_period_end: false }); }
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
  if (!(meta && isId(meta.subscription_id)) && stripe()) {
    try { meta = (await stripe().subscriptions.retrieve(stripeSubId)).metadata; }
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
  const s = stripe();
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

module.exports = {
  mode, stripe, setStripeClient, providerName, useStripeTax, getPricing, gstLabel, addMonth, LOOKUP_KEYS, WEBHOOK_EVENTS,
  loadJob, loadSubscriptionByJob, loadSubscriptionByCheckout, loadPayment, ensureSubscription, findStripeCustomerId,
  createCheckout, portalUrl, recordPayment, sendReceiptEmail, sendPaymentFailedEmail, cancel, resume,
  handleStripeEvent, reconcileCheckoutSession,
  // exported for tests / renewals
  invoiceSubscriptionId, invoicePeriod, invoiceTaxCents, invoiceIsPaid, subscriptionPeriod,
};
