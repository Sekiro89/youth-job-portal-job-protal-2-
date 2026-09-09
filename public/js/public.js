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
