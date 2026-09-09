# Seeker + auth + consultant test log (agent t2)

Instance: `PORT=3912`, DB `cc_t2`, uploads `data/uploads/t2/`, run 2026-09-09. Helpers: `shots/t2/h.sh` (curl + cookie jars),
`shots/t2/notify-test.js` (matching/digest harness), `shots/t2/shoot.js` + `shots/t2/pages.json` (CDP screenshots →
`shots/t2/d-<page>-<width>.png`, summary `shots/t2/d-REPORT.txt`). Consultant scenario data: user `t2-consultant@example.com`,
profiles 4–9, jobs titled `[t2A]`; matching jobs titled `[t2N]`; seekers `t2-aisha|ben|chloe|pat|weak@example.com`.

Format: scenario → result → bug → fix → verification. "OK" = behaved as the contract says, nothing changed.

## A. Third-party consultant (read-only: portal/billing belong to other agents)

| Scenario | Result |
|---|---|
| Signup → 4 profiles (ON/BC/AB/NS, one with PNG logo) → 2 drafts each → publish + sandbox-pay two (different profiles) | OK: active, `expires_at` +1 month, `subscriptions.total_cents=1049`, receipts `CC-202609-0000NN`, public + in sitemap |
| Dashboard per-company cards, `/consultant/jobs?profile=N` filter, status tabs, `/billing` per-company subtotals, receipt owner-only | OK (receipt: 200 owner+admin, 404 other users, 302 guest) |
| Archive profile with active jobs / with drafts only | OK: refused with flash / succeeds and disappears from selector, dashboard, `/companies/:slug`, `/logos/:id` |
| Post under another owner's `employer_profile_id` (1, 2); edit/publish/pause/duplicate/applicants/resume of jobs 1 and 4 | OK: 422 "Choose which company…" / 404 or redirect, no rows created |
| Consultant on `/employer/*` | `/employer/profile` → 302 `/consultant/profile` → 302 `/consultant/profiles` (double redirect, harmless). Employer on `/consultant/profiles` → redirected |
| Cancel at period end → resume → cancel now; pause; duplicate | OK |
| XSS company name / job title / description across 29 pages incl. JSON-LD + emails | OK — nothing unescaped |
| **BUG (major)** draft under an ARCHIVED profile can still be published, paid and goes live; `/companies/:slug` for it 404s | outside my files — `routes/portal.js:153-162` (loadJob), `:464-468` (publish), `routes/billing.js:64-96` (checkout), `lib/jobs.js` `PUBLIC_WHERE` ignores `employer_profiles.archived` (public.js only filters archived on `/companies` + sitemap companies) |
| **BUG (minor)** logo upload trusts client MIME: 18-byte text file sent as `image/png` is stored and served as `image/png` | `routes/portal.js:43` fileFilter, `:52-59` saveLogo — add magic-byte sniff (same approach as resumes, see B) |
| **BUG (minor)** dashboard per-company table has no Drafts column (6 drafts invisible per company) | `views/portal/dashboard.ejs:40`, `routes/portal.js:187-193` |
| Cosmetic: consultant pages carry `/employer` + `/employer#pricing` links from the global nav/footer | `views/partials/footer.ejs:11`, `partials/nav.ejs` (orchestrator) |

## B. Job seekers

