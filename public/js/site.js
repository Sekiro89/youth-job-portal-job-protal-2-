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
  // "Need to know" FAQ (views/portal/partials/landing-faq.ejs): a category rail filters a column of questions.
  // Pure enhancement — every question from every category is already in the DOM and expandable without this;
  // this only shows/hides whole [data-faq-group]s, it never adds, removes or rewrites any question or answer.
  document.querySelectorAll('[data-faq-filterable]').forEach(function (root) {
    var buttons = Array.prototype.slice.call(root.querySelectorAll('[data-faq-cat]'));
    var groups = Array.prototype.slice.call(root.querySelectorAll('[data-faq-group]'));
    if (!buttons.length || !groups.length) return;
    function show(i) {
      groups.forEach(function (g) { g.classList.toggle('needknow__group--hidden', g.getAttribute('data-faq-group') !== i); });
      buttons.forEach(function (b) {
        var on = b.getAttribute('data-faq-cat') === i;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    buttons.forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-faq-cat')); }); });
    show(buttons[0].getAttribute('data-faq-cat'));
  });
})();
document.querySelectorAll('[data-print]').forEach(function (el) { el.addEventListener('click', function () { window.print(); }); });
