# Canada Careers — job bank portal

**Live:** https://canadacareers.jobs · **Repo:** github.com/ankitjm/canada-careers (private) · **Server:** srv1751425 (187.127.180.28), path `/home/ubuntu/projects/canada-careers`, systemd `canada-careers`, port 3900, Postgres db `cc_main`.

This README is the knowledge-transfer document. It records **what the client asked for, how it is built, every mistake we made and the rule that came out of it**, and a checklist for cloning this into the next portals. Read it end to end before touching the code. Operational runbook: `OPS.md`. Design rules: `docs/UX-STANDARDS.md`. Everything else: `docs/`.

---

## 1. What the product is

A Canadian job bank with five tabs: **Employer · Third Party Consultant · Job Seeker · About Us · Contact Us**.

| Actor | What they get |
|---|---|
| **Employer** | Signs up with a company (legal name + operating/trade names + industry + address book of work locations), posts jobs, pays per posting, sees applicants, downloads resumes and cover sheets. |
| **Third Party Consultant** | One login, **unlimited employer profiles** underneath it; posts on behalf of any of them; one billing view across all clients. |
| **Job Seeker** | Free account, profile (categories, provinces, keywords, skills, audiences), resume upload once, one-click apply with optional cover sheet, saved jobs, **job alerts matched to the profile** (instant or daily digest), in-app notifications. |
| **Admin (the client)** | `/admin`: support inbox (Contact Us lands here), all jobs incl. archived, users, payments/receipts, mail outbox, and `/admin/integrations` (passcode-protected control panel: Stripe keys, email provider, support recipients, prices, GST number, Google Maps key, Job Bank sync, extra admin logins). |

Five audiences from the client's logo are first-class tags on every posting and seeker profile: **Professionals, New Immigrants, Indigenous, Refugees, Youth**.

## 2. The client's requirements, in full (this is the spec for the next portals too)

Everything below came from the client (Vishal / BRC) across three feedback rounds. Build the next portal with **all of it** from day one.

### Pricing and billing
- **Employers $14.99, third-party consultants $9.99 per posting per month, plus 5% GST** ($15.74 / $10.49). Price is decided by the **payer's role**, snapshotted on the subscription so renewals never re-price. Recurring until cancelled; cancel at period end (posting stays live) or immediately.
- Receipts: itemised (fee, GST, total), numbered `CC-YYYYMM-NNNNNN`, GST registration number printed, viewable and downloadable (print to PDF) from the login under Billing, emailed on every charge.
- Stripe Checkout in subscription mode, one Stripe Customer per user, four lookup-key prices (employer/consultant posting + GST lines), webhook-driven activation (`invoice.paid`), daily reconciliation cron. **Sandbox mode** (simulated card 4242…) until keys exist, with a visible banner.
- Inactive / expired / cancelled postings are **archived**: never public, 404, out of the sitemap. One rule in one place: `lib/jobs.js PUBLIC_WHERE`.

### The posting form (Job Bank-grade)
- **Industry**: dropdown only, the 25 NAICS sectors exactly as Job Bank lists them (`lib/constants.js INDUSTRIES`). No free text. NOC code is a typeable text field.
- **Education** and **experience**: Job Bank's exact dropdown lists + "Other (specify)" free text.
- **Salary**: amount with cents (hourly wages like $21.18) and period **hour / day / week / bi-weekly / month / year**. **Work hours**: number + frequency (week / bi-weekly / month / year).
- **Work location**: full street address + postal code is **required**. Locations are managed on the employer profile (address book) and **ticked when posting; several addresses per posting** are allowed and every one is printed on the posting, on the map, and in JSON-LD.
- **Operating / trade name**: employers keep a list of operating names; each posting picks one; seekers see the operating name first and "Operated by <legal name>" under it.
- **Application email** defaults to the **employer profile's** contact email, never the consultant's login. "**Other platform link**" (not "Apply link") for an external application URL.
- **Posting ID** in the pattern `X1X1X1` (letter-digit ×3, e.g. `K4T7M2`) on every posting, receipt, email and admin list; searchable; `/jobs/id/K4T7M2` resolves.
- **Locked after publishing**: once a posting has been paid and live, **company, operating name, title and work locations cannot change** (form shows them read-only with a lock note; server ignores them). Everything else stays editable, including **"Posted on"** and **"Applications close on"** dates. Past deadline = "Applications closed" (Apply hidden, alerts stop) while the posting stays visible until billing expiry.
- Owner **preview** shows exactly what seekers see, including hours. **Print / save as PDF** on every posting (Job Bank-style sheet).

