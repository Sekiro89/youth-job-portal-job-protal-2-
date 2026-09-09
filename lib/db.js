'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});
pool.on('error', (err) => console.error('[db] idle client error', err));

/** query(sql, params) -> { rows, rowCount } */
const query = (text, params) => pool.query(text, params);
/** one(sql, params) -> first row or null */
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
/** many(sql, params) -> rows[] */
const many = async (text, params) => (await pool.query(text, params)).rows;
/** tx(async (client) => {...}) — runs inside BEGIN/COMMIT, rolls back on throw */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, many, tx };
