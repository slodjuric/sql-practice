import { useEffect, useState } from 'react';
import { api } from '../api';

export default function DatabaseView({ selectedTable }) {
  const [columns, setColumns] = useState([]);
  const [preview, setPreview] = useState(null);
  const [activeTab, setActiveTab] = useState('data');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!selectedTable) return;
    setLoading(true);
    setError(null);
    setColumns([]);
    setPreview(null);
    setActiveTab('data');
    Promise.all([
      api.tables.columns(selectedTable),
      api.tables.preview(selectedTable),
    ])
      .then(([cols, prev]) => {
        setColumns(cols);
        setPreview(prev);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedTable]);

  if (!selectedTable) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        <div className="icon">🗄️</div>
        <p>Klikni na tabelu u sidebar-u da vidiš podatke</p>
      </div>
    );
  }

  return (
    <div className="db-view">
      <div className="page-header">
        <h2>{selectedTable}</h2>
        <p>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            sql_practice › public › {selectedTable}
          </span>
        </p>
      </div>

      {loading ? (
        <div className="loading" style={{ marginTop: 40 }}>Loading {selectedTable}</div>
      ) : error ? (
        <div className="page-body">
          <div className="result-section">
            <div className="result-header">
              <span className="result-label">Error</span>
            </div>
            <div className="result-error">⚠ {error}</div>
          </div>
        </div>
      ) : (
        <div className="db-view-body">
          <div className="table-detail-tabs">
            <button
              className={`tab-btn ${activeTab === 'data' ? 'active' : ''}`}
              onClick={() => setActiveTab('data')}
            >
              Data {preview ? `(${preview.rowCount})` : ''}
            </button>
            <button
              className={`tab-btn ${activeTab === 'columns' ? 'active' : ''}`}
              onClick={() => setActiveTab('columns')}
            >
              Columns ({columns.length})
            </button>
          </div>

          <div className="db-view-content">
            {activeTab === 'data' && <DataTab preview={preview} />}
            {activeTab === 'columns' && <ColumnsTab columns={columns} />}
          </div>
        </div>
      )}
    </div>
  );
}

function DataTab({ preview }) {
  if (!preview) return null;

  if (preview.rows.length === 0) {
    return <div className="result-empty">No data found in this table.</div>;
  }

  return (
    <div className="result-table-wrapper">
      <table className="result-table">
        <thead>
          <tr>
            {preview.columns.map(col => <th key={col}>{col}</th>)}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, i) => (
            <tr key={i}>
              {preview.columns.map(col => (
                <td key={col}>
                  {row[col] === null
                    ? <span className="null-value">NULL</span>
                    : String(row[col])
                  }
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ColumnsTab({ columns }) {
  return (
    <div style={{ padding: 16 }}>
      <div className="columns-grid">
        <div className="col-header">Column</div>
        <div className="col-header">Type</div>
        <div className="col-header">Nullable</div>
        {columns.map(col => (
          <>
            <div className="col-cell" key={`n-${col.column_name}`}>{col.column_name}</div>
            <div className="col-cell type" key={`t-${col.column_name}`}>{col.data_type}</div>
            <div className="col-cell nullable" key={`nul-${col.column_name}`}>
              {col.is_nullable === 'YES' ? 'YES' : 'NO'}
            </div>
          </>
        ))}
      </div>
    </div>
  );
}
