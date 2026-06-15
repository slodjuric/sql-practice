import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import ResultTable from './ResultTable';
import TablePreviewPanel from './TablePreviewPanel';
import SqlEditor from './SqlEditor';
import { matchesSessionFilters } from '../utils/taskFilters';
import { getFriendlySqlErrorMessage } from '../utils/sqlErrorMessages';
import StatusBadge from './shared/StatusBadge';
import { DIFFICULTY_CLASS } from '../constants/difficulties';

function displayVal(v) {
  return v === null ? 'NULL' : String(v);
}

function CheckBanner({ checkResult, sql }) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Reset to collapsed whenever a new check result arrives.
  useEffect(() => { setIsExpanded(false); }, [checkResult]);

  if (!checkResult) return null;

  if (checkResult.isCorrect) {
    return (
      <div className="check-banner correct">
        ✓ Correct! Your query matches the expected result.
      </div>
    );
  }

  const {
    failureReason,
    errorMessage,
    userColumns, expectedColumns, missingColumns, extraColumns,
    userRowCount, expectedRowCount,
    sampleDifferences,
    logicMismatchHint,
    logicMismatchReason,
  } = checkResult;
  const colCount = checkResult.userResult?.columns?.length ?? userColumns?.length ?? '?';

  const hasJoin =
    Boolean(checkResult.solutionHasJoin) ||
    /\bjoin\b/i.test(sql || '');

  let headline;
  let detail = null;

  switch (failureReason) {
    case 'query_logic_mismatch': {
      headline = '✗ Your query returns the expected rows, but the query logic does not fully match the task.';
      detail = (
        <div className="check-banner-detail">
          {logicMismatchHint}
          {logicMismatchReason && (
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
              Issue: {logicMismatchReason.replace(/_/g, ' ')}
            </div>
          )}
        </div>
      );
      break;
    }
    case 'sql_error': {
      headline = '✗ Your SQL could not be executed.';
      if (errorMessage) {
        detail = (
          <div className="check-banner-detail">
            <span className="check-banner-error-msg">{errorMessage}</span>
          </div>
        );
      }
      break;
    }
    case 'column_count_mismatch': {
      const uc = userColumns?.length ?? '?';
      const sc = expectedColumns?.length ?? '?';
      headline = `✗ Your result returns ${uc} ${uc === 1 ? 'column' : 'columns'}, but the expected result has ${sc}.`;
      detail = (
        <div className="check-banner-detail">
          <div><span className="check-banner-label">Got: </span>{(userColumns ?? []).join(', ') || '(none)'}</div>
          <div><span className="check-banner-label">Expected: </span>{(expectedColumns ?? []).join(', ')}</div>
          {missingColumns?.length > 0 && (
            <div><span className="check-banner-label">Missing: </span>{missingColumns.join(', ')}</div>
          )}
          {extraColumns?.length > 0 && (
            <div><span className="check-banner-label">Extra: </span>{extraColumns.join(', ')}</div>
          )}
        </div>
      );
      break;
    }
    case 'column_name_mismatch': {
      headline = "✗ Your result returns the right number of columns, but some names don't match.";
      detail = (
        <div className="check-banner-detail">
          <div><span className="check-banner-label">Got: </span>{(userColumns ?? []).join(', ')}</div>
          <div><span className="check-banner-label">Expected: </span>{(expectedColumns ?? []).join(', ')}</div>
        </div>
      );
      break;
    }
    case 'row_count_mismatch': {
      const u = userRowCount ?? '?';
      const s = expectedRowCount ?? '?';
      headline = `✗ Your query returned ${u} ${u === 1 ? 'row' : 'rows'}, but the expected result has ${s}.`;
      if (typeof u === 'number' && typeof s === 'number') {
        const hint = u < s
          ? (hasJoin
              ? 'Your filter may be too strict, or a JOIN condition may be excluding rows.'
              : 'Your filter may be too strict.')
          : (hasJoin
              ? 'You may be missing a WHERE condition, or a JOIN is producing extra rows.'
              : 'You may be missing a WHERE condition.');
        detail = <div className="check-banner-detail">{hint}</div>;
      }
      break;
    }
    case 'order_mismatch': {
      headline = '✗ Your rows are correct, but the order is wrong.';
      detail = (
        <div className="check-banner-detail">
          Check which columns to sort by and in which direction (ASC / DESC).
        </div>
      );
      break;
    }
    case 'duplicate_rows_mismatch': {
      headline = '✗ Your result contains duplicate rows.';
      detail = (
        <div className="check-banner-detail">
          {hasJoin
            ? 'Check for a missing DISTINCT or an incorrect JOIN that may be multiplying rows.'
            : 'Check if DISTINCT is needed.'}
        </div>
      );
      break;
    }
    case 'value_mismatch': {
      const u = userRowCount ?? '?';
      headline = `✗ Correct shape (${u} ${u === 1 ? 'row' : 'rows'}, ${colCount} ${colCount === 1 ? 'column' : 'columns'}), but some values don't match.`;
      if (sampleDifferences?.length > 0) {
        detail = (
          <div className="check-banner-detail">
            {sampleDifferences.map((diff, i) => (
              <div key={i}>
                <span className="check-banner-label">Row {diff.row}, &ldquo;{diff.columns[0]}&rdquo;: </span>
                got <code className="check-banner-code">{displayVal(diff.userValues[0])}</code>
                {', expected '}
                <code className="check-banner-code">{displayVal(diff.expectedValues[0])}</code>
              </div>
            ))}
          </div>
        );
      }
      break;
    }
    default: {
      const fallback = checkResult.userResult?.rowCount ?? userRowCount;
      headline = `✗ Not quite. Your query returned ${fallback ?? '?'} rows, expected ${expectedRowCount ?? '?'}.`;
    }
  }

  return (
    <div className="check-banner incorrect">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>{headline}</div>
        {detail && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12, padding: '3px 10px', flexShrink: 0, marginLeft: 12 }}
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded(e => !e)}
          >
            {isExpanded ? 'Hide details ▴' : 'Show details ▾'}
          </button>
        )}
      </div>
      {isExpanded && detail}
    </div>
  );
}

