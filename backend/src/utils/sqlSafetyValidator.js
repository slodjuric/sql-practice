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

// Rejects SQL that contains schema-qualified references to datasets OTHER than
// the session's allowed schema.  Uses a known-schema list so that legitimate
// table.column references (e.g. students.first_name) are never flagged —
// only identifiers that match a real dataset schema name are inspected.
//
// knownDatasetSchemas: all schema_name values from the datasets table.
// When only one dataset exists, otherSchemas is empty and the check is a no-op.
function validateSchemaScope(sql, allowedSchema, knownDatasetSchemas = []) {
  const normalizedAllowed = allowedSchema.toLowerCase();
  const otherSchemas = new Set(
    knownDatasetSchemas.map(s => s.toLowerCase()).filter(s => s !== normalizedAllowed)
  );

  if (otherSchemas.size === 0) return { safe: true };

  const normalized = sql.toLowerCase();
  // Match word.word patterns; the left side is a candidate schema reference.
  const pattern = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g;
  let match;
  while ((match = pattern.exec(normalized)) !== null) {
    if (otherSchemas.has(match[1])) {
      return {
        safe:   false,
        reason: `Cross-dataset query not allowed. Your session only has access to the "${allowedSchema}" dataset.`,
      };
    }
  }

  return { safe: true };
}

module.exports = { validateSqlSafety, validateSchemaScope };
