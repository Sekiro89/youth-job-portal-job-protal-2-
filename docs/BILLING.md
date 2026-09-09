# Billing — job posting subscriptions

Every job posting is one recurring subscription priced by the **payer's role** (client decision 2026-09-09): **employers $14.99 + GST 5% ($0.75) = $15.74 CAD per month**, **third party consultants $9.99 + GST 5% ($0.50) = $10.49 CAD per month**, charged when the posting is published and then every month on the same date until the employer/consultant cancels. Receipts are viewable and downloadable (PDF via print) from `/billing`. Owner: `lib/billing.js` (core), `routes/billing.js` (pages + webhook), `jobs/renewals.js` + `jobs/run.js` (daily cron), `views/billing/*.ejs`, `public/css/billing.css`, `public/js/billing.js`.

## Pricing and GST (two price points)

| Payer role (`users.role`) | Price | GST 5% | Total / month | Stripe lookup keys |
|---|---|---|---|---|
| `employer` | $14.99 (1499 ¢) | $0.75 | **$15.74** (1574 ¢) | `cc_posting_employer_monthly`, `cc_gst_employer_monthly` |
| `consultant` | $9.99 (999 ¢) | $0.50 | **$10.49** (1049 ¢) | `cc_posting_consultant_monthly`, `cc_gst_consultant_monthly` |

**The payer's role decides** — the user at checkout (`req.user.role`; anything other than `consultant` gets the employer rate). Resolved by `billing.getPricing(role)` (a user object is accepted) through **`lib/settings`** (since 2026-09-10 — the client's admin panel at `/admin/integrations`), whose precedence is:

1. `settings` table (the panel): `employer_price_cents`, `consultant_price_cents` (cents, before GST), `gst_rate` (e.g. `0.05`), `gst_number` (printed on receipts). Cached 5 s; a save in the panel is live on the next request — no restart.
2. `.env` fallback when the panel field is blank: `EMPLOYER_PRICE_CENTS` / `CONSULTANT_PRICE_CENTS` / `GST_RATE` / `GST_NUMBER`.
3. `lib/constants.js PRICING` / `priceCentsFor(role)` (1499 / 999 / 0.05).

The legacy `POSTING_PRICE_CENTS` env and `posting_price_cents` setting are **ignored** (a startup warning names them) — remove `POSTING_PRICE_CENTS` from `.env`. `billing.getAllPricing()` returns `{ employer, consultant }` for copy and the Stripe catalog.

`tax_cents = round(price_cents * gst_rate)` (rounded to the cent: 1499 × 0.05 = 74.95 → 75), `total_cents = price + tax`.

**Snapshot rule.** `ensureSubscription(job, user)` copies the payer's current pricing onto the `subscriptions` row (`price_cents`, `tax_rate`, `tax_cents`, `total_cents`) when the row is created or re-pended. From then on everything reads the row, never `getPricing()`: the checkout page and sandbox card page (`billing.snapshotPricing(sub, role)`), the Stripe Checkout line items, `recordPayment()` (renewals — sandbox and Stripe alike), receipts, receipt emails, `/billing` totals and `/admin/payments`. Changing a price only affects postings published after the change; `node scripts/test-stripe.js` proves a 1574 subscription still renews at 1574 after the panel price (`employer_price_cents`) is changed to 1999.

Only GST is charged (federal 5%). If provincial HST/PST is ever required, either change `GST_RATE`/labels or switch to Stripe Tax (below).

## Modes

`await billing.mode()` (async since 2026-09-10) is `stripe` when the `stripe_secret_key` setting is non-empty (panel > `.env STRIPE_SECRET_KEY`), otherwise `sandbox`. `await billing.stripe()` builds the SDK client lazily and caches it **per key string**, so a key pasted (or blanked) in `/admin/integrations` is honoured on the very next call — no restart; the webhook route reads `stripe_webhook_secret` on every delivery. (Non-production only: `BILLING_FAKE_STRIPE=1` selects `stripe` mode with the in-memory fake client from `scripts/test-stripe.js` — ignored under `NODE_ENV=production`.)

