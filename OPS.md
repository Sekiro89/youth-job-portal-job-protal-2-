# Canada Careers — OPS / README

> Job bank portal for a Canadian client: employers and third-party consultants post jobs ($9.99 + GST per posting per month, recurring until cancelled); job seekers upload a resume, apply online and get alerts matched to their profile; Contact Us goes to Veda (technical support). Five audiences from the logo: Professionals, New Immigrants, Indigenous, Refugees, Youth.

**Status:** built, awaiting DNS for jobs.khosha.tech  ·  **Last updated:** 2026-09-09 by Claude (Fable 5.1)

---

## 1. Development
| | |
|---|---|
| **LLM used to develop** | Claude Fable 5.1 (Claude Code) — orchestrator + 9 parallel agents (public, auth, portal, seeker, billing, about, contact/admin, brand, QA). Build contract: `docs/CONTRACT.md` |
| Source repo | local git only (`~/projects/canada-careers`) — no GitHub remote yet |
| Language / stack | Node 24 · Express 4 · EJS + express-ejs-layouts · pg · express-session (pg store) · multer · nodemailer · stripe · vendored KDS tokens (`public/kds/`) |
| Code owner (person) | Ankit (ankitjm@gmail.com); client-side support: Veda |
| Runs as OS user | ubuntu |

## 2. Hosting / server
| | |
|---|---|
| Host | srv1751425 · 187.127.180.28 · Ubuntu 26.04 |
| Code path | `/home/ubuntu/projects/canada-careers` |
| Persistent data path | `data/uploads/` (resumes under `resumes/`, company logos under `logos/`) — never served statically; only via authorised routes |

## 3. Runtime / process
| | |
|---|---|
| Process manager | `canada-careers.service` (systemd) + `canada-careers-renewals.timer` (daily 07:15 UTC → `node jobs/run.js`) |
| Start / stop | `sudo systemctl restart canada-careers` · `sudo systemctl start canada-careers-renewals.service` (run renewals now) |
| **Port** | 3900 — 127.0.0.1 only, behind Caddy |
| Health check | `curl -s localhost:3900/healthz` → `{"ok":true}` |
| Logs | `canada-careers.log`, `renewals.log` in the project dir |
| Boot persistence | enabled, Restart=always |

## 4. Database
| | |
|---|---|
| Engine | host PostgreSQL 18 |
| Database name | `cc_main` (dev sandboxes `cc_public cc_auth cc_portal cc_seeker cc_billing cc_about cc_contact cc_brand cc_qa` — droppable) |
| Role / user | `canada_careers` (password in `.env` DATABASE_URL and `docs/.dbpw`, both mode 600) |
| Connection | 127.0.0.1:5432 |
| Schema / migrations | `db/schema.sql` (idempotent) via `npm run migrate`; demo data via `npm run seed` (password for every seed user `Password123!`) |

## 5. Routing / network
| | |
|---|---|
| Public domain | jobs.khosha.tech (A record → 187.127.180.28 — **pending** as of 2026-09-09) |
| TLS | Caddy automatic Let's Encrypt |
| Reverse proxy config | `/etc/caddy/Caddyfile` block `jobs.khosha.tech` → `127.0.0.1:3900`; `/data/* /docs/* /.env* /.git/*` blocked at Caddy |
| Reload Caddy | `sudo caddy reload --config /etc/caddy/Caddyfile` (systemctl reload is broken on this box) |

## 6. Environment / secrets
- **`.env`** at project root (600). Keys: `DATABASE_URL SESSION_SECRET PUBLIC_URL PORT SMTP_URL MAIL_FROM SUPPORT_EMAIL SUPPORT_NAME STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PUBLISHABLE_KEY POSTING_PRICE_CENTS GST_RATE UPLOAD_DIR`.
- Empty `SMTP_URL` ⇒ emails are recorded in `mail_outbox` (visible at `/admin/outbox`) but not sent. Empty `STRIPE_SECRET_KEY` ⇒ **sandbox billing** (simulated card `4242 4242 4242 4242`). See `docs/BILLING.md`.
- `SUPPORT_EMAIL` = where Contact Us messages go (Veda).

## 7. Backup & restore
- **What:** database `cc_main` + `data/uploads/`.
- **How:** `sudo -u postgres pg_dump -Fc cc_main > backups/cc_main-$(date +%F).dump` and `tar czf backups/uploads-$(date +%F).tgz data/uploads` — ⚠️ not yet scheduled (task tracker).
- **Restore:** `sudo -u postgres pg_restore -d cc_main --clean backups/<file>.dump`; untar uploads.

## 8. SOP — maintenance runbook
- Deploy a change: edit → `node -c` / run `BASE_URL=http://localhost:3900 node scripts/smoke.js` → `sudo systemctl restart canada-careers` → `curl localhost:3900/healthz`.
- Run renewals/expiry by hand: `sudo systemctl start canada-careers-renewals.service; tail renewals.log`.
- Screenshots at 390/768/1024/1440: `node scripts/shots.js` (see `docs/QA.md`).
- Go live with real payments: set the three `STRIPE_*` keys, register webhook `https://jobs.khosha.tech/billing/webhook` (events in `docs/BILLING.md`), restart.
- Go live with email: set `SMTP_URL` (e.g. Resend/SES SMTP URL) and `MAIL_FROM`, restart; check `/admin/outbox` statuses.

## 9. Dependencies / gotchas
- Public visibility rule lives in ONE place: `lib/jobs.js` `PUBLIC_WHERE` (`status='active' AND expires_at > now()`). Expired/cancelled/inactive postings are archived = never rendered publicly (404) and excluded from the sitemap.
- Router mount order in `server.js` matters: auth, seeker, portal, billing, about, contact, admin, then public LAST (catch-alls).
- The Stripe webhook route receives a raw body (mounted before the JSON parser).
- Dev-only login helpers (`/portal-dev-login/...` etc.) are disabled when `NODE_ENV=production`.

## 10. Change log
- 2026-09-09 — initial build (orchestrator + 9 agents), systemd units, Caddy block.
- 2026-09-09 (later) — second wave: Stripe path hardened + offline lifecycle test (`node scripts/test-stripe.js`, 26/26), `docs/STRIPE-GO-LIVE.md`; Job Bank importer (`scripts/import-jobbank.js`, `jobs/jobbank-sync.js` wired into the daily runner) — 256 real postings imported into `cc_main`; three tester agents' fixes; critical fix: helmet `no-referrer` made browsers send `Origin: null` so every form 403'd — now `strict-origin-when-cross-origin`; session id regenerated on login; scroll-restoration disabled (pages open at top); `PUBLIC_WHERE` now also excludes archived employer profiles.
