# Canada Careers — build contract (read fully before writing a line)

Project root: `/home/ubuntu/projects/canada-careers`. Node 24, Express 4, EJS + express-ejs-layouts, Postgres 18 (`pg`), express-session (pg store), multer, nodemailer, stripe. **No other dependencies without asking the orchestrator.** Light theme only. **Mobile first** — every page must be perfect at 390px, 768px (iPad portrait), 1024px (iPad landscape) and 1440px.

## Files you may touch
You own ONLY the files listed in your brief. Never edit: `server.js`, `db/schema.sql`, `lib/*`, `views/layout.ejs`, `views/partials/*`, `views/error.ejs`, `public/css/theme.css`, `public/js/site.js`, `scripts/seed.js`, `scripts/migrate.js`, `package.json`, `.env`. If you need a change there, put it in your final report as "ORCHESTRATOR: add X" and work around it meanwhile.

## Run your own isolated instance (never share a DB/port with another agent)
```bash
cd /home/ubuntu/projects/canada-careers
PW=$(cut -d= -f2 docs/.dbpw)
DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/<YOUR_DB>" PORT=<YOUR_PORT> PUBLIC_URL=http://localhost:<YOUR_PORT> node server.js
```
Your DB is already migrated + seeded (`scripts/seed.js`). To reset it: `sudo -u postgres psql -qc "DROP DATABASE <db>" && sudo -u postgres psql -qc "CREATE DATABASE <db> OWNER canada_careers"` then run migrate + seed with your DATABASE_URL. Uploads go to `data/uploads/` — write your test uploads under `data/uploads/<your-agent-name>/`.

Seed logins (password for all: `Password123!`):
- admin (Veda): `veda@canadacareers.local` · employer: `employer@example.com` (1 profile: Northern Lights Logistics) · consultant: `consultant@example.com` (2 profiles: Prairie Health Group, Maple Byte Software) · seekers: `seeker@example.com`, `seeker2@example.com`.
- 12 jobs: 8 active, 1 expired, 1 cancelled, 1 draft, 1 pending_payment. One application by seeker@ on the first active job.

Screenshots: chromium is a snap; write PNGs under `$HOME` (e.g. `~/projects/canada-careers/shots/<agent>/`), never /tmp. `chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars --screenshot=~/projects/canada-careers/shots/<agent>/x.png --window-size=1440,1200 URL`. **`--window-size` clamps below ~500px wide** — for the 390px mobile check use Chrome DevTools Protocol `Emulation.setDeviceMetricsOverride` (a small puppeteer-core script against `chromium --remote-debugging-port` works; puppeteer-core is NOT installed — use `node:http` + `ws`? Neither is installed. Simplest reliable path: `chromium --headless=new --no-sandbox --screenshot=... --window-size=768,1400` for tablet and, for mobile, add `?_vw=390` is NOT supported — instead open the page with `--window-size=500,1000` AND verify with the DOM that nothing overflows: `document.documentElement.scrollWidth <= innerWidth`. Use `--dump-dom` to inspect. Also design at 390 via CSS reasoning: no fixed widths > 100%, tables use `.table--stack`, grids collapse to 1 column below 640px.) Look at the images you take with the Read tool. Claims must be demonstrated.

## Layout + templates
`res.render('<area>/<page>', { title, metaDescription?, extraCss?: ['/css/x.css'], extraJs?: ['/js/x.js'], jsonLd?: [obj], bodyClass?, noindex?: true, ...data })`. The layout (`views/layout.ejs`) renders header nav, flash messages, footer. Every template has: `user` (null or `{id,email,role,name}`), `h` (helpers, `lib/helpers.js`), `C` (constants, `lib/constants.js`), `path`, `PUBLIC_URL`, `canonical`. Escape output with `<%= %>` (EJS escapes). `h.paragraphs(text)` renders user text safely as `<p>`s (use `<%- %>` for it only).

Nav tabs (fixed, in `partials/nav.ejs`): Find Jobs `/jobs` · Employer `/employer` · Third Party Consultant `/consultant` · Job Seeker `/jobseeker` · About Us `/about` · Contact Us `/contact` · Sign in `/login` · Sign up `/signup`. `/employer`, `/consultant`, `/jobseeker` are PUBLIC landing pages that explain the offering and CTA to signup/login; logged-in users of that role see their dashboard link.

## CSS
`public/css/theme.css` already provides: `.container .section-pad .grid .grid--2/3/4 .stack .cluster .split .card .card--flat .form .form-row .form-row--3 .field .input .checks .check .form-actions .badge(--positive/--warning/--danger/--teal) .page-head .dash .dash__side .dash__main .stats .stat .table .table--stack (td[data-label]) .job-card* .empty .eyebrow .lead .muted .small .aud.aud--<audience> .divider-maple .kds-btn(--brand/--accent/--ghost/--block/--sm)`. Tokens: `--cc-navy --cc-red --cc-green --cc-orange --cc-teal --cc-ink --cc-ink-muted --cc-line --cc-surface --cc-navy-50/100 ...` — never hardcode hex colours; use tokens. Put page-specific CSS in YOUR css file (listed in your brief) and reference it via `extraCss`. Touch targets ≥ 44px. Fonts: Montserrat (display, already loaded) + Inter.

