'use strict';

/**
 * Authorization layer verification for GET /api/sessions and
 * GET /api/sessions/:id/filters (Step 6e-3a — session read routes only).
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the sessions router, mounted the same way as in src/index.js) on
 * an ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie — userId is never sent by the client; the routes must
 * resolve it from the session and must not honor a spoofed ?userId= or
 * reveal another user's session by id.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:sessions-read-authz
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const sessionsRouter = require('../src/routes/sessions');

const PREFIX = '_sessread_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-sessions-read-authz-script-only';
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

    // ── Setup: userA has 2 sessions, userB has 1 ──────────────────────────────
    const userAUsername = `${PREFIX}userA`;
    const userBUsername = `${PREFIX}userB`;
    const userAId = await createUser(userAUsername);
    const userBId = await createUser(userBUsername);

    const userASession1 = await createSession(userAId, `${PREFIX}a_session_1`);
    const userASession2 = await createSession(userAId, `${PREFIX}a_session_2`);
    const userBSession1 = await createSession(userBId, `${PREFIX}b_session_1`);

    // ── Case 1: unauthenticated GET /api/sessions → 401 ───────────────────────
    {
      const res = await fetch(sessionsBase);
      if (res.status === 401) {
        pass('1', 'Unauthenticated GET /api/sessions returns 401');
      } else {
        fail('1', 'Unauthenticated GET /api/sessions must return 401', `status=${res.status}`);
      }
    }

    // ── Case 2: logged-in user only sees their own sessions ──────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(sessionsBase, { headers: { Cookie: cookie } });
      const body = await res.json();
      const ids = body.map(s => s.id);
      const onlyOwn = ids.includes(userASession1) && ids.includes(userASession2) && !ids.includes(userBSession1);
      if (res.status === 200 && onlyOwn && ids.length === 2) {
        pass('2', 'Logged-in user sees only their own 2 sessions, not the other user\'s');
      } else {
        fail('2', 'Must return only the caller\'s own sessions', `status=${res.status}, ids=${JSON.stringify(ids)}`);
      }
    }

    // ── Case 3: spoofed ?userId= does not expose another user's sessions ─────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}?userId=${userBId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      const ids = body.map(s => s.id);
      const leaksVictim = ids.includes(userBSession1);
      if (res.status === 200 && !leaksVictim) {
        pass('3', "Spoofed ?userId= is ignored — still returns only the caller's own sessions");
      } else {
        fail('3', 'Spoofed userId must not expose another user\'s sessions', `status=${res.status}, ids=${JSON.stringify(ids)}`);
      }
    }

    // ── Case 4: unauthenticated GET /:id/filters → 401 ────────────────────────
    {
      const res = await fetch(`${sessionsBase}/${userASession1}/filters`);
      if (res.status === 401) {
        pass('4', 'Unauthenticated GET /:id/filters returns 401');
      } else {
        fail('4', 'Unauthenticated GET /:id/filters must return 401', `status=${res.status}`);
      }
    }

    // ── Case 5: own session filters can be read ───────────────────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${userASession1}/filters`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && 'planType' in body) {
        pass('5', 'Own session filters are readable (200)');
      } else {
        fail('5', 'Own session filters must be readable', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 6: another user's session filters return 404 ────────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${userBSession1}/filters`, { headers: { Cookie: cookie } });
      if (res.status === 404) {
        pass('6', "Another user's session filters return 404 (not 403)");
      } else {
        fail('6', "Another user's session filters must return 404", `status=${res.status}`);
      }
    }

    // ── Case 7: nonexistent session filters return 404 ────────────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/999999999/filters`, { headers: { Cookie: cookie } });
      if (res.status === 404) {
        pass('7', 'Nonexistent session filters return 404');
      } else {
        fail('7', 'Nonexistent session filters must return 404', `status=${res.status}`);
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
