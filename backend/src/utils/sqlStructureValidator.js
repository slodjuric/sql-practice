'use strict';

// ─── Hints ────────────────────────────────────────────────────────────────────

const HINTS = {
  extra_where_condition:   'Check your WHERE clause — you may have added a condition that makes the result too restrictive.',
  missing_where_condition: 'Check your WHERE clause — a required filter condition seems to be missing.',
  condition_mismatch:      'Check the comparison operator or value in your WHERE clause.',
  extra_distinct:          'The task does not require DISTINCT. Check if removing it still gives the correct result.',
  extra_order_by:          'The task does not ask you to sort the results. Check if ORDER BY is needed here.',
  extra_limit:             'The task does not ask you to limit the number of rows. Remove the LIMIT clause.',
  missing_order_by:        'Check whether the task asks you to sort the results.',
};

const VALID = { isStructurallyValid: true, reason: null, hint: null };

// Checked in priority order — multi-word phrases must precede their prefixes
// so that e.g. "order by" is matched before a bare "order" could be.
const CLAUSE_MARKERS = [
  'left outer join', 'right outer join', 'full outer join',
  'left join', 'right join', 'full join',
  'inner join', 'cross join',
  'order by', 'group by',
  'union all',
  'having', 'where', 'from', 'select',
  'limit', 'offset',
  'union', 'intersect', 'except',
  'join',
];

// ─── Normalization ────────────────────────────────────────────────────────────

