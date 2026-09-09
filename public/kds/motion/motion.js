/* ============================================================
   KDS Motion — zero-dependency animation engine
   Built on the Web Animations API (native in every browser).
   ~6 KB min. No framework required; works everywhere.

   Highlights
   - real spring physics → compiled to CSS linear() easing
   - presets: fadeIn, riseIn, scaleIn, slideIn, popIn, blurIn
   - stagger() and sequence() orchestration
   - reveal(): scroll-triggered entrances (IntersectionObserver)
   - respects prefers-reduced-motion automatically
   © Khosha Systems. All rights reserved.
   ============================================================ */

export const reducedMotion = () =>
  typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- easing ---------- */

export const ease = {
  standard: "cubic-bezier(0.2, 0, 0.2, 1)",
  enter: "cubic-bezier(0.16, 1, 0.3, 1)",
  exit: "cubic-bezier(0.6, 0, 0.85, 0.4)",
  springGentle: "cubic-bezier(0.34, 1.45, 0.5, 1)",
};

/**
 * Real spring physics → native CSS linear() easing string.
 * Samples a damped harmonic oscillator and emits a linear() curve the
 * browser runs on the compositor. No rAF loop, no JS per frame.
 *   spring()                        → balanced spring
 *   spring({ stiffness: 300, damping: 12 }) → bouncier
 * Returns { easing, duration } — feed both into animate().
 */
export function spring({ stiffness = 180, damping = 18, mass = 1 } = {}) {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  // settle time ≈ when envelope decays below 0.5%
  const settle = zeta < 1 ? -Math.log(0.005) / (zeta * w0) : 5.3 / w0;
  const duration = Math.min(Math.max(settle * 1000, 150), 2500);
  const N = 80;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * (duration / 1000);
    let x;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      x =
        1 -
        Math.exp(-zeta * w0 * t) *
          (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    } else {
      x = 1 - Math.exp(-w0 * t) * (1 + w0 * t);
    }
    pts.push(Math.round(x * 1000) / 1000);
  }
  return { easing: `linear(${pts.join(",")})`, duration };
}

/* ---------- core ---------- */

const BASE = { duration: 360, easing: ease.enter, fill: "both" };

/**
 * animate(el, keyframes, options?) → Animation
 * Thin WAAPI wrapper with sane defaults + reduced-motion respect.
 */
export function animate(el, keyframes, options = {}) {
  if (!el) return null;
  if (reducedMotion()) {
    const anim = el.animate(keyframes, { ...BASE, ...options, duration: 0 });
    return anim;
  }
  return el.animate(keyframes, { ...BASE, ...options });
}

/* ---------- presets ---------- */

export const presets = {
  fadeIn: { keyframes: [{ opacity: 0 }, { opacity: 1 }] },
  riseIn: {
    keyframes: [
      { opacity: 0, transform: "translateY(16px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
  },
  slideInLeft: {
    keyframes: [
      { opacity: 0, transform: "translateX(-24px)" },
      { opacity: 1, transform: "translateX(0)" },
    ],
  },
  slideInRight: {
    keyframes: [
      { opacity: 0, transform: "translateX(24px)" },
      { opacity: 1, transform: "translateX(0)" },
    ],
  },
  scaleIn: {
    keyframes: [
      { opacity: 0, transform: "scale(0.92)" },
      { opacity: 1, transform: "scale(1)" },
    ],
  },
  popIn: {
    keyframes: [
      { opacity: 0, transform: "scale(0.6)" },
      { opacity: 1, transform: "scale(1)" },
    ],
    spring: { stiffness: 260, damping: 14 },
  },
  blurIn: {
    keyframes: [
      { opacity: 0, filter: "blur(8px)" },
      { opacity: 1, filter: "blur(0px)" },
    ],
  },
};

/** play(el, "riseIn", options?) — run a preset by name. */
export function play(el, name, options = {}) {
  const p = presets[name];
  if (!p) throw new Error(`KDS Motion: unknown preset "${name}"`);
  const springOpts = p.spring ? spring(p.spring) : null;
  return animate(el, p.keyframes, { ...(springOpts ?? {}), ...options });
}

/* ---------- orchestration ---------- */

/**
 * stagger(elements, "riseIn", { gap = 70, ...options })
 * Cascade a preset across a list. Returns the Animations.
 */
export function stagger(els, name, { gap = 70, ...options } = {}) {
  return [...els].map((el, i) =>
    play(el, name, { ...options, delay: (options.delay ?? 0) + i * gap }),
  );
}

/**
 * sequence([[el, "fadeIn", opts?], ...]) — run steps one after another.
 * Returns a promise resolving when the chain completes.
 */
export async function sequence(steps) {
  for (const [el, name, options] of steps) {
    const a = play(el, name, options);
    if (a) await a.finished.catch(() => {});
  }
}

/* ---------- scroll reveal ---------- */

/**
 * reveal(target = "[data-kds-reveal]", { preset, gap, once = true })
 * Elements animate in as they enter the viewport. The data attribute can
 * override the preset per element: data-kds-reveal="popIn".
 * Returns a cleanup function.
 */
export function reveal(target = "[data-kds-reveal]", opts = {}) {
  const els =
    typeof target === "string" ? document.querySelectorAll(target) : target;
  if (!els.length) return () => {};
  const { preset = "riseIn", gap = 60, once = true, threshold = 0.15 } = opts;

  for (const el of els) el.style.opacity = "0";

  let batchIndex = 0;
  let batchTimer = null;
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const name = el.dataset.kdsReveal || preset;
        play(el, name, { delay: batchIndex * gap });
        batchIndex++;
        if (once) io.unobserve(el);
      }
      clearTimeout(batchTimer);
      batchTimer = setTimeout(() => (batchIndex = 0), 200);
    },
    { threshold },
  );
  for (const el of els) io.observe(el);
  return () => io.disconnect();
}

/* ---------- micro-interactions ---------- */

/** pressable(el) — tactile press feedback on pointer down/up. */
export function pressable(el, { scale = 0.97 } = {}) {
  if (!el || reducedMotion()) return () => {};
  const down = () =>
    el.animate(
      [{ transform: "scale(1)" }, { transform: `scale(${scale})` }],
      { duration: 90, easing: ease.standard, fill: "forwards" },
    );
  const up = () => {
    const s = spring({ stiffness: 320, damping: 16 });
    el.animate(
      [{ transform: `scale(${scale})` }, { transform: "scale(1)" }],
      { duration: s.duration, easing: s.easing, fill: "forwards" },
    );
  };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointerleave", up);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointerleave", up);
  };
}
