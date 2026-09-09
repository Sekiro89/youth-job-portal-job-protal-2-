'use strict';
// Shared job rules. THE ONLY place the public-visibility rule is written.
const db = require('./db');
const { slugify } = require('./helpers');

/** SQL fragment: a posting is public only while active and paid-up. Prefix with table alias if needed. */
const PUBLIC_WHERE = "jobs.status = 'active' AND jobs.expires_at > now() AND NOT EXISTS (SELECT 1 FROM employer_profiles ap WHERE ap.id = jobs.employer_profile_id AND ap.archived)";

/** Unique slug for a new job: "<title>-<city>-<random4>" */
async function uniqueJobSlug(title, city) {
  const base = slugify(`${title} ${city || ''}`);
  for (let i = 0; i < 10; i++) {
    const s = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (!(await db.one('SELECT 1 FROM jobs WHERE slug=$1', [s]))) return s;
  }
  return `${base}-${Date.now()}`;
}
async function uniqueProfileSlug(name) {
  const base = slugify(name);
  if (!(await db.one('SELECT 1 FROM employer_profiles WHERE slug=$1', [base]))) return base;
  for (let i = 2; i < 1000; i++) {
    const s = `${base}-${i}`;
    if (!(await db.one('SELECT 1 FROM employer_profiles WHERE slug=$1', [s]))) return s;
  }
  return `${base}-${Date.now()}`;
}

/** Move a job out of public view. reason: 'expired' | 'cancelled' | 'inactive' */
async function archiveJob(jobId, reason, client) {
  const q = client || db;
  await q.query(`UPDATE jobs SET status=$2::job_status, archived_at=now(), cancelled_at = CASE WHEN $2='cancelled' THEN now() ELSE cancelled_at END, updated_at=now() WHERE id=$1`, [jobId, reason]);
}

/** Activate (or extend) a posting through `periodEnd`. Called by billing after a successful charge. */
async function activateJob(jobId, periodEnd, client) {
  const q = client || db;
  await q.query(`UPDATE jobs SET status='active', published_at = COALESCE(published_at, now()), expires_at=$2, archived_at=NULL, updated_at=now() WHERE id=$1`, [jobId, periodEnd]);
}

/** Cron: any active job whose paid period has lapsed becomes 'expired' (archived). Returns count. */
async function expireLapsedJobs() {
  const r = await db.query(`UPDATE jobs SET status='expired', archived_at=now(), updated_at=now() WHERE status='active' AND expires_at <= now() RETURNING id`);
  return r.rowCount;
}

/** Can this user manage this job? Owner of the employer profile (employer or consultant) or admin. */
async function userCanManageJob(user, jobId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const r = await db.one('SELECT 1 FROM jobs j JOIN employer_profiles p ON p.id=j.employer_profile_id WHERE j.id=$1 AND p.owner_user_id=$2', [jobId, user.id]);
  return !!r;
}

module.exports = { PUBLIC_WHERE, uniqueJobSlug, uniqueProfileSlug, archiveJob, activateJob, expireLapsedJobs, userCanManageJob };
