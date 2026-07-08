# SQL Practice

An interactive web app for learning SQL against real PostgreSQL databases — 221 tasks (in the current, main dataset) checked directly against the database, with an in-browser SQL editor, progress tracking, sessions (learning plans), support for multiple datasets, and a login/role system (admin / mentor-"Professor" / student).

**What the app does:**
- Write and run SQL queries directly in the browser (CodeMirror editor, with autocomplete against the real schema).
- **Run Query** — run a query and see the result.
- **Check Answer** — check your query against the solution, with concrete, specific feedback (not just right/wrong — e.g. "wrong number of columns", "row order is not correct", "WHERE condition is too restrictive").
- Track progress per task, per session, per user.
- Create multiple "sessions" (learning plans) — by topic, category, or project, with difficulty filters.
- Works across multiple practice datasets (currently: `academic` is the only one with real tasks — see "Datasets" below).
- Login with a password, three roles with different permissions (see "Roles" below).

## Prerequisites

| Tool | Minimum version |
|------|------------------|
| Node.js | 18+ |
| npm | 9+ |
| PostgreSQL | 14+ |

Check installed versions:

```bash
node --version
npm --version
psql --version
```

---

## Local setup

### 1. Clone the repository

```bash
git clone <repo-url>
cd sql-practice
```

### 2. Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 3. Create the database

PostgreSQL must be running. Create an empty database:

```bash
createdb sql_practice
```

### 4. Configure the connection

```bash
cp backend/.env.example backend/.env
```

Open `backend/.env` and fill in the values for your local PostgreSQL:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=sql_practice
DB_USER=your_pg_username
DB_PASSWORD=your_pg_password
PORT=3001

# Required — the backend refuses to start without this (fail-fast check in src/index.js).
# Generate a real random value for your local .env; don't leave "change-me".
SESSION_SECRET=change-me
```

> `DB_PASSWORD` can be left empty if your local PostgreSQL user doesn't require a password.

**Note on `DATABASE_URL`:** a couple of helper scripts (`backend/scripts/run-sql-file.js`, `backend/scripts/check-setup-flow.js`) also accept a single `DATABASE_URL` connection string instead of individual `DB_*` variables, and prefer it if set. **The main application (`backend/src/db.js`) does not support this** — it always builds its connection exclusively from `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`. For normal app operation, fill in the `DB_*` variables; `DATABASE_URL` is an optional extra only for those two scripts.

### 5. Initialize the practice tables (academic dataset)

```bash
cd backend
npm run db:init
```

This command runs `backend/scripts/run-sql-file.js`, which **defaults to `backend/db/schemas/academic.sql`** and:
- creates 7 practice tables in the `academic` schema: `faculties`, `departments`, `professors`, `subjects`, `students`, `exams`, `professor_subjects`
- fills them with demo data (90 students, 160 exams, etc.)
- **does not touch** the tables for user progress and application data: `users`, `learning_sessions`, `task_attempts`, `user_task_progress`, `datasets`, `mentor_assignments` (those are created automatically by `initDb.js` on backend server startup, in the `public` schema)

You can re-run `db:init` at any time to reset just the `academic` practice data, without losing user accounts, sessions, or progress.

> **Note:** `backend/db/init-practice-db.sql` (a file at the root of the `db/` folder) is an older version that created the same tables in the `public` schema instead of the `academic` schema. It is **no longer used** for normal setup — `npm run db:init` is already pointed at `db/schemas/academic.sql`. The file is kept only as a historical reference; `initDb.js` even has a migration that drops old `public.*` versions of these tables on server startup if they exist from an earlier setup.

### 6. Create the first admin account

The login system is real (bcrypt + server-side sessions), but **there is no scripted "bootstrap" for the first admin account** — on its first startup, `initDb.js` creates only a single `'default'` account, with role `student` and no password. To have an admin account for managing users, you need to (after the backend server's first startup, step 8 below):

```bash
# 1. Manually change the 'default' account's role via psql:
psql sql_practice -c "UPDATE users SET role = 'admin' WHERE username = 'default';"

