const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');

// Same generic message whether the username doesn't exist, has no password
// set yet, or the password is simply wrong — avoids leaking which accounts
// exist or are not yet migrated to a password.
const GENERIC_LOGIN_ERROR = 'Invalid username or password.';

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const result = await pool.query(
      'SELECT id, username, role, password_hash FROM users WHERE username = $1',
      [username.trim()]
    );
    const user = result.rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    }

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    }

    // Regenerate the session on login to prevent session fixation.
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Login failed. Please try again.' });
      req.session.userId = user.id;
      res.json({ id: user.id, username: user.username, role: user.role });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed. Please try again.' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  try {
    const result = await pool.query(
      'SELECT id, username, role FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = result.rows[0];

    if (!user) {
      // Session points at a user that no longer exists — clear it.
      return req.session.destroy(() => {
        res.status(401).json({ error: 'Not authenticated.' });
      });
    }

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
