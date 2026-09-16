'use strict';
// Seeker <-> job matching. Owned by the seeker agent (see docs/CONTRACT.md).
//   notifySeekersForJob(jobId)  -> billing calls this on first activation
//   sendDailyDigests()          -> cron (daily) for seekers on notify_frequency='daily'
//   matchesForSeeker(userId, n) -> dashboard "Jobs matched to your profile"
const db = require('./db');
const mail = require('./mail');
const settings = require('./settings');
const { PUBLIC_WHERE } = require('./jobs');
const h = require('./helpers');
const jd = require('./job-dates');   // OPEN_WHERE: postings past their application deadline are never matched or alerted (round 3)

// ---- shared criteria (SQL fragments over aliases: jobs AS jobs, seeker_profiles AS p) ----
// category:  job category in the seeker's categories
// keyword:   any seeker keyword appears (ILIKE) in title / description / any job skill
// skill:     any seeker skill equals (case-insensitive) a job skill
// province:  seeker has no province preference, or ANY of the job's work locations (job_locations; jobs.province = the
//            primary one) is in one of them, or the job is remote
const CATEGORY_MATCH = `jobs.category = ANY(p.categories)`;
// keywords match as whole words/phrases, case-insensitively ("RN" must not match "learn"); regex metachars are escaped
const KW_RE = `('(^|[^[:alnum:]_])' || regexp_replace(trim(k), '[][\\\\.^$|()*+?{}]', '\\\\\\&', 'g') || '($|[^[:alnum:]_])')`;
const KEYWORD_MATCH = `EXISTS (SELECT 1 FROM unnest(p.keywords) k
  WHERE length(trim(k)) > 0 AND (jobs.title ~* ${KW_RE} OR jobs.description ~* ${KW_RE}
        OR EXISTS (SELECT 1 FROM unnest(jobs.skills) js WHERE js ~* ${KW_RE})))`;
const SKILL_MATCH = `EXISTS (SELECT 1 FROM unnest(jobs.skills) js JOIN unnest(p.skills) ps ON lower(trim(js)) = lower(trim(ps)))`;
const IN_PROVINCES = `(jobs.province = ANY(p.provinces) OR EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = jobs.id AND l.province = ANY(p.provinces)))`;
const PROVINCE_OK = `(cardinality(p.provinces) = 0 OR ${IN_PROVINCES} OR jobs.work_arrangement = 'remote')`;
const PROVINCE_HIT = `(${IN_PROVINCES} OR jobs.work_arrangement = 'remote')`;
const LOCATION_COUNT = `(SELECT count(*)::int FROM job_locations l WHERE l.job_id = jobs.id) AS location_count`;
// Name shown to seekers: the operating name chosen for THIS posting, else the profile default (h.displayCompany falls back to company_name).
// `jobs.*` already carries jobs.operating_name/hours_amount/hours_period, but a later `ep.operating_name` would overwrite it in the row object.
const JOB_COMPANY = `ep.company_name, COALESCE(NULLIF(jobs.operating_name, ''), ep.operating_name) AS operating_name, jobs.hours_amount, jobs.hours_period`;
const publicUrl = async () => (await settings.get('public_url')).replace(/\/$/, '');

// audience: the posting welcomes one of the audiences the seeker identified with (ranking boost only — never a trigger on its own)
const AUDIENCE_HIT = `(jobs.audiences && p.audiences)`;

const SCORE = `((CASE WHEN ${CATEGORY_MATCH} THEN 3 ELSE 0 END) + (CASE WHEN ${KEYWORD_MATCH} THEN 2 ELSE 0 END)
  + (CASE WHEN ${SKILL_MATCH} THEN 1 ELSE 0 END) + (CASE WHEN ${PROVINCE_HIT} THEN 1 ELSE 0 END) + (CASE WHEN ${AUDIENCE_HIT} THEN 1 ELSE 0 END))`;

