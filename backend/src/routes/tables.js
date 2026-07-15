const express = require('express');
const router = express.Router();
const pool = require('../db');
const { getSchemaNameBySessionId } = require('../utils/datasetResolver');
const { getActingUser, canAccessStudent } = require('../utils/authz');
const { sendUnexpectedError } = require('../utils/requestLogger');

const isValidTableName = (name) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);

// Returns true if the table exists in the given schema.
async function tableExistsInSchema(tableName, schemaName) {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
    [schemaName, tableName]
  );
  return result.rows.length > 0;
}

// Resolves the schema to browse for this request, authorizing the acting
// user against the session's owner first — the same "fetch the session,
// then canAccessStudent" pattern GET /api/sessions/:id/filters already uses
// (admin any session; mentor their own or an assigned student's; student
// only their own). Returns { schemaName } on success, or
// { error: { status, message } } for the caller to short-circuit with
// res.status(error.status).json({ error: error.message }).
//
// A sessionId is optional here — unlike Run Query/Check Answer (always
// self-scoped), the table browser is reachable from Sidebar/DatabaseView for
// whichever session context is on screen, including a mentor/admin browsing
// an assigned/reviewed student's session. When no sessionId is supplied at
// all (or it doesn't parse to a number), this falls back to the default
// academic schema — same as getSchemaNameBySessionId's existing behavior —
// since there's no specific session's data to authorize against.
async function resolveAuthorizedSchemaName(actingUser, sessionId) {
  if (!sessionId) {
    return { schemaName: await getSchemaNameBySessionId(null) };
  }

  const sessionRow = await pool.query(
    'SELECT id, user_id FROM learning_sessions WHERE id = $1',
    [sessionId]
  );
  if (sessionRow.rows.length === 0) {
    return { error: { status: 404, message: 'Session not found.' } };
  }

  const allowed = await canAccessStudent(actingUser, sessionRow.rows[0].user_id);
  if (!allowed) {
    return { error: { status: 403, message: "You do not have permission to view this session's tables." } };
  }

  return { schemaName: await getSchemaNameBySessionId(sessionId) };
}

// GET /api/tables?sessionId=N
router.get('/', async (req, res) => {
  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  try {
    const sessionId = req.query.sessionId ? parseInt(req.query.sessionId, 10) : null;
    const { schemaName, error } = await resolveAuthorizedSchemaName(actingUser, sessionId);
    if (error) return res.status(error.status).json({ error: error.message });

    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schemaName]
    );
    res.json(result.rows.map(r => r.table_name));
  } catch (err) {
    sendUnexpectedError(req, res, err, { route: 'GET /api/tables', sessionId: req.query.sessionId });
  }
});

// GET /api/tables/:tableName/columns?sessionId=N
router.get('/:tableName/columns', async (req, res) => {
  const { tableName } = req.params;
  if (!isValidTableName(tableName)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  try {
    const sessionId = req.query.sessionId ? parseInt(req.query.sessionId, 10) : null;
    const { schemaName, error } = await resolveAuthorizedSchemaName(actingUser, sessionId);
    if (error) return res.status(error.status).json({ error: error.message });

    if (!await tableExistsInSchema(tableName, schemaName)) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    const result = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schemaName, tableName]
    );
    res.json(result.rows);
  } catch (err) {
    sendUnexpectedError(req, res, err, {
      route: 'GET /api/tables/:tableName/columns',
      sessionId: req.query.sessionId,
      tableName,
    });
  }
});

// GET /api/tables/:tableName/preview?sessionId=N
router.get('/:tableName/preview', async (req, res) => {
  const { tableName } = req.params;
  if (!isValidTableName(tableName)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }
  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  try {
    const sessionId = req.query.sessionId ? parseInt(req.query.sessionId, 10) : null;
    const { schemaName, error } = await resolveAuthorizedSchemaName(actingUser, sessionId);
    if (error) return res.status(error.status).json({ error: error.message });

    if (!await tableExistsInSchema(tableName, schemaName)) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM "${schemaName}"."${tableName}"`
    );
    const rowCount = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT * FROM "${schemaName}"."${tableName}" LIMIT 50`
    );
    res.json({
      rows:    result.rows,
      columns: result.fields.map(f => f.name),
      rowCount,
    });
  } catch (err) {
    sendUnexpectedError(req, res, err, {
      route: 'GET /api/tables/:tableName/preview',
      sessionId: req.query.sessionId,
      tableName,
    });
  }
});

module.exports = router;
