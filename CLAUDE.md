# SQL Practice

Web aplikacija za vježbanje SQL upita — interaktivni zadaci s provjerom direktno na PostgreSQL bazi.

## Pokretanje

### Backend
```bash
cd backend
npm run dev       # nodemon, port 3001
# ili
npm start         # node, port 3001
```

### Frontend
```bash
cd frontend
npm run dev       # Vite, port 5173
```

Oba servisa moraju biti pokrenuta istovremeno.

## Arhitektura

```
sql-practice/
├── backend/
│   ├── src/
│   │   ├── index.js          # Express server
│   │   ├── db.js             # PostgreSQL pool (pg)
│   │   ├── data/tasks.json   # 221 zadataka
│   │   ├── routes/
│   │   │   ├── query.js      # POST /api/query — izvršava SQL
│   │   │   ├── tables.js     # GET /api/tables — lista tabela/sheme
│   │   │   ├── tasks.js      # GET /api/tasks, POST /api/tasks/:id/check
│   │   │   ├── sessions.js   # CRUD za learning sessions
│   │   │   ├── users.js      # GET/POST/DELETE /api/users
│   │   │   └── progress.js   # GET /api/progress/summary|tasks-status
│   │   └── utils/
│   │       ├── attemptRecorder.js      # saveRunAttempt / saveCheckAttempt
│   │       ├── contextResolvers.js     # resolveUserId / resolveSessionId (with ownership check)
│   │       ├── queryRunner.js          # executeUserQuery — timeout + row-limit guard
│   │       ├── resultComparator.js     # compareResults — order-aware row matching
│   │       ├── sqlSafetyValidator.js   # whitelist: only SELECT allowed
│   │       ├── sqlStructureValidator.js # structural checks (LIMIT, DISTINCT, ORDER BY enforcement)
│   │       └── taskFilters.js          # matchesSessionFilters — must stay in sync with frontend
│   └── .env                  # DB konfiguracija (ne commitovati)
└── frontend/
    └── src/
        ├── App.jsx
        ├── api.js             # fetch wrapperi za backend
        └── components/
            ├── Sidebar.jsx
            ├── TaskView.jsx
            ├── PracticeView.jsx
            ├── QueryPlayground.jsx
            ├── DatabaseView.jsx
            ├── ProgressView.jsx
            ├── ResultTable.jsx
            ├── SqlEditor.jsx
            ├── TablePreviewPanel.jsx
            ├── CheckboxGroup.jsx
            ├── FormSelect.jsx
            └── shared/
                └── StatusBadge.jsx
```

## Baza podataka

- PostgreSQL, baza: `sql_practice`, port: 5432
- Konfiguracija u `backend/.env` (vidi `.env.example`); podržava i `DATABASE_URL`

Inicijalizacija practice tabela (jednom, za novog korisnika):
```bash
cd backend && npm run db:init
```
Izvršava `backend/db/init-practice-db.sql` — DROP + CREATE + INSERT za 7 practice tabela.
**Ne diraj** tabele za napredak (`users`, `learning_sessions`, itd.) — te kreira `initDb.js` automatski pri startu servera.

Provjera konekcije:
```bash
curl http://localhost:3001/api/health
```

DB schema (glavne tabele):
- `users` — id, username
- `learning_sessions` — id, user_id, name, description, plan_type, status
- `learning_session_filters` — session_id, filter_type, filter_value (ON DELETE CASCADE)
- `task_attempts` — user_id, session_id, task_id, sql, is_correct, error_message
- `user_task_progress` — user_id, session_id, task_id, solved_at

## Zadaci

**221 zadataka** u `backend/src/data/tasks.json`, organizovani po kategorijama i topicId-u:

| Kategorija | topicId | Broj | Težine |
|---|---|---|---|
| SELECT basics | select | 11 | easy |
| WHERE filtering | where | 13 | easy–hard |
| ORDER BY sorting | sorting | 2 | easy |
| Aggregate functions | aggregate-functions | 15 | easy–hard |
| GROUP BY | group-by-having | 10 | medium–hard |
| HAVING | group-by-having | 6 | medium |
| INNER JOIN | join | 17 | easy–hard |
| LEFT JOIN | join | 3 | medium–hard |
| Subqueries | subqueries | 15 | easy–hard |
| Mixed practice | — | 1 | hard |
| Sorting | sorting | 12 | easy–hard |
| CASE WHEN | case-when | 12 | easy–hard |
| Set Operations | set-operations | 10 | easy–hard |
| CTE | cte | 12 | easy–hard |
| Window Functions | window-functions | 15 | easy–hard |
| Date Functions | date-functions | 10 | easy–hard |
| Text Functions | text-functions | 12 | easy–hard |
| Data Analysis | data-analysis | 15 | easy–hard |
| Practice Projects | — | 30 | hard |

