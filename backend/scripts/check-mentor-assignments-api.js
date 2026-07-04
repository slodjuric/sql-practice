'use strict';

/**
 * Authorization + behavior verification for the admin mentor-assignment API:
 *   GET/POST /api/mentor-assignments, DELETE /api/mentor-assignments/:id
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the mentor-assignments router, mounted the same way as in
 * src/index.js) on an ephemeral port. Authenticates via real
 * POST /api/auth/login and carries the resulting cookie.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:mentor-assignments-api
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const mentorAssignmentsRouter = require('../src/routes/mentorAssignments');

const PREFIX = '_mentorassign_api_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-mentor-assignments-api-script-only';
const TEST_PASSWORD = 'test-password-123456';

let passed = 0;
let failed = 0;

function pass(id, name) {
  console.log(`[${id}] PASS — ${name}`);
  passed++;
}

function fail(id, name, detail) {
  console.log(`[${id}] FAIL — ${name}: ${detail}`);
  failed++;
}

async function cleanup() {
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username, role, withPassword = true) {
  const hash = withPassword ? await bcrypt.hash(TEST_PASSWORD, 10) : null;
  const r = await pool.query(
    'INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [username, role, hash]
  );
  return r.rows[0].id;
}

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

async function login(base, username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  return { res, body, cookie: extractCookie(res) };
}

async function assignmentExists(id) {
  const r = await pool.query('SELECT id FROM mentor_assignments WHERE id = $1', [id]);
  return r.rows.length > 0;
}

async function run() {
  await cleanup();

  let server;
  try {
    const app = express();
    app.use(express.json());
    app.use(session({
      store: new pgSession({ pool, createTableIfMissing: true }),
      secret: TEST_SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 14 * 24 * 60 * 60 * 1000 },
    }));
    app.use('/api/auth', authRouter);
    app.use('/api/mentor-assignments', mentorAssignmentsRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const assignBase = `${base}/api/mentor-assignments`;

    // ── Setup ──────────────────────────────────────────────────────────────
    const adminUsername   = `${PREFIX}admin`;
    const studentUsername = `${PREFIX}studentactor`;
    const adminId = await createUser(adminUsername, 'admin');
    await createUser(studentUsername, 'student');

    const mentorId    = await createUser(`${PREFIX}mentor`,    'mentor', false);
    const studentId   = await createUser(`${PREFIX}student1`,  'student', false);
    const otherMentorId  = await createUser(`${PREFIX}mentor2`,  'mentor', false);
    const otherStudentId = await createUser(`${PREFIX}student2`, 'student', false);

    const { cookie: adminCookie } = await login(base, adminUsername, TEST_PASSWORD);
    const { cookie: studentCookie } = await login(base, studentUsername, TEST_PASSWORD);

    // ── Case a: admin can list assignments ────────────────────────────────────
    {
      const res = await fetch(assignBase, { headers: { Cookie: adminCookie } });
      const body = await res.json();
      if (res.status === 200 && Array.isArray(body)) {
        pass('a', `Admin can list assignments (200, ${body.length} row(s))`);
      } else {
        fail('a', 'Admin must be able to list assignments', `status=${res.status}`);
      }
    }

    // ── Case b: non-admin cannot list assignments ─────────────────────────────
    {
      const res = await fetch(assignBase, { headers: { Cookie: studentCookie } });
      const unauthedRes = await fetch(assignBase);
      if (res.status === 403 && unauthedRes.status === 401) {
        pass('b', 'Non-admin gets 403, unauthenticated gets 401 for GET');
      } else {
        fail('b', 'Non-admin/unauthenticated must be blocked', `studentStatus=${res.status}, unauthStatus=${unauthedRes.status}`);
      }
    }

    // ── Case c: admin can create assignment mentor -> student ────────────────
    let createdAssignmentId;
    {
      const res = await fetch(assignBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ mentorId, studentId }),
      });
      const body = await res.json();
      createdAssignmentId = body.id;
      const fieldsOk = body.mentor_id === mentorId && body.student_id === studentId &&
        body.mentor_username === `${PREFIX}mentor` && body.mentor_role === 'mentor' &&
        body.student_username === `${PREFIX}student1` && body.student_role === 'student' &&
        !!body.created_at;
      if (res.status === 201 && fieldsOk) {
        pass('c', 'Admin can create a mentor->student assignment with full joined fields (201)');
      } else {
        fail('c', 'Admin must be able to create an assignment with joined fields', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case d: cannot create assignment if mentorId is not a mentor ─────────
    {
      const res = await fetch(assignBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ mentorId: studentId, studentId: otherStudentId }),
      });
      if (res.status === 400) {
        pass('d', 'Non-mentor mentorId is rejected (400)');
      } else {
        fail('d', 'Non-mentor mentorId must be rejected', `status=${res.status}`);
      }
    }

    // ── Case e: cannot create assignment if studentId is not a student ───────
    {
      const res = await fetch(assignBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ mentorId, studentId: otherMentorId }),
      });
      if (res.status === 400) {
        pass('e', 'Non-student studentId is rejected (400)');
      } else {
        fail('e', 'Non-student studentId must be rejected', `status=${res.status}`);
      }
    }

    // ── Case f: cannot create assignment with missing/nonexistent users ─────
    {
      const res = await fetch(assignBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ mentorId: 999999999, studentId }),
      });
      const res2 = await fetch(assignBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ mentorId }),
      });
      if (res.status === 404 && res2.status === 400) {
        pass('f', 'Nonexistent mentorId returns 404; missing studentId returns 400');
      } else {
        fail('f', 'Missing/nonexistent users must be rejected cleanly', `status1=${res.status}, status2=${res2.status}`);
      }
    }

    // ── Case g: duplicate assignment is handled cleanly ───────────────────────
    {
      const res = await fetch(assignBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ mentorId, studentId }),
      });
      const body = await res.json();
      if (res.status === 200 && body.id === createdAssignmentId) {
        pass('g', 'Duplicate assignment returns the existing row (200, same id) instead of erroring');
      } else {
        fail('g', 'Duplicate assignment must be handled cleanly', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case h: admin can delete assignment ───────────────────────────────────
    {
      const res = await fetch(`${assignBase}/${createdAssignmentId}`, {
        method: 'DELETE',
        headers: { Cookie: adminCookie },
      });
      const body = await res.json();
      const gone = !(await assignmentExists(createdAssignmentId));
      if (res.status === 200 && body.success === true && gone) {
        pass('h', 'Admin can delete an assignment (200, row removed)');
      } else {
        fail('h', 'Admin must be able to delete an assignment', `status=${res.status}, gone=${gone}`);
      }
    }

    // ── Case i: deleting assignment does not delete users ─────────────────────
    {
      const mentorRow = await pool.query('SELECT id FROM users WHERE id = $1', [mentorId]);
      const studentRow = await pool.query('SELECT id FROM users WHERE id = $1', [studentId]);
      if (mentorRow.rows.length === 1 && studentRow.rows.length === 1) {
        pass('i', 'Deleting the assignment left both the mentor and student user rows intact');
      } else {
        fail('i', 'Deleting an assignment must not delete users', `mentorExists=${mentorRow.rows.length === 1}, studentExists=${studentRow.rows.length === 1}`);
      }
    }

    // ── Case j: deleting a nonexistent assignment returns 404 ─────────────────
    {
      const res = await fetch(`${assignBase}/999999999`, { method: 'DELETE', headers: { Cookie: adminCookie } });
      if (res.status === 404) {
        pass('j', 'Deleting a nonexistent assignment returns 404');
      } else {
        fail('j', 'Nonexistent assignment delete must return 404', `status=${res.status}`);
      }
    }

    // ── Case k: non-admin cannot create/delete assignments ────────────────────
    {
      const secondAssignment = await pool.query(
        'INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2) RETURNING id',
        [otherMentorId, otherStudentId]
      );
      const createRes = await fetch(assignBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
        body: JSON.stringify({ mentorId: otherMentorId, studentId }),
      });
      const deleteRes = await fetch(`${assignBase}/${secondAssignment.rows[0].id}`, {
        method: 'DELETE',
        headers: { Cookie: studentCookie },
      });
      const stillExists = await assignmentExists(secondAssignment.rows[0].id);
      if (createRes.status === 403 && deleteRes.status === 403 && stillExists) {
        pass('k', 'Non-admin cannot create or delete assignments (403, row untouched)');
      } else {
        fail('k', 'Non-admin must be blocked from create/delete', `createStatus=${createRes.status}, deleteStatus=${deleteRes.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case l: password_hash is never exposed ────────────────────────────────
    {
      const res = await fetch(assignBase, { headers: { Cookie: adminCookie } });
      const body = await res.json();
      const leaked = body.some(row => 'password_hash' in row || 'mentor_password_hash' in row || 'student_password_hash' in row);
      if (res.status === 200 && !leaked) {
        pass('l', 'password_hash is never present in the assignments list response');
      } else {
        fail('l', 'password_hash must never be returned', `leaked=${leaked}`);
      }
    }

  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message);
    failed++;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await cleanup();
    await pool.end();
  }

  console.log('');
  console.log(`Result: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