// Produces a canonical lowercase single-spaced SQL string with comments and
// trailing semicolons removed. String literal contents are preserved verbatim.
function normalize(sql) {
  let s = String(sql || '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');  // block comments
  s = s.replace(/--[^\n]*/g, ' ');           // line comments
  s = s.replace(/;\s*$/, '');                // trailing semicolon
  s = s.toLowerCase();
  s = s.replace(/!=/g, '<>');             // PostgreSQL != and <> are identical
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Strips simple table/alias prefixes from qualified column references outside
// string literals: "s.ects" → "ects", "professors.last_name" → "last_name".
// Only strips identifier.identifier patterns (requires leading [a-z_], not digits),
// so numeric literals like "2022.01" are never touched.
function stripAliases(sql) {
  let result = '';
  let i = 0;
  let inStr = false;
  const n = sql.length;

  while (i < n) {
    if (inStr) {
      // PostgreSQL escapes an embedded quote as '' — skip both characters.
      if (sql[i] === "'" && sql[i + 1] === "'") {
        result += "''";
        i += 2;
        continue;
      }
      if (sql[i] === "'") inStr = false;
      result += sql[i++];
      continue;
    }

    if (sql[i] === "'") {
      inStr = true;
      result += sql[i++];
      continue;
    }

    // Match alias.column only at a word boundary (preceded by whitespace or operator).
    if (i === 0 || /[\s,(=<>!+\-*/]/.test(sql[i - 1])) {
      const m = sql.slice(i).match(/^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/);
      if (m) {
        result += m[2]; // keep only the column part, drop "alias."
        i += m[0].length;
        continue;
      }
    }

    result += sql[i++];
  }
  return result;
}

// ─── Clause extraction ────────────────────────────────────────────────────────

// Scans a normalized SQL string and records the start position of every top-level
// clause keyword (depth 0 only — keywords inside subquery parens are ignored).
// Returns an array of { keyword, start } sorted ascending by start.
function findTopLevelClauses(sql) {
  const n = sql.length;
  const found = [];
  let depth = 0;
  let inStr = false;
  let i = 0;

  while (i < n) {
    const ch = sql[i];

    if (inStr) {
      if (ch === "'" && sql[i + 1] === "'") { i += 2; continue; }
      if (ch === "'") inStr = false;
      i++;
      continue;
    }
    if (ch === "'") { inStr = true; i++; continue; }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth--; i++; continue; }

    if (depth === 0) {
      // Only match at a word boundary: start of string or preceded by space/comma/paren.
      const atBoundary = i === 0 || /[\s,)]/.test(sql[i - 1]);
      if (atBoundary) {
        let matched = false;
        for (const kw of CLAUSE_MARKERS) {
          if (sql.startsWith(kw, i)) {
            const afterKw = i + kw.length;
            // Keyword must be followed by whitespace, '(', or end of string.
            if (afterKw >= n || /[\s(]/.test(sql[afterKw])) {
              found.push({ keyword: kw, start: i });
              i += kw.length; // jump past the keyword itself
              matched = true;
              break;
            }
          }
        }
        if (!matched) i++;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  found.sort((a, b) => a.start - b.start);
  return found;
}

// Returns the text content of a clause (the text after its keyword and before the
// next top-level clause). Returns null if the keyword was not found.
function clauseContent(keyword, found, sql) {
  const entry = found.find(f => f.keyword === keyword);
  if (!entry) return null;
  const contentStart = entry.start + keyword.length;
  const later = found
    .filter(f => f.start > entry.start)
    .sort((a, b) => a.start - b.start);
  const contentEnd = later.length > 0 ? later[0].start : sql.length;
  return sql.slice(contentStart, contentEnd).trim();
}

// ─── WHERE condition splitting ────────────────────────────────────────────────

// Splits a WHERE clause body by top-level AND (respecting string literals and
// parenthesis depth so that e.g. function arguments are not split).
// Returns a deduplicated array of trimmed condition strings.
function splitAndConditions(whereClause) {
  const conditions = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  let i = 0;
  const n = whereClause.length;

  while (i < n) {
    const ch = whereClause[i];

    if (inStr) {
      if (ch === "'" && whereClause[i + 1] === "'") { i += 2; continue; }
      if (ch === "'") inStr = false;
      i++;
      continue;
    }
    if (ch === "'") { inStr = true; i++; continue; }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth--; i++; continue; }

    // Top-level AND is always surrounded by single spaces after normalization.
    if (depth === 0 && whereClause.startsWith(' and ', i)) {
      conditions.push(whereClause.slice(start, i).trim());
      i += 5; // skip ' and '
      start = i;
      continue;
    }
    i++;
  }

  const last = whereClause.slice(start).trim();
  if (last) conditions.push(last);

  return conditions.filter(c => c.length > 0);
}

// ─── Fallback detection ───────────────────────────────────────────────────────

// Returns true when a normalized SQL opens with WITH (CTE).
function isCTE(normalizedSql) {
  return /^with\b/.test(normalizedSql);
}

// Returns true when a WHERE clause body contains patterns that are too complex
// for simple string-based condition comparison:
//   BETWEEN, IN/NOT IN, IS [NOT] NULL, ILIKE, nested SELECT.
// Callers should skip structural validation and return VALID when this is true.
function requiresFallback(whereText) {
  if (!whereText) return false;
  return (
    /\bbetween\b/.test(whereText) ||
    /\b(not\s+)?in\s*\(/.test(whereText) ||
    /\bis(\s+not)?\s+null\b/.test(whereText) ||
    /\bilike\b/.test(whereText) ||
    /\bselect\b/.test(whereText)   // nested subquery
  );
}

// Returns true when a WHERE clause body contains a top-level OR
// (i.e. OR at paren depth 0, outside string literals).
function hasTopLevelOr(whereText) {
  if (!whereText) return false;
  let depth = 0;
  let inStr = false;
  let i = 0;
  const n = whereText.length;

  while (i < n) {
    const ch = whereText[i];
    if (inStr) {
      if (ch === "'" && whereText[i + 1] === "'") { i += 2; continue; }
      if (ch === "'") inStr = false;
      i++;
      continue;
    }
    if (ch === "'") { inStr = true; i++; continue; }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth--; i++; continue; }
    // Top-level OR is always surrounded by spaces after normalization.
    if (depth === 0 && whereText.startsWith(' or ', i)) return true;
    i++;
  }
  return false;
}

// ─── Simple condition parsing ─────────────────────────────────────────────────

// Parses a single normalized, alias-stripped condition of the form:
//   column op value   (normal)
//   value  op column  (reversed — flips the operator to canonical direction)
//
// Supported operators: =  <>  >  >=  <  <=
// Supported values: numeric literals (including decimals and negatives) and
//                   single-quoted strings (with PostgreSQL '' escaping).
//
// Returns { column, operator, value } on success, or null if the condition is
// too complex to parse safely (functions, CAST, LIKE, subqueries, etc.).
function parseSimpleCondition(cond) {
  const FLIP  = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '<>': '<>' };
  const NUM   = '-?\\d+(?:\\.\\d+)?';
  const STR   = "'(?:[^']|'')*'";
  const VAL   = `(?:${NUM}|${STR})`;
  const IDENT = '[a-z_][a-z0-9_]*';
  // Longer operators must be listed first so <> / >= / <= are not partially matched.
  const OP    = '(?:<>|>=|<=|>|<|=)';

  // Normal form: column op value
  const m1 = cond.match(new RegExp(`^(${IDENT})\\s*(${OP})\\s*(${VAL})$`));
  if (m1) return { column: m1[1], operator: m1[2], value: m1[3] };

  // Reversed form: value op column  →  flip operator so column is always on the left.
  // Example: "6 <= ects"  →  { column: 'ects', operator: '>=', value: '6' }
  const m2 = cond.match(new RegExp(`^(${VAL})\\s*(${OP})\\s*(${IDENT})$`));
  if (m2) {
    const flipped = FLIP[m2[2]];
    if (flipped === undefined) return null;
    return { column: m2[3], operator: flipped, value: m2[1] };
  }

  return null;
}

// Returns true when every extra condition can be paired with a missing condition
// that is on the same column — indicating the user wrote the same filter concept
// but with a different operator or threshold, rather than adding/removing conditions.
//
// Both arrays contain canonical condition strings (produced by toCanon inside
// validateSqlStructure). Any condition that parseSimpleCondition cannot parse
// causes an immediate false return (conservative: when in doubt, fall through to
// the existing extra/missing error).
function detectConditionMismatch(extraConds, missingConds) {
  for (const ec of extraConds) {
    const ep = parseSimpleCondition(ec);
    if (!ep) return false;

    const hasSameColumn = missingConds.some(mc => {
      const mp = parseSimpleCondition(mc);
      return mp !== null && mp.column === ep.column;
    });
    if (!hasSameColumn) return false;
  }
  return true;
}

// ─── Main export ──────────────────────────────────────────────────────────────

function invalid(reason) {
  return { isStructurallyValid: false, reason, hint: HINTS[reason] };
}

/**
 * Validates that a user's SQL query is structurally consistent with the reference
 * solution. This is called only after compareResults already confirmed the result
 * sets match — it guards against queries that accidentally return correct rows but
 * use logically different (over- or under-constrained) SQL.
 *
 * @param {string} userSql      - The SQL the student submitted.
 * @param {string} solutionSql  - The reference solution from tasks.json.
 * @param {object} task         - The task object; may carry validationMode override.
 *
 * @returns {{ isStructurallyValid: boolean, reason: string|null, hint: string|null }}
 *
 * Always returns VALID when the query contains patterns that are too complex for
 * simple string comparison (OR, BETWEEN, IN, IS NULL, ILIKE, subqueries, CTEs).
 * The validator is conservative by design: when in doubt, it accepts.
 */
function validateSqlStructure(userSql, solutionSql, task = {}) {
  // Per-task opt-out — tasks that legitimately accept multiple valid forms.
  if (task.validationMode === 'result_only') return VALID;

  const userNorm = stripAliases(normalize(userSql));
  const solNorm  = stripAliases(normalize(solutionSql));

  // CTEs are too varied in structure to compare reliably.
  if (isCTE(userNorm) || isCTE(solNorm)) return VALID;

  const userFound = findTopLevelClauses(userNorm);
  const solFound  = findTopLevelClauses(solNorm);

  const userWhere = clauseContent('where', userFound, userNorm);
  const solWhere  = clauseContent('where', solFound,  solNorm);

  // If either WHERE clause contains complex patterns, skip structural checks.
  if (requiresFallback(userWhere) || requiresFallback(solWhere)) return VALID;
  if (hasTopLevelOr(userWhere)    || hasTopLevelOr(solWhere))    return VALID;

  // A) DISTINCT
  // Only flag when the user added DISTINCT that the solution does not use.
  const userHasDistinct = /^select\s+distinct\b/.test(userNorm);
  const solHasDistinct  = /^select\s+distinct\b/.test(solNorm);
  if (userHasDistinct && !solHasDistinct) return invalid('extra_distinct');

  // B) WHERE presence
  if (!userWhere && solWhere)  return invalid('missing_where_condition');
  if (userWhere  && !solWhere) return invalid('extra_where_condition');

  // C) WHERE conditions — compare sets of top-level AND conditions.
  // Condition order is irrelevant; only presence/absence matters.
  if (userWhere && solWhere) {
    const userConds = splitAndConditions(userWhere);
    const solConds  = splitAndConditions(solWhere);

    // Canonicalize each condition so that semantically equivalent forms compare
    // as equal strings: "6 <= ects" and "ects >= 6" both become "ects >= 6".
    // Conditions that parseSimpleCondition cannot handle are kept as-is.
    const toCanon = cond => {
      const p = parseSimpleCondition(cond);
      return p ? `${p.column} ${p.operator} ${p.value}` : cond;
    };
    const userCanon = userConds.map(toCanon);
    const solCanon  = solConds.map(toCanon);

    const extra   = userCanon.filter(uc => !solCanon.includes(uc));
    const missing = solCanon.filter(sc => !userCanon.includes(sc));

    // Before reporting extra/missing, check whether the discrepancy is a
    // condition mismatch: same number of "wrong" conditions, each on the same
    // column as its counterpart. This covers operator differences (> vs >=) and
    // threshold differences (ects >= 5 vs ects >= 6).
    if (extra.length === missing.length && extra.length > 0) {
      if (detectConditionMismatch(extra, missing)) return invalid('condition_mismatch');
    }

    if (extra.length   > 0) return invalid('extra_where_condition');
    if (missing.length > 0) return invalid('missing_where_condition');
  }

  // D) ORDER BY — compare against solution's actual clauses, not task.topicId.
  // Many WHERE-topic tasks include ORDER BY in their solution for determinism.
  const userOrderBy = clauseContent('order by', userFound, userNorm);
  const solOrderBy  = clauseContent('order by', solFound,  solNorm);
  if (userOrderBy !== null && solOrderBy === null) return invalid('extra_order_by');

  // E) LIMIT — compare against solution's actual clauses.
  const userHasLimit = userFound.some(f => f.keyword === 'limit');
  const solHasLimit  = solFound.some(f  => f.keyword === 'limit');
  if (userHasLimit && !solHasLimit) return invalid('extra_limit');

  return VALID;
}

// Returns true when a SQL string contains a top-level ORDER BY clause —
// i.e. ORDER BY at paren depth 0, not inside a subquery, CTE body, or OVER().
function hasTopLevelOrderBy(sql) {
  const found = findTopLevelClauses(normalize(sql || ''));
  return found.some(clause => clause.keyword === 'order by');
}

// Backward-compatible alias used by the check route for orderMatters detection.
function solutionHasTopLevelOrderBy(sql) {
  return hasTopLevelOrderBy(sql);
}

// ─── Order-by requirement detection ──────────────────────────────────────────

// Patterns that signal the task explicitly asks the learner to sort the output.
// Matched against the concatenated description + hint (lowercased).
//
// "/\border by\b/" is intentionally ABSENT. Window-function hints regularly
// contain "OVER(PARTITION BY … ORDER BY …)" — that ORDER BY is part of the
// window frame, not a directive for the learner to add a top-level ORDER BY.
// Hints that instruct the learner to sort (e.g. "Koristi ORDER BY col DESC")
// are already captured by the /\basc\b/ and /\bdesc\b/ patterns below.
const SORT_KEYWORDS = [
  /\bsorted\b/,           // English adjective
  /\bordered\b/,          // English adjective
  /\bascending\b/,
  /\bdescending\b/,
  /\balphabetically\b/,
  /\bsort\b/,             // English verb
  /\bsortir/,             // Serbian root: sortiraj, sortirane, sortirano, sortiran…
  /\bpore[dđ]aj/,         // Serbian: poređaj / poredjaj
  /\bpo redu\b/,          // Serbian: "in order"
  /\bopadaju[cć]/,        // Serbian: opadajuće / opadajuce (descending)
  /\brastuc/,             // Serbian: rastuće / rastuce (ascending)
  /\brastuć/,             // Serbian with diacritic
  /\babecedno\b/,         // Serbian: alphabetically
  /\brang\b/,             // Serbian/English: rank / ranking (rangiraj, rang lista…)
  /\basc\b/,              // SQL keyword in an instructional hint (ORDER BY col ASC)
  /\bdesc\b/,             // SQL keyword in an instructional hint (ORDER BY col DESC)
];

// Returns true when the task explicitly requires the learner to sort the output.
// Three signals are checked in priority order:
//   1. task.requiresOrderBy === true  — explicit per-task override
//   2. task.topicId === 'sorting'     — the dedicated sorting topic
//   3. Sort-indicating keyword in description or hint
function isOrderByRequired(task) {
  if (!task || typeof task !== 'object') return false;
  if (task.requiresOrderBy === true) return true;
  if (task.topicId === 'sorting') return true;
  const text = ((task.description || '') + ' ' + (task.hint || '')).toLowerCase();
  return SORT_KEYWORDS.some(p => p.test(text));
}

// Returns invalid('missing_order_by') only when all three conditions hold:
//   (a) the task explicitly requires sorted output (isOrderByRequired), AND
//   (b) the solution contains a top-level ORDER BY, AND
//   (c) the user omitted a top-level ORDER BY.
//
// Runs globally (all topics) after compareResults returns isCorrect: true.
// Only checks ORDER BY presence, not column or direction correctness.
// When task is absent or undefined the function always returns VALID (safe default).
function validateRequiredOrderBy(userSql, solutionSql, task) {
  if (!isOrderByRequired(task)) return VALID;
  if (hasTopLevelOrderBy(solutionSql) && !hasTopLevelOrderBy(userSql)) {
    return invalid('missing_order_by');
  }
  return VALID;
}

module.exports = { validateSqlStructure, solutionHasTopLevelOrderBy, hasTopLevelOrderBy, isOrderByRequired, validateRequiredOrderBy };

/*
 * ─── Self-check ───────────────────────────────────────────────────────────────
 * Uncomment the block below and run:
 *   node backend/src/utils/sqlStructureValidator.js
 *
 * Expected output: all PASS.

const cases = [
  {
    name: '1 — exact WHERE match (casing + whitespace differ)',
    user: 'select * FROM subjects WHERE ects >= 6;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid: true,
  },
  {
    name: '2 — extra AND condition (the core motivating case)',
    user: 'SELECT * FROM subjects WHERE ects >= 6 AND ects <= 8;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid: false,
    expectReason: 'extra_where_condition',
  },
  {
    name: '3 — missing WHERE entirely',
    user: 'SELECT * FROM subjects;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid: false,
    expectReason: 'missing_where_condition',
  },
  {
    name: '4 — extra LIMIT not in solution',
    user: 'SELECT * FROM subjects WHERE ects >= 6 LIMIT 10;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid: false,
    expectReason: 'extra_limit',
  },
  {
    name: '5 — ORDER BY allowed because solution also has ORDER BY',
    user: 'SELECT first_name, last_name, enrollment_year FROM students WHERE enrollment_year = 2021 OR enrollment_year = 2023 ORDER BY enrollment_year, last_name;',
    sol:  'SELECT first_name, last_name, enrollment_year FROM students WHERE enrollment_year = 2021 OR enrollment_year = 2023 ORDER BY enrollment_year, last_name;',
    expectValid: true, // falls back due to OR — never reaches ORDER BY check
  },
  {
    name: '6 — extra ORDER BY when solution has no ORDER BY',
    user: 'SELECT * FROM subjects WHERE ects >= 6 ORDER BY ects;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid: false,
    expectReason: 'extra_order_by',
  },
  {
    name: '7 — DISTINCT allowed because solution also uses DISTINCT',
    user: 'SELECT DISTINCT city FROM faculties;',
    sol:  'SELECT DISTINCT city FROM faculties;',
    expectValid: true,
  },
  {
    name: '8 — fallback for BETWEEN',
    user: 'SELECT * FROM exams WHERE grade BETWEEN 8 AND 10;',
    sol:  'SELECT * FROM exams WHERE grade BETWEEN 8 AND 10;',
    expectValid: true, // BETWEEN triggers fallback
  },
  {
    name: '9 — fallback for IN',
    user: 'SELECT name, semester, ects FROM subjects WHERE semester IN (1, 2, 3);',
    sol:  'SELECT name, semester, ects FROM subjects WHERE semester IN (1, 2, 3);',
    expectValid: true, // IN triggers fallback
  },
  {
    name: '10 — fallback for OR',
    user: 'SELECT * FROM students WHERE enrollment_year = 2021 OR enrollment_year = 2023;',
    sol:  'SELECT * FROM students WHERE enrollment_year = 2021 OR enrollment_year = 2023;',
    expectValid: true, // top-level OR triggers fallback
  },
  {
    name: '11 — table alias stripped (s.ects vs ects)',
    user: 'SELECT * FROM subjects s WHERE s.ects >= 6;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    expectValid: true,
  },
  {
    name: '12 — LIMIT allowed because solution also has LIMIT',
    user: 'SELECT * FROM subjects LIMIT 5;',
    sol:  'SELECT * FROM subjects LIMIT 5;',
    expectValid: true,
  },
  {
    name: '13 — extra DISTINCT not in solution',
    user: 'SELECT DISTINCT city FROM faculties;',
    sol:  'SELECT city FROM faculties;',
    expectValid: false,
    expectReason: 'extra_distinct',
  },
  {
    name: '14 — AND condition order is irrelevant',
    user: 'SELECT first_name, last_name, index_number FROM students WHERE enrollment_year = 2022 AND faculty_id = 2;',
    sol:  'SELECT first_name, last_name, index_number FROM students WHERE faculty_id = 2 AND enrollment_year = 2022;',
    expectValid: true,
  },
  {
    name: '15 — validationMode result_only bypasses all checks',
    user: 'SELECT * FROM subjects WHERE ects >= 6 AND ects <= 8;',
    sol:  'SELECT * FROM subjects WHERE ects >= 6;',
    task: { validationMode: 'result_only' },
    expectValid: true,
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const result = validateSqlStructure(c.user, c.sol, c.task || {});
  const validOk  = result.isStructurallyValid === c.expectValid;
  const reasonOk = !c.expectReason || result.reason === c.expectReason;
  if (validOk && reasonOk) {
    console.log(`PASS — ${c.name}`);
    passed++;
  } else {
    console.log(`FAIL — ${c.name}`);
    console.log(`  Expected: valid=${c.expectValid}, reason=${c.expectReason ?? 'any'}`);
    console.log(`  Got:      valid=${result.isStructurallyValid}, reason=${result.reason}`);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed.`);

*/
