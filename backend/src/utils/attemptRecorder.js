const pool = require('../db');

async function saveRunAttempt(userId, sessionId, taskId, sql, errorMessage) {
  try {
    if (!userId || !sessionId) return;

    await pool.query(
      `INSERT INTO task_attempts (user_id, session_id, task_id, submitted_sql, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, sessionId, taskId, sql, errorMessage]
    );

    await pool.query(`
      INSERT INTO user_task_progress (user_id, session_id, task_id, status, attempts_count, last_submitted_sql, last_attempt_at)
      VALUES ($1, $2, $3, 'in_progress', 1, $4, NOW())
      ON CONFLICT (user_id, session_id, task_id) DO UPDATE SET
        status = CASE
          WHEN user_task_progress.status = 'solved' THEN 'solved'
          ELSE 'in_progress'
        END,
        attempts_count     = user_task_progress.attempts_count + 1,
        last_submitted_sql = EXCLUDED.last_submitted_sql,
        last_attempt_at    = NOW()
    `, [userId, sessionId, taskId, sql]);
  } catch (err) {
    console.error('[saveRunAttempt] DB ERROR:', err.message);
  }
}

async function saveCheckAttempt(userId, sessionId, taskId, userSql, isCorrect, errorMessage) {
  try {
    if (!userId || !sessionId) return;

    await pool.query(
      `INSERT INTO task_attempts (user_id, session_id, task_id, submitted_sql, is_correct, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, sessionId, taskId, userSql, isCorrect, errorMessage]
    );

    const newStatus = isCorrect ? 'solved' : 'in_progress';
    const solvedAt  = isCorrect ? new Date() : null;

    await pool.query(`
      INSERT INTO user_task_progress
        (user_id, session_id, task_id, status, attempts_count, last_submitted_sql, last_attempt_at, solved_at)
      VALUES ($1, $2, $3, $4, 1, $5, NOW(), $6)
      ON CONFLICT (user_id, session_id, task_id) DO UPDATE SET
        status = CASE
          WHEN EXCLUDED.status = 'solved' THEN 'solved'
          WHEN user_task_progress.status = 'solved' THEN 'solved'
          ELSE 'in_progress'
        END,
        attempts_count     = user_task_progress.attempts_count + 1,
        last_submitted_sql = $5,
        last_attempt_at    = NOW(),
        solved_at = CASE
          WHEN user_task_progress.status != 'solved' AND EXCLUDED.status = 'solved' THEN NOW()
          ELSE user_task_progress.solved_at
        END
    `, [userId, sessionId, taskId, newStatus, userSql, solvedAt]);
  } catch (err) {
    console.error('[saveCheckAttempt] DB ERROR:', err.message);
  }
}

module.exports = { saveRunAttempt, saveCheckAttempt };
