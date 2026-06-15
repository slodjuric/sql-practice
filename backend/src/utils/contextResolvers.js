const pool = require('../db');

async function resolveUserId(provided) {
  if (provided !== undefined && provided !== null && provided !== '') {
    const id = parseInt(provided, 10);
    if (!isNaN(id)) return id;
  }
  const res = await pool.query("SELECT id FROM users WHERE username = 'default' LIMIT 1");
  return res.rows[0]?.id ?? null;
}

async function resolveSessionId(userId, provided) {
  if (provided !== undefined && provided !== null && provided !== '') {
    const id = parseInt(provided, 10);
    if (!isNaN(id)) {
      if (!userId) return null;
      // Verify the session actually belongs to this user before accepting it.
      const ownerCheck = await pool.query(
        'SELECT id FROM learning_sessions WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      return ownerCheck.rows.length > 0 ? id : null;
    }
  }
  if (!userId) return null;
  const res = await pool.query(
    'SELECT id FROM learning_sessions WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1',
    [userId]
  );
  return res.rows[0]?.id ?? null;
}

module.exports = { resolveUserId, resolveSessionId };