LevelId vrijednosti: `introduction`, `beginner`, `intermediate`, `advanced`, `expert`.

Practice Projects imaju `projectId` (ne `topicId`): `student-performance`, `faculty-analysis`, `subject-difficulty`, `professor-workload`, `exam-timeline` (po 6 zadataka svaki).

Svaki zadatak ima: `id`, `category`, `topicId` ili `projectId`, `levelId`, `difficulty`, `description`, `hint`, `solution`, `tables[]`.
Opcionalno: `requiresOrderBy` (bool), `validationMode` (`'strict'` | `'result_only'`).

**Ne mijenjati `tasks.json`** bez eksplicitnog zahtjeva.
**Ne exposovati `solution` SQL frontandu** — samo izvedeni booloani kao `solutionHasJoin`.

## Session model

Korisnik može imati više learning sessions. Svaka sesija ima:
- `plan_type`: `'topic'` | `'level'` | `'project'` | `'category'`
- `status`: `'active'` | `'completed'`
- Filtere u `learning_session_filters` (topic, difficulty, project, category)

Ownership se provjerava pri svakom pisanju/brisanju/otvaranju sesije:
- `resolveSessionId(userId, providedId)` vraća `null` ako providedId ne pripada userId-u
- `DELETE /sessions/:id` i `PATCH /sessions/:id/open` zahtijevaju `userId` u body-u i provjeravaju vlasništvo
- `saveRunAttempt` / `saveCheckAttempt` ne zapisuju ništa ako je `sessionId === null`

## Check-answer flow (`POST /api/tasks/:id/check`)

1. Provjera sigurnosti SQL-a (`validateSqlSafety`) — samo SELECT dozvoljen
2. Paralelno izvršavanje: `executeUserQuery(userSql)` + `pool.query(task.solution)`
3. Timeout catch: err.code `57014` → friendly poruka (max 5s po defaultu)
4. Row limit check: ako `userResult.rowCount > 1000` → 400 error **prije** `compareResults`
5. `compareResults(userResult, solutionResult, { orderMatters })` — order-aware poređenje
6. Ako `isCorrect`, provjera ORDER BY: `validateRequiredOrderBy(userSql, task.solution, task)`
7. Ako `isCorrect` i `validationMode === 'strict'`: `validateSqlStructure(userSql, task.solution, task)`
8. Zapis pokušaja u DB, vraćanje rezultata

## ORDER BY enforcement

`validateRequiredOrderBy` provjerava prisustvo top-level ORDER BY **samo** za zadatke koji zaista traže sortiranje. `isOrderByRequired(task)` određuje ovo prema prioritetu:

1. `task.requiresOrderBy === true` — eksplicitni flag
2. `task.topicId === 'sorting'` — topic za sortiranje
3. Ključne riječi u `description` + `hint`: svi glagoli za sortiranje na srpskom i engleskom (sort, order, ascending, descending, poreðaj, opadajuć, rastuć, abecedno, rang, asc, desc, itd.)

`ORDER BY` unutar `OVER(...)` window funkcija **ne** triggera enforcement — `/\border by\b/` nije u SORT_KEYWORDS da bi se izbjeglo false-positive matchovanje.

Zadaci koji imaju ORDER BY u solution samo zbog determinizma (ne-sorting topic, nema keyword) **ne** dobijaju enforcement.

## Query safety limits

`backend/src/utils/queryRunner.js` — `executeUserQuery(sql)`:
- Acquires dedicated pool client
- `SET statement_timeout = QUERY_TIMEOUT` (default: 5000ms, env: `QUERY_TIMEOUT_MS`)
- `finally` uvijek resetuje na 0 i oslobađa klijenta
- Timeout → pg error code `57014`
- Row limit (default: 1000, env: `QUERY_ROW_LIMIT`) provjerava **caller**, ne queryRunner

