'use strict';

/**
 * Auth endpoints verification for POST /api/auth/login, POST /api/auth/logout,
 * GET /api/auth/me.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router, mounted the same way as in src/index.js) on an ephemeral port, and
 * issues real HTTP requests against it. Node's global fetch does not persist
 * cookies across calls, so this script manually captures the Set-Cookie
 * header from a successful login and replays it as Cookie on subsequent
 * requests — a real cookie jar, not a simulated one.
 *
 * This script exercises the /api/auth/* endpoints in isolation, independent
 * of getActingUser()'s own tests (see check-authz.js / check-reopen-authz.js).
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:auth
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');

const PREFIX = '_auth_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-auth-script-only';

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

async function createUser(username, role, plainPassword) {
  const hash = plainPassword ? await bcrypt.hash(plainPassword, 10) : null;
  const r = await pool.query(
    'INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [username, role, hash]
  );
  return r.rows[0].id;
}

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0]; // "connect.sid=..."
}

async function login(base, username, password) {
  const res = await fetch(`${base}/login`, {
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
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}/api/auth`;

    // ── Setup ──────────────────────────────────────────────────────────────
    const goodUsername = `${PREFIX}gooduser`;
    const goodPassword = 'correct-password-123';
    const goodUserId = await createUser(goodUsername, 'student', goodPassword);
    const noPassUsername = `${PREFIX}nopassuser`;
    await createUser(noPassUsername, 'student', null);

    // ── Case a: correct login ─────────────────────────────────────────────────
    let sessionCookie;
    {
      const { res, body, cookie } = await login(base, goodUsername, goodPassword);
      sessionCookie = cookie;
      if (res.status === 200 && body.id === goodUserId && body.username === goodUsername && body.role === 'student' && cookie) {
        pass('a', 'Correct login returns 200, { id, username, role }, and Set-Cookie');
      } else {
        fail('a', 'Correct login must return 200 + user shape + cookie', `status=${res.status}, body=${JSON.stringify(body)}, cookie=${cookie}`);
      }
    }

    // ── Case b: wrong password ──────────────────────────────────────────────
    {
      const { res, body } = await login(base, goodUsername, 'wrong-password');
      if (res.status === 401 && body.error === 'Invalid username or password.') {
        pass('b', 'Wrong password returns 401 generic error');
      } else {
        fail('b', 'Wrong password must return 401 generic error', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case c: password_hash is null ───────────────────────────────────────
    {
      const { res, body } = await login(base, noPassUsername, 'anything123');
      if (res.status === 401 && body.error === 'Invalid username or password.') {
        pass('c', "Login for a user with null password_hash returns the same 401 generic error");
      } else {
        fail('c', 'Null password_hash must return 401 generic error', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case d: nonexistent username ────────────────────────────────────────
    {
      const { res, body } = await login(base, `${PREFIX}does_not_exist`, 'anything123');
      if (res.status === 401 && body.error === 'Invalid username or password.') {
        pass('d', 'Nonexistent username returns the same 401 generic error');
      } else {
        fail('d', 'Nonexistent username must return 401 generic error', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case e: /me without cookie ───────────────────────────────────────────
    {
      const res = await fetch(`${base}/me`);
      if (res.status === 401) {
        pass('e', 'GET /me without a cookie returns 401');
      } else {
        fail('e', 'GET /me without a cookie must return 401', `status=${res.status}`);
      }
    }

    // ── Case f: /me with valid cookie ───────────────────────────────────────
    {
      const res = await fetch(`${base}/me`, { headers: { Cookie: sessionCookie } });
      const body = await res.json();
      if (res.status === 200 && body.id === goodUserId && body.username === goodUsername && body.role === 'student') {
        pass('f', 'GET /me with a valid cookie returns the logged-in user');
      } else {
        fail('f', 'GET /me with a valid cookie must return the logged-in user', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case i: password_hash is never present in any response body ────────
    // Re-logs in (session.regenerate issues a new cookie); reassign
    // sessionCookie so the logout/post-logout cases below use the current one.
    {
      const { res: loginRes, body: loginBody, cookie: freshCookie } = await login(base, goodUsername, goodPassword);
      sessionCookie = freshCookie;
      const meRes = await fetch(`${base}/me`, { headers: { Cookie: sessionCookie } });
      const meBody = await meRes.json();
      if (loginRes.status === 200 && !('password_hash' in loginBody) && !('password_hash' in meBody)) {
        pass('i', 'password_hash is never present in /login or /me responses');
      } else {
        fail('i', 'password_hash must never be returned', `loginBody=${JSON.stringify(loginBody)}, meBody=${JSON.stringify(meBody)}`);
      }
    }

    // ── Case g: logout destroys the session ─────────────────────────────────
    {
      const res = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: sessionCookie } });
      const body = await res.json();
      if (res.status === 200 && body.success === true) {
        pass('g', 'POST /logout returns 200 { success: true }');
      } else {
        fail('g', 'Logout must return 200 { success: true }', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case h: /me after logout ─────────────────────────────────────────────
    {
      const res = await fetch(`${base}/me`, { headers: { Cookie: sessionCookie } });
      if (res.status === 401) {
        pass('h', 'GET /me after logout returns 401 (session was destroyed)');
      } else {
        fail('h', 'GET /me after logout must return 401', `status=${res.status}`);
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
