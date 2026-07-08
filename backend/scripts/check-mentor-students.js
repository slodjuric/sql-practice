'use strict';

/**
 * Authorization + behavior verification for the mentor-facing endpoints:
 *   GET /api/mentor/students
 *   GET /api/mentor/students/summary
 *   GET /api/mentor/students/:studentId/sessions
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the mentor-students router, mounted the same way as in
 * src/index.js) on an ephemeral port. Authenticates via real
 * POST /api/auth/login and carries the resulting cookie.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:mentor-students
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const mentorStudentsRouter = require('../src/routes/mentorStudents');

const PREFIX = '_mentorstudents_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-mentor-students-script-only';
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
  // task_attempts.user_id and user_task_progress.user_id have no ON DELETE
  // action of their own (unlike their session_id FKs, which cascade from
  // learning_sessions) — a leftover row from the summary/sessions fixture
  // below (which seeds a real user_task_progress row) would otherwise make
  // the final DELETE FROM users fail with an FK violation. Same pattern as
  // check-authz.js's cleanup().
  await pool.query(`
    DELETE FROM task_attempts WHERE session_id IN (
      SELECT id FROM learning_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)
    )`, [`${PREFIX}%`]);
  await pool.query(`
    DELETE FROM user_task_progress WHERE session_id IN (
      SELECT id FROM learning_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)
    )`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM learning_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)`, [`${PREFIX}%`]);
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username, role) {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
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
    app.use('/api/mentor', mentorStudentsRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const studentsUrl = `${base}/api/mentor/students`;

    // ── Setup ──────────────────────────────────────────────────────────────
    const mentorAUsername  = `${PREFIX}mentorA`;
    const mentorBUsername  = `${PREFIX}mentorB`;
    const emptyMentorUsername = `${PREFIX}mentorEmpty`;
    const studentUsername  = `${PREFIX}studentactor`;
    const adminUsername    = `${PREFIX}admin`;

    const mentorAId = await createUser(mentorAUsername, 'mentor');
    const mentorBId = await createUser(mentorBUsername, 'mentor');
    await createUser(emptyMentorUsername, 'mentor');
    await createUser(studentUsername, 'student');
    await createUser(adminUsername, 'admin');

    // Two students assigned to mentor A, one assigned to mentor B only
    const studentAlice = await createUser(`${PREFIX}alice`, 'student');
    const studentZoe   = await createUser(`${PREFIX}zoe`,   'student');
    const studentBobBOnly = await createUser(`${PREFIX}bob`, 'student');

    await pool.query(
      'INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2), ($1, $3)',
      [mentorAId, studentAlice, studentZoe]
    );
    await pool.query(
      'INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2)',
      [mentorBId, studentBobBOnly]
    );

    const { cookie: mentorACookie } = await login(base, mentorAUsername, TEST_PASSWORD);
    const { cookie: mentorBCookie } = await login(base, mentorBUsername, TEST_PASSWORD);
    const { cookie: emptyMentorCookie } = await login(base, emptyMentorUsername, TEST_PASSWORD);
    const { cookie: studentCookie } = await login(base, studentUsername, TEST_PASSWORD);
    const { cookie: adminCookie } = await login(base, adminUsername, TEST_PASSWORD);

    // ── Case a: mentor can list only their assigned students, ordered by username ──
    {
      const res = await fetch(studentsUrl, { headers: { Cookie: mentorACookie } });
      const body = await res.json();
      const usernames = body.map(s => s.username);
      const expectedOrder = [`${PREFIX}alice`, `${PREFIX}zoe`].sort();
      const orderOk = JSON.stringify(usernames) === JSON.stringify(expectedOrder);
      if (res.status === 200 && orderOk) {
        pass('a', `Mentor A sees exactly their 2 assigned students, ordered by username (${usernames.join(', ')})`);
      } else {
        fail('a', 'Mentor must see only their own assigned students, ordered by username', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case b: mentor cannot see students assigned to another mentor ─────────
    {
      const res = await fetch(studentsUrl, { headers: { Cookie: mentorACookie } });
      const body = await res.json();
      const includesOtherMentorsStudent = body.some(s => s.username === `${PREFIX}bob`);
      if (res.status === 200 && !includesOtherMentorsStudent) {
        pass('b', "Mentor A's list does not include mentor B's student");
      } else {
        fail('b', 'Mentor must not see another mentor\'s assigned students', `body=${JSON.stringify(body)}`);
      }
    }

    // ── Case c: mentor with no assigned students gets an empty list ───────────
    {
      const res = await fetch(studentsUrl, { headers: { Cookie: emptyMentorCookie } });
      const body = await res.json();
      if (res.status === 200 && Array.isArray(body) && body.length === 0) {
        pass('c', 'Mentor with no assigned students gets an empty array (200)');
      } else {
        fail('c', 'Mentor with no assignments must get an empty list', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case d: student cannot access the endpoint ─────────────────────────────
    {
      const res = await fetch(studentsUrl, { headers: { Cookie: studentCookie } });
      if (res.status === 403) {
        pass('d', 'Student is blocked from GET /api/mentor/students (403)');
      } else {
        fail('d', 'Student must be blocked', `status=${res.status}`);
      }
    }

    // ── Case e: admin does not get special access either (mentor-only route) ──
    {
      const res = await fetch(studentsUrl, { headers: { Cookie: adminCookie } });
      if (res.status === 403) {
        pass('e', 'Admin is blocked from GET /api/mentor/students (403) — admin uses User Management instead');
      } else {
        fail('e', 'Admin must be blocked from this mentor-only route', `status=${res.status}`);
      }
    }

    // ── Case f: unauthenticated request is rejected ────────────────────────────
    {
      const res = await fetch(studentsUrl);
      if (res.status === 401) {
        pass('f', 'Unauthenticated request returns 401');
      } else {
        fail('f', 'Unauthenticated request must be rejected', `status=${res.status}`);
      }
    }

    // ── Case g: password_hash is never exposed ─────────────────────────────────
    {
      const res = await fetch(studentsUrl, { headers: { Cookie: mentorACookie } });
      const body = await res.json();
      const leaked = body.some(row => 'password_hash' in row);
      if (res.status === 200 && !leaked) {
        pass('g', 'password_hash is never present in the students list response');
      } else {
        fail('g', 'password_hash must never be returned', `leaked=${leaked}`);
      }
    }

    // ── Case h: returned fields match expected shape ───────────────────────────
    {
      const res = await fetch(studentsUrl, { headers: { Cookie: mentorACookie } });
      const body = await res.json();
      const row = body[0];
      const shapeOk = row && typeof row.id === 'number' && typeof row.username === 'string' &&
        row.role === 'student' && !!row.assigned_at;
      if (shapeOk) {
        pass('h', `Row shape includes id/username/role/assigned_at (${JSON.stringify(row)})`);
      } else {
        fail('h', 'Row must include id, username, role, assigned_at', `row=${JSON.stringify(row)}`);
      }
    }

    // ── GET /api/mentor/students/summary ────────────────────────────────────
    const summaryUrl = `${base}/api/mentor/students/summary`;

    // Seed alice with 3 real sessions (active/completed/archived) and one
    // solved task, so the aggregated counts below have something real to
    // check instead of all zeros. Inserted directly for setup speed, same
    // pattern check-authz.js's case g uses for its owned-session fixture.
    const dataset = await pool.query("SELECT id FROM datasets WHERE key = 'academic'");
    const datasetId = dataset.rows[0].id;

    const activeSessionRow = await pool.query(
      `INSERT INTO learning_sessions (user_id, created_by_user_id, name, dataset_id)
       VALUES ($1, $1, $2, $3) RETURNING id`,
      [studentAlice, `${PREFIX}alice_active`, datasetId]
    );
    const completedSessionRow = await pool.query(
      `INSERT INTO learning_sessions (user_id, created_by_user_id, name, dataset_id, status, completed_at)
       VALUES ($1, $1, $2, $3, 'completed', NOW()) RETURNING id`,
      [studentAlice, `${PREFIX}alice_completed`, datasetId]
    );
    const archivedSessionRow = await pool.query(
      `INSERT INTO learning_sessions (user_id, created_by_user_id, name, dataset_id, archived_at, archived_by_user_id)
       VALUES ($1, $1, $2, $3, NOW(), $4) RETURNING id`,
      [studentAlice, `${PREFIX}alice_archived`, datasetId, mentorAId]
    );
    const activeSessionId    = activeSessionRow.rows[0].id;
    const completedSessionId = completedSessionRow.rows[0].id;
    const archivedSessionId  = archivedSessionRow.rows[0].id;

    await pool.query(
      `INSERT INTO user_task_progress (user_id, session_id, task_id, status, attempts_count, last_attempt_at)
       VALUES ($1, $2, 1, 'solved', 1, NOW())`,
      [studentAlice, activeSessionId]
    );

    // ── Case i: mentor summary returns exactly their assigned students with
    // the expected aggregate shape ─────────────────────────────────────────
    {
      const res = await fetch(summaryUrl, { headers: { Cookie: mentorACookie } });
      const body = await res.json();
      const usernames = body.map(s => s.username).sort();
      const expectedUsernames = [`${PREFIX}alice`, `${PREFIX}zoe`].sort();
      const alice = body.find(s => s.username === `${PREFIX}alice`);
      const shapeOk = alice &&
        alice.active_sessions === 1 &&
        alice.completed_sessions === 1 &&
        alice.archived_sessions === 1 &&
        alice.solved_count === 1 &&
        !!alice.last_activity;
      if (res.status === 200 && JSON.stringify(usernames) === JSON.stringify(expectedUsernames) && shapeOk) {
        pass('i', `Mentor summary returns assigned students with correct aggregate counts (alice: ${JSON.stringify(alice)})`);
      } else {
        fail('i', 'Mentor summary must return assigned students with correct counts', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case j: mentor summary does not include another mentor's student ───
    {
      const res = await fetch(summaryUrl, { headers: { Cookie: mentorACookie } });
      const body = await res.json();
      const includesBob = body.some(s => s.username === `${PREFIX}bob`);
      if (res.status === 200 && !includesBob) {
        pass('j', "Mentor summary does not include mentor B's student");
      } else {
        fail('j', 'Mentor summary must not include another mentor\'s student', `body=${JSON.stringify(body)}`);
      }
    }

    // ── Case k: student blocked from /students/summary ──────────────────────
    {
      const res = await fetch(summaryUrl, { headers: { Cookie: studentCookie } });
      if (res.status === 403) {
        pass('k', 'Student is blocked from GET /api/mentor/students/summary (403)');
      } else {
        fail('k', 'Student must be blocked from the summary endpoint', `status=${res.status}`);
      }
    }

    // ── Case l: admin blocked from /students/summary (mentor-only, same as
    // /students) ─────────────────────────────────────────────────────────────
    {
      const res = await fetch(summaryUrl, { headers: { Cookie: adminCookie } });
      if (res.status === 403) {
        pass('l', 'Admin is blocked from GET /api/mentor/students/summary (403) — own roster is not a meaningful concept for admin');
      } else {
        fail('l', 'Admin must be blocked from the summary endpoint', `status=${res.status}`);
      }
    }

    // ── Case m: unauthenticated blocked from /students/summary ──────────────
    {
      const res = await fetch(summaryUrl);
      if (res.status === 401) {
        pass('m', 'Unauthenticated request to /students/summary returns 401');
      } else {
        fail('m', 'Unauthenticated request must return 401', `status=${res.status}`);
      }
    }

    // ── GET /api/mentor/students/:studentId/sessions ────────────────────────

    // ── Case n: assigned mentor can view their student's session history,
    // including the archived session (unlike GET /api/sessions' default) ────
    {
      const res = await fetch(`${base}/api/mentor/students/${studentAlice}/sessions`, { headers: { Cookie: mentorACookie } });
      const body = await res.json();
      const sessionIds = body.map(s => s.id);
      const hasAllThree = [activeSessionId, completedSessionId, archivedSessionId].every(id => sessionIds.includes(id));
      const archivedRow = body.find(s => s.id === archivedSessionId);
      const activeRow   = body.find(s => s.id === activeSessionId);
      if (res.status === 200 && hasAllThree && archivedRow?.archived_at && activeRow?.solved_count === 1) {
        pass('n', "Assigned mentor sees the student's full session history, including the archived session and solved_count");
      } else {
        fail('n', 'Assigned mentor must see full session history with archived sessions included', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case o: mentor A cannot view an UNASSIGNED student's sessions (bob
    // belongs only to mentor B) — the core assigned-vs-unassigned check ─────
    {
      const res = await fetch(`${base}/api/mentor/students/${studentBobBOnly}/sessions`, { headers: { Cookie: mentorACookie } });
      if (res.status === 403) {
        pass('o', "Mentor A is blocked from an unassigned student's (bob's) sessions (403)");
      } else {
        fail('o', 'Mentor must be blocked from an unassigned student\'s sessions', `status=${res.status}`);
      }
    }

    // ── Case p: student is blocked even for their OWN id — this route is
    // mentor/admin-only, not a self-access route ─────────────────────────────
    {
      const selfIdRes = await fetch(`${base}/api/mentor/students/${studentAlice}/sessions`, { headers: { Cookie: studentCookie } });
      // Also verify with the student's own literal id, in case actor==target
      // self-access is what's under test elsewhere in the app.
      const meRes = await fetch(`${base}/api/auth/me`, { headers: { Cookie: studentCookie } });
      const meBody = await meRes.json();
      const ownIdRes = await fetch(`${base}/api/mentor/students/${meBody.id}/sessions`, { headers: { Cookie: studentCookie } });
      if (selfIdRes.status === 403 && ownIdRes.status === 403) {
        pass('p', 'Student is blocked from /students/:id/sessions for any id, including their own (403)');
      } else {
        fail('p', 'Student must be blocked regardless of target id', `otherIdStatus=${selfIdRes.status}, ownIdStatus=${ownIdRes.status}`);
      }
    }

    // ── Case q: admin can view any student's sessions via this route too ────
    {
      const res = await fetch(`${base}/api/mentor/students/${studentBobBOnly}/sessions`, { headers: { Cookie: adminCookie } });
      if (res.status === 200) {
        pass('q', "Admin can view any student's sessions via /students/:id/sessions (200)");
      } else {
        fail('q', 'Admin must be able to view any student\'s sessions', `status=${res.status}`);
      }
    }

    // ── Case r: unauthenticated blocked from /students/:id/sessions ─────────
    {
      const res = await fetch(`${base}/api/mentor/students/${studentAlice}/sessions`);
      if (res.status === 401) {
        pass('r', 'Unauthenticated request to /students/:id/sessions returns 401');
      } else {
        fail('r', 'Unauthenticated request must return 401', `status=${res.status}`);
      }
    }

    // ── Case s: password_hash never exposed in either new endpoint ──────────
    {
      const summaryRes = await fetch(summaryUrl, { headers: { Cookie: mentorACookie } });
      const summaryBody = await summaryRes.json();
      const sessionsRes = await fetch(`${base}/api/mentor/students/${studentAlice}/sessions`, { headers: { Cookie: mentorACookie } });
      const sessionsBody = await sessionsRes.json();
      const leaked = summaryBody.some(r => 'password_hash' in r) || sessionsBody.some(r => 'password_hash' in r);
      if (!leaked) {
        pass('s', 'password_hash is never present in /students/summary or /students/:id/sessions responses');
      } else {
        fail('s', 'password_hash must never be returned', `summary=${JSON.stringify(summaryBody)}, sessions=${JSON.stringify(sessionsBody)}`);
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
