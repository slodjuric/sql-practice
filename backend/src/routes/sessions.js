const express = require('express');
const router = express.Router();
const pool = require('../db');
const { tasks } = require('../data/taskRegistry');
const { matchesSessionFilters, getSessionFilters } = require('../utils/taskFilters');
const { getDatasetByKey, getDatasetBySessionId } = require('../utils/datasetResolver');
const { getActingUser, canReopenSession, canCreateSessionForUser, canAccessStudent, canArchiveSession } = require('../utils/authz');

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

// Shared by every route that returns a single enriched session object
// (POST, PATCH /:id, PATCH /:id/complete, PATCH /:id/reopen, PATCH /:id/archive,
// PATCH /:id/restore) — attaches the current dataset fields plus read-only
// ownership metadata: owner_username/owner_role (from user_id),
// created_by_username (from created_by_user_id, null if never set or the
// creator was since deleted), and archived_by_username (from
// archived_by_user_id, same null-if-deleted behavior). Only these fields are
// exposed; no password_hash or other user columns. Merge the single result
// row into the session object, e.g. `{ ...session, ...enrichRow.rows[0] }`.
const SESSION_ENRICH_QUERY = `
  SELECT d.key AS dataset_key, d.name AS dataset_name, d.schema_name, d.type AS dataset_type,
         o.username AS owner_username, o.role AS owner_role, c.username AS created_by_username,
         a.username AS archived_by_username
  FROM learning_sessions ls
  LEFT JOIN datasets d ON d.id = ls.dataset_id
  LEFT JOIN users o ON o.id = ls.user_id
  LEFT JOIN users c ON c.id = ls.created_by_user_id
  LEFT JOIN users a ON a.id = ls.archived_by_user_id
  WHERE ls.id = $1
`;

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

