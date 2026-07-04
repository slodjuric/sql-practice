'use strict';

/**
 * Authorization layer verification for GET /api/users and POST /api/users
 * (both admin-only as of Step 6e-1), plus a smoke check that DELETE
 * /api/users/:id and the last-remaining-admin guard still hold.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the users router, mounted the same way as in src/index.js) on an
 * ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie on subsequent requests.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:users-admin-gate
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const usersRouter = require('../src/routes/users');

const PREFIX = '_users_gate_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-users-admin-gate-script-only';
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

async function userExists(id) {
  const r = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
  return r.rows.length > 0;
}

async function findByUsername(username) {
  const r = await pool.query('SELECT id, role FROM users WHERE username = $1', [username]);
  return r.rows[0] || null;
}

async function adminCount() {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
  return r.rows[0].n;
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

    const baselineAdmins = await adminCount();

    // ── Setup ──────────────────────────────────────────────────────────────
    const adminUsername   = `${PREFIX}admin`;
    const mentorUsername  = `${PREFIX}mentor`;
    const studentUsername = `${PREFIX}student`;
    await createUser(adminUsername,   'admin');
    await createUser(mentorUsername,  'mentor');
    await createUser(studentUsername, 'student');

    // ── Case a: unauthenticated GET /api/users → 401 ──────────────────────────
    {
      const res = await fetch(usersBase);
      if (res.status === 401) {
        pass('a', 'Unauthenticated GET /api/users returns 401');
      } else {
        fail('a', 'Unauthenticated GET must return 401', `status=${res.status}`);
      }
    }

    // ── Case b: student GET /api/users → 403 ───────────────────────────────────
    {
      const { cookie } = await login(base, studentUsername, TEST_PASSWORD);
      const res = await fetch(usersBase, { headers: { Cookie: cookie } });
      if (res.status === 403) {
        pass('b', 'Student GET /api/users returns 403');
      } else {
        fail('b', 'Student GET must return 403', `status=${res.status}`);
      }
    }

    // ── Case c: mentor GET /api/users → 403 ─────────────────────────────────────
    {
      const { cookie } = await login(base, mentorUsername, TEST_PASSWORD);
      const res = await fetch(usersBase, { headers: { Cookie: cookie } });
      if (res.status === 403) {
        pass('c', 'Mentor GET /api/users returns 403');
      } else {
        fail('c', 'Mentor GET must return 403', `status=${res.status}`);
      }
    }

    // ── Case d: admin GET /api/users → 200, no password_hash on any row ───────
    let adminCookie;
    {
      const { cookie } = await login(base, adminUsername, TEST_PASSWORD);
      adminCookie = cookie;
      const res = await fetch(usersBase, { headers: { Cookie: cookie } });
      const body = await res.json();
      const noHashLeak = Array.isArray(body) && body.every(u => !('password_hash' in u));
      if (res.status === 200 && noHashLeak && body.length > 0) {
        pass('d', `Admin GET /api/users returns 200, ${body.length} row(s), no password_hash on any row`);
      } else {
        fail('d', 'Admin GET must return 200 with no password_hash leaked', `status=${res.status}, sample=${JSON.stringify(body[0])}`);
      }
    }

    // ── Case e: unauthenticated POST /api/users → 401 ─────────────────────────
    {
      const res = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `${PREFIX}should_not_exist_1` }),
      });
      if (res.status === 401) {
        pass('e', 'Unauthenticated POST /api/users returns 401');
      } else {
        fail('e', 'Unauthenticated POST must return 401', `status=${res.status}`);
      }
    }

    // ── Case f: student POST /api/users → 403 ───────────────────────────────────
    {
      const { cookie } = await login(base, studentUsername, TEST_PASSWORD);
      const res = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ username: `${PREFIX}should_not_exist_2` }),
      });
      if (res.status === 403) {
        pass('f', 'Student POST /api/users returns 403');
      } else {
        fail('f', 'Student POST must return 403', `status=${res.status}`);
      }
    }

    // ── Case g: mentor POST /api/users → 403 ─────────────────────────────────────
    {
      const { cookie } = await login(base, mentorUsername, TEST_PASSWORD);
      const res = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ username: `${PREFIX}should_not_exist_3` }),
      });
      if (res.status === 403) {
        pass('g', 'Mentor POST /api/users returns 403');
      } else {
        fail('g', 'Mentor POST must return 403', `status=${res.status}`);
      }
    }

    // ── Case h: admin POST with no role (+ password) defaults to student ─────
    {
      const createdUsername = `${PREFIX}created_default`;
      const res = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: createdUsername, password: TEST_PASSWORD }),
      });
      const body = await res.json();
      const row = await findByUsername(createdUsername);
      if (res.status === 201 && body.role === 'student' && row?.role === 'student') {
        pass('h', "Admin POST with no role creates a 'student' (201)");
      } else {
        fail('h', "Admin POST with no role must default to 'student'", `status=${res.status}, body=${JSON.stringify(body)}, dbRole=${row?.role}`);
      }
    }

    // ── Case i: admin POST with role=mentor (+ password) creates a mentor ────
    {
      const createdUsername = `${PREFIX}created_mentor`;
      const res = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: createdUsername, role: 'mentor', password: TEST_PASSWORD }),
      });
      const body = await res.json();
      const row = await findByUsername(createdUsername);
      if (res.status === 201 && body.role === 'mentor' && row?.role === 'mentor') {
        pass('i', "Admin POST with role='mentor' creates a mentor (201)");
      } else {
        fail('i', 'Admin POST with role=mentor must create a mentor', `status=${res.status}, body=${JSON.stringify(body)}, dbRole=${row?.role}`);
      }
    }

    // ── Case j: admin POST with an invalid role returns 400 ───────────────────
    {
      const createdUsername = `${PREFIX}created_invalid`;
      const res = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: createdUsername, role: 'superadmin', password: TEST_PASSWORD }),
      });
      const row = await findByUsername(createdUsername);
      if (res.status === 400 && !row) {
        pass('j', 'Admin POST with an invalid role returns 400 and creates nothing');
      } else {
        fail('j', 'Invalid role must return 400 and not create a row', `status=${res.status}, rowCreated=${!!row}`);
      }
    }

    // ── Case k: DELETE /api/users/:id still admin-only ────────────────────────
    {
      const victim = await createUser(`${PREFIX}delete_victim`, 'student');
      const { cookie: studentCookie } = await login(base, studentUsername, TEST_PASSWORD);
      const forbidden = await fetch(`${usersBase}/${victim}`, { method: 'DELETE', headers: { Cookie: studentCookie } });
      const stillExistsAfterStudent = await userExists(victim);

      const allowed = await fetch(`${usersBase}/${victim}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
      const stillExistsAfterAdmin = await userExists(victim);

      if (forbidden.status === 403 && stillExistsAfterStudent && allowed.status === 200 && !stillExistsAfterAdmin) {
        pass('k', 'DELETE /api/users/:id remains admin-only (student 403, admin 200)');
      } else {
        fail('k', 'DELETE must stay admin-only', `studentStatus=${forbidden.status}, adminStatus=${allowed.status}, stillExistsAfterStudent=${stillExistsAfterStudent}, stillExistsAfterAdmin=${stillExistsAfterAdmin}`);
      }
    }

    // ── Case l: last-remaining-admin guard still works ────────────────────────
    {
      // At this point our only temp admin is adminUsername's account.
      // Confirm it's blocked from self-deleting when it's the only admin
      // in this environment (baselineAdmins measured before any temp admins).
      const adminRow = await findByUsername(adminUsername);
      const countBeforeSelfDelete = await adminCount();
      const res = await fetch(`${usersBase}/${adminRow.id}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
      const stillExists = await userExists(adminRow.id);

      if (baselineAdmins === 0) {
        if (res.status === 400 && stillExists) {
          pass('l', `Last-remaining-admin guard still blocks self-delete (400, count was ${countBeforeSelfDelete})`);
        } else {
          fail('l', 'Last-remaining-admin guard must still block delete', `status=${res.status}, stillExists=${stillExists}, adminCountBefore=${countBeforeSelfDelete}`);
        }
      } else {
        console.log(`[l] SKIP — ${baselineAdmins} pre-existing admin(s) in this environment; cannot deterministically test the last-admin block without touching real users`);
      }
    }

    // Fresh admin for the remaining cases — case l may have altered the
    // original admin account's state (deleted, in the atypical environment
    // where real admins already exist), so don't rely on adminCookie after it.
    const admin2Username = `${PREFIX}admin2`;
    await createUser(admin2Username, 'admin');
    const { cookie: admin2Cookie } = await login(base, admin2Username, TEST_PASSWORD);

    // ── Case m: admin creates a login-ready user; that user can log in ───────
    {
      const newUsername = `${PREFIX}loginready`;
      const newPassword = 'a-fresh-password-123';
      const createRes = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin2Cookie },
        body: JSON.stringify({ username: newUsername, role: 'student', password: newPassword }),
      });
      const createBody = await createRes.json();
      const loginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, password: newPassword }),
      });
      const loginBody = await loginRes.json();
      if (
        createRes.status === 201 && !('password_hash' in createBody) &&
        loginRes.status === 200 && loginBody.username === newUsername
      ) {
        pass('m', 'Admin-created user has a working password and password_hash is never returned (201 → login 200)');
      } else {
        fail('m', 'Admin-created user must be able to log in immediately, without password_hash leaking', `createStatus=${createRes.status}, createBody=${JSON.stringify(createBody)}, loginStatus=${loginRes.status}`);
      }
    }

    // ── Case n: missing password is rejected ──────────────────────────────────
    {
      const newUsername = `${PREFIX}nopassword`;
      const res = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin2Cookie },
        body: JSON.stringify({ username: newUsername, role: 'student' }),
      });
      const row = await findByUsername(newUsername);
      if (res.status === 400 && !row) {
        pass('n', 'Missing password is rejected (400, no row created)');
      } else {
        fail('n', 'Missing password must be rejected', `status=${res.status}, rowCreated=${!!row}`);
      }
    }

    // ── Case o: too-short password is rejected ────────────────────────────────
    {
      const newUsername = `${PREFIX}shortpassword`;
      const res = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin2Cookie },
        body: JSON.stringify({ username: newUsername, role: 'student', password: 'short' }),
      });
      const row = await findByUsername(newUsername);
      if (res.status === 400 && !row) {
        pass('o', 'Password shorter than 8 characters is rejected (400, no row created)');
      } else {
        fail('o', 'Too-short password must be rejected', `status=${res.status}, rowCreated=${!!row}`);
      }
    }

    // ── Case p: duplicate username handling still works ───────────────────────
    {
      const dupUsername = `${PREFIX}duplicate`;
      const firstRes = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin2Cookie },
        body: JSON.stringify({ username: dupUsername, role: 'student', password: TEST_PASSWORD }),
      });
      const secondRes = await fetch(usersBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin2Cookie },
        body: JSON.stringify({ username: dupUsername, role: 'student', password: TEST_PASSWORD }),
      });
      if (firstRes.status === 201 && secondRes.status === 409) {
        pass('p', 'Duplicate username still returns 409 on the second attempt');
      } else {
        fail('p', 'Duplicate username must return 409', `firstStatus=${firstRes.status}, secondStatus=${secondRes.status}`);
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
