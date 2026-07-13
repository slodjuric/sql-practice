import { useEffect } from 'react';
import { api } from '../api';
import { useSortableRows } from '../utils/useSortableRows';
import SortableTh from './shared/SortableTh';

const PREVIEW_LIMIT = 50;

function getRowCountLabel(data) {
  if (!data || data.loading) return 'Loading...';
  if (data.error) return null;
  if (data.rowCount === 0) return '0 rows';
  if (data.rowCount > PREVIEW_LIMIT) return `${PREVIEW_LIMIT} of ${data.rowCount} rows shown`;
  return `${data.rowCount} rows`;
}

export default function TablePreviewPanel({
  openTabs,
  activeTab,
  tableCache,
  previewVisible,
  onTabClick,
  onTabClose,
  onToggleVisibility,
  onCacheUpdate,
  sessionId,
}) {
  useEffect(() => {
    if (!activeTab) return;
    if (tableCache[activeTab] !== undefined) return;

    onCacheUpdate(activeTab, { loading: true });

    let cancelled = false;
    api.tables.preview(activeTab, sessionId)
      .then(data => { if (!cancelled) onCacheUpdate(activeTab, data); })
      .catch(err => { if (!cancelled) onCacheUpdate(activeTab, { error: err.message }); });

    return () => { cancelled = true; };
  }, [activeTab, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowCountLabel = previewVisible && activeTab
    ? getRowCountLabel(tableCache[activeTab])
    : null;

  return (
    <div className="table-preview">
      <div className="table-preview-header" onClick={onToggleVisibility}>
        <div className="table-preview-header-left">
          <span className="table-preview-label">Table Preview</span>
          {!previewVisible && openTabs.length > 0 && (
            <span className="table-preview-hint">{openTabs.join(', ')}</span>
          )}
        </div>
        <div className="table-preview-header-right">
          {rowCountLabel !== null && (
            <span className="table-preview-row-count">
              {activeTab} — {rowCountLabel}
            </span>
          )}
          <span className="table-preview-toggle">
            {previewVisible ? '▾ Hide' : '▸ Show'}
          </span>
        </div>
      </div>

      {previewVisible && (
        openTabs.length === 0 ? (
          <div className="table-preview-empty">
            Click a table in the sidebar to preview it here.
          </div>
        ) : (
          <>
            <div className="table-preview-tabs-bar">
              {openTabs.map(name => (
                <button
                  key={name}
                  className={`table-preview-tab ${activeTab === name ? 'active' : ''}`}
                  onClick={() => onTabClick(name)}
                >
                  {name}
                  <span
                    className="table-preview-tab-close"
                    onClick={e => onTabClose(name, e)}
                    title="Close tab"
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
            <div className="table-preview-body">
              {/* Keyed by activeTab so sort state resets when switching tabs —
                  a sort key from one table's columns is meaningless on another. */}
              <TablePreviewData key={activeTab} data={tableCache[activeTab]} />
            </div>
          </>
        )
      )}
    </div>
  );
}

function TablePreviewData({ data }) {
  // This is a raw table preview (not a query result), so click-to-sort is
  // safe here — see useSortableRows/SortableTh.
  const { sortedRows, sortKey, sortDir, requestSort } = useSortableRows(data?.rows);

  if (!data || data.loading) {
    return <div className="table-preview-empty">Loading...</div>;
  }
  if (data.error) {
    return <div className="table-preview-empty table-preview-error">⚠ {data.error}</div>;
  }
  if (!data.rows || data.rows.length === 0) {
    return <div className="table-preview-empty">No data found in this table.</div>;
  }

  return (
    <table className="result-table">
      <thead>
        <tr>
          {data.columns.map(c => (
            <SortableTh key={c} label={c} sortKey={c} activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
          ))}
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row, i) => (
          <tr key={i}>
            {data.columns.map(c => (
              <td key={c}>
                {row[c] === null
                  ? <span className="null-value">NULL</span>
                  : String(row[c])
                }
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
