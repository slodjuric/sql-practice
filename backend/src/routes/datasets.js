const express = require('express');
const router = express.Router();
const pool = require('../db');
const { sendUnexpectedError } = require('../utils/requestLogger');

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
    sendUnexpectedError(req, res, err, { route: 'GET /api/datasets' });
  }
});

module.exports = router;
