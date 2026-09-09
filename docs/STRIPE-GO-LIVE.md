# Stripe go-live — done from the admin panel, no server access needed

Each job posting is a Stripe **subscription** priced by the payer's role: employers $14.99 + 5% GST = **$15.74 CAD per month**, third party consultants $9.99 + 5% GST = **$10.49 CAD per month**, charged when the posting is published and on the same date every month until cancelled (the price at checkout is locked in for that posting). Until you connect Stripe the site runs in **sandbox mode**: a simulated card page, no money collected, and a "Sandbox mode — no real charge" banner on every billing page.

Everything below happens in **`/admin/integrations`** (passcode-gated). Every field takes effect the moment you click Save — there is nothing to restart. (Last verified offline 2026-09-10: `node scripts/test-stripe.js` → 35/35.)

## What you need from Stripe (dashboard.stripe.com)

| Item | Where in Stripe | Where it goes |
|---|---|---|
| Secret key `sk_test_…` (to try it) then `sk_live_…` (real money) | Developers → API keys | Integrations → Stripe → **Secret key** |
| Publishable key `pk_…` | Developers → API keys | Integrations → Stripe → **Publishable key** (optional — hosted Checkout does not need it) |
| Webhook signing secret `whsec_…` | created for you by the **Create prices & webhook** button | filled in automatically (or paste it if you created the endpoint in the Dashboard) |
| Your GST/HST registration number, e.g. `123456789 RT0001` | CRA | Integrations → Pricing → **GST number** (printed on every receipt) |
| Your business address | — | Integrations → Branding → **Business address** ("Bill from" on receipts) |

Test and live are separate Stripe "modes": prices and webhooks created in test mode do not exist in live mode, so you run steps 2–3 once with the test key and once more with the live key.

## Steps

1. **Paste the keys.** Integrations → Stripe: paste the **test** secret key (`sk_test_…`), Save. Also fill in the GST number (Pricing) and business address (Branding) now so receipts are complete.
2. **Test connection.** Click **Test connection**. You should see your Stripe account name, country (CA), currency (CAD) and "TEST mode". If it says the key was rejected, re-copy it from Stripe — keys are long and easy to truncate.
3. **Create prices & webhook.** Click **Create prices & webhook**. This:
   - creates four Prices in your Stripe account (found again on later clicks, so it is safe to press twice):

     | Product | Price | lookup_key |
     |---|---|---|
     | Job posting (monthly) — employer | 14.99 CAD/month | `cc_posting_employer_monthly` |
     | GST (5%) — employer posting | 0.75 CAD/month | `cc_gst_employer_monthly` |
     | Job posting (monthly) — third party consultant | 9.99 CAD/month | `cc_posting_consultant_monthly` |
     | GST (5%) — consultant posting | 0.50 CAD/month | `cc_gst_consultant_monthly` |

   - creates the webhook endpoint **`<your public URL>/billing/webhook`** with the five events `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, and **saves its signing secret into the Webhook signing secret field for you** (Stripe only reveals that secret once, at creation).

   If the endpoint already existed (for example you added it in the Dashboard first), the panel tells you so and asks you to paste the secret from Dashboard → Developers → Webhooks → your endpoint → "Reveal" — or delete that endpoint there and click the button again.
4. **Customer portal (one click in Stripe).** Dashboard → Settings → Billing → Customer portal → Save (defaults are fine; allow "update payment method" and "cancel subscription"). This enables the "Manage card & invoices" button on `/billing`.
5. **Pay a test posting.** Log in as an **employer**, publish a posting → the checkout page shows $14.99 + $0.75 = **$15.74** → you are sent to Stripe Checkout → pay with card **4242 4242 4242 4242**, any future expiry, any CVC, any postal code → you land on "Your posting is live", `/billing` lists the subscription with a receipt (GST number and your business address on it, "employer rate", View + Download (PDF)), and Dashboard → Developers → Webhooks shows the deliveries as 200. Repeat as a **consultant**: $9.99 + $0.50 = **$10.49**. Try a decline with `4000 0000 0000 0002`. Cancel from `/billing` and check the subscription in the Dashboard is set to cancel at period end.
6. **Go live.** Back in Integrations → Stripe, replace the test secret key with the **live** key (`sk_live_…`), Save, **Test connection** (now says LIVE), **Create prices & webhook** again (live mode needs its own prices and endpoint; the new signing secret replaces the test one automatically), step 4 for live mode, then one real posting per role ($15.74 employer, $10.49 consultant) with a real card — refund them from the Dashboard afterwards if you like; a refund does not touch our records.

That is it. The daily job (`node jobs/run.js`, systemd timer) reconciles anything a missed webhook would have left behind.

## How it behaves once live

- **Renewals** are Stripe's job: it charges the card every month and sends `invoice.paid`; we record a receipt `CC-YYYYMM-NNNNNN`, extend the posting a month and email the receipt from your configured sender address. Failed charge → `invoice.payment_failed` → "Payment failed" on `/billing`, one email to the payer with a link to update the card; Stripe's Smart Retries (Settings → Billing → Subscriptions and emails) retry the card, and if the period ends unpaid the posting drops out of public view and the daily job marks it `expired`.
- **Cancel** from `/billing` ("Cancel at period end" keeps it live until the paid date; "Cancel now" removes it immediately) or from the Stripe portal/Dashboard — all paths end in the same state because the webhooks mirror Dashboard changes.
- **Webhook failures return 500** so Stripe retries them (up to 3 days); handlers are idempotent, so retries never double-charge or double-record. The success page also pulls the Checkout Session directly, so the employer sees "live" even if the webhook is delayed.
- **One Stripe Customer per Canada Careers user** (created on the first checkout, reused after), so the portal shows all of that user's postings and cards.
- **Sandbox cannot coexist with Stripe:** as soon as a secret key is saved, every new checkout goes to Stripe and the sandbox card page returns 404. To go back to sandbox (for a demo) blank the secret key and Save — the banner returns on the next page load.
- **Changing keys never needs a restart.** The app reads the keys from the panel on every payment, webhook and daily job. Old `.env` values (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GST_NUMBER`, `EMPLOYER_PRICE_CENTS`, …) still work as a fallback when the panel field is empty, but **the panel always wins**.

