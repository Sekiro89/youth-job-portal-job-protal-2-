# Canada Careers — Admin guide (for Veda)

You are the site's technical support and its only admin. This page explains how to sign in, what each admin screen does, and how a Contact Us message reaches you.

## Signing in

1. Go to `/login` and sign in with your admin account (`veda@canadacareers.local` on the seeded site; the password is set by whoever created your account — use **Forgot password** on `/login` if you do not have it).
2. After signing in you land on `/admin`. The **My account** button in the top bar always brings you back here.
3. Admin pages are private: they are never indexed by search engines and any non-admin who opens `/admin` is bounced to their own dashboard.

In local development only (`NODE_ENV` is not `production`) there is a shortcut: `GET /admin-dev-login/<email>?next=/admin` signs you in without a password. It does not exist in production.

## How a Contact Us message reaches you

```
visitor fills /contact  ─►  contact_messages row (ticket #N, status "new")
                         ─►  email to SUPPORT_EMAIL (you): full message, category, reporter details,
                             IP/device, "Reply to: <their email>" and a button to /admin/messages/N
                         ─►  auto-acknowledgement to the sender ("ticket #N — Veda or a member of the team
                             will get back to you")
                         ─►  audit_log entry, visitor sees /contact/thanks?ref=N
```

- Signed-in users can tick **Include my account**; the ticket is then linked to their user record and the email shows their account id, role and a link to their row in `/admin/users`.
- Spam protection: a hidden honeypot field (bots that fill it get a fake "thanks" and nothing is stored) and a limit of 5 messages per browser session per hour.
- Every email the site produces is also stored in the **Mail outbox**, so you can read it there even when no SMTP server is configured.

Replying: you can answer straight from your mail client (the email says "Reply to: <address>"), or open the ticket in the admin area and use **Reply by email** — that route keeps the ticket status and notes in sync.

## The screens

| Screen | URL | What it does |
|---|---|---|
| Overview | `/admin` | Counters (new / in-progress messages, active / awaiting-payment / archived jobs, users, money collected this month, failed emails), users by role, the 5 latest messages and jobs. Red tiles need attention. |
| Messages | `/admin/messages` | Your support inbox. Filter by status (new, in progress, resolved) and category, search by name/email/subject/text. New tickets are highlighted and sorted first. |
| Message detail | `/admin/messages/:id` | The full message, reporter details (email, phone, linked account, IP, device), a **status** control, **Reply by email** (subject prefilled "Re: …", your signature added, original quoted; sending marks the ticket *in progress*, or *resolved* if you tick the box), and private **Internal notes** (only admins see them; each reply is logged there automatically). |
| Jobs | `/admin/jobs` | Every posting, including archived ones, with owner, status, published/expiry dates, views and applicant count. **Take down** removes a live posting from the public site immediately (status *inactive*). **Restore** is offered only when the posting still has an active, paid-up subscription; otherwise the owner must publish and pay again. |
| Users | `/admin/users` | All accounts with role, created / last-login dates and counts of company profiles, jobs and applications. **Deactivate** blocks sign-in and signs the user out everywhere; their data is kept and you can reactivate later. You cannot deactivate yourself. |
| Payments | `/admin/payments` | Every charge ($9.99 + 5% GST = $10.49 CAD per posting per month), totals by month, GST collected, and a link to each printable receipt (`/billing/receipt/:id`). |
| Mail outbox | `/admin/outbox` | Every email the site generated: recipient, subject, status (*logged* = SMTP not configured so it was only recorded; *sent*; *failed* with the error; *queued*). Open one to see exactly what the recipient got (HTML preview and plain text). |
| Settings | `/admin/settings` | Support email, posting price (cents) and GST rate stored in the database. **Values in `.env` take precedence** — the page shows which value is actually in effect and where it comes from. |

Every status change, reply, takedown, restore, user (de)activation and settings change is written to `audit_log` with your user id.

## Changing the support email (where Contact Us messages go)

The address and display name come from the server environment file `.env`:

```
SUPPORT_EMAIL=veda@example.com
SUPPORT_NAME=Veda
```

1. Edit `.env` on the server and change `SUPPORT_EMAIL` (and `SUPPORT_NAME` if the person changes).
2. Restart the app (`systemctl restart canada-careers` or however it is run).
3. Send yourself a test message from `/contact` and confirm it appears in `/admin/messages` and, if SMTP is configured, in the new inbox.

The **Settings** page also stores a `support_email` value in the database, but while `SUPPORT_EMAIL` is set in `.env` that stored value is ignored — the page tells you which one is in effect. To make the database value win, remove `SUPPORT_EMAIL` from `.env` and restart.

## Email delivery

Emails are only *sent* when `SMTP_URL` is set in `.env` (for example `smtps://user:password@smtp.example.com:465`). Without it every email is recorded with status *logged* in the Mail outbox and nothing leaves the server — useful for testing, but remember that visitors will not receive their acknowledgements until SMTP is configured.
