'use strict';
// Public pages: home, job search, job detail, company pages, sitemap, robots, privacy, terms.
// Every job query here MUST go through PUBLIC_WHERE (lib/jobs.js) — archived postings never leak.
const express = require('express');
const db = require('../lib/db');
const h = require('../lib/helpers');
const C = require('../lib/constants');
const { PUBLIC_WHERE } = require('../lib/jobs');
const geo = require('../lib/geocode');
const jd = require('../lib/job-dates');   // application_deadline (Toronto calendar day) + applications_closed

const router = express.Router();
const PAGE_SIZE = 20;
const CSS = ['/css/public.css', '/css/maps.css'];
const JS = ['/js/maps.js', '/js/public.js'];   // deferred scripts run in order: CCMaps must exist before public.js wires the search map
const RADII = [10, 25, 50, 100];
const DEFAULT_RADIUS = 25;
const GEO_MARKER_CAP = 200;
// Job detail's "Opportunity Profile" map gets a lighter, editorial basemap instead of the default OSM tile
// style — presentation only (same Leaflet/marker/provider logic; free, no-key CARTO tiles, OSM data & attribution
// retained). Scoped to this one route so the Job Bank / company maps elsewhere keep the standard OSM look.
const JOB_DETAIL_TILES = {
  url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
  maxZoom: 19,
};

// Card-level columns shared by every listing; detail page selects jobs.* on top.
// operating_name = the per-posting choice (jobs.operating_name) falling back to the profile default (client PDF 2026-09-10, decision 5).
const JOB_COLS = `jobs.id, jobs.title, jobs.slug, jobs.category, jobs.job_type, jobs.work_arrangement, jobs.experience_level,
  jobs.city, jobs.province, jobs.salary_min, jobs.salary_max, jobs.salary_period, jobs.audiences, jobs.published_at, jobs.expires_at, jobs.source, jobs.source_url,
  jobs.hours_amount, jobs.hours_period, jobs.public_id, jobs.application_deadline, jobs.locked_at,
  p.company_name, COALESCE(NULLIF(jobs.operating_name, ''), p.operating_name) AS operating_name, p.slug AS company_slug,
  (SELECT count(*) FROM job_locations l WHERE l.job_id = jobs.id)::int AS location_count`;
const JOB_FROM = `FROM jobs JOIN employer_profiles p ON p.id = jobs.employer_profile_id`;
// Every salary period is annualised with C.SALARY_PERIOD_TO_YEAR (hour ×2080, day ×260, week ×52, biweekly ×26, month ×12)
// so salary sort/filter can compare postings that quote different periods. Unknown/legacy periods count as yearly.
const ANNUAL = `((CASE jobs.salary_period ${Object.entries(C.SALARY_PERIOD_TO_YEAR).map(([k, n]) => `WHEN '${k}' THEN ${n}`).join(' ')} ELSE 1 END) * COALESCE(jobs.salary_max, jobs.salary_min))`;
const NEWEST = `jobs.published_at DESC NULLS LAST, jobs.id DESC`;
// A job's work locations, primary first. Imported (Job Bank) rows only have city/province.
const LOCATIONS_SQL = `SELECT id, street_address, unit, city, province, postal_code, sort_order, lat, lng, place_id FROM job_locations WHERE job_id = $1 ORDER BY sort_order, id`;
// Haversine (km) between a query point ($lat,$lng param indexes) and a job_locations row `l`. Wrapped in least(1, …) so
// floating-point drift can never push acos out of its domain. A bounding-box prefilter keeps the partial (lat, lng) index useful.
const distSql = (li, gi) => `(6371 * acos(least(1.0, cos(radians($${li})) * cos(radians(l.lat)) * cos(radians(l.lng) - radians($${gi})) + sin(radians($${li})) * sin(radians(l.lat)))))`;
const boxSql = (li, gi, ri) => `l.lat BETWEEN $${li} - $${ri} / 111.0 AND $${li} + $${ri} / 111.0 AND l.lng BETWEEN $${gi} - $${ri} / (111.0 * greatest(0.2, cos(radians($${li})))) AND $${gi} + $${ri} / (111.0 * greatest(0.2, cos(radians($${li}))))`;
// "Open in Google Maps" — a plain search URL, works with no API key.
const gmapsUrl = (l) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(h.fullAddress(l) + ', Canada');
const fmtKm = (km) => (km == null ? '' : km < 1 ? '< 1 km' : `≈ ${Math.round(km)} km`);
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

