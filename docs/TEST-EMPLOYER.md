# Employer end-to-end test (T1) — 2026-09-09

Instance: port 3911, DB `cc_t1`, uploads `data/uploads/t1/`. Harness: `shots/t1/t1-flow.js` (63 HTTP/DB steps, cookie jars,
real multipart uploads, `pg` assertions) and `shots/t1/t1-shots.js` (CDP, 24 pages × 390/768/1024/1440 = 96 PNGs in `shots/t1/`,
overflow + touch-target + console checks). Re-run: start the instance (see the brief), then
`node shots/t1/t1-flow.js` and `node shots/t1/t1-shots.js` (reads `shots/t1/last-run.json` written by the flow).

Result at the end of the pass: **63/63 flow steps pass except the one that depends on a public-agent bug (company page logo)**;
**96/96 captures with no horizontal overflow**; every PNG in the list below was opened and looked at.

## Scenario → result → bug → fix → verified

| # | Scenario | Result | Bug found | Fix (file) | Verified how |
|---|----------|--------|-----------|------------|--------------|
| 1 | Signup → dashboard → profile edit → PNG/SVG/oversize/wrong-type logo → public company page | PASS (logo on public page: see outside-bug A) | A file of the wrong type submitted **without JS** (no `logo_present=1` marker) was silently ignored and the form said "saved" | `routes/portal.js` multer `fileFilter` now sets `req.logoRejected`; error shown regardless of the marker | flow S1 "wrong type WITHOUT logo_present → 422" |
| 1 | SVG logo containing `<script>` | PASS — served with `Content-Security-Policy: default-src 'none'`, old file deleted on replace | — | — | flow S1 SVG step + the T1 logo renders in `e-profile-390.png` / `e-job-active-390.png` |
| 2 | 5 varied jobs (hourly/yearly, remote/hybrid/on-site, French + Other language, all audiences, `<script>`, quotes, emoji, 11.5k chars) | PASS — escaped on cards, detail, JSON-LD (parsed + no raw `<script>`), dashboards, mail_outbox | 20 000-char description was silently cut to 12 000 with no hint | `views/portal/job-form.ejs` `maxlength="12000"` + "n / 12,000 characters" counter; requirements/benefits/company description got their maxlengths too | flow S2 20k steps |
| 2 | Validation: max<min, 1-char title, bad province, negative vacancies, missing fields, bad salary/postal/NOC/url/email, languages | PASS — 422, friendly per-field messages, input kept | — | — | flow S2 validation steps |
| 2 | Duplicate submit (two POSTs in the same instant) | **FAIL → fixed** | Two identical drafts were created | `routes/portal.js` create runs in a tx under `pg_advisory_xact_lock(7001, user_id)` and reuses an identical draft < 20 s old; `public/js/portal.js` disables submit buttons after the first click on every portal POST form | flow S2 "double POST creates ONE draft" |
| 3 | Publish → checkout ($9.99/$10.49 shown) → sandbox 4242 → active → public 200 → edit while active → pause → reactivate → duplicate → cancel at period end → resume → cancel now → 404 + Archived tab + sitemap drop → delete draft | PASS | Edit of a live job with a tampered `employer_profile_id` produced a confusing "Create your company profile first" 422 | `routes/portal.js` `validateJob`: employers' posted profile id is never trusted (always their one profile); jobs with billing history are locked to their profile before validation | flow S3 edit + S5 tamper steps |
| 3 | Slug decision: **slug never changes on edit** (title changed, public URL stayed) | PASS | — | — | flow S3 "edit while active" |
| 3 | Refusals: pause/publish/reactivate on a cancelled job | PASS — flash, no state change | — | — | flow S3 |
| 4 | Seeker applies to two jobs → applicants list → each status → notes → resume download → all-applicants filters → seeker notification + email | PASS | `POST …/status` returned to the referer; with the site's `Referrer-Policy` the browser sends none, so the filtered "All applicants" view was lost every save | `views/portal/applicants.ejs` hidden `return_to` (+ `returnTo` local in `routes/portal.js`), validated to `/employer|/consultant` paths only (open-redirect test included) | flow S4b |
| 5 | Other employer on my job (view/edit/pause/applicants/duplicate/delete/publish/reactivate) and my applicant's resume/status; consultant on `/employer/*`; employer on `/consultant/profiles`; seeker/guest; cross-site POST; owner-only logo | PASS — 404 everywhere, no data, 403 cross-site | — | — | flow S5 |
| 5 | Tampered `employer_profile_id` (employer new/edit, consultant with a profile it does not own) | PASS after fix — ignored for employers, 422 "Choose which company" for consultants | see row 3 | | flow S5 |
| 6 | Responsive 390/768/1024/1440, every portal page (+ both landings, public job) | PASS — 96/96, no overflow | (a) `<td class="td-actions">` was `display:flex` → row borders broke on the Jobs table and consultant "By company" table; (b) `.kds-btn--sm` = 36 px on touch; (c) sticky save bar was 3 stacked rows (~180 px) on phones; (d) an 11k-char preview pushed Subscription/Timeline ~9000 px down on phones; (e) applicant status form overflowed its card on phones (column flex + px flex-basis wrapped the select into a 2nd column); (f) status tabs hid "Drafts/Archived" off-screen on phones | `views/portal/jobs.ejs`, `dashboard.ejs` (inner `<div class="td-actions">`), `public/css/portal.css` (44 px small buttons on `(hover:none)`/<768, one-row sticky bar with short labels via `.lbl-short` in `job-form.ejs`, aside first below 1024, `prose--clamp` + "Show full description" toggle in `job.ejs`/`portal.js`, status-form nowrap + full width, tabs wrap) | re-captured and inspected `e-jobs-1440`, `e-job-new-390`, `e-job-new-errors-390`, `e-job-active-390`, `e-applicants-390`, `c-dashboard-390`, `c-profiles-390`, `e-profile-390`, `e-dashboard-390`, `landing-employer-390` |
| 7 | Copy read-through as the client | PASS with fixes | (a) Jobs list said "Expires / renews Oct 9" on a **cancelled** job; (b) paused jobs were badged "Inactive" while every sentence says "paused"; (c) archived footnote told users to "duplicate" with no button | `views/portal/jobs.ejs` column "Renews / ended" with "Cancelled/Expired/Paused <date>", a **Repost** button on expired/cancelled rows, rewritten footnote; `partials/status-badge.ejs` + `job.ejs` timeline show "Paused" (warning colour) | `e-jobs-1440.png` |
| 7 | Pricing text | PASS — landing, form, job detail, dashboard empty state all say $9.99 + GST = $10.49/month, renews monthly, cancel any time | — | — | read + `landing-employer-390.png` |

