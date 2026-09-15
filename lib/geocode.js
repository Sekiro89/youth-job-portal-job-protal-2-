'use strict';
// Geocoding + map-provider abstraction (client PDF 2026-09-10, decision 8).
//
//   provider()                     -> 'google' | 'osm'   (Google when a key is configured and maps_provider != 'osm')
//   geocode(addressString)         -> { lat, lng, provider, place_id } | null   (cached in geocode_cache)
//   suggest(q, limit)              -> [{ label, lat, lng, street, city, province, postal_code, place_id }] (Nominatim, cached)
//   geocodeJobLocation(id)         -> fills job_locations.lat/lng (copies from the linked employer_location first)
//   geocodeEmployerLocation(id)    -> fills employer_locations.lat/lng (+ propagates to linked job_locations)
//   geocodeMissing({ limit })      -> backlog filler for the daily runner / jobs/geocode.js
//   publicMapConfig()              -> { provider, googleKey, tiles } for templates (window.CC_MAPS)
//
// Nothing here throws out of the public exports: every failure is logged and returns null / a count.
// Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/): <= 1 request/second (we wait
// 1.1 s between calls through ONE module-level queue), a real User-Agent, results cached. Google: Geocoding API with
// region=ca + components=country:CA, results cached the same way.
const db = require('./db');
const settings = require('./settings');
const C = require('./constants');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_UA = 'CanadaCareersBot/1.0 (+https://canadacareers.jobs/about)';
const NOMINATIM_GAP_MS = 1100;
const GOOGLE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const NEGATIVE_TTL_MS = 7 * 24 * 3600 * 1000;      // "no result" entries are retried after a week
const SUGGEST_TTL_MS = 30 * 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const OSM_TILES = {
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  maxZoom: 19,
};
const PROVINCE_BY_NAME = Object.fromEntries(C.PROVINCES.map(([k, n]) => [n.toLowerCase(), k]));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[geocode]', ...a);
const warn = (...a) => console.warn('[geocode]', ...a);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ---------------------------------------------------------------- provider
async function provider() {
  try {
    const mode = String(await settings.get('maps_provider') || 'auto').trim().toLowerCase();
    if (mode === 'osm') return 'osm';
    const key = String(await settings.get('google_maps_api_key') || '').trim();
    return key ? 'google' : 'osm';
  } catch (e) { warn('provider()', e.message); return 'osm'; }
}
async function googleKey() { try { return String(await settings.get('google_maps_api_key') || '').trim(); } catch (_) { return ''; } }

/** Everything a page needs to draw a map. The Google key is a browser (publishable) key restricted by HTTP referrer. */
async function publicMapConfig() {
  const p = await provider();
  return { provider: p, googleKey: p === 'google' ? await googleKey() : '', tiles: OSM_TILES };
}

// ---------------------------------------------------------------- one shared Nominatim queue (>= 1.1 s between calls)
let chain = Promise.resolve();
let lastCallAt = 0;
function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastCallAt + NOMINATIM_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastCallAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers: Object.assign({ accept: 'application/json' }, headers || {}), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// ---------------------------------------------------------------- cache
const normalise = (s) => String(s || '').replace(/\0/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 300);
async function cacheGet(key) {
  return db.one('SELECT query, lat, lng, provider, place_id, raw, created_at FROM geocode_cache WHERE query = $1', [key]);
}
async function cachePut(key, hit, prov, raw) {
  await db.query(`INSERT INTO geocode_cache(query, lat, lng, provider, place_id, raw, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (query) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, provider=EXCLUDED.provider, place_id=EXCLUDED.place_id, raw=EXCLUDED.raw, created_at=now()`,
  [key, hit ? hit.lat : null, hit ? hit.lng : null, prov, hit ? hit.place_id || null : null, raw == null ? null : JSON.stringify(raw)]);
}

