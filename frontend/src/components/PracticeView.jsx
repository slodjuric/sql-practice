import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import TaskView from './TaskView';
import FormSelect from './FormSelect';
import { matchesSessionFilters } from '../utils/taskFilters';
import StatusBadge from './shared/StatusBadge';
import { DIFFICULTY_CLASS, DIFFICULTY_ORDER } from '../constants/difficulties';
import { STATUS_FILTERS, STATUS_ORDER } from '../constants/status';

const PRACTICE_STRUCTURE = [
  {
    id: 'by-topic',
    title: 'Learn by Topic',
    description: 'SQL concepts organized by topic.',
    icon: '📚',
    filterKey: 'topicId',
    items: [
      { id: 'select',              title: 'SELECT',                       icon: '📋' },
      { id: 'where',               title: 'WHERE',                        icon: '🔍' },
      { id: 'sorting',             title: 'Sorting',                      icon: '↕️' },
      { id: 'aggregate-functions', title: 'Aggregate Functions',          icon: '∑'  },
      { id: 'group-by-having',     title: 'GROUP BY / HAVING',            icon: '📊' },
      { id: 'join',                title: 'JOIN',                         icon: '🔗' },
      { id: 'set-operations',      title: 'Set Operations',               icon: '⊕'  },
      { id: 'subqueries',          title: 'Subqueries',                   icon: '🪆' },
      { id: 'case-when',           title: 'CASE WHEN',                    icon: '🔀' },
      { id: 'cte',                 title: 'CTE',                          icon: '🔄' },
      { id: 'window-functions',    title: 'Window Functions',             icon: '🪟' },
      { id: 'date-functions',      title: 'Date Functions',               icon: '📅' },
      { id: 'text-functions',      title: 'Text Functions',               icon: '🔤' },
      { id: 'data-analysis',       title: 'Data Analysis / Data Quality', icon: '🔬' },
    ],
  },
  {
    id: 'by-level',
    title: 'Learn by Level',
    description: 'Tasks organized by difficulty.',
    icon: '🎓',
    filterKey: 'levelId',
    items: [
      { id: 'introduction',  title: 'Introduction',  icon: '🌱' },
      { id: 'beginner',      title: 'Beginner',      icon: '⭐' },
      { id: 'intermediate',  title: 'Intermediate',  icon: '⭐⭐' },
      { id: 'advanced',      title: 'Advanced',      icon: '⭐⭐⭐' },
      { id: 'expert',        title: 'Expert',        icon: '🏆' },
    ],
  },
  {
    id: 'projects',
    title: 'Practice Projects',
    description: 'Real-world analysis projects.',
    icon: '🎯',
    filterKey: 'projectId',
    items: [
      { id: 'student-performance', title: 'Student Performance Analysis', icon: '👨‍🎓' },
      { id: 'faculty-analysis',    title: 'Faculty Analysis',             icon: '🏫' },
      { id: 'subject-difficulty',  title: 'Subject Difficulty Analysis',  icon: '📖' },
      { id: 'professor-workload',  title: 'Professor Workload Analysis',  icon: '👨‍🏫' },
      { id: 'exam-timeline',       title: 'Exam Timeline Analysis',       icon: '🗓️'  },
    ],
  },
];

const SORT_OPTIONS = [
  { value: 'active',     label: 'Plan status' },
  { value: 'title',      label: 'Title' },
  { value: 'status',     label: 'Status' },
  { value: 'difficulty', label: 'Difficulty' },
];

const LS_SORT_KEY  = 'practiceTaskSort';
const DEFAULT_SORT = { field: 'difficulty', direction: 'asc' };

function readSortFromStorage() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_SORT_KEY) ?? '{}');
    return {
      field:     SORT_OPTIONS.some(o => o.value === p.field)       ? p.field     : DEFAULT_SORT.field,
      direction: (p.direction === 'asc' || p.direction === 'desc') ? p.direction : DEFAULT_SORT.direction,
    };
  } catch {
    return DEFAULT_SORT;
  }
}

function writeSortToStorage(field, direction) {
  try { localStorage.setItem(LS_SORT_KEY, JSON.stringify({ field, direction })); } catch {}
}

