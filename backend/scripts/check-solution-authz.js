'use strict';

/**
 * Authorization layer verification for GET /api/tasks/:id/solution.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the tasks router, mounted the same way as in src/index.js) on an
 * ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie. No role restriction is expected here — any
 * authenticated role should be able to fetch a solution; only anonymous
 * access should be blocked.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:solution-authz
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const tasksRouter = require('../src/routes/tasks');

const PREFIX = '_solutionauthz_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-solution-authz-script-only';
const TEST_PASSWORD = 'test-password-123456';
const TASK_ID = 1; // exists in academic tasks.json

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
    app.use('/api/tasks', tasksRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const tasksBase = `${base}/api/tasks`;

    const studentUsername = `${PREFIX}student`;
    const mentorUsername  = `${PREFIX}mentor`;
    const adminUsername   = `${PREFIX}admin`;
    await createUser(studentUsername, 'student');
    await createUser(mentorUsername,  'mentor');
    await createUser(adminUsername,   'admin');

    // ── Case 1: unauthenticated solution request → 401 ────────────────────────
    {
      const res = await fetch(`${tasksBase}/${TASK_ID}/solution`);
      if (res.status === 401) {
        pass('1', 'Unauthenticated GET /:id/solution returns 401');
      } else {
        fail('1', 'Unauthenticated solution request must return 401', `status=${res.status}`);
      }
    }

    // ── Case 2: logged-in student can fetch solution ──────────────────────────
    {
      const { cookie } = await login(base, studentUsername, TEST_PASSWORD);
      const res = await fetch(`${tasksBase}/${TASK_ID}/solution`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && typeof body.solution === 'string' && body.solution.length > 0) {
        pass('2', 'Logged-in student can fetch the solution (200, non-empty solution)');
      } else {
        fail('2', 'Logged-in student must be able to fetch the solution', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 3: logged-in mentor can fetch solution (no role restriction) ────
    {
      const { cookie } = await login(base, mentorUsername, TEST_PASSWORD);
      const res = await fetch(`${tasksBase}/${TASK_ID}/solution`, { headers: { Cookie: cookie } });
      if (res.status === 200) {
        pass('3', 'Logged-in mentor can also fetch the solution (no role restriction)');
      } else {
        fail('3', 'Logged-in mentor must be able to fetch the solution', `status=${res.status}`);
      }
    }

    // ── Case 4: logged-in admin can fetch solution (no role restriction) ─────
    {
      const { cookie } = await login(base, adminUsername, TEST_PASSWORD);
      const res = await fetch(`${tasksBase}/${TASK_ID}/solution`, { headers: { Cookie: cookie } });
      if (res.status === 200) {
        pass('4', 'Logged-in admin can also fetch the solution (no role restriction)');
      } else {
        fail('4', 'Logged-in admin must be able to fetch the solution', `status=${res.status}`);
      }
    }

    // ── Case 5: nonexistent task — authenticated → 404 ────────────────────────
    {
      const { cookie } = await login(base, studentUsername, TEST_PASSWORD);
      const res = await fetch(`${tasksBase}/999999999/solution`, { headers: { Cookie: cookie } });
      if (res.status === 404) {
        pass('5', 'Nonexistent task returns 404 when authenticated');
      } else {
        fail('5', 'Nonexistent task must return 404 when authenticated', `status=${res.status}`);
      }
    }

    // ── Case 6: nonexistent task — unauthenticated → 401, not 404 ─────────────
    // Auth is checked before task existence, so anonymous callers never learn
    // whether a given task id exists.
    {
      const res = await fetch(`${tasksBase}/999999999/solution`);
      if (res.status === 401) {
        pass('6', 'Nonexistent task, unauthenticated, still returns 401 (not 404)');
      } else {
        fail('6', 'Unauthenticated request must return 401 regardless of task existence', `status=${res.status}`);
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
