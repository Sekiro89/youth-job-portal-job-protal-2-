'use strict';
// View helpers, exposed to every template as `h`.
const C = require('./constants');

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
const cadCents = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

function formatSalary(job) {
  if (!job || (!job.salary_min && !job.salary_max)) return 'Salary not disclosed';
  const per = job.salary_period === 'hour' ? '/hour' : '/year';
  if (job.salary_min && job.salary_max && job.salary_min !== job.salary_max)
    return `${cad.format(job.salary_min)} – ${cad.format(job.salary_max)}${per}`;
  return `${cad.format(job.salary_min || job.salary_max)}${per}`;
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
const statusLabel = (s) => ({ draft: 'Draft', pending_payment: 'Awaiting payment', active: 'Active', expired: 'Expired', cancelled: 'Cancelled', inactive: 'Inactive' }[s] || s);
const statusBadge = (s) => ({ active: 'positive', pending_payment: 'warning', draft: '', expired: 'danger', cancelled: 'danger', inactive: 'danger' }[s] || '');

module.exports = {
  escapeHtml, formatSalary, money, formatDate, formatDateTime, timeAgo, paragraphs, slugify,
  location, statusLabel, statusBadge,
  categoryName: (k) => C.CATEGORY_NAME[k] || k,
  provinceName: (k) => C.PROVINCE_NAME[k] || k,
  jobTypeName: (k) => C.JOB_TYPE_NAME[k] || k,
  workArrangementName: (k) => C.WORK_ARRANGEMENT_NAME[k] || k,
  experienceName: (k) => C.EXPERIENCE_LEVEL_NAME[k] || k,
  audienceName: (k) => C.AUDIENCE_NAME[k] || k,
  C,
};
