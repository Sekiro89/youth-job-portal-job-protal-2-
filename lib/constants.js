'use strict';
// Shared vocabulary. Every agent reads keys from here — never hardcode these lists elsewhere.

const PROVINCES = [
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'],
  ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'],
  ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
];
const PROVINCE_NAME = Object.fromEntries(PROVINCES);

const CATEGORIES = [
  ['accounting_finance', 'Accounting & Finance'],
  ['administration', 'Administration & Office'],
  ['agriculture', 'Agriculture & Farming'],
  ['construction_trades', 'Construction & Skilled Trades'],
  ['customer_service', 'Customer Service & Call Centre'],
  ['education', 'Education & Training'],
  ['engineering', 'Engineering'],
  ['healthcare', 'Healthcare & Nursing'],
  ['hospitality', 'Hospitality, Food & Tourism'],
  ['human_resources', 'Human Resources'],
  ['it_software', 'IT & Software'],
  ['legal', 'Legal'],
  ['manufacturing', 'Manufacturing & Production'],
  ['marketing_sales', 'Marketing & Sales'],
  ['retail', 'Retail'],
  ['science_research', 'Science & Research'],
  ['social_services', 'Social & Community Services'],
  ['transport_logistics', 'Transportation, Trucking & Logistics'],
  ['warehouse_general_labour', 'Warehouse & General Labour'],
  ['other', 'Other'],
];
const CATEGORY_NAME = Object.fromEntries(CATEGORIES);

const JOB_TYPES = [
  ['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contract', 'Contract'],
  ['temporary', 'Temporary'], ['seasonal', 'Seasonal'], ['internship', 'Internship / Co-op'],
  ['apprenticeship', 'Apprenticeship'],
];
const JOB_TYPE_NAME = Object.fromEntries(JOB_TYPES);

const WORK_ARRANGEMENTS = [['on_site', 'On-site'], ['hybrid', 'Hybrid'], ['remote', 'Remote']];
const WORK_ARRANGEMENT_NAME = Object.fromEntries(WORK_ARRANGEMENTS);

const EXPERIENCE_LEVELS = [
  ['entry', 'Entry level (0–2 years)'], ['intermediate', 'Intermediate (2–5 years)'],
  ['senior', 'Senior (5+ years)'], ['manager', 'Manager / Lead'], ['executive', 'Executive'],
];
const EXPERIENCE_LEVEL_NAME = Object.fromEntries(EXPERIENCE_LEVELS);

// The five audiences from the Canada Careers logo. Colour tokens live in public/css/theme.css (--cc-aud-*).
const AUDIENCES = [
  ['professionals',  'Professionals',   'briefcase'],
  ['new_immigrants', 'New Immigrants',  'globe'],
  ['indigenous',     'Indigenous',      'inukshuk'],
  ['refugees',       'Refugees',        'hand'],
  ['youth',          'Youth',           'star'],
];
const AUDIENCE_NAME = Object.fromEntries(AUDIENCES.map(([k, n]) => [k, n]));

const CONTACT_CATEGORIES = [
  ['technical', 'Technical issue'], ['billing', 'Billing & payments'], ['posting', 'A job posting'],
  ['account', 'My account'], ['general', 'General enquiry'],
];

const JOB_STATUSES = ['draft', 'pending_payment', 'active', 'expired', 'cancelled', 'inactive'];
const ARCHIVED_STATUSES = ['expired', 'cancelled', 'inactive'];

const RESUME_MIME = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};
const RESUME_MAX_BYTES = 5 * 1024 * 1024;

const PRICING = { price_cents: 999, gst_rate: 0.05, currency: 'CAD' };

module.exports = {
  PROVINCES, PROVINCE_NAME, CATEGORIES, CATEGORY_NAME, JOB_TYPES, JOB_TYPE_NAME,
  WORK_ARRANGEMENTS, WORK_ARRANGEMENT_NAME, EXPERIENCE_LEVELS, EXPERIENCE_LEVEL_NAME,
  AUDIENCES, AUDIENCE_NAME, CONTACT_CATEGORIES, JOB_STATUSES, ARCHIVED_STATUSES,
  RESUME_MIME, RESUME_MAX_BYTES, PRICING,
};
