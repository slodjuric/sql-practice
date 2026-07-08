'use strict';

/**
 * Behavior + anti-drift regression test for matchesSessionFilters — the
 * function that decides whether a task is in scope for a session's plan.
 * Used by both Practice (frontend) and Progress (backend routes/progress.js,
 * routes/sessions.js's complete-session gate) to compute the same task set
 * for a given session; a mismatch here used to be a real risk when the logic
 * lived as two hand-synced copies (backend/src/utils/taskFilters.js and
 * frontend/src/utils/taskFilters.js).
 *
 * backend/src/utils/taskFilters.js now re-exports the canonical
 * implementation in shared/sessionFilters.js (repo root) directly — real
 * sharing, zero drift risk on that side. frontend/src/utils/taskFilters.js
 * could NOT be collapsed the same way: Vite's dev server only CJS-interops
 * node_modules dependencies, never a project's own source files, so
 * importing shared/sessionFilters.js (plain CommonJS, needed as-is for
 * Node's require()) from frontend code loads fine in a production build but
 * breaks the dev server with a runtime "does not provide an export" error —
 * which is what actually happened and is why this file mirrors the logic
 * instead. Part B below is the safeguard for that remaining copy: it
 * compares its source text against the canonical one at test time and fails
 * loudly on any mismatch, so the two can't silently drift apart again.
 *
 * Pure logic, no DB — instant, like check-compare-results.js /
 * check-sql-structure-validator.js.
 *
 * Run: npm run test:session-filters
 */

const fs = require('fs');
const path = require('path');
const { matchesSessionFilters } = require('../src/utils/taskFilters');
const sharedDirect = require('../../shared/sessionFilters');

let passed = 0;
let failed = 0;

function pass(id, name) {
  console.log(`[${id}] PASS — ${name}`);
  passed++;
}

function fail(id, name, detail) {
  console.log(`[${id}] FAIL — ${name}: ${detail}`);
  failed++;
}

// ─── Part A: behavior ──────────────────────────────────────────────────────
// cases: [id, description, task, filters, expected]
const cases = [
  // ── No filters at all ─────────────────────────────────────────────────────
  ['A01', 'undefined filters object matches any task',
    { topicId: 'select', difficulty: 'easy' }, undefined, true],
  ['A02', 'null filters object matches any task',
    { topicId: 'select', difficulty: 'easy' }, null, true],
  ['A03', 'empty filters object (all arrays empty) matches any task',
    { topicId: 'select', difficulty: 'easy' }, { topics: [], difficulties: [], projects: [], categories: [] }, true],

  // ── Difficulty / level gate (AND) ─────────────────────────────────────────
  ['A04', 'difficulty filter matches via task.difficulty',
    { difficulty: 'easy' }, { difficulties: ['easy'] }, true],
  ['A05', 'difficulty filter matches via task.levelId (either field can satisfy it)',
    { levelId: 'beginner' }, { difficulties: ['beginner'] }, true],
  ['A06', 'difficulty filter rejects a task matching neither difficulty nor levelId',
    { difficulty: 'hard', levelId: 'expert' }, { difficulties: ['easy'] }, false],
  ['A07', 'difficulty gate is checked even with no scope filters — non-matching difficulty still excludes',
    { difficulty: 'hard' }, { difficulties: ['easy'], topics: [], projects: [], categories: [] }, false],

  // ── Topic scope filter (OR against topicId/category) ─────────────────────
  ['A08', 'topic filter matches via task.topicId',
    { topicId: 'join' }, { topics: ['join'] }, true],
  ['A09', 'topic filter matches via task.category (cross-field fallback)',
    { category: 'join' }, { topics: ['join'] }, true],
  ['A10', 'topic filter rejects a task in neither topicId nor category',
    { topicId: 'select', category: 'select' }, { topics: ['join'] }, false],

  // ── Project scope filter (OR against projectId/project) ───────────────────
  ['A11', 'project filter matches via task.projectId',
    { projectId: 'student-performance' }, { projects: ['student-performance'] }, true],
  ['A12', 'project filter matches via task.project (cross-field fallback)',
    { project: 'student-performance' }, { projects: ['student-performance'] }, true],
  ['A13', 'project filter rejects a task in a different project',
    { projectId: 'exam-timeline' }, { projects: ['student-performance'] }, false],

  // ── Category scope filter (OR against category/topicId) ──────────────────
  ['A14', 'category filter matches via task.category',
    { category: 'aggregate-functions' }, { categories: ['aggregate-functions'] }, true],
  ['A15', 'category filter matches via task.topicId (cross-field fallback, symmetric with topic filter)',
    { topicId: 'aggregate-functions' }, { categories: ['aggregate-functions'] }, true],
  ['A16', 'category filter rejects a task in a different category',
    { category: 'select' }, { categories: ['aggregate-functions'] }, false],

  // ── Scope filters are OR'd across topic/project/category ──────────────────
  ['A17', 'task matching the topic scope passes even though it matches no selected project',
    { topicId: 'join' }, { topics: ['join'], projects: ['exam-timeline'] }, true],
  ['A18', 'task matching the project scope passes even though it matches no selected topic',
    { projectId: 'exam-timeline' }, { topics: ['join'], projects: ['exam-timeline'] }, true],
  ['A19', 'task matching none of several simultaneous scope filters is rejected',
    { topicId: 'select', projectId: 'student-performance', category: 'select' },
    { topics: ['join'], projects: ['exam-timeline'], categories: ['aggregate-functions'] }, false],

  // ── Mixed: difficulty (AND) combined with scope (OR) ──────────────────────
  ['A20', 'mixed filters: matches difficulty AND one scope filter',
    { difficulty: 'medium', topicId: 'join' }, { difficulties: ['medium'], topics: ['join'] }, true],
  ['A21', 'mixed filters: matches scope but wrong difficulty is still rejected (AND gate)',
    { difficulty: 'hard', topicId: 'join' }, { difficulties: ['medium'], topics: ['join'] }, false],
  ['A22', 'mixed filters: matches difficulty but wrong scope is still rejected',
    { difficulty: 'medium', topicId: 'select' }, { difficulties: ['medium'], topics: ['join'] }, false],

  // ── Practice Projects tasks have no topicId/category — must still work via project-only plans ──
  ['A23', 'a practice-project task (no topicId/category) matches a project-only plan',
    { projectId: 'faculty-analysis', topicId: null, category: undefined }, { projects: ['faculty-analysis'] }, true],
];

