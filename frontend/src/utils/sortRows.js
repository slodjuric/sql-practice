// Generic, dependency-free row sorting for plain data-management tables
// (Table Preview, Database browser, User Management, mentor rosters) — NOT
// used for SQL query result tables (ResultTable.jsx), which must always
// render exactly what the query returned.

function isNil(v) {
  return v === null || v === undefined;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

// Reduces a raw cell value to something directly comparable: a number for
// numbers/numeric strings/booleans/Dates/ISO date strings, a lowercased
// string otherwise. Returns the nil value unchanged (handled separately).
function toComparable(v) {
  if (isNil(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return '';
    if (NUMERIC_RE.test(trimmed)) return Number(trimmed);
    if (ISO_DATE_RE.test(trimmed)) {
      const t = Date.parse(trimmed);
      if (!isNaN(t)) return t;
    }
    return v.toLowerCase();
  }
  return v;
}

// Nulls/undefined always sort to the end, regardless of direction — a
// direction flip on top of "missing data" would be confusing either way, so
// this keeps it predictable no matter which arrow is showing.
function compareValues(a, b) {
  const aNil = isNil(a);
  const bNil = isNil(b);
  if (aNil && bNil) return 0;
  if (aNil) return 1;
  if (bNil) return -1;

  const ca = toComparable(a);
  const cb = toComparable(b);

  if (typeof ca === 'number' && typeof cb === 'number') return ca - cb;
  return String(ca).localeCompare(String(cb), undefined, { numeric: true, sensitivity: 'base' });
}

// Returns a NEW sorted array — never mutates `rows`. `accessor(row)` extracts
// the value to compare for the current sort column; ties are broken by
// original position so the sort is stable regardless of engine.
export function sortRows(rows, direction, accessor) {
  if (!rows || rows.length === 0) return rows;
  const indexed = rows.map((row, index) => ({ row, index }));
  indexed.sort((a, b) => {
    const cmp = compareValues(accessor(a.row), accessor(b.row));
    if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
    return a.index - b.index;
  });
  return indexed.map(x => x.row);
}
