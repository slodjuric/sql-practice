'use strict';

/**
 * Authorization layer verification for POST /api/query and
 * POST /api/tasks/:id/check (Step 6e-4).
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the query router + the tasks router, mounted the same way as in
 * src/index.js) on an ephemeral port. Authenticates via real
 * POST /api/auth/login and carries the resulting cookie — userId is never
 * sent by the client; both routes must resolve it from the session and must
 * not honor a spoofed body.userId or write to another user's progress via a
 * foreign sessionId.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:query-tasks-authz
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const queryRouter = require('../src/routes/query');
const tasksRouter = require('../src/routes/tasks');

const PREFIX = '_querytasks_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-query-tasks-authz-script-only';
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
  await pool.query(
    "DELETE FROM learning_sessions WHERE name LIKE $1",
    [`${PREFIX}%`]
  );
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username, role = 'student') {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  const r = await pool.query(
    'INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [username, role, hash]
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

async function attemptCountForUser(userId) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM task_attempts WHERE user_id = $1', [userId]);
  return r.rows[0].n;
}

async function progressRow(userId, sessionId, taskId) {
  const r = await pool.query(
    'SELECT * FROM user_task_progress WHERE user_id = $1 AND session_id = $2 AND task_id = $3',
    [userId, sessionId, taskId]
  );
  return r.rows[0] || null;
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
    app.use('/api/query', queryRouter);
    app.use('/api/tasks', tasksRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const queryBase = `${base}/api/query`;
    const tasksBase  = `${base}/api/tasks`;

    // ── Setup: userA (self), userB (victim) ───────────────────────────────────
    const userAUsername = `${PREFIX}userA`;
    const userBUsername = `${PREFIX}userB`;
    const userAId = await createUser(userAUsername);
    const userBId = await createUser(userBUsername);
    const userASessionId = await createSession(userAId, `${PREFIX}a_session`);
    const userBSessionId = await createSession(userBId, `${PREFIX}b_session`);

    // ── Case 1: unauthenticated check → 401 ───────────────────────────────────
    {
      const res = await fetch(`${tasksBase}/${TASK_ID}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userSql: 'SELECT 1', sessionId: userASessionId }),
      });
      if (res.status === 401) {
        pass('1', 'Unauthenticated POST /:id/check returns 401');
      } else {
        fail('1', 'Unauthenticated check must return 401', `status=${res.status}`);
      }
    }

    // ── Case 2: logged-in user can check their own task/session ──────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${tasksBase}/${TASK_ID}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ userSql: 'SELECT 1', sessionId: userASessionId }),
      });
      const body = await res.json();
      const row = await progressRow(userAId, userASessionId, TASK_ID);
      if (res.status === 200 && 'isCorrect' in body && row) {
        pass('2', 'Logged-in user can check their own task/session (200, attempt recorded for them)');
      } else {
        fail('2', 'Logged-in user must be able to check their own task', `status=${res.status}, body=${JSON.stringify(body)}, row=${JSON.stringify(row)}`);
      }
    }

    // ── Case 3: spoofed userId in check body is ignored ───────────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const beforeVictimAttempts = await attemptCountForUser(userBId);
      const res = await fetch(`${tasksBase}/${TASK_ID}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ userId: userBId, userSql: 'SELECT 2', sessionId: userASessionId }),
      });
      const afterVictimAttempts = await attemptCountForUser(userBId);
      const row = await progressRow(userAId, userASessionId, TASK_ID);
      if (res.status === 200 && afterVictimAttempts === beforeVictimAttempts && row) {
        pass('3', "Spoofed userId in check body is ignored — attempt recorded under the real logged-in user, not the victim");
      } else {
        fail('3', 'Spoofed userId must be ignored', `status=${res.status}, victimAttemptsBefore=${beforeVictimAttempts}, victimAttemptsAfter=${afterVictimAttempts}`);
      }
    }

    // ── Case 4: foreign sessionId cannot write to another user's progress ────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const beforeVictimAttempts = await attemptCountForUser(userBId);
      const res = await fetch(`${tasksBase}/${TASK_ID}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ userSql: 'SELECT 3', sessionId: userBSessionId }),
      });
      const afterVictimAttempts = await attemptCountForUser(userBId);
      const victimProgressRow = await progressRow(userBId, userBSessionId, TASK_ID);
      // resolveSessionId rejects userB's session for userA, so resolvedSessionId
      // is null — the check still runs (result computed) but nothing is recorded.
      if (res.status === 200 && afterVictimAttempts === beforeVictimAttempts && !victimProgressRow) {
        pass('4', "A foreign sessionId cannot write to another user's progress/attempts (nothing recorded for the victim)");
      } else {
        fail('4', "Foreign sessionId must not let an attacker write to the victim's progress", `status=${res.status}, victimAttemptsBefore=${beforeVictimAttempts}, victimAttemptsAfter=${afterVictimAttempts}, victimRow=${JSON.stringify(victimProgressRow)}`);
      }
    }

    // ── Case 5: unauthenticated query attempt write → 401 ─────────────────────
    // (taskId present → this is the recording path, so login is required)
    {
      const res = await fetch(queryBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: 'SELECT 1', taskId: TASK_ID, sessionId: userASessionId }),
      });
      if (res.status === 401) {
        pass('5', 'Unauthenticated POST /api/query with taskId (recording path) returns 401');
      } else {
        fail('5', 'Unauthenticated query attempt write must return 401', `status=${res.status}`);
      }
    }

    // ── Case 5b: unauthenticated POST /api/query WITHOUT taskId → 401 ─────────
    // This is the actual vulnerability: before this fix, omitting taskId let
    // an anonymous caller execute arbitrary SELECT SQL through the backend
    // (the free-form playground path recorded nothing, so it skipped the old
    // `taskId && !actingUser` gate entirely). Login is now required
    // unconditionally, regardless of taskId.
    {
      const res = await fetch(queryBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: 'SELECT 1' }),
      });
      const body = await res.json();
      if (res.status === 401 && body?.error === 'Authentication required') {
        pass('5b', 'Unauthenticated POST /api/query WITHOUT taskId returns 401 (body: { error: "Authentication required" })');
      } else {
        fail('5b', 'Unauthenticated POST /api/query without taskId must return 401', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 6: logged-in query attempt writes only for the caller's own session
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const beforeVictimAttempts = await attemptCountForUser(userBId);

      // Own session: should record.
      const ownRes = await fetch(queryBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ sql: 'SELECT 1', taskId: TASK_ID, sessionId: userASessionId }),
      });

      // Foreign session: should execute but not record for the victim.
      const foreignRes = await fetch(queryBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ sql: 'SELECT 1', taskId: TASK_ID, sessionId: userBSessionId }),
      });

      const afterVictimAttempts = await attemptCountForUser(userBId);
      const ownAttemptRow = await pool.query(
        'SELECT id FROM task_attempts WHERE user_id = $1 AND session_id = $2 AND task_id = $3',
        [userAId, userASessionId, TASK_ID]
      );

      if (ownRes.status === 200 && foreignRes.status === 200 && ownAttemptRow.rows.length > 0 && afterVictimAttempts === beforeVictimAttempts) {
        pass('6', "Query attempt recording works for the caller's own session and never writes to another user's session");
      } else {
        fail('6', 'Query attempt writes must be scoped to the caller\'s own session only', `ownStatus=${ownRes.status}, foreignStatus=${foreignRes.status}, ownRows=${ownAttemptRow.rows.length}, victimAttemptsBefore=${beforeVictimAttempts}, victimAttemptsAfter=${afterVictimAttempts}`);
      }
    }

    // ── Cases 7-9: logged-in student/mentor/admin can still use the
    // free-form Query Playground (no taskId, nothing recorded) exactly as
    // before — the auth fix must not affect any logged-in role's normal use.
    {
      const roleUsers = [
        { id: '7', role: 'student', username: `${PREFIX}playgroundStudent` },
        { id: '8', role: 'mentor',  username: `${PREFIX}playgroundMentor` },
        { id: '9', role: 'admin',   username: `${PREFIX}playgroundAdmin` },
      ];
      for (const { id, role, username } of roleUsers) {
        await createUser(username, role);
        const { cookie } = await login(base, username, TEST_PASSWORD);
        const res = await fetch(queryBase, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ sql: 'SELECT 1 AS n' }),
        });
        const body = await res.json();
        if (res.status === 200 && body?.rows?.[0]?.n !== undefined) {
          pass(id, `Logged-in ${role} POST /api/query without taskId works as before (200, SELECT-only)`);
        } else {
          fail(id, `Logged-in ${role} without taskId must still work`, `status=${res.status}, body=${JSON.stringify(body)}`);
        }
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
