'use strict';

/**
 * Schema verification for Step A of the professor/student role extension:
 *   - mentor_assignments table (columns, UNIQUE constraint, student index)
 *   - learning_sessions.created_by_user_id (column, backfill, index)
 *
 * Verifies the migration is idempotent (initDb() run twice) and that
 * existing sessions are correctly backfilled. No routes read/write this
 * schema yet — this script only checks the schema itself, directly via SQL,
 * following the same pattern as check-password-hashing.js.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:mentor-assignments-schema
 */

const pool = require('../src/db');
const initDb = require('../src/initDb');

const PREFIX = '_mentorschema_test_';

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
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username, role) {
  const r = await pool.query(
    'INSERT INTO users (username, role) VALUES ($1, $2) RETURNING id',
    [username, role]
  );
  return r.rows[0].id;
}

async function run() {
  await cleanup();

  try {
    // ── Case 1: initDb() runs twice without error ─────────────────────────────
    try {
      await initDb();
      await initDb();
      pass('01', 'initDb() runs twice without throwing (mentor_assignments + created_by_user_id migrations are idempotent)');
    } catch (err) {
      fail('01', 'initDb() must be safely re-runnable', err.message);
    }

    // ── Case 2: mentor_assignments table exists with expected columns ────────
    {
      const cols = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'mentor_assignments'
        ORDER BY ordinal_position
      `);
      const byName = Object.fromEntries(cols.rows.map(r => [r.column_name, r]));
      const hasAll = ['id', 'mentor_id', 'student_id', 'created_at'].every(c => byName[c]);
      const notNullable = byName.mentor_id?.is_nullable === 'NO' && byName.student_id?.is_nullable === 'NO';
      if (hasAll && notNullable) {
        pass('02', 'mentor_assignments table exists with id, mentor_id, student_id (NOT NULL), created_at');
      } else {
        fail('02', 'mentor_assignments must have the expected columns', JSON.stringify(cols.rows));
      }
    }

    // ── Case 3: UNIQUE(mentor_id, student_id) constraint exists ──────────────
    {
      const r = await pool.query(`
        SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'mentor_assignments'::regclass AND contype = 'u'
      `);
      const hasUnique = r.rows.some(row => row.def.includes('mentor_id') && row.def.includes('student_id'));
      if (hasUnique) {
        pass('03', 'UNIQUE(mentor_id, student_id) constraint exists');
      } else {
        fail('03', 'UNIQUE(mentor_id, student_id) constraint must exist', JSON.stringify(r.rows));
      }
    }

    // ── Case 4: index on student_id exists ────────────────────────────────────
    {
      const r = await pool.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'mentor_assignments' AND indexdef LIKE '%student_id%'
      `);
      if (r.rows.length > 0) {
        pass('04', `Index on mentor_assignments(student_id) exists (${r.rows.map(x => x.indexname).join(', ')})`);
      } else {
        fail('04', 'An index on student_id must exist', JSON.stringify(r.rows));
      }
    }

    // ── Case 5: ON DELETE CASCADE — deleting mentor or student removes the row
    {
      const mentorId  = await createUser(`${PREFIX}mentor`, 'mentor');
      const studentId = await createUser(`${PREFIX}student`, 'student');
      await pool.query(
        'INSERT INTO mentor_assignments (mentor_id, student_id) VALUES ($1, $2)',
        [mentorId, studentId]
      );
      await pool.query('DELETE FROM users WHERE id = $1', [studentId]);
      const remaining = await pool.query(
        'SELECT id FROM mentor_assignments WHERE mentor_id = $1',
        [mentorId]
      );
      if (remaining.rows.length === 0) {
        pass('05', 'Deleting a student cascades to remove their mentor_assignments row');
      } else {
        fail('05', 'ON DELETE CASCADE must remove the assignment row', `remaining=${JSON.stringify(remaining.rows)}`);
      }
    }

    // ── Case 6: learning_sessions.created_by_user_id column exists ───────────
    {
      const r = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'learning_sessions' AND column_name = 'created_by_user_id'
      `);
      if (r.rows.length === 1) {
        pass('06', 'learning_sessions.created_by_user_id column exists');
      } else {
        fail('06', 'learning_sessions.created_by_user_id must exist', JSON.stringify(r.rows));
      }
    }

    // ── Case 7: index on created_by_user_id exists ────────────────────────────
    {
      const r = await pool.query(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'learning_sessions' AND indexdef LIKE '%created_by_user_id%'
      `);
      if (r.rows.length > 0) {
        pass('07', `Index on learning_sessions(created_by_user_id) exists (${r.rows.map(x => x.indexname).join(', ')})`);
      } else {
        fail('07', 'An index on created_by_user_id must exist', JSON.stringify(r.rows));
      }
    }

    // ── Case 8: existing sessions are backfilled (created_by_user_id = user_id)
    {
      const mismatched = await pool.query(`
        SELECT COUNT(*)::int AS n FROM learning_sessions
        WHERE created_by_user_id IS NULL OR created_by_user_id <> user_id
      `);
      // This checks the *global* backfill correctness — every pre-existing
      // session (none of which had a creator recorded before this migration)
      // must now have created_by_user_id = user_id.
      if (mismatched.rows[0].n === 0) {
        pass('08', 'All existing sessions backfilled: created_by_user_id = user_id, none left NULL');
      } else {
        fail('08', 'All sessions must be backfilled to created_by_user_id = user_id', `mismatched count=${mismatched.rows[0].n}`);
      }
    }

    // ── Case 9: a newly created session (no explicit creator) still backfills
    // itself only via the app layer — confirm the column is nullable at the DB
    // level so route code decides the value (no DB default forces it).
    {
      const studentId = await createUser(`${PREFIX}freshstudent`, 'student');
      const dataset = await pool.query("SELECT id FROM datasets WHERE key = 'academic'");
      const r = await pool.query(
        `INSERT INTO learning_sessions (user_id, name, dataset_id)
         VALUES ($1, $2, $3) RETURNING created_by_user_id`,
        [studentId, `${PREFIX}fresh_session`, dataset.rows[0].id]
      );
      if (r.rows[0].created_by_user_id === null) {
        pass('09', 'created_by_user_id has no DB-level default — left to application code to set explicitly');
      } else {
        fail('09', 'created_by_user_id must not be auto-populated by a DB default', `got=${r.rows[0].created_by_user_id}`);
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
