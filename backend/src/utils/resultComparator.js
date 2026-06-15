'use strict';

// Convert a raw PostgreSQL value to a canonical JS value for comparison.
// PostgreSQL returns NUMERIC/DECIMAL as strings (e.g. "8.50"). We coerce
// those to numbers so that "8.50", "8.5", and 8.5 all compare as equal.
function normalizeValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean') return val;
  if (val instanceof Date)      return val.toISOString();
  if (typeof val === 'number')  return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    // Only coerce if the whole string is a finite number (avoids "123abc" → 123)
    if (trimmed !== '' && String(Number(trimmed)) !== 'NaN' && isFinite(Number(trimmed))) {
      return Number(trimmed);
    }
    return trimmed;
  }
  return String(val);
}

// Type-aware comparator: nulls first, numbers numerically, strings lexicographically.
function compareValues(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'variant' });
}

function valuesEqual(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return String(a) === String(b);
}

function normalizeRows(rows) {
  return rows.map(row => {
    const out = {};
    for (const key of Object.keys(row)) out[key.toLowerCase()] = normalizeValue(row[key]);
    return out;
  });
}

// Sort rows by each column in cols (lowercase, in solution's original order).
function sortRows(rows, cols) {
  return [...rows].sort((a, b) => {
    for (const col of cols) {
      const cmp = compareValues(a[col], b[col]);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

// Collect up to 3 row-level differences between two aligned row arrays.
function collectDiffs(userRows, solRows, cols) {
  const diffs = [];
  for (let i = 0; i < userRows.length && diffs.length < 3; i++) {
    const uRow = userRows[i];
    const sRow = solRows[i];
    const diffCols = cols.filter(col => !valuesEqual(uRow[col], sRow[col]));
    if (diffCols.length > 0) {
      diffs.push({
        row:            i + 1,
        columns:        diffCols,
        userValues:     diffCols.map(c => uRow[c]),
        expectedValues: diffCols.map(c => sRow[c]),
      });
    }
  }
  return diffs;
}

// Compare two pg result objects and return a structured diagnosis.
//
// failureReason values:
//   'column_count_mismatch'   — different number of columns
//   'column_name_mismatch'    — same count, different names/aliases
//   'row_count_mismatch'      — different number of rows
//   'order_mismatch'          — correct rows but wrong sequence (only when orderMatters)
//   'duplicate_rows_mismatch' — correct unique rows but repeated incorrectly
//   'value_mismatch'          — same shape, wrong cell values
//
// orderMatters: true for tasks where ORDER BY is being tested (topicId === 'sorting').
// For all other tasks, ORDER BY in the solution is just for determinism — row order is ignored.
function compareResults(userResult, solutionResult, { orderMatters = false } = {}) {
  const userColNames  = userResult.fields.map(f => f.name);
  const solColNames   = solutionResult.fields.map(f => f.name);
  const userColsLower = userColNames.map(c => c.toLowerCase());
  const solColsLower  = solColNames.map(c => c.toLowerCase());

  // 1. Column count
  if (userColNames.length !== solColNames.length) {
    const missingColumns = solColsLower.filter(c => !userColsLower.includes(c));
    const extraColumns   = userColsLower.filter(c => !solColsLower.includes(c));
    return {
      isCorrect:       false,
      failureReason:   'column_count_mismatch',
      userColumns:     userColNames,
      expectedColumns: solColNames,
      missingColumns,
      extraColumns,
    };
  }

  // 2. Column names (same count, check names order-independently)
  const userColsSorted = [...userColsLower].sort();
  const solColsSorted  = [...solColsLower].sort();
  if (userColsSorted.join('\x00') !== solColsSorted.join('\x00')) {
    return {
      isCorrect:       false,
      failureReason:   'column_name_mismatch',
      userColumns:     userColNames,
      expectedColumns: solColNames,
    };
  }

  // 3. Row count
  const userRowCount = userResult.rows.length;
  const solRowCount  = solutionResult.rows.length;
  if (userRowCount !== solRowCount) {
    return {
      isCorrect:        false,
      failureReason:    'row_count_mismatch',
      userRowCount,
      expectedRowCount: solRowCount,
    };
  }

  // 4. Normalize values in both result sets
  const userNorm = normalizeRows(userResult.rows);
  const solNorm  = normalizeRows(solutionResult.rows);
  // Use solution column names (lowercase, original order) as sort keys and lookup keys.
  const cols = solColsLower;

  if (orderMatters) {
    // 5a. Compare in original query order (ORDER BY is being tested)
    const diffs = collectDiffs(userNorm, solNorm, cols);
    if (diffs.length === 0) return { isCorrect: true };

    // Distinguish order_mismatch from value_mismatch: sort both and re-compare.
    // If sorted versions match, the only problem is ordering.
    const sortedDiffs = collectDiffs(sortRows(userNorm, cols), sortRows(solNorm, cols), cols);
    if (sortedDiffs.length === 0) {
      return {
        isCorrect:         false,
        failureReason:     'order_mismatch',
        userRowCount,
        expectedRowCount:  solRowCount,
        sampleDifferences: diffs,
      };
    }

    return {
      isCorrect:         false,
      failureReason:     'value_mismatch',
      userRowCount,
      expectedRowCount:  solRowCount,
      sampleDifferences: diffs,
    };
  }

  // 5b. Order doesn't matter — sort both canonically before comparing
  const sortedUser = sortRows(userNorm, cols);
  const sortedSol  = sortRows(solNorm,  cols);
  const diffs = collectDiffs(sortedUser, sortedSol, cols);
  if (diffs.length === 0) return { isCorrect: true };

  // 6. Check for duplicate-row mismatch:
  // If user's unique rows === expected's unique rows but row counts differ in distribution,
  // the problem is extra duplicates (missing DISTINCT, bad JOIN), not wrong values.
  const userUniqueSet = new Set(sortedUser.map(r => JSON.stringify(r)));
  const solUniqueSet  = new Set(sortedSol.map(r => JSON.stringify(r)));
  const userHasDups   = userUniqueSet.size < userNorm.length;

  if (userHasDups) {
    const sameUniqueSets =
      userUniqueSet.size === solUniqueSet.size &&
      [...userUniqueSet].every(r => solUniqueSet.has(r));
    if (sameUniqueSets) {
      return {
        isCorrect:        false,
        failureReason:    'duplicate_rows_mismatch',
        userRowCount,
        expectedRowCount: solRowCount,
      };
    }
  }

  return {
    isCorrect:         false,
    failureReason:     'value_mismatch',
    userRowCount,
    expectedRowCount:  solRowCount,
    sampleDifferences: diffs,
  };
}

module.exports = { compareResults };
