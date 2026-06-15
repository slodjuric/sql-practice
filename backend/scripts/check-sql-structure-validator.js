'use strict';

const { validateSqlStructure } = require('../src/utils/sqlStructureValidator');

// ─── Test cases ───────────────────────────────────────────────────────────────

const cases = [
  {
    id: 1,
    name: 'Exact simple WHERE match',
    user: 'SELECT * FROM subjects WHERE ects >= 6;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 2,
    name: 'Case and whitespace normalization',
    user: 'select *   from subjects   where   ects >= 6;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 3,
    name: 'Alias normalization (s.ects → ects)',
    user: 'SELECT * FROM subjects s WHERE s.ects >= 6;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 4,
    name: 'Extra AND condition',
    user: 'SELECT * FROM subjects WHERE ects >= 6 AND ects <= 8;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  false,
    expectReason: 'extra_where_condition',
  },
  {
    id: 5,
    name: 'Missing WHERE entirely',
    user: 'SELECT * FROM subjects;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  false,
    expectReason: 'missing_where_condition',
  },
  {
    id: 6,
    name: 'Extra WHERE (user has WHERE, solution does not)',
    user: 'SELECT * FROM subjects WHERE ects >= 6;',
    sol:  'SELECT * FROM subjects;',
    expectValid:  false,
    expectReason: 'extra_where_condition',
  },
  {
    id: 7,
    name: 'Extra LIMIT not in solution',
    user: 'SELECT * FROM subjects WHERE ects >= 6 LIMIT 10;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  false,
    expectReason: 'extra_limit',
  },
  {
    id: 8,
    name: 'LIMIT allowed when solution also has LIMIT',
    user: 'SELECT * FROM subjects LIMIT 5;',
    sol:  'SELECT * FROM subjects LIMIT 5;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 9,
    name: 'Extra ORDER BY not in solution',
    user: 'SELECT * FROM subjects WHERE ects >= 6 ORDER BY name;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  false,
    expectReason: 'extra_order_by',
  },
  {
    id: 10,
    name: 'ORDER BY allowed when solution also has ORDER BY',
    user: 'SELECT * FROM subjects WHERE ects >= 6 ORDER BY name;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6 ORDER BY name;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 11,
    name: 'Extra DISTINCT not in solution',
    user: 'SELECT DISTINCT city FROM faculties;',
    sol:  'SELECT city FROM faculties;',
    expectValid:  false,
    expectReason: 'extra_distinct',
  },
  {
    id: 12,
    name: 'DISTINCT allowed when solution also uses DISTINCT',
    user: 'SELECT DISTINCT city FROM faculties;',
    sol:  'SELECT DISTINCT city FROM faculties;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 13,
    name: 'Fallback for BETWEEN',
    user: 'SELECT * FROM exams WHERE grade BETWEEN 8 AND 10;',
    sol:  'SELECT * FROM exams WHERE grade BETWEEN 8 AND 10;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 14,
    name: 'Fallback for IN',
    user: 'SELECT * FROM subjects WHERE semester IN (1, 2, 3);',
    sol:  'SELECT * FROM subjects WHERE semester IN (1, 2, 3);',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 15,
    name: 'Fallback for top-level OR',
    user: 'SELECT * FROM exams WHERE grade = 10 OR grade = 9;',
    sol:  'SELECT * FROM exams WHERE grade = 10 OR grade = 9;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 16,
    name: "AND inside string literal must not be treated as condition separator",
    user: "SELECT * FROM subjects WHERE name = 'Research and Development';",
    sol:  "SELECT * FROM subjects WHERE name = 'Research and Development';",
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 17,
    name: 'Alias stripping must not touch decimal numbers (8.5)',
    user: 'SELECT * FROM exams WHERE grade >= 8.5;',
    sol:  'SELECT * FROM exams WHERE grade >= 8.5;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 18,
    name: 'AND condition order should not matter',
    user: 'SELECT * FROM subjects WHERE semester = 1 AND ects >= 6;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6 AND semester = 1;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 19,
    name: 'Condition mismatch — > vs >= on same column, different value',
    user: 'SELECT * FROM subjects WHERE ects > 5;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  false,
    expectReason: 'condition_mismatch',
  },
  {
    id: 20,
    name: 'Condition mismatch — same operator, different numeric value',
    user: 'SELECT * FROM subjects WHERE ects >= 5;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  false,
    expectReason: 'condition_mismatch',
  },
  {
    id: 21,
    name: 'Condition mismatch — < vs <= on same column',
    user: 'SELECT * FROM exams WHERE grade < 8;',
    sol:  'SELECT * FROM exams WHERE grade <= 7;',
    expectValid:  false,
    expectReason: 'condition_mismatch',
  },
  {
    id: 22,
    name: 'Condition mismatch — same column, different string value',
    user: "SELECT * FROM professors WHERE last_name = 'Nikolic';",
    sol:  "SELECT * FROM professors WHERE last_name = 'Petrovic';",
    expectValid:  false,
    expectReason: 'condition_mismatch',
  },
  {
    id: 23,
    name: 'Condition mismatch inside multi-AND — one condition swapped, one exact match',
    user: 'SELECT * FROM subjects WHERE ects > 5 AND semester = 1;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6 AND semester = 1;',
    expectValid:  false,
    expectReason: 'condition_mismatch',
  },
  {
    id: 24,
    name: 'Condition mismatch — both AND conditions swapped',
    user: 'SELECT * FROM exams WHERE ects > 5 AND grade < 8;',
    sol:  'SELECT * FROM exams WHERE ects >= 6 AND grade <= 7;',
    expectValid:  false,
    expectReason: 'condition_mismatch',
  },
  {
    id: 25,
    name: '!= normalized to <> — should be treated as identical, not a mismatch',
    user: 'SELECT * FROM students WHERE enrollment_year != 2022;',
    sol:  'SELECT * FROM students WHERE enrollment_year <> 2022;',
    expectValid:  true,
    expectReason: null,
  },
  {
    id: 26,
    name: 'Different column must not trigger condition_mismatch',
    user: 'SELECT * FROM subjects WHERE grade > 8;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  false,
    expectReason: 'extra_where_condition',
  },
  {
    id: 27,
    name: 'Extra condition added plus one changed — lengths differ, must fall through to extra_where_condition',
    user: 'SELECT * FROM subjects WHERE ects > 5 AND semester = 1;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  false,
    expectReason: 'extra_where_condition',
  },
  {
    id: 28,
    name: 'Reversed comparison equivalent — "6 <= ects" same as "ects >= 6"',
    user: 'SELECT * FROM subjects WHERE 6 <= ects;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid:  true,
    expectReason: null,
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const c of cases) {
  const result = validateSqlStructure(c.user, c.sol, c.task || {});

  const validOk  = result.isStructurallyValid === c.expectValid;
  const reasonOk = result.reason === (c.expectReason ?? null);

  const ok = validOk && reasonOk;

  const label = ok ? 'PASS' : 'FAIL';
  console.log(`[${String(c.id).padStart(2, '0')}] ${label} — ${c.name}`);

  if (!ok) {
    console.log(`       Expected: isStructurallyValid=${c.expectValid}, reason=${JSON.stringify(c.expectReason ?? null)}`);
    console.log(`       Got:      isStructurallyValid=${result.isStructurallyValid}, reason=${JSON.stringify(result.reason)}`);
    if (result.hint) {
      console.log(`       Hint:     ${result.hint}`);
    }
    failed++;
  } else {
    passed++;
  }
}

console.log('');
console.log(`Result: ${passed} passed, ${failed} failed.`);

if (failed > 0) {
  process.exit(1);
}
