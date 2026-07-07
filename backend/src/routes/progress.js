const express = require('express');
const router = express.Router();
const pool = require('../db');
const { tasks, taskMap } = require('../data/taskRegistry');
const { resolveSessionId } = require('../utils/contextResolvers');
const { matchesSessionFilters, getSessionFilters } = require('../utils/taskFilters');
const { getDatasetBySessionId } = require('../utils/datasetResolver');
const { getActingUser, resolveAuthorizedOwnerId } = require('../utils/authz');

// Resolves the targetUserId query param against actingUser, following the
// same rule used by GET /api/sessions: omitted => self, present => must pass
// canAccessStudent. Thin wrapper over the shared helper so both call sites
// below keep this route's existing "...progress." wording.
function resolveOwnerId(actingUser, targetUserId) {
  return resolveAuthorizedOwnerId(actingUser, targetUserId, {
    forbiddenMessage: 'You do not have permission to view this user\'s progress.',
  });
}

const PROJECT_LABELS = {
  'student-performance': 'Student Performance Analysis',
  'faculty-analysis':    'Faculty Analysis',
  'subject-difficulty':  'Subject Difficulty Analysis',
  'professor-workload':  'Professor Workload Analysis',
  'exam-timeline':       'Exam Timeline Analysis',
};

function applyPlanFilter(taskList, filters) {
  return taskList.filter(t => matchesSessionFilters(t, filters));
}

function buildGroupStats(taskList, progressMap, planType) {
  const groups = {};

  for (const task of taskList) {
    let groupId, groupLabel, canNavigate;

    if (planType === 'category') {
      groupId = task.category || 'unknown';
      groupLabel = groupId;
      canNavigate = false;
    } else if (planType === 'project') {
      groupId = task.projectId || 'unknown';
      groupLabel = PROJECT_LABELS[groupId] || groupId;
      canNavigate = groupId !== 'unknown';
    } else {
      groupId = task.topicId || 'unknown';
      groupLabel = null;
      canNavigate = groupId !== 'unknown';
    }

    if (!groups[groupId]) {
      groups[groupId] = { groupId, groupLabel, canNavigate, total: 0, solved: 0, inProgress: 0, tasks: [] };
    }

    const status = progressMap[task.id] || 'not_started';
    groups[groupId].total++;
    if (status === 'solved')      groups[groupId].solved++;
    if (status === 'in_progress') groups[groupId].inProgress++;
    groups[groupId].tasks.push({
      id:         task.id,
      title:      task.title,
      difficulty: task.difficulty,
      levelId:    task.levelId,
      topicId:    task.topicId,
      status,
    });
  }

  return Object.values(groups).map(g => ({ ...g, notStarted: g.total - g.solved - g.inProgress }));
}

