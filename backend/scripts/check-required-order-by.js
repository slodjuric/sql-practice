'use strict';

const { validateRequiredOrderBy, isOrderByRequired } = require('../src/utils/sqlStructureValidator');

// ─── isOrderByRequired unit tests ─────────────────────────────────────────────

const taskCases = [
  {
    id: 'T01',
    name: 'topicId=sorting always requires ORDER BY',
    task: { topicId: 'sorting', description: 'Show subjects.', hint: '' },
    expected: true,
  },
  {
    id: 'T02',
    name: 'requiresOrderBy=true flag overrides topic',
    task: { topicId: 'join', description: 'Show names.', hint: '', requiresOrderBy: true },
    expected: true,
  },
  {
    id: 'T03',
    name: 'Serbian keyword "Sortiraj" in description',
    task: { topicId: 'group-by-having', description: 'Sortiraj po broju studenata opadajuće.', hint: '' },
    expected: true,
  },
  {
    id: 'T04',
    name: 'Serbian keyword "sortirane" in description',
    task: { topicId: 'join', description: 'Prikaži predmete sortirane po ECTS bodovima.', hint: '' },
    expected: true,
  },
  {
    id: 'T05',
    name: 'English keyword "sort" in description',
    task: { topicId: 'subqueries', description: 'Show subjects. Sort by name ascending.', hint: '' },
    expected: true,
  },
  {
    id: 'T06',
    name: 'English keyword "sorted" in description',
    task: { topicId: 'join', description: 'Show professors sorted alphabetically.', hint: '' },
    expected: true,
  },
  {
    id: 'T07',
    name: 'Serbian keyword "opadajuće" in description',
    task: { topicId: 'group-by-having', description: 'Prikaži fakultete. Sortiraj broj studenata opadajuće.', hint: '' },
    expected: true,
  },
  {
    id: 'T08',
    name: 'Serbian keyword "poređaj" in description',
    task: { topicId: 'where', description: 'Poređaj studente po prezimenu.', hint: '' },
    expected: true,
  },
  {
    id: 'T09',
    name: 'Hint contains "ORDER BY" keyword',
    task: { topicId: 'join', description: 'Show all students.', hint: 'Koristi ORDER BY last_name ASC' },
    expected: true,
  },
  {
    id: 'T10',
    name: 'Hint contains "DESC" SQL keyword',
    task: { topicId: 'group-by-having', description: 'Show faculty counts.', hint: 'Koristi ORDER BY count DESC' },
    expected: true,
  },
  {
    id: 'T11',
    name: 'topicId=join, no sort keywords — ORDER BY is for determinism only',
    task: { topicId: 'join', description: 'Prikaži ime i prezime studenta i naziv departmana.', hint: 'Koristi INNER JOIN' },
    expected: false,
  },
  {
    id: 'T12',
    name: 'topicId=group-by-having, no sort keywords — ORDER BY is for determinism only',
    task: { topicId: 'group-by-having', description: 'Prikaži professor_id i broj predmeta.', hint: 'Koristi GROUP BY i HAVING' },
    expected: false,
  },
  {
    id: 'T13',
    name: 'topicId=subqueries, no sort keywords — ORDER BY is for determinism only',
    task: { topicId: 'subqueries', description: 'Prikaži predmete koji nikad nisu bili na ispitu.', hint: 'Koristi NOT EXISTS ili LEFT JOIN' },
    expected: false,
  },
  {
    id: 'T14',
    name: 'task object is null — safe default false',
    task: null,
    expected: false,
  },
  {
    id: 'T15',
    name: 'task object is empty — safe default false',
    task: {},
    expected: false,
  },
  {
    id: 'T16',
    name: '"rang" keyword: window-function ranking task correctly required',
    task: { topicId: 'window-functions', description: 'Rangiraj studente od najboljeg ka najlošijem. Prikaži rang.', hint: 'RANK() OVER(PARTITION BY dept ORDER BY avg_grade DESC)' },
    expected: true,
  },
  {
    id: 'T17',
    name: 'OVER(ORDER BY …) in hint only — not a sort directive for final output',
    task: { topicId: 'window-functions', description: 'Za svaki ispit prikaži ocenu s narednog ispita.', hint: 'LEAD(grade) OVER(PARTITION BY student_id ORDER BY exam_date)' },
    expected: false,
  },
  {
    id: 'T18',
    name: 'OVER(ORDER BY …) with ROWS frame in hint — not a sort directive for final output',
    task: { topicId: 'window-functions', description: 'Prikaži kumulativni prosek ocena.', hint: 'AVG(grade) OVER(PARTITION BY student_id ORDER BY exam_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)' },
    expected: false,
  },
  {
    id: 'T19',
    name: '"asc" word boundary — does not match inside "ascending" as a prefix check',
    task: { topicId: 'join', description: 'Show results in ascending order.', hint: '' },
    expected: true,  // "ascending" does not match /\basc\b/ — but "ascending" matches /\bascending\b/ → still required
  },
  {
    id: 'T20',
    name: '"desc" word boundary — does not match inside "description"',
    task: { topicId: 'join', description: 'Show the description of each subject.', hint: 'No sorting needed.' },
    expected: false,
  },
];

