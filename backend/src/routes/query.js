const express = require('express');
const router = express.Router();
const pool = require('../db');
const { resolveSessionId } = require('../utils/contextResolvers');
const { saveRunAttempt } = require('../utils/attemptRecorder');
const { validateSqlSafety, validateSchemaScope } = require('../utils/sqlSafetyValidator');
const { executeUserQuery, ROW_LIMIT, QUERY_TIMEOUT } = require('../utils/queryRunner');
const { getSchemaNameBySessionId, getAllDatasetSchemaNames } = require('../utils/datasetResolver');
const { getActingUser } = require('../utils/authz');

// POST /api/query — run a SELECT query
// userId always comes from the authenticated session — never from the client.
// Only the attempt-recording path (taskId present) requires login; the
// free-form playground (no taskId, nothing recorded) does not.
router.post('/', async (req, res) => {
  const { sql, taskId, sessionId } = req.body;

  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ error: 'SQL query is required.' });
  }

  const actingUser = await getActingUser(req);
  if (taskId && !actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  // resolveSessionId verifies the provided sessionId actually belongs to
  // actingUser (or picks their first session if none was provided).
  const resolvedUserId    = actingUser?.id ?? null;
  const resolvedSessionId = actingUser ? await resolveSessionId(actingUser.id, sessionId) : null;

  // Completed-session guard applies only to task runs (Run Query button on a task),
  // not to the free-form playground where no attempts are recorded.
  if (taskId && resolvedSessionId) {
    const sessionRow = await pool.query(
      'SELECT status FROM learning_sessions WHERE id = $1',
      [resolvedSessionId]
    );
    if (sessionRow.rows[0]?.status === 'completed') {
      return res.status(403).json({ error: 'This session is completed. Reopen it to continue.' });
    }
  }

  const schemaName = await getSchemaNameBySessionId(resolvedSessionId);

  const check = validateSqlSafety(sql);
  if (!check.safe) {
    if (taskId) await saveRunAttempt(resolvedUserId, resolvedSessionId, taskId, sql, check.reason);
    return res.status(403).json({ error: check.reason });
  }

  // Cross-schema guard — only active when more than one dataset exists.
  const allSchemas  = await getAllDatasetSchemaNames();
  const scopeCheck  = validateSchemaScope(sql, schemaName, allSchemas);
  if (!scopeCheck.safe) {
    if (taskId) await saveRunAttempt(resolvedUserId, resolvedSessionId, taskId, sql, scopeCheck.reason);
    return res.status(403).json({ error: scopeCheck.reason });
  }

  let result      = null;
  let errorMessage = null;

  try {
    result = await executeUserQuery(sql, schemaName);
  } catch (err) {
    errorMessage = err.code === '57014'
      ? `Your query exceeded the time limit of ${Math.round(QUERY_TIMEOUT / 1000)} seconds. Try a more specific query.`
      : err.message;
  }

  // Row limit check — only runs when execution succeeded.
  if (!errorMessage && result.rowCount > ROW_LIMIT) {
    errorMessage = `Your query returns more than ${ROW_LIMIT} rows. Add a LIMIT clause or a more specific filter.`;
  }

  if (taskId) {
    await saveRunAttempt(resolvedUserId, resolvedSessionId, taskId, sql, errorMessage);
  }

  if (errorMessage) {
    return res.status(400).json({ error: errorMessage });
  }

  res.json({
    rows:     result.rows,
    columns:  result.fields.map(f => f.name),
    rowCount: result.rowCount,
  });
});

module.exports = router;
