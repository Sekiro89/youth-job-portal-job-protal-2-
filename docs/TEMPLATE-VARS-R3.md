# Round 3 — template variables provided by the routes (fixes-agent)

Status: **v1 2026-09-14 17:55 IST — all variables below are LIVE in the routes on branch `ux-round-1`** (port 3931 instance).
View agents render these; anything not listed here is unchanged from before. Render defensively (`typeof x !== 'undefined'`) only for
variables marked *(optional)*.

## Shared conventions (every page that shows a job)

| variable | type | meaning |
|---|---|---|
| `job.public_id` | `string \| null` | Posting ID, pattern `X1X1X1` (e.g. `K4T7M2`). Allocated on create, duplicate and activation, so every row has one; still guard `null` for very old rows. Show as `Posting ID K4T7M2`. |
| `job.locked` | `boolean` | `jobs.isLocked(job)` — published at least once; company / operating name / title / work locations are frozen. |
| `job.application_deadline` | `Date \| null` | **Already normalised to 12:00 America/Toronto** so `h.formatDate(job.application_deadline)` and `h.formatDateInput(...)` print the right calendar day. |
| `job.application_deadline_date` | `string \| ''` | The same deadline as `yyyy-mm-dd` (for `<time datetime>` / comparisons). |
| `job.applications_closed` | `boolean` | `application_deadline < today (Toronto)`. The deadline day itself is still open. When true: show "Applications closed", hide Apply. Posting stays visible until billing expiry. |
| `job.published_at` | `Date \| null` | Owner-editable "Posted on" (defaults to first activation). "Posted" rows and sort use this. |
| `job.hours_text` | `string \| ''` | `h.formatHours(job)` (portal job detail + preview). |
| `job.salary_text` | `string` | `h.formatSalary(job)` — decimal-aware, e.g. `$21.18/hour`, `$52,000/year` (portal job detail). |

