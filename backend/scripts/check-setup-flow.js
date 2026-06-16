'use strict';

/**
 * End-to-end setup flow verification.
 *
 * Tests the full sequence a new user would follow:
 *   1.  npm run db:init  →  academic schema + 7 practice tables created + populated
 *   2.  server start     →  5 progress tables created by initDb.js
 *   3.  create user      →  user saved to DB
 *   4.  create session   →  session saved to DB
 *   5.  run attempt      →  task_attempts row written
 *   6.  check attempt    →  user_task_progress row written
 *   7.  db:init again    →  practice tables reset; all user data survives
 *
 * Run against the temporary test database:
 *   DATABASE_URL=postgres://USER@localhost/sql_practice_e2e_test \
 *     node scripts/check-setup-flow.js
 */

const fs      = require('fs');
const path    = require('path');
const { Client, Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const SQL_FILE = path.resolve(__dirname, '../db/schemas/academic.sql');

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(id, msg)         { console.log(`[${id}] PASS — ${msg}`); passed++; }
function fail(id, msg, detail) { console.log(`[${id}] FAIL — ${msg}: ${detail}`); failed++; }

function connConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'sql_practice',
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
  };
}

async function runSqlFile(client) {
  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  await client.query(sql);
}

// Minimal in-process version of initDb — creates progress tables only,
// no seed data.  Must stay in sync structurally with src/initDb.js.
async function runInitDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS datasets (
      id          SERIAL PRIMARY KEY,
      key         VARCHAR(50) UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      schema_name VARCHAR(50) NOT NULL,
      description TEXT,
      type        VARCHAR(20) NOT NULL DEFAULT 'official',
      is_active   BOOLEAN NOT NULL DEFAULT true,
      created_by  INTEGER NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO datasets (key, name, schema_name, description, type)
    VALUES ('academic', 'Academic', 'academic',
            'University practice dataset with faculties, departments, professors, subjects, students and exams',
            'official')
    ON CONFLICT (key) DO NOTHING
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   VARCHAR(50) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS learning_sessions (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      description    TEXT,
      plan_type      VARCHAR(20) DEFAULT 'topic',
      dataset_id     INTEGER REFERENCES datasets(id),
      status         TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'completed')),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at   TIMESTAMPTZ,
      last_opened_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_attempts (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      session_id    INTEGER REFERENCES learning_sessions(id) ON DELETE CASCADE,
      task_id       INTEGER NOT NULL,
      submitted_sql TEXT NOT NULL,
      is_correct    BOOLEAN,
      error_message TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_task_progress (
      id                 SERIAL PRIMARY KEY,
      user_id            INTEGER NOT NULL REFERENCES users(id),
      session_id         INTEGER REFERENCES learning_sessions(id) ON DELETE CASCADE,
      task_id            INTEGER NOT NULL,
      status             VARCHAR(20) NOT NULL DEFAULT 'not_started'
                           CHECK (status IN ('not_started', 'in_progress', 'solved')),
      attempts_count     INTEGER NOT NULL DEFAULT 0,
      last_submitted_sql TEXT,
      last_attempt_at    TIMESTAMPTZ,
      solved_at          TIMESTAMPTZ,
      CONSTRAINT utp_user_session_task_unique UNIQUE (user_id, session_id, task_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS learning_session_filters (
      id           SERIAL PRIMARY KEY,
      session_id   INTEGER NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
      filter_type  VARCHAR(20) NOT NULL,
      filter_value VARCHAR(100) NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_sessions_user_name_unique
    ON learning_sessions(user_id, name)
  `);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run() {
  const cfg  = connConfig();
  const pool = new Pool(cfg);
  const client = await pool.connect();

  try {
    // ── Step 1: db:init on empty DB ──────────────────────────────────────────
    console.log('\n── Step 1: db:init on fresh empty database ──');
    try {
      await runSqlFile(client);
      pass('01', 'academic.sql executed without error');
    } catch (err) {
      fail('01', 'academic.sql executed', err.message);
    }

    // ── Step 2: Verify 7 practice tables + row counts ────────────────────────
    console.log('\n── Step 2: Verify practice table row counts (academic schema) ──');
    const expected = {
      faculties:          6,
      departments:       17,
      professors:        10,
      subjects:          48,
      students:          90,
      exams:            160,
      professor_subjects: 50,
    };
    for (const [table, count] of Object.entries(expected)) {
      try {
        const r = await client.query(`SELECT COUNT(*) AS n FROM academic.${table}`);
        const got = parseInt(r.rows[0].n, 10);
        if (got === count) {
          pass(`02-${table}`, `academic.${table}: ${got} rows`);
        } else {
          fail(`02-${table}`, `academic.${table} row count`, `expected ${count}, got ${got}`);
        }
      } catch (err) {
        fail(`02-${table}`, `academic.${table} exists`, err.message);
      }
    }

    // ── Step 3: initDb.js equivalent — create progress tables ────────────────
    console.log('\n── Step 3: Progress tables (server startup simulation) ──');
    try {
      await runInitDb(pool);
      pass('03', 'Progress tables created by initDb equivalent');
    } catch (err) {
      fail('03', 'Progress tables created', err.message);
    }

    const progressTables = ['datasets','users','learning_sessions','learning_session_filters','task_attempts','user_task_progress'];
    for (const table of progressTables) {
      try {
        await client.query(`SELECT 1 FROM ${table} LIMIT 1`);
        pass(`03-${table}`, `${table} exists`);
      } catch (err) {
        fail(`03-${table}`, `${table} exists`, err.message);
      }
    }

    // ── Step 4: Simulate UI — create user ────────────────────────────────────
    console.log('\n── Step 4: Create user ──');
    let userId;
    try {
      const r = await client.query(
        `INSERT INTO users (username) VALUES ('e2e_test_user') RETURNING id`
      );
      userId = r.rows[0].id;
      pass('04', `User created (id=${userId})`);
    } catch (err) {
      fail('04', 'User created', err.message);
    }

    // ── Step 5: Simulate UI — create learning session ────────────────────────
    console.log('\n── Step 5: Create learning session ──');
    let sessionId;
    try {
      const datasetRow = await client.query(`SELECT id FROM datasets WHERE key = 'academic'`);
      const datasetId  = datasetRow.rows[0]?.id;
      const r = await client.query(
        `INSERT INTO learning_sessions (user_id, name, plan_type, dataset_id)
         VALUES ($1, 'Test Session', 'topic', $2) RETURNING id`,
        [userId, datasetId]
      );
      sessionId = r.rows[0].id;
      pass('05', `Session created (id=${sessionId}, dataset_id=${datasetId})`);
    } catch (err) {
      fail('05', 'Session created', err.message);
    }

    // ── Step 6: Simulate run attempt ─────────────────────────────────────────
    console.log('\n── Step 6: Run attempt saved ──');
    try {
      await client.query(
        `INSERT INTO task_attempts (user_id, session_id, task_id, submitted_sql, is_correct)
         VALUES ($1, $2, 101, 'SELECT * FROM students', null)`,
        [userId, sessionId]
      );
      const r = await client.query(
        `SELECT COUNT(*) AS n FROM task_attempts WHERE user_id = $1`, [userId]
      );
      const got = parseInt(r.rows[0].n, 10);
      if (got === 1) {
        pass('06', 'Run attempt recorded in task_attempts');
      } else {
        fail('06', 'Run attempt recorded', `got ${got} rows`);
      }
    } catch (err) {
      fail('06', 'Run attempt recorded', err.message);
    }

    // ── Step 7: Simulate check attempt ───────────────────────────────────────
    console.log('\n── Step 7: Check attempt saved ──');
    try {
      await client.query(
        `INSERT INTO user_task_progress
           (user_id, session_id, task_id, status, attempts_count, solved_at)
         VALUES ($1, $2, 101, 'solved', 1, NOW())`,
        [userId, sessionId]
      );
      const r = await client.query(
        `SELECT status FROM user_task_progress WHERE user_id = $1 AND task_id = 101`,
        [userId]
      );
      if (r.rows[0]?.status === 'solved') {
        pass('07', 'Check attempt recorded in user_task_progress (status=solved)');
      } else {
        fail('07', 'Check attempt recorded', `status=${r.rows[0]?.status}`);
      }
    } catch (err) {
      fail('07', 'Check attempt recorded', err.message);
    }

    // ── Step 8: db:init again — practice tables reset ────────────────────────
    console.log('\n── Step 8: db:init again — verify isolation ──');
    try {
      await runSqlFile(client);
      pass('08', 'Second academic.sql executed without error');
    } catch (err) {
      fail('08', 'Second academic.sql executed', err.message);
    }

    // ── Step 9: Verify practice tables reset ─────────────────────────────────
    console.log('\n── Step 9: Practice tables reset correctly ──');
    for (const [table, count] of Object.entries(expected)) {
      try {
        const r = await client.query(`SELECT COUNT(*) AS n FROM academic.${table}`);
        const got = parseInt(r.rows[0].n, 10);
        if (got === count) {
          pass(`09-${table}`, `academic.${table} reset to ${count} rows`);
        } else {
          fail(`09-${table}`, `academic.${table} reset`, `expected ${count}, got ${got}`);
        }
      } catch (err) {
        fail(`09-${table}`, `academic.${table} still accessible`, err.message);
      }
    }

    // ── Step 10: Verify user data survived ───────────────────────────────────
    console.log('\n── Step 10: User data survived second db:init ──');
    try {
      const uRow = await client.query(`SELECT id FROM users WHERE id = $1`, [userId]);
      if (uRow.rows.length === 1) {
        pass('10-users', 'users row survived');
      } else {
        fail('10-users', 'users row survived', 'row missing');
      }
    } catch (err) {
      fail('10-users', 'users table accessible', err.message);
    }
    try {
      const sRow = await client.query(`SELECT id FROM learning_sessions WHERE id = $1`, [sessionId]);
      if (sRow.rows.length === 1) {
        pass('10-sessions', 'learning_sessions row survived');
      } else {
        fail('10-sessions', 'learning_sessions row survived', 'row missing');
      }
    } catch (err) {
      fail('10-sessions', 'learning_sessions table accessible', err.message);
    }
    try {
      const aRow = await client.query(
        `SELECT COUNT(*) AS n FROM task_attempts WHERE user_id = $1`, [userId]
      );
      const got = parseInt(aRow.rows[0].n, 10);
      if (got === 1) {
        pass('10-attempts', 'task_attempts row survived');
      } else {
        fail('10-attempts', 'task_attempts row survived', `got ${got} rows`);
      }
    } catch (err) {
      fail('10-attempts', 'task_attempts table accessible', err.message);
    }
    try {
      const pRow = await client.query(
        `SELECT status FROM user_task_progress WHERE user_id = $1 AND task_id = 101`,
        [userId]
      );
      if (pRow.rows[0]?.status === 'solved') {
        pass('10-progress', 'user_task_progress row survived (status=solved)');
      } else {
        fail('10-progress', 'user_task_progress row survived', `status=${pRow.rows[0]?.status}`);
      }
    } catch (err) {
      fail('10-progress', 'user_task_progress table accessible', err.message);
    }

    // ── Step 11: Verify search_path scoping ──────────────────────────────────
    console.log('\n── Step 11: search_path scoping ──');
    try {
      await client.query(`SET search_path = academic, pg_catalog`);
      const r = await client.query(`SELECT COUNT(*) AS n FROM students`);
      const got = parseInt(r.rows[0].n, 10);
      if (got === 90) {
        pass('11', 'Unqualified SELECT * FROM students works with search_path = academic');
      } else {
        fail('11', 'Unqualified students count', `expected 90, got ${got}`);
      }
      await client.query(`SET search_path = public, pg_catalog`);
    } catch (err) {
      fail('11', 'search_path scoping', err.message);
    }

  } finally {
    client.release();
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
