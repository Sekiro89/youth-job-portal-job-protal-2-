/* Canada Careers — /jobs (Find Jobs) behaviour. UX standard §6 (docs/UX-STANDARDS.md, 2026-09-10).
 * Runs after maps.js (window.CCMaps) and public.js (which still owns the "Near me" button + sort auto-submit via
 * [data-search-form] / [data-autosubmit]). Everything here is progressive: without JS the form submits with every
 * field inline and the map simply is not shown.
 *
 *  - phone (<768):   full-screen filters drawer (focus trap, Esc, body scroll lock, live "Show N results")
 *                    List | Map switch (?view=map, history.replaceState; map fills the viewport under the header)
 *  - ≥768:           "More filters" popover (focus trap, Esc, click-outside), map toggle persisted in localStorage
 *                    (cc:jobs-map = show|hide; default: shown on desktop, hidden on tablet)
 *  - the map fetches /api/jobs/geo with the page's filters (data-geo-url) and a pin's popup highlights + scrolls to its row.
 */
(function () {
  'use strict';
  var root = document.querySelector('[data-jsearch]');
  var form = document.getElementById('jobs-form');
  if (!root || !form) return;
  var html = document.documentElement;
  var mqTablet = window.matchMedia('(min-width: 768px)');
  var mqDesktop = window.matchMedia('(min-width: 1024px)');
  var KEY = 'cc:jobs-map';
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var onMq = function (mq, fn) { if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn); };
  var headerH = function () { var v = parseInt(getComputedStyle(html).getPropertyValue('--cc-header-h'), 10); return isFinite(v) ? v : 64; };

  // ---------------------------------------------------------------- focus trap (shared by drawer + popover)
  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
  function focusables(container) { return Array.prototype.filter.call(container.querySelectorAll(FOCUSABLE), visible); }
  function trapTab(container, e) {
    var list = focusables(container);
    if (!list.length) { e.preventDefault(); return; }
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ---------------------------------------------------------------- field helpers
  function clearFields(scope) {
    scope.querySelectorAll('input, select').forEach(function (el) {
      if (el.type === 'hidden' && !el.hasAttribute('data-near-lat') && !el.hasAttribute('data-near-lng')) return;
      if (el.type === 'checkbox') el.checked = false;
      else if (el.type === 'radio') el.checked = el.value === '';
      else if (el.tagName === 'SELECT') el.selectedIndex = el.name === 'radius_km' ? Array.prototype.findIndex.call(el.options, function (o) { return o.value === '25'; }) : 0;
      else el.value = '';
    });
    var st = scope.querySelector('[data-near-status]'); if (st) st.textContent = '';
    onFieldsChanged();
  }
  function params() {
    var p = new URLSearchParams(new FormData(form));
    p.delete('page'); p.delete('view');
    Array.prototype.slice.call(p.keys()).forEach(function (k) { if (p.get(k) === '' && k !== 'audience') p.delete(k); });
    return p;
  }
  // Number of active filters (mirrors the server's chip list): keyword, place/point, category, province, city, type,
  // arrangement, every audience, salary. Radius alone is not a filter.
  function activeCounts() {
    var p = params(), all = 0, more = 0;
    ['q', 'category', 'province'].forEach(function (k) { if (p.get(k)) all++; });
    if (p.get('near') || (p.get('lat') && p.get('lng'))) all++;
    ['city', 'job_type', 'work_arrangement', 'salary_min'].forEach(function (k) { if (p.get(k)) more++; });
    more += p.getAll('audience').length;
    return { all: all + more, more: more };
  }
  function setBadge(el, n) { if (!el) return; el.textContent = String(n); el.hidden = !n; }

  // ---------------------------------------------------------------- live "Show N results" (drawer) — count-only query
  var liveTotal = form.querySelector('[data-live-total]'), livePlural = form.querySelector('[data-live-plural]');
  var geoUrl = root.getAttribute('data-geo-url') || '/api/jobs/geo';
  var geoBase = geoUrl.split('?')[0];
  var countTimer = null, countCtrl = null;
  function updateTotal() {
    if (!liveTotal || !('fetch' in window)) return;
    clearTimeout(countTimer);
    countTimer = setTimeout(function () {
      if (countCtrl) countCtrl.abort();
      countCtrl = window.AbortController ? new AbortController() : null;
      var p = params(); p.set('count_only', '1');
      fetch(geoBase + '?' + p.toString(), { headers: { accept: 'application/json' }, signal: countCtrl ? countCtrl.signal : undefined })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (!d || typeof d.total !== 'number') return; liveTotal.textContent = String(d.total); if (livePlural) livePlural.textContent = d.total === 1 ? '' : 's'; })
        .catch(function () {});
    }, 300);
  }
  var filtersBadge = form.querySelector('[data-active-count]'), moreBadge = form.querySelector('[data-more-count]');
  function onFieldsChanged() { var c = activeCounts(); setBadge(filtersBadge, c.all); setBadge(moreBadge, c.more); updateTotal(); }
  form.addEventListener('input', onFieldsChanged);
  form.addEventListener('change', onFieldsChanged);

  // ---------------------------------------------------------------- phone drawer
  var drawer = form.querySelector('[data-drawer]');
  var openBtn = form.querySelector('[data-drawer-open]');
  var drawerOpen = false, drawerReturn = null;
  function openDrawer() {
    if (drawerOpen || mqTablet.matches) return;
    drawerOpen = true; drawerReturn = document.activeElement;
    drawer.classList.add('is-open'); drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'true');
    html.classList.add('jsearch-lock');
    if (openBtn) openBtn.setAttribute('aria-expanded', 'true');
    var first = drawer.querySelector('[data-near-input]') || focusables(drawer)[0];
    if (first) first.focus({ preventScroll: true });
    updateTotal();
  }
  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    drawer.classList.remove('is-open'); drawer.removeAttribute('role'); drawer.removeAttribute('aria-modal');
    html.classList.remove('jsearch-lock');
    if (openBtn) { openBtn.setAttribute('aria-expanded', 'false'); if (drawerReturn && drawerReturn.focus) drawerReturn.focus({ preventScroll: true }); else openBtn.focus(); }
  }
  if (openBtn && drawer) {
    openBtn.addEventListener('click', openDrawer);
    drawer.querySelectorAll('[data-drawer-close]').forEach(function (b) { b.addEventListener('click', closeDrawer); });
    var dReset = drawer.querySelector('[data-drawer-reset]');
    if (dReset) dReset.addEventListener('click', function () { clearFields(drawer); var f = drawer.querySelector('[data-near-input]'); if (f) f.focus({ preventScroll: true }); });
  }

  // ---------------------------------------------------------------- "More filters" popover (≥768)
  var more = form.querySelector('[data-more]');
  var moreBtn = form.querySelector('[data-more-open]');
  var moreOpen = false;
  function openMore() {
    if (moreOpen || !mqTablet.matches) return;
    moreOpen = true; more.classList.add('is-open'); moreBtn.setAttribute('aria-expanded', 'true');
    var first = focusables(more)[0]; if (first) first.focus({ preventScroll: true });
    setTimeout(function () { document.addEventListener('pointerdown', onOutside); }, 0);
  }
  function closeMore(refocus) {
    if (!moreOpen) return;
    moreOpen = false; more.classList.remove('is-open'); moreBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside);
    if (refocus !== false) moreBtn.focus({ preventScroll: true });
  }
  function onOutside(e) { if (!more.contains(e.target) && !moreBtn.contains(e.target)) closeMore(false); }
  if (more && moreBtn) {
    moreBtn.addEventListener('click', function () { if (moreOpen) closeMore(); else openMore(); });
    var mReset = more.querySelector('[data-more-reset]');
    if (mReset) mReset.addEventListener('click', function () { clearFields(more); var f = focusables(more)[0]; if (f) f.focus({ preventScroll: true }); });
    // keep focus inside while open; Tab past the last control cycles back to the first
    more.addEventListener('focusout', function (e) { if (moreOpen && e.relatedTarget && !more.contains(e.relatedTarget) && e.relatedTarget !== moreBtn) closeMore(false); });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (drawerOpen) { e.preventDefault(); closeDrawer(); } else if (moreOpen) { e.preventDefault(); closeMore(); } return; }
    if (e.key === 'Tab') { if (drawerOpen) trapTab(drawer, e); else if (moreOpen) trapTab(more, e); }
  });
  onMq(mqTablet, function (e) { if (e.matches) closeDrawer(); else closeMore(false); applyMapState(); });
  onMq(mqDesktop, function () { applyMapState(); });

  // ---------------------------------------------------------------- map: toggle (≥768), List | Map switch (phone), markers
  var pane = root.querySelector('[data-map-pane]');
  var mapEl = root.querySelector('[data-jobs-map]');
  var note = root.querySelector('[data-map-note]');
  var toggle = root.querySelector('[data-map-toggle]');
  var toggleLabel = toggle && toggle.querySelector('[data-map-toggle-label]');
  var viewBtns = root.querySelectorAll('[data-view-switch] [data-view]');
  var viewField = form.querySelector('[data-view-field]');
  var rows = Array.prototype.slice.call(root.querySelectorAll('[data-job-row]'));
  var mapHandle = null, loading = null;

  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function store(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function mapWanted() {
    if (!mqTablet.matches) return root.classList.contains('is-map');
    var s = stored();
    if (s === 'hide') return false;
    if (s === 'show') return true;
    return mqDesktop.matches;
  }
  function applyMapState() {
    var on = mapWanted();
    if (mqTablet.matches) {
      html.classList.toggle('jobs-map-on', on); html.classList.toggle('jobs-map-off', !on);
      if (toggle) { toggle.setAttribute('aria-pressed', on ? 'true' : 'false'); if (toggleLabel) toggleLabel.textContent = on ? 'Hide map' : 'Show map'; }
    }
    if (on) showMap();
  }
  function showMap() {
    if (!window.CCMaps || !mapEl) return Promise.resolve(null);
    return loadMap().then(function (h) { if (h) setTimeout(function () { h.invalidate(); if (h.markers && h.markers.length) h.fit(); }, 60); return h; });
  }
  function loadMap() {
    if (mapHandle) return Promise.resolve(mapHandle);
    if (loading) return loading;
    var pointLat = Number(mapEl.getAttribute('data-point-lat')), pointLng = Number(mapEl.getAttribute('data-point-lng'));
    var hasPoint = mapEl.hasAttribute('data-point-lat') && isFinite(pointLat) && isFinite(pointLng);
    loading = fetch(geoUrl, { headers: { accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : { markers: [] }; }).catch(function () { return { markers: [] }; })
      .then(function (data) {
        var markers = data.markers || [];
        return window.CCMaps.init(mapEl, { markers: markers, fit: true, center: hasPoint ? { lat: pointLat, lng: pointLng } : undefined, zoom: hasPoint ? 11 : undefined, maxZoom: 13 }).then(function (h) {
          mapHandle = h;
          if (hasPoint && h.provider === 'osm' && window.L) {   // search centre + radius ring (Leaflet only)
            var radius = Number(mapEl.getAttribute('data-point-radius')) || 25;
            window.L.circle([pointLat, pointLng], { radius: radius * 1000, color: '#1F3A5F', weight: 1, fillColor: '#1F3A5F', fillOpacity: 0.06, interactive: false }).addTo(h.map);
            window.L.circleMarker([pointLat, pointLng], { radius: 6, color: '#fff', weight: 2, fillColor: '#D42E2E', fillOpacity: 1 }).addTo(h.map).bindTooltip(mapEl.getAttribute('data-point-label') || 'Search centre');
            if (!markers.length) h.map.setView([pointLat, pointLng], 10);
          }
          if (note) note.textContent = markers.length ? (markers.length + ' pin' + (markers.length === 1 ? '' : 's') + (data.capped ? ' (showing the first 200)' : '') + ' · click a pin to find it in the list.') : 'No mapped locations for these results yet.';
          // A pin's popup links to /jobs/<slug>: highlight + scroll to that row (Leaflet; Google's InfoWindow is not exposed by CCMaps).
          if (h.provider === 'osm' && h.map && h.map.on) {
            h.map.on('popupopen', function (e) {
              var el = e.popup && e.popup.getElement && e.popup.getElement();
              var a = el && el.querySelector('a[href^="/jobs/"]');
              if (a) highlightRow(a.getAttribute('href').replace(/^\/jobs\//, '').split(/[?#]/)[0]);
            });
          }
          return h;
        });
      }).catch(function (e) { console.warn('[jobs map]', e.message); if (note) note.textContent = 'Map unavailable right now.'; return null; });
    return loading;
  }
  function highlightRow(slug) {
    var hit = null;
    rows.forEach(function (r) { var on = r.getAttribute('data-slug') === slug; r.classList.toggle('is-active', on); if (on) hit = r; });
    if (!hit) { if (note) note.textContent = 'That job is on another page of results — open it from the pin.'; return; }
    if (!mqTablet.matches && root.classList.contains('is-map')) return;   // phone Map mode: the list is hidden
    var top = hit.getBoundingClientRect().top + window.pageYOffset - headerH() - 16;
    window.scrollTo({ top: top, behavior: 'smooth' });
  }
  function setView(v) {
    var isMap = v === 'map';
    root.classList.toggle('is-map', isMap);
    viewBtns.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-view') === v ? 'true' : 'false'); });
    if (viewField) viewField.value = isMap ? 'map' : '';
    try { var u = new URL(window.location.href); if (isMap) u.searchParams.set('view', 'map'); else u.searchParams.delete('view'); history.replaceState(null, '', u.toString()); } catch (e) {}
    if (isMap) {
      showMap();
      if (pane) window.scrollTo({ top: pane.getBoundingClientRect().top + window.pageYOffset - headerH(), behavior: 'smooth' });
    }
  }
  viewBtns.forEach(function (b) { b.addEventListener('click', function () { setView(b.getAttribute('data-view')); }); });
  if (toggle) toggle.addEventListener('click', function () { store(mapWanted() ? 'hide' : 'show'); applyMapState(); });
  var resizeTimer = null;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { if (mapHandle && mapWanted()) mapHandle.invalidate(); }, 150); });

  applyMapState();
})();
