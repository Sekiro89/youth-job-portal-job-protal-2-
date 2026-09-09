(function () {
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

  // Side nav (a horizontal pill strip below 1024px): scroll the current tab into view and hide the edge fade at the end.
  var nav = document.querySelector('[data-seeker-nav]');
  if (nav) {
    var wrap = nav.parentNode;
    var active = nav.querySelector('.is-active');
    var fade = function () { wrap.classList.toggle('is-scrolled-end', nav.scrollWidth - nav.clientWidth - nav.scrollLeft < 8); };
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

  // Alerts switch: keep aria-checked in sync; disable frequency when off
  var sw = document.querySelector('[data-switch]');
  if (sw) {
    var freq = document.querySelectorAll('input[name=notify_frequency]');
    var sync = function () { sw.setAttribute('aria-checked', sw.checked ? 'true' : 'false'); freq.forEach(function (r) { r.closest('.check').style.opacity = sw.checked ? '' : '.5'; }); };
    sw.addEventListener('change', sync); sync();
  }

  // Show chosen file name hint
  document.querySelectorAll('input[type=file]').forEach(function (f) {
    f.addEventListener('change', function () {
      if (f.files && f.files[0] && f.files[0].size > 5 * 1024 * 1024) { alert('That file is larger than 5 MB. Please choose a smaller resume.'); f.value = ''; }
    });
  });
})();
