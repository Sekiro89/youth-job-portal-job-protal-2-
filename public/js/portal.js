(function () {
  var jf = document.querySelector('form.job-form'), dirty = false, submitting = false;
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
  // <select> that reveals a dependent field when a given value is chosen (Education / Experience "Other (specify)").
  // Without JS the field is always visible (data-nojs-visible); with JS it only shows for the trigger value.
  document.querySelectorAll('select[data-select-toggles]').forEach(function (sel) {
    var target = document.getElementById(sel.getAttribute('data-select-toggles'));
    if (!target) return;
    var want = sel.getAttribute('data-toggle-value') || 'other';
    var sync = function (fromUser) { var on = sel.value === want; target.hidden = !on; if (on && fromUser) { var i = target.querySelector('input'); if (i) i.focus(); } };
    sel.addEventListener('change', function () { sync(true); }); sync(false);
  });
  // Repeatable work-location blocks on the job form. Server renders >= 3 blocks for no-JS users; with JS we drop the
  // untouched spares, offer "Add another location" (clones the last block) and "Remove" (never below one block).
  var locList = document.getElementById('loc-list');
  if (locList) {
    var addBtn = document.getElementById('loc-add');
    var max = parseInt(locList.getAttribute('data-max'), 10) || 20;
    var FIELDS = ['street_address', 'unit', 'city', 'province', 'postal_code'];
    var blocks = function () { return Array.prototype.slice.call(locList.querySelectorAll('[data-loc-block]')); };
    var fieldOf = function (el) { var m = /^loc_(\w+)\[\]$/.exec(el.name || ''); return m ? m[1] : null; };
    var reindex = function () {
      var bs = blocks();
      bs.forEach(function (b, i) {
        b.querySelectorAll('input,select').forEach(function (el) { var f = fieldOf(el); if (!f) return; var id = 'loc_' + i + '_' + f; var lab = b.querySelector('label[for="' + el.id + '"]'); el.id = id; if (lab) lab.setAttribute('for', id); });
        var n = b.querySelector('[data-loc-n]'); if (n) n.textContent = String(i + 1);
        var note = b.querySelector('[data-loc-first-note]'); if (note) note.hidden = i !== 0;
        var rm = b.querySelector('[data-loc-remove]'); if (rm) rm.hidden = bs.length <= 1;
      });
      if (addBtn) addBtn.hidden = bs.length >= max;
    };
    // drop untouched spare blocks (server marks them), keep every block that has content or an error
    blocks().forEach(function (b) { if (b.classList.contains('loc-block--spare')) b.parentNode.removeChild(b); });
    document.querySelectorAll('[data-nojs-only]').forEach(function (el) { el.hidden = true; });
    if (addBtn) {
      addBtn.hidden = false;
      addBtn.addEventListener('click', function () {
        var bs = blocks(); if (bs.length >= max) return;
        var clone = bs[bs.length - 1].cloneNode(true);
        clone.classList.remove('loc-block--invalid', 'loc-block--spare');
        clone.querySelectorAll('.error').forEach(function (e) { e.parentNode.removeChild(e); });
        clone.querySelectorAll('input,select').forEach(function (el) { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); if (el.tagName === 'SELECT') el.selectedIndex = 0; else el.value = ''; });
        var note = clone.querySelector('[data-loc-first-note]'); if (note) note.parentNode.removeChild(note);
        locList.appendChild(clone); reindex();
        var first = clone.querySelector('input'); if (first) first.focus();
        clone.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        if (jf) dirty = true;
      });
    }
    locList.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-loc-remove]'); if (!btn) return;
      var bs = blocks(); if (bs.length <= 1) return;
      var b = btn.closest('[data-loc-block]');
      var filled = Array.prototype.some.call(b.querySelectorAll('input,select'), function (el) { return el.value; });
      if (filled && !window.confirm('Remove this work location?')) return;
      b.parentNode.removeChild(b); reindex();
      if (jf) dirty = true;
    });
    reindex();
  }
  // Every other POST form: ignore a second submit while the first is in flight (publish / pay / status buttons)
  document.querySelectorAll('form[method=post]:not(.job-form)').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (f.dataset.busy) { e.preventDefault(); return; }
      f.dataset.busy = '1';
      f.querySelectorAll('button[type=submit]').forEach(function (b) { b.setAttribute('aria-busy', 'true'); setTimeout(function () { b.disabled = true; }, 0); });
      setTimeout(function () { delete f.dataset.busy; f.querySelectorAll('button[type=submit]').forEach(function (b) { b.disabled = false; b.removeAttribute('aria-busy'); }); }, 8000);
    });
  });
  // "Show full description" on long previews
  document.querySelectorAll('[data-expand]').forEach(function (btn) {
    var t = document.getElementById(btn.getAttribute('data-expand'));
    if (!t) return;
    btn.addEventListener('click', function () { var open = t.classList.toggle('is-open'); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); btn.textContent = open ? 'Show less' : 'Show full description'; });
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
  if (jf) {
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
