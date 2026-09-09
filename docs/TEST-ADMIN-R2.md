# Test report — admin panel round 2 (Integrations, admin users, Contact Us routing) — 2026-09-10

Instance: DB `cc_contact`, port 3907, `NODE_ENV=development`, `PUBLIC_URL=http://localhost:3907`. Driven with curl + cookie jars
(scripts in the session scratchpad: `t1.sh` unlock/first-run, `t2.sh` lock-out, `t3.sh` save every group, `t4.sh` action buttons +
admin users + passcode change + contact routing, `shots.js` screenshots via `scripts/cdp.js`). Screenshots in `shots/admin-r2/`
(`REPORT.txt` = overflow audit: every page `ok` at 390 and 1440).

## What was verified (all PASS)

| Area | Check | Result |
|---|---|---|
| Gate | `GET /admin/integrations` while locked | 302 → `/admin/integrations/unlock?next=…` |
| First run | no passcode saved → unlock page offers "Set the Integrations passcode"; `abc` rejected (min 6); `secret123` saved, session unlocked, redirect to `next` | PASS; DB row `admin_passcode` = `enc:v1:…`, `is_secret=t` |
| Lock-out | 5 wrong passcodes in a fresh session | "4 attempts left" … "locked for 15 minutes"; the right passcode is then refused; POST to a group while locked → 302 to unlock; audit rows `integrations.unlock {ok:false,fails:n}` + `integrations.unlock_locked` |
| Lock now | `POST /admin/integrations/lock` then GET | 302 to unlock; unlock with the new passcode → 200 |
| Branding | `http://evil.example` rejected ("must start with https://"); https URL + phone + multi-line address saved | values round-trip on reload; tags flip Default/.env → **Saved here** |
| Pricing | `0`, `abc`, `gst_rate=0.5` → three error flashes; `1999/1299/0.13/123456789 RT0001` saved | round-trip; `/admin/payments` header recomputes from the saved prices |
| Stripe | `hello` rejected as a key; `sk_test_FAKE…` + `pk_test_…` + Stripe Tax saved | reload shows `sk_test••••7890` masked; DB value `enc:v1:…`; **Clear** tick removes it (DB value empty) |
| Stripe buttons | Test connection with the fake key | "Stripe rejected the key: Invalid API Key provided: sk_test_****…7890." (clean error, no stack) |
|  | Create prices & webhook with the fake key | "Creating prices failed: Invalid API Key provided…" |
|  | Test connection with no key | "No Stripe secret key configured — paste sk_test_… …" |
| Email | provider `smtp` + `smtp://x:y@localhost:1`, Send test | "not delivered (smtp): connect ECONNREFUSED 127.0.0.1:1 — see outbox #16" (outbox row status `failed`) |
|  | provider `none`, Send test | "No email provider configured (choose SMTP or Resend and save first)." |
| Support | `veda@example.com, bad-address` | rejected: "Not a valid email address: bad-address." (typos are reported, not silently dropped) |
|  | two valid addresses | saved normalised `veda@example.com, owner@example.com`; overview + status card show both |
| Maps | `maps_provider=osm` saved; Test key with no key | "No Google Maps key is saved — the site is using OpenStreetMap…" |
| Job Bank | `off` saved | select shows Off; status tile "Daily import skipped" |
| Admin users | add with 5-char password → rejected; add `sam@example.com` / 14-char → created; duplicate → "already has an account (admin)" | PASS |
|  | real `POST /login` as Sam → 302 `/admin`, `GET /admin` 200 | PASS |
|  | Reset Sam's password | Sam's existing session bounced to `/login` (signed out everywhere) |
|  | Disable Sam → login with the new password | 403 (blocked); Enable → active again |
|  | Disable yourself (`/admins/1/toggle` as user 1) | "You cannot disable your own admin account." |
| Passcode change | wrong current → refused; right current + `newpass99` → saved; lock + unlock with the new one | PASS |
| Contact Us | `POST /contact` with 2 recipients, provider none | 3 outbox rows: one per recipient `[Contact #9] Technical issue: …` + the auto-reply to the visitor; audit `contact.submit {recipients:2}` |
|  | page copy | "our technical support team" ×5, `supportName` ("Maple support") used where a name is needed, no "Veda" anywhere in my files |
| Legacy | `GET /admin/settings` | 301 → `/admin/integrations` |
| Audit | every unlock / lock / save / test / admin change | rows present; `settings.update.meta.secrets` lists key names with `set`/`cleared` only, never values |
| Mobile | 390 px: nav chips scroll, status tiles stack, secret Replace/Clear stack, admins table becomes cards; 1440 px: sticky left sub-nav | no horizontal overflow on any of the 6 pages |

## Bugs found and fixed while testing (my files)

1. `routes/admin.js` referenced `mail.configured` (now a function) and `mail.FROM` (gone) → overview/outbox pages used `(await mail.config())`.
2. Support-email validation ran on the already-filtered list, so a typo was silently dropped instead of reported → validate the raw input first.
3. Stripe setup handler assumed `setupCatalog()`/`createWebhookEndpoint()` throw and return arrays → rewritten to the billing agent's real `{ ok, error, prices:{}, created, existing }` / `{ ok, id, created, secret, secret_saved, note }` shapes (it had shown "undefined prices ready" as a success).
4. `testConnection().account` is an object → the success flash now prints business name / id / country instead of `[object Object]`.
5. Screenshot harness: `Page.loadEventFired` must be awaited *before* `Page.navigate` on localhost (race).

## Not verified (needs real credentials)

- A successful Stripe "Test connection" / "Create prices & webhook" (needs a real `sk_test_` key), a delivered test email (needs a real SMTP/Resend account), and a successful Google Maps key test. The failure paths of all three are verified above.
- `Reply-To` on the support emails: `mail_outbox` has no reply_to column, so it can only be observed with a real provider (the value is passed to `mail.send({ replyTo })`).

## How to re-run

```bash
DBURL=$(grep ^DATABASE_URL= .env | cut -d= -f2- | sed 's#/cc_main$#/cc_contact#')
DATABASE_URL=$DBURL node scripts/migrate.js && DATABASE_URL=$DBURL node scripts/seed.js
NODE_ENV=development PORT=3907 PUBLIC_URL=http://localhost:3907 DATABASE_URL=$DBURL node server.js &
curl -c j -b j -o /dev/null 'localhost:3907/admin-dev-login/veda@canadacareers.local?next=/admin'
curl -c j -b j -H 'Origin: http://localhost:3907' -X POST -d 'action=set&passcode=secret123&passcode2=secret123' localhost:3907/admin/integrations/unlock
curl -c j -b j localhost:3907/admin/integrations | grep -c 'int-group'   # 9 sections
```
