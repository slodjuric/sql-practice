'use strict';

/**
 * Authorization layer verification for DELETE /api/users/:id.
 *
 * Spins up a minimal in-process Express app (just the users router, mounted
 * the same way as in src/index.js) on an ephemeral port, and issues real
 * HTTP requests against it so requireRole()'s middleware and the route
 * handler are exercised exactly as in production — not reimplemented by hand.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:authz
 */

const express = require('express');
const pool = require('../src/db');
const usersRouter = require('../src/routes/users');

const PREFIX = '_authz_test_';

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

async function createUser(username, role) {
  const r = await pool.query(
    'INSERT INTO users (username, role) VALUES ($1, $2) RETURNING id',
    [username, role]
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

async function run() {
  await cleanup();

  let server;
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/users', usersRouter);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}/api/users`;

    // Baseline admin count in this environment, measured before we create any
    // temp admins of our own — lets the last-admin-guard cases below adapt
    // instead of assuming a fresh DB with zero pre-existing admins.
    const baselineAdmins = await adminCount();

    // ── Setup: one acting user per role, plus one victim per case ────────────
    const adminId   = await createUser(`${PREFIX}admin`,   'admin');
    const mentorId  = await createUser(`${PREFIX}mentor`,  'mentor');
    const studentId = await createUser(`${PREFIX}student`, 'student');

    const victimForAdmin   = await createUser(`${PREFIX}victim_admin`,   'student');
    const victimForStudent = await createUser(`${PREFIX}victim_student`, 'student');
    const victimForMentor  = await createUser(`${PREFIX}victim_mentor`,  'student');
    const victimForMissing = await createUser(`${PREFIX}victim_missing`, 'student');
    const victimForInvalid = await createUser(`${PREFIX}victim_invalid`, 'student');

    // ── Case a: admin can delete a test user ──────────────────────────────────
    {
      const res = await fetch(`${base}/${victimForAdmin}`, {
        method: 'DELETE',
        headers: { 'x-acting-user-id': String(adminId) },
      });
      const stillExists = await userExists(victimForAdmin);
      if (res.status === 200 && !stillExists) {
        pass('a', 'Admin can delete a test user (200, row removed)');
      } else {
        fail('a', 'Admin must be able to delete a user', `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case b: student cannot delete a user ──────────────────────────────────
    {
      const res = await fetch(`${base}/${victimForStudent}`, {
        method: 'DELETE',
        headers: { 'x-acting-user-id': String(studentId) },
      });
      const stillExists = await userExists(victimForStudent);
      if (res.status === 403 && stillExists) {
        pass('b', 'Student cannot delete a user (403, row untouched)');
      } else {
        fail('b', 'Student must be forbidden from deleting a user', `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case c: mentor cannot delete a user ────────────────────────────────────
    {
      const res = await fetch(`${base}/${victimForMentor}`, {
        method: 'DELETE',
        headers: { 'x-acting-user-id': String(mentorId) },
      });
      const stillExists = await userExists(victimForMentor);
      if (res.status === 403 && stillExists) {
        pass('c', 'Mentor cannot delete a user (403, row untouched)');
      } else {
        fail('c', 'Mentor must be forbidden from deleting a user', `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case d: missing acting user returns 401 ────────────────────────────────
    {
      const res = await fetch(`${base}/${victimForMissing}`, { method: 'DELETE' });
      const stillExists = await userExists(victimForMissing);
      if (res.status === 401 && stillExists) {
        pass('d', 'Missing acting user header returns 401 (row untouched)');
      } else {
        fail('d', 'Missing acting user must return 401', `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case e: invalid/nonexistent acting user returns 401 ────────────────────
    {
      const res = await fetch(`${base}/${victimForInvalid}`, {
        method: 'DELETE',
        headers: { 'x-acting-user-id': '999999999' },
      });
      const stillExists = await userExists(victimForInvalid);
      if (res.status === 401 && stillExists) {
        pass('e', 'Nonexistent acting user id returns 401 (row untouched)');
      } else {
        fail('e', 'Nonexistent acting user must return 401', `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case f: deleting an admin is allowed while another admin still exists ──
    // At this point adminId is the only admin we've created; add a second so
    // the global count is baselineAdmins + 2 before this delete.
    const admin2Id = await createUser(`${PREFIX}admin2`, 'admin');
    {
      const res = await fetch(`${base}/${admin2Id}`, {
        method: 'DELETE',
        headers: { 'x-acting-user-id': String(adminId) },
      });
      const stillExists = await userExists(admin2Id);
      if (res.status === 200 && !stillExists) {
        pass('f', 'Admin can delete another admin while more than one admin exists (200, row removed)');
      } else {
        fail('f', 'Deleting an admin must succeed when another admin remains', `status=${res.status}, stillExists=${stillExists}`);
      }
    }

    // ── Case g: deleting the last remaining admin is blocked ──────────────────
    // Only runs the hard assertion when this environment has no pre-existing
    // admins of its own — otherwise adminId deleting itself would legitimately
    // succeed (real admins would still remain) and the guard wouldn't fire.
    {
      const countBeforeSelfDelete = await adminCount();
      const res = await fetch(`${base}/${adminId}`, {
        method: 'DELETE',
        headers: { 'x-acting-user-id': String(adminId) },
      });
      const stillExists = await userExists(adminId);

      if (baselineAdmins === 0) {
        if (res.status === 400 && stillExists) {
          pass('g', `Deleting the last remaining admin is blocked (400, row untouched, count was ${countBeforeSelfDelete})`);
        } else {
          fail('g', 'Deleting the last remaining admin must be blocked', `status=${res.status}, stillExists=${stillExists}, adminCountBefore=${countBeforeSelfDelete}`);
        }
      } else {
        console.log(`[g] SKIP — ${baselineAdmins} pre-existing admin(s) in this environment; cannot deterministically test the last-admin block without touching real users`);
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
