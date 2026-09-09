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

`billing.mode()` is `stripe` when `STRIPE_SECRET_KEY` is set, otherwise `sandbox`.

**Sandbox** (default, no keys): `POST /billing/checkout/:jobId` creates a random `provider_checkout_id` and redirects to `/billing/sandbox/:checkoutId`, a clearly labelled simulated card form. `4242 4242 4242 4242` succeeds (any future expiry, any CVC); `4000 0000 0000 0002` (or any number ending `0002`) is declined. Success calls `recordPayment()` for now → now + 1 calendar month. Renewals in sandbox always succeed. No card data is stored.

**Stripe** (`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`): checkout creates a Stripe Checkout Session in `subscription` mode with two recurring monthly line items — `Job posting: <title>` at `price_cents` and `GST (5%)` at `tax_cents` — plus metadata `{ job_id, subscription_id }` (also copied to the Stripe subscription). Stripe hosts the card form; we never see card numbers. Set `STRIPE_TAX=1` to drop the GST line and let Stripe Tax compute Canadian taxes automatically instead (requires Stripe Tax enabled in the dashboard and a Canadian tax registration).

## Stripe setup (production)

1. Stripe Dashboard → Developers → API keys: copy the **secret key** into `.env` as `STRIPE_SECRET_KEY=sk_live_…` (`STRIPE_PUBLISHABLE_KEY` is optional; the hosted Checkout does not need it).
2. Developers → Webhooks → **Add endpoint**: URL `https://jobs.khosha.tech/billing/webhook`. Subscribe to:
   - `checkout.session.completed` (links the Stripe customer/subscription to our row)
   - `invoice.paid` (records the payment, activates/extends the job, emails the receipt)
   - `invoice.payment_failed` (subscription → `past_due`, emails the payer)
   - `customer.subscription.updated` (mirrors cancel-at-period-end changed from the Stripe dashboard)
   - `customer.subscription.deleted` (subscription → `cancelled`, job archived)
3. Copy the endpoint's **signing secret** into `.env` as `STRIPE_WEBHOOK_SECRET=whsec_…`.
4. Restart the app. `server.js` already mounts `express.raw()` on `/billing/webhook` so the signature check (`stripe.webhooks.constructEvent(req.body, sig, secret)`) sees the raw body. Bad signature → 400; every verified event → 200 (handler errors are logged, not retried).
5. Optional: Dashboard → Settings → Billing → Subscriptions: enable Smart Retries and the customer portal if you want Stripe to email dunning notices too.

Local testing: `stripe listen --forward-to localhost:3900/billing/webhook` prints a temporary `whsec_` to use as `STRIPE_WEBHOOK_SECRET`; use test keys and card `4242 4242 4242 4242`.

Payments are idempotent on `(provider, provider_payment_id)` (= Stripe invoice id), so replayed webhooks never double-record. The success page also reconciles the Checkout Session directly (`billing.reconcileCheckoutSession`) so the confirmation is correct even if the webhook is delayed.

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
