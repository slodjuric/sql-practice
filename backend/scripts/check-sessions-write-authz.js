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
 * Cases 1-7 use mentor-role test users deliberately, not students — they
 * verify generic per-user ownership isolation (create/update/complete/open/
 * delete), which is orthogonal to the role-based restriction added later.
 *
 * Final student permission model (cases 8-14): students can never create,
 * delete, edit/rename, or reopen a session, not even their own — but CAN
 * complete their own session (once existing completion conditions are met)
 * and can always select/open an existing session. See also
 * check-session-create-for-user.js (create) and check-reopen-authz.js (reopen).
 *
 * Mentor edit-authz matrix (cases 15-19): PATCH /:id authorizes via
 * canAccessStudent(actingUser, session.user_id) fetched from the session row
 * itself — a mentor can edit their own session or an assigned student's, but
 * not an unassigned student's; admin can edit any session; a nonexistent id
 * is 404; responses never leak password/username fields.
 *
 * Mentor delete-authz matrix (cases 20-23): DELETE /:id authorizes the same
 * way — a mentor can delete an assigned student's session but not an
 * unassigned student's; admin can delete any session; a nonexistent id is 404.
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
    // update and delete are authorized via canAccessStudent (session found,
    // access denied => 403); complete/open stay ownership-scoped by the query
    // itself (session invisible to that query => 404). Different status
    // codes are intentional, not an inconsistency — see PATCH /:id and
    // DELETE /:id's authz rewrite.
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

      const authorizedChecksAre403 = [updateRes, deleteRes].every(r => r.status === 403);
      const ownershipScopedAre404 = [completeRes, openRes].every(r => r.status === 404);
      const ownerUnchanged = (await sessionOwner(victimSessionId))?.user_id === userBId;
      const nameUnchanged  = (await sessionOwner(victimSessionId))?.name === `${PREFIX}victim_session`;
      const stillExists = await sessionExists(victimSessionId);

      if (authorizedChecksAre403 && ownershipScopedAre404 && ownerUnchanged && nameUnchanged && stillExists) {
        pass('5', "User cannot update/delete (403, unassigned mentor)/complete/open (404) another user's session, untouched");
      } else {
        fail('5', "Another user's session must be fully protected", `statuses=${[updateRes, completeRes, openRes, deleteRes].map(r => r.status)}, ownerUnchanged=${ownerUnchanged}, nameUnchanged=${nameUnchanged}, stillExists=${stillExists}`);
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

    // ── Student role restriction (bug fix): students can never create or ──────
    // delete a session, not even their own. A pre-existing session is
    // inserted directly (bypassing POST, which students can no longer use)
    // so cases 9-10 can verify select/open still works normally.
    const studentUsername = `${PREFIX}student`;
    const studentId = await createUser(studentUsername, 'student');
    const studentSessionId = await createSession(studentId, `${PREFIX}student_own_session`);
    const { cookie: studentCookie } = await login(base, studentUsername, TEST_PASSWORD);

    // ── Case 8: student cannot create a session, even for self ────────────────
    {
      const res = await fetch(sessionsBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
        body: JSON.stringify({ name: `${PREFIX}student_attempt` }),
      });
      const createdNone = (await pool.query(
        'SELECT id FROM learning_sessions WHERE name = $1', [`${PREFIX}student_attempt`]
      )).rows.length === 0;
      if (res.status === 403 && createdNone) {
        pass('8', 'Student cannot create a session, even for self (403, nothing created)');
      } else {
        fail('8', 'Student must never be able to create a session', `status=${res.status}, createdNone=${createdNone}`);
      }
    }

    // ── Case 9: student cannot delete their own session ────────────────────────
    {
      const res = await fetch(`${sessionsBase}/${studentSessionId}`, { method: 'DELETE', headers: { Cookie: studentCookie } });
      const stillExists = await sessionExists(studentSessionId);
      if (res.status === 403 && stillExists) {
        pass('9', "Student cannot delete their own session (403, session untouched)");
      } else {
        fail('9', 'Student must never be able to delete a session', `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case 10: student can still select/open their own existing session ────
    {
      const res = await fetch(`${sessionsBase}/${studentSessionId}/open`, { method: 'PATCH', headers: { Cookie: studentCookie } });
      const body = await res.json();
      if (res.status === 200 && body.id === studentSessionId) {
        pass('10', "Student can still open/select their own existing session (200) — create/delete are the only new restrictions");
      } else {
        fail('10', 'Student must still be able to open their own existing session', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 11: student cannot edit/rename their own session ─────────────────
    {
      const beforeName = (await sessionOwner(studentSessionId))?.name;
      const res = await fetch(`${sessionsBase}/${studentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
        body: JSON.stringify({ name: `${PREFIX}student_renamed_attempt` }),
      });
      const afterName = (await sessionOwner(studentSessionId))?.name;
      if (res.status === 403 && afterName === beforeName) {
        pass('11', 'Student cannot edit/rename their own session (403, name untouched)');
      } else {
        fail('11', 'Student must never be able to edit a session', `status=${res.status}, beforeName=${beforeName}, afterName=${afterName}`);
      }
    }

    // ── Case 12: existing incomplete-session validation still applies to students ──
    // studentSessionId has no filters, so all real academic tasks are in
    // scope and none have been run — completion must still be rejected.
    {
      const res = await fetch(`${sessionsBase}/${studentSessionId}/complete`, { method: 'PATCH', headers: { Cookie: studentCookie } });
      const body = await res.json();
      const row = await pool.query('SELECT status FROM learning_sessions WHERE id = $1', [studentSessionId]);
      const stillActive = row.rows[0]?.status !== 'completed';
      if (res.status === 400 && stillActive) {
        pass('12', `Student's incomplete session is still rejected by the existing completion-condition check (400: "${body.error}")`);
      } else {
        fail('12', 'Incomplete-session validation must still apply to students', `status=${res.status}, sessionStatus=${row.rows[0]?.status}`);
      }
    }

    // ── Case 13: student CAN complete their own session once conditions are met ──
    // A difficulty filter matching zero real tasks makes the "every in-scope
    // task was run" precondition trivially true — same trick as case 7.
    let studentCompletableSessionId;
    {
      studentCompletableSessionId = await createSession(studentId, `${PREFIX}student_completable`);
      await pool.query(
        "INSERT INTO learning_session_filters (session_id, filter_type, filter_value) VALUES ($1, 'difficulty', 'nonexistent-difficulty-xyz')",
        [studentCompletableSessionId]
      );
      const res = await fetch(`${sessionsBase}/${studentCompletableSessionId}/complete`, { method: 'PATCH', headers: { Cookie: studentCookie } });
      const raw = await res.text();
      const body = JSON.parse(raw);
      // Task 5: complete's response is enriched the same way as GET/POST/PATCH
      // /:id — owner_username/owner_role/created_by_username — with no leak.
      const noPasswordLeak = !/password/i.test(raw);
      const onlyAllowlisted = Object.keys(body).filter(k => /username/i.test(k)).every(k => ['owner_username', 'created_by_username', 'archived_by_username'].includes(k));
      const correctOwnerFields = body.owner_username === studentUsername && body.owner_role === 'student';
      if (res.status === 200 && body.status === 'completed' && correctOwnerFields && noPasswordLeak && onlyAllowlisted) {
        pass('13', `Student CAN complete their own session once completion conditions are satisfied (200, status=completed, owner_username=${body.owner_username}, no leak)`);
      } else {
        fail('13', 'Student must be able to complete their own eligible session, with correct enriched fields', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 14: student CANNOT complete another user's session ───────────────
    {
      const othersSessionId = await createSession(userBId, `${PREFIX}others_session_for_complete`);
      const res = await fetch(`${sessionsBase}/${othersSessionId}/complete`, { method: 'PATCH', headers: { Cookie: studentCookie } });
      const owner = await sessionOwner(othersSessionId);
      if (res.status === 404 && owner?.user_id === userBId) {
        pass('14', "Student cannot complete another user's session (404, untouched)");
      } else {
        fail('14', 'Student must not be able to complete another user\'s session', `status=${res.status}, owner=${JSON.stringify(owner)}`);
      }
    }

    // ── Mentor edit-authz matrix (bug fix): PATCH /:id used to be scoped to
    // WHERE user_id = actingUser.id, so a mentor could never edit a session
    // owned by an assigned student (always 404, "Session not found" in the
    // UI). Now it fetches the session by id first and authorizes via
    // canAccessStudent(actingUser, session.user_id) — same rule as
    // GET /api/sessions. Cases 15-19 cover the assigned/unassigned/admin/
    // nonexistent/no-leak matrix.
    const editMentorUsername = `${PREFIX}editMentor`;
    const editStudentUsername = `${PREFIX}editStudent`;
    const unassignedMentorUsername = `${PREFIX}unassignedMentor`;
    const editMentorId = await createUser(editMentorUsername, 'mentor');
    const editStudentId = await createUser(editStudentUsername, 'student');
    const unassignedMentorId = await createUser(unassignedMentorUsername, 'mentor');
    await pool.query('INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2)', [editMentorId, editStudentId]);
    const editStudentSessionId = await createSession(editStudentId, `${PREFIX}edit_student_session`);

    // ── Case 15: mentor can edit their assigned student's session ─────────────
    {
      const { cookie } = await login(base, editMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${editStudentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `${PREFIX}edit_student_session_renamed` }),
      });
      const body = await res.json();
      const owner = await sessionOwner(editStudentSessionId);
      if (res.status === 200 && body.session?.name === `${PREFIX}edit_student_session_renamed` && owner?.user_id === editStudentId) {
        pass('15', "Mentor can edit their assigned student's session (200, ownership unchanged)");
      } else {
        fail('15', "Mentor must be able to edit an assigned student's session", `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 16: mentor cannot edit an unassigned student's session ───────────
    {
      const { cookie } = await login(base, unassignedMentorUsername, TEST_PASSWORD);
      const beforeName = (await sessionOwner(editStudentSessionId))?.name;
      const res = await fetch(`${sessionsBase}/${editStudentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `${PREFIX}hijacked_by_unassigned_mentor` }),
      });
      const afterName = (await sessionOwner(editStudentSessionId))?.name;
      if (res.status === 403 && afterName === beforeName) {
        pass('16', "Mentor cannot edit an unassigned student's session (403, untouched)");
      } else {
        fail('16', "Mentor must not be able to edit an unassigned student's session", `status=${res.status}, beforeName=${beforeName}, afterName=${afterName}`);
      }
    }

    // ── Case 17: admin can edit any session, including a student's ────────────
    {
      const adminUsername = `${PREFIX}admin`;
      await createUser(adminUsername, 'admin');
      const { cookie } = await login(base, adminUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${editStudentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `${PREFIX}edit_student_session_by_admin` }),
      });
      const body = await res.json();
      if (res.status === 200 && body.session?.name === `${PREFIX}edit_student_session_by_admin`) {
        pass('17', "Admin can edit any session, including a student's (200)");
      } else {
        fail('17', 'Admin must be able to edit any session', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 18: editing a nonexistent session id returns 404 ─────────────────
    {
      const { cookie } = await login(base, editMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/999999999`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `${PREFIX}nonexistent` }),
      });
      if (res.status === 404) {
        pass('18', 'Editing a nonexistent session id returns 404');
      } else {
        fail('18', 'Editing a nonexistent session id must return 404', `status=${res.status}`);
      }
    }

    // ── Case 19: successful edit response leaks no password/unexpected user data ──
    // owner_username/owner_role/created_by_username are now intentional,
    // allowlisted fields on the session object (Task 4) — this check must
    // still catch password_hash or any OTHER/unrelated username-shaped key,
    // just not those three specific ones.
    {
      const { cookie } = await login(base, editMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${editStudentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `${PREFIX}edit_student_session_final` }),
      });
      const body = await res.json();
      const session = body.session || {};
      const noPasswordLeak = !JSON.stringify(session).match(/password/i);
      const usernameKeys = Object.keys(session).filter(k => /username/i.test(k));
      const onlyAllowlistedUsernameKeys = usernameKeys.every(k => ['owner_username', 'created_by_username', 'archived_by_username'].includes(k));
      const hasExpectedOwnerFields = session.owner_username === editStudentUsername && session.owner_role === 'student';
      if (res.status === 200 && noPasswordLeak && onlyAllowlistedUsernameKeys && hasExpectedOwnerFields) {
        pass('19', 'Edit response contains owner_username/owner_role (correct) and no password/unexpected user fields');
      } else {
        fail('19', 'Edit response must not leak password/unexpected user data',
          `status=${res.status}, noPasswordLeak=${noPasswordLeak}, usernameKeys=${JSON.stringify(usernameKeys)}, owner_username=${session.owner_username}, owner_role=${session.owner_role}`);
      }
    }

    // ── Mentor delete-authz matrix (bug fix): DELETE /:id had the same bug
    // PATCH /:id had — scoped to WHERE user_id = actingUser.id, so a mentor
    // could never actually delete an assigned student's session (always a
    // real, non-stale 404 "Session not found", and nothing was deleted).
    // Now it fetches the session by id first and authorizes via
    // canAccessStudent(actingUser, session.user_id), same as PATCH /:id.

    // ── Case 20: mentor cannot delete an unassigned student's session ─────────
    {
      const targetSessionId = await createSession(editStudentId, `${PREFIX}delete_unassigned_target`);
      const { cookie } = await login(base, unassignedMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${targetSessionId}`, { method: 'DELETE', headers: { Cookie: cookie } });
      const stillExists = await sessionExists(targetSessionId);
      if (res.status === 403 && stillExists) {
        pass('20', "Mentor cannot delete an unassigned student's session (403, untouched)");
      } else {
        fail('20', "Mentor must not be able to delete an unassigned student's session", `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case 21: mentor CAN delete their assigned student's session ───────────
    {
      const targetSessionId = await createSession(editStudentId, `${PREFIX}delete_assigned_target`);
      const { cookie } = await login(base, editMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${targetSessionId}`, { method: 'DELETE', headers: { Cookie: cookie } });
      const gone = !(await sessionExists(targetSessionId));
      if (res.status === 200 && gone) {
        pass('21', "Mentor can delete their assigned student's session (200, deleted)");
      } else {
        fail('21', "Mentor must be able to delete an assigned student's session", `status=${res.status}, gone=${gone}`);
      }
    }

    // ── Case 22: admin can delete any session, including a student's ──────────
    {
      const targetSessionId = await createSession(editStudentId, `${PREFIX}delete_admin_target`);
      const adminUsername = `${PREFIX}deleteAdmin`;
      await createUser(adminUsername, 'admin');
      const { cookie } = await login(base, adminUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${targetSessionId}`, { method: 'DELETE', headers: { Cookie: cookie } });
      const gone = !(await sessionExists(targetSessionId));
      if (res.status === 200 && gone) {
        pass('22', "Admin can delete any session, including a student's (200, deleted)");
      } else {
        fail('22', 'Admin must be able to delete any session', `status=${res.status}, gone=${gone}`);
      }
    }

    // ── Case 23: deleting a nonexistent session id returns 404 ─────────────────
    {
      const { cookie } = await login(base, editMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/999999998`, { method: 'DELETE', headers: { Cookie: cookie } });
      if (res.status === 404) {
        pass('23', 'Deleting a nonexistent session id returns 404');
      } else {
        fail('23', 'Deleting a nonexistent session id must return 404', `status=${res.status}`);
      }
    }

    // ── Case 24 (Task 5): complete response's created_by_username is populated
    // when the session actually has a creator (mentor-created for a student) ──
    {
      const mentorCreatedSessionId = await createSession(editStudentId, `${PREFIX}complete_created_by_check`);
      await pool.query('UPDATE learning_sessions SET created_by_user_id = $1 WHERE id = $2', [editMentorId, mentorCreatedSessionId]);
      await pool.query(
        "INSERT INTO learning_session_filters (session_id, filter_type, filter_value) VALUES ($1, 'difficulty', 'nonexistent-difficulty-xyz')",
        [mentorCreatedSessionId]
      );
      const { cookie } = await login(base, editStudentUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${mentorCreatedSessionId}/complete`, { method: 'PATCH', headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && body.created_by_username === editMentorUsername) {
        pass('24', `Complete response's created_by_username is populated for a mentor-created session (${body.created_by_username})`);
      } else {
        fail('24', "Complete response must carry the real created_by_username", `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 25 (open cleanup): PATCH /:id/open is self-only by design, even
    // for an assigned mentor — updating last_opened_at is a signal the
    // session's owner relies on for their own next-login pick, so a mentor
    // opening an assigned student's session from the dropdown must not
    // silently overwrite it on the student's behalf. ────────────────────────
    {
      const { cookie } = await login(base, editMentorUsername, TEST_PASSWORD);
      const beforeRow = await pool.query('SELECT last_opened_at FROM learning_sessions WHERE id = $1', [editStudentSessionId]);
      const res = await fetch(`${sessionsBase}/${editStudentSessionId}/open`, { method: 'PATCH', headers: { Cookie: cookie } });
      const afterRow = await pool.query('SELECT last_opened_at FROM learning_sessions WHERE id = $1', [editStudentSessionId]);
      const unchanged = String(beforeRow.rows[0].last_opened_at) === String(afterRow.rows[0].last_opened_at);
      if (res.status === 404 && unchanged) {
        pass('25', "Assigned mentor cannot open (mark last_opened_at on) the student's session — self-only by design (404, unchanged)");
      } else {
        fail('25', 'PATCH /:id/open must stay self-only even for an assigned mentor', `status=${res.status}, unchanged=${unchanged}`);
      }
    }

    // ── Case 26 (open cleanup): admin is not special-cased either — open
    // stays self-only for every role, unlike edit/delete/reopen. ───────────
    {
      const adminOpenUsername = `${PREFIX}adminOpenCheck`;
      await createUser(adminOpenUsername, 'admin');
      const { cookie } = await login(base, adminOpenUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${editStudentSessionId}/open`, { method: 'PATCH', headers: { Cookie: cookie } });
      if (res.status === 404) {
        pass('26', 'Admin cannot open another user\'s session either — open is self-only for every role (404)');
      } else {
        fail('26', 'PATCH /:id/open must stay self-only for admin too', `status=${res.status}`);
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
