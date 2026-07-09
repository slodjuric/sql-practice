import { useState } from 'react';
import { roleLabel } from '../../utils/roleLabels';
import { formatDateShort } from '../../utils/formatDate';
import { isSessionCompleted } from '../../utils/sessionStatus';
import { TOPIC_LABELS } from '../../constants/topics';
import { PROJECT_LABELS } from '../../constants/projects';
import EditPlanForm from './EditPlanForm';

// ProgressView only ever renders this once a real activeSession exists (see
// NoSessionState for the !activeSession case) — no empty-state branch
// needed here.
export default function SessionSummaryCard({ activeUser, viewedUser, activeSession, summary, sessionFilters, onUpdateSession, isPlanEditOpen, setIsPlanEditOpen }) {
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