`/api/query`: row limit check → 400 error; timeout → 400 error  
`/api/tasks/:id/check`: row limit check fires **before** compareResults (sprječava false-positive match)

Solution SQL uvijek radi na `pool.query()` — bez limita i timeouta.

## Intentional duplication — filter logic sync

The function `matchesSessionFilters` exists in two places and **must be kept in sync**:

| Location | Role |
|---|---|
| `frontend/src/utils/taskFilters.js` | Controls which tasks are shown as active in Practice view and which enable Run/Check buttons |
| `backend/src/utils/taskFilters.js` (used in `progress.js`) | Controls which tasks are counted in Progress summary, stats, and byGroup breakdown |

Both functions implement the same rule:

1. **Difficulty** — AND gate. If the plan specifies difficulty levels, the task must match `task.difficulty` or `task.levelId`.
2. **Scope** (topic / project / category) — OR gate across all three types. The task must match at least one selected topic, project, or category. If no scope filters are set, the difficulty gate alone decides.

Exact fields checked in both:

| Filter field | Task fields compared |
|---|---|
| `difficulties` | `task.difficulty`, `task.levelId` |
| `topics` | `task.topicId`, `task.category` |
| `projects` | `task.projectId`, `task.project` |
| `categories` | `task.category`, `task.topicId` |

**If you change the filter logic in one file, you must apply the identical change in the other.** A mismatch causes users to see different task sets in Practice vs Progress for the same session.

## API endpointi

| Metoda | Ruta | Opis |
|---|---|---|
| GET | `/api/health` | Status konekcije na bazu |
| GET | `/api/tables` | Lista tabela i njihove sheme |
| GET | `/api/tasks` | Svi zadaci (bez solution) |
| GET | `/api/tasks/categories` | Lista kategorija |
| GET | `/api/tasks/:id` | Jedan zadatak (bez solution) |
| GET | `/api/tasks/:id/solution` | Solution SQL za zadatak |
| POST | `/api/tasks/:id/check` | Provjera korisnikovog SQL-a |
| POST | `/api/query` | Slobodan SQL upit (playground) |
| GET | `/api/users` | Lista korisnika |
| POST | `/api/users` | Kreiraj korisnika |
| DELETE | `/api/users/:id` | Obriši korisnika |
| GET | `/api/sessions?userId=N` | Sesije korisnika |
| POST | `/api/sessions` | Kreiraj sesiju |
| PATCH | `/api/sessions/:id` | Izmijeni sesiju |
| PATCH | `/api/sessions/:id/complete` | Označi sesiju kao završenu |
| PATCH | `/api/sessions/:id/reopen` | Ponovo otvori završenu sesiju |
| PATCH | `/api/sessions/:id/open` | Postavi sesiju kao aktivnu |
| DELETE | `/api/sessions/:id` | Obriši sesiju |
| GET | `/api/sessions/:id/filters` | Filtere sesije |
| GET | `/api/progress/summary?userId=N&sessionId=M` | Progress summary + byGroup |
| GET | `/api/progress/tasks-status?userId=N&sessionId=M` | Status za svaki zadatak |

## Verification scripts

```bash
cd backend
npm run test:sql-validator        # SQL structure validator (28 cases)
npm run test:compare-results      # Result comparator (21 cases)
npm run test:sql-safety           # SQL safety validator (22 cases)
npm run test:order-detection      # ORDER BY detection (12 cases)
npm run test:required-order-by    # ORDER BY enforcement scope (40 cases)
npm run test:session-ownership    # Session ownership at write/delete (5 cases, needs live DB)
npm run test:query-limits         # Row limit + timeout (6 cases, needs live DB)
```

## Development rules

- **Run non-destructive commands without asking**: npm scripts, node scripts, bash commands, SQL SELECT queries — run and report results directly. Ask only before destructive or irreversible actions (deleting data, dropping tables, force-push, deleting files).
- **Ne dodavati noisy console.log** u production code paths.
- **Ne dodavati `validationMode` u tasks.json globalno** — postavljati samo per-task gdje je potrebno.
- **Ne exposovati solution SQL frontandu** — samo izvedeni booloani.
- Komentare pisati samo za non-obvious WHY, ne za WHAT.
