# QA tooling — smoke test + responsive screenshots

Two zero-dependency scripts (Node 24 built-ins + the already-installed `pg`) that run against a **running, seeded**
instance. Both accept `BASE_URL` (default `http://localhost:3900`) and exit 1 on any failure, so they double as a
CI gate. Files: `scripts/smoke.js`, `scripts/shots.js`, `scripts/cdp.js` (shared helper), output in `shots/qa/`.

```bash
cd /home/ubuntu/projects/canada-careers
PW=$(cut -d= -f2 docs/.dbpw)
export BASE_URL=http://localhost:3900
export DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/canada_careers"   # the DB *that instance* uses

node scripts/smoke.js          # ~15 s  — HTTP flow test, ~150 PASS/FAIL checks
node scripts/shots.js --seed-extra   # ~6 min — 38 pages × 4 widths → shots/qa/*.png + shots/qa/REPORT.md
```

Against the QA sandbox: `BASE_URL=http://localhost:3909` + `DATABASE_URL=…/cc_qa` (start it with `NODE_ENV=development
DATABASE_URL=… PORT=3909 PUBLIC_URL=http://localhost:3909 STRIPE_SECRET_KEY= node server.js`; the empty Stripe key forces
sandbox mode, which the checkout steps need). **Restart the instance after other agents land files** — Express caches
nothing but the process still runs the routes/lib it loaded at start.

`DATABASE_URL` falls back to `.env`. Against an agent's isolated instance, point both at that agent's DB/port
(e.g. `PORT 3909` + `cc_qa`). **Never point smoke.js at production** — it writes rows (see below).

## scripts/smoke.js — what it checks

End-to-end HTTP test using global `fetch` with a manual cookie jar (`redirect: 'manual'`, parses `Set-Cookie`),
plus direct `pg` queries to verify DB side effects. Every step prints `PASS`/`FAIL` with the actual status and
`Location` header, so when a route deviates from `docs/CONTRACT.md` you see exactly what it did instead. A failing
step never aborts the run; a thrown exception becomes a FAIL. Failed POSTs print the form's own error text
(`class="…error…"` / flash elements) so validation mismatches explain themselves.

1. `/healthz` reachable; seeded fixtures present (an active job, an expired job, seeker user).
2. Public pages return 200 with `<h1` and `<meta name="viewport"`: `/ /jobs /about /contact /employer /consultant
   /jobseeker /login /signup /privacy /terms`; `/sitemap.xml` has `<urlset>`; `/robots.txt` names the sitemap.
3. Active job detail 200 (+ `JobPosting` JSON-LD); an `expired` job's slug 404s; sitemap lists **exactly** the
   live slugs (`status='active' AND expires_at > now()`), naming any not-live or missing ones.
4. Guest `GET /employer/dashboard` → 302 `/login`.
5. Login as employer / consultant / seeker / admin (`POST /login`, form-encoded) → 302 + `cc_session` cookie.
6. Employer dashboard 200; consultant dashboard 200 and `/consultant/profiles` lists Prairie Health Group + Maple
   Byte Software; seeker dashboard 200; seeker on `/employer/dashboard` → 302 (role guard); `/admin`,
   `/admin/messages` 200 as admin.
   Since the client round (2026-09-09) the active-job step also checks: every `job_locations` row's full address
   (`street, [Unit n,] city, PROV postal`) is on the page; JSON-LD `jobLocation` is an **array** (one entry per
   location) with `postalCode`; the page links `print.css` and has a `data-print` button; a live job whose
   `employer_profiles.operating_name` differs from the legal name (seed: Northern Lights Freight) shows the operating
   name; Job Bank rows (`source='jobbank'`, if any in the DB) show "Reference posting" and no `/apply` link.
   Guest `GET /jobs/<slug>/apply` must be a 200 interstitial linking `/signup/seeker` and `/login` (not a 302).
7. Apply flow: `GET /jobs/<slug>/apply` 200, then multipart POST (`FormData` + a generated one-page PDF `Blob` as
   `resume`, a second PDF as the cover sheet — field name discovered from `views/seeker/apply.ejs` (the file input
   that is not `resume`; currently `cover_file`), plus `cover_letter` text) → 302, `applications` row with
   `cover_letter_path` → `GET /jobseeker/applications/:id/cover` 200 `attachment` for the seeker →
   `GET /employer/applications/:id/cover` (or `/consultant/…` when the consultant owns the job) 200 `attachment`.
   Picks a live native job the seeker has **not** applied to, preferring one owned by the seeded employer.
