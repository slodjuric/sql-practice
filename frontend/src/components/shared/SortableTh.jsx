// Clickable `<th>` for data-management tables (Table Preview, Database
// browser, User Management, mentor rosters) — never used on SQL query
// result tables, which must keep exactly the row order the query returned.
// Shows a single minimal arrow (▲/▼) only on the currently-active column.
//
// Deliberately no role="button" — a <th> already has native columnheader
// semantics in a table, and aria-sort is only meaningful on a
// columnheader/rowheader per the ARIA spec. Overriding the role to "button"
// would strip that native semantic, so a screen reader could announce this
// as a plain button and never expose aria-sort at all. tabIndex + the
// keydown handler below make it keyboard-activatable without needing an
// interactive role.
export default function SortableTh({ label, sortKey, activeSortKey, sortDir, onSort, children }) {
  const active = sortKey === activeSortKey;
  return (
    <th
      className={`sortable-th${active ? ' sortable-th--active' : ''}`}
      onClick={() => onSort(sortKey)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(sortKey); } }}
      tabIndex={0}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      title={`Sort by ${label}`}
    >
      {children ?? label}
      {active && <span className="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}
