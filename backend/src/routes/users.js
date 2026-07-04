const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { VALID_ROLES, isValidRole } = require('../utils/roleValidator');
const { requireRole } = require('../utils/authz');

const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_COST = 10;

// GET /api/users
// Admin-only. Acting user is resolved from the authenticated session
// (see utils/authz.js).
router.get('/', requireRole('admin'), async (req, res) => {
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
// Admin-only — account creation is an admin action, not public registration.
// Creates a login-ready user: a password is required and hashed here so the
// account can log in immediately, without a separate set-user-password.js step.
router.post('/', requireRole('admin'), async (req, res) => {
  const { username, role, password } = req.body;
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

  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password is required.' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const result = await pool.query(
      'INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3) RETURNING id, username, role, created_at',
      [trimmed, resolvedRole, hash]
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
// Admin-only. Acting user is resolved from the authenticated session
// (see utils/authz.js).
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
