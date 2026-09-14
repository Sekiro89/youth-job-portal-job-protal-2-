# Round 3 — fixes-agent verification (2026-09-14, instance :3931, db `ux_fix`)

Scope: the server-side half of `docs/CHANGES-2026-09-14-ROUND3.md` — Posting IDs, locking after publication, owner-editable dates,
decimal salaries, "Other platform link" validation, owner-preview conveniences, seed states. Template variables are documented in
`docs/TEMPLATE-VARS-R3.md`. Views/CSS were not touched by this agent.

## How to run it again

```bash
cd /home/ubuntu/projects/canada-careers-ux
PW=$(grep '^DB_PASSWORD=' docs/.dbpw | cut -d= -f2)
export DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/ux_fix" PGPASSWORD=$PW NODE_ENV=development PORT=3931 PUBLIC_URL=http://localhost:3931
# fresh schema + seed (own DB only — never production)
psql -h 127.0.0.1 -U canada_careers -d ux_fix -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" && node scripts/migrate.js && node scripts/seed.js
node server.js &                      # kill only THIS pid afterwards (lsof -t -i:3931)
bash shots/fix/verify-fixes-r3.sh     # curl + cookie jars + psql; prints PASS/FAIL, ~150 checks (edit the env.sh source line to your paths)
BASE_URL=http://localhost:3931 node scripts/smoke.js   # QA agent's suite
```

## Results (last run 2026-09-14 ~18:40 IST)

`verify-fixes-r3.sh`: **153/153 PASS** after fixing two assertions in the script itself (see "false positives" below).
`scripts/smoke.js`: **343/346** — the 3 FAILs are not this agent's (see bottom).

| # | Flow (all exercised over HTTP against :3931, state checked with psql) | Result |
|---|---|---|
| 1 | Seed: every job has `public_id` matching `^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$`; PSW rate stored `21.18`; Dispatch Coordinator deadline in the past; drafts unlocked; active jobs locked | PASS |
| 2 | Public `/jobs/:slug` (PSW): prints `$21.18 – $24.50/hour`, shows Posting ID, JSON-LD `identifier.value` = Posting ID, not closed | PASS |
| 3 | Public closed posting (Dispatch Coordinator): "Applications closed", JSON-LD `directApply:false`, no `Apply now` link; future-deadline job shows "Applications close" + "Apply on other platform" CTA | PASS |
| 4 | Seeker on closed posting: `GET /jobs/:slug/apply` 200 with closed state; `POST` → **422** with flash "Applications for this posting have closed"; no `applications` row | PASS |
| 5 | Matching: `matchesForSeeker` excludes the closed posting (`OPEN_WHERE`) | PASS |
| 6 | Employer create draft (`POST /employer/jobs/new`, inline new location, `salary_min=21.18`, `salary_max=2118`) → 302, draft has `public_id`, salary stored `21.18` / `2118.00`, 1 location, unlocked | PASS |
| 7 | Owner detail page shows Posting ID, `37.5 hours per week`, `$21.18`; edit form echoes `value="21.18"` | PASS |
| 8 | Validation 422s: `salary_min=abc` → "Enter an amount like 21.18 (up to 2 decimals)."; `99999999` → "…between 0.01 and 9,999,999.99."; min>max → "Maximum must be at least the minimum."; `apply_url=http://…` → "Other platform link must be a valid https:// URL"; `application_deadline=yesterday` → "The closing date must be today or later." | PASS |
| 9 | Draft: `published_at=2020-01-01` is ignored (stays NULL until published); `apply_url=jobs.example.com/apply` → `https://jobs.example.com/apply`; deadline next week saved; `24.5` → `24.50` | PASS |
| 10 | Unlocked draft edit: title + `location_ids` change; `job_locations` replaced; `jobs.city` mirrors the first location | PASS |
| 11 | Publish via sandbox (`/publish` → `/billing/checkout` → `/billing/sandbox/:id` card 4242) → `active`, `locked_at` + `published_at` set, `public_id` unchanged; public page prints `$21.18` `/hour` + Posting ID; receipt email text contains `Posting ID <id>`; `/billing`, `/billing/receipt/:id?print=1` 200 | PASS |
| 12 | **Locked edit** posting a different title, `location_ids`, a `new_loc_*` block and `operating_name_choice_1=__new`: 302; title unchanged; `job_locations` ids/cities identical; no sneaky `employer_locations` row; `jobs.operating_name` unchanged; profile `operating_names` unchanged; description/salary updated; `published_at` moved to last week **at 12:00 America/Toronto**; public "Posted" shows that date; `published_at=2999-01-01` → 422 | PASS |
| 13 | Deadline (set to yesterday by SQL — the form refuses past dates): public page closed; seeker apply POST 422; owner detail shows "Applications closed"; re-saving the unchanged past deadline is accepted; clearing it reopens; `application_deadline=today` accepted and the page still shows `Apply now` (deadline day is open) | PASS |
| 14 | Duplicate: new `draft`, unlocked, **new** `public_id`, locations copied, no deadline copied, title editable | PASS |
| 15 | Every page renders 200 for every seeded state: portal detail + edit for all 12 seeded jobs + created ones (draft, pending_payment, active, expired, cancelled, locked/unlocked, 1 and 3 locations, operating-name fixture), consultant detail/edit, seeker dashboard/saved/applications, `/billing`, receipt, `/admin`, `/admin/jobs` (+ `?q=<PostingID>` upper and lower case finds the job), `/admin/payments`, every active public job page, home, company page | PASS |

