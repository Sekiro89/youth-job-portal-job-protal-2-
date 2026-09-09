'use strict';
// Billing routes: checkout -> (Stripe Checkout | sandbox card page) -> success; cancel/resume; /billing; receipts; Stripe webhook.
const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const jobs = require('../lib/jobs');
const billing = require('../lib/billing');
const { money } = require('../lib/helpers');

const router = express.Router();
const owners = auth.requireAuth('employer', 'consultant');
const baseFor = (user) => (user && user.role === 'consultant' ? '/consultant' : '/employer');
const page = (extra) => Object.assign({ noindex: true, extraCss: ['/css/billing.css'], extraJs: ['/js/billing.js'] }, extra);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- dev-only login helper (never in production)
if (process.env.NODE_ENV !== 'production') {
  router.get('/billing-dev-login/:email', wrap(async (req, res) => {
    const u = await db.one('SELECT id FROM users WHERE email=$1 AND is_active', [req.params.email]);
    if (!u) return res.status(404).send('no such user');
    req.session.userId = u.id;
    const next = typeof req.query.next === 'string' && /^\/(?!\/)/.test(req.query.next) ? req.query.next : '/billing';
    req.session.save(() => res.redirect(next));
  }));
}

// ---------------------------------------------------------------- Stripe webhook (raw body from server.js; no auth, no same-origin)
router.post('/billing/webhook', wrap(async (req, res) => {
  const stripe = billing.stripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) { console.warn('[billing] webhook received but Stripe is not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET)'); return res.status(400).send('Stripe is not configured'); }
  if (!Buffer.isBuffer(req.body)) return res.status(400).send('Raw body required');   // server.js mounts express.raw() on this path
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), secret);
  } catch (e) {
    console.warn('[billing] webhook signature failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  // Signature verified. From here on a failure must be a 5xx: Stripe retries non-2xx deliveries (for up to 3 days
  // in live mode), so a DB hiccup or API outage is replayed instead of silently losing a payment/cancellation.
  // Handlers are idempotent (payments dedupe on the invoice id), so replays are safe.
  try {
    const outcome = await billing.handleStripeEvent(event);
    console.log(`[billing] webhook ${event.id || ''} ${event.type}: ${outcome}`);
    res.status(200).json({ received: true, outcome });
  } catch (e) {
    console.error(`[billing] webhook ${event.id || ''} ${event.type} FAILED (Stripe will retry):`, e);
    res.status(500).json({ received: false, error: 'handler failed; retry' });
  }
}));

// ---------------------------------------------------------------- helpers
async function ownedJob(req, res) {
  const id = Number(req.params.jobId);
  if (!Number.isInteger(id) || id <= 0) { res.status(404).render('error', { title: 'Page not found', code: 404, message: 'That posting does not exist.', noindex: true }); return null; }
  if (!(await jobs.userCanManageJob(req.user, id))) { req.flash('error', 'You can only manage your own postings.'); res.redirect(`${baseFor(req.user)}/jobs`); return null; }
  const job = await billing.loadJob(id);
  if (!job) { res.status(404).render('error', { title: 'Page not found', code: 404, message: 'That posting does not exist.', noindex: true }); return null; }
  const prof = await db.one('SELECT archived FROM employer_profiles WHERE id=$1', [job.employer_profile_id]);
  if (prof && prof.archived && ['GET', 'POST'].includes(req.method) && /\/billing\/checkout\//.test(req.path)) {
    req.flash('error', 'This posting belongs to an archived company profile. Restore the company first, then publish.');
    res.redirect(`${baseFor(req.user)}/jobs/${job.id}`); return null;
  }
  return job;
}
function backTo(req, fallback) {
  const ref = req.get('referer');
  try { if (ref && new URL(ref).host === req.get('host')) return new URL(ref).pathname + new URL(ref).search; } catch (_) {}
  return fallback;
}

