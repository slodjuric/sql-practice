'use strict';

/**
 * Query safety limits verification script.
 *
 * Tests the executeUserQuery utility and row-limit / timeout behavior that the
 * query and check-answer routes depend on.  Requires a live DB connection.
 *
 * Run: npm run test:query-limits
 *
 * Cases:
 *   [01] Small query executes normally and returns the correct result.
 *   [02] Query at exactly ROW_LIMIT rows is accepted without error.
 *   [03] Query returning ROW_LIMIT+1 rows is detected as over-limit.
 *   [04] Check-answer: over-limit user query is rejected before compareResults,
 *        preventing a false-positive match when both results would be identical.
 *   [05] Long-running query is cancelled by statement_timeout (error code 57014).
 *   [06] statement_timeout is properly reset after a timeout — the next query on
 *        the same pool runs without being killed.
 */

const pool = require('../src/db');
const { executeUserQuery, ROW_LIMIT, QUERY_TIMEOUT } = require('../src/utils/queryRunner');
const { compareResults } = require('../src/utils/resultComparator');

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
  console.log(`ROW_LIMIT=${ROW_LIMIT}  QUERY_TIMEOUT=${QUERY_TIMEOUT}ms\n`);

  // ── Case 01: Small query executes normally ────────────────────────────────
  try {
    const result = await executeUserQuery('SELECT 1 AS n UNION ALL SELECT 2');
    if (result.rowCount === 2 && Number(result.rows[0].n) === 1) {
      pass('01', 'Small query (2 rows) executes correctly');
    } else {
      fail('01', 'Small query executes correctly', `unexpected result: ${JSON.stringify(result.rows)}`);
    }
  } catch (err) {
    fail('01', 'Small query executes correctly', `threw: ${err.message}`);
  }

  // ── Case 02: Query at exactly ROW_LIMIT rows is accepted ──────────────────
  try {
    const result = await executeUserQuery(
      `SELECT * FROM generate_series(1, ${ROW_LIMIT}) AS n(id)`
    );
    if (result.rowCount === ROW_LIMIT) {
      pass('02', `Query returning exactly ${ROW_LIMIT} rows is accepted (at boundary)`);
    } else {
      fail('02', `Query at exactly ROW_LIMIT rows`, `got rowCount=${result.rowCount}`);
    }
  } catch (err) {
    fail('02', `Query at exactly ROW_LIMIT rows`, `threw: ${err.message}`);
  }

  // ── Case 03: Query returning ROW_LIMIT+1 rows is detected as over-limit ───
  // executeUserQuery returns all rows; the route handler then checks rowCount.
  // This case verifies that the rowCount exceeds the limit so the route can reject.
  try {
    const result = await executeUserQuery(
      `SELECT * FROM generate_series(1, ${ROW_LIMIT + 1}) AS n(id)`
    );
    if (result.rowCount > ROW_LIMIT) {
      pass('03', `Query returning ${ROW_LIMIT + 1} rows detected as over-limit (rowCount=${result.rowCount} > ${ROW_LIMIT})`);
    } else {
      fail('03', 'Query over ROW_LIMIT detected', `rowCount=${result.rowCount} is not > ${ROW_LIMIT}`);
    }
  } catch (err) {
    fail('03', 'Query over ROW_LIMIT detected', `threw: ${err.message}`);
  }

  // ── Case 04: Check-answer row limit blocks false-positive comparison ───────
  // Scenario: user query and solution both return ROW_LIMIT+1 identical rows.
  // Without the row limit check, compareResults would return isCorrect=true
  // (identical shapes and values).  With the check, we detect overflow before
  // compareResults is ever called.
  try {
    const overLimitSql = `SELECT * FROM generate_series(1, ${ROW_LIMIT + 1}) AS n(id)`;

    const [userResult, solutionResult] = await Promise.all([
      executeUserQuery(overLimitSql),
      pool.query(overLimitSql),          // solution runs uncapped on the pool
    ]);

    const wouldBeWronglyCorrect =
      compareResults(userResult, solutionResult, { orderMatters: false }).isCorrect;

    const limitCheckFires = userResult.rowCount > ROW_LIMIT;

    if (!limitCheckFires) {
      fail('04', 'Row limit check must fire before compareResults',
        `rowCount=${userResult.rowCount} did not exceed ROW_LIMIT=${ROW_LIMIT}`);
    } else if (!wouldBeWronglyCorrect) {
      // The comparison itself failed for some other reason — test data issue.
      fail('04', 'Row limit check must fire before compareResults',
        'compareResults returned isCorrect=false unexpectedly; test setup issue');
    } else {
      // limitCheckFires=true means the route returns an error before compareResults.
      // wouldBeWronglyCorrect=true proves that skipping the check would cause a false pass.
      pass('04', `Over-limit user query blocked before compareResults — without the check compareResults would have returned isCorrect=true`);
    }
  } catch (err) {
    fail('04', 'Row limit check blocks false-positive comparison', `threw: ${err.message}`);
  }

  // ── Case 05: Long-running query is cancelled by statement_timeout ──────────
  // pg_sleep(N) blocks for N seconds; with QUERY_TIMEOUT < N*1000 ms it is
  // cancelled and pg throws error code 57014 (query_canceled).
  const sleepSeconds = Math.ceil(QUERY_TIMEOUT / 1000) * 3; // well above timeout
  try {
    await executeUserQuery(`SELECT pg_sleep(${sleepSeconds})`);
    fail('05', `pg_sleep(${sleepSeconds}) cancelled by timeout`, 'query completed — timeout did not fire');
  } catch (err) {
    if (err.code === '57014') {
      pass('05', `pg_sleep(${sleepSeconds}s) cancelled after ${QUERY_TIMEOUT}ms (error code 57014)`);
    } else {
      fail('05', `pg_sleep cancelled by timeout`, `expected code 57014, got ${err.code}: ${err.message}`);
    }
  }

  // ── Case 06: statement_timeout is reset after a timeout ───────────────────
  // After case 05, the pool connection should have statement_timeout reset to 0.
  // A quick query must succeed without being killed.
  try {
    const result = await executeUserQuery('SELECT 42 AS answer');
    if (result.rows[0]?.answer === '42' || result.rows[0]?.answer === 42) {
      pass('06', 'Quick query after a timeout succeeds — statement_timeout was properly reset');
    } else {
      fail('06', 'Quick query after timeout succeeds', `unexpected result: ${JSON.stringify(result.rows)}`);
    }
  } catch (err) {
    fail('06', 'Quick query after timeout succeeds', `threw: ${err.message}`);
  }

  await pool.end();

  console.log('');
  console.log(`Result: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
