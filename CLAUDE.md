# SQL Practice

A web app for practicing SQL queries — interactive tasks checked directly against a PostgreSQL database, with a login/role system (admin / mentor-"Professor" / student), sessions (learning plans), and support for multiple practice datasets.

> **Note for AI assistants:** this file was last synced with the code on 2026-07-06. If anything here looks suspiciously stale compared to the code you're looking at, trust the code and (if possible) update this file in the same PR.

## Running the app

### Backend
```bash
cd backend
npm run dev       # nodemon, port 3001
# or
npm start         # node, port 3001
```
The backend **refuses to start** without `SESSION_SECRET` in `backend/.env` (fail-fast, see `src/index.js`).

### Frontend
```bash
cd frontend
npm run dev       # Vite dev server, port 3000 (see frontend/vite.config.js — NOT Vite's default 5173)
```
Vite proxies `/api/*` to `http://localhost:3001` (hardcoded in `vite.config.js`, no `VITE_API_URL` env variable in this project).

Both services must be running at the same time.

## Architecture

```
sql-practice/
├── backend/
│   ├── src/
│   │   ├── index.js          # Express server, CORS, express-session (connect-pg-simple), global error handler
│   │   ├── db.js             # PostgreSQL pool (pg)
│   │   ├── initDb.js         # Idempotent migrations for the "app" tables (public schema) — runs on every boot
│   │   ├── data/
│   │   │   ├── taskRegistry.js        # Merges tasks.json from ALL datasets; throws on a duplicate/malformed id
│   │   │   └── datasets/
│   │   │       ├── academic/tasks.json   # 221 tasks — the ONLY dataset with content
│   │   │       ├── cinema/tasks.json     # [] — schema+data exist, NO tasks
│   │   │       ├── football/tasks.json   # [] — schema+data exist, NO tasks
│   │   │       └── nation/tasks.json     # [] — schema+data exist, NO tasks
│   │   ├── routes/            # see "Backend route map" below
│   │   └── utils/             # see "Check-answer flow" and "Role/permission model" below
│   ├── db/
│   │   ├── schemas/academic.sql   # DROP+CREATE+INSERT for the academic schema (7 tables) — this is what `npm run db:init` runs
│   │   ├── init-practice-db.sql   # OLDER version of the same, creates tables in the `public` schema — NO LONGER used for setup, kept as a reference
│   │   └── legacy/                 # archived, one-time migration scripts — never run in normal operation
│   └── .env                  # DB + SESSION_SECRET configuration (do not commit)
├── frontend/
│   └── src/
│       ├── App.jsx            # Top-level controller — auth state, session state, viewedUser (review mode), navigation (no router lib, manual currentView switch)
│       ├── api.js             # fetch wrappers; userId/role are NEVER sent explicitly — the backend reads them from the session cookie
│       └── components/        # see "Frontend component map" below
└── shared/
    └── sessionFilters.js  # matchesSessionFilters — canonical implementation, dependency-free (no React/Express/DB). The backend require()s it directly; the frontend keeps a parity-tested copy (Vite's dev server doesn't do CJS interop on the project's own source files) — see "Known risks" below
```

## Database

- PostgreSQL, database: `sql_practice`, port: 5432.
- Configuration in `backend/.env` (see `.env.example`); also supports `DATABASE_URL` (used only by `run-sql-file.js` and `check-setup-flow.js` — the main app connection in `src/db.js` **always** builds its connection from `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`; `DATABASE_URL` is not supported there).
- Two "kinds" of schema in the same database:
  - `public` — app/progress tables (`users`, `learning_sessions`, `learning_session_filters`, `task_attempts`, `user_task_progress`, `datasets`, `mentor_assignments`) — created and migrated by `initDb.js` **automatically on every backend server startup**. Don't touch these tables by hand.
  - One schema per dataset (`academic`, `cinema`, `football`, `nation`) — practice data, created manually via `npm run db:init` (`academic` only) or via the `npm run dataset:*` pipeline (cinema/football/nation).

Initializing the `academic` practice tables (once, or whenever you want to reset just the practice data):
```bash
cd backend && npm run db:init
```
This runs `backend/scripts/run-sql-file.js`, which **defaults to `backend/db/schemas/academic.sql`** (DROP+CREATE+INSERT for 7 tables: `faculties, departments, professors, subjects, students, exams, professor_subjects`, all in the `academic` schema). `backend/db/init-practice-db.sql` is an older version that created the same tables in the `public` schema — no longer used in normal setup, kept only as a historical reference (`initDb.js` even has a migration that drops those old `public.*` tables on boot if they exist). **Don't touch** the progress tables (`users`, `learning_sessions`, etc.) — those are created automatically by `initDb.js`.

Connection check:
```bash
curl http://localhost:3001/api/health
```

## Auth / session model

