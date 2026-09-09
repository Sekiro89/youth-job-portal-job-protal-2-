# Portal — client round 1 test (2026-09-09)

Instance: port **3903**, DB `cc_portal`, `NODE_ENV=development` on the command line, default `UPLOAD_DIR` (`data/uploads`;
the seed resume lives in `data/uploads/seed/`, test cover sheet in `data/uploads/covers/portal-r1-test.pdf`).

```bash
PW=$(cut -d= -f2 docs/.dbpw); NODE_ENV=development DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/cc_portal" PORT=3903 PUBLIC_URL=http://localhost:3903 node server.js
bash shots/portal-r1/flow.sh      # 76 curl + psql assertions (cookie jars, dev-login), re-runnable
node shots/portal-r1/shots.js     # 9 pages × 390/1440 via CDP → shots/portal-r1/*.png, overflow + JS-error + touch-target audit
```

Result (last run 2026-09-09): **flow 76/76 pass**, **shots 18/18 pass** (no horizontal overflow, no JS exceptions). Every PNG in
`shots/portal-r1/` was opened and looked at (390 shots are cropped into `crops/` for review).

## What was built (files: routes/portal.js, views/portal/*, public/css/portal.css, public/js/portal.js)

| # | Feature | Where | Verified by |
|---|---------|-------|-------------|
| 1a | Work locations: repeatable address block (street, unit, city, province, postal). Server renders 3 blocks (no-JS fallback; blank spares ignored); JS drops untouched spares, "Add another location" clones a block (max 20), "Remove" never below one. First block pre-filled from the profile's street/city/province/postal on a new job. Fields post as parallel arrays `loc_street_address[]` … | `job-form.ejs`, `portal.js`, `parseLocations/validateJob/saveLocations` in `routes/portal.js` | flow §1–7, shots `job-new-*`, `job-edit-2-locations-*` |
| 1a | Validation: ≥1 complete location; every non-blank block needs street ≥3, city, province, valid postal (`C.POSTAL_CODE_RE`, stored via `h.formatPostal`); duplicate addresses (case/space-insensitive) rejected on the later block; per-field errors `err-loc_<i>_<field>` + section error `err-locations`; input preserved | | flow §3, §5 (`job-new-errors-*.png`) |
| 1a | Save: `job_locations` delete+insert inside the job's transaction with `sort_order`; `jobs.city/province/postal_code` = first location | | flow §2, §6 |
| 1b | Education `<select>` from `C.EDUCATION_LEVELS` + `education_other` (required when `other`; JS shows it only for `other`, always visible without JS). Legacy free-text education on old rows opens as Other + text on edit and displays raw on detail | | flow §4, §8 |
| 1c | Experience `other` → `experience_other` (same pattern) | | flow §2, §6 |
| 1d | Salary period select = `C.SALARY_PERIODS`; unknown → `year` | | flow §2 (`hour` stored, `$25 – $28/hour` shown) |
| 2 | Profile forms (employer + consultant new/edit): `operating_name` (hint "e.g. Flying Pig — the name job seekers know you by"), `street_address`, `postal_code` (validated/formatted); "Business address" section explains it seeds the first work location | `profile-form.ejs`, `validateProfile/upsertProfile` | flow §10, `profile-*.png` |
| 2 | Operating name shown via `h.displayCompany` + `h.legalNameNote` on dashboard, jobs list, company picker chips, consultant profiles list (with full address), applicants, job-form company select | `dashboard.ejs`, `jobs.ejs`, `profiles.ejs`, `partials/company-picker.ejs`, `applicants.ejs` | flow §9, §10 |
| 3 | Owner job detail: operating name + "Operated by <legal>", "Work location(s)" list of `h.fullAddress` (city/province only for street-less rows), Pay via `h.formatSalary`, Experience/Education labels incl. `_other` text, "+N more" in the header/preview | `job.ejs` | flow §2, `job-detail-*.png` |
| 4 | `GET <base>/applications/:id/cover` — owner-only `res.download` of `applications.cover_letter_path`, 404 when none / not owner / file missing; marks viewed like the resume route. "⬇ Cover sheet" button next to "⬇ Resume" (or "No cover sheet") on both applicants pages | `routes/portal.js`, `applicants.ejs` | flow §11, `applicants-*.png` |
| 5 | Duplicate copies all locations + `education_other/experience_other` (in a transaction) | `routes/portal.js` | flow §7 |
| 5 | Job Bank reference postings: none owned by portal users (no code path changed) | | flow §12 |
| — | Pricing per PAYER role: `pricingFor(req.user.role)` → PRICE/GST/TOTAL locals (employer $14.99/$15.74, consultant $9.99/$10.49). `C.PRICING.price_cents` no longer exists, so the old constant was `NaN` on every portal page — fixed. Landing routes pass the role's numbers and the FAQ copy in `routes/portal.js` now says $14.99 (employer) / $9.99 (consultant) | `routes/portal.js` | flow §1, §9 |
| — | Applicant status e-mails/notifications use the operating name | `routes/portal.js` | code |

## Bugs found while testing

- `routes/portal.js` read `C.PRICING.price_cents` (removed by the schema/constants commit) → PRICE/TOTAL were `NaN` on every
  portal page and both landings. Fixed with `pricingFor(role)`.
- cc_portal seed profile 1 pointed at `logos/1-a218cefc.svg` which no longer exists on disk (broken image on profile/preview).
  Data-only; nulled in cc_portal. Other agents' DBs may have the same stale path (seed writes logos once; a test deleted the file).

## Notes / traps

- `express.urlencoded({ extended: true })` (qs) turns more than 20 `loc_*[]` entries into an object — `parseLocations` handles both
  shapes and caps at `MAX_LOCATIONS = 20`.
- The sticky save bar appears mid-page in full-page captures (`*-1440.png`); it is at the viewport bottom in a real browser.
- Do not `pkill -f PORT=3903` in the agent shell — the pattern matches the shell itself (exit 144). Kill by pid from `ss -ltnp`.
