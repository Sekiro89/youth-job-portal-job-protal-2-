'use strict';
// Job Bank (jobbank.gc.ca, Government of Canada) importer: polite fetcher + tolerant HTML/Atom parsers + DB upsert.
// Zero npm deps beyond `pg` (via lib/db). See docs/JOBBANK.md for sources, robots.txt findings, mapping and limits.
//
//   const jb = require('./jobbank');
//   const entries = await jb.searchFeed('nurse', 'ON');            // Atom feed -> [{ id, title, employer, city, province, ... }]
//   const detail  = await jb.fetchPosting('50243714');              // { gone:false, title, employer, sections, ... } (parsed detail page)
//   const summary = await jb.importQueries({ queries, provinces, limit, perQuery, dryRun, log });
//   const n       = await jb.refreshImported({ log });               // re-check every live imported job; expire the ones gone from Job Bank

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const C = require('./constants');
const { uniqueJobSlug, uniqueProfileSlug, archiveJob } = require('./jobs');

const BASE = 'https://www.jobbank.gc.ca';
const USER_AGENT = 'CanadaCareersBot/1.0 (+https://jobs.khosha.tech/about)';
const CACHE_DIR = path.join(__dirname, '..', 'data', 'jobbank-cache');
// robots.txt on jobbank.gc.ca says `Crawl-delay: 5` (checked 2026-09-09) — we honour it by default. Override with JOBBANK_DELAY_MS.
const DELAY_MS = Math.max(1000, parseInt(process.env.JOBBANK_DELAY_MS || '5000', 10) || 5000);
const SYSTEM_EMAIL = 'jobbank-import@canadacareers.local';
const SYSTEM_NAME = 'Job Bank (Government of Canada)';
const EMPLOYER_BLURB = "Employer listed on Job Bank, the Government of Canada's job board.";
const SOURCE = 'jobbank';

const DEFAULT_QUERIES = ['nurse', 'personal support worker', 'truck driver', 'software developer', 'cook', 'warehouse',
  'administrative assistant', 'electrician', 'customer service', 'early childhood educator', 'accountant', 'welder',
  'cleaner', 'retail sales', 'construction labourer'];
const DEFAULT_PROVINCES = ['ON', 'BC', 'AB', 'QC', 'MB', 'SK', 'NS', 'NB'];

// ---------------------------------------------------------------- polite HTTP (throttle + retry + on-disk cache)
const stats = { requests: 0, cacheHits: 0, retries: 0 };
let chain = Promise.resolve();
let lastAt = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Serialises every network call and keeps >= DELAY_MS between them. */
function throttled(fn) {
  const p = chain.then(async () => {
    const wait = lastAt + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastAt = Date.now(); }
  });
  chain = p.catch(() => {});
  return p;
}

function cachePath(key) {
  return path.join(CACHE_DIR, key.replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 120) + '-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 8) + '.html');
}
function readCache(key, maxAgeMs) {
  try {
    const f = cachePath(key);
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs > maxAgeMs) return null;
    const raw = fs.readFileSync(f, 'utf8');
    const nl = raw.indexOf('\n');
    const head = JSON.parse(raw.slice(0, nl));                 // first line = {status,url}
    return { status: head.status, url: head.url, body: raw.slice(nl + 1), cached: true };
  } catch (_) { return null; }
}
function writeCache(key, res) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify({ status: res.status, url: res.url, at: new Date().toISOString() }) + '\n' + res.body);
  } catch (e) { console.error('[jobbank] cache write failed', e.message); }
}

/**
 * GET a Job Bank URL. Returns { status, url (final, after redirects), body, cached }.
 * 410/404 are returned (not thrown) — they mean "posting gone". 429/5xx/network errors retry with backoff (3 tries).
 */
async function fetchPage(url, { cacheKey = url, maxAge = 6 * 3600 * 1000, force = false } = {}) {
  if (!force) { const c = readCache(cacheKey, maxAge); if (c) { stats.cacheHits++; return c; } }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) { stats.retries++; await sleep(DELAY_MS * (attempt + 1)); }
    try {
      const res = await throttled(async () => {
        stats.requests++;
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 30000);
        try {
          const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-CA,en;q=0.8', Accept: 'text/html,application/xhtml+xml,application/atom+xml;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: ac.signal });
          return { status: r.status, url: r.url, body: await r.text() };
        } finally { clearTimeout(t); }
      });
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status} for ${url}`); continue; }
      writeCache(cacheKey, res);
      return Object.assign(res, { cached: false });
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('fetch failed');
}

// ---------------------------------------------------------------- tiny HTML toolkit (no deps)
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ocirc: 'ô', ecirc: 'ê', icirc: 'î', ucirc: 'û', euml: 'ë', iuml: 'ï', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®' };
function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
const stripTags = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** HTML -> plain text: paragraphs separated by a blank line, list items as "- " lines. Safe for h.paragraphs(). */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|ul|ol|h[1-6]|tr|table|section|article|details|summary|dd|dt|blockquote)>/gi, '\n\n');
  s = s.replace(/<(p|div|ul|ol|h[1-6]|tr|table|section|article|details|summary|dd|dt|blockquote)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decode(s).replace(/ /g, ' ');
  s = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  // a lone "- " line ends up glued to its neighbours by h.paragraphs (single \n -> <br>), which is what we want for lists
  return s;
}

/** innerHTML of the first element matching `openRe` (a regex matching the opening tag), honouring same-tag nesting. */
function inner(html, openRe) {
  const m = openRe.exec(html);
  if (!m) return null;
  const tag = m[0].match(/^<([a-z0-9]+)/i);
  if (!tag) return null;
  const name = tag[1].toLowerCase();
  let depth = 1, i = m.index + m[0].length;
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
  re.lastIndex = i;
  let t;
  while ((t = re.exec(html))) {
    if (t[1]) { depth--; if (depth === 0) return html.slice(i, t.index); } else depth++;
  }
  return html.slice(i);
}
/** innerHTML of the element whose opening tag starts at `idx` (same nesting rule as inner()). */
function innerAt(html, idx) {
  const rest = html.slice(idx);
  const open = rest.match(/^<([a-z0-9]+)[^>]*>/i);
  if (!open) return null;
  const x = inner(rest, new RegExp('^' + open[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return x;
}
const propText = (html, prop) => { const x = inner(html, new RegExp(`<[a-z0-9]+[^>]*property="${prop}"[^>]*>`, 'i')); return x == null ? null : stripTags(x); };
const attrOf = (html, prop, attr) => { const m = html.match(new RegExp(`<[a-z0-9]+[^>]*property="${prop}"[^>]*\\b${attr}="([^"]*)"`, 'i')); return m ? decode(m[1]) : null; };

