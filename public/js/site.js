(function () {
  // Always open a new page at the top (browsers otherwise restore the previous scroll position).
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  function toTop() { if (!location.hash) window.scrollTo(0, 0); }
  toTop(); window.addEventListener('pageshow', toTop); window.addEventListener('load', toTop);
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && nav.classList.contains('is-open')) toggle.click(); });
  }
  // auto-dismiss flash after 8s
  document.querySelectorAll('.flash').forEach(function (el) { setTimeout(function () { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 400); }, 8000); });
  // confirm buttons
  document.querySelectorAll('[data-confirm]').forEach(function (el) {
    el.addEventListener('click', function (e) { if (!window.confirm(el.getAttribute('data-confirm'))) e.preventDefault(); });
  });
})();
document.querySelectorAll('[data-print]').forEach(function (el) { el.addEventListener('click', function () { window.print(); }); });
