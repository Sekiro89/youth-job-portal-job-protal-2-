/* Canada Careers — maps + address autocomplete (single file, no build step).
 *
 * Provider comes from window.CC_MAPS = { provider: 'google'|'osm', googleKey, tiles: { url, attribution, maxZoom } }
 * (rendered by the server from lib/geocode.publicMapConfig()). Without CC_MAPS the module assumes OSM/Leaflet.
 *
 *   CCMaps.init(el, { markers: [{ lat, lng, title, html }], fit: true, zoom }) -> Promise<mapHandle>
 *       mapHandle: { provider, map, setMarkers(list), fit(), destroy() }
 *   CCMaps.autocomplete(inputEl, onPick) -> Google Places autocomplete (country CA) or, on OSM, a debounced
 *       Nominatim lookup through GET /api/geocode/suggest?q=  (server-side proxy: queue + cache, max 5 results).
 *       On pick, fields are filled through a data-autofill mapping (see docs/MAPS.md), then onPick(place) is called.
 *
 * Auto-init on DOMContentLoaded:
 *   [data-map]                    -> CCMaps.init(el, { markers: JSON.parse(el.dataset.markers || '[]') })
 *   [data-address-autocomplete]   -> CCMaps.autocomplete(input)
 *
 * Google path uses the classic google.maps.Marker (AdvancedMarkerElement would require a mapId) and prefers the new
 * PlaceAutocompleteElement (legacy places.Autocomplete is unavailable to Google customers created after March 2025),
 * falling back to the legacy widget when the element class is missing.
 */
