#!/usr/bin/env node
'use strict';
// CLI: node jobs/geocode.js [--limit=100]  — geocodes every job_locations / employer_locations row without lat/lng and exits.
// The daily runner (jobs/run.js) calls geocodeMissing() too; this is for backfills and for checking a provider switch.
// Nominatim is throttled to 1 request / 1.1 s, so 100 rows take up to ~4 min worst case (each row may try up to 4 queries).
require('dotenv').config();
const db = require('../lib/db');
const { geocodeMissing, provider } = require('../lib/geocode');

(async () => {
  const arg = process.argv.find(a => a.startsWith('--limit='));
  const limit = Math.max(1, Math.min(2000, Number(arg ? arg.split('=')[1] : 100) || 100));
  const started = Date.now();
  try {
    console.log(`[geocode] provider=${await provider()} limit=${limit}`);
    const r = await geocodeMissing({ limit });
    console.log(`[geocode] done in ${Date.now() - started}ms:`, JSON.stringify(r));
    await db.pool.end();
    process.exit(r.error ? 1 : 0);
  } catch (e) {
    console.error('[geocode] fatal', e);
    try { await db.pool.end(); } catch (_) {}
    process.exit(1);
  }
})();
