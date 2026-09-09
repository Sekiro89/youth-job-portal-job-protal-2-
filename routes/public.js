'use strict';
// Public pages: home, job search, job detail, company pages, sitemap, robots, privacy, terms.
// Every job query here MUST go through PUBLIC_WHERE (lib/jobs.js) — archived postings never leak.
const express = require('express');
const db = require('../lib/db');
const h = require('../lib/helpers');
const C = require('../lib/constants');
const { PUBLIC_WHERE } = require('../lib/jobs');

const router = express.Router();
const PAGE_SIZE = 20;
const CSS = ['/css/public.css'];
const JS = ['/js/public.js'];

// Card-level columns shared by every listing; detail page selects jobs.* on top.
const JOB_COLS = `jobs.id, jobs.title, jobs.slug, jobs.category, jobs.job_type, jobs.work_arrangement, jobs.experience_level,
  jobs.city, jobs.province, jobs.salary_min, jobs.salary_max, jobs.salary_period, jobs.audiences, jobs.published_at, jobs.expires_at, jobs.source, jobs.source_url,
  p.company_name, p.operating_name, p.slug AS company_slug,
  (SELECT count(*) FROM job_locations l WHERE l.job_id = jobs.id)::int AS location_count`;
const JOB_FROM = `FROM jobs JOIN employer_profiles p ON p.id = jobs.employer_profile_id`;
// Every salary period is annualised with C.SALARY_PERIOD_TO_YEAR (hour ×2080, day ×260, week ×52, biweekly ×26, month ×12)
// so salary sort/filter can compare postings that quote different periods. Unknown/legacy periods count as yearly.
const ANNUAL = `((CASE jobs.salary_period ${Object.entries(C.SALARY_PERIOD_TO_YEAR).map(([k, n]) => `WHEN '${k}' THEN ${n}`).join(' ')} ELSE 1 END) * COALESCE(jobs.salary_max, jobs.salary_min))`;
const NEWEST = `jobs.published_at DESC NULLS LAST, jobs.id DESC`;
// A job's work locations, primary first. Imported (Job Bank) rows only have city/province.
const LOCATIONS_SQL = `SELECT id, street_address, unit, city, province, postal_code, sort_order FROM job_locations WHERE job_id = $1 ORDER BY sort_order, id`;
// schema.org QuantitativeValue.unitText only allows HOUR/DAY/WEEK/MONTH/YEAR — bi-weekly figures are halved into WEEK.
const SALARY_UNIT = { hour: 'HOUR', day: 'DAY', week: 'WEEK', biweekly: 'WEEK', month: 'MONTH', year: 'YEAR' };

const first = (v) => (Array.isArray(v) ? v[0] : v);
// NUL bytes are stripped: Postgres rejects them in text parameters (would 500).
const str = (v, max = 120) => (first(v) == null ? '' : String(first(v)).replace(/\0/g, '').trim().slice(0, max));
// Slugs are produced by h.slugify (a-z, 0-9, '-') plus a random suffix; anything else can never match, so 404 early
// instead of sending odd bytes to Postgres.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

function notFound(res, message) {
  return res.status(404).render('error', { title: 'Page not found', code: 404, message, noindex: true });
}

const AUDIENCE_BLURB = {
  professionals: 'Skilled and licensed roles across every industry.',
  new_immigrants: 'Employers who value international experience and credentials.',
  indigenous: 'Partners committed to First Nations, Inuit and Métis hiring.',
  refugees: 'Welcoming workplaces with support for newcomers.',
  youth: 'First jobs, co-ops, internships and apprenticeships.',
};

