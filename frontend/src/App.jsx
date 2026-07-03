import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import LoginView from './components/LoginView';
import PracticeView from './components/PracticeView';
import DatabaseView from './components/DatabaseView';
import QueryPlayground from './components/QueryPlayground';
import ProgressView from './components/ProgressView';
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

  // Check for an existing session on mount — a 401 here just means
  // "not logged in yet", not an application error, so it's handled silently.
  useEffect(() => {
    api.auth.me()
      .then(setActiveUser)
      .catch(() => setActiveUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  // Load sessions whenever active user changes
  useEffect(() => {
    if (!activeUser) {
      setSessions([]);
      setActiveSession(null);
      return;
    }

    api.sessions.list()
      .then(list => {
        setSessions(list);

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
  }, [activeUser]);

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
    setCurrentView('progress');
  }

  // ── Session management ──────────────────────────────────────
  function handleSessionChange(session) {
    setActiveSession(session);
    if (session && activeUser) {
      localStorage.setItem(`activeSessionId:user:${activeUser.id}`, String(session.id));
      api.sessions.open(session.id).catch(() => {});
    }
  }

  async function handleCreateSession(name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = [], datasetId = null) {
    const { session, filters } = await api.sessions.create(name, description, planType, topics, difficulties, projects, categories, datasetId);
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
    setCurrentView(view);
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
      case 'progress':
        return (
          <ProgressView
            activeUser={activeUser}
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
      />
      <main className="main-content">
        {renderView()}
      </main>
    </div>
  );
}
