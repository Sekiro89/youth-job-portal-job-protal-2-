#!/usr/bin/env node
'use strict';
// One-time Stripe setup (idempotent — safe to re-run). Needs STRIPE_SECRET_KEY in .env or the environment.
//
//   node scripts/stripe-setup.js                    # create/verify Product + Prices, print webhook instructions
//   node scripts/stripe-setup.js --create-webhook   # also create the webhook endpoint via the API and print its secret ONCE
//   node scripts/stripe-setup.js --url https://jobs.khosha.tech   # override PUBLIC_URL for the webhook address
//
// What it creates (found again by lookup_key / metadata on later runs, so nothing is duplicated) — one pair per payer role:
//   Product "Job posting (monthly) — employer"                + Price 1499 CAD / month, lookup_key cc_posting_employer_monthly   (tax_behavior exclusive)
//   Product "GST (5%) — employer posting"                     + Price   75 CAD / month, lookup_key cc_gst_employer_monthly       (skipped with STRIPE_TAX=1)
//   Product "Job posting (monthly) — third party consultant"  + Price  999 CAD / month, lookup_key cc_posting_consultant_monthly (tax_behavior exclusive)
//   Product "GST (5%) — consultant posting"                   + Price   50 CAD / month, lookup_key cc_gst_consultant_monthly     (skipped with STRIPE_TAX=1)
// lib/billing.js resolves the payer role's lookup_keys at checkout time (cached 10 min) and only uses a Price whose amount
// matches the subscription's price snapshot (EMPLOYER_PRICE_CENTS / CONSULTANT_PRICE_CENTS / GST_RATE); otherwise it falls
// back to inline price_data. If a price changes, re-run this script: it creates a new Price and moves the lookup_key to it
// (transfer_lookup_key). Existing Stripe subscriptions keep the Price they were created with — renewals never re-price.
const path = require('node:path');

const LOOKUP_KEYS = {
  employer: { posting: 'cc_posting_employer_monthly', gst: 'cc_gst_employer_monthly' },
  consultant: { posting: 'cc_posting_consultant_monthly', gst: 'cc_gst_consultant_monthly' },
};
const ROLE_LABEL = { employer: 'employer', consultant: 'third party consultant' };
const WEBHOOK_EVENTS = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'];

async function findProduct(stripe, key) {
  const r = await stripe.products.search({ query: `active:'true' AND metadata['cc_product']:'${key}'`, limit: 5 });
  return (r.data || [])[0] || null;
}
async function findPrice(stripe, lookupKey) {
  const r = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 5 });
  return (r.data || [])[0] || null;
}
const matches = (price, cents) => price && price.currency === 'cad' && price.unit_amount === cents && price.recurring && price.recurring.interval === 'month' && (price.recurring.interval_count || 1) === 1;

/** Ensure Product + Price for one line. Returns the Price (with .product). */
async function ensureLine(stripe, { key, name, description, lookupKey, cents, taxBehavior }, log) {
  let product = await findProduct(stripe, key);
  if (!product) { product = await stripe.products.create({ name, description, metadata: { cc_product: key, app: 'canada-careers' } }); log(`created product ${product.id} "${name}"`); }
  else log(`product ${product.id} "${product.name}" exists`);
  let price = await findPrice(stripe, lookupKey);
  if (matches(price, cents)) { log(`price ${price.id} (${lookupKey}) = ${cents} CAD cents / month exists`); return price; }
  if (price) log(`price ${price.id} (${lookupKey}) is ${price.unit_amount} ${price.currency}/${price.recurring && price.recurring.interval} — creating a new one and moving the lookup_key`);
  price = await stripe.prices.create({ product: product.id, currency: 'cad', unit_amount: cents, recurring: { interval: 'month', interval_count: 1 }, lookup_key: lookupKey, transfer_lookup_key: true, nickname: `${name} — ${(cents / 100).toFixed(2)} CAD/month`, ...(taxBehavior ? { tax_behavior: taxBehavior } : {}), metadata: { app: 'canada-careers' } });
  log(`created price ${price.id} (${lookupKey}) = ${cents} CAD cents / month`);
  return price;
}

/** Idempotently create the catalog for ONE role's pricing. Returns { posting, gst } Prices (gst null with STRIPE_TAX=1). */
async function ensureRoleCatalog(stripe, role, pricing, { log = console.log, stripeTax = /^(1|true|yes)$/i.test(process.env.STRIPE_TAX || '') } = {}) {
  const keys = LOOKUP_KEYS[role]; if (!keys) throw new Error(`unknown pricing role ${role}`);
  const posting = await ensureLine(stripe, { key: `posting_${role}`, name: `Job posting (monthly) — ${ROLE_LABEL[role]}`, description: `One job posting on Canada Careers at the ${ROLE_LABEL[role]} rate, renewed monthly until cancelled.`, lookupKey: keys.posting, cents: pricing.price_cents, taxBehavior: 'exclusive' }, log);
  const gst = stripeTax ? null : await ensureLine(stripe, { key: `gst_${role}`, name: `${pricing.gst_label || 'GST (5%)'} — ${role} posting`, description: `Goods and Services Tax (Canada), charged on the ${ROLE_LABEL[role]} posting fee.`, lookupKey: keys.gst, cents: pricing.tax_cents }, log);
  return { posting, gst };
}
/** Idempotently create the whole catalog: `pricings` = { employer, consultant } from billing.getAllPricing().
 *  Returns { employer: { posting, gst }, consultant: { posting, gst } }. */
