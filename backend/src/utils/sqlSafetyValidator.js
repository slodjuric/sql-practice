'use strict';

// Dangerous keywords whose presence anywhere in the SQL indicates a non-read-only
// query. Matched with word boundaries so "grandrevoke" would not match "grant".
//
// Conservative limitation: this also blocks the same words inside string literals
// (e.g. SELECT 'drop table students' is rejected). This is an accepted trade-off
// for simplicity — a full parse would be needed to distinguish literal content.
//
// "replace" is intentionally absent: REPLACE() is a standard read-only PostgreSQL
// string function used in text-manipulation tasks.
const BLOCKED_KEYWORDS = [
  'drop',
  'delete',
  'update',
  'insert',
  'alter',
  'truncate',
  'create',
  'grant',
  'revoke',
  'merge',
  'call',
  'execute',
  'copy',
];

// Validate that a SQL string is safe to run in a read-only practice context.
//
// Returns { safe: true } or { safe: false, reason: string }.
//
// Allowed: queries that start with SELECT or WITH (case-insensitive, after trim).
// WITH is allowed because CTEs are common in SQL practice, but the blocked-keyword
// scan below guards against destructive CTEs (WITH ... DELETE/INSERT/UPDATE ...).
function validateSqlSafety(sql) {
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return { safe: false, reason: 'Only read-only SELECT queries are allowed.' };
  }

  const normalized = sql.trim().toLowerCase();

  if (!normalized.startsWith('select') && !normalized.startsWith('with')) {
    return { safe: false, reason: 'Only read-only SELECT queries are allowed.' };
  }

  for (const keyword of BLOCKED_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(normalized)) {
      return {
        safe:   false,
        reason: `Only read-only SELECT queries are allowed. Detected: ${keyword.toUpperCase()}`,
      };
    }
  }

  return { safe: true };
}

module.exports = { validateSqlSafety };
