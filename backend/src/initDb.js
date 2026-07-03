const pool = require('./db');

async function initDb() {
  // Migration: drop legacy practice tables from public schema.
  // These were moved to the academic schema (npm run db:init).
  // Drop is safe and idempotent — CASCADE handles foreign-key order.
  await pool.query(`
    DROP TABLE IF EXISTS public.exams              CASCADE;
    DROP TABLE IF EXISTS public.professor_subjects CASCADE;
    DROP TABLE IF EXISTS public.students           CASCADE;
    DROP TABLE IF EXISTS public.professors         CASCADE;
    DROP TABLE IF EXISTS public.subjects           CASCADE;
    DROP TABLE IF EXISTS public.departments        CASCADE;
    DROP TABLE IF EXISTS public.faculties          CASCADE;
  `);

  // ── Datasets registry ────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS datasets (
      id          SERIAL PRIMARY KEY,
      key         VARCHAR(50) UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      schema_name VARCHAR(50) NOT NULL,
      description TEXT,
      type        VARCHAR(20) NOT NULL DEFAULT 'official',
      is_active   BOOLEAN NOT NULL DEFAULT true,
      created_by  INTEGER NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO datasets (key, name, schema_name, description, type)
    VALUES ('academic', 'Academic', 'academic',
            'University practice dataset with faculties, departments, professors, subjects, students and exams',
            'official')
    ON CONFLICT (key) DO NOTHING
  `);

  // ── Users ────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   VARCHAR(50) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Migration: add role to users — existing rows default to 'student'.
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'student'
  `);
  await pool.query(`
    UPDATE users SET role = 'student' WHERE role IS NULL
  `);

  // Migration: enforce allowed role values
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_role_valid'
          AND conrelid = 'users'::regclass
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT users_role_valid CHECK (role IN ('admin', 'mentor', 'student'));
      END IF;
    END $$;
  `);

  // Migration: add password_hash to users — nullable, no default, no backfill.
  // Existing accounts stay password-less until set explicitly via
  // scripts/set-user-password.js; real login does not exist yet.
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash TEXT
  `);

  await pool.query(`
    INSERT INTO users (username) VALUES ('default')
    ON CONFLICT (username) DO NOTHING
  `);

  // ── Learning sessions ────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS learning_sessions (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      description    TEXT,
      status         TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'completed')),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at   TIMESTAMPTZ,
      last_opened_at TIMESTAMPTZ
    )
  `);

  // Ensure every user has at least one session (idempotent)
  await pool.query(`
    INSERT INTO learning_sessions (user_id, name)
    SELECT id, 'Default Session'
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM learning_sessions ls WHERE ls.user_id = u.id
    )
  `);

  // ── task_attempts ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_attempts (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      session_id    INTEGER REFERENCES learning_sessions(id) ON DELETE CASCADE,
      task_id       INTEGER NOT NULL,
      submitted_sql TEXT NOT NULL,
      is_correct    BOOLEAN,
      error_message TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Migration: add session_id to pre-existing task_attempts table
  await pool.query(`
    ALTER TABLE task_attempts
    ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES learning_sessions(id) ON DELETE CASCADE
  `);

  // Migration: link orphaned attempts to their user's first session
  await pool.query(`
    UPDATE task_attempts ta
    SET session_id = (
      SELECT ls.id
      FROM learning_sessions ls
      WHERE ls.user_id = ta.user_id
      ORDER BY ls.created_at ASC
      LIMIT 1
    )
    WHERE ta.session_id IS NULL
  `);

  // ── user_task_progress ───────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_task_progress (
      id                 SERIAL PRIMARY KEY,
      user_id            INTEGER NOT NULL REFERENCES users(id),
      session_id         INTEGER REFERENCES learning_sessions(id) ON DELETE CASCADE,
      task_id            INTEGER NOT NULL,
      status             VARCHAR(20) NOT NULL DEFAULT 'not_started'
                           CHECK (status IN ('not_started', 'in_progress', 'solved')),
      attempts_count     INTEGER NOT NULL DEFAULT 0,
      last_submitted_sql TEXT,
      last_attempt_at    TIMESTAMPTZ,
      solved_at          TIMESTAMPTZ
    )
  `);

  // Migration: add session_id to pre-existing user_task_progress table
  await pool.query(`
    ALTER TABLE user_task_progress
    ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES learning_sessions(id) ON DELETE CASCADE
  `);

  // Migration: populate session_id for existing progress rows
  await pool.query(`
    UPDATE user_task_progress utp
    SET session_id = (
      SELECT ls.id
      FROM learning_sessions ls
      WHERE ls.user_id = utp.user_id
      ORDER BY ls.created_at ASC
      LIMIT 1
    )
    WHERE utp.session_id IS NULL
  `);

  // Migration: replace old UNIQUE(user_id, task_id) with UNIQUE(user_id, session_id, task_id)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'user_task_progress_user_id_task_id_key'
          AND conrelid = 'user_task_progress'::regclass
      ) THEN
        ALTER TABLE user_task_progress
          DROP CONSTRAINT user_task_progress_user_id_task_id_key;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'utp_user_session_task_unique'
          AND conrelid = 'user_task_progress'::regclass
      ) THEN
        ALTER TABLE user_task_progress
          ADD CONSTRAINT utp_user_session_task_unique UNIQUE (user_id, session_id, task_id);
      END IF;
    END $$;
  `);

  // Migration: add plan_type to learning_sessions
  await pool.query(`
    ALTER TABLE learning_sessions
    ADD COLUMN IF NOT EXISTS plan_type VARCHAR(20) DEFAULT 'topic'
  `);
  await pool.query(`
    UPDATE learning_sessions SET plan_type = 'topic' WHERE plan_type IS NULL
  `);

  // Migration: add dataset_id to learning_sessions
  await pool.query(`
    ALTER TABLE learning_sessions
    ADD COLUMN IF NOT EXISTS dataset_id INTEGER REFERENCES datasets(id)
  `);

  // Backfill: assign all existing sessions to the academic dataset
  await pool.query(`
    UPDATE learning_sessions
    SET dataset_id = (SELECT id FROM datasets WHERE key = 'academic')
    WHERE dataset_id IS NULL
  `);

  // Migration: replace old status CHECK ('active','locked') with ('active','completed')
  await pool.query(`
    DO $$
    DECLARE
      v_cname TEXT;
    BEGIN
      -- Drop old constraint (whichever name Postgres gave it)
      SELECT cc.conname INTO v_cname
      FROM pg_constraint cc
      JOIN pg_attribute a
        ON a.attnum = ANY(cc.conkey) AND a.attrelid = cc.conrelid
      WHERE cc.conrelid = 'learning_sessions'::regclass
        AND cc.contype = 'c'
        AND a.attname = 'status'
      LIMIT 1;

      IF v_cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE learning_sessions DROP CONSTRAINT %I', v_cname);
      END IF;

      -- Migrate legacy 'locked' rows BEFORE adding the new constraint,
      -- because ADD CONSTRAINT validates all existing rows immediately.
      UPDATE learning_sessions SET status = 'completed' WHERE status = 'locked';

      -- Add new constraint only after data is clean
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ls_status_valid'
          AND conrelid = 'learning_sessions'::regclass
      ) THEN
        ALTER TABLE learning_sessions
          ADD CONSTRAINT ls_status_valid CHECK (status IN ('active', 'completed'));
      END IF;
    END $$;
  `);

  // ── Backfill: reconcile user_task_progress from task_attempts ───────────────
  // user_task_progress is the source of truth for current task status.
  // This migration ensures any gaps or stale attempts_counts are fixed on startup.
  // ON CONFLICT: preserves solved status, syncs attempts_count to the true count,
  //              keeps the earliest solved_at and the latest last_attempt_at.
  await pool.query(`
    INSERT INTO user_task_progress
      (user_id, session_id, task_id, status, attempts_count, last_attempt_at, solved_at)
    SELECT
      ta.user_id,
      ta.session_id,
      ta.task_id,
      CASE
        WHEN COUNT(*) FILTER (WHERE ta.is_correct = true) > 0 THEN 'solved'
        ELSE 'in_progress'
      END AS status,
      COUNT(*) FILTER (WHERE ta.error_message IS NULL) AS attempts_count,
      MAX(ta.created_at)                                AS last_attempt_at,
      MIN(CASE WHEN ta.is_correct = true THEN ta.created_at END) AS solved_at
    FROM task_attempts ta
    WHERE ta.session_id IS NOT NULL
    GROUP BY ta.user_id, ta.session_id, ta.task_id
    ON CONFLICT (user_id, session_id, task_id) DO UPDATE SET
      status = CASE
        WHEN EXCLUDED.status = 'solved' OR user_task_progress.status = 'solved' THEN 'solved'
        ELSE 'in_progress'
      END,
      attempts_count  = GREATEST(user_task_progress.attempts_count, EXCLUDED.attempts_count),
      last_attempt_at = GREATEST(user_task_progress.last_attempt_at, EXCLUDED.last_attempt_at),
      solved_at       = COALESCE(user_task_progress.solved_at, EXCLUDED.solved_at)
  `);

  // ── Learning session filters ─────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS learning_session_filters (
      id           SERIAL PRIMARY KEY,
      session_id   INTEGER NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
      filter_type  VARCHAR(20) NOT NULL,
      filter_value VARCHAR(100) NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Migration: rename locked_at → completed_at (preserves existing timestamps)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'learning_sessions' AND column_name = 'locked_at'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'learning_sessions' AND column_name = 'completed_at'
      ) THEN
        ALTER TABLE learning_sessions RENAME COLUMN locked_at TO completed_at;
      END IF;
    END $$;
  `);

  // Migration: drop is_locked — redundant with status, never read by any code
  await pool.query(`
    ALTER TABLE learning_sessions DROP COLUMN IF EXISTS is_locked
  `);

  // Migration: enforce UNIQUE(user_id, name) — one session name per user
  // Step 1: rename any existing duplicates safely before adding the index.
  //         Keeps the oldest session's name unchanged; suffixes later ones:
  //         "Name (2)", "Name (3)", etc.
  await pool.query(`
    DO $$
    DECLARE
      dup    RECORD;
      suffix INTEGER;
      candidate TEXT;
    BEGIN
      FOR dup IN
        SELECT id, user_id, name,
               ROW_NUMBER() OVER (PARTITION BY user_id, name ORDER BY created_at ASC) AS rn
        FROM learning_sessions
        WHERE (user_id, name) IN (
          SELECT user_id, name FROM learning_sessions
          GROUP BY user_id, name HAVING COUNT(*) > 1
        )
      LOOP
        CONTINUE WHEN dup.rn = 1;  -- keep the oldest unchanged
        suffix := dup.rn;
        LOOP
          candidate := dup.name || ' (' || suffix || ')';
          EXIT WHEN NOT EXISTS (
            SELECT 1 FROM learning_sessions
            WHERE user_id = dup.user_id AND name = candidate AND id <> dup.id
          );
          suffix := suffix + 1;
        END LOOP;
        UPDATE learning_sessions SET name = candidate WHERE id = dup.id;
      END LOOP;
    END $$;
  `);
  // Step 2: create the unique index (idempotent — IF NOT EXISTS)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_sessions_user_name_unique
    ON learning_sessions(user_id, name)
  `);

  console.log('Progress tables ready');
}

module.exports = initDb;
