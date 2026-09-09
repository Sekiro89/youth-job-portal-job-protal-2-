# Stripe go-live — the 5-minute checklist

Each job posting is a Stripe **subscription** priced by the payer's role: employers $14.99 + 5% GST = **$15.74 CAD per month**, third party consultants $9.99 + 5% GST = **$10.49 CAD per month**, charged when the posting is published and on the same date every month until cancelled (the price at checkout is locked in for that posting). The code path is already built and proven offline (`node scripts/test-stripe.js` → 32/32 on 2026-09-09). Until you do the steps below the site runs in **sandbox mode**: a simulated card page, no money collected, banners saying so on every billing page, and a `[billing] WARNING` line in the log at startup.

## What you need from Stripe (dashboard.stripe.com)

| Item | Where | Goes in `.env` as |
|---|---|---|
| Secret key `sk_test_…` (test) then `sk_live_…` (live) | Developers → API keys | `STRIPE_SECRET_KEY=` |
| Webhook signing secret `whsec_…` | created in step 3 (script or dashboard) | `STRIPE_WEBHOOK_SECRET=` |
| Your GST/HST registration number, e.g. `123456789 RT0001` | CRA | `GST_NUMBER=` (printed on receipts + receipt emails) |

`STRIPE_PUBLISHABLE_KEY` is **not** needed (hosted Checkout). Test and live are separate Stripe "modes": prices, customers and webhooks created in test mode do not exist in live mode, so steps 2–3 are run once per mode.

## Steps

1. **Keys.** Edit `/home/ubuntu/projects/canada-careers/.env`:
   ```
   STRIPE_SECRET_KEY=sk_test_…
   STRIPE_WEBHOOK_SECRET=            # filled in step 3
   GST_NUMBER=123456789 RT0001
   ```
2. **Catalog.** `cd /home/ubuntu/projects/canada-careers && node scripts/stripe-setup.js`
   Idempotently creates four Products + Prices, one pair per payer role, and prints the ids:
   | Product | Price | lookup_key |
   |---|---|---|
   | Job posting (monthly) — employer | 14.99 CAD/month | `cc_posting_employer_monthly` |
   | GST (5%) — employer posting | 0.75 CAD/month | `cc_gst_employer_monthly` |
   | Job posting (monthly) — third party consultant | 9.99 CAD/month | `cc_posting_consultant_monthly` |
   | GST (5%) — consultant posting | 0.50 CAD/month | `cc_gst_consultant_monthly` |

   Safe to re-run; if you later change `EMPLOYER_PRICE_CENTS` / `CONSULTANT_PRICE_CENTS` / `GST_RATE` it creates new Prices and moves the lookup keys — existing subscriptions keep the Price they were created with, so nobody is re-priced. (Checkout works even without this step — it falls back to inline prices at the snapshot amounts — but named Prices keep the Stripe dashboard tidy.) Remove the legacy `POSTING_PRICE_CENTS` line from `.env`; it is ignored and logs a warning.
3. **Webhook.** Either
   - `node scripts/stripe-setup.js --create-webhook` — creates the endpoint via the API and prints `STRIPE_WEBHOOK_SECRET=whsec_…` **once**; paste it into `.env`; or
   - Dashboard → Developers → Webhooks → Add endpoint: URL **`https://jobs.khosha.tech/billing/webhook`**, events
     `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` → copy the signing secret into `.env`.
4. **Customer portal (one click).** Dashboard → Settings → Billing → Customer portal → Save (default settings are fine; allow "update payment method" and "cancel subscription"). This enables the "Manage card & invoices" button on `/billing`. Without it that button shows a friendly error.
5. **Restart + test.** `sudo systemctl restart canada-careers` (the startup log must no longer show the sandbox warning). Log in as an **employer**, publish a posting → the checkout page shows $14.99 + $0.75 = **$15.74** → you are sent to Stripe Checkout (same amounts) → pay with **4242 4242 4242 4242**, any future expiry, any CVC, any postal code → you land on `/billing/success`, the posting is live, `/billing` lists the subscription with a receipt (GST number on it, "employer rate", View + Download (PDF)), and Dashboard → Developers → Webhooks shows the deliveries as 200. Repeat as a **consultant** account: $9.99 + $0.50 = **$10.49**. Try a decline with `4000 0000 0000 0002`. Cancel from `/billing` and check the subscription in the dashboard is set to cancel at period end.
6. **Go live.** Repeat steps 1–4 with the **live** key (`sk_live_…`, a live-mode webhook endpoint → new `whsec_…`), restart, and do one real posting per role ($15.74 employer, $10.49 consultant) with a real card (refund them from the dashboard afterwards if you like — the refund does not touch our records).

