# QA tooling — smoke test + responsive screenshots

Two zero-dependency scripts (Node 24 built-ins + the already-installed `pg`) that run against a **running, seeded**
instance. Both accept `BASE_URL` (default `http://localhost:3900`) and exit 1 on any failure, so they double as a
CI gate. Files: `scripts/smoke.js`, `scripts/shots.js`, `scripts/cdp.js` (shared helper), output in `shots/qa/`.

```bash
cd /home/ubuntu/projects/canada-careers
PW=$(cut -d= -f2 docs/.dbpw)
export BASE_URL=http://localhost:3900
export DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/canada_careers"   # the DB *that instance* uses

node scripts/smoke.js          # ~60 s  — HTTP flow test, ~215 PASS/FAIL checks (≈10 s of that is the Nominatim geocoder on a fresh DB)
node scripts/shots.js --seed-extra   # ~8 min — 43 pages × 4 widths → shots/qa/*.png + shots/qa/REPORT.md
```

Against the QA sandbox: `BASE_URL=http://localhost:3909` + `DATABASE_URL=…/cc_qa` (start it with `NODE_ENV=development
DATABASE_URL=… PORT=3909 PUBLIC_URL=http://localhost:3909 STRIPE_SECRET_KEY= MAIL_PROVIDER=none node server.js`; the empty
Stripe key forces sandbox mode, which the checkout steps need — since 2026-09-10 the `stripe_secret_key` **settings row**
takes precedence over env, so it must be empty in that DB too; smoke.js asserts this). Both scripts also `require`
`lib/settings` directly (to set the Integrations passcode), so run them from the project root with the same
`SESSION_SECRET` the instance uses (`.env` — the passcode is encrypted with it). **Restart the instance after other agents land files** — Express caches
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
9. Contact form POST → 302 `/contact/thanks`, thanks page 200, `contact_messages` row, a `mail_outbox` row **per
   configured support recipient** (the two addresses step 12 saved through the panel) + the auto-reply to the sender
   (falls back to "exactly 2 rows" when the panel step could not set recipients).
10. `POST /logout` → 302.

Client round 2 (PDF, 2026-09-10) added, in run order:

11. **Profile + job form (R2).** Employer `GET /employer/profile` has `<select name="industry">` with `C.INDUSTRIES`
    keys, `operating_names[]` inputs and the address-book block; multipart `POST /employer/profile` with
    `industry=<key>` + `operating_names[]` (existing + `NL Smoke Trade`) → key stored, list stored, `operating_name` =
    first entry. `GET /employer/jobs/new` → the `apply_email` input equals the profile's `contact_email`;
    `GET /consultant/jobs/new?profile=<Prairie id>` → that profile's `contact_email`, never `consultant@example.com`;
    label reads "Application email (the employer's inbox)". Seed job temporarily set to legacy keys
    `entry`/`certificate` must render "1 year to less than 2 years" / "College/CEGEP" (restored afterwards).
    The posting flow (step 8) now runs in **select mode** when `views/portal/job-form.ejs` has `location_ids` checkboxes
    (or `routes/portal.js` reads them — a route/view mismatch is reported): the two addresses are first put in the
    profile's address book through `POST /employer/profile/locations` (consultant:
    `/consultant/profiles/:id/locations`, fields `loc_*`; existing rows reused, psql fallback printed), then ticked as
    `location_ids[]`; negatives are "nothing ticked → 422", "inline `new_loc_*` block with postal 12345 → 422",
    "education=other blank → 422". Asserted: `job_locations.employer_location_id` ∈ the ticked ids,
    `hours_amount/hours_period = 35/week` → public page "35 hours per week", `education=college` +
    `experience_level=1_2_years` accepted → Job Bank phrases on the page, `operating_name_choice_<pid>` = `NL Smoke Trade`
    → `jobs.operating_name` + shown publicly. Then an employer draft with one ticked + inline `new_loc_*` +
    `operating_name_choice=__new` / `operating_name_new_<pid>` → `employer_locations` +1 (label `[smoke] inline`),
    2 snapshot rows, the new name appended to `operating_names`. That draft stays (deleted next run) and is the
    checkout fixture for step 13.
12. **Maps.** `jobs/geocode.js --limit=25` is run (child process) when no live job has coordinates and Nominatim's
    `/status` answers (skipped with a note otherwise; last resort: manual city coordinates, reported as FAIL because
    the geocoder did not produce them). Then: the geocoded job's page has `[data-map]` + `/js/maps.js` + `CC_MAPS` +
    `data-markers`; `GET /api/jobs/geo?near=Mississauga, ON&radius_km=25` → JSON with ≥ 1 marker (tries the
    `lat/lng` form when `near` fails); `GET /jobs?near=Brampton, ON&radius_km=25` shows "… km";
    `GET /api/geocode/suggest?q=2400 Derry` → ≤ 5 results.
