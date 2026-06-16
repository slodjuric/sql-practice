const express = require('express');
const router = express.Router();
const pool = require('../db');
const tasks = require('../data/tasks.json');
const { matchesSessionFilters, getSessionFilters } = require('../utils/taskFilters');
const { getDatasetByKey } = require('../utils/datasetResolver');

async function insertSessionFilters(client, sessionId, { topics = [], difficulties = [], projects = [], categories = [] } = {}) {
  const rows = [
    ...topics.map(v       => [sessionId, 'topic',      v]),
    ...difficulties.map(v => [sessionId, 'difficulty', v]),
    ...projects.map(v     => [sessionId, 'project',    v]),
    ...categories.map(v   => [sessionId, 'category',   v]),
  ];
  if (rows.length === 0) return;

  const placeholders = rows.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
  const values = rows.flat();
  await client.query(
    `INSERT INTO learning_session_filters (session_id, filter_type, filter_value) VALUES ${placeholders}`,
    values
  );
}

// Resolves the dataset_id to use for a new session.
// Accepts an explicit datasetId (integer), falls back to the academic dataset.
async function resolveDatasetId(providedDatasetId) {
  if (providedDatasetId) {
    const id = parseInt(providedDatasetId, 10);
    if (!isNaN(id)) {
      const res = await pool.query('SELECT id FROM datasets WHERE id = $1 AND is_active = true', [id]);
      if (res.rows[0]) return id;
    }
  }
  const academic = await getDatasetByKey('academic');
  return academic?.id || null;
}

