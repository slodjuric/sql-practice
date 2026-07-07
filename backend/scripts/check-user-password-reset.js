'use strict';

/**
 * Authorization + behavior verification for PATCH /api/users/:id/password
 * (admin-only password reset from User Management).
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the users router, mounted the same way as in src/index.js) on an
 * ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie on subsequent requests.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:user-password-reset
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const usersRouter = require('../src/routes/users');

const PREFIX = '_pwreset_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-user-password-reset-script-only';
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

async function createUser(username, role, { withPassword = true } = {}) {
  const hash = withPassword ? await bcrypt.hash(TEST_PASSWORD, 10) : null;
  const r = await pool.query(
    'INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [username, role, hash]
  );
  return r.rows[0].id;
}

async function getPasswordHash(userId) {
  const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.password_hash ?? null;
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
    app.use('/api/users', usersRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const usersBase = `${base}/api/users`;

    // ── Setup ──────────────────────────────────────────────────────────────
    const adminUsername   = `${PREFIX}admin`;
    const mentorUsername  = `${PREFIX}mentor`;
    const studentUsername = `${PREFIX}student`;
    const adminId  = await createUser(adminUsername,   'admin');
    await createUser(mentorUsername,  'mentor');
    await createUser(studentUsername, 'student');
    const { cookie: adminCookie }   = await login(base, adminUsername,   TEST_PASSWORD);
    const { cookie: mentorCookie }  = await login(base, mentorUsername,  TEST_PASSWORD);
    const { cookie: studentCookie } = await login(base, studentUsername, TEST_PASSWORD);

    // ── Case 1: anonymous → 401 ────────────────────────────────────────────
    {
      const res = await fetch(`${usersBase}/${adminId}/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: 'irrelevant123' }),
      });
      if (res.status === 401) {
        pass('1', 'Anonymous PATCH /api/users/:id/password returns 401');
      } else {
        fail('1', 'Anonymous request must return 401', `status=${res.status}`);
      }
    }

    // ── Case 2: mentor → 403 ───────────────────────────────────────────────
    {
      const res = await fetch(`${usersBase}/${adminId}/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: mentorCookie },
        body: JSON.stringify({ newPassword: 'irrelevant123' }),
      });
      if (res.status === 403) {
        pass('2', 'Mentor PATCH /api/users/:id/password returns 403');
      } else {
        fail('2', 'Mentor request must return 403', `status=${res.status}`);
      }
    }

    // ── Case 3: student → 403 ──────────────────────────────────────────────
    {
      const res = await fetch(`${usersBase}/${adminId}/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
        body: JSON.stringify({ newPassword: 'irrelevant123' }),
      });
      if (res.status === 403) {
        pass('3', 'Student PATCH /api/users/:id/password returns 403');
      } else {
        fail('3', 'Student request must return 403', `status=${res.status}`);
      }
    }

    // ── Case 4/5/6: admin resets another user's password; old password
    // stops working, new password works ───────────────────────────────────
    let victimId;
    {
      victimId = await createUser(`${PREFIX}victim`, 'student');
      const newPassword = 'a-brand-new-password-1';

      const res = await fetch(`${usersBase}/${victimId}/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ newPassword }),
      });
      const body = await res.json();
      if (res.status === 200) {
        pass('4', "Admin reset another user's password returns 200");
      } else {
        fail('4', 'Admin reset must return 200', `status=${res.status}, body=${JSON.stringify(body)}`);
      }

      const oldLoginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `${PREFIX}victim`, password: TEST_PASSWORD }),
      });
      if (oldLoginRes.status === 401) {
        pass('5', 'Old password no longer works after reset (401)');
      } else {
        fail('5', 'Old password must stop working', `status=${oldLoginRes.status}`);
      }

      const newLoginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `${PREFIX}victim`, password: newPassword }),
      });
      const newLoginBody = await newLoginRes.json();
      if (newLoginRes.status === 200 && newLoginBody.username === `${PREFIX}victim`) {
        pass('6', 'New password works after reset (200, correct user)');
      } else {
        fail('6', 'New password must work', `status=${newLoginRes.status}, body=${JSON.stringify(newLoginBody)}`);
      }
    }

    // ── Case 7: password shorter than 8 chars → 400, hash unchanged ───────
    {
      const targetId = await createUser(`${PREFIX}shorttarget`, 'student');
      const hashBefore = await getPasswordHash(targetId);

      const res = await fetch(`${usersBase}/${targetId}/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ newPassword: 'short' }),
      });
      const hashAfter = await getPasswordHash(targetId);

      if (res.status === 400 && hashAfter === hashBefore) {
        pass('7', 'Password shorter than 8 characters is rejected (400, hash unchanged)');
      } else {
        fail('7', 'Too-short password must be rejected without changing the hash', `status=${res.status}, hashChanged=${hashAfter !== hashBefore}`);
      }
    }

    // ── Case 8: nonexistent user id → 404 ──────────────────────────────────
    {
      const res = await fetch(`${usersBase}/999999999/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ newPassword: 'irrelevant123' }),
      });
      if (res.status === 404) {
        pass('8', 'Resetting a nonexistent user id returns 404');
      } else {
        fail('8', 'Nonexistent user id must return 404', `status=${res.status}`);
      }
    }

    // ── Case 9: response body never contains password_hash ────────────────
    {
      const targetId = await createUser(`${PREFIX}noleak`, 'student');
      const res = await fetch(`${usersBase}/${targetId}/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ newPassword: 'another-good-password-1' }),
      });
      const body = await res.json();
      if (res.status === 200 && !('password_hash' in body)) {
        pass('9', 'Response body does not contain password_hash');
      } else {
        fail('9', 'Response must never contain password_hash', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 10: legacy NULL password_hash user can receive a new password
    // and then log in ───────────────────────────────────────────────────────
    {
      const legacyUsername = `${PREFIX}legacy`;
      const legacyId = await createUser(legacyUsername, 'student', { withPassword: false });
      const hashBefore = await getPasswordHash(legacyId);
      const newPassword = 'legacy-user-new-password-1';

      const resetRes = await fetch(`${usersBase}/${legacyId}/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ newPassword }),
      });

      const loginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: legacyUsername, password: newPassword }),
      });
      const loginBody = await loginRes.json();

      if (hashBefore === null && resetRes.status === 200 && loginRes.status === 200 && loginBody.username === legacyUsername) {
        pass('10', 'Legacy NULL password_hash user can receive a new password and then log in');
      } else {
        fail('10', 'Legacy NULL-password user must be resettable and able to log in', `hashBefore=${hashBefore}, resetStatus=${resetRes.status}, loginStatus=${loginRes.status}`);
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
