(function () {
  var jf = document.querySelector('form.job-form'), dirty = false, submitting = false;
  // Anything meant only for no-JS users goes away; anything meant only for JS users appears.
  document.querySelectorAll('[data-nojs-only]').forEach(function (el) { el.hidden = true; });
  document.querySelectorAll('[data-nojs-hide]').forEach(function (el) { el.hidden = false; });
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
  // <select> that reveals a dependent field when a given value is chosen (Education / Experience "Other (specify)", operating name "Add new…").
  // Without JS the field is always visible (data-nojs-visible); with JS it only shows for the trigger value.
  document.querySelectorAll('select[data-select-toggles]').forEach(function (sel) {
    var target = document.getElementById(sel.getAttribute('data-select-toggles'));
    if (!target) return;
    var want = sel.getAttribute('data-toggle-value') || 'other';
    var sync = function (fromUser) { var on = sel.value === want; target.hidden = !on; if (on && fromUser) { var i = target.querySelector('input'); if (i) i.focus(); } };
    sel.addEventListener('change', function () { sync(true); }); sync(false);
  });

  // ---- Profile form: repeatable operating names (operating_names[]; first = default). Server renders 3 boxes for no-JS users.
  var namesList = document.getElementById('names-list');
  if (namesList) {
    var namesAdd = document.getElementById('names-add');
    var nmax = parseInt(namesList.getAttribute('data-max'), 10) || 10;
    var rows = function () { return Array.prototype.slice.call(namesList.querySelectorAll('[data-name-row]')); };
    var reindex = function () {
      var rs = rows();
      rs.forEach(function (r, i) {
        var inp = r.querySelector('input'); var lab = r.querySelector('label'); inp.id = 'opname-' + i; if (lab) { lab.setAttribute('for', inp.id); lab.textContent = 'Operating name ' + (i + 1); }
        inp.placeholder = i === 0 ? 'e.g. Flying Pig' : 'Another name (optional)';
        var d = r.querySelector('[data-name-default]'); if (d) d.hidden = i !== 0;
        var rm = r.querySelector('[data-name-remove]'); if (rm) rm.hidden = rs.length <= 1;
      });
      if (namesAdd) namesAdd.hidden = rs.length >= nmax;
    };
    rows().forEach(function (r) { if (r.classList.contains('names-row--spare')) r.parentNode.removeChild(r); });
    if (namesAdd) {
      namesAdd.hidden = false;
      namesAdd.addEventListener('click', function () {
        var rs = rows(); if (rs.length >= nmax) return;
        var clone = rs[rs.length - 1].cloneNode(true);
        clone.classList.remove('names-row--spare'); clone.querySelector('input').value = '';
        namesList.appendChild(clone); reindex(); clone.querySelector('input').focus();
      });
    }
    namesList.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-name-remove]'); if (!btn) return;
      var rs = rows(); if (rs.length <= 1) return;
      var r = btn.closest('[data-name-row]');
      if (r.querySelector('input').value && !window.confirm('Remove this operating name? Postings that already use it keep it.')) return;
      r.parentNode.removeChild(r); reindex();
    });
    reindex();
  }
  // ---- Profile form: the location editor is collapsed behind "+ Add location" once the profile has locations.
  var locEditor = document.getElementById('loc-editor');
  if (locEditor) {
    var openEditor = function () { locEditor.classList.remove('is-collapsed'); locEditor.hidden = false; var i = locEditor.querySelector('input'); if (i) i.focus(); locEditor.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    document.querySelectorAll('[data-loc-open]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); openEditor(); a.hidden = true; }); });
    document.querySelectorAll('[data-loc-cancel]').forEach(function (a) {
      if (locEditor.getAttribute('action').match(/\/\d+$/)) return;   // edit mode: Cancel is a real link back to the plain form
      a.addEventListener('click', function (e) { e.preventDefault(); locEditor.classList.add('is-collapsed'); locEditor.querySelectorAll('input:not([type=checkbox]),select').forEach(function (i) { i.value = ''; }); document.querySelectorAll('[data-loc-open]').forEach(function (b) { b.hidden = false; }); });
    });
    if (location.hash === '#loc-editor') openEditor();
  }

  // ---- Job form
  if (jf) {
    // Consultant: the company select drives which address-book list / operating-name select is shown, and the default application email.
    var sel = document.getElementById('employer_profile_id');
    var applyEmail = document.getElementById('apply_email');
    var showProfile = function (pid) {
      document.querySelectorAll('[data-profile]').forEach(function (el) { el.hidden = !pid || String(el.getAttribute('data-profile')) !== String(pid); });
      document.querySelectorAll('[data-profile-none]').forEach(function (el) { el.hidden = !!pid; });
    };
    if (sel) {
      var optEmail = function () { var o = sel.options[sel.selectedIndex]; return o ? (o.getAttribute('data-contact-email') || '') : ''; };
      var prevDefault = applyEmail ? (applyEmail.getAttribute('data-apply-default') || '') : '';
      sel.addEventListener('change', function () {
        showProfile(sel.value);
        var d = optEmail();
        if (applyEmail && (!applyEmail.value || applyEmail.value === prevDefault)) { applyEmail.value = d; applyEmail.setAttribute('data-apply-default', d); }
        prevDefault = d;
      });
      showProfile(sel.value);
    }
    // "Add a new location" block: Clear empties it and folds it back.
    var newLoc = document.getElementById('loc-new'); var clearBtn = document.getElementById('loc-new-clear');
    if (newLoc && clearBtn) clearBtn.addEventListener('click', function () { newLoc.querySelectorAll('input,select').forEach(function (i) { i.value = ''; }); newLoc.open = false; dirty = true; });
    // A ticked location list that is hidden (other company) must not submit: the server ignores foreign ids anyway, this just keeps the payload honest.
    jf.addEventListener('submit', function () { document.querySelectorAll('.loc-choice[hidden] input[type=checkbox]').forEach(function (cb) { cb.checked = false; }); });
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

  // Consultant landing page: illustrative "switch clients" tabs (.client-switch) — one active at a time.
  document.querySelectorAll('.client-switch__tabs').forEach(function (tabs) {
    tabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.client-switch__tab');
      if (!btn) return;
      tabs.querySelectorAll('.client-switch__tab').forEach(function (t) { t.classList.remove('is-active'); t.setAttribute('aria-pressed', 'false'); });
      btn.classList.add('is-active'); btn.setAttribute('aria-pressed', 'true');
    });
  });
})();
