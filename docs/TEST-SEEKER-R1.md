# Seeker + auth — client feedback round 1 test log (seeker-agent, 2026-09-09)

Instance: `PORT=3904`, DB `cc_seeker`, `NODE_ENV=development`, uploads `data/uploads/{resumes,covers}/`.
Artifacts in `shots/seeker-r1/`: `jars/` (curl cookie jars), `*.html` (captured responses), `server.log`, `match-test.js`,
`shoot.js` + `pages.json` (CDP screenshots at 390/1440 — engine borrowed from `scripts/cdp.js`), PNGs listed below.
Test users created: `riya-r1@example.com` (seeker, applied to job 3 with cover sheet), `bc-only-r1@example.com` (seeker,
provinces {BC}, category administration), `flyingpig-r1@example.com` (employer "Flying Pig Hospitality Inc." / "Flying Pig").
Test data inserted: `job_locations` row for job 3 (1500 Water St, Kelowna, BC, sort_order 1).

## What was built (files owned by the seeker agent)
- `routes/seeker.js` — multer now accepts `resume` + `cover_file` (memory, ≤5 MB each, MIME + extension + magic-byte sniff for both);
  cover sheet stored at `covers/<userId>-<rand>.<ext>` → `applications.cover_letter_path/_name`; `GET /jobseeker/applications/:id/cover`
  (own only, else 404); apply gate renders an in-page interstitial for guests (200) and a 403 message page for employers/consultants/admin;
  `publicJob`/dashboard/saved/applications queries carry `operating_name` + `location_count`; emails mention the cover sheet and use the operating name.
- `lib/matching.js` — province criteria now match ANY `job_locations` row (`IN_PROVINCES`), `location_count` in match rows, operating name in alert emails.
- `views/seeker/apply.ejs` (rewritten), `_jobcard.ejs` ("+N more locations", operating name + "Operated by"), `applications.ejs` ("Sent" column with
  resume + cover sheet download), `dashboard.ejs` (operating name). `public/css/seeker.css` (apply gate, upload boxes, sent list), `public/js/seeker.js`.
- `routes/auth.js` — `?next=` on `/login`, `/signup`, `/signup/:role` → `session.returnTo` (safe-path guard); employer signup collects
  `operating_name`, `street_address`, `postal_code` (validated `C.POSTAL_CODE_RE`, stored via `h.formatPostal`); pricing copy $14.99 employer / $9.99 consultant.
- `views/auth/signup-employer.ejs` (new fields), `signup.ejs` + `signup-consultant.ejs` (price text).

## Results (curl + cookie jars unless noted)

| Scenario | Result |
|---|---|
| Guest `GET /jobs/:slug/apply` | **200** (not 302) — interstitial "Create a free job seeker profile to apply — takes one minute"; buttons `/signup/seeker?next=%2Fjobs%2F…%2Fapply` and `/login?role=seeker&next=…` |
| Guest `POST …/apply` | 302 → `/login?next=/jobs/…/apply` |
| `GET /signup/seeker?next=…` → `POST /signup/seeker` | 302 → `/jobs/dispatch-coordinator-mississauga-3pvz/apply`; page shows "no resume yet" upload box |
| `GET /login?next=…` → `POST /login` | 302 → the apply page. `?next=//evil.com` → ignored, lands on dashboard |
| Apply with fresh resume + cover sheet (pdf) + typed note | 302 → applications; row `resume_path=resumes/6-…pdf`, `cover_letter_path=covers/6-000f4ca1c79c.pdf`, `cover_letter_name=cover.pdf`; file exists on disk (28 B) |
| `GET /jobseeker/applications/5/cover` as owner / as seeker2 | 200 `Content-Disposition: attachment; filename="cover.pdf"`, bytes identical / **404** |
| Applications page | "Sent" column lists `Resume: resume.pdf` + `Cover sheet: cover.pdf` (link); company shows operating name + "+1 more" |
| Bad cover file (text bytes named .pdf, sent as application/pdf) | **422** "That cover sheet does not look like a real PDF, DOC or DOCX…"; no row created |
| Oversize cover (6 MB) | 422 "Cover sheet must be 5 MB or smaller." |
| Unexpected file field | ignored (302, application created without cover) |
| Apply with profile resume (seeker@) | page says "Your profile resume **test-resume.pdf** will be attached automatically."; row `resume_path` = profile's (`auto_attached=t`), `cover_letter_path` NULL |
| Employer opens apply page | **403** with "Only job seeker accounts can apply" + back / dashboard buttons |
| Profile resume upload (regression after multer `.fields`) | 302, `seeker_profiles.resume_path` set; bad file → 422 |
| Matching, BC-only seeker vs job 3 (primary ON) | `matchesForSeeker` BEFORE insert: 0 · AFTER `job_locations(job 3, Kelowna BC)`: 1 (job 3, `location_count=2`); dashboard card shows "+1 more location"; `notifySeekersForJob(3)` notified 1 (this seeker) |
| Employer signup, postal `ZZZ` | 422 "Please enter a valid Canadian postal code (e.g. M5V 1A1)." |
| Employer signup, operating name + address, postal `m5h2m4` | 302 → dashboard; `employer_profiles` = Flying Pig Hospitality Inc. / Flying Pig / 88 Queen St W / Toronto / ON / **M5H 2M4** |
| Server log | 0 errors |

## Screenshots (CDP, `Emulation.setDeviceMetricsOverride`; all 16: no horizontal overflow, `scrollWidth == innerWidth`)
`apply-guest-{390,1440}.png` (interstitial), `apply-seeker-{390,1440}.png` (auto-attach + cover upload; `apply-seeker-tall-390.png` = 2700px viewport
so the sticky submit bar does not sit mid-page in the capture), `apply-noresume-390/1440.png`, `apply-role-390/1440.png` (403 message),
`applications-390/1440.png`, `dashboard-390/1440.png` ("+1 more location" card), `signup-employer-390/1440.png`, `signup-390/1440.png`.

## Known gaps / notes
- Sticky "Send application" bar on phones is a viewport-bottom bar (as before); in full-page captures it appears mid-page — not a layout bug.
- `removeFile` only prunes `resumes/`; cover sheets are never deleted (an application row always references them; withdraw deletes the row but leaves the file).
- Employer address fields at signup are optional (postal validated when given) — the client note says the profile address is the *default* work location, so I did not make it mandatory at account creation.
