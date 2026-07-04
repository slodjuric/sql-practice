import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { roleLabel } from '../utils/roleLabels';

const SIDEBAR_WIDTH_KEY = 'sidebarWidth';
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 520;
const DEFAULT_SIDEBAR_WIDTH = 240;

function clampSidebarWidth(width) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readStoredSidebarWidth() {
  try {
    const raw = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    if (!isNaN(raw)) return clampSidebarWidth(raw);
  } catch {}
  return DEFAULT_SIDEBAR_WIDTH;
}

function OverflowLabel({ text, className }) {
  const ref = useRef(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el) setOverflows(el.scrollWidth > el.clientWidth);
  }, [text]);

  return (
    <span ref={ref} className={className} title={overflows ? text : undefined}>
      {text}
    </span>
  );
}

function SidebarDropdown({ options, value, onChange, disabled, placeholder }) {
  const [open, setOpen]           = useState(false);
  const [menuStyle, setMenuStyle] = useState({});
  const triggerRef                = useRef(null);
  const menuRef                   = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (
        triggerRef.current?.contains(e.target) ||
        menuRef.current?.contains(e.target)
      ) return;
      setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle() {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setMenuStyle({ top: r.bottom + 2, left: r.left, minWidth: Math.max(r.width, 200) });
    }
    setOpen(o => !o);
  }

  const selected = options.find(o => o.id === value);

  return (
    <div className="sd-root" ref={triggerRef}>
      <button
        type="button"
        className={`sd-trigger${open ? ' sd-trigger--open' : ''}`}
        onClick={toggle}
        disabled={disabled}
      >
        {selected?.prefixIcon && (
          <span className="sd-trigger-prefix" title={selected.prefixTitle}>{selected.prefixIcon}</span>
        )}
        <OverflowLabel
          text={selected?.label ?? placeholder ?? '—'}
          className="sd-trigger-label"
        />
        <span className="sd-chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div ref={menuRef} className="sd-menu" style={menuStyle}>
          {options.length === 0
            ? <span className="sd-empty">{placeholder ?? 'No options'}</span>
            : options.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  className={`sd-item${opt.id === value ? ' sd-item--active' : ''}`}
                  onClick={() => { onChange(opt.id); setOpen(false); }}
                >
                  {opt.prefixIcon && (
                    <span className="sd-item-prefix" title={opt.prefixTitle}>{opt.prefixIcon}</span>
                  )}
                  <OverflowLabel text={opt.label} className="sd-item-label" />
                  {opt.id === value && <span className="sd-item-check" title="Current session">✓</span>}
                </button>
              ))
          }
        </div>
      )}
    </div>
  );
}