Screenshots (chromium headless, 1440 wide) in `shots/fix/`: `public-psw-decimal-salary.png` ($21.18 – $24.50/hour + Posting ID),
`public-closed-deadline.png` (closed state, Apply hidden), `portal-locked-edit-form.png` (lock icons on company/operating name/title/locations,
pay still editable), `portal-job-detail.png`. Viewed and checked.

## False positives found in my own script (fixed)

- "deadline = today still shows Applications closed": the text came from a **related-jobs card** (the closed Dispatch Coordinator is the same
  employer / category), not from the page's own apply card. Assertion now checks for `Apply now</a>` and the apply-card block.
- "draft is unlocked": returned one row per draft after re-runs; now a count.
- "operating name unchanged": the seed's new operating-name fixture makes `__legal` store the explicit legal name (existing rule), so the
  assertion compares before/after instead of expecting NULL.

## `scripts/smoke.js` — 343/346, whose are the 3 FAILs

| FAIL | Owner | Evidence |
|---|---|---|
| `R3 dates: on the deadline day itself Apply is still visible (200)` and `R3 dates: Apply visible again with a future deadline (200)` | **qa agent** (test scoping) | Re-activated the smoke's job #18 and fetched its page: the `/apply` link IS present (2 hits); the only "Applications closed" string is inside `<section class="section section--alt related">` — the "More jobs from Northern Lights Logistics" card for the seeded closed posting. The check `!/Applications closed/i.test(page)` needs to be scoped to the apply card / exclude `.job-card`. |
| `R3 layout: /admin/integrations/unlock (admin) has exactly one <h1> + page-head/app-head/hero band` | admin agent (view) | Layout class missing on that template; no route involvement. |

Two earlier smoke FAILs were mine and are fixed in `scripts/seed.js`: the 3-location fixture used unit `"Unit 4"` (smoke and `h.fullAddress`
both prefix "Unit "), now `"4"`; and the operating-name fixture the smoke expects (`Northern Lights Freight` on the AZ Truck Driver posting,
appended to the profile's `operating_names`) did not exist in any seed — added.

## Behaviour notes for the orchestrator

- `lib/job-dates.js` is NEW (fixes-agent). Dates are Toronto calendar days; `decorateJob()` turns the DATE column into a Date at 12:00 Toronto
  because node-pg parses DATE as server-local midnight (server TZ Asia/Kolkata) and `h.formatDate` would print the previous day.
- `published_at` edits store `<date> 12:00 America/Toronto`; blank = keep; only when the posting has been published; `> today` rejected; never
  touches `expires_at`/billing.
- `application_deadline` day itself is still open (`applications_closed` = deadline **<** today Toronto); `OPEN_WHERE` mirrors it in SQL.
- "Other platform link" is **https-only** (a bare domain gets `https://` prepended; `http://` is rejected with the client's wording).
- Company select stays frozen once billing exists even when not yet locked (`companyLocked`) — the previous rule, kept.
- A locked posting whose per-posting operating name is NULL keeps following the profile default (unchanged rule); the lock only freezes the column.
- Nothing was committed: the worktree is shared with six view agents; the orchestrator merges.