// ---------------------------------------------------------------- providers
async function googleGeocode(q, key) {
  const url = `${GOOGLE_URL}?address=${encodeURIComponent(q)}&region=ca&components=country:CA&key=${encodeURIComponent(key)}`;
  const data = await fetchJson(url);
  if (data.status === 'ZERO_RESULTS') return { hit: null, raw: data };
  if (data.status !== 'OK') throw new Error(`Google Geocoding ${data.status}${data.error_message ? ': ' + data.error_message : ''}`);
  const r = data.results[0];
  const loc = r && r.geometry && r.geometry.location;
  if (!loc) return { hit: null, raw: data };
  return { hit: { lat: num(loc.lat), lng: num(loc.lng), provider: 'google', place_id: r.place_id || null, label: r.formatted_address }, raw: r };
}
async function nominatimSearch(q, limit, addressdetails) {
  const url = `${NOMINATIM_URL}?format=jsonv2&countrycodes=ca&limit=${limit}${addressdetails ? '&addressdetails=1' : ''}&q=${encodeURIComponent(q)}`;
  return throttled(() => fetchJson(url, { 'user-agent': NOMINATIM_UA, 'accept-language': 'en-CA,en' }));
}
async function nominatimGeocode(q) {
  const rows = await nominatimSearch(q, 1, false);
  const r = Array.isArray(rows) && rows[0];
  if (!r) return { hit: null, raw: rows };
  return { hit: { lat: num(r.lat), lng: num(r.lon), provider: 'nominatim', place_id: r.place_id != null ? String(r.place_id) : null, label: r.display_name }, raw: r };
}

/**
 * Geocode one free-text address (Canada only). Returns { lat, lng, provider, place_id } or null.
 * Cached forever on success, for a week on "no result"; never throws.
 */
async function geocode(address) {
  const key = normalise(address);
  if (!key || key.length < 3) return null;
  try {
    const cached = await cacheGet(key);
    if (cached) {
      if (cached.lat != null) return { lat: cached.lat, lng: cached.lng, provider: cached.provider, place_id: cached.place_id };
      if (Date.now() - new Date(cached.created_at).getTime() < NEGATIVE_TTL_MS) return null;
    }
    const p = await provider();
    const { hit, raw } = p === 'google' ? await googleGeocode(address, await googleKey()) : await nominatimGeocode(address);
    if (hit && (hit.lat == null || hit.lng == null)) return null;
    await cachePut(key, hit, p === 'google' ? 'google' : 'nominatim', raw);
    return hit ? { lat: hit.lat, lng: hit.lng, provider: hit.provider, place_id: hit.place_id } : null;
  } catch (e) { warn(`geocode("${key}") failed:`, e.message); return null; }
}

/** Address suggestions for the OSM fallback autocomplete (server-side proxy: queue + cache). Max 5 results. */
async function suggest(q, limit = 5) {
  const key = 'suggest:' + normalise(q);
  const n = Math.max(1, Math.min(5, Number(limit) || 5));
  if (key.length < 'suggest:'.length + 2) return [];
  try {
    const cached = await cacheGet(key);
    if (cached && cached.raw && Date.now() - new Date(cached.created_at).getTime() < SUGGEST_TTL_MS) return (cached.raw || []).slice(0, n);
    const rows = await nominatimSearch(q, 5, true);
    const out = (Array.isArray(rows) ? rows : []).map(r => {
      const a = r.address || {};
      const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(' ');
      const provName = String(a.state || a.province || '').toLowerCase();
      return {
        label: r.display_name, lat: num(r.lat), lng: num(r.lon), place_id: r.place_id != null ? String(r.place_id) : null,
        street: street || '', city: a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb || '',
        province: PROVINCE_BY_NAME[provName] || '', postal_code: a.postcode ? String(a.postcode).toUpperCase() : '',
      };
    }).filter(s => s.lat != null && s.lng != null);
    await cachePut(key, null, 'nominatim', out);
    return out.slice(0, n);
  } catch (e) { warn(`suggest("${q}") failed:`, e.message); return []; }
}

// ---------------------------------------------------------------- location rows
/** Candidate query strings for a location row, most specific first (Nominatim often misses unit/postal combos). */
function candidates(l) {
  const prov = C.PROVINCE_NAME[l.province] || l.province || '';
  const list = [];
  if (l.street_address) list.push([l.street_address, l.city, prov, l.postal_code, 'Canada']);
  if (l.street_address) list.push([l.street_address, l.city, prov, 'Canada']);
  if (l.postal_code) list.push([l.postal_code, l.city, prov, 'Canada']);
  list.push([l.city, prov, 'Canada']);
  return [...new Set(list.map(parts => parts.filter(Boolean).join(', ')))].filter(Boolean);
}
async function geocodeRow(l) {
  for (const q of candidates(l)) {
    const hit = await geocode(q);
    if (hit) return hit;
  }
  return null;
}

