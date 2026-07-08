'use strict';

/**
 * Authorization + behavior verification for PATCH /api/users/:id/role
 * (admin-only role editing from User Management).
 *
 * Spins up a minimal in-process Express app (session middleware + the auth,
 * users, and mentor-assignments routers, mounted the same way as in
 * src/index.js) on an ephemeral port. Authenticates via real
 * POST /api/auth/login and carries the resulting cookie on subsequent
 * requests.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:user-role-edit
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const usersRouter = require('../src/routes/users');
const mentorAssignmentsRouter = require('../src/routes/mentorAssignments');

const PREFIX = '_roleedit_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-user-role-edit-script-only';
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

async function getRole(userId) {
  const r = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.role ?? null;
}

async function adminCount() {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
  return r.rows[0].n;
}

async function assignmentExists(mentorId, studentId) {
  const r = await pool.query(
    'SELECT id FROM mentor_assignments WHERE mentor_id = $1 AND student_id = $2',
    [mentorId, studentId]
  );
  return r.rows.length > 0;
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
    app.use('/api/mentor-assignments', mentorAssignmentsRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const usersBase = `${base}/api/users`;
    const assignmentsBase = `${base}/api/mentor-assignments`;

    // Baseline admin count in this environment — the last-admin-guard case
    // below adapts to it instead of assuming a fresh DB with zero
    // pre-existing admins, same approach as check-authz.js's case e2.
    const baselineAdmins = await adminCount();

    // ── Setup ──────────────────────────────────────────────────────────────
    const adminUsername   = `${PREFIX}admin`;
    const mentorUsername  = `${PREFIX}mentor`;
    const studentUsername = `${PREFIX}student`;
    const adminId = await createUser(adminUsername, 'admin');
    await createUser(mentorUsername,  'mentor');
    await createUser(studentUsername, 'student');
    // let, not const — reassigned below (after case 9) once adminId's own
    // role has been changed away from 'admin', which would otherwise leave
    // every later case silently acting with whatever reduced privileges
    // adminId ends up holding (role is re-derived fresh per request — see
    // case 14 — so this isn't a stale-cookie bug, it's the actual live
    // behavior the earlier cases would otherwise be tripped up by).
    let { cookie: adminCookie }      = await login(base, adminUsername,   TEST_PASSWORD);
    const { cookie: mentorCookie }  = await login(base, mentorUsername,  TEST_PASSWORD);
    const { cookie: studentCookie } = await login(base, studentUsername, TEST_PASSWORD);

    // ── Case 1: anonymous → 401 ────────────────────────────────────────────
    {
      const targetId = await createUser(`${PREFIX}anon_target`, 'student', false);
      const res = await fetch(`${usersBase}/${targetId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'mentor' }),
      });
      const roleAfter = await getRole(targetId);
      if (res.status === 401 && roleAfter === 'student') {
        pass('1', 'Anonymous PATCH /api/users/:id/role returns 401 (role unchanged)');
      } else {
        fail('1', 'Anonymous request must return 401 and not change the role', `status=${res.status}, role=${roleAfter}`);
      }
    }

    // ── Case 2: mentor → 403 ───────────────────────────────────────────────
    {
      const targetId = await createUser(`${PREFIX}mentor_target`, 'student', false);
      const res = await fetch(`${usersBase}/${targetId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: mentorCookie },
        body: JSON.stringify({ role: 'admin' }),
      });
      const roleAfter = await getRole(targetId);
      if (res.status === 403 && roleAfter === 'student') {
        pass('2', 'Mentor PATCH /api/users/:id/role returns 403 (role unchanged)');
      } else {
        fail('2', 'Mentor request must return 403 and not change the role', `status=${res.status}, role=${roleAfter}`);
      }
    }

    // ── Case 3: student → 403 ──────────────────────────────────────────────
    {
      const targetId = await createUser(`${PREFIX}student_target`, 'student', false);
      const res = await fetch(`${usersBase}/${targetId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
        body: JSON.stringify({ role: 'admin' }),
      });
      const roleAfter = await getRole(targetId);
      if (res.status === 403 && roleAfter === 'student') {
        pass('3', 'Student PATCH /api/users/:id/role returns 403 (role unchanged)');
      } else {
        fail('3', 'Student request must return 403 and not change the role', `status=${res.status}, role=${roleAfter}`);
      }
    }

    // ── Case 4: admin changes a student to mentor → 200, role updated ─────
    {
      const targetId = await createUser(`${PREFIX}promote`, 'student', false);
      const res = await fetch(`${usersBase}/${targetId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'mentor' }),
      });
      const body = await res.json();
      const roleAfter = await getRole(targetId);
      if (res.status === 200 && roleAfter === 'mentor' && body.role === 'mentor' && body.removedAssignments === 0) {
        pass('4', "Admin can change a student's role to mentor (200, role updated, removedAssignments=0)");
      } else {
        fail('4', 'Admin role change to mentor must succeed', `status=${res.status}, roleAfter=${roleAfter}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 5: invalid role value → 400, role unchanged ───────────────────
    {
      const targetId = await createUser(`${PREFIX}invalidrole`, 'student', false);
      const res = await fetch(`${usersBase}/${targetId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'superadmin' }),
      });
      const roleAfter = await getRole(targetId);
      if (res.status === 400 && roleAfter === 'student') {
        pass('5', 'Invalid role value is rejected (400, role unchanged)');
      } else {
        fail('5', 'Invalid role value must be rejected without changing the role', `status=${res.status}, roleAfter=${roleAfter}`);
      }
    }

    // ── Case 6: nonexistent user id → 404 ──────────────────────────────────
    {
      const res = await fetch(`${usersBase}/999999999/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'mentor' }),
      });
      if (res.status === 404) {
        pass('6', 'Changing the role of a nonexistent user id returns 404');
      } else {
        fail('6', 'Nonexistent user id must return 404', `status=${res.status}`);
      }
    }

    // ── Case 7: same-role no-op → 200, no side effects ─────────────────────
    {
      const targetId = await createUser(`${PREFIX}noop`, 'student', false);
      const res = await fetch(`${usersBase}/${targetId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'student' }),
      });
      const body = await res.json();
      const roleAfter = await getRole(targetId);
      if (res.status === 200 && roleAfter === 'student' && body.removedAssignments === 0) {
        pass('7', 'Setting a role to its current value is a safe no-op (200, unchanged, removedAssignments=0)');
      } else {
        fail('7', 'Same-role update must be a safe no-op', `status=${res.status}, roleAfter=${roleAfter}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 8: last-admin guard blocks demoting the last remaining admin ──
    const admin2Username = `${PREFIX}admin2`;
    const admin2Id = await createUser(admin2Username, 'admin', false);
    {
      // With another admin (admin2) present, demoting the first test admin
      // must succeed — there is still at least one admin left afterward.
      const res = await fetch(`${usersBase}/${adminId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'mentor' }),
      });
      const roleAfter = await getRole(adminId);
      if (res.status === 200 && roleAfter === 'mentor') {
        pass('8', 'Demoting an admin succeeds when another admin remains (200, role updated)');
      } else {
        fail('8', 'Demoting an admin must succeed when another admin remains', `status=${res.status}, roleAfter=${roleAfter}`);
      }
    }
    {
      const { cookie: admin2Cookie } = await login(base, admin2Username, TEST_PASSWORD);
      const countBeforeSelfDemote = await adminCount();
      const res = await fetch(`${usersBase}/${admin2Id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: admin2Cookie },
        body: JSON.stringify({ role: 'student' }),
      });
      const roleAfter = await getRole(admin2Id);
      if (baselineAdmins === 0) {
        if (res.status === 400 && roleAfter === 'admin') {
          pass('9', `Demoting the last remaining admin is blocked (400, role unchanged, count was ${countBeforeSelfDemote})`);
        } else {
          fail('9', 'Demoting the last remaining admin must be blocked', `status=${res.status}, roleAfter=${roleAfter}, adminCountBefore=${countBeforeSelfDemote}`);
        }
      } else {
        console.log(`[9] SKIP — ${baselineAdmins} pre-existing admin(s) in this environment; cannot deterministically test the last-admin block without touching real users`);
      }
    }

    // adminId (and therefore adminCookie's underlying privileges) no longer
    // reliably holds 'admin' after cases 8/9 above — same reasoning as
    // check-authz.js's admin3 pattern for its post-last-admin-guard case.
    // Every case below needs a real admin actor, so get a fresh one instead
    // of assuming adminCookie is still usable for admin-only routes.
    const admin3Username = `${PREFIX}admin3`;
    await createUser(admin3Username, 'admin');
    ({ cookie: adminCookie } = await login(base, admin3Username, TEST_PASSWORD));

    // ── Case 10: leaving 'mentor' cleans up mentor_assignments where this
    // user was the mentor_id ────────────────────────────────────────────────
    {
      const mId = await createUser(`${PREFIX}m_leaving`, 'mentor', false);
      const sId = await createUser(`${PREFIX}s_for_m_leaving`, 'student', false);
      await fetch(assignmentsBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ mentorId: mId, studentId: sId }),
      });
      const existedBefore = await assignmentExists(mId, sId);

      const res = await fetch(`${usersBase}/${mId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'student' }),
      });
      const body = await res.json();
      const existsAfter = await assignmentExists(mId, sId);

      if (existedBefore && res.status === 200 && !existsAfter && body.removedAssignments === 1) {
        pass('10', "Changing a mentor's role away from 'mentor' removes their mentor_assignments row (removedAssignments=1)");
      } else {
        fail('10', 'Leaving mentor role must clean up mentor_assignments where this user was the mentor',
          `existedBefore=${existedBefore}, status=${res.status}, existsAfter=${existsAfter}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 11: leaving 'student' cleans up mentor_assignments where this
    // user was the student_id ───────────────────────────────────────────────
    {
      const mId = await createUser(`${PREFIX}m_for_s_leaving`, 'mentor', false);
      const sId = await createUser(`${PREFIX}s_leaving`, 'student', false);
      await fetch(assignmentsBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ mentorId: mId, studentId: sId }),
      });
      const existedBefore = await assignmentExists(mId, sId);

      const res = await fetch(`${usersBase}/${sId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'mentor' }),
      });
      const body = await res.json();
      const existsAfter = await assignmentExists(mId, sId);

      if (existedBefore && res.status === 200 && !existsAfter && body.removedAssignments === 1) {
        pass('11', "Changing a student's role away from 'student' removes their mentor_assignments row (removedAssignments=1)");
      } else {
        fail('11', 'Leaving student role must clean up mentor_assignments where this user was the student',
          `existedBefore=${existedBefore}, status=${res.status}, existsAfter=${existsAfter}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 12: an unrelated assignment is untouched by someone else's
    // role change ───────────────────────────────────────────────────────────
    {
      const bystanderMentorId  = await createUser(`${PREFIX}m_bystander`, 'mentor', false);
      const bystanderStudentId = await createUser(`${PREFIX}s_bystander`, 'student', false);
      await fetch(assignmentsBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ mentorId: bystanderMentorId, studentId: bystanderStudentId }),
      });

      const otherTargetId = await createUser(`${PREFIX}unrelated_target`, 'student', false);
      await fetch(`${usersBase}/${otherTargetId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'mentor' }),
      });

      const bystanderAssignmentStillExists = await assignmentExists(bystanderMentorId, bystanderStudentId);
      if (bystanderAssignmentStillExists) {
        pass('12', "An unrelated mentor_assignments row is untouched by someone else's role change");
      } else {
        fail('12', 'Unrelated assignment must remain untouched', `bystanderAssignmentStillExists=${bystanderAssignmentStillExists}`);
      }
    }

    // ── Case 13: response body never contains password_hash ────────────────
    {
      const targetId = await createUser(`${PREFIX}noleak`, 'student', false);
      const res = await fetch(`${usersBase}/${targetId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'mentor' }),
      });
      const body = await res.json();
      if (res.status === 200 && !('password_hash' in body)) {
        pass('13', 'Response body does not contain password_hash');
      } else {
        fail('13', 'Response must never contain password_hash', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 14: a role change takes effect immediately on the target's
    // existing session, with no re-login required ──────────────────────────
    {
      const liveUsername = `${PREFIX}live_session`;
      const liveId = await createUser(liveUsername, 'student');
      const { cookie: liveCookie } = await login(base, liveUsername, TEST_PASSWORD);

      const meBefore = await fetch(`${base}/api/auth/me`, { headers: { Cookie: liveCookie } });
      const meBeforeBody = await meBefore.json();

      await fetch(`${usersBase}/${liveId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ role: 'mentor' }),
      });

      const meAfter = await fetch(`${base}/api/auth/me`, { headers: { Cookie: liveCookie } });
      const meAfterBody = await meAfter.json();

      if (meBeforeBody.role === 'student' && meAfter.status === 200 && meAfterBody.role === 'mentor') {
        pass('14', "A role change is reflected immediately on the target's existing session (no re-login needed)");
      } else {
        fail('14', 'Role change must take effect immediately on the existing session',
          `before=${JSON.stringify(meBeforeBody)}, afterStatus=${meAfter.status}, after=${JSON.stringify(meAfterBody)}`);
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
