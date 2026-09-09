#!/usr/bin/env node
'use strict';
// OFFLINE proof of the Stripe billing path — no Stripe account or network needed.
//
//   node scripts/test-stripe.js            # DATABASE_URL defaults to the cc_billing dev database (docs/.dbpw)
//   KEEP=1 node scripts/test-stripe.js     # keep the fixture jobs/payments for inspection
//
// Two things live in this file:
//   1. createFakeStripe() — an in-memory (optionally file-backed) stand-in for the Stripe SDK client that implements
//      exactly the methods lib/billing.js, jobs/renewals.js and scripts/stripe-setup.js call, validates the parameters
//      the way Stripe would, and simulates "the customer paid on the hosted page" (_pay/_renew/_fail). Webhook
//      signature verification is the REAL SDK code (Stripe.webhooks.generateTestHeaderString + constructEvent), so a
//      bad secret genuinely fails. lib/billing.js loads it when BILLING_FAKE_STRIPE=1 (never in production).
//   2. The lifecycle test: checkout create → checkout.session.completed → invoice.paid (job live, receipt, email)
//      → duplicate invoice.paid (no double record) → subscription.updated (cancel at period end) → resume/cancel via
//      Stripe → invoice.payment_failed (past_due + email) → subscription.deleted (cancelled, job archived, public 404)
//      → bad signature → API-version drift parsing → Stripe Tax variant → lookup_key Prices for BOTH roles (via
//      stripe-setup.js) → consultant checkout at $9.99 + $0.50 → pricing precedence (env > settings > constants)
//      → renewals charge the snapshot, not the current price → renewals reconciliation → and the same over HTTP
//      against a freshly spawned server (raw body + signature, 500-on-handler-failure, /billing/success
//      reconciliation, /billing/portal, receipt with GST number, role-priced checkout pages, PDF receipt links).
// Pricing under test (lib/constants + settings): employers 1499 + 75 = 1574 cents, consultants 999 + 50 = 1049.
// Prints PASS/FAIL per step and exits 1 on any failure.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

