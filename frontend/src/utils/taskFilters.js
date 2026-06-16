/**
 * Determines whether a task is in scope for a given session plan.
 *
 * ⚠️  INTENTIONAL DUPLICATION — KEEP IN SYNC
 * This function is mirrored in:
 *   backend/src/utils/taskFilters.js → matchesSessionFilters
 *
 * Both implementations MUST stay identical in logic. If you change
 * the filter rules here, apply the same change in the backend copy, and vice versa.
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
 *
 * Logic:
 *  1. Difficulty is an AND gate — if the plan specifies levels, the task must
 *     match one (checked against both task.difficulty and task.levelId).
 *  2. Topic / project / category are OR scope filters — the task must belong
 *     to at least one of the selected scopes.  If no scope filters exist, the
 *     difficulty gate alone determines the result.
 */
export function matchesSessionFilters(task, sessionFilters) {
  const selectedLevels     = sessionFilters?.difficulties ?? [];
  const selectedTopics     = sessionFilters?.topics       ?? [];
  const selectedProjects   = sessionFilters?.projects     ?? [];
  const selectedCategories = sessionFilters?.categories   ?? [];

  // ── 1. Difficulty / level gate (AND) ──────────────────────────────────────
  const levelOk =
    selectedLevels.length === 0 ||
    selectedLevels.includes(task.difficulty) ||
    selectedLevels.includes(task.levelId);

  if (!levelOk) return false;

  // ── 2. Scope gate (OR across topic / project / category) ──────────────────
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
