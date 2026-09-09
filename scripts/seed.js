'use strict';
// Demo/dev seed. Idempotent-ish: skips if the admin user already exists. Password for every seed user: Password123!
require('dotenv').config();
const db = require('../lib/db');
const { hashPassword } = require('../lib/auth');
const { uniqueJobSlug, uniqueProfileSlug } = require('../lib/jobs');

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
  const jobs = [
    [p1, emp, 'Warehouse Associate (Days)', 'warehouse_general_labour', 'full_time', 'on_site', 'entry', 'Mississauga', 'ON', 19, 22, 'hour', ['new_immigrants', 'youth', 'refugees'], 'active', 25],
    [p1, emp, 'AZ Truck Driver — Regional Routes', 'transport_logistics', 'full_time', 'on_site', 'intermediate', 'Brampton', 'ON', 68000, 82000, 'year', ['professionals', 'new_immigrants'], 'active', 20],
    [p1, emp, 'Dispatch Coordinator', 'administration', 'full_time', 'hybrid', 'intermediate', 'Mississauga', 'ON', 52000, 60000, 'year', ['professionals'], 'active', 12],
    [p2, con, 'Registered Nurse — Long-Term Care', 'healthcare', 'full_time', 'on_site', 'intermediate', 'Saskatoon', 'SK', 78000, 96000, 'year', ['professionals', 'new_immigrants'], 'active', 18],
    [p2, con, 'Personal Support Worker', 'healthcare', 'part_time', 'on_site', 'entry', 'Regina', 'SK', 21, 25, 'hour', ['new_immigrants', 'refugees', 'indigenous'], 'active', 28],
    [p3, con, 'Full-Stack Developer (Node/React)', 'it_software', 'full_time', 'remote', 'senior', 'Vancouver', 'BC', 110000, 140000, 'year', ['professionals'], 'active', 9],
    [p3, con, 'Junior QA Analyst — Co-op', 'it_software', 'internship', 'remote', 'entry', 'Vancouver', 'BC', 24, 28, 'hour', ['youth', 'indigenous'], 'active', 14],
    [p3, con, 'Customer Success Specialist', 'customer_service', 'full_time', 'hybrid', 'entry', 'Burnaby', 'BC', 48000, 55000, 'year', ['new_immigrants', 'youth'], 'active', 6],
    [p1, emp, 'Forklift Operator (Nights)', 'warehouse_general_labour', 'full_time', 'on_site', 'intermediate', 'Mississauga', 'ON', 23, 26, 'hour', ['new_immigrants'], 'expired', -3],
    [p2, con, 'Medical Office Assistant', 'administration', 'full_time', 'on_site', 'entry', 'Saskatoon', 'SK', 42000, 48000, 'year', ['youth', 'new_immigrants'], 'cancelled', 10],
    [p3, con, 'DevOps Engineer', 'it_software', 'contract', 'remote', 'senior', 'Vancouver', 'BC', 90, 110, 'hour', ['professionals'], 'draft', null],
    [p1, emp, 'Fleet Maintenance Technician', 'construction_trades', 'full_time', 'on_site', 'intermediate', 'Brampton', 'ON', 60000, 72000, 'year', ['professionals', 'indigenous'], 'pending_payment', null],
  ];
  const desc = (t, c) => `${c} is hiring a ${t}.\n\nWhat you will do:\n- Work with a supportive, diverse team\n- Follow safety and quality procedures\n- Grow into more senior roles with paid training\n\nWho we are looking for:\n- Legally entitled to work in Canada\n- Reliable, punctual and eager to learn\n- Foreign credentials and experience welcome`;
  const names = { [p1]: 'Northern Lights Logistics', [p2]: 'Prairie Health Group', [p3]: 'Maple Byte Software' };
  const ids = [];
  for (const [pid, by, title, cat, type, wa, exp, city, prov, smin, smax, per, aud, status, daysLeft] of jobs) {
    const published = status === 'draft' ? null : new Date(now - (30 - (daysLeft || 0)) * day);
    const expires = daysLeft == null ? null : new Date(now + daysLeft * day);
    const r = await db.one(`INSERT INTO jobs(employer_profile_id,created_by,title,slug,description,requirements,benefits,category,job_type,work_arrangement,experience_level,city,province,salary_min,salary_max,salary_period,audiences,apply_email,status,published_at,expires_at,archived_at,views,skills)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
      [pid, by, title, await uniqueJobSlug(title, city), desc(title, names[pid]), 'High school diploma or equivalent.\nValid work authorization in Canada.', 'Extended health and dental after 3 months.\nPaid training.\nTransit-accessible workplace.', cat, type, wa, exp, city, prov, smin, smax, per, aud, 'apply@example.com', status, published, expires, ['expired', 'cancelled'].includes(status) ? new Date() : null, Math.floor(Math.random() * 400), ['Teamwork', 'Communication']]);
    ids.push([r.id, pid, by, status, expires]);
  }
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
