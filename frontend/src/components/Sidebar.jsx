import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

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
  users,
  activeUser,
  onUserChange,
  onCreateUser,
  onDeleteUser,
  sessions,
  activeSession,
  onSessionChange,
  onCreateSession,
  onDeleteSession,
  onCompleteSession,
  onReopenSession,
  canReopenSession,
}) {
  const [dbStatus, setDbStatus] = useState('checking');
  const [dbOpen, setDbOpen] = useState(false);
  const [tables, setTables] = useState([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesError, setTablesError] = useState(null);

  // User form state
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [userAddError, setUserAddError] = useState(null);
  const [userSaving, setUserSaving] = useState(false);
  const [userDeleting, setUserDeleting] = useState(false);
  const [userDeleteError, setUserDeleteError] = useState(null);

  // Session form state
  const [showAddSession, setShowAddSession] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [sessionAddError, setSessionAddError] = useState(null);
  const [sessionSaving, setSessionSaving] = useState(false);
  const [sessionDeleting, setSessionDeleting] = useState(false);
  const [sessionDeleteError, setSessionDeleteError] = useState(null);
  const [sessionActionError, setSessionActionError] = useState(null);
  const [sessionActioning, setSessionActioning] = useState(false);

  useEffect(() => { setSessionActionError(null); }, [activeSession?.id]);

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
      api.tables.list()
        .then(setTables)
        .catch(() => setTablesError('Could not load tables'))
        .finally(() => setTablesLoading(false));
    }
  }

  // ── User handlers ───────────────────────────────────────────
  function openAddUser() {
    setNewUsername('');
    setUserAddError(null);
    setShowAddUser(true);
  }

  async function handleSaveUser() {
    if (!newUsername.trim()) return;
    setUserSaving(true);
    setUserAddError(null);
    try {
      await onCreateUser(newUsername.trim());
      setShowAddUser(false);
      setNewUsername('');
    } catch (err) {
      setUserAddError(err.message);
    } finally {
      setUserSaving(false);
    }
  }

  async function handleDeleteUser() {
    if (!activeUser) return;
    const confirmed = window.confirm(
      `Are you sure you want to delete user "${activeUser.username}"? This will delete all sessions, progress and activity for this user.`
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
    setSessionAddError(null);
    setShowAddSession(true);
  }

  async function handleSaveSession() {
    if (!newSessionName.trim()) return;
    setSessionSaving(true);
    setSessionAddError(null);
    try {
      await onCreateSession(newSessionName.trim(), null);
      setShowAddSession(false);
      setNewSessionName('');
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
    <div className="sidebar">
      <div className="sidebar-logo">
        <h1>SQL Practice</h1>
        <span>PostgreSQL Trainer</span>
      </div>

      {/* ── User Switcher ──────────────────────────────────── */}
      <div className="sidebar-user">
        <div className="sidebar-user-row">
          <span className="sidebar-user-label">User</span>
          <div className="sidebar-user-controls">
            <SidebarDropdown
              options={users.map(u => ({ id: u.id, label: u.username }))}
              value={activeUser?.id ?? null}
              onChange={id => { const u = users.find(u => u.id === id); if (u) onUserChange(u); }}
              disabled={users.length === 0}
              placeholder="No users"
            />
            <button
              className="sidebar-add-user-btn"
              onClick={openAddUser}
              title="Add user"
            >+</button>
            <button
              className="sidebar-delete-user-btn"
              onClick={handleDeleteUser}
              title="Delete user"
              disabled={!activeUser || userDeleting}
            >🗑</button>
          </div>
        </div>

        {userDeleteError && (
          <div className="sidebar-add-user-error">{userDeleteError}</div>
        )}

        {showAddUser && (
          <div className="sidebar-add-user-form">
            <input
              className="sidebar-add-user-input"
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              placeholder="Username..."
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveUser();
                if (e.key === 'Escape') { setShowAddUser(false); setUserAddError(null); }
              }}
              autoFocus
              disabled={userSaving}
            />
            <div className="sidebar-add-user-actions">
              <button className="sidebar-add-user-save" onClick={handleSaveUser} disabled={userSaving || !newUsername.trim()}>
                {userSaving ? '...' : 'Save'}
              </button>
              <button className="sidebar-add-user-cancel" onClick={() => { setShowAddUser(false); setUserAddError(null); }} disabled={userSaving}>
                Cancel
              </button>
            </div>
            {userAddError && <div className="sidebar-add-user-error">{userAddError}</div>}
          </div>
        )}
      </div>

      {/* ── Session Switcher ───────────────────────────────── */}
      <div className="sidebar-session">
        <div className="sidebar-session-row">
          <span className="sidebar-session-label">Session</span>
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
              onChange={id => { const s = sessions.find(s => s.id === id); if (s) { onSessionChange(s); onNavigate('progress'); } }}
              disabled={sessions.length === 0}
              placeholder="No sessions"
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
            canReopenSession ? (
              <button
                className="sidebar-session-action sidebar-session-reopen"
                onClick={handleReopenClick}
                disabled={sessionActioning}
              >
                {sessionActioning ? 'Reopening…' : 'Reopen session'}
              </button>
            ) : (
              <button className="sidebar-session-action sidebar-session-reopen" disabled title="Only mentor/admin can reopen a completed session.">
                Reopen session
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

        {showAddSession && (
          <div className="sidebar-add-session-form">
            <input
              className="sidebar-add-session-input"
              value={newSessionName}
              onChange={e => setNewSessionName(e.target.value)}
              placeholder="Session name..."
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveSession();
                if (e.key === 'Escape') { setShowAddSession(false); setSessionAddError(null); }
              }}
              autoFocus
              disabled={sessionSaving}
            />
            <div className="sidebar-add-session-actions">
              <button className="sidebar-add-session-save" onClick={handleSaveSession} disabled={sessionSaving || !newSessionName.trim()}>
                {sessionSaving ? '...' : 'Save'}
              </button>
              <button className="sidebar-add-session-cancel" onClick={() => { setShowAddSession(false); setSessionAddError(null); }} disabled={sessionSaving}>
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
      </nav>

      <div className="sidebar-status">
        <div className={`status-dot ${dbStatus}`}>
          {dbStatus === 'connected' ? 'sql_practice' : dbStatus === 'error' ? 'DB not connected' : 'Connecting...'}
        </div>
      </div>
    </div>
  );
}
