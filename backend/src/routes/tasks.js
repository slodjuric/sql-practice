const express = require('express');
const router = express.Router();
const { tasks } = require('../data/taskRegistry');
const { resolveSessionId, getSessionBlockReason } = require('../utils/contextResolvers');
const { saveCheckAttempt } = require('../utils/attemptRecorder');
const { getActingUser } = require('../utils/authz');
const {
  validateSqlStructure,
  solutionHasTopLevelOrderBy,
  validateRequiredOrderBy,
} = require('../utils/sqlStructureValidator');
const { compareResults } = require('../utils/resultComparator');
const { validateSqlSafety, validateSchemaScope } = require('../utils/sqlSafetyValidator');
const { executeUserQuery, executeSolutionQuery, ROW_LIMIT, QUERY_TIMEOUT } = require('../utils/queryRunner');
const { getDatasetBySessionId, getAllDatasetSchemaNames } = require('../utils/datasetResolver');
const { sendUnexpectedError } = require('../utils/requestLogger');

// GET /api/tasks/categories
router.get('/categories', (req, res) => {
  const categories = [...new Set(tasks.map(t => t.category))];
  res.json(categories);
});

// GET /api/tasks
router.get('/', (req, res) => {
  const { category, topicId, levelId, projectId, datasetKey } = req.query;
  let list = tasks;
  if (datasetKey) list = list.filter(t => t.datasetKey === datasetKey);
  if (category)   list = list.filter(t => t.category  === category);
  if (topicId)    list = list.filter(t => t.topicId   === topicId);
  if (levelId)    list = list.filter(t => t.levelId   === levelId);
  if (projectId)  list = list.filter(t => t.projectId === projectId);
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
// Requires login — any authenticated role (admin/mentor/student) may fetch a
// solution; this only blocks anonymous/public access, no role restriction.
router.get('/:id/solution', async (req, res) => {
  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const task = tasks.find(t => t.id === parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ solution: task.solution.trim() });
});

// POST /api/tasks/:id/check
// userId always comes from the authenticated session — never from the client.
router.post('/:id/check', async (req, res) => {
  const task = tasks.find(t => t.id === parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { userSql, sessionId } = req.body;

  if (!userSql || typeof userSql !== 'string' || !userSql.trim()) {
    return res.status(400).json({ error: 'userSql is required.' });
  }

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const resolvedUserId    = actingUser.id;
  const resolvedSessionId = await resolveSessionId(actingUser.id, sessionId);

  if (resolvedSessionId) {
    const blockReason = await getSessionBlockReason(resolvedSessionId);
    if (blockReason) return res.status(blockReason.status).json({ error: blockReason.message });
  }

  // Resolve dataset for the session — determines schema and enables dataset validation.
  const dataset    = await getDatasetBySessionId(resolvedSessionId);
  const schemaName = dataset?.schema_name || 'academic';

  // Reject if the task belongs to a different dataset than the session.
  if (task.datasetKey && dataset?.key && task.datasetKey !== dataset.key) {
    return res.status(400).json({
      error: `This task belongs to the "${task.datasetKey}" dataset but your session uses "${dataset.key}".`,
    });
  }

  const safetyCheck = validateSqlSafety(userSql);
  if (!safetyCheck.safe) {
    await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, null, safetyCheck.reason);
    return res.status(403).json({ error: safetyCheck.reason });
  }

  // Cross-schema guard
  const allSchemas = await getAllDatasetSchemaNames();
  const scopeCheck = validateSchemaScope(userSql, schemaName, allSchemas);
  if (!scopeCheck.safe) {
    await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, null, scopeCheck.reason);
    return res.status(403).json({ error: scopeCheck.reason });
  }

  let userResult;
  let solutionResult;

  try {
    // User SQL runs with timeout guard + search_path on a dedicated client.
    // Solution SQL is trusted — no timeout, but same search_path for correctness.
    [userResult, solutionResult] = await Promise.all([
      executeUserQuery(userSql, schemaName),
      executeSolutionQuery(task.solution, schemaName),
    ]);
  } catch (err) {
    // Distinct from a genuine SQL error in the user's own query — the
    // server couldn't get a DB connection at all, so this isn't the user's
    // fault and shouldn't be shown to them as if their query were wrong.
    if (err.isPoolAcquisitionFailure) {
      await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, null, 'Server was too busy to run this check. Please try again.');
      return sendUnexpectedError(req, res, err, { route: 'POST /api/tasks/:id/check', sessionId: resolvedSessionId, taskId: task.id });
    }
    const msg = err.code === '57014'
      ? `Your query exceeded the time limit of ${Math.round(QUERY_TIMEOUT / 1000)} seconds. Try a more specific query.`
      : err.message;
    await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, null, msg);
    return res.status(400).json({ error: msg });
  }

  // Row limit check — must run BEFORE compareResults.
  if (userResult.rowCount > ROW_LIMIT) {
    const msg = `Your query returns more than ${ROW_LIMIT} rows. The expected result has ${solutionResult.rowCount} rows. Add a more specific filter or a LIMIT clause.`;
    await saveCheckAttempt(resolvedUserId, resolvedSessionId, task.id, userSql, null, msg);
    return res.status(400).json({ error: msg });
  }

  const orderMatters = solutionHasTopLevelOrderBy(task.solution);
  const comparison = compareResults(userResult, solutionResult, { orderMatters });

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
