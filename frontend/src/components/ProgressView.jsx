import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import FormSelect from './FormSelect';
import CheckboxGroup from './CheckboxGroup';
import StatusBadge from './shared/StatusBadge';
import { PLAN_TOPICS, TOPIC_LABELS } from '../constants/topics';
import { PLAN_DIFFICULTIES, PLAN_DIFFICULTY_OPTIONS, DIFFICULTY_CLASS } from '../constants/difficulties';
import { PLAN_PROJECTS, PROJECT_LABELS } from '../constants/projects';
import { roleLabel } from '../utils/roleLabels';
import { formatDateShort } from '../utils/formatDate';
import { isSessionCompleted } from '../utils/sessionStatus';

function ProgressBar({ value, max, color = 'var(--accent)' }) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div className="progress-bar-track">
        <div className="progress-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="progress-bar-pct">{pct}%</span>
    </div>
  );
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

const PLAN_TYPE_OPTIONS = [
  { value: 'topic',    label: 'Learn by Topic' },
  { value: 'category', label: 'Learn by Category' },
  { value: 'project',  label: 'Practice Projects' },
];

// ── Edit Plan Form ─────────────────────────────────────────────────────────
function EditPlanForm({ activeSession, sessionFilters, onSave, onCancel }) {
  const [name,                 setName]                 = useState(activeSession.name);
  const [description,          setDescription]          = useState(activeSession.description || '');
  const [planType,             setPlanType]             = useState(activeSession.plan_type || 'topic');
  const [selectedTopics,       setSelectedTopics]       = useState(sessionFilters?.topics       ?? []);
  const [selectedDifficulties, setSelectedDifficulties] = useState(sessionFilters?.difficulties ?? []);
  const [selectedProjects,     setSelectedProjects]     = useState(sessionFilters?.projects     ?? []);
  const [selectedCategories,   setSelectedCategories]   = useState(sessionFilters?.categories   ?? []);
  const [availableCategories,  setAvailableCategories]  = useState([]);
  const [saving,               setSaving]               = useState(false);
  const [error,                setError]                = useState(null);

  useEffect(() => {
    api.tasks.categories().then(setAvailableCategories).catch(() => {});
  }, []);

  function handlePlanTypeChange(newType) {
    setPlanType(newType);
    if (newType === 'topic')    { setSelectedProjects([]); setSelectedCategories([]); }
    if (newType === 'category') { setSelectedTopics([]);   setSelectedProjects([]); }
    if (newType === 'project')  { setSelectedTopics([]);   setSelectedCategories([]); }
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!name.trim()) { setError('Plan name is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name:         name.trim(),
        description:  description.trim() || null,
        planType,
        topics:       selectedTopics,
        difficulties: selectedDifficulties,
        projects:     selectedProjects,
        categories:   selectedCategories,
      });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="create-plan-form" onSubmit={handleSave}>
      <div className="create-plan-field">
        <label className="create-plan-label">Plan name <span className="create-plan-required">*</span></label>
        <input
          className="create-plan-input"
          type="text"
          value={name}
          onChange={e => { setName(e.target.value); setError(null); }}
          autoFocus
        />
      </div>

      <div className="create-plan-field">
        <label className="create-plan-label">
          Description <span className="create-plan-optional">(optional)</span>
        </label>
        <textarea
          className="create-plan-textarea"
          placeholder="What is this plan about?"
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={3}
        />
      </div>

      <div className="create-plan-field">
        <label className="create-plan-label">Plan type</label>
        <FormSelect
          value={planType}
          onChange={handlePlanTypeChange}
          options={PLAN_TYPE_OPTIONS}
        />
      </div>

      {planType === 'topic' && (
        <div className="create-plan-field">
          <label className="create-plan-label">
            Learn by Topic <span className="create-plan-optional">(optional)</span>
          </label>
          <CheckboxGroup
            options={PLAN_TOPICS}
            selected={selectedTopics}
            onChange={setSelectedTopics}
          />
        </div>
      )}

      {planType === 'category' && (
        <div className="create-plan-field">
          <label className="create-plan-label">
            Learn by Category <span className="create-plan-optional">(optional)</span>
          </label>
          <CheckboxGroup
            options={availableCategories.map(c => ({ id: c, label: c }))}
            selected={selectedCategories}
            onChange={setSelectedCategories}
          />
        </div>
      )}

      {planType === 'project' && (
        <div className="create-plan-field">
          <label className="create-plan-label">
            Practice Projects <span className="create-plan-optional">(optional)</span>
          </label>
          <CheckboxGroup
            options={PLAN_PROJECTS}
            selected={selectedProjects}
            onChange={setSelectedProjects}
          />
        </div>
      )}

      <div className="create-plan-field">
        <label className="create-plan-label">
          Learn by Level <span className="create-plan-optional">(optional)</span>
        </label>
        <CheckboxGroup
          options={PLAN_DIFFICULTY_OPTIONS}
          selected={selectedDifficulties}
          onChange={setSelectedDifficulties}
          layout="row"
          showSelectAll={false}
        />
      </div>

      {error && <div className="create-plan-error">{error}</div>}

      <div className="create-plan-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={saving || !name.trim()}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Session Summary Card ───────────────────────────────────────────────────
// ProgressView only ever renders this once a real activeSession exists (see
// NoSessionState below for the !activeSession case) — no empty-state branch
// needed here anymore.
function SessionSummaryCard({ activeUser, viewedUser, activeSession, summary, sessionFilters, onUpdateSession, isPlanEditOpen, setIsPlanEditOpen }) {
  const [open, setOpen] = useState(true);

  const solved         = summary?.solved         ?? 0;
  const totalTasks     = summary?.totalTasks     ?? 0;
  const attemptsCount  = summary?.attemptsCount  ?? 0;
  const recentAttempts = summary?.recentAttempts ?? [];
  const pct            = totalTasks === 0 ? 0 : Math.round((solved / totalTasks) * 100);
  const lastActivity   = recentAttempts[0]?.createdAt;
  const isCompleted    = isSessionCompleted(activeSession);

  const isOpen = open || isPlanEditOpen;

  function handleHeaderClick() {
    if (isPlanEditOpen) return; // don't collapse while editing
    setOpen(o => !o);
  }

  return (
    <div className="session-summary-card">
      <div className="session-summary-header" onClick={handleHeaderClick}>
        <div className="session-summary-header-left">
          <span className="session-summary-section-label">Current Session</span>
          {!isOpen && (
            <>
              <span className="session-summary-header-name">{activeSession.name}</span>
              <span className={`session-status-badge session-status-badge--${isCompleted ? 'completed' : 'active'}`}>
                {isCompleted ? 'completed' : 'active'}
              </span>
            </>
          )}
        </div>
        <span className="session-summary-chevron">{isOpen ? '▾' : '▸'}</span>
      </div>

      {isOpen && (
        <div className="session-summary-body">
          {isPlanEditOpen ? (
            <EditPlanForm
              activeSession={activeSession}
              sessionFilters={sessionFilters}
              onSave={async (updates) => {
                await onUpdateSession(activeSession.id, updates);
                setIsPlanEditOpen(false);
              }}
              onCancel={() => setIsPlanEditOpen(false)}
            />
          ) : (
            <>
              <div className="session-summary-title-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="session-summary-title">{activeSession.name}</span>
                  {activeUser.role !== 'student' && (
                    <button
                      className="btn-plan-edit"
                      onClick={e => { e.stopPropagation(); setIsPlanEditOpen(true); }}
                      disabled={isCompleted}
                      title={isCompleted ? 'Reopen this session to edit the plan.' : 'Edit plan'}
                    >
                      Edit
                    </button>
                  )}
                </div>
                <span className={`session-status-badge session-status-badge--${isCompleted ? 'completed' : 'active'}`}>
                  {isCompleted ? 'completed' : 'active'}
                </span>
              </div>

              {isCompleted && (
                <div className="session-completed-notice">
                  This session is completed. Reopen it from the sidebar to continue working.
                </div>
              )}

              <div className="session-summary-grid">
                <div className="session-summary-item">
                  <span className="session-summary-label">User</span>
                  <span className="session-summary-value">
                    {/* Backend now returns authoritative owner_username/owner_role
                        (Task 4) — fall back to viewedUser/activeUser only if an
                        older cached session object doesn't have them yet, so
                        this never crashes mid-rollout. */}
                    {activeSession.owner_username
                      ? `${activeSession.owner_username} (${roleLabel(activeSession.owner_role)})`
                      : (viewedUser || activeUser).username}
                  </span>
                </div>
                <div className="session-summary-item">
                  <span className="session-summary-label">Created by</span>
                  <span className="session-summary-value">
                    {activeSession.created_by_username || '—'}
                  </span>
                </div>
                {activeSession.dataset_name && (
                  <div className="session-summary-item">
                    <span className="session-summary-label">Dataset</span>
                    <span className="session-summary-value">{activeSession.dataset_name}</span>
                  </div>
                )}
                {activeSession.description && (
                  <div className="session-summary-item">
                    <span className="session-summary-label">Description</span>
                    <span className="session-summary-value">{activeSession.description}</span>
                  </div>
                )}
                <div className="session-summary-item">
                  <span className="session-summary-label">Created</span>
                  <span className="session-summary-value">{formatDateShort(activeSession.created_at)}</span>
                </div>
                {isCompleted && (
                  <div className="session-summary-item">
                    <span className="session-summary-label">Completed on</span>
                    <span className="session-summary-value">{formatDateShort(activeSession.completed_at)}</span>
                  </div>
                )}
                {isCompleted && (
                  <div className="session-summary-item">
                    <span className="session-summary-label">Solved</span>
                    <span className="session-summary-value">
                      {totalTasks === 0 ? '—' : `${solved} / ${totalTasks}`}
                    </span>
                  </div>
                )}
                {isCompleted && (
                  <div className="session-summary-item">
                    <span className="session-summary-label">Success rate</span>
                    <span className="session-summary-value">
                      {totalTasks === 0 ? '—' : `${pct}%`}
                    </span>
                  </div>
                )}
                {isCompleted && (
                  <div className="session-summary-item">
                    <span className="session-summary-label">Attempts</span>
                    <span className="session-summary-value">{attemptsCount}</span>
                  </div>
                )}
                <div className="session-summary-item">
                  <span className="session-summary-label">Last activity</span>
                  <span className="session-summary-value">
                    {lastActivity
                      ? formatDateShort(lastActivity)
                      : <span className="session-summary-muted">No activity yet</span>}
                  </span>
                </div>
                <div className="session-summary-item">
                  <span className="session-summary-label">Plan scope</span>
                  <span className="session-summary-value">
                    {(() => {
                      const topics      = sessionFilters?.topics       ?? [];
                      const diffs       = sessionFilters?.difficulties ?? [];
                      const projects    = sessionFilters?.projects     ?? [];
                      const categories  = sessionFilters?.categories   ?? [];
                      if (topics.length === 0 && diffs.length === 0 && projects.length === 0 && categories.length === 0) return 'All tasks';
                      return (
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {topics.length > 0 && (
                            <span>Topics: {topics.map(t => TOPIC_LABELS[t] || t).join(', ')}</span>
                          )}
                          {categories.length > 0 && (
                            <span>Categories: {categories.join(', ')}</span>
                          )}
                          {diffs.length > 0 && (
                            <span>Levels: {diffs.join(', ')}</span>
                          )}
                          {projects.length > 0 && (
                            <span>Projects: {projects.map(p => PROJECT_LABELS[p] || p).join(', ')}</span>
                          )}
                        </span>
                      );
                    })()}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── No-session empty state ──────────────────────────────────────────────────
// Shown instead of the full dashboard whenever there is no activeSession at
// all — previously the backend's "no session" fallback (a synthetic summary
// covering every academic task, all unsolved) rendered as if a real 221-task
// plan existed. Wording varies by context; only mentor/admin ever get a
// create-session action (students can never create their own session).
function NoSessionState({ activeUser, viewedUser, onRequestCreateSession }) {
  let title;
  let description;
  let buttonLabel = null;

  if (viewedUser) {
    title = `No sessions for ${viewedUser.username} yet.`;
    description = "Create a session to assign tasks and start tracking this student's progress.";
    buttonLabel = `Create session for ${viewedUser.username}`;
  } else if (activeUser.role === 'student') {
    title = 'No session has been assigned to you yet.';
    description = 'Ask your professor or an admin to create one for you.';
  } else {
    title = 'No session yet.';
    description = 'Create a session to start practicing.';
    buttonLabel = 'Create a session';
  }

  return (
    <div>
      <div className="page-header"><h2>Progress</h2></div>
      <div className="page-body">
        <div className="progress-empty-state">
          <h3 className="progress-empty-state-title">{title}</h3>
          <p className="progress-empty-state-text">{description}</p>
          {buttonLabel && (
            <button className="btn btn-primary" onClick={() => onRequestCreateSession?.()}>
              {buttonLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Archived-session guard state ────────────────────────────────────────────
// Defense-in-depth only (see the comment in `load` above) — under normal
// navigation an archived session can never become activeSession, since the
// session list excludes archived sessions by default and restoring one
// deliberately does not auto-select it. If it somehow happens anyway (a
// stale reference from another tab, for example), this replaces the
// dashboard with a clear, specific message instead of firing a request the
// backend would just 403.
function ArchivedSessionState({ activeSession }) {
  return (
    <div>
      <div className="page-header"><h2>Progress</h2></div>
      <div className="page-body">
        <div className="progress-empty-state">
          <h3 className="progress-empty-state-title">"{activeSession.name}" is archived.</h3>
          <p className="progress-empty-state-text">
            Restore it from "Show archived sessions" in the sidebar, or select a different session.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Progress View ──────────────────────────────────────────────────────────
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
  const [expandedTopics,       setExpandedTopics]       = useState({});
  const [expandedAttemptGroups, setExpandedAttemptGroups] = useState({});

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

  const toggleTopic = (topicId) =>
    setExpandedTopics(prev => ({ ...prev, [topicId]: !prev[topicId] }));

  const load = useCallback(() => {
    // No session at all — skip the fetch entirely rather than relying on the
    // backend's "no session" fallback (a synthetic summary covering every
    // academic task). See NoSessionState below for what renders instead.
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
  const notStarted = totalTasks - solved - inProgress;
  const pct        = totalTasks === 0 ? 0 : Math.round((solved / totalTasks) * 100);

  // Group recent attempts by taskId, sorted by most recent attempt first
  const recentAttemptGroups = (() => {
    const grouped = {};
    for (const attempt of recentAttempts) {
      const key = attempt.taskId ?? attempt.taskTitle;
      if (!grouped[key]) {
        grouped[key] = {
          groupKey: key,
          taskId:    attempt.taskId,
          taskTitle: attempt.taskTitle,
          category:  attempt.category,
          topicId:   attempt.topicId,
          attempts:  [],
        };
      }
      grouped[key].attempts.push(attempt);
    }
    // attempts arrive DESC from backend, so attempts[0] is already the most recent per group
    return Object.values(grouped).sort((a, b) =>
      new Date(b.attempts[0]?.createdAt) - new Date(a.attempts[0]?.createdAt)
    );
  })();

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

        {/* Overall stats */}
        <div className="progress-stats-row">
          <div className="progress-stat-card progress-stat-card--main">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
              <span className="progress-stat-value" style={{ color: 'var(--green)' }}>{solved}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 16 }}>/ {totalTasks} Solved, {pct}%</span>
            </div>
            <div className="progress-stat-label" style={{ marginBottom: 12 }}>Progress</div>
            <ProgressBar value={solved} max={totalTasks} color="var(--green)" />
          </div>

          <div className="progress-stat-card">
            <div className="progress-stat-value" style={{ color: 'var(--yellow)' }}>{inProgress}</div>
            <div className="progress-stat-label">In Progress</div>
          </div>
          <div className="progress-stat-card">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span className="progress-stat-value" style={{ color: 'var(--text-muted)' }}>{notStarted}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 16 }}>/ {totalTasks}</span>
            </div>
            <div className="progress-stat-label">Not Started</div>
          </div>
        </div>

        {/* Group breakdown (by topic / category / project depending on plan_type) */}
        <div className="progress-section">
          <div
            className="progress-section-title progress-section-title--collapsible"
            onClick={() => toggleSection('byTopic')}
          >
            <span className="collapse-icon">{collapsedSections.byTopic ? '▸' : '▾'}</span>
            {planType === 'category' ? 'By Category' : planType === 'project' ? 'By Project' : 'By Topic'}
          </div>
          {!collapsedSections.byTopic && <div className="progress-category-list">
            {(byGroup ?? []).map(g => {
              const label    = g.groupLabel ?? TOPIC_LABELS[g.groupId] ?? g.groupId;
              const expanded = !!expandedTopics[g.groupId];
              const canNav   = !!(g.canNavigate && onOpenCategory);
              return (
                <div key={g.groupId}>
                  <div
                    className="progress-category-row progress-category-row--clickable"
                    onClick={() => toggleTopic(g.groupId)}
                  >
                    <span style={{ width: 14, flexShrink: 0, fontSize: 11, color: 'var(--text-muted)' }}>
                      {expanded ? '▾' : '▸'}
                    </span>
                    <div className="progress-category-name">{label}</div>
                    <div className="progress-category-bar">
                      <ProgressBar value={g.solved} max={g.total} color="var(--accent)" />
                    </div>
                    <div className="progress-category-count">{g.solved} / {g.total}</div>
                    {canNav && (
                      <span
                        className="progress-category-arrow"
                        title={`Open ${label} in Practice`}
                        onClick={e => { e.stopPropagation(); onOpenCategory(g.groupId, planType); }}
                      >›</span>
                    )}
                  </div>

                  {expanded && (
                    <div className="progress-topic-tasks">
                      {(g.tasks || []).map(task => (
                        <div
                          key={task.id}
                          className="progress-topic-task-row progress-list-row--clickable"
                          onClick={() => handleOpenTask(task.id, task.topicId)}
                          title={reviewMode ? `Open in Practice — actions remain your own, not ${viewedUser.username}'s` : 'Open task'}
                        >
                          <div className="progress-list-info">
                            <div className="progress-list-title">{task.title}</div>
                            <div className="progress-list-meta">
                              {task.levelId} · {task.difficulty}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                            <StatusBadge status={task.status} />
                            {task.difficulty && (
                              <span className={`card-badge ${DIFFICULTY_CLASS[task.difficulty] || ''}`}>
                                {task.difficulty}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>}
        </div>

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
          {/* Answer Checks */}
          <div className="progress-section">
            <div
              className="progress-section-title progress-section-title--collapsible"
              onClick={() => toggleSection('recentAttempts')}
            >
              <span className="collapse-icon">{collapsedSections.recentAttempts ? '▸' : '▾'}</span>
              Answer Checks
            </div>
            {!collapsedSections.recentAttempts && (recentAttempts.length === 0 ? (
              <div className="progress-empty">No answer checks yet. Click "Check Answer" on a task to get started.</div>
            ) : (
              <div className="progress-list progress-list--scrollable">
                {recentAttemptGroups.map(group => {
                  const lastAttempt = group.attempts[0];
                  const isExpanded  = !!expandedAttemptGroups[group.groupKey];
                  const count       = group.attempts.length;
                  const lastStatus  = lastAttempt.isCorrect === true  ? 'correct'
                                    : lastAttempt.isCorrect === false ? 'wrong' : 'run';
                  return (
                    <div key={group.groupKey} className="recent-attempt-group">
                      <div
                        className="recent-attempt-group-header"
                        onClick={() => toggleAttemptGroup(group.groupKey)}
                      >
                        <span className="collapse-icon recent-attempt-chevron">
                          {isExpanded ? '▾' : '▸'}
                        </span>
                        <div className="recent-attempt-group-main">
                          <div className="recent-attempt-group-title">{group.taskTitle}</div>
                          <div className="recent-attempt-group-meta">
                            {group.category} · {count} check{count !== 1 ? 's' : ''} · Last: {lastStatus} · {formatDate(lastAttempt.createdAt)}
                          </div>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="recent-attempt-group-details">
                          {group.attempts.map((attempt, idx) => {
                            const status = attempt.isCorrect === true  ? 'correct'
                                         : attempt.isCorrect === false ? 'wrong' : 'run';
                            const canOpen = !!(group.taskId && group.topicId && attempt.submittedSql);
                            return (
                              <div
                                key={idx}
                                className={`recent-attempt-detail-row${canOpen ? ' recent-attempt-detail-row--clickable' : ''}`}
                                onClick={canOpen ? (e) => { e.stopPropagation(); handleOpenAttempt(group, attempt); } : undefined}
                                title={canOpen ? (reviewMode ? `Open in Practice — actions remain your own, not ${viewedUser.username}'s` : 'Open this attempt') : undefined}
                              >
                                <span className={`progress-badge ${
                                  status === 'correct' ? 'progress-badge--correct'   :
                                  status === 'wrong'   ? 'progress-badge--incorrect' :
                                  'progress-badge--run'
                                }`}>
                                  {status === 'correct' ? '✓ correct' : status === 'wrong' ? '✗ wrong' : 'run'}
                                </span>
                                <span className="recent-attempt-detail-time">{formatDate(attempt.createdAt)}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* In-progress tasks */}
          <div className="progress-section">
            <div
              className="progress-section-title progress-section-title--collapsible"
              onClick={() => toggleSection('inProgress')}
            >
              <span className="collapse-icon">{collapsedSections.inProgress ? '▸' : '▾'}</span>
              In Progress
            </div>
            {!collapsedSections.inProgress && (inProgressTasks.length === 0 ? (
              <div className="progress-empty">
                {solved > 0 ? 'All started tasks are solved!' : 'No tasks in progress yet.'}
              </div>
            ) : (
              <div className="progress-list progress-list--scrollable">
                {inProgressTasks.map(t => {
                  const clickable = !!(t.taskId && t.topicId);
                  return (
                    <div
                      key={t.taskId}
                      className={`progress-list-row${clickable ? ' progress-list-row--clickable' : ''}`}
                      onClick={() => clickable && handleOpenTask(t.taskId, t.topicId)}
                      title={clickable ? (reviewMode ? `Open in Practice — actions remain your own, not ${viewedUser.username}'s` : 'Open task') : undefined}
                    >
                      <div className="progress-list-info">
                        <div className="progress-list-title">{t.taskTitle}</div>
                        <div className="progress-list-meta">{t.category}</div>
                      </div>
                      {t.difficulty && (
                        <span className={`card-badge badge-${t.difficulty}`} style={{ marginTop: 0, fontSize: 10 }}>
                          {t.difficulty}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
