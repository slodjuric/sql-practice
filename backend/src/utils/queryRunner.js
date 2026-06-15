'use strict';

const pool = require('../db');

// Maximum rows returned to the client from a user-submitted query.
// Configurable via QUERY_ROW_LIMIT env var; defaults to 1000.
const ROW_LIMIT = parseInt(process.env.QUERY_ROW_LIMIT, 10) || 1000;

// Maximum execution time (ms) for a user-submitted query.
// Configurable via QUERY_TIMEOUT_MS env var; defaults to 5 000 ms.
const QUERY_TIMEOUT = parseInt(process.env.QUERY_TIMEOUT_MS, 10) || 5000;

// Executes user-submitted SQL on a dedicated pool connection with a
// statement_timeout guard.
//
// - Acquires its own client so the timeout setting is isolated to this call.
// - Resets statement_timeout to 0 before releasing the client, regardless of
//   whether the query succeeded or failed, so the pooled connection is not left
//   in a restricted state for the next caller.
//
// Throws the raw pg error on failure (callers inspect err.code === '57014'
// for timeout; all other codes are SQL errors from the user's query).
//
// Does NOT enforce ROW_LIMIT internally — callers check result.rowCount after
// the call so they can produce context-specific error messages.
async function executeUserQuery(sql) {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${QUERY_TIMEOUT}`);
    const result = await client.query(sql);
    return result;
  } finally {
    try { await client.query('SET statement_timeout = 0'); } catch (_) {}
    client.release();
  }
}

module.exports = { executeUserQuery, ROW_LIMIT, QUERY_TIMEOUT };