### Job seekers
- Cover sheet upload (PDF/DOC/DOCX) as an alternative to a typed note; resume auto-attached from the profile; guest hits Apply → "create a free profile" interstitial → returns to the apply page after signup.
- Alerts matched on category / keywords (whole-word) / skills / province of **any** work location; audiences boost ranking.

### Content, SEO, maps
- About Us written for **SEO + AEO + GEO** (quick answers, FAQ with FAQPage JSON-LD, Organization/WebSite/AboutPage schema, internal links to category/province searches). JobPosting JSON-LD on every posting, sitemap, robots.
- **Google Maps** on postings and search (pin per location, "Near me", radius, place autocomplete) with an **OpenStreetMap/Nominatim fallback** when no Google key is set (`lib/geocode.js`).
- Contact Us goes to the configured support recipients (Veda's address is a *recipient*; nothing is ever sent *from* a person's mailbox).
- Real postings imported from jobbank.gc.ca to launch with content — **but the site must never say they came from Job Bank** (Service Canada concern). No badge, no attribution, no source row; the apply button is the generic "Apply on other platform" via an on-site hand-off (`/jobs/:slug/go`). Origin is visible only in `/admin/jobs`.

### Cross-cutting
- Light theme in the logo's colours (navy #1F3A5F, maple red #D42E2E, green, orange, teal), **mobile first**, perfect at 390 / 768 / 1024 / 1440 — every page, every state.
- Pages open at the **top** on navigation (`history.scrollRestoration = 'manual'`).
- One visual standard on every page: same container width, same header band, same section rhythm (`docs/UX-STANDARDS.md`). The client noticed immediately when About Us was wider than the rest.
- "Everybody has their own backend": the client manages keys, prices, email, support routing and admin users **in the site**, no server access.

## 3. Architecture

Plain **Node 24 + Express 4 + EJS** (express-ejs-layouts) + **PostgreSQL 18** on the host. No build step, no framework churn — the server serves the working tree.

```
server.js                 mounts routers IN ORDER (auth, seeker, portal, billing, about, contact, admin, jobs-search, public LAST)
db/schema.sql             idempotent schema (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) — `npm run migrate` on every deploy
lib/
  constants.js            every dropdown vocabulary (provinces, categories, INDUSTRIES, EDUCATION_LEVELS, EXPERIENCE_LEVELS, SALARY_PERIODS, HOURS_PERIODS, AUDIENCES, PRICING)
  helpers.js              view helpers `h.*` (formatSalary with cents, formatHours, fullAddress, displayCompany, formatDate…)
  jobs.js                 PUBLIC_WHERE, activateJob/archiveJob, ensurePublicId, isLocked
  job-dates.js            Toronto-day rules for published_at / application_deadline (pg DATE ≠ JS Date!)
  billing.js              provider-agnostic billing: getPricing(role), createCheckout, recordPayment, cancel/resume, Stripe webhooks, sandbox
  settings.js             the admin control panel storage: DB (encrypted secrets) > env > constants
  mail.js                 every email → mail_outbox row; sent via SMTP or Resend when configured, else "logged" (visible in /admin/outbox)
  matching.js             seeker ↔ job matching, alerts, daily digests
  geocode.js              Google or Nominatim geocoding + cache; publicMapConfig()
  jobbank.js              Job Bank importer (Atom feed + detail pages, cached, 5 s crawl delay)
  auth.js                 sessions (pg store), requireAuth(role…), flash, same-origin guard, audit
routes/                   one router per area; portal.js serves BOTH /employer/* and /consultant/*
views/                    EJS; layout.ejs + partials/{nav,footer,flash}; one folder per area
public/css/theme.css      the design system (KDS tokens + brand + shared primitives); page CSS only adds
jobs/run.js               daily cron (systemd timer): renewals, cancel-at-period-end, expiry archiving, digests, geocode backlog, Job Bank refresh
scripts/                  migrate, seed, smoke (346 end-to-end HTTP checks), shots (real-viewport screenshots via CDP), import-jobbank, stripe-setup, test-stripe
docs/                     CONTRACT.md (+ CHANGES-*.md per client round), UX-STANDARDS.md, BILLING.md, STRIPE-GO-LIVE.md, ADMIN.md, MAPS.md, JOBBANK.md, SEO.md, SECURITY.md, QA.md, TEST-*.md
```

Key tables: `users` (role: employer | consultant | seeker | admin) · `employer_profiles` (owner_user_id; employer owns 1, consultant owns many; operating_names[], industry) · `employer_locations` (address book) · `jobs` (status, public_id, locked_at, application_deadline, salary numeric, hours, source) · `job_locations` (snapshot per posting, lat/lng) · `subscriptions` + `payments` (price snapshot, receipt numbers) · `seeker_profiles` · `applications` (resume + cover sheet paths) · `saved_jobs` · `notifications` · `contact_messages` · `mail_outbox` · `settings` · `audit_log` · `geocode_cache` · `session`.

