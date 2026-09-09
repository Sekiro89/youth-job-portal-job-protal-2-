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
  // Submit-once guard on admin forms (reply emails, takedowns)
  document.querySelectorAll('form[method="post"]').forEach(function (f) {
    f.addEventListener('submit', function () {
      var b = f.querySelector('button[type="submit"]');
      if (b) setTimeout(function () { b.disabled = true; }, 0);
    });
  });
})();
