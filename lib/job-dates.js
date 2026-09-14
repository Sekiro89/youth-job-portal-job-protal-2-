'use strict';
// Application deadline + "posted on" date rules (client round 3, 2026-09-14). ONE place for the Toronto calendar-date logic.
//   jobs.application_deadline is a DATE column. node-postgres parses DATE into a JS Date at SERVER-LOCAL midnight (this
//   server runs in Asia/Kolkata), so formatting that Date in America/Toronto would print the previous day. Every route
//   therefore passes rows through decorateJob(), which replaces application_deadline with a Date at 12:00 America/Toronto
//   (safe for h.formatDate / h.formatDateInput / toISOString) and adds application_deadline_date ('yyyy-mm-dd'),
//   applications_closed and locked.
const TZ = 'America/Toronto';
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'yyyy-mm-dd' for today in Toronto. */
const todayToronto = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

/** Minutes the zone is ahead of UTC at `date` (Toronto: -240 in summer, -300 in winter). */
function tzOffsetMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const o = {}; parts.forEach(p => { o[p.type] = p.value; });
  return (Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - date.getTime()) / 60000;
}
/** 'yyyy-mm-dd' -> Date at 12:00 America/Toronto (DST-correct). Returns null for anything that is not a valid date string. */
function torontoNoon(ymd) {
  if (!ymd || !YMD_RE.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 12);
  const noon = new Date(guess - tzOffsetMinutes(new Date(guess), TZ) * 60000);
  return noon.toLocaleDateString('en-CA', { timeZone: TZ }) === ymd ? noon : null;   // rejects 2026-02-31 etc.
}
/** 'yyyy-mm-dd' -> Date at 23:59:59 America/Toronto (JSON-LD validThrough). */
function torontoEndOfDay(ymd) {
  const noon = torontoNoon(ymd);
  return noon ? new Date(noon.getTime() + (11 * 3600 + 59 * 60 + 59) * 1000) : null;
}
/**
 * Calendar date ('yyyy-mm-dd') of a DATE column value however node-postgres hands it over:
 *  - a JS Date parsed from a DATE column = server-local midnight -> format in the server's local zone;
 *  - a 'yyyy-mm-dd…' string -> first 10 chars.
 * For TIMESTAMPTZ values use h.formatDateInput() (Toronto) instead.
 */
function dateOnly(v) {
  if (!v) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  const s = String(v).slice(0, 10);
  return YMD_RE.test(s) ? s : '';
}
/** Validate a form date input. Returns { value: 'yyyy-mm-dd'|'' , error } — '' is "not set". */
function parseDateInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { value: '', error: null };
  if (!YMD_RE.test(s) || !torontoNoon(s)) return { value: s, error: 'Enter a valid date (yyyy-mm-dd).' };
  return { value: s, error: null };
}

/** SQL: posting still accepts applications (no deadline, or deadline is today or later in Toronto). Uses the `jobs` alias. */
const OPEN_WHERE = `(jobs.application_deadline IS NULL OR jobs.application_deadline >= (now() AT TIME ZONE '${TZ}')::date)`;

/** deadline < today (Toronto). The deadline day itself is still open. */
const isClosed = (job) => { const d = job && dateOnly(job.application_deadline); return !!d && d < todayToronto(); };
const isLocked = (job) => !!(job && (job.locked_at || job.published_at));

/** Normalise one job-ish row in place (safe on rows without the columns). Returns the row. */
function decorateJob(job) {
  if (!job || typeof job !== 'object') return job;
  if ('application_deadline' in job) {
    const d = dateOnly(job.application_deadline);
    job.application_deadline_date = d;
    job.application_deadline = d ? torontoNoon(d) : null;
    job.applications_closed = !!d && d < todayToronto();
  } else if (job.applications_closed === undefined) job.applications_closed = false;
  if ('locked_at' in job || 'published_at' in job) job.locked = isLocked(job);
  return job;
}
const decorateJobs = (rows) => { (rows || []).forEach(decorateJob); return rows; };

module.exports = { TZ, todayToronto, torontoNoon, torontoEndOfDay, dateOnly, parseDateInput, OPEN_WHERE, isClosed, isLocked, decorateJob, decorateJobs };
