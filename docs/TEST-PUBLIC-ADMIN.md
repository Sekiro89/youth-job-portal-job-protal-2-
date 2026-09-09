# Test report — public site, Contact Us, admin, security, responsive (agent t3, 2026-09-09)

Instance: `cc_t3` DB, port 3913 (`NODE_ENV=development`), plus a second instance on port 3923 with
`NODE_ENV=production` for error-page/header checks. Scripts live in the session scratchpad
(`t3agent-t1.js` public, `-t2.js` contact, `-t3.js` admin, `-t4.js` security, `-t5.js` session, `-browserpost.js`
real-Chrome form POST, `-shots.js` screenshots); PNGs are in `shots/t3/`. Last full run: all four suites green
except the items listed under "Outside my files" (77 + 26 + 92 + 83 checks).

## Bugs fixed (my files)

| # | Bug | Repro | Fix |
|---|-----|-------|-----|
| 1 | `?page=` beyond the last page rendered "8 jobs found" over an empty list, title "— page 2" | `GET /jobs?page=2` | `routes/public.js`: 302 to the last real page, filters kept |
| 2 | NUL byte in `q`/`city`/slug → Postgres error → 500 | `GET /jobs?q=%00`, `/jobs/%00`, `/companies/%00` | `routes/public.js`: `str()` strips `\0`; `SLUG_RE` 404s impossible slugs before hitting the DB |
| 3 | NUL byte in any Contact Us field → 500 | `POST /contact` with `name=Null\0Byte` | `routes/contact.js`: `s()` strips `\0` |
| 4 | `/admin/messages/1e3` opened ticket #1 (`parseInt('1e3') === 1`) | admin GET `/admin/messages/1e3` | `routes/admin.js`: `int()` requires plain digits; `s()` strips `\0` |
| 5 | Dev-only `/admin-dev-login?next=/\evil.example` open redirect (`/\` is `//` to browsers) | dev instance only | `routes/admin.js`: `safePath()` rejects `//` and `/\` |
| 6 | Admin Messages / Jobs / Users lists silently capped at 200 / 300 / 300 rows | insert 250 messages via psql → rows 201+ unreachable | `routes/admin.js` + `views/admin/_pager.ejs` (new) + `messages/jobs/users.ejs`: 50 per page, "Page x of y · N unit", filters preserved in pager links, out-of-range page clamps |
| 7 | `/jobs` sidebar pinned sticky with an internal scroll → on a 900 px-tall viewport "Show results" was hidden with no visible scrollbar (jobs-1440.png before fix) | open `/jobs` at 1440×900 | `public/css/public.css`: sticky only at `min-height: 1150px` |
| 8 | Content: About said alerts come "daily, weekly or instantly" (no weekly option exists) | `/about` job seekers section | `views/about/about.ejs` |
| 9 | Content: Terms said "again every 30 days" but billing renews on the same calendar day each month (`lib/billing.js addMonth`) | `/terms` §3 | `views/public/terms.ejs` |
| 10 | Content: Contact page claimed support is reachable "from their dashboard" — no such link exists | `/contact` promise card | `views/contact/index.ejs`: points to "Include my account" instead |

## Outside my files — repro + proposed patch (owner: orchestrator)

1. **CRITICAL — every browser form POST returns 403 "Cross-site request blocked".** helmet's default
   `Referrer-Policy: no-referrer` makes Chrome/Firefox send `Origin: null` on same-origin form posts (Fetch spec
   §4.5 "append a request Origin header"); `sameOriginGuard` then rejects it. Nobody caught it because every test
   harness (`scripts/cdp.js request()`) adds an explicit `Origin` header. Repro: `t3agent-browserpost.js` drives
   headless Chrome to submit `/login` → 403; with the patch it lands on `/jobseeker/dashboard`.
   Patch `server.js` line 26: `app.use(helmet({ referrerPolicy: { policy: 'strict-origin-when-cross-origin' }, contentSecurityPolicy: {...` (proved via a `-r` preload shim on my instance, see SECURITY.md).
   Also in `lib/auth.js sameOriginGuard`: treat `origin === 'null'` as a rejection explicitly (it already falls
   through to 403 because `new URL('null')` throws — fine, but make it intentional).
2. **Session fixation** — `lib/auth.js login()` sets `req.session.userId` without regenerating the SID
   (verified: same `cc_session` before/after login). Patch: wrap in `req.session.regenerate` and carry over
   `returnTo`/`flash`:
   ```js
   async function login(req, user) {
     const keep = { returnTo: req.session.returnTo, flash: req.session.flash };
     await new Promise((res, rej) => req.session.regenerate(e => e ? rej(e) : res()));
     Object.assign(req.session, keep, { userId: user.id });
     await db.query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
     const to = req.session.returnTo || homeFor(user); delete req.session.returnTo; return to;
   }
   ```
3. **`/\host` open redirect** — `routes/seeker.js:298 isSafeReturn` and the dev logins in `routes/seeker.js:391`,
   `routes/portal.js:125`, `routes/billing.js:22` accept `/\evil.example` (portal also accepts `//evil`).
   Patch: `const isSafeReturn = (u) => typeof u === 'string' && /^\/(?![\/\\])/.test(u);` (use it in all four).
   Live impact is low: the only production route is `POST /jobseeker/notifications/read` (same-origin POST by a
   logged-in seeker); the rest are dev-only.
4. **500 on non-numeric ids** — `POST /jobseeker/applications/abc/withdraw` and `POST /jobseeker/saved/abc/remove`
   (`routes/seeker.js:598`, `:641`) pass the raw param to a bigint column. Patch: `':id(\\d+)'` / `':jobId(\\d+)'`.
   Same for `GET /jobs/%00/apply` (`routes/seeker.js:360 publicJob`) — strip `\0` or apply the slug regex.
5. Rate limits (login 5/10 min, contact 5/h) are **per session** — dropping the cookie resets them
   (`routes/auth.js:150`, `routes/contact.js`). Needs an IP-keyed store for real protection.
6. Cosmetic: `views/admin/outbox-item.ejs` preview iframe is `sandbox=""` (opaque origin) so the CSP `img-src 'self'`
   blocks the email logo in the preview only. Optional: add `http://localhost:*`? No — leave; real mail is fine.

## What was verified (all PASS unless noted above)

**Public search** — every filter alone and combined; `province` case-insensitive; `city` substring; audience
multi-select (`&&` overlap); `salary_min` uses `COALESCE(max,min)` annualised at 2080 h (so `$50,000+` matches
the $48k–$55k job — documented, intended); `sort=salary` order Full-Stack › RN › AZ › … › Warehouse; `q` with
quotes, apostrophes, `%`, `_`, unicode, 5000 chars, arrays (`q[]=`), SQL fragments — all 200, escaped in title,
h1 and inputs; `page=0/-1/abc/999999`; `loc=prov:`/`city:`/junk redirects; chips remove exactly one filter and
keep `sort`; `noindex` when >2 chips or page>1; canonical normalised (`province=sk` → `SK`, junk params dropped);
home category (20) and province (13) counts equal the list counts; sitemap = exactly the 8 live slugs + 3
companies, no app URLs; robots disallows `/admin /employer/ /consultant/ /jobseeker/ /billing /login /signup
/forgot /reset/ /account`; archived/draft/pending slugs 404 with `noindex`; company pages hide archived jobs;
JSON-LD parses on `/ /jobs /jobs/:slug /companies/:slug /about /contact /employer /consultant /jobseeker`;
JobPosting has title, description, datePosted, validThrough, hiringOrganization, jobLocation, employmentType,
baseSalary (HOUR/YEAR), identifier, directApply, url, plus TELECOMMUTE for remote; views counter increments.

**Contact** — valid → 302 `/contact/thanks?ref=N`, row stored raw, exactly 2 `mail_outbox` rows; Veda's email
has `[Contact #N] Category: subject`, the yellow "Reply to: <mailto>" line, IP/UA, account line (`#4 · seeker ·
link to /admin/users?q=…` when signed in) and the "Open ticket #N in admin" button; `<img onerror>`, `<script>`,
quotes escaped in both HTML bodies and preserved raw in the text bodies; ack email greets by escaped first name;
invalid → 422 with 4 field errors + summary, input kept; honeypot → fake `ref=0` thanks, nothing stored; 6th
message in an hour → 422 form error; signed-in prefill readonly + "Include my account" uses the account identity
and ignores spoofed name/email; unticked keeps typed values but still links `user_id`; `?category=` preselect,
junk ignored; cross-origin POST → 403.

**Admin (veda@)** — guest → `/login`, seeker/employer/consultant → their dashboards for GET and POST; every page
200 + `noindex` + `<h1>` incl. junk filters (`status=bogus`, `category=<x>`, `q='"`, `%`, `_`, `\`, `' OR 1=1`,
500 chars); bad ids (`0`, `999999`, `abc`, `1e3`, `%00`) → 404 for messages/outbox and for archive/restore/
toggle POSTs; status change (+ bad status rejected), notes, empty reply → error flash, reply → mail with
signature + quoted original (escaped), status resolved + note appended, "Emails on this ticket" lists it;
take-down → `inactive` + public 404 + redirect back to the referer filter; archive of a draft refused; restore
only with paid-up sub (job 1 yes, expired job 9 no); self-deactivate refused; deactivating seeker2 kills their
session (`/jobseeker/dashboard` → `/login`) and blocks login (403); reactivate; settings 422 ×3 with values
kept, valid save, env-override badge; outbox preview `sandbox=""` + escaped `srcdoc`, 50/page with filters
kept; payments totals + admin can open any receipt; 250 messages / 120 mails / 80 users → paginated.

**Responsive** — 21 pages × 390/768/1024/1440 (+ 6 re-shoots): no horizontal overflow anywhere, no console
errors; every PNG in `shots/t3/` was opened and inspected. Admin tables stack to cards below 1200 px; the 390
admin nav is a horizontal pill strip; contact 422 and settings 422 states captured for real via a headless-Chrome
form submit (`contact-errors-*.png`, `admin-settings-errors-*.png`).

**Content** (as the Canadian client) — pricing wording consistent everywhere: "$9.99 CAD per month plus 5% GST
($0.50) = $10.49", "renews monthly until you cancel", receipts numbered; Veda named on Contact page, thanks
page, both emails and the admin inbox; fixes 8–10 above.

## How to re-run

```bash
cd /home/ubuntu/projects/canada-careers && PW=$(cut -d= -f2 docs/.dbpw)
NODE_ENV=development DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/cc_t3" PORT=3913 PUBLIC_URL=http://localhost:3913 SUPPORT_EMAIL=veda@canadacareers.local node server.js &
export DATABASE_URL="postgres://canada_careers:$PW@127.0.0.1:5432/cc_t3"
for t in t1 t2 t3 t4; do node <scratchpad>/t3agent-$t.js | grep -c ^PASS; done
```
