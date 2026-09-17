/* Youth Futures Canada — legal document pages (privacy, terms) only.
   1) Scroll-spy: highlights the current section in the sticky index as you read (desktop).
   2) Jump-to-section: a native <select> that navigates by hash (mobile/tablet — no sticky rail there). */
(function () {
  'use strict';
  var links = document.querySelectorAll('[data-legal-link]');
  var sections = document.querySelectorAll('.legal-section[id]');
  if (links.length && sections.length && 'IntersectionObserver' in window) {
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var active = null;
    var setActive = function (link) {
      if (active === link) return;
      if (active) active.classList.remove('is-active');
      active = link;
      if (active) active.classList.add('is-active');
    };
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) setActive(byId[entry.target.id]);
      });
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    sections.forEach(function (s) { observer.observe(s); });
  }

  var jump = document.querySelector('[data-legal-jump]');
  if (jump) {
    jump.addEventListener('change', function () {
      if (jump.value) window.location.hash = jump.value;
    });
  }
})();
