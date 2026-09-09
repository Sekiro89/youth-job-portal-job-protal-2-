# Billing — job posting subscriptions

Every job posting is one recurring subscription: **$9.99 + GST 5% ($0.50) = $10.49 CAD per month**, charged when the posting is published and then every month on the same date until the employer/consultant cancels. Owner: `lib/billing.js` (core), `routes/billing.js` (pages + webhook), `jobs/renewals.js` + `jobs/run.js` (daily cron), `views/billing/*.ejs`, `public/css/billing.css`, `public/js/billing.js`.

## Pricing and GST

Resolved by `billing.getPricing()` in this order:

1. Environment: `POSTING_PRICE_CENTS` (e.g. `999`) and `GST_RATE` (e.g. `0.05`).
2. `settings` table: keys `posting_price_cents`, `gst_rate` (seeded by `db/schema.sql`; cached 60 s). Optional `gst_number` (or env `GST_NUMBER`) prints the GST/HST registration number on receipts.
3. Fallback `lib/constants.js PRICING` (999 / 0.05).

`tax_cents = round(price_cents * gst_rate)`, `total_cents = price + tax`. The snapshot is copied onto the `subscriptions` row at checkout, so changing the price later never alters an existing subscription; every `payments` row carries its own amounts.

Only GST is charged (federal 5%). If provincial HST/PST is ever required, either change `GST_RATE`/labels or switch to Stripe Tax (below).

## Modes

`billing.mode()` is `stripe` when `STRIPE_SECRET_KEY` is set, otherwise `sandbox`. (Non-production only: `BILLING_FAKE_STRIPE=1` also selects `stripe` mode with the in-memory fake client from `scripts/test-stripe.js` — ignored under `NODE_ENV=production`.)

**Sandbox** (default, no keys): `POST /billing/checkout/:jobId` creates a random `provider_checkout_id` and redirects to `/billing/sandbox/:checkoutId`, a clearly labelled simulated card form. `4242 4242 4242 4242` succeeds (any future expiry, any CVC); `4000 0000 0000 0002` (or any number ending `0002`) is declined. Success calls `recordPayment()` for now → now + 1 calendar month. Renewals in sandbox always succeed. No card data is stored. A "Sandbox mode — no real charge" banner is shown on the checkout page, the card page and `/billing`, and the app logs a `[billing] WARNING` at startup when production runs in sandbox mode. The sandbox card page is unreachable in Stripe mode (subscription rows created in Stripe mode have `provider='stripe'`).

**Stripe** (`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`; SDK 17.7.0, API version `2025-02-24.acacia` pinned by the SDK): checkout creates a Stripe Checkout Session in `subscription` mode:

- `line_items`: the posting fee and the GST line, both recurring monthly in CAD. Prices are resolved by `lookup_key` (`cc_posting_monthly`, `cc_gst_monthly`, created by `node scripts/stripe-setup.js`; cached 10 min; optionally pinned with `STRIPE_PRICE_POSTING` / `STRIPE_PRICE_GST`). A Price is only used when its amount/currency/interval match `getPricing()`; otherwise inline `price_data` is sent, so checkout works even before the setup script has run.
- `STRIPE_TAX=1` drops the GST line and sets `automatic_tax.enabled` so Stripe Tax computes Canadian taxes (needs Stripe Tax enabled + a Canadian registration in the dashboard). The invoice's real `tax`/`amount_paid` are then recorded on the payment row.
- One Stripe **Customer per user**: created with `customers.create({ email, name, metadata.user_id })` on the first checkout, stored in `subscriptions.provider_customer_id`, and passed as `customer` (with `customer_update: { address: 'auto', name: 'auto' }`) on every later checkout, so the Customer Portal shows all of a user's postings. If the customer call fails we fall back to `customer_email`.
- `metadata` `{ job_id, subscription_id, user_id, employer_profile_id }` on the session **and** `subscription_data.metadata` (Stripe copies it onto every invoice as `subscription_details.metadata`), `client_reference_id` = our subscription id, `currency: 'cad'`, `locale: 'en'` (Checkout has no `en-CA`; `fr-CA` exists), `billing_address_collection: 'auto'`, `success_url` `/billing/success?job=&session_id={CHECKOUT_SESSION_ID}`, `cancel_url` `/billing/cancelled?job=`.

Stripe hosts the card form; we never see card numbers.

### Webhooks (`POST /billing/webhook`)

`server.js` mounts `express.raw()` on this path so `stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)` verifies the signature (bad/missing signature, stale timestamp or tampered body → **400**). After verification:

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

