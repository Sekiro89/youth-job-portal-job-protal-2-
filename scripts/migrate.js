'use strict';
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const db = require('../lib/db');
(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.query(sql);
  console.log('schema applied to', process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@'));
  await db.pool.end();
})().catch(e => { console.error(e); process.exit(1); });
