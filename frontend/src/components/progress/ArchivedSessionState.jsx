// Defense-in-depth only (see the guard in ProgressView's load) — under
// normal navigation an archived session can never become activeSession,
// since the session list excludes archived sessions by default and restoring
// one deliberately does not auto-select it. If it somehow happens anyway (a
// stale reference from another tab, for example), this replaces the
// dashboard with a clear, specific message instead of firing a request the
// backend would just 403.
export default function ArchivedSessionState({ activeSession }) {
  return (
    <div>
      <div className="page-header"><h2>Progress</h2></div>
      <div className="page-body">
        <div className="progress-empty-state">
          <h3 className="progress-empty-state-title">"{activeSession.name}" is archived.</h3>
          <p className="progress-empty-state-text">
            Restore it from "Show archived sessions" in the sidebar, or select a different session.
          </p>
        </div>
      </div>
    </div>
  );
}
