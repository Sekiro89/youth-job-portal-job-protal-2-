# Maps, geocoding and address autocomplete

Built for client feedback round 2 (PDF, 2026-09-10, decision 8). Files: `lib/geocode.js`, `jobs/geocode.js`,
`public/js/maps.js`, `public/css/maps.css`, `public/vendor/leaflet/**` (Leaflet 1.9.4, vendored — never loaded from a CDN),
`routes/public.js` (search/geo/suggest routes), `views/public/{job,jobs,company,_job-card}.ejs`.

## 1. Provider switch

`lib/geocode.provider()` returns `'google'` when the settings key `google_maps_api_key` is non-empty **and**
`maps_provider` is not `osm`; otherwise `'osm'`. Both keys live in `lib/settings` (DB > env > default), so the client
changes them at **/admin/integrations → Maps** with no restart (settings cache is 5 s).

| | Google (key present) | OSM fallback (default, no key) |
|---|---|---|
| Map tiles | Google Maps JavaScript API (`google.maps.Map`, classic `google.maps.Marker`) | Leaflet 1.9.4 + `https://{s}.tile.openstreetmap.org` tiles, OSM attribution |
| Geocoding (server) | Geocoding API, `region=ca&components=country:CA` | Nominatim `search?format=jsonv2&countrycodes=ca&limit=1` |
| Address autocomplete (forms) | Places `PlaceAutocompleteElement` (new API), falls back to legacy `places.Autocomplete` if the element class is missing | Debounced (350 ms) lookup through **our** proxy `GET /api/geocode/suggest?q=` (Nominatim, max 5, cached) |
| Browser failure | If the Google script fails (bad key, referrer, quota) `CCMaps` logs a warning and falls back to Leaflet/OSM automatically | — |

`maps_provider` values: `auto` (default: Google if a key exists), `google`, `osm` (force OpenStreetMap even with a key).

The Google key is sent to the browser (`window.CC_MAPS.googleKey`) and used server-side for Geocoding: create it as a
**browser key restricted by HTTP referrer** (see §2). Server calls send `key=` as well, so Google must allow the server
too — either leave "Application restrictions" at *Websites* and add both `canadacareers.jobs/*` and `*.khosha.tech/*`, or
(cleaner) create a second, IP-restricted key and paste it into `GOOGLE_MAPS_API_KEY` in `.env` while the browser key goes
in the admin panel (DB wins for the browser; env is used only when the DB value is empty — so for two keys, ask the
orchestrator to split the setting; today one key serves both).

## 2. What the client must set up in Google Cloud (only if they want Google maps)

1. Create/select a project at <https://console.cloud.google.com>, attach a **billing account** (required even inside the
   free tier).
2. **APIs & Services → Library**, enable: **Maps JavaScript API**, **Places API (New)** (and the legacy **Places API** for
   older projects), **Geocoding API**.
3. **Credentials → Create credentials → API key**. Under *Application restrictions* choose **Websites** and add
   `https://canadacareers.jobs/*` (plus any staging host). Under *API restrictions* select only the three APIs above.
4. Paste the key into **/admin/integrations → Maps → Google Maps API key** and leave *Map provider* on `auto`.
5. Open any job page: the map should now be Google. Check the browser console for `RefererNotAllowedMapError` /
   `ApiNotActivatedMapError` if it silently falls back to OpenStreetMap.

Cost notes (2025 pricing, CAD varies): every SKU has a monthly free allowance (10k map loads, 10k geocodes, 10k
autocomplete sessions); beyond that ≈ US$7 per 1,000 map loads, US$5 per 1,000 geocodes, US$2.83 per 1,000 autocomplete
sessions. Our caching means each distinct address is geocoded **once ever**; the search map loads on every desktop
/jobs view (one map load per page view). Set a budget alert in Google Cloud Billing.

## 3. OpenStreetMap / Nominatim usage policy compliance

- <https://operations.osmfoundation.org/policies/nominatim/>: max **1 request per second**, a valid **User-Agent**,
  no bulk geocoding, cache results. `lib/geocode.js` serialises every Nominatim call through one module-level queue with
  a 1.1 s gap, sends `User-Agent: CanadaCareersBot/1.0 (+https://canadacareers.jobs/about)` and writes every answer
  (including "no result", retried after 7 days) into `geocode_cache`. Suggestions are cached for 30 days.
- The browser never calls Nominatim: autocomplete goes through `/api/geocode/suggest` (same queue + cache, 2+ chars,
  max 5 results, 40 requests/minute per IP → 429).
- Tile policy <https://operations.osmfoundation.org/policies/tiles/>: fine for this traffic level; attribution is
  rendered on every map. If traffic grows past a few thousand map views a day, move to a commercial tile host
  (MapTiler / Stadia — change `OSM_TILES` in `lib/geocode.js` and add the host to `connectSrc`/`imgSrc` in `server.js`).
- Nominatim is a poor *autocompleter* (it needs fairly complete strings, e.g. "2400 Derry Rd E Mississauga"); Google
  Places is much better for partial input. That is the main user-facing difference between the two providers.

## 4. Data model + backlog geocoder

- `employer_locations.lat/lng/geocoded_at/place_id` and `job_locations.lat/lng/geocoded_at/geocode_provider/place_id`
  (`geocode_provider` = `google` | `nominatim` | `copy` (copied from the linked employer_location) | `manual`).
- `geocode_cache(query PK, lat, lng, provider, place_id, raw, created_at)` — key is the normalised address
  (`lower`, collapsed whitespace); suggestion lists are stored under `suggest:<q>`.
- Query chain per row (most specific first, each step cached separately): `street, city, province, postal, Canada` →
  without postal → `postal, city, province` → `city, province`. Imported Job Bank rows (no street) resolve to the city
  centroid.

