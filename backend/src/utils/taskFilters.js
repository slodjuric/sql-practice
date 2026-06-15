const pool = require('../db');

/**
 * Determines whether a task is in scope for a given session plan.
 *
 * ⚠️  INTENTIONAL DUPLICATION — KEEP IN SYNC
 * This function is mirrored in:
 *   frontend/src/utils/taskFilters.js → matchesSessionFilters (exported)
 *
 * Both implementations MUST stay identical in logic. If you change the filter
 * rules here, apply the same change in taskFilters.js, and vice versa.
 * A mismatch causes users to see different task sets in Practice vs Progress
 * for the same session.
 *
 * Fields that must match between both implementations:
 *   - difficulties  → AND gate: task.difficulty or task.levelId must be included
 *   - topics        → OR scope: task.topicId or task.category must be included
 *   - projects      → OR scope: task.projectId or task.project must be included
 *   - categories    → OR scope: task.category or task.topicId must be included
 *   - hasScopeFilter guard (topics.len > 0 || projects.len > 0 || categories.len > 0)
 *   - gate structure: difficulty is AND, scope filters are OR across types
 */
function matchesSessionFilters(task, filters) {
  const selectedLevels     = filters?.difficulties ?? [];
  const selectedTopics     = filters?.topics       ?? [];
  const selectedProjects   = filters?.projects     ?? [];
  const selectedCategories = filters?.categories   ?? [];

  const levelOk =
    selectedLevels.length === 0 ||
    selectedLevels.includes(task.difficulty) ||
    selectedLevels.includes(task.levelId);

  if (!levelOk) return false;

  const hasScopeFilter =
    selectedTopics.length     > 0 ||
    selectedProjects.length   > 0 ||
    selectedCategories.length > 0;

  if (!hasScopeFilter) return true;

  const topicOk =
    selectedTopics.includes(task.topicId) ||
    selectedTopics.includes(task.category);

  const projectOk =
    selectedProjects.includes(task.projectId) ||
    selectedProjects.includes(task.project);

  const categoryOk =
    selectedCategories.includes(task.category) ||
    selectedCategories.includes(task.topicId);

  return topicOk || projectOk || categoryOk;
}

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
