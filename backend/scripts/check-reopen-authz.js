'use strict';

/**
 * Authorization layer verification for PATCH /api/sessions/:id/reopen.
 *
 * Spins up a minimal in-process Express app (just the sessions router,
 * mounted the same way as in src/index.js) on an ephemeral port, and issues
 * real HTTP requests against it so getActingUser()/canReopenSession() and
 * the route handler are exercised exactly as in production.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:reopen-authz
 */

const express = require('express');
const pool = require('../src/db');
const sessionsRouter = require('../src/routes/sessions');

const PREFIX = '_reopen_test_';

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
  // Sessions cascade-delete on user delete, but clean up explicitly first
  // in case a failed run left orphaned rows under a different owner.
  await pool.query(
    "DELETE FROM learning_sessions WHERE name LIKE $1",
    [`${PREFIX}%`]
  );
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username, role) {
  const r = await pool.query(
    'INSERT INTO users (username, role) VALUES ($1, $2) RETURNING id',
    [username, role]
  );
  return r.rows[0].id;
}

async function createCompletedSession(ownerId, name) {
  const r = await pool.query(
    `INSERT INTO learning_sessions (user_id, name, status, completed_at)
     VALUES ($1, $2, 'completed', NOW())
     RETURNING id, status`,
    [ownerId, name]
  );
  return r.rows[0].id;
}

async function sessionStatus(id) {
  const r = await pool.query('SELECT status FROM learning_sessions WHERE id = $1', [id]);
  return r.rows[0]?.status;
}

async function run() {
  await cleanup();

  let server;
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}/api/sessions`;

    // ── Setup: one acting user per role, two distinct session owners ─────────
    const adminId    = await createUser(`${PREFIX}admin`,    'admin');
    const mentorId   = await createUser(`${PREFIX}mentor`,   'mentor');
    const studentAId = await createUser(`${PREFIX}studentA`, 'student');
    const studentBId = await createUser(`${PREFIX}studentB`, 'student');

    const sessionOwnA1 = await createCompletedSession(studentAId, `${PREFIX}session_a1`);
    const sessionOwnA2 = await createCompletedSession(studentAId, `${PREFIX}session_a2`);
    const sessionOwnB1 = await createCompletedSession(studentBId, `${PREFIX}session_b1`);
    const sessionOwnB2 = await createCompletedSession(studentBId, `${PREFIX}session_b2`);
    const sessionOwnB3 = await createCompletedSession(studentBId, `${PREFIX}session_b3`);
    const sessionOwnB4 = await createCompletedSession(studentBId, `${PREFIX}session_b4`);

    // ── Case a: student cannot reopen own completed session ──────────────────
    {
      const res = await fetch(`${base}/${sessionOwnA1}/reopen`, {
        method: 'PATCH',
        headers: { 'x-acting-user-id': String(studentAId) },
      });
      const status = await sessionStatus(sessionOwnA1);
      if (res.status === 403 && status === 'completed') {
        pass('a', "Student cannot reopen own completed session (403, status unchanged)");
      } else {
        fail('a', 'Student must not be able to reopen own completed session', `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case b: student cannot reopen another user's completed session ───────
    // Must be 404, not 403 — a student must not be able to distinguish a
    // nonexistent session id from one that exists but belongs to someone else.
    {
      const res = await fetch(`${base}/${sessionOwnB1}/reopen`, {
        method: 'PATCH',
        headers: { 'x-acting-user-id': String(studentAId) },
      });
      const status = await sessionStatus(sessionOwnB1);
      if (res.status === 404 && status === 'completed') {
        pass('b', "Student cannot reopen another user's completed session (404, status unchanged)");
      } else {
        fail('b', "Student must get 404 (not 403) for another user's session", `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case c: admin can reopen a completed session ─────────────────────────
    {
      const res = await fetch(`${base}/${sessionOwnB2}/reopen`, {
        method: 'PATCH',
        headers: { 'x-acting-user-id': String(adminId) },
      });
      const status = await sessionStatus(sessionOwnB2);
      if (res.status === 200 && status === 'active') {
        pass('c', 'Admin can reopen a completed session (200, status=active)');
      } else {
        fail('c', 'Admin must be able to reopen a completed session', `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case d: mentor can reopen a completed session (temporary, broad) ─────
    {
      const res = await fetch(`${base}/${sessionOwnB3}/reopen`, {
        method: 'PATCH',
        headers: { 'x-acting-user-id': String(mentorId) },
      });
      const status = await sessionStatus(sessionOwnB3);
      if (res.status === 200 && status === 'active') {
        pass('d', 'Mentor can reopen a completed session (200, status=active)');
      } else {
        fail('d', 'Mentor must be able to reopen a completed session (temporary rule)', `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case e: missing acting user returns 401 ───────────────────────────────
    {
      const res = await fetch(`${base}/${sessionOwnB4}/reopen`, { method: 'PATCH' });
      const status = await sessionStatus(sessionOwnB4);
      if (res.status === 401 && status === 'completed') {
        pass('e', 'Missing acting user header returns 401 (status unchanged)');
      } else {
        fail('e', 'Missing acting user must return 401', `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case f: invalid/nonexistent acting user returns 401 ───────────────────
    {
      const res = await fetch(`${base}/${sessionOwnA2}/reopen`, {
        method: 'PATCH',
        headers: { 'x-acting-user-id': '999999999' },
      });
      const status = await sessionStatus(sessionOwnA2);
      if (res.status === 401 && status === 'completed') {
        pass('f', 'Nonexistent acting user id returns 401 (status unchanged)');
      } else {
        fail('f', 'Nonexistent acting user must return 401', `httpStatus=${res.status}, dbStatus=${status}`);
      }
    }

    // ── Case g: nonexistent session id returns 404 ────────────────────────────
    {
      const res = await fetch(`${base}/999999999/reopen`, {
        method: 'PATCH',
        headers: { 'x-acting-user-id': String(adminId) },
      });
      if (res.status === 404) {
        pass('g', 'Nonexistent session id returns 404');
      } else {
        fail('g', 'Nonexistent session id must return 404', `httpStatus=${res.status}`);
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
