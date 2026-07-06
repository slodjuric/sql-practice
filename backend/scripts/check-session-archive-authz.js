'use strict';

/**
 * Authorization + behavior verification for session archiving:
 *   PATCH /api/sessions/:id/archive
 *   PATCH /api/sessions/:id/restore
 *   GET /api/sessions (default excludes archived; ?includeArchived=true includes them)
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the sessions router, mounted the same way as in src/index.js) on
 * an ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie — userId is never sent by the client; every route
 * must resolve it from the session.
 *
 * Follows the same admin/mentor/student authorization matrix already
 * established for edit/delete/reopen (see check-sessions-write-authz.js,
 * check-reopen-authz.js): admin can archive/restore any session; a mentor
 * can archive/restore their own session or an assigned student's, never an
 * unassigned student's; a student never can, not even their own — same
 * blanket rule as edit/delete.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:session-archive-authz
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const sessionsRouter = require('../src/routes/sessions');

const PREFIX = '_archauthz_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-session-archive-authz-script-only';
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
    "DELETE FROM task_attempts WHERE session_id IN (SELECT id FROM learning_sessions WHERE name LIKE $1)",
    [`${PREFIX}%`]
  );
  await pool.query(
    "DELETE FROM user_task_progress WHERE session_id IN (SELECT id FROM learning_sessions WHERE name LIKE $1)",
    [`${PREFIX}%`]
  );
  await pool.query("DELETE FROM learning_sessions WHERE name LIKE $1", [`${PREFIX}%`]);
  await pool.query(
    `DELETE FROM mentor_assignments WHERE mentor_id IN (SELECT id FROM users WHERE username LIKE $1)
       OR student_id IN (SELECT id FROM users WHERE username LIKE $1)`,
    [`${PREFIX}%`]
  );
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username, role = 'mentor') {
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

async function sessionRow(id) {
  const r = await pool.query(
    'SELECT id, user_id, name, archived_at, archived_by_user_id, status FROM learning_sessions WHERE id = $1',
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

    // ── Setup ──────────────────────────────────────────────────────────────
    const ownerUsername = `${PREFIX}owner`;
    const ownerId = await createUser(ownerUsername, 'student');
    const ownSessionId = await createSession(ownerId, `${PREFIX}owner_session`);

    // ── Case 1: unauthenticated archive/restore → 401, untouched ──────────
    {
      const archiveRes = await fetch(`${sessionsBase}/${ownSessionId}/archive`, { method: 'PATCH' });
      const restoreRes = await fetch(`${sessionsBase}/${ownSessionId}/restore`, { method: 'PATCH' });
      const row = await sessionRow(ownSessionId);
      if (archiveRes.status === 401 && restoreRes.status === 401 && row.archived_at === null) {
        pass('1', 'Unauthenticated archive/restore both return 401 (session untouched)');
      } else {
        fail('1', 'Unauthenticated archive/restore must return 401', `archiveStatus=${archiveRes.status}, restoreStatus=${restoreRes.status}, archived_at=${row.archived_at}`);
      }
    }

    // ── Case 2: student cannot archive their own session ───────────────────
    {
      const { cookie } = await login(base, ownerUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${ownSessionId}/archive`, { method: 'PATCH', headers: { Cookie: cookie } });
      const row = await sessionRow(ownSessionId);
      if (res.status === 403 && row.archived_at === null) {
        pass('2', "Student cannot archive their own session (403, untouched)");
      } else {
        fail('2', 'Student must never be able to archive a session', `status=${res.status}, archived_at=${row.archived_at}`);
      }
    }

    // ── Setup: mentor/student pair for the assigned/unassigned matrix ──────
    const mentorUsername = `${PREFIX}mentor`;
    const studentUsername = `${PREFIX}student`;
    const unassignedMentorUsername = `${PREFIX}unassignedMentor`;
    const adminUsername = `${PREFIX}admin`;
    const mentorId = await createUser(mentorUsername, 'mentor');
    const studentId = await createUser(studentUsername, 'student');
    const unassignedMentorId = await createUser(unassignedMentorUsername, 'mentor');
    await createUser(adminUsername, 'admin');
    await pool.query('INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2)', [mentorId, studentId]);
    const studentSessionId = await createSession(studentId, `${PREFIX}student_session`);

    // ── Case 3: unassigned mentor cannot archive the student's session ─────
    {
      const { cookie } = await login(base, unassignedMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${studentSessionId}/archive`, { method: 'PATCH', headers: { Cookie: cookie } });
      const row = await sessionRow(studentSessionId);
      if (res.status === 403 && row.archived_at === null) {
        pass('3', "Unassigned mentor cannot archive the student's session (403, untouched)");
      } else {
        fail('3', "Unassigned mentor must not be able to archive an unassigned student's session", `status=${res.status}, archived_at=${row.archived_at}`);
      }
    }

    // ── Case 4: assigned mentor CAN archive the student's session ──────────
    {
      const { cookie } = await login(base, mentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${studentSessionId}/archive`, { method: 'PATCH', headers: { Cookie: cookie } });
      const body = await res.json();
      const row = await sessionRow(studentSessionId);
      if (res.status === 200 && row.archived_at !== null && row.archived_by_user_id === mentorId && body.archived_by_username === mentorUsername) {
        pass('4', "Assigned mentor can archive the student's session (200, archived_at set, archived_by_user_id=mentor, archived_by_username in response)");
      } else {
        fail('4', "Assigned mentor must be able to archive an assigned student's session", `status=${res.status}, row=${JSON.stringify(row)}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 5: archived session disappears from the default GET / list ────
    {
      const { cookie } = await login(base, studentUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}`, { headers: { Cookie: cookie } });
      const list = await res.json();
      const found = list.find(s => s.id === studentSessionId);
      if (res.status === 200 && !found) {
        pass('5', 'Archived session is excluded from the default GET /api/sessions list');
      } else {
        fail('5', 'Archived session must be excluded from the default list', `status=${res.status}, found=${JSON.stringify(found)}`);
      }
    }

    // ── Case 6: GET /?includeArchived=true DOES include it ──────────────────
    {
      const { cookie } = await login(base, studentUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}?includeArchived=true`, { headers: { Cookie: cookie } });
      const list = await res.json();
      const found = list.find(s => s.id === studentSessionId);
      if (res.status === 200 && found && found.archived_at) {
        pass('6', '?includeArchived=true includes the archived session with archived_at set');
      } else {
        fail('6', '?includeArchived=true must include the archived session', `status=${res.status}, found=${JSON.stringify(found)}`);
      }
    }

    // ── Case 7: unassigned mentor cannot restore the student's session ─────
    {
      const { cookie } = await login(base, unassignedMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${studentSessionId}/restore`, { method: 'PATCH', headers: { Cookie: cookie } });
      const row = await sessionRow(studentSessionId);
      if (res.status === 403 && row.archived_at !== null) {
        pass('7', "Unassigned mentor cannot restore the student's session (403, still archived)");
      } else {
        fail('7', "Unassigned mentor must not be able to restore an unassigned student's session", `status=${res.status}, archived_at=${row.archived_at}`);
      }
    }

    // ── Case 8: student cannot restore their own (mentor-archived) session ──
    {
      const { cookie } = await login(base, studentUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${studentSessionId}/restore`, { method: 'PATCH', headers: { Cookie: cookie } });
      const row = await sessionRow(studentSessionId);
      if (res.status === 403 && row.archived_at !== null) {
        pass('8', 'Student cannot restore their own session (403, still archived)');
      } else {
        fail('8', 'Student must never be able to restore a session', `status=${res.status}, archived_at=${row.archived_at}`);
      }
    }

    // ── Case 9: assigned mentor CAN restore the student's session ──────────
    {
      const { cookie } = await login(base, mentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${studentSessionId}/restore`, { method: 'PATCH', headers: { Cookie: cookie } });
      const row = await sessionRow(studentSessionId);
      if (res.status === 200 && row.archived_at === null && row.archived_by_user_id === null) {
        pass('9', "Assigned mentor can restore the student's session (200, archived_at/archived_by_user_id cleared)");
      } else {
        fail('9', "Assigned mentor must be able to restore an assigned student's session", `status=${res.status}, row=${JSON.stringify(row)}`);
      }
    }

    // ── Case 10: restored session reappears in the default GET / list ──────
    {
      const { cookie } = await login(base, studentUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}`, { headers: { Cookie: cookie } });
      const list = await res.json();
      const found = list.find(s => s.id === studentSessionId);
      if (res.status === 200 && found && !found.archived_at) {
        pass('10', 'Restored session reappears in the default GET /api/sessions list');
      } else {
        fail('10', 'Restored session must reappear in the default list', `status=${res.status}, found=${JSON.stringify(found)}`);
      }
    }

    // ── Case 11: admin can archive and restore any session ─────────────────
    {
      const { cookie } = await login(base, adminUsername, TEST_PASSWORD);
      const archiveRes = await fetch(`${sessionsBase}/${studentSessionId}/archive`, { method: 'PATCH', headers: { Cookie: cookie } });
      const afterArchive = await sessionRow(studentSessionId);
      const restoreRes = await fetch(`${sessionsBase}/${studentSessionId}/restore`, { method: 'PATCH', headers: { Cookie: cookie } });
      const afterRestore = await sessionRow(studentSessionId);
      if (archiveRes.status === 200 && afterArchive.archived_at !== null &&
          restoreRes.status === 200 && afterRestore.archived_at === null) {
        pass('11', 'Admin can archive and restore any session, including a student\'s (200/200)');
      } else {
        fail('11', 'Admin must be able to archive and restore any session', `archiveStatus=${archiveRes.status}, restoreStatus=${restoreRes.status}, afterArchive=${JSON.stringify(afterArchive)}, afterRestore=${JSON.stringify(afterRestore)}`);
      }
    }

    // ── Case 12: archiving preserves task_attempts and user_task_progress ──
    {
      const preserveSessionId = await createSession(studentId, `${PREFIX}preserve_session`);
      await pool.query(
        `INSERT INTO task_attempts (user_id, session_id, task_id, submitted_sql, is_correct)
         VALUES ($1, $2, 1, 'SELECT 1', true)`,
        [studentId, preserveSessionId]
      );
      await pool.query(
        `INSERT INTO user_task_progress (user_id, session_id, task_id, status, attempts_count)
         VALUES ($1, $2, 1, 'solved', 1)`,
        [studentId, preserveSessionId]
      );
      const { cookie } = await login(base, mentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${preserveSessionId}/archive`, { method: 'PATCH', headers: { Cookie: cookie } });
      const attemptsAfter = await pool.query('SELECT COUNT(*)::int AS n FROM task_attempts WHERE session_id = $1', [preserveSessionId]);
      const progressAfter = await pool.query('SELECT COUNT(*)::int AS n FROM user_task_progress WHERE session_id = $1', [preserveSessionId]);
      const sessionAfter = await sessionRow(preserveSessionId);
      if (res.status === 200 && attemptsAfter.rows[0].n === 1 && progressAfter.rows[0].n === 1 && sessionAfter) {
        pass('12', 'Archiving preserves task_attempts (1) and user_task_progress (1) — session row itself also untouched otherwise');
      } else {
        fail('12', 'Archiving must never remove task_attempts/user_task_progress', `status=${res.status}, attempts=${attemptsAfter.rows[0].n}, progress=${progressAfter.rows[0].n}, session=${JSON.stringify(sessionAfter)}`);
      }
    }

    // ── Case 13: edit/complete/reopen/open all reject an archived session ──
    {
      const guardSessionId = await createSession(studentId, `${PREFIX}guard_session`);
      const { cookie: mentorCookie } = await login(base, mentorUsername, TEST_PASSWORD);
      await fetch(`${sessionsBase}/${guardSessionId}/archive`, { method: 'PATCH', headers: { Cookie: mentorCookie } });

      const editRes = await fetch(`${sessionsBase}/${guardSessionId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: mentorCookie },
        body: JSON.stringify({ name: `${PREFIX}renamed_while_archived` }),
      });
      const reopenRes = await fetch(`${sessionsBase}/${guardSessionId}/reopen`, { method: 'PATCH', headers: { Cookie: mentorCookie } });

      const { cookie: studentCookie } = await login(base, studentUsername, TEST_PASSWORD);
      const completeRes = await fetch(`${sessionsBase}/${guardSessionId}/complete`, { method: 'PATCH', headers: { Cookie: studentCookie } });
      const openRes = await fetch(`${sessionsBase}/${guardSessionId}/open`, { method: 'PATCH', headers: { Cookie: studentCookie } });

      const allRejected = [editRes, reopenRes, completeRes, openRes].every(r => r.status === 403);
      if (allRejected) {
        pass('13', 'Edit/reopen/complete/open on an archived session all return 403 with a clear error');
      } else {
        fail('13', 'Edit/reopen/complete/open must all reject an archived session', `statuses=edit:${editRes.status},reopen:${reopenRes.status},complete:${completeRes.status},open:${openRes.status}`);
      }
    }

    // ── Case 14: archiving/restoring a nonexistent session id returns 404 ──
    {
      const { cookie } = await login(base, mentorUsername, TEST_PASSWORD);
      const archiveRes = await fetch(`${sessionsBase}/999999997/archive`, { method: 'PATCH', headers: { Cookie: cookie } });
      const restoreRes = await fetch(`${sessionsBase}/999999997/restore`, { method: 'PATCH', headers: { Cookie: cookie } });
      if (archiveRes.status === 404 && restoreRes.status === 404) {
        pass('14', 'Archiving/restoring a nonexistent session id both return 404');
      } else {
        fail('14', 'Archiving/restoring a nonexistent session id must return 404', `archiveStatus=${archiveRes.status}, restoreStatus=${restoreRes.status}`);
      }
    }

    // ── Case 15: archive response leaks no password/unexpected user data ───
    {
      const leakCheckSessionId = await createSession(studentId, `${PREFIX}leak_check_session`);
      const { cookie } = await login(base, mentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${leakCheckSessionId}/archive`, { method: 'PATCH', headers: { Cookie: cookie } });
      const body = await res.json();
      const noPasswordLeak = !JSON.stringify(body).match(/password/i);
      const usernameKeys = Object.keys(body).filter(k => /username/i.test(k));
      const onlyAllowlisted = usernameKeys.every(k => ['owner_username', 'created_by_username', 'archived_by_username'].includes(k));
      if (res.status === 200 && noPasswordLeak && onlyAllowlisted) {
        pass('15', 'Archive response leaks no password/unexpected user fields');
      } else {
        fail('15', 'Archive response must not leak password/unexpected user data', `status=${res.status}, noPasswordLeak=${noPasswordLeak}, usernameKeys=${JSON.stringify(usernameKeys)}`);
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
