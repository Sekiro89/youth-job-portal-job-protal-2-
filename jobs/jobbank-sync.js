'use strict';
// Daily Job Bank sync (called by the cron runner): 1) re-check every live imported posting against jobbank.gc.ca and
// expire the ones that are gone / past validThrough; 2) pull new postings for the default keyword × province set.
// Imported postings are free, attributed content — this never touches subscriptions/payments.
//
//   node -e "require('./jobs/jobbank-sync').syncJobBank().then(r => console.log(r))"
//
// Budget: robots.txt Crawl-delay is 5 s, so ~300 live postings + ~100 new ≈ 35 min per run; keep it on a daily timer.

const jb = require('../lib/jobbank');

async function syncJobBank({ log = console.log, limit = 100, perQuery = 1, maxRequests = 700 } = {}) {
  const t0 = Date.now();
  const req0 = jb.stats.requests;
  // Kill switch: `node scripts/import-jobbank.js --purge` archives every imported posting and sets settings.jobbank_sync=off
  // (env JOBBANK_SYNC=off works too). Nothing is fetched or revived until `--enable` clears it.
  const disabled = await jb.isSyncDisabled();
  if (disabled) {
    log(`[jobbank-sync] skipped — imports disabled (${disabled}); run scripts/import-jobbank.js --enable to resume`);
    return { skipped: disabled, refresh: { checked: 0, expired: 0, refreshed: 0, errors: 0 }, import: { found: 0, inserted: 0, updated: 0, existing: 0, skipped: 0, errors: 0 }, requests: 0, seconds: 0 };
  }
  log(`[jobbank-sync] start (delay ${jb.DELAY_MS} ms)`);
  const refresh = await jb.refreshImported({ log, maxRequests: Math.floor(maxRequests * 0.7) });
  log(`[jobbank-sync] refresh: checked ${refresh.checked}, expired ${refresh.expired}, refreshed ${refresh.refreshed}, errors ${refresh.errors}`);
  const imp = await jb.importQueries({ queries: jb.DEFAULT_QUERIES, provinces: jb.DEFAULT_PROVINCES, limit, perQuery, maxRequests: Math.ceil(maxRequests * 0.3), log });
  log(`[jobbank-sync] import: found ${imp.totals.found}, inserted ${imp.totals.inserted}, updated ${imp.totals.updated}, existing ${imp.totals.existing}, skipped ${imp.totals.skipped}, errors ${imp.totals.errors} (${imp.requests} requests)`);
  const out = { refresh, import: imp.totals, requests: jb.stats.requests - req0, seconds: Math.round((Date.now() - t0) / 1000) };
  log(`[jobbank-sync] done in ${out.seconds}s`);
  return out;
}

module.exports = { syncJobBank };

if (require.main === module) {
  require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
  syncJobBank().then(async (r) => { console.log(JSON.stringify(r)); await require('../lib/db').pool.end(); })
    .catch(async (e) => { console.error(e); try { await require('../lib/db').pool.end(); } catch (_) {} process.exit(1); });
}
