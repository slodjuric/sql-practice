// A session is "completed" once its status flips to 'completed' — this is
// completion state, independent of archived_at (archiving is orthogonal
// lifecycle visibility, not a status value — see the Sessions/plans model
// in CLAUDE.md). Centralizes the repeated `session.status === 'completed'`
// check (Sidebar, ProgressView, MyStudentsView, TaskView) so a future
// change to how completion is represented only needs updating here.
export function isSessionCompleted(session) {
  return session?.status === 'completed';
}
