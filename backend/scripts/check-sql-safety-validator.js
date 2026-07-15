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
  {
    id: 23,
    name: 'SELECT * INTO blocked (creates a new table despite starting with SELECT)',
    sql: 'SELECT * INTO new_table FROM students;',
    expectSafe:    false,
    expectKeyword: 'INTO',
  },
  {
    id: 24,
    name: 'SELECT column INTO blocked',
    sql: 'SELECT name INTO temp_students FROM students;',
    expectSafe:    false,
    expectKeyword: 'INTO',
  },

  // ─── Single-statement enforcement (CRIT-1 fix) ─────────────────────────────
  // queryRunner.js runs raw SQL text with no parameters, which uses
  // node-postgres's simple-query protocol — the one path that executes
  // multiple `;`-separated statements in one call. These cases cover the
  // scanner in sqlSafetyValidator.js that rejects anything but a single
  // statement (with at most one optional trailing semicolon), including its
  // string/identifier/comment-aware semicolon handling.
  {
    id: 25,
    name: 'No semicolon at all — allowed',
    sql: 'SELECT 1',
    expectSafe: true,
  },
  {
    id: 26,
    name: 'One trailing semicolon — allowed',
    sql: 'SELECT 1;',
    expectSafe: true,
  },
  {
    id: 27,
    name: 'Trailing whitespace after the semicolon — allowed',
    sql: 'SELECT 1;   \n\t',
    expectSafe: true,
  },
  {
    id: 28,
    name: 'Stacked SELECT statements — rejected',
    sql: 'SELECT 1; SELECT 2',
    expectSafe:       false,
    expectSingleStmt: true,
  },
  {
    id: 29,
    name: 'Stacked pg_sleep statements (connection-pool-exhaustion shape) — rejected',
    sql: 'SELECT pg_sleep(4); SELECT pg_sleep(4);',
    expectSafe:       false,
    expectSingleStmt: true,
  },
  {
    id: 30,
    name: 'SELECT followed by SET — rejected (SET is not a blocked keyword on its own)',
    sql: 'SELECT 1; SET search_path TO public',
    expectSafe:       false,
    expectSingleStmt: true,
  },
  {
    id: 31,
    name: 'Double trailing semicolon — rejected',
    sql: 'SELECT 1;;',
    expectSafe:       false,
    expectSingleStmt: true,
  },
  {
    id: 32,
    name: 'CTE followed by a second statement — rejected',
    sql: 'WITH x AS (SELECT 1) SELECT * FROM x; SELECT 2',
    expectSafe:       false,
    expectSingleStmt: true,
  },
  {
    id: 33,
    name: 'Semicolon inside a single-quoted string literal — not a separator, allowed',
    sql: "SELECT 'a;b';",
    expectSafe: true,
  },
  {
    id: 34,
    name: 'Semicolon inside a double-quoted identifier — not a separator, allowed',
    sql: 'SELECT "column;name" FROM some_table;',
    expectSafe: true,
  },
  {
    id: 35,
    name: 'Semicolon inside a -- line comment — not a separator, allowed',
    sql: 'SELECT 1 -- comment with a ; in it\n',
    expectSafe: true,
  },
  {
    id: 36,
    name: 'Semicolon inside a /* */ block comment — not a separator, allowed',
    sql: 'SELECT 1 /* comment with a ; in it */',
    expectSafe: true,
  },
  {
    id: 37,
    name: 'A real second statement hidden after a comment is still rejected',
    sql: 'SELECT 1 /* just a comment */; SELECT 2',
    expectSafe:       false,
    expectSingleStmt: true,
  },
  {
    id: 38,
    name: 'An escaped quote inside a string literal does not end it early — semicolon after is still top-level',
    sql: "SELECT 'it''s; fine' FROM students; SELECT 2",
    expectSafe:       false,
    expectSingleStmt: true,
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

  if (c.expectSafe === false && c.expectSingleStmt) {
    checks.push({
      ok:  result.reason === 'Only one SQL statement is allowed.',
      msg: `reason should be "Only one SQL statement is allowed.", got: ${JSON.stringify(result.reason)}`,
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