// GET /api/sessions
// By default, returns the authenticated user's own, NON-ARCHIVED sessions —
// archiving is a lifecycle-visibility action (see PATCH /:id/archive below),
// so an archived session is hidden from the normal list unless the caller
// explicitly opts in via ?includeArchived=true (used by the "show archived
// sessions" toggle in the UI). Optionally accepts ?targetUserId=<id> so an
// admin/mentor can read another authorized user's sessions (e.g. a mentor
// viewing an assigned student's sessions). Authorization is always
// re-checked server-side via canAccessStudent, never trusted from the query
// string.
//
// Each session row also carries read-only ownership metadata so the UI can
// show whose session it is without inferring it from local viewedUser state:
// owner_username/owner_role (from user_id), created_by_username (from
// created_by_user_id, null if never set or the creator was since deleted —
// see the ON DELETE SET NULL migration in initDb.js), and
// archived_by_username (same null-if-deleted behavior, from
// archived_by_user_id). Only these four fields are exposed; no password_hash
// or other user columns.
router.get('/', async (req, res) => {
  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  let ownerId = actingUser.id;
  const { targetUserId, includeArchived } = req.query;
  if (targetUserId !== undefined && targetUserId !== null && targetUserId !== '') {
    const parsedTargetId = parseInt(targetUserId, 10);
    if (isNaN(parsedTargetId)) {
      return res.status(400).json({ error: 'Invalid targetUserId.' });
    }

    const allowed = await canAccessStudent(actingUser, parsedTargetId);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have permission to view this user\'s sessions.' });
    }

    ownerId = parsedTargetId;
  }

  const showArchived = includeArchived === 'true' || includeArchived === '1';

  try {
    const result = await pool.query(
      `SELECT ls.*,
              d.key  AS dataset_key,
              d.name AS dataset_name,
              d.schema_name,
              d.type AS dataset_type,
              o.username AS owner_username,
              o.role     AS owner_role,
              c.username AS created_by_username,
              a.username AS archived_by_username
       FROM learning_sessions ls
       LEFT JOIN datasets d ON d.id = ls.dataset_id
       LEFT JOIN users o ON o.id = ls.user_id
       LEFT JOIN users c ON c.id = ls.created_by_user_id
       LEFT JOIN users a ON a.id = ls.archived_by_user_id
       WHERE ls.user_id = $1 ${showArchived ? '' : 'AND ls.archived_at IS NULL'}
       ORDER BY ls.created_at ASC`,
      [ownerId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions
// By default, creates a session owned by (and created by) the authenticated
// user. Optionally accepts `targetUserId` in the body so an admin/mentor can
// create a session owned by another user (e.g. a mentor setting up a plan
// for an assigned student). Named to match the `targetUserId` parameter of
// canCreateSessionForUser (utils/authz.js) — authorization is always
// re-checked server-side via that function, for self-creation too, never
// trusted from the frontend. Students can never create a session, not even
// for themselves — canCreateSessionForUser rejects the student role outright.
router.post('/', async (req, res) => {
  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const { name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = [], datasetId, targetUserId } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Session name is required.' });
  }

  // ownerId defaults to the acting user, and is only ever changed after an
  // explicit targetUserId passes an existence check.
  let ownerId = actingUser.id;
  const targetUserIdProvided = targetUserId !== undefined && targetUserId !== null && targetUserId !== '';

  if (targetUserIdProvided) {
    const parsedTargetId = parseInt(targetUserId, 10);
    if (isNaN(parsedTargetId)) {
      return res.status(400).json({ error: 'Invalid targetUserId.' });
    }

    const targetRow = await pool.query('SELECT id FROM users WHERE id = $1', [parsedTargetId]);
    if (targetRow.rows.length === 0) {
      return res.status(404).json({ error: 'Target user not found.' });
    }

    ownerId = parsedTargetId;
  }

  // Always re-checked, even for self-creation with no targetUserId — this is
  // what actually blocks a student from creating their own session.
  const allowed = await canCreateSessionForUser(actingUser, ownerId);
  if (!allowed) {
    return res.status(403).json({ error: 'You do not have permission to create a session for this user.' });
  }

  const resolvedDatasetId = await resolveDatasetId(datasetId);
  if (!resolvedDatasetId) return res.status(400).json({ error: 'No active dataset found.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO learning_sessions (user_id, created_by_user_id, name, description, plan_type, dataset_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [ownerId, actingUser.id, name.trim(), description?.trim() || null, planType, resolvedDatasetId]
    );
    const session = result.rows[0];

    // Attach dataset fields + read-only ownership metadata (see
    // SESSION_ENRICH_QUERY) — otherwise a freshly created session would show
    // this info only after the next full list reload.
    const enrichRow = await client.query(SESSION_ENRICH_QUERY, [session.id]);
    const sessionWithDataset = { ...session, ...enrichRow.rows[0] };

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
// userId always comes from the authenticated session — never from the client.
// Authorization is based on the session's own user_id (fetched here), not on
// any targetUserId the client might send — a mentor editing an assigned
// student's session relies on the session row itself, exactly like
// canViewSession/GET /api/sessions.
router.patch('/:id', async (req, res) => {
  const sid = parseInt(req.params.id, 10);

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const { name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = [] } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Session name is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      'SELECT id, user_id, archived_at FROM learning_sessions WHERE id = $1',
      [sid]
    );
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found.' });
    }
    const existingSession = check.rows[0];

    // Students can view/select sessions but never manage them — renaming or
    // editing the plan is a management action, not even for their own session.
    if (actingUser.role === 'student') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You do not have permission to edit sessions.' });
    }

    // Admin can edit any session; mentor can edit their own session or an
    // assigned student's session, never an unassigned student's — same rule
    // canAccessStudent already encodes for GET /api/sessions.
    const allowed = await canAccessStudent(actingUser, existingSession.user_id);
    if (!allowed) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You do not have permission to edit this session.' });
    }

    // Archived sessions are hidden/inert until restored — editing one before
    // restoring it would silently bring a "forgotten" plan back into active
    // use without the explicit restore step the archive flow is meant to require.
    if (existingSession.archived_at) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This session is archived. Restore it before editing.' });
    }

    const result = await client.query(
      `UPDATE learning_sessions SET name = $1, description = $2, plan_type = $3 WHERE id = $4 RETURNING *`,
      [name.trim(), description?.trim() || null, planType, sid]
    );
    const session = result.rows[0];

    // Attach dataset fields + read-only ownership metadata (see
    // SESSION_ENRICH_QUERY) — edit doesn't change ownership, but keeps the
    // response shape consistent so the Current Session card doesn't lose
    // owner/creator info right after a save.
    const enrichRow = await client.query(SESSION_ENRICH_QUERY, [sid]);
    const sessionWithDataset = { ...session, ...enrichRow.rows[0] };

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
// Requires login. Authorization mirrors PATCH/DELETE /:id: fetch the session
// by id first (404 if it doesn't exist at all), then authorize via
// canAccessStudent(actingUser, session.user_id) — self always allowed, admin
// always allowed, mentor allowed only for their own or an assigned student's
// session (403 otherwise), student allowed only for their own. This used to
// be scoped to `WHERE user_id = actingUser.id`, which made a mentor/admin
// reviewing another (even assigned) user's session always 404 — silently
// resetting the Edit Plan form to empty filters and risking overwriting the
// real plan on save.
router.get('/:id/filters', async (req, res) => {
  const sid = parseInt(req.params.id, 10);

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  try {
    const sessionRes = await pool.query(
      'SELECT plan_type, user_id FROM learning_sessions WHERE id = $1',
      [sid]
    );
    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    const existingSession = sessionRes.rows[0];

    const allowed = await canAccessStudent(actingUser, existingSession.user_id);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have permission to view this session\'s filters.' });
    }

    const filtersRes = await pool.query(
      `SELECT filter_type, filter_value
       FROM learning_session_filters
       WHERE session_id = $1
       ORDER BY filter_type, filter_value`,
      [sid]
    );
    const planType     = sessionRes.rows[0].plan_type ?? 'topic';
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
// userId always comes from the authenticated session — never from the client.
router.patch('/:id/complete', async (req, res) => {
  const sid = parseInt(req.params.id, 10);

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  try {
    // Unlike edit/create/delete/reopen, completing a session is not a
    // management action reserved for admin/mentor — a student legitimately
    // completes their own session once they've satisfied the conditions
    // below. Ownership-only, same as before: never another user's session.
    const sessionCheck = await pool.query(
      'SELECT id, archived_at FROM learning_sessions WHERE id = $1 AND user_id = $2',
      [sid, actingUser.id]
    );
    if (sessionCheck.rows.length === 0) return res.status(404).json({ error: 'Session not found.' });

    // Archived sessions are hidden/inert until restored.
    if (sessionCheck.rows[0].archived_at) {
      return res.status(403).json({ error: 'This session is archived. Restore it before completing it.' });
    }

    // Verify every in-scope task has been run at least once
    const [filters, progressResult, dataset] = await Promise.all([
      getSessionFilters(sid),
      pool.query(
        'SELECT task_id, status FROM user_task_progress WHERE user_id = $1 AND session_id = $2',
        [actingUser.id, sid]
      ),
      getDatasetBySessionId(sid),
    ]);
    const datasetKey  = dataset?.key || 'academic';
    const datasetTasks = tasks.filter(t => !t.datasetKey || t.datasetKey === datasetKey);
    const planTasks   = datasetTasks.filter(t => matchesSessionFilters(t, filters));
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
      [sid, actingUser.id]
    );
    if (!result.rows[0]) return res.status(500).json({ error: 'Session update failed.' });

    const enrichRow = await pool.query(SESSION_ENRICH_QUERY, [sid]);
    res.json({ ...result.rows[0], ...enrichRow.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/:id/reopen  — reopens a completed session back to active
// Acting user is resolved from the authenticated session (see utils/authz.js).
// Permission is enforced by canReopenSession — students can never reopen, even their own session;
// backend is the source of truth here, not the frontend button state.
router.patch('/:id/reopen', async (req, res) => {
  const sid = parseInt(req.params.id, 10);

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Acting user is required.' });
  }

  try {
    const sessionRow = await pool.query(
      'SELECT id, user_id, archived_at FROM learning_sessions WHERE id = $1',
      [sid]
    );
    if (sessionRow.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    const session = sessionRow.rows[0];

    // A student targeting someone else's session gets 404, not 403 — this
    // avoids letting a student distinguish "doesn't exist" from "exists but
    // isn't mine" by probing session ids. Only their own session (where the
    // real rule — students can never reopen — kicks in) surfaces as 403.
    if (actingUser.role === 'student' && session.user_id !== actingUser.id) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    if (!(await canReopenSession(actingUser, session))) {
      return res.status(403).json({ error: 'You do not have permission to reopen this session.' });
    }

    // Reopen is specifically for completed → active; restoring a session
    // from archived is a distinct action (PATCH /:id/restore) with its own
    // authorization check, so archived sessions are routed there instead.
    if (session.archived_at) {
      return res.status(403).json({ error: 'This session is archived. Restore it instead of reopening.' });
    }

    const result = await pool.query(
      `UPDATE learning_sessions
       SET status = 'active', completed_at = NULL
       WHERE id = $1
       RETURNING *`,
      [sid]
    );

    const enrichRow = await pool.query(SESSION_ENRICH_QUERY, [sid]);
    res.json({ ...result.rows[0], ...enrichRow.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/:id/open
// userId always comes from the authenticated session — never from the client.
// Deliberately self-only (NOT canAccessStudent, unlike PATCH/DELETE /:id) —
// last_opened_at is the signal the session's OWNER relies on to have their
// own next-login session auto-picked (see loadSessionsForContext in
// App.jsx). A mentor/admin browsing a reviewed user's sessions must never
// overwrite that signal on the owner's behalf; the frontend already never
// calls this route in a viewedUser context for exactly this reason — this
// explicit fetch-then-check makes that the actual enforced backend rule
// (previously a single combined WHERE clause with the same effect, but not
// documented as an intentional decision alongside the other routes' authz).
router.patch('/:id/open', async (req, res) => {
  const sid = parseInt(req.params.id, 10);

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  try {
    const sessionRes = await pool.query('SELECT id, user_id, archived_at FROM learning_sessions WHERE id = $1', [sid]);
    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    if (sessionRes.rows[0].user_id !== actingUser.id) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    // Archived sessions never become "the resumed active session" — the
    // frontend's own session list already excludes them by default, but this
    // is the actual enforced backend rule, same defense-in-depth pattern as
    // the archived guards on edit/complete/reopen above.
    if (sessionRes.rows[0].archived_at) {
      return res.status(403).json({ error: 'This session is archived. Restore it before opening it.' });
    }

    const result = await pool.query(
      'UPDATE learning_sessions SET last_opened_at = NOW() WHERE id = $1 RETURNING *',
      [sid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/:id/archive
// Archive is the NORMAL user-facing way to remove a session from view —
// unlike DELETE below, it never touches task_attempts, user_task_progress,
// or learning_session_filters. It only hides the session from the default
// GET /api/sessions list (see the `includeArchived` handling above) and
// blocks further lifecycle actions (edit/complete/reopen/open) until it is
// restored via PATCH /:id/restore. Authorization mirrors DELETE/PATCH /:id:
// a blanket role gate for students (never, not even their own session), then
// canArchiveSession (admin any session; mentor own or assigned student's).
router.patch('/:id/archive', async (req, res) => {
  const sid = parseInt(req.params.id, 10);

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  if (actingUser.role === 'student') {
    return res.status(403).json({ error: 'You do not have permission to archive sessions.' });
  }

  try {
    const sessionRow = await pool.query(
      'SELECT id, user_id FROM learning_sessions WHERE id = $1',
      [sid]
    );
    if (sessionRow.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    const session = sessionRow.rows[0];

    const allowed = await canArchiveSession(actingUser, session);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have permission to archive this session.' });
    }

    const result = await pool.query(
      `UPDATE learning_sessions
       SET archived_at = NOW(), archived_by_user_id = $1
       WHERE id = $2
       RETURNING *`,
      [actingUser.id, sid]
    );

    const enrichRow = await pool.query(SESSION_ENRICH_QUERY, [sid]);
    res.json({ ...result.rows[0], ...enrichRow.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/:id/restore
// Reverses PATCH /:id/archive — clears archived_at/archived_by_user_id so
// the session reappears in the default GET /api/sessions list and its
// lifecycle actions (edit/complete/reopen/open) work normally again. Does
// NOT change status (active/completed) or last_opened_at — restoring a
// session never makes it "the resumed active session" on its own; the owner
// (or a mentor/admin) still has to select it explicitly afterwards. Same
// authorization as archive: student never; admin any; mentor own or
// assigned student's session.
router.patch('/:id/restore', async (req, res) => {
  const sid = parseInt(req.params.id, 10);

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  if (actingUser.role === 'student') {
    return res.status(403).json({ error: 'You do not have permission to restore sessions.' });
  }

  try {
    const sessionRow = await pool.query(
      'SELECT id, user_id FROM learning_sessions WHERE id = $1',
      [sid]
    );
    if (sessionRow.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    const session = sessionRow.rows[0];

    const allowed = await canArchiveSession(actingUser, session);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have permission to restore this session.' });
    }

    const result = await pool.query(
      `UPDATE learning_sessions
       SET archived_at = NULL, archived_by_user_id = NULL
       WHERE id = $1
       RETURNING *`,
      [sid]
    );

    const enrichRow = await pool.query(SESSION_ENRICH_QUERY, [sid]);
    res.json({ ...result.rows[0], ...enrichRow.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sessions/:id
// MAINTENANCE-ONLY — not the normal user-facing flow. Archive (above) is now
// the standard way a session is removed from view, and it preserves all
// history; this route still permanently destroys task_attempts,
// user_task_progress, learning_session_filters, and the session row itself,
// with no way to undo it. It is intentionally not called from anywhere in
// the frontend (no button reaches it) — it remains here only for direct
// API/admin/database-maintenance use (e.g. purging a genuinely unwanted test
// or duplicate session). Authorization is unchanged from before: userId
// always comes from the authenticated session — never from the client.
// Based on the session's own user_id (fetched here), not on any targetUserId
// the client might send — same pattern as PATCH /:id: a mentor deleting an
// assigned student's session relies on the session row itself via
// canAccessStudent.
router.delete('/:id', async (req, res) => {
  const sid = parseInt(req.params.id, 10);
  if (!sid || isNaN(sid)) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }

  const actingUser = await getActingUser(req);
  if (!actingUser) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  // Students can never delete a session, not even their own — the product
  // rule is "select existing sessions only." This is a blanket role gate,
  // not an ownership check, so a student can't even use this route to probe
  // whether a given session id exists.
  if (actingUser.role === 'student') {
    return res.status(403).json({ error: 'You do not have permission to delete sessions.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      'SELECT id, user_id FROM learning_sessions WHERE id = $1',
      [sid]
    );
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found.' });
    }
    const existingSession = check.rows[0];

    // Admin can delete any session; mentor can delete their own session or
    // an assigned student's session, never an unassigned student's — same
    // rule canAccessStudent already encodes for GET /api/sessions and
    // PATCH /:id.
    const allowed = await canAccessStudent(actingUser, existingSession.user_id);
    if (!allowed) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You do not have permission to delete this session.' });
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
