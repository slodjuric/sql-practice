'use strict';

/**
 * Authorization + behavior verification for creating a learning session on
 * behalf of another authorized user:
 *   POST /api/sessions with an optional `targetUserId` body field.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the sessions router, mounted the same way as in src/index.js) on
 * an ephemeral port. Authenticates via real POST /api/auth/login and
 * carries the resulting cookie.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:session-create-for-user
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const sessionsRouter = require('../src/routes/sessions');

const PREFIX = '_sessioncreate_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-session-create-for-user-script-only';
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

// task_attempts/user_task_progress have no CASCADE on user delete in some
// paths — remove anything scoped to test sessions/users before the users
// themselves, mirroring check-session-ownership.js's cleanup order.
async function cleanup() {
  await pool.query(`
    DELETE FROM task_attempts
    WHERE session_id IN (
      SELECT id FROM learning_sessions
      WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)
    )
  `, [`${PREFIX}%`]);
  await pool.query(`
    DELETE FROM user_task_progress
    WHERE session_id IN (
      SELECT id FROM learning_sessions
      WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)
    )
  `, [`${PREFIX}%`]);
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

async function createSession(base, cookie, name, targetUserId) {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      name,
      planType: 'topic',
      ...(targetUserId !== undefined ? { targetUserId } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function getSessionRow(id) {
  const r = await pool.query('SELECT * FROM learning_sessions WHERE id = $1', [id]);
  return r.rows[0] || null;
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
    app.use('/api/sessions', sessionsRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;

    // ── Setup ──────────────────────────────────────────────────────────────
    const studentAUsername = `${PREFIX}studentA`;
    const studentBUsername = `${PREFIX}studentB`;
    const assignedStudentUsername = `${PREFIX}assignedStudent`;
    const mentorUsername = `${PREFIX}mentor`;
    const adminUsername = `${PREFIX}admin`;

    const studentAId = await createUser(studentAUsername, 'student');
    const studentBId = await createUser(studentBUsername, 'student');
    const assignedStudentId = await createUser(assignedStudentUsername, 'student');
    const mentorId = await createUser(mentorUsername, 'mentor');
    await createUser(adminUsername, 'admin');

    await pool.query(
      'INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2)',
      [mentorId, assignedStudentId]
    );

    const { cookie: studentACookie } = await login(base, studentAUsername, TEST_PASSWORD);
    const { cookie: mentorCookie } = await login(base, mentorUsername, TEST_PASSWORD);
    const { cookie: adminCookie } = await login(base, adminUsername, TEST_PASSWORD);

    // ── Case a: student cannot create a session for self, even with no targetUserId ──
    // Product rule (bug fix, post-launch): students select existing sessions
    // only — they can never create one, not even their own.
    {
      const { res, body } = await createSession(base, studentACookie, `${PREFIX}a`);
      if (res.status === 403) {
        pass('a', 'Student cannot create a session for self with no targetUserId (403)');
      } else {
        fail('a', 'Student must never be able to create a session', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case b: student cannot create a session for self WITH own targetUserId ──
    {
      const { res, body } = await createSession(base, studentACookie, `${PREFIX}b`, studentAId);
      if (res.status === 403) {
        pass('b', 'Student cannot create a session for self using their own targetUserId (403)');
      } else {
        fail('b', 'Student targeting themselves must still be forbidden', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case c: student tries to create a session for another student ─────────
    {
      const { res, body } = await createSession(base, studentACookie, `${PREFIX}c`, studentBId);
      if (res.status === 403) {
        pass('c', 'Student targeting another student is forbidden (403)');
      } else {
        fail('c', 'Student must not create a session for another student', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case d: mentor creates a session for self ──────────────────────────────
    {
      const { res, body } = await createSession(base, mentorCookie, `${PREFIX}d`);
      if (res.status === 201 && body.session?.user_id === mentorId) {
        pass('d', 'Mentor creates a session for self (201)');
      } else {
        fail('d', 'Mentor must be able to create a session for self', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case e: mentor creates a session for an assigned student ───────────────
    let assignedStudentSessionId;
    {
      const { res, body } = await createSession(base, mentorCookie, `${PREFIX}e`, assignedStudentId);
      assignedStudentSessionId = body.session?.id;
      if (res.status === 201 && body.session?.user_id === assignedStudentId) {
        pass('e', 'Mentor creates a session for an assigned student (201)');
      } else {
        fail('e', 'Mentor must be able to create a session for an assigned student', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case f: mentor tries to create a session for an unassigned student ────
    {
      const { res, body } = await createSession(base, mentorCookie, `${PREFIX}f`, studentBId);
      if (res.status === 403) {
        pass('f', 'Mentor targeting an unassigned student is forbidden (403)');
      } else {
        fail('f', 'Mentor must not create a session for an unassigned student', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case g: admin creates a session for a student ──────────────────────────
    {
      const { res, body } = await createSession(base, adminCookie, `${PREFIX}g`, studentBId);
      if (res.status === 201 && body.session?.user_id === studentBId) {
        pass('g', 'Admin creates a session for any student (201)');
      } else {
        fail('g', 'Admin must be able to create a session for any user', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case h: assigned-student session has user_id=student, created_by=mentor ──
    {
      const row = await getSessionRow(assignedStudentSessionId);
      if (row && row.user_id === assignedStudentId && row.created_by_user_id === mentorId) {
        pass('h', `Mentor-created session: user_id=${row.user_id} (student), created_by_user_id=${row.created_by_user_id} (mentor)`);
      } else {
        fail('h', 'Mentor-created session must have user_id=student, created_by_user_id=mentor', `row=${JSON.stringify(row)}`);
      }
    }

    // ── Case i: self-created session has user_id === created_by_user_id ───────
    // Uses the mentor (not a student — students can no longer self-create at
    // all, see cases a/b) to verify the general self-creation ownership invariant.
    {
      const { body } = await createSession(base, mentorCookie, `${PREFIX}i`);
      const row = await getSessionRow(body.session?.id);
      if (row && row.user_id === mentorId && row.created_by_user_id === mentorId) {
        pass('i', `Self-created session: user_id=${row.user_id} === created_by_user_id=${row.created_by_user_id}`);
      } else {
        fail('i', 'Self-created session must have user_id === created_by_user_id', `row=${JSON.stringify(row)}`);
      }
    }

    // ── Case j: GET /api/sessions for the student includes the mentor-created session ──
    {
      const { cookie: assignedStudentCookie } = await login(base, assignedStudentUsername, TEST_PASSWORD);
      const listRes = await fetch(`${base}/api/sessions`, { headers: { Cookie: assignedStudentCookie } });
      const list = await listRes.json();
      const found = list.some(s => s.id === assignedStudentSessionId);
      if (listRes.status === 200 && found) {
        pass('j', "GET /api/sessions for the student includes the mentor-created session as their own");
      } else {
        fail('j', 'Student must see the mentor-created session via existing GET /api/sessions', `status=${listRes.status}, ids=${JSON.stringify(list.map(s => s.id))}`);
      }
    }

    // ── Case k: GET /api/sessions for the mentor does NOT include the student's session ──
    {
      const listRes = await fetch(`${base}/api/sessions`, { headers: { Cookie: mentorCookie } });
      const list = await listRes.json();
      const leaked = list.some(s => s.id === assignedStudentSessionId);
      if (listRes.status === 200 && !leaked) {
        pass('k', "GET /api/sessions for the mentor does not include the student's session (unchanged, scoped by ls.user_id)");
      } else {
        fail('k', 'Mentor\'s own GET /api/sessions must not leak the student\'s session', `leaked=${leaked}`);
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
