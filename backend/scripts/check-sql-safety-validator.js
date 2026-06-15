'use strict';

const { validateSqlSafety } = require('../src/utils/sqlSafetyValidator');

// ─── Test cases ───────────────────────────────────────────────────────────────

const cases = [
  {
    id: 1,
    name: 'Plain SELECT',
    sql: 'SELECT * FROM students',
    expectSafe: true,
  },
  {
    id: 2,
    name: 'Lowercase select',
    sql: 'select * from students',
    expectSafe: true,
  },
  {
    id: 3,
    name: 'SELECT literal',
    sql: 'SELECT 1',
    expectSafe: true,
  },
  {
    id: 4,
    name: 'Plain CTE with SELECT',
    sql: 'WITH cte AS (SELECT 1) SELECT * FROM cte',
    expectSafe: true,
  },
  {
    id: 5,
    name: 'INSERT blocked',
    sql: "INSERT INTO students VALUES (1)",
    expectSafe:    false,
    expectKeyword: null,  // validStart fails before keyword scan
  },
  {
    id: 6,
    name: 'UPDATE blocked',
    sql: "UPDATE students SET name = 'x'",
    expectSafe:    false,
    expectKeyword: null,
  },
  {
    id: 7,
    name: 'DROP TABLE blocked',
    sql: 'DROP TABLE students',
    expectSafe:    false,
    expectKeyword: null,
  },
  {
    id: 8,
    name: 'DELETE FROM blocked',
    sql: 'DELETE FROM students',
    expectSafe:    false,
    expectKeyword: null,
  },
  {
    id: 9,
    name: 'Multi-statement — SELECT then DROP',
    sql: 'SELECT * FROM students; DROP TABLE students',
    expectSafe:    false,
    expectKeyword: 'DROP',
  },
  {
    id: 10,
    name: 'Destructive CTE — WITH ... DELETE',
    sql: 'WITH x AS (DELETE FROM students RETURNING *) SELECT * FROM x',
    expectSafe:    false,
    expectKeyword: 'DELETE',
  },
  {
    id: 11,
    name: "Conservative false positive — 'drop' inside string literal",
    sql: "SELECT 'drop table students'",
    expectSafe:    false,
    expectKeyword: 'DROP',
  },
  {
    id: 12,
    name: 'CREATE TABLE blocked',
    sql: 'CREATE TABLE foo (id int)',
    expectSafe:    false,
    expectKeyword: null,
  },
  {
    id: 13,
    name: 'TRUNCATE blocked',
    sql: 'TRUNCATE students',
    expectSafe:    false,
    expectKeyword: null,
  },
  {
    id: 14,
    name: 'GRANT blocked',
    sql: 'GRANT SELECT ON students TO public',
    expectSafe:    false,
    expectKeyword: null,
  },
  {
    id: 15,
    name: 'REVOKE blocked',
    sql: 'REVOKE ALL ON students FROM public',
    expectSafe:    false,
    expectKeyword: null,
  },
  {
    id: 16,
    name: "REPLACE in string literal — allowed (not a blocked keyword)",
    sql: "SELECT * FROM orders WHERE status = 'replace'",
    expectSafe: true,
  },
  {
    id: 17,
    name: 'REPLACE() function — allowed (valid read-only PostgreSQL function)',
    sql: "SELECT REPLACE(name, 'a', 'b') FROM students",
    expectSafe: true,
  },
  {
    id: 18,
    name: 'EXECUTE keyword blocked even as non-top-level',
    sql: 'SELECT EXECUTE(...)',
    expectSafe:    false,
    expectKeyword: 'EXECUTE',
  },
  {
    id: 19,
    name: 'Empty string blocked',
    sql: '',
    expectSafe: false,
  },
  {
    id: 20,
    name: 'EXPLAIN blocked (does not start with SELECT or WITH)',
    sql: 'EXPLAIN SELECT * FROM students',
    expectSafe: false,
  },
  {
    id: 21,
    name: 'COPY TO blocked',
    sql: "COPY students TO '/tmp/students.csv'",
    expectSafe:    false,
    expectKeyword: null,  // does not start with SELECT/WITH
  },
  {
    id: 22,
    name: 'Multi-statement — SELECT then COPY',
    sql: "SELECT * FROM students; COPY students TO '/tmp/students.csv'",
    expectSafe:    false,
    expectKeyword: 'COPY',
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const c of cases) {
  const result = validateSqlSafety(c.sql);
  const checks = [];

  checks.push({
    ok:  result.safe === c.expectSafe,
    msg: `safe should be ${c.expectSafe}, got ${result.safe}`,
  });

  if (c.expectSafe === false && c.expectKeyword) {
    const hasKeyword = typeof result.reason === 'string' &&
                       result.reason.includes(`Detected: ${c.expectKeyword}`);
    checks.push({
      ok:  hasKeyword,
      msg: `reason should mention "Detected: ${c.expectKeyword}", got: ${JSON.stringify(result.reason)}`,
    });
  }

  if (c.expectSafe === true) {
    checks.push({
      ok:  result.reason === undefined,
      msg: `reason should be undefined when safe, got: ${JSON.stringify(result.reason)}`,
    });
  }

  const allPass = checks.every(ch => ch.ok);
  console.log(`[${String(c.id).padStart(2, '0')}] ${allPass ? 'PASS' : 'FAIL'} — ${c.name}`);

  if (!allPass) {
    checks.filter(ch => !ch.ok).forEach(ch => console.log(`       ✗ ${ch.msg}`));
    failed++;
  } else {
    passed++;
  }
}

console.log('');
console.log(`Result: ${passed} passed, ${failed} failed.`);

if (failed > 0) process.exit(1);