// ---------------------------------------------------------------- Atom feed (search results)
/** URL of the Atom feed for a keyword (+ optional 2-letter province). `fprov` is the only location filter the feed honours. */
function feedUrl(keyword, province, rows = 100) {
  const p = new URLSearchParams({ searchstring: keyword, sort: 'D', rows: String(rows) });
  if (province) p.set('fprov', province);
  return `${BASE}/jobsearch/feed/jobSearchRSSfeed?${p}`;
}
const cdata = (s) => String(s || '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');

/** Parse the Atom feed -> [{ id, url, title, jobNumber, city, province, employer, salaryText, updated }] */
function parseFeed(xml) {
  const out = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const e = m[1];
    const link = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const id = (link.match(/jobposting\/(\d+)/) || [])[1];
    if (!id) continue;
    const title = stripTags(cdata((e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]));
    const summary = decode(cdata((e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1]));
    const field = (label) => { const x = summary.match(new RegExp(`<strong>${label}:</strong>\\s*([^<]*)`, 'i')); return x ? stripTags(x[1]) : ''; };
    const loc = field('Location');
    const lm = loc.match(/^(.*?)\s*\(([A-Z]{2})\)\s*$/);
    out.push({
      id, url: `${BASE}/jobsearch/jobposting/${id}`, title,
      jobNumber: field('Job number'), city: lm ? lm[1].trim() : loc, province: lm ? lm[2] : null,
      employer: field('Employer'), salaryText: field('Salary'),
      updated: (e.match(/<updated>([^<]+)<\/updated>/) || [])[1] || null,
    });
  }
  return out;
}

/** Fallback parser for the server-rendered search HTML (article.action-buttons > a.resultJobItem). Same shape as parseFeed(). */
function parseSearchHtml(html) {
  const out = [];
  const re = /<article id="article-(\d+)"[\s\S]*?<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const a = m[0], id = m[1];
    const cls = (c) => { const x = inner(a, new RegExp(`<[a-z0-9]+[^>]*class="[^"]*\\b${c}\\b[^"]*"[^>]*>`, 'i')); return x == null ? '' : stripTags(x); };
    const loc = cls('location').replace(/^Location\s*/i, '');
    const lm = loc.match(/^(.*?)\s*\(([A-Z]{2})\)\s*$/);
    out.push({
      id, url: `${BASE}/jobsearch/jobposting/${id}`, title: cls('noctitle'), jobNumber: (cls('source').match(/(\d+)\s*$/) || [])[1] || '',
      city: lm ? lm[1].trim() : loc, province: lm ? lm[2] : null, employer: cls('business'),
      salaryText: cls('salary').replace(/^Salary\s*/i, ''), updated: cls('date') || null,
    });
  }
  return out;
}

async function searchFeed(keyword, province, { maxAge = 6 * 3600 * 1000 } = {}) {
  const res = await fetchPage(feedUrl(keyword, province), { cacheKey: `feed-${keyword}-${province || 'CA'}`, maxAge });
  if (res.status !== 200) throw new Error(`feed ${keyword}/${province || 'CA'}: HTTP ${res.status}`);
  return parseFeed(res.body);
}