## 4. Running it

```bash
git clone git@github.com:ankitjm/canada-careers.git && cd canada-careers && npm install
createdb cc_dev   # any Postgres 14+; role needs CREATE EXTENSION citext/pgcrypto or a superuser to pre-create them
cp .env.example .env   # fill DATABASE_URL, SESSION_SECRET; leave STRIPE_*/SMTP_URL empty for sandbox + logged mail
npm run migrate && npm run seed      # demo users: veda@canadacareers.local (admin), employer@ / consultant@ / seeker@example.com — password Password123!
NODE_ENV=development npm start       # http://localhost:3900
```
Dev-only login shortcuts exist when `NODE_ENV !== 'production'`: `/portal-dev-login/:email?next=`, `/seeker-dev-login/…`, `/admin-dev-login/…`, `/billing-dev-login/…`.

**Tests** (run both before every deploy; they are the definition of done):
```bash
BASE_URL=http://localhost:3900 DATABASE_URL=… node scripts/smoke.js     # 346 HTTP checks incl. post→pay→live→cancel, locking, ids, dates, admin
BASE_URL=http://localhost:3900 DATABASE_URL=… node scripts/shots.js     # every page × 390/768/1024/1440, fails on horizontal overflow or console errors
```
Smoke creates and deletes its own `[smoke]` rows; if a run is interrupted, delete rows whose slug/label starts with `smoke-`/`[smoke]`.

**Deploy (production):** `cd ~/projects/canada-careers && git pull && npm install && npm run migrate && sudo systemctl restart canada-careers && curl -s localhost:3900/healthz`. Then run smoke against `https://canadacareers.jobs`. There is no auto-deploy on purpose.

**Go-live checklist for the client** (no server access needed): `/admin/integrations` → Stripe keys → "Test connection" → "Create prices & webhook" → pay a test posting with 4242 → swap to live keys · Email provider (SMTP or Resend) + sender address + "Send test email" · Support recipients · GST number · Google Maps key (Maps JavaScript, Places, Geocoding APIs; referrer-restrict to the domain). Details: `docs/STRIPE-GO-LIVE.md`, `docs/ADMIN.md`, `docs/MAPS.md`.

## 5. Mistakes we made and the rules that came out of them

These cost real time or real downtime. Do not repeat them.

1. **Every browser form was broken and no test caught it.** helmet's default `Referrer-Policy: no-referrer` makes browsers send `Origin: null` on POST, so our same-origin guard 403'd login, signup, apply, post-a-job and contact. Every curl-based test set `Origin` explicitly and passed. → `helmet({ referrerPolicy: 'strict-origin-when-cross-origin' })`, and **form flows are verified from a real browser** (`scripts/shots.js`/`cdp.js`), never only curl.
2. **Half-edited templates went live and 500'd job pages for four days.** The server serves the working tree; agents editing views were killed mid-edit by an API limit. → **All UI work happens in a git worktree / branch and is merged only after smoke + shots pass.** Production is a plain clone of `main`.
3. **A committed `node_modules` symlink replaced production's real modules on merge.** `.gitignore` said `node_modules/` (directories only). → the pattern is `node_modules` (no slash); never symlink node_modules inside a tree that gets `git add -A`'d.
4. **The DB password file was committed early** (`docs/.dbpw`). History was rewritten before the first push. → secrets live only in `.env` / `docs/.dbpw` / `docs/.admin-passcode`, all gitignored from commit one; check `git ls-files` for them before pushing anything.
5. **pg returns bigint ids as strings** → `"1" === 1` rejected every job POST until ids were normalised. Cast at the query boundary.
6. **pg returns DATE columns as server-local midnight** (server is IST, client is Toronto) → deadlines shifted by a day. → `lib/job-dates.js` normalises; never `h.formatDate(rawDateColumn)`; do calendar-date rules in the business timezone.
7. **"$2,118/hour"**: salary columns were integers; the client typed 21.18. → `numeric(10,2)` + cents in the formatter for hour/day rates.
8. **A constant was removed and one consumer kept reading it** (`C.PRICING.price_cents`) → NaN prices on every portal page until caught. → grep every consumer when changing `lib/constants.js`.
9. **Uploads trusted the client's MIME type** (an .exe renamed .pdf was stored). → magic-byte sniffing for resumes, cover sheets and logos.
10. **An archived consultant company could still publish and pay a posting.** → `PUBLIC_WHERE` also excludes archived profiles; publish/checkout guard.
11. **Job Bank imports: the feed URL in docs was dead, `locationstring` is ignored (use `fprov`), robots asks 5 s crawl delay, "$10,000 monthly" parsed as $10/hour (comma), a per-query cap that counted only inserts walked past itself.** All fixed in `lib/jobbank.js`; and per the client, **never show the origin publicly**.
12. **Agents killed each other's servers** with `pkill -f "node server.js"` (once killing production) and overwrote each other's scripts in a shared scratch dir. → kill by pid, per-agent DB + port + scratch subdir, never a wildcard kill.
13. **Environment/permission traps:** the auto-mode classifier blocks edits to `.env` — the admin panel (`lib/settings`) exists partly so the client and we never need to; `NODE_ENV=production` makes cookies `secure`, so http test instances must pass `NODE_ENV=development` on the command line; snap Chromium cannot use hidden dirs under `$HOME` and clamps `--window-size` below ~500 px (use CDP emulation for 390).
14. **Pages kept the previous scroll position** on navigation (client noticed). → `scrollRestoration = 'manual'` + scroll to top on load in `site.js`.
15. **The header wrapped to two lines when logged in** at 1024–1440. → compact header rules; screenshot logged-in states too, not only guest pages.

