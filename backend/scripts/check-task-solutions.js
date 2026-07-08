'use strict';

/**
 * Regression check: every task's own `solution` SQL must pass the real
 * check-answer grading pipeline when submitted as if it were the user's
 * answer (compareResults, validateRequiredOrderBy, and — for strict-mode
 * topics — validateSqlStructure). Runs against the live `academic` schema.
 *
 * This is the test the task-content translation batches (see tasks.json)
 * lean on to prove that editing description/hint text — or renaming a
 * Serbian-origin solution alias to English — never silently changes grading
 * behavior. It also incidentally re-validates every task whenever anything
 * else about the dataset or the check-answer pipeline changes, not just
 * during a translation pass.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:task-solutions
 */

const pool = require('../src/db');
const { executeUserQuery, executeSolutionQuery } = require('../src/utils/queryRunner');
const { compareResults } = require('../src/utils/resultComparator');
const {
  solutionHasTopLevelOrderBy,
  validateRequiredOrderBy,
  validateSqlStructure,
} = require('../src/utils/sqlStructureValidator');
const { tasks } = require('../src/data/taskRegistry');

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

// Only the academic dataset currently has tasks (see CLAUDE.md) — the schema
// name matches the dataset's own key, same assumption docs/check-answer-flow.md
// and the rest of the test suite already make.
const SCHEMA = 'academic';

async function run() {
  try {
    const datasetTasks = tasks.filter(t => !t.datasetKey || t.datasetKey === SCHEMA);
    for (const task of datasetTasks) {
      try {
        const [userResult, solutionResult] = await Promise.all([
          executeUserQuery(task.solution, SCHEMA),
          executeSolutionQuery(task.solution, SCHEMA),
        ]);

        const orderMatters = solutionHasTopLevelOrderBy(task.solution);
        const cmp = compareResults(userResult, solutionResult, { orderMatters });

        const orderCheck = validateRequiredOrderBy(task.solution, task.solution, task);

        const validationMode = task.validationMode ?? (['select', 'where'].includes(task.topicId) ? 'strict' : 'result_only');
        const structCheck = validationMode === 'strict'
          ? validateSqlStructure(task.solution, task.solution, task)
          : { isStructurallyValid: true };

        if (cmp.isCorrect && orderCheck.isStructurallyValid && structCheck.isStructurallyValid) {
          pass(task.id, task.title);
        } else {
          fail(task.id, task.title, JSON.stringify({
            isCorrect: cmp.isCorrect,
            failureReason: cmp.failureReason,
            orderCheck,
            structCheck,
          }));
        }
      } catch (err) {
        fail(task.id, task.title, `threw: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message);
    failed++;
  } finally {
    await pool.end();
  }

  console.log('');
  console.log(`Result: ${passed} passed, ${failed} failed (out of ${passed + failed} tasks checked).`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
