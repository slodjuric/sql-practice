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
 * `session` only needs a `user_id` field (the session's owner). Async
 * because the mentor case needs canAccessStudent's mentor_assignments
 * lookup — its one caller (PATCH /api/sessions/:id/reopen) awaits it.
 *
 * Rules:
 *   - no actingUser/session => false
 *   - admin                 => true (can reopen any session)
 *   - mentor                => true only if canAccessStudent(actingUser,
 *                              session.user_id) — their own session, or an
 *                              assigned student's; never an unassigned
 *                              student's session
 *   - student                => false, always — never reopens, not even
 *                              their own session. Deliberately does NOT
 *                              delegate to canAccessStudent, since that
 *                              function's self-access check would otherwise
 *                              let a student reopen their own session.
 */
async function canReopenSession(actingUser, session) {
  if (!actingUser || !session) return false;
  if (actingUser.role === 'admin') return true;
  if (actingUser.role === 'mentor') return canAccessStudent(actingUser, session.user_id);
  return false;
}

/**
 * Account-level access check — can actingUser access targetUserId's own
 * account (e.g. profile-level data)?
 *
 * This is NOT for student progress/session ownership — use
 * canAccessStudent for that. Mentor cross-user access is intentionally NOT
 * granted here, even for assigned students: a mentor never gets to act as
 * "the account" of a student, only to view/manage their learning data via
 * canAccessStudent/canViewSession.
 *
 * Rules:
 *   - no actingUser        => false
 *   - admin                => true
 *   - same user id         => true
 *   - anyone else          => false (includes mentor on any other user)
 */
function canAccessUser(actingUser, targetUserId) {
  if (!actingUser) return false;
  if (actingUser.role === 'admin') return true;
  return actingUser.id === targetUserId;
}

/**
 * Can actingUser view/manage studentId's sessions/progress?
 *
 * Requires a DB lookup for mentor role (checks mentor_assignments), so this
 * function is async — unlike canAccessUser.
 *
 * Rules:
 *   - no actingUser  => false
 *   - admin          => true
 *   - same user id   => true (a student always "can access" themselves)
 *   - mentor         => true only if a mentor_assignments row exists for
 *                       (actingUser.id, studentId)
 *   - anyone else    => false
 */
async function canAccessStudent(actingUser, studentId) {
  if (!actingUser) return false;
  if (actingUser.role === 'admin') return true;
  if (actingUser.id === studentId) return true;
  if (actingUser.role === 'mentor') {
    const result = await pool.query(
      'SELECT 1 FROM mentor_assignments WHERE mentor_id = $1 AND student_id = $2',
      [actingUser.id, studentId]
    );
    return result.rows.length > 0;
  }
  return false;
}

/**
 * Can actingUser create a session owned by targetUserId?
 *
 * Deliberately narrower than canAccessStudent for one case: students may
 * never create a session, not even for themselves — the product rule is
 * "students select existing sessions only." Kept as a separate named
 * function (rather than an alias of canAccessStudent) precisely so this
 * kind of divergence — creation is more restrictive than viewing — doesn't
 * require touching canAccessStudent, which students still need for reading
 * their own sessions/progress (GET /api/sessions, GET /api/progress/*).
 */
async function canCreateSessionForUser(actingUser, targetUserId) {
  if (!actingUser) return false;
  if (actingUser.role === 'student') return false;
  return canAccessStudent(actingUser, targetUserId);
}

/**
 * Can actingUser view/act on this specific session row?
 * `session` needs at least a `user_id` field (the session's owner).
 */
async function canViewSession(actingUser, session) {
  if (!session) return false;
  return canAccessStudent(actingUser, session.user_id);
}

/**
 * Can actingUser archive or restore this session?
 *
 * `session` only needs a `user_id` field (the session's owner). Same
 * authorization shape as canReopenSession, deliberately kept as its own
 * named function rather than an alias — archive/restore is a distinct
 * product action from reopen, even though the rule happens to be identical:
 *
 *   - no actingUser/session => false
 *   - admin                 => true (can archive/restore any session)
 *   - mentor                => true only if canAccessStudent(actingUser,
 *                              session.user_id) — their own session, or an
 *                              assigned student's; never an unassigned
 *                              student's session
 *   - student                => false, always — never archives/restores,
 *                              not even their own session. Same blanket rule
 *                              as edit/delete: managing a session's lifecycle
 *                              is not something a student does.
 */
async function canArchiveSession(actingUser, session) {
  if (!actingUser || !session) return false;
  if (actingUser.role === 'admin') return true;
  if (actingUser.role === 'mentor') return canAccessStudent(actingUser, session.user_id);
  return false;
}

module.exports = {
  getActingUser,
  requireRole,
  canReopenSession,
  canAccessUser,
  canAccessStudent,
  canCreateSessionForUser,
  canViewSession,
  canArchiveSession,
};
