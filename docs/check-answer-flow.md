# Check Answer Flow

## High-level flow

```
POST /api/tasks/:id/check
        │
        ▼
1. Validate SQL safety          sqlSafetyValidator.js
   └─ blocked? → 403, save attempt
        │
        ▼
2. Execute user SQL + solution SQL in parallel   pg pool
   └─ SQL error? → 400, save attempt
        │
        ▼
3. Compare result sets          resultComparator.js
   orderMatters = solutionHasTopLevelOrderBy(task.solution)
   └─ compareResults(userResult, solutionResult, { orderMatters })
        │
        ├─ mismatch? → save attempt (isCorrect=false), return failureReason
        │
        ▼
4. If results match: check required ORDER BY presence   sqlStructureValidator.js
   validateRequiredOrderBy(userSql, task.solution)
   └─ solution has top-level ORDER BY but user omitted it?
      → save attempt (isCorrect=false), return query_logic_mismatch / missing_order_by
        │
        ▼
5. If results match AND validationMode === 'strict':
   Validate SQL structure       sqlStructureValidator.js
   └─ invalid? → return query_logic_mismatch (isCorrect=false, no attempt saved as correct)
        │
        ▼
6. Save attempt (isCorrect=true)
        │
        ▼
7. Return response to frontend
```

## Backend modules

| File | Responsibility |
|---|---|
| `backend/src/routes/tasks.js` | Route handler — orchestrates the full flow |
| `backend/src/utils/sqlSafetyValidator.js` | Read-only guard: rejects non-SELECT/WITH starts and dangerous keywords |
| `backend/src/utils/resultComparator.js` | Compares two pg result objects; returns structured diagnosis |
| `backend/src/utils/sqlStructureValidator.js` | ORDER BY detection, required ORDER BY check, and strict structural validation |

## Failure reasons

Returned as `failureReason` in the JSON response body.

| Reason | Source | Description |
|---|---|---|
| `sql_error` | pg driver | User SQL threw a PostgreSQL error |
| `column_count_mismatch` | resultComparator | Different number of columns |
| `column_name_mismatch` | resultComparator | Same column count, wrong names or aliases |
| `row_count_mismatch` | resultComparator | Different number of rows |
| `order_mismatch` | resultComparator | Correct rows but wrong sequence (only when `orderMatters=true`) |
| `duplicate_rows_mismatch` | resultComparator | Correct unique rows but wrong duplication |
| `value_mismatch` | resultComparator | Same shape, wrong cell values |
| `query_logic_mismatch` | sqlStructureValidator | Results matched but SQL is logically different from solution |

`query_logic_mismatch` carries two extra fields:
- `logicMismatchReason` — specific structural issue (e.g. `missing_order_by`, `extra_order_by`, `condition_mismatch`)
- `logicMismatchHint` — short user-facing hint string

### logicMismatchReason values

| Reason | Hint |
|---|---|
| `missing_order_by` | Check whether the task asks you to sort the results. |
| `extra_order_by` | The task does not ask you to sort the results. Check if ORDER BY is needed here. |
| `extra_distinct` | The task does not require DISTINCT. Check if removing it still gives the correct result. |
| `extra_limit` | The task does not ask you to limit the number of rows. Remove the LIMIT clause. |
| `extra_where_condition` | Check your WHERE clause — you may have added a condition that makes the result too restrictive. |
| `missing_where_condition` | Check your WHERE clause — a required filter condition seems to be missing. |
| `condition_mismatch` | Check the comparison operator or value in your WHERE clause. |

## ORDER BY enforcement

### orderMatters flag

`orderMatters` is set per-request by inspecting the solution SQL:

```js
const orderMatters = solutionHasTopLevelOrderBy(task.solution);
```

This replaces the old `task.topicId === 'sorting'` check. Any task whose solution contains a top-level ORDER BY — regardless of topic — will have `orderMatters=true`, causing `compareResults` to enforce row sequence.

**Top-level** means ORDER BY at paren depth 0. The following are NOT counted as top-level:

| Pattern | Detected as top-level? |
|---|---|
| `SELECT * FROM t ORDER BY col` | Yes |
| `WITH cte AS (SELECT * FROM t ORDER BY col) SELECT * FROM cte` | No — ORDER BY is inside the CTE body |
| `SELECT * FROM (SELECT * FROM t ORDER BY col) sub` | No — ORDER BY is inside a subquery |
| `SELECT RANK() OVER(ORDER BY col) FROM t` | No — ORDER BY is inside OVER() |
| `WITH cte AS (...) SELECT * FROM cte ORDER BY col` | Yes — final ORDER BY is at depth 0 |

### Required ORDER BY check (`validateRequiredOrderBy`)

Even when `compareResults` returns `isCorrect: true`, there is a failure mode: if all sort-key values happen to be equal, PostgreSQL can return rows in the same order with or without ORDER BY, so a data coincidence masks the missing clause.

To catch this, step 4 runs `validateRequiredOrderBy(userSql, task.solution)` globally (all topics, all validationModes) before saving a correct attempt:

- If the solution has a top-level ORDER BY and the user's SQL does not → returns `missing_order_by`
- Otherwise → passes through

