const express = require('express');
const router = express.Router();
const pool = require('../db');
const { getSchemaNameBySessionId } = require('../utils/datasetResolver');

const isValidTableName = (name) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);

// Returns true if the table exists in the given schema.
async function tableExistsInSchema(tableName, schemaName) {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
    [schemaName, tableName]
  );
  return result.rows.length > 0;
}

// GET /api/tables?sessionId=N
router.get('/', async (req, res) => {
  try {
    const sessionId  = req.query.sessionId ? parseInt(req.query.sessionId, 10) : null;
    const schemaName = await getSchemaNameBySessionId(sessionId);

    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schemaName]
    );
    res.json(result.rows.map(r => r.table_name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tables/:tableName/columns?sessionId=N
router.get('/:tableName/columns', async (req, res) => {
  const { tableName } = req.params;
  if (!isValidTableName(tableName)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  try {
    const sessionId  = req.query.sessionId ? parseInt(req.query.sessionId, 10) : null;
    const schemaName = await getSchemaNameBySessionId(sessionId);

    if (!await tableExistsInSchema(tableName, schemaName)) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    const result = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schemaName, tableName]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tables/:tableName/preview?sessionId=N
router.get('/:tableName/preview', async (req, res) => {
  const { tableName } = req.params;
  if (!isValidTableName(tableName)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  try {
    const sessionId  = req.query.sessionId ? parseInt(req.query.sessionId, 10) : null;
    const schemaName = await getSchemaNameBySessionId(sessionId);

    if (!await tableExistsInSchema(tableName, schemaName)) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM "${schemaName}"."${tableName}"`
    );
    const rowCount = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT * FROM "${schemaName}"."${tableName}" LIMIT 50`
    );
    res.json({
      rows:    result.rows,
      columns: result.fields.map(f => f.name),
      rowCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
