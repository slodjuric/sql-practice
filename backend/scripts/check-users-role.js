'use strict';

/**
 * users.role migration + API shape verification script.
 *
 * Runs initDb() twice to prove the role migration is idempotent, then creates
 * real test users to verify the GET /api/users query shape, the default role
 * on creation, and rejection of invalid role values (both at the app-level
 * validator used by POST /api/users and at the DB CHECK constraint).
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:users-role
 */

const pool = require('../src/db');
const initDb = require('../src/initDb');
const { isValidRole } = require('../src/utils/roleValidator');

const PREFIX = '_role_test_';

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

async function run() {
  await cleanup();

  try {
    // ── Case 1: initDb() runs twice without error (migration idempotency) ────
    try {
      await initDb();
      await initDb();
      pass('01', 'initDb() runs twice without throwing (role migration is idempotent)');
    } catch (err) {
      fail('01', 'initDb() must be safely re-runnable', err.message);
    }

    // ── Case 2: creating a user without a role defaults to 'student' ─────────
    // Mirrors POST /api/users when `role` is omitted.
    const created = await pool.query(
      'INSERT INTO users (username) VALUES ($1) RETURNING id, username, role, created_at',
      [`${PREFIX}default`]
    );
    if (created.rows[0].role === 'student') {
      pass('02', "User created without role defaults to 'student'");
    } else {
      fail('02', "User created without role must default to 'student'", `got role=${created.rows[0].role}`);
    }

    // ── Case 3: GET /api/users query shape includes role ──────────────────────
    // Mirrors the exact SELECT used in GET /api/users.
    const listed = await pool.query(
      'SELECT id, username, role, created_at FROM users ORDER BY created_at ASC'
    );
    const hasRoleOnEveryRow = listed.rows.every(r => 'role' in r && typeof r.role === 'string');
    if (listed.rows.length > 0 && hasRoleOnEveryRow) {
      pass('03', `GET /api/users query returns role on every row (${listed.rows.length} row(s))`);
    } else {
      fail('03', 'GET /api/users query must return role on every row', JSON.stringify(listed.rows[0]));
    }

    // ── Case 4: explicit valid role is honored ────────────────────────────────
    const mentor = await pool.query(
      'INSERT INTO users (username, role) VALUES ($1, $2) RETURNING role',
      [`${PREFIX}mentor`, 'mentor']
    );
    if (mentor.rows[0].role === 'mentor') {
      pass('04', "Explicit valid role ('mentor') is stored as-is");
    } else {
      fail('04', "Explicit valid role must be honored", `got role=${mentor.rows[0].role}`);
    }

    // ── Case 5: app-level validator rejects an invalid role ───────────────────
    // Mirrors the isValidRole() check in POST /api/users.
    if (isValidRole('admin') && isValidRole('mentor') && isValidRole('student') && !isValidRole('superadmin')) {
      pass('05', 'isValidRole() accepts admin/mentor/student and rejects an unknown role');
    } else {
      fail('05', 'isValidRole() must accept exactly admin/mentor/student', 'unexpected result for one or more roles');
    }

    // ── Case 6: DB CHECK constraint rejects an invalid role at the data layer ─
    // Defense-in-depth: even if app-level validation were bypassed, the DB
    // must still refuse an invalid role value.
    try {
      await pool.query(
        'INSERT INTO users (username, role) VALUES ($1, $2)',
        [`${PREFIX}invalid`, 'superadmin']
      );
      fail('06', 'DB CHECK constraint must reject an invalid role', 'insert unexpectedly succeeded');
    } catch (err) {
      if (err.code === '23514') {
        pass('06', 'DB CHECK constraint rejects an invalid role (23514 check_violation)');
      } else {
        fail('06', 'Expected a check_violation (23514) for invalid role', `got code=${err.code}: ${err.message}`);
      }
    }

  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message);
    failed++;
  } finally {
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
