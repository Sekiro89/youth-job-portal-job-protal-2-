# Portal — client round 2 test (PDF + WhatsApp feedback, 2026-09-10)

Instance: port **3903**, DB `cc_portal`, `NODE_ENV=development` on the command line.

```bash
PW=$(grep '^DB_PASSWORD=' docs/.dbpw | cut -d= -f2-)        # .dbpw now has TWO lines (DB_PASSWORD, ADMIN_PASSCODE) — `cut` on the whole file glues both values and auth fails
ENC=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PW")
NODE_ENV=development DATABASE_URL="postgres://canada_careers:$ENC@127.0.0.1:5432/cc_portal" PORT=3903 PUBLIC_URL=http://localhost:3903 node server.js
bash shots/portal-r2/flow.sh      # 132 curl + psql assertions (cookie jars, dev-login), idempotent (resets its own "R2 …" fixtures)
node shots/portal-r2/shots.js     # 13 pages × 390/1440 via CDP → shots/portal-r2/*.png; overflow + JS-error + touch-target audit; browser-side check of the consultant company switch
```

Result (last run 2026-09-10): **flow 132/132 pass**, **shots 26/26 pass** (scrollWidth == innerWidth on every 390 page, zero JS exceptions).
Every PNG was opened and looked at; 390 shots are sliced into `shots/portal-r2/crops/` (1500px strips) for review.

## What was built (files: routes/portal.js, views/portal/*, views/portal/partials/location-fields.ejs (new), public/css/portal.css, public/js/portal.js)

### Company profile forms — `/employer/profile`, `/consultant/profiles/new`, `/consultant/profiles/:id/edit`
| Field / route | Behaviour |
|---|---|
| `industry` `<select>` of `C.INDUSTRIES` | **Required on save** (422 "Choose the company’s industry."). Unknown key → 422. A legacy free-text value (e.g. profile 2 "Healthcare") renders as a disabled, selected `Current: Healthcare — choose from the list` option; a disabled option is not submitted, so the user must pick a sector before the form saves. |
| `operating_names[]` (repeatable) | First = default → also written to `employer_profiles.operating_name`. Blanks dropped, case-insensitive duplicates collapsed, max 10, each ≤120. No-JS: 3 inputs; JS: spares removed, "+ Add another name" / "Remove" (never below one). Legacy single `operating_name` field is still accepted. |
| Create mode (`consultant-new`, `employer-create`) | Inline **Main location** block (`loc_label`, `loc_street_address`, `loc_unit`, `loc_city`, `loc_province`, `loc_postal_code`) — optional, but if anything is typed the address must be complete (`C.POSTAL_CODE_RE`, stored via `h.formatPostal`). Saved as the profile's default `employer_locations` row (label defaults to "Main location") inside the create transaction. |
| Edit mode | The old free-text address fields are **gone**; `employer_profiles.street_address/city/province/postal_code` are never taken from the form — `syncProfileAddress()` mirrors the DEFAULT location after every address-book change. |

### Address book (section `#locations` on the edit forms; separate forms, save on their own)
Routes (employer prefix `/employer/profile/locations…` maps to the single profile; consultant `/consultant/profiles/:id/locations…`, owner-checked, 404 otherwise):
- `POST …/locations` — fields `loc_label` (optional ≤80), `loc_street_address` (≥3), `loc_unit`, `loc_city` (≥2), `loc_province` (code), `loc_postal_code` (validated + formatted), `make_default=1` (optional). First location of a profile is always the default. 422 re-renders the profile form with the editor open and per-field errors `err-loc-<field>`.
- `POST …/locations/:lid` — edit (same fields); a changed address clears lat/lng/place_id so it is re-geocoded.
- `POST …/locations/:lid/archive` — soft delete; job snapshots keep their address; archiving the default promotes the oldest remaining active row.
- `POST …/locations/:lid/default` — one default per profile; profile address columns follow.
- `GET <profile form>?loc=<lid>` opens that row in the editor (no-JS edit mode); `#loc-editor` anchor.
- After every insert/edit: `require('../lib/geocode').geocodeEmployerLocation(id)` (lazy, try/catch, promise rejection swallowed). The maps agent's module landed during this round and geocoded the test rows ("Map pin ready" shows on rows with `lat`).

