/* Canada Careers — public page enhancements (filters toggle, sort auto-submit, share). Progressive: pages work without this file. */
(function () {
  'use strict';

  // Graceful image fallback (inline onerror is blocked by CSP script-src-attr). data-fallback="<class to add to parent>"
  document.querySelectorAll('img[data-fallback]').forEach(function (img) {
    var fail = function () { var cls = img.getAttribute('data-fallback'); if (cls) img.parentNode.classList.add(cls); img.remove(); };
    if (img.complete && img.naturalWidth === 0) fail(); else img.addEventListener('error', fail);
  });

  // Mobile filters panel
  var filters = document.querySelector('.filters');
  var toggle = filters && filters.querySelector('.filters__toggle');
  if (filters && toggle) {
    toggle.addEventListener('click', function () {
      var open = filters.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        var firstField = filters.querySelector('input, select');
        if (firstField && window.innerWidth < 1024) firstField.focus({ preventScroll: true });
      }
    });
  }

  // Sort select lives outside the form (form="filters-body"); submit on change.
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () {
      var form = el.form || document.getElementById(el.getAttribute('form'));
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    });
  });

  // ---------------------------------------------------------------- job search: "Near me", list/map toggle, results map
  // Relies on window.CCMaps (maps.js, loaded before this file). Everything degrades: without JS the form still works.
  var results = document.querySelector('[data-results]');
  var searchForm = document.querySelector('[data-search-form]');
  if (searchForm) {
    var nearInput = searchForm.querySelector('[data-near-input]');
    var latField = searchForm.querySelector('[data-near-lat]');
    var lngField = searchForm.querySelector('[data-near-lng]');
    var nearStatus = searchForm.querySelector('[data-near-status]');
    var nearBtn = searchForm.querySelector('[data-near-me]');
    var setStatus = function (msg, isError) { if (!nearStatus) return; nearStatus.textContent = msg || ''; nearStatus.classList.toggle('is-error', !!isError); };
    // A typed place replaces a browser point (the server prefers `near` anyway; keep the URL clean).
    if (nearInput) nearInput.addEventListener('input', function () { if (latField) latField.value = ''; if (lngField) lngField.value = ''; if (nearStatus && nearStatus.textContent) setStatus(''); });
    if (nearBtn) {
      if (!navigator.geolocation) nearBtn.hidden = true;
      nearBtn.addEventListener('click', function () {
        if (!window.CCMaps) return setStatus('Location is unavailable right now.', true);
        nearBtn.disabled = true; setStatus('Finding your location…');
        window.CCMaps.locate().then(function (p) {
          if (latField) latField.value = p.lat.toFixed(5);
          if (lngField) lngField.value = p.lng.toFixed(5);
          if (nearInput) nearInput.value = '';
          setStatus('Using your current location.');
          searchForm.requestSubmit ? searchForm.requestSubmit() : searchForm.submit();
        }).catch(function (e) { nearBtn.disabled = false; setStatus(e.message || 'Could not determine your location.', true); });
      });
    }
  }
  if (results && window.CCMaps) {
    var mapEl = results.querySelector('[data-results-map]');
    var note = results.querySelector('[data-map-note]');
    var viewField = document.querySelector('[data-view-field]');
    var geoUrl = results.getAttribute('data-geo-url');
    var desktop = window.matchMedia('(min-width: 1024px)');
    var mapHandle = null, loading = null;
    var loadMap = function () {
      if (mapHandle) { mapHandle.invalidate(); return Promise.resolve(mapHandle); }
      if (loading) return loading;
      var pointLat = Number(mapEl.getAttribute('data-point-lat')), pointLng = Number(mapEl.getAttribute('data-point-lng'));
      var hasPoint = mapEl.hasAttribute('data-point-lat') && isFinite(pointLat) && isFinite(pointLng);
      loading = fetch(geoUrl, { headers: { accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : { markers: [] }; }).catch(function () { return { markers: [] }; })
        .then(function (data) {
          var markers = data.markers || [];
          return window.CCMaps.init(mapEl, { markers: markers, fit: true, center: hasPoint ? { lat: pointLat, lng: pointLng } : undefined, zoom: hasPoint ? 11 : undefined, maxZoom: 13 }).then(function (h) {
            mapHandle = h;
            // Search centre + radius ring (Leaflet only; Google draws nothing extra to keep the classic-marker path simple).
            if (hasPoint && h.provider === 'osm' && window.L) {
              var radius = Number(mapEl.getAttribute('data-point-radius')) || 25;
              window.L.circle([pointLat, pointLng], { radius: radius * 1000, color: '#1F3A5F', weight: 1, fillColor: '#1F3A5F', fillOpacity: 0.06, interactive: false }).addTo(h.map);
              window.L.circleMarker([pointLat, pointLng], { radius: 6, color: '#fff', weight: 2, fillColor: '#D42E2E', fillOpacity: 1 }).addTo(h.map).bindTooltip(mapEl.getAttribute('data-point-label') || 'Search centre');
              if (!markers.length) h.map.setView([pointLat, pointLng], 10);
            }
            if (note) note.textContent = markers.length ? (markers.length + ' pin' + (markers.length === 1 ? '' : 's') + (data.capped ? ' (showing the first 200)' : '') + ' · click a pin for details.') : 'No mapped locations for these results yet.';
            return h;
          });
        }).catch(function (e) { console.warn('[jobs map]', e.message); if (note) note.textContent = 'Map unavailable right now.'; });
      return loading;
    };
    var setView = function (v) {
      var isMap = v === 'map';
      results.classList.toggle('is-map', isMap);
      results.querySelectorAll('.view-toggle [data-view]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-view') === v ? 'true' : 'false'); });
      if (viewField) viewField.value = isMap ? 'map' : '';
      try { var u = new URL(window.location.href); if (isMap) u.searchParams.set('view', 'map'); else u.searchParams.delete('view'); history.replaceState(null, '', u.toString()); } catch (e) {}
      if (isMap || desktop.matches) loadMap().then(function (h) { if (h) setTimeout(function () { h.invalidate(); }, 50); });
    };
    results.querySelectorAll('.view-toggle [data-view]').forEach(function (b) { b.addEventListener('click', function () { setView(b.getAttribute('data-view')); }); });
    if (desktop.matches || results.classList.contains('is-map')) loadMap();
    var onChange = function (e) { if (e.matches) loadMap(); };
    if (desktop.addEventListener) desktop.addEventListener('change', onChange); else if (desktop.addListener) desktop.addListener(onChange);
  }

  // Share: copy link (LinkedIn / X / email are plain links)
  document.querySelectorAll('[data-share="copy"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var url = btn.getAttribute('data-url') || window.location.href;
      var status = btn.parentNode.querySelector('.share__status');
      var done = function (ok) { if (status) { status.textContent = ok ? 'Link copied' : 'Copy failed — press Ctrl+C'; setTimeout(function () { status.textContent = ''; }, 2500); } };
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        navigator.share({ title: document.title, url: url }).catch(function () {});
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
      } else {
        var ta = document.createElement('textarea'); ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { done(document.execCommand('copy')); } catch (e) { done(false); }
        document.body.removeChild(ta);
      }
    });
  });
})();
