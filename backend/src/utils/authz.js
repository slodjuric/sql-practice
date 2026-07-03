'use strict';

const pool = require('../db');

/**
 * Resolves the acting user from the authenticated session (real login —
 * see routes/auth.js). Previously read a temporary x-acting-user-id header;
 * that mechanism has been fully removed, no fallback.
 *
 * Returns { id, username, role } on success, or null if there is no
 * session, no session.userId, or it doesn't match an existing user.
 */
async function getActingUser(req) {
  const userId = req.session?.userId;
  if (!userId) return null;

  const result = await pool.query(
    'SELECT id, username, role FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Express middleware factory — resolves the acting user and enforces that
 * their role is one of `allowedRoles`.
 *
 *   401 — no acting user could be resolved (missing/invalid/nonexistent)
 *   403 — acting user resolved, but role not in allowedRoles
 *
 * On success, attaches the resolved user to req.actingUser for the route
 * handler to use.
 */
function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    const actingUser = await getActingUser(req);
    if (!actingUser) {
      return res.status(401).json({ error: 'Acting user is required.' });
    }
    if (!allowedRoles.includes(actingUser.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    req.actingUser = actingUser;
    next();
  };
}

/**
 * Determines whether actingUser is allowed to reopen a completed session.
 *
 * `session` only needs a `user_id` field (the session's owner).
 *
 * Rule for now:
 *   - admin:   can reopen any session.
 *   - mentor:  can reopen any session — INTENTIONALLY BROAD AND TEMPORARY.
 *              There is no mentor_assignments table yet, so a mentor cannot
 *              currently be scoped to "their" students. Once that table
 *              exists, this must be narrowed to only sessions owned by
 *              students assigned to this mentor.
 *   - student: can never reopen a completed session, not even their own.
 */
function canReopenSession(actingUser, session) {
  if (!actingUser || !session) return false;
  if (actingUser.role === 'admin')  return true;
  if (actingUser.role === 'mentor') return true; // TEMPORARY — see comment above
  return false;
}

module.exports = { getActingUser, requireRole, canReopenSession };
