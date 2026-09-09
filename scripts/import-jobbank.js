#!/usr/bin/env node
'use strict';
// Import current postings from Job Bank (jobbank.gc.ca) into the `jobs` table. See docs/JOBBANK.md.
//
//   DATABASE_URL=postgres://... node scripts/import-jobbank.js --dry-run --limit 5 --queries nurse --provinces ON
//   DATABASE_URL=postgres://... node scripts/import-jobbank.js                    # default 15 keywords × 8 provinces, ≤200 new
//   DATABASE_URL=postgres://... node scripts/import-jobbank.js --refresh --limit 0  # re-map every imported row from cache, import nothing new
//   DATABASE_URL=postgres://... node scripts/import-jobbank.js --purge             # archive ALL imported postings + disable the daily sync
//
// Options: --queries "a,b,c"  --provinces "ON,BC"  --limit N (max new postings; 0 = import nothing new)  --per-query N (max new per keyword×province, default 2)
//          --max-requests N (HTTP budget, default 600)  --dry-run (fetch + parse + print, write nothing)  --refresh (also re-check live imported jobs)
//          --purge (archive every imported posting, set settings.jobbank_sync=off, exit)
//          --enable (undo a purge: clear that flag, re-activate purged rows whose Job Bank expiry is still ahead, then continue)
//          --from-cache (with --refresh: re-map from the on-disk page cache regardless of age — no network)
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
// "--limit 0" must mean zero (the old `parseInt(v) || dflt` turned it into the default)
const num = (v, dflt) => { if (v == null || v === true) return dflt; const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, n) : dflt; };

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }

  if (argv.purge) {
    const r = await jb.purgeImported({ log: console.log });
    console.log(`purged: ${r.archived} posting(s) archived. Re-enable imports later with --enable.`);
    await db.pool.end();
    return;
  }
  if (argv.enable) await jb.restoreImported({ log: console.log });   // clears the flag + re-activates purged rows whose Job Bank expiry is still ahead
  const disabled = await jb.isSyncDisabled();
  if (disabled && !argv['dry-run']) {
    console.error(`Job Bank imports are disabled (${disabled}) — the reference postings were purged. Pass --enable to turn them back on.`);
    await db.pool.end();
    process.exit(3);
  }

  const queries = list(argv.queries, jb.DEFAULT_QUERIES);
  const provinces = list(argv.provinces, jb.DEFAULT_PROVINCES).map(p => p.toUpperCase());
  const bad = provinces.filter(p => !jb.provinceCode(p));
  if (bad.length) { console.error(`unknown province code(s): ${bad.join(', ')}`); process.exit(2); }
  const opts = {
    queries, provinces,
    limit: num(argv.limit, 200), perQuery: num(argv['per-query'], 2), maxRequests: num(argv['max-requests'], 600),
    dryRun: !!argv['dry-run'], log: console.log,
  };

  if (opts.limit > 0) {
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
  } else {
    console.log(`jobbank import: --limit 0 — importing nothing new${argv.refresh ? ', refresh only' : ''}`);
  }

  if (argv.refresh && !opts.dryRun) {
    // --from-cache: re-map every live imported row from the on-disk page cache regardless of its age (no network unless a page
    // is missing from the cache). Use it after a parser/mapping change; the daily sync still re-checks Job Bank within 20 h.
    const maxAge = argv['from-cache'] ? Infinity : undefined;
    console.log(`\nrefreshing live imported postings${maxAge ? ' (from cache — any age)' : ''}…`);
    const rr = await jb.refreshImported({ log: console.log, maxAge });
    console.log(`refresh: checked ${rr.checked}, expired ${rr.expired}, refreshed ${rr.refreshed}, errors ${rr.errors} (${jb.stats.requests} HTTP requests, ${jb.stats.cacheHits} cache hits)`);
  }
  if (!opts.dryRun) {
    const [c, p, sp, loc] = await Promise.all([
      db.many(`SELECT province, count(*)::int AS n FROM jobs WHERE source=$1 AND status='active' GROUP BY 1 ORDER BY 2 DESC`, [jb.SOURCE]),
      db.one(`SELECT count(*)::int AS n, count(operating_name)::int AS op FROM employer_profiles WHERE source=$1`, [jb.SOURCE]),
      db.many(`SELECT salary_period, count(*)::int AS n FROM jobs WHERE source=$1 AND status='active' GROUP BY 1 ORDER BY 2 DESC`, [jb.SOURCE]),
      db.one(`SELECT count(*)::int AS n, count(l.street_address)::int AS street FROM job_locations l JOIN jobs j ON j.id=l.job_id WHERE j.source=$1 AND j.status='active'`, [jb.SOURCE]),
    ]);
    console.log(`\nlive Job Bank postings in DB: ${c.reduce((a, r) => a + r.n, 0)} (${c.map(r => `${r.province}=${r.n}`).join(', ')}); employer profiles: ${p.n} (${p.op} with operating name)`);
    console.log(`salary periods: ${sp.map(r => `${r.salary_period}=${r.n}`).join(', ')}; work locations: ${loc.n} rows (${loc.street} with a street address)`);
  }
  await db.pool.end();
}

main().catch(async (e) => { console.error(e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
