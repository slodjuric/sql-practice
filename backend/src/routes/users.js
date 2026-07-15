const express = require('express');
const router = express.Router();
const pool = require('../db');
const { VALID_ROLES, isValidRole } = require('../utils/roleValidator');
const { requireRole } = require('../utils/authz');
const { MIN_PASSWORD_LENGTH, validatePasswordLength, hashPassword } = require('../utils/passwordPolicy');
const { sendUnexpectedError, safeRollback } = require('../utils/requestLogger');

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
    sendUnexpectedError(req, res, err, { route: 'GET /api/users' });
  }
});

// GET /api/users/admin-summary
// Admin-only. Aggregated counts for a simple dashboard overview — total
// users, per-role breakdown, session lifecycle counts, and assignment
// count. No raw per-user/per-session rows, only totals, so this stays cheap
// and doesn't leak anything GET /api/users or /api/sessions wouldn't already
// allow an admin to compute themselves.
// Session counts are mutually exclusive and sum to the total session count:
// active/completed both exclude archived sessions (archived is a separate,
// orthogonal lifecycle flag — see CLAUDE.md's sessions/plans model), and
// archived counts regardless of its underlying status.
// Registered before the /:id routes below only for readability — there is
// no GET /:id route on this router, so there's no actual path collision risk.
router.get('/admin-summary', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS total_users,
        (SELECT COUNT(*)::int FROM users WHERE role = 'admin') AS admins,
        (SELECT COUNT(*)::int FROM users WHERE role = 'mentor') AS mentors,
        (SELECT COUNT(*)::int FROM users WHERE role = 'student') AS students,
        (SELECT COUNT(*)::int FROM learning_sessions WHERE status = 'active' AND archived_at IS NULL) AS active_sessions,
        (SELECT COUNT(*)::int FROM learning_sessions WHERE status = 'completed' AND archived_at IS NULL) AS completed_sessions,
        (SELECT COUNT(*)::int FROM learning_sessions WHERE archived_at IS NOT NULL) AS archived_sessions,
        (SELECT COUNT(*)::int FROM mentor_assignments) AS mentor_assignments
    `);
    res.json(result.rows[0]);
  } catch (err) {
    sendUnexpectedError(req, res, err, { route: 'GET /api/users/admin-summary' });
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
  if (!validatePasswordLength(password)) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  try {
    const hash = await hashPassword(password);
    const result = await pool.query(
      'INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3) RETURNING id, username, role, created_at',
      [trimmed, resolvedRole, hash]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    sendUnexpectedError(req, res, err, { route: 'POST /api/users' });
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
    await safeRollback(client, req, { route: 'DELETE /api/users/:id', targetUserId: userId });
    sendUnexpectedError(req, res, err, { route: 'DELETE /api/users/:id', targetUserId: userId });
  } finally {
    client.release();
  }
});

// PATCH /api/users/:id/password
// Admin-only. Resets any user's password, including the admin's own —
// unlike delete, this isn't destructive (it doesn't remove data or lock the
// platform out of admin capability), so it deliberately does not exclude the
// acting admin's own row the way DELETE /:id does.
// Works identically for a legacy user with a NULL password_hash (no existing
// hash to compare against, no special-casing needed) — same unconditional
// UPDATE pattern as scripts/set-user-password.js.
//
// Invalidates every active session belonging to the TARGET user as part of
// the same transaction as the password update — a stale, already-logged-in
// browser must not keep working under the old password once it's been
// reset. Sessions are express-session rows stored by connect-pg-simple in
// the "session" table (see src/index.js), whose `sess` JSON column carries
// the `userId` set at login (routes/auth.js's `req.session.userId = user.id`).
// There's no per-user index on that JSON field — acceptable at this scale;
// revisit if the session table grows large enough for this DELETE to matter
// for latency.
// If the admin is resetting their OWN password, this also deletes their own
// current session row — intentional (see CLAUDE.md): a self-reset should
// force the admin to log in again too, not just every other target.
// Wrapped in a single transaction: if the session cleanup fails for any
// reason, the password change is rolled back too, so a reset can never
// "succeed" while leaving the old session usable.
router.patch('/:id/password', requireRole('admin'), async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId || isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  const { newPassword } = req.body;
  if (!newPassword || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'New password is required.' });
  }
  if (!validatePasswordLength(newPassword)) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }

    const hash = await hashPassword(newPassword);
    const result = await client.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, username, role',
      [hash, userId]
    );

    await client.query(
      `DELETE FROM "session" WHERE (sess->>'userId')::int = $1`,
      [userId]
    );

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await safeRollback(client, req, { route: 'PATCH /api/users/:id/password', targetUserId: userId });
    sendUnexpectedError(req, res, err, { route: 'PATCH /api/users/:id/password', targetUserId: userId });
  } finally {
    client.release();
  }
});

// PATCH /api/users/:id/role
// Admin-only. Changes an existing user's role in place, so a role correction
// no longer requires deleting and recreating the account.
//
// Role is never cached in the session payload — getActingUser() and
// GET /api/auth/me both re-read `role` fresh from the DB on every request
// (see utils/authz.js) — so a role change takes effect immediately on the
// target's very next request. Unlike password reset, this needs no session
// invalidation of its own.
//
// Guards, in order: new role must be valid; target must exist; demoting the
// last remaining admin away from 'admin' is blocked, same rule/wording as
// DELETE /:id's last-admin guard (self-demotion included — an admin who is
// the last one cannot demote themselves either, for the same reason they
// can't delete themselves as the last admin).
//
// On an actual change away from mentor/student, stale mentor_assignments
// rows are cleaned up in the same transaction so assignment data never
// points at a user who no longer holds the matching role:
//   - leaving 'mentor'  -> delete rows where this user was the mentor_id
//   - leaving 'student' -> delete rows where this user was the student_id
// No cleanup is needed when a user newly ENTERS mentor/student (e.g. from
// admin) — POST /api/mentor-assignments only ever creates a row for a user
// already holding the matching role, so no stale row can exist for a role
// the user is only now acquiring.
router.patch('/:id/role', requireRole('admin'), async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId || isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  const { role } = req.body;
  if (!role || !isValidRole(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query('SELECT id, role FROM users WHERE id = $1', [userId]);
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }
    const currentRole = check.rows[0].role;

    if (currentRole === 'admin' && role !== 'admin') {
      const adminCount = await client.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
      if (adminCount.rows[0].n <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot change the role of the last remaining admin.' });
      }
    }

    const result = await client.query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, role',
      [role, userId]
    );

    let removedAssignments = 0;
    if (currentRole === 'mentor' && role !== 'mentor') {
      const r = await client.query('DELETE FROM mentor_assignments WHERE mentor_id = $1', [userId]);
      removedAssignments += r.rowCount;
    }
    if (currentRole === 'student' && role !== 'student') {
      const r = await client.query('DELETE FROM mentor_assignments WHERE student_id = $1', [userId]);
      removedAssignments += r.rowCount;
    }

    await client.query('COMMIT');
    res.json({ ...result.rows[0], removedAssignments });
  } catch (err) {
    await safeRollback(client, req, { route: 'PATCH /api/users/:id/role', targetUserId: userId });
    sendUnexpectedError(req, res, err, { route: 'PATCH /api/users/:id/role', targetUserId: userId });
  } finally {
    client.release();
  }
});

module.exports = router;
