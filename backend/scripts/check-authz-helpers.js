'use strict';

/**
 * Unit-style verification for the new Step B authz helpers:
 *   canAccessUser, canAccessStudent, canCreateSessionForUser, canViewSession
 *
 * These are plain function calls against real DB-backed test users and a
 * real mentor_assignments row — no HTTP layer, no routes are wired to these
 * helpers yet (that's a later step). Follows the same "call the real
 * function, use real data" spirit as the other check-*.js scripts, just
 * without the Express/session plumbing since nothing here is a route.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:authz-helpers
 */

const pool = require('../src/db');
const {
  canAccessUser,
  canAccessStudent,
  canCreateSessionForUser,
  canViewSession,
} = require('../src/utils/authz');

const PREFIX = '_authzhelpers_test_';

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

function check(id, name, actual, expected) {
  if (actual === expected) {
    pass(id, name);
  } else {
    fail(id, name, `expected ${expected}, got ${actual}`);
  }
}

async function cleanup() {
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username, role) {
  const r = await pool.query(
    'INSERT INTO users (username, role) VALUES ($1, $2) RETURNING id',
    [username, role]
  );
  return { id: r.rows[0].id, username, role };
}

async function run() {
  await cleanup();

  try {
    // ── Setup ──────────────────────────────────────────────────────────────
    const admin           = await createUser(`${PREFIX}admin`,       'admin');
    const mentor           = await createUser(`${PREFIX}mentor`,       'mentor');
    const assignedStudent   = await createUser(`${PREFIX}assigned`,     'student');
    const unassignedStudent = await createUser(`${PREFIX}unassigned`,   'student');
    const otherStudent      = await createUser(`${PREFIX}other`,        'student');

    await pool.query(
      'INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2)',
      [mentor.id, assignedStudent.id]
    );

    // ── canAccessUser ──────────────────────────────────────────────────────
    check('01', 'admin canAccessUser(any user) => true',
      canAccessUser(admin, assignedStudent.id), true);
    check('02', 'student canAccessUser(self) => true',
      canAccessUser(assignedStudent, assignedStudent.id), true);
    check('03', 'student canAccessUser(other user) => false',
      canAccessUser(assignedStudent, otherStudent.id), false);
    check('04', 'mentor canAccessUser(assigned student) => false (account-level access is not granted to mentors)',
      canAccessUser(mentor, assignedStudent.id), false);
    check('05', 'no actingUser => canAccessUser false',
      canAccessUser(null, assignedStudent.id), false);

    // ── canAccessStudent ───────────────────────────────────────────────────
    check('06', 'admin canAccessStudent(any) => true',
      await canAccessStudent(admin, assignedStudent.id), true);
    check('07', 'student canAccessStudent(self) => true',
      await canAccessStudent(assignedStudent, assignedStudent.id), true);
    check('08', 'student canAccessStudent(other student) => false',
      await canAccessStudent(assignedStudent, otherStudent.id), false);
    check('09', 'mentor canAccessStudent(assigned student) => true',
      await canAccessStudent(mentor, assignedStudent.id), true);
    check('10', 'mentor canAccessStudent(unassigned student) => false',
      await canAccessStudent(mentor, unassignedStudent.id), false);
    check('11', 'no actingUser => canAccessStudent false',
      await canAccessStudent(null, assignedStudent.id), false);

    // ── canCreateSessionForUser ────────────────────────────────────────────
    check('12', 'mentor canCreateSessionForUser(assigned student) => true',
      await canCreateSessionForUser(mentor, assignedStudent.id), true);
    check('13', 'mentor canCreateSessionForUser(unassigned student) => false',
      await canCreateSessionForUser(mentor, unassignedStudent.id), false);
    check('14', 'student canCreateSessionForUser(self) => true',
      await canCreateSessionForUser(assignedStudent, assignedStudent.id), true);
    check('15', 'student canCreateSessionForUser(other student) => false',
      await canCreateSessionForUser(assignedStudent, otherStudent.id), false);
    check('16', 'admin canCreateSessionForUser(any) => true',
      await canCreateSessionForUser(admin, unassignedStudent.id), true);
    check('17', 'no actingUser => canCreateSessionForUser false',
      await canCreateSessionForUser(null, assignedStudent.id), false);

    // ── canViewSession ──────────────────────────────────────────────────────
    const assignedStudentSession   = { user_id: assignedStudent.id };
    const unassignedStudentSession = { user_id: unassignedStudent.id };
    check('18', 'mentor canViewSession(assigned student\'s session) => true',
      await canViewSession(mentor, assignedStudentSession), true);
    check('19', 'mentor canViewSession(unassigned student\'s session) => false',
      await canViewSession(mentor, unassignedStudentSession), false);
    check('20', 'student canViewSession(own session) => true',
      await canViewSession(assignedStudent, assignedStudentSession), true);
    check('21', 'student canViewSession(other student\'s session) => false',
      await canViewSession(otherStudent, assignedStudentSession), false);
    check('22', 'canViewSession(no session) => false',
      await canViewSession(admin, null), false);
    check('23', 'no actingUser => canViewSession false',
      await canViewSession(null, assignedStudentSession), false);

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
