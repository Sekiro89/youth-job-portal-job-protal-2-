# Public pages — client round 1 (2026-09-09) test notes

Scope: `routes/public.js`, `views/public/{job,jobs,company,_job-card}.ejs`, `public/css/public.css`, `public/css/print.css` (new).
Instance: db `cc_public`, port 3901, `NODE_ENV=development` (`PW=$(cut -d= -f2 docs/.dbpw); NODE_ENV=development DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/cc_public" PORT=3901 PUBLIC_URL=http://localhost:3901 node server.js`).

## Fixtures added to cc_public (my DB only; idempotent)
```sql
INSERT INTO job_locations(job_id, street_address, unit, city, province, postal_code, sort_order) VALUES
  (6, '4720 Kingsway', '2600', 'Burnaby', 'BC', 'V5H 4N2', 1), (6, '13450 102 Ave', NULL, 'Surrey', 'BC', 'V3T 5X3', 2);
UPDATE jobs SET salary_period='biweekly', salary_min=2600, salary_max=3100 WHERE id=3;                       -- bi-weekly salary
UPDATE jobs SET education='other', education_other='Class AZ licence with air brake (Z) endorsement' WHERE id=2; -- education = other
UPDATE jobs SET education='bachelor' WHERE id=4;
UPDATE jobs SET source='jobbank', source_id='45123456', source_url='https://www.jobbank.gc.ca/jobsearch/jobposting/45123456' WHERE id=5; -- reference posting
```
Seed already has `operating_name` on profiles 1 (Northern Lights Freight) and 3 (MapleByte); profile 2 has none (legal name only path).
Seed rows for jobs 2/5/8/12 have no street/postal (imported-style) — they render as "City, PR".

## What was checked (2026-09-09, all pass)
Script: fetch + regex + `JSON.parse` of every `application/ld+json` block (see report). Results:
- `/jobs/full-stack-developer-node-react-vancouver-hyhg` (3 locations): H1 line "MapleByte · Vancouver, BC +2 more locations", "Operated by Maple Byte Software" under it,
  "Work locations (3)" block with `1055 W Hastings St, Vancouver, BC V6E 2E9 (primary)`, `4720 Kingsway, Unit 2600, Burnaby, BC V5H 4N2`, `13450 102 Ave, Surrey, BC V3T 5X3`;
  facts sidebar has Operating name / Legal name rows; JSON-LD `hiringOrganization {name: MapleByte, legalName: Maple Byte Software}`, `jobLocation` = array of 3 `Place` with full `PostalAddress` (streetAddress incl. "Unit 2600", postalCode, addressCountry CA).
- Job 3 (bi-weekly): page shows "$2,600 – $3,100 bi-weekly"; JSON-LD `baseSalary.value {unitText: WEEK, minValue: 1300, maxValue: 1550}` (halved). hour→HOUR, year→YEAR verified on jobs 1/6.
- Job 2 (education = other): "Other (specify): Class AZ licence with air brake (Z) endorsement" on page and in `educationRequirements`; job 4 shows "Bachelor's degree". Work location without street renders "Brampton, ON"; JSON-LD address has no streetAddress/postalCode.
- Job 5 (reference): badge + attribution box + Job-ID note all read "Reference posting from Job Bank (Government of Canada) — not posted on Canada Careers"; "Apply on Job Bank" CTA kept (sidebar, attribution, mobile bar); JSON-LD `directApply:false`, `url` = source.
- Search: `/jobs?city=Surrey` → 1 (job 6, primary city Vancouver); `?city=Burnaby` → 2 (job 6 + job 8); `?q=Surrey` → 1; `?q=MapleByte` (operating name) → 3. Count header and list agree.
  `?sort=salary` orders annualised: full-stack 140k, RN 96k, AZ driver 82k, dispatch (3100×26=80.6k), QA 28/h=58k, CSS 55k, PSW 25/h=52k, warehouse 22/h=45.8k. `?salary_min=60000` → 4 (incl. the bi-weekly job).
- Cards: operating name shown; "+2 more locations" on job 6; reference line on job 5.
- `/companies/maple-byte-software`: H1 "MapleByte", "Operated by Maple Byte Software (legal name)", address `1055 W Hastings St, Vancouver, BC V6E 2E9` in head + facts; Organization JSON-LD has `legalName` + full `PostalAddress`. `/companies/prairie-health-group` (no operating name): plain legal name, no "Operated by".
- `/sitemap.xml` 200, 20 URLs (unchanged logic).

## Print
`chromium --headless=new --no-sandbox --no-pdf-header-footer --print-to-pdf=shots/public-r1/job-print.pdf <job 6 url>` → 2 pages (`pdftoppm -png -r 70`): `shots/public-r1/job-print-p1-1.png` (title, operating + legal name, dates line, addresses, description, requirements, benefits, skills, about) and `job-print-p2-2.png` ("How to apply" box, 2-column details incl. Operating/Legal name, footer "Printed from localhost:3901/jobs/<slug> on September 9, 2026"). Nav, footer, buttons, share, related jobs, apply bar hidden. The `<link media="print">` is emitted from `job.ejs` because `layout.ejs` renders `extraCss` without a media attribute; the file is also wrapped in `@media print`.

## Screenshots (`shots/public-r1/`)
`job-1440.png`, `job-768.png`, `company-1440.png`, `jobs-768.png` (chromium `--screenshot`); `job-390.png`, `job-ref-390.png`, `jobs-390.png`, `company-390.png` via CDP `Emulation.setDeviceMetricsOverride` (scripts/cdp.js helper, read-only). All four 390 pages: `scrollWidth == innerWidth == 390`, no element past the right edge. Address lines wrap inside their boxes.

## Re-run
`node <scratch>/check.js` was ad hoc; the equivalent quick checks: `curl -s localhost:3901/jobs/<slug> | grep -c 'Work locations (3)'`, `curl -s 'localhost:3901/jobs?city=Surrey' | grep -o '[0-9]* jobs* found'`.