| Scenario | Result → bug → fix → verification |
|---|---|
| Signup 3 seekers (`/signup/seeker`) with audiences/province, XSS in name | OK: `seeker_profiles` row created with city/province/audiences/notify_email; welcome email escaped. Name `Aisha <script>…</script>` was accepted → **fixed**: names may not contain `<`/`>` (`routes/auth.js` `nameError`, signup + `/account`) → re-POST gives 422 "Names cannot contain < or >." |
| Profile save (headline/summary with HTML, categories, provinces, keywords with trailing comma, skills) | OK: stored raw, rendered escaped on profile/dashboard/apply/applications (`grep -c '<script>alert'` = 0); keywords deduped/trimmed, capped 20; skills capped 40 chars |
| Resume upload matrix: pdf / doc / docx / 6 MB / exe-renamed-`.pdf` / txt-as-`application/pdf` / txt-as-`text/plain` / pdf-as-`octet-stream` | pdf/doc/docx OK; 6 MB → 422 "5 MB or smaller"; txt/plain → 422. **BUG**: MIME + extension were checked but both come from the file NAME in a browser, so `evil.pdf` (MZ header) and `notes.txt` sent as `application/pdf` were stored as `.pdf`. **Fix** `routes/seeker.js` `resumeMagicOk/checkResumeFile`: `%PDF` / OLE `D0CF11E0…` / zip `PK\x03\x04` sniffing on the in-memory buffer, empty files rejected → verified 422 "does not look like a real PDF, DOC or DOCX" on profile AND apply; real pdf/doc/docx still 302 |
| Replace resume while an application references the old file | OK: `removeFile` keeps files referenced by `applications.resume_path` (`7-f738d2ec0024.docx` kept, unreferenced one deleted); download of profile resume returns the right bytes with `Content-Disposition: attachment` |
| Apply with profile resume + XSS cover letter; apply twice; apply with fresh upload + save-to-profile; upload with no file / wrong type; cover letter 3001 chars | OK: row + 2 emails (seeker confirmation, employer "New applicant" — name/headline/cover escaped in html; text part is plain text); second apply → flash + redirect, apply page shows "You applied on …"; fresh upload stored per-application and copied to profile; 422s with field errors |
| Guest apply → login → returnTo | OK: `/jobs/:slug/apply` → 302 `/login` (info flash) → POST /login → 302 back to `/jobs/:slug/apply` |
| Apply/save on expired, cancelled, draft, unknown slug; employer tries to apply/save | OK: 404 (page + POST); employer → 302 to the job with "Only job seeker accounts…" |
| Withdraw own submitted / viewed / someone else's / `abc` | submitted → deleted + audit; viewed → "can no longer be withdrawn"; other user → same error, no change. **BUG**: `/jobseeker/applications/abc/withdraw` and `/jobseeker/saved/abc/remove` → 500 (pg bigint cast). **Fix**: `isId()` guard → 404. Verified 404 for `abc` and 20-digit ids |
| Saved jobs: save (with/without Referer), save twice, unsave, guest, stale (job archived after saving), remove stale | OK: redirect back to the referrer, idempotent, guest → login; stale job listed under "No longer available" with Remove, excluded from the Saved count |
| Notifications: read one (own / other user's id), read all, `next=//evil.com` | OK: other user's id is a no-op; open redirect blocked (falls back to `/jobseeker/notifications`) |
| Alerts instant/daily/off; invalid frequency `weekly` | OK: `weekly` → `instant`; off → notifications only |
| Matching — `notifySeekersForJob` on 4 crafted jobs (`shots/t2/notify-test.js`) | Exactly right: J1 (education/ON, "learn", skill Node.js) → nobody (Ben is BC-only; "RN" does not match "learn"); J2 (healthcare/MB, "support worker") → Chloe only (keyword, no province limits, email off → no mail); J3 (it_software/ON remote) → seeker2 (instant mail) + Ben (daily → no mail); J4 (healthcare/ON "RN", title with `<b>` `&` `"`) → Aisha with instant mail, html escaped. Second call per job → 0 (idempotent). `sendDailyDigests` → 1 (Ben) then 0 |
| Dashboard matches per profile | Aisha: RN/ON jobs; Ben: QA co-op + full-stack (BC); Chloe: PSW Regina (keyword). Empty state was misleading when criteria were set but no job matched → **fixed** (`views/seeker/dashboard.ejs`): distinguishes "no criteria" vs "criteria set, nothing live" and lists the criteria. "Matched jobs" stat showed the 6-card cap → now `countMatchesForSeeker` (`lib/matching.js`) |
| Audience promise on landing ("we highlight the employers hiring for you") vs reality (audiences unused) | **Fixed**: `lib/matching.js` adds +1 ranking boost when `jobs.audiences && p.audiences` (never a trigger on its own); job card shows "· hiring for you"; landing/FAQ copy now says postings from employers hiring for your audience rank higher |
| Resume download with missing file / tampered `resume_path` | flash + redirect; added `startsWith(UPLOAD_DIR)` guard (`routes/seeker.js`) |

## C. Auth

| Scenario | Result |
|---|---|
| Password rules | Only "≥ 8 chars" existed (`aaaaaaaa`, `12345678` accepted). **Fixed** `routes/auth.js` `passwordError` (8–128, ≥1 letter + ≥1 digit, ≠ email) used by signup, reset and account; hints updated in 5 views; account change also rejects "same as current". Verified 422 messages |
| Wrong password ×5 → lockout | OK: 401 ×5 then 429 for 10 min, even with the correct password |
| Remember-me | OK: checked → `Expires` 30 days; unchecked → session cookie (no Expires); `HttpOnly; SameSite=Lax` |
| Forgot / reset (token from `users.reset_token`) / reuse / expired / short password | OK: same "Check your inbox" for unknown email; token single-use (reuse → 302 `/forgot` + flash); expired → refused; old password rejected, new accepted |
| Account edit (name/phone), password change with wrong current | OK. XSS name rendered escaped everywhere (`avatar` shows `&lt;` — now impossible via validation) |
| Deactivate → login → forgot | OK: 403 "deactivated" on login; forgot does not issue a token; other live session bounced to `/login` |
| Session persists across restart | OK: jar logged in before `restart.sh`, dashboard 200 after (pg store) |
| **Logout everywhere** | Did not exist: after a password change the other device stayed signed in. **Fixed**: `endOtherSessions()` in `routes/auth.js` deletes the user's other rows from `"session"` on password change (keeps current device), on reset and deactivate (all devices), plus a "Sign out of all other devices" form on `/account` (`views/auth/account.ejs`). Verified: second jar → 302 `/login` after each |
| Cross-site POST (`Origin: https://evil.example`, or Referer only) | OK: 403 "Cross-site request blocked", row unchanged |

## D. Responsive (390/768/1024/1440) — see `shots/t2/d-REPORT.txt` and the D section below

## E. Copy

- Landing FAQ claimed resumes are "stored securely on Canadian infrastructure" — unverifiable → replaced with what is true (served only to signed-in owners of the posting).
- Alerts page now explains whole-word keyword matching, ranking order, when instant vs daily emails go out.
- Empty states: dashboard (2 variants), applications, saved, notifications, alerts (no criteria warning) all present.