function jobEmailBlock(job) {
  const hours = h.formatHours(job);
  return `<p><strong>${h.escapeHtml(job.title)}</strong><br>${h.escapeHtml(h.displayCompany(job))} · ${h.escapeHtml(h.location(job))}${job.location_count > 1 ? ` (+${job.location_count - 1} more location${job.location_count > 2 ? 's' : ''})` : ''}<br>
  <span style="color:#5A6B7E">${h.escapeHtml(h.jobTypeName(job.job_type))} · ${h.escapeHtml(h.workArrangementName(job.work_arrangement))}${hours ? ` · ${h.escapeHtml(hours)}` : ''} · ${h.escapeHtml(h.formatSalary(job))}${job.public_id ? ` · Posting ID ${h.escapeHtml(job.public_id)}` : ''}</span></p>`;
}

/** Notify every matching seeker about a newly activated job. Idempotent per (user, job). Returns count notified. */
async function notifySeekersForJob(jobId) {
  const job = jd.decorateJob(await db.one(`SELECT jobs.*, ${JOB_COMPANY}, ${LOCATION_COUNT} FROM jobs JOIN employer_profiles ep ON ep.id = jobs.employer_profile_id WHERE jobs.id = $1`, [jobId]));
  if (!job) return 0;
  if (job.applications_closed) { console.log(`[matching] job ${jobId} is past its application deadline — no alerts`); return 0; }
  const company = h.displayCompany(job);
  const PUBLIC_URL = await publicUrl();
  const hours = h.formatHours(job);
  const seekers = await db.many(`
    SELECT u.id, u.email, u.name, p.notify_email, p.notify_frequency
    FROM seeker_profiles p JOIN users u ON u.id = p.user_id, jobs
    WHERE jobs.id = $1 AND u.role = 'seeker' AND u.is_active AND u.id <> jobs.created_by
      AND (${CATEGORY_MATCH} OR ${KEYWORD_MATCH} OR ${SKILL_MATCH})
      AND ${PROVINCE_OK}
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.job_id = jobs.id AND n.type = 'new_job_match')`, [jobId]);
  const link = `/jobs/${job.slug}`;
  let count = 0;
  for (const s of seekers) {
    const body = `${company} · ${h.location(job)}${hours ? ` · ${hours}` : ''} · ${h.formatSalary(job)}${job.public_id ? ` · Posting ID ${job.public_id}` : ''}`;
    const n = await db.one(`INSERT INTO notifications(user_id, type, title, body, link, job_id) VALUES ($1,'new_job_match',$2,$3,$4,$5) RETURNING id`,
      [s.id, `New job: ${job.title}`, body, link, job.id]);
    count++;
    if (s.notify_email && s.notify_frequency === 'instant') {
      const href = PUBLIC_URL + link;
      await mail.send({
        to: s.email,
        subject: `New job match: ${job.title} at ${company}`,
        html: mail.layout(`A new job matches your profile`, `<p>Hi ${h.escapeHtml(s.name || 'there')},</p><p>A new posting on Youth Futures Canada matches the categories, keywords or skills in your profile:</p>${jobEmailBlock(job)}<p>You can apply in one click with your saved resume.</p><p style="font-size:13px;color:#6b7a8c">Manage your alerts at ${h.escapeHtml(PUBLIC_URL)}/jobseeker/alerts</p>`, { href, label: 'View this job' }),
        text: `Hi ${s.name || 'there'},\n\nA new job matches your profile: ${job.title} at ${company} (${h.location(job)}${hours ? `, ${hours}` : ''}).${job.public_id ? `\nPosting ID ${job.public_id}` : ''}\n${href}\n\nManage your alerts: ${PUBLIC_URL}/jobseeker/alerts`,
      });
      await db.query('UPDATE notifications SET emailed_at = now() WHERE id = $1', [n.id]);
    }
  }
  return count;
}

