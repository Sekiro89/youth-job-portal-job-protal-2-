'use strict';
// Billing core — provider-agnostic API used by routes/billing.js and jobs/renewals.js.
// One subscription per job posting: $9.99 + GST (5%) = $10.49 CAD per month, renews until cancelled.
// mode() is 'stripe' when STRIPE_SECRET_KEY is set, otherwise 'sandbox' (simulated card, always succeeds
// on renewal). Every successful charge goes through recordPayment(), which is the single place that
// writes a payments row, issues a receipt number, activates the job and emails the receipt.
const crypto = require('crypto');
const db = require('./db');
const jobs = require('./jobs');
const mail = require('./mail');
const auth = require('./auth');
const C = require('./constants');
const { escapeHtml, money, formatDate } = require('./helpers');

const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3900';

// ------------------------------------------------------------------ provider
let _stripe = null;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
const mode = () => (process.env.STRIPE_SECRET_KEY ? 'stripe' : 'sandbox');
const providerName = (p) => (p === 'stripe' ? 'Stripe' : 'Sandbox (test payment)');

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
  return { price_cents, gst_rate, tax_cents, total_cents: price_cents + tax_cents, currency: 'CAD', gst_label: gstLabel(gst_rate), gst_number: s.gst_number || process.env.GST_NUMBER || null };
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

/** Create or reset the subscription row for a job so it is `pending` with the current pricing snapshot.
 *  If the row is still paid-up (active and period not over) it is returned untouched. */
async function ensureSubscription(job, user) {
  const p = await getPricing();
  const existing = await loadSubscriptionByJob(job.id);
  if (existing && existing.status === 'active' && existing.current_period_end && new Date(existing.current_period_end) > new Date()) return existing;
  // Still-pending row with the same price snapshot: keep it (and its checkout link) so Back/refresh does not invalidate an open checkout.
  if (existing && existing.status === 'pending' && existing.price_cents === p.price_cents && Number(existing.tax_rate) === p.gst_rate && existing.tax_cents === p.tax_cents && Number(existing.payer_user_id) === Number(user.id)) return existing;
  if (existing && existing.provider === 'stripe' && existing.provider_subscription_id && ['active', 'past_due'].includes(existing.status) && stripe()) {
    try { await stripe().subscriptions.cancel(existing.provider_subscription_id); } catch (e) { console.warn('[billing] could not cancel stale stripe subscription', e.message); }
  }
  const vals = [job.employer_profile_id, user.id, mode(), p.price_cents, p.gst_rate, p.tax_cents, p.total_cents, p.currency];
  if (existing) {
    return db.one(`UPDATE subscriptions SET status='pending', employer_profile_id=$2, payer_user_id=$3, provider=$4, price_cents=$5, tax_rate=$6, tax_cents=$7,
                   total_cents=$8, currency=$9, cancel_at_period_end=false, cancelled_at=NULL, provider_checkout_id=NULL, provider_subscription_id=NULL, updated_at=now()
                   WHERE id=$1 RETURNING *`, [existing.id, ...vals]);
  }
  return db.one(`INSERT INTO subscriptions(job_id, employer_profile_id, payer_user_id, provider, price_cents, tax_rate, tax_cents, total_cents, currency, status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`, [job.id, ...vals]);
}

// ------------------------------------------------------------------ checkout
/** Returns { url, subscription }. Stripe mode -> hosted Checkout (subscription mode); sandbox -> /billing/sandbox/:id */
async function createCheckout(job, user, profile) {
  const sub = await ensureSubscription(job, user);
  const p = await getPricing();
  if (mode() === 'stripe') {
    const s = stripe();
    const meta = { job_id: String(job.id), subscription_id: String(sub.id) };
    const useStripeTax = /^(1|true|yes)$/i.test(process.env.STRIPE_TAX || '');
    const line_items = [{
      price_data: { currency: 'cad', unit_amount: p.price_cents, recurring: { interval: 'month' },
        product_data: { name: `Job posting: ${job.title}`, description: `${profile.company_name} · renews monthly until cancelled` } },
      quantity: 1,
    }];
    if (!useStripeTax) line_items.push({
      price_data: { currency: 'cad', unit_amount: p.tax_cents, recurring: { interval: 'month' }, product_data: { name: p.gst_label } },
      quantity: 1,
    });
    const session = await s.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.email,
      client_reference_id: String(sub.id),
      line_items,
      metadata: meta,
      subscription_data: { metadata: meta, description: `Canada Careers job posting #${job.id}` },
      ...(useStripeTax ? { automatic_tax: { enabled: true } } : {}),
      success_url: `${PUBLIC_URL}/billing/success?job=${job.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/billing/cancelled?job=${job.id}`,
    });
    await db.query("UPDATE subscriptions SET provider='stripe', provider_checkout_id=$2, updated_at=now() WHERE id=$1", [sub.id, session.id]);
    return { url: session.url, subscription: sub };
  }
  const checkoutId = crypto.randomBytes(16).toString('hex');
  await db.query("UPDATE subscriptions SET provider='sandbox', provider_checkout_id=$2, updated_at=now() WHERE id=$1", [sub.id, checkoutId]);
  return { url: `/billing/sandbox/${checkoutId}`, subscription: sub };
}