// ---------------------------------------------------------------- checkout
router.get('/billing/checkout/:jobId', owners, wrap(async (req, res) => {
  const job = await ownedJob(req, res); if (!job) return;
  const base = baseFor(req.user);
  if (job.status === 'active') { req.flash('info', 'This posting is already live and paid up.'); return res.redirect(`${base}/jobs/${job.id}`); }
  const existing = await billing.loadSubscriptionByJob(job.id);
  if (existing && existing.status === 'active' && existing.current_period_end && new Date(existing.current_period_end) > new Date()) {
    // paused posting with a paid-up subscription: no new charge needed
    await jobs.activateJob(job.id, existing.current_period_end);
    await auth.audit(req.user.id, 'billing.reactivate_paid', 'job', job.id, { subscription_id: existing.id });
    req.flash('success', `Your posting is live again — it is already paid through ${new Date(existing.current_period_end).toLocaleDateString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: 'short', day: 'numeric' })}.`);
    return res.redirect(`${base}/jobs/${job.id}`);
  }
  const sub = await billing.ensureSubscription(job, req.user);            // snapshots the price for the payer's role
  const pricing = await billing.snapshotPricing(sub, req.user.role);       // what the page shows = what will be charged
  res.render('billing/checkout', page({ title: `Checkout — ${job.title}`, metaDescription: 'Pay for your job posting on Canada Careers.', job, sub, pricing, base, mode: billing.mode(), rateLabel: pricing.role === 'consultant' ? 'Third party consultant rate' : 'Employer rate' }));
}));

router.post('/billing/checkout/:jobId', owners, wrap(async (req, res) => {
  const job = await ownedJob(req, res); if (!job) return;
  const base = baseFor(req.user);
  if (job.status === 'active') { req.flash('info', 'This posting is already live and paid up.'); return res.redirect(`${base}/jobs/${job.id}`); }
  if (job.status === 'draft') await db.query("UPDATE jobs SET status='pending_payment', updated_at=now() WHERE id=$1", [job.id]);
  const profile = { company_name: job.company_name };
  try {
    const { url } = await billing.createCheckout(job, req.user, profile);
    await auth.audit(req.user.id, 'billing.checkout_started', 'job', job.id, { mode: billing.mode() });
    return res.redirect(303, url);
  } catch (e) {
    console.error('[billing] createCheckout failed', e);
    req.flash('error', 'We could not start the payment. Please try again in a moment.');
    return res.redirect(`/billing/checkout/${job.id}`);
  }
}));

// ---------------------------------------------------------------- sandbox card page (only when Stripe is not configured)
const TEST_OK = '4242424242424242';
const TEST_DECLINE = '4000000000000002';
const luhn = (n) => { let s = 0, alt = false; for (let i = n.length - 1; i >= 0; i--) { let d = +n[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } s += d; alt = !alt; } return s % 10 === 0; };

async function sandboxContext(req, res) {
  const sub = await billing.loadSubscriptionByCheckout(String(req.params.checkoutId || ''));
  if (!sub || sub.provider !== 'sandbox') { res.status(404).render('error', { title: 'Checkout not found', code: 404, message: 'This checkout link is no longer valid. Start again from your posting.', noindex: true }); return null; }
  if (!(await jobs.userCanManageJob(req.user, sub.job_id))) { req.flash('error', 'That checkout belongs to another account.'); res.redirect(baseFor(req.user) + '/jobs'); return null; }
  const job = await billing.loadJob(sub.job_id);
  if (sub.status === 'active' && sub.current_period_end && new Date(sub.current_period_end) > new Date()) { res.redirect(`/billing/success?job=${job.id}`); return null; }
  return { sub, job };
}
router.get('/billing/sandbox/:checkoutId', owners, wrap(async (req, res) => {
  const ctx = await sandboxContext(req, res); if (!ctx) return;
  const pricing = await billing.snapshotPricing(ctx.sub, req.user.role);
  res.render('billing/sandbox', page({ title: 'Sandbox payment', metaDescription: 'Simulated card payment.', job: ctx.job, sub: ctx.sub, pricing, checkoutId: req.params.checkoutId, base: baseFor(req.user), error: null, values: { name: req.user.name || '', number: '', exp: '', cvc: '' } }));
}));
router.post('/billing/sandbox/:checkoutId', owners, wrap(async (req, res) => {
  const ctx = await sandboxContext(req, res); if (!ctx) return;
  const { sub, job } = ctx;
  const values = { name: String(req.body.name || '').trim(), number: String(req.body.number || '').replace(/\D/g, ''), exp: String(req.body.exp || '').trim(), cvc: String(req.body.cvc || '').replace(/\D/g, '') };
  const fail = async (error, fields) => {
    const pricing = await billing.snapshotPricing(sub, req.user.role);
    res.status(422).render('billing/sandbox', page({ title: 'Sandbox payment', metaDescription: 'Simulated card payment.', job, sub, pricing, checkoutId: req.params.checkoutId, base: baseFor(req.user), error, fields: fields || {}, values: Object.assign({}, values, { number: values.number.replace(/(\d{4})(?=\d)/g, '$1 ') }) }));
  };
  const fields = {};
  if (!values.name) fields.name = 'Enter the name on the card.';
  if (values.number.length < 13 || values.number.length > 19 || !luhn(values.number)) fields.number = 'Enter a valid card number.';
  const m = values.exp.match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (!m || +m[1] < 1 || +m[1] > 12) fields.exp = 'Use MM/YY.';
  else { const yr = m[2].length === 2 ? 2000 + +m[2] : +m[2]; const end = new Date(yr, +m[1], 0, 23, 59, 59); if (end < new Date()) fields.exp = 'This card has expired.'; }
  if (values.cvc.length < 3 || values.cvc.length > 4) fields.cvc = 'Enter the 3 or 4 digit security code.';
  if (Object.keys(fields).length) return fail('Please check the highlighted fields.', fields);
  if (values.number === TEST_DECLINE || values.number !== TEST_OK && values.number.endsWith('0002')) {
    await auth.audit(req.user.id, 'billing.sandbox_declined', 'job', job.id, { subscription_id: sub.id });
    return fail('Your card was declined (sandbox). Try the test card 4242 4242 4242 4242.', { number: 'Card declined.' });
  }
  const now = new Date();
  const payment = await billing.recordPayment(sub.id, { provider: 'sandbox', provider_payment_id: `sandbox_${req.params.checkoutId}_${Date.now()}`, period_start: now, period_end: billing.addMonth(now) });
  req.flash('success', `Payment received — receipt ${payment.receipt_number}. Your posting is now live.`);
  res.redirect(303, `/billing/success?job=${job.id}`);
}));

