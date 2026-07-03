const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/datasets
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, key, name, schema_name, description, type, is_active
      FROM datasets
      WHERE is_active = true
      ORDER BY id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
