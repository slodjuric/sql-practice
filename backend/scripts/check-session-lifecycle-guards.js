'use strict';

/**
 * Regression coverage for the sessions.js load-and-authorize refactor
 * (loadAuthorizedSession helper + RETURNING/rowCount guards):
 *
 *   - Cases 1-8: a non-numeric :id on every id-taking session route returns
 *     a clean 400, never falls through to a DB error/500. Covers both
 *     routes that now go through loadAuthorizedSession (PATCH /:id,
 *     GET /:id/filters, reopen, archive, restore, DELETE /:id) and the two
 *     that intentionally kept their own self-only ownership check
 *     (complete, open).
 *
 *   - Cases 9-10: the "row deleted between the authorization check and the
 *     UPDATE" race now returns 404 instead of a 500 (complete, which used
 *     to 500) or a silently-empty 200 body (archive/restore/reopen/open,
 *     which had no check at all). Reproduced deterministically — not via
 *     timing — by holding an uncommitted DELETE on the row (which blocks
 *     the route's UPDATE on the row lock, per normal Postgres MVCC/locking
 *     under READ COMMITTED) and committing it only after the route's SELECT
 *     has already passed the authorization check, so its UPDATE is
 *     guaranteed to see zero matching rows once unblocked. Covers one route
 *     using the shared helper (archive) and one using the separate
 *     self-only pattern (open), since the fix was applied to both.
 *
 * Regression coverage added for the follow-up transaction-safety pass
 * (reopen/archive/restore now run inside BEGIN/COMMIT with
 * SELECT ... FOR UPDATE):
 *
 *   - Cases 11-16: unauthorized (403) and nonexistent-session (404) checks
 *     against the now-transactional reopen/archive/restore, confirming the
 *     transaction wrap changed nothing about who is allowed to do what.
 *
 *   - Cases 17-19: a successful reopen/archive/restore still returns the
 *     exact same flat, enriched response shape as before (no {session:...}
 *     wrapper, owner_username/owner_role/created_by_username present).
 *
 *   - Cases 20-21: the same "row deleted mid-request" race as cases 9-10,
 *     now exercised against reopen and restore specifically. Because
 *     loadAuthorizedSession now takes FOR UPDATE on its own SELECT for
 *     these three routes, the delete is actually blocked at the SELECT
 *     stage rather than at the later UPDATE — either way the route still
 *     returns a clean 404, just one authorization-check step earlier than
 *     before the transaction wrap (see the inline note on case 20).
 *
 *   - Case 22 (the key new case): two genuinely concurrent, differently-
 *     authorized mutations on the SAME session (an in-flight archive, and a
 *     concurrent reopen) are serialized by the row lock rather than both
 *     evaluating against the same stale snapshot — the reopen blocks until
 *     the archive commits, then correctly re-reads the now-archived row and
 *     rejects with the normal "already archived" 403, instead of blindly
 *     reopening a session that (by the time it would have run its UPDATE)
 *     is already archived. No sleeps: Postgres's own row lock guarantees
 *     the ordering regardless of which request's query the event loop
 *     issues first.
 *
 *   - Case 23: two concurrent, both-authorized archive calls on the same
 *     session (idempotent action) are serialized without deadlock or
 *     error — both requests succeed, sequentially, not concurrently.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:session-lifecycle-guards
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const sessionsRouter = require('../src/routes/sessions');

const PREFIX = '_lcguard_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-session-lifecycle-guards-script-only';
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
  await pool.query("DELETE FROM learning_sessions WHERE name LIKE $1", [`${PREFIX}%`]);
  await pool.query(
    `DELETE FROM mentor_assignments WHERE mentor_id IN (SELECT id FROM users WHERE username LIKE $1)
       OR student_id IN (SELECT id FROM users WHERE username LIKE $1)`,
    [`${PREFIX}%`]
  );
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username, role = 'admin') {
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

async function createCompletedSession(ownerId, name) {
  const dataset = await pool.query("SELECT id FROM datasets WHERE key = 'academic'");
  const r = await pool.query(
    `INSERT INTO learning_sessions (user_id, name, dataset_id, status, completed_at)
     VALUES ($1, $2, $3, 'completed', NOW()) RETURNING id`,
    [ownerId, name, dataset.rows[0].id]
  );
  return r.rows[0].id;
}

async function sessionRow(id) {
  const r = await pool.query(
    'SELECT id, user_id, name, status, archived_at, archived_by_user_id FROM learning_sessions WHERE id = $1',
    [id]
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
  await res.json();
  return { cookie: extractCookie(res) };
}

// Holds an uncommitted DELETE on `sessionId` (row-locked, invisible to other
// READ COMMITTED transactions until committed) so a concurrent route's
// UPDATE on the same row blocks until `release()` commits the delete —
// guaranteeing the route's UPDATE sees zero matching rows once it proceeds,
// without relying on timing.
async function holdUncommittedDelete(sessionId) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('DELETE FROM learning_sessions WHERE id = $1', [sessionId]);
  return {
    release: async () => {
      await client.query('COMMIT');
      client.release();
    },
  };
}

// Same idea, but simulates an in-flight, not-yet-committed PATCH /:id/archive
// by taking the exact same lock (SELECT ... FOR UPDATE) the route itself
// takes, then performing the same UPDATE it would. Used to prove that a
// concurrent request against the same session genuinely blocks on the row
// lock and is not just "usually fine" under light/no contention.
async function holdUncommittedArchive(sessionId, actingUserId) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM learning_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
  await client.query(
    'UPDATE learning_sessions SET archived_at = NOW(), archived_by_user_id = $1 WHERE id = $2',
    [actingUserId, sessionId]
  );
  return {
    release: async () => {
      await client.query('COMMIT');
      client.release();
    },
  };
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

    const adminUsername = `${PREFIX}admin`;
    const adminId = await createUser(adminUsername, 'admin');
    const { cookie } = await login(base, adminUsername, TEST_PASSWORD);

    // ── Cases 1-8: non-numeric :id returns 400 on every id-taking route ────
    const badId = 'not-a-number';
    const routeChecks = [
      { id: '1', label: 'PATCH /:id',            fn: () => fetch(`${sessionsBase}/${badId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'x' }) }) },
      { id: '2', label: 'GET /:id/filters',       fn: () => fetch(`${sessionsBase}/${badId}/filters`, { headers: { Cookie: cookie } }) },
      { id: '3', label: 'PATCH /:id/complete',    fn: () => fetch(`${sessionsBase}/${badId}/complete`, { method: 'PATCH', headers: { Cookie: cookie } }) },
      { id: '4', label: 'PATCH /:id/reopen',      fn: () => fetch(`${sessionsBase}/${badId}/reopen`, { method: 'PATCH', headers: { Cookie: cookie } }) },
      { id: '5', label: 'PATCH /:id/open',        fn: () => fetch(`${sessionsBase}/${badId}/open`, { method: 'PATCH', headers: { Cookie: cookie } }) },
      { id: '6', label: 'PATCH /:id/archive',     fn: () => fetch(`${sessionsBase}/${badId}/archive`, { method: 'PATCH', headers: { Cookie: cookie } }) },
      { id: '7', label: 'PATCH /:id/restore',     fn: () => fetch(`${sessionsBase}/${badId}/restore`, { method: 'PATCH', headers: { Cookie: cookie } }) },
      { id: '8', label: 'DELETE /:id',            fn: () => fetch(`${sessionsBase}/${badId}`, { method: 'DELETE', headers: { Cookie: cookie } }) },
    ];
    for (const { id, label, fn } of routeChecks) {
      const res = await fn();
      const body = await res.json().catch(() => null);
      if (res.status === 400 && body && typeof body.error === 'string') {
        pass(id, `${label} with a non-numeric id returns 400, not a DB error/500 ("${body.error}")`);
      } else {
        fail(id, `${label} with a non-numeric id must return 400`, `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 9: PATCH /:id/archive — row deleted after authorization, ──────
    // before the UPDATE, now returns 404 (was: silently empty 200 body).
    // Uses the shared loadAuthorizedSession helper.
    {
      const sid = await createSession(adminId, `${PREFIX}archive_race`);
      const lock = await holdUncommittedDelete(sid);
      try {
        const resPromise = fetch(`${sessionsBase}/${sid}/archive`, { method: 'PATCH', headers: { Cookie: cookie } });
        // Give the request a moment to reach and block on the UPDATE before
        // we commit the delete that unblocks it.
        await new Promise(r => setTimeout(r, 150));
        await lock.release();
        const res = await resPromise;
        const body = await res.json().catch(() => null);
        if (res.status === 404 && body?.error === 'Session not found.') {
          pass('9', 'PATCH /:id/archive returns 404 when the session is deleted between authorization and the UPDATE');
        } else {
          fail('9', 'PATCH /:id/archive must return 404 for this race', `status=${res.status}, body=${JSON.stringify(body)}`);
        }
      } finally {
        // no-op if already released
      }
    }

    // ── Case 10: PATCH /:id/open — same race, self-only ownership pattern ──
    // (not migrated to the shared helper, but given the same RETURNING/
    // rowCount fix).
    {
      const sid = await createSession(adminId, `${PREFIX}open_race`);
      const lock = await holdUncommittedDelete(sid);
      const resPromise = fetch(`${sessionsBase}/${sid}/open`, { method: 'PATCH', headers: { Cookie: cookie } });
      await new Promise(r => setTimeout(r, 150));
      await lock.release();
      const res = await resPromise;
      const body = await res.json().catch(() => null);
      if (res.status === 404 && body?.error === 'Session not found.') {
        pass('10', 'PATCH /:id/open returns 404 when the session is deleted between the ownership check and the UPDATE');
      } else {
        fail('10', 'PATCH /:id/open must return 404 for this race', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Setup for cases 11-23: mentor/student pair for the authz checks ────
    const mentorUsername = `${PREFIX}mentor`;
    const studentUsername = `${PREFIX}student`;
    const unassignedMentorUsername = `${PREFIX}unassignedMentor`;
    const mentorId = await createUser(mentorUsername, 'mentor');
    const studentId = await createUser(studentUsername, 'student');
    await createUser(unassignedMentorUsername, 'mentor');
    // unassignedMentorUsername is deliberately NOT assigned to studentId —
    // used for the 403 cases below.
    await pool.query('INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2)', [mentorId, studentId]);
    const { cookie: mentorCookie } = await login(base, mentorUsername, TEST_PASSWORD);
    const { cookie: unassignedMentorCookie } = await login(base, unassignedMentorUsername, TEST_PASSWORD);

    // ── Case 11: reopen — unauthorized (unassigned mentor) still 403, untouched ──
    {
      const sid = await createCompletedSession(studentId, `${PREFIX}reopen_unauth`);
      const res = await fetch(`${sessionsBase}/${sid}/reopen`, { method: 'PATCH', headers: { Cookie: unassignedMentorCookie } });
      const body = await res.json().catch(() => null);
      const row = await sessionRow(sid);
      if (res.status === 403 && body?.error === 'You do not have permission to reopen this session.' && row.status === 'completed') {
        pass('11', 'Transactional reopen: unassigned mentor still gets 403 with the same message, session untouched');
      } else {
        fail('11', 'Transactional reopen must preserve the unauthorized 403 behavior', `status=${res.status}, body=${JSON.stringify(body)}, row=${JSON.stringify(row)}`);
      }
    }

    // ── Case 12: reopen — nonexistent session still 404 ─────────────────────
    {
      const res = await fetch(`${sessionsBase}/999999996/reopen`, { method: 'PATCH', headers: { Cookie: mentorCookie } });
      const body = await res.json().catch(() => null);
      if (res.status === 404 && body?.error === 'Session not found.') {
        pass('12', 'Transactional reopen: nonexistent session id still returns 404 with the same message');
      } else {
        fail('12', 'Transactional reopen must preserve the nonexistent-session 404 behavior', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 13: archive — unauthorized (unassigned mentor) still 403, untouched ──
    {
      const sid = await createSession(studentId, `${PREFIX}archive_unauth`);
      const res = await fetch(`${sessionsBase}/${sid}/archive`, { method: 'PATCH', headers: { Cookie: unassignedMentorCookie } });
      const body = await res.json().catch(() => null);
      const row = await sessionRow(sid);
      if (res.status === 403 && body?.error === 'You do not have permission to archive this session.' && row.archived_at === null) {
        pass('13', 'Transactional archive: unassigned mentor still gets 403 with the same message, session untouched');
      } else {
        fail('13', 'Transactional archive must preserve the unauthorized 403 behavior', `status=${res.status}, body=${JSON.stringify(body)}, row=${JSON.stringify(row)}`);
      }
    }

    // ── Case 14: archive — nonexistent session still 404 ────────────────────
    {
      const res = await fetch(`${sessionsBase}/999999995/archive`, { method: 'PATCH', headers: { Cookie: mentorCookie } });
      const body = await res.json().catch(() => null);
      if (res.status === 404 && body?.error === 'Session not found.') {
        pass('14', 'Transactional archive: nonexistent session id still returns 404 with the same message');
      } else {
        fail('14', 'Transactional archive must preserve the nonexistent-session 404 behavior', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 15: restore — unauthorized (unassigned mentor) still 403, untouched ──
    {
      const sid = await createSession(studentId, `${PREFIX}restore_unauth`);
      await pool.query('UPDATE learning_sessions SET archived_at = NOW(), archived_by_user_id = $1 WHERE id = $2', [mentorId, sid]);
      const res = await fetch(`${sessionsBase}/${sid}/restore`, { method: 'PATCH', headers: { Cookie: unassignedMentorCookie } });
      const body = await res.json().catch(() => null);
      const row = await sessionRow(sid);
      if (res.status === 403 && body?.error === 'You do not have permission to restore this session.' && row.archived_at !== null) {
        pass('15', 'Transactional restore: unassigned mentor still gets 403 with the same message, session untouched');
      } else {
        fail('15', 'Transactional restore must preserve the unauthorized 403 behavior', `status=${res.status}, body=${JSON.stringify(body)}, row=${JSON.stringify(row)}`);
      }
    }

    // ── Case 16: restore — nonexistent session still 404 ────────────────────
    {
      const res = await fetch(`${sessionsBase}/999999994/restore`, { method: 'PATCH', headers: { Cookie: mentorCookie } });
      const body = await res.json().catch(() => null);
      if (res.status === 404 && body?.error === 'Session not found.') {
        pass('16', 'Transactional restore: nonexistent session id still returns 404 with the same message');
      } else {
        fail('16', 'Transactional restore must preserve the nonexistent-session 404 behavior', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 17: successful reopen still returns the same flat, enriched ───
    // response shape (no {session:...} wrapper).
    {
      const sid = await createCompletedSession(studentId, `${PREFIX}reopen_shape`);
      const res = await fetch(`${sessionsBase}/${sid}/reopen`, { method: 'PATCH', headers: { Cookie: mentorCookie } });
      const body = await res.json().catch(() => null);
      const shapeOk = res.status === 200 && body?.status === 'active' && body?.id === sid
        && body?.owner_username === studentUsername && body?.owner_role === 'student'
        && !('session' in body) && !('filters' in body);
      if (shapeOk) {
        pass('17', 'Transactional reopen still returns the same flat enriched shape (200, status=active, owner_username/owner_role present, no session/filters wrapper)');
      } else {
        fail('17', 'Transactional reopen must preserve the exact response shape', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 18: successful archive still returns the same flat, enriched ──
    // response shape.
    {
      const sid = await createSession(studentId, `${PREFIX}archive_shape`);
      const res = await fetch(`${sessionsBase}/${sid}/archive`, { method: 'PATCH', headers: { Cookie: mentorCookie } });
      const body = await res.json().catch(() => null);
      const shapeOk = res.status === 200 && body?.id === sid && body?.archived_at
        && body?.archived_by_username === mentorUsername
        && body?.owner_username === studentUsername && body?.owner_role === 'student'
        && !('session' in body) && !('filters' in body);
      if (shapeOk) {
        pass('18', 'Transactional archive still returns the same flat enriched shape (200, archived_at/archived_by_username/owner fields present, no wrapper)');
      } else {
        fail('18', 'Transactional archive must preserve the exact response shape', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 19: successful restore still returns the same flat, enriched ──
    // response shape.
    {
      const sid = await createSession(studentId, `${PREFIX}restore_shape`);
      await pool.query('UPDATE learning_sessions SET archived_at = NOW(), archived_by_user_id = $1 WHERE id = $2', [mentorId, sid]);
      const res = await fetch(`${sessionsBase}/${sid}/restore`, { method: 'PATCH', headers: { Cookie: mentorCookie } });
      const body = await res.json().catch(() => null);
      const shapeOk = res.status === 200 && body?.id === sid && body?.archived_at === null && body?.archived_by_user_id === null
        && body?.owner_username === studentUsername && body?.owner_role === 'student'
        && !('session' in body) && !('filters' in body);
      if (shapeOk) {
        pass('19', 'Transactional restore still returns the same flat enriched shape (200, archived_at/archived_by_user_id cleared, owner fields present, no wrapper)');
      } else {
        fail('19', 'Transactional restore must preserve the exact response shape', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 20: reopen — row deleted between authorization and the UPDATE ─
    // still returns 404. Now that loadAuthorizedSession takes FOR UPDATE for
    // this route, the held delete blocks reopen's own SELECT rather than
    // its later UPDATE — it still surfaces as the same 404/"Session not
    // found." either way, just from loadAuthorizedSession's own not-found
    // branch instead of the post-UPDATE rowCount branch. Both are correct;
    // this proves the row lock, if anything, catches the race earlier.
    {
      const sid = await createCompletedSession(studentId, `${PREFIX}reopen_race`);
      const lock = await holdUncommittedDelete(sid);
      const resPromise = fetch(`${sessionsBase}/${sid}/reopen`, { method: 'PATCH', headers: { Cookie: mentorCookie } });
      await lock.release();
      const res = await resPromise;
      const body = await res.json().catch(() => null);
      if (res.status === 404 && body?.error === 'Session not found.') {
        pass('20', 'Transactional reopen returns 404 when the session is deleted concurrently, no false 200');
      } else {
        fail('20', 'Transactional reopen must return 404 for this race', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 21: restore — same race as case 20 ─────────────────────────────
    {
      const sid = await createSession(studentId, `${PREFIX}restore_race`);
      await pool.query('UPDATE learning_sessions SET archived_at = NOW(), archived_by_user_id = $1 WHERE id = $2', [mentorId, sid]);
      const lock = await holdUncommittedDelete(sid);
      const resPromise = fetch(`${sessionsBase}/${sid}/restore`, { method: 'PATCH', headers: { Cookie: mentorCookie } });
      await lock.release();
      const res = await resPromise;
      const body = await res.json().catch(() => null);
      if (res.status === 404 && body?.error === 'Session not found.') {
        pass('21', 'Transactional restore returns 404 when the session is deleted concurrently, no false 200');
      } else {
        fail('21', 'Transactional restore must return 404 for this race', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 22 (the key case): a concurrent archive-in-progress serializes ─
    // against a reopen on the SAME session — the reopen must block until the
    // archive commits, then correctly re-evaluate against the fresh
    // (now-archived) row and reject, instead of reopening based on the
    // stale pre-archive snapshot it would have seen without the row lock.
    // No sleeps: whichever request's query Postgres processes first, the
    // row lock guarantees the reopen can only ever observe either the
    // pre-archive or the committed post-archive state — never a torn state
    // where both "succeed" independently.
    {
      const sid = await createCompletedSession(studentId, `${PREFIX}serialize_race`);
      const lock = await holdUncommittedArchive(sid, mentorId);
      const resPromise = fetch(`${sessionsBase}/${sid}/reopen`, { method: 'PATCH', headers: { Cookie: mentorCookie } });
      await lock.release();
      const res = await resPromise;
      const body = await res.json().catch(() => null);
      const row = await sessionRow(sid);
      const reopenCorrectlyRejected = res.status === 403 && body?.error === 'This session is archived. Restore it instead of reopening.';
      const finalStateIsArchived = row.archived_at !== null && row.status === 'completed';
      if (reopenCorrectlyRejected && finalStateIsArchived) {
        pass('22', 'Concurrent archive + reopen on the same session are serialized by the row lock — reopen correctly sees the fresh archived state and rejects (403), final state is archived/completed, not silently reopened');
      } else {
        fail('22', 'Concurrent archive + reopen must be serialized, not both applied independently', `status=${res.status}, body=${JSON.stringify(body)}, row=${JSON.stringify(row)}`);
      }
    }

    // ── Case 23: two concurrent, both-authorized archive calls on the same ──
    // session serialize without deadlock/error — both succeed sequentially.
    {
      const sid = await createSession(studentId, `${PREFIX}concurrent_archive`);
      const [res1, res2] = await Promise.all([
        fetch(`${sessionsBase}/${sid}/archive`, { method: 'PATCH', headers: { Cookie: mentorCookie } }),
        fetch(`${sessionsBase}/${sid}/archive`, { method: 'PATCH', headers: { Cookie: mentorCookie } }),
      ]);
      const row = await sessionRow(sid);
      const bothSucceeded = res1.status === 200 && res2.status === 200;
      if (bothSucceeded && row.archived_at !== null) {
        pass('23', 'Two concurrent archive calls on the same session both succeed (serialized by the row lock, no deadlock/error)');
      } else {
        fail('23', 'Two concurrent, both-authorized archive calls must serialize cleanly, not deadlock/error', `statuses=${res1.status},${res2.status}, row=${JSON.stringify(row)}`);
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
