import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
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

  // ── User state ──────────────────────────────────────────────
  const [users, setUsers] = useState([]);
  const [activeUser, setActiveUser] = useState(null);

  // ── Session state ───────────────────────────────────────────
  const [sessions,       setSessions]       = useState([]);
  const [activeSession,  setActiveSession]  = useState(null);
  const [sessionFilters, setSessionFilters] = useState({ topics: [], difficulties: [], projects: [] });
  const [progressVersion, setProgressVersion] = useState(0);
  const [openPlanEditorOnProgress, setOpenPlanEditorOnProgress] = useState(false);

  // Load users on mount
  useEffect(() => {
    api.users.list()
      .then(userList => {
        setUsers(userList);
        const savedId = localStorage.getItem('activeUserId');
        const saved   = savedId ? userList.find(u => u.id === parseInt(savedId, 10)) : null;
        setActiveUser(saved || userList[0] || null);
      })
      .catch(() => {});
  }, []);

  // Load sessions whenever active user changes
  useEffect(() => {
    if (!activeUser) {
      setSessions([]);
      setActiveSession(null);
      return;
    }

    api.sessions.list(activeUser.id)
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
        if (picked) api.sessions.open(picked.id, activeUser?.id).catch(() => {});
      })
      .catch(() => {});
  }, [activeUser]);

  // Load filters whenever the active session changes
  useEffect(() => {
    if (!activeSession?.id) {
      setSessionFilters({ topics: [], difficulties: [] });
      return;
    }
    api.sessions.filters(activeSession.id)
      .then(setSessionFilters)
      .catch(() => setSessionFilters({ topics: [], difficulties: [], projects: [] }));
  }, [activeSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── User management ─────────────────────────────────────────
  function handleUserChange(user) {
    setActiveUser(user);
    if (user) localStorage.setItem('activeUserId', String(user.id));
  }

  async function handleCreateUser(username) {
    const newUser = await api.users.create(username);
    setUsers(prev => [...prev, newUser]);
    handleUserChange(newUser);
    return newUser;
  }

  async function handleDeleteUser() {
    if (!activeUser) return;
    const deletedId = activeUser.id;
    await api.users.delete(deletedId);
    localStorage.removeItem('activeUserId');
    localStorage.removeItem(`activeSessionId:user:${deletedId}`);
    const remaining = users.filter(u => u.id !== deletedId);
    setUsers(remaining);
    setSessions([]);
    setActiveSession(null);
    const nextUser = remaining[0] || null;
    setActiveUser(nextUser);
    if (nextUser) localStorage.setItem('activeUserId', String(nextUser.id));
    setCurrentView('progress');
  }

  // ── Session management ──────────────────────────────────────
  function handleSessionChange(session) {
    setActiveSession(session);
    if (session && activeUser) {
      localStorage.setItem(`activeSessionId:user:${activeUser.id}`, String(session.id));
      api.sessions.open(session.id, activeUser?.id).catch(() => {});
    }
  }

  async function handleCreateSession(name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = []) {
    const { session, filters } = await api.sessions.create(activeUser.id, name, description, planType, topics, difficulties, projects, categories);
    setSessions(prev => [...prev, session]);
    handleSessionChange(session);
    setSessionFilters(filters);
    setOpenPlanEditorOnProgress(true);
    setCurrentView('progress');
    return { session, filters };
  }

  async function handleUpdateSession(sessionId, updates) {
    const { session, filters } = await api.sessions.update(sessionId, { userId: activeUser.id, ...updates });
    setSessions(prev => prev.map(s => s.id === session.id ? session : s));
    setActiveSession(session);
    setSessionFilters(filters);
    return { session, filters };
  }

  async function handleDeleteSession() {
    if (!activeSession || !activeUser) return;
    const deletedId = activeSession.id;
    await api.sessions.delete(deletedId, activeUser.id);
    localStorage.removeItem(`activeSessionId:user:${activeUser.id}`);
    const remaining = sessions.filter(s => s.id !== deletedId);
    setSessions(remaining);
    const nextSession = remaining[0] || null;
    setActiveSession(nextSession);
    if (nextSession) {
      localStorage.setItem(`activeSessionId:user:${activeUser.id}`, String(nextSession.id));
      api.sessions.open(nextSession.id, activeUser.id).catch(() => {});
    }
    setCurrentView('progress');
  }

  // TODO: Restrict reopen by role once `role` is added to the users table.
  // Future policy: only mentors/admins can reopen a completed session; students cannot.
  // For now the users table has no role column, so all users can reopen their own sessions.
  // When roles exist: check `user.role === 'mentor' || user.role === 'admin'` here,
  // and enforce the same guard in PATCH /api/sessions/:id/reopen on the backend.
  function canReopenSession(user) {
    return true;
  }

  async function handleCompleteSession() {
    if (!activeSession || !activeUser) return;
    try {
      const updated = await api.sessions.complete(activeSession.id, activeUser.id);
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
      const updated = await api.sessions.reopen(activeSession.id, activeUser.id);
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
        return <DatabaseView selectedTable={selectedTable} />;
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

  return (
    <div className="app">
      <Sidebar
        currentView={currentView}
        onNavigate={handleNavigate}
        selectedTable={selectedTable}
        onSelectTable={handleSelectTable}
        users={users}
        activeUser={activeUser}
        onUserChange={handleUserChange}
        onCreateUser={handleCreateUser}
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
