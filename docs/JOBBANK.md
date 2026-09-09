# Job Bank importer

Brings **real, current postings from Job Bank** (jobbank.gc.ca — Employment and Social Development Canada's public job
board) into Canada Careers so the portal launches with genuine content.

> **`jobs.source = 'jobbank'` rows are reference postings — not the client's, no payment, link back only.**
> They were never posted on Canada Careers, carry no subscription/payment rows, can't be applied to here (the CTA goes
> to Job Bank), and are labelled "Reference posting from Job Bank (Government of Canada) — not posted on Canada
> Careers". If the client wants them gone: `node scripts/import-jobbank.js --purge` (see [Purge](#purge--kill-switch)).

Files: `lib/jobbank.js` (fetch + parse + upsert), `scripts/import-jobbank.js` (CLI), `jobs/jobbank-sync.js`
(daily `syncJobBank()`), `views/public/job.ejs` + `views/public/_job-card.ejs` (attribution UI),
`data/jobbank-cache/` (raw HTML cache, gitignored). Schema: the `source*` columns on `jobs` and `source` on
`employer_profiles`, the `job_locations` table, `jobs.education_other` / `experience_other` / `hours_amount` /
`hours_period`, `employer_profiles.operating_name` / `industry` (bottom of `db/schema.sql`).

**2026-09-10 (client PDF round):** education and experience now map to the NEW Job Bank vocabularies in
`lib/constants.js` (`EDUCATION_LEVELS`, `EXPERIENCE_LEVELS`), work hours are parsed into `hours_amount` + `hours_period`,
and the employer's **industry sector** is read from the employer's Job Bank profile page into `employer_profiles.industry`
(a `C.INDUSTRIES` key). The `jobbank_sync` kill switch is a runtime setting (`lib/settings`) shared with the admin panel.

## Sources used (verified 2026-09-09)

