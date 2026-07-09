import { useState, useEffect } from 'react';
import { api } from '../api';
import ResultTable from './ResultTable';
import TablePreviewPanel from './TablePreviewPanel';
import SqlEditor from './SqlEditor';
import { getFriendlySqlErrorMessage } from '../utils/sqlErrorMessages';
import { useTablePreviewTabs } from '../utils/useTablePreviewTabs';

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

  // Table preview state — shared shape/bookkeeping with TaskView, see
  // utils/useTablePreviewTabs.
  const {
    openTabs, activeTab, tableCache, previewVisible,
    setActiveTab, setTableCache, setPreviewVisible,
    resetTabs, openTab, closeTab,
  } = useTablePreviewTabs(true);

  // Reset table preview state on session switch — different datasets can share a
  // table name (e.g. "countries" exists in both football and nation), so a cached
  // preview must never be reused across a session/schema change.
  useEffect(() => {
    resetTabs();
  }, [activeSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tableToOpen) return;
    openTab(tableToOpen);
    onTableOpened?.();
  }, [tableToOpen]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <p>Write and run any SELECT query against the database. Ctrl+Enter to run.</p>
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
          sessionId={activeSession?.id}
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
