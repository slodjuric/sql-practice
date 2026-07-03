'use strict';

/**
 * Authorization layer verification for GET /api/progress/summary and
 * GET /api/progress/tasks-status.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the progress router, mounted the same way as in src/index.js) on
 * an ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie — userId is never sent by the client; the route must
 * resolve it from the session and must not honor a spoofed ?userId= or a
 * sessionId belonging to someone else.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:progress-authz
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const progressRouter = require('../src/routes/progress');

const PREFIX = '_progress_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-progress-authz-script-only';
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
  await pool.query(
    "DELETE FROM learning_sessions WHERE name LIKE $1",
    [`${PREFIX}%`]
  );
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username) {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  const r = await pool.query(
    'INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [username, 'student', hash]
  );
  return r.rows[0].id;
}

async function createSession(ownerId, name) {
  const dataset = await pool.query("SELECT id FROM datasets WHERE key = 'academic'");
  const r = await pool.query(
    'INSERT INTO learning_sessions (user_id, name, dataset_id) VALUES ($1, $2, $3) RETURNING id',
    [ownerId, name, dataset.rows[0].id]
  );
  return r.rows[0].id;
}

async function markSolved(userId, sessionId, taskId) {
  await pool.query(
    `INSERT INTO user_task_progress (user_id, session_id, task_id, status, attempts_count, solved_at)
     VALUES ($1, $2, $3, 'solved', 1, NOW())`,
    [userId, sessionId, taskId]
  );
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
    app.use('/api/progress', progressRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const progressBase = `${base}/api/progress`;

    // ── Setup: victim (userB) has real progress; attacker (userA) has none ───
    const attackerUsername = `${PREFIX}userA`;
    const victimUsername   = `${PREFIX}userB`;
    const attackerId = await createUser(attackerUsername);
    const victimId   = await createUser(victimUsername);

    const attackerSessionId = await createSession(attackerId, `${PREFIX}session_a`);
    const victimSessionId   = await createSession(victimId,   `${PREFIX}session_b`);
    await markSolved(victimId, victimSessionId, 1); // task id 1 exists in academic tasks.json

    // ── Case 1: unauthenticated GET /summary → 401 ────────────────────────────
    {
      const res = await fetch(`${progressBase}/summary`);
      if (res.status === 401) {
        pass('1', 'Unauthenticated GET /summary returns 401');
      } else {
        fail('1', 'Unauthenticated GET /summary must return 401', `status=${res.status}`);
      }
    }

    // ── Case 2: unauthenticated GET /tasks-status → 401 ───────────────────────
    {
      const res = await fetch(`${progressBase}/tasks-status`);
      if (res.status === 401) {
        pass('2', 'Unauthenticated GET /tasks-status returns 401');
      } else {
        fail('2', 'Unauthenticated GET /tasks-status must return 401', `status=${res.status}`);
      }
    }

    // ── Case 3: logged-in user reads their OWN progress correctly ────────────
    {
      const { cookie } = await login(base, victimUsername, TEST_PASSWORD);
      const res = await fetch(`${progressBase}/summary?sessionId=${victimSessionId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && body.solved === 1) {
        pass('3', "Logged-in user reads their own progress correctly (solved=1)");
      } else {
        fail('3', 'Logged-in user must read their own correct progress', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 4: spoofed ?userId= is ignored — attacker never sees victim's data
    {
      const { cookie } = await login(base, attackerUsername, TEST_PASSWORD);
      const res = await fetch(`${progressBase}/summary?userId=${victimId}&sessionId=${victimSessionId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      // attacker's own session_id doesn't match victimSessionId, so
      // resolveSessionId must reject it and fall back to the default
      // (no-session) overview — solved must NOT be 1 (victim's real value).
      if (res.status === 200 && body.solved !== 1) {
        pass('4', `Spoofed userId + another user's sessionId does not leak their progress (solved=${body.solved}, not 1)`);
      } else {
        fail('4', "Attacker must not see victim's progress via spoofed userId/sessionId", `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 5: sessionId belonging to someone else is rejected (tasks-status)
    {
      const { cookie } = await login(base, attackerUsername, TEST_PASSWORD);
      const res = await fetch(`${progressBase}/tasks-status?sessionId=${victimSessionId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && Object.keys(body.statuses || {}).length === 0) {
        pass('5', "Another user's sessionId is rejected for /tasks-status (empty statuses, not victim's)");
      } else {
        fail('5', "Must not return victim's task statuses for a foreign sessionId", `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 6: attacker's own session/tasks-status still works normally ─────
    {
      const { cookie } = await login(base, attackerUsername, TEST_PASSWORD);
      const res = await fetch(`${progressBase}/tasks-status?sessionId=${attackerSessionId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && body.statuses) {
        pass('6', "User's own sessionId still works normally for /tasks-status (200)");
      } else {
        fail('6', "User's own sessionId must still work", `status=${res.status}, body=${JSON.stringify(body)}`);
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
