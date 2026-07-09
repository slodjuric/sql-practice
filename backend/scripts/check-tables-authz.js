'use strict';

/**
 * Authorization layer verification for the table browser routes:
 *   GET /api/tables?sessionId=N
 *   GET /api/tables/:tableName/columns?sessionId=N
 *   GET /api/tables/:tableName/preview?sessionId=N
 *
 * These routes previously had NO authentication at all — any caller could
 * pass an arbitrary ?sessionId= and browse table metadata/preview rows with
 * no login. This script pins down the fix: login is required (401), and a
 * provided sessionId is authorized via canAccessStudent against the
 * session's owner (admin any; mentor own or assigned student's; student only
 * their own) — the same "fetch session, then canAccessStudent" pattern
 * GET /api/sessions/:id/filters already uses.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the tables router, mounted the same way as in src/index.js) on an
 * ephemeral port. Authenticates via real POST /api/auth/login and carries the
 * resulting cookie — same style as the other check-*-authz.js scripts.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:tables-authz
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const tablesRouter = require('../src/routes/tables');

const PREFIX = '_tablesauthz_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-tables-authz-script-only';
const TEST_PASSWORD = 'test-password-123456';
const KNOWN_TABLE = 'students'; // exists in the academic schema (backend/db/schemas/academic.sql)

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
  await pool.query(`DELETE FROM learning_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)`, [`${PREFIX}%`]);
  await pool.query('DELETE FROM mentor_assignments WHERE mentor_id IN (SELECT id FROM users WHERE username LIKE $1) OR student_id IN (SELECT id FROM users WHERE username LIKE $1)', [`${PREFIX}%`]);
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username, role) {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  const r = await pool.query(
    'INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [username, role, hash]
  );
  return { id: r.rows[0].id, username, role };
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
    app.use('/api/tables', tablesRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const tablesBase = `${base}/api/tables`;

    // ── Setup ──────────────────────────────────────────────────────────────
    const admin             = await createUser(`${PREFIX}admin`,      'admin');
    const mentor             = await createUser(`${PREFIX}mentor`,      'mentor');
    const assignedStudent     = await createUser(`${PREFIX}assigned`,    'student');
    const unassignedStudent   = await createUser(`${PREFIX}unassigned`,  'student');
    const otherStudent        = await createUser(`${PREFIX}other`,       'student');

    await pool.query(
      'INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2)',
      [mentor.id, assignedStudent.id]
    );

    const assignedSessionId   = await createSession(assignedStudent.id,   `${PREFIX}session_assigned`);
    const unassignedSessionId = await createSession(unassignedStudent.id, `${PREFIX}session_unassigned`);

    // ── Case 1-3: unauthenticated requests → 401 ──────────────────────────
    {
      const res = await fetch(`${tablesBase}?sessionId=${assignedSessionId}`);
      if (res.status === 401) {
        pass('1', 'Unauthenticated GET /api/tables returns 401');
      } else {
        fail('1', 'Unauthenticated GET /api/tables must return 401', `status=${res.status}`);
      }
    }
    {
      const res = await fetch(`${tablesBase}/${KNOWN_TABLE}/columns?sessionId=${assignedSessionId}`);
      if (res.status === 401) {
        pass('2', 'Unauthenticated GET /api/tables/:tableName/columns returns 401');
      } else {
        fail('2', 'Unauthenticated GET /api/tables/:tableName/columns must return 401', `status=${res.status}`);
      }
    }
    {
      const res = await fetch(`${tablesBase}/${KNOWN_TABLE}/preview?sessionId=${assignedSessionId}`);
      if (res.status === 401) {
        pass('3', 'Unauthenticated GET /api/tables/:tableName/preview returns 401');
      } else {
        fail('3', 'Unauthenticated GET /api/tables/:tableName/preview must return 401', `status=${res.status}`);
      }
    }

    // ── Case 4: student can access table info for their own session ──────
    {
      const { cookie } = await login(base, assignedStudent.username, TEST_PASSWORD);
      const res = await fetch(`${tablesBase}?sessionId=${assignedSessionId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && Array.isArray(body) && body.includes(KNOWN_TABLE)) {
        pass('4', "Student can list tables for their own session (200, includes '" + KNOWN_TABLE + "')");
      } else {
        fail('4', 'Student must be able to list tables for their own session', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 5: student cannot access another user's session table info ──
    {
      const { cookie } = await login(base, otherStudent.username, TEST_PASSWORD);
      const res = await fetch(`${tablesBase}?sessionId=${assignedSessionId}`, { headers: { Cookie: cookie } });
      if (res.status === 403) {
        pass('5a', "Student is denied (403) listing tables for another user's session");
      } else {
        fail('5a', "Student must be denied access to another user's session", `status=${res.status}`);
      }

      const res2 = await fetch(`${tablesBase}/${KNOWN_TABLE}/preview?sessionId=${assignedSessionId}`, { headers: { Cookie: cookie } });
      if (res2.status === 403) {
        pass('5b', "Student is denied (403) previewing a table for another user's session");
      } else {
        fail('5b', "Student must be denied preview access to another user's session", `status=${res2.status}`);
      }
    }

    // ── Case 6: mentor can access an ASSIGNED student's session ──────────
    {
      const { cookie } = await login(base, mentor.username, TEST_PASSWORD);
      const res = await fetch(`${tablesBase}?sessionId=${assignedSessionId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && Array.isArray(body) && body.includes(KNOWN_TABLE)) {
        pass('6', "Mentor can list tables for an assigned student's session (200)");
      } else {
        fail('6', "Mentor must be able to access an assigned student's session tables", `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 7: mentor cannot access an UNASSIGNED student's session ─────
    {
      const { cookie } = await login(base, mentor.username, TEST_PASSWORD);
      const res = await fetch(`${tablesBase}?sessionId=${unassignedSessionId}`, { headers: { Cookie: cookie } });
      if (res.status === 403) {
        pass('7', "Mentor is denied (403) listing tables for an unassigned student's session");
      } else {
        fail('7', "Mentor must be denied access to an unassigned student's session", `status=${res.status}`);
      }
    }

    // ── Case 8: admin can access ANY session's table info ─────────────────
    {
      const { cookie } = await login(base, admin.username, TEST_PASSWORD);
      const res = await fetch(`${tablesBase}?sessionId=${unassignedSessionId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && Array.isArray(body) && body.includes(KNOWN_TABLE)) {
        pass('8', "Admin can list tables for any session, including an unassigned student's (200)");
      } else {
        fail('8', 'Admin must be able to access any session\'s tables', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 9: normal end-to-end table preview flow still works ─────────
    {
      const { cookie } = await login(base, assignedStudent.username, TEST_PASSWORD);

      const listRes  = await fetch(`${tablesBase}?sessionId=${assignedSessionId}`, { headers: { Cookie: cookie } });
      const listBody = await listRes.json();

      const colRes  = await fetch(`${tablesBase}/${KNOWN_TABLE}/columns?sessionId=${assignedSessionId}`, { headers: { Cookie: cookie } });
      const colBody = await colRes.json();

      const previewRes  = await fetch(`${tablesBase}/${KNOWN_TABLE}/preview?sessionId=${assignedSessionId}`, { headers: { Cookie: cookie } });
      const previewBody = await previewRes.json();

      const ok =
        listRes.status === 200 && Array.isArray(listBody) && listBody.includes(KNOWN_TABLE) &&
        colRes.status === 200 && Array.isArray(colBody) && colBody.length > 0 &&
        previewRes.status === 200 && Array.isArray(previewBody.rows) && Array.isArray(previewBody.columns) &&
        typeof previewBody.rowCount === 'number';

      if (ok) {
        pass('9', 'Full list → columns → preview flow works normally for a logged-in, authorized user');
      } else {
        fail('9', 'Normal table browser flow must keep working after login', `list=${listRes.status}, columns=${colRes.status}, preview=${previewRes.status}, previewBody=${JSON.stringify(previewBody)}`);
      }
    }

    // ── Bonus: no sessionId at all still requires login, then falls back
    // to the default academic schema (unchanged pre-existing behavior) ────
    {
      const res = await fetch(`${tablesBase}`);
      if (res.status === 401) {
        pass('10a', 'Unauthenticated GET /api/tables with no sessionId still returns 401');
      } else {
        fail('10a', 'Must require login even with no sessionId', `status=${res.status}`);
      }

      const { cookie } = await login(base, otherStudent.username, TEST_PASSWORD);
      const res2 = await fetch(`${tablesBase}`, { headers: { Cookie: cookie } });
      const body2 = await res2.json();
      if (res2.status === 200 && Array.isArray(body2) && body2.includes(KNOWN_TABLE)) {
        pass('10b', 'Logged-in user with no sessionId still gets the default academic schema (200)');
      } else {
        fail('10b', 'Logged-in user with no sessionId must still resolve a default schema', `status=${res2.status}, body=${JSON.stringify(body2)}`);
      }
    }

    // ── Bonus: a nonexistent sessionId is rejected with 404, not a leak ──
    {
      const { cookie } = await login(base, otherStudent.username, TEST_PASSWORD);
      const res = await fetch(`${tablesBase}?sessionId=99999999`, { headers: { Cookie: cookie } });
      if (res.status === 404) {
        pass('11', 'A nonexistent sessionId returns 404, not a schema leak');
      } else {
        fail('11', 'A nonexistent sessionId must return 404', `status=${res.status}`);
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
