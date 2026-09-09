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

const SALARY_PERIODS = [
  ['hour', 'per hour'], ['day', 'per day'], ['week', 'per week'], ['biweekly', 'bi-weekly'], ['month', 'per month'], ['year', 'per year'],
];
const SALARY_PERIOD_NAME = Object.fromEntries(SALARY_PERIODS);
// multiply a rate by this to get an annual figure (for search/sort only; assumes 40 h/week, 5 d/week)
const SALARY_PERIOD_TO_YEAR = { hour: 2080, day: 260, week: 52, biweekly: 26, month: 12, year: 1 };

const EDUCATION_LEVELS = [   // Job Bank vocabulary (client PDF 2026-09-10)
  ['none', 'No degree, certificate or diploma'],
  ['secondary', 'Secondary (high) school graduation certificate'],
  ['apprenticeship', 'Registered Apprenticeship certificate'],
  ['trades', 'Other trades certificate or diploma'],
  ['college_short', 'College, CEGEP or other non-university certificate or diploma from a program of 3 months to less than 1 year'],
  ['college_1_2', 'College, CEGEP or other non-university certificate or diploma from a program of 1 year to 2 years'],
  ['college', 'College/CEGEP'],
  ['bachelor', "Bachelor's degree"],
  ['professional_degree', 'Degree in medicine, dentistry, veterinary medicine or optometry'],
  ['master', "Master's degree"],
  ['doctorate', 'Earned doctorate degree'],
  ['other', 'Other (specify)'],
];
const EDUCATION_LEVEL_NAME = Object.fromEntries(EDUCATION_LEVELS);

const EXPERIENCE_LEVELS = [  // Job Bank vocabulary (client PDF 2026-09-10)
  ['will_train', 'No experience (will train)'],
  ['asset', 'Experience an asset'],
  ['1_7_months', '1 to less than 7 months'],
  ['7_12_months', '7 months to less than 1 year'],
  ['1_2_years', '1 year to less than 2 years'],
  ['2_3_years', '2 years to less than 3 years'],
  ['3_5_years', '3 years to less than 5 years'],
  ['5_plus', '5 years or more'],
  ['other', 'Other (specify)'],
];
// legacy keys still present in old rows / seeker profiles
const EXPERIENCE_LEGACY = { entry: '1_2_years', intermediate: '2_3_years', senior: '5_plus', manager: '5_plus', executive: '5_plus' };
const EDUCATION_LEGACY = { certificate: 'college', professional: 'professional_degree' };

const HOURS_PERIODS = [['week', 'per week'], ['biweekly', 'bi-weekly'], ['month', 'per month'], ['year', 'per year']];
const HOURS_PERIOD_NAME = Object.fromEntries(HOURS_PERIODS);

// Company industry sector — Job Bank / NAICS list exactly as in the client's PDF (2026-09-10)
const INDUSTRIES = [
  ['agriculture', 'Agriculture, forestry, fishing and hunting'],
  ['mining_oil_gas', 'Mining and oil and gas extraction'],
  ['utilities', 'Utilities'],
  ['construction', 'Construction'],
  ['manufacturing', 'Manufacturing'],
  ['wholesale_trade', 'Wholesale trade'],
  ['retail_trade', 'Retail trade'],
  ['transportation_warehousing', 'Transportation and warehousing'],
  ['information_cultural', 'Information and cultural industries'],
  ['finance_insurance', 'Finance and insurance'],
  ['real_estate', 'Real estate and rental and leasing'],
  ['professional_scientific', 'Professional, scientific and technical services'],
  ['management_companies', 'Management of Companies and Enterprises'],
  ['administrative_support', 'Administrative and support services'],
  ['employment_services', 'Employment services'],
  ['waste_management', 'Waste management and remediation services'],
  ['educational_services', 'Educational services'],
  ['health_care_social', 'Health care and social assistance'],
  ['arts_entertainment', 'Arts, entertainment and recreation'],
  ['accommodation_food', 'Accommodation and food services'],
  ['repair_maintenance', 'Repair and maintenance'],
  ['personal_laundry', 'Personal and laundry services'],
  ['religious_civic', 'Religious, grant-making, civic, and professional and similar organizations'],
  ['private_households', 'Private households'],
  ['public_administration', 'Public administration'],
];
const INDUSTRY_NAME = Object.fromEntries(INDUSTRIES);
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

// Per posting per month, before GST. Employers $14.99, third-party consultants $9.99 (client decision 2026-09-09).
const PRICING = { employer_price_cents: 1499, consultant_price_cents: 999, gst_rate: 0.05, currency: 'CAD' };
const priceCentsFor = (role) => (role === 'consultant' ? PRICING.consultant_price_cents : PRICING.employer_price_cents);
const POSTAL_CODE_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d$/i;

module.exports = {
  PROVINCES, PROVINCE_NAME, CATEGORIES, CATEGORY_NAME, JOB_TYPES, JOB_TYPE_NAME,
  WORK_ARRANGEMENTS, WORK_ARRANGEMENT_NAME, EXPERIENCE_LEVELS, EXPERIENCE_LEVEL_NAME,
  AUDIENCES, AUDIENCE_NAME, CONTACT_CATEGORIES, JOB_STATUSES, ARCHIVED_STATUSES,
  RESUME_MIME, RESUME_MAX_BYTES, PRICING, priceCentsFor, POSTAL_CODE_RE,
  SALARY_PERIODS, SALARY_PERIOD_NAME, SALARY_PERIOD_TO_YEAR, EDUCATION_LEVELS, EDUCATION_LEVEL_NAME,
  EXPERIENCE_LEGACY, EDUCATION_LEGACY, HOURS_PERIODS, HOURS_PERIOD_NAME, INDUSTRIES, INDUSTRY_NAME,
};