## Bugs OUTSIDE my files (repro + location) — not fixed here

- **P0 (already picked up by the orchestrator in commit 17405e1): every browser form POST was rejected with 403 "Cross-site request blocked".**
  helmet 8's default `Referrer-Policy: no-referrer` makes Chrome/Firefox send `Origin: null` on same-origin form posts (Fetch spec
  §"append a request Origin header"); `lib/auth.js` `sameOriginGuard` then fails `new URL('null')`. Repro: `node shots/t1/t1-origin-repro.js`
  (real headless Chrome clicks "Save draft" → 403). Proof of fix: `shots/t1/t1-helmet-fix-wrapper.js` (same server.js with
  `referrerPolicy: { policy: 'strict-origin-when-cross-origin' }`) → `Origin: http://localhost:3912`, 422 re-render as expected.
  smoke.js never saw it because it sends its own `Origin` header.
- **Public company page ignores the logo** — `views/public/company.ejs:5` always renders the initial-letter placeholder; `routes/public.js:265`
  selects `logo_path` but the template never uses `/logos/<id>`. Repro: upload a logo at `/employer/profile`, open `/companies/<slug>`.
  (Public job page `views/public/job.ejs` has no company logo either.)
- **Uploaded resume filenames are mojibake** — `routes/seeker.js:76` stores `file.originalname` raw; busboy decodes the filename
  as latin1, so "Aisha Khan — CV.pdf" is stored/displayed/downloaded as "Aisha Khan â€” CV.pdf" (visible in `e-applicants-390.png`).
  Fix: `Buffer.from(file.originalname, 'latin1').toString('utf8')` or multer `{ defParamCharset: 'utf8' }` (same risk for any other multer user).

## Notes / traps

- The agents' shared scratchpad is one directory: my `run.sh` was overwritten by another agent's (it started *their* servers when I
  ran it). Use uniquely named scripts (`t1-run-3911.sh`) — copies of everything I used are in `shots/t1/`.
- A logged-in page that 500s renders "Something went wrong" with HTTP 200 for the CDP driver's purposes — always check the title.
