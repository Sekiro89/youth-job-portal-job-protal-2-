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
    await db.pool.end();
    process.exit(counts.errors ? 1 : 0);
  } catch (e) {
    console.error('[renewals] fatal', e);
    try { await db.pool.end(); } catch (_) {}
    process.exit(1);
  }
})();
