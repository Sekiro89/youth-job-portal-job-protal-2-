# Canada Careers — Admin guide

This is written for the people who run the site day to day. You do not need the server or a developer for anything on this page: payments, email, where Contact Us goes, prices, maps and admin logins are all managed from the **Integrations** screen in the admin area, and every change takes effect immediately.

## 1. Signing in

1. Go to `/login` and sign in with your admin email and password. New admin logins are created under Integrations → Access & admins (section 4); the first one is created by whoever set up the site.
2. You land on `/admin`. The **My account** button in the top bar brings you back here at any time.
3. Admin pages are private: search engines never index them and a non-admin who opens `/admin` is sent to their own dashboard.
4. Forgot your password? Use **Forgot password** on `/login` (needs email delivery to be working) or ask another admin to reset it from Access & admins.

## 2. The screens

| Screen | URL | What it does |
|---|---|---|
| Overview | `/admin` | Counters (new / in-progress messages, active / awaiting-payment / archived jobs, users, money collected this month, failed emails), a **Contact Us recipients** card (warns in orange when nobody is set), the payment / email / maps / import status, users by role, the 5 latest messages and jobs. |
| Messages | `/admin/messages` | The support inbox. Filter by status and category, search by name / email / subject / text. New tickets are highlighted and listed first. |
| Message detail | `/admin/messages/:id` | The full message, reporter details (email, phone, linked account, IP, device), a **status** control, **Reply by email** (sent from the site's sender address, signed with your support name, Reply-To set to your first support address, original message quoted; sending marks the ticket *in progress*, or *resolved* if you tick the box) and private **Internal notes**. |
| Jobs | `/admin/jobs` | Every posting including archived ones. **Printable** opens the public posting ready to print; **Receipt** opens the latest paid receipt; **Take down** removes a live posting immediately; **Restore** appears only while the posting still has a paid-up subscription. |
| Users | `/admin/users` | All accounts with role, dates and counts. **Deactivate** blocks sign-in and signs the user out everywhere (data is kept). You cannot deactivate yourself. |
| Payments | `/admin/payments` | Every charge, totals by month, GST collected, links to printable receipts. The prices shown come from Integrations → Pricing. |
| Mail outbox | `/admin/outbox` | Every email the site generated with its status: *sent*, *failed* (with the provider's error), *queued*, or *logged* (no email provider configured, so it was only recorded). Open one to see exactly what the recipient got. |
| Integrations | `/admin/integrations` | The control panel described below. Protected by a passcode on top of your login. |

Every status change, reply, takedown, restore, (de)activation, unlock, settings change and test button press is written to the audit log with your user id. Secret values are never written to the log.

## 3. Unlocking Integrations

Integrations holds Stripe keys, email credentials and admin accounts, so it asks for a **passcode** even after you are signed in.

- **First time ever:** the page asks you to *set* the passcode (6+ characters). Do this once and share it only with the admins who should manage payments and email.
- **Every later visit:** enter the passcode. You stay unlocked for 15 minutes of activity; **Lock now** ends it early.
- **Five wrong tries** lock the page for 15 minutes for that browser session.
- **Changing it:** Access & admins → Integrations passcode (needs the current one).
- **Lost it:** any other admin can change it. If nobody knows it, the server owner can set `ADMIN_PASSCODE=…` in `.env` on the server and delete the saved row (`DELETE FROM settings WHERE key='admin_passcode'`), then set a new one from the page.

The passcode and every other secret on this page are stored encrypted in the database (`enc:v1:…`); the encryption key is derived from the server's `SESSION_SECRET`.

## 4. What each section does

Each section has its own **Save** button and saves only its own fields. Under every field a tag says where the value in effect comes from: **Saved here** (set on this page), **From server .env** (set by the developer in the server's environment file; saving here overrides it) or **Default** (nothing set, built-in value).

For secret fields you never see the full value again — only a masked version like `sk_live••••4Q2z`. To change one, paste the new value in the **Replace** box; leave it empty to keep what is stored; tick **Clear** to remove it.

### Payments status (top card)
Read-only summary: payment mode (**Sandbox** = simulated card, no money collected; **Stripe test**; **Stripe LIVE**), whether the webhook secret is set, the email provider, the map provider, where Contact Us goes and whether the Job Bank import is on.

### Branding
- **Site name** — used in email subjects and footers.
- **Public URL** — the address of the site (`https://…`). Used in every email link, on receipts and as the Stripe webhook address. Must be correct before "Create prices & webhook".
- **Contact phone / Business address** — printed in the footer and on receipts.

### Pricing & GST
- **Employer / Consultant price** — cents per posting per month before tax (`1499` = $14.99). Whole numbers greater than 0.
- **GST rate** — `0.05` = 5 %. Allowed 0 to 0.3.
- **GST/HST registration number** — printed on receipts once you have one.

New checkouts use the new prices immediately. Existing subscriptions keep the price they were sold at. After changing prices with Stripe in use, click **Create prices & webhook** again so Stripe has matching prices.

### Stripe (payments)
Where to get the keys: log in at <https://dashboard.stripe.com> → **Developers → API keys**. Use the *test* keys (`sk_test_…`, `pk_test_…`) first; switch to *live* keys (`sk_live_…`, `pk_live_…`) when you are ready to charge real cards.

1. Paste the **secret key** and **publishable key**, Save.
2. Click **Test connection** — you should see your Stripe account name and "test mode" / "live mode".
3. Click **Create prices & webhook** — this creates the employer and consultant prices in your Stripe account (safe to repeat) and registers the webhook at `<Public URL>/billing/webhook`. The **webhook signing secret** is saved for you automatically. If a webhook for that address already existed, the page tells you where to copy the secret from in the Stripe dashboard (Developers → Webhooks → your endpoint → *Reveal*).
4. **Use Stripe Tax** — leave off unless you have enabled Stripe Tax in your Stripe account; off means the fixed GST rate above is added as one line.

Leaving the secret key empty keeps the site in **sandbox** mode: postings are "paid" with a simulated card and nobody is charged. Full go-live checklist: `docs/STRIPE-GO-LIVE.md`.

### Email delivery
Every email the site sends (acknowledgements, receipts, job alerts, password resets, admin replies) goes out **from the sender address below** — never from a person's mailbox.

- **Email provider** — *None* records emails in the Mail outbox only (useful while testing, but visitors get nothing). *SMTP* or *Resend* actually delivers.
- **SMTP URL** — `smtps://user:password@smtp.example.com:465` (port 465) or `smtp://user:password@smtp.example.com:587` (STARTTLS). Your email host gives you these details; Google Workspace and Microsoft 365 both work with an app password.
- **Resend API key** — sign up at <https://resend.com>, verify your domain (Domains → Add), then **API Keys → Create**. Paste the `re_…` key here.
- **Sender name / Sender email** — e.g. `Canada Careers` / `no-reply@yourdomain.ca`. The address must be one your provider allows you to send from (a verified domain on Resend; a mailbox or alias on SMTP).

Click **Send test email** with your own address, then check the inbox (and spam). A failure shows the provider's exact error and links to the outbox entry.

### Contact Us routing
- **Where Contact Us messages are delivered** — one or more addresses, separated by commas. Every address receives every message; the visitor's address is set as **Reply-To**, so hitting *Reply* in your mail client answers them directly. Nothing is ever sent *from* these addresses.
- **Support contact name** — appears on the Contact page and in reply signatures (for example "Support" or "Technical support").

If this is empty, messages are still stored in the admin inbox but **nobody is emailed** — the overview page shows an orange warning.

### Google Maps
Optional. Without a key the site uses OpenStreetMap (free) for maps and address lookup. With a key you get Google maps on postings and Google address autocomplete on location forms.

Get a key at <https://console.cloud.google.com> → create a project → **APIs & Services → Library**: enable **Maps JavaScript API**, **Places API** and **Geocoding API** → **Credentials → Create credentials → API key**. Paste it, Save, then **Test key** (the page geocodes "Parliament Hill, Ottawa"). Google requires a billing account on the project even for the free monthly allowance. **Map provider** lets you force one provider; *Automatic* is right for almost everyone.

### Job Bank import
**On** (default) runs the daily import of Government of Canada Job Bank reference postings with the site's scheduled job; **Off** skips it. Details: `docs/JOBBANK.md`.

### Access & admins
- **Admin logins** — everyone who can open this admin area. **Disable** signs them out everywhere and blocks sign-in (history kept); **Enable** reverses it. **Reset password** sets a new password (10+ characters) and signs that person out everywhere. You cannot disable yourself.
- **Add an admin** — name, their email (this is their login) and a first password of 10+ characters. Tell them the password privately; they can change it under *My account* after signing in.
- **Integrations passcode** — change it here (needs the current one).

## 5. How a Contact Us message flows

```
visitor fills /contact  ─►  contact_messages row (ticket #N, status "new")
                         ─►  one email per address in "Contact Us routing", from the site sender,
                             Reply-To = the visitor, with the full message, category, reporter
                             details, IP/device and a button to /admin/messages/N
                         ─►  auto-acknowledgement to the visitor ("ticket #N — <support name> will get back to you")
                         ─►  audit_log entry; visitor sees /contact/thanks?ref=N
```

Signed-in users can tick **Include my account** so the ticket links to their user record. Spam protection: a hidden honeypot field and a limit of 5 messages per browser session per hour.

## 6. For the developer

- Runtime values live in the `settings` table and are read through `lib/settings.js` (precedence: **database > .env > default**). `.env` values remain a fallback; anything saved on the page wins.
- Secrets are AES-256-GCM encrypted with a key derived from `SETTINGS_KEY` (or `SESSION_SECRET`). Changing that secret makes stored secrets unreadable — re-enter them on the page.
- `/admin/settings` (the old page) permanently redirects to `/admin/integrations`.
- Local development only: `GET /admin-dev-login/<email>?next=/admin` signs in without a password (absent in production).
