import { useState, useEffect, Fragment } from 'react';
import { api } from '../api';
import { formatDateShort } from '../utils/studentRoster';
import { isSessionCompleted } from '../utils/sessionStatus';
import { useSortableRows } from '../utils/useSortableRows';
import SortableTh from './shared/SortableTh';

// Stable sort order for the derived session status column below — matches
// how a reader would expect these to rank (active work first, then done,
// then put away).
const SESSION_STATUS_RANK = { active: 0, completed: 1, archived: 2 };

function sessionStatusOf(session) {
  if (session.archived_at) return 'archived';
  return isSessionCompleted(session) ? 'completed' : 'active';
}

function SessionStatusCell({ session }) {
  if (session.archived_at) {
    return <span className="session-status-badge session-status-badge--archived">archived</span>;
  }
  const isCompleted = isSessionCompleted(session);
  return (
    <span className={`session-status-badge session-status-badge--${isCompleted ? 'completed' : 'active'}`}>
      {isCompleted ? 'completed' : 'active'}
    </span>
  );
}

// Expandable "View sessions" panel for one student row — fetched fresh every
// time it's opened (simpler than cache invalidation, and this list is small
// per student) via the mentor-only GET /api/mentor/students/:id/sessions.
// Deliberately has only one action per row ("Open") rather than duplicating
// edit/archive/reopen here — Open jumps into the existing review-mode +
// Sidebar tooling that already implements those actions correctly, so this
// panel stays a lightweight history view instead of a second copy of session
// management.
function StudentSessionsPanel({ student, onOpenSession }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.mentorStudents.sessions(student.id)
      .then(list => { if (!cancelled) setSessions(list); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [student.id]);

  // This is a session-history list (not a query result), so click-to-sort
  // is safe here — see useSortableRows/SortableTh. Status sorts by rank
  // (active/completed/archived), not alphabetically.
  const { sortedRows, sortKey, sortDir, requestSort } = useSortableRows(sessions, (s, key) => {
    if (key === 'status') return SESSION_STATUS_RANK[sessionStatusOf(s)];
    if (key === 'solved_count') return s.solved_count;
    return s[key];
  });

  if (loading) return <div className="loading">Loading sessions…</div>;
  if (error) return <div className="user-mgmt-error">{error}</div>;
  if (sessions.length === 0) {
    return <div className="user-mgmt-hint">{student.username} has no sessions yet.</div>;
  }

  return (
    <div className="user-mgmt-table-scroll">
      <table className="result-table student-sessions-table">
        <thead>
          <tr>
            <SortableTh label="Session" sortKey="name" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
            <SortableTh label="Dataset" sortKey="dataset_name" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
            <SortableTh label="Status" sortKey="status" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
            <SortableTh label="Created" sortKey="created_at" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
            <SortableTh label="Solved / Attempted" sortKey="solved_count" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(s => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.dataset_name || '—'}</td>
              <td><SessionStatusCell session={s} /></td>
              <td>{formatDateShort(s.created_at)}</td>
              <td>{s.solved_count} / {s.attempted_count}</td>
              <td>
                <button
                  type="button"
                  className="user-mgmt-view-student-btn"
                  onClick={() => onOpenSession(student, s)}
                >
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MyStudentsView({ onSelectStudent, onCreateSessionForStudent, onOpenStudentSession }) {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.mentorStudents.summary()
      .then(list => { if (!cancelled) setStudents(list); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, []);

  // This is a roster overview (not a query result), so click-to-sort is safe
  // here — see useSortableRows/SortableTh.
  const { sortedRows: sortedStudents, sortKey, sortDir, requestSort } = useSortableRows(students);

  return (
    <div className="user-mgmt-view">
      <div className="page-header">
        <h2>My Students</h2>
        <p>Students assigned to you.</p>
      </div>

      <div className="page-body">
        {loading ? (
          <div className="loading">Loading students…</div>
        ) : error ? (
          <div className="user-mgmt-error">{error}</div>
        ) : students.length === 0 ? (
          <div className="user-mgmt-hint">No students assigned yet. Ask an admin to assign students to you.</div>
        ) : (
          <div className="user-mgmt-table-scroll">
            <table className="result-table user-mgmt-table">
              <thead>
                <tr>
                  <SortableTh label="Username" sortKey="username" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                  <SortableTh label="Assigned" sortKey="assigned_at" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                  <SortableTh label="Active" sortKey="active_sessions" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                  <SortableTh label="Completed" sortKey="completed_sessions" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                  <SortableTh label="Archived" sortKey="archived_sessions" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                  <SortableTh label="Solved" sortKey="solved_count" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                  <SortableTh label="Last activity" sortKey="last_activity" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                  <th></th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedStudents.map(s => (
                  <Fragment key={s.id}>
                    <tr>
                      <td>{s.username}</td>
                      <td>{new Date(s.assigned_at).toLocaleString()}</td>
                      <td>{s.active_sessions}</td>
                      <td>{s.completed_sessions}</td>
                      <td>{s.archived_sessions}</td>
                      <td>{s.solved_count}</td>
                      <td>{formatDateShort(s.last_activity)}</td>
                      <td>
                        <button
                          type="button"
                          className="user-mgmt-view-student-btn"
                          onClick={() => onSelectStudent?.(s)}
                        >
                          View progress
                        </button>
                      </td>
                      <td>
                        {/* The main shortcut this view exists for: skip
                            entering review mode + hunting for the sidebar's
                            "+" button — this opens the create-session form
                            directly, already targeting this student. */}
                        <button
                          type="button"
                          className="user-mgmt-create-session-btn"
                          onClick={() => onCreateSessionForStudent?.(s)}
                        >
                          Create session
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="user-mgmt-view-sessions-btn"
                          onClick={() => setExpandedId(id => id === s.id ? null : s.id)}
                        >
                          {expandedId === s.id ? 'Hide sessions' : 'View sessions'}
                        </button>
                      </td>
                    </tr>
                    {expandedId === s.id && (
                      <tr className="user-mgmt-reset-row">
                        <td colSpan={10}>
                          <StudentSessionsPanel student={s} onOpenSession={onOpenStudentSession} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