# 2. Set its password via the CLI script (min. 8 characters):
cd backend
node scripts/set-user-password.js default <your-password>
```

After this you can log in as `default` (admin) and create the other accounts (mentor/student) directly through the User Management screen in the app.

To change or reset the password of any existing account later, use the same script:
```bash
node scripts/set-user-password.js <username> <new-password>
```
There is no "forgot password"/self-service reset in the app itself — only this CLI script.

### 7. Run the app

Open **two** terminals:

```bash
# Terminal 1 — backend (port 3001)
cd backend
npm run dev
```

```bash
# Terminal 2 — frontend (port 3000)
cd frontend
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

> The Vite dev server in this project is configured for **port 3000** (`frontend/vite.config.js`), not Vite's default 5173. `/api/*` calls are automatically proxied to `http://localhost:3001` (same file) — no extra configuration is needed for local development.

### 8. Verification

Optional — confirm the whole setup is correct:

```bash
cd backend
npm run test:setup-flow
```

This script creates a temporary test database, walks through the full setup flow (init → app tables → create user → session → attempt a task → a second db:init), and drops the test database at the end.

---

## Roles and permissions

Three roles: **admin**, **mentor** (shown in the app as "Professor" — the DB value stays `mentor`), **student**.

| Role | What it can do |
|---|---|
| **Admin** | Manages users (creates/deletes accounts — see "Deleting users" below), manages mentor↔student links (who mentors whom), can review any user's sessions/progress, archives/restores/reopens any session. |
| **Mentor / "Professor"** | Sees the list of students assigned to them, creates/edits/archives/restores/reopens sessions (plans) for assigned students, reviews their progress. Cannot see/manage students who aren't assigned to them. |
| **Student** | Solves tasks, picks among sessions assigned to them, tracks their own progress. Cannot create/edit/archive/reopen a session — the only "management" action allowed to a student is marking their own session as completed, once every task in the plan has been run at least once. |

Assigning a mentor to a student is done by an admin, in the User Management screen ("Assignments" tab).

**These role checks are actually enforced on the backend** (not just hiding buttons in the UI) — every API call that touches someone else's data (another session, another user's progress) is independently re-authorized on the server based on the logged-in user from the session, not on anything the frontend sends.

---

## Deleting users — admin only, permanent

In the User Management screen ("Users" tab), an admin now has a **Delete** button for every row except their own account:

- The button is **not shown** for the currently logged-in admin — deleting your own account still goes through the separate "🗑" button in the Sidebar (self-delete, existing, separate flow, with its own confirmation).
- Clicking asks for explicit confirmation that explains exactly what happens (not a generic "Are you sure?"):
  - All sessions, progress, and answer history **owned** by that account are **permanently deleted** — no undo.
  - Sessions that user only **created** for someone else (e.g. a professor who set up a plan for a student) **remain untouched** — they just stop showing who created them.
  - For professors, an extra note that their student assignments are also removed.
- After a successful delete: the row disappears from the table, a success message is shown, and if that user was currently being reviewed (viewedUser in review mode), the review closes automatically.
- Mentors and students **do not see** the User Management screen at all (the route only exists for `activeUser.role === 'admin'`), and cannot delete a user via a direct API call either — `DELETE /api/users/:id` is admin-only on the backend, independent of the frontend.
- An admin cannot delete the last remaining admin account (backend guard) — this prevents completely locking the platform out of admin access.