// GET /api/progress/summary?sessionId=5
// By default, resolves progress for the authenticated user — unchanged from
// before. Optionally accepts ?targetUserId=<id> so an admin/mentor can view
// another authorized user's progress (e.g. a mentor viewing an assigned
// student's progress). Authorization is always re-checked server-side via
// canAccessStudent, never trusted from the query string.
router.get('/summary', async (req, res) => {
  try {
    const actingUser = await getActingUser(req);
    if (!actingUser) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const { ownerId, error } = await resolveOwnerId(actingUser, req.query.targetUserId);
    if (error) return res.status(error.status).json({ error: error.message });

    // resolveSessionId verifies the provided sessionId actually belongs to
    // ownerId (or picks their first session if none was provided) — this is
    // what prevents a sessionId for a different user from ever resolving,
    // even if targetUserId itself was authorized.
    const sessionId = await resolveSessionId(ownerId, req.query.sessionId);

    if (!sessionId) {
      const academicTasks = tasks.filter(t => !t.datasetKey || t.datasetKey === 'academic');
      return res.json({
        totalTasks: academicTasks.length,
        solved: 0,
        inProgress: 0,
        planType: 'topic',
        byGroup: buildGroupStats(academicTasks, {}, 'topic'),
        recentAttempts: [],
        inProgressTasks: [],
      });
    }

    const [statusRows, recentRows, filters, dataset] = await Promise.all([
      // user_task_progress = current task status source of truth
      pool.query(`
        SELECT task_id, status, attempts_count
        FROM user_task_progress
        WHERE user_id = $1 AND session_id = $2
      `, [ownerId, sessionId]),
      // task_attempts — check answer history only (is_correct IS NOT NULL excludes Run Query rows)
      pool.query(`
        SELECT task_id, is_correct, created_at, submitted_sql
        FROM task_attempts
        WHERE user_id = $1 AND session_id = $2
          AND is_correct IS NOT NULL
        ORDER BY created_at DESC
      `, [ownerId, sessionId]),
      getSessionFilters(sessionId),
      getDatasetBySessionId(sessionId),
    ]);

    // Scope task list to the session's dataset before applying plan filters.
    const datasetKey    = dataset?.key || 'academic';
    const datasetTasks  = tasks.filter(t => !t.datasetKey || t.datasetKey === datasetKey);
    const planTasks     = applyPlanFilter(datasetTasks, filters);
    const planTaskIds = new Set(planTasks.map(t => t.id));

    // Progress map — only count attempts for tasks in the plan
    const progressMap = {};
    for (const row of statusRows.rows) {
      if (planTaskIds.has(row.task_id)) progressMap[row.task_id] = row.status;
    }

    const solved          = Object.values(progressMap).filter(s => s === 'solved').length;
    const inProgressCount = Object.values(progressMap).filter(s => s === 'in_progress').length;
    const attemptsCount   = statusRows.rows
      .filter(r => planTaskIds.has(r.task_id))
      .reduce((sum, r) => sum + (r.attempts_count || 0), 0);

    const recentAttempts = recentRows.rows
      .filter(row => planTaskIds.has(row.task_id))
      .map(row => {
        const task = taskMap[row.task_id] || {};
        return {
          taskId:       row.task_id,
          taskTitle:    task.title    || `Task #${row.task_id}`,
          category:     task.category || '—',
          topicId:      task.topicId  || null,
          isCorrect:    row.is_correct,
          createdAt:    row.created_at,
          submittedSql: row.submitted_sql || null,
        };
      });

    const inProgressTasks = statusRows.rows
      .filter(r => r.status === 'in_progress' && planTaskIds.has(r.task_id))
      .map(r => {
        const task = taskMap[r.task_id] || {};
        return {
          taskId:     r.task_id,
          taskTitle:  task.title      || `Task #${r.task_id}`,
          category:   task.category   || '—',
          topicId:    task.topicId    || null,
          difficulty: task.difficulty,
        };
      });

    res.json({
      totalTasks: planTasks.length,
      solved,
      inProgress: inProgressCount,
      attemptsCount,
      planType: filters.planType,
      byGroup: buildGroupStats(planTasks, progressMap, filters.planType),
      recentAttempts,
      inProgressTasks,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/progress/tasks-status?sessionId=5
// Same targetUserId behavior as GET /summary above — omitted means self,
// present means an authorized admin/mentor view of another user's statuses.
router.get('/tasks-status', async (req, res) => {
  try {
    const actingUser = await getActingUser(req);
    if (!actingUser) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const { ownerId, error } = await resolveOwnerId(actingUser, req.query.targetUserId);
    if (error) return res.status(error.status).json({ error: error.message });

    const sessionId = await resolveSessionId(ownerId, req.query.sessionId);
    if (!sessionId) return res.json({ statuses: {} });

    // user_task_progress = current task status source of truth
    const result = await pool.query(`
      SELECT task_id, status
      FROM user_task_progress
      WHERE user_id = $1 AND session_id = $2
    `, [ownerId, sessionId]);

    const statuses = {};
    for (const row of result.rows) statuses[row.task_id] = row.status;

    res.json({ statuses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