// ---------------------------------------------------------------- success / cancelled
router.get('/billing/success', owners, wrap(async (req, res) => {
  req.params.jobId = req.query.job;
  const job = await ownedJob(req, res); if (!job) return;
  if (billing.mode() === 'stripe' && req.query.session_id) {
    // The webhook may not have landed yet: pull the Checkout Session (+ subscription + latest invoice) directly.
    try { await billing.reconcileCheckoutSession(String(req.query.session_id), job.id); } catch (e) { console.warn('[billing] reconcile session failed', e.message); }
  }
  const fresh = await billing.loadJob(job.id);
  const sub = await billing.loadSubscriptionByJob(job.id);
  const pending = !(fresh.status === 'active' && fresh.expires_at && new Date(fresh.expires_at) > new Date());
  res.render('billing/success', page({ title: pending ? 'Confirming your payment' : 'Your posting is live', metaDescription: 'Payment confirmation.', job: fresh, sub, base: baseFor(req.user), pending, extraJs: pending ? ['/js/billing.js'] : [] }));
}));
router.get('/billing/cancelled', owners, wrap(async (req, res) => {
  req.params.jobId = req.query.job;
  const job = await ownedJob(req, res); if (!job) return;
  const sub = await billing.loadSubscriptionByJob(job.id);
  res.render('billing/cancelled', page({ title: 'Payment not completed', metaDescription: 'Payment was not completed.', job, sub, base: baseFor(req.user), extraJs: [] }));
}));

// ---------------------------------------------------------------- cancel / resume
router.post('/billing/cancel/:jobId', owners, wrap(async (req, res) => {
  const job = await ownedJob(req, res); if (!job) return;
  const base = baseFor(req.user);
  try {
    const out = await billing.cancel(job.id, req.user, { now: req.query.now === '1' || req.body.now === '1' });
    if (out.immediate) req.flash('success', `"${job.title}" has been cancelled and removed from public view. You will not be charged again.`);
    else req.flash('success', `"${job.title}" will stay live until ${new Date(out.period_end).toLocaleDateString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: 'short', day: 'numeric' })} and will not renew. You can resume before then from Billing.`);
  } catch (e) {
    if (!e.status) throw e;
    req.flash('error', e.message);
  }
  res.redirect(backTo(req, `${base}/jobs/${job.id}`));
}));
router.post('/billing/resume/:jobId', owners, wrap(async (req, res) => {
  const job = await ownedJob(req, res); if (!job) return;
  const base = baseFor(req.user);
  try { await billing.resume(job.id, req.user); req.flash('success', `Auto-renewal is back on for "${job.title}".`); }
  catch (e) { if (!e.status) throw e; req.flash('error', e.message); }
  res.redirect(backTo(req, `${base}/jobs/${job.id}`));
}));

// ---------------------------------------------------------------- Stripe Customer Portal (update card, invoices) — Stripe mode only
router.get('/billing/portal', owners, wrap(async (req, res) => {
  if (billing.mode() !== 'stripe') { req.flash('info', 'Card management opens once Stripe payments are enabled. In sandbox mode there is no card on file.'); return res.redirect('/billing'); }
  try {
    const url = await billing.portalUrl(req.user, '/billing');
    if (!url) { req.flash('info', 'No Stripe billing account yet — it is created with your first paid posting.'); return res.redirect('/billing'); }
    await auth.audit(req.user.id, 'billing.portal', 'user', req.user.id, null);
    return res.redirect(303, url);
  } catch (e) {
    console.error('[billing] portal session failed', e.message);
    req.flash('error', 'We could not open the payment portal right now. Please try again in a moment.');
    return res.redirect('/billing');
  }
}));

