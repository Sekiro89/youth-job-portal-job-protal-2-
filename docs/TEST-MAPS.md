# Maps + proximity search — test log (2026-09-10)

Instance: `NODE_ENV=development … DATABASE_URL=…/cc_public PORT=3901`. Provider: **osm** (no Google key). Screenshots in
`shots/maps/` (`REPORT.txt` = per-page tile/marker/overflow/console audit from headless Chromium via `scripts/cdp.js`).

## Server-side geocoding (Nominatim)
| Check | Result |
|---|---|
| `geocode('2400 Derry Rd E, Mississauga, ON L5S 1B1')` | `{ lat: 43.6914017, lng: -79.6566515, provider: 'nominatim', place_id: '347542470' }` |
| Same call again | served from `geocode_cache` (no network; verified by timing + cache row) |
| `node jobs/geocode.js --limit=50` on cc_public | `employer_locations 3/3, job_locations 14/14, remaining 0` in 14.4 s (7 distinct queries, rest cache hits) |
| Job Bank rows without street (Brampton, Regina, Burnaby) | resolved to city centroids via the `city, province` fallback |
| `suggest('2400 Derry Rd E Mississauga')` | 1 result with street/city/province=ON/postal parsed |
| DB password trap | `docs/.dbpw` has two lines — use `head -1 docs/.dbpw | cut -d= -f2` (the doc's one-liner concatenates both lines and auth fails) |

## HTTP
| URL | Expect | Got |
|---|---|---|
| `/jobs?near=Brampton, ON&radius_km=25` | Brampton + Mississauga jobs, sorted by distance, "≈ km" on cards | 3 jobs: `< 1 km`, `≈ 8 km`, `≈ 8 km`; heading "All jobs within 25 km of Brampton, ON"; chip removes the point |
| `/jobs?lat=43.7&lng=-79.7&radius_km=10` | browser-point path | 3 jobs, "within 10 km of you", status "Using your current location." |
| `/jobs?near=zzqxv nowhere` | graceful | all 8 jobs + "couldn't find … try a city and province" + chip `Near “…” (not found)` |
| `/jobs?lat=999&lng=abc` | ignored | 200, unfiltered |
| `/api/jobs/geo?near=Brampton, ON` | JSON markers | `point{43.6858,-79.7599,radius 25}`, 3 markers with distance_km 0 / 8.4 / 8.4 |
| `/api/jobs/geo` | all public | 10 markers (14 location rows, 8 public jobs → multi-location posting yields 3), `capped:false` |
| `/api/geocode/suggest?q=a` | too short | `{results:[]}` |
| `/jobs/full-stack-developer-node-react-vancouver-hyhg` | map data + links + JSON-LD | `data-markers` with 3 pins, 3 × "Open in Google Maps", `geo` on 3 Places, `workHours: "37.5 hours per week"`, `industry` |
| `/companies/maple-byte-software` | address book + map | "Location" block, 1 pin, Organization `location[]` with geo, industry via `h.industryName` |
| Static `/js/maps.js /css/maps.css /vendor/leaflet/*` | 200 | 200 |

## Browser (headless Chromium, real 390/1440 viewports, `Log.entryAdded` + `Runtime.exceptionThrown` captured)
| Page | 390 | 1440 | Notes |
|---|---|---|---|
| Job page | tiles 4, markers 3, no overflow | tiles 8, markers 3 | Leaflet map under "Work locations (3)", pins Vancouver/Burnaby/Surrey, hours chip, Industry row, "Operated by …" |
| /jobs near Brampton | list view (no map loaded until toggled) · map view: tiles 6, markers 3 | tiles 12, markers 3, map sticky beside list | red search-centre dot + 25 km ring, "Nearest first" sort |
| /jobs (all) | — | tiles 8, markers 10 | Canada-wide fit |
| Company | tiles 6, markers 1 | tiles 8, markers 1 | |
| Autocomplete (near box given `data-address-autocomplete` at runtime) | — | 1 suggestion "2400 Derry Road East, Mississauga"; ArrowDown+Enter autofilled city=Mississauga, province=ON | OSM/Nominatim path |
| Console | **0 CSP violations, 0 exceptions** on all pages | | |

## Not tested
- Google Maps / Places / Geocoding paths (no key). See docs/MAPS.md §8.
- Real device geolocation prompt (the "Near me" button was exercised only through the resulting `?lat=&lng=` URL).
- Print output with maps (CSS hides `.cc-map` / `.map-block` under `@media print`; not re-rendered to PDF this round).