### Job form — `/employer|consultant/jobs/new`, `/jobs/:id/edit`
| Field | Behaviour |
|---|---|
| `location_ids[]` (checkboxes) | The selected profile's active `employer_locations` (label + full address + Default badge). Default pre-ticked on new. Ids of other profiles are ignored server-side. Consultant: one `.loc-choice[data-profile=<pid>]` list per company is rendered; JS shows the one matching `#employer_profile_id` (server pre-hides the others when a company is selected). |
| `new_loc_label/street_address/unit/city/province/postal_code` | Inline "Add a new location" `<details>`; blank = ignored; partial = 422 (`err-new-loc-<field>` + section error); complete = inserted into `employer_locations` for that profile **and** selected (becomes the default only if the profile had none). Identical to an existing row (case/space-insensitive key) → that row is selected instead of duplicated. |
| `keep_job_locations[]` (edit only) | Pre-R2 snapshot rows that match no address-book row (by id or address key) are offered as "Saved on this posting" checkboxes, pre-ticked; matched ones tick the address-book row instead. |
| Validation | none selected/kept/new → **422 "Select at least one work location."**; max 20. |
| Save | `job_locations` delete+insert inside the job transaction: `employer_location_id`, street/unit/city/province/postal, `lat/lng/geocoded_at/place_id` copied when present, `sort_order` = list order with the **default first**, kept legacy rows last. `jobs.city/province/postal_code` = first row. |
| `operating_name_choice_<pid>` | `__legal` (Legal name — X) · one of the profile's `operating_names` (first marked "(default)") · `__new` + `operating_name_new_<pid>` (≥2 chars, appended to the profile's `operating_names`, sets `operating_name` if it was empty). Result → `jobs.operating_name`: the chosen name; `__legal` stores the legal name when the profile has operating names (so it beats the profile default) or NULL when it has none. A name since removed from the profile stays selectable on that posting as "(current)". Name not in the list → 422. |
| `education` / `experience_level` | `C.EDUCATION_LEVELS` / `C.EXPERIENCE_LEVELS` (Job Bank lists) + `education_other` / `experience_other` (required when `other`). Legacy keys posted or stored map through `C.EDUCATION_LEGACY` / `C.EXPERIENCE_LEGACY` (so `certificate` pre-selects College/CEGEP, `entry` → 1–2 years); unknown free-text education opens as Other + text. |
| `hours_amount` (0.5–168, step .5, optional) + `hours_period` (`C.HOURS_PERIODS`, default `week`) | Stored as numeric(6,2) + period; period NULL when no amount. Shown via `h.formatHours` → "35 hours per week", "37.5 hours bi-weekly". 200 → 422. |
| `apply_email` | Label "Application email (the employer’s inbox)", hint "Applicants also land in your dashboard." Default = selected profile's `contact_email` (owner login only when the profile has none; blank until a consultant picks a company). Options carry `data-contact-email`; JS replaces the value on company change unless the user edited it. |

### Display
- Every list/detail query exposes `coalesce(j.operating_name, p.operating_name) AS operating_name` → `h.displayCompany(job)` / `h.legalNameNote(job)` show the posting's own name first (dashboard, jobs list, job detail header + preview + facts, applicants, applicant e-mails, company picker). `loadJob` also exposes the raw column as `job_operating_name`.
- Job detail facts: Company (+ "Operated by"), Industry (`h.industryName`), Work locations (full addresses, default first), Hours; preview meta shows hours. Jobs list: "+N more" + hours; dashboard: industry on the company line, hours on posting rows; consultant companies list: industry name + "Also operates as …".
- Duplicate copies `operating_name`, `hours_amount`, `hours_period` and every snapshot row (keeping `employer_location_id`).

## Bugs found while testing
- **Profile create lost the location label**: `Object.assign({label:'Main location'}, first)` let an empty `first.label` overwrite the default → NULL label. Fixed (assign order).
- `GET /jobs/new` handler referenced `next` without declaring it → 500 on every new-job page. Fixed.
- `docs/.dbpw` gained a second line (`ADMIN_PASSCODE=…`) since round 1; the round-1 `PW=$(cut -d= -f2 docs/.dbpw)` now yields two lines and the instance cannot authenticate (psql only worked because of `~/.pgpass`). Use the `grep '^DB_PASSWORD='` form above. `shots/portal-r1/flow.sh` still has the old line.
- Names row: the "DEFAULT" note overlapped the Remove button on the first operating-name row (CSS sibling selector in the wrong direction) — seen in `profile-1440.png`, fixed with a 3-column grid.

## Notes / traps
- The consultant form renders **every** company's location list and operating-name select (`data-profile`) so a no-JS user still gets a usable form; ids from a non-selected company are filtered out server-side, and JS unticks hidden lists on submit.
- `h.fullAddress` prefixes the unit with "Unit " — entering "Suite 5" as the unit prints "Unit Suite 5" (helper is the orchestrator's; data-entry hint may be worth adding).
- Full-page 1440 captures show the sticky save bar mid-page; it sits at the viewport bottom in a real browser.
- Do not `pkill -f PORT=3903` in the agent shell; kill by pid from `ss -ltnp`.
- flow.sh rewrites job 15's snapshot rows and profiles 1/2's industry/operating names on every run (its own fixtures); everything else it creates is prefixed "R2 ".
