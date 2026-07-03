'use strict';

/**
 * Authorization layer verification for PATCH /api/sessions/:id/reopen.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the sessions router, mounted the same way as in src/index.js) on
 * an ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie on subsequent requests — no x-acting-user-id header,
 * matching how getActingUser()/canReopenSession() resolve identity in
 * production.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:reopen-authz
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const sessionsRouter = require('../src/routes/sessions');

const PREFIX = '_reopen_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-reopen-authz-script-only';
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
  // Sessions cascade-delete on user delete, but clean up explicitly first
  // in case a failed run left orphaned rows under a different owner.
  await pool.query(
    "DELETE FROM learning_sessions WHERE name LIKE $1",
    [`${PREFIX}%`]
  );
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

async function createCompletedSession(ownerId, name) {
  const r = await pool.query(
    `INSERT INTO learning_sessions (user_id, name, status, completed_at)
     VALUES ($1, $2, 'completed', NOW())
     RETURNING id, status`,
    [ownerId, name]
  );
  return r.rows[0].id;
}

async function sessionStatus(id) {
  const r = await pool.query('SELECT status FROM learning_sessions WHERE id = $1', [id]);
  return r.rows[0]?.status;
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
    app.use('/api/sessions', sessionsRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const sessionsBase = `${base}/api/sessions`;

    // ── Setup: one logged-in-capable acting user per role, two session owners ─
    const adminUsername    = `${PREFIX}admin`;
    const mentorUsername   = `${PREFIX}mentor`;
    const studentAUsername = `${PREFIX}studentA`;
    const adminId    = await createUser(adminUsername,    'admin');
    const mentorId   = await createUser(mentorUsername,   'mentor');
    const studentAId = await createUser(studentAUsername, 'student');
    const studentBId = await createUser(`${PREFIX}studentB`, 'student');

    const sessionOwnA1 = await createCompletedSession(studentAId, `${PREFIX}session_a1`);
    const sessionOwnB1 = await createCompletedSession(studentBId, `${PREFIX}session_b1`);
    const sessionOwnB2 = await createCompletedSession(studentBId, `${PREFIX}session_b2`);
    const sessionOwnB3 = await createCompletedSession(studentBId, `${PREFIX}session_b3`);
    const sessionOwnB4 = await createCompletedSession(studentBId, `${PREFIX}session_b4`);

    // ── Case a: logged-in student cannot reopen own completed session ────────
    {
      const { cookie } = await login(base, studentAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${sessionOwnA1}/reopen`, { method: 'PATCH', headers: { Cookie: cookie } });
      const status = await sessionStatus(sessionOwnA1);
      if (res.status === 403 && status === 'completed') {
        pass('a', 'Logged-in student cannot reopen own completed session (403, status unchanged)');
      } else {
        fail('a', 'Student must not be able to reopen own completed session', `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case b: logged-in student targeting someone else's session gets 404 ──
    // Must be 404, not 403 — a student must not be able to distinguish a
    // nonexistent session id from one that exists but belongs to someone else.
    {
      const { cookie } = await login(base, studentAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${sessionOwnB1}/reopen`, { method: 'PATCH', headers: { Cookie: cookie } });
      const status = await sessionStatus(sessionOwnB1);
      if (res.status === 404 && status === 'completed') {
        pass('b', "Logged-in student targeting another user's completed session gets 404 (status unchanged)");
      } else {
        fail('b', "Student must get 404 (not 403) for another user's session", `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case c: logged-in admin can reopen a completed session ───────────────
    {
      const { cookie } = await login(base, adminUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${sessionOwnB2}/reopen`, { method: 'PATCH', headers: { Cookie: cookie } });
      const status = await sessionStatus(sessionOwnB2);
      if (res.status === 200 && status === 'active') {
        pass('c', 'Logged-in admin can reopen a completed session (200, status=active)');
      } else {
        fail('c', 'Admin must be able to reopen a completed session', `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case d: logged-in mentor can reopen a completed session (temporary) ──
    {
      const { cookie } = await login(base, mentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${sessionOwnB3}/reopen`, { method: 'PATCH', headers: { Cookie: cookie } });
      const status = await sessionStatus(sessionOwnB3);
      if (res.status === 200 && status === 'active') {
        pass('d', 'Logged-in mentor can reopen a completed session (200, status=active, temporary rule)');
      } else {
        fail('d', 'Mentor must be able to reopen a completed session (temporary rule)', `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case e: no login at all returns 401 ────────────────────────────────────
    {
      const res = await fetch(`${sessionsBase}/${sessionOwnB4}/reopen`, { method: 'PATCH' });
      const status = await sessionStatus(sessionOwnB4);
      if (res.status === 401 && status === 'completed') {
        pass('e', 'No login at all returns 401 (status unchanged)');
      } else {
        fail('e', 'No login must return 401', `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case f: nonexistent session id returns 404 ─────────────────────────────
    {
      const { cookie } = await login(base, adminUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/999999999/reopen`, { method: 'PATCH', headers: { Cookie: cookie } });
      if (res.status === 404) {
        pass('f', 'Nonexistent session id returns 404');
      } else {
        fail('f', 'Nonexistent session id must return 404', `httpStatus=${res.status}`);
      }
    }

    // ── Case g (bonus): a garbage/tampered cookie is treated as no session ───
    {
      const res = await fetch(`${sessionsBase}/${sessionOwnB4}/reopen`, {
        method: 'PATCH',
        headers: { Cookie: 'connect.sid=s%3Agarbage-not-a-real-session.invalidsignature' },
      });
      const status = await sessionStatus(sessionOwnB4);
      if (res.status === 401 && status === 'completed') {
        pass('g', 'A garbage/tampered session cookie is treated as unauthenticated (401, status unchanged)');
      } else {
        fail('g', 'A garbage cookie must return 401', `httpStatus=${res.status}, dbStatus=${status}`);
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