// ------------------------------------------------------------------ payments
/**
 * Record a successful charge: payments row (receipt CC-YYYYMM-NNNNNN), subscription -> active with the new
 * period, job activated through period_end, receipt email, seeker notifications on the first payment.
 * Idempotent on (provider, provider_payment_id). Runs in its own transaction unless a client is given.
 */
async function recordPayment(subscriptionId, { provider, provider_payment_id, period_start, period_end }, client) {
  provider = provider || 'sandbox';
  const run = async (c) => {
    if (provider_payment_id) {
      const dup = (await c.query('SELECT * FROM payments WHERE provider=$1 AND provider_payment_id=$2', [provider, provider_payment_id])).rows[0];
      if (dup) return { payment: dup, duplicate: true };
    }
    const sub = (await c.query('SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [subscriptionId])).rows[0];
    if (!sub) throw new Error(`subscription ${subscriptionId} not found`);
    const prior = (await c.query("SELECT count(*)::int AS n FROM payments WHERE job_id=$1 AND status='paid'", [sub.job_id])).rows[0].n;
    const payment = (await c.query(`
      INSERT INTO payments(subscription_id, job_id, payer_user_id, provider, provider_payment_id, receipt_number, amount_cents, tax_cents, total_cents, currency, status, period_start, period_end)
      VALUES ($1,$2,$3,$4,$5, 'CC-' || to_char(now() AT TIME ZONE 'America/Toronto', 'YYYYMM') || '-' || lpad(nextval('receipt_seq')::text, 6, '0'),
              $6,$7,$8,$9,'paid',$10,$11) RETURNING *`,
      [sub.id, sub.job_id, sub.payer_user_id, provider, provider_payment_id || null, sub.price_cents, sub.tax_cents, sub.total_cents, sub.currency, period_start, period_end])).rows[0];
    await c.query(`UPDATE subscriptions SET status='active', provider=$2, current_period_start=$3, current_period_end=$4, updated_at=now() WHERE id=$1`,
      [sub.id, provider, period_start, period_end]);
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
  const receiptUrl = `${PUBLIC_URL}/billing/receipt/${r.id}`;
  const td = 'padding:8px 0;border-bottom:1px solid #e1e7ef';
  const body = `
<p>Thank you — your payment for the posting <strong>${escapeHtml(r.job_title)}</strong> (${escapeHtml(r.company_name)}) was received.
The posting is live until <strong>${escapeHtml(formatDate(r.period_end))}</strong> and will renew automatically unless you cancel from Billing.</p>
<table style="width:100%;border-collapse:collapse;font-size:15px;margin:16px 0">
  <tr><td style="${td}">Job posting — monthly fee</td><td style="${td};text-align:right">${money(r.amount_cents)}</td></tr>
  <tr><td style="${td}">${escapeHtml(gstLabel(r.tax_rate))}</td><td style="${td};text-align:right">${money(r.tax_cents)}</td></tr>
  <tr><td style="padding:10px 0;font-weight:700">Total paid (CAD)</td><td style="padding:10px 0;text-align:right;font-weight:700">${money(r.total_cents)}</td></tr>
</table>
<p style="font-size:14px;color:#5a6b7e">Receipt number <strong>${escapeHtml(r.receipt_number)}</strong> · Paid ${escapeHtml(formatDate(r.paid_at))} via ${escapeHtml(providerName(r.provider))}<br>
Billing period ${escapeHtml(formatDate(r.period_start))} – ${escapeHtml(formatDate(r.period_end))}</p>`;
  const text = `Receipt ${r.receipt_number}\nJob posting: ${r.job_title} (${r.company_name})\nMonthly fee ${money(r.amount_cents)}\n${gstLabel(r.tax_rate)} ${money(r.tax_cents)}\nTotal ${money(r.total_cents)} CAD\nPeriod ${formatDate(r.period_start)} – ${formatDate(r.period_end)}\nView: ${receiptUrl}`;
  await mail.send({ to: r.payer_email, subject: `Receipt ${r.receipt_number} — ${money(r.total_cents)} for "${r.job_title}"`, html: mail.layout('Payment receipt', body, { href: receiptUrl, label: 'View receipt' }), text });
}

async function sendPaymentFailedEmail(sub, reason) {
  const job = await loadJob(sub.job_id);
  const user = await db.one('SELECT name, email FROM users WHERE id=$1', [sub.payer_user_id]);
  if (!job || !user) return;
  const body = `<p>We could not collect the monthly fee of <strong>${money(sub.total_cents)}</strong> for the posting <strong>${escapeHtml(job.title)}</strong>.</p>
<p>${reason ? escapeHtml(reason) + ' ' : ''}Please update your card. The posting stays live until <strong>${escapeHtml(formatDate(sub.current_period_end))}</strong>; if payment is not received by then it will be removed from public view.</p>`;
  await mail.send({ to: user.email, subject: `Payment failed for "${job.title}" — action needed`, html: mail.layout('Payment failed', body, { href: `${PUBLIC_URL}/billing`, label: 'Open Billing' }), text: `Payment failed for ${job.title}. Update your card at ${PUBLIC_URL}/billing` });
}

// ------------------------------------------------------------------ cancel / resume
/** now=true: cancel immediately and archive the job. Otherwise the posting stays live until current_period_end. */
async function cancel(jobId, user, { now = false } = {}) {
  const sub = await loadSubscriptionByJob(jobId);
  if (!sub) { const e = new Error('No subscription for this posting'); e.status = 404; throw e; }
  const immediate = now || sub.status !== 'active' || !sub.current_period_end || new Date(sub.current_period_end) <= new Date();
  if (sub.provider === 'stripe' && sub.provider_subscription_id && stripe()) {
    try {
      if (immediate) await stripe().subscriptions.cancel(sub.provider_subscription_id);
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
  await auth.audit(user && user.id, immediate ? 'billing.cancel_now' : 'billing.cancel_at_period_end', 'job', jobId, { subscription_id: sub.id });
  return { immediate, period_end: sub.current_period_end };
}

/** Undo cancel-at-period-end (only while the subscription is still active). */
async function resume(jobId, user) {
  const sub = await loadSubscriptionByJob(jobId);
  if (!sub) { const e = new Error('No subscription for this posting'); e.status = 404; throw e; }
  if (sub.status !== 'active' || !sub.cancel_at_period_end) { const e = new Error('This subscription is not scheduled to cancel.'); e.status = 409; throw e; }
  if (sub.provider === 'stripe' && sub.provider_subscription_id && stripe()) await stripe().subscriptions.update(sub.provider_subscription_id, { cancel_at_period_end: false });
  await db.query('UPDATE subscriptions SET cancel_at_period_end=false, updated_at=now() WHERE id=$1', [sub.id]);
  await auth.audit(user && user.id, 'billing.resume', 'job', jobId, { subscription_id: sub.id });
  return sub;
}

// ------------------------------------------------------------------ Stripe webhooks
const sec = (s) => (s ? new Date(s * 1000) : null);
function invoiceSubscriptionId(inv) {
  if (typeof inv.subscription === 'string') return inv.subscription;
  if (inv.subscription && inv.subscription.id) return inv.subscription.id;
  return inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription || null;
}
function invoicePeriod(inv) {
  const line = inv.lines && inv.lines.data && inv.lines.data.find(l => l.period && l.period.start && l.period.end);
  if (line) return { period_start: sec(line.period.start), period_end: sec(line.period.end) };
  return { period_start: sec(inv.period_start), period_end: sec(inv.period_end) };
}
/** Find our subscription for a Stripe subscription id; falls back to the metadata Stripe copied onto the subscription. */
async function subForStripeSubscription(stripeSubId, metadata) {
  if (!stripeSubId) return null;
  let sub = await db.one('SELECT * FROM subscriptions WHERE provider_subscription_id=$1', [stripeSubId]);
  if (sub) return sub;
  let meta = metadata;
  if (!meta && stripe()) { try { meta = (await stripe().subscriptions.retrieve(stripeSubId)).metadata; } catch (_) {} }
  if (meta && meta.subscription_id) {
    sub = await db.one("UPDATE subscriptions SET provider='stripe', provider_subscription_id=$2, updated_at=now() WHERE id=$1 RETURNING *", [meta.subscription_id, stripeSubId]);
  }
  return sub;
}

/** Handle a verified Stripe event. Returns a short description of what happened (for logs). */
async function handleStripeEvent(event) {
  const obj = event.data && event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const subId = obj.metadata && obj.metadata.subscription_id || obj.client_reference_id;
      if (!subId) return 'no subscription_id in metadata';
      await db.query(`UPDATE subscriptions SET provider='stripe', provider_customer_id=$2, provider_subscription_id=COALESCE($3, provider_subscription_id), provider_checkout_id=$4, updated_at=now() WHERE id=$1`,
        [subId, typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id, typeof obj.subscription === 'string' ? obj.subscription : obj.subscription && obj.subscription.id, obj.id]);
      return `linked subscription ${subId}`;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const sub = await subForStripeSubscription(invoiceSubscriptionId(obj), obj.subscription_details && obj.subscription_details.metadata);
      if (!sub) return 'invoice for unknown subscription';
      const { period_start, period_end } = invoicePeriod(obj);
      if (!period_end) return 'invoice without period';
      const pay = await recordPayment(sub.id, { provider: 'stripe', provider_payment_id: obj.id, period_start: period_start || new Date(), period_end });
      return `payment ${pay.receipt_number}`;
    }
    case 'invoice.payment_failed': {
      const sub = await subForStripeSubscription(invoiceSubscriptionId(obj));
      if (!sub) return 'failed invoice for unknown subscription';
      await db.query("UPDATE subscriptions SET status='past_due', updated_at=now() WHERE id=$1 AND status <> 'cancelled'", [sub.id]);
      try { await sendPaymentFailedEmail(sub, obj.last_finalization_error && obj.last_finalization_error.message); } catch (e) { console.error('[billing] failed email', e.message); }
      return `subscription ${sub.id} past_due`;
    }
    case 'customer.subscription.deleted': {
      const sub = await subForStripeSubscription(obj.id, obj.metadata);
      if (!sub) return 'deleted unknown subscription';
      await db.tx(async (c) => {
        await c.query("UPDATE subscriptions SET status='cancelled', cancelled_at=COALESCE(cancelled_at, now()), cancel_at_period_end=false, updated_at=now() WHERE id=$1", [sub.id]);
        await jobs.archiveJob(sub.job_id, 'cancelled', c);
      });
      return `subscription ${sub.id} cancelled`;
    }
    case 'customer.subscription.updated': {
      const sub = await subForStripeSubscription(obj.id, obj.metadata);
      if (!sub) return 'updated unknown subscription';
      await db.query('UPDATE subscriptions SET cancel_at_period_end=$2, updated_at=now() WHERE id=$1', [sub.id, !!obj.cancel_at_period_end]);
      return `subscription ${sub.id} cancel_at_period_end=${!!obj.cancel_at_period_end}`;
    }
    default:
      return `ignored ${event.type}`;
  }
}

/** After a Stripe success redirect: pull the session so the page is correct even before the webhook lands. */
async function reconcileCheckoutSession(sessionId) {
  const s = stripe();
  if (!s || !sessionId) return null;
  const session = await s.checkout.sessions.retrieve(sessionId, { expand: ['subscription.latest_invoice'] });
  await handleStripeEvent({ type: 'checkout.session.completed', data: { object: session } });
  const inv = session.subscription && session.subscription.latest_invoice;
  if (inv && (inv.status === 'paid' || inv.paid)) await handleStripeEvent({ type: 'invoice.paid', data: { object: inv } });
  return session;
}

module.exports = {
  mode, stripe, providerName, getPricing, gstLabel, addMonth,
  loadJob, loadSubscriptionByJob, loadSubscriptionByCheckout, loadPayment, ensureSubscription,
  createCheckout, recordPayment, sendReceiptEmail, sendPaymentFailedEmail, cancel, resume,
  handleStripeEvent, reconcileCheckoutSession,
};
