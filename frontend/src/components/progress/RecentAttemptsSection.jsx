// Date + time, unlike utils/formatDate's short date-only variant — attempt
// timestamps need the time of day to distinguish same-day checks.
function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// "Answer Checks" — recent check attempts grouped per task, expandable to the
// individual attempts. Which groups are expanded stays ProgressView state so
// it survives a summary refresh (this section unmounts while the summary
// reloads); the grouping itself is derived here. `reviewOpenTitle` is the
// review-mode tooltip override (null outside review mode).
export default function RecentAttemptsSection({ recentAttempts, collapsed, onToggleCollapsed, expandedAttemptGroups, onToggleAttemptGroup, onOpenAttempt, reviewOpenTitle }) {
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
    <div className="progress-section">
      <div
        className="progress-section-title progress-section-title--collapsible"
        onClick={onToggleCollapsed}
      >
        <span className="collapse-icon">{collapsed ? '▸' : '▾'}</span>
        Answer Checks
      </div>
      {!collapsed && (recentAttempts.length === 0 ? (
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
                  onClick={() => onToggleAttemptGroup(group.groupKey)}
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
                          onClick={canOpen ? (e) => { e.stopPropagation(); onOpenAttempt(group, attempt); } : undefined}
                          title={canOpen ? (reviewOpenTitle ?? 'Open this attempt') : undefined}
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
  );
}
