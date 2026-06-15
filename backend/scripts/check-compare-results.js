'use strict';

// Regression tests for the production compareResults utility.
// Tests the real implementation in backend/src/utils/resultComparator.js.

const { compareResults } = require('../src/utils/resultComparator');

// ─── Test helper ─────────────────────────────────────────────────────────────

// Build a mock pg result object from column names and row data.
// compareResults only reads .fields and .rows, so this is all that is needed.
function res(colNames, rows) {
  return { fields: colNames.map(name => ({ name })), rows };
}

// ─── Test cases ───────────────────────────────────────────────────────────────

const cases = [
  {
    id: 1,
    name: 'Correct — identical rows',
    user: res(['id', 'name'], [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]),
    sol:  res(['id', 'name'], [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]),
    check(r) {
      return [
        { ok: r.isCorrect === true, msg: `isCorrect should be true, got ${r.isCorrect}` },
      ];
    },
  },
  {
    id: 2,
    name: 'Correct — same rows, different order, orderMatters=false',
    user: res(['id', 'name'], [{ id: 2, name: 'Bob' }, { id: 1, name: 'Alice' }]),
    sol:  res(['id', 'name'], [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]),
    check(r) {
      return [
        { ok: r.isCorrect === true, msg: `isCorrect should be true, got ${r.isCorrect}` },
      ];
    },
  },
  {
    id: 3,
    name: 'column_count_mismatch — user has fewer columns',
    user: res(['id'],          [{ id: 1 }]),
    sol:  res(['id', 'name'], [{ id: 1, name: 'Alice' }]),
    check(r) {
      return [
        { ok: r.failureReason === 'column_count_mismatch',                       msg: `failureReason: ${r.failureReason}` },
        { ok: Array.isArray(r.missingColumns) && r.missingColumns.includes('name'), msg: `missingColumns: ${JSON.stringify(r.missingColumns)}` },
        { ok: Array.isArray(r.extraColumns)   && r.extraColumns.length === 0,       msg: `extraColumns should be empty: ${JSON.stringify(r.extraColumns)}` },
      ];
    },
  },
  {
    id: 4,
    name: 'column_count_mismatch — user has more columns',
    user: res(['id', 'name', 'extra'], [{ id: 1, name: 'Alice', extra: 'x' }]),
    sol:  res(['id', 'name'],          [{ id: 1, name: 'Alice' }]),
    check(r) {
      return [
        { ok: r.failureReason === 'column_count_mismatch',                        msg: `failureReason: ${r.failureReason}` },
        { ok: Array.isArray(r.missingColumns) && r.missingColumns.length === 0,    msg: `missingColumns should be empty: ${JSON.stringify(r.missingColumns)}` },
        { ok: Array.isArray(r.extraColumns)   && r.extraColumns.includes('extra'), msg: `extraColumns: ${JSON.stringify(r.extraColumns)}` },
      ];
    },
  },
  {
    id: 5,
    name: 'column_count_mismatch — both missing and extra columns',
    user: res(['id', 'grade', 'extra'], [{ id: 1, grade: 9, extra: 'x' }]),
    sol:  res(['id', 'name'],           [{ id: 1, name: 'Alice' }]),
    check(r) {
      return [
        { ok: r.failureReason === 'column_count_mismatch',                                                              msg: `failureReason: ${r.failureReason}` },
        { ok: Array.isArray(r.missingColumns) && r.missingColumns.includes('name'),                                     msg: `missingColumns: ${JSON.stringify(r.missingColumns)}` },
        { ok: Array.isArray(r.extraColumns)   && r.extraColumns.includes('grade') && r.extraColumns.includes('extra'),  msg: `extraColumns: ${JSON.stringify(r.extraColumns)}` },
      ];
    },
  },
  {
    id: 6,
    name: 'column_name_mismatch — same count, different names',
    user: res(['id', 'title'], [{ id: 1, title: 'X' }]),
    sol:  res(['id', 'name'],  [{ id: 1, name: 'Alice' }]),
    check(r) {
      return [
        { ok: r.failureReason === 'column_name_mismatch', msg: `failureReason: ${r.failureReason}` },
      ];
    },
  },
  {
    id: 7,
    name: 'Correct — column declaration order irrelevant',
    user: res(['name', 'id'], [{ name: 'Alice', id: 1 }]),
    sol:  res(['id', 'name'], [{ id: 1, name: 'Alice' }]),
    check(r) {
      return [
        { ok: r.isCorrect === true, msg: `isCorrect should be true, got ${r.isCorrect} (reason: ${r.failureReason})` },
      ];
    },
  },
  {
    id: 8,
    name: 'row_count_mismatch — user has fewer rows',
    user: res(['id'], [{ id: 1 }]),
    sol:  res(['id'], [{ id: 1 }, { id: 2 }, { id: 3 }]),
    check(r) {
      return [
        { ok: r.failureReason === 'row_count_mismatch', msg: `failureReason: ${r.failureReason}` },
        { ok: r.userRowCount === 1,                     msg: `userRowCount: ${r.userRowCount}` },
        { ok: r.expectedRowCount === 3,                 msg: `expectedRowCount: ${r.expectedRowCount}` },
      ];
    },
  },
  {
    id: 9,
    name: 'row_count_mismatch — user has more rows',
    user: res(['id'], [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]),
    sol:  res(['id'], [{ id: 1 }, { id: 2 }]),
    check(r) {
      return [
        { ok: r.failureReason === 'row_count_mismatch', msg: `failureReason: ${r.failureReason}` },
        { ok: r.userRowCount === 4,                     msg: `userRowCount: ${r.userRowCount}` },
        { ok: r.expectedRowCount === 2,                 msg: `expectedRowCount: ${r.expectedRowCount}` },
      ];
    },
  },
  {
    id: 10,
    name: 'order_mismatch — wrong sequence, correct values, orderMatters=true',
    user: res(['id'], [{ id: 2 }, { id: 1 }]),
    sol:  res(['id'], [{ id: 1 }, { id: 2 }]),
    opts: { orderMatters: true },
    check(r) {
      return [
        { ok: r.failureReason === 'order_mismatch',                                              msg: `failureReason: ${r.failureReason}` },
        { ok: Array.isArray(r.sampleDifferences) && r.sampleDifferences.length > 0,             msg: `sampleDifferences should be non-empty: ${JSON.stringify(r.sampleDifferences)}` },
      ];
    },
  },
  {
    id: 11,
    name: 'Correct — same order, orderMatters=true',
    user: res(['id'], [{ id: 1 }, { id: 2 }]),
    sol:  res(['id'], [{ id: 1 }, { id: 2 }]),
    opts: { orderMatters: true },
    check(r) {
      return [
        { ok: r.isCorrect === true, msg: `isCorrect should be true, got ${r.isCorrect}` },
      ];
    },
  },
  {
    id: 12,
    name: 'value_mismatch — orderMatters=false',
    user: res(['id', 'name'], [{ id: 1, name: 'Alice' }]),
    sol:  res(['id', 'name'], [{ id: 1, name: 'Bob' }]),
    check(r) {
      const diff = r.sampleDifferences?.[0];
      return [
        { ok: r.failureReason === 'value_mismatch',           msg: `failureReason: ${r.failureReason}` },
        { ok: diff?.row === 1,                                 msg: `diff.row: ${diff?.row}` },
        { ok: diff?.columns?.includes('name'),                 msg: `diff.columns: ${JSON.stringify(diff?.columns)}` },
        { ok: diff?.userValues?.includes('Alice'),             msg: `diff.userValues: ${JSON.stringify(diff?.userValues)}` },
        { ok: diff?.expectedValues?.includes('Bob'),           msg: `diff.expectedValues: ${JSON.stringify(diff?.expectedValues)}` },
      ];
    },
  },
  {
    id: 13,
    name: 'value_mismatch — orderMatters=true, values wrong not just order',
    user: res(['id'], [{ id: 1 }, { id: 9 }]),
    sol:  res(['id'], [{ id: 1 }, { id: 2 }]),
    opts: { orderMatters: true },
    check(r) {
      return [
        { ok: r.failureReason === 'value_mismatch', msg: `failureReason: ${r.failureReason}` },
      ];
    },
  },
  {
    id: 14,
    name: 'duplicate_rows_mismatch — same unique rows, different distribution',
    user: res(['a'], [{ a: 1 }, { a: 1 }, { a: 2 }]),
    sol:  res(['a'], [{ a: 1 }, { a: 2 }, { a: 2 }]),
    check(r) {
      return [
        { ok: r.failureReason === 'duplicate_rows_mismatch', msg: `failureReason: ${r.failureReason}` },
      ];
    },
  },
  {
    id: 15,
    name: 'Numeric normalization — PostgreSQL NUMERIC string equals JS number',
    user: res(['price'], [{ price: '8.50' }]),
    sol:  res(['price'], [{ price: 8.5 }]),
    check(r) {
      return [
        { ok: r.isCorrect === true, msg: `"8.50" and 8.5 should compare as equal; isCorrect=${r.isCorrect}` },
      ];
    },
  },
  {
    id: 16,
    name: 'Numeric normalization — alphanumeric string must not be coerced to number',
    user: res(['code'], [{ code: 'abc123' }]),
    sol:  res(['code'], [{ code: 'abc123' }]),
    check(r) {
      return [
        { ok: r.isCorrect === true, msg: `"abc123" should stay as string and compare equal; isCorrect=${r.isCorrect}` },
      ];
    },
  },
  {
    id: 17,
    name: 'NULL equality — null equals null',
    user: res(['grade'], [{ grade: null }]),
    sol:  res(['grade'], [{ grade: null }]),
    check(r) {
      return [
        { ok: r.isCorrect === true, msg: `null should equal null; isCorrect=${r.isCorrect}` },
      ];
    },
  },
  {
    id: 18,
    name: 'NULL vs non-NULL — null should not equal 0',
    user: res(['grade'], [{ grade: null }]),
    sol:  res(['grade'], [{ grade: 0 }]),
    check(r) {
      return [
        { ok: r.failureReason === 'value_mismatch', msg: `failureReason: ${r.failureReason}` },
      ];
    },
  },
  {
    id: 19,
    name: 'sampleDifferences capped at 3 even when 5 rows differ',
    user: res(['id', 'val'], [
      { id: 1, val: 0 }, { id: 2, val: 0 }, { id: 3, val: 0 },
      { id: 4, val: 0 }, { id: 5, val: 0 },
    ]),
    sol: res(['id', 'val'], [
      { id: 1, val: 1 }, { id: 2, val: 1 }, { id: 3, val: 1 },
      { id: 4, val: 1 }, { id: 5, val: 1 },
    ]),
    check(r) {
      return [
        { ok: r.failureReason === 'value_mismatch',     msg: `failureReason: ${r.failureReason}` },
        { ok: r.sampleDifferences?.length === 3,         msg: `sampleDifferences.length should be 3, got ${r.sampleDifferences?.length}` },
      ];
    },
  },
  {
    id: 20,
    name: 'order_mismatch sampleDifferences reflect pre-sort row positions',
    user: res(['id'], [{ id: 3 }, { id: 1 }, { id: 2 }]),
    sol:  res(['id'], [{ id: 1 }, { id: 2 }, { id: 3 }]),
    opts: { orderMatters: true },
    check(r) {
      return [
        { ok: r.failureReason === 'order_mismatch',           msg: `failureReason: ${r.failureReason}` },
        { ok: r.sampleDifferences?.[0]?.row === 1,            msg: `sampleDifferences[0].row should be 1 (pre-sort position 1), got ${r.sampleDifferences?.[0]?.row}` },
      ];
    },
  },
  {
    id: 21,
    name: 'Multi-column differences — both differing columns listed in one diff entry',
    user: res(['id', 'name', 'grade'], [{ id: 1, name: 'Alice', grade: 8 }]),
    sol:  res(['id', 'name', 'grade'], [{ id: 1, name: 'Bob',   grade: 9 }]),
    check(r) {
      const diff = r.sampleDifferences?.[0];
      return [
        { ok: r.failureReason === 'value_mismatch',   msg: `failureReason: ${r.failureReason}` },
        { ok: diff?.columns?.includes('name'),         msg: `diff.columns should include "name": ${JSON.stringify(diff?.columns)}` },
        { ok: diff?.columns?.includes('grade'),        msg: `diff.columns should include "grade": ${JSON.stringify(diff?.columns)}` },
      ];
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const c of cases) {
  const result    = compareResults(c.user, c.sol, c.opts ?? {});
  const checks    = c.check(result);
  const allPass   = checks.every(ch => ch.ok);
  const label     = allPass ? 'PASS' : 'FAIL';

  console.log(`[${String(c.id).padStart(2, '0')}] ${label} — ${c.name}`);

  if (!allPass) {
    checks.filter(ch => !ch.ok).forEach(ch => console.log(`       ✗ ${ch.msg}`));
    console.log(`       Result: ${JSON.stringify(result)}`);
    failed++;
  } else {
    passed++;
  }
}

console.log('');
console.log(`Result: ${passed} passed, ${failed} failed.`);

if (failed > 0) process.exit(1);
