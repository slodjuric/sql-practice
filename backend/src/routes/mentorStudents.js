const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireRole, getActingUser, canAccessStudent } = require('../utils/authz');

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

// GET /api/mentor/students/summary
// Mentor-only, same scope as GET /students above (not admin — an admin's
// own "assigned roster" isn't a meaningful concept; admin already has
// GET /api/mentor-assignments for oversight). Aggregated per-assigned-student
// counts for the My Students overview cards — one query for the whole
// roster instead of the N-per-student round trips the older
// utils/studentRoster.js fetchStudentStats() helper made (2 requests x N
// students). MentorOverviewView (admin reviewing a mentor) is intentionally
// left on the older per-student helper — this endpoint is scoped to the
// mentor's own roster only and isn't reused there.
// last_activity is MAX(last_attempt_at) across ALL of a student's sessions
// (Run Query and Check Answer both touch it — see attemptRecorder.js) —
// more accurate than the old helper, which only looked at one arbitrarily
// resolved session's Check-Answer-only attempts.
router.get('/students/summary', requireRole('mentor'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.id, s.username, s.role, ma.created_at AS assigned_at,
        COALESCE(sess.active_count, 0)    AS active_sessions,
        COALESCE(sess.completed_count, 0) AS completed_sessions,
        COALESCE(sess.archived_count, 0)  AS archived_sessions,
        COALESCE(prog.solved_count, 0)    AS solved_count,
        prog.last_activity
      FROM mentor_assignments ma
      JOIN users s ON s.id = ma.student_id
      LEFT JOIN (
        SELECT user_id,
          COUNT(*) FILTER (WHERE status = 'active'    AND archived_at IS NULL)::int AS active_count,
          COUNT(*) FILTER (WHERE status = 'completed' AND archived_at IS NULL)::int AS completed_count,
          COUNT(*) FILTER (WHERE archived_at IS NOT NULL)::int                      AS archived_count
        FROM learning_sessions
        GROUP BY user_id
      ) sess ON sess.user_id = s.id
      LEFT JOIN (
        SELECT user_id,
          COUNT(*) FILTER (WHERE status = 'solved')::int AS solved_count,
          MAX(last_attempt_at)                            AS last_activity
        FROM user_task_progress
        GROUP BY user_id
      ) prog ON prog.user_id = s.id
      WHERE ma.mentor_id = $1
      ORDER BY s.username ASC
    `, [req.actingUser.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mentor/students/:studentId/sessions
// Mentor (only if assigned, via canAccessStudent) or admin (always) — the
// :studentId path param is never trusted on its own, same re-authorization
// pattern as every other targetUserId-accepting route in this app. Students
// are explicitly blocked even for their own id — this route is mounted
// under /api/mentor and returns a shape meant for mentor/admin oversight,
// not the student-facing GET /api/sessions.
//
// Returns the student's FULL session history, including archived sessions
// (unlike GET /api/sessions' default, which hides them) — the point of this
// endpoint is a complete history view, not "what should I resume." Each
// session carries a lightweight solved/attempted count (COUNT of
// user_task_progress rows for that session_id) rather than a full
// plan-scoped fraction — computing the true "solved out of planned total"
// per session would require re-deriving each session's dataset+filter scope
// (see routes/progress.js's applyPlanFilter), which is unnecessary detail
// for a history list whose job is "which session, roughly how much done."
router.get('/students/:studentId/sessions', async (req, res) => {
  const studentId = parseInt(req.params.studentId, 10);
  if (!studentId || isNaN(studentId)) {
    return res.status(400).json({ error: 'Invalid student id.' });
  }

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  if (actingUser.role === 'student') {
    return res.status(403).json({ error: 'You do not have permission to view this data.' });
  }

  const allowed = await canAccessStudent(actingUser, studentId);
  if (!allowed) {
    return res.status(403).json({ error: 'You do not have permission to view this student\'s sessions.' });
  }

  try {
    const result = await pool.query(`
      SELECT ls.*,
             d.key AS dataset_key, d.name AS dataset_name, d.schema_name, d.type AS dataset_type,
             c.username AS created_by_username,
             a.username AS archived_by_username,
             COALESCE(p.solved_count, 0)    AS solved_count,
             COALESCE(p.attempted_count, 0) AS attempted_count
      FROM learning_sessions ls
      LEFT JOIN datasets d ON d.id = ls.dataset_id
      LEFT JOIN users c ON c.id = ls.created_by_user_id
      LEFT JOIN users a ON a.id = ls.archived_by_user_id
      LEFT JOIN (
        SELECT session_id,
          COUNT(*) FILTER (WHERE status = 'solved')::int AS solved_count,
          COUNT(*)::int                                  AS attempted_count
        FROM user_task_progress
        WHERE user_id = $1
        GROUP BY session_id
      ) p ON p.session_id = ls.id
      WHERE ls.user_id = $1
      ORDER BY ls.created_at DESC
    `, [studentId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
