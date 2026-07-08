const pool = require('../db');
// matchesSessionFilters used to be hand-duplicated here and in
// frontend/src/utils/taskFilters.js — both copies had to be kept in sync
// manually, with a real risk of Practice and Progress silently disagreeing
// about a session's task scope if one side was edited without the other.
// This backend copy is now just a re-export of the canonical implementation
// in shared/sessionFilters.js (repo root), loaded via plain Node require() —
// no build step needed on this side. The frontend copy could not be
// collapsed the same way (see shared/sessionFilters.js's docstring for why —
// short version: Vite's dev server can't interop a plain CommonJS project
// file), so it keeps its own copy, checked for drift by
// scripts/check-session-filters.js instead of removed.
const { matchesSessionFilters } = require('../../../shared/sessionFilters');

async function getSessionFilters(sessionId) {
  const [filtersRes, sessionRes] = await Promise.all([
    pool.query(
      'SELECT filter_type, filter_value FROM learning_session_filters WHERE session_id = $1',
      [sessionId]
    ),
    pool.query('SELECT plan_type FROM learning_sessions WHERE id = $1', [sessionId]),
  ]);
  return {
    planType:     sessionRes.rows[0]?.plan_type || 'topic',
    topics:       filtersRes.rows.filter(r => r.filter_type === 'topic').map(r => r.filter_value),
    difficulties: filtersRes.rows.filter(r => r.filter_type === 'difficulty').map(r => r.filter_value),
    projects:     filtersRes.rows.filter(r => r.filter_type === 'project').map(r => r.filter_value),
    categories:   filtersRes.rows.filter(r => r.filter_type === 'category').map(r => r.filter_value),
  };
}

module.exports = { matchesSessionFilters, getSessionFilters };
