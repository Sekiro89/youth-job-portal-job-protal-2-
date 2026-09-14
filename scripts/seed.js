'use strict';
// Demo/dev seed. Idempotent-ish: skips if the admin user already exists. Password for every seed user: Password123!
require('dotenv').config();
const db = require('../lib/db');
const { hashPassword } = require('../lib/auth');
const { uniqueJobSlug, uniqueProfileSlug, ensurePublicId } = require('../lib/jobs');

async function main() {
  if (await db.one("SELECT 1 FROM users WHERE email='veda@canadacareers.local'")) { console.log('seed: already seeded'); return; }
  const pw = await hashPassword('Password123!');
  const u = async (email, role, name) => (await db.one('INSERT INTO users(email,password_hash,role,name,email_verified) VALUES ($1,$2,$3,$4,true) RETURNING id', [email, pw, role, name])).id;
  const admin = await u('veda@canadacareers.local', 'admin', 'Veda');
  const emp = await u('employer@example.com', 'employer', 'Maria Santos');
  const con = await u('consultant@example.com', 'consultant', 'Raj Patel');
  const seeker = await u('seeker@example.com', 'seeker', 'Aisha Khan');
  const seeker2 = await u('seeker2@example.com', 'seeker', 'Liam O\'Connor');

  const prof = async (owner, name, extra) => (await db.one(
    'INSERT INTO employer_profiles(owner_user_id,company_name,slug,website,industry,company_size,city,province,description,contact_name,contact_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
    [owner, name, await uniqueProfileSlug(name), extra.website, extra.industry, extra.size, extra.city, extra.province, extra.description, extra.contact, extra.email])).id;
  const p1 = await prof(emp, 'Northern Lights Logistics', { website: 'https://northernlights.example', industry: 'Transportation & Logistics', size: '51-200', city: 'Mississauga', province: 'ON', description: 'A family-owned freight and warehousing company serving the Greater Toronto Area since 1998. We hire for attitude and train for skill.', contact: 'Maria Santos', email: 'hr@northernlights.example' });
  const p2 = await prof(con, 'Prairie Health Group', { website: 'https://prairiehealth.example', industry: 'Healthcare', size: '201-500', city: 'Saskatoon', province: 'SK', description: 'Community clinics and long-term care homes across Saskatchewan.', contact: 'Raj Patel', email: 'careers@prairiehealth.example' });
  const p3 = await prof(con, 'Maple Byte Software', { website: 'https://maplebyte.example', industry: 'IT & Software', size: '11-50', city: 'Vancouver', province: 'BC', description: 'A remote-first SaaS studio building tools for Canadian small businesses.', contact: 'Raj Patel', email: 'jobs@maplebyte.example' });

  const now = Date.now(); const day = 86400000;
  const ymd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  // Round 3 states every view must render: decimal hourly rates ($19.50 – $22.25/hour), one active posting whose application
  // deadline has PASSED (Dispatch Coordinator → "Applications closed"), one with a future deadline (Registered Nurse), the
  // published (locked) postings, one unlocked draft (DevOps Engineer) and one pending_payment row. `extra` = { deadline, hours, applyUrl }.
  const jobs = [
    [p1, emp, 'Warehouse Associate (Days)', 'warehouse_general_labour', 'full_time', 'on_site', 'entry', 'Mississauga', 'ON', 19.50, 22.25, 'hour', ['new_immigrants', 'youth', 'refugees'], 'active', 25, { hours: 40 }],
    [p1, emp, 'AZ Truck Driver — Regional Routes', 'transport_logistics', 'full_time', 'on_site', 'intermediate', 'Brampton', 'ON', 68000, 82000, 'year', ['professionals', 'new_immigrants'], 'active', 20, { hours: 44 }],
    [p1, emp, 'Dispatch Coordinator', 'administration', 'full_time', 'hybrid', 'intermediate', 'Mississauga', 'ON', 52000, 60000, 'year', ['professionals'], 'active', 12, { deadline: ymd(now - 2 * day), hours: 37.5 }],
    [p2, con, 'Registered Nurse — Long-Term Care', 'healthcare', 'full_time', 'on_site', 'intermediate', 'Saskatoon', 'SK', 78000, 96000, 'year', ['professionals', 'new_immigrants'], 'active', 18, { deadline: ymd(now + 14 * day), hours: 37.5, applyUrl: 'https://careers.prairiehealth.example/rn-ltc' }],
    [p2, con, 'Personal Support Worker', 'healthcare', 'part_time', 'on_site', 'entry', 'Regina', 'SK', 21.18, 24.50, 'hour', ['new_immigrants', 'refugees', 'indigenous'], 'active', 28, { hours: 24 }],
    [p3, con, 'Full-Stack Developer (Node/React)', 'it_software', 'full_time', 'remote', 'senior', 'Vancouver', 'BC', 110000, 140000, 'year', ['professionals'], 'active', 9, { hours: 40 }],
    [p3, con, 'Junior QA Analyst — Co-op', 'it_software', 'internship', 'remote', 'entry', 'Vancouver', 'BC', 24.00, 27.75, 'hour', ['youth', 'indigenous'], 'active', 14, { hours: 35, deadline: ymd(now + 30 * day) }],
    [p3, con, 'Customer Success Specialist', 'customer_service', 'full_time', 'hybrid', 'entry', 'Burnaby', 'BC', 48000, 55000, 'year', ['new_immigrants', 'youth'], 'active', 6, {}],
    [p1, emp, 'Forklift Operator (Nights)', 'warehouse_general_labour', 'full_time', 'on_site', 'intermediate', 'Mississauga', 'ON', 23.40, 26.15, 'hour', ['new_immigrants'], 'expired', -3, { hours: 40 }],
    [p2, con, 'Medical Office Assistant', 'administration', 'full_time', 'on_site', 'entry', 'Saskatoon', 'SK', 42000, 48000, 'year', ['youth', 'new_immigrants'], 'cancelled', 10, {}],
    [p3, con, 'DevOps Engineer', 'it_software', 'contract', 'remote', 'senior', 'Vancouver', 'BC', 90.00, 110.00, 'hour', ['professionals'], 'draft', null, { hours: 30 }],
    [p1, emp, 'Fleet Maintenance Technician', 'construction_trades', 'full_time', 'on_site', 'intermediate', 'Brampton', 'ON', 60000, 72000, 'year', ['professionals', 'indigenous'], 'pending_payment', null, { hours: 40 }],
  ];
  const desc = (t, c) => `${c} is hiring a ${t}.\n\nWhat you will do:\n- Work with a supportive, diverse team\n- Follow safety and quality procedures\n- Grow into more senior roles with paid training\n\nWho we are looking for:\n- Legally entitled to work in Canada\n- Reliable, punctual and eager to learn\n- Foreign credentials and experience welcome`;
  const names = { [p1]: 'Northern Lights Logistics', [p2]: 'Prairie Health Group', [p3]: 'Maple Byte Software' };
  const ids = [];
  for (const [pid, by, title, cat, type, wa, exp, city, prov, smin, smax, per, aud, status, daysLeft, extra = {}] of jobs) {
    // published_at + locked_at only for postings that have been published at least once; pending_payment was never live → unlocked.
    const published = ['draft', 'pending_payment'].includes(status) ? null : new Date(now - (30 - (daysLeft || 0)) * day);
    const expires = daysLeft == null ? null : new Date(now + daysLeft * day);
    const r = await db.one(`INSERT INTO jobs(employer_profile_id,created_by,title,slug,description,requirements,benefits,category,job_type,work_arrangement,experience_level,city,province,salary_min,salary_max,salary_period,audiences,apply_email,status,published_at,expires_at,archived_at,views,skills,locked_at,application_deadline,hours_amount,hours_period,apply_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
      [pid, by, title, await uniqueJobSlug(title, city), desc(title, names[pid]), 'High school diploma or equivalent.\nValid work authorization in Canada.', 'Extended health and dental after 3 months.\nPaid training.\nTransit-accessible workplace.', cat, type, wa, exp, city, prov, smin.toFixed(2), smax.toFixed(2), per, aud, 'apply@example.com', status, published, expires, ['expired', 'cancelled'].includes(status) ? new Date() : null, Math.floor(Math.random() * 400), ['Teamwork', 'Communication'],
        published, extra.deadline || null, extra.hours || null, extra.hours ? 'week' : null, extra.applyUrl || null]);
    await ensurePublicId(r.id);   // every posting (drafts included) carries a Posting ID X1X1X1
    // Work locations: the schema backfill only covers rows that exist at migrate time, so seed them here (first job gets 3 addresses).
    const locs = title === 'Warehouse Associate (Days)'
      ? [['6120 Kestrel Rd', null, 'Mississauga', 'ON', 'L5T 1Y9'], ['2 Airport Rd', '4', 'Brampton', 'ON', 'L6S 0C4'], ['100 Steeles Ave E', null, 'Milton', 'ON', 'L9T 6P8']]
      : [[null, null, city, prov, null]];
    for (let i = 0; i < locs.length; i++) await db.query('INSERT INTO job_locations(job_id, street_address, unit, city, province, postal_code, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [r.id, ...locs[i], i]);
    ids.push([r.id, pid, by, status, expires]);
  }
  // Operating-name fixture (scripts/smoke.js expects it): the truck-driver posting is published under a trade name that differs from the legal name.
  await db.query(`UPDATE employer_profiles SET operating_names = array_append(operating_names, 'Northern Lights Freight') WHERE id=$1 AND NOT ('Northern Lights Freight' = ANY(operating_names))`, [p1]);
  await db.query(`UPDATE jobs SET operating_name='Northern Lights Freight' WHERE title LIKE 'AZ Truck Driver%'`);
  // subscriptions + one payment for every active/expired/cancelled job (sandbox provider)
  for (const [jid, pid, by, status, expires] of ids) {
    if (status === 'draft') continue;
    const sstatus = status === 'active' ? 'active' : status === 'pending_payment' ? 'pending' : 'cancelled';
    const start = expires ? new Date(expires.getTime() - 30 * day) : null;
    const s = await db.one(`INSERT INTO subscriptions(job_id,employer_profile_id,payer_user_id,provider,status,current_period_start,current_period_end,cancelled_at) VALUES ($1,$2,$3,'sandbox',$4,$5,$6,$7) RETURNING id`, [jid, pid, by, sstatus, start, expires, sstatus === 'cancelled' ? new Date() : null]);
    if (start) await db.query(`INSERT INTO payments(subscription_id,job_id,payer_user_id,provider,receipt_number,amount_cents,tax_cents,total_cents,period_start,period_end,paid_at) VALUES ($1,$2,$3,'sandbox',$4,999,50,1049,$5,$6,$5)`, [s.id, jid, by, 'CC-' + start.toISOString().slice(0, 7).replace('-', '') + '-' + String(await db.one("SELECT nextval('receipt_seq') n").then(r => r.n)).padStart(6, '0'), start, expires]);
  }
  await db.query(`INSERT INTO seeker_profiles(user_id,headline,summary,city,province,categories,job_types,work_arrangements,provinces,keywords,skills,audiences) VALUES
    ($1,'Registered Nurse (IEN) — 6 years experience','Internationally educated nurse, NCLEX passed, seeking LTC or community roles.','Regina','SK','{healthcare}','{full_time,part_time}','{on_site}','{SK,AB}','{nurse,RN,long-term care}','{Patient care,Medication administration}','{new_immigrants,professionals}'),
    ($2,'Junior developer / recent grad','BCIT graduate looking for a first role in web development.','Vancouver','BC','{it_software}','{full_time,internship}','{remote,hybrid}','{BC}','{javascript,react,node,QA}','{JavaScript,React,SQL}','{youth}')`, [seeker, seeker2]);
  const activeJob = ids.find(x => x[3] === 'active')[0];
  await db.query(`INSERT INTO applications(job_id,seeker_user_id,resume_path,resume_name,cover_letter) VALUES ($1,$2,'seed/aisha-khan-resume.pdf','Aisha-Khan-Resume.pdf','I am very interested in this role and believe my experience is a strong fit.')`, [activeJob, seeker]);
  await db.query(`INSERT INTO contact_messages(name,email,category,subject,message,status) VALUES ('Test Employer','test@example.com','technical','Cannot upload company logo','The logo upload button does nothing on my iPad.','new')`);
  console.log('seeded: admin', admin, 'employer', emp, 'consultant', con, 'seekers', seeker, seeker2, 'jobs', ids.length);
}
main().then(() => db.pool.end()).catch(e => { console.error(e); process.exit(1); });
