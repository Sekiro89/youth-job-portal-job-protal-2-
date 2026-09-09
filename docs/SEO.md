# Canada Careers — SEO / AEO / GEO notes for `/about`

Owner: about agent. Page: `GET /about` (`routes/about.js`, `views/about/*.ejs`, `public/css/about.css`).
Last verified: 2026-09-09 on the isolated instance (port 3906): ~1,490 words of prose, 2,300 words including Quick answers + FAQ; 5 JSON-LD blocks parse; FAQ JSON-LD mirrors the visible FAQ text verbatim; 41 unique internal links.

## Page-level metadata

| Field | Value |
|---|---|
| `<title>` | `About Us — Canada’s inclusive job bank · Canada Careers` (55 chars incl. site suffix added by `layout.ejs`) |
| `<h1>` | `About Canada Careers — Canada’s inclusive job bank` |
| Meta description (154 chars) | `Canada Careers is Canada’s inclusive job bank: employers and consultants post jobs for $9.99 + GST a month; job seekers apply free and get matched alerts.` |
| Canonical | `${PUBLIC_URL}/about` (set by `server.js`) |
| Indexable | yes (`noindex` false) |
| Breadcrumb | Home › About Us (visible `<nav aria-label="Breadcrumb">` + `BreadcrumbList`) |

## Keyword map — primary / secondary per section

| Section (`id`) | Primary phrase | Secondary phrases |
|---|---|---|
| Hero | Canadian job bank · inclusive job bank | professionals, new immigrants, Indigenous peoples, refugees, youth; employers; third-party consultants; "Jobs for every Canadian. Opportunities for all." |
| Facts strip (GEO) | $9.99 + GST per posting per month | 5 audiences; 13 provinces & territories; 20 job categories; free for job seekers; monthly renewal |
| `quick-answers` (AEO) | What is Canada Careers | who can post jobs; how much does a job posting cost; free for job seekers; how job alerts work; who we serve |
| `mission` | job bank in Canada | Canadian job bank; find your next job in Canada; no hidden fees; Toronto, Vancouver, Nunavut |
| `who-we-serve` | jobs in Canada for new immigrants | Indigenous employment opportunities Canada; refugee jobs Canada; youth jobs Canada; internships and co-op; professional roles; healthcare & nursing, IT & software, engineering, skilled trades, logistics, accounting |
| `who-we-serve` › provinces | jobs in Ontario / British Columbia / Alberta / Quebec | all 13 province & territory names; jobs in Toronto, Vancouver, Calgary, Montreal, Edmonton, Ottawa, Winnipeg, Halifax |
| `employers` | post a job in Canada · $9.99 job posting | job board for employers in Canada; job posting pricing; GST; monthly renewal; cancel any time; archived / expired / cancelled / inactive postings |
| `consultants` | third party recruiter job posting | staffing agencies; recruitment firms; immigration consultants; HR consultants; many employer profiles; single sign-in |
| `job-seekers` | jobs in Canada (free) | resume upload PDF / DOC / DOCX; job alerts; apply online; save jobs; on-site, hybrid, remote |
| `how-it-works` | how to post a job / how to apply | 3 steps each; publish and pay; matched alerts |
| `commitment` | inclusive hiring Canada | accessibility (WCAG); privacy (PIPEDA); Canadian data; Canadian dollars |
| How to cite us (GEO) | Canada Careers citation | canonical URL; name; price fact |
| `faq` | job posting cost / GST / cancel / archive / consultants / resume formats / alerts / coverage / accessibility / PIPEDA / contact | 12 questions, natural-language question headings |
| Closing CTA | post a job · sign up free | Calgary, Quebec, Ottawa |

Internal links present: `/jobs`, `/employer`, `/employer#pricing`, `/consultant`, `/jobseeker`, `/contact`, `/privacy`, `/jobs?audience=<key>` (5), `/jobs?category=<key>` (6), `/jobs?job_type=internship`, `/jobs?province=<code>` (13), `/jobs?province=<code>&city=<City>` (8). Keys come from `lib/constants.js`.

## JSON-LD inventory (all in the `jsonLd` array → rendered by `layout.ejs`)

