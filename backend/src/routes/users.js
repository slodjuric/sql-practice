const express = require('express');
const router = express.Router();
const pool = require('../db');
const { VALID_ROLES, isValidRole } = require('../utils/roleValidator');
const { requireRole } = require('../utils/authz');

// GET /api/users
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, role, created_at FROM users ORDER BY created_at ASC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users
router.post('/', async (req, res) => {
  const { username, role } = req.body;
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  const trimmed = username.trim();

  let resolvedRole = 'student';
  if (role !== undefined && role !== null && role !== '') {
    if (!isValidRole(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}.` });
    }
    resolvedRole = role;
  }

  try {
    const result = await pool.query(
      'INSERT INTO users (username, role) VALUES ($1, $2) RETURNING id, username, role, created_at',
      [trimmed, resolvedRole]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id
// Admin-only. Acting user is resolved via the temporary x-acting-user-id
// header (see utils/authz.js) until real login/auth exists.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId || isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query('SELECT id, role FROM users WHERE id = $1', [userId]);
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }

    // Guard: never delete the last remaining admin — this is the only account
    // able to perform admin-only actions (including this delete), so losing
    // it would lock the platform out of admin capability entirely.
    if (check.rows[0].role === 'admin') {
      const adminCount = await client.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
      if (adminCount.rows[0].n <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot delete the last remaining admin.' });
      }
    }

    await client.query('DELETE FROM task_attempts WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_task_progress WHERE user_id = $1', [userId]);
    await client.query(
      'DELETE FROM learning_session_filters WHERE session_id IN (SELECT id FROM learning_sessions WHERE user_id = $1)',
      [userId]
    );
    await client.query('DELETE FROM learning_sessions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
