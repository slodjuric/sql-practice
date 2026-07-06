'use strict';

/**
 * Authorization + behavior verification for reading another authorized
 * user's session list:
 *   GET /api/sessions with an optional ?targetUserId=<id> query parameter.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the sessions router, mounted the same way as in src/index.js) on
 * an ephemeral port. Authenticates via real POST /api/auth/login and
 * carries the resulting cookie.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:session-read-for-user
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const sessionsRouter = require('../src/routes/sessions');

const PREFIX = '_sessionread_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-session-read-for-user-script-only';
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

// created_by_user_id has no ON DELETE CASCADE (by design, Step A), so
// sessions must be removed before the users they reference either as
// owner or creator.
async function cleanup() {
  await pool.query(`
    DELETE FROM task_attempts WHERE session_id IN (
      SELECT id FROM learning_sessions
      WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)
         OR created_by_user_id IN (SELECT id FROM users WHERE username LIKE $1)
    )`, [`${PREFIX}%`]);
  await pool.query(`
    DELETE FROM user_task_progress WHERE session_id IN (
      SELECT id FROM learning_sessions
      WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)
         OR created_by_user_id IN (SELECT id FROM users WHERE username LIKE $1)
    )`, [`${PREFIX}%`]);
  await pool.query(`
    DELETE FROM learning_sessions
    WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)
       OR created_by_user_id IN (SELECT id FROM users WHERE username LIKE $1)
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
  return res.json();
}

async function listSessions(base, cookie, targetUserId) {
  const q = targetUserId !== undefined ? `?targetUserId=${targetUserId}` : '';
  const res = await fetch(`${base}/api/sessions${q}`, { headers: { Cookie: cookie } });
  const body = await res.json().catch(() => ([]));
  return { res, body };
}

// Seeds a session directly in the DB, bypassing POST /api/sessions — needed
// for a student-owned fixture session, since students can no longer create
// sessions via the route at all (bug fix; see check-session-create-for-user.js).
// This script tests the read path only, so a direct seed is appropriate here.
async function seedSessionDirect(ownerId, name) {
  const dataset = await pool.query("SELECT id FROM datasets WHERE key = 'academic'");
  const r = await pool.query(
    'INSERT INTO learning_sessions (user_id, created_by_user_id, name, dataset_id) VALUES ($1, $1, $2, $3) RETURNING id',
    [ownerId, name, dataset.rows[0].id]
  );
  return r.rows[0].id;
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

    // Seed one session each for studentA (self-owned) and mentor (self-owned).
    // studentA's is seeded directly (bypassing POST) since students can no
    // longer create sessions at all; mentor's still goes through the real route.
    await seedSessionDirect(studentAId, `${PREFIX}studentA_own`);
    await createSession(base, mentorCookie, `${PREFIX}mentor_own`);

    // ── Case a: student GET with no targetUserId returns own sessions ─────────
    {
      const { res, body } = await listSessions(base, studentACookie);
      const onlyOwn = Array.isArray(body) && body.every(s => s.user_id === studentAId);
      if (res.status === 200 && onlyOwn && body.length >= 1) {
        pass('a', `Student GET with no targetUserId returns only own sessions (${body.length})`);
      } else {
        fail('a', 'Student must see only their own sessions with no targetUserId', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case b: student targetUserId=self works ────────────────────────────────
    {
      const { res, body } = await listSessions(base, studentACookie, studentAId);
      const onlyOwn = Array.isArray(body) && body.every(s => s.user_id === studentAId);
      if (res.status === 200 && onlyOwn) {
        pass('b', 'Student targetUserId=self works (200, own sessions)');
      } else {
        fail('b', 'Student targeting themselves must succeed', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case c: student targetUserId=another student is forbidden ─────────────
    {
      const { res } = await listSessions(base, studentACookie, studentBId);
      if (res.status === 403) {
        pass('c', 'Student targeting another student is forbidden (403)');
      } else {
        fail('c', 'Student must not read another student\'s sessions', `status=${res.status}`);
      }
    }

    // Mentor creates a session for the assigned student, to use in later cases
    const mentorCreatedForStudent = await createSession(base, mentorCookie, `${PREFIX}mentorCreatedForStudent`, assignedStudentId);

    // ── Case d: mentor targetUserId=assigned student works ─────────────────────
    {
      const { res, body } = await listSessions(base, mentorCookie, assignedStudentId);
      const onlyStudent = Array.isArray(body) && body.every(s => s.user_id === assignedStudentId);
      if (res.status === 200 && onlyStudent) {
        pass('d', `Mentor targetUserId=assigned student works (200, ${body.length} session(s))`);
      } else {
        fail('d', 'Mentor must be able to read an assigned student\'s sessions', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case e: mentor targetUserId=unassigned student is forbidden ────────────
    {
      const { res } = await listSessions(base, mentorCookie, studentBId);
      if (res.status === 403) {
        pass('e', 'Mentor targeting an unassigned student is forbidden (403)');
      } else {
        fail('e', 'Mentor must not read an unassigned student\'s sessions', `status=${res.status}`);
      }
    }

    // ── Case f: mentor no targetUserId returns own sessions only ───────────────
    {
      const { res, body } = await listSessions(base, mentorCookie);
      const onlyOwn = Array.isArray(body) && body.every(s => s.user_id === mentorId);
      if (res.status === 200 && onlyOwn) {
        pass('f', `Mentor GET with no targetUserId returns only own sessions (${body.length})`);
      } else {
        fail('f', 'Mentor with no targetUserId must see only their own sessions', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case g: admin targetUserId=student works ────────────────────────────────
    {
      const { res, body } = await listSessions(base, adminCookie, studentBId);
      if (res.status === 200 && Array.isArray(body)) {
        pass('g', `Admin targetUserId=student works (200, ${body.length} session(s))`);
      } else {
        fail('g', 'Admin must be able to read any user\'s sessions', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case h: invalid targetUserId returns 400 ────────────────────────────────
    {
      const { res } = await listSessions(base, mentorCookie, 'not-a-number');
      if (res.status === 400) {
        pass('h', 'Invalid (non-numeric) targetUserId returns 400');
      } else {
        fail('h', 'Invalid targetUserId must return 400', `status=${res.status}`);
      }
    }

    // ── Case i: mentor-created session appears in the assigned student's own list ──
    {
      const { cookie: assignedStudentCookie } = await login(base, assignedStudentUsername, TEST_PASSWORD);
      const { res, body } = await listSessions(base, assignedStudentCookie);
      const found = body.some(s => s.id === mentorCreatedForStudent.session?.id);
      if (res.status === 200 && found) {
        pass('i', "Mentor-created session appears in the assigned student's own GET /api/sessions");
      } else {
        fail('i', 'Assigned student must see the mentor-created session as their own', `status=${res.status}, ids=${JSON.stringify(body.map(s => s.id))}`);
      }
    }

    // ── Case j: no password_hash / unrelated user data ever exposed ────────────
    {
      const { body } = await listSessions(base, mentorCookie, assignedStudentId);
      const leaked = body.some(row => 'password_hash' in row || 'username' in row);
      if (!leaked) {
        pass('j', 'No password_hash or username field present in the session rows');
      } else {
        fail('j', 'Session rows must never expose password_hash or unrelated user fields', `sample=${JSON.stringify(body[0])}`);
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
