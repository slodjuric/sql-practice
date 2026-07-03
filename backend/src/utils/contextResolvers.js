const pool = require('../db');

// userId is always the authenticated actingUser.id (see utils/authz.js) —
// resolveUserId was retired once every call site switched to real sessions.
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

module.exports = { resolveSessionId };