// GET /api/sessions?userId=2
router.get('/', async (req, res) => {
  const uid = parseInt(req.query.userId, 10);
  if (!req.query.userId || isNaN(uid)) {
    return res.status(400).json({ error: 'userId is required.' });
  }
  try {
    const result = await pool.query(
      `SELECT ls.*,
              d.key  AS dataset_key,
              d.name AS dataset_name,
              d.schema_name,
              d.type AS dataset_type
       FROM learning_sessions ls
       LEFT JOIN datasets d ON d.id = ls.dataset_id
       WHERE ls.user_id = $1
       ORDER BY ls.created_at ASC`,
      [uid]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions
router.post('/', async (req, res) => {
  const { userId, name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = [], datasetId } = req.body;
  const uid = parseInt(userId, 10);
  if (!userId || isNaN(uid)) return res.status(400).json({ error: 'userId is required.' });
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Session name is required.' });
  }

  const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [uid]);
  if (userCheck.rows.length === 0) return res.status(404).json({ error: 'User not found.' });

  const resolvedDatasetId = await resolveDatasetId(datasetId);
  if (!resolvedDatasetId) return res.status(400).json({ error: 'No active dataset found.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO learning_sessions (user_id, name, description, plan_type, dataset_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [uid, name.trim(), description?.trim() || null, planType, resolvedDatasetId]
    );
    const session = result.rows[0];

    // Attach dataset fields to the returned session object
    const datasetRow = await client.query(
      'SELECT key AS dataset_key, name AS dataset_name, schema_name, type AS dataset_type FROM datasets WHERE id = $1',
      [resolvedDatasetId]
    );
    const sessionWithDataset = { ...session, ...datasetRow.rows[0] };

    const topicArr    = Array.isArray(topics)       ? topics       : [];
    const diffArr     = Array.isArray(difficulties)  ? difficulties : [];
    const projectArr  = Array.isArray(projects)      ? projects     : [];
    const categoryArr = Array.isArray(categories)    ? categories   : [];

    await insertSessionFilters(client, session.id, { topics: topicArr, difficulties: diffArr, projects: projectArr, categories: categoryArr });

    await client.query('COMMIT');
    res.status(201).json({
      session: sessionWithDataset,
      filters: {
        planType,
        topics:       topicArr,
        difficulties: diffArr,
        projects:     projectArr,
        categories:   categoryArr,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A session with this name already exists. Please choose a different name.' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/sessions/:id — update name, description and replace filters
// dataset_id is intentionally NOT editable after session creation.
router.patch('/:id', async (req, res) => {
  const sid = parseInt(req.params.id, 10);
  const { userId, name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = [] } = req.body;
  const uid = parseInt(userId, 10);

  if (!userId || isNaN(uid)) return res.status(400).json({ error: 'userId is required.' });
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Session name is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      'SELECT id FROM learning_sessions WHERE id = $1 AND user_id = $2',
      [sid, uid]
    );
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found.' });
    }

    const result = await client.query(
      `UPDATE learning_sessions SET name = $1, description = $2, plan_type = $3 WHERE id = $4 RETURNING *`,
      [name.trim(), description?.trim() || null, planType, sid]
    );
    const session = result.rows[0];

    // Attach current dataset fields
    const datasetRow = await client.query(
      `SELECT d.key AS dataset_key, d.name AS dataset_name, d.schema_name, d.type AS dataset_type
       FROM datasets d
       JOIN learning_sessions ls ON ls.dataset_id = d.id
       WHERE ls.id = $1`,
      [sid]
    );
    const sessionWithDataset = { ...session, ...datasetRow.rows[0] };

    await client.query('DELETE FROM learning_session_filters WHERE session_id = $1', [sid]);

    const topicArr    = Array.isArray(topics)       ? topics       : [];
    const diffArr     = Array.isArray(difficulties)  ? difficulties : [];
    const projectArr  = Array.isArray(projects)      ? projects     : [];
    const categoryArr = Array.isArray(categories)    ? categories   : [];

    await insertSessionFilters(client, sid, { topics: topicArr, difficulties: diffArr, projects: projectArr, categories: categoryArr });

    await client.query('COMMIT');
    res.json({
      session: sessionWithDataset,
      filters: { planType, topics: topicArr, difficulties: diffArr, projects: projectArr, categories: categoryArr },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A session with this name already exists. Please choose a different name.' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/sessions/:id/filters
router.get('/:id/filters', async (req, res) => {
  const sid = parseInt(req.params.id, 10);
  try {
    const [filtersRes, sessionRes] = await Promise.all([
      pool.query(
        `SELECT filter_type, filter_value
         FROM learning_session_filters
         WHERE session_id = $1
         ORDER BY filter_type, filter_value`,
        [sid]
      ),
      pool.query('SELECT plan_type FROM learning_sessions WHERE id = $1', [sid]),
    ]);
    const planType     = sessionRes.rows[0]?.plan_type ?? 'topic';
    const topics       = filtersRes.rows.filter(r => r.filter_type === 'topic').map(r => r.filter_value);
    const difficulties = filtersRes.rows.filter(r => r.filter_type === 'difficulty').map(r => r.filter_value);
    const projects     = filtersRes.rows.filter(r => r.filter_type === 'project').map(r => r.filter_value);
    const categories   = filtersRes.rows.filter(r => r.filter_type === 'category').map(r => r.filter_value);
    res.json({ planType, topics, difficulties, projects, categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/:id/complete  — marks session as completed (read-only, finalized)
router.patch('/:id/complete', async (req, res) => {
  const sid = parseInt(req.params.id, 10);
  const uid = parseInt(req.body.userId, 10);
  if (!req.body.userId || isNaN(uid)) return res.status(400).json({ error: 'userId is required.' });
  try {
    const sessionCheck = await pool.query(
      'SELECT id FROM learning_sessions WHERE id = $1 AND user_id = $2',
      [sid, uid]
    );
    if (sessionCheck.rows.length === 0) return res.status(404).json({ error: 'Session not found.' });

    // Verify every in-scope task has been run at least once
    const [filters, progressResult] = await Promise.all([
      getSessionFilters(sid),
      pool.query(
        'SELECT task_id, status FROM user_task_progress WHERE user_id = $1 AND session_id = $2',
        [uid, sid]
      ),
    ]);
    const planTasks   = tasks.filter(t => matchesSessionFilters(t, filters));
    const progressMap = Object.fromEntries(progressResult.rows.map(r => [r.task_id, r.status]));
    const hasNotStarted = planTasks.some(t => (progressMap[t.id] || 'not_started') === 'not_started');
    if (hasNotStarted) {
      return res.status(400).json({
        error: 'You cannot complete this session yet. Run every task at least once first.',
      });
    }

    const result = await pool.query(
      `UPDATE learning_sessions
       SET status = 'completed', completed_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [sid, uid]
    );
    if (!result.rows[0]) return res.status(500).json({ error: 'Session update failed.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/:id/reopen  — reopens a completed session back to active
router.patch('/:id/reopen', async (req, res) => {
  const sid = parseInt(req.params.id, 10);
  const uid = parseInt(req.body.userId, 10);
  if (!req.body.userId || isNaN(uid)) return res.status(400).json({ error: 'userId is required.' });
  try {
    const result = await pool.query(
      `UPDATE learning_sessions
       SET status = 'active', completed_at = NULL
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [sid, uid]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/:id/open
router.patch('/:id/open', async (req, res) => {
  const sid = parseInt(req.params.id, 10);
  const uid = parseInt(req.body?.userId, 10);
  if (!req.body?.userId || isNaN(uid)) return res.status(400).json({ error: 'userId is required.' });
  try {
    const result = await pool.query(
      'UPDATE learning_sessions SET last_opened_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *',
      [sid, uid]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sessions/:id
router.delete('/:id', async (req, res) => {
  const sid = parseInt(req.params.id, 10);
  if (!sid || isNaN(sid)) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }

  const uid = parseInt(req.body?.userId, 10);
  if (!req.body?.userId || isNaN(uid)) {
    return res.status(400).json({ error: 'userId is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      'SELECT id FROM learning_sessions WHERE id = $1 AND user_id = $2',
      [sid, uid]
    );
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found.' });
    }

    await client.query('DELETE FROM task_attempts WHERE session_id = $1', [sid]);
    await client.query('DELETE FROM user_task_progress WHERE session_id = $1', [sid]);
    await client.query('DELETE FROM learning_session_filters WHERE session_id = $1', [sid]);
    await client.query('DELETE FROM learning_sessions WHERE id = $1', [sid]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
