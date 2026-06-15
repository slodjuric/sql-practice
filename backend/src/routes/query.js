const express = require('express');
const router = express.Router();
const pool = require('../db');
const { resolveUserId, resolveSessionId } = require('../utils/contextResolvers');
const { saveRunAttempt } = require('../utils/attemptRecorder');
const { validateSqlSafety } = require('../utils/sqlSafetyValidator');
const { executeUserQuery, ROW_LIMIT, QUERY_TIMEOUT } = require('../utils/queryRunner');

// POST /api/query — run a SELECT query
router.post('/', async (req, res) => {
  const { sql, taskId, userId, sessionId } = req.body;

  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ error: 'SQL query is required.' });
  }

  let resolvedUserId    = null;
  let resolvedSessionId = null;

  if (taskId) {
    resolvedUserId    = await resolveUserId(userId);
    resolvedSessionId = await resolveSessionId(resolvedUserId, sessionId);

    if (resolvedSessionId) {
      const sessionRow = await pool.query(
        'SELECT status FROM learning_sessions WHERE id = $1',
        [resolvedSessionId]
      );
      if (sessionRow.rows[0]?.status === 'completed') {
        return res.status(403).json({ error: 'This session is completed. Reopen it to continue.' });
      }
    }
  }

  const check = validateSqlSafety(sql);
  if (!check.safe) {
    if (taskId) await saveRunAttempt(resolvedUserId, resolvedSessionId, taskId, sql, check.reason);
    return res.status(403).json({ error: check.reason });
  }

  let result      = null;
  let errorMessage = null;

  try {
    result = await executeUserQuery(sql);
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
