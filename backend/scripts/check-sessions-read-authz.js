'use strict';

/**
 * Authorization layer verification for GET /api/sessions,
 * GET /api/sessions/:id/filters, and GET /api/sessions/:id (Step 6e-3a —
 * session read routes only).
 *
 * GET /:id authorization (cases 18-25): shares its rule with GET /:id/filters
 * (canAccessStudent), except a student targeting someone else's session gets
 * 404 instead of 403 — anti-enumeration, matching PATCH /:id/reopen's rule —
 * so a student can't tell "doesn't exist" apart from "exists but isn't mine"
 * by probing ids. A denied mentor still gets the existing 403.
 *
 * Spins up a minimal in-process Express app (session middleware + the auth
 * router + the sessions router, mounted the same way as in src/index.js) on
 * an ephemeral port. Authenticates via real POST /api/auth/login and carries
 * the resulting cookie — userId is never sent by the client; the routes must
 * resolve it from the session and must not honor a spoofed ?userId= or
 * reveal another user's session by id.
 *
 * GET /:id/filters authorization (cases 6, 8-11): fetches the session by id
 * first, then authorizes via canAccessStudent(actingUser, session.user_id) —
 * same pattern as PATCH/DELETE /:id. A session that exists but isn't
 * accessible returns 403 (case 6, 9); a session that truly doesn't exist
 * returns 404 (case 7). This mirrors GET /api/sessions and fixes a prior bug
 * where this route was scoped to `WHERE user_id = actingUser.id` only, which
 * made a mentor/admin reviewing an assigned user's session always 404 —
 * silently resetting Edit Plan to empty filters.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:sessions-read-authz
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const authRouter = require('../src/routes/auth');
const sessionsRouter = require('../src/routes/sessions');

const PREFIX = '_sessread_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-sessions-read-authz-script-only';
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
    "DELETE FROM learning_session_filters WHERE session_id IN (SELECT id FROM learning_sessions WHERE name LIKE $1)",
    [`${PREFIX}%`]
  );
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

    // ── Setup: userA has 2 sessions, userB has 1 ──────────────────────────────
    const userAUsername = `${PREFIX}userA`;
    const userBUsername = `${PREFIX}userB`;
    const userAId = await createUser(userAUsername);
    const userBId = await createUser(userBUsername);

    const userASession1 = await createSession(userAId, `${PREFIX}a_session_1`);
    const userASession2 = await createSession(userAId, `${PREFIX}a_session_2`);
    const userBSession1 = await createSession(userBId, `${PREFIX}b_session_1`);

    // ── Case 1: unauthenticated GET /api/sessions → 401 ───────────────────────
    {
      const res = await fetch(sessionsBase);
      if (res.status === 401) {
        pass('1', 'Unauthenticated GET /api/sessions returns 401');
      } else {
        fail('1', 'Unauthenticated GET /api/sessions must return 401', `status=${res.status}`);
      }
    }

    // ── Case 2: logged-in user only sees their own sessions ──────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(sessionsBase, { headers: { Cookie: cookie } });
      const body = await res.json();
      const ids = body.map(s => s.id);
      const onlyOwn = ids.includes(userASession1) && ids.includes(userASession2) && !ids.includes(userBSession1);
      if (res.status === 200 && onlyOwn && ids.length === 2) {
        pass('2', 'Logged-in user sees only their own 2 sessions, not the other user\'s');
      } else {
        fail('2', 'Must return only the caller\'s own sessions', `status=${res.status}, ids=${JSON.stringify(ids)}`);
      }
    }

    // ── Case 3: spoofed ?userId= does not expose another user's sessions ─────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}?userId=${userBId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      const ids = body.map(s => s.id);
      const leaksVictim = ids.includes(userBSession1);
      if (res.status === 200 && !leaksVictim) {
        pass('3', "Spoofed ?userId= is ignored — still returns only the caller's own sessions");
      } else {
        fail('3', 'Spoofed userId must not expose another user\'s sessions', `status=${res.status}, ids=${JSON.stringify(ids)}`);
      }
    }

    // ── Case 4: unauthenticated GET /:id/filters → 401 ────────────────────────
    {
      const res = await fetch(`${sessionsBase}/${userASession1}/filters`);
      if (res.status === 401) {
        pass('4', 'Unauthenticated GET /:id/filters returns 401');
      } else {
        fail('4', 'Unauthenticated GET /:id/filters must return 401', `status=${res.status}`);
      }
    }

    // ── Case 5: own session filters can be read ───────────────────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${userASession1}/filters`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && 'planType' in body) {
        pass('5', 'Own session filters are readable (200)');
      } else {
        fail('5', 'Own session filters must be readable', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 6: another (unrelated) user's session filters return 403 ─────────
    // userA and userB are both plain students with no relationship —
    // canAccessStudent(userA, userB) is false, so the session is found but
    // access is denied: 403, not 404 (mirrors PATCH/DELETE /:id case 5/20).
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${userBSession1}/filters`, { headers: { Cookie: cookie } });
      if (res.status === 403) {
        pass('6', "Another unrelated user's session filters return 403 (found, not authorized)");
      } else {
        fail('6', "Another unrelated user's session filters must return 403", `status=${res.status}`);
      }
    }

    // ── Case 7: nonexistent session filters return 404 ────────────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/999999999/filters`, { headers: { Cookie: cookie } });
      if (res.status === 404) {
        pass('7', 'Nonexistent session filters return 404');
      } else {
        fail('7', 'Nonexistent session filters must return 404', `status=${res.status}`);
      }
    }

    // ── Mentor/admin filters-authz matrix (bug fix) ───────────────────────────
    const filtersMentorUsername = `${PREFIX}filtersMentor`;
    const filtersStudentUsername = `${PREFIX}filtersStudent`;
    const filtersUnassignedMentorUsername = `${PREFIX}filtersUnassignedMentor`;
    const filtersAdminUsername = `${PREFIX}filtersAdmin`;
    const filtersMentorId = await createUser(filtersMentorUsername, 'mentor');
    const filtersStudentId = await createUser(filtersStudentUsername, 'student');
    await createUser(filtersUnassignedMentorUsername, 'mentor');
    await createUser(filtersAdminUsername, 'admin');
    await pool.query('INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2)', [filtersMentorId, filtersStudentId]);
    const filtersStudentSessionId = await createSession(filtersStudentId, `${PREFIX}filters_student_session`);
    await pool.query(
      "INSERT INTO learning_session_filters (session_id, filter_type, filter_value) VALUES ($1, 'topic', 'join'), ($1, 'difficulty', 'hard')",
      [filtersStudentSessionId]
    );

    // ── Case 8: assigned mentor can fetch the student's real filters ──────────
    {
      const { cookie } = await login(base, filtersMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${filtersStudentSessionId}/filters`, { headers: { Cookie: cookie } });
      const body = await res.json();
      const hasRealFilters = body.topics?.includes('join') && body.difficulties?.includes('hard');
      if (res.status === 200 && hasRealFilters) {
        pass('8', "Assigned mentor fetches the student's real filters (200, not empty)");
      } else {
        fail('8', "Assigned mentor must fetch the real filters, not an empty fallback", `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 9: unassigned mentor cannot fetch the student's filters ──────────
    {
      const { cookie } = await login(base, filtersUnassignedMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${filtersStudentSessionId}/filters`, { headers: { Cookie: cookie } });
      if (res.status === 403) {
        pass('9', "Unassigned mentor cannot fetch the student's session filters (403)");
      } else {
        fail('9', "Unassigned mentor must not be able to fetch another student's filters", `status=${res.status}`);
      }
    }

    // ── Case 10: admin can fetch any user's session filters ───────────────────
    {
      const { cookie } = await login(base, filtersAdminUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${filtersStudentSessionId}/filters`, { headers: { Cookie: cookie } });
      const body = await res.json();
      const hasRealFilters = body.topics?.includes('join') && body.difficulties?.includes('hard');
      if (res.status === 200 && hasRealFilters) {
        pass('10', "Admin fetches any user's real session filters (200, not empty)");
      } else {
        fail('10', "Admin must be able to fetch any user's session filters", `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 11: student can fetch their own session filters (unaffected) ─────
    {
      const { cookie } = await login(base, filtersStudentUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${filtersStudentSessionId}/filters`, { headers: { Cookie: cookie } });
      const body = await res.json();
      const hasRealFilters = body.topics?.includes('join') && body.difficulties?.includes('hard');
      if (res.status === 200 && hasRealFilters) {
        pass('11', "Student fetches their own session's real filters (200)");
      } else {
        fail('11', "Student must be able to fetch their own session's filters", `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── GET /api/sessions owner/creator metadata (Task 4) ─────────────────────
    // filtersStudentSessionId was inserted directly via createSession(), which
    // never sets created_by_user_id — it stays NULL, exercising the
    // "deleted/never-set creator" case safely alongside the normal one below.

    // ── Case 12: self session response contains owner_username/owner_role ─────
    {
      const { cookie } = await login(base, filtersStudentUsername, TEST_PASSWORD);
      const res = await fetch(sessionsBase, { headers: { Cookie: cookie } });
      const body = await res.json();
      const row = body.find(s => s.id === filtersStudentSessionId);
      if (res.status === 200 && row?.owner_username === filtersStudentUsername && row?.owner_role === 'student') {
        pass('12', `Self session includes owner_username/owner_role (${row.owner_username}/${row.owner_role})`);
      } else {
        fail('12', 'Self session must include correct owner_username/owner_role', `status=${res.status}, row=${JSON.stringify(row)}`);
      }
    }

    // ── Case 13: null creator is handled safely (no crash, null/absent) ───────
    {
      const { cookie } = await login(base, filtersStudentUsername, TEST_PASSWORD);
      const res = await fetch(sessionsBase, { headers: { Cookie: cookie } });
      const body = await res.json();
      const row = body.find(s => s.id === filtersStudentSessionId);
      if (res.status === 200 && (row?.created_by_username === null || row?.created_by_username === undefined)) {
        pass('13', `Session with no creator set has created_by_username = ${row?.created_by_username} (no crash)`);
      } else {
        fail('13', 'Session with a null created_by_user_id must expose created_by_username as null, not crash or fabricate one', `status=${res.status}, row=${JSON.stringify(row)}`);
      }
    }

    // ── Case 14: created_by_username is populated when a session was actually
    // created by another allowed user (mentor creating for the student) ──────
    let mentorCreatedSessionId;
    {
      const { cookie } = await login(base, filtersMentorUsername, TEST_PASSWORD);
      const createRes = await fetch(sessionsBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `${PREFIX}mentor_created_for_student`, targetUserId: filtersStudentId }),
      });
      const createBody = await createRes.json();
      mentorCreatedSessionId = createBody.session?.id;
      const hasCorrectFields = createBody.session?.owner_username === filtersStudentUsername
        && createBody.session?.owner_role === 'student'
        && createBody.session?.created_by_username === filtersMentorUsername;
      if (createRes.status === 201 && hasCorrectFields) {
        pass('14', `POST response already carries correct owner/creator fields (owner=${createBody.session.owner_username}, created_by=${createBody.session.created_by_username})`);
      } else {
        fail('14', 'POST response must carry correct owner_username/owner_role/created_by_username', `status=${createRes.status}, session=${JSON.stringify(createBody.session)}`);
      }
    }

    // ── Case 15: mentor fetching assigned student's sessions sees correct
    // owner_username/owner_role and the populated created_by_username ────────
    {
      const { cookie } = await login(base, filtersMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}?targetUserId=${filtersStudentId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      const row = body.find(s => s.id === mentorCreatedSessionId);
      const ok = row?.owner_username === filtersStudentUsername && row?.owner_role === 'student' && row?.created_by_username === filtersMentorUsername;
      if (res.status === 200 && ok) {
        pass('15', 'Mentor reviewing assigned student sees correct owner_username/owner_role/created_by_username');
      } else {
        fail('15', 'Mentor must see correct owner/creator fields for an assigned student\'s session', `status=${res.status}, row=${JSON.stringify(row)}`);
      }
    }

    // ── Case 16: admin fetching any user's sessions sees correct fields ───────
    {
      const { cookie } = await login(base, filtersAdminUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}?targetUserId=${filtersStudentId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      const row = body.find(s => s.id === mentorCreatedSessionId);
      const ok = row?.owner_username === filtersStudentUsername && row?.owner_role === 'student' && row?.created_by_username === filtersMentorUsername;
      if (res.status === 200 && ok) {
        pass('16', "Admin reviewing any user sees correct owner_username/owner_role/created_by_username");
      } else {
        fail('16', 'Admin must see correct owner/creator fields for any user\'s session', `status=${res.status}, row=${JSON.stringify(row)}`);
      }
    }

    // ── Case 17: no password_hash or full user object ever leaks ──────────────
    {
      const { cookie } = await login(base, filtersAdminUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}?targetUserId=${filtersStudentId}`, { headers: { Cookie: cookie } });
      const raw = await res.text();
      const noPasswordLeak = !/password/i.test(raw);
      const body = JSON.parse(raw);
      const onlyAllowlistedUsernameKeys = body.every(row =>
        Object.keys(row).filter(k => /username/i.test(k)).every(k => ['owner_username', 'created_by_username', 'archived_by_username'].includes(k))
      );
      if (res.status === 200 && noPasswordLeak && onlyAllowlistedUsernameKeys) {
        pass('17', 'No password_hash or unexpected username-shaped field ever leaks from GET /api/sessions');
      } else {
        fail('17', 'GET /api/sessions must never leak password_hash or unrelated user fields', `noPasswordLeak=${noPasswordLeak}, onlyAllowlisted=${onlyAllowlistedUsernameKeys}`);
      }
    }

    // ── GET /api/sessions/:id (canonical single-session read) ────────────────
    // Reuses the same authz fixtures set up above (filtersMentor/Student/
    // UnassignedMentor/Admin, and the plain unrelated userA/userB pair) —
    // this route shares its authorization rule with GET /:id/filters
    // (canAccessStudent), except a student targeting someone else's session
    // gets 404 instead of 403 (anti-enumeration, same as PATCH /:id/reopen).

    // ── Case 18: invalid (non-numeric) id returns 400 ─────────────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/not-a-number`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 400 && body.error === 'Invalid session id.') {
        pass('18', 'GET /:id with a non-numeric id returns 400');
      } else {
        fail('18', 'GET /:id with a non-numeric id must return 400', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 19: nonexistent session returns 404 ──────────────────────────────
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/999999999`, { headers: { Cookie: cookie } });
      if (res.status === 404) {
        pass('19', 'GET /:id for a nonexistent session returns 404');
      } else {
        fail('19', 'GET /:id for a nonexistent session must return 404', `status=${res.status}`);
      }
    }

    // ── Case 20: a student can read their own session (200, enriched shape) ──
    {
      const { cookie } = await login(base, filtersStudentUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${filtersStudentSessionId}`, { headers: { Cookie: cookie } });
      const raw = await res.text();
      const body = JSON.parse(raw);
      const enriched = body.id === filtersStudentSessionId
        && body.owner_username === filtersStudentUsername
        && body.owner_role === 'student'
        && 'dataset_key' in body
        && !('session' in body) && !('filters' in body);
      const noPasswordLeak = !/password/i.test(raw);
      if (res.status === 200 && enriched && noPasswordLeak) {
        pass('20', 'Student reading their own session gets 200 with the full enriched, flat shape (owner_username/dataset_key present, no wrapper, no leak)');
      } else {
        fail('20', 'Student must be able to read their own session with the enriched shape', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 21: a student reading another (unrelated) user's session gets ────
    // 404, not 403 — anti-enumeration, same rule as PATCH /:id/reopen.
    {
      const { cookie } = await login(base, userAUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${userBSession1}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 404 && body.error === 'Session not found.') {
        pass('21', "Student reading another unrelated user's session gets 404 (anti-enumeration), not 403");
      } else {
        fail('21', "Student reading another user's session must return 404, not reveal it exists via 403", `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 22: an assigned mentor can read the student's session (200) ─────
    {
      const { cookie } = await login(base, filtersMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${filtersStudentSessionId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && body.id === filtersStudentSessionId) {
        pass('22', "Assigned mentor reading the student's session gets 200");
      } else {
        fail('22', "Assigned mentor must be able to read an assigned student's session", `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 23: an unassigned mentor is denied (existing denied behavior — ──
    // 403, same as GET /:id/filters case 9, not the student-only 404 rule).
    {
      const { cookie } = await login(base, filtersUnassignedMentorUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${filtersStudentSessionId}`, { headers: { Cookie: cookie } });
      if (res.status === 403) {
        pass('23', "Unassigned mentor reading the student's session gets 403 (existing denied behavior, not the student anti-enumeration 404)");
      } else {
        fail('23', 'Unassigned mentor must be denied with 403', `status=${res.status}`);
      }
    }

    // ── Case 24: admin can read any session (200) ─────────────────────────────
    {
      const { cookie } = await login(base, filtersAdminUsername, TEST_PASSWORD);
      const res = await fetch(`${sessionsBase}/${filtersStudentSessionId}`, { headers: { Cookie: cookie } });
      const body = await res.json();
      if (res.status === 200 && body.id === filtersStudentSessionId) {
        pass('24', 'Admin reading any session gets 200');
      } else {
        fail('24', 'Admin must be able to read any session', `status=${res.status}, body=${JSON.stringify(body)}`);
      }
    }

    // ── Case 25: unauthenticated request returns 401 ──────────────────────────
    {
      const res = await fetch(`${sessionsBase}/${filtersStudentSessionId}`);
      if (res.status === 401) {
        pass('25', 'Unauthenticated GET /:id returns 401');
      } else {
        fail('25', 'Unauthenticated GET /:id must return 401', `status=${res.status}`);
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
