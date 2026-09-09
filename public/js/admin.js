(function () {
  'use strict';
  // Mail outbox: HTML / plain-text toggle
  var views = document.querySelectorAll('[data-mail-view]');
  if (views.length) {
    views.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var which = btn.getAttribute('data-mail-view');
        views.forEach(function (b) { b.classList.toggle('is-active', b === btn); b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
        document.querySelectorAll('[data-mail-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-mail-pane') !== which; });
      });
    });
  }
  // Message detail: keep the status <select> and the "also resolve" checkbox honest with each other
  var statusSel = document.getElementById('status');
  if (statusSel) statusSel.addEventListener('change', function () { statusSel.form.querySelector('button').classList.add('kds-btn--accent'); });
  // Submit-once guard on admin forms (reply emails, takedowns, settings saves)
  document.querySelectorAll('form[method="post"]').forEach(function (f) {
    f.addEventListener('submit', function () {
      var b = f.querySelector('button[type="submit"]');
      if (b) setTimeout(function () { b.disabled = true; }, 0);
    });
  });

  // Integrations: highlight the section in view in the sub-nav, and unhide a section when its hash is opened.
  var nav = document.querySelector('.integrations__nav');
  if (nav) {
    var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
    var sections = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); }).filter(Boolean);
    var setActive = function (id) { links.forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('href') === '#' + id); }); };
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) setActive(e.target.id); });
      }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });
      sections.forEach(function (s) { io.observe(s); });
    }
    if (location.hash) setActive(location.hash.slice(1));
    // A secret "Replace" box and its "Clear" tick are mutually exclusive.
    document.querySelectorAll('.secret').forEach(function (box) {
      var input = box.querySelector('input[type="text"]'), clear = box.querySelector('input[type="checkbox"]');
      if (!input || !clear) return;
      clear.addEventListener('change', function () { if (clear.checked) { input.value = ''; input.disabled = true; } else input.disabled = false; });
      input.addEventListener('input', function () { if (input.value) clear.checked = false; });
    });
    // Scroll the flash into view after a save/test so the result is seen on phones.
    var flash = document.querySelector('.flash-region');
    if (flash && location.hash) { setTimeout(function () { flash.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 50); }
  }
})();
