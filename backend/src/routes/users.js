const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/users
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, created_at FROM users ORDER BY created_at ASC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users
router.post('/', async (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  const trimmed = username.trim();
  try {
    const result = await pool.query(
      'INSERT INTO users (username) VALUES ($1) RETURNING id, username, created_at',
      [trimmed]
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
router.delete('/:id', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId || isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
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