// ---------------------------------------------------------------- billing overview
router.get('/billing', owners, wrap(async (req, res) => {
  const subs = await db.many(`
    SELECT s.*, j.title AS job_title, j.slug AS job_slug, j.status AS job_status, j.expires_at, p.company_name, p.id AS profile_id,
           (SELECT count(*)::int FROM payments x WHERE x.subscription_id = s.id AND x.status='paid') AS payment_count
    FROM subscriptions s JOIN jobs j ON j.id = s.job_id JOIN employer_profiles p ON p.id = j.employer_profile_id
    WHERE p.owner_user_id = $1
    ORDER BY (s.status='active') DESC, (s.status='past_due') DESC, (s.status='pending') DESC, s.current_period_end DESC NULLS LAST, s.id DESC`, [req.user.id]);
  const payments = await db.many(`
    SELECT pay.*, j.title AS job_title, p.company_name
    FROM payments pay JOIN jobs j ON j.id = pay.job_id JOIN employer_profiles p ON p.id = j.employer_profile_id
    WHERE p.owner_user_id = $1 ORDER BY pay.paid_at DESC, pay.id DESC LIMIT 200`, [req.user.id]);
  const now = new Date();
  const live = subs.filter(s => s.status === 'active' && s.current_period_end && new Date(s.current_period_end) > now);
  const renewing = live.filter(s => !s.cancel_at_period_end);
  const totals = {
    activeCount: live.length,
    monthly: renewing.reduce((a, s) => a + s.total_cents, 0),
    nextRenewal: renewing.map(s => new Date(s.current_period_end)).sort((a, b) => a - b)[0] || null,
    paid: payments.filter(p => p.status === 'paid').reduce((a, p) => a + p.total_cents, 0),
    pastDue: subs.filter(s => s.status === 'past_due').length,
    pending: subs.filter(s => s.status === 'pending').length,
  };
  const byCompanyMap = new Map();
  for (const s of live) {
    const row = byCompanyMap.get(s.company_name) || { company_name: s.company_name, count: 0, monthly: 0 };
    row.count += 1; if (!s.cancel_at_period_end) row.monthly += s.total_cents; byCompanyMap.set(s.company_name, row);
  }
  const pricing = await billing.getPricing(req.user.role);               // the rate THIS payer gets on new postings
  const allPricing = await billing.getAllPricing();                       // both rates, for the explanatory note
  const hasStripeCustomer = billing.mode() === 'stripe' && !!(await billing.findStripeCustomerId(req.user.id));
  res.render('billing/index', page({ title: 'Billing', metaDescription: 'Your subscriptions and payment history.', subs, payments, pricing, allPricing, totals, byCompany: [...byCompanyMap.values()], isConsultant: req.user.role === 'consultant', base: baseFor(req.user), mode: billing.mode(), hasStripeCustomer, money }));
}));

// ---------------------------------------------------------------- receipt (owner or admin)
router.get('/billing/receipt/:paymentId', auth.requireAuth('employer', 'consultant', 'admin'), wrap(async (req, res) => {
  const id = Number(req.params.paymentId);
  const r = Number.isInteger(id) && id > 0 ? await billing.loadPayment(id) : null;
  if (!r || (req.user.role !== 'admin' && r.owner_user_id !== req.user.id && r.payer_user_id !== req.user.id)) {
    return res.status(404).render('error', { title: 'Receipt not found', code: 404, message: 'We could not find that receipt.', noindex: true });
  }
  const pricing = await billing.getPricing(r.payer_role);                // only gst_number is read; amounts come from the payment row
  const autoprint = req.query.print === '1';                               // /billing "Download (PDF)" link opens the print dialog on load
  res.render('billing/receipt', page({ title: `Receipt ${r.receipt_number}`, metaDescription: 'Payment receipt.', r, pricing, base: req.user.role === 'admin' ? '/admin' : baseFor(req.user), bodyClass: 'is-receipt', gstLabel: billing.gstLabel, providerName: billing.providerName, rateLabel: billing.pricingRole(r.payer_role) === 'consultant' ? 'third party consultant rate' : 'employer rate', autoprint, extraJs: [] }));
}));

module.exports = router;