| # | `@type` | `@id` | Notes |
|---|---|---|---|
| 1 | `Organization` | `${PUBLIC_URL}/#organization` | name, alternateName, url, `logo` = `/img/logo-stacked.svg`, slogan, description, `sameAs: []` (fill when social profiles exist), `areaServed` Country=Canada, `knowsAbout` (14 topics), `contactPoint` → `/contact`, `makesOffer` → Offer $9.99 CAD / month with `UnitPriceSpecification` (`valueAddedTaxIncluded: false`, `unitCode: MON`) |
| 2 | `WebSite` | `${PUBLIC_URL}/#website` | publisher → Organization; `SearchAction` → `/jobs?q={search_term_string}` |
| 3 | `WebPage` + `AboutPage` | `${PUBLIC_URL}/about#webpage` | isPartOf → WebSite; about / mainEntity → Organization; breadcrumb → #breadcrumb; `speakable` → `.about-quick`; primaryImageOfPage → `/img/og.png` |
| 4 | `BreadcrumbList` | `${PUBLIC_URL}/about#breadcrumb` | Home › About Us |
| 5 | `FAQPage` | `${PUBLIC_URL}/about#faq` | 12 Question/Answer pairs; text is the same string rendered in the `<details>` accordions (single source: `FAQ` array in `routes/about.js`) |

Validate after any copy change: `curl -s localhost:PORT/about | node -e '...'` (extract `<script type="application/ld+json">` blocks, `JSON.parse` each, assert every `acceptedAnswer.text` appears HTML-escaped in the page). Also paste the page into https://validator.schema.org and Google's Rich Results Test before launch.

Note: `WebSite` + `Organization` are also expected on the home page (public agent). Both pages use the same `@id`s so crawlers merge them into one entity graph rather than seeing two organisations.

## 10 concrete follow-ups for ranking

1. **Google Search Console + Bing Webmaster Tools** — verify the production domain, submit `/sitemap.xml` (already served by the public router), watch Coverage and the Rich Results report for the `FAQPage`, `JobPosting` and `Organization` markup.
2. **Google for Jobs** — the job pages already emit `JobPosting` JSON-LD; make sure every posting includes `datePosted`, `validThrough` (= `expires_at`), `hiringOrganization`, `jobLocation` with `addressRegion` (province code) and `addressCountry: CA`, `employmentType`, and `baseSalary` when a range is set. Archived jobs must 404 or 410 (they do via `PUBLIC_WHERE`) so Google drops them fast.
3. **IndexNow** — on every job activation / archive, POST the job URL (and `/sitemap.xml`) to `https://api.indexnow.org/indexnow` with a key file at `/<key>.txt`. Bing, Yandex and Naver index within minutes; cheap to add to `lib/jobs.js` activate/archive.
4. **Sitemap hygiene** — include `<lastmod>` on job URLs, split into `sitemap-jobs.xml` / `sitemap-pages.xml` once listings exceed ~1,000, and ping Google after the daily renewal run.
5. **Programmatic landing pages** — `/jobs?province=ON` style URLs are filters, not landing pages. Add crawlable, canonical pages such as `/jobs/ontario`, `/jobs/toronto`, `/jobs/healthcare`, `/jobs/new-immigrants` with unique intro copy, counts and `ItemList` JSON-LD; link them from `/about`, the footer and the home page. This is the single biggest organic lever for "jobs in <city>" queries.
6. **Audience content hubs** — one long-form guide per audience (e.g. "Finding your first job in Canada as a new immigrant", "Indigenous employment programs by province", "Refugee work permits and hiring", "Youth and student jobs in Canada"). Interlink with `/about#who-we-serve` and the audience filter pages; each guide gets its own `FAQPage`.
7. **Employer / pricing page schema** — add `Product` + `Offer` (`$9.99 CAD`, `priceValidUntil`, `UnitPriceSpecification`) and an `HowTo` block ("How to post a job on Canada Careers") on `/employer` so pricing snippets appear for "job posting cost Canada" queries.
8. **Company pages as entity anchors** — `/companies/:slug` should emit `Organization` JSON-LD with `sameAs` (company website / LinkedIn) and list active jobs as `ItemList`; these pages earn backlinks from employers and consultants who share them.
9. **Performance + Core Web Vitals** — self-host Montserrat/Inter with `font-display: swap`, preload the logo, set `Cache-Control` for `/css` and `/img` (currently `maxAge` only in production), and add `width`/`height` to every image to avoid CLS. Run Lighthouse on `/`, `/about`, a job page and a search page; aim for LCP < 2.5 s on mobile.
10. **Off-page and GEO signals** — populate `sameAs` with LinkedIn / X / Facebook / Crunchbase / Wikidata once they exist; register the business on Google Business Profile; get listed in Canadian newcomer-settlement and Indigenous-employment directories (IRCC settlement agencies, provincial nominee program resource lists, university career centres). Consistent naming ("Canada Careers", never "CanadaCareers") across every profile helps generative engines resolve the entity; the "How to cite us" line on `/about` gives them a canonical sentence to quote.

Bonus hygiene: add `hreflang="fr-CA"` once a French version exists (Quebec queries are heavily French), and keep `robots.txt` disallowing `/employer/`, `/consultant/`, `/jobseeker/`, `/billing/`, `/admin/` while allowing the public landing pages.