API (`lib/geocode.js`, nothing throws):
```js
const geo = require('./lib/geocode');
await geo.geocode('2400 Derry Rd E, Mississauga, ON L5S 1B1'); // { lat, lng, provider, place_id } | null
await geo.geocodeEmployerLocation(id);   // portal calls this after saving a location (lazy require + try/catch)
await geo.geocodeJobLocation(id);        // prefers the linked employer_location, then cache, then network
await geo.geocodeMissing({ limit: 100 }); // { provider, employer_locations:{tried,done}, job_locations:{tried,done}, remaining }
await geo.suggest('1055 W Hastings', 5); // [{ label, lat, lng, street, city, province, postal_code, place_id }]
await geo.publicMapConfig();             // { provider, googleKey, tiles } -> window.CC_MAPS
```

Backlog: `node jobs/geocode.js [--limit=100]` (also runs inside the daily `jobs/run.js`). With Nominatim expect
~1.1 s per network call; repeated addresses are free. Switching provider later: existing coordinates are kept; only
rows with `lat IS NULL` are (re)geocoded. To force a re-geocode: `UPDATE job_locations SET lat=NULL, lng=NULL WHERE …`.

## 5. Public pages

- **Job page**: "Work location(s)" list gets an *Open in Google Maps* link per address
  (`https://www.google.com/maps/search/?api=1&query=<address>` — works with no key) and a map with one pin per
  geocoded location; when none are geocoded a "Map unavailable" note is shown instead. Print view hides all maps
  (`@media print` in `maps.css`). JSON-LD: `Place.geo` (GeoCoordinates) per location, `workHours` when hours are set,
  `industry` = the employer's sector.
- **Search `/jobs`**: `near=<place>` (geocoded server-side, cached), or `lat=&lng=` (browser geolocation via the
  *Near me* button), plus `radius_km` ∈ {10, 25, 50, 100} (default 25). A posting matches when **any** work location
  is inside the radius (Haversine in SQL over `job_locations.lat/lng`, with a bounding-box prefilter so the partial index
  is used); results sort nearest-first and cards show "≈ 12 km" (distance to the nearest location). `view=map` opens the
  map view on mobile; on ≥1024 px the map is always beside the list (sticky). Proximity searches are `noindex`.
- **`GET /api/jobs/geo?…same filters…`** → `{ point, count, capped, markers:[{ id, slug, url, title, company, address,
  lat, lng, salary, distance_km, reference }] }` — one marker per geocoded work location of every PUBLIC posting,
  capped at 200. Only `PUBLIC_WHERE` jobs, ever.
- **Company page**: map of the employer's address book (`employer_locations`, non-archived) + list with Google Maps links;
  Organization JSON-LD gains `location[]` with `geo`.

## 6. Browser contract for other agents' forms (`public/js/maps.js`)

Add to the page: `extraCss: ['/css/maps.css']`, `extraJs: ['/js/maps.js']` and, before them, the provider config:
```ejs
<script>window.CC_MAPS = <%- JSON.stringify(mapConfig).replace(/</g, '\\u003c') %>;</script>
<!-- route: mapConfig: await require('../lib/geocode').publicMapConfig() -->
```
(without `CC_MAPS` the module assumes OSM — maps still work, Google is simply never tried.)

Address autocomplete — zero JS needed in the portal:
```html
<input name="street_address" data-address-autocomplete
       data-autofill='{"city":"#loc-city","province":"#loc-province","postal_code":"#loc-postal","lat":"[name=lat]","lng":"[name=lng]","place_id":"[name=place_id]"}'>
```
`maps.js` auto-initialises every `[data-address-autocomplete]` on DOMContentLoaded. `data-autofill` maps
`street | unit | city | province | postal_code | lat | lng | place_id` → CSS selectors (or plain field names) inside the
same form; missing keys default to inputs named `street_address, city, province, postal_code, lat, lng, place_id`.
Province is filled as the 2-letter code (works for `<select>`s by value or label). On pick the input dispatches
`ccmaps:pick` with `{ detail: place }`. Programmatic use: `CCMaps.autocomplete(inputEl, onPick)`.
Google's `PlaceAutocompleteElement` is inserted **before** the input (it cannot attach to an existing input); style it
via `gmp-place-autocomplete.cc-pac` in `maps.css`.

Maps: `<div class="cc-map" data-map data-zoom="14" data-markers="<%= JSON.stringify(markers) %>"></div>` auto-inits;
or `CCMaps.init(el, { markers:[{lat,lng,title,company,address,url,html}], fit:true })` → `{ provider, map,
setMarkers(list), fit(), invalidate(), destroy() }`. `CCMaps.locate()` wraps `navigator.geolocation`.

## 7. CSP (server.js, orchestrator-owned)

Already allows: `script-src maps.googleapis.com maps.gstatic.com`, `connect-src maps.googleapis.com *.tile.openstreetmap.org`,
`img-src https:` (tiles + Google sprites), `worker-src blob:`, `style-src 'unsafe-inline'` (Leaflet/Google inline styles),
fonts from Google. Verified with headless Chromium (`Log.entryAdded`): no CSP violations on job, jobs, company pages.

## 8. Known limits / untested

- **Google path is untested live** (no key on this server). Written against the current Maps JS API
  (`loading=async` + callback, classic `Marker`, `PlaceAutocompleteElement` with `gmp-select` and the older
  `gmp-placeselect`, legacy `Autocomplete` fallback). First thing to check with a real key: job page map renders,
  autocomplete fills city/province/postal, server geocode returns `provider: 'google'`.
- Two postings at the same address produce overlapping pins (no clustering by design; cap 200).
- The search map re-fetches on every filter change via page load (no live panning search).
