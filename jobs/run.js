#!/usr/bin/env node
'use strict';
// CLI: node jobs/run.js  — runs renewals once and exits (systemd timer / cron, daily).
require('dotenv').config();
const db = require('../lib/db');
const { runRenewals } = require('./renewals');

(async () => {
  const started = Date.now();
  try {
    const counts = await runRenewals();
    console.log(`[renewals] done in ${Date.now() - started}ms:`, JSON.stringify(counts));
    if (process.env.JOBBANK_SYNC !== '0') {
      try {
        const { syncJobBank } = require('./jobbank-sync');
        const t = Date.now();
        const r = await syncJobBank();
        console.log(`[jobbank] done in ${Date.now() - t}ms:`, JSON.stringify(r));
      } catch (e) { console.error('[jobbank] failed', e.message); }
    }
    await db.pool.end();
    process.exit(counts.errors ? 1 : 0);
  } catch (e) {
    console.error('[renewals] fatal', e);
    try { await db.pool.end(); } catch (_) {}
    process.exit(1);
  }
})();
