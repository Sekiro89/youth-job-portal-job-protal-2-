# Security review — Canada Careers (2026-09-09, agent t3)

Scope: every route in `routes/*.js` exercised on an isolated instance (`cc_t3`, port 3913) with a second
`NODE_ENV=production` instance on 3923 for error pages and headers. Method: scripted probes
(`t3agent-t4.js`, 83 checks) + a real headless-Chrome form submission (`t3agent-browserpost.js`).
Status legend: **fixed** = patched in a file I own and re-tested; **open** = outside my files, patch proposed in
`docs/TEST-PUBLIC-ADMIN.md`; **ok** = tested, no issue.

## Findings

| Sev | Area / route | Finding | Status | Owner file |
|-----|--------------|---------|--------|------------|
| **Critical** | every `POST` (login, signup, contact, apply, post-a-job, admin actions) | helmet default `Referrer-Policy: no-referrer` ⇒ browsers send `Origin: null` on **same-origin** form posts ⇒ `sameOriginGuard` returns 403. Reproduced in headless Chrome (`/login` → "Cross-site request blocked"); fixed by `referrerPolicy: { policy: 'strict-origin-when-cross-origin' }` (proved with a preload shim, login then reaches the dashboard). All existing test harnesses add an explicit `Origin` header, which hid this. | **open** | `server.js` |
| Medium | `POST /login` | Session fixation: SID is not regenerated on login (same `cc_session` value before and after). Exploitable only if an attacker can plant a cookie (subdomain / XSS), which the current CSP+HttpOnly setup makes hard. Logout does regenerate. | **open** | `lib/auth.js login()` |
| Medium | `/login`, `/contact` | Rate limits (5 failed logins / 10 min; 5 messages / hour) are keyed on the session ⇒ reset by dropping the cookie. Verified. | **open** | `routes/auth.js`, `routes/contact.js` (needs a shared IP store) |
| Low | `POST /jobseeker/notifications/read` (`next`), dev logins `/seeker-dev-login`, `/portal-dev-login`, `/billing-dev-login` | `isSafeReturn` accepts `/\evil.example` (browsers read `/\` as `//`); portal dev login also accepts `//evil`. Notifications route needs a same-origin POST by a logged-in seeker, dev logins are absent in production (verified 404 ×4). | **open** | `routes/seeker.js:298,391`, `routes/portal.js:125`, `routes/billing.js:22` |
| Low | `/admin-dev-login?next=/\…` | same as above | **fixed** (`safePath()`) | `routes/admin.js` |
| Low | `POST /jobseeker/applications/:id/withdraw`, `/jobseeker/saved/:jobId/remove`, `GET /jobs/:slug/apply` | Non-numeric id / NUL slug reaches Postgres ⇒ 500 (generic page in production, no stack). | **open** | `routes/seeker.js:598,641,360` |
| Low | `/jobs?q=`, `?city=`, `/jobs/:slug`, `/companies/:slug`, `POST /contact`, `/admin/*?q=` | NUL byte ⇒ Postgres error ⇒ 500 | **fixed** (strip `\0`, slug regex) | `routes/public.js`, `routes/contact.js`, `routes/admin.js` |
| Low | `/admin/messages/1e3` | `parseInt` accepted `1e3` as id 1 | **fixed** | `routes/admin.js` |
| Info | CSP | `script-src` and `style-src` carry `'unsafe-inline'`. Needed today by: `views/public/home.ejs` (`<script>document.documentElement.classList.add('js')</script>`), `views/contact/index.ejs` (account toggle script), inline `style=` on error text in admin views, and every JSON-LD block is fine without it (not executed). Moving the two inline scripts into `public.js`/a contact JS file plus a per-request nonce would allow dropping `'unsafe-inline'` from `script-src`; `style-src` would still need it for the KDS inline styles. `script-src-attr 'none'` is already set, so inline `onerror=` handlers are blocked. | open (design) | `server.js`, views |
| Info | `lib/auth.js sameOriginGuard` | Requests with **no** Origin and no Referer are accepted. Browsers always send `Origin` on cross-site POST (and `null` for sandboxed/opaque contexts, which is rejected because `new URL('null')` throws), and the session cookie is `SameSite=Lax`, so a cross-site form post carries no session anyway. The bypass only matters for very old browsers or privacy extensions that strip `Origin` *and* ignore SameSite — accepted risk; document it. | ok (documented) | — |

## Verified OK (no finding)

- **IDOR**: resume download (`/employer/applications/:id/resume`) owner-only (consultant → 404, seeker → role
  redirect, guest → login); application status/notes cross-owner → 404; `/employer/jobs/4` (+edit/pause/
  applicants) cross-owner → 404; `/consultant/profiles/1/edit|archive` cross-owner → 404; receipts
  (`/billing/receipt/:id`) owner or admin only; checkout/cancel/success for another owner's job refused;
  `withdraw`/`saved remove`/`notifications read` scoped by `user_id`; owner logo route cross-owner → 404;
  public `/logos/:id` only for non-archived profiles; `/logos/../../.env` → 404.
- **Role guards**: `/admin/*` (GET and POST) bounce non-admins to their own dashboard; `/employer/*` ↔
  `/consultant/*` redirect to the right prefix; `/jobseeker/*` seeker-only; `/billing/*` employer/consultant
  (+admin for receipts).
- **Open redirect**: `returnTo` is only ever set from `req.originalUrl` (always a path); `?next=` on `/login` is
  ignored; `//evil` rejected everywhere; back-to-referer helpers keep only `pathname+search`.
- **CSRF**: cross-origin `Origin` → 403; `Origin: null` → 403; host-suffix trick (`localhost:3913.evil`) → 403;
  bad Origin + good Referer → 403 (Origin wins); cookie `HttpOnly; SameSite=Lax` (+`Secure` in production).
- **Uploads**: multer memory storage, 5 MB limit (422 with message), MIME+extension whitelist (`text/html` →
  422), filename never used for the path (`../../../evil.pdf` → `resumes/5-<rand>.pdf`), `.exe` with a PDF MIME
  is stored as `.pdf`; downloads are `Content-Disposition: attachment`; logos: SVG allowed but served with
  `CSP default-src 'none'` + `X-Content-Type-Options: nosniff`, HTML-as-PNG served as `image/png`. No
  content sniffing of uploads (a "PDF" can be anything) — acceptable because nothing is ever rendered inline
  except logos, which are CSP-isolated.
- **Static exposure**: `/uploads/…`, `/data/uploads/…`, `/.env`, `/../.env`, `/docs/.dbpw` → 404.
- **SQL injection**: every parameter is bound; probes on `q`, `category`, `salary_min`, `page`, slugs, portal
  `status`/`profile`/`job`, admin `status`/`role`/`page`, receipt and reset ids → no 500, `jobs` intact. Admin
  `ILIKE` searches do not escape `%`/`_` (wildcards only, not injection).
- **Production instance (3923)**: 500 page says "Something went wrong on our side" with no stack/pg message;
  404 page generic; all four `*-dev-login` routes → 404; `Strict-Transport-Security max-age=31536000;
  includeSubDomains`; no session cookie on anonymous GETs; static `Cache-Control: public, max-age=86400`;
  `X-Powered-By` removed; `X-Frame-Options: SAMEORIGIN`; `X-Content-Type-Options: nosniff`.
- **XSS**: user text is escaped in pages (`<%= %>`, `h.paragraphs`), in both HTML emails (`escapeHtml`) and in
  the outbox preview (`sandbox=""` iframe with escaped `srcdoc`); JSON-LD escapes `<` as `<`.
- **Passwords / tokens**: bcrypt(10); reset tokens 64-hex, 1 h expiry, cleared on use; deactivation deletes
  the user's sessions from the store.