export default function PracticeView({
  activeUser,
  activeSession,
  sessionFilters,
  onTaskEnter,
  onTaskExit,
  tableToOpenInTask,
  onTableOpened,
  practiceTarget,
  onPracticeTargetConsumed,
  practiceCategory,
  onPracticeCategoryConsumed,
  onProgressInvalidate,
  onBackToProgress,
}) {
  const [selectedGroup,     setSelectedGroup]     = useState(null);
  const [selectedItem,      setSelectedItem]      = useState(null);
  const [tasks,             setTasks]             = useState([]);
  const [tasksLoading,      setTasksLoading]      = useState(false);
  const [selectedTaskId,    setSelectedTaskId]    = useState(null);
  const [taskStatuses,      setTaskStatuses]      = useState({});
  const [statusFilter,      setStatusFilter]      = useState('all');
  const [sortBy,            setSortBy]            = useState(() => readSortFromStorage().field);
  const [sortDir,           setSortDir]           = useState(() => readSortFromStorage().direction);
  const [allTasks,          setAllTasks]          = useState([]);
  const [taskExecutionCache, setTaskExecutionCache] = useState({});
  const [initialAttemptSql,  setInitialAttemptSql]  = useState(null);
  const [taskOrigin,         setTaskOrigin]         = useState(null);

  // Load all tasks once so group views can compute which cards have plan tasks.
  useEffect(() => {
    api.tasks.list().then(setAllTasks).catch(() => {});
  }, []);

  // ── Status loading ─────────────────────────────────────────
  const loadStatuses = useCallback(async () => {
    try {
      const data = await api.progress.taskStatuses(activeUser?.id, activeSession?.id);
      setTaskStatuses(data.statuses || {});
    } catch {
      // statuses are optional — don't break the practice flow
    }
  }, [activeUser, activeSession]);

  // Reload statuses when entering a category list
  useEffect(() => {
    if (selectedItem) loadStatuses();
  }, [selectedItem, loadStatuses]);

  // ── Task loading (effect-driven so both manual and programmatic nav work) ──
  useEffect(() => {
    setStatusFilter('all'); // reset filter on every category change
    if (!selectedItem || !selectedGroup?.filterKey) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    setTasksLoading(true);
    api.tasks.list({ [selectedGroup.filterKey]: selectedItem.id })
      .then(data  => { if (!cancelled) setTasks(data.map((t, idx) => ({ ...t, _originalIdx: idx }))); })
      .catch(()   => { if (!cancelled) setTasks([]); })
      .finally(() => { if (!cancelled) setTasksLoading(false); });
    return () => { cancelled = true; };
  }, [selectedItem]); // intentionally reads selectedGroup from closure — they always update together

  // ── Navigate to a task from the Progress dashboard ─────────
  useEffect(() => {
    if (!practiceTarget) return;
    const { taskId, topicId, attemptSql, origin } = practiceTarget;
    onPracticeTargetConsumed?.(); // clear immediately so stale targets don't re-fire
    setTaskOrigin(origin ?? null);

    const group = PRACTICE_STRUCTURE.find(g => g.filterKey === 'topicId');
    const item  = group?.items.find(i => i.id === topicId);

    if (!group || !item) {
      console.warn(`openTaskFromProgress: topicId '${topicId}' not found in PRACTICE_STRUCTURE`);
      return;
    }

    setSelectedGroup(group);
    setSelectedItem(item);
    setSelectedTaskId(taskId);
    setInitialAttemptSql(attemptSql || null);
  }, [practiceTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigate to a category/project from the Progress dashboard ─
  useEffect(() => {
    if (!practiceCategory) return;
    const { groupId, planType } = practiceCategory;
    onPracticeCategoryConsumed?.();

    const filterKey = planType === 'project' ? 'projectId' : 'topicId';
    const group = PRACTICE_STRUCTURE.find(g => g.filterKey === filterKey);
    const item  = group?.items.find(i => i.id === groupId);

    if (!group || !item) {
      console.warn(`openCategoryFromProgress: groupId '${groupId}' (planType '${planType}') not found in PRACTICE_STRUCTURE`);
      return;
    }

    setSelectedGroup(group);
    setSelectedItem(item);
    setSelectedTaskId(null);
    onTaskExit?.();
  }, [practiceCategory]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigation helpers ──────────────────────────────────────
  function goHome() {
    setSelectedGroup(null);
    setSelectedItem(null);
    setTasks([]);
    setSelectedTaskId(null);
    onTaskExit?.();
  }

  function selectGroup(group) {
    setSelectedGroup(group);
    setSelectedItem(null);
    setTasks([]);
    setSelectedTaskId(null);
    onTaskExit?.();
  }

  function selectItem(item) {
    setSelectedItem(item);
    setSelectedTaskId(null);
    onTaskExit?.();
  }

  function goBackToGroup() {
    setSelectedItem(null);
    setTasks([]);
    setSelectedTaskId(null);
    onTaskExit?.();
  }

  function openTask(id) {
    setSelectedTaskId(id);
    setTaskOrigin(null);
    onTaskEnter?.();
  }

  function closeTask() {
    setSelectedTaskId(null);
    onTaskExit?.();
    loadStatuses(); // refresh statuses after returning from a task
  }

  function handleTaskStatusChange(taskId, newStatus) {
    setTaskStatuses(prev => {
      if (prev[taskId] === 'solved') return prev; // never downgrade
      return { ...prev, [taskId]: newStatus };
    });
  }

  // ── Task view ──────────────────────────────────────────────
  if (selectedTaskId) {
    return (
      <TaskView
        activeUser={activeUser}
        activeSession={activeSession}
        sessionFilters={sessionFilters}
        taskId={selectedTaskId}
        onBack={closeTask}
        category={selectedItem?.title}
        onBackToCategories={goHome}
        tableToOpenInTask={tableToOpenInTask}
        onTableOpened={onTableOpened}
        executionCache={taskExecutionCache[selectedTaskId] ?? null}
        onExecutionCacheUpdate={(id, entry) =>
          setTaskExecutionCache(prev => ({ ...prev, [id]: entry }))
        }
        taskStatus={taskStatuses[selectedTaskId] ?? 'not_started'}
        onStatusChange={handleTaskStatusChange}
        refreshTaskStatuses={loadStatuses}
        initialAttemptSql={initialAttemptSql}
        onInitialAttemptSqlConsumed={() => setInitialAttemptSql(null)}
        onProgressInvalidate={onProgressInvalidate}
        origin={taskOrigin}
        onBackToProgress={onBackToProgress}
      />
    );
  }

  // ── Leaf: task list with filter + sort controls ───────────
  if (selectedItem) {
    const filteredTasks = statusFilter === 'all'
      ? tasks
      : tasks.filter(t => (taskStatuses[t.id] ?? 'not_started') === statusFilter);

    const dir = sortDir === 'asc' ? 1 : -1;
    const displayTasks = [...filteredTasks].sort((a, b) => {
      switch (sortBy) {
        case 'number':    return ((a._originalIdx ?? 0) - (b._originalIdx ?? 0)) * dir;
        case 'title':     return a.title.localeCompare(b.title) * dir;
        case 'status': {
          const sa = STATUS_ORDER[taskStatuses[a.id] ?? 'not_started'] ?? 0;
          const sb = STATUS_ORDER[taskStatuses[b.id] ?? 'not_started'] ?? 0;
          return (sa - sb) * dir;
        }
        case 'difficulty': {
          const da = DIFFICULTY_ORDER[a.difficulty] ?? 0;
          const db = DIFFICULTY_ORDER[b.difficulty] ?? 0;
          return (da - db) * dir;
        }
        case 'active': {
          const aa = matchesSessionFilters(a, sessionFilters) ? 1 : 0;
          const ab = matchesSessionFilters(b, sessionFilters) ? 1 : 0;
          return (aa - ab) * dir;
        }
        default:          return 0;
      }
    });

    return (
      <div>
        <div className="page-header">
          <nav className="breadcrumb" style={{ marginBottom: 6 }}>
            <span className="breadcrumb-item" onClick={goHome}>Practice</span>
            <span className="breadcrumb-sep">/</span>
            <span className="breadcrumb-item" onClick={goBackToGroup}>{selectedGroup.title}</span>
            <span className="breadcrumb-sep">/</span>
            <span style={{ color: 'var(--text-primary)' }}>{selectedItem.title}</span>
          </nav>
          <h2 style={{ paddingBottom: 16 }}>{selectedItem.title}</h2>
        </div>
        <div className="page-body">
          {tasksLoading ? (
            <div className="loading">Loading</div>
          ) : tasks.length === 0 ? (
            <div className="practice-placeholder">
              Tasks for <strong>{selectedItem.title}</strong> will be added in the next step.
            </div>
          ) : (
            <>
              <div className="task-controls-row">
                <div className="task-status-filters">
                  {STATUS_FILTERS.map(f => (
                    <button
                      key={f.key}
                      className={`task-status-filter filter-${f.key.replace(/_/g, '-')}${statusFilter === f.key ? ' active' : ''}`}
                      onClick={() => setStatusFilter(f.key)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="task-sort-bar">
                  <span className="task-sort-label">Sort:</span>
                  <div style={{ width: 150 }}>
                    <FormSelect
                      value={sortBy}
                      options={SORT_OPTIONS}
                      onChange={field => {
                        setSortBy(field);
                        writeSortToStorage(field, sortDir);
                      }}
                    />
                  </div>
                  <button
                    className="task-sort-dir"
                    title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
                    onClick={() => setSortDir(prev => {
                      const next = prev === 'asc' ? 'desc' : 'asc';
                      writeSortToStorage(sortBy, next);
                      return next;
                    })}
                  >
                    {sortDir === 'asc' ? '↑' : '↓'}
                  </button>
                </div>
              </div>

              {displayTasks.length === 0 ? (
                <div className="practice-placeholder">
                  No tasks found for this filter.
                </div>
              ) : (
                <div className="task-list">
                  {displayTasks.map((task, i) => {
                    const status = taskStatuses[task.id] ?? 'not_started';
                    const inPlan = matchesSessionFilters(task, sessionFilters);
                    return (
                      <div
                        key={task.id}
                        className={`task-item${inPlan ? '' : ' task-item--out-of-plan'}`}
                        onClick={() => openTask(task.id)}
                      >
                        <div className="task-item-left">
                          <span className="task-num">#{i + 1}</span>
                          <span className={`task-active-badge task-active-badge--${inPlan ? 'in-plan' : 'out-of-plan'}`}>
                            {inPlan ? 'in plan' : 'out of plan'}
                          </span>
                          <div>
                            <div className="task-title">{task.title}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                              {task.description}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                          <StatusBadge status={status} />
                          {task.difficulty && (
                            <span className={`card-badge ${DIFFICULTY_CLASS[task.difficulty] || ''}`}>
                              {task.difficulty}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Group: show its items ──────────────────────────────────
  if (selectedGroup) {
    const visibleItems = allTasks.length > 0
      ? selectedGroup.items.filter(item =>
          allTasks.some(t =>
            t[selectedGroup.filterKey] === item.id &&
            matchesSessionFilters(t, sessionFilters)
          )
        )
      : selectedGroup.items;

    const itemCounts = allTasks.length > 0
      ? Object.fromEntries(visibleItems.map(item => [
          item.id,
          allTasks.filter(t =>
            t[selectedGroup.filterKey] === item.id &&
            matchesSessionFilters(t, sessionFilters)
          ).length,
        ]))
      : {};

    return (
      <div>
        <div className="page-header">
          <nav className="breadcrumb" style={{ marginBottom: 6 }}>
            <span className="breadcrumb-item" onClick={goHome}>Practice</span>
            <span className="breadcrumb-sep">/</span>
            <span style={{ color: 'var(--text-primary)' }}>{selectedGroup.title}</span>
          </nav>
          <h2 style={{ paddingBottom: 16 }}>{selectedGroup.title}</h2>
        </div>
        <div className="page-body">
          {visibleItems.length === 0 ? (
            <div className="practice-placeholder">
              No tasks found for this section yet.
            </div>
          ) : (
            <div className="card-grid">
              {visibleItems.map(item => {
                const count = itemCounts[item.id] ?? 0;
                return (
                  <div key={item.id} className="card" onClick={() => selectItem(item)}>
                    <div style={{ fontSize: 24, marginBottom: 8 }}>{item.icon}</div>
                    <div className="card-title">{item.title}</div>
                    <div className="card-subtitle">{count} {count === 1 ? 'task' : 'tasks'}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Top level: group cards ─────────────────────────────────
  return (
    <div>
      <div className="page-header">
        <h2>Practice</h2>
        <p>Izaberi način vežbanja SQL-a.</p>
      </div>
      <div className="page-body">
        <div className="card-grid">
          {PRACTICE_STRUCTURE.map(group => (
            <div key={group.id} className="card" onClick={() => selectGroup(group)}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>{group.icon}</div>
              <div className="card-title">{group.title}</div>
              <div className="card-subtitle">{group.description}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
