/**
 * Converts a raw backend SQL error message into a user-friendly string.
 *
 * context:
 *   'practice' — inside a task (Run Query / Check Answer)
 *   'playground' — Query Playground (no task context)
 */
export function getFriendlySqlErrorMessage(errorMessage, sql, context = 'practice') {
  const msg   = String(errorMessage || '').trim();
  const lmsg  = msg.toLowerCase();
  const query = String(sql || '').trim();
  const lq    = query.toLowerCase();

  if (!query) {
    return 'Please write a SQL query before running it.';
  }

  // Query doesn't start with SELECT or WITH — user typed freeform text or a DML keyword
  if (!lq.startsWith('select') && !lq.startsWith('with')) {
    if (context === 'practice') {
      return 'Please write a SELECT query for this task.\nFor example: SELECT column_name FROM table_name;';
    }
    return 'Please write a SELECT query before running it.';
  }

  // Backend blocked a DML/DDL keyword inside the query
  if (
    lmsg.includes('only read-only select') ||
    lmsg.includes('detected:')
  ) {
    return 'For safety, only read-only SELECT queries are allowed. Destructive keywords (INSERT, UPDATE, DELETE, DROP, …) are not permitted.';
  }

  // PostgreSQL syntax error
  if (lmsg.includes('syntax error')) {
    return `SQL syntax error — check your query and try again.\n\nDetails: ${msg}`;
  }

  // Relation / column not found
  if (lmsg.includes('does not exist')) {
    return `${msg}\n\nTip: check the table and column names in the task description.`;
  }

  // Pass through other real PostgreSQL errors with the original message
  return msg || 'Something went wrong while running your query. Please try again.';
}
