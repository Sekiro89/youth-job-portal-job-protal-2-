#!/usr/bin/env node
'use strict';
// Stripe setup CLI — a thin wrapper over the admin-panel functions in lib/billing.js. Idempotent, safe to re-run.
// The client does NOT need this: /admin/integrations has "Test connection" and "Create prices & webhook" buttons that
// call the same functions. Keys come from lib/settings (panel > .env), so nothing here reads process.env directly.
//
//   node scripts/stripe-setup.js                    # test connection, create/verify the 4 Prices, show webhook status
//   node scripts/stripe-setup.js --create-webhook   # also create the webhook endpoint (secret saved to settings, printed once)
//   node scripts/stripe-setup.js --url https://jobs.khosha.tech   # override the public URL for the webhook address
//   node scripts/stripe-setup.js --status           # read-only: connection + catalog status, change nothing
//
// What setupCatalog() creates (found again by lookup_key / metadata on later runs, so nothing is duplicated) — one pair per payer role:
//   Product "Job posting (monthly) — employer"                + Price 1499 CAD / month, lookup_key cc_posting_employer_monthly   (tax_behavior exclusive)
//   Product "GST (5%) — employer posting"                     + Price   75 CAD / month, lookup_key cc_gst_employer_monthly       (skipped with setting stripe_tax=1)
//   Product "Job posting (monthly) — third party consultant"  + Price  999 CAD / month, lookup_key cc_posting_consultant_monthly (tax_behavior exclusive)
//   Product "GST (5%) — consultant posting"                   + Price   50 CAD / month, lookup_key cc_gst_consultant_monthly     (skipped with setting stripe_tax=1)
// lib/billing.js resolves the payer role's lookup_keys at checkout time (cached 10 min) and only uses a Price whose amount
// matches the subscription's price snapshot; otherwise it falls back to inline price_data. If a price changes, re-run this
// (or click the panel button): a new Price is created and the lookup_key moved to it. Existing Stripe subscriptions keep
// the Price they were created with — renewals never re-price.
const path = require('node:path');
const billing = require('../lib/billing');

// Kept for callers that pass their own client (scripts/test-stripe.js): the same implementations live in lib/billing.js.
module.exports = { ensureCatalog: billing.ensureCatalog, ensureRoleCatalog: billing.ensureRoleCatalog, ensureWebhook: billing.ensureWebhook, LOOKUP_KEYS: billing.LOOKUP_KEYS, WEBHOOK_EVENTS: billing.WEBHOOK_EVENTS };
if (require.main !== module) return;

(async () => {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const settings = require('../lib/settings');
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const statusOnly = argv.includes('--status');

  const conn = await billing.testConnection();
  if (!conn.ok) { console.error(`Stripe connection FAILED: ${conn.error}\n  (source of stripe_secret_key: ${await settings.source('stripe_secret_key')})`); await done(2); return; }
  const a = conn.account || {};
  console.log(`Stripe connection OK — ${conn.mode.toUpperCase()} mode key · account ${a.id || '(restricted key)'}${a.business_name ? ` "${a.business_name}"` : ''}${a.country ? ` · ${a.country}` : ''}${a.default_currency ? ` · ${a.default_currency.toUpperCase()}` : ''}`);
  const pricings = await billing.getAllPricing();
  for (const role of Object.keys(pricings)) console.log(`  ${role.padEnd(10)} ${pricings[role].price_cents} + ${pricings[role].tax_cents} = ${pricings[role].total_cents} CAD cents / month`);
  if (await billing.useStripeTax()) console.log('  stripe_tax=1: GST lines skipped, Stripe Tax computes tax');
  console.log('');

  if (statusOnly) {
    const st = await billing.catalogStatus();
    console.log(`Catalog: ${st.ok ? 'complete' : `incomplete (${st.missing.join(', ') || st.error})`}`);
    for (const [k, v] of Object.entries(st.keys)) console.log(`  ${k.padEnd(32)} ${v.exists ? `${v.price_id} = ${v.unit_amount}` : 'missing'}${v.exists && !v.matches ? ` (expected ${v.expected_cents})` : ''}`);
  } else {
    const cat = await billing.setupCatalog({ log: (m) => console.log('  ' + m) });
    if (!cat.ok) { console.error(`Catalog setup FAILED: ${cat.error}`); await done(1); return; }
    console.log(`\nPrices (created: ${cat.created.length ? cat.created.join(', ') : 'none'}; already correct: ${cat.existing.length ? cat.existing.join(', ') : 'none'}):`);
    for (const [k, id] of Object.entries(cat.prices)) console.log(`  ${k.padEnd(32)} ${id}`);
  }

  const publicUrl = (arg('--url') || await billing.publicUrl()).replace(/\/$/, '');
  const webhookUrl = `${publicUrl}/billing/webhook`;
  console.log(`\nWebhook endpoint:\n  URL     ${webhookUrl}\n  Events  ${billing.WEBHOOK_EVENTS.join(', ')}`);
  const whsec = await settings.get('stripe_webhook_secret');
  if (argv.includes('--create-webhook') && !statusOnly) {
    const wh = await billing.createWebhookEndpoint(webhookUrl);
    if (!wh.ok) { console.error(`  Webhook FAILED: ${wh.error}`); await done(1); return; }
    console.log(`  ${wh.note}`);
    if (wh.created && wh.secret) console.log(`  Signing secret (shown once; ${wh.secret_saved ? 'already saved to settings' : 'SAVE IT NOW'}): ${wh.secret}`);
  } else {
    console.log(`  Signing secret: ${whsec ? `configured (${whsec.slice(0, 10)}…, source ${await settings.source('stripe_webhook_secret')})` : 'NOT configured — re-run with --create-webhook, or click "Create prices & webhook" in /admin/integrations'}`);
  }
  console.log(`\nNext: pay one employer posting (${(pricings.employer.total_cents / 100).toFixed(2)}) and one consultant posting (${(pricings.consultant.total_cents / 100).toFixed(2)}) with card 4242 4242 4242 4242 (test mode). No restart needed.`);
  await done(0);
})().catch(async (e) => { console.error('stripe-setup failed:', e.message); await done(1); });

async function done(code) { await require('../lib/db').pool.end().catch(() => {}); process.exit(code); }
