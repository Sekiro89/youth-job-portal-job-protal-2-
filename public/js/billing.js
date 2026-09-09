// Billing: sandbox card formatting + Luhn check, busy state on submit buttons.
(function () {
  'use strict';
  function luhn(n) { var s = 0, alt = false; for (var i = n.length - 1; i >= 0; i--) { var d = +n[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } s += d; alt = !alt; } return s % 10 === 0; }
  function brand(n) { if (/^4/.test(n)) return 'Visa'; if (/^(5[1-5]|2[2-7])/.test(n)) return 'Mastercard'; if (/^3[47]/.test(n)) return 'Amex'; return ''; }
  function setErr(id, msg) { var el = document.getElementById(id + '-error'); var inp = document.getElementById(id); if (el) el.textContent = msg || ''; if (inp) inp.classList.toggle('is-invalid', !!msg); }

  var form = document.getElementById('sandbox-form');
  if (form) {
    var number = document.getElementById('number'), exp = document.getElementById('exp'), cvc = document.getElementById('cvc'), brandEl = document.getElementById('card-brand');
    number.addEventListener('input', function () {
      var digits = number.value.replace(/\D/g, '').slice(0, 19);
      number.value = digits.replace(/(\d{4})(?=\d)/g, '$1 ');
      if (brandEl) brandEl.textContent = brand(digits);
      if (digits.length >= 13 && !luhn(digits)) setErr('number', 'This card number does not look right.'); else setErr('number', '');
    });
    exp.addEventListener('input', function () {
      var d = exp.value.replace(/\D/g, '').slice(0, 4);
      if (d.length >= 3) d = d.slice(0, 2) + '/' + d.slice(2);
      exp.value = d; setErr('exp', '');
    });
    cvc.addEventListener('input', function () { cvc.value = cvc.value.replace(/\D/g, '').slice(0, 4); setErr('cvc', ''); });
    form.addEventListener('submit', function (e) {
      var ok = true, digits = number.value.replace(/\D/g, '');
      if (!document.getElementById('name').value.trim()) { ok = false; document.getElementById('name').classList.add('is-invalid'); }
      if (digits.length < 13 || !luhn(digits)) { ok = false; setErr('number', 'Enter a valid card number.'); }
      var m = exp.value.match(/^(\d{2})\/(\d{2})$/);
      if (!m || +m[1] < 1 || +m[1] > 12) { ok = false; setErr('exp', 'Use MM/YY.'); }
      else if (new Date(2000 + +m[2], +m[1], 0) < new Date()) { ok = false; setErr('exp', 'This card has expired.'); }
      if (cvc.value.length < 3) { ok = false; setErr('cvc', 'Enter the 3 or 4 digit code.'); }
      if (!ok) { e.preventDefault(); var first = form.querySelector('.is-invalid'); if (first) first.focus(); }
    });
    if (number.value) number.dispatchEvent(new Event('input'));
  }

  // Busy state: "Processing…" and disable after a valid submit (prevents double charges).
  document.querySelectorAll('form button[data-busy]').forEach(function (btn) {
    btn.form.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return;
      setTimeout(function () { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = btn.getAttribute('data-busy'); }, 0);
    });
  });
})();
