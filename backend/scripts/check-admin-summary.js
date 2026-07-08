'use strict';

/**
 * Authorization + shape verification for GET /api/users/admin-summary
 * (admin-only aggregated counts powering the User Management dashboard cards).
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * and users routers, mounted the same way as in src/index.js) on an
 * ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie on subsequent requests.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:admin-summary
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const usersRouter = require('../src/routes/users');

const PREFIX = '_adminsummary_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-admin-summary-script-only';
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

async function createUser(username, role, withPassword = true) {
  const hash = withPassword ? await bcrypt.hash(TEST_PASSWORD, 10) : null;
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

const EXPECTED_KEYS = [
  'total_users', 'admins', 'mentors', 'students',
  'active_sessions', 'completed_sessions', 'archived_sessions', 'mentor_assignments',
];

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
    const summaryUrl = `${base}/api/users/admin-summary`;

    const adminUsername   = `${PREFIX}admin`;
    const mentorUsername  = `${PREFIX}mentor`;
    const studentUsername = `${PREFIX}student`;
    await createUser(adminUsername,   'admin');
    await createUser(mentorUsername,  'mentor');
    await createUser(studentUsername, 'student');
    const { cookie: adminCookie }   = await login(base, adminUsername,   TEST_PASSWORD);
    const { cookie: mentorCookie }  = await login(base, mentorUsername,  TEST_PASSWORD);
    const { cookie: studentCookie } = await login(base, studentUsername, TEST_PASSWORD);

    // ── Case 1: anonymous → 401 ────────────────────────────────────────────
    {
      const res = await fetch(summaryUrl);
      if (res.status === 401) {
        pass('1', 'Anonymous GET /api/users/admin-summary returns 401');
      } else {
        fail('1', 'Anonymous request must return 401', `status=${res.status}`);
      }
    }

    // ── Case 2: mentor → 403 ───────────────────────────────────────────────
    {
      const res = await fetch(summaryUrl, { headers: { Cookie: mentorCookie } });
      if (res.status === 403) {
        pass('2', 'Mentor GET /api/users/admin-summary returns 403');
      } else {
        fail('2', 'Mentor request must return 403', `status=${res.status}`);
      }
    }

    // ── Case 3: student → 403 ──────────────────────────────────────────────
    {
      const res = await fetch(summaryUrl, { headers: { Cookie: studentCookie } });
      if (res.status === 403) {
        pass('3', 'Student GET /api/users/admin-summary returns 403');
      } else {
        fail('3', 'Student request must return 403', `status=${res.status}`);
      }
    }

    // ── Case 4: admin → 200, expected shape, all non-negative integers ────
    let before;
    {
      const res = await fetch(summaryUrl, { headers: { Cookie: adminCookie } });
      before = await res.json();
      const hasAllKeys = EXPECTED_KEYS.every(k => k in before);
      const allNonNegativeInts = EXPECTED_KEYS.every(k => Number.isInteger(before[k]) && before[k] >= 0);
      if (res.status === 200 && hasAllKeys && allNonNegativeInts) {
        pass('4', `Admin GET /api/users/admin-summary returns 200 with all expected keys as non-negative integers (${JSON.stringify(before)})`);
      } else {
        fail('4', 'Admin response must have the expected shape', `status=${res.status}, body=${JSON.stringify(before)}`);
      }
    }

    // ── Case 5: total_users equals admins + mentors + students ─────────────
    {
      const sumOfRoles = before.admins + before.mentors + before.students;
      if (before.total_users === sumOfRoles) {
        pass('5', `total_users (${before.total_users}) equals admins+mentors+students (${sumOfRoles})`);
      } else {
        fail('5', 'total_users must equal the sum of the three role counts', `total_users=${before.total_users}, sum=${sumOfRoles}`);
      }
    }

    // ── Case 6: creating a new student increases total_users and students
    // by exactly 1, and leaves every other count unchanged ─────────────────
    {
      await createUser(`${PREFIX}delta_student`, 'student', false);
      const res = await fetch(summaryUrl, { headers: { Cookie: adminCookie } });
      const after = await res.json();

      const deltaOk =
        after.total_users === before.total_users + 1 &&
        after.students === before.students + 1 &&
        after.admins === before.admins &&
        after.mentors === before.mentors &&
        after.active_sessions === before.active_sessions &&
        after.completed_sessions === before.completed_sessions &&
        after.archived_sessions === before.archived_sessions &&
        after.mentor_assignments === before.mentor_assignments;

      if (res.status === 200 && deltaOk) {
        pass('6', 'Creating a new student increases total_users/students by exactly 1, other counts unchanged');
      } else {
        fail('6', 'Counts must reflect the newly created student with no other side effects',
          `before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`);
      }
    }

    // ── Case 7: no raw user or session rows in the response, only counts ───
    {
      const res = await fetch(summaryUrl, { headers: { Cookie: adminCookie } });
      const body = await res.json();
      const keys = Object.keys(body);
      const onlyExpectedKeys = keys.every(k => EXPECTED_KEYS.includes(k)) && keys.length === EXPECTED_KEYS.length;
      if (onlyExpectedKeys) {
        pass('7', 'Response contains only the 8 expected aggregate keys, no raw rows');
      } else {
        fail('7', 'Response must contain only aggregate counts', `keys=${JSON.stringify(keys)}`);
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
