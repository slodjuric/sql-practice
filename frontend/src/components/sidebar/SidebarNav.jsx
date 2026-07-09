import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';

// Main navigation plus the expandable database/table tree. Owns the table
// list for the tree; role-gated sections (Professor/Admin) are cosmetic
// only — the backend enforces every permission independently.
export default function SidebarNav({ currentView, onNavigate, selectedTable, onSelectTable, activeUser, activeSessionId }) {
  const [dbOpen, setDbOpen] = useState(false);
  const [tables, setTables] = useState([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesError, setTablesError] = useState(null);

  // Shared request counter for the DB tree's table list — guards both fetch
  // sites below (session-change effect and toggleDb) against out-of-order
  // responses, e.g. two rapid session switches where the first (now stale)
  // request resolves after the second (current) one.
  const tablesRequestIdRef = useRef(0);

  // Invalidate the table cache whenever the active session (and thus dataset) changes.
  // If the DB tree is already open, reload immediately for the new session.
  useEffect(() => {
    setTables([]);
    setTablesError(null);
    const requestId = ++tablesRequestIdRef.current;
    if (dbOpen) {
      setTablesLoading(true);
      api.tables.list(activeSessionId)
        .then(data => { if (tablesRequestIdRef.current === requestId) setTables(data); })
        .catch(() => { if (tablesRequestIdRef.current === requestId) setTablesError('Could not load tables'); })
        .finally(() => { if (tablesRequestIdRef.current === requestId) setTablesLoading(false); });
    }
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleDb() {
    const opening = !dbOpen;
    setDbOpen(opening);
    if (opening && tables.length === 0 && !tablesError) {
      setTablesLoading(true);
      setTablesError(null);
      const requestId = ++tablesRequestIdRef.current;
      api.tables.list(activeSessionId)
        .then(data => { if (tablesRequestIdRef.current === requestId) setTables(data); })
        .catch(() => { if (tablesRequestIdRef.current === requestId) setTablesError('Could not load tables'); })
        .finally(() => { if (tablesRequestIdRef.current === requestId) setTablesLoading(false); });
    }
  }

  return (
    <nav className="sidebar-nav">
      <div className="nav-section">
        <div className="nav-section-label">Menu</div>

        <button
          className={`nav-item ${currentView === 'progress' ? 'active' : ''}`}
          onClick={() => onNavigate('progress')}
        >
          <span className="icon">📊</span>
          Progress
        </button>

        <button
          className={`nav-item ${currentView === 'practice' ? 'active' : ''}`}
          onClick={() => onNavigate('practice')}
        >
          <span className="icon">✏️</span>
          Practice
        </button>

        <button
          className={`nav-item ${currentView === 'database' ? 'active' : ''}`}
          onClick={toggleDb}
        >
          <span className="icon">🗄️</span>
          Database
          <span className="nav-arrow">{dbOpen ? '▾' : '▸'}</span>
        </button>

        {dbOpen && (
          <div className="db-tree">
            <div className="db-tree-section">
              <span className="db-tree-label">Tables</span>
            </div>

            {tablesLoading && <div className="db-tree-loading">Loading...</div>}
            {tablesError  && <div className="db-tree-error">{tablesError}</div>}
            {!tablesLoading && !tablesError && tables.length === 0 && (
              <div className="db-tree-loading">No tables found</div>
            )}

            {tables.map(t => (
              <button
                key={t}
                className={`db-tree-item ${selectedTable === t && currentView === 'database' ? 'active' : ''}`}
                onClick={() => onSelectTable(t)}
              >
                <span className="db-tree-icon">▶</span>
                {t}
              </button>
            ))}
          </div>
        )}

        <button
          className={`nav-item ${currentView === 'playground' ? 'active' : ''}`}
          onClick={() => onNavigate('playground')}
        >
          <span className="icon">▶️</span>
          Query Playground
        </button>

      </div>

      {activeUser?.role === 'mentor' && (
        <div className="nav-section">
          <div className="nav-section-label">Professor</div>

          <button
            className={`nav-item ${currentView === 'my-students' ? 'active' : ''}`}
            onClick={() => onNavigate('my-students')}
          >
            <span className="icon">🎓</span>
            My Students
          </button>
        </div>
      )}

      {activeUser?.role === 'admin' && (
        <div className="nav-section">
          <div className="nav-section-label">Admin</div>

          <button
            className={`nav-item ${currentView === 'users' ? 'active' : ''}`}
            onClick={() => onNavigate('users')}
          >
            <span className="icon">👥</span>
            Users
          </button>
        </div>
      )}
    </nav>
  );
}
