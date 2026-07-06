'use strict';

/**
 * Authorization + behavior verification for reading another authorized
 * user's progress:
 *   GET /api/progress/summary and GET /api/progress/tasks-status, both with
 *   an optional ?targetUserId=<id> query parameter.
 *
 * Spins up a minimal in-process Express app (session middleware + auth +
 * sessions + progress routers, mounted the same way as in src/index.js) on
 * an ephemeral port. Authenticates via real POST /api/auth/login and
 * carries the resulting cookie.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:progress-read-for-user
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const sessionsRouter = require('../src/routes/sessions');
const progressRouter = require('../src/routes/progress');

const PREFIX = '_progressread_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-progress-read-for-user-script-only';
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

// Seeds a session directly in the DB, bypassing POST /api/sessions — needed
// for student-owned fixture sessions, since students can no longer create
// sessions via the route at all (bug fix; see check-session-create-for-user.js).
// This script tests the read path only, so a direct seed is appropriate here.
// Returns the same { session: { id } } shape as the POST-based createSession
// helper, so call sites don't need to change.
async function seedSessionDirect(ownerId, name) {
  const dataset = await pool.query("SELECT id FROM datasets WHERE key = 'academic'");
  const r = await pool.query(
    'INSERT INTO learning_sessions (user_id, created_by_user_id, name, dataset_id) VALUES ($1, $1, $2, $3) RETURNING id',
    [ownerId, name, dataset.rows[0].id]
  );
  return { session: { id: r.rows[0].id } };
}

async function getSummary(base, cookie, { targetUserId, sessionId } = {}) {
  const params = new URLSearchParams();
  if (targetUserId !== undefined) params.set('targetUserId', targetUserId);
  if (sessionId !== undefined) params.set('sessionId', sessionId);
  const q = params.toString();
  const res = await fetch(`${base}/api/progress/summary${q ? `?${q}` : ''}`, { headers: { Cookie: cookie } });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function getTasksStatus(base, cookie, { targetUserId, sessionId } = {}) {
  const params = new URLSearchParams();
  if (targetUserId !== undefined) params.set('targetUserId', targetUserId);
  if (sessionId !== undefined) params.set('sessionId', sessionId);
  const q = params.toString();
  const res = await fetch(`${base}/api/progress/tasks-status${q ? `?${q}` : ''}`, { headers: { Cookie: cookie } });
  const body = await res.json().catch(() => ({}));
  return { res, body };
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
    app.use('/api/progress', progressRouter);
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

    // Seed one session each for studentA and mentor (self-owned). Student
    // sessions are seeded directly (bypassing POST) since students can no
    // longer create sessions at all; mentor's still goes through the real route.
    await seedSessionDirect(studentAId, `${PREFIX}studentA_own`);
    await createSession(base, mentorCookie, `${PREFIX}mentor_own`);
    // Mentor creates a session for the assigned student
    const mentorCreatedForStudent = await createSession(base, mentorCookie, `${PREFIX}mentorCreatedForStudent`, assignedStudentId);
    // Seed a session for studentB, used as the "belongs to someone else" probe
    const studentBSession = await seedSessionDirect(studentBId, `${PREFIX}studentB_own`);

    // ── Case a: student summary with no targetUserId works for self ───────────
    {
      const { res, body } = await getSummary(base, studentACookie);
      if (res.status === 200 && typeof body.totalTasks === 'number') {
        pass('a', 'Student summary with no targetUserId works for self (200)');
      } else {
        fail('a', 'Student must get their own summary with no targetUserId', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case b: student summary targetUserId=self works ────────────────────────
    {
      const { res, body } = await getSummary(base, studentACookie, { targetUserId: studentAId });
      if (res.status === 200 && typeof body.totalTasks === 'number') {
        pass('b', 'Student summary targetUserId=self works (200)');
      } else {
        fail('b', 'Student targeting themselves must succeed', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case c: student summary targetUserId=other student is forbidden ────────
    {
      const { res } = await getSummary(base, studentACookie, { targetUserId: studentBId });
      if (res.status === 403) {
        pass('c', 'Student targeting another student is forbidden (403)');
      } else {
        fail('c', 'Student must not read another student\'s progress', `status=${res.status}`);
      }
    }

    // ── Case d: mentor summary targetUserId=assigned student works ─────────────
    {
      const { res, body } = await getSummary(base, mentorCookie, { targetUserId: assignedStudentId });
      if (res.status === 200 && typeof body.totalTasks === 'number') {
        pass('d', 'Mentor summary targetUserId=assigned student works (200)');
      } else {
        fail('d', 'Mentor must be able to read an assigned student\'s progress', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case e: mentor summary targetUserId=unassigned student is forbidden ────
    {
      const { res } = await getSummary(base, mentorCookie, { targetUserId: studentBId });
      if (res.status === 403) {
        pass('e', 'Mentor targeting an unassigned student is forbidden (403)');
      } else {
        fail('e', 'Mentor must not read an unassigned student\'s progress', `status=${res.status}`);
      }
    }

    // ── Case f: mentor no targetUserId still returns own progress ──────────────
    {
      const { res, body } = await getSummary(base, mentorCookie);
      if (res.status === 200 && typeof body.totalTasks === 'number') {
        pass('f', 'Mentor with no targetUserId still gets their own summary (200)');
      } else {
        fail('f', 'Mentor with no targetUserId must get their own summary', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case g: admin targetUserId=student works ────────────────────────────────
    {
      const { res, body } = await getSummary(base, adminCookie, { targetUserId: studentBId });
      if (res.status === 200 && typeof body.totalTasks === 'number') {
        pass('g', 'Admin targetUserId=student works (200)');
      } else {
        fail('g', 'Admin must be able to read any user\'s progress', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case h: invalid targetUserId returns 400 ────────────────────────────────
    {
      const { res } = await getSummary(base, mentorCookie, { targetUserId: 'not-a-number' });
      if (res.status === 400) {
        pass('h', 'Invalid (non-numeric) targetUserId returns 400 for summary');
      } else {
        fail('h', 'Invalid targetUserId must return 400', `status=${res.status}`);
      }
    }

    // ── Case i: tasks-status follows the same rules ─────────────────────────────
    {
      const ok1 = await getTasksStatus(base, studentACookie); // self, no targetUserId
      const ok2 = await getTasksStatus(base, mentorCookie, { targetUserId: assignedStudentId }); // assigned
      const forbidden = await getTasksStatus(base, mentorCookie, { targetUserId: studentBId }); // unassigned
      const invalid = await getTasksStatus(base, mentorCookie, { targetUserId: 'nope' });
      if (ok1.res.status === 200 && ok2.res.status === 200 && forbidden.res.status === 403 && invalid.res.status === 400) {
        pass('i', 'tasks-status follows the same targetUserId rules (self 200, assigned 200, unassigned 403, invalid 400)');
      } else {
        fail('i', 'tasks-status must follow the same rules as summary', `statuses=${ok1.res.status},${ok2.res.status},${forbidden.res.status},${invalid.res.status}`);
      }
    }

    // ── Case j: a sessionId belonging to another user does not leak progress ───
    {
      // Mentor is authorized for assignedStudent, but passes studentB's sessionId.
      const { res, body } = await getSummary(base, mentorCookie, { targetUserId: assignedStudentId, sessionId: studentBSession.session.id });
      // resolveSessionId(assignedStudentId, studentBSession.id) must fail the
      // ownership check (that session belongs to studentB, not assignedStudent)
      // — unlike an omitted sessionId, an explicit-but-mismatched one does NOT
      // fall back to the owner's own session; it resolves to null, which the
      // route renders as the generic "no session" default (identifiable by
      // the missing attemptsCount key present only on real per-session data).
      const hitGenericDefault = !('attemptsCount' in body);
      if (res.status === 200 && hitGenericDefault && body.solved === 0 && body.inProgress === 0) {
        pass('j', "A sessionId belonging to a different user fails ownership and never resolves studentB's data");
      } else {
        fail('j', 'A foreign sessionId must not leak another user\'s progress', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case k: mentor can use the professor-created session only via the assigned student's targetUserId ──
    {
      const withTarget = await getSummary(base, mentorCookie, {
        targetUserId: assignedStudentId,
        sessionId: mentorCreatedForStudent.session.id,
      });
      const withoutTarget = await getSummary(base, mentorCookie, {
        sessionId: mentorCreatedForStudent.session.id,
      });
      // withTarget: ownerId=assignedStudentId, and the session really belongs
      // to them — resolves to real per-session data (has attemptsCount).
      // withoutTarget: ownerId=mentorId (no targetUserId sent), but the
      // session belongs to assignedStudent, not the mentor — ownership check
      // fails, falls through to the generic default (no attemptsCount) rather
      // than silently granting access to the student's session.
      const resolvedWithTarget    = 'attemptsCount' in withTarget.body;
      const rejectedWithoutTarget = !('attemptsCount' in withoutTarget.body);
      if (withTarget.res.status === 200 && resolvedWithTarget && rejectedWithoutTarget) {
        pass('k', "Professor-created session resolves only when targetUserId=assignedStudent is also sent; omitting it is rejected, not silently granted");
      } else {
        fail('k', 'Session created for a student must require targetUserId to resolve for the mentor', `resolvedWithTarget=${resolvedWithTarget}, rejectedWithoutTarget=${rejectedWithoutTarget}`);
      }
    }

    // ── Case l: no password_hash or unrelated user fields ever exposed ─────────
    // Checked as top-level response keys only — task titles/descriptions are
    // static content from tasks.json and may legitimately contain words like
    // "username" in plain English, which isn't a leak.
    {
      const { body } = await getSummary(base, mentorCookie, { targetUserId: assignedStudentId });
      const leaked = 'password_hash' in body || 'username' in body;
      if (!leaked) {
        pass('l', 'No password_hash or username field present as a top-level key in the progress summary response');
      } else {
        fail('l', 'Progress summary must never expose password_hash or unrelated user fields', `keys=${Object.keys(body)}`);
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