(function () {
  'use strict';
  var cfg = window.CC_MAPS || {};
  var provider = cfg.provider === 'google' && cfg.googleKey ? 'google' : 'osm';
  var tiles = cfg.tiles || { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors', maxZoom: 19 };
  var LEAFLET_JS = '/vendor/leaflet/leaflet.js', LEAFLET_CSS = '/vendor/leaflet/leaflet.css';
  var CANADA = { lat: 56.1, lng: -96.0, zoom: 3 };
  var PROVINCE_CODE = { 'alberta': 'AB', 'british columbia': 'BC', 'manitoba': 'MB', 'new brunswick': 'NB', 'newfoundland and labrador': 'NL', 'nova scotia': 'NS', 'northwest territories': 'NT', 'nunavut': 'NU', 'ontario': 'ON', 'prince edward island': 'PE', 'quebec': 'QC', 'québec': 'QC', 'saskatchewan': 'SK', 'yukon': 'YT' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function provinceCode(v) { if (!v) return ''; var s = String(v).trim(); if (/^[A-Z]{2}$/i.test(s)) return s.toUpperCase(); return PROVINCE_CODE[s.toLowerCase()] || s; }

  // ---------------------------------------------------------------- loaders (each script/css loaded once)
  var loads = {};
  function loadScript(src, attrs) {
    if (loads[src]) return loads[src];
    loads[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script'); s.src = src; s.async = true;
      Object.keys(attrs || {}).forEach(function (k) { s.setAttribute(k, attrs[k]); });
      s.onload = function () { resolve(); }; s.onerror = function () { delete loads[src]; reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
    return loads[src];
  }
  function loadCss(href) {
    if (loads[href]) return loads[href];
    loads[href] = new Promise(function (resolve) {
      if (document.querySelector('link[href="' + href + '"]')) return resolve();
      var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = function () { resolve(); }; l.onerror = function () { resolve(); };
      document.head.appendChild(l);
    });
    return loads[href];
  }
  function ensureLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    return Promise.all([loadCss(LEAFLET_CSS), loadScript(LEAFLET_JS)]).then(function () { if (!window.L) throw new Error('Leaflet did not load'); return window.L; });
  }
  var googleReady = null;
  function ensureGoogle() {
    if (window.google && window.google.maps && window.google.maps.Map) return Promise.resolve(window.google.maps);
    if (googleReady) return googleReady;
    googleReady = new Promise(function (resolve, reject) {
      var cb = '__ccGoogleMapsReady';
      var timer = setTimeout(function () { reject(new Error('Google Maps did not load (check the key, referrer restrictions and enabled APIs)')); }, 15000);
      window[cb] = function () { clearTimeout(timer); delete window[cb]; resolve(window.google.maps); };
      var src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(cfg.googleKey) + '&libraries=places&loading=async&callback=' + cb + '&region=CA&language=en';
      loadScript(src).catch(function (e) { clearTimeout(timer); reject(e); });
    });
    googleReady.catch(function () { googleReady = null; });
    return googleReady;
  }

  // ---------------------------------------------------------------- map
  // custom pin: an orange-to-red gradient teardrop (brand mark), not Leaflet's/Google's default blue —
  // hex values match --cc-orange / --cc-red / --cc-navy in theme.css; keep in sync if the palette changes.
  var PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40">' +
    '<defs><linearGradient id="ccPinGrad" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#FF9317"/><stop offset="100%" stop-color="#DC4A3D"/>' +
    '</linearGradient></defs>' +
    '<path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 25 15 25s15-14.5 15-25C30 6.7 23.3 0 15 0z" fill="url(#ccPinGrad)" stroke="#1C3350" stroke-width="1.5"/>' +
    '<circle cx="15" cy="15" r="5.5" fill="#fff"/>' +
    '</svg>';
  var PIN_URL = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(PIN_SVG);

  function popupHtml(m) {
    if (m.html) return m.html;
    var h = '<div class="cc-popup">';
    if (m.url) h += '<a class="cc-popup__title" href="' + esc(m.url) + '">' + esc(m.title || 'Job') + '</a>';
    else if (m.title) h += '<strong class="cc-popup__title">' + esc(m.title) + '</strong>';
    if (m.company) h += '<div class="cc-popup__co">' + esc(m.company) + '</div>';
    if (m.address) h += '<div class="cc-popup__addr">' + esc(m.address) + '</div>';
    var bits = [];
    if (m.salary) bits.push(esc(m.salary));
    if (m.distance_km != null) bits.push('&asymp; ' + esc(Math.round(m.distance_km)) + ' km');
    if (bits.length) h += '<div class="cc-popup__meta">' + bits.join(' &middot; ') + '</div>';
    if (m.url) h += '<a class="cc-popup__link" href="' + esc(m.url) + '">View job &rarr;</a>';
    return h + '</div>';
  }
  function validMarkers(list) { return (list || []).filter(function (m) { return m && isFinite(m.lat) && isFinite(m.lng); }).map(function (m) { m.lat = Number(m.lat); m.lng = Number(m.lng); return m; }); }
  function noteEmpty(el, list) {
    var n = el.querySelector('.cc-map__empty');
    if (!list.length) { if (!n) { n = document.createElement('div'); n.className = 'cc-map__empty'; n.textContent = el.getAttribute('data-empty') || 'No mapped locations for these results yet.'; el.appendChild(n); } }
    else if (n) n.remove();
  }

  function initLeaflet(el, opts) {
    return ensureLeaflet().then(function (L) {
      var map = L.map(el, { scrollWheelZoom: opts.scrollWheelZoom !== undefined ? opts.scrollWheelZoom : false, zoomControl: true });
      L.tileLayer(tiles.url, { attribution: tiles.attribution, maxZoom: tiles.maxZoom || 19 }).addTo(map);
      var layer = L.layerGroup().addTo(map);
      var pinIcon = L.icon({ iconUrl: PIN_URL, iconSize: [30, 40], iconAnchor: [15, 40], popupAnchor: [0, -36] });
      var handle = {
        provider: 'osm', map: map, markers: [],
        setMarkers: function (list) {
          layer.clearLayers(); handle.markers = validMarkers(list);
          handle.markers.forEach(function (m) { var mk = L.marker([m.lat, m.lng], { title: m.title || '', icon: pinIcon }); mk.bindPopup(popupHtml(m), { maxWidth: 280 }); mk.addTo(layer); });
          noteEmpty(el, handle.markers);
          if (opts.fit !== false) handle.fit();
        },
        fit: function () {
          var ms = handle.markers;
          if (!ms.length) { map.setView([opts.center ? opts.center.lat : CANADA.lat, opts.center ? opts.center.lng : CANADA.lng], opts.center ? (opts.zoom || 10) : CANADA.zoom); return; }
          if (ms.length === 1) { map.setView([ms[0].lat, ms[0].lng], opts.zoom || 14); return; }
          map.fitBounds(L.latLngBounds(ms.map(function (m) { return [m.lat, m.lng]; })), { padding: [28, 28], maxZoom: opts.maxZoom || 14 });
        },
        invalidate: function () { map.invalidateSize(); },
        destroy: function () { map.remove(); },
      };
      handle.setMarkers(opts.markers);
      return handle;
    });
  }

  function initGoogle(el, opts) {
    return ensureGoogle().then(function (gm) {
      var map = new gm.Map(el, { center: opts.center || { lat: CANADA.lat, lng: CANADA.lng }, zoom: opts.center ? (opts.zoom || 10) : CANADA.zoom, mapTypeControl: false, streetViewControl: false, fullscreenControl: true, gestureHandling: 'cooperative' });
      var info = new gm.InfoWindow();
      var pins = [];
      var handle = {
        provider: 'google', map: map, markers: [],
        setMarkers: function (list) {
          pins.forEach(function (p) { p.setMap(null); }); pins = []; handle.markers = validMarkers(list);
          handle.markers.forEach(function (m) {
            var pin = new gm.Marker({ position: { lat: m.lat, lng: m.lng }, map: map, title: m.title || '', icon: { url: PIN_URL, scaledSize: new gm.Size(30, 40), anchor: new gm.Point(15, 40) } });
            pin.addListener('click', function () { info.setContent(popupHtml(m)); info.open({ map: map, anchor: pin }); });
            pins.push(pin);
          });
          noteEmpty(el, handle.markers);
          if (opts.fit !== false) handle.fit();
        },
        fit: function () {
          var ms = handle.markers;
          if (!ms.length) { map.setCenter(opts.center || { lat: CANADA.lat, lng: CANADA.lng }); map.setZoom(opts.center ? (opts.zoom || 10) : CANADA.zoom); return; }
          if (ms.length === 1) { map.setCenter({ lat: ms[0].lat, lng: ms[0].lng }); map.setZoom(opts.zoom || 14); return; }
          var b = new gm.LatLngBounds(); ms.forEach(function (m) { b.extend({ lat: m.lat, lng: m.lng }); });
          map.fitBounds(b, 28);
          gm.event.addListenerOnce(map, 'idle', function () { if (map.getZoom() > (opts.maxZoom || 14)) map.setZoom(opts.maxZoom || 14); });
        },
        invalidate: function () { gm.event.trigger(map, 'resize'); },
        destroy: function () { pins.forEach(function (p) { p.setMap(null); }); el.innerHTML = ''; },
      };
      handle.setMarkers(opts.markers);
      return handle;
    });
  }

  function init(el, opts) {
    opts = opts || {};
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return Promise.reject(new Error('CCMaps.init: no element'));
    el.classList.add('cc-map', 'cc-map--' + provider);
    var p = provider === 'google' ? initGoogle(el, opts) : initLeaflet(el, opts);
    return p.catch(function (e) {
      // Google failed (bad key / quota / referrer): fall back to Leaflet so the page still shows a map.
      if (provider === 'google') { console.warn('[CCMaps] Google Maps unavailable, falling back to OpenStreetMap:', e.message); el.classList.remove('cc-map--google'); el.classList.add('cc-map--osm'); return initLeaflet(el, opts); }
      el.classList.add('cc-map--failed');
      var n = document.createElement('div'); n.className = 'cc-map__empty'; n.textContent = 'Map unavailable right now.'; el.appendChild(n);
      throw e;
    }).then(function (handle) { el.ccMap = handle; el.dispatchEvent(new CustomEvent('ccmap:ready', { detail: handle })); return handle; });
  }

  // ---------------------------------------------------------------- autocomplete
  // data-autofill = JSON { street, unit, city, province, postal_code, lat, lng, place_id } -> CSS selectors (or field names in
  // the same form). Missing keys default to inputs named street_address / city / province / postal_code / lat / lng / place_id.
  var DEFAULT_FIELDS = { street: 'street_address', city: 'city', province: 'province', postal_code: 'postal_code', lat: 'lat', lng: 'lng', place_id: 'place_id' };
  function resolveTargets(input) {
    var map = {}; try { map = JSON.parse(input.getAttribute('data-autofill') || '{}') || {}; } catch (e) { map = {}; }
    var form = input.form || input.closest('form') || document;
    var out = {};
    // Portal address blocks: <div data-address-form> with inputs tagged data-address-part="street_address|unit|city|province|postal_code"
    var block = input.closest('[data-address-form]');
    if (block && !input.hasAttribute('data-autofill')) {
      var PART = { street: 'street_address', unit: 'unit', city: 'city', province: 'province', postal_code: 'postal_code', lat: 'lat', lng: 'lng', place_id: 'place_id' };
      Object.keys(PART).forEach(function (k) { var el = block.querySelector('[data-address-part="' + PART[k] + '"]'); if (el) out[k] = el; });
      return out;
    }
    Object.keys(DEFAULT_FIELDS).forEach(function (k) {
      var sel = map[k] || DEFAULT_FIELDS[k];
      var el = null;
      if (sel) { try { el = form.querySelector(sel); } catch (e) { el = null; } if (!el) el = form.querySelector('[name="' + sel + '"]'); }
      if (el) out[k] = el;
    });
    return out;
  }
  function fill(targets, place, input) {
    Object.keys(targets).forEach(function (k) {
      var el = targets[k], v = place[k];
      if (v == null) return;
      if (el === input && k !== 'street') return;
      if (el.tagName === 'SELECT') { var opt = Array.prototype.find.call(el.options, function (o) { return o.value.toUpperCase() === String(v).toUpperCase() || o.textContent.trim().toLowerCase() === String(v).toLowerCase(); }); if (opt) el.value = opt.value; }
      else el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (!targets.street && place.street) input.value = place.street;
  }
  function placeFromGoogle(gp) {
    var comps = gp.addressComponents || gp.address_components || [];
    var get = function (type, short) { var c = comps.find(function (x) { return (x.types || []).indexOf(type) >= 0; }); if (!c) return ''; return short ? (c.shortText || c.short_name || '') : (c.longText || c.long_name || ''); };
    var loc = gp.location || (gp.geometry && gp.geometry.location);
    var lat = loc ? (typeof loc.lat === 'function' ? loc.lat() : loc.lat) : null, lng = loc ? (typeof loc.lng === 'function' ? loc.lng() : loc.lng) : null;
    var num = get('street_number'), route = get('route');
    return { street: [num, route].filter(Boolean).join(' '), unit: get('subpremise'), city: get('locality') || get('postal_town') || get('sublocality') || get('administrative_area_level_3'), province: provinceCode(get('administrative_area_level_1', true)), postal_code: get('postal_code').toUpperCase(), lat: lat, lng: lng, place_id: gp.id || gp.place_id || '', label: gp.formattedAddress || gp.formatted_address || '' };
  }

  function googleAutocomplete(input, onPick) {
    return ensureGoogle().then(function (gm) {
      var targets = resolveTargets(input);
      var done = function (place) { fill(targets, place, input); input.dispatchEvent(new CustomEvent('ccmaps:pick', { detail: place })); if (onPick) onPick(place); };
      var PAE = gm.places && gm.places.PlaceAutocompleteElement;
      if (PAE) {
        var pae = null;
        try { pae = new PAE({ includedRegionCodes: ['ca'] }); } catch (e) { try { pae = new PAE({ componentRestrictions: { country: ['ca'] } }); } catch (e2) { pae = null; } }
        if (pae) {
          pae.classList.add('cc-pac'); pae.setAttribute('aria-label', 'Search for an address');
          input.parentNode.insertBefore(pae, input);
          input.classList.add('cc-pac__target');
          var handleSelect = function (ev) {
            var p = null;
            var fetchFields = function (place) { return place.fetchFields({ fields: ['addressComponents', 'location', 'formattedAddress', 'id'] }).then(function () { return place; }); };
            if (ev.placePrediction) p = fetchFields(ev.placePrediction.toPlace());
            else if (ev.place) p = fetchFields(ev.place);
            if (p) p.then(function (place) { done(placeFromGoogle(place)); }).catch(function (e) { console.warn('[CCMaps] place fetch failed', e); });
          };
          pae.addEventListener('gmp-select', handleSelect);
          pae.addEventListener('gmp-placeselect', handleSelect);
          return { provider: 'google', element: pae };
        }
      }
      if (gm.places && gm.places.Autocomplete) {
        var ac = new gm.places.Autocomplete(input, { componentRestrictions: { country: 'ca' }, fields: ['address_components', 'geometry', 'place_id', 'formatted_address'], types: ['address'] });
        ac.addListener('place_changed', function () { var gp = ac.getPlace(); if (gp && (gp.geometry || gp.address_components)) done(placeFromGoogle(gp)); });
        input.setAttribute('autocomplete', 'off');
        return { provider: 'google', widget: ac };
      }
      throw new Error('Places library not available');
    });
  }

  function osmAutocomplete(input, onPick) {
    var targets = resolveTargets(input);
    var list = document.createElement('ul'); list.className = 'cc-suggest'; list.setAttribute('role', 'listbox'); list.hidden = true;
    var wrap = input.parentNode;
    if (getComputedStyle(wrap).position === 'static') wrap.classList.add('cc-suggest-host');
    wrap.insertBefore(list, input.nextSibling);
    input.setAttribute('autocomplete', 'off'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
    var items = [], active = -1, timer = null, ctrl = null, lastQ = '';
    function close() { list.hidden = true; list.innerHTML = ''; items = []; active = -1; input.setAttribute('aria-expanded', 'false'); }
    function render() {
      list.innerHTML = '';
      if (!items.length) return close();
      items.forEach(function (it, i) {
        var li = document.createElement('li'); li.setAttribute('role', 'option'); li.id = 'cc-suggest-' + i; li.className = 'cc-suggest__item' + (i === active ? ' is-active' : '');
        var main = it.street ? it.street + (it.city ? ', ' + it.city : '') : (it.city || it.label.split(',')[0]);
        li.innerHTML = '<span class="cc-suggest__main">' + esc(main) + '</span><span class="cc-suggest__sub">' + esc(it.label) + '</span>';
        li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(i); });
        list.appendChild(li);
      });
      list.hidden = false; input.setAttribute('aria-expanded', 'true');
    }
    function pick(i) {
      var it = items[i]; if (!it) return;
      var place = { street: it.street || '', city: it.city || '', province: provinceCode(it.province), postal_code: it.postal_code || '', lat: it.lat, lng: it.lng, place_id: it.place_id || '', label: it.label };
      close();
      fill(targets, place, input);
      if (!targets.street) input.value = place.street || place.label;
      input.dispatchEvent(new CustomEvent('ccmaps:pick', { detail: place })); if (onPick) onPick(place);
    }
    function lookup() {
      var q = input.value.trim();
      if (q.length < 2) return close();
      if (q === lastQ) return;
      lastQ = q;
      if (ctrl) ctrl.abort(); ctrl = new AbortController();
      fetch('/api/geocode/suggest?q=' + encodeURIComponent(q), { signal: ctrl.signal, headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : { results: [] }; })
        .then(function (d) { if (input.value.trim() !== q) return; items = (d && d.results) || []; active = -1; render(); })
        .catch(function () {});
    }
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(lookup, 350); });
    input.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(active); } }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', function () { setTimeout(close, 150); });
    return Promise.resolve({ provider: 'osm', list: list });
  }

  function autocomplete(input, onPick) {
    if (typeof input === 'string') input = document.querySelector(input);
    if (!input) return Promise.reject(new Error('CCMaps.autocomplete: no input'));
    if (input.__ccAutocomplete) return input.__ccAutocomplete;
    var p = provider === 'google' ? googleAutocomplete(input, onPick).catch(function (e) { console.warn('[CCMaps] Google Places unavailable, using OpenStreetMap suggestions:', e.message); return osmAutocomplete(input, onPick); }) : osmAutocomplete(input, onPick);
    input.__ccAutocomplete = p;
    return p;
  }

  // ---------------------------------------------------------------- browser geolocation helper (used by the search page)
  function locate() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('Your browser does not support location.'));
      navigator.geolocation.getCurrentPosition(function (pos) { resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }); },
        function (err) { reject(new Error(err.code === 1 ? 'Location access was denied.' : 'Could not determine your location.')); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    });
  }

  window.CCMaps = { provider: provider, init: init, autocomplete: autocomplete, locate: locate, popupHtml: popupHtml, esc: esc, provinceCode: provinceCode, ensureLeaflet: ensureLeaflet, ensureGoogle: ensureGoogle };

  function boot() {
    document.querySelectorAll('[data-map]').forEach(function (el) {
      if (el.hasAttribute('data-map-manual')) return;
      var markers = []; try { markers = JSON.parse(el.getAttribute('data-markers') || '[]'); } catch (e) { markers = []; }
      var zoom = Number(el.getAttribute('data-zoom')) || undefined;
      init(el, { markers: markers, fit: true, zoom: zoom }).catch(function (e) { console.warn('[CCMaps]', e.message); });
    });
    document.querySelectorAll('[data-address-autocomplete], [data-address-form] [data-address-part="street_address"]').forEach(function (input) { if (input.__ccmaps) return; input.__ccmaps = true; autocomplete(input).catch(function (e) { console.warn('[CCMaps]', e.message); }); });
  }
  // Portal job form adds address blocks dynamically ("Add a new location"): re-scan when it asks.
  document.addEventListener('ccmaps:rescan', boot);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
