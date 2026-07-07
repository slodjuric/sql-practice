'use strict';

/**
 * Authorization layer verification for DELETE /api/users/:id.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the users router, mounted the same way as in src/index.js) on an
 * ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie on subsequent requests — no x-acting-user-id header,
 * matching how getActingUser() resolves identity in production.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:authz
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const usersRouter = require('../src/routes/users');

const PREFIX = '_authz_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-authz-script-only';
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
  // task_attempts.user_id and user_task_progress.user_id have no ON DELETE
  // action of their own (unlike their session_id FKs, which cascade from
  // learning_sessions) — a leftover row from a failed case (e.g. case g,
  // which seeds an owned session with attempt/progress rows) would otherwise
  // make the final `DELETE FROM users` below fail with a FK violation. Clean
  // child rows first, same order the real DELETE /api/users/:id route uses.
  await pool.query(`
    DELETE FROM task_attempts WHERE session_id IN (
      SELECT id FROM learning_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)
    )`, [`${PREFIX}%`]);
  await pool.query(`
    DELETE FROM user_task_progress WHERE session_id IN (
      SELECT id FROM learning_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)
    )`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM learning_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)`, [`${PREFIX}%`]);
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

async function userExists(id) {
  const r = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
  return r.rows.length > 0;
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

    // Baseline admin count in this environment, measured before we create any
    // temp admins of our own — lets the last-admin-guard case adapt instead
    // of assuming a fresh DB with zero pre-existing admins.
    const baselineAdmins = await adminCount();

    // ── Setup: one logged-in-capable acting user per role, plus victims ──────
    const adminUsername   = `${PREFIX}admin`;
    const mentorUsername  = `${PREFIX}mentor`;
    const studentUsername = `${PREFIX}student`;
    const adminId   = await createUser(adminUsername,   'admin');
    const mentorId  = await createUser(mentorUsername,  'mentor');
    const studentId = await createUser(studentUsername, 'student');

    const victimForAdmin   = await createUser(`${PREFIX}victim_admin`,   'student', false);
    const victimForStudent = await createUser(`${PREFIX}victim_student`, 'student', false);
    const victimForMentor  = await createUser(`${PREFIX}victim_mentor`,  'student', false);
    const victimForMissing = await createUser(`${PREFIX}victim_missing`, 'student', false);

    // ── Case a: logged-in admin can delete a test user ────────────────────────
    let adminLoginBody;
    {
      const { res: loginRes, body, cookie } = await login(base, adminUsername, TEST_PASSWORD);
      adminLoginBody = body;
      const delRes = await fetch(`${usersBase}/${victimForAdmin}`, { method: 'DELETE', headers: { Cookie: cookie } });
      const stillExists = await userExists(victimForAdmin);
      if (loginRes.status === 200 && delRes.status === 200 && !stillExists) {
        pass('a', 'Logged-in admin can delete a test user (200, row removed)');
      } else {
        fail('a', 'Logged-in admin must be able to delete a user', `loginStatus=${loginRes.status}, delStatus=${delRes.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case b: logged-in student cannot delete a user ─────────────────────────
    {
      const { cookie } = await login(base, studentUsername, TEST_PASSWORD);
      const res = await fetch(`${usersBase}/${victimForStudent}`, { method: 'DELETE', headers: { Cookie: cookie } });
      const stillExists = await userExists(victimForStudent);
      if (res.status === 403 && stillExists) {
        pass('b', 'Logged-in student cannot delete a user (403, row untouched)');
      } else {
        fail('b', 'Logged-in student must be forbidden from deleting a user', `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case c: logged-in mentor cannot delete a user ───────────────────────────
    {
      const { cookie } = await login(base, mentorUsername, TEST_PASSWORD);
      const res = await fetch(`${usersBase}/${victimForMentor}`, { method: 'DELETE', headers: { Cookie: cookie } });
      const stillExists = await userExists(victimForMentor);
      if (res.status === 403 && stillExists) {
        pass('c', 'Logged-in mentor cannot delete a user (403, row untouched)');
      } else {
        fail('c', 'Logged-in mentor must be forbidden from deleting a user', `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case d: no login at all returns 401 ─────────────────────────────────────
    {
      const res = await fetch(`${usersBase}/${victimForMissing}`, { method: 'DELETE' });
      const stillExists = await userExists(victimForMissing);
      if (res.status === 401 && stillExists) {
        pass('d', 'No login at all returns 401 (row untouched)');
      } else {
        fail('d', 'No login must return 401', `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case e: last-admin guard still works (via real login, not header) ────
    const { cookie: adminCookie } = await login(base, adminUsername, TEST_PASSWORD);
    const admin2Id = await createUser(`${PREFIX}admin2`, 'admin', false);
    {
      const res = await fetch(`${usersBase}/${admin2Id}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
      const stillExists = await userExists(admin2Id);
      if (res.status === 200 && !stillExists) {
        pass('e1', 'Logged-in admin can delete another admin while more than one admin exists (200, row removed)');
      } else {
        fail('e1', 'Deleting an admin must succeed when another admin remains', `status=${res.status}, stillExists=${stillExists}`);
      }
    }
    {
      const countBeforeSelfDelete = await adminCount();
      const res = await fetch(`${usersBase}/${adminId}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
      const stillExists = await userExists(adminId);
      if (baselineAdmins === 0) {
        if (res.status === 400 && stillExists) {
          pass('e2', `Deleting the last remaining admin is blocked (400, row untouched, count was ${countBeforeSelfDelete})`);
        } else {
          fail('e2', 'Deleting the last remaining admin must be blocked', `status=${res.status}, stillExists=${stillExists}, adminCountBefore=${countBeforeSelfDelete}`);
        }
      } else {
        console.log(`[e2] SKIP — ${baselineAdmins} pre-existing admin(s) in this environment; cannot deterministically test the last-admin block without touching real users`);
      }
    }

    // ── Case f: password_hash is never exposed ────────────────────────────────
    {
      const usersListRes = await fetch(usersBase, { headers: { Cookie: adminCookie } });
      const usersList = await usersListRes.json();
      const leaked = ('password_hash' in adminLoginBody) || (Array.isArray(usersList) && usersList.some(u => 'password_hash' in u));
      if (!leaked) {
        pass('f', 'password_hash is never present in login or users-list responses');
      } else {
        fail('f', 'password_hash must never be returned', `loginBody=${JSON.stringify(adminLoginBody)}`);
      }
    }

    // ── Case g: deleting a user who OWNS a session cascades their own data ────
    // Every prior case's victim owned no sessions at all, so none of them
    // actually exercised the cascade the route documents (task_attempts,
    // user_task_progress, and the session row itself, all scoped to the
    // deleted user's own id). This is the one case that seeds a real owned
    // session with attempt/progress rows and confirms all three are gone
    // afterward, not just the user row.
    //
    // Uses a freshly created admin + fresh login rather than the original
    // adminCookie/adminId — case e2 above unconditionally sends a DELETE for
    // adminId (only the pass/fail *assertion* is skipped when pre-existing
    // admins make the last-admin guard untestable), so in any environment
    // with a real pre-existing admin, adminId no longer exists by this point
    // and adminCookie's session is already invalid.
    const admin3Username = `${PREFIX}admin3`;
    await createUser(admin3Username, 'admin'); // withPassword defaults to true — needed to log in below
    const { cookie: admin3Cookie } = await login(base, admin3Username, TEST_PASSWORD);
    {
      const ownerId = await createUser(`${PREFIX}session_owner`, 'student', false);
      const dataset = await pool.query("SELECT id FROM datasets WHERE key = 'academic'");
      const sessionRow = await pool.query(
        `INSERT INTO learning_sessions (user_id, created_by_user_id, name, dataset_id)
         VALUES ($1, $1, $2, $3) RETURNING id`,
        [ownerId, `${PREFIX}owned_session`, dataset.rows[0].id]
      );
      const ownedSessionId = sessionRow.rows[0].id;
      await pool.query(
        `INSERT INTO task_attempts (user_id, session_id, task_id, submitted_sql, is_correct)
         VALUES ($1, $2, 1, 'SELECT 1', true)`,
        [ownerId, ownedSessionId]
      );
      await pool.query(
        `INSERT INTO user_task_progress (user_id, session_id, task_id, status, attempts_count)
         VALUES ($1, $2, 1, 'solved', 1)`,
        [ownerId, ownedSessionId]
      );

      const delRes = await fetch(`${usersBase}/${ownerId}`, { method: 'DELETE', headers: { Cookie: admin3Cookie } });
      const userGone     = !(await userExists(ownerId));
      const sessionGone  = (await pool.query('SELECT id FROM learning_sessions WHERE id = $1', [ownedSessionId])).rows.length === 0;
      const attemptsGone = (await pool.query('SELECT id FROM task_attempts WHERE session_id = $1', [ownedSessionId])).rows.length === 0;
      const progressGone = (await pool.query('SELECT id FROM user_task_progress WHERE session_id = $1', [ownedSessionId])).rows.length === 0;

      if (delRes.status === 200 && userGone && sessionGone && attemptsGone && progressGone) {
        pass('g', 'Deleting a user cascades their OWNED session, task_attempts, and user_task_progress (all gone)');
      } else {
        fail('g', 'Deleting a user must cascade their owned session/attempts/progress',
          `delStatus=${delRes.status}, userGone=${userGone}, sessionGone=${sessionGone}, attemptsGone=${attemptsGone}, progressGone=${progressGone}`);
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
