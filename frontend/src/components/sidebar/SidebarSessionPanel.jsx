import { useEffect, useState } from 'react';
import { isSessionCompleted } from '../../utils/sessionStatus';
import OverflowLabel from './OverflowLabel';
import SidebarDropdown from './SidebarDropdown';
import SidebarAddSessionForm from './SidebarAddSessionForm';
import SidebarArchivedSessions from './SidebarArchivedSessions';

// The session switcher block: current-session dropdown, create/archive/delete
// controls, complete/reopen actions, the create-session form, and the
// archived-sessions panel. Everything here is UX only — every action is
// re-authorized server-side (see CLAUDE.md's role/permission model).
// `confirm` is the container's useConfirmDialog function, so the whole
// sidebar shares one ConfirmModal instance.
export default function SidebarSessionPanel({
  activeUser,
  viewedUser,
  isMentorOverview,
  sessions,
  activeSession,
  onSessionChange,
  onNavigate,
  onCreateSession,
  onArchiveSession,
  onRestoreSession,
  onDeleteSession,
  onCompleteSession,
  onReopenSession,
  canReopenSession,
  requestOpenAddSession,
  onRequestOpenAddSessionConsumed,
  confirm,
}) {
  const [showAddSession, setShowAddSession] = useState(false);
  // Incremented on every open so the form remounts fresh (clearing its
  // inputs and refetching the dataset list) even if it was already open —
  // matching the original openAddSession's explicit reset-and-refetch.
  const [addSessionKey, setAddSessionKey] = useState(0);
  const [sessionAddSuccess, setSessionAddSuccess] = useState(null);
  const [sessionArchiving, setSessionArchiving] = useState(false);
  const [sessionArchiveError, setSessionArchiveError] = useState(null);
  // Delete is a separate, permanent action from Archive — kept as its own
  // state pair rather than reusing the archive ones, so an in-flight/failed
  // delete never gets confused with an in-flight/failed archive.
  const [sessionDeleting, setSessionDeleting] = useState(false);
  const [sessionDeleteError, setSessionDeleteError] = useState(null);
  const [sessionActionError, setSessionActionError] = useState(null);
  const [sessionActioning, setSessionActioning] = useState(false);

  // Clears any stale action/archive error whenever the session context
  // changes — e.g. a successful archive switches to a fallback session (or to
  // none), or the viewer switches to reviewing a different user. Without
  // this, an error from a previous action (or a failed archive of a
  // *different* session) would linger on screen next to an already-valid,
  // already-open session. A genuine error from the action that's currently
  // in flight is set again right after this by its own handler, so it isn't lost.
  useEffect(() => { setSessionActionError(null); setSessionArchiveError(null); setSessionDeleteError(null); }, [activeSession?.id, viewedUser?.id]);

  // A viewed-user context switch (reviewing a different user, or clearing
  // back to the viewer's own sessions) should not leave a stale "created for
  // <user>" confirmation hanging around indefinitely. Deliberately NOT keyed
  // on activeSession?.id — creating a session for the viewed user refreshes
  // and can auto-pick that very session as active, which would otherwise
  // wipe the message before it's ever seen.
  useEffect(() => { setSessionAddSuccess(null); }, [viewedUser?.id, activeUser?.id]);

  // Lets ProgressView's no-session empty state open this same create-session
  // form (mirrors the autoOpenPlanEditor pattern in App.jsx) — this panel
  // stays the single owner of the form; it just gets told to open when asked.
  useEffect(() => {
    if (requestOpenAddSession) {
      openAddSession();
      onRequestOpenAddSessionConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestOpenAddSession]);

  function openAddSession() {
    setSessionAddSuccess(null);
    setAddSessionKey(k => k + 1);
    setShowAddSession(true);
  }

  function closeAddSession() {
    setShowAddSession(false);
  }

  // Called by SidebarAddSessionForm with already-trimmed values; throws on
  // failure so the form keeps its inputs and shows the error itself.
  async function handleSaveSession(name, description, datasetId) {
    const result = await onCreateSession(name, description, 'topic', [], [], [], [], datasetId);
    setShowAddSession(false);
    // A session created for the viewed user does become the selected
    // session immediately (App.jsx's handleCreateSession), but it's still
    // worth an explicit confirmation naming whose account it belongs to —
    // the dropdown alone doesn't make that ownership obvious.
    if (result?.createdForViewedUser) {
      setSessionAddSuccess(`Session "${name}" created for ${viewedUser?.username || 'the viewed user'}. Now choose what this student should practice.`);
    } else {
      setSessionAddSuccess(null);
    }
  }

  async function handleArchiveSession() {
    if (!activeSession) return;
    const confirmed = await confirm({
      title: 'Archive session',
      message: `Archive session "${activeSession.name}"?`,
      details: 'It will be hidden from your session list, but all progress and history will be kept. You can restore it later from "Show archived sessions".',
      confirmLabel: 'Archive session',
      variant: 'info',
    });
    if (!confirmed) return;
    setSessionArchiving(true);
    setSessionArchiveError(null);
    try {
      await onArchiveSession();
    } catch (err) {
      setSessionArchiveError(err.message);
    } finally {
      setSessionArchiving(false);
    }
  }

  // Delete is permanent and distinct from Archive — separate confirmation
  // copy that explicitly names what is destroyed and that it cannot be undone.
  async function handleDeleteSessionClick() {
    if (!activeSession) return;
    const confirmed = await confirm({
      title: 'Delete session',
      message: `Delete session "${activeSession.name}" permanently?`,
      details: 'This will delete its attempts, progress, and plan filters. This cannot be undone.',
      confirmLabel: 'Delete session',
      variant: 'danger',
    });
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
    const confirmed = await confirm({
      title: 'Complete session',
      message: 'Complete this session?',
      details: 'It will become read-only. You can reopen it later.',
      confirmLabel: 'Complete session',
      variant: 'info',
    });
    if (!confirmed) return;
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
    <div className="sidebar-session">
      {isMentorOverview ? (
        // Admin reviewing a mentor: the main panel shows that mentor's
        // assigned-student roster (Mentor Overview), not their own
        // sessions — showing "Sessions for: <mentor>" here would
        // misleadingly imply the sidebar/dropdown still drives the main
        // context. Replaced entirely rather than just relabeled, since
        // there is no "session" concept to switch between in this mode.
        <div className="sidebar-mentor-overview-note">
          <div className="sidebar-session-label">Viewing professor overview</div>
          <p className="sidebar-mentor-overview-text">
            Showing students assigned to <strong>{viewedUser?.username}</strong>. Select a student in the main panel to review their sessions and progress.
          </p>
        </div>
      ) : (
      <>
      <div className="sidebar-session-row">
        <div className="sidebar-session-header">
          {viewedUser ? (
            <OverflowLabel
              text={`Sessions for: ${viewedUser.username}`}
              className="sidebar-session-label sidebar-session-label--student"
            />
          ) : (
            <span className="sidebar-session-label">Session</span>
          )}
        </div>
        <div className="sidebar-session-controls">
          <SidebarDropdown
            options={sessions.map(s => {
              const isCompleted = isSessionCompleted(s);
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
            placeholder={viewedUser ? 'No sessions for this user yet.' : 'No sessions yet'}
          />
          {activeUser?.role !== 'student' && (
            <button
              className="sidebar-add-session-btn"
              onClick={openAddSession}
              title="New session"
            >+</button>
          )}
          {activeUser?.role !== 'student' && (
            <button
              className="sidebar-archive-session-btn"
              onClick={handleArchiveSession}
              title="Archive session"
              disabled={!activeSession || sessionArchiving}
            >🗄</button>
          )}
          {activeUser?.role !== 'student' && (
            <button
              className="sidebar-delete-session-btn"
              onClick={handleDeleteSessionClick}
              title="Delete session"
              disabled={!activeSession || sessionDeleting}
            >🗑</button>
          )}
        </div>
      </div>

      {sessionArchiveError && (
        <div className="sidebar-add-session-error">{sessionArchiveError}</div>
      )}

      {sessionDeleteError && (
        <div className="sidebar-add-session-error">{sessionDeleteError}</div>
      )}

      {activeSession && !activeSession.archived_at && (
        isSessionCompleted(activeSession) ? (
          // Reopen stays available while reviewing — admin/mentor are
          // allowed to reopen an assigned/any session, unlike Complete
          // below. Students should not see the Reopen action at all —
          // backend enforces this independently (canReopenSession is UX only).
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
          // Unlike create/delete/edit/reopen, completing a session is
          // allowed for students too — they legitimately complete their
          // own session once the existing completion conditions are met.
          // But it is ownership-only server-side, so it's never shown
          // while reviewing someone else's session (viewedUser set) —
          // the button would otherwise always fail with a generic error.
          !viewedUser && (
            <>
              <p className="sidebar-complete-hint">
                Complete this session after you run every selected task at least once.
              </p>
              <button
                className="sidebar-session-action sidebar-session-complete"
                onClick={handleCompleteClick}
                disabled={sessionActioning}
              >
                {sessionActioning ? 'Completing…' : 'Complete session'}
              </button>
            </>
          )
        )
      )}

      {sessionActionError && (
        <div className="sidebar-add-session-error">{sessionActionError}</div>
      )}

      {sessionAddSuccess && (
        <div className="sidebar-add-session-success">{sessionAddSuccess}</div>
      )}

      {showAddSession && activeUser?.role !== 'student' && (
        <SidebarAddSessionForm
          key={addSessionKey}
          viewedUser={viewedUser}
          onSave={handleSaveSession}
          onCancel={closeAddSession}
        />
      )}

      {activeUser?.role !== 'student' && (
        <SidebarArchivedSessions
          activeUser={activeUser}
          viewedUser={viewedUser}
          onRestoreSession={onRestoreSession}
        />
      )}
      </>
      )}
    </div>
  );
}
