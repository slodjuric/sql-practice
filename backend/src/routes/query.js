const express = require('express');
const router = express.Router();
const { resolveSessionId, getSessionBlockReason } = require('../utils/contextResolvers');
const { saveRunAttempt } = require('../utils/attemptRecorder');
const { validateSqlSafety, validateSchemaScope } = require('../utils/sqlSafetyValidator');
const { executeUserQuery, ROW_LIMIT, QUERY_TIMEOUT } = require('../utils/queryRunner');
const { getSchemaNameBySessionId, getAllDatasetSchemaNames } = require('../utils/datasetResolver');
const { getActingUser } = require('../utils/authz');
const { sendUnexpectedError } = require('../utils/requestLogger');

// POST /api/query — run a SELECT query
// userId always comes from the authenticated session — never from the client.
// Requires login unconditionally, regardless of whether taskId is present —
// this is the only endpoint in the API that can execute arbitrary SQL, so it
// must never be reachable anonymously, even for the free-form playground
// where no attempt is recorded.
router.post('/', async (req, res) => {
  const { sql, taskId, sessionId } = req.body;

  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ error: 'SQL query is required.' });
  }

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // resolveSessionId verifies the provided sessionId actually belongs to
  // actingUser (or picks their first session if none was provided).
  const resolvedUserId    = actingUser.id;
  const resolvedSessionId = await resolveSessionId(actingUser.id, sessionId);

  // Completed/archived-session guards apply only to task runs (Run Query
  // button on a task), not to the free-form playground where no attempts are
  // recorded.
  if (taskId && resolvedSessionId) {
    const blockReason = await getSessionBlockReason(resolvedSessionId);
    if (blockReason) return res.status(blockReason.status).json({ error: blockReason.message });
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
    // Distinct from a genuine SQL error in the user's own query — the
    // server couldn't get a DB connection at all, so this isn't the user's
    // fault and shouldn't be shown to them as if their query were wrong.
    if (err.isPoolAcquisitionFailure) {
      if (taskId) await saveRunAttempt(resolvedUserId, resolvedSessionId, taskId, sql, 'Server was too busy to run this query. Please try again.');
      return sendUnexpectedError(req, res, err, { route: 'POST /api/query', sessionId: resolvedSessionId });
    }
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
