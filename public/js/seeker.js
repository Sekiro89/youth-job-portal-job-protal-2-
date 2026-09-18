(function () {
  'use strict';
  // Apply form: reveal the upload field only when "upload a different resume" is chosen.
  var choices = document.querySelectorAll('[data-resume-choice]');
  var uploadBox = document.querySelector('[data-resume-upload]');
  function syncUpload() {
    if (!uploadBox || !choices.length) return;
    var v = 'profile';
    choices.forEach(function (r) { if (r.checked) v = r.value; });
    uploadBox.hidden = v !== 'upload';
    var file = uploadBox.querySelector('input[type=file]');
    if (file) file.required = v === 'upload';
  }
  choices.forEach(function (r) { r.addEventListener('change', syncUpload); });
  syncUpload();

  // Side nav (a horizontal pill strip below 1024px): scroll the current tab into view; show an edge fade on whichever
  // side still has hidden tabs (.is-scrolled-start = fade on the left, .is-scrolled-end = no fade on the right).
  var nav = document.querySelector('[data-seeker-nav]');
  if (nav) {
    var wrap = nav.parentNode;
    var active = nav.querySelector('.is-active');
    var fade = function () {
      var max = nav.scrollWidth - nav.clientWidth;
      wrap.classList.toggle('is-scrolled-end', max - nav.scrollLeft < 8);
      wrap.classList.toggle('is-scrolled-start', nav.scrollLeft > 8);
    };
    if (active && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2);
    nav.addEventListener('scroll', fade, { passive: true }); window.addEventListener('resize', fade); fade();
  }

  // Character counters
  document.querySelectorAll('[data-counter]').forEach(function (ta) {
    var out = document.getElementById(ta.getAttribute('data-counter'));
    if (!out) return;
    var tick = function () { out.textContent = ta.value.length; out.parentNode.style.color = ta.value.length > (Number(ta.maxLength) || 3000) ? 'var(--cc-red)' : ''; };
    ta.addEventListener('input', tick); tick();
  });

  // Alerts switch: keep aria-checked in sync; dim frequency when off
  var sw = document.querySelector('[data-switch]');
  if (sw) {
    var freq = document.querySelectorAll('input[name=notify_frequency]');
    var sync = function () { sw.setAttribute('aria-checked', sw.checked ? 'true' : 'false'); freq.forEach(function (r) { r.closest('.check').style.opacity = sw.checked ? '' : '.5'; }); };
    sw.addEventListener('change', sync); sync();
  }

  // Client-side size guard for resume / cover sheet uploads (the server re-checks size, type and magic bytes)
  document.querySelectorAll('input[type=file]').forEach(function (f) {
    f.addEventListener('change', function () {
      var what = f.name === 'cover_file' ? 'cover sheet' : 'resume';
      if (f.files && f.files[0] && f.files[0].size > 5 * 1024 * 1024) { alert('That file is larger than 5 MB. Please choose a smaller ' + what + '.'); f.value = ''; }
    });
  });

  // "Where are you starting?" stage picker (jobseeker landing): a rail of node buttons selects which stage's
  // panel shows. Pure enhancement — every panel already has its full real content in the DOM with no JS at
  // all; this only shows/hides whole panels, it never adds, removes or rewrites any stage's text or count.
  var picker = document.querySelector('[data-stage-picker]');
  if (picker) {
    var stageBtns = Array.prototype.slice.call(picker.querySelectorAll('[data-stage-btn]'));
    var stagePanels = Array.prototype.slice.call(picker.querySelectorAll('[data-stage-panel]'));
    if (stageBtns.length && stagePanels.length) {
      var showStage = function (i) {
        stagePanels.forEach(function (p) { p.classList.toggle('stage-picker__panel--hidden', p.getAttribute('data-stage-panel') !== i); });
        stageBtns.forEach(function (b) {
          var on = b.getAttribute('data-stage-btn') === i;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      };
      stageBtns.forEach(function (b) { b.addEventListener('click', function () { showStage(b.getAttribute('data-stage-btn')); }); });
      showStage(stageBtns[0].getAttribute('data-stage-btn'));
    }
  }
})();