export default function TaskView({ activeUser, activeSession, sessionFilters, taskId, onBack, category, onBackToCategories, tableToOpenInTask, onTableOpened, executionCache, onExecutionCacheUpdate, taskStatus, onStatusChange, refreshTaskStatuses, initialAttemptSql, onInitialAttemptSqlConsumed, onProgressInvalidate, origin, onBackToProgress }) {
  const [task, setTask] = useState(null);
  const [sql, setSql] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showSolution, setShowSolution] = useState(false);
  const [solution, setSolution] = useState(null);
  const [copiedSolution, setCopiedSolution] = useState(false);
  const [pastedClipboard, setPastedClipboard] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [localStatus, setLocalStatus] = useState(taskStatus ?? 'not_started');

  // Table preview state
  const [openTabs, setOpenTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [tableCache, setTableCache] = useState({});
  const [previewVisible, setPreviewVisible] = useState(false);

  // Always-current refs so effects below read the latest values without re-running
  const executionCacheRef     = useRef(executionCache);
  executionCacheRef.current   = executionCache;
  const taskStatusRef         = useRef(taskStatus);
  taskStatusRef.current       = taskStatus;
  const initialAttemptSqlRef  = useRef(initialAttemptSql);
  initialAttemptSqlRef.current = initialAttemptSql;

  // Sync localStatus upward whenever the persisted prop arrives or changes from outside
  // (e.g. loadStatuses completes after the component already mounted).
  // Never downgrade: solved stays solved, in_progress stays in_progress.
  useEffect(() => {
    setLocalStatus(prev => {
      if (prev === 'solved') return prev;
      if (taskStatus === 'solved') return 'solved';
      if (taskStatus === 'in_progress' && prev === 'not_started') return 'in_progress';
      return prev;
    });
  }, [taskStatus]);

  // localStorage key scoped to user + session + task
  const practiceKey = `lastQuery:practice:${activeUser?.id}:${activeSession?.id}:${taskId}`;

  // Load task and initialize table tabs; restore last executed SQL from localStorage (fallback: in-memory cache)
  useEffect(() => {
    const cache      = executionCacheRef.current;
    const attemptSql = initialAttemptSqlRef.current;
    setTask(null);
    setLocalStatus(taskStatusRef.current ?? 'not_started');
    if (attemptSql) {
      setSql(attemptSql);
      onInitialAttemptSqlConsumed?.();
    } else {
      const savedSql = localStorage.getItem(practiceKey);
      setSql(savedSql ?? cache?.sql ?? '');
    }
    setResult(cache?.result ?? null);
    setError(cache?.error ?? null);
    setShowSolution(false);
    setSolution(null);
    setShowHint(false);
    setCheckResult(null);
    setOpenTabs([]);
    setActiveTab(null);
    setTableCache({});
    setPreviewVisible(false);

    api.tasks.get(taskId).then(t => {
      setTask(t);
      if (t.tables && t.tables.length > 0) {
        setOpenTabs(t.tables);
        setActiveTab(t.tables[0]);
        setPreviewVisible(true);
      }
    });
  }, [practiceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open a table tab requested from the sidebar (via App)
  useEffect(() => {
    if (!tableToOpenInTask) return;
    setOpenTabs(prev => prev.includes(tableToOpenInTask) ? prev : [...prev, tableToOpenInTask]);
    setActiveTab(tableToOpenInTask);
    setPreviewVisible(true);
    onTableOpened?.();
  }, [tableToOpenInTask]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (activeSession?.status === 'completed') return;
    if (!task || !matchesSessionFilters(task, sessionFilters)) return;
    localStorage.setItem(practiceKey, sql);
    setIsLoading(true);
    setError(null);
    setResult(null);
    setCheckResult(null);
    setShowSolution(false);
    setPreviewVisible(false);
    try {
      const data = await api.query(sql, taskId, activeUser?.id, activeSession?.id);
      setResult(data);
      onExecutionCacheUpdate?.(taskId, { sql, result: data, error: null });
      if (localStatus !== 'solved') {
        setLocalStatus('in_progress');
        onStatusChange?.(taskId, 'in_progress');
      }
    } catch (err) {
      const friendly = getFriendlySqlErrorMessage(err.message, sql, 'practice');
      setError(friendly);
      onExecutionCacheUpdate?.(taskId, { sql, result: null, error: friendly });
      if (localStatus !== 'solved') {
        setLocalStatus('in_progress');
        onStatusChange?.(taskId, 'in_progress');
      }
    } finally {
      setIsLoading(false);
      await refreshTaskStatuses?.();
    }
  }

  async function checkAnswer() {
    if (!sql.trim()) return;
    if (activeSession?.status === 'completed') return;
    localStorage.setItem(practiceKey, sql);
    setIsLoading(true);
    setError(null);
    setCheckResult(null);
    try {
      const data = await api.tasks.check(taskId, sql, activeUser?.id, activeSession?.id);
      setResult(data.userResult);
      setCheckResult(data);
      onProgressInvalidate?.();
      if (data.isCorrect) {
        setLocalStatus('solved');
        onStatusChange?.(taskId, 'solved');
      } else if (localStatus !== 'solved') {
        setLocalStatus('in_progress');
        onStatusChange?.(taskId, 'in_progress');
      }
    } catch (err) {
      const friendly = getFriendlySqlErrorMessage(err.message, sql, 'practice');
      setCheckResult({ failureReason: 'sql_error', errorMessage: friendly });
      if (localStatus !== 'solved') {
        setLocalStatus('in_progress');
        onStatusChange?.(taskId, 'in_progress');
      }
    } finally {
      setIsLoading(false);
      await refreshTaskStatuses?.();
    }
  }

  async function handleShowSolution() {
    if (!solution) {
      const data = await api.tasks.solution(taskId);
      setSolution(data.solution);
    }
    setShowSolution(s => !s);
  }

  async function copySolution() {
    try {
      await navigator.clipboard.writeText(solution);
      setCopiedSolution(true);
      setTimeout(() => setCopiedSolution(false), 1500);
    } catch {
      console.error('Failed to copy solution.');
    }
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      setSql(text);
      setPastedClipboard(true);
      setTimeout(() => setPastedClipboard(false), 1500);
    } catch {
      // clipboard read permission denied or unavailable
    }
  }

  if (!task) return <div className="loading">Loading task</div>;

  const isActive = matchesSessionFilters(task, sessionFilters);

  return (
    <div>
      <div className="page-header">
        {origin === 'progress' && (
          <button
            className="btn btn-back"
            onClick={onBackToProgress}
            style={{ display: 'block', paddingLeft: 0, marginBottom: 4 }}
          >
            ← Back to Progress
          </button>
        )}
        <nav className="breadcrumb" style={{ marginBottom: 0, paddingBottom: 16 }}>
          <span className="breadcrumb-item" onClick={onBackToCategories}>Practice</span>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-item" onClick={onBack}>{category ?? task.category}</span>
          <span className="breadcrumb-sep">/</span>
          <span style={{ color: 'var(--text-secondary)' }}>{task.title}</span>
        </nav>
      </div>

      <div className="page-body" style={{ paddingTop: 12 }}>
        {/* Inactive task banner */}
        {!isActive && (
          <div className="task-inactive-banner">
            <span className="banner-icon">⚠️</span>
            <span>This task is not in the current plan. You can review it, but execution is disabled.</span>
          </div>
        )}

        {/* Task info */}
        <div className="task-info">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
            <h3>{task.title}</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              <StatusBadge status={localStatus} />
              {task.difficulty && (
                <span className={`card-badge ${DIFFICULTY_CLASS[task.difficulty] || ''}`}>
                  {task.difficulty}
                </span>
              )}
            </div>
          </div>
          <p className="task-description">{task.description}</p>
          {task.tables && task.tables.length > 0 && (
            <div className="task-tables">
              Tables:
              {task.tables.map(t => <span key={t} className="table-tag">{t}</span>)}
            </div>
          )}
          {task.hint && (
            <div style={{ marginTop: 10 }}>
              <button
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: '3px 10px' }}
                onClick={() => setShowHint(h => !h)}
              >
                {showHint ? 'Hide hint' : '💡 Show hint'}
              </button>
              {showHint && <div className="hint-box" style={{ marginTop: 6 }}>💡 {task.hint}</div>}
            </div>
          )}
        </div>

        {/* Completed session banner */}
        {activeSession?.status === 'completed' && (
          <div className="session-completed-banner">
            This session is completed. Reopen it from the sidebar to continue working.
          </div>
        )}

        {/* Check result banner */}
        <CheckBanner checkResult={checkResult} sql={sql} />

        {/* SQL Editor */}
        <div className="editor-wrapper">
          <div className="editor-header">
            <span className="editor-label">Your SQL</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {isActive && activeSession?.status !== 'completed' && (
                <button className="btn btn-secondary btn-copy" onClick={pasteFromClipboard}>
                  {pastedClipboard ? 'Pasted!' : 'Paste'}
                </button>
              )}
            </div>
          </div>
          <SqlEditor
            value={sql}
            onChange={setSql}
            onRun={runQuery}
            minHeight={140}
            readOnly={!isActive || activeSession?.status === 'completed'}
          />
        </div>

        {/* Action buttons */}
        <div className="btn-row">
          <button
            className="btn btn-primary"
            onClick={runQuery}
            disabled={isLoading || !sql.trim() || activeSession?.status === 'completed' || !isActive}
          >
            ▶ Run Query
          </button>
          <button
            className="btn btn-success"
            onClick={checkAnswer}
            disabled={isLoading || !sql.trim() || activeSession?.status === 'completed' || !isActive}
          >
            ✓ Check Answer
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleShowSolution}
          >
            {showSolution ? 'Hide Solution' : '👁 Show Solution'}
          </button>
        </div>

        {/* Solution */}
        {showSolution && solution && (
          <div className="solution-panel">
            <div className="solution-header">
              <span className="result-label">Solution</span>
              <button className="btn btn-secondary btn-copy" onClick={copySolution}>
                {copiedSolution ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="solution-code"><code>{solution}</code></pre>
          </div>
        )}

        {/* Table Preview Panel */}
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

        {/* Query result */}
        <ResultTable
          result={result}
          error={error}
          isLoading={isLoading}
          placeholder="Run your query to see results."
        />
      </div>
    </div>
  );
}