8. Post-a-job flow, run **twice** — as employer ($14.99 + $0.75 = $15.74, 1574 cents) and as consultant
   ($9.99 + $0.50 = $10.49, 1049 cents; under Prairie Health Group). Employer-only negative checks first, each
   expecting **422 and no row** (a stray draft is reported and deleted): no street/postal; postal `12345`;
   `education=other` with empty `education_other`. Then: `GET /employer/jobs/new` 200 → POST with **two** work
   locations (`loc_street_address[]`… parallel arrays, discovered from `views/portal/job-form.ejs` — see
   `discoverLocationFields`) and `salary_period=biweekly` → 302 + draft, 2 `job_locations` rows (street + postal
   match, postal compared without spaces), `jobs.city/province` = first location, `salary_period=biweekly` →
   `GET /employer/jobs/:id` 200 → `POST …/publish` → 302 `/billing/checkout/:id` → checkout GET 200 shows the
   role's three amounts → checkout POST → 302 `/billing/sandbox/:checkoutId` → sandbox GET 200 → POST card `4242…`
   → 302 `/billing/success` → job `active` + paid-up, `subscriptions.total_cents` and `payments.total_cents` =
   role total, `CC-YYYYMM-NNNNNN` receipt → `GET /billing/receipt/:paymentId` 200 for the payer, 302/404 for the
   other role → job in `/jobs?q=`, public page lists both full addresses, shows the operating name, renders
   "bi-weekly", links `print.css`, has `data-print`, JSON-LD `jobLocation` array of 2 with `postalCode` → in
   sitemap → `GET /billing` 200 → `POST /billing/cancel/:id?now=1` → `cancelled`, public URL 404s, dropped from
   sitemap.
9. Contact form POST → 302 `/contact/thanks`, thanks page 200, `contact_messages` row, exactly **2** new
   `mail_outbox` rows (support notification + auto-reply).
10. `POST /logout` → 302.

**Side effects and cleanup.** Every row it creates is tagged `[smoke]` (job titles, application cover-letter text,
contact subject) and the uploaded files are named `smoke-resume.pdf` / `smoke-cover.pdf`. At start it deletes its
own leftovers from earlier runs (applications by marker or `smoke-%` file names, contact messages, jobs; set
`SMOKE_KEEP=1` to keep them). Both smoke jobs are cancelled, never left live. Runs are repeatable.

**Field names it sends** (portal/billing/contact forms are not fixed by the contract): job form —
`employer_profile_id title description requirements benefits category job_type work_arrangement experience_level
experience_other education education_other city province postal_code salary_min salary_max salary_period vacancies
languages skills audiences[] apply_email noc_code` + per location `loc_street_address[] loc_unit[] loc_city[]
loc_province[] loc_postal_code[]` (the street name is read from the view at run time; the others derive from it);
apply — `resume`, `cover_file` (discovered), `cover_letter`, `resume_choice=upload`; sandbox card — `card_number
number card name exp expiry exp_month exp_year cvc cvv postal_code` (aliases so any reasonable form works);
contact — `name email phone category subject message`. If an agent used different names the step FAILs and
prints the form's error text plus the field names/template it tried; adjust the `form`/`card` objects.

## scripts/shots.js — what it checks

Launches snap chromium headless with `--remote-debugging-port` and drives it over the DevTools Protocol using
`scripts/cdp.js`. For every page × width in `[390, 768, 1024, 1440]`:

- `Emulation.setDeviceMetricsOverride` (390 = `mobile:true`, `deviceScaleFactor:2`, touch on). This is the only
  way to get a real 390px viewport — the chromium CLI `--window-size` silently clamps to ~500px.
- Navigate, wait for `Page.loadEventFired` + 1.5 s settle.
- Evaluate `{scrollWidth, innerWidth, scrollHeight}`; `scrollWidth > innerWidth` = **OVERFLOW** = FAIL, and the up
  to 5 widest offending elements (`tag#id.class right=px`) are named so the owner can fix them.
- Record the main document's HTTP status (non-2xx = FAIL) and console errors/warnings
  (`Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`) — 404 assets, CSP refusals, JS
  exceptions all show up here.
- Full-page PNG via `Page.captureScreenshot` (`captureBeyondViewport: true`, clipped to 8000 css px) →
  `shots/qa/<key>-<width>.png` (390 shots are 780 px wide because of DSF 2).

Pages added for the client round: `job-detail-multi` (a live job with ≥ 2 `job_locations`), `apply-guest` (the
interstitial, captured as guest), `checkout-employer` / `checkout-consultant` (an unpaid draft/pending job owned by
each login — the seed's Fleet Maintenance Technician / DevOps Engineer), `receipt` (the employer's latest payment).
Their ids come from `DATABASE_URL` (`dbFixtures()`); `--seed-extra` creates what is missing — a second address on the
first live job, a `[qa] Checkout fixture` draft per role — and is idempotent. Never run `--seed-extra` on
production. Pages whose fixture is missing are skipped with a printed reason, not failed.

