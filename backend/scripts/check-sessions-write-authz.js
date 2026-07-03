'use strict';

/**
 * Authorization layer verification for the session write routes
 * (Step 6e-3b): POST /api/sessions, PATCH /api/sessions/:id,
 * PATCH /api/sessions/:id/complete, PATCH /api/sessions/:id/open,
 * DELETE /api/sessions/:id.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the sessions router, mounted the same way as in src/index.js) on
 * an ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie — userId is never sent by the client; every route
 * must resolve it from the session and must not honor a spoofed body.userId
 * or act on a session belonging to someone else.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:sessions-write-authz
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const sessionsRouter = require('../src/routes/sessions');

const PREFIX = '_sesswrite_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-sessions-write-authz-script-only';
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

async function sessionExists(id) {
  const r = await pool.query('SELECT id FROM learning_sessions WHERE id = $1', [id]);
  return r.rows.length > 0;
}

async function sessionOwner(id) {
  const r = await pool.query('SELECT user_id, name FROM learning_sessions WHERE id = $1', [id]);
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
    app.use('/api/sessions', sessionsRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const sessionsBase = `${base}/api/sessions`;

    // ── Setup: userA (attacker/self), userB (victim) ──────────────────────────
    const userAUsername = `${PREFIX}userA`;
    const userBUsername = `${PREFIX}userB`;
    const userAId = await createUser(userAUsername);
    const userBId = await createUser(userBUsername);

    // ── Case 1: unauthenticated create/update/complete/open/delete → 401 ─────
    {
      const createRes = await fetch(sessionsBase, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${PREFIX}unauth` }),
      });
      const someSid = await createSession(userBId, `${PREFIX}unauth_target`);
      const updateRes = await fetch(`${sessionsBase}/${someSid}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${PREFIX}renamed` }),
      });
      const completeRes = await fetch(`${sessionsBase}/${someSid}/complete`, { method: 'PATCH' });
      const openRes     = await fetch(`${sessionsBase}/${someSid}/open`, { method: 'PATCH' });
      const deleteRes   = await fetch(`${sessionsBase}/${someSid}`, { method: 'DELETE' });

      const allUnauthorized = [createRes, updateRes, completeRes, openRes, deleteRes].every(r => r.status === 401);
      const stillExists = await sessionExists(someSid);
      if (allUnauthorized && stillExists) {
        pass('1', 'Unauthenticated create/update/complete/open/delete all return 401 (session untouched)');
      } else {
        fail('1', 'All unauthenticated session writes must return 401', `statuses=${[createRes, updateRes, completeRes, openRes, deleteRes].map(r => r.status)}, stillExists=${stillExists}`);
      }
    }

    // ── Case 2: logged-in user can create their own session ──────────────────
    let userACreatedSessionId;
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(sessionsBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `${PREFIX}userA_created` }),
      });
      const body = await res.json();
      userACreatedSessionId = body.session?.id;
      const owner = await sessionOwner(userACreatedSessionId);
      if (res.status === 201 && owner?.user_id === userAId) {
        pass('2', 'Logged-in user can create their own session (201, correct owner)');
      } else {
        fail('2', 'Logged-in user must be able to create a session', `status=${res.status}, owner=${JSON.stringify(owner)}`);
      }
    }

    // ── Case 3: spoofed userId in create body is ignored ──────────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(sessionsBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ userId: userBId, name: `${PREFIX}spoofed_owner` }),
      });
      const body = await res.json();
      const owner = await sessionOwner(body.session?.id);
      if (res.status === 201 && owner?.user_id === userAId) {
        pass('3', "Spoofed userId in create body is ignored — session is owned by the real logged-in user");
      } else {
        fail('3', 'Spoofed userId must be ignored on create', `status=${res.status}, owner=${JSON.stringify(owner)}`);
      }
    }

    // ── Case 4: logged-in user can update/complete/open/delete their own session
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const updateRes = await fetch(`${sessionsBase}/${userACreatedSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `${PREFIX}userA_renamed` }),
      });
      const updateBody = await updateRes.json();
      const openRes = await fetch(`${sessionsBase}/${userACreatedSessionId}/open`, { method: 'PATCH', headers: { Cookie: cookie } });

      if (updateRes.status === 200 && updateBody.session?.name === `${PREFIX}userA_renamed` && openRes.status === 200) {
        pass('4', "Logged-in user can update and open their own session");
      } else {
        fail('4', 'Logged-in user must be able to update/open their own session', `updateStatus=${updateRes.status}, openStatus=${openRes.status}, name=${updateBody.session?.name}`);
      }
    }

    // ── Case 5: user cannot update/complete/open/delete another user's session
    {
      const victimSessionId = await createSession(userBId, `${PREFIX}victim_session`);
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);

      const updateRes = await fetch(`${sessionsBase}/${victimSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `${PREFIX}hijacked` }),
      });
      const completeRes = await fetch(`${sessionsBase}/${victimSessionId}/complete`, { method: 'PATCH', headers: { Cookie: cookie } });
      const openRes     = await fetch(`${sessionsBase}/${victimSessionId}/open`, { method: 'PATCH', headers: { Cookie: cookie } });
      const deleteRes   = await fetch(`${sessionsBase}/${victimSessionId}`, { method: 'DELETE', headers: { Cookie: cookie } });

      const all404 = [updateRes, completeRes, openRes, deleteRes].every(r => r.status === 404);
      const ownerUnchanged = (await sessionOwner(victimSessionId))?.user_id === userBId;
      const nameUnchanged  = (await sessionOwner(victimSessionId))?.name === `${PREFIX}victim_session`;

      if (all404 && ownerUnchanged && nameUnchanged) {
        pass('5', "User cannot update/complete/open/delete another user's session (all 404, untouched)");
      } else {
        fail('5', "Another user's session must be fully protected", `statuses=${[updateRes, completeRes, openRes, deleteRes].map(r => r.status)}, ownerUnchanged=${ownerUnchanged}, nameUnchanged=${nameUnchanged}`);
      }
    }

    // ── Case 6: delete removes only the caller's own session/progress data ───
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const deleteRes = await fetch(`${sessionsBase}/${userACreatedSessionId}`, { method: 'DELETE', headers: { Cookie: cookie } });
      const deletedGone = !(await sessionExists(userACreatedSessionId));

      // Confirm userB's sessions were never touched by any of the above.
      const victimStillExists = await sessionExists(await (async () => {
        const r = await pool.query(
          "SELECT id FROM learning_sessions WHERE user_id = $1 AND name = $2",
          [userBId, `${PREFIX}victim_session`]
        );
        return r.rows[0]?.id;
      })());

      if (deleteRes.status === 200 && deletedGone && victimStillExists) {
        pass('6', "Delete removes only the caller's own session; other users' sessions remain untouched");
      } else {
        fail('6', 'Delete must be scoped to the caller\'s own session only', `deleteStatus=${deleteRes.status}, deletedGone=${deletedGone}, victimStillExists=${victimStillExists}`);
      }
    }

    // ── Case 7: logged-in user can complete their own session ─────────────────
    // A difficulty filter matching zero real tasks makes the "every in-scope
    // task was run" precondition trivially true, so completion succeeds
    // without needing to seed 221 real task attempts.
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const createRes = await fetch(sessionsBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `${PREFIX}completable`, difficulties: ['nonexistent-difficulty-xyz'] }),
      });
      const createBody = await createRes.json();
      const completableSessionId = createBody.session?.id;

      const completeRes = await fetch(`${sessionsBase}/${completableSessionId}/complete`, { method: 'PATCH', headers: { Cookie: cookie } });
      const completeBody = await completeRes.json();

      if (completeRes.status === 200 && completeBody.status === 'completed') {
        pass('7', "Logged-in user can complete their own session (200, status=completed)");
      } else {
        fail('7', 'Logged-in user must be able to complete their own session', `createStatus=${createRes.status}, completeStatus=${completeRes.status}, body=${JSON.stringify(completeBody)}`);
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
