'use strict';

/**
 * Authorization + behavior verification for the mentor-facing endpoint:
 *   GET /api/mentor/students
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