// ================================================================== fake Stripe client
function createFakeStripe(opts = {}) {
  const Stripe = require('stripe');
  const secret = opts.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test';
  const storeFile = opts.storeFile || process.env.BILLING_FAKE_STRIPE_STORE || null;   // share state between processes
  let S = { customers: {}, sessions: {}, subscriptions: {}, invoices: {}, products: {}, prices: {}, endpoints: {}, calls: [] };
  const load = () => { if (storeFile && fs.existsSync(storeFile)) { try { S = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch (_) {} } };
  const save = () => { if (storeFile) fs.writeFileSync(storeFile, JSON.stringify(S)); };
  load();
  const rid = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
  const ts = () => Math.floor(Date.now() / 1000);
  const clone = (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o)));
  const err = (message, code, type = 'StripeInvalidRequestError') => Object.assign(new Error(message), { code, type, statusCode: code === 'resource_missing' ? 404 : 400, rawType: 'invalid_request_error' });
  const must = (cond, msg) => { if (!cond) throw err(msg, 'parameter_invalid'); };
  // load() runs once at the START of every public method (via record()/the helpers below) — never mid-operation, so
  // objects created earlier in the same call are not discarded before save().
  const get = (bucket, id, what) => { const o = S[bucket][id]; if (!o) throw err(`No such ${what}: '${id}'`, 'resource_missing'); return o; };
  const record = (name, ...args) => { load(); S.calls.push({ name, args: clone(args), at: ts() }); save(); };
  const addMonthEpoch = (epoch, n = 1) => { const d = new Date(epoch * 1000); const r = new Date(d.getTime()); r.setUTCMonth(r.getUTCMonth() + n); if (r.getUTCDate() !== d.getUTCDate()) r.setUTCDate(0); return Math.floor(r.getTime() / 1000); };
  const unitAmount = (li) => { if (li.price_data) return li.price_data.unit_amount; const p = get('prices', li.price, 'price'); return p.unit_amount; };
  const lineName = (li) => (li.price_data ? li.price_data.product_data.name : (S.products[get('prices', li.price, 'price').product] || {}).name || li.price);

  function makeInvoice(sub, session, { periodStart, periodEnd, reason, paid = true }) {
    const lines = session.line_items.map((li, i) => ({ id: rid('il'), object: 'line_item', amount: unitAmount(li) * (li.quantity || 1), currency: 'cad', description: lineName(li), quantity: li.quantity || 1, period: { start: periodStart, end: periodEnd }, subscription: sub.id, subscription_item: sub.items.data[i] && sub.items.data[i].id, type: 'subscription' }));
    const subtotal = lines.reduce((a, l) => a + l.amount, 0);
    const autoTax = !!(session.automatic_tax && session.automatic_tax.enabled);
    const tax = autoTax ? Math.round(subtotal * 0.05) : null;     // Stripe Tax would compute 5% GST for a Canadian customer
    const total = subtotal + (tax || 0);
    const inv = { id: rid('in'), object: 'invoice', customer: sub.customer, subscription: sub.id, subscription_details: { metadata: clone(sub.metadata) }, status: paid ? 'paid' : 'open', paid,
      billing_reason: reason, currency: 'cad', period_start: periodStart, period_end: periodEnd, lines: { object: 'list', data: lines }, subtotal, subtotal_excluding_tax: subtotal, tax, total, total_excluding_tax: subtotal,
      amount_due: total, amount_paid: paid ? total : 0, amount_remaining: paid ? 0 : total, attempt_count: 1, created: ts(), hosted_invoice_url: `https://invoice.stripe.com/i/${rid('acct')}`, last_finalization_error: null };
    S.invoices[inv.id] = inv; sub.latest_invoice = inv.id; return inv;
  }

  const fake = {
    _fake: true, _secret: secret, _storeFile: storeFile,
    get _store() { load(); return S; },
    _calls(name) { load(); return S.calls.filter(c => !name || c.name === name); },
    webhooks: Stripe.webhooks,                                    // REAL signature verification
    customers: {
      create: async (params = {}) => { record('customers.create', params); must(!params.email || /@/.test(params.email), 'Invalid email'); const c = { id: rid('cus'), object: 'customer', email: params.email || null, name: params.name || null, metadata: params.metadata || {}, created: ts(), livemode: false }; S.customers[c.id] = c; save(); return clone(c); },
      retrieve: async (id) => { load(); return clone(get('customers', id, 'customer')); },
    },
    products: {
      create: async (params = {}) => { record('products.create', params); must(params.name, 'name required'); const p = { id: rid('prod'), object: 'product', name: params.name, description: params.description || null, active: true, metadata: params.metadata || {}, created: ts() }; S.products[p.id] = p; save(); return clone(p); },
      search: async ({ query }) => { load(); const m = /metadata\['(\w+)'\]:'([^']+)'/.exec(query || ''); return { object: 'search_result', data: Object.values(S.products).filter(p => p.active && (!m || p.metadata[m[1]] === m[2])).map(clone) }; },
      update: async (id, params = {}) => { record('products.update', id, params); const p = get('products', id, 'product'); Object.assign(p, params); save(); return clone(p); },
    },
    prices: {
      create: async (params = {}) => {
        record('prices.create', params);
        must(params.currency && Number.isInteger(params.unit_amount) && params.recurring && params.recurring.interval, 'currency, unit_amount and recurring.interval are required');
        must(params.product && S.products[params.product], `No such product: '${params.product}'`);
        if (params.lookup_key) for (const p of Object.values(S.prices)) if (p.lookup_key === params.lookup_key) { must(params.transfer_lookup_key, `lookup_key '${params.lookup_key}' is already in use`); p.lookup_key = null; }
        const p = { id: rid('price'), object: 'price', product: params.product, currency: params.currency, unit_amount: params.unit_amount, recurring: { interval: params.recurring.interval, interval_count: params.recurring.interval_count || 1, usage_type: 'licensed' }, lookup_key: params.lookup_key || null, nickname: params.nickname || null, active: true, type: 'recurring', tax_behavior: params.tax_behavior || 'unspecified', metadata: params.metadata || {}, created: ts() };
        S.prices[p.id] = p; save(); return clone(p);
      },
      list: async (params = {}) => { record('prices.list', params); let all = Object.values(S.prices); if (params.lookup_keys) all = all.filter(p => params.lookup_keys.includes(p.lookup_key)); if (params.active !== undefined) all = all.filter(p => p.active === params.active); if (params.product) all = all.filter(p => p.product === params.product); return { object: 'list', data: all.slice(0, params.limit || 10).map(clone), has_more: false }; },
      update: async (id, params = {}) => { record('prices.update', id, params); const p = get('prices', id, 'price'); Object.assign(p, params); save(); return clone(p); },
    },
    checkout: { sessions: {
      create: async (params = {}) => {
        record('checkout.sessions.create', params);
        must(params.mode === 'subscription', "mode must be 'subscription'");
        must(Array.isArray(params.line_items) && params.line_items.length, 'line_items is required');
        must(params.success_url && params.cancel_url, 'success_url and cancel_url are required');
        must(!(params.customer && params.customer_email), 'customer and customer_email are mutually exclusive');
        if (params.customer) get('customers', params.customer, 'customer');
        if (params.customer_update) must(params.customer, 'customer_update can only be provided when customer is provided');
        if (params.automatic_tax && params.automatic_tax.enabled && params.customer) must(params.customer_update && params.customer_update.address === 'auto', 'automatic_tax with an existing customer requires customer_update[address]=auto');
        for (const li of params.line_items) {
          must(li.price || li.price_data, 'each line item needs price or price_data');
          if (li.price_data) { const pd = li.price_data; must(pd.currency && Number.isInteger(pd.unit_amount) && pd.recurring && pd.recurring.interval, 'price_data needs currency, unit_amount and recurring.interval'); must(pd.product_data && pd.product_data.name, 'price_data.product_data.name is required'); }
          else { const p = get('prices', li.price, 'price'); must(p.active && p.recurring, 'price must be an active recurring price'); }
        }
        const s = { id: rid('cs_test'), object: 'checkout.session', mode: 'subscription', status: 'open', payment_status: 'unpaid', livemode: false, url: `https://checkout.stripe.com/c/pay/${rid('cs_test')}`,
          customer: params.customer || null, customer_email: params.customer_email || null, client_reference_id: params.client_reference_id || null, metadata: params.metadata || {}, subscription: null,
          currency: params.currency || 'cad', locale: params.locale || null, billing_address_collection: params.billing_address_collection || null, success_url: params.success_url, cancel_url: params.cancel_url,
          line_items: params.line_items, subscription_data: params.subscription_data || {}, automatic_tax: params.automatic_tax || { enabled: false }, customer_update: params.customer_update || null, created: ts(), expires_at: ts() + 86400 };
        S.sessions[s.id] = s; save();
        const out = clone(s); delete out.line_items; return out;      // the real API does not return line_items unless expanded
      },
      retrieve: async (id, params = {}) => {
        record('checkout.sessions.retrieve', id, params);
        const s = clone(get('sessions', id, 'checkout.session')); delete s.line_items;
        const expand = params.expand || [];
        if (s.subscription && expand.some(e => e.startsWith('subscription'))) {
          s.subscription = clone(S.subscriptions[s.subscription]);
          if (expand.includes('subscription.latest_invoice') && s.subscription.latest_invoice) s.subscription.latest_invoice = clone(S.invoices[s.subscription.latest_invoice]);
        }
        return s;
      },
    } },
    subscriptions: {
      retrieve: async (id, params = {}) => {
        record('subscriptions.retrieve', id, params);
        if (/^sub_boom/.test(id)) throw Object.assign(new Error('An error occurred with our connection to Stripe. Request was retried 2 times.'), { type: 'StripeConnectionError' });
        const s = clone(get('subscriptions', id, 'subscription'));
        if ((params.expand || []).includes('latest_invoice') && s.latest_invoice) s.latest_invoice = clone(S.invoices[s.latest_invoice]);
        return s;
      },
      update: async (id, params = {}) => { record('subscriptions.update', id, params); const s = get('subscriptions', id, 'subscription'); must(s.status !== 'canceled', 'A canceled subscription can only be updated to add metadata'); if ('cancel_at_period_end' in params) s.cancel_at_period_end = !!params.cancel_at_period_end; if (params.metadata) Object.assign(s.metadata, params.metadata); save(); return clone(s); },
      cancel: async (id, params = {}) => { record('subscriptions.cancel', id, params); const s = get('subscriptions', id, 'subscription'); s.status = 'canceled'; s.canceled_at = ts(); s.ended_at = ts(); s.cancel_at_period_end = false; save(); return clone(s); },
    },
    billingPortal: { sessions: { create: async (params = {}) => { record('billingPortal.sessions.create', params); must(params.customer, 'customer is required'); get('customers', params.customer, 'customer'); return { id: rid('bps'), object: 'billing_portal.session', customer: params.customer, return_url: params.return_url || null, url: `https://billing.stripe.com/p/session/test_${rid('YWNjdA')}`, created: ts(), livemode: false }; } } },
    webhookEndpoints: {
      list: async () => { load(); return { object: 'list', data: Object.values(S.endpoints).map(clone) }; },
      create: async (params = {}) => { record('webhookEndpoints.create', params); must(params.url && Array.isArray(params.enabled_events) && params.enabled_events.length, 'url and enabled_events are required'); const e = { id: rid('we'), object: 'webhook_endpoint', url: params.url, enabled_events: params.enabled_events, description: params.description || null, status: 'enabled', secret: 'whsec_' + crypto.randomBytes(16).toString('hex'), api_version: params.api_version || null, created: ts() }; S.endpoints[e.id] = e; save(); const out = clone(e); return out; },
    },

    // ---------------------------------------------------------- simulation helpers (not part of the Stripe API)
    /** The customer paid on the hosted page: creates the Subscription + first paid Invoice, marks the session complete. */
    _pay(sessionId, { at = ts() } = {}) {
      load();
      const session = get('sessions', sessionId, 'checkout.session');
      must(session.status === 'open', 'session already completed');
      let customer = session.customer;
      if (!customer) { const c = { id: rid('cus'), object: 'customer', email: session.customer_email, name: null, metadata: {}, created: ts() }; S.customers[c.id] = c; customer = c.id; }
      const sd = session.subscription_data || {};
      const sub = { id: rid('sub'), object: 'subscription', status: 'active', customer, metadata: clone(sd.metadata || {}), description: sd.description || null, cancel_at_period_end: false, canceled_at: null, currency: 'cad',
        current_period_start: at, current_period_end: addMonthEpoch(at), created: at, latest_invoice: null, livemode: false,
        items: { object: 'list', data: session.line_items.map(li => ({ id: rid('si'), object: 'subscription_item', quantity: li.quantity || 1, current_period_start: at, current_period_end: addMonthEpoch(at), price: li.price ? clone(S.prices[li.price]) : { id: rid('price'), object: 'price', unit_amount: li.price_data.unit_amount, currency: li.price_data.currency, recurring: li.price_data.recurring, product: rid('prod') } })) } };
      S.subscriptions[sub.id] = sub;
      const invoice = makeInvoice(sub, session, { periodStart: at, periodEnd: addMonthEpoch(at), reason: 'subscription_create' });
      Object.assign(session, { status: 'complete', payment_status: 'paid', subscription: sub.id, customer });
      save();
      return { session: clone(session), subscription: clone(sub), invoice: clone(invoice) };
    },
    /** Next monthly charge succeeded. */
    _renew(subId) { load(); const sub = get('subscriptions', subId, 'subscription'); const session = Object.values(S.sessions).find(s => s.subscription === subId); const start = sub.current_period_end; sub.current_period_start = start; sub.current_period_end = addMonthEpoch(start); sub.items.data.forEach(i => { i.current_period_start = start; i.current_period_end = sub.current_period_end; }); sub.status = 'active'; const invoice = makeInvoice(sub, session, { periodStart: start, periodEnd: sub.current_period_end, reason: 'subscription_cycle' }); save(); return { subscription: clone(sub), invoice: clone(invoice) }; },
    /** Next monthly charge failed (card declined). */
    _fail(subId, message = 'Your card was declined.') { load(); const sub = get('subscriptions', subId, 'subscription'); const session = Object.values(S.sessions).find(s => s.subscription === subId); const start = sub.current_period_end; const invoice = makeInvoice(sub, session, { periodStart: start, periodEnd: addMonthEpoch(start), reason: 'subscription_cycle', paid: false }); invoice.last_finalization_error = null; invoice.last_payment_error = { message }; sub.status = 'past_due'; save(); return { subscription: clone(sub), invoice: clone(invoice) }; },
    /** A signed webhook delivery for an object: { event, payload, header }. Pass a different secret to forge a bad signature. */
    _signed(type, object, { secret: sec = secret, timestamp } = {}) {
      const event = { id: rid('evt'), object: 'event', api_version: '2025-02-24.acacia', created: ts(), livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object } };
      const payload = JSON.stringify(event);
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: sec, timestamp });
      return { event, payload, header };
    },
  };
  return fake;
}

