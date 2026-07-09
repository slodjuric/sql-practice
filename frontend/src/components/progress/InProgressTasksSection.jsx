// "In Progress" — tasks started but not yet solved. `reviewOpenTitle` is the
// review-mode tooltip override (null outside review mode).
export default function InProgressTasksSection({ inProgressTasks, solved, collapsed, onToggleCollapsed, onOpenTask, reviewOpenTitle }) {
  return (
    <div className="progress-section">
      <div
        className="progress-section-title progress-section-title--collapsible"
        onClick={onToggleCollapsed}
      >
        <span className="collapse-icon">{collapsed ? '▸' : '▾'}</span>
        In Progress
      </div>
      {!collapsed && (inProgressTasks.length === 0 ? (
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
                onClick={() => clickable && onOpenTask(t.taskId, t.topicId)}
                title={clickable ? (reviewOpenTitle ?? 'Open task') : undefined}
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
  );
}
