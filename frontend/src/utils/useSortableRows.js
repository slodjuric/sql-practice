import { useState, useMemo } from 'react';
import { sortRows } from './sortRows';

// Click-to-sort state for a data-management table: which column, which
// direction, and the derived (never mutated) sorted array. Click the same
// column again to flip direction; click a different column to sort it
// ascending. Not used for SQL query result tables — those must keep exactly
// the row order the query returned.
//
// `getSortValue(row, key)` extracts the comparable value for a column;
// defaults to `row[key]`, which is exactly right for raw DB rows (Table
// Preview, Database browser) where object keys are the column names.
// Callers with formatted/derived cells (e.g. a role code shown as a label,
// or a status computed from two fields) pass their own to sort by the
// underlying/display value instead of the raw field.
export function useSortableRows(rows, getSortValue) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  function requestSort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sortedRows = useMemo(() => {
    if (!sortKey || !rows) return rows;
    const accessor = getSortValue ? (row => getSortValue(row, sortKey)) : (row => row[sortKey]);
    return sortRows(rows, sortDir, accessor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, sortDir]);

  return { sortedRows, sortKey, sortDir, requestSort };
}