// CAREER_PATHS / CATEGORY_TO_PATH now live in lib/constants.js (shared with the job-seeker landing page's own
// "Find your lane" section). All five groups are shown on the compass — the full catalogue remains one click
// away via "Explore all career areas →" to /jobs.
const COMPASS_PATHS = C.CAREER_PATHS.map(({ key, name }) => ({ key, name }));

// Career-stage bucket, from the existing experience_level/job_type fields (current Job Bank vocabulary + legacy
// strings on older rows — lib/constants.js EXPERIENCE_LEGACY). Used only to weight the homepage's "Featured
// Opportunities" mix toward young talent — never to hide postings: the Job Bank (/jobs) always shows every stage.
const STAGE_SQL = `(CASE
  WHEN jobs.experience_level IN ('3_5_years', '5_plus', 'senior', 'manager', 'executive') THEN 'skilled'
  ELSE 'targeted'
END)`;

// ------------------------------------------------------------------ home
router.get('/', async (req, res, next) => {
  try {
    const [featured, catRows, provRows, cityRows, totals, stageRow] = await Promise.all([
      // Featured mix is weighted toward the core young-talent audience — up to 7 of 8 slots go to
      // student/intern/graduate/early-career postings, newest first, with room for at most one skilled/senior
      // example so the homepage still shows the full journey without reading as a general job board. Real data only.
      db.many(`WITH staged AS (
          SELECT ${JOB_COLS}, ${STAGE_SQL} AS stage ${JOB_FROM} WHERE ${PUBLIC_WHERE}
        ),
        targeted AS (SELECT * FROM staged WHERE stage = 'targeted' ORDER BY published_at DESC NULLS LAST, id DESC LIMIT 7),
        skilled AS (SELECT * FROM staged WHERE stage = 'skilled' ORDER BY published_at DESC NULLS LAST, id DESC LIMIT 1),
        combined AS (SELECT * FROM targeted UNION ALL SELECT * FROM skilled)
        SELECT * FROM combined
        ORDER BY (CASE WHEN stage = 'skilled' THEN 1 ELSE 0 END), published_at DESC NULLS LAST, id DESC LIMIT 8`),
      db.many(`SELECT category, count(*)::int AS n FROM jobs WHERE ${PUBLIC_WHERE} GROUP BY category`),
      db.many(`SELECT province, count(*)::int AS n FROM jobs WHERE ${PUBLIC_WHERE} GROUP BY province`),
      db.many(`SELECT city, count(*)::int AS n FROM jobs WHERE ${PUBLIC_WHERE} GROUP BY city ORDER BY n DESC, city LIMIT 40`),
      db.one(`SELECT count(*)::int AS jobs, count(DISTINCT employer_profile_id)::int AS companies FROM jobs WHERE ${PUBLIC_WHERE}`),
      // Real counts for the "Explore Your Path" career-stage cards — same CAREER_STAGE_SQL the Job Bank's own
      // ?stage= filter uses (lib/constants.js), so a card's count always matches what clicking through shows.
      db.one(`SELECT ${C.CAREER_STAGES.map(([k]) => `count(*) FILTER (WHERE ${C.CAREER_STAGE_SQL[k]})::int AS ${k}`).join(', ')} FROM jobs WHERE ${PUBLIC_WHERE}`),
    ]);
    jd.decorateJobs(featured);
    const catCount = Object.fromEntries(catRows.map(r => [r.category, r.n]));
    const provCount = Object.fromEntries(provRows.map(r => [r.province, r.n]));
    const categories = C.CATEGORIES.map(([key, name]) => ({ key, name, n: catCount[key] || 0, path: C.CATEGORY_TO_PATH[key] || '' }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const provinces = C.PROVINCES.map(([key, name]) => ({ key, name, n: provCount[key] || 0 }));
    const cities = cityRows.map(r => r.city).sort((a, b) => a.localeCompare(b));
    const provincesWithJobs = provinces.filter(p => p.n > 0).length;
    const careerStages = C.CAREER_STAGES.map(([key, name]) => ({ key, name, n: stageRow[key] || 0 }));

    res.render('public/home', {
      title: 'Canadian jobs for young talent, from anywhere',
      metaDescription: `Search ${totals.jobs} open jobs from Canadian employers. Youth Futures Canada helps students, graduates, young professionals and skilled workers around the world find real Canadian career opportunities. Post a job from $${(C.PRICING.consultant_price_cents / 100).toFixed(2)}/month + GST.`,
      extraCss: CSS, extraJs: JS, bodyClass: 'page-home',
      jsonLd: [
        {
          '@context': 'https://schema.org', '@type': 'WebSite', name: 'Youth Futures Canada', url: res.locals.PUBLIC_URL + '/',
          description: 'Canadian job bank connecting young talent everywhere — students, graduates, young professionals and skilled workers — with real Canadian employers.',
          inLanguage: 'en-CA',
          potentialAction: {
            '@type': 'SearchAction',
            target: { '@type': 'EntryPoint', urlTemplate: res.locals.PUBLIC_URL + '/jobs?q={search_term_string}' },
            'query-input': 'required name=search_term_string',
          },
        },
        {
          '@context': 'https://schema.org', '@type': 'Organization', name: 'Youth Futures Canada', url: res.locals.PUBLIC_URL + '/',
          logo: res.locals.PUBLIC_URL + '/img/icon-512.png', slogan: 'Our dreams. Our skills. Our future. Our Canada.',
          areaServed: { '@type': 'Country', name: 'Canada' },
        },
      ],
      featured, categories, provinces, cities, totals, compassPaths: COMPASS_PATHS, careerStages, provincesWithJobs,
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
    sort: ['salary', 'distance'].includes(str(query.sort)) ? str(query.sort) : 'newest',
    page: Math.max(1, Math.min(500, parseInt(str(query.page), 10) || 1)),
    // Proximity (client PDF 2026-09-10, decision 8): either a typed place (`near`, geocoded server-side) or a browser point (`lat`/`lng`).
    near: str(query.near, 120),
    lat: coord(query.lat, 90), lng: coord(query.lng, 180),
    radius_km: RADII.includes(parseInt(str(query.radius_km), 10)) ? parseInt(str(query.radius_km), 10) : DEFAULT_RADIUS,
    view: str(query.view) === 'map' ? 'map' : 'list',
  };
}
function coord(v, max) { const n = Number(str(v, 24)); return Number.isFinite(n) && Math.abs(n) <= max && str(v, 24) !== '' ? Math.round(n * 1e6) / 1e6 : null; }

/** Canonical /jobs URL for a filter set (with overrides). Page is dropped unless explicitly kept. */
function jobsUrl(f, overrides = {}) {
  const o = Object.assign({}, f, { page: 1 }, overrides);
  const p = new URLSearchParams();
  ['q', 'category', 'province', 'city', 'job_type', 'work_arrangement'].forEach(k => { if (o[k]) p.set(k, o[k]); });
  (o.audience || []).forEach(a => p.append('audience', a));
  if (o.salary_min) p.set('salary_min', o.salary_min);
  if (o.near) p.set('near', o.near);
  else if (o.lat != null && o.lng != null) { p.set('lat', o.lat); p.set('lng', o.lng); }
  if ((o.near || (o.lat != null && o.lng != null)) && o.radius_km && o.radius_km !== DEFAULT_RADIUS) p.set('radius_km', o.radius_km);
  if (o.sort && o.sort !== 'newest') p.set('sort', o.sort);
  if (o.view === 'map') p.set('view', 'map');
  if (o.page > 1) p.set('page', o.page);
  const s = p.toString();
  return '/jobs' + (s ? '?' + s : '');
}

/**
 * Resolve the search centre: browser point wins only when no place was typed. Returns
 * { lat, lng, label, source: 'browser'|'near' } or null; `f.near_unresolved` is set when the typed place could not be geocoded.
 */
async function resolvePoint(f) {
  if (f.near) {
    const hit = await geo.geocode(f.near);
    if (hit) return { lat: hit.lat, lng: hit.lng, label: f.near, source: 'near' };
    f.near_unresolved = true;
    return null;
  }
  if (f.lat != null && f.lng != null) return { lat: f.lat, lng: f.lng, label: 'your location', source: 'browser' };
  return null;
}

/** WHERE clause + params for a filter set (shared by /jobs and /api/jobs/geo). `point` adds the radius filter and a distance column. */
function buildWhere(f, point) {
  const where = [PUBLIC_WHERE];
  const params = [];
  if (f.q) {
    params.push(f.q); const a = params.length;
    params.push('%' + f.q.replace(/[%_\\]/g, '\\$&') + '%'); const b = params.length;
    // Keyword also matches the operating (trade) name and the city of ANY work location, not just the primary one.
    where.push(`(to_tsvector('english', jobs.title || ' ' || jobs.description || ' ' || coalesce(jobs.requirements,'')) @@ plainto_tsquery('english', $${a})
      OR jobs.title ILIKE $${b} OR p.company_name ILIKE $${b} OR p.operating_name ILIKE $${b} OR jobs.operating_name ILIKE $${b} OR EXISTS (SELECT 1 FROM unnest(jobs.skills) s WHERE s ILIKE $${b})
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
  let distance = 'NULL::double precision', dist = null, box = null;
  if (point) {
    params.push(point.lat); const li = params.length;
    params.push(point.lng); const gi = params.length;
    params.push(f.radius_km); const ri = params.length;
    dist = distSql(li, gi); box = boxSql(li, gi, ri);
    // Any work location within the radius qualifies the posting; the distance shown is to its nearest location.
    where.push(`EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = jobs.id AND l.lat IS NOT NULL AND ${box} AND ${dist} <= $${ri})`);
    distance = `(SELECT min(${dist}) FROM job_locations l WHERE l.job_id = jobs.id AND l.lat IS NOT NULL)`;
  }
  return { W: where.join(' AND '), params, distance, dist, box };
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
  if (f.near) s = `${what} within ${f.radius_km} km of ${f.near}`;
  else if (f.lat != null && f.lng != null) s = `${what} within ${f.radius_km} km of you`;
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
    const point = await resolvePoint(f);
    const { W, params, distance } = buildWhere(f, point);
    // With a search point the default order is nearest-first; "Highest salary" still wins when chosen.
    const order = f.sort === 'salary' ? `${ANNUAL} DESC NULLS LAST, ${NEWEST}` : point ? `distance_km ASC NULLS LAST, ${NEWEST}` : NEWEST;

    const [countRow, rows] = await Promise.all([
      db.one(`SELECT count(*)::int AS n ${JOB_FROM} WHERE ${W}`, params),
      db.many(`SELECT * FROM (SELECT ${JOB_COLS}, ${distance} AS distance_km ${JOB_FROM} WHERE ${W}) x ORDER BY ${order.replace(/jobs\./g, 'x.')} LIMIT ${PAGE_SIZE} OFFSET ${(f.page - 1) * PAGE_SIZE}`, params),
    ]);
    const total = countRow.n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    // ?page= beyond the last page: send the visitor to the last real page instead of "8 jobs found" + an empty list.
    if (f.page > pages) return res.redirect(302, jobsUrl(f, { page: pages }));

    const chips = [];
    if (point) chips.push({ label: `Within ${f.radius_km} km of ${point.label}`, href: jobsUrl(f, { near: '', lat: null, lng: null }) });
    else if (f.near_unresolved) chips.push({ label: `Near “${f.near}” (not found)`, href: jobsUrl(f, { near: '' }) });
    if (f.q) chips.push({ label: `“${f.q}”`, href: jobsUrl(f, { q: '' }) });
    if (f.category) chips.push({ label: h.categoryName(f.category), href: jobsUrl(f, { category: '' }) });
    if (f.province) chips.push({ label: h.provinceName(f.province), href: jobsUrl(f, { province: '' }) });
    if (f.city) chips.push({ label: f.city, href: jobsUrl(f, { city: '' }) });
    if (f.job_type) chips.push({ label: h.jobTypeName(f.job_type), href: jobsUrl(f, { job_type: '' }) });
    if (f.work_arrangement) chips.push({ label: h.workArrangementName(f.work_arrangement), href: jobsUrl(f, { work_arrangement: '' }) });
    f.audience.forEach(a => chips.push({ label: h.audienceName(a), href: jobsUrl(f, { audience: f.audience.filter(x => x !== a) }) }));
    if (f.salary_min) chips.push({ label: `$${f.salary_min.toLocaleString('en-CA')}+ / year`, href: jobsUrl(f, { salary_min: 0 }) });

    const heading = headingFor(f);
    const canonicalUrl = res.locals.PUBLIC_URL + jobsUrl(f, { page: f.page, view: 'list' });
    // Which "More filters" (drawer) fields are active — drives the count badge on the "More filters" / "Filters" buttons.
    const moreActive = ['city', 'job_type', 'work_arrangement'].filter(k => f[k]).length + f.audience.length + (f.salary_min ? 1 : 0);
    res.render('public/jobs', {
      title: heading + (f.page > 1 ? ` — page ${f.page}` : ''),
      metaDescription: `${total} ${heading.charAt(0).toLowerCase() + heading.slice(1)} on Youth Futures Canada. Filter by category, province, city, job type, work arrangement, audience, salary and distance. New postings added daily.`,
      canonical: canonicalUrl,
      // UX standard §6 (2026-09-10): this page's own layout/JS live in jobs-search.css/js (after public.css + maps.css so they win).
      extraCss: CSS.concat('/css/jobs-search.css'), extraJs: JS.concat('/js/jobs-search.js'), bodyClass: 'page-jobs',
      noindex: chips.length > 2 || f.page > 1 || !!point, // keep the index to broad, useful landing combinations (never proximity searches)
      jsonLd: [{
        '@context': 'https://schema.org', '@type': 'ItemList', name: heading, numberOfItems: total,
        itemListElement: rows.map((j, i) => ({ '@type': 'ListItem', position: (f.page - 1) * PAGE_SIZE + i + 1, name: j.title, url: `${res.locals.PUBLIC_URL}/jobs/${j.slug}` })),
      }],
      f, jobs: rows, total, pages, chips, heading, jobsUrl, PAGE_SIZE, point, fmtKm, RADII, moreActive,
      // The map pane fetches its markers from /api/jobs/geo with the same filters (page-independent, capped).
      geoUrl: '/api/jobs/geo' + jobsUrl(f, { page: 1, view: 'list' }).replace(/^\/jobs/, ''),
      mapConfig: await geo.publicMapConfig(),
      salaryOptions: [30000, 40000, 50000, 60000, 80000, 100000, 150000],
    });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ JSON: markers for the search map (same filters as /jobs)
// One marker per geocoded work location of every PUBLIC posting matching the filters, nearest/newest first, capped at 200.
// `total` = number of matching postings (same count as the /jobs heading); `?count_only=1` returns just { total, point,
// near_unresolved } so the filters drawer can label its "Show N results" button live without pulling markers.
router.get('/api/jobs/geo', async (req, res, next) => {
  try {
    const f = parseFilters(req.query);
    const point = await resolvePoint(f);
    const { W, params, dist } = buildWhere(f, point);
    const pointOut = point ? { lat: point.lat, lng: point.lng, label: point.label, radius_km: f.radius_km } : null;
    const countRow = await db.one(`SELECT count(*)::int AS n ${JOB_FROM} WHERE ${W}`, params);
    if (str(req.query.count_only) === '1') {
      res.set('Cache-Control', 'private, max-age=60');
      return res.json({ point: pointOut, near_unresolved: !!f.near_unresolved, total: countRow.n });
    }
    const rows = await db.many(`SELECT jobs.id, jobs.title, jobs.slug, jobs.salary_min, jobs.salary_max, jobs.salary_period, jobs.published_at, jobs.source,
        COALESCE(NULLIF(jobs.operating_name, ''), p.operating_name) AS operating_name, p.company_name,
        l.id AS location_id, l.street_address, l.unit, l.city, l.province, l.postal_code, l.lat, l.lng, ${dist ? dist : 'NULL::double precision'} AS distance_km
      ${JOB_FROM} JOIN job_locations l ON l.job_id = jobs.id AND l.lat IS NOT NULL
      WHERE ${W} ORDER BY ${dist ? 'distance_km ASC NULLS LAST, ' : ''}${NEWEST}, l.sort_order LIMIT ${GEO_MARKER_CAP + 1}`, params);
    const capped = rows.length > GEO_MARKER_CAP;
    const markers = rows.slice(0, GEO_MARKER_CAP).map(r => ({
      id: r.id, location_id: r.location_id, slug: r.slug, url: `/jobs/${r.slug}`, title: r.title, company: h.displayCompany(r),
      address: h.fullAddress(r), lat: r.lat, lng: r.lng, salary: h.formatSalary(r), distance_km: r.distance_km == null ? null : Math.round(r.distance_km * 10) / 10,
    }));
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ point: pointOut, near_unresolved: !!f.near_unresolved, total: countRow.n, count: markers.length, capped, markers });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ JSON: address suggestions (OSM fallback for CCMaps.autocomplete)
// Server-side Nominatim proxy: shared 1.1 s queue + geocode_cache, 2+ chars, max 5 results, light per-IP throttle.
const suggestHits = new Map();
function suggestAllowed(ip) {
  const now = Date.now(); const e = suggestHits.get(ip) || { n: 0, t: now };
  if (now - e.t > 60000) { e.n = 0; e.t = now; }
  e.n++; suggestHits.set(ip, e);
  if (suggestHits.size > 5000) suggestHits.clear();
  return e.n <= 40;
}
router.get('/api/geocode/suggest', async (req, res, next) => {
  try {
    const q = str(req.query.q, 160);
    if (q.length < 2) return res.json({ provider: 'osm', results: [] });
    if (!suggestAllowed(req.ip)) return res.status(429).json({ error: 'Too many requests — try again in a minute.', results: [] });
    const results = await geo.suggest(q, 5);
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ provider: 'osm', results });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ job detail
const EMPLOYMENT_TYPE = { full_time: 'FULL_TIME', part_time: 'PART_TIME', contract: 'CONTRACTOR', temporary: 'TEMPORARY', seasonal: 'TEMPORARY', internship: 'INTERN', apprenticeship: 'OTHER' };

// External application hand-off: keeps third-party destinations (imported postings) off the page source; never indexed.
router.get('/jobs/:slug/go', async (req, res, next) => {
  try {
    const job = await db.one(`SELECT jobs.id, jobs.apply_url, jobs.source_url FROM jobs WHERE jobs.slug = $1 AND ${PUBLIC_WHERE}`, [req.params.slug]);
    const target = job && (job.apply_url || job.source_url);
    if (!target || !/^https?:\/\//i.test(target)) return res.status(404).render('error', { title: 'Page not found', code: 404, message: 'That posting does not exist.', noindex: true });
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'no-referrer');
    return res.redirect(302, target);
  } catch (e) { next(e); }
});

router.get('/jobs/:slug', async (req, res, next) => {
  try {
    if (!SLUG_RE.test(req.params.slug)) return notFound(res, 'This job posting is no longer available. It may have closed, expired or been removed by the employer.');
    const job = await db.one(`SELECT jobs.*, p.company_name, COALESCE(NULLIF(jobs.operating_name, ''), p.operating_name) AS operating_name, p.slug AS company_slug, p.website AS company_website, p.industry AS company_industry,
        p.city AS company_city, p.province AS company_province, p.company_size, p.description AS company_description
      ${JOB_FROM} WHERE jobs.slug = $1 AND ${PUBLIC_WHERE}`, [req.params.slug]);
    if (!job) return notFound(res, 'This job posting is no longer available. It may have closed, expired or been removed by the employer.');
    jd.decorateJob(job);   // application_deadline @ Toronto noon, application_deadline_date, applications_closed, locked (docs/TEMPLATE-VARS-R3.md)
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
    jd.decorateJobs(more); jd.decorateJobs(similar);
    // "Posted" = owner-editable published_at; "Closes" = the application deadline when set (end of that day in Toronto), else billing expiry.
    const postedAt = job.published_at || job.created_at;
    const closesAt = job.application_deadline || job.expires_at;
    const closesLabel = job.application_deadline ? 'Applications close' : 'Closes';
    const validThrough = job.application_deadline_date ? jd.torontoEndOfDay(job.application_deadline_date) : new Date(job.expires_at);

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
    const placeFor = (l) => Object.assign({
      '@type': 'Place',
      address: Object.assign({ '@type': 'PostalAddress' },
        l.street_address ? { streetAddress: l.unit ? `${l.street_address}, Unit ${l.unit}` : l.street_address } : {},
        { addressLocality: l.city, addressRegion: l.province },
        l.postal_code ? { postalCode: l.postal_code } : {},
        { addressCountry: 'CA' }),
    }, l.lat != null && l.lng != null ? { geo: { '@type': 'GeoCoordinates', latitude: l.lat, longitude: l.lng } } : {});
    const hoursText = h.formatHours(job);
    const industryText = job.company_industry ? h.industryName(job.company_industry) : '';
    // Map pins: only geocoded locations (the template shows "Map unavailable" when there are none).
    const mapMarkers = locations.filter(l => l.lat != null && l.lng != null).map((l, i) => ({ lat: l.lat, lng: l.lng, title: job.title, company: companyName, address: h.fullAddress(l) + (i === 0 && locations.length > 1 ? ' (primary)' : '') }));
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting',
      title: job.title,
      description: h.paragraphs(job.description) + (job.requirements ? '<h3>Requirements</h3>' + h.paragraphs(job.requirements) : '') + (job.benefits ? '<h3>Benefits</h3>' + h.paragraphs(job.benefits) : ''),
      datePosted: isoDate(postedAt),
      validThrough: validThrough.toISOString(),
      employmentType: EMPLOYMENT_TYPE[job.job_type] || 'OTHER',
      identifier: { '@type': 'PropertyValue', name: companyName, value: job.public_id || job.slug },
      url, directApply: !job.applications_closed,
      hiringOrganization: Object.assign({ '@type': 'Organization', name: companyName, legalName, url: `${res.locals.PUBLIC_URL}/companies/${job.company_slug}` }, job.company_website ? { sameAs: job.company_website } : {}),
      jobLocation: locations.map(placeFor),
      industry: industryText || h.categoryName(job.category),
      occupationalCategory: h.categoryName(job.category),
      totalJobOpenings: job.vacancies,
    };
    if (hoursText) posting.workHours = hoursText;
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
    const jobMapConfig = await geo.publicMapConfig();
    if (jobMapConfig.provider !== 'google') jobMapConfig.tiles = JOB_DETAIL_TILES;
    res.render('public/job', {
      title: `${job.title} job in ${job.city}, ${h.provinceName(job.province)} — ${companyName}`,
      metaDescription: `${companyName} is hiring a ${job.title} in ${job.city}, ${h.provinceName(job.province)} (${h.jobTypeName(job.job_type)}, ${h.workArrangementName(job.work_arrangement)}). ${h.formatSalary(job)}. ${shortDesc}`.slice(0, 300),
      extraCss: CSS.concat('/css/jobs-search.css'), extraJs: JS, bodyClass: 'page-job has-applybar',
      jsonLd: [posting, breadcrumbs],
      job, more, similar, saved: !!savedRow, url, locations, companyName, legalName, educationText, experienceText, hoursText, industryText,
      postedAt, closesAt, closesLabel, applyUrlLabel: 'Apply on other platform',
      mapMarkers, gmapsUrl, mapConfig: jobMapConfig,
      // For the print footer: "Printed from canadacareers.jobs/jobs/<slug> on <date>" (host without scheme).
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
    const [jobs, coLocations] = await Promise.all([
      db.many(`SELECT ${JOB_COLS} ${JOB_FROM} WHERE jobs.employer_profile_id = $1 AND ${PUBLIC_WHERE} ORDER BY ${NEWEST}`, [co.id]),
      // The profile's address book (client PDF 2026-09-10, decision 4) — default first; archived rows stay private.
      db.many('SELECT id, label, street_address, unit, city, province, postal_code, is_default, lat, lng FROM employer_locations WHERE employer_profile_id = $1 AND NOT archived ORDER BY is_default DESC, id', [co.id]),
    ]);
    jd.decorateJobs(jobs);
    const url = `${res.locals.PUBLIC_URL}/companies/${co.slug}`;
    const companyName = h.displayCompany(co);
    const industryText = co.industry ? h.industryName(co.industry) : '';
    const address = co.street_address || co.city || co.province ? h.fullAddress(co) : '';
    const mapMarkers = coLocations.filter(l => l.lat != null && l.lng != null).map(l => ({ lat: l.lat, lng: l.lng, title: l.label || companyName, company: companyName, address: h.fullAddress(l) }));
    const org = Object.assign({ '@context': 'https://schema.org', '@type': 'Organization', name: companyName, legalName: co.company_name, url },
      co.website ? { sameAs: co.website } : {},
      co.description ? { description: co.description } : {},
      co.city || co.province ? { address: Object.assign({ '@type': 'PostalAddress' }, co.street_address ? { streetAddress: co.street_address } : {},
        { addressLocality: co.city || undefined, addressRegion: co.province || undefined }, co.postal_code ? { postalCode: co.postal_code } : {}, { addressCountry: 'CA' }) } : {},
      mapMarkers.length ? { location: coLocations.filter(l => l.lat != null).map(l => ({ '@type': 'Place', name: l.label || undefined, address: { '@type': 'PostalAddress', streetAddress: l.street_address, addressLocality: l.city, addressRegion: l.province, postalCode: l.postal_code, addressCountry: 'CA' }, geo: { '@type': 'GeoCoordinates', latitude: l.lat, longitude: l.lng } })) } : {});
    res.render('public/company', {
      title: `${companyName} — jobs and company profile`,
      metaDescription: `${companyName}${industryText ? ' (' + industryText + ')' : ''}${co.city ? ' in ' + h.location(co) : ''} has ${jobs.length} open job${jobs.length === 1 ? '' : 's'} on Youth Futures Canada. ${String(co.description || '').slice(0, 160)}`.slice(0, 300),
      extraCss: CSS.concat('/css/jobs-search.css'), extraJs: JS, bodyClass: 'page-company',
      jsonLd: [org],
      co, jobs, url, companyName, address, industryText, coLocations, mapMarkers, gmapsUrl, mapConfig: await geo.publicMapConfig(),
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
    'Disallow: /billing', 'Disallow: /jobs/*/go', 'Disallow: /login', 'Disallow: /signup', 'Disallow: /forgot', 'Disallow: /reset/', 'Disallow: /account',
    '', `Sitemap: ${res.locals.PUBLIC_URL}/sitemap.xml`, '',
  ].join('\n'));
});

// ------------------------------------------------------------------ legal
router.get('/privacy', (req, res) => res.render('public/privacy', {
  title: 'Privacy policy',
  metaDescription: 'How Youth Futures Canada collects, uses, stores and protects personal information under PIPEDA — for job seekers, employers and third-party consultants.',
  extraCss: CSS.concat('/css/legal.css'), extraJs: ['/js/legal.js'], bodyClass: 'page-legal', updated: '2026-09-01T12:00:00Z',
}));
router.get('/terms', (req, res) => res.render('public/terms', {
  title: 'Terms of use',
  metaDescription: 'The terms that govern use of Youth Futures Canada, including job posting rules, the monthly posting subscription (plus GST), acceptable use and Canadian governing law.',
  extraCss: CSS.concat('/css/legal.css'), extraJs: ['/js/legal.js'], bodyClass: 'page-legal', updated: '2026-09-01T12:00:00Z',
}));

module.exports = router;