`h.formatSalary(job)` now prints cents for hour/day periods everywhere (helpers are the orchestrator's; already merged).
`salary_min` / `salary_max` come back from Postgres as **numeric strings** (`"21.18"`), never do arithmetic on them without `Number()`.

Where a row is NOT a full job object the id is aliased: `job_public_id` (see per-page tables).

Shared helper module (new, fixes-agent): `lib/job-dates.js` — `todayToronto()`, `dateOnly(v)`, `torontoNoon(ymd)`, `isClosed(job)`,
`decorateJob(job)` (adds `application_deadline` Date@noon, `application_deadline_date`, `applications_closed`, `locked`),
`OPEN_WHERE` (SQL fragment: deadline null or >= today Toronto). Any route may `require('../lib/job-dates')`.

---

## Portal — `views/portal/job-form.ejs` (`GET/POST /employer|consultant/jobs/new`, `/jobs/:id/edit`)

| variable | type | notes |
|---|---|---|
| `job` | object \| null | as before (`null` on create). Has every shared field above (`public_id`, `locked`, `application_deadline`, `applications_closed`, `published_at`). |
| `values` | object | form echo. New keys: `salary_min`/`salary_max` (strings, decimals allowed, e.g. `"21.18"`), `published_at` (`yyyy-mm-dd` or `''`), `application_deadline` (`yyyy-mm-dd` or `''`). |
| `errors` | object | keys as before + `salary_min`, `salary_max` ("Enter an amount like 21.18 (up to 2 decimals)." / "…at most $9,999,999.99."), `apply_url` ("Other platform link must be a valid https:// URL"), `published_at`, `application_deadline`. |
| `locked` | boolean | `jobs.isLocked(job)`; `false` on create. When true the routes IGNORE submitted `employer_profile_id`, `title`, `operating_name_choice_*`, `operating_name_new_*`, `location_ids[]`, `keep_job_locations[]`, `new_loc_*` — render those as static text with a lock icon + "Locked after publishing — contact support to change." |
| `lockedFields` | string[] | `['employer_profile_id','operating_name','title','locations']` (from `lib/jobs.LOCKED_FIELDS`). Empty array when not locked. |
| `lockedSummary` | object \| null | `{ company, operating_name, title, locations: string[] }` — display strings: `company` = legal name, `operating_name` = the name seekers see (`''` when same as legal), `locations` = full address strings (one per `job_locations` row). `null` when not locked. |
| `companyLocked` | boolean | Company select is frozen even when `locked` is false: a job with billing (`pending_payment`, `active`, …). Keep sending the hidden `employer_profile_id`. |
| `canEditPublishedAt` | boolean | `!!job.published_at` — only then render the "Posted on" date input (`name="published_at"`, `max = today`). |
| `formPublishedAt` | string | `yyyy-mm-dd` to put in the `published_at` input (submitted value on a 422, stored value otherwise). |
| `formDeadline` | string | `yyyy-mm-dd` or `''` for the `application_deadline` input ("Applications close on", optional, `min = today` unless unchanged). |
| `today` | string | `yyyy-mm-dd` in America/Toronto for `min`/`max` attributes. |
| `byProfile`, `legacyLocs`, `profiles`, `COMPANY_SIZES`, `PRICE`/`GST`/`TOTAL` | | unchanged. |

Field names stay: `salary_min`, `salary_max` (`type="text" inputmode="decimal"` or `type="number" step="0.01"`), `hours_amount` (`step="0.5"`),
`apply_url` (label **"Other platform link"**, hint "If you also accept applications on another job board or your own site"),
`published_at`, `application_deadline`, `location_ids[]`, `new_loc_*`, `operating_name_choice_<pid>`.

## Portal — `views/portal/job.ejs` (`GET /jobs/:id`)

`job` has all shared fields + `job.hours_text`, `job.salary_text`, `job.locked`, `job.public_id`, `job.application_deadline` (Date@noon), `job.applications_closed`.
`sub`, `payments`, `recent`, `canReactivate`, `canDelete` unchanged. Preview must show `job.hours_text` and "Posting ID". "Apply link" label → "Other platform link".

## Portal — `views/portal/jobs.ejs` (`GET /jobs`)

Each `list[]` row additionally has `public_id`, `application_deadline` (Date@noon or null), `application_deadline_date`, `applications_closed`, `locked`, `locked_at`.

## Portal — `views/portal/dashboard.ejs`

`active[]` rows additionally have `public_id`, `locked`, `applications_closed`. `recent[]` (applications) rows have `job_public_id`.

## Portal — `views/portal/applicants.ejs`

`job` (job scope) has the shared fields incl. `public_id`. Every `list[]` row has `job_public_id`. `jobsList[]` rows have `public_id`.

## Public — `views/public/job.ejs` (`GET /jobs/:slug`)

| variable | notes |
|---|---|
| `job.public_id` | show in facts + card footer ("Posting ID K4T7M2"). |
| `job.application_deadline`, `job.application_deadline_date`, `job.applications_closed` | when closed: "Applications closed" badge, hide "Apply now" (and the other-platform CTA), keep Save/Print. |
| `closesAt` | `Date` — `application_deadline` (noon Toronto) when set, else `expires_at`. Use for the "Closes" row. |
| `closesLabel` | `'Applications close'` when a deadline is set, else `'Closes'`. |
| `postedAt` | `Date` — `published_at` (fallback `created_at`). Use for "Posted". |
| `more[]`, `similar[]` cards | rows have `public_id`, `application_deadline`, `applications_closed`. |
| `applyUrlLabel` | `'Apply on other platform'` — CTA text for `job.apply_url`. |
| everything else | unchanged (`companyName`, `legalName`, `hoursText`, `locations`, `mapMarkers`, `gmapsUrl`, `url`, `saved`, `printHost`, `printedOn`, `educationText`, `experienceText`, `industryText`). |

JSON-LD `validThrough` uses the deadline (end of that day, Toronto) when set.

## Public — `views/public/_job-card.ejs`, `home.ejs`, `company.ejs`

Card rows (`JOB_COLS`) now include `public_id`, `application_deadline`, `applications_closed`, `locked` — `latest[]` (home), `jobs[]` (company), `more[]`/`similar[]` (job page).

## Seeker — `views/seeker/apply.ejs` (`GET/POST /jobs/:slug/apply`)

| variable | notes |
|---|---|
| `job.applications_closed` | when true (GET): render the closed state instead of the form ("Applications for this posting have closed"). The POST answers **422** with the same page, a flash `error` "Applications for this posting have closed" (already in `flash`) and `errors.closed` with the same text. |
| `job.public_id`, `job.application_deadline`, `job.locked` | available. |
| `gate`, `profile`, `existing`, `values`, `errors`, `returnTo` | unchanged (`profile`/`existing` are present on the seeker path; guest/role gates render as before with `job.applications_closed` set). |

## Seeker — `dashboard.ejs`, `applications.ejs`, `saved.ejs`, `_jobcard.ejs`

- `matches[]` (dashboard): full job rows → `public_id`, `application_deadline`, `applications_closed`, `locked`. Closed postings are excluded from matches/alerts.
- `applications[]` (dashboard + applications page): rows have `public_id`, `application_deadline` (Date@noon), `applications_closed`, `is_public`, `title`, `slug`.
- `jobs[]` (saved): full job rows → `public_id`, `application_deadline`, `applications_closed`, `locked`, `applied`, `is_public`.

## Billing — `views/billing/index.ejs`, `receipt.ejs`, `checkout.ejs`, `sandbox.ejs`, `success.ejs`, `cancelled.ejs`

- `subs[]` rows: `job_public_id`; `payments[]` rows: `job_public_id`.
- `r` (receipt): `r.job_public_id` — print "Posting ID …" next to the job title.
- `job` on checkout/sandbox/success/cancelled: `job.public_id` (full row from `billing.loadJob`).

## Admin — `views/admin/jobs.ejs`, `overview.ejs`, `payments.ejs`

- `rows[]` (jobs): `public_id`, `application_deadline` (Date@noon), `applications_closed`, `locked`, `locked_at`. The `q` search also matches an exact Posting ID (case-insensitive).
- `latestJobs[]` (overview): `public_id`.
- `rows[]` (payments): `job_public_id`.

## Emails (already updated in routes/lib — no template work)

Receipt, new-applicant (employer), application-sent (seeker), application-status (seeker) and new-job-match (seeker) emails mention `Posting ID X1X1X1`.

## Seed states on every agent DB after `node scripts/seed.js` (re-seed to get them)

`Warehouse Associate (Days)` 3 locations, $19.50–$22.25/hour · `Personal Support Worker` $21.18–$24.50/hour · `Dispatch Coordinator` **deadline passed**
(applications closed, still active) · `Registered Nurse` future deadline + `apply_url` (other platform) · `AZ Truck Driver` operating name
"Northern Lights Freight" ≠ legal name · `Customer Success Specialist` no hours · `DevOps Engineer` draft (unlocked) · `Fleet Maintenance Technician`
pending_payment (unlocked, never published) · expired + cancelled rows · every job has a Posting ID. Verification: `docs/TEST-FIXES-R3.md`.

## Not done here (for other agents / orchestrator)

- `GET /jobs/id/:publicId` redirect and `/jobs?q=K4T7M2` exact match: **jobs-page agent** (`routes/jobs-search.js`). Use `jobs.PUBLIC_ID_RE` and `require('../lib/job-dates')` for `applications_closed` on list rows.
- Labels/hints/badges/lock icon: view agents.
- Orchestrator: nothing to mount; note the new file `lib/job-dates.js` (fixes-agent owns it this round).