Logged-in pages: it logs in over HTTP per role (same cookie-jar code as smoke.js, from `cdp.js`), consumes the
"Welcome back" flash, then injects the httpOnly `cc_session` cookie with `Network.setCookie` before navigating;
cookies are cleared between pages so guest pages are really guest. `{slug}` in a path is replaced with a live job
slug from `/sitemap.xml` (DB fallback). Output: `shots/qa/REPORT.md` — table page × width → `OK 1234px` /
`OVERFLOW (sw>iw)` / `HTTP 500`, then overflow details, navigation errors and console errors per capture.

Options: `--only=home,jobs,apply` (page keys), `--widths=390,1440`, `--url=/any/path [--as=employer]` for an
ad-hoc page, `--seed-extra` (see above). Self-test the harness alone: `node scripts/cdp.js http://localhost:3900/nope 390` prints
`innerWidth` (must say 390) and writes `shots/qa/cdp-selftest-390.png`.

## Adding a page

`scripts/shots.js` → `pageList()`: add `{ key: 'seeker-saved', path: '/jobseeker/saved', as: 'seeker' }`. `key`
becomes the PNG name; `as` is `employer | consultant | seeker | admin` or omitted for guest; add `expect: 404` for a page whose correct status is not 2xx. For smoke.js add a
line in the relevant section: `await step('x', () => expectPage('seeker', '/jobseeker/saved', seeker));` or use
`expectRedirect(name, path, jar, /regex/, { method: 'POST', form: {...} })` for a state change, and assert DB
effects with `one('SELECT …')`.

## scripts/cdp.js

Zero-dependency Chrome DevTools Protocol client: RFC 6455 WebSocket over `node:net`/`node:tls` (masking,
fragmentation, ping/pong, 64-bit frames — screenshots are multi-MB messages), `CDP.connect(port)` → `send()`,
`waitFor(event)`, `eval(expr)`; `launchChromium()` (profile under `$HOME/cc-qa-chromium/` — the snap cannot write
`/tmp` **or hidden dirs like `~/.cache`**); and the shared HTTP helpers `CookieJar`, `request()`, `login()`.

## Gotchas learned while building this

- **`NODE_ENV=production` in `.env` breaks every login over plain http**: `cookie.secure` becomes true and
  express-session silently withholds `cc_session` (login still 302s, so only the "no cookie" detail shows it).
  Run any http test instance with an explicit `NODE_ENV=development ... node server.js` — env beats dotenv.
- Chrome's `Network.responseReceived` only reports the *final* document after a redirect, so shots.js also
  compares `location.pathname` with the requested path and flags `REDIRECT→/login` (a logged-in page whose
  cookie did not stick) as FAIL. Add `redirect: true` to a page entry if landing elsewhere is intended.

- Snap chromium: profile/PNG paths must be under `$HOME` and not a top-level dot-directory.
- `document.documentElement.scrollWidth` can be 390 while an *inner* element scrolls horizontally on purpose
  (e.g. the portal tab strip) — that is fine and not flagged; only page-level overflow is.
- The same-origin guard (`lib/auth.js`) accepts requests with no `Origin`; `request()` sends `Origin: BASE_URL`
  anyway so the scripts behave like a browser.
- `pg` returns `bigserial` ids as **strings**; strict `===` against a parsed integer fails (smoke.js caught this
  in the job form's profile check — see the run report).
- Do not `pkill -f PORT=3909` from a script whose own command line contains that string — it kills the shell
  running it (exit 144). Keep a pid file instead.
- `GET /billing/checkout/:id` creates a `pending` subscription row as a side effect (`ensureSubscription`), so the
  checkout screenshots leave one row per fixture job behind. Harmless in a sandbox DB.
- The smoke-created jobs are cancelled at the end of the run, so `job-detail-multi` cannot reuse them — that is why
  `--seed-extra` adds a second address to a seeded job instead.

## Run log

- **2026-09-09 (client round 1)** — instance `:3909` / `cc_qa`, tree as of 23:50: smoke **152/152 PASS** (employer
  and consultant flows, 422 validations, cover sheet up/down-load, interstitial, print, JSON-LD, receipts); shots for
  full suite 38 pages × 4 widths: 148/148 OK, no overflow, no console errors beyond the expected 404 on `not-found` (one earlier receipt 404 was the harness picking a smoke-job payment that a concurrent smoke run deleted — fixed in `dbFixtures`). Earlier run at 23:45 had
  22 FAILs, all "not landed yet" (billing views threw ReferenceErrors mid-edit, old routes in the process) — gone
  after a restart.
