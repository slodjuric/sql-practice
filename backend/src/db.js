const { Pool } = require('pg');
require('dotenv').config();

// Explicit pool sizing/timeouts — previously all left at pg's defaults,
// which meant an unbounded wait (no connectionTimeoutMillis) whenever the
// pool was exhausted, rather than a controlled failure. Check Answer is the
// main pressure point: it acquires two dedicated clients per request (see
// utils/queryRunner.js), so a handful of concurrent checks can occupy the
// whole pool. Defaults below preserve current local/dev behavior (10 was
// already pg's implicit default for `max`) while making the limits explicit
// and configurable per-environment.
const DB_POOL_MAX = parseInt(process.env.DB_POOL_MAX, 10) || 10;
const DB_CONNECTION_TIMEOUT_MS = parseInt(process.env.DB_CONNECTION_TIMEOUT_MS, 10) || 5000;
const DB_IDLE_TIMEOUT_MS = parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10) || 30000;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'sql_practice',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  max: DB_POOL_MAX,
  connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
});

pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('PostgreSQL connection error:', err.message);
});

module.exports = pool;
