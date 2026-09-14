'use strict';
// View helpers, exposed to every template as `h`.
const C = require('./constants');

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const cad0 = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
const cad2 = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Hourly/daily rates always show cents ($21.18/hour); larger periods show cents only when present ($52,000/year, $1,234.50/week).
const cad = { format: (v, period) => { const n = Number(v); return (period === 'hour' || period === 'day' || n % 1 !== 0) ? cad2.format(n) : cad0.format(n); } };
const cadCents = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

function formatSalary(job) {
  if (!job || (!job.salary_min && !job.salary_max)) return 'Salary not disclosed';
  const per = { hour: '/hour', day: '/day', week: '/week', biweekly: ' bi-weekly', month: '/month', year: '/year' }[job.salary_period] || '/year';
  const p = job.salary_period, lo = job.salary_min != null ? Number(job.salary_min) : null, hi = job.salary_max != null ? Number(job.salary_max) : null;
  if (lo && hi && lo !== hi) return `${cad.format(lo, p)} – ${cad.format(hi, p)}${per}`;
  return `${cad.format(lo || hi, p)}${per}`;
}
const money = (cents) => cadCents.format((cents || 0) / 100);

function formatDate(d, opts) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-CA', Object.assign({ year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Toronto' }, opts || {}));
}
function formatDateTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto' });
}
function timeAgo(d) {
  if (!d) return '';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const hr = Math.floor(m / 60); if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24); if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  return formatDate(d);
}
/** plain text with blank-line paragraphs -> safe <p> html; single newlines become <br> */
function paragraphs(text) {
  return String(text || '').split(/\n{2,}/).map(p => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('\n');
}
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}
const location = (o) => [o.city, o.province].filter(Boolean).join(', ');
/** Full one-line address for a job_locations row: "123 Main St, Unit 4, Toronto, ON M5V 1A1" */
const unitLabel = (u) => { const t = String(u || '').trim(); if (!t) return ''; return /^(unit|suite|apt\.?|apartment|#|bureau|ste\.?)\b/i.test(t) || t.startsWith('#') ? t : `Unit ${t}`; };
const fullAddress = (l) => [l.street_address, unitLabel(l.unit), l.city, [l.province, formatPostal(l.postal_code)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
/** Name to show job seekers: operating (trade) name first, legal name secondary. Pass {operating_name: job.operating_name || profile.operating_name, company_name} for a posting. */
const displayCompany = (p) => (p.operating_name && p.operating_name.trim() && p.operating_name.trim() !== (p.company_name || '').trim()) ? `${p.operating_name.trim()}` : (p.company_name || '');
const legalNameNote = (p) => (p.operating_name && p.operating_name.trim() && p.operating_name.trim() !== (p.company_name || '').trim()) ? `Operated by ${p.company_name}` : '';
function formatPostal(s) { return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/^(.{3})(.{3})$/, '$1 $2'); }
const formatDateInput = (d) => (d ? new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }) : ''); // yyyy-mm-dd for <input type=date>
const statusLabel = (s) => ({ draft: 'Draft', pending_payment: 'Awaiting payment', active: 'Active', expired: 'Expired', cancelled: 'Cancelled', inactive: 'Inactive' }[s] || s);
const statusBadge = (s) => ({ active: 'positive', pending_payment: 'warning', draft: '', expired: 'danger', cancelled: 'danger', inactive: 'danger' }[s] || '');

module.exports = {
  escapeHtml, formatSalary, money, formatDate, formatDateTime, timeAgo, paragraphs, slugify,
  location, fullAddress, displayCompany, legalNameNote, formatPostal, formatDateInput, statusLabel, statusBadge,
  salaryPeriodName: (k) => C.SALARY_PERIOD_NAME[k] || k,
  educationName: (k) => C.EDUCATION_LEVEL_NAME[k] || C.EDUCATION_LEVEL_NAME[C.EDUCATION_LEGACY[k]] || k,
  categoryName: (k) => C.CATEGORY_NAME[k] || k,
  provinceName: (k) => C.PROVINCE_NAME[k] || k,
  jobTypeName: (k) => C.JOB_TYPE_NAME[k] || k,
  workArrangementName: (k) => C.WORK_ARRANGEMENT_NAME[k] || k,
  experienceName: (k) => C.EXPERIENCE_LEVEL_NAME[k] || C.EXPERIENCE_LEVEL_NAME[C.EXPERIENCE_LEGACY[k]] || k,
  industryName: (k) => C.INDUSTRY_NAME[k] || k,
  hoursPeriodName: (k) => C.HOURS_PERIOD_NAME[k] || k,
  formatHours: (job) => (job && job.hours_amount ? `${String(Number(job.hours_amount))} hours ${C.HOURS_PERIOD_NAME[job.hours_period] || 'per week'}` : ''),
  audienceName: (k) => C.AUDIENCE_NAME[k] || k,
  C,
};
