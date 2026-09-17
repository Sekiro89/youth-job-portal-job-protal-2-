/* Canada Careers — public content pages (home, job detail, company). Progressive: pages work without this file.
   The /jobs search page has its own /js/jobs-search.js (filters, near-me, results map); nothing here targets it.
   Detail/company maps auto-initialise from [data-map] in /js/maps.js. */
(function () {
  'use strict';

  // Graceful image fallback (inline onerror is blocked by CSP script-src-attr). data-fallback="<class to add to parent>"
  document.querySelectorAll('img[data-fallback]').forEach(function (img) {
    var fail = function () { var cls = img.getAttribute('data-fallback'); if (cls) img.parentNode.classList.add(cls); img.remove(); };
    if (img.complete && img.naturalWidth === 0) fail(); else img.addEventListener('error', fail);
  });

  // "Print or save as PDF" (job page). /css/print.css (media="print") lays out the sheet.
  document.querySelectorAll('[data-print]').forEach(function (btn) {
    btn.addEventListener('click', function () { window.print(); });
  });

  // Homepage "Find your lane": hovering/focusing a category row lights up its matching career-compass node.
  // Pure enhancement — the rows are plain links and work identically without this.
  var laneRows = document.querySelectorAll('[data-compass-row]');
  if (laneRows.length) {
    var setCompass = function (path) {
      document.querySelectorAll('.compass').forEach(function (el) { el.classList.toggle('is-focused', !!path); });
      document.querySelectorAll('.compass__node, .compass__label').forEach(function (el) {
        el.classList.toggle('is-active', !!path && el.getAttribute('data-path') === path);
      });
    };
    laneRows.forEach(function (row) {
      var path = row.getAttribute('data-compass-row');
      row.addEventListener('mouseenter', function () { setCompass(path); });
      row.addEventListener('focus', function () { setCompass(path); });
      row.addEventListener('mouseleave', function () { setCompass(''); });
      row.addEventListener('blur', function () { setCompass(''); });
    });
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
