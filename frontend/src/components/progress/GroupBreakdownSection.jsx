import StatusBadge from '../shared/StatusBadge';
import { TOPIC_LABELS } from '../../constants/topics';
import { DIFFICULTY_CLASS } from '../../constants/difficulties';
import ProgressBar from './ProgressBar';

// Per-group breakdown (by topic / category / project depending on plan_type),
// with expandable per-task rows. Which groups are expanded stays ProgressView
// state (like the collapsed/expanded section state) so it survives a summary
// refresh — this section unmounts while the summary reloads.
// `reviewOpenTitle` is the review-mode tooltip override (null outside review
// mode) — see ProgressView, which builds it from viewedUser.
export default function GroupBreakdownSection({ byGroup, planType, collapsed, onToggleCollapsed, expandedTopics, onToggleTopic, onOpenCategory, onOpenTask, reviewOpenTitle }) {
  return (
    <div className="progress-section">
      <div
        className="progress-section-title progress-section-title--collapsible"
        onClick={onToggleCollapsed}
      >
        <span className="collapse-icon">{collapsed ? '▸' : '▾'}</span>
        {planType === 'category' ? 'By Category' : planType === 'project' ? 'By Project' : 'By Topic'}
      </div>
      {!collapsed && <div className="progress-category-list">
        {(byGroup ?? []).map(g => {
          const label    = g.groupLabel ?? TOPIC_LABELS[g.groupId] ?? g.groupId;
          const expanded = !!expandedTopics[g.groupId];
          const canNav   = !!(g.canNavigate && onOpenCategory);
          return (
            <div key={g.groupId}>
              <div
                className="progress-category-row progress-category-row--clickable"
                onClick={() => onToggleTopic(g.groupId)}
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
                      onClick={() => onOpenTask(task.id, task.topicId)}
                      title={reviewOpenTitle ?? 'Open task'}
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
  );
}
