'use strict';

const pool = require('../db');

// Maximum rows returned to the client from a user-submitted query.
// Configurable via QUERY_ROW_LIMIT env var; defaults to 1000.
const ROW_LIMIT = parseInt(process.env.QUERY_ROW_LIMIT, 10) || 1000;

// Maximum execution time (ms) for a user-submitted query.
// Configurable via QUERY_TIMEOUT_MS env var; defaults to 5 000 ms.
const QUERY_TIMEOUT = parseInt(process.env.QUERY_TIMEOUT_MS, 10) || 5000;

// Executes user-submitted SQL on a dedicated pool connection with a
// statement_timeout guard and search_path scoped to the dataset schema.
//
// - Acquires its own client so timeout and search_path settings are isolated.
// - Resets both settings before releasing the client, regardless of outcome,
//   so the pooled connection is not left in a restricted state.
//
// Throws the raw pg error on failure (callers inspect err.code === '57014'
// for timeout; all other codes are SQL errors from the user's query).
//
// Does NOT enforce ROW_LIMIT internally — callers check result.rowCount after
// the call so they can produce context-specific error messages.
async function executeUserQuery(sql, schemaName = 'academic') {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${QUERY_TIMEOUT}`);
    await client.query(`SET search_path = ${schemaName}, pg_catalog`);
    const result = await client.query(sql);
    return result;
  } finally {
    try { await client.query('SET statement_timeout = 0'); } catch (_) {}
    try { await client.query('SET search_path = public, pg_catalog'); } catch (_) {}
    client.release();
  }
}

// Executes trusted solution SQL with search_path scoped to the dataset schema.
// No timeout guard — solution SQL is authored by the developer and is trusted.
// Uses a dedicated client so search_path is isolated and reset after the query.
async function executeSolutionQuery(sql, schemaName = 'academic') {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path = ${schemaName}, pg_catalog`);
    return await client.query(sql);
  } finally {
    try { await client.query('SET search_path = public, pg_catalog'); } catch (_) {}
    client.release();
  }
}

module.exports = { executeUserQuery, executeSolutionQuery, ROW_LIMIT, QUERY_TIMEOUT };
