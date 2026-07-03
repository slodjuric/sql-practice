import { useState, useEffect } from 'react';
import { api } from '../api';
import ResultTable from './ResultTable';
import TablePreviewPanel from './TablePreviewPanel';
import SqlEditor from './SqlEditor';
import { getFriendlySqlErrorMessage } from '../utils/sqlErrorMessages';

const DEFAULT_SQL = 'SELECT * FROM students LIMIT 10;';

export default function QueryPlayground({ tableToOpen, onTableOpened, activeUser, activeSession }) {
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  // Load saved query when user or session becomes known or changes
  useEffect(() => {
    if (!activeUser?.id) return;
    const key = `lastQuery:playground:${activeUser.id}:${activeSession?.id}`;
    const saved = localStorage.getItem(key);
    if (saved !== null) setSql(saved);
  }, [activeUser?.id, activeSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [openTabs, setOpenTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [tableCache, setTableCache] = useState({});
  const [previewVisible, setPreviewVisible] = useState(true);

  useEffect(() => {
    if (!tableToOpen) return;
    setOpenTabs(prev => prev.includes(tableToOpen) ? prev : [...prev, tableToOpen]);
    setActiveTab(tableToOpen);
    setPreviewVisible(true);
    onTableOpened?.();
  }, [tableToOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  function closeTab(tableName, e) {
    e.stopPropagation();
    const newTabs = openTabs.filter(t => t !== tableName);
    setOpenTabs(newTabs);
    if (activeTab === tableName) {
      const idx = openTabs.indexOf(tableName);
      setActiveTab(newTabs[Math.min(idx, newTabs.length - 1)] ?? null);
    }
  }

  async function runQuery() {
    if (!sql.trim()) return;
    if (activeUser?.id) {
      localStorage.setItem(`lastQuery:playground:${activeUser.id}:${activeSession?.id}`, sql);
    }
    setIsLoading(true);
    setError(null);
    setResult(null);
    setPreviewVisible(false);
    try {
      const data = await api.query(sql, null, activeSession?.id);
      setResult(data);
    } catch (err) {
      setError(getFriendlySqlErrorMessage(err.message, sql, 'playground'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Query Playground</h2>
        <p>Piši i pokreni bilo koji SELECT upit nad bazom. Ctrl+Enter za pokretanje.</p>
      </div>
      <div className="page-body">
        <div className="editor-wrapper">
          <div className="editor-header">
            <span className="editor-label">SQL Query</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Ctrl+Enter to run</span>
          </div>
          <SqlEditor
            value={sql}
            onChange={setSql}
            onRun={runQuery}
            minHeight={180}
          />
        </div>

        <div className="btn-row">
          <button
            className="btn btn-primary"
            onClick={runQuery}
            disabled={isLoading || !sql.trim()}
          >
            ▶ Run Query
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => { setSql(''); setResult(null); setError(null); }}
          >
            Clear
          </button>
        </div>

        <TablePreviewPanel
          openTabs={openTabs}
          activeTab={activeTab}
          tableCache={tableCache}
          previewVisible={previewVisible}
          onTabClick={name => setActiveTab(name)}
          onTabClose={closeTab}
          onToggleVisibility={() => setPreviewVisible(v => !v)}
          onCacheUpdate={(name, data) => setTableCache(prev => ({ ...prev, [name]: data }))}
        />

        <ResultTable
          result={result}
          error={error}
          isLoading={isLoading}
          placeholder="Write a SELECT query and click Run."
        />
      </div>
    </div>
  );
}