Authorization details, exact cascade behavior (what gets deleted, what stays), and the API shape: [`CLAUDE.md`](CLAUDE.md#rolepermission-model).

---

## Sessions (learning plans) — archive instead of delete

Removing a session from the visible list goes through **Archive**, not permanent deletion:

- The button in the Sidebar ("🗄 Archive session") hides the session from the normal list, but **preserves its complete history** — all `task_attempts` (attempts), `user_task_progress` (per-task progress), plan filters, ownership/creator, `completed_at`, `last_opened_at`, and dataset all remain untouched in the database.
- Archived sessions are not shown in the normal dropdown and cannot be run/checked (Run Query / Check Answer return a clear error if attempted anyway).
- The **"Show archived sessions"** toggle in the Sidebar (visible to admin/mentor, not students) shows archived sessions with a **Restore** button — restoring returns the session to the normal list, but does not automatically select it as active.
- Who may archive/restore: admin any session; mentor their own or an assigned student's; student never (same rule as edit/reopen).
- **Permanent deletion (`DELETE /api/sessions/:id`) still exists in the backend, but is no longer part of the normal UI flow** — no button calls it. It remains solely for direct API/DB maintenance work (e.g. deleting a test account), since it irreversibly destroys attempt and progress history. Don't rely on it as a way to "clean up" a session — use Archive.

Authorization details and the exact API shape: [`CLAUDE.md`](CLAUDE.md#sessionsplans-model).

---

## Datasets — current state

The app supports multiple practice datasets (each in its own PostgreSQL schema), but **currently only one has real tasks**:

| Dataset | Status | Number of tasks |
|---|---|---|
| **academic** | Ready to practice | **221** |
| cinema | Infrastructure only — schema + data imported, **no tasks** | 0 |
| football | Infrastructure only — schema + data imported, **no tasks** | 0 |
| nation | Infrastructure only — schema + data imported, **no tasks** | 0 |

**Note:** these three "empty" datasets can currently be selected when creating a new session (the session-creation picker doesn't filter them out), but a user who picks one would see an empty task list everywhere in Practice/Progress. If you're testing the app, use the **academic** dataset for any session that needs real tasks.

### Database — academic schema

```
faculties
  └── departments (faculty_id)
        ├── professors (department_id)
        ├── subjects   (faculty_id, department_id)
        └── students   (faculty_id, department_id)
              └── exams (student_id, subject_id, professor_id)

professor_subjects (professor_id, subject_id)
```

| Table | Rows |
|--------|--------|
| faculties | 6 |
| departments | 17 |
| professors | 10 |
| subjects | 48 |
| students | 90 |
| exams | 160 |
| professor_subjects | 50 |

Tasks cover: SELECT basics, WHERE, Sorting, Aggregate Functions, GROUP BY/HAVING, JOIN, Subqueries, CASE WHEN, Set Operations, CTE, Window Functions, Date Functions, Text Functions, Data Analysis, and 5 Practice Projects (6 tasks each).

---

## Architecture

- **Backend:** Node.js + Express + PostgreSQL (`pg`, no ORM), authentication via `express-session` + `connect-pg-simple` (sessions are stored in the Postgres database itself) + `bcryptjs` for password hashing.
- **Frontend:** React + Vite, CodeMirror 6 for the SQL editor. No router library (navigation is manual, via internal view state).
- **PostgreSQL schemas:**
  - `public` — application data (users, sessions, progress, mentor-student links) — created and migrated automatically by `initDb.js` on every backend server startup.
  - One schema per practice dataset (`academic`, `cinema`, `football`, `nation`) — practice data, created manually (see "Adding a new dataset" below).

Detailed architecture, backend route map, frontend component map, auth/role model, and check-answer flow: [`CLAUDE.md`](CLAUDE.md).

---

## Troubleshooting

**PostgreSQL is not running**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```
Start the PostgreSQL service, e.g. `brew services start postgresql` (macOS) or `sudo service postgresql start` (Linux).

**Database doesn't exist**
```
Error: database "sql_practice" does not exist
```
Run `createdb sql_practice` before `npm run db:init`.

**Authentication error (PostgreSQL)**
```
Error: password authentication failed for user "..."
```
Check `DB_USER` and `DB_PASSWORD` in `backend/.env`.

**Backend won't start — "Missing required environment variable: SESSION_SECRET"**
Add `SESSION_SECRET=<some-random-value>` to `backend/.env` (see step 4 above) — the backend deliberately refuses to start without this.

**"Invalid username or password" on login, even though the account exists**
The account has no password set (`password_hash` is `NULL`) — this is normal for accounts created before the login system existed. Set a password for it via `node scripts/set-user-password.js <username> <password>` (see step 6 above).

**Port already in use**
```
Error: listen EADDRINUSE :::3001
```
Change `PORT` in `backend/.env`. If you change the backend port, also update the `target` in `frontend/vite.config.js`'s `server.proxy['/api']` to match the new port.

**`.env` accidentally added to git**
`.env` is listed in `.gitignore` and must never be committed. If it was, remove it from git tracking:
```bash
git rm --cached backend/.env
git commit -m "remove .env from tracking"
```
Rotate every password/secret that was in that file (including `SESSION_SECRET`).

---

## Adding a new dataset

See [docs/adding-new-dataset.md](docs/adding-new-dataset.md) for the full guide.

Quick summary: put source CSV files in `backend/src/data/datasets/<key>/raw/`, then run three commands from inside `backend/`:

```bash
npm run dataset:generate-config -- <datasetKey>
npm run dataset:build-sample -- <datasetKey>
npm run dataset:import -- <datasetKey>
```

The `csv/` folder is generated automatically — you do not create it manually. To undo and start over for one dataset: `npm run dataset:reset -- <datasetKey>`.

**Note:** this pipeline fills the PostgreSQL schema and tables. It does not write tasks (`tasks.json`) — that is still done by hand, per dataset (see "Datasets — current state" above: this is why cinema/football/nation currently have data but no tasks).

---

## Check-answer flow

How `POST /api/tasks/:id/check` checks a user's SQL against the solution (SQL safety validation → execution → result comparison → structural validation), including known limitations: [docs/check-answer-flow.md](docs/check-answer-flow.md).

---

## Testing

**Backend** — a large number of script-based checks in `backend/scripts/`, run via `npm run test:*` (no Jest/Mocha, each script is a standalone Node program). They cover: SQL safety validation, result comparison, structural validation, ORDER BY detection/enforcement, and a very extensive set of authorization scenarios (session ownership, mentor/student/admin matrix, admin-only gates, etc.). Full list of scripts and what each one checks: [`CLAUDE.md`](CLAUDE.md#verification-scripts).

```bash
cd backend
npm run test:setup-flow          # end-to-end setup flow (requires a live DB connection)
npm run test:sql-validator       # SQL structure validator
npm run test:compare-results     # result comparator
npm run test:sql-safety          # SQL safety validator
npm run test:order-detection     # ORDER BY detection
npm run test:required-order-by   # ORDER BY enforcement scope
npm run test:sessions-write-authz  # largest authz test suite (create/update/complete/open/delete matrix)
# ... and ~20 more test: scripts, see CLAUDE.md or `cat backend/package.json`
```

**Frontend — currently no automated tests.** No Playwright, no unit/component tests, `frontend/package.json` has no `test` script. Verifying frontend functionality is currently entirely manual. This is a known, documented gap (don't assume tests exist or run in some CI — no CI configuration currently exists for this repo).

---

## Notes for developers

- The `.env` file is not committed — use `.env.example` as a template for configuration.
- Old development scripts (`backend/db/legacy/01_create_tables.sql` etc.) are archived and **not used** for normal setup — use only `npm run db:init`.
- `backend/db/init-practice-db.sql` is also an old/superseded version (see "Initialize the practice tables" above) — not used, kept only as a reference.
- The app is currently at an internal/MVP maturity level — suitable for a single teacher/mentor with a known, small number of students on a trusted local/internal network. It is not yet ready for public/production hosting without additional hardening (login rate limiting, DB-level read-only enforcement for user SQL, audit log, etc. — details in `CLAUDE.md`).
- Architecture details, backend route map, frontend component map, auth/role model, sessions/plans model, check-answer flow, and rules for AI assistants: [`CLAUDE.md`](CLAUDE.md)