async function ensureCatalog(stripe, pricings, opts = {}) {
  const out = {};
  for (const role of Object.keys(LOOKUP_KEYS)) { if (pricings[role]) out[role] = await ensureRoleCatalog(stripe, role, pricings[role], opts); }
  return out;
}

/** Find the webhook endpoint for `url` or create it (the signing secret is only returned on creation). */
async function ensureWebhook(stripe, url, { log = console.log, create = true } = {}) {
  const list = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = (list.data || []).find(e => e.url === url);
  if (existing) { log(`webhook endpoint ${existing.id} for ${url} exists (${existing.status}); its secret is only shown in the Dashboard`); return existing; }
  if (!create) return null;
  const ep = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, description: 'Canada Careers — job posting subscriptions' });
  log(`created webhook endpoint ${ep.id} for ${url}`);
  return ep;
}

module.exports = { ensureCatalog, ensureRoleCatalog, ensureWebhook, LOOKUP_KEYS, WEBHOOK_EVENTS };
if (require.main !== module) return;

(async () => {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { console.error('STRIPE_SECRET_KEY is not set. Put sk_test_… (or sk_live_…) in .env first — see docs/STRIPE-GO-LIVE.md'); process.exit(2); }
  const live = /^sk_live_/.test(key);
  const publicUrl = (arg('--url') || process.env.PUBLIC_URL || 'https://jobs.khosha.tech').replace(/\/$/, '');
  const webhookUrl = `${publicUrl}/billing/webhook`;
  const stripe = require('stripe')(key, { appInfo: { name: 'Canada Careers setup' } });
  const billing = require('../lib/billing');
  const pricings = await billing.getAllPricing();
  console.log(`Stripe setup — ${live ? 'LIVE' : 'TEST'} mode key${billing.useStripeTax() ? ' (STRIPE_TAX=1: GST lines skipped, Stripe Tax will compute tax)' : ''}`);
  for (const role of Object.keys(pricings)) console.log(`  ${role.padEnd(10)} ${pricings[role].price_cents} + ${pricings[role].tax_cents} = ${pricings[role].total_cents} CAD cents / month`);
  console.log('');

  const catalog = await ensureCatalog(stripe, pricings);
  console.log(`\nPrices in use (resolved automatically by lookup_key; optionally pin them in .env):`);
  for (const role of Object.keys(catalog)) {
    console.log(`  STRIPE_PRICE_POSTING_${role.toUpperCase()}=${catalog[role].posting.id}`);
    if (catalog[role].gst) console.log(`  STRIPE_PRICE_GST_${role.toUpperCase()}=${catalog[role].gst.id}`);
  }

  console.log(`\nWebhook endpoint:\n  URL     ${webhookUrl}\n  Events  ${WEBHOOK_EVENTS.join(', ')}`);
  const wantCreate = argv.includes('--create-webhook');
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    console.log(`  STRIPE_WEBHOOK_SECRET is set (${process.env.STRIPE_WEBHOOK_SECRET.slice(0, 10)}…). Verify the endpoint above exists in Dashboard → Developers → Webhooks.`);
    await ensureWebhook(stripe, webhookUrl, { create: false });
  } else {
    const ep = await ensureWebhook(stripe, webhookUrl, { create: wantCreate });
    if (ep && ep.secret) {
      console.log(`\n  Created. Add this to .env NOW — the signing secret is shown only once:\n\n  STRIPE_WEBHOOK_SECRET=${ep.secret}\n`);
    } else if (ep) {
      console.log(`  The endpoint already exists but STRIPE_WEBHOOK_SECRET is empty: open it in the Dashboard (Developers → Webhooks → ${ep.id}) → "Reveal" signing secret → put it in .env.`);
    } else {
      console.log(`  STRIPE_WEBHOOK_SECRET is empty. Either add the endpoint in Dashboard → Developers → Webhooks (URL + events above) and copy its signing secret,\n  or re-run with --create-webhook to create it via the API and print the secret here.`);
    }
  }
  console.log(`\nThen: restart the app (sudo systemctl restart canada-careers) and test one employer posting ($15.74) and one consultant posting ($10.49) with card 4242 4242 4242 4242 (test mode).`);
  await require('../lib/db').pool.end().catch(() => {});
})().catch((e) => { console.error('stripe-setup failed:', e.message); process.exit(1); });
