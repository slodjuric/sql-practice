'use strict';

/**
 * Small, focused regression coverage for the pg_advisory_xact_lock added
 * around initDb() (src/initDb.js) — prevents two concurrently-starting
 * backend instances from both passing a check-then-ALTER migration guard
 * before either has applied it.
 *
 * Cases:
 *   1  Two genuinely concurrent initDb() calls (fired together via
 *      Promise.all, not one-after-another) both resolve without error —
 *      the exact race the lock exists to prevent: two instances starting
 *      at once, one being serialized behind the other rather than both
 *      racing the same check-then-ALTER guards.
 *   2  After initDb() completes, the advisory lock is free — a second
 *      caller can acquire it immediately (pg_try_advisory_lock, which
 *      never blocks) — proving the lock isn't left permanently held.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:initdb-lock
 */

const pool = require('../src/db');
const initDb = require('../src/initDb');

// Must match src/initDb.js's INIT_DB_LOCK_KEY exactly.
const INIT_DB_LOCK_KEY = 823951042;

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

async function run() {
  try {
    // ── Case 1: two concurrent initDb() calls both succeed ─────────────────
    try {
      await Promise.all([initDb(), initDb()]);
      pass('1', 'Two concurrent initDb() calls both resolve without error (serialized by the advisory lock, not racing each other)');
    } catch (err) {
      fail('1', 'Two concurrent initDb() calls must both succeed', err.message);
    }

    // ── Case 2: the lock is free afterward — not left permanently held ─────
    {
      const result = await pool.query('SELECT pg_try_advisory_lock($1) AS acquired', [INIT_DB_LOCK_KEY]);
      const acquired = result.rows[0].acquired;
      if (acquired) {
        await pool.query('SELECT pg_advisory_unlock($1)', [INIT_DB_LOCK_KEY]);
        pass('2', 'Advisory lock is free after initDb() completes — a new acquisition succeeds immediately, nothing left permanently held');
      } else {
        fail('2', 'Advisory lock must not remain held after initDb() completes', 'pg_try_advisory_lock returned false');
      }
    }
  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message);
    failed++;
  } finally {
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