This check only tests **presence**. Correctness of the ORDER BY expression (wrong column, wrong direction) is handled by `compareResults` when the data actually exposes the difference as `order_mismatch`.

## validationMode

Controls whether strict structural validation (step 5) runs after a result match.

| Topic | Default mode |
|---|---|
| `select` | `strict` |
| `where` | `strict` |
| all other topics | `result_only` |

`validationMode` can be set explicitly per task in `tasks.json` to override the default.

In `result_only` mode, structural validation (step 5) is skipped entirely — a result match after the required ORDER BY check is sufficient for `isCorrect: true`.

In `strict` mode, structural validation runs after step 4. If it fails, the response returns `isCorrect: false` with `failureReason: 'query_logic_mismatch'`.

Note: the required ORDER BY check (step 4) is not subject to `validationMode` — it always runs.

## Frontend behavior

`TaskView.jsx` calls `POST /api/tasks/:id/check` and passes the result to `CheckBanner`.

### Correct answer

`isCorrect: true` renders a plain green banner with no expand/collapse:

```
✓ Correct! Your query matches the expected result.
```

### Incorrect answers — expand/collapse

All incorrect banners share a single expand/collapse pattern:

- The **headline** is always visible.
- **Detail content** is hidden by default.
- A **"Show details ▾" / "Hide details ▴"** button appears right-aligned on the same row as the headline, but only when there is detail content to show. Branches with no detail (e.g. the fallback default) show no button.
- `isExpanded` resets to `false` on every new `checkResult`, so each check always starts collapsed.
- The button uses `aria-expanded` for accessibility.

Default view (collapsed):
```
✗ Your result returns 3 columns, but the expected result has 4.    [Show details ▾]
```

Expanded:
```
✗ Your result returns 3 columns, but the expected result has 4.    [Hide details ▴]
  Got: subject_id, grade, passed_status
  Expected: student_id, subject_id, grade, passed_status
  Missing: student_id
```

### Detail content per failure reason

| Failure reason | Detail shown when expanded |
|---|---|
| `sql_error` | Error message text (only when `errorMessage` is set) |
| `column_count_mismatch` | Got / Expected column lists; Missing / Extra columns if applicable |
| `column_name_mismatch` | Got / Expected column lists |
| `row_count_mismatch` | Contextual hint — references JOIN if `solutionHasJoin` or user SQL contains a JOIN |
| `order_mismatch` | "Check which columns to sort by and in which direction (ASC / DESC)." |
| `duplicate_rows_mismatch` | Contextual hint — references JOIN if applicable |
| `value_mismatch` | Sample row differences (up to 3): row index, column name, got value, expected value |
| `query_logic_mismatch` | Generic hint (`logicMismatchHint`) and muted issue label (`logicMismatchReason`) |

### `query_logic_mismatch` detail

There is no separate nested "Show hint" button. The hint and reason are shown as part of the unified detail block, visible only after the user clicks "Show details ▾":

```
Issue: missing order by          ← muted, font-size 11
Check whether the task asks you to sort the results.
```

JOIN hint gating uses `solutionHasJoin` (boolean returned by the backend, derived from the solution SQL) combined with a regex check on the user's own SQL. The solution SQL itself is never sent to the frontend.

## Test scripts

```bash
npm run test:sql-safety          # 22 cases — sqlSafetyValidator
npm run test:compare-results     # 21 cases — resultComparator
npm run test:sql-validator       # 28 cases — sqlStructureValidator
npm run test:order-detection     # 12 cases — solutionHasTopLevelOrderBy / hasTopLevelOrderBy
npm run test:required-order-by   #  8 cases — validateRequiredOrderBy
```

Scripts live in `backend/scripts/`. Each prints PASS/FAIL per case and exits with code 1 on any failure.

## Known limitations

**SQL safety validator (sqlSafetyValidator.js)**
- Keyword matching is conservative: blocked words are matched anywhere in the normalized SQL using word boundaries. A keyword inside a string literal (e.g. `SELECT 'drop table'`) is also blocked. This is an accepted trade-off — a full parse would be required to distinguish literal content.
- `REPLACE()` is intentionally not blocked — it is a valid read-only PostgreSQL string function used in text-manipulation tasks.
- `COPY` is blocked. `EXPLAIN` is blocked (it does not start with `SELECT` or `WITH`).

**SQL structure validator (sqlStructureValidator.js)**
- Intentionally falls back to `isStructurallyValid: true` (no complaint) for queries containing `OR`, `IN`, `BETWEEN`, `IS NULL`, `ILIKE`, subqueries, and CTEs in the WHERE clause. These constructs are too complex for the current clause-by-clause comparison, and false positives (incorrectly marking a valid query as wrong) are worse than false negatives.
- Structural validation (step 5) only runs after result comparison passes. A structurally dubious query that also returns wrong rows is reported as a result mismatch, not a structure mismatch.

**ORDER BY enforcement**
- `validateRequiredOrderBy` only checks presence of a top-level ORDER BY, not whether the column or direction matches the solution. A user who writes `ORDER BY wrong_column` passes step 4 — whether this produces `order_mismatch` or `isCorrect: true` depends entirely on what the data returns.
- The required ORDER BY check cannot be enforced when the solution itself uses `result_only` mode and the data coincidentally matches in both order and values with a wrong ORDER BY expression.
