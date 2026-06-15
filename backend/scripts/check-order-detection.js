'use strict';

const { solutionHasTopLevelOrderBy } = require('../src/utils/sqlStructureValidator');

// ─── Test cases ───────────────────────────────────────────────────────────────

// Task 97 exact solution: scalar subquery whose ORDER BY is inside parens (depth > 0).
const TASK_97_SOLUTION = `SELECT name, city
FROM faculties
WHERE id = (
  SELECT faculty_id
  FROM students
  GROUP BY faculty_id
  ORDER BY COUNT(*) DESC
  LIMIT 1
);`;

// Task 128 exact solution: CTE where ORDER BY is at the top level (depth 0).
const TASK_128_SOLUTION = `WITH passed_exams AS (
  SELECT student_id, subject_id, grade, exam_date
  FROM exams
  WHERE passed = true
)
SELECT *
FROM passed_exams
ORDER BY grade DESC;`;

const cases = [
  {
    id: 1,
    name: 'Plain SELECT with top-level ORDER BY',
    sql: 'SELECT * FROM exams ORDER BY grade DESC',
    expected: true,
  },
  {
    id: 2,
    name: 'Plain SELECT without ORDER BY',
    sql: 'SELECT * FROM students',
    expected: false,
  },
  {
    id: 3,
    name: 'Aggregate query — no ORDER BY',
    sql: 'SELECT COUNT(*) FROM students',
    expected: false,
  },
  {
    id: 4,
    name: 'CTE with top-level ORDER BY after the final SELECT',
    sql: 'WITH cte AS (SELECT 1) SELECT * FROM cte ORDER BY 1',
    expected: true,
  },
  {
    id: 5,
    name: 'CTE where ORDER BY is only inside the CTE body (depth > 0)',
    sql: 'WITH cte AS (SELECT * FROM exams ORDER BY grade) SELECT * FROM cte',
    expected: false,
  },
  {
    id: 6,
    name: 'Subquery where ORDER BY is only inside the derived table (depth > 0)',
    sql: 'SELECT * FROM (SELECT * FROM exams ORDER BY grade) sub',
    expected: false,
  },
  {
    id: 7,
    name: 'Window function — ORDER BY only inside OVER() (depth > 0)',
    sql: 'SELECT RANK() OVER(ORDER BY grade DESC) FROM exams',
    expected: false,
  },
  {
    id: 8,
    name: 'Window function with final top-level ORDER BY',
    sql: 'SELECT RANK() OVER(ORDER BY grade DESC) FROM exams ORDER BY 1',
    expected: true,
  },
  {
    id: 9,
    name: 'UNION with ORDER BY on the combined result (top-level)',
    sql: 'SELECT first_name FROM students UNION SELECT first_name FROM professors ORDER BY first_name',
    expected: true,
  },
  {
    id: 10,
    name: "String literal containing 'order by' must not be matched",
    sql: "SELECT id FROM a ORDER BY 'order by dummy'",
    expected: true,  // there is a real top-level ORDER BY here; the string content is irrelevant
  },
  {
    id: 11,
    name: 'Task 128 exact solution — CTE with top-level ORDER BY',
    sql: TASK_128_SOLUTION,
    expected: true,
  },
  {
    id: 12,
    name: 'Task 97 exact solution — scalar subquery with ORDER BY inside parens only',
    sql: TASK_97_SOLUTION,
    expected: false,
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const c of cases) {
  const result = solutionHasTopLevelOrderBy(c.sql);
  const ok = result === c.expected;
  console.log(`[${String(c.id).padStart(2, '0')}] ${ok ? 'PASS' : 'FAIL'} — ${c.name}`);
  if (!ok) {
    console.log(`       Expected: ${c.expected}`);
    console.log(`       Got:      ${result}`);
    failed++;
  } else {
    passed++;
  }
}

console.log('');
console.log(`Result: ${passed} passed, ${failed} failed.`);

if (failed > 0) process.exit(1);
