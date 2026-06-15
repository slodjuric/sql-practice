const express = require('express');
const router = express.Router();
const pool = require('../db');
const tasks = require('../data/tasks.json');
const { resolveUserId, resolveSessionId } = require('../utils/contextResolvers');
const { saveCheckAttempt } = require('../utils/attemptRecorder');
const {
  validateSqlStructure,
  solutionHasTopLevelOrderBy,
  validateRequiredOrderBy,
} = require('../utils/sqlStructureValidator');
const { compareResults } = require('../utils/resultComparator');
const { validateSqlSafety } = require('../utils/sqlSafetyValidator');
const { executeUserQuery, ROW_LIMIT, QUERY_TIMEOUT } = require('../utils/queryRunner');

// GET /api/tasks/categories
router.get('/categories', (req, res) => {
  const categories = [...new Set(tasks.map(t => t.category))];
  res.json(categories);
});

// GET /api/tasks
router.get('/', (req, res) => {
  const { category, topicId, levelId, projectId } = req.query;
  let list = tasks;
  if (category)  list = list.filter(t => t.category  === category);
  if (topicId)   list = list.filter(t => t.topicId   === topicId);
  if (levelId)   list = list.filter(t => t.levelId   === levelId);
  if (projectId) list = list.filter(t => t.projectId === projectId);
  res.json(list.map(({ solution, ...rest }) => rest));
});

// GET /api/tasks/:id
router.get('/:id', (req, res) => {
  const task = tasks.find(t => t.id === parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { solution, ...rest } = task;
  res.json(rest);
});

// GET /api/tasks/:id/solution
router.get('/:id/solution', (req, res) => {
  const task = tasks.find(t => t.id === parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ solution: task.solution.trim() });
});

// POST /api/tasks/:id/check
router.post('/:id/check', async (req, res) => {
  const task = tasks.find(t => t.id === parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { userSql, userId, sessionId } = req.body;

  if (!userSql || typeof userSql !== 'string' || !userSql.trim()) {
    return res.status(400).json({ error: 'userSql is required.' });
  }

  let resolvedUserId    = await resolveUserId(userId);
  let resolvedSessionId = await resolveSessionId(resolvedUserId, sessionId);

  if (resolvedSessionId) {
    const sessionRow = await pool.query(
      'SELECT status FROM learning_sessions WHERE id = $1',
      [resolvedSessionId]
    );
    if (sessionRow.rows[0]?.status === 'completed') {
      return res.status(403).json({ error: 'This session is completed. Reopen it to continue.' });
    }
  }

  const safetyCheck = validateSqlSafety(userSql);
  if (!safetyCheck.safe) {
    await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, null, safetyCheck.reason);
    return res.status(403).json({ error: safetyCheck.reason });
  }

  let userResult;
  let solutionResult;

  try {
    // User SQL runs with a timeout guard on a dedicated client.
    // Solution SQL is trusted and runs on the shared pool — no cap, no timeout.
    [userResult, solutionResult] = await Promise.all([
      executeUserQuery(userSql),
      pool.query(task.solution),
    ]);
  } catch (err) {
    const msg = err.code === '57014'
      ? `Your query exceeded the time limit of ${Math.round(QUERY_TIMEOUT / 1000)} seconds. Try a more specific query.`
      : err.message;
    await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, null, msg);
    return res.status(400).json({ error: msg });
  }

  // Row limit check — must run BEFORE compareResults.
  // If the user's query returns too many rows we cannot compare results safely,
  // and returning partial rows would risk a false-positive match.
  if (userResult.rowCount > ROW_LIMIT) {
    const msg = `Your query returns more than ${ROW_LIMIT} rows. The expected result has ${solutionResult.rowCount} rows. Add a more specific filter or a LIMIT clause.`;
    await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, null, msg);
    return res.status(400).json({ error: msg });
  }

  const orderMatters = solutionHasTopLevelOrderBy(task.solution);
  const comparison = compareResults(userResult, solutionResult, { orderMatters });

  // Global ORDER BY presence check — runs for all topics.
  // Catches cases where results coincidentally match even though the user omitted
  // a required ORDER BY (e.g. all rows have the same sort-key value).
  if (comparison.isCorrect) {
    const requiredOrderCheck = validateRequiredOrderBy(userSql, task.solution, task);
    if (!requiredOrderCheck.isStructurallyValid) {
      await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, false, null);
      return res.json({
        isCorrect:           false,
        failureReason:       'query_logic_mismatch',
        logicMismatchReason: requiredOrderCheck.reason,
        logicMismatchHint:   requiredOrderCheck.hint,
        solutionHasJoin:     /\bjoin\b/i.test(task.solution || ''),
        userResult: {
          rows:     userResult.rows,
          columns:  userResult.fields.map(f => f.name),
          rowCount: userResult.rowCount,
        },
        expectedRowCount: solutionResult.rowCount,
      });
    }
  }

  // Structural validation — only for strict-mode tasks, only when results already match.
  // Catches queries that return the right rows on the current dataset but use logically
  // different SQL (e.g. over-constrained WHERE, extra LIMIT, unsolicited DISTINCT).
  const validationMode =
    task.validationMode ??
    (['select', 'where'].includes(task.topicId) ? 'strict' : 'result_only');

  if (comparison.isCorrect && validationMode === 'strict') {
    const structureCheck = validateSqlStructure(userSql, task.solution, task);
    if (!structureCheck.isStructurallyValid) {
      await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, false, null);
      return res.json({
        isCorrect:           false,
        failureReason:       'query_logic_mismatch',
        logicMismatchReason: structureCheck.reason,
        logicMismatchHint:   structureCheck.hint,
        solutionHasJoin:     /\bjoin\b/i.test(task.solution || ''),
        userResult: {
          rows:     userResult.rows,
          columns:  userResult.fields.map(f => f.name),
          rowCount: userResult.rowCount,
        },
        expectedRowCount: solutionResult.rowCount,
      });
    }
  }

  await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, comparison.isCorrect, null);

  res.json({
    ...comparison,
    solutionHasJoin: /\bjoin\b/i.test(task.solution || ''),
    userResult: {
      rows:     userResult.rows,
      columns:  userResult.fields.map(f => f.name),
      rowCount: userResult.rowCount,
    },
    expectedRowCount: solutionResult.rowCount,
  });
});

module.exports = router;
