// Shown instead of the full dashboard whenever there is no activeSession at
// all — previously the backend's "no session" fallback (a synthetic summary
// covering every academic task, all unsolved) rendered as if a real 221-task
// plan existed. Wording varies by context; only mentor/admin ever get a
// create-session action (students can never create their own session).
export default function NoSessionState({ activeUser, viewedUser, onRequestCreateSession }) {
  let title;
  let description;
  let buttonLabel = null;

  if (viewedUser) {
    title = `No sessions for ${viewedUser.username} yet.`;
    description = "Create a session to assign tasks and start tracking this student's progress.";
    buttonLabel = `Create session for ${viewedUser.username}`;
  } else if (activeUser.role === 'student') {
    title = 'No session has been assigned to you yet.';
    description = 'Ask your professor or an admin to create one for you.';
  } else {
    title = 'No session yet.';
    description = 'Create a session to start practicing.';
    buttonLabel = 'Create a session';
  }

  return (
    <div>
      <div className="page-header"><h2>Progress</h2></div>
      <div className="page-body">
        <div className="progress-empty-state">
          <h3 className="progress-empty-state-title">{title}</h3>
          <p className="progress-empty-state-text">{description}</p>
          {buttonLabel && (
            <button className="btn btn-primary" onClick={() => onRequestCreateSession?.()}>
              {buttonLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