module.exports = { createFakeStripe };
if (require.main !== module) return;

// ================================================================== the test
(async () => {
  // ---- environment: fake client on, non-production, test secrets, dev DB
  if (process.env.NODE_ENV === 'production') { console.error('Refusing to run against NODE_ENV=production'); process.exit(2); }
  process.env.NODE_ENV = 'development';
  process.env.BILLING_FAKE_STRIPE = '1';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake_offline';
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_' + crypto.randomBytes(12).toString('hex');
  process.env.GST_NUMBER = process.env.GST_NUMBER || '123456789 RT0001';
  delete process.env.STRIPE_TAX; delete process.env.POSTING_PRICE_CENTS; delete process.env.EMPLOYER_PRICE_CENTS; delete process.env.CONSULTANT_PRICE_CENTS;
  for (const k of Object.keys(process.env)) if (/^STRIPE_PRICE_/.test(k)) delete process.env[k];
  const ROOT = path.join(__dirname, '..');
  if (!process.env.DATABASE_URL) {
    const pw = fs.readFileSync(path.join(ROOT, 'docs', '.dbpw'), 'utf8').trim().split('=').pop();
    process.env.DATABASE_URL = `postgres://canada_careers:${pw}@127.0.0.1:5432/cc_billing`;
  }
  const port = await freePort();
  process.env.PORT = String(port);
  process.env.PUBLIC_URL = `http://localhost:${port}`;
  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cc-stripe-'));
  process.env.BILLING_FAKE_STRIPE_STORE = path.join(scratch, 'fake-stripe.json');

  const db = require('../lib/db');
  const jobs = require('../lib/jobs');
  const billing = require('../lib/billing');
  const { runRenewals } = require('../jobs/renewals');
  const { request, CookieJar } = require('./cdp');
  const fake = billing.stripe();
  const SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const Stripe = require('stripe');

  const results = [];
  let server = null;
  const step = async (name, fn) => {
    try { const note = await fn(); results.push([true, name, note]); console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`); }
    catch (e) { results.push([false, name, e.message]); console.log(`FAIL  ${name} — ${e.stack || e.message}`); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const eq = (a, b, what) => assert(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  const deliver = (type, object, opts) => { const d = fake._signed(type, object, opts); const event = fake.webhooks.constructEvent(Buffer.from(d.payload), d.header, SECRET); return billing.handleStripeEvent(event); };
  const jobRow = (id) => db.one('SELECT * FROM jobs WHERE id=$1', [id]);
  const subRow = (id) => db.one('SELECT * FROM subscriptions WHERE job_id=$1', [id]);
  const payCount = (id) => db.one("SELECT count(*)::int AS n FROM payments WHERE job_id=$1 AND status='paid'", [id]).then(r => r.n);
  const isPublic = (id) => db.one(`SELECT 1 FROM jobs WHERE id=$1 AND ${jobs.PUBLIC_WHERE}`, [id]).then(r => !!r);
  const near = (a, b, tolMs = 5000) => Math.abs(new Date(a) - new Date(b)) <= tolMs;

  // ---- fixtures: our own jobs under the seeded employer (never touch other rows)
  const user = await db.one("SELECT id, email, role, name FROM users WHERE email='employer@example.com'");
  const profile = await db.one('SELECT * FROM employer_profiles WHERE owner_user_id=$1 ORDER BY id LIMIT 1', [user.id]);
  assert(user && profile, 'seed employer@example.com + profile required');
  const consultant = await db.one("SELECT id, email, role, name FROM users WHERE email='consultant@example.com'");
  const cprofile = consultant && await db.one('SELECT * FROM employer_profiles WHERE owner_user_id=$1 AND NOT archived ORDER BY id LIMIT 1', [consultant.id]);
  assert(consultant && cprofile, 'seed consultant@example.com + profile required');
  const tag = `stripe-test-${Date.now()}`;
  const fixtures = [];
  async function newJobFor(u, prof, title) {
    const j = await db.one(`INSERT INTO jobs(employer_profile_id, created_by, title, slug, description, category, job_type, work_arrangement, city, province, audiences, status)
                            VALUES ($1,$2,$3,$4,'Offline Stripe lifecycle test posting. Safe to delete.','it','full_time','remote','Toronto','ON','{professionals}','draft') RETURNING *`,
      [prof.id, u.id, title, `${tag}-${fixtures.length + 1}`]);
    fixtures.push(j.id);
    return { ...j, company_name: prof.company_name, owner_user_id: prof.owner_user_id };
  }
  const newJob = (title) => newJobFor(user, profile, title);
  const mailCount = (subjectLike) => db.one('SELECT count(*)::int AS n FROM mail_outbox WHERE to_email=$1 AND subject ILIKE $2', [user.email, subjectLike]).then(r => r.n);

  try {
    console.log(`Offline Stripe proof — SDK ${Stripe.PACKAGE_VERSION || require('stripe/package.json').version}, DB ${process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}, fake store ${process.env.BILLING_FAKE_STRIPE_STORE}`);
    eq(billing.mode(), 'stripe', 'billing.mode()'); assert(fake._fake, 'fake client injected');

    await step('getPricing(role): employer 1499 + 75 = 1574, consultant 999 + 50 = 1049; env override wins over settings; legacy POSTING_PRICE_CENTS ignored', async () => {
      billing.resetPricingCache();
      const e = await billing.getPricing('employer'), c = await billing.getPricing('consultant'), u = await billing.getPricing(user), d = await billing.getPricing(undefined);
      eq(e.price_cents, 1499, 'employer price'); eq(e.tax_cents, 75, 'employer GST'); eq(e.total_cents, 1574, 'employer total'); eq(e.role, 'employer', 'role');
      eq(c.price_cents, 999, 'consultant price'); eq(c.tax_cents, 50, 'consultant GST'); eq(c.total_cents, 1049, 'consultant total'); eq(c.role, 'consultant', 'role');
      eq(u.price_cents, 1499, 'user object → employer'); eq(d.price_cents, 1499, 'no role → employer');
      const all = await billing.getAllPricing(); eq(all.employer.total_cents, 1574, 'getAllPricing employer'); eq(all.consultant.total_cents, 1049, 'getAllPricing consultant');
      process.env.CONSULTANT_PRICE_CENTS = '1299'; process.env.POSTING_PRICE_CENTS = '100'; billing.resetPricingCache();
      try {
        const c2 = await billing.getPricing('consultant'); eq(c2.price_cents, 1299, 'env consultant price'); eq(c2.tax_cents, 65, 'GST rounded to the cent (64.95 → 65)'); eq(c2.total_cents, 1364, 'total');
        eq((await billing.getPricing('employer')).price_cents, 1499, 'employer unaffected by CONSULTANT_PRICE_CENTS / POSTING_PRICE_CENTS');
      } finally { delete process.env.CONSULTANT_PRICE_CENTS; delete process.env.POSTING_PRICE_CENTS; billing.resetPricingCache(); }
      eq((await billing.getPricing('consultant')).price_cents, 999, 'back to settings after env removed');
      return 'employer 1574 / consultant 1049; env override + rounding ok';
    });

    // ============================================================ in-process lifecycle (job A)
    const A = await newJob('Stripe test A — bilingual support analyst');
    let sessA, subA;
    await step('checkout.sessions.create: subscription mode, CAD monthly posting + GST lines, metadata, customer reuse', async () => {
      const out = await billing.createCheckout(A, user, { company_name: profile.company_name });
      sessA = out.session; subA = await subRow(A.id);
      assert(/^https:\/\/checkout\.stripe\.com\//.test(out.url), `hosted url: ${out.url}`);
      const call = fake._calls('checkout.sessions.create').pop().args[0];
      eq(call.mode, 'subscription', 'mode'); eq(call.currency, 'cad', 'currency'); eq(call.locale, 'en', 'locale'); eq(call.billing_address_collection, 'auto', 'billing_address_collection');
      eq(call.line_items.length, 2, 'line items'); eq(call.line_items[0].price_data.unit_amount, 1499, 'posting cents (employer rate)'); eq(call.line_items[1].price_data.unit_amount, 75, 'GST cents');
      eq(call.metadata.payer_role, 'employer', 'metadata.payer_role');
      for (const li of call.line_items) { eq(li.price_data.currency, 'cad', 'li currency'); eq(li.price_data.recurring.interval, 'month', 'li interval'); }
      assert(call.line_items[1].price_data.product_data.name.startsWith('GST'), 'GST line label');
      eq(call.metadata.job_id, String(A.id), 'metadata.job_id'); eq(call.metadata.subscription_id, String(subA.id), 'metadata.subscription_id'); eq(call.metadata.user_id, String(user.id), 'metadata.user_id');
      eq(call.subscription_data.metadata.job_id, String(A.id), 'subscription_data.metadata.job_id'); eq(call.subscription_data.metadata.subscription_id, String(subA.id), 'subscription_data.metadata.subscription_id');
      assert(call.success_url === `${process.env.PUBLIC_URL}/billing/success?job=${A.id}&session_id={CHECKOUT_SESSION_ID}`, `success_url ${call.success_url}`);
      assert(call.cancel_url === `${process.env.PUBLIC_URL}/billing/cancelled?job=${A.id}`, 'cancel_url');
      assert(!call.automatic_tax, 'no automatic_tax without STRIPE_TAX');
      assert(/^cus_/.test(call.customer), 'customer passed'); eq(call.customer_update.address, 'auto', 'customer_update.address');
      const cust = fake._calls('customers.create').pop().args[0]; eq(cust.email, user.email, 'customer email'); eq(cust.metadata.user_id, String(user.id), 'customer metadata');
      eq(subA.provider, 'stripe', 'sub.provider'); eq(subA.provider_checkout_id, sessA.id, 'sub.provider_checkout_id'); eq(subA.provider_customer_id, call.customer, 'sub.provider_customer_id'); eq(subA.status, 'pending', 'sub.status');
      eq(subA.price_cents, 1499, 'snapshot price'); eq(subA.tax_cents, 75, 'snapshot GST'); eq(subA.total_cents, 1574, 'snapshot total'); eq((await jobRow(A.id)).status, 'draft', 'job untouched by checkout create (route sets pending_payment)');
      return `${sessA.id} for sub ${subA.id}, customer ${call.customer}`;
    });
    await db.query("UPDATE jobs SET status='pending_payment' WHERE id=$1", [A.id]);   // what POST /billing/checkout does

    let paidA;
    await step('checkout.session.completed links ids but does NOT activate', async () => {
      paidA = fake._pay(sessA.id);
      const out = await deliver('checkout.session.completed', paidA.session);
      const s = await subRow(A.id);
      eq(s.provider_subscription_id, paidA.subscription.id, 'provider_subscription_id'); eq(s.provider_customer_id, paidA.session.customer, 'provider_customer_id'); eq(s.status, 'pending', 'still pending');
      eq((await jobRow(A.id)).status, 'pending_payment', 'job not active yet'); eq(await payCount(A.id), 0, 'no payment yet');
      return out;
    });
    let receiptA;
    await step('invoice.paid activates the job, records the payment + receipt, emails the receipt (with GST number)', async () => {
      const before = await mailCount('Receipt CC-%');
      const out = await deliver('invoice.paid', paidA.invoice);
      const s = await subRow(A.id), j = await jobRow(A.id);
      eq(s.status, 'active', 'sub active'); assert(near(s.current_period_end, paidA.invoice.lines.data[0].period.end * 1000), 'period_end from invoice line');
      eq(j.status, 'active', 'job active'); assert(near(j.expires_at, s.current_period_end), 'job.expires_at = period_end'); assert(await isPublic(A.id), 'job publicly visible');
      const p = await db.one('SELECT * FROM payments WHERE job_id=$1', [A.id]); receiptA = p;
      eq(p.provider, 'stripe', 'payment.provider'); eq(p.provider_payment_id, paidA.invoice.id, 'payment.provider_payment_id = invoice id');
      assert(/^CC-\d{6}-\d{6}$/.test(p.receipt_number), `receipt number ${p.receipt_number}`); eq(p.amount_cents, 1499, 'amount'); eq(p.tax_cents, 75, 'tax'); eq(p.total_cents, 1574, 'total');
      eq(await mailCount('Receipt CC-%'), before + 1, 'receipt email queued');
      const m = await db.one('SELECT html, text FROM mail_outbox WHERE to_email=$1 ORDER BY id DESC LIMIT 1', [user.email]);
      assert(m.html.includes('123456789 RT0001') && m.text.includes('123456789 RT0001'), 'GST number on the emailed receipt');
      assert(m.html.includes('$15.74') && m.html.includes('employer rate') && /\/billing"/.test(m.html), 'email shows $15.74 at the employer rate + a Billing link for downloads');
      return `${out}; ${p.receipt_number}`;
    });
    await step('invoice.paid replayed with the same invoice id is idempotent', async () => {
      const before = await mailCount('Receipt CC-%');
      const out = await deliver('invoice.paid', paidA.invoice);
      eq(await payCount(A.id), 1, 'still one payment'); eq(await mailCount('Receipt CC-%'), before, 'no second receipt email');
      return out;
    });
    await step('customer.subscription.updated mirrors cancel_at_period_end + period end', async () => {
      const remote = { ...paidA.subscription, cancel_at_period_end: true };
      const out = await deliver('customer.subscription.updated', remote);
      const s = await subRow(A.id); eq(s.cancel_at_period_end, true, 'cancel_at_period_end'); eq(s.status, 'active', 'status unchanged');
      return out;
    });
    await step('resume() and cancel() call Stripe (subscriptions.update / cancel) when provider=stripe', async () => {
      await billing.resume(A.id, user);
      let c = fake._calls('subscriptions.update').pop(); eq(c.args[0], paidA.subscription.id, 'update target'); eq(c.args[1].cancel_at_period_end, false, 'resume -> cancel_at_period_end=false');
      eq((await subRow(A.id)).cancel_at_period_end, false, 'db resumed');
      const r = await billing.cancel(A.id, user);
      eq(r.immediate, false, 'cancel at period end'); c = fake._calls('subscriptions.update').pop(); eq(c.args[1].cancel_at_period_end, true, 'cancel -> cancel_at_period_end=true');
      eq(fake._store.subscriptions[paidA.subscription.id].cancel_at_period_end, true, 'Stripe subscription flagged');
      eq((await subRow(A.id)).cancel_at_period_end, true, 'db flagged'); assert(await isPublic(A.id), 'posting stays live until period end');
      return 'update x2';
    });
    await step('invoice.payment_failed -> past_due + "payment failed" email (once)', async () => {
      const before = await mailCount('Payment failed%');
      const failed = fake._fail(paidA.subscription.id);
      const out = await deliver('invoice.payment_failed', failed.invoice);
      eq((await subRow(A.id)).status, 'past_due', 'past_due'); eq(await mailCount('Payment failed%'), before + 1, 'email queued');
      await deliver('invoice.payment_failed', failed.invoice);
      eq(await mailCount('Payment failed%'), before + 1, 'no duplicate email on retry'); assert(await isPublic(A.id), 'still live until period end');
      return out;
    });
    await step('customer.subscription.deleted -> cancelled, job archived, gone from PUBLIC_WHERE', async () => {
      const out = await deliver('customer.subscription.deleted', { ...paidA.subscription, status: 'canceled', canceled_at: Math.floor(Date.now() / 1000) });
      const s = await subRow(A.id), j = await jobRow(A.id);
      eq(s.status, 'cancelled', 'sub cancelled'); assert(s.cancelled_at, 'cancelled_at set'); eq(j.status, 'cancelled', 'job cancelled'); assert(j.archived_at, 'archived_at set'); eq(await isPublic(A.id), false, 'not public (404 via PUBLIC_WHERE)');
      await deliver('customer.subscription.deleted', { ...paidA.subscription, status: 'canceled' });
      return out;
    });
    await step('bad webhook signature is rejected by the real SDK verifier', async () => {
      const d = fake._signed('invoice.paid', paidA.invoice, { secret: 'whsec_wrong' });
      let threw = null; try { fake.webhooks.constructEvent(Buffer.from(d.payload), d.header, SECRET); } catch (e) { threw = e; }
      assert(threw && threw.type === 'StripeSignatureVerificationError', 'wrong secret must throw StripeSignatureVerificationError');
      const stale = fake._signed('invoice.paid', paidA.invoice, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
      threw = null; try { fake.webhooks.constructEvent(Buffer.from(stale.payload), stale.header, SECRET); } catch (e) { threw = e; }
      assert(threw && /timestamp/i.test(threw.message), 'stale timestamp (replay) must be rejected');
      const tampered = fake._signed('invoice.paid', paidA.invoice);
      threw = null; try { fake.webhooks.constructEvent(Buffer.from(tampered.payload.replace('"amount_paid":1574', '"amount_paid":1')), tampered.header, SECRET); } catch (e) { threw = e; }
      assert(threw, 'tampered payload must be rejected');
      return 'wrong secret, stale timestamp, tampered body all rejected';
    });
    await step('API-version drift: newer-shape objects (parent.subscription_details, items[].current_period_end, total_taxes) parse', async () => {
      const inv = { id: 'in_new', object: 'invoice', status: 'paid', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_new', metadata: { subscription_id: '7' } } }, lines: { data: [{ period: { start: 1700000000, end: 1702592000 } }, { period: { start: 1700000000, end: 1702592000 } }] }, total_taxes: [{ amount: 50 }], amount_paid: 1049 };
      eq(billing.invoiceSubscriptionId(inv), 'sub_new', 'subscription id from parent'); eq(billing.invoiceTaxCents(inv), 50, 'tax from total_taxes'); eq(billing.invoicePeriod(inv).period_end.getTime(), 1702592000000, 'period from lines'); assert(billing.invoiceIsPaid(inv), 'paid');
      const sub = { id: 'sub_new', status: 'active', items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] } };
      eq(billing.subscriptionPeriod(sub).end.getTime(), 1702592000000, 'period end from items');
      const old = { id: 'in_old', subscription: { id: 'sub_old' }, tax: null, period_start: 1, period_end: 2, lines: { data: [] }, paid: true };
      eq(billing.invoiceSubscriptionId(old), 'sub_old', 'expanded subscription object'); eq(billing.invoiceTaxCents(old), null, 'no tax'); eq(billing.invoicePeriod(old).period_end.getTime(), 2000, 'fallback to invoice period'); assert(billing.invoiceIsPaid(old), 'paid (legacy flag)');
      return 'both shapes';
    });

    // ============================================================ Stripe Tax variant (job B)
    const B = await newJob('Stripe test B — Stripe Tax variant');
    await step('STRIPE_TAX=1: single posting line + automatic_tax; invoice tax recorded from Stripe', async () => {
      process.env.STRIPE_TAX = '1';
      try {
        const out = await billing.createCheckout(B, user, { company_name: profile.company_name });
        const call = fake._calls('checkout.sessions.create').pop().args[0];
        eq(call.line_items.length, 1, 'one line item'); eq(call.automatic_tax.enabled, true, 'automatic_tax'); eq(call.customer, (await subRow(A.id)).provider_customer_id, 'same Stripe customer reused for the same user');
        eq(fake._calls('customers.create').length, 1, 'customers.create called once across checkouts');
        const paid = fake._pay(out.session.id);
        eq(paid.invoice.tax, 75, 'fake Stripe Tax computed 5%'); eq(paid.invoice.amount_paid, 1574, 'total');
        await deliver('checkout.session.completed', paid.session); await deliver('invoice.paid', paid.invoice);
        const p = await db.one('SELECT * FROM payments WHERE job_id=$1', [B.id]); eq(p.amount_cents, 1499, 'amount'); eq(p.tax_cents, 75, 'tax from invoice'); eq(p.total_cents, 1574, 'total');
        eq((await jobRow(B.id)).status, 'active', 'job active');
        return `invoice ${paid.invoice.id}`;
      } finally { delete process.env.STRIPE_TAX; }
    });

    // ============================================================ lookup-key Prices via stripe-setup.js (job C)
    const C = await newJob('Stripe test C — lookup_key prices');
    let catalog;
    await step('scripts/stripe-setup.js creates 2 Products + 2 Prices PER ROLE idempotently (4 lookup keys); employer checkout then uses `price:` ids', async () => {
      const setup = require('./stripe-setup');
      const r1 = await setup.ensureCatalog(fake, await billing.getAllPricing(), { log: () => {} });
      const r2 = await setup.ensureCatalog(fake, await billing.getAllPricing(), { log: () => {} });
      catalog = r1;
      for (const role of ['employer', 'consultant']) {
        eq(r1[role].posting.id, r2[role].posting.id, `${role} posting price stable`); eq(r1[role].gst.id, r2[role].gst.id, `${role} gst price stable`);
        eq(r1[role].posting.lookup_key, billing.LOOKUP_KEYS[role].posting, `${role} posting lookup key`); eq(r1[role].gst.lookup_key, billing.LOOKUP_KEYS[role].gst, `${role} gst lookup key`);
      }
      eq(r1.employer.posting.unit_amount, 1499, 'employer posting amount'); eq(r1.employer.gst.unit_amount, 75, 'employer gst amount');
      eq(r1.consultant.posting.unit_amount, 999, 'consultant posting amount'); eq(r1.consultant.gst.unit_amount, 50, 'consultant gst amount');
      eq(fake._calls('prices.create').length, 4, 'four prices created once'); eq(fake._calls('products.create').length, 4, 'four products created once');
      billing.setStripeClient(fake);            // clears the price cache
      const out = await billing.createCheckout(C, user, { company_name: profile.company_name });
      const call = fake._calls('checkout.sessions.create').pop().args[0];
      eq(call.line_items[0].price, r1.employer.posting.id, 'posting by EMPLOYER price id'); eq(call.line_items[1].price, r1.employer.gst.id, 'gst by employer price id'); assert(!call.line_items[0].price_data, 'no price_data');
      const paid = fake._pay(out.session.id); eq(paid.invoice.amount_paid, 1574, 'invoice total from catalog prices');
      const wh = await setup.ensureWebhook(fake, `${process.env.PUBLIC_URL}/billing/webhook`, { log: () => {} });
      assert(/^whsec_/.test(wh.secret), 'webhook endpoint created with a secret'); eq(wh.enabled_events.length, billing.WEBHOOK_EVENTS.length, 'events');
      return `${r1.employer.posting.id}, ${r1.consultant.posting.id}, ${wh.id}`;
    });

    // ============================================================ consultant pricing (job G, paid by consultant@example.com)
    const G = await newJobFor(consultant, cprofile, 'Stripe test G — consultant rate');
    await step('consultant checkout: snapshot 999 + 50 = 1049, CONSULTANT lookup-key Prices, own Stripe customer; invoice.paid records $10.49 + emails the consultant-rate receipt', async () => {
      const out = await billing.createCheckout(G, consultant, { company_name: cprofile.company_name });
      const s = await subRow(G.id);
      eq(s.payer_user_id, consultant.id, 'payer'); eq(s.price_cents, 999, 'snapshot price'); eq(s.tax_cents, 50, 'snapshot GST'); eq(s.total_cents, 1049, 'snapshot total');
      const call = fake._calls('checkout.sessions.create').pop().args[0];
      eq(call.line_items[0].price, catalog.consultant.posting.id, 'posting by CONSULTANT price id'); eq(call.line_items[1].price, catalog.consultant.gst.id, 'gst by consultant price id');
      eq(call.metadata.payer_role, 'consultant', 'metadata.payer_role'); assert(call.customer !== (await subRow(A.id)).provider_customer_id, 'a different Stripe customer than the employer');
      const before = await db.one('SELECT count(*)::int AS n FROM mail_outbox WHERE to_email=$1', [consultant.email]).then(r => r.n);
      const paid = fake._pay(out.session.id); eq(paid.invoice.amount_paid, 1049, 'invoice total');
      await deliver('checkout.session.completed', paid.session); await deliver('invoice.paid', paid.invoice);
      const p = await db.one('SELECT * FROM payments WHERE job_id=$1', [G.id]); eq(p.amount_cents, 999, 'amount'); eq(p.tax_cents, 50, 'tax'); eq(p.total_cents, 1049, 'total'); eq((await jobRow(G.id)).status, 'active', 'job active');
      const m = await db.one('SELECT html, text FROM mail_outbox WHERE to_email=$1 ORDER BY id DESC LIMIT 1', [consultant.email]);
      eq(await db.one('SELECT count(*)::int AS n FROM mail_outbox WHERE to_email=$1', [consultant.email]).then(r => r.n), before + 1, 'receipt emailed to the consultant');
      assert(m.html.includes('$10.49') && m.html.includes('third party consultant rate') && !m.html.includes('$15.74'), 'email shows $10.49 at the consultant rate');
      return `${p.receipt_number} for ${consultant.email}`;
    });
    await step('inline price_data fallback carries the role snapshot when the catalog does not match (price changed after setup)', async () => {
      const H = await newJobFor(consultant, cprofile, 'Stripe test H — stale catalog');
      process.env.CONSULTANT_PRICE_CENTS = '1099'; billing.resetPricingCache();
      try {
        await billing.createCheckout(H, consultant, { company_name: cprofile.company_name });
        const s = await subRow(H.id); eq(s.price_cents, 1099, 'snapshot at the new price'); eq(s.tax_cents, 55, 'GST 54.95 → 55'); eq(s.total_cents, 1154, 'total');
        const call = fake._calls('checkout.sessions.create').pop().args[0];
        assert(call.line_items[0].price_data && call.line_items[0].price_data.unit_amount === 1099, 'posting sent inline at 1099 (catalog Price is 999, so it is NOT used)');
        assert(call.line_items[1].price_data && call.line_items[1].price_data.unit_amount === 55, 'GST sent inline at 55');
        eq(call.line_items[0].price_data.product_data.metadata.payer_role, 'consultant', 'role on the inline product');
      } finally { delete process.env.CONSULTANT_PRICE_CENTS; billing.resetPricingCache(); }
      return 'inline 1099 + 55';
    });
    await step('renewals charge the SNAPSHOT: a sandbox subscription at 1574 renews at 1574 even after EMPLOYER_PRICE_CENTS changes to 1999', async () => {
      const S = await newJob('Stripe test S — sandbox renewal snapshot');
      const sub = await billing.ensureSubscription(S, user);                                      // snapshot 1499/75/1574
      eq(sub.total_cents, 1574, 'snapshot');
      await db.query("UPDATE subscriptions SET provider='sandbox', status='active', current_period_start=now() - interval '32 days', current_period_end=now() - interval '1 day' WHERE id=$1", [sub.id]);
      await db.query("UPDATE jobs SET status='active', expires_at=now() - interval '1 day', published_at=now() - interval '32 days' WHERE id=$1", [S.id]);
      process.env.EMPLOYER_PRICE_CENTS = '1999'; billing.resetPricingCache();
      try {
        eq((await billing.getPricing('employer')).total_cents, 2099, 'current price is now 2099');
        const counts = await runRenewals({ log: () => {} });
        assert(counts.renewed >= 1, `renewed ${counts.renewed}`); eq(counts.errors, 0, 'no errors');
        const p = await db.one('SELECT * FROM payments WHERE job_id=$1 ORDER BY id DESC LIMIT 1', [S.id]);
        eq(p.amount_cents, 1499, 'renewal amount = snapshot'); eq(p.tax_cents, 75, 'renewal GST = snapshot'); eq(p.total_cents, 1574, 'renewal total = snapshot, not 2099');
        const s2 = await subRow(S.id); assert(new Date(s2.current_period_end) > new Date(), 'period extended'); eq(s2.total_cents, 1574, 'snapshot untouched');
        eq((await jobRow(S.id)).status, 'active', 'job active');
      } finally { delete process.env.EMPLOYER_PRICE_CENTS; billing.resetPricingCache(); }
      return 'renewed at 1574 while current price was 2099';
    });
    await step('/billing/success reconciliation (no webhook yet): retrieve session -> link + record + activate', async () => {
      const s0 = await subRow(C.id); eq(s0.status, 'pending', 'pending before');
      await billing.reconcileCheckoutSession(s0.provider_checkout_id, C.id);
      const s = await subRow(C.id), j = await jobRow(C.id);
      eq(s.status, 'active', 'sub active'); eq(j.status, 'active', 'job active'); eq(await payCount(C.id), 1, 'one payment');
      eq(await billing.reconcileCheckoutSession(s0.provider_checkout_id, 999999), null, 'session for another job is refused');
      return `sub ${s.provider_subscription_id}`;
    });
    await step('renewals: lapsed Stripe subscription reconciled from latest_invoice; unlinked pending checkout reconciled', async () => {
      const s = await subRow(C.id);
      fake._renew(s.provider_subscription_id);                                                  // Stripe charged month 2, webhook "lost"
      await db.query("UPDATE subscriptions SET current_period_end=now() - interval '1 day' WHERE id=$1", [s.id]);
      await db.query("UPDATE jobs SET expires_at=now() - interval '1 day' WHERE id=$1", [C.id]);
      const D = await newJob('Stripe test D — orphan checkout'); await db.query("UPDATE jobs SET status='pending_payment' WHERE id=$1", [D.id]);
      const outD = await billing.createCheckout(D, user, { company_name: profile.company_name }); fake._pay(outD.session.id);
      await db.query("UPDATE subscriptions SET updated_at=now() - interval '2 hours' WHERE job_id=$1", [D.id]);
      const counts = await runRenewals({ log: () => {} });
      assert(counts.stripe_reconciled >= 2, `stripe_reconciled ${counts.stripe_reconciled}`); eq(counts.errors, 0, 'no errors');
      const s2 = await subRow(C.id), j2 = await jobRow(C.id);
      eq(await payCount(C.id), 2, 'second payment recorded'); assert(new Date(s2.current_period_end) > new Date(), 'period extended'); eq(j2.status, 'active', 'job still active'); assert(await isPublic(C.id), 'public');
      eq((await subRow(D.id)).status, 'active', 'orphan checkout activated'); eq((await jobRow(D.id)).status, 'active', 'job D active');
      const p2 = await db.one('SELECT * FROM payments WHERE job_id=$1 ORDER BY id DESC LIMIT 1', [C.id]); eq(p2.total_cents, 1574, 'renewal invoice recorded at the employer snapshot');
      const again = await runRenewals({ log: () => {} }); eq(again.stripe_reconciled, 0, 'second run is a no-op'); eq(await payCount(C.id), 2, 'no duplicate on re-run');
      return JSON.stringify(counts);
    });
    await step('cancel(now) calls subscriptions.cancel and archives immediately', async () => {
      const s = await subRow(C.id);
      const r = await billing.cancel(C.id, user, { now: true });
      eq(r.immediate, true, 'immediate'); eq(fake._calls('subscriptions.cancel').pop().args[0], s.provider_subscription_id, 'cancel target'); eq(fake._store.subscriptions[s.provider_subscription_id].status, 'canceled', 'Stripe status');
      eq((await jobRow(C.id)).status, 'cancelled', 'job cancelled'); eq(await isPublic(C.id), false, 'not public');
      return 'ok';
    });
    await step('portalUrl() opens a Customer Portal session for the user\'s Stripe customer', async () => {
      const url = await billing.portalUrl(user, '/billing');
      assert(/^https:\/\/billing\.stripe\.com\//.test(url), `portal url ${url}`);
      const c = fake._calls('billingPortal.sessions.create').pop().args[0]; eq(c.customer, (await subRow(A.id)).provider_customer_id, 'customer'); eq(c.return_url, `${process.env.PUBLIC_URL}/billing`, 'return_url');
      return url;
    });

    // ============================================================ over HTTP against a spawned server (job E)
    server = await startServer(ROOT, port);
    const BASE = process.env.PUBLIC_URL;
    const E = await newJob('Stripe test E — HTTP end-to-end');
    const jar = new CookieJar();
    let sessE, paidE, subE;
    await step('HTTP: dev login, POST /billing/checkout -> 303 to Stripe hosted Checkout', async () => {
      const l = await request(BASE, `/billing-dev-login/${encodeURIComponent(user.email)}?next=/billing`, { jar }); eq(l.status, 302, 'dev login');
      const r = await request(BASE, `/billing/checkout/${E.id}`, { method: 'POST', jar, form: {} });
      eq(r.status, 303, 'redirect'); assert(/^https:\/\/checkout\.stripe\.com\//.test(r.location), `location ${r.location}`);
      subE = await subRow(E.id); eq(subE.provider, 'stripe', 'provider'); eq((await jobRow(E.id)).status, 'pending_payment', 'job pending_payment');
      sessE = fake._store.sessions[subE.provider_checkout_id]; assert(sessE, 'session in shared fake store');
      return r.location;
    });
    const post = (payload, header) => fetch(`${BASE}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
    await step('HTTP: POST /billing/webhook with a bad signature -> 400, nothing recorded', async () => {
      paidE = fake._pay(sessE.id);
      const d = fake._signed('invoice.paid', paidE.invoice, { secret: 'whsec_wrong' });
      const r = await post(d.payload, d.header); eq(r.status, 400, 'status'); eq(await payCount(E.id), 0, 'no payment');
      const r2 = await fetch(`${BASE}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: d.payload }); eq(r2.status, 400, 'missing header');
      return (await r.text()).slice(0, 80);
    });
    await step('HTTP: signed checkout.session.completed + invoice.paid -> 200, job live; replay -> 200 no duplicate', async () => {
      let d = fake._signed('checkout.session.completed', paidE.session); let r = await post(d.payload, d.header); eq(r.status, 200, 'completed status');
      d = fake._signed('invoice.paid', paidE.invoice); r = await post(d.payload, d.header); eq(r.status, 200, 'paid status');
      const body = await r.json(); assert(body.received && /payment CC-/.test(body.outcome), `outcome ${body.outcome}`);
      eq((await jobRow(E.id)).status, 'active', 'job active'); eq(await payCount(E.id), 1, 'payment');
      r = await post(d.payload, d.header); eq(r.status, 200, 'replay status'); eq(await payCount(E.id), 1, 'no duplicate');
      return body.outcome;
    });
    await step('HTTP: handler failure after a valid signature -> 500 so Stripe retries', async () => {
      const inv = { ...paidE.invoice, id: 'in_boom', subscription: 'sub_boom_1', subscription_details: { metadata: {} } };   // unknown sub + API outage on lookup
      const d = fake._signed('invoice.paid', inv);
      const r = await post(d.payload, d.header); eq(r.status, 500, 'status'); eq(await payCount(E.id), 1, 'nothing recorded');
      return (await r.text()).slice(0, 80);
    });
    await step('HTTP: GET /billing/success?session_id= shows the live confirmation; GET /billing shows the portal button', async () => {
      const r = await request(BASE, `/billing/success?job=${E.id}&session_id=${sessE.id}`, { jar });
      eq(r.status, 200, 'status'); assert(/Your posting is live until/.test(r.text), 'live headline'); assert(!/data-poll/.test(r.text), 'no polling once live');
      const b = await request(BASE, '/billing', { jar }); eq(b.status, 200, 'billing'); assert(b.text.includes('href="/billing/portal"'), 'portal button'); assert(b.text.includes(E.title), 'subscription listed'); assert(!/Sandbox mode/.test(b.text), 'no sandbox banner in stripe mode');
      return 'ok';
    });
    await step('HTTP: GET /billing/portal -> 303 to the Stripe Customer Portal', async () => {
      const r = await request(BASE, '/billing/portal', { jar }); eq(r.status, 303, 'status'); assert(/^https:\/\/billing\.stripe\.com\//.test(r.location), `location ${r.location}`);
      return r.location;
    });
    await step('HTTP: receipt page shows the GST registration number and Stripe as the provider', async () => {
      const p = await db.one('SELECT id FROM payments WHERE job_id=$1', [E.id]);
      const r = await request(BASE, `/billing/receipt/${p.id}`, { jar }); eq(r.status, 200, 'status'); assert(r.text.includes('123456789 RT0001'), 'GST number'); assert(/Paid via <strong>Stripe<\/strong>/.test(r.text), 'provider');
      return `/billing/receipt/${p.id}`;
    });
    await step('HTTP: success page before the webhook (job F) reconciles the session and goes live; pending state polls', async () => {
      const F = await newJob('Stripe test F — success before webhook');
      const r0 = await request(BASE, `/billing/checkout/${F.id}`, { method: 'POST', jar, form: {} }); eq(r0.status, 303, 'checkout');
      const sF = await subRow(F.id);
      const pend = await request(BASE, `/billing/success?job=${F.id}`, { jar }); eq(pend.status, 200, 'pending page'); assert(/data-poll=/.test(pend.text) && /Confirming your payment/.test(pend.text), 'pending state with polling');
      fake._pay(sF.provider_checkout_id);
      const r = await request(BASE, `/billing/success?job=${F.id}&session_id=${sF.provider_checkout_id}`, { jar });
      eq(r.status, 200, 'status'); assert(/Your posting is live until/.test(r.text), 'live after reconcile'); eq((await jobRow(F.id)).status, 'active', 'job active'); eq(await payCount(F.id), 1, 'payment');
      return 'ok';
    });
    await step('HTTP: POST /billing/cancel (period end) and /billing/resume hit Stripe', async () => {
      const s = await subRow(E.id); const n = fake._calls('subscriptions.update').length;
      let r = await request(BASE, `/billing/cancel/${E.id}`, { method: 'POST', jar, form: {} }); eq(r.status, 302, 'cancel'); eq((await subRow(E.id)).cancel_at_period_end, true, 'flagged');
      r = await request(BASE, `/billing/resume/${E.id}`, { method: 'POST', jar, form: {} }); eq(r.status, 302, 'resume'); eq((await subRow(E.id)).cancel_at_period_end, false, 'unflagged');
      eq(fake._calls('subscriptions.update').length, n + 2, 'two Stripe updates'); eq(fake._store.subscriptions[s.provider_subscription_id].cancel_at_period_end, false, 'Stripe state');
      return 'ok';
    });
    await step('HTTP: sandbox card page is unreachable in Stripe mode', async () => {
      const s = await subRow(E.id);
      const r = await request(BASE, `/billing/sandbox/${s.provider_checkout_id}`, { jar }); eq(r.status, 404, 'status');
      return 'ok';
    });
    await step('HTTP: checkout page shows $14.99 + $0.75 = $15.74 to the employer and $9.99 + $0.50 = $10.49 to the consultant', async () => {
      const E2 = await newJob('Stripe test E2 — employer checkout page');
      const r = await request(BASE, `/billing/checkout/${E2.id}`, { jar }); eq(r.status, 200, 'employer checkout');
      const lines = (html) => (html.match(/<table class="bill-lines"[\s\S]*?<\/table>/) || [''])[0];   // the order summary only (the site footer mentions the from-price)
      assert(/\$14\.99/.test(lines(r.text)) && /\$0\.75/.test(lines(r.text)) && /\$15\.74/.test(lines(r.text)) && /Employer rate/.test(lines(r.text)), 'employer amounts + rate label');
      assert(!/\$9\.99/.test(lines(r.text)) && !/\$10\.49/.test(lines(r.text)), 'no consultant amounts in the employer order summary');
      const cjar = new CookieJar();
      const l = await request(BASE, `/billing-dev-login/${encodeURIComponent(consultant.email)}?next=/billing`, { jar: cjar }); eq(l.status, 302, 'consultant dev login');
      const G2 = await newJobFor(consultant, cprofile, 'Stripe test G2 — consultant checkout page');
      const c = await request(BASE, `/billing/checkout/${G2.id}`, { jar: cjar }); eq(c.status, 200, 'consultant checkout');
      assert(/\$9\.99/.test(lines(c.text)) && /\$0\.50/.test(lines(c.text)) && /\$10\.49/.test(lines(c.text)) && /Third party consultant rate/.test(lines(c.text)), 'consultant amounts + rate label');
      assert(!/\$14\.99/.test(lines(c.text)) && !/\$15\.74/.test(lines(c.text)), 'no employer amounts in the consultant order summary');
      eq((await subRow(E2.id)).total_cents, 1574, 'employer snapshot'); eq((await subRow(G2.id)).total_cents, 1049, 'consultant snapshot');
      const b = await request(BASE, '/billing', { jar: cjar }); eq(b.status, 200, 'consultant /billing');
      assert(/As a third party consultant, each job posting costs <strong>\$9\.99/.test(b.text) && /employers pay \$14\.99/.test(b.text), 'consultant pricing note');
      return 'both pages priced by the payer role';
    });
    await step('HTTP: /billing lists every receipt with View + Download (PDF); ?print=1 opens the receipt with the print dialog; print stylesheet inline', async () => {
      const p = await db.one('SELECT id FROM payments WHERE job_id=$1', [E.id]);
      const b = await request(BASE, '/billing', { jar }); eq(b.status, 200, 'billing');
      assert(b.text.includes(`href="/billing/receipt/${p.id}"`) && b.text.includes(`href="/billing/receipt/${p.id}?print=1"`) && /Download \(PDF\)/.test(b.text), 'view + download links');
      assert(/All receipts are available from your login/.test(b.text), 'receipts-from-your-login copy');
      const r = await request(BASE, `/billing/receipt/${p.id}?print=1`, { jar }); eq(r.status, 200, 'receipt');
      assert(/window\.print\(\)/.test(r.text) && /Download receipt \(PDF\)/.test(r.text) && /data-print/.test(r.text), 'autoprint + download button');
      assert(/@media print/.test(r.text) && /\$15\.74/.test(r.text) && /employer rate/.test(r.text), 'print stylesheet + snapshot amounts + rate label');
      const plain = await request(BASE, `/billing/receipt/${p.id}`, { jar }); assert(!/window\.print\(\)/.test(plain.text), 'no autoprint without ?print=1');
      return `/billing/receipt/${p.id}?print=1`;
    });
  } catch (e) {
    results.push([false, 'harness', e.message]); console.log('FAIL  harness —', e.stack);
  } finally {
    if (server) server.kill();
    if (!process.env.KEEP) { for (const id of fixtures) await db.query('DELETE FROM jobs WHERE id=$1', [id]); await db.query("DELETE FROM mail_outbox WHERE to_email = ANY($1) AND created_at > now() - interval '10 minutes' AND (subject ILIKE '%Stripe test%')", [[user.email, consultant.email]]); }
    else console.log('KEEP=1: fixture job ids', fixtures.join(', '));
    fs.rmSync(scratch, { recursive: true, force: true });
    await db.pool.end();
  }
  const failed = results.filter(r => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} steps passed${failed ? ` — ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// ================================================================== helpers
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
}
async function startServer(root, port) {
  const logFile = path.join(root, 'shots', 'stripe', 'test-server.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'w');
  const proc = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), PUBLIC_URL: `http://localhost:${port}` }, stdio: ['ignore', out, out] });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://localhost:${port}/healthz`); if (r.ok) return proc; } catch (_) {}
    if (proc.exitCode !== null) throw new Error(`server exited early, see ${logFile}`);
    await new Promise(r => setTimeout(r, 200));
  }
  proc.kill(); throw new Error(`server did not start on ${port}, see ${logFile}`);
}