/** Fill job_locations.lat/lng for one row. Prefers the linked employer_location, then the cache, then the network. */
async function geocodeJobLocation(id) {
  try {
    const l = await db.one('SELECT * FROM job_locations WHERE id = $1', [id]);
    if (!l) return null;
    if (l.lat != null && l.lng != null) return { lat: l.lat, lng: l.lng, provider: l.geocode_provider, place_id: l.place_id };
    let hit = null;
    if (l.employer_location_id) {
      const e = await db.one('SELECT lat, lng, place_id FROM employer_locations WHERE id = $1 AND lat IS NOT NULL', [l.employer_location_id]);
      if (e) hit = { lat: e.lat, lng: e.lng, provider: 'copy', place_id: e.place_id };
    }
    if (!hit) hit = await geocodeRow(l);
    if (!hit) return null;
    await db.query('UPDATE job_locations SET lat=$2, lng=$3, geocoded_at=now(), geocode_provider=$4, place_id=$5 WHERE id=$1', [id, hit.lat, hit.lng, hit.provider, hit.place_id || null]);
    return hit;
  } catch (e) { warn(`geocodeJobLocation(${id})`, e.message); return null; }
}

/** Fill employer_locations.lat/lng for one row and copy it onto any linked job_locations still missing coordinates. */
async function geocodeEmployerLocation(id) {
  try {
    const l = await db.one('SELECT * FROM employer_locations WHERE id = $1', [id]);
    if (!l) return null;
    let hit = l.lat != null && l.lng != null ? { lat: l.lat, lng: l.lng, provider: 'existing', place_id: l.place_id } : await geocodeRow(l);
    if (!hit) return null;
    if (hit.provider !== 'existing') await db.query('UPDATE employer_locations SET lat=$2, lng=$3, geocoded_at=now(), place_id=$4 WHERE id=$1', [id, hit.lat, hit.lng, hit.place_id || null]);
    await db.query(`UPDATE job_locations SET lat=$2, lng=$3, geocoded_at=now(), geocode_provider='copy', place_id=$4 WHERE employer_location_id=$1 AND lat IS NULL`, [id, hit.lat, hit.lng, hit.place_id || null]);
    return hit;
  } catch (e) { warn(`geocodeEmployerLocation(${id})`, e.message); return null; }
}

/**
 * Backlog: geocode up to `limit` employer_locations + `limit` job_locations that have no coordinates.
 * Active/public postings first. Returns counts; never throws.
 */
async function geocodeMissing({ limit = 100 } = {}) {
  const out = { provider: await provider(), employer_locations: { tried: 0, done: 0 }, job_locations: { tried: 0, done: 0 }, remaining: 0 };
  try {
    const emp = await db.many('SELECT id FROM employer_locations WHERE lat IS NULL AND NOT archived ORDER BY is_default DESC, id LIMIT $1', [limit]);
    for (const r of emp) { out.employer_locations.tried++; if (await geocodeEmployerLocation(r.id)) out.employer_locations.done++; }
    const jobs = await db.many(`SELECT l.id FROM job_locations l JOIN jobs j ON j.id = l.job_id WHERE l.lat IS NULL
      ORDER BY (j.status = 'active' AND j.expires_at > now()) DESC, l.job_id DESC, l.sort_order LIMIT $1`, [limit]);
    for (const r of jobs) { out.job_locations.tried++; if (await geocodeJobLocation(r.id)) out.job_locations.done++; }
    const rem = await db.one('SELECT (SELECT count(*) FROM job_locations WHERE lat IS NULL)::int + (SELECT count(*) FROM employer_locations WHERE lat IS NULL AND NOT archived)::int AS n');
    out.remaining = rem ? rem.n : 0;
    log('geocodeMissing', JSON.stringify(out));
  } catch (e) { warn('geocodeMissing', e.message); out.error = e.message; }
  return out;
}

/** Great-circle distance in km (Haversine) — the JS twin of the SQL in routes/public.js. */
function distanceKm(a, b) {
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

module.exports = { provider, publicMapConfig, geocode, suggest, geocodeJobLocation, geocodeEmployerLocation, geocodeMissing, distanceKm, candidates, normalise, OSM_TILES, NOMINATIM_UA };