// ---------------------------------------------------------------- posting detail page
const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
/** "September 04, 2026" | "2026-10-03" -> Date (UTC noon / end of day), or null */
function parseDate(s, endOfDay) {
  if (!s) return null;
  s = String(s).trim();
  let y, mo, d;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
  else if ((m = s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/)) && MONTHS[m[1].toLowerCase()] != null) { y = +m[3]; mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; }
  else return null;
  return new Date(Date.UTC(y, mo, d, endOfDay ? 23 : 12, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
}

/** Salary -> { min, max, period: 'hour'|'year' } in whole CAD. Weekly/biweekly/monthly/daily are annualised. */
function normaliseSalary(min, max, unit) {
  const u = String(unit || '').toUpperCase().replace(/[^A-Z]/g, '');
  let f = 1, period = 'year';
  if (u === 'HOUR' || u === 'HOURLY') { period = 'hour'; }
  else if (u === 'YEAR' || u === 'ANNUALLY' || u === 'ANNUAL' || u === 'YEARLY') f = 1;
  else if (u === 'WEEK' || u === 'WEEKLY') f = 52;
  else if (u === 'BIWEEKLY' || u === 'BIWEEK' || u === 'BIMONTHLY') f = u === 'BIMONTHLY' ? 24 : 26;
  else if (u === 'MONTH' || u === 'MONTHLY') f = 12;
  else if (u === 'DAY' || u === 'DAILY') f = 260;
  else if (u === 'SEMIMONTHLY') f = 24;
  else return null;
  const conv = (v) => (v == null || !Number.isFinite(v) ? null : period === 'hour' ? Math.round(v * 100) / 100 : Math.round(v * f));
  const a = conv(min), b = conv(max);
  if (a == null && b == null) return null;
  const r = { min: a == null ? b : a, max: b == null ? a : b, period };
  // whole-dollar columns: hourly rates are rounded to the nearest dollar for storage (helpers format with 0 decimals anyway)
  r.min = Math.round(r.min); r.max = Math.round(r.max);
  if (r.min === 0 && r.max === 0) return null;
  return r;
}
/** "$26.00 to $35.00 hourly (To be negotiated)" | "$60,000 annually" | "$1,200 weekly" */
function parseSalaryText(t) {
  if (!t) return null;
  const nums = [...String(t).matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map(m => parseFloat(m[1].replace(/,/g, '')));
  if (!nums.length) return null;
  const unit = (String(t).match(/hourly|annually|yearly|weekly|bi-?weekly|semi-?monthly|monthly|daily|hour|year|week|month|day/i) || ['year'])[0];
  return normaliseSalary(nums[0], nums[1] ?? nums[0], unit);
}

/**
 * Parse a posting detail page. Works for native Job Bank postings (structured Overview/Responsibilities/... sections)
 * and partner-site postings (Jobillico, Workopolis, ... — one HTML blob in property="description").
 */
function parseDetail(html, id) {
  const d = { id, url: `${BASE}/jobsearch/jobposting/${id}`, gone: false, partner: null, externalUrl: null };
  const main = inner(html, /<div class="job-posting-details-body[^"]*"[^>]*>/) || html;
  d.title = (propText(main, 'title') || propText(main, 'name') || '').trim();
  if (!d.title) { d.gone = true; return d; }
  d.originalTitle = (stripTags(inner(main, /<span class="source-title-inner"[^>]*>/) || '').replace(/^Title posted on [^-]+-\s*/i, '') || null);
  const org = inner(main, /<span property="hiringOrganization"[^>]*>/);
  d.employer = stripTags(org ? (inner(org, /<span property="name"[^>]*>/) || org) : '').replace(/\s*\(.*details.*\)$/i, '').trim() || null;
  d.datePosted = parseDate(stripTags(inner(main, /<span property="datePosted"[^>]*>/) || '').replace(/^Posted on\s*/i, ''));
  d.validThrough = parseDate(propText(main, 'validThrough'), true);
  d.city = propText(main, 'addressLocality');
  d.province = propText(main, 'addressRegion');
  d.postalCode = propText(main, 'postalCode');
  d.noc = (html.match(/aa_jobbank_job_noccode">(\d{4,5})</) || [])[1] || (html.match(/class="noc-no">\s*NOC\s*(\d{4,5})/) || [])[1] || null;
  d.employmentType = stripTags(inner(main, /<span property="employmentType"[^>]*>/) || '');
  const wl = main.match(/Work location<\/span>\s*<span>([^<]*)<\/span>/i);
  d.workLocation = wl ? stripTags(wl[1]) : null;
  d.workHours = propText(main, 'workHours');
  const vac = main.match(/(\d+)\s*vacanc/i);
  d.vacancies = vac ? parseInt(vac[1], 10) : 1;
  d.startText = (main.match(/<span>(Starts[^<]*)<\/span>/i) || [])[1] || null;
  const srcBlock = inner(main, /<li>\s*<span class="wb-inv">Source<\/span>/) || '';
  const srcName = stripTags(srcBlock).replace(/Source/, '').replace(/#\s*\d+/, '').trim();
  d.sourceName = srcName || 'Job Bank';
  d.partner = /^job bank$/i.test(d.sourceName) ? null : d.sourceName;
  d.externalUrl = (main.match(/id="externalJobLink"[^>]*href="([^"]+)"/) || [])[1] || null;
  if (d.externalUrl) d.externalUrl = decode(d.externalUrl);
  // salary
  const minV = attrOf(main, 'minValue', 'content'), maxV = attrOf(main, 'maxValue', 'content'), oneV = attrOf(main, 'value', 'content');
  const unit = propText(main, 'unitText');
  d.salary = normaliseSalary(minV != null ? parseFloat(minV) : oneV != null ? parseFloat(oneV) : null, maxV != null ? parseFloat(maxV) : oneV != null ? parseFloat(oneV) : null, unit);
  d.salaryText = stripTags(inner(main, /<span[^>]*property="baseSalary"[^>]*>/) || '') || null;
  if (!d.salary && d.salaryText) d.salary = parseSalaryText(d.salaryText);
  // sections (native postings): ordered { level, title, text } from every job-posting-detail-requirements block
  d.sections = [];
  const reqRe = /<div[^>]*class="[^"]*job-posting-detail-requirements[^"]*"[^>]*>/g;
  let rm;
  while ((rm = reqRe.exec(main))) {
    const block = innerAt(main, rm.index);
    if (block == null) continue;
    const marked = block.replace(/<section[^>]*modal-dialog[\s\S]*?<\/section>/gi, '').replace(/<a[^>]*dialog-help[\s\S]*?<\/a>/gi, '')
      .replace(/<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n\n@@H${l}:${stripTags(t)}@@\n\n`);
    const text = htmlToText(marked);
    let cur = null;
    for (const chunk of text.split(/\n(?=@@H\d:)/)) {
      const hm = chunk.match(/^@@H(\d):([^@]*)@@\s*([\s\S]*)$/);
      if (hm) { cur = { level: +hm[1], title: hm[2].trim(), text: hm[3].trim() }; d.sections.push(cur); }
      else if (cur) cur.text = (cur.text + '\n\n' + chunk.trim()).trim();
      else if (chunk.trim()) d.sections.push({ level: 0, title: '', text: chunk.trim() });
    }
  }
  // employment groups ("Support for youths", "Support for newcomers and refugees", "Support for Indigenous people", ...)
  d.employmentGroups = [...main.matchAll(/<summary>\s*([^<]+?)\s*<\/summary>/g)].map(m => stripTags(m[1])).filter(t => /^support/i.test(t));
  const aud = inner(main, /<div class="job-audience"[^>]*>/);
  d.whoCanApply = aud ? [...aud.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => stripTags(m[1])) : [];
  // partner-site blob
  const blob = inner(main, /<span class="hidden" property="description"[^>]*>/);
  d.descriptionHtml = blob ? decode(blob) : null;
  return d;
}

/** Fetch + parse one posting. { gone: true } when Job Bank answers 410/404 or redirects to /jobpostingexpired. */
async function fetchPosting(id, { maxAge = 7 * 24 * 3600 * 1000, force = false } = {}) {
  const res = await fetchPage(`${BASE}/jobsearch/jobposting/${id}`, { cacheKey: `posting-${id}`, maxAge, force });
  if (res.status === 410 || res.status === 404 || /jobpostingexpired/.test(res.url || '')) return { id, gone: true, status: res.status };
  if (res.status !== 200) throw new Error(`posting ${id}: HTTP ${res.status}`);
  const d = parseDetail(res.body, id);
  d.status = res.status;
  return d;
}

// ---------------------------------------------------------------- mapping to Canada Careers vocabulary
// NOC 2021 prefix -> category. Longest matching prefix wins (1 digit = broad category, 2 = major group, 5 = unit group).
const NOC_CATEGORY = [
  ['0', 'other'],
  ['1', 'administration'], ['11', 'accounting_finance'], ['1120', 'human_resources'], ['11201', 'other'], ['11202', 'marketing_sales'],
  ['12101', 'human_resources'], ['1220', 'accounting_finance'], ['13102', 'accounting_finance'], ['1420', 'accounting_finance'],
  ['1440', 'warehouse_general_labour'], ['14402', 'transport_logistics'], ['14404', 'transport_logistics'], ['14405', 'transport_logistics'],
  ['2', 'science_research'], ['20', 'engineering'], ['20012', 'it_software'], ['21211', 'it_software'], ['2122', 'it_software'], ['2123', 'it_software'],
  ['213', 'engineering'], ['22', 'engineering'], ['221', 'science_research'], ['2222', 'it_software'],
  ['3', 'healthcare'],
  ['4', 'social_services'], ['40', 'other'], ['4002', 'education'], ['40030', 'social_services'], ['411', 'legal'], ['412', 'education'],
  ['4131', 'other'], ['414', 'other'], ['41401', 'accounting_finance'], ['41402', 'marketing_sales'], ['42', 'other'], ['4220', 'social_services'],
  ['42200', 'legal'], ['42202', 'education'], ['42203', 'education'], ['431', 'education'], ['44', 'social_services'], ['44101', 'healthcare'],
  ['5', 'other'], ['50011', 'marketing_sales'],
  ['6', 'other'], ['60010', 'marketing_sales'], ['60020', 'retail'], ['6003', 'hospitality'], ['60040', 'customer_service'], ['6201', 'retail'],
  ['6202', 'hospitality'], ['62023', 'customer_service'], ['62024', 'warehouse_general_labour'], ['62100', 'marketing_sales'], ['62101', 'retail'],
  ['6220', 'hospitality'], ['631', 'marketing_sales'], ['632', 'hospitality'], ['6321', 'other'], ['6322', 'other'], ['641', 'retail'],
  ['64101', 'marketing_sales'], ['643', 'hospitality'], ['644', 'customer_service'], ['64410', 'other'], ['651', 'retail'], ['652', 'hospitality'],
  ['6522', 'other'], ['653', 'warehouse_general_labour'],
  ['7', 'construction_trades'], ['7002', 'transport_logistics'], ['72024', 'transport_logistics'], ['726', 'transport_logistics'],
  ['7330', 'transport_logistics'], ['7331', 'transport_logistics'], ['73401', 'manufacturing'], ['74', 'transport_logistics'],
  ['7410', 'warehouse_general_labour'], ['74203', 'construction_trades'], ['74204', 'construction_trades'], ['74205', 'construction_trades'],
  ['75', 'warehouse_general_labour'], ['7511', 'construction_trades'], ['75119', 'warehouse_general_labour'], ['752', 'transport_logistics'],
  ['8', 'agriculture'],
  ['9', 'manufacturing'],
];
// Keyword fallback (title + first line of description), checked in order.
const KEYWORD_CATEGORY = [
  [/\b(nurse|nursing|rn|lpn|rpn|physician|doctor|dentist|dental|pharmac|paramedic|therapist|physio|health ?care aide|care aide|personal support|psw|caregiver|medical|clinic|hospital|midwife|optometr|chiropract|lab(oratory)? technician|sonograph|radiolog)\b/i, 'healthcare'],
  [/\b(software|developer|programmer|web|full[- ]?stack|devops|data (engineer|analyst|scientist)|it support|systems? (admin|analyst)|network|cyber|database|qa (analyst|engineer)|cloud|computer)\b/i, 'it_software'],
  [/\b(account|bookkeep|payroll|auditor|financial|finance|tax|banking|controller|cfo|treasur)\b/i, 'accounting_finance'],
  [/\b(early childhood|ece|teacher|instructor|tutor|educator|professor|lecturer|daycare|child ?care|preschool|principal)\b/i, 'education'],
  [/\b(truck|driver|delivery|courier|dispatcher|logistics|freight|transport|forklift|shipper|receiver|shipping|bus|chauffeur|trucking)\b/i, 'transport_logistics'],
  [/\b(warehouse|labou?rer|general labour|material handler|packer|picker|cleaner|janitor|custodian|housekeep|mover|loader|sanitation)\b/i, 'warehouse_general_labour'],
  [/\b(electrician|plumber|carpenter|welder|hvac|millwright|mechanic|technician|pipefitter|roofer|drywall|painter|mason|framer|construction|glazier|steamfitter|apprentice|tile|flooring|landscap|crane)\b/i, 'construction_trades'],
  [/\b(cook|chef|kitchen|server|barista|bartender|dishwasher|restaurant|hotel|hospitality|food (service|counter)|host(ess)?|tourism|baker|pastry|catering|line cook)\b/i, 'hospitality'],
  [/\b(customer (service|support|care)|call cent|contact cent|client service|help ?desk|receptionist)\b/i, 'customer_service'],
  [/\b(retail|cashier|sales (associate|clerk|representative|rep)|store|merchandis|shop|grocery|supervisor - retail)\b/i, 'retail'],
  [/\b(administrative|admin|office|clerk|secretary|executive assistant|data entry|coordinator|scheduler)\b/i, 'administration'],
  [/\b(human resources|hr |recruit|talent|hris)\b/i, 'human_resources'],
  [/\b(marketing|sales|business development|account (manager|executive)|advertis|brand|social media|communications)\b/i, 'marketing_sales'],
  [/\b(engineer|engineering|drafts|cad|surveyor)\b/i, 'engineering'],
  [/\b(lawyer|paralegal|legal|law clerk|notary|solicitor)\b/i, 'legal'],
  [/\b(manufactur|production|assembl|machin|operator|fabricat|cnc|plant|factory|quality control|welding)\b/i, 'manufacturing'],
  [/\b(farm|agricultur|greenhouse|harvest|livestock|dairy|ranch|nursery|fish|forestry)\b/i, 'agriculture'],
  [/\b(social (worker|service)|community|counsel|outreach|youth worker|settlement|support worker|shelter|case (worker|manager)|addiction|mental health|developmental)\b/i, 'social_services'],
  [/\b(scientist|research|laboratory|chemist|biolog|analyst)\b/i, 'science_research'],
];
function categoryFor(title, noc, description) {
  if (noc) {
    let best = null;
    for (const [pfx, cat] of NOC_CATEGORY) if (noc.startsWith(pfx) && (!best || pfx.length > best[0].length)) best = [pfx, cat];
    // 1–2 digit matches are coarse; let a strong title keyword override those only.
    if (best && best[0].length > 2) return best[1];
    for (const [re, cat] of KEYWORD_CATEGORY) if (re.test(title || '')) return cat;
    if (best) return best[1];
  }
  const text = `${title || ''}\n${String(description || '').slice(0, 200)}`;
  for (const [re, cat] of KEYWORD_CATEGORY) if (re.test(title || '')) return cat;
  for (const [re, cat] of KEYWORD_CATEGORY) if (re.test(text)) return cat;
  return 'other';
}
function jobTypeFor(employmentType) {
  const t = String(employmentType || '').toLowerCase();
  if (/apprentice/.test(t)) return 'apprenticeship';
  if (/intern|co-op|coop/.test(t)) return 'internship';
  if (/seasonal/.test(t)) return 'seasonal';
  if (/casual/.test(t)) return 'part_time';
  if (/part time|part-time/.test(t)) return 'part_time';
  if (/term or contract|contract|temporary/.test(t)) return /temporary/.test(t) && !/contract/.test(t) ? 'temporary' : 'contract';
  return 'full_time';
}
function workArrangementFor(workLocation, sections) {
  const t = String(workLocation || '').toLowerCase();
  if (/remote|telework|work from home/.test(t)) return 'remote';
  if (/hybrid/.test(t)) return 'hybrid';
  const s = (sections || []).map(x => x.title.toLowerCase());
  if (s.includes('remote')) return 'remote';
  if (s.includes('hybrid')) return 'hybrid';
  return 'on_site';
}
function experienceFor(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/no experience|will train|experience an asset|less than 7 months|7 months to less than 1 year|1 year to less than 2/.test(t)) return 'entry';
  if (/2 years to less|3 years to less|2 to 3|3 to 5/.test(t)) return 'intermediate';
  if (/5 years or more|5\+|more than 5/.test(t)) return 'senior';
  return null;
}
function languagesFor(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return ['English'];
  if (/bilingual|english or french|english and french/.test(t)) return ['English', 'French'];
  const out = [];
  if (/english/.test(t)) out.push('English');
  if (/french|fran/.test(t)) out.push('French');
  return out.length ? out : ['English'];
}
function audiencesFor(groups, noc) {
  const out = new Set();
  for (const g of groups || []) {
    const t = g.toLowerCase();
    if (/newcomer|immigrant/.test(t)) out.add('new_immigrants');
    if (/refugee/.test(t)) out.add('refugees');
    if (/indigenous|aboriginal|first nation|inuit|m[ée]tis/.test(t)) out.add('indigenous');
    if (/youth/.test(t)) out.add('youth');
  }
  if (noc && /^\d[01]/.test(noc)) out.add('professionals');      // NOC 2021: second digit = TEER (0-1 = management / university)
  return [...out];
}
/** Job Bank titles are lower-case ("registered nurse (r.n.)"); make them presentable without shouting. */
function titleCase(s) {
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'de', 'des', 'du', 'en', 'et', 'for', 'in', 'la', 'le', 'les', 'of', 'on', 'or', 'the', 'to', 'with']);
  return String(s || '').trim().replace(/\s+/g, ' ').split(' ').map((w, i) => {
    if (/^[A-Z0-9.&/-]+$/.test(w) && w.length <= 6) return w;                       // keep RN, CNC, HVAC, R.N.
    const lw = w.toLowerCase();
    if (i && small.has(lw)) return lw;
    return lw.replace(/(^|[(\/-])([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase());
  }).join(' ');
}
const PROV_FROM_NAME = Object.fromEntries(C.PROVINCES.map(([k, n]) => [n.toLowerCase(), k]));
function provinceCode(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (/^[A-Z]{2}$/.test(t) && C.PROVINCE_NAME[t]) return t;
  return PROV_FROM_NAME[t.toLowerCase()] || null;
}

const SECTION_REQ = /^(languages?|education|experience|credentials|certificat|experience and specialization|personal suitability|security and safety|transportation\/travel information|work conditions and physical capabilities|own tools|screening questions|area of specialization|computer and technology knowledge|type of|specialization)/i;
const SECTION_BENEFITS = /^(benefits|health benefits|financial benefits|long term benefits|other benefits)/i;
const SECTION_SKIP = /^(overview|responsibilities|additional information|employment groups|who can apply|how to apply|advertised until|on site|remote|hybrid)$/i;

/** Build the row for `jobs` (minus ids/slug) from a parsed detail (+ the feed entry it came from). Returns null if unusable. */
function toJobRecord(d, entry) {
  if (!d || d.gone || !d.title) return null;
  const province = provinceCode(d.province) || provinceCode(entry && entry.province);
  const city = (d.city || (entry && entry.city) || '').replace(/\s+/g, ' ').trim();
  if (!province || !city) return null;
  const employer = (d.employer || (entry && entry.employer) || '').trim();
  if (!employer) return null;

  const desc = [], req = [], ben = [];
  let education = null, experienceText = null, languagesText = null;
  if (d.sections.length) {
    for (const s of d.sections) {
      if (!s.text && !/^(on site|remote|hybrid)$/i.test(s.title)) continue;
      const t = s.title;
      if (/^languages?$/i.test(t)) { languagesText = s.text; req.push(`Languages: ${s.text}`); continue; }
      if (/^education$/i.test(t)) { education = s.text.replace(/^- /gm, '').split('\n').filter(Boolean).join('; ').slice(0, 200); req.push(`Education: ${education}`); continue; }
      if (/^experience$/i.test(t)) { experienceText = s.text; req.push(`Experience: ${s.text}`); continue; }
      if (/^(on site|remote|hybrid)$/i.test(t)) { if (s.text) desc.push(s.text); continue; }
      if (SECTION_BENEFITS.test(t)) { ben.push(`${t}\n${s.text}`); continue; }
      if (SECTION_REQ.test(t)) { req.push(`${t}\n${s.text}`); continue; }
      if (/^employment groups$/i.test(t)) { desc.push(`Employment groups\n${s.text}`); continue; }
      if (SECTION_SKIP.test(t)) { if (s.text) desc.push(s.text); continue; }
      desc.push(`${t}\n${s.text}`);
    }
  }
  if (d.descriptionHtml) desc.unshift(htmlToText(d.descriptionHtml));
  if (d.whoCanApply.length) req.push('Who can apply\n' + d.whoCanApply.map(x => `- ${x}`).join('\n'));
  let description = desc.join('\n\n').trim();
  if (!description) description = `${titleCase(d.title)} position with ${employer} in ${city}, ${C.PROVINCE_NAME[province]}.${d.startText ? ' ' + d.startText + '.' : ''}${d.workHours ? ' ' + d.workHours.trim() + '.' : ''}`;
  if (d.originalTitle && d.originalTitle.toLowerCase() !== d.title.toLowerCase()) description = `${d.originalTitle}\n\n${description}`;
  const salary = d.salary || (entry && parseSalaryText(entry.salaryText)) || null;
  const publishedAt = d.datePosted || (entry && entry.updated ? new Date(entry.updated) : null) || new Date();
  const expiresAt = d.validThrough || new Date(publishedAt.getTime() + 30 * 24 * 3600 * 1000);
  return {
    title: titleCase(d.title).slice(0, 200),
    description: description.slice(0, 20000),
    requirements: req.join('\n\n').trim().slice(0, 10000) || null,
    benefits: ben.join('\n\n').trim().slice(0, 5000) || null,
    category: categoryFor(d.title, d.noc, description),
    noc_code: d.noc,
    job_type: jobTypeFor(d.employmentType),
    work_arrangement: workArrangementFor(d.workLocation, d.sections),
    experience_level: experienceFor(experienceText),
    education,
    city: city.slice(0, 120), province, postal_code: d.postalCode || null,
    salary_min: salary ? salary.min : null, salary_max: salary ? salary.max : null, salary_period: salary ? salary.period : 'year',
    vacancies: Math.max(1, Math.min(9999, d.vacancies || 1)),
    languages: languagesFor(languagesText),
    audiences: audiencesFor(d.employmentGroups, d.noc),
    apply_url: d.url,
    source: SOURCE, source_id: String(d.id), source_url: d.url, source_employer: employer.slice(0, 200),
    published_at: publishedAt, expires_at: expiresAt,
  };
}

// ---------------------------------------------------------------- DB: system user, employer profiles, upsert
async function ensureSystemUser() {
  const u = await db.one('SELECT id FROM users WHERE email=$1', [SYSTEM_EMAIL]);
  if (u) return u.id;
  // Nobody logs in as this account: random unguessable hash-shaped secret, is_active=false.
  const r = await db.one(`INSERT INTO users(email,password_hash,role,name,email_verified,is_active) VALUES ($1,$2,'consultant',$3,true,false)
    ON CONFLICT (email) DO UPDATE SET updated_at=now() RETURNING id`, [SYSTEM_EMAIL, 'disabled:' + crypto.randomBytes(32).toString('hex'), SYSTEM_NAME]);
  return r.id;
}
const profileCache = new Map();
async function ensureEmployerProfile(ownerId, name, city, province) {
  const key = name.toLowerCase();
  if (profileCache.has(key)) return profileCache.get(key);
  let p = await db.one(`SELECT id FROM employer_profiles WHERE source=$1 AND lower(company_name)=lower($2) ORDER BY id LIMIT 1`, [SOURCE, name]);
  if (!p) {
    p = await db.one(`INSERT INTO employer_profiles(owner_user_id,company_name,slug,city,province,description,source)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ownerId, name, await uniqueProfileSlug(name), city, province, EMPLOYER_BLURB, SOURCE]);
  }
  profileCache.set(key, p.id);
  return p.id;
}

/** Insert or update one job. Returns 'inserted' | 'updated' | 'revived'. */
async function upsertJob(rec, systemUserId) {
  const existing = await db.one('SELECT id, status FROM jobs WHERE source=$1 AND source_id=$2', [SOURCE, rec.source_id]);
  if (existing) {
    const revive = existing.status === 'expired' && rec.expires_at > new Date();
    await db.query(`UPDATE jobs SET title=$2, description=$3, requirements=$4, benefits=$5, category=$6, noc_code=$7, job_type=$8, work_arrangement=$9,
        experience_level=$10, education=$11, city=$12, province=$13, postal_code=$14, salary_min=$15, salary_max=$16, salary_period=$17, vacancies=$18,
        languages=$19, audiences=$20, apply_url=$21, source_url=$22, source_employer=$23, published_at=COALESCE(published_at,$24), expires_at=$25,
        source_synced_at=now(), updated_at=now()
        ${revive ? ", status='active', archived_at=NULL" : ''}
      WHERE id=$1`,
      [existing.id, rec.title, rec.description, rec.requirements, rec.benefits, rec.category, rec.noc_code, rec.job_type, rec.work_arrangement,
        rec.experience_level, rec.education, rec.city, rec.province, rec.postal_code, rec.salary_min, rec.salary_max, rec.salary_period, rec.vacancies,
        rec.languages, rec.audiences, rec.apply_url, rec.source_url, rec.source_employer, rec.published_at, rec.expires_at]);
    return revive ? 'revived' : 'updated';
  }
  const profileId = await ensureEmployerProfile(systemUserId, rec.source_employer, rec.city, rec.province);
  await db.query(`INSERT INTO jobs(employer_profile_id, created_by, title, slug, description, requirements, benefits, category, noc_code, job_type, work_arrangement,
      experience_level, education, city, province, postal_code, salary_min, salary_max, salary_period, vacancies, languages, audiences, apply_url,
      status, published_at, expires_at, source, source_id, source_url, source_employer, source_synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'active',$24,$25,$26,$27,$28,$29,now())
    ON CONFLICT (source, source_id) WHERE source IS NOT NULL DO NOTHING`,
    [profileId, systemUserId, rec.title, await uniqueJobSlug(rec.title, rec.city), rec.description, rec.requirements, rec.benefits, rec.category, rec.noc_code,
      rec.job_type, rec.work_arrangement, rec.experience_level, rec.education, rec.city, rec.province, rec.postal_code, rec.salary_min, rec.salary_max,
      rec.salary_period, rec.vacancies, rec.languages, rec.audiences, rec.apply_url, rec.published_at, rec.expires_at, SOURCE, rec.source_id, rec.source_url, rec.source_employer]);
  return 'inserted';
}

// ---------------------------------------------------------------- import run
/**
 * Pull new postings for keyword × province. One nationwide feed per keyword (rows=100) is bucketed by province first;
 * a province-filtered feed is fetched only when that bucket has fewer than `perQuery` unseen candidates.
 * Detail pages are fetched only for postings we intend to insert. Postings past validThrough are skipped.
 */
async function importQueries({ queries = DEFAULT_QUERIES, provinces = DEFAULT_PROVINCES, limit = 200, perQuery = 2, dryRun = false, log = console.log, maxRequests = 600, onRecord } = {}) {
  const t0 = Date.now();
  const systemUserId = dryRun ? null : await ensureSystemUser();
  const known = new Set((await db.many(`SELECT source_id FROM jobs WHERE source=$1`, [SOURCE])).map(r => r.source_id));
  const seen = new Set();
  const rows = [];        // per query summary
  const totals = { found: 0, inserted: 0, updated: 0, existing: 0, skipped: 0, errors: 0 };
  const byCat = {}, byProv = {};
  const startReq = stats.requests;
  let inserted = 0;
  outer:
  for (const q of queries) {
    let nationwide = [];
    try { nationwide = await searchFeed(q, null); } catch (e) { log(`  feed ${q}: ${e.message}`); totals.errors++; }
    for (const prov of provinces) {
      const row = { query: q, province: prov, found: 0, inserted: 0, updated: 0, existing: 0, skipped: 0 };
      rows.push(row);
      let cands = nationwide.filter(e => e.province === prov);
      const fresh = (list) => list.filter(e => !known.has(e.id) && !seen.has(e.id));
      if (fresh(cands).length < perQuery && stats.requests - startReq < maxRequests) {
        try { const extra = await searchFeed(q, prov); const ids = new Set(cands.map(e => e.id)); cands = cands.concat(extra.filter(e => !ids.has(e.id))); }
        catch (e) { log(`  feed ${q}/${prov}: ${e.message}`); totals.errors++; }
      }
      row.found = cands.length; totals.found += cands.length;
      let taken = 0;
      for (const entry of cands) {
        if (taken >= perQuery) break;
        if (inserted >= limit) break outer;
        if (stats.requests - startReq >= maxRequests) { log(`  request budget (${maxRequests}) reached`); break outer; }
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        if (known.has(entry.id)) {
          // Already imported: refresh it only when the detail page is still in the on-disk cache (no network cost);
          // otherwise leave it to refreshImported(), which re-checks every live imported posting.
          const c = dryRun ? null : readCache(`posting-${entry.id}`, 7 * 24 * 3600 * 1000);
          if (c && c.status === 200) {
            const rec = toJobRecord(parseDetail(c.body, entry.id), entry);
            if (rec) { await upsertJob(rec, systemUserId); row.updated++; totals.updated++; continue; }
          }
          row.existing++; totals.existing++; continue;
        }
        let d;
        try { d = await fetchPosting(entry.id); } catch (e) { log(`  posting ${entry.id}: ${e.message}`); totals.errors++; continue; }
        const rec = d.gone ? null : toJobRecord(d, entry);
        if (!rec || rec.expires_at <= new Date()) { row.skipped++; totals.skipped++; continue; }
        if (onRecord) onRecord(rec, d);
        if (!dryRun) {
          const what = await upsertJob(rec, systemUserId);
          if (what === 'inserted') { known.add(entry.id); }
          else { row.updated++; totals.updated++; continue; }
        }
        row.inserted++; totals.inserted++; inserted++; taken++;
        byCat[rec.category] = (byCat[rec.category] || 0) + 1;
        byProv[rec.province] = (byProv[rec.province] || 0) + 1;
      }
    }
  }
  return { rows, totals, byCat, byProv, requests: stats.requests - startReq, cacheHits: stats.cacheHits, seconds: Math.round((Date.now() - t0) / 1000), dryRun };
}

/**
 * Re-check every live imported posting against Job Bank (detail page, cache max 20h): gone/expired -> status 'expired'
 * (archived, never public); still live -> refresh title/description/expiry. Returns { checked, expired, refreshed, errors }.
 */
async function refreshImported({ log = console.log, maxAge = 20 * 3600 * 1000, maxRequests = 1000 } = {}) {
  const out = { checked: 0, expired: 0, refreshed: 0, errors: 0 };
  // 1) anything past its Job Bank expiry goes first, no network needed (only OUR rows — never touch paid postings)
  const lapsed = await db.query(`UPDATE jobs SET status='expired', archived_at=now(), updated_at=now() WHERE source=$1 AND status='active' AND expires_at <= now() RETURNING id`, [SOURCE]);
  out.expired += lapsed.rowCount;
  const systemUserId = await ensureSystemUser();
  const live = await db.many(`SELECT id, source_id, city, province, source_employer FROM jobs WHERE source=$1 AND status='active' ORDER BY source_synced_at NULLS FIRST, id`, [SOURCE]);
  const startReq = stats.requests;
  for (const j of live) {
    if (stats.requests - startReq >= maxRequests) { log(`  refresh: request budget (${maxRequests}) reached after ${out.checked} postings`); break; }
    out.checked++;
    let d;
    try { d = await fetchPosting(j.source_id, { maxAge }); } catch (e) { out.errors++; log(`  posting ${j.source_id}: ${e.message}`); continue; }
    const rec = d.gone ? null : toJobRecord(d, { city: j.city, province: j.province, employer: j.source_employer });
    if (!rec || rec.expires_at <= new Date()) { await archiveJob(j.id, 'expired'); out.expired++; continue; }
    await upsertJob(rec, systemUserId);
    out.refreshed++;
  }
  return out;
}

/** Console summary table for a run. */
function formatSummary(r) {
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n);
  lines.push(pad('query', 28) + pad('prov', 6) + pad('found', 7) + pad('inserted', 10) + pad('updated', 9) + 'skipped');
  for (const row of r.rows) lines.push(pad(row.query, 28) + pad(row.province, 6) + pad(row.found, 7) + pad(row.inserted, 10) + pad(row.updated, 9) + row.skipped);
  lines.push(pad('TOTAL', 34) + pad(r.totals.found, 7) + pad(r.totals.inserted, 10) + pad(r.totals.updated, 9) + r.totals.skipped + (r.totals.errors ? `   errors ${r.totals.errors}` : ''));
  lines.push(`by category: ${Object.entries(r.byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}`);
  lines.push(`by province: ${Object.entries(r.byProv).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}`);
  lines.push(`${r.requests} HTTP requests (${r.cacheHits} cache hits), ${r.seconds}s${r.dryRun ? ' — DRY RUN, nothing written' : ''}`);
  return lines.join('\n');
}

module.exports = {
  BASE, USER_AGENT, CACHE_DIR, DELAY_MS, SOURCE, SYSTEM_EMAIL, SYSTEM_NAME, DEFAULT_QUERIES, DEFAULT_PROVINCES, stats,
  fetchPage, feedUrl, parseFeed, parseSearchHtml, searchFeed, parseDetail, fetchPosting,
  htmlToText, decode, stripTags, parseDate, normaliseSalary, parseSalaryText, categoryFor, jobTypeFor, workArrangementFor, titleCase, provinceCode,
  toJobRecord, ensureSystemUser, ensureEmployerProfile, upsertJob, importQueries, refreshImported, formatSummary,
};
