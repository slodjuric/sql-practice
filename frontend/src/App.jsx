import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import LoginView from './components/LoginView';
import PracticeView from './components/PracticeView';
import DatabaseView from './components/DatabaseView';
import QueryPlayground from './components/QueryPlayground';
import ProgressView from './components/ProgressView';
import UserManagementView from './components/UserManagementView';
import MyStudentsView from './components/MyStudentsView';
import MentorOverviewView from './components/MentorOverviewView';
import { api } from './api';
import { roleLabel } from './utils/roleLabels';

// Roles that can review another user's sessions/progress. Students never can.
function canViewOthers(role) {
  return role === 'mentor' || role === 'admin';
}

// A professor's own owned sessions are rarely meaningful (their job is
// managing students, not solving tasks) — when admin reviews a mentor,
// show the assigned-student roster (MentorOverviewView) instead of the
// normal ProgressView. This never applies to a mentor's own review of a
// student (that viewedUser is always role 'student', see My Students).
function showsMentorOverview(activeUser, viewedUser) {
  return activeUser?.role === 'admin' && viewedUser?.role === 'mentor';
}

export default function App() {
  const [currentView, setCurrentView] = useState('progress');
  const [selectedTable, setSelectedTable] = useState(null);
  const [isInTask, setIsInTask] = useState(false);
  const [tableToOpenInTask, setTableToOpenInTask] = useState(null);
  const [tableToOpenInPlayground, setTableToOpenInPlayground] = useState(null);
  const [practiceTarget,   setPracticeTarget]   = useState(null);
  const [practiceCategory, setPracticeCategory] = useState(null);

  // ── Auth state ──────────────────────────────────────────────
  // activeUser is the real logged-in identity (GET /api/auth/me), not a
  // switcher pick — the temporary switcher was removed in this step.
  const [activeUser, setActiveUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Session state ───────────────────────────────────────────
  const [sessions,       setSessions]       = useState([]);
  const [activeSession,  setActiveSession]  = useState(null);
  const [sessionFilters, setSessionFilters] = useState({ topics: [], difficulties: [], projects: [] });
  const [progressVersion, setProgressVersion] = useState(0);
  const [openPlanEditorOnProgress, setOpenPlanEditorOnProgress] = useState(false);

  // Lets ProgressView's no-session empty state trigger Sidebar's existing
  // create-session form (mirrors the autoOpenPlanEditor pattern above) —
  // Sidebar remains the single owner of that form, ProgressView never
  // duplicates it.
  const [requestOpenAddSession, setRequestOpenAddSession] = useState(false);

  // ── Viewed-user context (mentor/admin reviewing another user) ──
  // A UI context flag: { id, username, role } of the user a mentor clicked
  // into from My Students (later: an admin from User Management). NOT the
  // acting identity — activeUser always stays the logged-in user. Only
  // affects read/review/session-management context (sessions list, plan
  // edit/delete/reopen, progress); Practice's run/check remain hard-scoped
  // to activeUser regardless of viewedUser — see canViewOthers() above.
  const [viewedUser, setViewedUser] = useState(null);

  // Set by handleOpenStudentSession (My Students' "View sessions" panel) to
  // pin a SPECIFIC session as the one loadSessionsForContext should select,
  // overriding its normal "most recently opened" heuristic — a mentor
  // picking an exact session from a student's history should land on that
  // session, not whichever one the student last touched. Consumed (cleared)
  // the next time loadSessionsForContext runs while viewing that user.
  const [pendingOpenSessionId, setPendingOpenSessionId] = useState(null);

  // Only students are structurally barred from ever having a viewed user
  // (there is no UI path for them to set one, but this guards against a
  // stale value surviving a role change without a full reload).
  useEffect(() => {
    if (activeUser?.role === 'student') setViewedUser(null);
  }, [activeUser?.role]);

  // Check for an existing session on mount — a 401 here just means
  // "not logged in yet", not an application error, so it's handled silently.
  useEffect(() => {
    api.auth.me()
      .then(setActiveUser)
      .catch(() => setActiveUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  // Default landing page per role, and clearing any viewed-user context from
  // a previous login — both keyed on activeUser?.id so they only fire when
  // the logged-in user actually changes, never on every activeUser
  // re-render or on in-session navigation. Mentor lands on My Students,
  // admin lands on User Management (their own Progress isn't a meaningful
  // default — see the role-system analysis); student keeps the unchanged
  // default of 'progress'.
  useEffect(() => {
    setViewedUser(null);
    if (activeUser?.role === 'mentor') {
      setCurrentView('my-students');
    } else if (activeUser?.role === 'admin') {
      setCurrentView('users');
    }
  }, [activeUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Loads sessions for the current "session context": the viewed user's
  // sessions when a mentor/admin is reviewing one, otherwise the logged-in
  // user's own sessions. Shared by the effect below and by
  // handleCreateSession's post-create refresh for a viewed user.
  function loadSessionsForContext() {
    if (!activeUser) {
      setSessions([]);
      setActiveSession(null);
      return Promise.resolve();
    }

    const targetUserId = (canViewOthers(activeUser.role) && viewedUser) ? viewedUser.id : null;

    return api.sessions.list(targetUserId)
      .then(list => {
        setSessions(list);

        if (targetUserId) {
          // A specific session was requested (My Students' "View sessions"
          // panel, via handleOpenStudentSession) — honor it instead of the
          // "most recently opened" heuristic below, then clear it so it
          // doesn't stick across an unrelated later reload of this same
          // viewed user's sessions.
          if (pendingOpenSessionId) {
            const pending = list.find(s => s.id === pendingOpenSessionId);
            setPendingOpenSessionId(null);
            if (pending) {
              setActiveSession(pending);
              return;
            }
          }

          // Viewing another user's sessions for display only — do not call
          // api.sessions.open (that PATCH route is unchanged this step and
          // scoped to the acting user's own sessions), and don't persist to
          // localStorage since this isn't the viewer's own last-used session.
          const byLastOpened = list
            .filter(s => s.last_opened_at)
            .sort((a, b) => new Date(b.last_opened_at) - new Date(a.last_opened_at));
          setActiveSession(byLastOpened[0] || list[0] || null);
          return;
        }

        const key     = `activeSessionId:user:${activeUser.id}`;
        const savedId = localStorage.getItem(key);
        const saved   = savedId ? list.find(s => s.id === parseInt(savedId, 10)) : null;

        let picked;
        if (saved) {
          picked = saved;
        } else {
          const byLastOpened = list
            .filter(s => s.last_opened_at)
            .sort((a, b) => new Date(b.last_opened_at) - new Date(a.last_opened_at));
          picked = byLastOpened[0] || list[0] || null;
        }

        setActiveSession(picked);
        if (picked) api.sessions.open(picked.id).catch(() => {});
      })
      .catch(() => {});
  }

  // Reloads whenever the logged-in user or the viewed-user context
  // changes — covers login/logout, a mentor/admin selecting a user to
  // review, and clearing that selection back to their own sessions.
  useEffect(() => {
    loadSessionsForContext();
  }, [activeUser, viewedUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load filters whenever the active session changes.
  // Also clear the selected table so DatabaseView never loads a stale table
  // into a dataset that may not contain it (e.g. after switching from academic to football).
  useEffect(() => {
    setSelectedTable(null);
    if (!activeSession?.id) {
      setSessionFilters({ topics: [], difficulties: [] });
      return;
    }
    api.sessions.filters(activeSession.id)
      .then(setSessionFilters)
      .catch(() => setSessionFilters({ topics: [], difficulties: [], projects: [] }));
  }, [activeSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auth management ──────────────────────────────────────────
  function handleLoginSuccess(user) {
    setActiveUser(user);
  }

  async function handleLogout() {
    try {
      await api.auth.logout();
    } catch {
      // logging out client-side regardless of whether the server call succeeded
    }
    setActiveUser(null);
    setSessions([]);
    setActiveSession(null);
    setViewedUser(null);
    setCurrentView('progress');
  }

  // Admin-only, self-delete only (see Sidebar) — deletes the logged-in account.
  async function handleDeleteUser() {
    if (!activeUser) return;
    const deletedId = activeUser.id;
    await api.users.delete(deletedId);
    try {
      await api.auth.logout();
    } catch {
      // account is already gone server-side; logging out regardless
    }
    localStorage.removeItem(`activeSessionId:user:${deletedId}`);
    setActiveUser(null);
    setSessions([]);
    setActiveSession(null);
    setViewedUser(null);
    setCurrentView('progress');
  }

  // ── Session management ──────────────────────────────────────
  function handleSessionChange(session) {
    setActiveSession(session);
    if (!session || !activeUser) return;

    // Sessions shown while reviewing a viewed user belong to that user, not
    // the viewer — PATCH /:id/open is unchanged this step and scoped to the
    // acting user's own sessions, so skip it (it would just 404) and don't
    // persist it under the viewer's own localStorage key.
    if (canViewOthers(activeUser.role) && viewedUser) return;

    localStorage.setItem(`activeSessionId:user:${activeUser.id}`, String(session.id));
    api.sessions.open(session.id).catch(() => {});
  }

  async function handleCreateSession(name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = [], datasetId = null) {
    // Only a mentor/admin with a viewed user targets someone else — every
    // other case (student, or no viewed user) omits targetUserId and keeps
    // the exact self-creation behavior from before.
    const targetUserId = (canViewOthers(activeUser?.role) && viewedUser) ? viewedUser.id : null;
    const { session, filters } = await api.sessions.create(name, description, planType, topics, difficulties, projects, categories, datasetId, targetUserId);

    if (targetUserId) {
      // The created session belongs to the viewed user, not the viewer, but
      // it should still become the active session in this review context
      // immediately — mirrors the self-creation path below exactly.
      // handleSessionChange sets activeSession unconditionally but skips
      // localStorage + api.sessions.open() whenever canViewOthers(role) &&
      // viewedUser is true, so this never touches the viewed user's own
      // last_opened_at (PATCH /:id/open is self-only by design) or the
      // viewer's own localStorage key.
      setSessions(prev => [...prev, session]);
      handleSessionChange(session);
      setSessionFilters(filters);
      setOpenPlanEditorOnProgress(true);
      setCurrentView('progress');
      return { session, filters, createdForViewedUser: true };
    }

    setSessions(prev => [...prev, session]);
    handleSessionChange(session);
    setSessionFilters(filters);
    setOpenPlanEditorOnProgress(true);
    setCurrentView('progress');
    return { session, filters };
  }

  async function handleUpdateSession(sessionId, updates) {
    const { session, filters } = await api.sessions.update(sessionId, updates);
    setSessions(prev => prev.map(s => s.id === session.id ? session : s));
    setActiveSession(session);
    setSessionFilters(filters);
    return { session, filters };
  }

  // Shared by Archive and Delete below — both remove a session from the
  // visible list and fall back to another session the same way the old
  // hard-delete flow did, correctly guarding the viewedUser case (mirrors
  // handleSessionChange's guard above): while reviewing another user's
  // sessions, never touch the viewer's own localStorage key or call the
  // self-only PATCH /:id/open route on the reviewed user's behalf.
  function removeSessionAndPickNext(removedId) {
    const remaining = sessions.filter(s => s.id !== removedId);
    setSessions(remaining);
    const nextSession = remaining[0] || null;

    if (canViewOthers(activeUser.role) && viewedUser) {
      setActiveSession(nextSession);
    } else {
      localStorage.removeItem(`activeSessionId:user:${activeUser.id}`);
      setActiveSession(nextSession);
      if (nextSession) {
        localStorage.setItem(`activeSessionId:user:${activeUser.id}`, String(nextSession.id));
        api.sessions.open(nextSession.id).catch(() => {});
      }
    }
    setCurrentView('progress');
  }

  // Archive is the normal user-facing way to remove a session from the
  // visible list — it preserves all history and is restorable (see
  // handleRestoreSession below).
  async function handleArchiveSession() {
    if (!activeSession || !activeUser) return;
    const archivedId = activeSession.id;
    await api.sessions.archive(archivedId);
    removeSessionAndPickNext(archivedId);
  }

  // Restoring a session only brings it back into the visible list — it
  // deliberately does NOT make it the active session (avoids silently
  // switching the user's current focus to an old, possibly stale plan). The
  // simplest, safest refresh is to reload the canonical list for whichever
  // context (self or reviewed user) is currently active.
  async function handleRestoreSession(sessionId) {
    await api.sessions.restore(sessionId);
    await loadSessionsForContext();
  }

  // Delete is separate from Archive — permanent, destroys task_attempts/
  // user_task_progress/learning_session_filters server-side (see
  // DELETE /api/sessions/:id), never restorable. Kept as its own handler
  // (rather than a parameter on handleArchiveSession) so the two destructive
  // actions stay clearly distinct at the call-site level, matching the UI.
  async function handleDeleteSession() {
    if (!activeSession || !activeUser) return;
    const deletedId = activeSession.id;
    await api.sessions.delete(deletedId);
    removeSessionAndPickNext(deletedId);
  }

  // Mirrors backend canReopenSession() (backend/src/utils/authz.js) for UX
  // visibility only — the backend is the source of truth and enforces this
  // independently on PATCH /api/sessions/:id/reopen.
  function canReopenSession(user) {
    return user?.role === 'admin' || user?.role === 'mentor';
  }

  async function handleCompleteSession() {
    if (!activeSession || !activeUser) return;
    try {
      const updated = await api.sessions.complete(activeSession.id);
      setSessions(prev => prev.map(s => s.id === updated.id ? updated : s));
      setActiveSession(updated);
    } catch (err) {
      console.error('Failed to complete session:', err);
      throw err;
    }
  }

  async function handleReopenSession() {
    if (!activeSession || !activeUser) return;
    try {
      const updated = await api.sessions.reopen(activeSession.id);
      setSessions(prev => prev.map(s => s.id === updated.id ? updated : s));
      setActiveSession(updated);
    } catch (err) {
      console.error('Failed to reopen session:', err);
      throw err;
    }
  }

  function handleProgressInvalidate() {
    setProgressVersion(v => v + 1);
  }

  // ── Navigation ──────────────────────────────────────────────
  function handleNavigate(view) {
    if (view !== 'practice') {
      setIsInTask(false);
      setPracticeTarget(null);
      setPracticeCategory(null);
    }
    // Going back to My Students (mentor) or User Management (admin) is
    // treated as leaving the viewed-user context, so the viewer doesn't land
    // back on Progress still "viewing" a user they navigated away from.
    if (view === 'my-students' || view === 'users') {
      setViewedUser(null);
    }
    setCurrentView(view);
  }

  // Sets the viewed-user context — from My Students (mentor) or User
  // Management's "Review" action (admin) — and jumps to Progress.
  function handleSelectViewedUser(user) {
    if (!canViewOthers(activeUser?.role) || !user) return;
    setViewedUser({ id: user.id, username: user.username, role: user.role });
    handleNavigate('progress');
  }

  function handleClearViewedUser() {
    setViewedUser(null);
    if (activeUser?.role === 'mentor') {
      handleNavigate('my-students');
    } else if (activeUser?.role === 'admin') {
      handleNavigate('users');
    }
  }

  // "Create session for this student" quick action (My Students overview) —
  // the whole point is skipping the "view student, then find the sidebar's
  // + button" two-step flow: this sets the review context AND opens the
  // sidebar's existing create-session form in one click. Sidebar already
  // shows "Creating session for: <username>" whenever viewedUser is set
  // while that form is open, and handleCreateSession already targets
  // viewedUser when present — both unchanged, this just triggers them together.
  // Deliberately calls setCurrentView directly, not handleNavigate('progress')
  // — handleNavigate has no special-case for 'progress' clearing viewedUser,
  // so this is equivalent, but going through the raw setter here keeps this
  // function's intent (view student's context, don't touch task/practice
  // state) obvious without relying on handleNavigate's unrelated resets.
  function handleCreateSessionForStudent(student) {
    if (!canViewOthers(activeUser?.role) || !student) return;
    setViewedUser({ id: student.id, username: student.username, role: student.role });
    setCurrentView('progress');
    setRequestOpenAddSession(true);
  }

  // "Open" on a specific session in My Students' "View sessions" history
  // panel — jumps straight to review mode for that student WITH that exact
  // session selected (via pendingOpenSessionId, see loadSessionsForContext),
  // rather than whichever session the student last opened. Once there, the
  // mentor already has full edit/archive/reopen tooling via the existing
  // Sidebar controls — this intentionally does not duplicate those actions.
  function handleOpenStudentSession(student, session) {
    if (!canViewOthers(activeUser?.role) || !student || !session) return;
    setPendingOpenSessionId(session.id);
    setViewedUser({ id: student.id, username: student.username, role: student.role });
    setCurrentView('progress');
  }

  // Admin deleted another user's account from User Management. UserManagementView
  // already removes the row from its own local list — this only needs to clear
  // viewedUser if the deleted account was the one currently being reviewed, so
  // the app doesn't keep pointing "Viewing: X" at an account that no longer
  // exists. Deliberately stays on the current view (already 'users') rather
  // than navigating anywhere — clearing viewedUser is itself the safe default.
  function handleUserDeleted(deletedUserId) {
    if (viewedUser?.id === deletedUserId) {
      setViewedUser(null);
    }
  }

  // A direct shortcut back to the viewer's own Progress, without going
  // through My Students/User Management first — clicking the "Progress" nav
  // item alone doesn't clear viewedUser (that's still whichever session
  // context was active), so this is the one explicit way to leave review
  // mode from anywhere. setViewedUser(null) must happen before/alongside
  // handleNavigate('progress') here since handleNavigate only clears
  // viewedUser for the 'my-students'/'users' targets, not 'progress'.
  function handleViewOwnProgress() {
    setViewedUser(null);
    handleNavigate('progress');
  }

  function openTaskFromProgress({ taskId, topicId, attemptSql }) {
    setCurrentView('practice');
    setIsInTask(true);
    setPracticeCategory(null);
    setPracticeTarget({ taskId, topicId, attemptSql: attemptSql || null, origin: 'progress' });
  }

  function openCategoryFromProgress(groupId, planType) {
    setIsInTask(false);
    setPracticeTarget(null);
    setPracticeCategory({ groupId, planType });
    setCurrentView('practice');
  }

  function handleSelectTable(tableName) {
    if (currentView === 'practice' && isInTask) {
      setTableToOpenInTask(tableName);
    } else if (currentView === 'playground') {
      setTableToOpenInPlayground(tableName);
    } else {
      setSelectedTable(tableName);
      setCurrentView('database');
    }
  }

  function renderView() {
    switch (currentView) {
      case 'practice':
        return (
          <PracticeView
            activeUser={activeUser}
            activeSession={activeSession}
            sessionFilters={sessionFilters}
            onTaskEnter={() => setIsInTask(true)}
            onTaskExit={() => setIsInTask(false)}
            tableToOpenInTask={tableToOpenInTask}
            onTableOpened={() => setTableToOpenInTask(null)}
            practiceTarget={practiceTarget}
            onPracticeTargetConsumed={() => setPracticeTarget(null)}
            practiceCategory={practiceCategory}
            onPracticeCategoryConsumed={() => setPracticeCategory(null)}
            onProgressInvalidate={handleProgressInvalidate}
            onBackToProgress={() => handleNavigate('progress')}
            // Display-only — a mentor/admin may reach Practice from a
            // reviewed student's task list. Never used for any API call:
            // run/check remain hard-scoped to activeUser/activeSession
            // regardless of this prop. Purely drives the safety notice
            // shown above TaskView.
            viewedUser={canViewOthers(activeUser?.role) ? viewedUser : null}
          />
        );
      case 'database':
        return <DatabaseView selectedTable={selectedTable} activeSession={activeSession} />;
      case 'playground':
        return (
          <QueryPlayground
            tableToOpen={tableToOpenInPlayground}
            onTableOpened={() => setTableToOpenInPlayground(null)}
            activeUser={activeUser}
            activeSession={activeSession}
          />
        );
      case 'progress': {
        // Admin reviewing a mentor sees that mentor's assigned-student
        // roster instead of their own (likely empty/irrelevant) sessions —
        // see showsMentorOverview() above. Reviewing a student (by admin or
        // mentor) is unaffected and still goes to the normal ProgressView.
        if (showsMentorOverview(activeUser, viewedUser)) {
          return <MentorOverviewView mentor={viewedUser} onReviewStudent={handleSelectViewedUser} />;
        }

        // Only a mentor/admin with a viewed user reviews someone else's
        // progress — every other case (student, or no viewed user) omits
        // targetUserId and sees their own, unchanged.
        const progressTargetUserId = (canViewOthers(activeUser?.role) && viewedUser) ? viewedUser.id : null;
        return (
          <ProgressView
            activeUser={activeUser}
            viewedUser={progressTargetUserId ? viewedUser : null}
            targetUserId={progressTargetUserId}
            activeSession={activeSession}
            sessionFilters={sessionFilters}
            onOpenTask={openTaskFromProgress}
            onOpenCategory={openCategoryFromProgress}
            onUpdateSession={handleUpdateSession}
            onNavigate={handleNavigate}
            progressVersion={progressVersion}
            autoOpenPlanEditor={openPlanEditorOnProgress}
            onAutoOpenPlanEditorConsumed={() => setOpenPlanEditorOnProgress(false)}
            onRequestCreateSession={() => setRequestOpenAddSession(true)}
          />
        );
      }
      case 'users':
        return activeUser?.role === 'admin'
          ? (
            <UserManagementView
              activeUser={activeUser}
              onReviewUser={handleSelectViewedUser}
              onUserDeleted={handleUserDeleted}
              // An admin changing their OWN role away from admin loses access
              // to this screen immediately (role is re-derived fresh from the
              // DB on every request — see backend PATCH /api/users/:id/role).
              // Reuse the same full logout flow as Sidebar's account panel so
              // they land on a clean login screen rather than a stale,
              // now-wrong-permission view.
              onSelfRoleChanged={handleLogout}
            />
          )
          : null;
      case 'my-students':
        return activeUser?.role === 'mentor'
          ? (
            <MyStudentsView
              onSelectStudent={handleSelectViewedUser}
              onCreateSessionForStudent={handleCreateSessionForStudent}
              onOpenStudentSession={handleOpenStudentSession}
            />
          )
          : null;
      default:
        return <PracticeView activeUser={activeUser} activeSession={activeSession} />;
    }
  }

  if (authLoading) {
    return <div className="app-loading">Loading…</div>;
  }

  if (!activeUser) {
    return <LoginView onLogin={handleLoginSuccess} />;
  }

  return (
    <div className="app">
      <Sidebar
        currentView={currentView}
        onNavigate={handleNavigate}
        selectedTable={selectedTable}
        onSelectTable={handleSelectTable}
        activeUser={activeUser}
        onLogout={handleLogout}
        onDeleteUser={handleDeleteUser}
        sessions={sessions}
        activeSession={activeSession}
        onSessionChange={handleSessionChange}
        onCreateSession={handleCreateSession}
        onArchiveSession={handleArchiveSession}
        onRestoreSession={handleRestoreSession}
        onDeleteSession={handleDeleteSession}
        onCompleteSession={handleCompleteSession}
        onReopenSession={handleReopenSession}
        canReopenSession={canReopenSession(activeUser)}
        viewedUser={canViewOthers(activeUser?.role) ? viewedUser : null}
        isMentorOverview={showsMentorOverview(activeUser, viewedUser)}
        requestOpenAddSession={requestOpenAddSession}
        onRequestOpenAddSessionConsumed={() => setRequestOpenAddSession(false)}
      />
      <main className="main-content">
        {viewedUser && canViewOthers(activeUser?.role) && (
          <div className="viewing-banner">
            <span className="viewing-banner-text">
              Viewing: <strong>{viewedUser.username}</strong> ({roleLabel(viewedUser.role)}).
              {' '}{showsMentorOverview(activeUser, viewedUser)
                ? "Showing this professor's assigned students, not their own sessions."
                : 'Sessions and Progress are connected. Practice actions remain your own.'}
            </span>
            <div className="viewing-banner-actions">
              <button className="viewing-banner-own-progress" onClick={handleViewOwnProgress}>
                View my progress
              </button>
              <button className="viewing-banner-clear" onClick={handleClearViewedUser}>
                {activeUser?.role === 'mentor' ? 'Back to My Students'
                  : activeUser?.role === 'admin' ? 'Back to User Management'
                  : 'Clear selection'}
              </button>
            </div>
          </div>
        )}
        {renderView()}
      </main>
    </div>
  );
}