## 6. How the build was run (so the next one can be run the same way)

One orchestrator + parallel agents (9 build agents in round 1, then 5 test/import agents, 6, 7 and 8 in later rounds), partitioned strictly by **file ownership** (exactly one writer per file), with a written contract first (`docs/CONTRACT.md`, then `docs/CHANGES-*.md` per client round: vocabulary, URL map, DB columns, template variables, ownership table). Each agent had its own database, port and scratch dir; the orchestrator owned every integration point (server.js mounts, schema, constants, helpers, layout, theme) and verified the assembled whole with smoke + shots + looking at the screenshots. Route logic and templates were sometimes split across agents; the route owner published `docs/TEMPLATE-VARS-*.md` and view owners rendered defensively until variables landed.

## 7. Cloning this for the next three portals

1. **Fork the repo** (or `git clone --depth 1` into a new repo). Keep the structure; do not start from scratch.
2. **Brand:** replace `public/img/logo*.svg`, favicon, OG image, hero SVGs; override the `--cc-*` tokens at the top of `public/css/theme.css`. Nothing else in CSS should change for a rebrand.
3. **Names and copy:** `settings.site_name` (admin panel) drives title/nav/footer/emails; About Us content lives in `views/about/` + `routes/about.js` (FAQ/quick answers arrays); landing copy in `views/portal/landing-*.ejs`, `views/seeker/landing.ejs`.
4. **Pricing:** defaults in `lib/constants.js PRICING`, overridable in the admin panel per portal. Keep the role-based model unless the client says otherwise.
5. **Vocabularies:** `lib/constants.js` — if the portal is not Canadian, replace PROVINCES, INDUSTRIES, EDUCATION/EXPERIENCE lists, postal-code regex, GST rate/label, currency in `helpers.js`, and the Toronto timezone in `lib/job-dates.js`/`helpers.js`.
6. **Server:** new Postgres db + role, new `.env` (copy `.env.example`), new systemd unit + timer (copy the two units in `OPS.md`, change paths/port), Caddy block, `settings.public_url`. Run migrate, seed, smoke, shots.
7. **Client handover:** create their admin user, set the Integrations passcode, hand over `docs/ADMIN.md` + `docs/STRIPE-GO-LIVE.md`; make them change the password and passcode on first login; delete the demo seed before real users.
8. **Optional seed content:** `scripts/import-jobbank.js` (Canada only) — remember the no-attribution rule; `--purge` removes it all.

## 8. Where things are on the server

| | |
|---|---|
| Code | `/home/ubuntu/projects/canada-careers` (clone of `main`) |
| Service / logs | `sudo systemctl status canada-careers` · `canada-careers.log`, `renewals.log` |
| Daily cron | `canada-careers-renewals.timer` → `node jobs/run.js` 07:15 UTC |
| Database | `cc_main`, role `canada_careers`; password in `.env` and `docs/.dbpw` (600, gitignored) |
| Secrets for the client | `docs/.admin-passcode` (admin login + Integrations passcode; gitignored) |
| Uploads | `data/uploads/{resumes,covers,logos}` — served only through owner-checked routes |
| Backups | manual `pg_dump` (`data/*.dump`); scheduled backups are still an open task |
| Ops log | `~/projects/ops/sessions/2026-09-09--canada-careers-job-portal--7b653930.md`, tasks in `~/projects/ops/tasks.json` |
