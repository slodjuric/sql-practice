const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireRole } = require('../utils/authz');

// GET /api/mentor/students
// Mentor-only (not admin — admin already manages assignments via
// /api/mentor-assignments in User Management). Lists the students assigned
// to the logged-in mentor. Never selects password_hash.
router.get('/students', requireRole('mentor'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.username, s.role, ma.created_at AS assigned_at
       FROM mentor_assignments ma
       JOIN users s ON s.id = ma.student_id
       WHERE ma.mentor_id = $1
       ORDER BY s.username ASC`,
      [req.actingUser.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
