/**
 * Canonical implementation of "is this task in scope for this session's
 * plan" — imported directly by backend/src/utils/taskFilters.js via Node's
 * CommonJS require().
 *
 * frontend/src/utils/taskFilters.js keeps its own copy of this same function
 * rather than importing this file: Vite's dev server only converts CommonJS
 * to ESM for node_modules dependencies (via optimizeDeps pre-bundling), never
 * for a project's own source files — so a direct import here loads fine in a
 * production `vite build` but breaks the dev server with a runtime "does not
 * provide an export" error (full page blank, nothing else on screen).
 * Rather than a bundler-specific workaround, the frontend keeps a plain
 * mirror, and backend/scripts/check-session-filters.js's Part B compares its
 * source text against this file's at test time so the two can't silently
 * drift apart again — see that file's comments for what it checks.
 *
 * Dependency-free on purpose: no React, no Express/Node built-ins, no DB
 * access — plain data in, boolean out.
 *
 * Logic:
 *  1. Difficulty is an AND gate — if the plan specifies levels, the task must
 *     match one (checked against both task.difficulty and task.levelId).
 *  2. Topic / project / category are OR scope filters — the task must belong
 *     to at least one of the selected scopes. If no scope filters exist, the
 *     difficulty gate alone determines the result.
 */
function matchesSessionFilters(task, filters) {
  const selectedLevels     = filters?.difficulties ?? [];
  const selectedTopics     = filters?.topics       ?? [];
  const selectedProjects   = filters?.projects     ?? [];
  const selectedCategories = filters?.categories   ?? [];

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

module.exports = { matchesSessionFilters };
