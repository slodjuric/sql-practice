const express = require('express');
const router = express.Router();
const pool = require('../db');

const isValidTableName = (name) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);

const PRACTICE_TABLES = new Set([
  'departments',
  'exams',
  'faculties',
  'professor_subjects',
  'professors',
  'students',
  'subjects',
]);

// Placeholder for future role-based access: return Set of visible tables for a given user.
// Currently everyone gets only the practice tables.
function getVisibleTables(/* user */) {
  return PRACTICE_TABLES;
}

// GET /api/tables
router.get('/', async (req, res) => {
  try {
    const visible = getVisibleTables();
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const tables = result.rows
      .map(r => r.table_name)
      .filter(name => visible.has(name));
    res.json(tables);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tables/:tableName/columns
router.get('/:tableName/columns', async (req, res) => {
  const { tableName } = req.params;
  if (!isValidTableName(tableName)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  if (!getVisibleTables().has(tableName)) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  try {
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `, [tableName]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tables/:tableName/preview
router.get('/:tableName/preview', async (req, res) => {
  const { tableName } = req.params;
  if (!isValidTableName(tableName)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  if (!getVisibleTables().has(tableName)) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  try {
    const countResult = await pool.query(`SELECT COUNT(*) FROM "${tableName}"`);
    const rowCount = parseInt(countResult.rows[0].count);

    const result = await pool.query(`SELECT * FROM "${tableName}" LIMIT 50`);
    res.json({
      rows: result.rows,
      columns: result.fields.map(f => f.name),
      rowCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
