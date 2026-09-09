# Canada Careers — UX standard (2026-09-10)

The client noticed pages "laid out very differently" (About Us wider than the rest, Find Jobs cramped by the map). This is the single standard every page follows. Primitives live in `public/css/theme.css` (bottom section). **Do not invent new containers, header bands, section paddings, card styles or button weights in page CSS.**

## 1. Width and gutters
- `.container` = **1200 px max, 16 px gutters on phones, 24 px from 768 px.** Every page section, header band, footer and dashboard uses it. Nothing sits outside it except full-bleed background bands (the band is full-bleed; its content is in `.container`).
- Long reading (About, Privacy, Terms, Contact copy): `.container.container--prose` (820 px) — the **left edge still aligns** with `.container` on every other page because gutters are identical; only the right edge comes in.
- Single-form pages (auth, checkout, sandbox card): `.container.container--narrow` (640 px), centred card.
- `/jobs` with the map open may use `.container--wide` (1360 px). Nothing else.
- Prose inside wider layouts: `.prose` (72ch).

## 2. Page header band (every public page + landings + app pages)
```ejs
<header class="page-head"><div class="container page-head__inner">
  <div>
    <ol class="breadcrumb"><li><a href="/">Home</a></li><li>Jobs</li></ol>   <!-- optional -->
    <p class="eyebrow">For employers</p>
    <h1>Post a job across Canada</h1>
    <p class="lead">One sentence, max 68ch.</p>
  </div>
  <div class="page-head__actions"><a class="kds-btn kds-btn--accent" href="…">Primary</a><a class="kds-btn kds-btn--ghost" href="…">Secondary</a></div>
</div></header>
```
Home is the only page with a hero instead of `.page-head` (it keeps the illustration). Dashboards use `.app-head` (smaller h1) inside `.dash__main`.

## 3. Vertical rhythm
- Sections: `<section class="section">` (40 / 56 / 72 px at phone / tablet / desktop) with `.section__head` (eyebrow + h2 + lead). Alternate background with `.section--alt`. No page-specific paddings.
- Inside cards: 20 px (`.card`), 28 px for hero cards (`.card--pad-lg`). Grid gaps: 16 px (`.grid`), 12 px for chip/check grids.

## 4. Type scale (already in theme.css)
h1 clamp 1.75–2.75rem (Montserrat 800) · h2 clamp 1.4–2rem · h3 1.15rem · body 16px/1.55 Inter · `.lead` 1.125rem muted · `.eyebrow` red caps. Never set font sizes on headings in page CSS; never use a second display face.

## 5. Components
- Cards: `.card` (white, 1px border, 16px radius). Interactive lists use `.job-card`. No shadows except hover.
- Buttons: `.kds-btn--accent` (red) = the ONE primary action on a page; `.kds-btn--brand` (navy) for secondary-primary; `.kds-btn--ghost` for everything else; `--sm` only in tables/rows. 44 px min-height everywhere.
- Badges: `.badge` variants only. Audience chips: `.aud.aud--<key>`.
- Forms: `.form` > `.field` (label, control, hint/error) with `.form-row` for pairs; inputs `.input`; checkbox tiles `.checks > .check`. Required marker: `<span class="req">*</span>` in the label. Sticky action bar on phones: `.sticky-bar`.
- Tables: `.table.table--stack` with `data-label` on every cell.
- Empty states: `.empty` with one sentence and one CTA.

## 6. Find Jobs (the special page)
Desktop ≥1024: a **compact filter bar on top** (keyword, place + Near me, radius, category, province, "More filters" drawer) and below it **one results column + the map** (`grid-template-columns: minmax(0, 1fr) minmax(360px, 42%)`; map sticky; "Hide map" toggle collapses to a single 760px-max list). Cards are full-width rows (title, company, location + distance, salary, type chips, posted) — never a 2-column card grid next to a map. Tablet: same without the sticky map (map toggle). Phone: List / Map segmented control under the filter bar; filters open in a full-screen drawer.

## 7. Mobile first, always
No horizontal scroll at 390; touch targets ≥44 px; sticky bars must not cover content (add bottom padding equal to the bar); tables stack; images `max-width:100%`.

## 8. Copy hygiene
Sentence case for headings and buttons ("Post a job", not "Post A Job"). Prices always "$14.99 + GST" / "$9.99 + GST". Company shown as operating name, "Operated by <legal>" underneath. No internal names (Veda) in public copy — say "our support team".
