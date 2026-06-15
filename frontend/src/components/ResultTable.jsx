export default function ResultTable({ result, error, isLoading, placeholder }) {
  if (isLoading) {
    return (
      <div className="result-section">
        <div className="result-header">
          <span className="result-label">Result</span>
        </div>
        <div className="loading">Running query</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="result-section">
        <div className="result-header">
          <span className="result-label">Error</span>
        </div>
        <div className="result-error">⚠ {error}</div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="result-section">
        <div className="result-header">
          <span className="result-label">Result</span>
        </div>
        <div className="result-empty">{placeholder || 'Run a query to see results.'}</div>
      </div>
    );
  }

  const { rows, columns, rowCount } = result;

  if (!rows || rows.length === 0) {
    return (
      <div className="result-section">
        <div className="result-header">
          <span className="result-label">Result</span>
          <span className="result-count">0 rows</span>
        </div>
        <div className="result-empty">Query returned no rows.</div>
      </div>
    );
  }

  return (
    <div className="result-section">
      <div className="result-header">
        <span className="result-label">Result</span>
        <span className="result-count">{rowCount} {rowCount === 1 ? 'row' : 'rows'}</span>
      </div>
      <div className="result-table-wrapper">
        <table className="result-table">
          <thead>
            <tr>
              {columns.map(col => <th key={col}>{col}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map(col => (
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
    </div>
  );
}
