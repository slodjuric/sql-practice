import { useEffect, useState } from 'react';
import { api } from '../../api';
import OverflowLabel from './OverflowLabel';

// Archived sessions (peek/restore). Fetches its own list, independent of the
// main `sessions` prop (which only ever holds non-archived sessions) —
// nothing else in the app needs to react to "which sessions are archived",
// so this stays a self-contained, toggle-driven concern rather than threaded
// through App.jsx's session-context state.
export default function SidebarArchivedSessions({ activeUser, viewedUser, onRestoreSession }) {
  const [showArchived, setShowArchived] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState(null);
  const [restoringId, setRestoringId] = useState(null);
  const [restoreError, setRestoreError] = useState(null);

  // A viewed-user context switch should never leave a *previous* reviewed
  // user's archived-session list on screen — collapse the toggle and clear
  // whatever was loaded so the next open fetches fresh, correctly-scoped data.
  useEffect(() => {
    setShowArchived(false);
    setArchivedSessions([]);
    setArchivedError(null);
    setRestoreError(null);
  }, [viewedUser?.id, activeUser?.id]);

  function loadArchivedSessions() {
    const targetUserId = viewedUser ? viewedUser.id : undefined;
    setArchivedLoading(true);
    setArchivedError(null);
    api.sessions.list(targetUserId, true)
      .then(list => setArchivedSessions(list.filter(s => s.archived_at)))
      .catch(err => setArchivedError(err.message))
      .finally(() => setArchivedLoading(false));
  }

  function toggleShowArchived() {
    const opening = !showArchived;
    setShowArchived(opening);
    if (opening) loadArchivedSessions();
  }

  async function handleRestoreClick(sessionId) {
    setRestoreError(null);
    setRestoringId(sessionId);
    try {
      await onRestoreSession(sessionId);
      setArchivedSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (err) {
      setRestoreError(err.message);
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <div className="sidebar-archived-section">
      <button
        type="button"
        className="sidebar-archived-toggle"
        onClick={toggleShowArchived}
      >
        <span className="nav-arrow">{showArchived ? '▾' : '▸'}</span>
        {showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
      </button>

      {showArchived && (
        <div className="sidebar-archived-list">
          {archivedLoading && <div className="sidebar-archived-loading">Loading…</div>}
          {archivedError && <div className="sidebar-add-session-error">{archivedError}</div>}
          {restoreError && <div className="sidebar-add-session-error">{restoreError}</div>}
          {!archivedLoading && !archivedError && archivedSessions.length === 0 && (
            <div className="sidebar-archived-empty">
              {viewedUser ? `No archived sessions for ${viewedUser.username}.` : 'No archived sessions.'}
            </div>
          )}
          {archivedSessions.map(s => (
            <div key={s.id} className="sidebar-archived-item">
              <OverflowLabel text={s.name} className="sidebar-archived-item-name" />
              <button
                type="button"
                className="sidebar-archived-restore-btn"
                onClick={() => handleRestoreClick(s.id)}
                disabled={restoringId === s.id}
                title="Restore session"
              >
                {restoringId === s.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