13. **Admin integrations.** The passcode is written first with `lib/settings.set('admin_passcode', 'qa-pass-123')`
    (`QA_ADMIN_PASSCODE` to change it). Locked `GET /admin/integrations` → 302 `/admin/integrations/unlock`; wrong
    passcode → still locked; right passcode (`action=unlock`) → 200 with all six groups' fields. Each group is
    re-posted **from the page's own `<form>`** (`findForm` in `scripts/cdp.js`) with one value changed:
    `employer_price_cents=1599` → `settings` row → `GET /billing/checkout/<draft>` shows $15.99 + $0.80 = $16.79
    (polled up to 8 s) → restored to 1499 and $15.74 checked again; `stripe_webhook_secret=whsec_…` → row value
    `enc:v1:…` + `is_secret`, then `stripe_webhook_secret__clear=1` empties it (and `stripe_secret_key` is asserted
    empty so the instance stays in sandbox); `POST …/email/test` with provider none → flash explains nothing was
    delivered / logged; `POST …/access/admins` → `smoke-admin@example.com` (role admin) can log in and open `/admin`;
    `support_email` = two smoke addresses (used by step 9) and restored to the previous value at the end.

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
contact — `name email phone category subject message`; R2 job form — `location_ids[]`, `new_loc_{label,street_address,
unit,city,province,postal_code}`, `operating_name_choice_<profileId>` (`__legal` | a name | `__new`) +
`operating_name_new_<profileId>`, `hours_amount`, `hours_period`; address book — `loc_{label,street_address,unit,city,
province,postal_code}`; admin — whatever the panel's own forms contain (re-posted), `to` for the test email,
`name email password` for a new admin. If an agent used different names the step FAILs and prints the form's error
text plus the field names/template it tried; adjust the `form`/`card` objects.

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

Pages added for client round 2 (2026-09-10): `job-detail-map` (`{geoslug}` = a live job with a geocoded
`job_locations` row; `--seed-extra` sets manual city coordinates when the geocoder has not run), `jobs-map`
(`/jobs?near=Brampton, ON&radius_km=50&view=map`), `admin-integrations` (`unlock: true` — after the admin login the
harness posts `QA_ADMIN_PASSCODE` (default `qa-pass-123`, written by `--seed-extra` through `lib/settings`) to
`/admin/integrations/unlock` so the panel is captured unlocked), `admin-users`, `profile-locations`
(`/employer/profile#locations`).

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
`/tmp` **or hidden dirs like `~/.cache`**); the shared HTTP helpers `CookieJar`, `request()`, `login()`; and HTML
form helpers `parseForms(html)` (every `<form>` → `{action, method, fields}` as a browser would submit it),
`findForm(html, fieldName | /action-re/)`, `inputValue(html, name)`, `flashes(html)`. Re-posting a page's own form
with one field changed is how the admin panel is tested without hard-coding its field list.

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
- **Job-page map needs coordinates first.** `[data-map]` only renders once a `job_locations` row has lat/lng, so the
  first R2 run reported "no map container" simply because the geocoder ran *after* that check. The check now runs
  after the geocode fixture. Same for `{geoslug}` in shots.js.
- **`#fragment` URLs break the status capture.** `/employer/profile#locations` navigated a second time (next width) is a
  same-document navigation: no new `Network.responseReceived`, `status=?`, false FAIL. shots.js now navigates to
  `about:blank` between captures and ignores the fragment when comparing the landing path.
- The admin validator only accepts `whsec_` + 8 alphanumerics — `whsec_smoke_123` (underscore) was rejected with a
  flash, so the "secret stored encrypted" check must use a value that passes validation.
- `lib/billing` reads prices from `lib/settings` at call time (DB > env > constants): a `stripe_secret_key` row in the
  QA DB would silently switch the instance to Stripe mode. smoke.js only ever writes `stripe_webhook_secret` and clears
  it again, and asserts `stripe_secret_key` is empty.
- `settings` values are cached 5 s server-side; anything written directly with `lib/settings.set` (the passcode) is
  done at the start of the run so the cache has expired by the time it matters. Values saved through the panel are
  invalidated immediately.
- The smoke run leaves visible traces in the QA DB by design: `[smoke]`-labelled address-book rows, the draft
  `[smoke] Inline Location …` job, `NL Smoke Trade` / `Smoke Trade <stamp>` operating names on the employer profile,
  `smoke-admin@example.com`. All are removed at the start of the next run (not the `NL Smoke Trade` name — it is the
  stable fixture the posting flow selects).

## Run log

- **2026-09-10 (client round 2 — PDF)** — instance `:3909` / `cc_qa`, tree as of 01:05: smoke **215/215 PASS**
  (address book via portal route, select-mode posting with `employer_location_id`, inline add-new location + operating
  name, 35 h/week, Job Bank vocabulary + legacy mapping, industry key, apply_email defaults, geocoder + geo API +
  distance search + suggest proxy, passcode gate, pricing change live on checkout, encrypted secret, test email, new
  admin login, support routing → outbox per recipient). First run had 2 FAILs, both harness bugs (map check before the
  geocoder; `whsec_` value with an underscore) — fixed. Final run at 01:08 after a restart: **216/216** (incl. the
  employer-signup industry select). Shots full suite `--seed-extra`: **168/168** (43 pages × 4 widths), no overflow,
  no console errors beyond the expected 404 on `not-found`; first pass had 3 false FAILs on `profile-locations`
  (`#fragment` same-document navigation → `status=?`) — harness fixed, recaptured OK. Screenshots of `job-detail-map`,
  `jobs-map`, `admin-integrations`, `profile-locations` inspected by eye: pins render on OSM tiles, distance chips,
  unlocked panel with status cards, operating-name list.

- **2026-09-09 (client round 1)** — instance `:3909` / `cc_qa`, tree as of 23:50: smoke **152/152 PASS** (employer
  and consultant flows, 422 validations, cover sheet up/down-load, interstitial, print, JSON-LD, receipts); shots for
  full suite 38 pages × 4 widths: 148/148 OK, no overflow, no console errors beyond the expected 404 on `not-found` (one earlier receipt 404 was the harness picking a smoke-job payment that a concurrent smoke run deleted — fixed in `dbFixtures`). Earlier run at 23:45 had
  22 FAILs, all "not landed yet" (billing views threw ReferenceErrors mid-edit, old routes in the process) — gone
  after a restart.
