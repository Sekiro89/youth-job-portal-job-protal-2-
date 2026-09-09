#!/usr/bin/env node
'use strict';
// Import current postings from Job Bank (jobbank.gc.ca) into the `jobs` table. See docs/JOBBANK.md.
//
//   DATABASE_URL=postgres://... node scripts/import-jobbank.js --dry-run --limit 5 --queries nurse --provinces ON
//   DATABASE_URL=postgres://... node scripts/import-jobbank.js                    # default 15 keywords × 8 provinces, ≤200 new
//
// Options: --queries "a,b,c"  --provinces "ON,BC"  --limit N (max new postings)  --per-query N (max new per keyword×province, default 2)
//          --max-requests N (HTTP budget, default 600)  --dry-run (fetch + parse + print, write nothing)  --refresh (also re-check live imported jobs)
// Requests are throttled to robots.txt's Crawl-delay (5 s; JOBBANK_DELAY_MS overrides) and cached under data/jobbank-cache/.

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const db = require('../lib/db');
const jb = require('../lib/jobbank');

const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (!m) continue;
  if (m[2] !== undefined) argv[m[1]] = m[2];
  else if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) argv[m[1]] = process.argv[++i];
  else argv[m[1]] = true;
}
const list = (v, dflt) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : dflt);
const num = (v, dflt) => (v == null || v === true ? dflt : Math.max(0, parseInt(v, 10) || dflt));

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
  const queries = list(argv.queries, jb.DEFAULT_QUERIES);
  const provinces = list(argv.provinces, jb.DEFAULT_PROVINCES).map(p => p.toUpperCase());
  const bad = provinces.filter(p => !jb.provinceCode(p));
  if (bad.length) { console.error(`unknown province code(s): ${bad.join(', ')}`); process.exit(2); }
  const opts = {
    queries, provinces,
    limit: num(argv.limit, 200), perQuery: num(argv['per-query'], 2), maxRequests: num(argv['max-requests'], 600),
    dryRun: !!argv['dry-run'], log: console.log,
  };
  console.log(`jobbank import: ${queries.length} keyword(s) × ${provinces.join('/')} — limit ${opts.limit}, per-query ${opts.perQuery}, delay ${jb.DELAY_MS} ms${opts.dryRun ? ' — DRY RUN' : ''}`);
  const est = Math.min(opts.limit, queries.length * provinces.length * opts.perQuery) + queries.length;
  console.log(`  ~${est} HTTP requests worst case ≈ ${Math.ceil(est * jb.DELAY_MS / 60000)} min (cache hits are free)`);

  if (opts.dryRun) {
    opts.onRecord = (rec, d) => {
      const short = Object.assign({}, rec, { description: rec.description.slice(0, 400) + (rec.description.length > 400 ? ` … (+${rec.description.length - 400} chars)` : ''), requirements: rec.requirements ? rec.requirements.slice(0, 300) + (rec.requirements.length > 300 ? ' …' : '') : null });
      console.log(`\n--- parsed ${d.id} (${d.partner ? 'partner: ' + d.partner : 'native Job Bank'})`);
      console.log(JSON.stringify(short, null, 2));
    };
  }
  const r = await jb.importQueries(opts);
  console.log('\n' + jb.formatSummary(r));

  if (argv.refresh && !opts.dryRun) {
    console.log('\nrefreshing live imported postings…');
    const rr = await jb.refreshImported({ log: console.log });
    console.log(`refresh: checked ${rr.checked}, expired ${rr.expired}, refreshed ${rr.refreshed}, errors ${rr.errors}`);
  }
  if (!opts.dryRun) {
    const [c, p] = await Promise.all([
      db.many(`SELECT province, count(*)::int AS n FROM jobs WHERE source=$1 AND status='active' GROUP BY 1 ORDER BY 2 DESC`, [jb.SOURCE]),
      db.one(`SELECT count(*)::int AS n FROM employer_profiles WHERE source=$1`, [jb.SOURCE]),
    ]);
    console.log(`\nlive Job Bank postings in DB: ${c.reduce((a, r) => a + r.n, 0)} (${c.map(r => `${r.province}=${r.n}`).join(', ')}); employer profiles: ${p.n}`);
  }
  await db.pool.end();
}

main().catch(async (e) => { console.error(e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