## Optional

- **Change a price**: Integrations → Pricing (cents before GST). Only postings published after the change pay the new price; then click **Create prices & webhook** once more so Stripe gets a matching Price (checkout works anyway — it sends the exact amount inline when no matching Price exists).
- **Stripe Tax** instead of our fixed GST line: enable Stripe Tax and add a Canadian tax registration in the Dashboard, set Integrations → Stripe → "Use Stripe Tax" to 1, Save, click **Create prices & webhook**. Checkout then sends a single posting line ($14.99 or $9.99 by role) and Stripe adds GST/HST/PST by the customer's address; receipts record the exact tax Stripe charged. Keep the default (explicit 5% GST line) unless you need provincial taxes.
- **Command line** (for whoever runs the server): `node scripts/stripe-setup.js` does steps 2–3 (`--create-webhook` to create the endpoint, `--status` for a read-only report). It uses the same panel settings.
- **Local webhook testing** with a real test account: `stripe listen --forward-to localhost:3900/billing/webhook` prints a temporary `whsec_` to paste into the Webhook signing secret field (restore the real one afterwards).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Paid at Stripe but the posting stays "Awaiting payment" | Webhook not arriving or wrong signing secret: Integrations → Test connection, then check Dashboard → Developers → Webhooks for the endpoint and its deliveries (400 = wrong secret). `/billing/success` and the daily job reconcile it anyway. |
| Test connection says the key was rejected | Re-copy the key from Stripe; make sure it is the **secret** key (`sk_…`), not the publishable one (`pk_…`). |
| "Create prices & webhook" says the endpoint exists but no secret is saved | Reveal the secret in Dashboard → Developers → Webhooks → endpoint and paste it into the Webhook signing secret field, or delete that endpoint and click the button again. |
| "Manage card & invoices" shows an error | Step 4 (portal configuration) not saved in the Dashboard for that mode. |
| Deliveries in the Dashboard show 500 | The app could not process a verified event (DB down, Stripe API outage). Stripe retries; fix the cause and let it, or "Resend" from the Dashboard. |
| Amount on the Stripe invoice ≠ $15.74 (employer) / $10.49 (consultant) | Pricing changed after a Price was created: click **Create prices & webhook** again. Existing subscriptions keep their original amount by design. |
| An employer was charged $10.49 (or a consultant $15.74) | The price follows the role of the account that paid. Check the payer's role in `/admin/users`; the posting's company profile does not decide the rate. |
| Receipt has no GST number / address | Fill in Integrations → Pricing → GST number and Branding → Business address; receipts and receipt emails read them live. |