export default function Sidebar({
  currentView,
  onNavigate,
  selectedTable,
  onSelectTable,
  activeUser,
  onLogout,
  onDeleteUser,
  sessions,
  activeSession,
  onSessionChange,
  onCreateSession,
  onDeleteSession,
  onCompleteSession,
  onReopenSession,
  canReopenSession,
  selectedStudent,
}) {
  const [dbStatus, setDbStatus] = useState('checking');
  const [dbOpen, setDbOpen] = useState(false);
  const [tables, setTables] = useState([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesError, setTablesError] = useState(null);

  // ── Resizable sidebar width ───────────────────────────────────
  const sidebarRef = useRef(null);
  const resizingRef = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);

  useEffect(() => {
    function onMouseMove(e) {
      if (!resizingRef.current || !sidebarRef.current) return;
      const left = sidebarRef.current.getBoundingClientRect().left;
      setSidebarWidth(clampSidebarWidth(e.clientX - left));
    }
    function onMouseUp() {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSidebarWidth(width => {
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch {}
        return width;
      });
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  function startSidebarResize(e) {
    e.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  // User state (self-delete only — no switcher, no create; see Step 6c)
  const [userDeleting, setUserDeleting] = useState(false);
  const [userDeleteError, setUserDeleteError] = useState(null);

  // Session form state
  const [showAddSession, setShowAddSession] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionDescription, setNewSessionDescription] = useState('');
  const [availableDatasets, setAvailableDatasets] = useState([]);
  const [datasetsLoading, setDatasetsLoading] = useState(false);
  const [selectedDatasetId, setSelectedDatasetId] = useState(null);
  const [sessionAddError, setSessionAddError] = useState(null);
  const [sessionAddSuccess, setSessionAddSuccess] = useState(null);
  const [sessionSaving, setSessionSaving] = useState(false);
  const [sessionDeleting, setSessionDeleting] = useState(false);
  const [sessionDeleteError, setSessionDeleteError] = useState(null);
  const [sessionActionError, setSessionActionError] = useState(null);
  const [sessionActioning, setSessionActioning] = useState(false);

  useEffect(() => { setSessionActionError(null); }, [activeSession?.id]);

  // A student-context switch (selecting a different student, or clearing
  // back to the professor's own sessions) should not leave a stale
  // "created for <student>" confirmation hanging around indefinitely.
  // Deliberately NOT keyed on activeSession?.id — creating a session for
  // the selected student refreshes and can auto-pick that very session as
  // active, which would otherwise wipe the message before it's ever seen.
  useEffect(() => { setSessionAddSuccess(null); }, [selectedStudent?.id, activeUser?.id]);

  // Invalidate the table cache whenever the active session (and thus dataset) changes.
  // If the DB tree is already open, reload immediately for the new session.
  useEffect(() => {
    setTables([]);
    setTablesError(null);
    if (dbOpen) {
      setTablesLoading(true);
      api.tables.list(activeSession?.id)
        .then(setTables)
        .catch(() => setTablesError('Could not load tables'))
        .finally(() => setTablesLoading(false));
    }
  }, [activeSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.health()
      .then(() => setDbStatus('connected'))
      .catch(() => setDbStatus('error'));
  }, []);

  function toggleDb() {
    const opening = !dbOpen;
    setDbOpen(opening);
    if (opening && tables.length === 0 && !tablesError) {
      setTablesLoading(true);
      setTablesError(null);
      api.tables.list(activeSession?.id)
        .then(setTables)
        .catch(() => setTablesError('Could not load tables'))
        .finally(() => setTablesLoading(false));
    }
  }

  // ── User handlers ───────────────────────────────────────────
  async function handleDeleteUser() {
    if (!activeUser) return;
    const confirmed = window.confirm(
      `Are you sure you want to delete your account "${activeUser.username}"? This will delete all sessions, progress and activity for this account, and you will be logged out.`
    );
    if (!confirmed) return;
    setUserDeleting(true);
    setUserDeleteError(null);
    try {
      await onDeleteUser();
    } catch (err) {
      setUserDeleteError(err.message);
    } finally {
      setUserDeleting(false);
    }
  }

  // ── Session handlers ────────────────────────────────────────
  function openAddSession() {
    setNewSessionName('');
    setNewSessionDescription('');
    setSelectedDatasetId(null);
    setSessionAddError(null);
    setSessionAddSuccess(null);
    setShowAddSession(true);
    setDatasetsLoading(true);
    api.datasets.list()
      .then(list => {
        setAvailableDatasets(list);
        if (list.length > 0) setSelectedDatasetId(list[0].id);
      })
      .catch(() => setAvailableDatasets([]))
      .finally(() => setDatasetsLoading(false));
  }

  function closeAddSession() {
    setShowAddSession(false);
    setSessionAddError(null);
    setNewSessionDescription('');
    setSelectedDatasetId(null);
  }

  async function handleSaveSession() {
    if (!newSessionName.trim()) return;
    const nameForMessage = newSessionName.trim();
    setSessionSaving(true);
    setSessionAddError(null);
    try {
      const result = await onCreateSession(nameForMessage, newSessionDescription.trim() || null, 'topic', [], [], [], [], selectedDatasetId);
      setShowAddSession(false);
      setNewSessionName('');
      setNewSessionDescription('');
      setSelectedDatasetId(null);
      // Sessions created for a selected student don't show up in this
      // sidebar's own session dropdown (GET /api/sessions still only
      // returns the logged-in user's sessions) — surface a clear
      // confirmation instead of silently doing nothing visible.
      if (result?.createdForStudent) {
        setSessionAddSuccess(`Session "${nameForMessage}" created for ${selectedStudent?.username || 'the selected student'}. It will appear in their own account.`);
      } else {
        setSessionAddSuccess(null);
      }
    } catch (err) {
      setSessionAddError(err.message);
    } finally {
      setSessionSaving(false);
    }
  }

  async function handleDeleteSession() {
    if (!activeSession) return;
    const confirmed = window.confirm(
      `Are you sure you want to delete session "${activeSession.name}"? This will delete all progress and activity for this session.`
    );
    if (!confirmed) return;
    setSessionDeleting(true);
    setSessionDeleteError(null);
    try {
      await onDeleteSession();
    } catch (err) {
      setSessionDeleteError(err.message);
    } finally {
      setSessionDeleting(false);
    }
  }

  async function handleCompleteClick() {
    if (!window.confirm('Complete this session? It will become read-only. You can reopen it later.')) return;
    setSessionActionError(null);
    setSessionActioning(true);
    try {
      await onCompleteSession();
    } catch (err) {
      setSessionActionError(err.message || 'Could not complete session. Please try again.');
    } finally {
      setSessionActioning(false);
    }
  }

  async function handleReopenClick() {
    setSessionActionError(null);
    setSessionActioning(true);
    try {
      await onReopenSession();
    } catch (err) {
      setSessionActionError(err.message || 'Could not reopen session. Please try again.');
    } finally {
      setSessionActioning(false);
    }
  }

  return (
    <div className="sidebar-wrapper" ref={sidebarRef} style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
      <div className="sidebar">
        <div className="sidebar-logo">
          <h1>SQL Practice</h1>
          <span>PostgreSQL Trainer</span>
        </div>
  
        {/* ── Logged-in user (real identity via /api/auth/me — no switcher) ── */}
        <div className="sidebar-user">
          <div className="sidebar-user-name" title={activeUser?.username}>
            {activeUser?.username}
          </div>
          <div className="sidebar-user-row">
            <span className="sidebar-user-role">{roleLabel(activeUser?.role)}</span>
            <div className="sidebar-user-controls">
              {activeUser?.role === 'admin' && (
                <button
                  className="sidebar-delete-user-btn"
                  onClick={handleDeleteUser}
                  title="Delete my account"
                  disabled={userDeleting}
                >🗑</button>
              )}
              <button
                className="sidebar-logout-btn"
                onClick={onLogout}
                title="Log out"
              >Log out</button>
            </div>
          </div>
  
          {userDeleteError && (
            <div className="sidebar-add-user-error">{userDeleteError}</div>
          )}
        </div>
  
        {/* ── Session Switcher ───────────────────────────────── */}
        <div className="sidebar-session">
          <div className="sidebar-session-row">
            {selectedStudent ? (
              <OverflowLabel
                text={`Sessions for: ${selectedStudent.username}`}
                className="sidebar-session-label sidebar-session-label--student"
              />
            ) : (
              <span className="sidebar-session-label">Session</span>
            )}
            <div className="sidebar-session-controls">
              <SidebarDropdown
                options={sessions.map(s => {
                  const isCompleted = s.status === 'completed';
                  return {
                    id: s.id,
                    label: s.name,
                    prefixIcon: isCompleted ? '✓' : null,
                    prefixTitle: isCompleted ? 'Completed session' : undefined,
                  };
                })}
                value={activeSession?.id ?? null}
                onChange={id => { const s = sessions.find(s => s.id === id); if (s) { setSessionAddSuccess(null); onSessionChange(s); onNavigate('progress'); } }}
                disabled={sessions.length === 0}
                placeholder={selectedStudent ? 'No sessions for this student yet.' : 'No sessions'}
              />
              <button
                className="sidebar-add-session-btn"
                onClick={openAddSession}
                title="New session"
              >+</button>
              <button
                className="sidebar-delete-session-btn"
                onClick={handleDeleteSession}
                title="Delete session"
                disabled={!activeSession || sessionDeleting}
              >🗑</button>
            </div>
          </div>
  
          {sessionDeleteError && (
            <div className="sidebar-add-session-error">{sessionDeleteError}</div>
          )}
  
          {activeSession && (
            activeSession.status === 'completed' ? (
              // Students should not see the Reopen action at all — backend
              // enforces this independently (canReopenSession is UX only).
              canReopenSession && (
                <button
                  className="sidebar-session-action sidebar-session-reopen"
                  onClick={handleReopenClick}
                  disabled={sessionActioning}
                >
                  {sessionActioning ? 'Reopening…' : 'Reopen session'}
                </button>
              )
            ) : (
              <button
                className="sidebar-session-action sidebar-session-complete"
                onClick={handleCompleteClick}
                disabled={sessionActioning}
              >
                {sessionActioning ? 'Completing…' : 'Complete session'}
              </button>
            )
          )}
  
          {sessionActionError && (
            <div className="sidebar-add-session-error">{sessionActionError}</div>
          )}
  
          {sessionAddSuccess && (
            <div className="sidebar-add-session-success">{sessionAddSuccess}</div>
          )}

          {showAddSession && (
            <div className="sidebar-add-session-form">
              {selectedStudent && (
                <div className="sidebar-add-session-target-hint">
                  Creating session for: <strong>{selectedStudent.username}</strong>
                </div>
              )}
              <input
                className="sidebar-add-session-input"
                value={newSessionName}
                onChange={e => setNewSessionName(e.target.value)}
                placeholder="Session name..."
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveSession();
                  if (e.key === 'Escape') closeAddSession();
                }}
                autoFocus
                disabled={sessionSaving}
              />
              <div className="sidebar-add-session-dataset-row">
                {datasetsLoading ? (
                  <span className="sidebar-add-session-dataset-loading">Loading…</span>
                ) : (
                  <select
                    className="sidebar-add-session-select"
                    value={selectedDatasetId ?? ''}
                    onChange={e => setSelectedDatasetId(parseInt(e.target.value, 10))}
                    disabled={sessionSaving || availableDatasets.length <= 1}
                  >
                    {availableDatasets.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                )}
                <span className="sidebar-add-session-dataset-hint">Dataset (fixed after creation)</span>
              </div>
              <textarea
                className="sidebar-add-session-textarea"
                value={newSessionDescription}
                onChange={e => setNewSessionDescription(e.target.value)}
                placeholder="Description (optional)..."
                disabled={sessionSaving}
                rows={2}
              />
              <div className="sidebar-add-session-actions">
                <button className="sidebar-add-session-save" onClick={handleSaveSession} disabled={sessionSaving || !newSessionName.trim() || !selectedDatasetId}>
                  {sessionSaving ? '...' : 'Save'}
                </button>
                <button className="sidebar-add-session-cancel" onClick={closeAddSession} disabled={sessionSaving}>
                  Cancel
                </button>
              </div>
              {sessionAddError && <div className="sidebar-add-session-error">{sessionAddError}</div>}
            </div>
          )}
        </div>
  
        {/* ── Navigation ─────────────────────────────────────── */}
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
  
        <div className="sidebar-status">
          <div className={`status-dot ${dbStatus}`}>
            {dbStatus === 'connected' ? 'sql_practice' : dbStatus === 'error' ? 'DB not connected' : 'Connecting...'}
          </div>
        </div>
      </div>

      <div
        className="sidebar-resize-handle"
        onMouseDown={startSidebarResize}
        title="Drag to resize sidebar"
      />
    </div>
  );
}
