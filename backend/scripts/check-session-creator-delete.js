'use strict';

/**
 * Verifies that deleting a user who *created* sessions for other users
 * (created_by_user_id) no longer fails, and no longer deletes or blocks
 * anything belonging to the real session owner.
 *
 * Before this fix, learning_sessions.created_by_user_id had no ON DELETE
 * behavior (implicit NO ACTION), so DELETE /api/users/:id on a mentor who
 * had created a session for a student would fail with a foreign key
 * violation and roll back the entire deletion. The fix adds
 * ON DELETE SET NULL to that constraint (see initDb.js) — the session (and
 * its real owner, user_id) must survive untouched, with created_by_user_id
 * simply nulled out.
 *
 * Spins up a minimal in-process Express app (session middleware + auth +
 * users + sessions routers, mounted the same way as in src/index.js) on an
 * ephemeral port. Authenticates via real POST /api/auth/login.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:session-creator-delete
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const usersRouter = require('../src/routes/users');
const sessionsRouter = require('../src/routes/sessions');

const PREFIX = '_creatordelete_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-session-creator-delete-script-only';
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
    app.use('/api/users', usersRouter);
    app.use('/api/sessions', sessionsRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;

    // ── Setup ──────────────────────────────────────────────────────────────
    const adminUsername   = `${PREFIX}admin`;
    const mentorUsername  = `${PREFIX}mentor`;
    const studentUsername = `${PREFIX}student`;

    await createUser(adminUsername, 'admin');
    const mentorId  = await createUser(mentorUsername, 'mentor');
    const studentId = await createUser(studentUsername, 'student');

    const dataset = await pool.query("SELECT id FROM datasets WHERE key = 'academic'");
    const sessionRow = await pool.query(
      `INSERT INTO learning_sessions (user_id, created_by_user_id, name, dataset_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [studentId, mentorId, `${PREFIX}studentSession`, dataset.rows[0].id]
    );
    const sessionId = sessionRow.rows[0].id;

    const { cookie: adminCookie } = await login(base, adminUsername, TEST_PASSWORD);
    const { cookie: studentCookie } = await login(base, studentUsername, TEST_PASSWORD);

    // ── Case a: session exists with expected owner/creator before delete ──────
    {
      const row = (await pool.query('SELECT user_id, created_by_user_id FROM learning_sessions WHERE id = $1', [sessionId])).rows[0];
      if (row && row.user_id === studentId && row.created_by_user_id === mentorId) {
        pass('a', `Session seeded correctly before delete: user_id=${row.user_id}, created_by_user_id=${row.created_by_user_id}`);
      } else {
        fail('a', 'Session must be seeded with student as owner, mentor as creator', `row=${JSON.stringify(row)}`);
      }
    }

    // ── Case b: deleting the mentor (creator) succeeds, not blocked by the FK ──
    {
      const res = await fetch(`${base}/api/users/${mentorId}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.success === true) {
        pass('b', 'Deleting the mentor (session creator) succeeds (200) — not blocked by the FK');
      } else {
        fail('b', 'Deleting the creator must succeed, not be blocked by created_by_user_id', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case c: mentor user row is actually gone ───────────────────────────────
    {
      const row = await pool.query('SELECT id FROM users WHERE id = $1', [mentorId]);
      if (row.rows.length === 0) {
        pass('c', 'Mentor user row no longer exists');
      } else {
        fail('c', 'Mentor user row must be deleted', `stillExists=${row.rows.length > 0}`);
      }
    }

    // ── Case d: the session itself still exists (not deleted) ─────────────────
    {
      const row = await pool.query('SELECT id FROM learning_sessions WHERE id = $1', [sessionId]);
      if (row.rows.length === 1) {
        pass('d', 'Session still exists after the creator was deleted');
      } else {
        fail('d', 'Session must not be deleted when its creator is deleted', `exists=${row.rows.length === 1}`);
      }
    }

    // ── Case e: session.user_id is still the student (owner unchanged) ────────
    // ── Case f: session.created_by_user_id is now NULL ────────────────────────
    {
      const row = (await pool.query('SELECT user_id, created_by_user_id FROM learning_sessions WHERE id = $1', [sessionId])).rows[0];
      if (row?.user_id === studentId) {
        pass('e', `Session user_id (owner) is unchanged: ${row.user_id}`);
      } else {
        fail('e', 'Session user_id must remain the student, never altered by this migration', `user_id=${row?.user_id}`);
      }
      if (row?.created_by_user_id === null) {
        pass('f', 'Session created_by_user_id is now NULL (not left dangling, not cascaded to delete)');
      } else {
        fail('f', 'Session created_by_user_id must become NULL after the creator is deleted', `created_by_user_id=${row?.created_by_user_id}`);
      }
    }

    // ── Case g: the student can still GET/see the session ─────────────────────
    {
      const res = await fetch(`${base}/api/sessions`, { headers: { Cookie: studentCookie } });
      const list = await res.json();
      const found = list.some(s => s.id === sessionId);
      if (res.status === 200 && found) {
        pass('g', 'Student can still GET/see the session after its creator was deleted');
      } else {
        fail('g', 'Student must still see their own session', `status=${res.status}, ids=${JSON.stringify(list.map?.(s => s.id))}`);
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