| What | URL | Notes |
|---|---|---|
| Search feed (**primary**) | `https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed?searchstring=<kw>&fprov=<XX>&sort=D&rows=100` | Atom, ~10–50 KB. One `<entry>` per posting: title, link (`/jobsearch/jobposting/<id>`), `<updated>`, summary with Job number / Location "City (XX)" / Employer / Salary text. `fprov` (2-letter province) is the only location filter the feed honours — `locationstring` is ignored. `rows` caps at 100. The `jobsearchfeed` URL from older docs 404s; the live one is linked from the "Subscribe" button on every search page. |
| Search HTML (fallback) | `https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=<kw>&fprov=<XX>&sort=D` | ~300 KB, 25 results/page, `article#article-<id> > a.resultJobItem` with `span.noctitle`, `li.date`, `li.business`, `li.location`, `li.salary`. `parseSearchHtml()` covers it; not used by default because the feed is 10× cheaper. |
| Posting detail | `https://www.jobbank.gc.ca/jobsearch/jobposting/<id>` | ~190 KB. RDFa: `property="title|datePosted|hiringOrganization/name|addressLocality|addressRegion|postalCode|baseSalary(minValue,maxValue,unitText)|employmentType|workHours|validThrough"`, NOC in `span.aa_jobbank_job_noccode`. **Native** postings have structured `div.job-posting-detail-requirements` blocks (`h3/h4`: Overview → Languages/Education/Experience/On site; Responsibilities → Tasks; Experience and specialization; Additional information; Benefits; Employment groups with `<details><summary>Support for …</summary>`), plus "Who can apply for this job?". **Partner** postings (Indeed, Jobillico, Workopolis, …) carry one HTML blob in `span[property=description]` and an `#externalJobLink`. The "Show how to apply" POST is **not** used — we link to the posting instead. |
| Expired posting | HTTP **410** + redirect to `/jobsearch/jobpostingexpired` | This is the "gone" signal used by the daily sync. |
| Employer profile (**industry**) | `https://www.jobbank.gc.ca/jobsearch/empprofile/<posting id>` | ~150 KB. Linked (as `/jobsearch/empprofile/<id>;jsessionid=…`, the posting's own id) from native postings whose employer has a Job Bank profile — 69 of 296 cached postings. `h1 span.name` = employer, `span.industry-sector > span.value` = **"Industrial sector: Construction"** (NAICS sector, the same vocabulary as `C.INDUSTRIES`), `span.website a`, business size, workplace amenities, "Support for …" groups. `parseEmployerPage()` reads sector/website/size. Fetched **once per employer** (cache key `empprofile-<id>`, 30 days), only when the profile has no industry yet; `--no-employer-pages` skips it. |

### robots.txt

`https://www.jobbank.gc.ca/robots.txt` (fetched 2026-09-09) is, in full:

```
User-agent: *
Crawl-delay: 5
```

No paths are disallowed; the site asks for **5 seconds between requests**. The importer honours that by default
(`JOBBANK_DELAY_MS`, minimum 1000 — never go below the brief's 1 req/s), serialises every request through one
throttle, retries 429/5xx/network errors 3× with growing backoff, sends
`User-Agent: CanadaCareersBot/1.0 (+https://jobs.khosha.tech/about)` and caches every response on disk so re-runs and
dry-runs cost nothing (feeds 6 h, detail pages 7 days for import / 20 h for the sync re-check).

## Attribution approach — and why

Job Bank content is published by the Government of Canada for the public to find work. We republish it as a
convenience, not as our own inventory, so every imported posting:

- is stored with `source='jobbank'`, `source_id`, `source_url` (the canonical Job Bank URL), `source_employer`,
  `source_synced_at` — a `NULL` source means "posted on Canada Careers";
- shows a **"Source: Job Bank"** badge on the card and the detail header, an attribution box ("This posting was
  published on Job Bank (Government of Canada) … Apply on Job Bank →") and a Source row in the facts panel;
- makes the **primary CTA "Apply on Job Bank ↗"** (`target=_blank rel="nofollow noopener"` to `source_url`) — the
  internal `/jobs/:slug/apply` route is not offered for imported postings (native postings keep it);
- has JobPosting JSON-LD with `directApply: false` and `url` = the Job Bank posting, so search engines credit the
  original and never treat us as the application endpoint;
- costs nothing and has **no subscription/payment rows** — the importer never touches `subscriptions`/`payments`;
  it only writes `users` (one system account), `employer_profiles` and `jobs`;
- is owned by a single inactive system user (`jobbank-import@canadacareers.local`, role `consultant`,
  `is_active=false`, unusable password hash) so nothing in the portal can log in as it or edit these rows;
- is removed from public view (`status='expired'`, archived) as soon as Job Bank reports it gone or its
  `validThrough` passes — we never keep a posting live longer than the source does.

## Data mapping

| Canada Careers | Job Bank | Rule |
|---|---|---|
| `users` (1 row) | — | `jobbank-import@canadacareers.local`, name "Job Bank (Government of Canada)", role consultant, `is_active=false`. |
| `employer_profiles` (1 per employer) | hiringOrganization name | `source='jobbank'`, slug via `uniqueProfileSlug`, city/province from the first posting seen, description "Employer listed on Job Bank, the Government of Canada's job board." Matched case-insensitively on `company_name`. **Operating name:** Job Bank prints one string; when it is "`<Legal> o/a <Trade>`" (also `operating as`, `dba`/`d.b.a.`/`d/b/a`, `c.o.b.`, `trading as`, `t/a`) `splitEmployerName()` stores `company_name` = legal part and `operating_name` = trade part (`h.displayCompany` shows the trade name first). `street_address`/`postal_code` on the profile = the first posting's street/postal when Job Bank printed one. Re-mapped on every refresh, so profiles created before this existed get their names split too. `jobs.source_employer` keeps the string exactly as printed. |
| `title` | `property="title"` | Job Bank titles are lower-case; `titleCase()` capitalises words, keeps acronyms like RN / (R.N.) / CNC. Partner "original title" is prepended to the description when it differs. |
| `description` | native: Tasks, Work setting, Supervision, Additional information, Employment groups …; partner: `property="description"` blob | HTML → plain paragraphs, list items as `- ` lines (`htmlToText`). Native pages' hidden flattened summary is used only when the sections are empty. |
| `requirements` | Languages, Education, Experience, Credentials, Experience and specialization, Personal suitability, Work conditions, Screening questions, "Who can apply" | Section title + text blocks. |
| `benefits` | Health/Financial/Long term/Other benefits | |
| `category` | NOC 2021 code (`aa_jobbank_job_noccode`) then title keywords | `NOC_CATEGORY` longest-prefix table (5-digit unit groups where it matters: 73300 truck drivers → transport, 44101 home support workers → healthcare, 65310 cleaners → warehouse/general labour, …); a title keyword may override a 1–2-digit match; `KEYWORD_CATEGORY` for partner postings without a NOC; default `other`. |
| `noc_code` | NOC | 5-digit NOC 2021. |
| `job_type` | employmentType | Permanent/Full time → `full_time`; Part time / Casual → `part_time`; Term or contract → `contract`; Temporary → `temporary`; Seasonal → `seasonal`; apprenticeship/internship when stated. |
| `work_arrangement` | "Work location" (On site / Remote / Hybrid) | default `on_site`. |
| `experience_level`, `experience_other` | Experience (`span[property="experienceRequirements"]`) | `experienceFor()` → a `C.EXPERIENCE_LEVELS` **key** — the list IS Job Bank's vocabulary, so it is 1:1: "No experience (will train)" → `will_train`; "Experience an asset" → `asset`; "1 to less than 7 months" → `1_7_months`; "7 months to less than 1 year" → `7_12_months`; "1 year to less than 2 years" → `1_2_years`; "2 years to less than 3 years" → `2_3_years`; "3 years to less than 5 years" → `3_5_years`; "5 years or more" → `5_plus`. Matcher is longest-phrase-first. Free text ("2-5 years", "3+ years", "6 months") is bucketed by its LOWER bound; anything else → `other` + `experience_other` = raw text; no Experience section (partner postings) → NULL. |
| `education`, `education_other` | Education (`ul[property="educationRequirements qualification"]` lines) | `educationFor()` → a `C.EDUCATION_LEVELS` **key** (1:1 with Job Bank's list): "No degree, certificate or diploma" → `none`; "Secondary (high) school graduation certificate" → `secondary`; "Registered Apprenticeship certificate" → `apprenticeship`; "Other trades certificate or diploma" → `trades`; "College, CEGEP or other non-university certificate or diploma from a program of 3 months to less than 1 year" → `college_short`; "… of 1 year to 2 years" → `college_1_2`; "College/CEGEP" (and longer-program variants) → `college`; "Bachelor's degree" → `bachelor`; "Degree in medicine, dentistry, veterinary medicine or optometry" → `professional_degree`; "Master's degree" → `master`; "Earned doctorate degree" → `doctorate`. **Matcher is ordered longest phrase first** (several phrases contain "certificate or diploma" — a short pattern running first mis-filed the College variants in round 1). First mappable line wins; modifier lines ("or equivalent experience", "Full time enrollment") are ignored; anything unrecognised → `other` + `education_other` = raw text; no Education section (partner postings) → NULL. The raw line is always kept verbatim in `requirements` ("Education: …"). |
| `hours_amount`, `hours_period` | `property='workHours'` ("35 hours per week", "30 to 40 hours per week", "75 hours bi-weekly") | `parseHours()` → amount = the single value or the **upper bound** of a range (numeric(6,2)), period ∈ `C.HOURS_PERIODS` (`week` / `biweekly` / `month` / `year`; French "heures par semaine" handled). Note Job Bank single-quotes this attribute — round 1's `propText` only matched double quotes, so `workHours` was always NULL until 2026-09-10. Partner postings have no workHours → NULL; `h.formatHours(job)` renders "35 hours per week". |
| `employer_profiles.industry` | employer profile page "Industrial sector: …" | `industryFor()` matches the sector name against `C.INDUSTRIES` labels (normalised), then a per-sector alias list; **no match → NULL, never guessed** (an unmapped sector is logged as `unmapped sector "…"`). Never overwrites an existing value. `website` is filled from the same page when empty. Only employers whose posting links an employer page get one (69 of 296 postings; ~1 in 4 employers). |
| `job_locations` (≥1 row), `city`, `province`, `postal_code` | every `property="address" typeof="PostalAddress"` block in the Location `<li>` (streetAddress / addressLocality / addressRegion / postalCode); "Various locations" postings list all of them in `span.list-city`; the `#variouslocation-dialog` modal is the fallback | `parseLocations()` → one `job_locations` row per address in page order (`sort_order` 0…n), `street_address` + `unit` (split out of the street by `splitUnit()`: "UNIT 4-11 VERVAIN DRIVE", "948 Homer Street suite 400", "205-105 Southbank Boulevard") + `postal_code` (validated with `C.POSTAL_CODE_RE`, stored "A1A 1A1") when Job Bank printed them, else city/province only. `jobs.city/province/postal_code` = the first row. Province must be a `C.PROVINCES` code or the address is dropped (posting skipped if none is left). **Upsert replaces the job's location rows** (delete + insert inside one transaction). |
| `salary_min/max`, `salary_period` | baseSalary minValue/maxValue/unitText (fallback: feed salary text) | HOUR → `hour`, DAY → `day`, WEEK(LY) → `week`, BIWEEKLY → `biweekly`, MONTH(LY) → `month`, YEAR/ANNUALLY → `year` — **amounts stored as printed** (a "$1,200 weekly" posting is `1200 / week`; search/sort annualises with `C.SALARY_PERIOD_TO_YEAR`). Only semi-monthly (no period key) is converted: ×24 → `year`. Whole CAD; `content="10,000"` thousands separators are stripped. Guard kept: a non-hourly figure under $150 is an employer typo ("$24.87 weekly / 74 hours per week" and "software developer $101.00 daily" are real Job Bank data) and is stored as hourly. |
| `vacancies` | "N vacancies" | default 1. |
| `languages` | Languages | Bilingual / "English or French" → both; default English. |
| `audiences` | Employment groups (`Support for youths` → youth; `… newcomers and refugees` → new_immigrants + refugees; `… Indigenous people` → indigenous) + NOC TEER 0–1 (2nd digit) → professionals | |
| `apply_url`, `source_url` | posting URL | both the canonical Job Bank URL. |
| `published_at` | datePosted (fallback feed `<updated>`) | |
| `expires_at` | validThrough (end of day UTC) | fallback +30 days (Indeed-sourced postings show no "Advertised until"). |
| `status` | — | `active` on insert; `expired` when gone/past validThrough. A previously expired posting that reappears with a future validThrough is revived; `cancelled`/`inactive` (admin decisions) are never revived. |
| `created_by` | — | the system user. |

Upsert key: unique index `jobs_source_uid (source, source_id)`. Updates refresh title/description/requirements/
benefits/salary/education/experience/hours/expiry/`source_synced_at`, replace the `job_locations` rows and re-sync the
employer profile's legal/operating name (+ industry once); the job slug and profile slug never change.

## How to run

```bash
cd /home/ubuntu/projects/canada-careers && PW=$(cut -d= -f2 docs/.dbpw)
export DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/<db>"

# 1. see what would be imported (fetch + parse + print, writes nothing)
node scripts/import-jobbank.js --dry-run --limit 5 --per-query 5 --queries nurse --provinces ON

# 2. first import: 15 default keywords × ON/BC/AB/QC/MB/SK/NS/NB, ≤200 new postings, ≤2 per keyword×province
node scripts/import-jobbank.js                       # ≈ 25–30 min at the 5 s crawl delay
node scripts/import-jobbank.js --limit 50 --per-query 1 --queries "cook,welder" --provinces "NS,NB"
node scripts/import-jobbank.js --refresh             # also re-check every live imported posting afterwards

# 2b. after a parser/mapping change: re-map every imported row from the on-disk cache, import nothing new, no network
node scripts/import-jobbank.js --refresh --from-cache --limit 0

# 3. daily sync (the cron runner calls this; also runnable by hand)
node -e "require('./jobs/jobbank-sync').syncJobBank().then(r => console.log(JSON.stringify(r)))"
```

Options: `--queries a,b` · `--provinces ON,BC` · `--limit N` (max new postings; **0 = import nothing new**) ·
`--per-query N` (max new per keyword × province, default 2) · `--max-requests N` (HTTP budget, default 600) ·
`--dry-run` · `--refresh` · `--from-cache` (with `--refresh`: use cached pages of any age; network only for pages
missing from the cache — e.g. employer pages on the first run after 2026-09-10, ≤ 69 requests ≈ 6 min) ·
`--no-employer-pages` (skip the industry lookup) · `--purge` · `--enable`.
Env: `JOBBANK_DELAY_MS` (default 5000 = robots Crawl-delay; floor 1000), `JOBBANK_SYNC=off` (kill switch, see below).
The run ends with the vocabulary distributions (education / experience keys, hours, employer industry) so a mapping
regression is visible immediately.

### Purge / kill switch

If the client decides the reference postings should not appear at all:

```bash
node scripts/import-jobbank.js --purge
```

archives every imported posting (`status='expired'`, `archived_at=now()` — nothing is deleted, nothing paid is touched)
and sets the **`jobbank_sync` runtime setting** to `off` through `lib/settings` (`settings.set('jobbank_sync','off')`;
read with `settings.get` — DB value > env `JOBBANK_SYNC` > default `on`). The client's admin panel
(`/admin/integrations` → "Daily Job Bank reference import") toggles the very same key, so panel and CLI never disagree.
While it is off, `syncJobBank()` returns `{ skipped: '…' }` without fetching anything and `scripts/import-jobbank.js`
refuses to run (exit 3) — otherwise the daily sync would quietly revive them (the upsert revives an expired row whose
`validThrough` is still ahead). The 235 auto-created employer profiles stay (they list no live postings, so they're not
linked from anywhere). To undo:

```bash
node scripts/import-jobbank.js --enable            # clears the flag + re-activates purged rows whose Job Bank expiry is still ahead
```

Rows that had genuinely expired stay archived; the next sync re-checks every revived row against Job Bank within 20 h.
Verified on cc_import 2026-09-09: purge → 266 archived, sync skipped, import exit 3; `--enable` → 266 active again.

The run prints a per-query table (query, province, found, inserted, updated, existing, skipped), totals, counts by
category and province, and the request/cache-hit count. `existing` = already imported and left to the sync to
refresh; `updated` = already imported and refreshed from a still-fresh cached page. Running the importer twice in a
row inserts 0 the second time.

### Request budget

One nationwide feed per keyword (bucketed by province) + a province feed only where the bucket is short + one detail
page per posting we actually insert. Default first run ≈ 15 + ≤120 feeds + ≤200 details ≈ 250–330 requests ≈ 25 min
at 5 s. `syncJobBank()` spends 70 % of its budget re-checking live postings (~300 → 25 min) and 30 % on new ones
(`limit 100, perQuery 1`); at the default delay a full daily sync is ~35 min — keep it on a **daily** timer, not hourly.

### Cron wiring (orchestrator)

`jobs/jobbank-sync.js` exports `syncJobBank({ log, limit, perQuery, maxRequests })` and returns
`{ refresh: {checked, expired, refreshed, errors}, import: {found, inserted, updated, existing, skipped, errors}, requests, seconds }`
(or `{ skipped: 'settings.jobbank_sync=off', … zeros }` when the kill switch is on).
Call it from the daily runner after `runRenewals()`; it is safe to run concurrently with the web app (row-level
updates only, no truncation, no touching of paid rows: every write is scoped `WHERE source='jobbank'`).

## Known parsing gaps

- **Partner postings** (Indeed, Jobillico, Workopolis, Monster, …) have no structured Requirements/Benefits, so
  `requirements`/`benefits` are null and the whole text lands in `description`; some have no `validThrough` (Indeed) →
  +30-day fallback, corrected by the daily 410 check. Their `#externalJobLink` (the partner's own page) is parsed into
  `d.externalUrl` but we deliberately link to the Job Bank page, not the partner.
- **French postings** (mostly QC) are imported as-is; category mapping relies on the NOC code for those, and the
  keyword fallback is English-only.
- **"Various locations"** postings get one `job_locations` row per city (3 of 296 cached postings: 3, 2 and 7
  cities); Job Bank prints no street/postal for those, so the rows are city/province only.
- **Operating names** are only detected when Job Bank prints them inside the employer name ("X Ltd. o/a Y"); the
  employer-details block shows the same single string, there is no separate "Business name" field on the posting page.
  1 of 235 imported employers has one (Weldwork Fabricators Ltd. o/a Weldwork Fabricators).
- **Education / experience / hours** are NULL for partner postings (no structured sections, no `workHours` — 146 of
  266 rows); `other` is not hit by any of the current native vocabulary. If Job Bank adds a phrase, it lands in
  `education_other` / `experience_other` verbatim and shows up in the run's distribution line.
- **Industry** exists only for employers with a Job Bank employer profile (69 of 296 postings link one); everyone else
  stays NULL on purpose — we do not infer a sector from the NOC or the title.
- **Salary "to be negotiated"** with no figures → salary null ("Salary not disclosed").
- `job_type` collapses Job Bank's two-axis terms (Permanent/Term/Casual/Seasonal × Full/Part time) to one key;
  "Term or contract + Full time" becomes `contract`.
- Employment-group audiences only exist on native postings; NOC TEER 0–1 → `professionals` is a heuristic.
- The parser is regex-based and keyed on Job Bank's RDFa `property=` attributes and `job-posting-detail-requirements`
  blocks. If a run suddenly skips everything, diff a cached page in `data/jobbank-cache/` against the selectors in
  `parseDetail()`.
- The `_job-card` badge needs `jobs.source` in the card SELECT (`JOB_COLS` in `routes/public.js` and any other card
  list); the detail page selects `jobs.*` so it always has it.