Every other Stripe/branding value is read the same way at call time: `public_url` (success/cancel/portal return URLs, receipt links), `stripe_tax` (`await billing.useStripeTax()`), `site_name` + `contact_address` + `gst_number` (`billing.billFrom()` → the receipt's "Bill from" block and the receipt email).

**Sandbox** (default, no keys): `POST /billing/checkout/:jobId` creates a random `provider_checkout_id` and redirects to `/billing/sandbox/:checkoutId`, a clearly labelled simulated card form. `4242 4242 4242 4242` succeeds (any future expiry, any CVC); `4000 0000 0000 0002` (or any number ending `0002`) is declined. Success calls `recordPayment()` for now → now + 1 calendar month. Renewals in sandbox always succeed. No card data is stored. A "Sandbox mode — no real charge" banner is shown on the checkout page, the card page and `/billing`, and the app logs a `[billing] WARNING` at startup when production runs in sandbox mode. The sandbox card page is unreachable in Stripe mode (subscription rows created in Stripe mode have `provider='stripe'`).

**Stripe** (settings `stripe_secret_key` + `stripe_webhook_secret`; SDK 17.7.0, API version `2025-02-24.acacia` pinned by the SDK): checkout creates a Stripe Checkout Session in `subscription` mode:

- `line_items`: the posting fee and the GST line, both recurring monthly in CAD, at the subscription's snapshot amounts. Prices are resolved by the payer role's `lookup_key` pair (`cc_posting_employer_monthly` + `cc_gst_employer_monthly` or `cc_posting_consultant_monthly` + `cc_gst_consultant_monthly`, created by `setupCatalog()` / the panel button / `node scripts/stripe-setup.js`; cached 10 min per role; optionally pinned with `STRIPE_PRICE_POSTING_EMPLOYER` / `STRIPE_PRICE_GST_EMPLOYER` / `STRIPE_PRICE_POSTING_CONSULTANT` / `STRIPE_PRICE_GST_CONSULTANT`). A Price is only used when its amount/currency/interval match the snapshot; otherwise inline `price_data` (product name "Job posting (monthly, employer|third party consultant)", metadata `payer_role`) is sent, so checkout works even before the setup script has run or after a price change. Session and subscription metadata carry `payer_role`.
- setting `stripe_tax=1` drops the GST line and sets `automatic_tax.enabled` so Stripe Tax computes Canadian taxes (needs Stripe Tax enabled + a Canadian registration in the dashboard). The invoice's real `tax`/`amount_paid` are then recorded on the payment row.
- One Stripe **Customer per user**: created with `customers.create({ email, name, metadata.user_id })` on the first checkout, stored in `subscriptions.provider_customer_id`, and passed as `customer` (with `customer_update: { address: 'auto', name: 'auto' }`) on every later checkout, so the Customer Portal shows all of a user's postings. If the customer call fails we fall back to `customer_email`.
- `metadata` `{ job_id, subscription_id, user_id, employer_profile_id }` on the session **and** `subscription_data.metadata` (Stripe copies it onto every invoice as `subscription_details.metadata`), `client_reference_id` = our subscription id, `currency: 'cad'`, `locale: 'en'` (Checkout has no `en-CA`; `fr-CA` exists), `billing_address_collection: 'auto'`, `success_url` `/billing/success?job=&session_id={CHECKOUT_SESSION_ID}`, `cancel_url` `/billing/cancelled?job=`.

Stripe hosts the card form; we never see card numbers.

### Webhooks (`POST /billing/webhook`)

`server.js` mounts `express.raw()` on this path so `stripe.webhooks.constructEvent(rawBody, signature, await settings.get('stripe_webhook_secret'))` verifies the signature (bad/missing signature, stale timestamp or tampered body → **400**). After verification:

| Event | Effect |
|---|---|
| `checkout.session.completed` | Links `provider_customer_id` / `provider_subscription_id` / `provider_checkout_id` to our subscription. **Does not activate** — money is only confirmed by `invoice.paid`. |
| `invoice.paid` (also `invoice.payment_succeeded`) | `recordPayment()` for the period on the invoice lines (`lines.data[].period`), idempotent on the invoice id (`payments.provider_payment_id`); activates/extends the job, emails the receipt. Ignores invoices without a subscription or not `paid`. |
| `invoice.payment_failed` | subscription → `past_due` (only from `active`), one "Payment failed" email (not repeated on retries). The posting stays live until `current_period_end`; the daily cron then archives it as `expired`. |
| `customer.subscription.updated` | Mirrors `cancel_at_period_end`, `current_period_start/end`, `active ↔ past_due`; `canceled` handled like deleted. Never activates a pending row. |
| `customer.subscription.deleted` | subscription `cancelled` + `jobs.archiveJob(id,'cancelled')` (public 404 via `PUBLIC_WHERE`). |

Anything else → 200 `ignored`. **A handler error after signature verification returns 500** (previously 200-always): Stripe retries non-2xx deliveries (up to 3 days in live mode), so a DB hiccup or Stripe API outage during processing is replayed instead of silently losing a payment or cancellation. All handlers are idempotent, so retries are safe. An unknown Stripe subscription id (e.g. created in the dashboard) is looked up via `subscriptions.retrieve` → `metadata.subscription_id`; `resource_missing` is a 200 "unknown", any other API error is a 500.

Parsing is defensive across API versions: subscription id from `invoice.subscription` or `invoice.parent.subscription_details.subscription` (2025-03+), period from line items, tax from `invoice.tax` or `invoice.total_taxes[]`, `current_period_end` from the subscription or its `items.data[0]`.

### Other Stripe paths

- `GET /billing/success?job=&session_id=` retrieves the Checkout Session (`expand: subscription.latest_invoice`) and applies "completed" + "invoice.paid" itself (`billing.reconcileCheckoutSession`, guarded by `metadata.job_id === job`), so the confirmation is correct even before the webhook lands. While pending, the page re-checks itself every few seconds (`public/js/billing.js`).
- `GET /billing/portal` → `billingPortal.sessions.create({ customer, return_url: /billing })` → Stripe Customer Portal (update card, download Stripe invoices). Shown as "Manage card & invoices" on `/billing` once the user has a Stripe customer. The portal needs its default configuration saved once in Dashboard → Settings → Billing → Customer portal.
- Cancel at period end → `subscriptions.update({ cancel_at_period_end: true })`; cancel now → `subscriptions.cancel(id, { invoice_now: false, prorate: false })`; resume → `subscriptions.update({ cancel_at_period_end: false })` (409 with a friendly message if the subscription no longer exists at Stripe).
- Daily cron (`jobs/renewals.js` step 3): lapsed Stripe subscriptions are re-read (`subscriptions.retrieve` + `latest_invoice`) and any missed paid invoice / cancellation / past_due is applied; `pending` Stripe checkouts older than an hour are reconciled through `reconcileCheckoutSession`.

Payments are idempotent on `(provider, provider_payment_id)` (= Stripe invoice id), so replayed webhooks never double-record.

### Receipts

The receipt carries a **"Bill from"** block — `site_name`, `contact_address` and `gst_number` from the admin panel (`billing.billFrom()`), plus the public URL — next to "Bill to" and "Payment"; the receipt email repeats it as "Billed by …" and the GST number, and is sent from the configured system sender (`lib/mail` decides; billing never passes a `from`). Fill in the GST number before go-live — CRA requires the registration number on receipts once you charge GST.

Every receipt shows the rate it was charged at ("employer rate" / "third party consultant rate"), the payer, the company (with its operating name when different) and the period. **Download:** `/billing` lists every receipt with **View** (`/billing/receipt/:id`) and **Download (PDF)** (`/billing/receipt/:id?print=1`, which opens the browser print dialog on load — choose "Save as PDF"); the receipt page itself has a "Download receipt (PDF)" button (`data-print` → `window.print()` from `public/js/site.js`). `views/billing/receipt.ejs` carries its own `@media print` stylesheet so only the receipt document prints, on one clean sheet, regardless of which CSS bundle loaded. There is no server-side PDF renderer (no extra dependency): the PDF is the browser's print output. All receipts stay available from the user's login.

## Stripe setup (production) — admin panel API

See **`docs/STRIPE-GO-LIVE.md`** (written for the client: everything happens in `/admin/integrations`, no server access). `lib/billing.js` exports the functions the panel's buttons call; all return plain objects and never throw:

| Function | Returns |
|---|---|
| `testConnection()` | `{ ok, mode: 'test'\|'live'\|null, account: { id, business_name, email, country, default_currency, charges_enabled, livemode }, error }` — `accounts.retrieve()`, falling back to `balance.retrieve()` for restricted keys |
| `catalogStatus()` | `{ ok, mode, stripe_tax, keys: { <lookup_key>: { role, line, expected_cents, exists, matches, price_id, unit_amount } }, missing: [...], error }` |
| `setupCatalog()` | idempotent: `{ ok, mode, created: [lookup keys], existing: [lookup keys], prices: { <lookup_key>: price_id }, error }` — 4 Products/Prices (posting + GST per role; GST skipped with `stripe_tax=1`); a changed price gets a new Price with the lookup_key moved |
| `createWebhookEndpoint(url?)` | `{ ok, id, url, created, secret, secret_saved, events, note, error }` — `url` defaults to `<public_url>/billing/webhook`; https required; on creation the secret is returned **once** and saved to `stripe_webhook_secret` (`{ saveSecret: false }` to skip); for an existing endpoint `secret` is null and `note` explains where to reveal it |

`node scripts/stripe-setup.js` is a thin CLI over the same functions (`--create-webhook`, `--status`, `--url`). Explicit-client forms `ensureCatalog(client, pricings)` / `ensureWebhook(client, url)` remain exported for tests.

Local testing without a Stripe account: `node scripts/test-stripe.js` (below). With one: `stripe listen --forward-to localhost:3900/billing/webhook` prints a temporary `whsec_` to use as `STRIPE_WEBHOOK_SECRET`.

## Data flow

- `subscriptions` (one per job): `status` pending → active → (past_due) → cancelled; `current_period_start/end`; `cancel_at_period_end`; price snapshot for the payer's role (`price_cents`/`tax_rate`/`tax_cents`/`total_cents` — 1499/0.05/75/1574 or 999/0.05/50/1049); `payer_user_id` (whose role set the price); provider ids.
- `payments`: one row per successful charge with `receipt_number` `CC-YYYYMM-NNNNNN` (`nextval('receipt_seq')`, month in America/Toronto), amounts, period, `provider_payment_id`.
- `recordPayment()` (single write path, in a transaction): payment row → subscription active with new period → `jobs.activateJob(job_id, period_end)` (sets `expires_at`) → receipt email via `mail.send` (itemised, link to `/billing/receipt/:id`) → on the first payment for a job, `lib/matching.notifySeekersForJob(jobId)` (lazy-required, optional).
- Cancel at period end: `cancel_at_period_end=true` (Stripe: `subscriptions.update`), posting stays public until `current_period_end`, then the cron archives it as `cancelled`. Cancel now: subscription `cancelled` + `jobs.archiveJob(id,'cancelled')` immediately (Stripe: `subscriptions.cancel`). Resume undoes cancel-at-period-end.
- Public visibility is always `lib/jobs.PUBLIC_WHERE` (`active AND expires_at > now()`), so a lapsed posting disappears even before the cron runs.

## Renewals (cron)

`node jobs/run.js` (npm `cron`) loads `.env`, runs `runRenewals()` once, prints a JSON summary and exits 0 (1 if any step errored). Run it daily, e.g. a systemd timer:

```
# /etc/systemd/system/canada-careers-renewals.service
[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/home/ubuntu/projects/canada-careers
ExecStart=/usr/bin/node jobs/run.js
# /etc/systemd/system/canada-careers-renewals.timer
[Timer]
OnCalendar=*-*-* 03:00 America/Toronto
Persistent=true
[Install]
WantedBy=timers.target
```

Steps, in order: (1) `cancel_at_period_end` subscriptions whose period ended → cancelled + job archived; (2) sandbox subscriptions past `current_period_end` → charged (always succeeds) **at the row's price snapshot**, `recordPayment` for the next month starting where the last period ended (or from now if it lapsed by over a month); (3) Stripe reconciliation — lapsed Stripe subscriptions are re-read from Stripe and any missed paid invoice / cancellation is applied; (4) `jobs.expireLapsedJobs()` archives anything still active past `expires_at` as `expired`; (5) `pending` subscriptions older than 7 days with no payment are logged (job stays `pending_payment`); (6) `lib/matching.sendDailyDigests()` if present. Safe to re-run: a second run does nothing.

## Routes

`GET|POST /billing/checkout/:jobId` · `GET|POST /billing/sandbox/:checkoutId` · `GET /billing/success?job=` · `GET /billing/cancelled?job=` · `POST /billing/webhook` · `POST /billing/cancel/:jobId[?now=1]` · `POST /billing/resume/:jobId` · `GET /billing` (subscriptions, every receipt with View + Download (PDF), role-aware pricing note) · `GET /billing/receipt/:paymentId[?print=1]` (owner or admin, printable, `noindex`; `?print=1` opens the print dialog on load). All except the webhook require an employer/consultant session; owner checks use `jobs.userCanManageJob`. Dev only (`NODE_ENV !== 'production'`): `GET /billing-dev-login/:email?next=/…` sets the session for screenshots/tests.

## Testing

**Offline Stripe proof — `node scripts/test-stripe.js`** (no keys, no network; uses the `cc_billing` dev DB by default, creates and deletes its own fixture jobs under employer@ and consultant@). Config is seeded the way the panel does it — `settings.set('stripe_secret_key','sk_test_fake')`, `stripe_webhook_secret`, `gst_number` — and the touched `settings` rows are restored byte-for-byte at the end (it reads `SESSION_SECRET` from `.env` so the spawned server can decrypt them). It swaps in a fake Stripe client (`BILLING_FAKE_STRIPE=1`) that validates parameters like Stripe and simulates the hosted payment, while signature verification uses the real SDK. 35 steps (last run 2026-09-10: 35/35), PASS/FAIL each, exit 1 on failure: `getPricing(role)` panel > env > constants precedence + cent rounding → `testConnection()` / `catalogStatus()` / no-key errors + `mode()` flipping to sandbox when the key is blanked → employer checkout create (1499 + 75, `payer_role` metadata) → session.completed → invoice.paid (job live, receipt 1574, email at the employer rate with GST number) → replay (no duplicate) → subscription.updated → resume/cancel via Stripe → payment_failed (past_due + email) → subscription.deleted (archived, public 404) → bad/stale/tampered signatures → API-version drift → Stripe Tax variant (tax 75 on 1499) → `setupCatalog()` creates 4 then reports 4 existing (idempotent) → `createWebhookEndpoint()` new (secret returned + saved) vs existing (no secret) → consultant checkout (999 + 50 by consultant Price ids, own customer, $10.49 receipt email) → inline `price_data` fallback when the catalog no longer matches → **renewal at the snapshot after the price changes** → success-page reconciliation → renewals reconciliation → cancel now → portal, then the same over HTTP against a spawned server (webhook 400/200/500, success page, portal redirect, receipt with "Bill from", webhook secret rotated in settings honoured by the running server without restart, cancel/resume, sandbox page 404 in Stripe mode, employer vs consultant checkout pages, `/billing` receipt links + `?print=1`).

**Sandbox flow (manual):**

```bash
PW=$(grep '^DB_PASSWORD=' docs/.dbpw | cut -d= -f2); export DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/cc_billing" PORT=3905 PUBLIC_URL=http://localhost:3905
node server.js &
J=/tmp/cj; curl -sc $J -b $J -o /dev/null "localhost:3905/billing-dev-login/employer@example.com?next=/billing"
curl -sb $J localhost:3905/billing/checkout/12 | grep -o '\$1[45]\.[0-9][0-9]'   # employer: $14.99 and $15.74
SB=$(curl -sc $J -b $J -o /dev/null -w '%{redirect_url}' -X POST localhost:3905/billing/checkout/12)
curl -sc $J -b $J -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST "$SB" -d name=Test -d 'number=4242424242424242' -d exp=12/29 -d cvc=123   # 303 → /billing/success?job=12
psql "$DATABASE_URL" -c "select status,expires_at from jobs where id=12" -c "select receipt_number,amount_cents,tax_cents,total_cents from payments order by id desc limit 1"   # 1499 75 1574
# same as consultant@example.com on one of their jobs → checkout shows $9.99 / $10.49, payment row 999 50 1049
# renewal: backdate, then run the cron
psql "$DATABASE_URL" -c "update subscriptions set current_period_end=now()-interval '1 day' where job_id=12"
node jobs/run.js     # → {"renewed":1,...} and a second payments row
```
