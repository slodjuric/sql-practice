const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireRole } = require('../utils/authz');

const ASSIGNMENT_SELECT = `
  SELECT
    ma.id,
    ma.mentor_id,
    m.username AS mentor_username,
    m.role     AS mentor_role,
    ma.student_id,
    s.username AS student_username,
    s.role     AS student_role,
    ma.created_at
  FROM mentor_assignments ma
  JOIN users m ON m.id = ma.mentor_id
  JOIN users s ON s.id = ma.student_id
`;

// INNER JOINs naturally exclude any row whose mentor/student no longer
// exists (ON DELETE CASCADE on mentor_assignments already prevents this in
// practice, but the join makes the guarantee explicit at the query level too).
async function fetchAssignmentById(id) {
  const result = await pool.query(`${ASSIGNMENT_SELECT} WHERE ma.id = $1`, [id]);
  return result.rows[0] || null;
}

// GET /api/mentor-assignments
// Admin-only. Lists all mentor-student assignments, joined with username
// and role for both sides. Never selects password_hash.
router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `${ASSIGNMENT_SELECT} ORDER BY m.username ASC, s.username ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mentor-assignments
// Admin-only. Body: { mentorId, studentId }.
router.post('/', requireRole('admin'), async (req, res) => {
  const mentorId = parseInt(req.body.mentorId, 10);
  const studentId = parseInt(req.body.studentId, 10);

  if (!req.body.mentorId || isNaN(mentorId)) {
    return res.status(400).json({ error: 'mentorId is required.' });
  }
  if (!req.body.studentId || isNaN(studentId)) {
    return res.status(400).json({ error: 'studentId is required.' });
  }
  if (mentorId === studentId) {
    return res.status(400).json({ error: 'mentorId and studentId must not be the same user.' });
  }

  try {
    const mentorRow = await pool.query('SELECT id, role FROM users WHERE id = $1', [mentorId]);
    if (mentorRow.rows.length === 0) {
      return res.status(404).json({ error: 'Mentor not found.' });
    }
    if (mentorRow.rows[0].role !== 'mentor') {
      return res.status(400).json({ error: 'mentorId must belong to a user with role "mentor".' });
    }

    const studentRow = await pool.query('SELECT id, role FROM users WHERE id = $1', [studentId]);
    if (studentRow.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found.' });
    }
    if (studentRow.rows[0].role !== 'student') {
      return res.status(400).json({ error: 'studentId must belong to a user with role "student".' });
    }

    try {
      const inserted = await pool.query(
        'INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2) RETURNING id',
        [mentorId, studentId]
      );
      const assignment = await fetchAssignmentById(inserted.rows[0].id);
      return res.status(201).json(assignment);
    } catch (err) {
      if (err.code === '23505') {
        // Duplicate assignment — treat as an idempotent success rather than
        // an error. Re-assigning an already-assigned student/mentor pair is
        // a no-op from the admin's point of view (the desired state already
        // exists), so returning the existing row with 200 avoids forcing the
        // UI to special-case "already assigned" as a failure to handle.
        const existing = await pool.query(
          'SELECT id FROM mentor_assignments WHERE mentor_id = $1 AND student_id = $2',
          [mentorId, studentId]
        );
        const assignment = await fetchAssignmentById(existing.rows[0].id);
        return res.status(200).json(assignment);
      }
      throw err;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mentor-assignments/:id
// Admin-only. Deletes only the assignment row — never touches users.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid assignment id.' });
  }

  try {
    const result = await pool.query(
      'DELETE FROM mentor_assignments WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