// ─── validateRequiredOrderBy integration tests ────────────────────────────────

const SQL_WITH_ORDER    = 'SELECT * FROM exams ORDER BY grade DESC';
const SQL_WITHOUT_ORDER = 'SELECT * FROM exams';
const SQL_CTE_WITH      = 'WITH cte AS (SELECT * FROM exams) SELECT * FROM cte ORDER BY grade DESC';
const SQL_CTE_WITHOUT   = 'WITH cte AS (SELECT * FROM exams) SELECT * FROM cte';
const SQL_WINDOW_ONLY   = 'SELECT RANK() OVER(ORDER BY grade DESC) FROM exams';

const integrationCases = [
  {
    id: 'I01',
    name: 'Sorting task: user omits ORDER BY → missing_order_by',
    task: { topicId: 'sorting', description: 'Prikaži predmete sortirane po ECTS.', hint: '' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: false, reason: 'missing_order_by' },
  },
  {
    id: 'I02',
    name: 'Sorting task: user includes ORDER BY → valid',
    task: { topicId: 'sorting', description: 'Prikaži predmete sortirane po ECTS.', hint: '' },
    user: SQL_WITH_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: true },
  },
  {
    id: 'I03',
    name: 'Sorting task: user has ORDER BY with wrong direction — only presence checked → valid',
    task: { topicId: 'sorting', description: 'Prikaži predmete sortirane po ECTS.', hint: '' },
    user: 'SELECT * FROM exams ORDER BY grade ASC',
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: true },
  },
  {
    id: 'I04',
    name: 'Non-sorting join task: user omits ORDER BY, no sort keywords → valid (determinism-only)',
    task: { topicId: 'join', description: 'Prikaži ime i naziv departmana.', hint: 'Koristi INNER JOIN' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: true },
  },
  {
    id: 'I05',
    name: 'Non-sorting group-by task: "Sortiraj" in description → missing_order_by',
    task: { topicId: 'group-by-having', description: 'Prikaži broj studenata po fakultetu. Sortiraj opadajuće.', hint: '' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: false, reason: 'missing_order_by' },
  },
  {
    id: 'I06',
    name: 'requiresOrderBy=true flag: user omits ORDER BY → missing_order_by',
    task: { topicId: 'subqueries', description: 'Prikaži studente.', hint: '', requiresOrderBy: true },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: false, reason: 'missing_order_by' },
  },
  {
    id: 'I07',
    name: 'Non-sorting task: no sort keywords, neither has ORDER BY → valid',
    task: { topicId: 'subqueries', description: 'Prikaži predmete koji nisu na ispitu.', hint: 'Koristi NOT EXISTS' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITHOUT_ORDER,
    expected: { isStructurallyValid: true },
  },
  {
    id: 'I08',
    name: 'CTE: sorting task, user omits top-level ORDER BY → missing_order_by',
    task: { topicId: 'sorting', description: 'Prikaži sortirane predmete.', hint: '' },
    user: SQL_CTE_WITHOUT,
    sol:  SQL_CTE_WITH,
    expected: { isStructurallyValid: false, reason: 'missing_order_by' },
  },
  {
    id: 'I09',
    name: 'Window fn: sorting task, user ORDER BY only inside OVER() → missing_order_by',
    task: { topicId: 'sorting', description: 'Sortiraj predmete.', hint: '' },
    user: SQL_WINDOW_ONLY,
    sol:  'SELECT RANK() OVER(ORDER BY grade DESC) FROM exams ORDER BY 1',
    expected: { isStructurallyValid: false, reason: 'missing_order_by' },
  },
  {
    id: 'I10',
    name: 'No task passed (undefined): safe default → valid',
    task: undefined,
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: true },
  },
  {
    id: 'I11',
    name: 'English "sort" keyword: user omits ORDER BY → missing_order_by',
    task: { topicId: 'data-analysis', description: 'Show all students. Sort by last name.', hint: '' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: false, reason: 'missing_order_by' },
  },
  {
    id: 'I12',
    name: 'English "ordered" keyword in description: user omits ORDER BY → missing_order_by',
    task: { topicId: 'join', description: 'Show professors ordered alphabetically.', hint: '' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: false, reason: 'missing_order_by' },
  },
  {
    id: 'I13',
    name: 'Serbian "rastuće" keyword: user omits ORDER BY → missing_order_by',
    task: { topicId: 'where', description: 'Prikaži studente sortirane rastuće po imenu.', hint: '' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: false, reason: 'missing_order_by' },
  },
  {
    id: 'I14',
    name: 'Non-sorting task: data-analysis, no sort keywords, user omits ORDER BY → valid',
    task: { topicId: 'data-analysis', description: 'Pronađi studente koji nisu izašli na ispit.', hint: 'Koristi NOT EXISTS' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: true },
  },
  {
    id: 'I15',
    name: 'Non-sorting task: window-functions, no sort keywords, user omits ORDER BY → valid',
    task: { topicId: 'window-functions', description: 'Za svaki ispit prikaži ocenu i ukupan prosek.', hint: 'Koristi AVG() OVER()' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: true },
  },
  {
    id: 'I16',
    name: 'LEAD task: OVER(ORDER BY) in hint only — omitting top-level ORDER BY is valid',
    task: { topicId: 'window-functions', description: 'Za svaki ispit prikaži ocenu s narednog ispita. Za posljednji ispit NULL.', hint: 'LEAD(grade) OVER(PARTITION BY student_id ORDER BY exam_date) vraća sljedeći red.' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: true },
  },
  {
    id: 'I17',
    name: 'COUNT OVER task: cumulative count uses OVER(ORDER BY) — omitting top-level ORDER BY is valid',
    task: { topicId: 'window-functions', description: 'Prikaži kumulativni broj ispita tog studenta do tog trenutka. Koristi COUNT() OVER() s ORDER BY.', hint: 'COUNT(*) OVER(PARTITION BY student_id ORDER BY exam_date) — kad ima ORDER BY, podrazumijevani okvir je RANGE.' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: true },
  },
  {
    id: 'I18',
    name: 'AVG OVER with ROWS frame in hint: no top-level ORDER BY requirement',
    task: { topicId: 'window-functions', description: 'Prikaži kumulativni prosek ocena do tog ispita.', hint: 'AVG(grade) OVER(PARTITION BY student_id ORDER BY exam_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: true },
  },
  {
    id: 'I19',
    name: 'Ranking task with "rang" keyword: user omits top-level ORDER BY → missing_order_by',
    task: { topicId: 'window-functions', description: 'Rangiraj sve studente od najboljeg ka najlošijem. Prikaži ime, prosek i rang.', hint: 'CTE za proseke. RANK() OVER(ORDER BY avg_grade DESC) na CTE rezultatu.' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: false, reason: 'missing_order_by' },
  },
  {
    id: 'I20',
    name: '"desc" word boundary: "description" in task text does not trigger ORDER BY requirement',
    task: { topicId: 'join', description: 'Show the description of each subject.', hint: 'No sorting needed.' },
    user: SQL_WITHOUT_ORDER,
    sol:  SQL_WITH_ORDER,
    expected: { isStructurallyValid: true },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

console.log('── isOrderByRequired ──────────────────────────────────────────────');
for (const c of taskCases) {
  const result = isOrderByRequired(c.task);
  const ok = result === c.expected;
  console.log(`[${c.id}] ${ok ? 'PASS' : 'FAIL'} — ${c.name}`);
  if (!ok) {
    console.log(`       Expected: ${c.expected}`);
    console.log(`       Got:      ${result}`);
    failed++;
  } else {
    passed++;
  }
}

console.log('');
console.log('── validateRequiredOrderBy ────────────────────────────────────────');
for (const c of integrationCases) {
  const result = validateRequiredOrderBy(c.user, c.sol, c.task);
  const validOk  = result.isStructurallyValid === c.expected.isStructurallyValid;
  const reasonOk = c.expected.reason === undefined || result.reason === c.expected.reason;
  const ok = validOk && reasonOk;
  console.log(`[${c.id}] ${ok ? 'PASS' : 'FAIL'} — ${c.name}`);
  if (!ok) {
    console.log(`       Expected: valid=${c.expected.isStructurallyValid}, reason=${c.expected.reason ?? 'any'}`);
    console.log(`       Got:      valid=${result.isStructurallyValid}, reason=${result.reason}`);
    failed++;
  } else {
    passed++;
  }
}

console.log('');
console.log(`Result: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
