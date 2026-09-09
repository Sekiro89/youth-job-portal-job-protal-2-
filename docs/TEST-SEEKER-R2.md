# Auth + seeker — client feedback round 2 (PDF) test log (auth-seeker-agent, 2026-09-10)

Instance: `PORT=3904`, DB `cc_seeker` (re-migrated with the 2026-09-10 schema), `NODE_ENV=development`, `PUBLIC_URL=http://localhost:3904`.
Artifacts in `shots/seeker-r2/`: `jars/`, `*.html` (captured responses), `server.log`, `mail-capture.js` (in-process app with `mail.send` patched to
assert `replyTo`), `shoot.js` + `pages*.json` (CDP screenshots at 390/1440), PNGs listed below.
Test data: `jobs` 3 (`dispatch-coordinator-mississauga-3pvz`) `hours_amount=35, hours_period='week', operating_name='NL Dispatch Centre'`;
job 4 `hours_amount=37.5`. Users created: `mg1-r2@example.com` (employer "Maple Grove Bakery Ltd." / "Maple Grove"), `cons-r2@example.com`,
`sam-r2@example.com` (seeker, keyword dispatch, applied + saved job 3), `cap-r2@example.com` (seeker, capture test).

## What changed (files owned by this agent)
- `routes/auth.js` — employer signup: `industry` required and validated against `C.INDUSTRIES` keys; street + postal now REQUIRED (they become the
  profile's first `employer_locations` row, whose columns are NOT NULL); `unit` field; `operating_name` saved to both `operating_name` and
  `operating_names[]`; profile + `employer_locations` ("Main location", `is_default=true`) inserted in one `db.tx`; after commit
  `require('../lib/geocode').geocodeEmployerLocation(id)` in try/catch (MODULE_NOT_FOUND swallowed). Email links (welcome, reset) use
  `await settings.get('public_url')`; the module-level `PUBLIC_URL` const is gone. Employer signup page includes `/js/maps.js` via `extraJs`.
  `/account` passes `isAdmin`. Consultant/seeker signup unchanged.
- `views/auth/signup-employer.ejs` — Industry `<select>` (25 NAICS sectors), "Business address" section: street (`data-address-autocomplete`
  `data-autofill="street=street_address,city=city,province=province,postal=postal_code"`), unit, city / province / postal (3-col row).
- `views/auth/account.ejs` — admins see "Manage the site from /admin". `public/css/auth.css` — 2-col street/unit row, section note.
- `lib/matching.js`, `routes/seeker.js` — every job query selects `JOB_COMPANY` =
  `ep.company_name, COALESCE(NULLIF(jobs.operating_name,''), ep.operating_name) AS operating_name, jobs.hours_amount, jobs.hours_period`
  (previously `jobs.*` then `ep.operating_name` — the profile name silently overwrote the per-posting one). Alert / digest / application
  emails use `settings.get('public_url')`; hours in the alert body + notification body; employer "New applicant" email has
  `replyTo: "<applicant name> <applicant email>"`.
- `views/seeker/_jobcard.ejs` (hours in meta), `apply.ejs` (hours + Education / Experience rows using `h.educationName`/`h.experienceName`,
  legacy-aware, `*_other` text when key = other), `saved.ejs` ("no longer available" list used `company_name`; now `h.displayCompany`).
  `public/css/seeker.css` — `.apply-job__reqs`, `.job-card__hours`. Seeker profile has no education/experience field — nothing to migrate.

## Results (curl unless noted)
| Scenario | Result |
|---|---|
| `GET /signup/employer` | 200; `name="industry"` select with 25 options; street input carries `data-address-autocomplete data-autofill="…"`; `<script src="/js/maps.js">` present (file exists, 200) |
| POST without `industry` | **422** "Please choose your industry." |
| POST `industry=hacking` (not a key) | **422** |
| POST `postal_code=ZZZ` | **422** "Please enter a valid Canadian postal code (e.g. M5V 1A1)." |
| POST without street | **422** "Please enter your street address." |
| POST good (industry `accommodation_food`, `12 Bloor St W`, `Suite 300`, postal `m4w1a1`) | **302** → `/employer/dashboard`; `employer_profiles` id 5: operating_name `Maple Grove`, operating_names `{"Maple Grove"}`, industry `accommodation_food`, postal **M4W 1A1**; `employer_locations` id 5: label `Main location`, `12 Bloor St W` / `Suite 300` / Toronto / ON / M4W 1A1, `is_default=t`; geocoded by the maps lib (lat 43.628, lng −79.581); welcome email in `mail_outbox` with `http://localhost:3904/employer/jobs/new` |
| Consultant / seeker signup | 302 / 302 → `/jobseeker/dashboard` (unchanged) |
| Seeker dashboard (sam) | 200; job 3 card "NL Dispatch Centre · Mississauga, ON +1 more location", "Operated by Northern Lights Logistics", "35 hours per week"; job 4 "37.50 hours per week" (see gaps); notification bodies carry the operating name + hours |
| `GET /jobs/…-3pvz/apply` (sam) | 200; aside `<strong>NL Dispatch Centre</strong>` (Operated by …), "35 hours per week", "Experience 2 years to less than 3 years" (key `2_3_years`) |
| Save job 3 → `/jobseeker/saved` | 302 / 200 with operating name + hours |
| `POST …/apply` (upload resume + note) → `/jobseeker/applications` | 302 / 200; company column "NL Dispatch Centre" |
| `mail_outbox` after apply | seeker confirmation: subject "Application sent: Dispatch Coordinator at NL Dispatch Centre", body has operating name + "35 hours per week" + public_url links; employer notification to `apply@example.com` has operating name |
| `mail-capture.js` (in-process, `mail.send` patched) | employer notification `replyTo = "Cap Tester <cap-r2@example.com>"`; seeker/welcome emails have no replyTo; links use the configured public URL (`http://localhost:3924` in that process) |
| `matching.notifySeekersForJob(3)` | notified 2; alert email subject "New job match: Dispatch Coordinator at NL Dispatch Centre", text "… (Mississauga, ON, 35 hours per week)", link = public_url |
| `/account` as admin (`veda@`) | 200; "Manage the site from /admin" note |
| `server.log` | 0 errors from auth/seeker routes (one `[error] GET /admin … views/admin/overview.ejs` from the admin agent's page when the shoot script's admin login landed on `/admin`) |

## Screenshots (CDP; all no horizontal overflow, `scrollWidth == innerWidth`)
`signup-employer-{390,1440}.png` (industry select, business address block), `apply-seeker-{390,1440}.png` (job 4: hours + Experience row,
profile default operating name), `apply-guest-{390,1440}.png` (job 3 interstitial), `dashboard-{390,1440}.png` (job 3 = NL Dispatch Centre +
35 hours per week; job 4 = 37.50), `account-admin-{390,1440}.png`. Sticky "Send application" bar appears mid-page in the 390 full-page
capture (viewport-bottom bar, known from R1).

## Gaps / for the orchestrator
- `h.formatHours` (lib/helpers.js) prints `37.50 hours per week` for numeric(6,2) values with a fraction — `Number(job.hours_amount) % 1 === 0`
  is false for "37.50" so the raw pg string is used. Fix: `String(Number(job.hours_amount))` → "37.5".
- Employer signup now REQUIRES street + postal (schema: `employer_locations.street_address/postal_code NOT NULL`). R1 had them optional.
- `docs/MAPS.md` did not exist when this was built; the street input uses the contract attributes from the brief
  (`data-address-autocomplete`, `data-autofill="street=…,city=…,province=…,postal=…"`). Check against the maps agent's final doc.
- `mail_outbox` does not persist `replyTo` — only verifiable in-process (`shots/seeker-r2/mail-capture.js`) or via a real provider.