Job card markup (reuse everywhere):
```html
<article class="job-card">
  <h3 class="job-card__title"><a href="/jobs/<%= job.slug %>"><%= job.title %></a></h3>
  <div class="job-card__company"><%= job.company_name %> · <%= h.location(job) %></div>
  <div class="job-card__meta"><span><%= h.jobTypeName(job.job_type) %></span><span><%= h.workArrangementName(job.work_arrangement) %></span><span class="job-card__salary"><%= h.formatSalary(job) %></span></div>
  <div class="cluster"><% job.audiences.forEach(a => { %><span class="aud aud--<%= a %>"><%= h.audienceName(a) %></span><% }) %></div>
  <div class="job-card__foot"><span>Posted <%= h.timeAgo(job.published_at) %></span><span><%= h.categoryName(job.category) %></span></div>
</article>
```

## Auth (lib/auth.js)
`requireAuth('employer','consultant')` middleware; `req.user`; `req.flash('success'|'error'|'info', msg)`; `auth.login(req, user)` returns redirect target; `auth.homeFor(user)`; `auth.audit(userId, action, entity, entityId, meta)`. POST requests from another origin are blocked by `sameOriginGuard` (no CSRF tokens needed). Roles: `employer` owns exactly ONE employer_profile; `consultant` owns MANY; `seeker`; `admin` (Veda).

## Jobs (lib/jobs.js) — THE RULES
- Public visibility = `PUBLIC_WHERE` (`jobs.status='active' AND jobs.expires_at > now()`). Any public listing/detail/sitemap/matching MUST use it. Everything else is archived and 404s publicly.
- `archiveJob(id, 'cancelled'|'inactive'|'expired')`, `activateJob(id, periodEnd)`, `expireLapsedJobs()`, `userCanManageJob(user, jobId)`, `uniqueJobSlug(title, city)`, `uniqueProfileSlug(name)`.
- Lifecycle: draft → (Post & pay) pending_payment → active (paid) → renews monthly → expired (payment lapsed / not renewed) | cancelled (owner cancels) | inactive (owner pauses / admin). Price: `$9.99 + GST 5% = $10.49 CAD per posting per month`, recurring until cancelled.
- Posting a job = employer/consultant creates job (status draft), clicks "Publish" → redirected to `/billing/checkout/:jobId` (billing agent). Billing activates the job on success and redirects back to `/employer/jobs/:id` (portal agent). Cancel = `POST /billing/cancel/:jobId` (billing agent) → sets `cancel_at_period_end` (job stays live until period end) OR immediate cancel with `?now=1` → archiveJob('cancelled').

## Mail (lib/mail.js)
`await mail.send({ to, subject, html: mail.layout(title, bodyHtml, {href,label}), text })`. Always recorded in `mail_outbox`; sent only if SMTP configured. Escape user content with `h.escapeHtml` in email html.

