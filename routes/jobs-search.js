'use strict';
// Find Jobs (/jobs) — the search list, its marker feed and the posting-id redirect. UX standard §6 (docs/UX-STANDARDS.md).
// Mounted by server.js BEFORE routes/public.js, so these three routes shadow the older copies that still live there.
// The handlers were moved here verbatim from routes/public.js on 2026-09-14 (round 3) and then extended with:
//   - jobs.public_id in the row columns ("Posting ID K4T7M2" on every row),
//   - ?q=<X1X1X1> matching a public posting id exactly (case-insensitive) before falling back to full-text search,
//   - GET /jobs/id/:publicId → 302 to /jobs/<slug> (404 when the posting is not public).
// Every job query here MUST go through PUBLIC_WHERE (lib/jobs.js) — archived postings never leak.
const express = require('express');
const db = require('../lib/db');
const h = require('../lib/helpers');
const C = require('../lib/constants');
const { PUBLIC_WHERE, PUBLIC_ID_RE } = require('../lib/jobs');
const geo = require('../lib/geocode');

const router = express.Router();
const PAGE_SIZE = 10;
const CSS = ['/css/public.css', '/css/maps.css'];
const JS = ['/js/maps.js', '/js/public.js'];   // deferred scripts run in order: CCMaps must exist before public.js wires "Near me"
const RADII = [10, 25, 50, 100];
const DEFAULT_RADIUS = 25;
const GEO_MARKER_CAP = 200;

// Row-level columns for the list (same shape as routes/public.js JOB_COLS + public_id + application_deadline).
// operating_name = the per-posting choice (jobs.operating_name) falling back to the profile default (client PDF 2026-09-10, decision 5).
const JOB_COLS = `jobs.id, jobs.public_id, jobs.title, jobs.slug, jobs.category, jobs.job_type, jobs.work_arrangement, jobs.experience_level,
  jobs.city, jobs.province, jobs.salary_min, jobs.salary_max, jobs.salary_period, jobs.audiences, jobs.published_at, jobs.expires_at, jobs.application_deadline, jobs.source, jobs.source_url,
  jobs.hours_amount, jobs.hours_period,
  p.company_name, COALESCE(NULLIF(jobs.operating_name, ''), p.operating_name) AS operating_name, p.slug AS company_slug,
  (SELECT count(*) FROM job_locations l WHERE l.job_id = jobs.id)::int AS location_count`;
const JOB_FROM = `FROM jobs JOIN employer_profiles p ON p.id = jobs.employer_profile_id`;
// Every salary period is annualised with C.SALARY_PERIOD_TO_YEAR (hour ×2080, day ×260, week ×52, biweekly ×26, month ×12)
// so salary sort/filter can compare postings that quote different periods. Unknown/legacy periods count as yearly.
const ANNUAL = `((CASE jobs.salary_period ${Object.entries(C.SALARY_PERIOD_TO_YEAR).map(([k, n]) => `WHEN '${k}' THEN ${n}`).join(' ')} ELSE 1 END) * COALESCE(jobs.salary_max, jobs.salary_min))`;
const NEWEST = `jobs.published_at DESC NULLS LAST, jobs.id DESC`;
// Default-order relevance bias: student/intern-co-op/graduate/early-career postings rank ahead of skilled/senior
// ones when no explicit sort or filter is chosen, so the Job Bank's first page(s) read as built for young talent —
// without hiding or excluding anything. A skilled-career posting is still fully reachable via search, the "Skilled
// Careers" stage filter, sorting by salary, or a direct link; it just isn't first in the unfiltered default list.
const TARGET_RANK = `(CASE WHEN ${['student', 'intern_coop', 'graduate', 'early_career'].map(k => `(${C.CAREER_STAGE_SQL[k]})`).join(' OR ')} THEN 0 ELSE 1 END)`;
// Haversine (km) between a query point ($lat,$lng param indexes) and a job_locations row `l`. Wrapped in least(1, …) so
// floating-point drift can never push acos out of its domain. A bounding-box prefilter keeps the partial (lat, lng) index useful.
const distSql = (li, gi) => `(6371 * acos(least(1.0, cos(radians($${li})) * cos(radians(l.lat)) * cos(radians(l.lng) - radians($${gi})) + sin(radians($${li})) * sin(radians(l.lat)))))`;
const boxSql = (li, gi, ri) => `l.lat BETWEEN $${li} - $${ri} / 111.0 AND $${li} + $${ri} / 111.0 AND l.lng BETWEEN $${gi} - $${ri} / (111.0 * greatest(0.2, cos(radians($${li})))) AND $${gi} + $${ri} / (111.0 * greatest(0.2, cos(radians($${li}))))`;
const fmtKm = (km) => (km == null ? '' : km < 1 ? '< 1 km' : `≈ ${Math.round(km)} km`);

