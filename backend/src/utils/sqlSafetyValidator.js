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
//
// "into" blocks PostgreSQL's SELECT ... INTO new_table, which would otherwise
// create a new table despite starting with SELECT.
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
  'into',
];

// Scans `sql` to decide whether it is a single statement — i.e. either no
// semicolon at all, or exactly one semicolon that is the last non-whitespace
// character (an optional trailing terminator). A second top-level semicolon,
// or any non-whitespace content after the one allowed semicolon, means more
// than one statement was submitted.
//
// This exists because queryRunner.js runs the raw SQL text through
// node-postgres with no parameters, which uses the simple-query protocol —
// the one wire-protocol path that executes multiple `;`-separated statements
// in a single call. Without this check, something like
// `SELECT 1; SET search_path TO other_schema;` passes every check above (no
// blocked keyword — SET isn't one) and both statements actually run.
//
// A semicolon is only a statement separator when it appears outside a
// single-quoted string literal, a double-quoted identifier, or a comment —
// tracking "am I currently inside one of those" is exactly what a regex
// can't safely express, so this is a small hand-written scanner instead.
// Handles the SQL-standard escaping Postgres itself uses by default: `''`
// inside a string literal is an escaped quote, `""` inside a quoted
// identifier is an escaped quote, `-- ...` runs to end of line, `/* ... */`
// nests (Postgres block comments do). Deliberately does not special-case
// dollar-quoted strings ($$...$$) or backslash-escaped E'...' strings —
// neither is relevant to the read-only SELECT/WITH queries this validator
// allows through, and adding them would mean writing a real SQL tokenizer
// for a case this validator otherwise never needs to distinguish.
//
// Returns { ok: true } or { ok: false, reason: string }.
function checkSingleStatement(sql) {
  const n = sql.length;
  let i = 0;
  let separatorIndex = -1; // index of the one allowed (optionally trailing) semicolon

  while (i < n) {
    const ch = sql[i];

    // Line comment: -- through end of line.
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }

    // Block comment: /* ... */, nesting-aware.
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else { i++; }
      }
      continue;
    }

    // Single-quoted string literal — '' is an escaped quote.
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }

    // Double-quoted identifier — "" is an escaped quote.
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === ';') {
      if (separatorIndex !== -1) {
        // A second top-level semicolon, whether stacked statements
        // (`SELECT 1; SELECT 2;`) or just a doubled terminator (`SELECT 1;;`).
        return { ok: false, reason: 'Only one SQL statement is allowed.' };
      }
      separatorIndex = i;
      i++;
      continue;
    }

    i++;
  }

  if (separatorIndex !== -1 && sql.slice(separatorIndex + 1).trim() !== '') {
    return { ok: false, reason: 'Only one SQL statement is allowed.' };
  }

  return { ok: true };
}

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

  const singleStatement = checkSingleStatement(sql);
  if (!singleStatement.ok) {
    return { safe: false, reason: singleStatement.reason };
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
