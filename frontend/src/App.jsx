import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import LoginView from './components/LoginView';
import PracticeView from './components/PracticeView';
import DatabaseView from './components/DatabaseView';
import QueryPlayground from './components/QueryPlayground';
import ProgressView from './components/ProgressView';
import UserManagementView from './components/UserManagementView';
import MyStudentsView from './components/MyStudentsView';
import { api } from './api';

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

  // ── Selected student context (professor viewing a student) ────
  // Purely a UI context flag for now — { id, username, role } of the
  // student a professor clicked into from My Students. NOT the acting
  // identity: activeUser always stays the logged-in user. No API call in
  // this step reads selectedStudent — Progress/Sessions/Practice still
  // fetch the logged-in user's own data until a later step wires it up.
  const [selectedStudent, setSelectedStudent] = useState(null);

  // Only students are structurally barred from ever having a selected
  // student (there is no UI path for them to set one, but this guards
  // against a stale value surviving a role change without a full reload).
  useEffect(() => {
    if (activeUser?.role === 'student') setSelectedStudent(null);
  }, [activeUser?.role]);

  // Check for an existing session on mount — a 401 here just means
  // "not logged in yet", not an application error, so it's handled silently.
  useEffect(() => {
    api.auth.me()
      .then(setActiveUser)
      .catch(() => setActiveUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  // Default landing page for professors, and clearing any selected-student
  // context from a previous login — both keyed on activeUser?.id so they
  // only fire when the logged-in user actually changes, never on every
  // activeUser re-render or on in-session navigation.
  useEffect(() => {
    setSelectedStudent(null);
    if (activeUser?.role === 'mentor') {
      setCurrentView('my-students');
    }
  }, [activeUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Loads sessions for the current "session context": the selected
  // student's sessions when a professor is viewing one, otherwise the
  // logged-in user's own sessions. Shared by the effect below and by
  // handleCreateSession's post-create refresh for a selected student.
  function loadSessionsForContext() {
    if (!activeUser) {
      setSessions([]);
      setActiveSession(null);
      return Promise.resolve();
    }

    const targetUserId = (activeUser.role === 'mentor' && selectedStudent) ? selectedStudent.id : null;

    return api.sessions.list(targetUserId)
      .then(list => {
        setSessions(list);

        if (targetUserId) {
          // Viewing a student's sessions for display only — do not call
          // api.sessions.open (that PATCH route is unchanged this step and
          // scoped to the acting user's own sessions), and don't persist to
          // localStorage since this isn't the professor's own last-used session.
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

  // Reloads whenever the logged-in user or the selected-student context
  // changes — covers login/logout, a professor selecting a student, and a
  // professor clearing that selection back to their own sessions.
  useEffect(() => {
    loadSessionsForContext();
  }, [activeUser, selectedStudent]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setSelectedStudent(null);
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
    setSelectedStudent(null);
    setCurrentView('progress');
  }

  // ── Session management ──────────────────────────────────────
  function handleSessionChange(session) {
    setActiveSession(session);
    if (!session || !activeUser) return;

    // Sessions shown while viewing a selected student belong to that
    // student, not the professor — PATCH /:id/open is unchanged this step
    // and scoped to the acting user's own sessions, so skip it (it would
    // just 404) and don't persist it under the professor's own localStorage key.
    if (activeUser.role === 'mentor' && selectedStudent) return;

    localStorage.setItem(`activeSessionId:user:${activeUser.id}`, String(session.id));
    api.sessions.open(session.id).catch(() => {});
  }

  async function handleCreateSession(name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = [], datasetId = null) {
    // Only a professor with a selected student targets someone else — every
    // other case (student, admin, professor with no selection) omits
    // targetUserId and keeps the exact self-creation behavior from before.
    const targetUserId = (activeUser?.role === 'mentor' && selectedStudent) ? selectedStudent.id : null;
    const { session, filters } = await api.sessions.create(name, description, planType, topics, difficulties, projects, categories, datasetId, targetUserId);

    if (targetUserId) {
      // The created session belongs to the student, not the professor.
      // GET /api/sessions can now read the selected student's sessions
      // (this step), so refresh that list to show the new session — but
      // deliberately do not auto-select/open it: Progress still isn't
      // wired to the selected student, so forcing it "active" wouldn't
      // show anything meaningful yet. loadSessionsForContext's normal
      // "most recently opened, else first" pick decides on its own.
      await loadSessionsForContext();
      return { session, filters, createdForStudent: true };
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

  async function handleDeleteSession() {
    if (!activeSession || !activeUser) return;
    const deletedId = activeSession.id;
    await api.sessions.delete(deletedId);
    localStorage.removeItem(`activeSessionId:user:${activeUser.id}`);
    const remaining = sessions.filter(s => s.id !== deletedId);
    setSessions(remaining);
    const nextSession = remaining[0] || null;
    setActiveSession(nextSession);
    if (nextSession) {
      localStorage.setItem(`activeSessionId:user:${activeUser.id}`, String(nextSession.id));
      api.sessions.open(nextSession.id).catch(() => {});
    }
    setCurrentView('progress');
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
    // Going back to My Students is treated as leaving the selected-student
    // context, so a professor doesn't land back on Progress still "viewing"
    // a student they navigated away from.
    if (view === 'my-students') {
      setSelectedStudent(null);
    }
    setCurrentView(view);
  }

  // Sets selected-student context from My Students and jumps to Progress.
  // Progress does not yet fetch this student's data (Step F is context-only
  // — see the viewing banner below); that wiring is a later step.
  function handleSelectStudent(student) {
    if (activeUser?.role !== 'mentor' || !student) return;
    setSelectedStudent({ id: student.id, username: student.username, role: student.role });
    handleNavigate('progress');
  }

  function handleClearSelectedStudent() {
    setSelectedStudent(null);
    if (activeUser?.role === 'mentor') {
      handleNavigate('my-students');
    }
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
        // Only a professor with a selected student views someone else's
        // progress — every other case (student, admin, professor with no
        // selection) omits targetUserId and sees their own, unchanged.
        const progressTargetUserId = (activeUser?.role === 'mentor' && selectedStudent) ? selectedStudent.id : null;
        return (
          <ProgressView
            activeUser={activeUser}
            selectedStudent={progressTargetUserId ? selectedStudent : null}
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
          />
        );
      }
      case 'users':
        return activeUser?.role === 'admin' ? <UserManagementView /> : null;
      case 'my-students':
        return activeUser?.role === 'mentor'
          ? <MyStudentsView onSelectStudent={handleSelectStudent} />
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
        onDeleteSession={handleDeleteSession}
        onCompleteSession={handleCompleteSession}
        onReopenSession={handleReopenSession}
        canReopenSession={canReopenSession(activeUser)}
        selectedStudent={activeUser?.role === 'mentor' ? selectedStudent : null}
      />
      <main className="main-content">
        {selectedStudent && activeUser?.role !== 'student' && (
          <div className="viewing-banner">
            <span className="viewing-banner-text">
              Viewing student: <strong>{selectedStudent.username}</strong>.
              {' '}Sessions and Progress are connected. Practice actions remain your own.
            </span>
            <button className="viewing-banner-clear" onClick={handleClearSelectedStudent}>
              {activeUser?.role === 'mentor' ? 'Back to My Students' : 'Clear selection'}
            </button>
          </div>
        )}
        {renderView()}
      </main>
    </div>
  );
}
