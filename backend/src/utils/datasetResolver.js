'use strict';

const pool = require('../db');

// Returns the dataset row for a given key, or null if not found.
async function getDatasetByKey(key) {
  const res = await pool.query(
    'SELECT * FROM datasets WHERE key = $1 AND is_active = true',
    [key]
  );
  return res.rows[0] || null;
}

// Returns the dataset row for the session's dataset.
// Falls back to the academic dataset when sessionId is null/undefined,
// preserving backward compatibility with routes that don't yet pass sessionId.
async function getDatasetBySessionId(sessionId) {
  if (sessionId) {
    const res = await pool.query(
      `SELECT d.*
       FROM datasets d
       JOIN learning_sessions ls ON ls.dataset_id = d.id
       WHERE ls.id = $1`,
      [sessionId]
    );
    if (res.rows[0]) return res.rows[0];
  }
  // Fallback: academic dataset (covers sessions without dataset_id and missing sessionId)
  return getDatasetByKey('academic');
}

// Convenience shortcut — returns just the schema_name string.
// Always returns at least 'academic' so callers never receive null.
async function getSchemaNameBySessionId(sessionId) {
  const dataset = await getDatasetBySessionId(sessionId);
  return dataset?.schema_name || 'academic';
}

// Returns all schema_name values for active datasets.
// Used by validateSchemaScope to know which identifiers are dataset schemas.
async function getAllDatasetSchemaNames() {
  const res = await pool.query(
    'SELECT schema_name FROM datasets WHERE is_active = true'
  );
  return res.rows.map(r => r.schema_name);
}

module.exports = {
  getDatasetByKey,
  getDatasetBySessionId,
  getSchemaNameBySessionId,
  getAllDatasetSchemaNames,
};