- Real login: `bcryptjs` hash (`users.password_hash`, cost 10), `express-session` + `connect-pg-simple` (sessions are stored in Postgres, the table is created automatically — `createTableIfMissing: true`).
- Cookie: `httpOnly`, `sameSite: 'lax'`, `secure` only when `NODE_ENV=production`, rolling 14 days.
- `POST /api/auth/login` — a generic error message ("Invalid username or password") regardless of whether the account doesn't exist, has no password_hash, or the password is wrong (prevents account enumeration). On success: `req.session.regenerate()` BEFORE writing `userId` (session fixation mitigation).
- `GET /api/auth/me` — reads `role`/`username` fresh from the database every time based on `req.session.userId` (nothing is cached in the session payload except `userId`) — a role change or account deletion takes effect immediately on the next request.
- **Admin can reset any user's password from the UI** — `PATCH /api/users/:id/password` (admin-only, `requireRole('admin')`), an inline form in `UserManagementView.jsx` ("Reset password" button per row, including the admin's own row — resetting a password isn't destructive like delete, so it's deliberately not hidden for your own row). Password rules (`MIN_PASSWORD_LENGTH = 8`, `BCRYPT_COST = 10`, hash/validate helpers) are centralized in `backend/src/utils/passwordPolicy.js`, used by both `POST /api/users` and `scripts/set-user-password.js`. Works identically for legacy accounts with `password_hash IS NULL` (an unconditional `UPDATE`, same pattern as the CLI script) — after the reset, the user can log in immediately. **A successful reset invalidates ALL active sessions of the target user** — in the same transaction as the password `UPDATE`, the route deletes every row from `connect-pg-simple`'s `session` table whose `sess->>'userId'` matches `:id` (see `routes/users.js`); if that deletion fails, the whole transaction rolls back, so a reset never "succeeds" while the old session stays valid. If the admin resets their OWN password, this deliberately deletes their own current session too — the same forced re-login as for any other user, no special exception. **Intentionally out of scope for now:** self-service change (a logged-in user changing their OWN password), a forgot-password/email/token flow, generating a temporary password, force-change-on-next-login, an audit log of admin actions — all of this stays CLI-only or nonexistent until explicitly requested.
- **Admin can change an existing user's role from the UI** — `PATCH /api/users/:id/role` (admin-only, `requireRole('admin')`), an inline "Edit role" form per row in `UserManagementView.jsx` (the same keyed-by-user-id pattern as the "Reset password" row — one open at a time), using the existing `FormSelect` (not a native `<select>`). The role is **never cached in the session payload** — `getActingUser`/`GET /api/auth/me` always re-read it from the database (see the row above) — so a role change takes effect immediately on the target user's next request, with no need for session invalidation (unlike a password reset). **Same last-admin protection as `DELETE /api/users/:id`** — it's not possible to demote the LAST remaining admin (400), including when an admin changes their OWN role (no self-exception). **`mentor_assignments` is cleaned up in the same transaction when a user LEAVES a role** — mentor→(student/admin) deletes rows where they were `mentor_id`; student→(mentor/admin) deletes rows where they were `student_id`; entering the mentor/student role (e.g. from admin) requires no cleanup, since `POST /api/mentor-assignments` never creates a row for a user who doesn't already hold the matching role. The response includes `removedAssignments` (count of deleted rows) for a clear message in the UI. **If an admin changes their OWN role**, the frontend first asks for explicit confirmation (`window.confirm`, warning that they may immediately lose access to this screen), and on success immediately performs a full logout (`onSelfRoleChanged` prop, the same flow as the Sidebar's logout) — this avoids a stale UI with the wrong permissions, forcing a fresh login instead, where the default view for the new role is applied correctly.
- **Admin dashboard / summary cards** — `GET /api/users/admin-summary` (admin-only) returns only aggregated counts (`total_users`, `admins`, `mentors`, `students`, `active_sessions`, `completed_sessions`, `archived_sessions`, `mentor_assignments`), never raw rows. `active_sessions`/`completed_sessions` exclude archived sessions (archived status is orthogonal to `status`, see the Sessions/plans model below); `archived_sessions` counts regardless of status — all three categories are mutually exclusive and add up to the total session count. Shown as cards above the Users/Assignments tabs in `UserManagementView.jsx`, styled via the existing `.progress-stat-card` pattern (the same one Progress View uses, not a new card style).
- **An audit log of admin actions (who reset whose password, deleted which user, changed whose role, when) is NOT implemented** — deliberately left for later, doesn't block the current MVP level. If added, consider a dedicated `admin_audit_log` table with a write alongside every mutating admin route in `routes/users.js`/`routes/mentorAssignments.js`.
- **The CLI still exists and works** for cases where the UI isn't available (e.g. bootstrapping the first admin, direct DB/server access): `node scripts/set-user-password.js <username> <newPassword>` (min. 8 characters, bcrypt hash, never prints the raw password/hash).
- **Bootstrapping the first admin account isn't scripted.** `initDb.js` seeds only a single `'default'` user, role `student` (default), with no password_hash. To have a first admin account, a manual DB change is currently required:
  ```sql
  UPDATE users SET role = 'admin' WHERE username = 'default';
  ```
  and then:
  ```bash
  node scripts/set-user-password.js default <newPassword>
  ```
  This is a known limitation, not a feature — if a "real" seed/bootstrap script is added in the future, update this section.

## Role/permission model

Three roles, DB `CHECK` constraint on `users.role`: `admin | mentor | student`. **`mentor` is shown in the UI as "Professor"** (`frontend/src/utils/roleLabels.js`) — the DB value stays `mentor` everywhere; there is no separate `professor` role string.

| Action | admin | mentor ("Professor") | student |
|---|---|---|---|
| View own sessions/progress | yes | yes | yes |
| View another (assigned) user's sessions/progress | yes (any user) | yes, only if a `mentor_assignments` row exists for that student | no |
| Create a session for self | yes | yes | **no, never** |
| Create a session for an assigned student | yes | yes | n/a |
| Edit/rename a session | yes (any) | yes, their own or an assigned student's | **no, never** |
| Reopen a completed session | yes (any) | yes, their own or an assigned student's | **no, never** |
| Complete a session | n/a (self-only route) | n/a (self-only route) | yes, only their own, if every task in the plan has been run at least once |
| Delete a session | yes (any) | yes, their own or an assigned student's | **no, never** |
| Manage users (`/api/users`) | yes | no | no |
| Manage mentor↔student assignments (`/api/mentor-assignments`) | yes | no (only read-only `/api/mentor/students` for their own) | no |
| View their own assigned students | n/a | yes (`GET /api/mentor/students`) | n/a |
| Fetch a task's solution | yes | yes | yes (login-only, no role gate) |

The logic is centralized in `backend/src/utils/authz.js`:
- `getActingUser(req)` — the single source of identity, reads **exclusively** from `req.session.userId` (the old `x-acting-user-id` header mechanism has been fully removed).
- `requireRole(...roles)` — middleware, 401 (no acting user) / 403 (wrong role).
- `canAccessUser(actingUser, targetUserId)` — account-level check (admin or self), **not used** for sessions/progress.
- `canAccessStudent(actingUser, studentId)` — the real source of truth for mentor/student cross-access (admin always; self always; mentor only if a `mentor_assignments` row exists).
- `canCreateSessionForUser` — like `canAccessStudent`, but explicitly blocks `role === 'student'` even for self-creation.
- `canReopenSession` — admin always; mentor via `canAccessStudent`; student never (not even for their own session).
- `canViewSession(actingUser, session)` — a wrapper around `canAccessStudent(actingUser, session.user_id)`.

**There is no separate "assignment" (homework) or "review mode" table.** "Assignments" in the feature's name means the *mentor↔student* link (the `mentor_assignments` table, who mentors whom), not assigning tasks. "Review mode" means a mentor/admin looking at an existing student's sessions/progress via `?targetUserId=` on the same GET routes the student uses for themselves — there is no separate review-status/comment table.

### Deleting users (`DELETE /api/users/:id`)

Admin-only (`requireRole('admin')`), **permanent, hard-delete** — no soft-delete/archive for accounts (unlike sessions, see Archive/restore below). Called from two places in the frontend: `Sidebar.jsx`'s "delete my account" (self-delete, existing flow) and `UserManagementView.jsx`'s "Delete" in the users table (deleting **another** user — the button is deliberately **not shown** for the currently logged-in admin's own row, to avoid duplicating the self-delete flow).

What exactly happens (`backend/src/routes/users.js`):
- **Guard against deleting the last admin** — if the target is the only remaining `admin`, returns 400, nothing changes.
- Sessions **owned** by the deleted user (`learning_sessions.user_id`) are **permanently deleted**, along with their `task_attempts` and `user_task_progress` rows (explicitly in the route, transactionally).
- Sessions the deleted user only **created** for someone else (`created_by_user_id`, e.g. a mentor who set up a plan for a student) **remain untouched** — only `created_by_user_id` becomes `NULL` (`ON DELETE SET NULL`, migration in `initDb.js`). The owner (`user_id`) and their progress are never touched.
- `mentor_assignments` rows (both as `mentor_id` and as `student_id`) are cleaned up automatically at the DB level (`ON DELETE CASCADE`), with no special code in the route.
- Test coverage: `scripts/check-authz.js` (admin-only gate + owned-session cascade), `scripts/check-session-creator-delete.js` (creator-only case, `created_by_user_id` → NULL), `scripts/check-mentor-assignments-schema.js` case 05 (mentor_assignments cascade).

## IMPORTANT INVARIANT — activeUser vs viewedUser

- `activeUser` (frontend `App.jsx` state) = **the actual logged-in user**, source of truth is `GET /api/auth/me` → backend session. Every Run Query / Check Answer action MUST stay scoped to `activeUser` + `activeSession`.
- `viewedUser` (frontend `App.jsx` state) = **UI context only** ("who a mentor/admin is currently reviewing"), NEVER the acting identity. Set when a mentor clicks a student in My Students, or an admin clicks "Review" in User Management.
- `PracticeView`/`TaskView` receive `viewedUser` **strictly as a display-only prop** (for the banner "Running or checking here affects only your own account") — it is never sent as `targetUserId` to `/api/tasks/:id/check` or `/api/query`. If you ever see an API call from Practice/TaskView sending `viewedUser.id` as the identity for run/check — that's a bug, not a feature.
- The backend NEVER trusts client-provided identity for authorization — `targetUserId` (wherever it exists, e.g. `GET /api/sessions`, `GET /api/progress/summary`) is always re-authorized server-side via `canAccessStudent`, regardless of what the frontend sends.
- Frontend role-based UI (e.g. `activeUser.role !== 'student'` checks in `Sidebar.jsx`/`ProgressView.jsx`) is **cosmetic**, just to avoid showing buttons that would fail with a 403 anyway. The real boundary is always the backend (`requireRole`, `canX` functions). **Don't rely on frontend role checks as a security boundary when adding new code — always add a backend check too.**

## Sessions/plans model

A user (student) has one or more `learning_sessions` (learning plan). Key fields:
- `user_id` — the session's **owner**, whose progress/attempts are tracked.
- `created_by_user_id` — **who created the session** (a mentor/admin who set up a plan for a student, or the student themselves/self-creation). `ON DELETE SET NULL` — deleting the creator never deletes or blocks deleting the session itself.
- `plan_type`: `'topic'` | `'category'` | `'project'` (note: older text also mentioned `'level'` as a separate plan_type — this no longer exists as an option in the frontend `PLAN_TYPE_OPTIONS`; the difficulty filter still works as an independent AND-gate across all plan_types).
- `status`: `'active'` | `'completed'` — **completion state**, independent of archived (see below).
- `archived_at` / `archived_by_user_id` — **lifecycle visibility**, orthogonal to `status`. `NULL` = a normal, visible session (default for all existing and new sessions). Set = the session is archived: hidden from the default `GET /api/sessions` list, but `task_attempts`/`user_task_progress`/`learning_session_filters`/ownership/`completed_at`/`last_opened_at`/`dataset_id` remain completely untouched. `archived_by_user_id` follows the same `ON DELETE SET NULL` pattern as `created_by_user_id`.
- `last_opened_at` — updated ONLY via the self-only `PATCH /:id/open` route (never when a mentor/admin is just reviewing someone else's session — the frontend deliberately never calls this in a viewedUser context). Blocked (403) if the session is archived.
- Filters in `learning_session_filters` (`filter_type`: topic/difficulty/project/category, `filter_value`).

A mentor can create/edit/archive/restore/reopen a session for an assigned student (via an optional `targetUserId` in the body), but this is ALWAYS re-authorized server-side (`canCreateSessionForUser`/`canAccessStudent`/`canArchiveSession`) — the mere presence of a `targetUserId` field is never trusted. A student can never create/edit/archive/restore/delete/reopen a session, not even their own — they can only select it (as the active one) and **complete** it (the only management-like action allowed to a student, provided every task in the plan has been run at least once).

### Archive / restore (the normal way to "remove" a session)

**Archive is the normal, user-facing way for a session to be removed from the visible list — not DELETE.** Introduced because hard-delete (cascade-deleting `task_attempts`/`user_task_progress`/`learning_session_filters`) irreversibly lost a student's history/progress on a single wrong click.

- `PATCH /api/sessions/:id/archive` — sets `archived_at = NOW()`, `archived_by_user_id = actingUser.id`. Authorization: `canArchiveSession` (admin any session; mentor their own or an assigned student's; student never — the same blanket gate as edit/delete).
- `PATCH /api/sessions/:id/restore` — clears `archived_at`/`archived_by_user_id`. Same authorization as archive. **Does not change `status` or `last_opened_at`** — restoring doesn't automatically make the session active, the user still has to explicitly select it.
- `GET /api/sessions` — excludes archived sessions by default (`WHERE archived_at IS NULL`). `?includeArchived=true` also returns archived ones (used by the Sidebar's "Show archived sessions" toggle).
- While a session is archived: `PATCH /:id` (edit), `PATCH /:id/complete`, `PATCH /:id/reopen`, `PATCH /:id/open` all return 403 with a clear message ("This session is archived. Restore it..."). Reopen and restore are deliberately separate actions — reopen is for completed→active, restore is for archived→visible; an archived+completed session is first restored, then (if needed) reopened.
- `POST /api/tasks/:id/check` and `POST /api/query` (Run Query) also block (403) execution against an archived session, the same pattern as the existing `status === 'completed'` guard.
- `contextResolvers.resolveSessionId`'s "no sessionId provided → pick the user's first session" fallback excludes archived sessions (`AND archived_at IS NULL`) — an archived session is never "resurrected" as active just because the caller didn't explicitly ask for another one.

### Hard delete — a permanent action, available in the UI alongside Archive

`DELETE /api/sessions/:id` is a permanent hard-delete, with unchanged authorization (student never; mentor their own/an assigned student's; admin any) — permanently destroys `task_attempts`/`user_task_progress`/`learning_session_filters`/the session itself, with no way to undo it. Archive and Delete are deliberately two separate buttons in `Sidebar.jsx`'s session-controls bar (🗄 Archive, 🗑 Delete), both visible only for `activeUser.role !== 'student'` — the same gate as Archive/Create, students never see them. Delete does NOT replace Archive: Archive remains the default, restorable, non-destructive way to remove a session from the visible list (see above); Delete is for cases where a session genuinely needs to be permanently removed (e.g. an accidentally created test plan). Delete's confirmation (`window.confirm`) explicitly states what gets deleted and that it's irreversible: `Delete session "<name>" permanently? This will delete its attempts, progress, and plan filters. This cannot be undone.` — deliberately more destructive-sounding wording than Archive's confirmation. After a successful delete, `App.jsx`'s `handleDeleteSession` (shares the `removeSessionAndPickNext` helper with `handleArchiveSession`) removes the session from the list and picks the next available session (or an empty state if none remain).

## Dataset/task system

- `backend/src/data/datasets/<key>/tasks.json` — one file per dataset.
- `backend/src/data/taskRegistry.js` — on boot, reads ALL `datasets/*/tasks.json`, validates that `id` is numeric and globally unique (throws on a duplicate/malformed one), tags each task with `datasetKey` (from the folder name, if the task doesn't define its own `datasetKey`). This is real, active code — used by `routes/tasks.js`, `routes/sessions.js`, `routes/progress.js`.
- **Current content status — only `academic` has tasks:**

  | Dataset | Number of tasks | Note |
  |---|---|---|
  | `academic` | 221 | The only dataset with content — the entire existing task breakdown below uses it. |
  | `cinema` | 0 | Schema + CSV data + import pipeline exist (`raw/`, `csv/`, `dataset.config.json`), **no tasks**. |
  | `football` | 0 | Same — schema+data exist, no tasks. |
  | `nation` | 0 | Same — schema+data exist, no tasks. |

  **Don't assume any of cinema/football/nation is ready for practice** — currently a student who selects one of them would see an empty task list everywhere. The session-creation dataset picker in `Sidebar.jsx` currently does NOT filter out datasets with no tasks.

- `academic` breakdown (the only populated dataset, 221 tasks):

  | Category | topicId | Count | Difficulty |
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

  LevelId values: `introduction`, `beginner`, `intermediate`, `advanced`, `expert`. Practice Projects have a `projectId` (not `topicId`): `student-performance`, `faculty-analysis`, `subject-difficulty`, `professor-workload`, `exam-timeline` (6 tasks each).

  Every task has: `id`, `datasetKey`, `category`, `topicId` or `projectId`, `levelId`, `difficulty`, `title`, `description`, `hint`, `solution`, `tables[]`. Optional: `requiresOrderBy` (bool), `validationMode` (`'strict'` | `'result_only'`) — **currently none of the 221 tasks sets `validationMode` explicitly** (see "Check-answer flow" below for the implications).

- Dataset build pipeline (used for new/empty datasets, not for `academic`, which is hand-written SQL): `npm run dataset:generate-config` → `dataset:build-sample` → `dataset:import` → `dataset:reset`. Details: [`docs/adding-new-dataset.md`](docs/adding-new-dataset.md).

**Don't modify `tasks.json` files** without an explicit request.
**Don't expose the `solution` SQL to the frontend** except via the explicit, login-gated `/api/tasks/:id/solution` route — everywhere else, only derived booleans like `solutionHasJoin`.

## Backend route map

| Mount | File | Routes | Auth |
|---|---|---|---|
| `/api/auth` | `routes/auth.js` | `POST /login`, `POST /logout`, `GET /me` | public (login/logout), `/me` checks the session |
| `/api/users` | `routes/users.js` | `GET /`, `GET /admin-summary`, `POST /`, `DELETE /:id`, `PATCH /:id/password`, `PATCH /:id/role` | admin-only (`requireRole('admin')`) |
| `/api/sessions` | `routes/sessions.js` | `GET /` (`?includeArchived=true` optional), `POST /`, `PATCH /:id`, `GET /:id/filters`, `PATCH /:id/complete`, `PATCH /:id/reopen`, `PATCH /:id/open`, `PATCH /:id/archive`, `PATCH /:id/restore`, `DELETE /:id` (permanent hard-delete, available in the UI alongside Archive — see "Hard delete" below) | login required; ownership/role checks per route (see the table above and "Archive / restore" below) |
| `/api/datasets` | `routes/datasets.js` | `GET /` (list of active datasets) | public (metadata only) |
| `/api/tables` | `routes/tables.js` | `GET /`, `GET /:name/columns`, `GET /:name/preview` | scoped to the session's dataset schema |
| `/api/query` | `routes/query.js` | `POST /` (Run Query / playground) | **login always required**, regardless of `taskId` — see "Known risks" below |
| `/api/tasks` | `routes/tasks.js` | `GET /categories`, `GET /`, `GET /:id`, `GET /:id/solution` (login required), `POST /:id/check` | see check-answer flow below |
| `/api/progress` | `routes/progress.js` | `GET /summary`, `GET /tasks-status` | login required; `?targetUserId=` re-authorized via `canAccessStudent` |
| `/api/mentor-assignments` | `routes/mentorAssignments.js` | `GET /`, `POST /`, `DELETE /:id` | admin-only |
| `/api/mentor` | `routes/mentorStudents.js` | `GET /students`, `GET /students/summary`, `GET /students/:studentId/sessions` | first two: mentor-only, always just `req.actingUser`'s own roster. Third: mentor (only an assigned student, via `canAccessStudent`) or admin (always); a student is blocked even for their own id |

## Frontend component map

| File | Role |
|---|---|
| `App.jsx` | Top-level controller — auth state, session state, `viewedUser` (review mode), navigation. No router lib, `currentView` string + switch. Heavy prop drilling (no Context API in the project). |
| `api.js` | fetch wrappers; `credentials: 'same-origin'`; userId/role are never sent explicitly except for the optional `targetUserId`. |
| `components/LoginView.jsx` | Login form. |
| `components/Sidebar.jsx` | Navigation + session switcher (custom dropdown) + create/archive/**delete**/complete/reopen session form + "Show archived sessions" toggle with a Restore button + DB tree + account (self-delete/logout). Archive (🗄) and Delete (🗑) are separate buttons next to each other, both admin/mentor-only — Delete does not replace Archive. A large, multi-responsibility file (~750+ lines) — read the whole file carefully before changing it. |
| `components/PracticeView.jsx` | Topic/level/project cards → task list → `TaskView`. |
| `components/TaskView.jsx` | Editor (CodeMirror), Run Query / Check Answer, hint/solution, `CheckBanner` (a specific message per `failureReason`). |
| `components/QueryPlayground.jsx` | Free-form SQL sandbox — shares safety/timeout/row-limit logic with `/api/tasks/:id/check`, but a separate route. |
| `components/DatabaseView.jsx` | Table browser (Data/Columns tabs). |
| `components/ProgressView.jsx` | Progress dashboard: summary, by-group breakdown, recent attempts, in-progress tasks, plan editor. A large, multi-responsibility file (~825 lines, includes the inline `EditPlanForm` and `SessionSummaryCard`) — read the whole file carefully before changing it. |
| `components/UserManagementView.jsx` | Admin: summary dashboard cards (`.progress-stat-card`, from `GET /api/users/admin-summary`) + user create/list/**delete**/**reset password**/**edit role** (delete is permanent, button hidden for your own row — self-delete still goes through `Sidebar.jsx`; reset password and edit role are NOT hidden for your own row, both inline row-expansion forms, one open at a time per type; edit role uses `FormSelect`, not a native `<select>`) + mentor↔student assignment management (Professor/Student dropdowns are also `FormSelect`). |
| `components/MyStudentsView.jsx` | Mentor: overview of their own assigned students — aggregated counts (active/completed/archived sessions, solved count, last activity) from `GET /api/mentor/students/summary`, in one call instead of the old N-per-student `fetchStudentStats` pattern (still used only in `MentorOverviewView.jsx`). Three quick-action buttons per row: **View progress** (the existing review-mode flow), **Create session** (new — sets `viewedUser` and immediately opens the Sidebar's create-session form in the same click, instead of the mentor first having to enter review mode and manually find the "+" button), **View sessions** (new — an inline expandable row, `GET /api/mentor/students/:id/sessions`, shows the FULL session history for that student including archived ones, with an "Open" action per session that sets both `viewedUser` and that exact session as active — see `pendingOpenSessionId` in `App.jsx`). Deliberately does NOT duplicate edit/archive/reopen buttons inside this panel — "Open" leads into the existing review-mode + Sidebar tooling where those actions already work correctly. |
| `components/MentorOverviewView.jsx` | Admin reviewing a mentor: shows the mentor's student roster instead of the mentor's own (usually irrelevant) sessions. Still uses the old `fetchStudentStats` (2 calls per student) — deliberately unchanged in this step, the new aggregate endpoint is scoped only to a mentor's own roster. |
| `components/ResultTable.jsx`, `SqlEditor.jsx`, `TablePreviewPanel.jsx`, `CheckboxGroup.jsx`, `FormSelect.jsx`, `shared/StatusBadge.jsx` | Smaller, reusable components. |
| `utils/taskFilters.js` | A copy of `matchesSessionFilters` — parity-tested against the canonical version in `shared/sessionFilters.js` (repo root), not a re-export (Vite dev server reason, see the section below). |
| `utils/roleLabels.js` | The `mentor` → "Professor" mapping (the only place that does this). |
| `utils/studentRoster.js` | `fetchStudentStats` — shared by `MyStudentsView` and `MentorOverviewView` (2 API calls per student, in parallel; no backend "roster summary" endpoint). |

## Check-answer flow (`POST /api/tasks/:id/check`)

Detailed documentation: [`docs/check-answer-flow.md`](docs/check-answer-flow.md).

1. SQL safety check (`sqlSafetyValidator.validateSqlSafety`) — only SELECT/WITH allowed, plus a keyword blocklist (`drop, delete, update, insert, alter, truncate, create, grant, revoke, merge, call, execute, copy`). **Known limitation:** this is a text-based keyword scan, not a parser — `SELECT ... INTO <table>` is currently NOT blocked (it contains none of the blocked words), and there is no dedicated read-only DB role/transaction as a backup layer — the entire "read-only" guarantee currently rests on this one layer.
2. `sqlSafetyValidator.validateSchemaScope` — blocks references to another dataset's schema (cross-dataset isolation).
3. Parallel execution via `queryRunner.js`: `executeUserQuery(userSql, schemaName)` (dedicated pool client, `SET statement_timeout` + `SET search_path`, reset in `finally`) + `executeSolutionQuery(task.solution, schemaName)` (no timeout — the solution is trusted).
4. Timeout catch: `err.code === '57014'` → a friendly message (default 5s, env `QUERY_TIMEOUT_MS`).
5. Row limit check: if `userResult.rowCount > ROW_LIMIT` (default 1000, env `QUERY_ROW_LIMIT`) → a 400 error **before** `compareResults` (prevents a false-positive match on a huge result).
6. `resultComparator.compareResults(userResult, solutionResult, { orderMatters })` — `orderMatters` is computed from `solutionHasTopLevelOrderBy(task.solution)` (depth-aware — ignores an ORDER BY inside a CTE/subquery/`OVER(...)`), NOT from `topicId === 'sorting'`.
7. If `isCorrect`: `sqlStructureValidator.validateRequiredOrderBy(userSql, task.solution, task)` — checks ONLY for the presence of a top-level ORDER BY (not the correctness of the column/direction), always runs regardless of `validationMode`.
8. If `isCorrect` AND `validationMode === 'strict'`: `sqlStructureValidator.validateSqlStructure(userSql, task.solution, task)` — a hand-rolled, string-based structural check (WHERE conditions, DISTINCT, LIMIT, ORDER BY) that **deliberately** falls back to "valid" (no complaint) as soon as it encounters `OR`, `IN`, `BETWEEN`, `IS NULL`, `ILIKE`, a subquery, or a CTE in the WHERE clause — a false negative is more acceptable than a false positive.
9. The attempt is recorded in the DB (`attemptRecorder.saveCheckAttempt`), and the result is returned.

**IMPORTANT — the `validationMode` default and the real reach of structural validation:** the `validationMode` default is `(['select','where'].includes(task.topicId)) ? 'strict' : 'result_only'`, and **none of the 221 tasks currently sets `validationMode` explicitly**. This means step 8 (structural validation) **actually runs for only ~24/221 tasks (`select`+`where` topicId, ~11%)**. For the remaining ~89% of tasks (join, group-by, subqueries, CTE, window-functions, etc.) correctness is judged EXCLUSIVELY via `compareResults` (result equality) + `validateRequiredOrderBy` (ORDER BY presence). Don't assume "structural cheating" (e.g. a superfluous/omitted WHERE condition that happens to give the same result) is caught for every task — it isn't.

## Known risks / things to watch out for

- **Frontend role checks are not a security boundary.** `activeUser.role !== 'student'` and similar checks in `Sidebar.jsx`/`ProgressView.jsx`/`App.jsx` are cosmetic — the real boundary is `backend/src/utils/authz.js` + `requireRole`/`canX` checks per route, always freshly derived from the session cookie + a DB lookup. When adding a new role-gated action, the check MUST exist on the backend — the frontend gate is an optional UX improvement, not a substitute.
- **`matchesSessionFilters` has a canonical implementation in `shared/sessionFilters.js`** (repo root, outside `backend/` and `frontend/`), dependency-free (no React/Express/DB). `backend/src/utils/taskFilters.js` requires it directly — real shared logic, no risk of drift on that side. `frontend/src/utils/taskFilters.js` still keeps ITS OWN copy of the same function (**not** a re-export) — a direct `import` from `shared/` was tried and deliberately abandoned: Vite's dev server only does CJS→ESM interop for `node_modules` dependencies, never for the project's own source files, so a direct import worked in a production `vite build` but crashed the dev server with a runtime "does not provide an export" error (a blank white page — this actually happened, see the git history). That's why `vite.config.js` **has no** `commonjsOptions` hack for `shared/` — deliberately removed since it only fixed the build, not dev. The risk of the frontend copy drifting from `shared/sessionFilters.js` is covered by the `test:session-filters` test (26 cases: topic/difficulty/project/category/mixed/empty filters + Part B, which compares the frontend copy's source text against `shared/`, whitespace-normalized, and fails loudly on any difference). If you change the filter logic, change BOTH files (`shared/sessionFilters.js` and `frontend/src/utils/taskFilters.js`) and run `npm run test:session-filters`.
- **`ProgressView.jsx` and `Sidebar.jsx` are large, multi-responsibility files** (~855 and ~780 lines, both having grown further with the archive/restore UI) — before making any change, read the whole file, don't assume responsibilities are clearly separated within it.
- **There are no automated frontend/e2e tests** (no Playwright, no unit tests, no `test` script in `frontend/package.json`). The `activeUser`/`viewedUser` review-mode boundary (see the invariant above) is currently protected ONLY by manual testing and code comments — **don't add new role/review features before at least a basic frontend test exists around this boundary**, since a regression here isn't just a UI bug but a security-adjacent one.
- **The SQL safety layer has a known hole** (`SELECT ... INTO`, see Check-answer flow above) and no DB-level backup (no restricted/read-only role). Be careful when extending the query execution path (`queryRunner.js`, `query.js`, `tasks.js`) — don't assume "SELECT only" is guaranteed at the database level, it's only guaranteed at the level of this one validator.
- `POST /api/query` always requires login (401 `{ "error": "Authentication required" }` with no session), regardless of `taskId` — it previously also worked while logged out when `taskId` wasn't sent (the largest unauthenticated surface in the API), now fixed. Covered by the `test:query-tasks-authz` test (case 5b + cases 7-9 for student/mentor/admin without a `taskId`).
- The user lifecycle UI is now complete for the basic operations — an admin can create, delete, reset the password of, **and change the role** of a user (`UserManagementView.jsx`, all admin-only). What remains: self-service password change, a forgot-password flow, and an audit log of admin actions (see Auth / session model above).
- **Deleting a user is permanent and a hard-delete** — deletes every session/task_attempts/user_task_progress **owned** by that user (see `routes/users.js` `DELETE /:id`). Sessions that user only **created** for someone else (a mentor for a student) remain untouched, only their `created_by_user_id` becomes `NULL` (`ON DELETE SET NULL`, see initDb.js). `mentor_assignments` rows are cleaned up automatically at the DB level (`ON DELETE CASCADE` in both directions). There is no soft-delete/archive for accounts — if this turns out to be too risky, consider a `deleted_at` approach before the number of users grows.
- The cinema/football/nation datasets are selectable when creating a session even though they have no tasks (see Dataset/task system above) — don't assume they're ready for production/demo until content is added or the picker filters them out.

## Query safety limits

`backend/src/utils/queryRunner.js` — `executeUserQuery(sql, schemaName)`:
- Acquires a dedicated pool client.
- `SET statement_timeout = QUERY_TIMEOUT` (default: 5000ms, env: `QUERY_TIMEOUT_MS`).
- `SET search_path = <schemaName>, pg_catalog`.
- `finally` always resets both (`statement_timeout = 0`, `search_path = public, pg_catalog`) and releases the client.
- Timeout → pg error code `57014`.
- The row limit (default: 1000, env: `QUERY_ROW_LIMIT`) is checked by the **caller** (`tasks.js`/`query.js`), not by `queryRunner` itself.

`/api/query`: row limit check → 400 error; timeout → 400 error.
`/api/tasks/:id/check`: the row limit check fires **before** `compareResults` (prevents a false-positive match).

Solution SQL always runs via `executeSolutionQuery` — no timeout (same `search_path`, no row limit since it's trusted).

## Verification scripts

All live in `backend/scripts/`, run via `npm run test:*` (no Jest/Mocha — each script is a standalone Node program with a `pass`/`fail` printer, `process.exit(1)` on failure). Breakdown:

**Pure-logic (no DB, instant):**
```bash
cd backend
npm run test:sql-validator        # SQL structure validator
npm run test:compare-results      # Result comparator
npm run test:sql-safety           # SQL safety validator
npm run test:order-detection      # ORDER BY detection
npm run test:required-order-by    # ORDER BY enforcement scope
npm run test:session-filters      # matchesSessionFilters (shared/sessionFilters.js) + anti-drift wrapper checks
```

**Live-DB auth/authz/behavior (require a real Postgres connection and `backend/.env`):**
```bash
npm run test:auth                    # login/logout/me
npm run test:password-hashing        # bcrypt hashing/verification
npm run test:authz                   # DELETE /api/users/:id authz + owned-session cascade (task_attempts/user_task_progress/session all removed)
npm run test:authz-helpers           # canAccessUser/canAccessStudent/canCreateSessionForUser/canViewSession
npm run test:users-admin-gate        # GET/POST /api/users admin-only gate
npm run test:user-password-reset     # PATCH /api/users/:id/password authz + behavior + legacy NULL-hash case + session invalidation
npm run test:user-role-edit          # PATCH /api/users/:id/role authz + last-admin guard + mentor_assignments cleanup + live session effect
npm run test:admin-summary           # GET /api/users/admin-summary authz + response shape + count deltas
npm run test:users-role              # role assignment/validation
npm run test:reopen-authz            # PATCH /:id/reopen admin/mentor/student matrix
npm run test:session-ownership       # basic session CRUD isolation
npm run test:session-create-for-user # POST /api/sessions with targetUserId
npm run test:session-read-for-user   # GET /api/sessions with targetUserId
npm run test:session-creator-delete  # created_by_user_id ON DELETE SET NULL
npm run test:session-archive-authz   # archive/restore authz matrix, visibility, data-preservation, archived-guards
npm run test:sessions-read-authz     # GET /api/sessions + /:id/filters full matrix
npm run test:sessions-write-authz    # create/update/complete/open/delete full matrix (the largest suite)
npm run test:progress-authz          # GET /api/progress/* authz
npm run test:progress-read-for-user  # ?targetUserId= on the progress routes
npm run test:query-tasks-authz       # auth requirements on /api/query and /api/tasks/:id/check
npm run test:query-limits            # row limit + timeout
npm run test:solution-authz          # GET /api/tasks/:id/solution requires login
npm run test:mentor-assignments-schema  # mentor_assignments schema + created_by_user_id migration
npm run test:mentor-assignments-api     # admin CRUD on /api/mentor-assignments
npm run test:mentor-students            # GET /api/mentor/students(/summary, /:id/sessions) — mentor-only scoping, assigned-vs-unassigned, admin access to sessions, archived sessions included
```

**End-to-end setup:**
```bash
npm run test:setup-flow    # a complete setup flow on a disposable test DB (DATABASE_URL=...sql_practice_e2e_test)
```

**Dataset tooling (not a test, operational scripts):**
```bash
npm run dataset:generate-config -- <datasetKey>
npm run dataset:build-sample -- <datasetKey>
npm run dataset:import -- <datasetKey>
npm run dataset:reset -- <datasetKey>
```

There is no CI configuration in the repo that would run these scripts automatically — they currently need to be run by hand before trusting that a change hasn't broken the auth/checking logic.

## Recommended next tasks

1. **Fill the empty-dataset-picker gap** — either filter cinema/football/nation out of the session-creation picker while they have no tasks, or write a first set of tasks for one of them.
2. **Self-service password change** and an **audit log of admin actions** remain deliberately unimplemented (see Auth / session model above) — the user lifecycle UI (create/delete/reset password/edit role) is otherwise complete now.
3. **Add frontend review-mode tests** — cover the `activeUser`/`viewedUser` boundary (see the invariant above) before adding new role/review features.
4. **Refactor the large components** — extract `EditPlanForm`/`SessionSummaryCard` from `ProgressView.jsx`, and `SessionSwitcher`/`DbTreeNav`/`AccountPanel` from `Sidebar.jsx`.

## Development rules

- **Run non-destructive commands without asking**: npm scripts, node scripts, bash commands, SQL SELECT queries — run and report results directly. Ask only before destructive or irreversible actions (deleting data, dropping tables, force-push, deleting files).
- **Don't add noisy console.log** in production code paths.
- **Don't add `validationMode` to tasks.json globally** — set it only per-task where needed.
- **Don't expose the solution SQL to the frontend** — only derived booleans (e.g. `solutionHasJoin`), except via the explicit `/api/tasks/:id/solution` route.
- **Don't trust frontend role checks as a security boundary** — every role-gated action must have a corresponding backend check (`requireRole` or a `canX` function from `authz.js`).
- **Don't add new role/review features (e.g. a new role, another review level) before at least a basic frontend test exists around the `activeUser`/`viewedUser` boundary.**
- Write comments only for the non-obvious WHY, not the WHAT.
