// Clickable `<th>` for data-management tables (Table Preview, Database
// browser, User Management, mentor rosters) — never used on SQL query
// result tables, which must keep exactly the row order the query returned.
// Shows a single minimal arrow (▲/▼) only on the currently-active column.
export default function SortableTh({ label, sortKey, activeSortKey, sortDir, onSort, children }) {
  const active = sortKey === activeSortKey;
  return (
    <th
      className={`sortable-th${active ? ' sortable-th--active' : ''}`}
      onClick={() => onSort(sortKey)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(sortKey); } }}
      role="button"
      tabIndex={0}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      title={`Sort by ${label}`}
    >
      {children ?? label}
      {active && <span className="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}
