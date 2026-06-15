'use strict';

/**
 * Session ownership verification script.
 *
 * Creates two real users and two real sessions in the DB, runs ownership
 * checks, then removes all test data. The script is self-cleaning: even if a
 * case fails the finally block deletes every row it created.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:session-ownership
 */

const pool = require('../src/db');
const { resolveSessionId } = require('../src/utils/contextResolvers');
const { saveRunAttempt, saveCheckAttempt } = require('../src/utils/attemptRecorder');

const PREFIX = '_own_test_';

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

async function attemptCount(userId) {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM task_attempts WHERE user_id = $1',
    [userId]
  );
  return r.rows[0].n;
}

// Removes all test data.  task_attempts.user_id has no CASCADE on user delete,
// so we delete those first before removing users (which cascades sessions etc.).
async function cleanup() {
  await pool.query(`
    DELETE FROM task_attempts
    WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)
  `, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM users WHERE username LIKE $1`, [`${PREFIX}%`]);
}

async function run() {
  // Pre-cleanup: remove any leftover rows from a previous failed run
  await cleanup();

  let userAId, userBId, sessionAId, sessionBId;

  try {
    // ── Setup ─────────────────────────────────────────────────────────────────
    const ua = await pool.query(
      'INSERT INTO users (username) VALUES ($1) RETURNING id',
      [`${PREFIX}a`]
    );
    userAId = ua.rows[0].id;

    const ub = await pool.query(
      'INSERT INTO users (username) VALUES ($1) RETURNING id',
      [`${PREFIX}b`]
    );
    userBId = ub.rows[0].id;

    const sa = await pool.query(
      'INSERT INTO learning_sessions (user_id, name) VALUES ($1, $2) RETURNING id',
      [userAId, `${PREFIX}session_a`]
    );
    sessionAId = sa.rows[0].id;

    const sb = await pool.query(
      'INSERT INTO learning_sessions (user_id, name) VALUES ($1, $2) RETURNING id',
      [userBId, `${PREFIX}session_b`]
    );
    sessionBId = sb.rows[0].id;

    // ── Case 1: User A cannot delete User B's session ─────────────────────────
    // Mirrors the SELECT check in DELETE /:id before issuing the actual deletes.
    const deleteCheck = await pool.query(
      'SELECT id FROM learning_sessions WHERE id = $1 AND user_id = $2',
      [sessionBId, userAId]
    );
    if (deleteCheck.rows.length === 0) {
      pass('01', 'User A cannot delete User B session (ownership SELECT → 0 rows)');
    } else {
      fail('01', 'User A cannot delete User B session', 'SELECT returned a row — delete would proceed');
    }

    // ── Case 2: User A cannot update last_opened_at for User B's session ──────
    // Mirrors the UPDATE in PATCH /:id/open.
    const openUpdate = await pool.query(
      'UPDATE learning_sessions SET last_opened_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id',
      [sessionBId, userAId]
    );
    if (openUpdate.rows.length === 0) {
      pass('02', 'User A cannot set last_opened_at on User B session (UPDATE → 0 rows)');
    } else {
      fail('02', 'User A cannot set last_opened_at on User B session', `UPDATE matched ${openUpdate.rows.length} row(s)`);
    }

    // ── Case 3: User A cannot record a run attempt into User B's session ──────
    // resolveSessionId must reject the cross-user session and return null.
    // saveRunAttempt must then silently skip the DB write.
    const resolvedForRun = await resolveSessionId(userAId, sessionBId);
    if (resolvedForRun !== null) {
      fail('03', 'resolveSessionId must reject cross-user session (run)', `expected null, got ${resolvedForRun}`);
    } else {
      const before = await attemptCount(userAId);
      await saveRunAttempt(userAId, null, 99999, 'SELECT 1', null);
      const after = await attemptCount(userAId);
      if (after === before) {
        pass('03', 'User A run attempt not recorded into User B session (resolveSessionId→null, saveRunAttempt skipped)');
      } else {
        fail('03', 'saveRunAttempt must skip write when sessionId is null', `attempt count changed from ${before} to ${after}`);
      }
    }

    // ── Case 4: User A cannot record a check attempt into User B's session ────
    // Same resolver gate, different recorder (saveCheckAttempt).
    const resolvedForCheck = await resolveSessionId(userAId, sessionBId);
    if (resolvedForCheck !== null) {
      fail('04', 'resolveSessionId must reject cross-user session (check)', `expected null, got ${resolvedForCheck}`);
    } else {
      const before = await attemptCount(userAId);
      await saveCheckAttempt(userAId, null, 99999, 'SELECT 1', false, null);
      const after = await attemptCount(userAId);
      if (after === before) {
        pass('04', 'User A check attempt not recorded into User B session (resolveSessionId→null, saveCheckAttempt skipped)');
      } else {
        fail('04', 'saveCheckAttempt must skip write when sessionId is null', `attempt count changed from ${before} to ${after}`);
      }
    }

    // ── Case 5: Valid same-user session is accepted normally ──────────────────
    const resolvedOwn = await resolveSessionId(userAId, sessionAId);
    if (resolvedOwn === sessionAId) {
      pass('05', `User A own session (id=${sessionAId}) accepted by resolveSessionId`);
    } else {
      fail('05', 'resolveSessionId must accept own-user session', `expected ${sessionAId}, got ${resolvedOwn}`);
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
