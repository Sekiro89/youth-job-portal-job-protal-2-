(function () {
  // Character counter (description min 100)
  document.querySelectorAll('[data-counter]').forEach(function (ta) {
    var out = document.getElementById(ta.getAttribute('data-counter'));
    if (!out) return;
    var update = function () { out.textContent = ta.value.length; out.style.color = ta.value.length < 100 ? 'var(--cc-red)' : 'var(--cc-ink)'; };
    ta.addEventListener('input', update); update();
  });
  // Checkbox that reveals a dependent field (Other language)
  document.querySelectorAll('[data-toggles]').forEach(function (cb) {
    var target = document.getElementById(cb.getAttribute('data-toggles'));
    if (!target) return;
    var sync = function () { target.hidden = !cb.checked; if (cb.checked) { var i = target.querySelector('input'); if (i && document.activeElement === cb) i.focus(); } };
    cb.addEventListener('change', sync); sync();
  });
  // Every other POST form: ignore a second submit while the first is in flight (publish / pay / status buttons)
  document.querySelectorAll('form[method=post]:not(.job-form)').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (f.dataset.busy) { e.preventDefault(); return; }
      f.dataset.busy = '1';
      f.querySelectorAll('button[type=submit]').forEach(function (b) { b.setAttribute('aria-busy', 'true'); setTimeout(function () { b.disabled = true; }, 0); });
      setTimeout(function () { delete f.dataset.busy; f.querySelectorAll('button[type=submit]').forEach(function (b) { b.disabled = false; b.removeAttribute('aria-busy'); }); }, 8000);
    });
  });
  // Filters that submit on change (keep the button for no-JS)
  document.querySelectorAll('[data-autosubmit]').forEach(function (sel) {
    sel.addEventListener('change', function () { sel.form && sel.form.submit(); });
  });
  // Logo preview + "file present" marker for server-side type validation
  document.querySelectorAll('input[type=file][data-preview]').forEach(function (inp) {
    var img = document.getElementById(inp.getAttribute('data-preview'));
    var present = document.getElementById('logo_present');
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (present) present.value = f ? '1' : '0';
      if (!img) return;
      if (!f || !/^image\//.test(f.type)) { return; }
      var r = new FileReader();
      r.onload = function () { img.src = r.result; img.hidden = false; };
      r.readAsDataURL(f);
    });
  });
  // Warn before leaving a dirty job form
  var jf = document.querySelector('form.job-form');
  if (jf) {
    var dirty = false, submitting = false;
    jf.addEventListener('input', function () { dirty = true; });
    jf.addEventListener('submit', function (e) {
      if (submitting) { e.preventDefault(); return; }           // double-click / double-Enter guard
      submitting = true;
      var btn = e.submitter; if (btn) { btn.setAttribute('aria-busy', 'true'); btn.dataset.label = btn.textContent; btn.textContent = 'Saving…'; }
      jf.querySelectorAll('button[type=submit]').forEach(function (b) { setTimeout(function () { b.disabled = true; }, 0); });
    });
    window.addEventListener('beforeunload', function (e) { if (dirty && !submitting) { e.preventDefault(); e.returnValue = ''; } });
  }
})();
