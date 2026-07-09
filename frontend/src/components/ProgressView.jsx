import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { isSessionCompleted } from '../utils/sessionStatus';
import SessionSummaryCard from './progress/SessionSummaryCard';
import NoSessionState from './progress/NoSessionState';
import ArchivedSessionState from './progress/ArchivedSessionState';
import ProgressStatsRow from './progress/ProgressStatsRow';
import GroupBreakdownSection from './progress/GroupBreakdownSection';
import RecentAttemptsSection from './progress/RecentAttemptsSection';
import InProgressTasksSection from './progress/InProgressTasksSection';

export default function ProgressView({ activeUser, viewedUser, targetUserId, activeSession, sessionFilters, onOpenTask, onOpenCategory, onUpdateSession, onNavigate, progressVersion, autoOpenPlanEditor, onAutoOpenPlanEditorConsumed, onRequestCreateSession }) {
  // Review mode: a mentor/admin viewing another user's progress. Practice
  // is explicitly first-person-only (product decision, Step J) — every task/
  // attempt/category entry point into Practice is guarded below rather than
  // wiring targetUserId into Practice itself.
  const reviewMode = !!viewedUser;

  const [summary,        setSummary]        = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState(null);
  const [isPlanEditOpen, setIsPlanEditOpen] = useState(false);

  // Expanded rows inside the sections below. Kept here (not in the section
  // components) so they survive a summary refresh — the sections unmount
  // while the summary reloads, this component does not.
  const [expandedTopics,        setExpandedTopics]        = useState({});
  const [expandedAttemptGroups, setExpandedAttemptGroups] = useState({});

  const toggleTopic = (topicId) =>
    setExpandedTopics(prev => ({ ...prev, [topicId]: !prev[topicId] }));

  const toggleAttemptGroup = (groupKey) =>
    setExpandedAttemptGroups(prev => ({ ...prev, [groupKey]: !prev[groupKey] }));

  const [collapsedSections, setCollapsedSections] = useState(() => {
    try {
      const saved = localStorage.getItem('progressCollapsedSections');
      return saved ? JSON.parse(saved) : { byTopic: false, recentAttempts: false, inProgress: false };
    } catch {
      return { byTopic: false, recentAttempts: false, inProgress: false };
    }
  });

  useEffect(() => {
    localStorage.setItem('progressCollapsedSections', JSON.stringify(collapsedSections));
  }, [collapsedSections]);

  const toggleSection = (key) =>
    setCollapsedSections(prev => ({ ...prev, [key]: !prev[key] }));

  const load = useCallback(() => {
    // No session at all — skip the fetch entirely rather than relying on the
    // backend's "no session" fallback (a synthetic summary covering every
    // academic task). See NoSessionState for what renders instead.
    //
    // An archived session should never reach here under normal navigation —
    // the session list (and therefore activeSession) excludes archived
    // sessions by default — but this guards defensively against a stale
    // reference (e.g. archived in another tab/session while this one still
    // holds it as active) instead of firing a request the backend will 403 anyway.
    if (!activeSession || activeSession.archived_at) {
      setSummary(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    api.progress.summary(activeSession.id, targetUserId)
      .then(setSummary)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [activeSession, progressVersion, targetUserId]);

  useEffect(() => { load(); }, [load]);

  // Auto-open plan editor after session creation from the Sidebar.
  // Lives in ProgressView (not SessionSummaryCard) so it survives the loading phase —
  // SessionSummaryCard unmounts while the progress summary is fetching, so any state
  // or effect placed there is lost before it can show the form.
  useEffect(() => {
    if (!autoOpenPlanEditor) return;
    if (!activeSession) return;
    if (isSessionCompleted(activeSession)) {
      onAutoOpenPlanEditorConsumed?.();
      return;
    }
    setIsPlanEditOpen(true);
    onAutoOpenPlanEditorConsumed?.();
  }, [autoOpenPlanEditor, activeSession?.id, activeSession?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleUpdateSession(sessionId, updates) {
    await onUpdateSession(sessionId, updates);
    load();
  }

  // Opening a task/attempt from review mode is safe to allow: run/check
  // stay hard-scoped to the acting (professor/admin) user's own account and
  // session no matter what — TaskView never accepts reviewContext as a
  // write target, only as a read-only display context (see its handling of
  // `reviewContext`). What DOES travel along in review mode is display
  // context: the reviewed session's id/dataset/filters, so TaskView can
  // correctly show "is this task in the STUDENT's plan" and preview the
  // STUDENT's tables, instead of silently validating/previewing against the
  // acting user's own unrelated current session (the bug this fixes — see
  // the activeUser/viewedUser invariant in CLAUDE.md).
  function buildReviewContext() {
    if (!reviewMode) return null;
    return {
      sessionId: activeSession?.id ?? null,
      datasetKey: activeSession?.dataset_key ?? null,
      filters: sessionFilters,
      username: viewedUser?.username ?? null,
    };
  }

  function handleOpenTask(taskId, topicId) {
    if (!taskId || !topicId) {
      console.warn('openTaskFromProgress: missing taskId or topicId');
      return;
    }
    onOpenTask?.({ taskId, topicId, reviewContext: buildReviewContext() });
  }

  function handleOpenAttempt(group, attempt) {
    if (!group.taskId || !group.topicId) return;
    onOpenTask?.({ taskId: group.taskId, topicId: group.topicId, attemptSql: attempt.submittedSql || null, reviewContext: buildReviewContext() });
  }

  if (!activeSession) {
    return <NoSessionState activeUser={activeUser} viewedUser={viewedUser} onRequestCreateSession={onRequestCreateSession} />;
  }

  if (activeSession.archived_at) {
    return <ArchivedSessionState activeSession={activeSession} />;
  }

  if (loading) return <div className="loading">Loading progress</div>;

  if (error) {
    return (
      <div>
        <div className="page-header"><h2>Progress</h2></div>
        <div className="page-body">
          <div className="result-error" style={{ padding: 20 }}>Error: {error}</div>
        </div>
      </div>
    );
  }

  if (!summary) return null;

  const { totalTasks, solved, inProgress, planType, byGroup, recentAttempts, inProgressTasks } = summary;

  // Review-mode tooltip for every "open in Practice" entry point below; null
  // outside review mode so each section falls back to its own default label.
  const reviewOpenTitle = reviewMode
    ? `Open in Practice — actions remain your own, not ${viewedUser.username}'s`
    : null;

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 16 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Progress</h2>
            <p style={{ paddingBottom: 0 }}>
              {/* The global viewing banner (App.jsx) already names the viewed
                  user/role and confirms Practice stays first-person — this
                  subtitle just needs to stop saying "your" journey when it
                  isn't. No separate review badge needed here anymore. */}
              {reviewMode
                ? 'Review progress, sessions, and recent attempts for this user.'
                : 'Track your SQL learning journey.'}
            </p>
          </div>
          <button className="btn btn-secondary" onClick={load} style={{ fontSize: 12 }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="page-body">
        <SessionSummaryCard
          activeUser={activeUser}
          viewedUser={viewedUser}
          activeSession={activeSession}
          summary={summary}
          sessionFilters={sessionFilters}
          onUpdateSession={handleUpdateSession}
          isPlanEditOpen={isPlanEditOpen}
          setIsPlanEditOpen={setIsPlanEditOpen}
        />

        <ProgressStatsRow solved={solved} totalTasks={totalTasks} inProgress={inProgress} />

        <GroupBreakdownSection
          byGroup={byGroup}
          planType={planType}
          collapsed={collapsedSections.byTopic}
          onToggleCollapsed={() => toggleSection('byTopic')}
          expandedTopics={expandedTopics}
          onToggleTopic={toggleTopic}
          onOpenCategory={onOpenCategory}
          onOpenTask={handleOpenTask}
          reviewOpenTitle={reviewOpenTitle}
        />

        {recentAttempts.length === 0 ? (
          <div className="progress-empty-state">
            <h3 className="progress-empty-state-title">No activity yet — let's get started!</h3>
            <p className="progress-empty-state-text">
              {reviewMode
                ? `${viewedUser.username} hasn't checked any answers yet.`
                : 'Pick a task from Practice to begin tracking your progress.'}
            </p>
            {!reviewMode && (
              <button className="btn btn-primary" onClick={() => onNavigate?.('practice')}>
                Go to Practice
              </button>
            )}
          </div>
        ) : (
        <div className="progress-bottom-grid">
          <RecentAttemptsSection
            recentAttempts={recentAttempts}
            collapsed={collapsedSections.recentAttempts}
            onToggleCollapsed={() => toggleSection('recentAttempts')}
            expandedAttemptGroups={expandedAttemptGroups}
            onToggleAttemptGroup={toggleAttemptGroup}
            onOpenAttempt={handleOpenAttempt}
            reviewOpenTitle={reviewOpenTitle}
          />

          <InProgressTasksSection
            inProgressTasks={inProgressTasks}
            solved={solved}
            collapsed={collapsedSections.inProgress}
            onToggleCollapsed={() => toggleSection('inProgress')}
            onOpenTask={handleOpenTask}
            reviewOpenTitle={reviewOpenTitle}
          />
        </div>
        )}
      </div>
    </div>
  );
}