## URL map (owner in brackets)
- `[public]` `GET /`, `GET /jobs` (search: q, category, province, city, job_type, work_arrangement, audience, page), `GET /jobs/:slug` (404 unless PUBLIC_WHERE; increments views; JobPosting JSON-LD), `GET /companies/:slug` (public employer page, active jobs only), `GET /sitemap.xml`, `GET /robots.txt`, `GET /privacy`, `GET /terms`.
- `[auth]` `GET|POST /login`, `GET /signup` (choose role), `GET|POST /signup/employer`, `/signup/consultant`, `/signup/seeker`, `POST /logout`, `GET|POST /forgot`, `GET|POST /reset/:token`, `GET|POST /account` (name/phone/password). Employer signup creates user + their single employer_profile (company name required). Consultant signup creates user only (adds profiles later). Seeker signup creates user + empty seeker_profiles row.
- `[portal]` employer + consultant share one code path with a profile selector. `GET /employer` (public landing + pricing), `GET /consultant` (public landing), `GET /employer/dashboard`, `GET /consultant/dashboard`, `GET /employer/profile` (edit own company), `GET /consultant/profiles` + `GET|POST /consultant/profiles/new` + `GET|POST /consultant/profiles/:id/edit` + `POST /consultant/profiles/:id/archive`, `GET /employer/jobs` (all statuses, filter tabs incl. Archived), `GET|POST /employer/jobs/new` (consultant picks profile), `GET /employer/jobs/:id`, `GET|POST /employer/jobs/:id/edit`, `POST /employer/jobs/:id/publish` (→ redirect to `/billing/checkout/:id`), `POST /employer/jobs/:id/pause` (archive inactive), `POST /employer/jobs/:id/duplicate`, `GET /employer/jobs/:id/applicants`, `POST /employer/applications/:id/status`, `GET /employer/applications/:id/resume` (download, owner only). `/consultant/*` routes are the same handlers (the same router answers both prefixes) plus the profiles pages.
- `[seeker]` `GET /jobseeker` (public landing), `GET /jobseeker/dashboard` (matches, recent applications, notifications), `GET|POST /jobseeker/profile` (incl. resume upload), `GET /jobseeker/applications`, `GET /jobseeker/saved` + `POST /jobs/:slug/save` + `POST /jobs/:slug/unsave`, `GET /jobseeker/alerts` + `POST /jobseeker/alerts` (notify_email, frequency, criteria), `GET /jobseeker/notifications` + `POST /jobseeker/notifications/read`, `GET|POST /jobs/:slug/apply` (must be seeker; guests get redirected to login with returnTo; uses profile resume or a fresh upload), `GET /jobseeker/resume` (download own). Also exports `lib/matching.js`-like logic INSIDE `routes/seeker.js`'s sibling file `lib-seeker/matching.js`? NO — seeker agent owns `lib/matching.js` (exception to the lib rule): `notifySeekersForJob(jobId)` (creates notifications + emails for matching seekers) and `matchesForSeeker(userId, limit)`. Billing calls `notifySeekersForJob` on first activation.
- `[billing]` `GET /billing/checkout/:jobId` (summary: $9.99 + GST $0.50 = $10.49/month; Stripe Checkout in subscription mode when STRIPE_SECRET_KEY set, else sandbox card form), `POST /billing/checkout/:jobId` (create session), `GET /billing/sandbox/:checkoutId` + `POST /billing/sandbox/:checkoutId` (simulated card page; test card 4242…), `GET /billing/success?job=`, `GET /billing/cancelled?job=`, `POST /billing/webhook` (Stripe; raw body already provided by server.js), `POST /billing/cancel/:jobId` (?now=1 immediate), `POST /billing/resume/:jobId` (undo cancel-at-period-end), `GET /billing` (subscriptions + payments for the current user, all profiles), `GET /billing/receipt/:paymentId` (printable receipt, owner only). Also owns `jobs/renewals.js` exporting `runRenewals()`: sandbox renewals (charge, extend 30 days, payment row, receipt email), Stripe reconciliation, `expireLapsedJobs()`, then cancel-at-period-end handling; and `jobs/run.js` CLI that calls it (systemd timer will run it daily). Receipt numbers: `CC-YYYYMM-000001` via `nextval('receipt_seq')`.
- `[about]` `GET /about` (SEO/AEO/GEO-rich content page, FAQ + Organization + WebSite JSON-LD).
- `[contact]` `GET|POST /contact` (→ contact_messages + email to SUPPORT_EMAIL (Veda) + auto-reply), `GET /admin`, `GET /admin/messages`, `GET|POST /admin/messages/:id` (status/notes/reply), `GET /admin/jobs` (all incl. archived, force-archive), `GET /admin/users`, `GET /admin/outbox` (mail log), `GET /admin/payments`. Admin = `requireAuth('admin')`.
- `[brand]` `public/img/logo.svg` (horizontal lockup used in nav/footer, ~400×112 viewBox), `logo-stacked.svg` (the full logo as attached: maple leaf + 5 figures + arc + CANADA / CAREERS + tagline + audience icon strip), `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `og.png` (1200×630), `logo-email.png` (360px wide), `public/img/audience/{briefcase,globe,inukshuk,hand,star}.svg`, `public/img/hero-*.svg` illustrations for the home/landing pages, plus `public/css/brand.css` (optional: `.audience-icon` classes).
- `[qa]` `scripts/smoke.js` (end-to-end HTTP flow test using fetch + cookie jar against a running instance) and `scripts/shots.js`/`scripts/shots.sh` (screenshots at 390/768/1024/1440 for a list of URLs, including logged-in pages).

## Quality bar (every agent)
- Server-side validation on every POST with friendly field errors re-rendered in the form (keep user input). Flash on success.
- Every page: `<h1>`, sensible `title` + `metaDescription`; app pages `noindex: true`.
- Mobile first. No horizontal scroll at 390px. Tables → `.table--stack`. Sticky bottom action bars are fine but must not cover content.
- Accessibility: labels on all inputs, focus-visible, buttons not divs, aria on toggles.
- Never expose resumes/uploads via static URL — serve through authorised routes with `res.download`.
- Log actions with `auth.audit(...)` for create/publish/cancel/status changes.
- Final report (≤ 25 lines): what you built, routes, how you verified (with screenshot paths), ORCHESTRATOR items, known gaps.