const first = (v) => (Array.isArray(v) ? v[0] : v);
// NUL bytes are stripped: Postgres rejects them in text parameters (would 500).
const str = (v, max = 120) => (first(v) == null ? '' : String(first(v)).replace(/\0/g, '').trim().slice(0, max));
// "K4T7M2" / "k4t7m2" → the canonical posting id, or '' when the string is not shaped like one.
const asPublicId = (s) => { const u = String(s || '').trim().toUpperCase(); return PUBLIC_ID_RE.test(u) ? u : ''; };

function notFound(res, message) {
  return res.status(404).render('error', { title: 'Page not found', code: 404, message, noindex: true });
}

// ------------------------------------------------------------------ filters (shared by /jobs and /api/jobs/geo)
function parseFilters(query) {
  const prov = str(query.province).toUpperCase(), jt = str(query.job_type), wa = str(query.work_arrangement);
  return {
    q: str(query.q),
    // Repeatable, like audience: a single ?category=x still works (one-element array); career-path
    // cards on the homepage can link several related categories at once (?category=a&category=b).
    category: [...new Set([].concat(query.category || []).map(c => String(c)).filter(c => C.CATEGORY_NAME[c]))],
    province: C.PROVINCE_NAME[prov] ? prov : '',
    city: str(query.city, 80),
    job_type: C.JOB_TYPE_NAME[jt] ? jt : '',
    work_arrangement: C.WORK_ARRANGEMENT_NAME[wa] ? wa : '',
    audience: [...new Set([].concat(query.audience || []).map(a => String(a)).filter(a => C.AUDIENCE_NAME[a]))],
    // Career stage (Students / Internships & Co-ops / Graduates / Early Career / Skilled Careers) — built from
    // real experience_level/job_type values (lib/constants.js CAREER_STAGE_SQL), not a fabricated classification.
    stage: C.CAREER_STAGE_SQL[str(query.stage)] ? str(query.stage) : '',
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
  ['q', 'province', 'city', 'job_type', 'work_arrangement', 'stage'].forEach(k => { if (o[k]) p.set(k, o[k]); });
  (o.category || []).forEach(c => p.append('category', c));
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

/**
 * Posting-id lookup (client round 3, item 6): when the keyword is shaped like a public id (X1X1X1) and a PUBLIC posting
 * carries it, the search is that exact posting (`f.public_id` set) instead of a full-text query. A code that matches no
 * public posting falls through to full text, so a stray "A1B2C3" in a title is still findable.
 */
async function resolvePublicId(f) {
  const pid = asPublicId(f.q);
  if (!pid) return;
  const hit = await db.one(`SELECT 1 FROM jobs WHERE public_id = $1 AND ${PUBLIC_WHERE}`, [pid]);
  if (hit) f.public_id = pid;
}

/** WHERE clause + params for a filter set (shared by /jobs and /api/jobs/geo). `point` adds the radius filter and a distance column. */
function buildWhere(f, point) {
  const where = [PUBLIC_WHERE];
  const params = [];
  if (f.public_id) { params.push(f.public_id); where.push(`jobs.public_id = $${params.length}`); }
  else if (f.q) {
    params.push(f.q); const a = params.length;
    params.push('%' + f.q.replace(/[%_\\]/g, '\\$&') + '%'); const b = params.length;
    // Keyword also matches the operating (trade) name and the city of ANY work location, not just the primary one.
    where.push(`(to_tsvector('english', jobs.title || ' ' || jobs.description || ' ' || coalesce(jobs.requirements,'')) @@ plainto_tsquery('english', $${a})
      OR jobs.title ILIKE $${b} OR p.company_name ILIKE $${b} OR p.operating_name ILIKE $${b} OR jobs.operating_name ILIKE $${b} OR EXISTS (SELECT 1 FROM unnest(jobs.skills) s WHERE s ILIKE $${b})
      OR jobs.city ILIKE $${b} OR EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = jobs.id AND l.city ILIKE $${b}))`);
  }
  if (f.category.length) { params.push(f.category); where.push(`jobs.category = ANY($${params.length}::text[])`); }
  if (f.province) { params.push(f.province); where.push(`jobs.province = $${params.length}`); }
  // City filter: a posting with several work locations is found by any of them (jobs.city is the primary one and is kept in sync).
  if (f.city) { params.push('%' + f.city.replace(/[%_\\]/g, '\\$&') + '%'); where.push(`(jobs.city ILIKE $${params.length} OR EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = jobs.id AND l.city ILIKE $${params.length}))`); }
  if (f.job_type) { params.push(f.job_type); where.push(`jobs.job_type = $${params.length}`); }
  if (f.work_arrangement) { params.push(f.work_arrangement); where.push(`jobs.work_arrangement = $${params.length}`); }
  if (f.audience.length) { params.push(f.audience); where.push(`jobs.audiences && $${params.length}::text[]`); }
  if (f.stage) where.push(`(${C.CAREER_STAGE_SQL[f.stage]})`);
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
  if (f.public_id) what = `Posting ${f.public_id}`;
  else if (f.q) what = `“${f.q}” jobs`;
  else {
    const bits = [];
    if (f.work_arrangement) bits.push(h.workArrangementName(f.work_arrangement));
    if (f.job_type) bits.push(h.jobTypeName(f.job_type).toLowerCase());
    if (f.category.length) bits.push(f.category.map(h.categoryName).join(' & '));
    if (f.stage) bits.push(C.CAREER_STAGE_NAME[f.stage]);
    what = bits.length ? bits.join(' ') + ' jobs' : 'All jobs';
  }
  let s = `${what} in ${place}`;
  if (f.near) s = `${what} within ${f.radius_km} km of ${f.near}`;
  else if (f.lat != null && f.lng != null) s = `${what} within ${f.radius_km} km of you`;
  if (f.audience.length) s += ' for ' + f.audience.map(h.audienceName).join(' & ');
  return s;
}

// ------------------------------------------------------------------ the list
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
    const [point] = await Promise.all([resolvePoint(f), resolvePublicId(f)]);
    const { W, params, distance } = buildWhere(f, point);
    // With a search point the default order is nearest-first; "Highest salary" still wins when chosen.
    const order = f.sort === 'salary' ? `${ANNUAL} DESC NULLS LAST, ${NEWEST}` : point ? `distance_km ASC NULLS LAST, ${NEWEST}` : `${TARGET_RANK} ASC, ${NEWEST}`;

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
    if (f.public_id) chips.push({ label: `Posting ID ${f.public_id}`, href: jobsUrl(f, { q: '' }) });
    else if (f.q) chips.push({ label: `“${f.q}”`, href: jobsUrl(f, { q: '' }) });
    f.category.forEach(c => chips.push({ label: h.categoryName(c), href: jobsUrl(f, { category: f.category.filter(x => x !== c) }) }));
    if (f.province) chips.push({ label: h.provinceName(f.province), href: jobsUrl(f, { province: '' }) });
    if (f.city) chips.push({ label: f.city, href: jobsUrl(f, { city: '' }) });
    if (f.job_type) chips.push({ label: h.jobTypeName(f.job_type), href: jobsUrl(f, { job_type: '' }) });
    if (f.stage) chips.push({ label: C.CAREER_STAGE_NAME[f.stage], href: jobsUrl(f, { stage: '' }) });
    if (f.work_arrangement) chips.push({ label: h.workArrangementName(f.work_arrangement), href: jobsUrl(f, { work_arrangement: '' }) });
    f.audience.forEach(a => chips.push({ label: h.audienceName(a), href: jobsUrl(f, { audience: f.audience.filter(x => x !== a) }) }));
    if (f.salary_min) chips.push({ label: `$${f.salary_min.toLocaleString('en-CA')}+ / year`, href: jobsUrl(f, { salary_min: 0 }) });

    const heading = headingFor(f);
    const canonicalUrl = res.locals.PUBLIC_URL + jobsUrl(f, { page: f.page, view: 'list' });
    // Which "More filters" (drawer) fields are active — drives the count badge on the "More filters" / "Filters" buttons.
    const moreActive = ['city', 'job_type', 'work_arrangement', 'stage'].filter(k => f[k]).length + (f.salary_min ? 1 : 0);
    res.render('public/jobs', {
      title: heading + (f.page > 1 ? ` — page ${f.page}` : ''),
      metaDescription: `${total} ${heading.charAt(0).toLowerCase() + heading.slice(1)} on Youth Careers Canada. Filter by category, province, city, job type, work arrangement, audience, salary and distance. New postings added daily.`,
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

// ------------------------------------------------------------------ posting id → slug (client round 3, item 6)
// /jobs/id/K4T7M2 (any case) → 302 /jobs/<slug>. Only PUBLIC postings resolve; anything else is a plain 404.
router.get('/jobs/id/:publicId', async (req, res, next) => {
  try {
    const pid = asPublicId(req.params.publicId);
    const job = pid ? await db.one(`SELECT slug FROM jobs WHERE public_id = $1 AND ${PUBLIC_WHERE}`, [pid]) : null;
    if (!job) return notFound(res, 'We could not find a live posting with that ID. It may have expired or been withdrawn.');
    res.redirect(302, `/jobs/${job.slug}`);
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ JSON: markers for the search map (same filters as /jobs)
// One marker per geocoded work location of every PUBLIC posting matching the filters, nearest/newest first, capped at 200.
// `total` = number of matching postings (same count as the /jobs heading); `?count_only=1` returns just { total, point,
// near_unresolved } so the filters drawer can label its "Show N results" button live without pulling markers.
router.get('/api/jobs/geo', async (req, res, next) => {
  try {
    const f = parseFilters(req.query);
    const [point] = await Promise.all([resolvePoint(f), resolvePublicId(f)]);
    const { W, params, dist } = buildWhere(f, point);
    const pointOut = point ? { lat: point.lat, lng: point.lng, label: point.label, radius_km: f.radius_km } : null;
    const countRow = await db.one(`SELECT count(*)::int AS n ${JOB_FROM} WHERE ${W}`, params);
    if (str(req.query.count_only) === '1') {
      res.set('Cache-Control', 'private, max-age=60');
      return res.json({ point: pointOut, near_unresolved: !!f.near_unresolved, total: countRow.n });
    }
    const rows = await db.many(`SELECT jobs.id, jobs.public_id, jobs.title, jobs.slug, jobs.salary_min, jobs.salary_max, jobs.salary_period, jobs.published_at, jobs.source,
        COALESCE(NULLIF(jobs.operating_name, ''), p.operating_name) AS operating_name, p.company_name,
        l.id AS location_id, l.street_address, l.unit, l.city, l.province, l.postal_code, l.lat, l.lng, ${dist ? dist : 'NULL::double precision'} AS distance_km
      ${JOB_FROM} JOIN job_locations l ON l.job_id = jobs.id AND l.lat IS NOT NULL
      WHERE ${W} ORDER BY ${dist ? 'distance_km ASC NULLS LAST, ' : ''}${NEWEST}, l.sort_order LIMIT ${GEO_MARKER_CAP + 1}`, params);
    const capped = rows.length > GEO_MARKER_CAP;
    const markers = rows.slice(0, GEO_MARKER_CAP).map(r => ({
      id: r.id, public_id: r.public_id, location_id: r.location_id, slug: r.slug, url: `/jobs/${r.slug}`, title: r.title, company: h.displayCompany(r),
      address: h.fullAddress(r), lat: r.lat, lng: r.lng, salary: h.formatSalary(r), distance_km: r.distance_km == null ? null : Math.round(r.distance_km * 10) / 10,
    }));
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ point: pointOut, near_unresolved: !!f.near_unresolved, total: countRow.n, count: markers.length, capped, markers });
  } catch (e) { next(e); }
});

module.exports = router;
