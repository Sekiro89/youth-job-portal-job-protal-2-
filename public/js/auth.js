(function () {
  // show / hide password toggles
  document.querySelectorAll('[data-pw-toggle]').forEach(function (btn) {
    var input = document.getElementById(btn.getAttribute('data-pw-toggle'));
    if (!input) return;
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', (show ? 'Hide' : 'Show') + ' password');
      input.focus({ preventScroll: true });
    });
  });

  // live "passwords do not match" hint on confirm fields
  document.querySelectorAll('input[name="password_confirm"]').forEach(function (confirm) {
    var form = confirm.form; if (!form) return;
    var pw = form.querySelector('input[name="password"]'); if (!pw) return;
    var note = document.createElement('span'); note.className = 'error'; note.hidden = true; note.textContent = 'Passwords do not match.';
    confirm.closest('.field').appendChild(note);
    function check() { var bad = confirm.value && pw.value !== confirm.value; note.hidden = !bad; confirm.setAttribute('aria-invalid', bad ? 'true' : 'false'); }
    confirm.addEventListener('input', check); pw.addEventListener('input', check);
  });

  // move focus to the error summary after a failed submit so screen readers announce it
  var alert = document.getElementById('form-errors');
  if (alert) alert.focus();

  // Account settings: highlight the current section in the settings nav as you scroll (Profile/Security/Devices).
  var accountLinks = document.querySelectorAll('[data-account-link]');
  var accountSections = document.querySelectorAll('.account-section[id]');
  if (accountLinks.length && accountSections.length && 'IntersectionObserver' in window) {
    var byId = {};
    accountLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var active = null;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var link = byId[entry.target.id];
        if (!link || active === link) return;
        if (active) active.classList.remove('is-active');
        active = link;
        active.classList.add('is-active');
      });
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    accountSections.forEach(function (s) { observer.observe(s); });
  }
})();