That is it. The daily timer (`canada-careers-renewals.timer` → `node jobs/run.js`) already reconciles anything a missed webhook would have left behind.

## How it behaves once live

- **Renewals** are Stripe's job: it charges the card every month and sends `invoice.paid`; we record a receipt `CC-YYYYMM-NNNNNN`, extend the posting a month and email the receipt. Failed charge → `invoice.payment_failed` → subscription "Payment failed" on `/billing`, one email to the payer with a link to update the card; Stripe's Smart Retries (Settings → Billing → Subscriptions and emails) retry the card, and if the period ends unpaid the posting drops out of public view and the cron marks it `expired`.
- **Cancel** from `/billing` ("Cancel at period end" keeps it live until the paid date; "Cancel now" removes it immediately) or from the Stripe portal/dashboard — all paths end in the same state because the webhooks mirror dashboard changes.
- **Webhook failures return 500** so Stripe retries them (up to 3 days); handlers are idempotent, so retries never double-charge or double-record. The success page also pulls the Checkout Session directly, so the employer sees "live" even if the webhook is delayed.
- **One Stripe Customer per Canada Careers user** (created on the first checkout, reused after), so the portal shows all of that user's postings and cards.
- **Sandbox cannot coexist with Stripe:** once `STRIPE_SECRET_KEY` is set, every checkout goes to Stripe and the sandbox card page returns 404. To go back to sandbox (e.g. for a demo) blank the key and restart — the banner and warning return automatically.

## Optional

- **Stripe Tax** instead of our fixed GST line: enable Stripe Tax and add a Canadian tax registration in the dashboard, set `STRIPE_TAX=1`, restart, re-run `node scripts/stripe-setup.js`. Checkout then sends a single posting line ($14.99 or $9.99 by role) with `automatic_tax` and Stripe adds GST/HST/PST by the customer's address; receipts record the exact tax Stripe charged. Keep the default (explicit 5% GST line) unless you need provincial taxes — it needs no registration in Stripe.
- **Pin prices** in `.env` with `STRIPE_PRICE_POSTING_EMPLOYER=price_…` / `STRIPE_PRICE_GST_EMPLOYER=price_…` / `STRIPE_PRICE_POSTING_CONSULTANT=price_…` / `STRIPE_PRICE_GST_CONSULTANT=price_…` (printed by the setup script) to skip the lookup-key call at checkout.
- **Change a price** with `EMPLOYER_PRICE_CENTS` / `CONSULTANT_PRICE_CENTS` in `.env` (or the `employer_price_cents` / `consultant_price_cents` rows in `settings`), restart, re-run the setup script. Only postings published after the change pay the new price.
- **Local webhook testing** with a real test account: `stripe listen --forward-to localhost:3900/billing/webhook` prints a temporary `whsec_` to use as `STRIPE_WEBHOOK_SECRET`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Paid at Stripe but the posting stays "Awaiting payment" | Webhook not arriving: check the endpoint URL/events and `STRIPE_WEBHOOK_SECRET`; the app log shows `webhook signature failed` on a wrong secret. `/billing/success` and the daily cron reconcile it anyway. |
| Startup log says `STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing` | Step 3 not done. |
| "Manage card & invoices" shows an error | Step 4 (portal configuration) not saved in the dashboard for that mode. |
| Deliveries in the dashboard show 500 | The app could not process a verified event (DB down, Stripe API outage). Stripe retries; fix the cause and let it, or "Resend" from the dashboard. |
| Amount on the Stripe invoice ≠ $15.74 (employer) / $10.49 (consultant) | Pricing changed after a Price was created: re-run `node scripts/stripe-setup.js`. Existing subscriptions keep their original amount by design. |
| An employer was charged $10.49 (or a consultant $15.74) | The price follows `users.role` of the account that paid. Check the payer's role in `/admin/users`; the posting's company profile does not decide the rate. |