`GST_NUMBER` (env) or the `gst_number` settings row prints "GST/HST No. …" on the receipt page, in the receipt email and in the pricing note on `/billing`. Set it before go-live — CRA requires the registration number on receipts once you charge GST.

## Stripe setup (production)

See **`docs/STRIPE-GO-LIVE.md`** for the 5-minute checklist. Short version: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (+ `GST_NUMBER`) in `.env`, `node scripts/stripe-setup.js` (creates the Product/Prices by lookup_key and, with `--create-webhook`, the webhook endpoint at `https://jobs.khosha.tech/billing/webhook` with the 5 events above), restart, pay once with `4242 4242 4242 4242` in test mode, swap to live keys.

Local testing without a Stripe account: `node scripts/test-stripe.js` (below). With one: `stripe listen --forward-to localhost:3900/billing/webhook` prints a temporary `whsec_` to use as `STRIPE_WEBHOOK_SECRET`.

## Data flow

- `subscriptions` (one per job): `status` pending → active → (past_due) → cancelled; `current_period_start/end`; `cancel_at_period_end`; price snapshot; provider ids.
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

Steps, in order: (1) `cancel_at_period_end` subscriptions whose period ended → cancelled + job archived; (2) sandbox subscriptions past `current_period_end` → charged (always succeeds), `recordPayment` for the next month starting where the last period ended (or from now if it lapsed by over a month); (3) Stripe reconciliation — lapsed Stripe subscriptions are re-read from Stripe and any missed paid invoice / cancellation is applied; (4) `jobs.expireLapsedJobs()` archives anything still active past `expires_at` as `expired`; (5) `pending` subscriptions older than 7 days with no payment are logged (job stays `pending_payment`); (6) `lib/matching.sendDailyDigests()` if present. Safe to re-run: a second run does nothing.

## Routes

`GET|POST /billing/checkout/:jobId` · `GET|POST /billing/sandbox/:checkoutId` · `GET /billing/success?job=` · `GET /billing/cancelled?job=` · `POST /billing/webhook` · `POST /billing/cancel/:jobId[?now=1]` · `POST /billing/resume/:jobId` · `GET /billing` · `GET /billing/receipt/:paymentId` (owner or admin, printable, `noindex`). All except the webhook require an employer/consultant session; owner checks use `jobs.userCanManageJob`. Dev only (`NODE_ENV !== 'production'`): `GET /billing-dev-login/:email?next=/…` sets the session for screenshots/tests.

## Testing

**Offline Stripe proof — `node scripts/test-stripe.js`** (no keys, no network; uses the `cc_billing` dev DB by default, creates and deletes its own fixture jobs). It swaps in a fake Stripe client (`BILLING_FAKE_STRIPE=1`) that validates parameters like Stripe and simulates the hosted payment, while signature verification uses the real SDK. 26 steps, PASS/FAIL each, exit 1 on failure: checkout create → session.completed → invoice.paid (job live, receipt, email with GST number) → replay (no duplicate) → subscription.updated → resume/cancel via Stripe → payment_failed (past_due + email) → subscription.deleted (archived, public 404) → bad/stale/tampered signatures → API-version drift → Stripe Tax variant → lookup_key Prices via `stripe-setup.js` → success-page reconciliation → renewals reconciliation → cancel now → portal, then the same over HTTP against a spawned server (webhook 400/200/500, success page, portal redirect, receipt, cancel/resume, sandbox page 404 in Stripe mode).

**Sandbox flow (manual):**

```bash
PW=$(cut -d= -f2 docs/.dbpw); export DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/cc_billing" PORT=3905 PUBLIC_URL=http://localhost:3905
node server.js &
J=/tmp/cj; curl -sc $J -b $J -o /dev/null "localhost:3905/billing-dev-login/employer@example.com?next=/billing"
SB=$(curl -sc $J -b $J -o /dev/null -w '%{redirect_url}' -X POST localhost:3905/billing/checkout/12)
curl -sc $J -b $J -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST "$SB" -d name=Test -d 'number=4242424242424242' -d exp=12/29 -d cvc=123   # 303 → /billing/success?job=12
psql "$DATABASE_URL" -c "select status,expires_at from jobs where id=12" -c "select receipt_number,total_cents from payments order by id desc limit 1"
# renewal: backdate, then run the cron
psql "$DATABASE_URL" -c "update subscriptions set current_period_end=now()-interval '1 day' where job_id=12"
node jobs/run.js     # → {"renewed":1,...} and a second payments row
```