// ------------------------------------------------------------------ home
router.get('/', async (req, res, next) => {
  try {
    const [latest, catRows, provRows, cityRows, totals] = await Promise.all([
      db.many(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE ${PUBLIC_WHERE} ORDER BY ${NEWEST} LIMIT 8`),
      db.many(`SELECT category, count(*)::int AS n FROM jobs WHERE ${PUBLIC_WHERE} GROUP BY category`),
      db.many(`SELECT province, count(*)::int AS n FROM jobs WHERE ${PUBLIC_WHERE} GROUP BY province`),
      db.many(`SELECT city, count(*)::int AS n FROM jobs WHERE ${PUBLIC_WHERE} GROUP BY city ORDER BY n DESC, city LIMIT 40`),
      db.one(`SELECT count(*)::int AS jobs, count(DISTINCT employer_profile_id)::int AS companies FROM jobs WHERE ${PUBLIC_WHERE}`),
    ]);
    const catCount = Object.fromEntries(catRows.map(r => [r.category, r.n]));
    const provCount = Object.fromEntries(provRows.map(r => [r.province, r.n]));
    const categories = C.CATEGORIES.map(([key, name]) => ({ key, name, n: catCount[key] || 0 }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const provinces = C.PROVINCES.map(([key, name]) => ({ key, name, n: provCount[key] || 0 }));
    const cities = cityRows.map(r => r.city).sort((a, b) => a.localeCompare(b));

    res.render('public/home', {
      title: 'Find jobs across Canada',
      metaDescription: `Search ${totals.jobs} open jobs from Canadian employers. Canada Careers connects professionals, new immigrants, Indigenous peoples, refugees and youth with opportunities in every province. Post a job from $${(C.PRICING.consultant_price_cents / 100).toFixed(2)}/month + GST.`,
      extraCss: CSS, extraJs: JS, bodyClass: 'page-home',
      jsonLd: [
        {
          '@context': 'https://schema.org', '@type': 'WebSite', name: 'Canada Careers', url: res.locals.PUBLIC_URL + '/',
          description: 'Canadian job bank for professionals, new immigrants, Indigenous peoples, refugees and youth.',
          inLanguage: 'en-CA',
          potentialAction: {
            '@type': 'SearchAction',
            target: { '@type': 'EntryPoint', urlTemplate: res.locals.PUBLIC_URL + '/jobs?q={search_term_string}' },
            'query-input': 'required name=search_term_string',
          },
        },
        {
          '@context': 'https://schema.org', '@type': 'Organization', name: 'Canada Careers', url: res.locals.PUBLIC_URL + '/',
          logo: res.locals.PUBLIC_URL + '/img/logo.svg', slogan: 'Jobs for every Canadian. Opportunities for all.',
          areaServed: { '@type': 'Country', name: 'Canada' },
        },
      ],
      latest, categories, provinces, cities, totals, AUDIENCE_BLURB,
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ search
function parseFilters(query) {
  const cat = str(query.category), prov = str(query.province).toUpperCase(), jt = str(query.job_type), wa = str(query.work_arrangement);
  return {
    q: str(query.q),
    category: C.CATEGORY_NAME[cat] ? cat : '',
    province: C.PROVINCE_NAME[prov] ? prov : '',
    city: str(query.city, 80),
    job_type: C.JOB_TYPE_NAME[jt] ? jt : '',
    work_arrangement: C.WORK_ARRANGEMENT_NAME[wa] ? wa : '',
    audience: [...new Set([].concat(query.audience || []).map(a => String(a)).filter(a => C.AUDIENCE_NAME[a]))],
    salary_min: Math.max(0, Math.min(1000000, parseInt(str(query.salary_min), 10) || 0)),
    sort: str(query.sort) === 'salary' ? 'salary' : 'newest',
    page: Math.max(1, Math.min(500, parseInt(str(query.page), 10) || 1)),
  };
}

/** Canonical /jobs URL for a filter set (with overrides). Page is dropped unless explicitly kept. */
function jobsUrl(f, overrides = {}) {
  const o = Object.assign({}, f, { page: 1 }, overrides);
  const p = new URLSearchParams();
  ['q', 'category', 'province', 'city', 'job_type', 'work_arrangement'].forEach(k => { if (o[k]) p.set(k, o[k]); });
  (o.audience || []).forEach(a => p.append('audience', a));
  if (o.salary_min) p.set('salary_min', o.salary_min);
  if (o.sort && o.sort !== 'newest') p.set('sort', o.sort);
  if (o.page > 1) p.set('page', o.page);
  const s = p.toString();
  return '/jobs' + (s ? '?' + s : '');
}

function headingFor(f) {
  const place = f.city ? f.city + (f.province ? ', ' + h.provinceName(f.province) : '') : (f.province ? h.provinceName(f.province) : 'Canada');
  let what;
  if (f.q) what = `“${f.q}” jobs`;
  else {
    const bits = [];
    if (f.work_arrangement) bits.push(h.workArrangementName(f.work_arrangement));
    if (f.job_type) bits.push(h.jobTypeName(f.job_type).toLowerCase());
    if (f.category) bits.push(h.categoryName(f.category));
    what = bits.length ? bits.join(' ') + ' jobs' : 'All jobs';
  }
  let s = `${what} in ${place}`;
  if (f.audience.length) s += ' for ' + f.audience.map(h.audienceName).join(' & ');
  return s;
}

router.get('/jobs', async (req, res, next) => {
  try {
    // The home hero submits one "loc" select (prov:XX or city:Name); normalise to canonical params.
    if (req.query.loc !== undefined) {
      const loc = str(req.query.loc, 90);
      const q = Object.assign({}, req.query); delete q.loc;
      if (loc.startsWith('prov:')) q.province = loc.slice(5);
      else if (loc.startsWith('city:')) q.city = loc.slice(5);
      return res.redirect(302, jobsUrl(parseFilters(q)));
    }
    const f = parseFilters(req.query);
    const where = [PUBLIC_WHERE];
    const params = [];
    if (f.q) {
      params.push(f.q); const a = params.length;
      params.push('%' + f.q.replace(/[%_\\]/g, '\\$&') + '%'); const b = params.length;
      // Keyword also matches the operating (trade) name and the city of ANY work location, not just the primary one.
      where.push(`(to_tsvector('english', jobs.title || ' ' || jobs.description || ' ' || coalesce(jobs.requirements,'')) @@ plainto_tsquery('english', $${a})
        OR jobs.title ILIKE $${b} OR p.company_name ILIKE $${b} OR p.operating_name ILIKE $${b} OR EXISTS (SELECT 1 FROM unnest(jobs.skills) s WHERE s ILIKE $${b})
        OR jobs.city ILIKE $${b} OR EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = jobs.id AND l.city ILIKE $${b}))`);
    }
    if (f.category) { params.push(f.category); where.push(`jobs.category = $${params.length}`); }
    if (f.province) { params.push(f.province); where.push(`jobs.province = $${params.length}`); }
    // City filter: a posting with several work locations is found by any of them (jobs.city is the primary one and is kept in sync).
    if (f.city) { params.push('%' + f.city.replace(/[%_\\]/g, '\\$&') + '%'); where.push(`(jobs.city ILIKE $${params.length} OR EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = jobs.id AND l.city ILIKE $${params.length}))`); }
    if (f.job_type) { params.push(f.job_type); where.push(`jobs.job_type = $${params.length}`); }
    if (f.work_arrangement) { params.push(f.work_arrangement); where.push(`jobs.work_arrangement = $${params.length}`); }
    if (f.audience.length) { params.push(f.audience); where.push(`jobs.audiences && $${params.length}::text[]`); }
    if (f.salary_min) { params.push(f.salary_min); where.push(`${ANNUAL} >= $${params.length}`); }
    const W = where.join(' AND ');
    const order = f.sort === 'salary' ? `${ANNUAL} DESC NULLS LAST, ${NEWEST}` : NEWEST;

    const [countRow, rows] = await Promise.all([
      db.one(`SELECT count(*)::int AS n ${JOB_FROM} WHERE ${W}`, params),
      db.many(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE ${W} ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${(f.page - 1) * PAGE_SIZE}`, params),
    ]);
    const total = countRow.n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    // ?page= beyond the last page: send the visitor to the last real page instead of "8 jobs found" + an empty list.
    if (f.page > pages) return res.redirect(302, jobsUrl(f, { page: pages }));

    const chips = [];
    if (f.q) chips.push({ label: `“${f.q}”`, href: jobsUrl(f, { q: '' }) });
    if (f.category) chips.push({ label: h.categoryName(f.category), href: jobsUrl(f, { category: '' }) });
    if (f.province) chips.push({ label: h.provinceName(f.province), href: jobsUrl(f, { province: '' }) });
    if (f.city) chips.push({ label: f.city, href: jobsUrl(f, { city: '' }) });
    if (f.job_type) chips.push({ label: h.jobTypeName(f.job_type), href: jobsUrl(f, { job_type: '' }) });
    if (f.work_arrangement) chips.push({ label: h.workArrangementName(f.work_arrangement), href: jobsUrl(f, { work_arrangement: '' }) });
    f.audience.forEach(a => chips.push({ label: h.audienceName(a), href: jobsUrl(f, { audience: f.audience.filter(x => x !== a) }) }));
    if (f.salary_min) chips.push({ label: `$${f.salary_min.toLocaleString('en-CA')}+ / year`, href: jobsUrl(f, { salary_min: 0 }) });

    const heading = headingFor(f);
    const canonicalUrl = res.locals.PUBLIC_URL + jobsUrl(f, { page: f.page });
    res.render('public/jobs', {
      title: heading + (f.page > 1 ? ` — page ${f.page}` : ''),
      metaDescription: `${total} ${heading.charAt(0).toLowerCase() + heading.slice(1)} on Canada Careers. Filter by category, province, city, job type, work arrangement, audience and salary. New postings added daily.`,
      canonical: canonicalUrl,
      extraCss: CSS, extraJs: JS, bodyClass: 'page-jobs',
      noindex: chips.length > 2 || f.page > 1, // keep the index to broad, useful landing combinations
      jsonLd: [{
        '@context': 'https://schema.org', '@type': 'ItemList', name: heading, numberOfItems: total,
        itemListElement: rows.map((j, i) => ({ '@type': 'ListItem', position: (f.page - 1) * PAGE_SIZE + i + 1, name: j.title, url: `${res.locals.PUBLIC_URL}/jobs/${j.slug}` })),
      }],
      f, jobs: rows, total, pages, chips, heading, jobsUrl, PAGE_SIZE,
      salaryOptions: [30000, 40000, 50000, 60000, 80000, 100000, 150000],
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ job detail
const EMPLOYMENT_TYPE = { full_time: 'FULL_TIME', part_time: 'PART_TIME', contract: 'CONTRACTOR', temporary: 'TEMPORARY', seasonal: 'TEMPORARY', internship: 'INTERN', apprenticeship: 'OTHER' };

router.get('/jobs/:slug', async (req, res, next) => {
  try {
    if (!SLUG_RE.test(req.params.slug)) return notFound(res, 'This job posting is no longer available. It may have closed, expired or been removed by the employer.');
    const job = await db.one(`SELECT jobs.*, p.company_name, p.operating_name, p.slug AS company_slug, p.website AS company_website, p.industry AS company_industry,
        p.city AS company_city, p.province AS company_province, p.company_size, p.description AS company_description
      ${JOB_FROM} WHERE jobs.slug = $1 AND ${PUBLIC_WHERE}`, [req.params.slug]);
    if (!job) return notFound(res, 'This job posting is no longer available. It may have closed, expired or been removed by the employer.');
    db.query('UPDATE jobs SET views = views + 1 WHERE id = $1', [job.id]).catch(e => console.error('[views]', e.message));

    const [more, savedRow, locRows] = await Promise.all([
      db.many(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE jobs.employer_profile_id = $1 AND jobs.id <> $2 AND ${PUBLIC_WHERE} ORDER BY ${NEWEST} LIMIT 4`, [job.employer_profile_id, job.id]),
      req.user && req.user.role === 'seeker' ? db.one('SELECT 1 FROM saved_jobs WHERE user_id = $1 AND job_id = $2', [req.user.id, job.id]) : null,
      db.many(LOCATIONS_SQL, [job.id]),
    ]);
    // A posting always has at least one location row (schema backfill); fall back to jobs.city/province just in case.
    const locations = locRows.length ? locRows : [{ city: job.city, province: job.province, postal_code: job.postal_code }];
    // Similar = same category, same province first, excluding this job and anything already shown under "more from company".
    const similar = await db.many(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE jobs.category = $1 AND jobs.id <> ALL($2::bigint[]) AND ${PUBLIC_WHERE} ORDER BY (jobs.province = $3) DESC, ${NEWEST} LIMIT 4`,
      [job.category, [job.id, ...more.map(j => j.id)], job.province]);

    const url = `${res.locals.PUBLIC_URL}/jobs/${job.slug}`;
    const companyName = h.displayCompany(job);          // operating (trade) name first
    const legalName = job.company_name;
    // Education / experience: keys map to names; legacy rows may hold free text (shown raw); "other" adds the free-text detail.
    const educationText = job.education ? h.educationName(job.education) + (job.education === 'other' && job.education_other ? ': ' + job.education_other : '') : '';
    const experienceText = job.experience_level ? h.experienceName(job.experience_level) + (job.experience_level === 'other' && job.experience_other ? ': ' + job.experience_other : '') : '';
    const half = (n) => (n == null ? n : Math.round(n / 2));
    const biweekly = job.salary_period === 'biweekly';
    const sMin = biweekly ? half(job.salary_min) : job.salary_min, sMax = biweekly ? half(job.salary_max) : job.salary_max;
    const salaryValue = job.salary_min || job.salary_max ? {
      '@type': 'MonetaryAmount', currency: 'CAD',
      value: Object.assign({ '@type': 'QuantitativeValue', unitText: SALARY_UNIT[job.salary_period] || 'YEAR' },
        sMin && sMax && sMin !== sMax ? { minValue: sMin, maxValue: sMax } : { value: sMin || sMax }),
    } : undefined;
    const placeFor = (l) => ({
      '@type': 'Place',
      address: Object.assign({ '@type': 'PostalAddress' },
        l.street_address ? { streetAddress: l.unit ? `${l.street_address}, Unit ${l.unit}` : l.street_address } : {},
        { addressLocality: l.city, addressRegion: l.province },
        l.postal_code ? { postalCode: l.postal_code } : {},
        { addressCountry: 'CA' }),
    });
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting',
      title: job.title,
      description: h.paragraphs(job.description) + (job.requirements ? '<h3>Requirements</h3>' + h.paragraphs(job.requirements) : '') + (job.benefits ? '<h3>Benefits</h3>' + h.paragraphs(job.benefits) : ''),
      datePosted: isoDate(job.published_at || job.created_at),
      validThrough: new Date(job.expires_at).toISOString(),
      employmentType: EMPLOYMENT_TYPE[job.job_type] || 'OTHER',
      identifier: { '@type': 'PropertyValue', name: companyName, value: job.slug },
      url, directApply: true,
      hiringOrganization: Object.assign({ '@type': 'Organization', name: companyName, legalName, url: `${res.locals.PUBLIC_URL}/companies/${job.company_slug}` }, job.company_website ? { sameAs: job.company_website } : {}),
      jobLocation: locations.map(placeFor),
      industry: h.categoryName(job.category),
      totalJobOpenings: job.vacancies,
    };
    if (salaryValue) posting.baseSalary = salaryValue;
    if (experienceText) posting.experienceRequirements = experienceText;
    if (educationText) posting.educationRequirements = educationText;
    if (job.skills && job.skills.length) posting.skills = job.skills.join(', ');
    if (job.work_arrangement === 'remote') {
      posting.jobLocationType = 'TELECOMMUTE';
      posting.applicantLocationRequirements = { '@type': 'Country', name: 'Canada' };
    }
    const breadcrumbs = {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: res.locals.PUBLIC_URL + '/' },
        { '@type': 'ListItem', position: 2, name: 'Jobs', item: res.locals.PUBLIC_URL + '/jobs' },
        { '@type': 'ListItem', position: 3, name: h.categoryName(job.category), item: res.locals.PUBLIC_URL + jobsUrl(parseFilters({ category: job.category })) },
        { '@type': 'ListItem', position: 4, name: job.title, item: url },
      ],
    };
    const shortDesc = String(job.description || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    res.render('public/job', {
      title: `${job.title} job in ${job.city}, ${h.provinceName(job.province)} — ${companyName}`,
      metaDescription: `${companyName} is hiring a ${job.title} in ${job.city}, ${h.provinceName(job.province)} (${h.jobTypeName(job.job_type)}, ${h.workArrangementName(job.work_arrangement)}). ${h.formatSalary(job)}. ${shortDesc}`.slice(0, 300),
      extraCss: CSS, extraJs: JS, bodyClass: 'page-job has-applybar',
      jsonLd: [posting, breadcrumbs],
      job, more, similar, saved: !!savedRow, url, locations, companyName, legalName, educationText, experienceText,
      // For the print footer: "Printed from jobs.khosha.tech/jobs/<slug> on <date>" (host without scheme).
      printHost: String(res.locals.PUBLIC_URL || '').replace(/^https?:\/\//, ''), printedOn: h.formatDate(new Date(), { month: 'long' }),
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ company page
router.get('/companies/:slug', async (req, res, next) => {
  try {
    if (!SLUG_RE.test(req.params.slug)) return notFound(res, 'We could not find that employer.');
    const co = await db.one('SELECT * FROM employer_profiles WHERE slug = $1 AND NOT archived', [req.params.slug]);
    if (!co) return notFound(res, 'We could not find that employer.');
    const jobs = await db.many(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE jobs.employer_profile_id = $1 AND ${PUBLIC_WHERE} ORDER BY ${NEWEST}`, [co.id]);
    const url = `${res.locals.PUBLIC_URL}/companies/${co.slug}`;
    const companyName = h.displayCompany(co);
    const address = co.street_address || co.city || co.province ? h.fullAddress(co) : '';
    const org = Object.assign({ '@context': 'https://schema.org', '@type': 'Organization', name: companyName, legalName: co.company_name, url },
      co.website ? { sameAs: co.website } : {},
      co.description ? { description: co.description } : {},
      co.city || co.province ? { address: Object.assign({ '@type': 'PostalAddress' }, co.street_address ? { streetAddress: co.street_address } : {},
        { addressLocality: co.city || undefined, addressRegion: co.province || undefined }, co.postal_code ? { postalCode: co.postal_code } : {}, { addressCountry: 'CA' }) } : {});
    res.render('public/company', {
      title: `${companyName} — jobs and company profile`,
      metaDescription: `${companyName}${co.industry ? ' (' + co.industry + ')' : ''}${co.city ? ' in ' + h.location(co) : ''} has ${jobs.length} open job${jobs.length === 1 ? '' : 's'} on Canada Careers. ${String(co.description || '').slice(0, 160)}`.slice(0, 300),
      extraCss: CSS, extraJs: JS, bodyClass: 'page-company',
      jsonLd: [org],
      co, jobs, url, companyName, address,
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ sitemap / robots
router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const base = res.locals.PUBLIC_URL;
    const [jobs, companies] = await Promise.all([
      db.many(`SELECT slug, updated_at FROM jobs WHERE ${PUBLIC_WHERE} ORDER BY updated_at DESC`),
      db.many(`SELECT p.slug, max(jobs.updated_at) AS lastmod FROM employer_profiles p JOIN jobs ON jobs.employer_profile_id = p.id WHERE NOT p.archived AND ${PUBLIC_WHERE} GROUP BY p.slug ORDER BY p.slug`),
    ]);
    const entries = [];
    const add = (loc, lastmod, changefreq, priority) => entries.push(`<url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${isoDate(lastmod)}</lastmod>` : ''}${changefreq ? `<changefreq>${changefreq}</changefreq>` : ''}${priority ? `<priority>${priority}</priority>` : ''}</url>`);
    add(base + '/', null, 'daily', '1.0');
    add(base + '/jobs', null, 'hourly', '0.9');
    ['/about', '/contact', '/employer', '/consultant', '/jobseeker', '/privacy', '/terms'].forEach(p => add(base + p, null, 'monthly', p === '/privacy' || p === '/terms' ? '0.2' : '0.6'));
    jobs.forEach(j => add(`${base}/jobs/${j.slug}`, j.updated_at, 'weekly', '0.8'));
    companies.forEach(c => add(`${base}/companies/${c.slug}`, c.lastmod, 'weekly', '0.5'));
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`);
  } catch (e) { next(e); }
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *', 'Allow: /',
    'Disallow: /admin', 'Disallow: /employer/', 'Disallow: /consultant/', 'Disallow: /jobseeker/',
    'Disallow: /billing', 'Disallow: /login', 'Disallow: /signup', 'Disallow: /forgot', 'Disallow: /reset/', 'Disallow: /account',
    '', `Sitemap: ${res.locals.PUBLIC_URL}/sitemap.xml`, '',
  ].join('\n'));
});

// ------------------------------------------------------------------ legal
router.get('/privacy', (req, res) => res.render('public/privacy', {
  title: 'Privacy policy',
  metaDescription: 'How Canada Careers collects, uses, stores and protects personal information under PIPEDA — for job seekers, employers and third-party consultants.',
  extraCss: CSS, bodyClass: 'page-legal', updated: '2026-09-01T12:00:00Z',
}));
router.get('/terms', (req, res) => res.render('public/terms', {
  title: 'Terms of use',
  metaDescription: 'The terms that govern use of Canada Careers, including job posting rules, the monthly posting subscription (plus GST), acceptable use and Canadian governing law.',
  extraCss: CSS, bodyClass: 'page-legal', updated: '2026-09-01T12:00:00Z',
}));

module.exports = router;