/** One digest email per 'daily' seeker covering un-emailed new_job_match notifications from the last 24h. Returns emails sent. */
async function sendDailyDigests() {
  const rows = await db.many(`
    SELECT u.id AS user_id, u.email, u.name,
           json_agg(json_build_object('id', n.id, 'title', n.title, 'body', n.body, 'link', n.link) ORDER BY n.created_at DESC) AS items
    FROM notifications n JOIN users u ON u.id = n.user_id JOIN seeker_profiles p ON p.user_id = u.id
    WHERE n.type = 'new_job_match' AND n.emailed_at IS NULL AND n.created_at > now() - interval '24 hours'
      AND p.notify_email AND p.notify_frequency = 'daily' AND u.is_active
    GROUP BY u.id, u.email, u.name`);
  let sent = 0;
  const PUBLIC_URL = await publicUrl();
  for (const r of rows) {
    const list = r.items.map(i => `<li style="margin:0 0 10px"><a href="${h.escapeHtml(PUBLIC_URL + i.link)}" style="font-weight:600;color:#0F2444">${h.escapeHtml(i.title.replace(/^New job: /, ''))}</a><br><span style="color:#5A6B7E;font-size:14px">${h.escapeHtml(i.body || '')}</span></li>`).join('');
    const text = r.items.map(i => `- ${i.title.replace(/^New job: /, '')} — ${i.body || ''}\n  ${PUBLIC_URL + i.link}`).join('\n');
    await mail.send({
      to: r.email,
      subject: `${r.items.length} new job${r.items.length === 1 ? '' : 's'} matched your profile today`,
      html: mail.layout('Your daily job matches', `<p>Hi ${h.escapeHtml(r.name || 'there')},</p><p>These postings from the last 24 hours match your Youth Futures Canada profile:</p><ul style="padding-left:18px">${list}</ul><p style="font-size:13px;color:#6b7a8c">Manage your alerts at ${h.escapeHtml(PUBLIC_URL)}/jobseeker/alerts</p>`, { href: `${PUBLIC_URL}/jobseeker/dashboard`, label: 'See all matches' }),
      text: `Hi ${r.name || 'there'},\n\nNew jobs matching your profile:\n${text}\n\nManage your alerts: ${PUBLIC_URL}/jobseeker/alerts`,
    });
    await db.query('UPDATE notifications SET emailed_at = now() WHERE id = ANY($1::bigint[])', [r.items.map(i => i.id)]);
    sent++;
  }
  return sent;
}

/** How many public jobs currently match the seeker (same criteria as matchesForSeeker, no limit). */
async function countMatchesForSeeker(userId) {
  const r = await db.one(`SELECT count(*)::int AS n FROM seeker_profiles p, jobs
    WHERE p.user_id = $1 AND ${PUBLIC_WHERE} AND ${jd.OPEN_WHERE} AND ${PROVINCE_OK} AND (${CATEGORY_MATCH} OR ${KEYWORD_MATCH} OR ${SKILL_MATCH})`, [userId]);
  return r ? r.n : 0;
}

/** Public, still-open jobs scored against the seeker's profile (3 category + 2 keyword + 1 skill + 1 province + 1 audience), best first. */
async function matchesForSeeker(userId, limit = 6) {
  return jd.decorateJobs(await db.many(`
    SELECT jobs.*, ${JOB_COMPANY}, ep.slug AS company_slug, ${LOCATION_COUNT}, ${SCORE} AS score, ${AUDIENCE_HIT} AS audience_hit,
           EXISTS (SELECT 1 FROM applications a WHERE a.job_id = jobs.id AND a.seeker_user_id = p.user_id) AS applied,
           EXISTS (SELECT 1 FROM saved_jobs s WHERE s.job_id = jobs.id AND s.user_id = p.user_id) AS saved
    FROM seeker_profiles p, jobs JOIN employer_profiles ep ON ep.id = jobs.employer_profile_id
    WHERE p.user_id = $1 AND ${PUBLIC_WHERE} AND ${jd.OPEN_WHERE} AND ${PROVINCE_OK}
      AND (${CATEGORY_MATCH} OR ${KEYWORD_MATCH} OR ${SKILL_MATCH})
    ORDER BY score DESC, jobs.published_at DESC NULLS LAST
    LIMIT $2`, [userId, limit]));
}

module.exports = { notifySeekersForJob, sendDailyDigests, matchesForSeeker, countMatchesForSeeker };