for (const [id, name, task, filters, expected] of cases) {
  const result = matchesSessionFilters(task, filters);
  if (result === expected) {
    pass(id, name);
  } else {
    fail(id, name, `expected ${expected}, got ${result} (task=${JSON.stringify(task)}, filters=${JSON.stringify(filters)})`);
  }
}

// Note on dataset scoping: matchesSessionFilters itself has no notion of
// datasetKey — callers (routes/progress.js, routes/sessions.js) already
// filter the task list down to the session's dataset BEFORE calling this
// function (e.g. `tasks.filter(t => !t.datasetKey || t.datasetKey ===
// datasetKey)`). No dataset-related case is added here because this function
// is not responsible for that scoping and never sees a datasetKey field.

// ─── Part B: anti-drift regression — both wrappers must resolve to the ONE
// shared implementation, not a local reimplementation ──────────────────────

// B1: the backend wrapper (backend/src/utils/taskFilters.js) must export the
// EXACT SAME function reference as shared/sessionFilters.js — not a copy.
// Node's require() cache is keyed by resolved absolute path, so this holds
// regardless of the relative path string each file used to get there.
if (matchesSessionFilters === sharedDirect.matchesSessionFilters) {
  pass('B1', 'Backend wrapper re-exports the exact same function reference as shared/sessionFilters.js (no local copy)');
} else {
  fail('B1', 'Backend wrapper must be the same function reference as the shared module', 'function identity differs — a local reimplementation may have been reintroduced');
}

// B2: the frontend copy (frontend/src/utils/taskFilters.js) is an ES module
// — this plain Node script can't `require()` or execute it directly without
// a bundler (that mismatch is exactly why it's a separate copy rather than a
// direct import in the first place — see the file header above), so this
// compares SOURCE TEXT instead of a live function reference: extract the
// `matchesSessionFilters` function body from both this file and the
// canonical shared/sessionFilters.js, normalize whitespace, and require them
// to be identical. Catches the exact regression this refactor guards
// against — someone changing the filter rules on one side and forgetting
// the other — without needing to execute the ES module. Relies on both
// copies using the same parameter name (`filters`) so a body-text diff
// isn't tripped up by a cosmetic rename; that's a real (if very unlikely)
// blind spot, not a loophole for logic changes.
function extractFunctionBody(src, fnName) {
  const start = src.indexOf(`function ${fnName}(`);
  if (start === -1) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  return null;
}

function normalize(body) {
  return body.replace(/\s+/g, ' ').trim();
}

{
  const frontendWrapperPath = path.join(__dirname, '../../frontend/src/utils/taskFilters.js');
  const sharedPath = path.join(__dirname, '../../shared/sessionFilters.js');
  const frontendSrc = fs.readFileSync(frontendWrapperPath, 'utf8');
  const sharedSrc = fs.readFileSync(sharedPath, 'utf8');

  const frontendBody = extractFunctionBody(frontendSrc, 'matchesSessionFilters');
  const sharedBody = extractFunctionBody(sharedSrc, 'matchesSessionFilters');

  if (!frontendBody) {
    fail('B2', 'Could not find matchesSessionFilters in the frontend copy', 'has it been renamed or removed?');
  } else if (!sharedBody) {
    fail('B2', 'Could not find matchesSessionFilters in shared/sessionFilters.js', 'has it been renamed or removed?');
  } else if (normalize(frontendBody) === normalize(sharedBody)) {
    pass('B2', "Frontend copy's function body is identical (whitespace-normalized) to the canonical shared implementation");
  } else {
    fail('B2', 'Frontend copy has drifted from shared/sessionFilters.js',
      'the two function bodies differ — apply the same change to both, or reconsider whether this file should just import shared/ directly again');
  }
}

// B3: the shared module itself must stay framework-free — no React, no
// Express/Node built-ins beyond what every plain JS file has access to, no
// DB access — so it keeps loading unmodified under both CommonJS require()
// and Vite/esbuild's ES module import.
{
  const sharedPath = path.join(__dirname, '../../shared/sessionFilters.js');
  const src = fs.readFileSync(sharedPath, 'utf8');
  const hasForbiddenImport = /require\(['"](?!.*sessionFilters)|from\s+['"]react|from\s+['"]express/.test(src);
  if (!hasForbiddenImport) {
    pass('B3', 'shared/sessionFilters.js has no React/Express/other-module dependency');
  } else {
    fail('B3', 'shared/sessionFilters.js must stay dependency-free', 'found a require()/import beyond what is expected');
  }
}

console.log('');
console.log(`Result: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
