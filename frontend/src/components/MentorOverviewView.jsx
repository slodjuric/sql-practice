import { useState, useEffect } from 'react';
import { api } from '../api';
import { roleLabel } from '../utils/roleLabels';
import { fetchStudentStats, formatDateShort } from '../utils/studentRoster';
import { useSortableRows } from '../utils/useSortableRows';
import SortableTh from './shared/SortableTh';

// Admin reviewing a Professor/Mentor: a professor's own owned sessions are
// rarely meaningful (their job is managing students, not solving tasks), so
// instead of the normal ProgressView this shows their assigned-student
// roster. Reuses existing admin-authorized endpoints only — no new backend
// route: GET /api/mentor-assignments (admin-only, already returns every
// mentor<->student pair) filtered client-side by this mentor's id, then
// fetchStudentStats (progress summary + sessions list) per assigned student
// — the same helper MyStudentsView uses for the mentor's own roster.
export default function MentorOverviewView({ mentor, onReviewStudent }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.mentorAssignments.list()
      .then(async (assignments) => {
        const assigned = assignments.filter(a => a.mentor_id === mentor.id);
        const withSummaries = await Promise.all(assigned.map(async (a) => ({
          id: a.student_id,
          username: a.student_username,
          role: a.student_role,
          assignedAt: a.created_at,
          ...(await fetchStudentStats(a.student_id)),
        })));
        if (!cancelled) setRows(withSummaries);
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [mentor.id]);

  // This is a roster overview (not a query result), so click-to-sort is safe
  // here — see useSortableRows/SortableTh. Role sorts by its displayed label,
  // and "Solved / Total" sorts by the raw solved count.
  const { sortedRows, sortKey, sortDir, requestSort } = useSortableRows(rows, (r, key) => {
    if (key === 'role') return roleLabel(r.role);
    if (key === 'solved') return r.solved;
    return r[key];
  });

  return (
    <div className="user-mgmt-view">
      <div className="page-header">
        <h2>Students assigned to {mentor.username}</h2>
        <p>Overview of sessions and progress for each assigned student. Practice actions remain your own.</p>
      </div>

      <div className="page-body">
        {loading ? (
          <div className="loading">Loading students…</div>
        ) : error ? (
          <div className="user-mgmt-error">{error}</div>
        ) : rows.length === 0 ? (
          <div className="user-mgmt-hint">This professor has no assigned students yet.</div>
        ) : (
          <table className="result-table user-mgmt-table">
            <thead>
              <tr>
                <SortableTh label="Username" sortKey="username" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortableTh label="Role" sortKey="role" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortableTh label="Solved / Total" sortKey="solved" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortableTh label="Sessions" sortKey="sessionCount" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortableTh label="Last activity" sortKey="lastActivity" activeSortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(s => (
                <tr key={s.id}>
                  <td>{s.username}</td>
                  <td>{roleLabel(s.role)}</td>
                  <td>{s.totalTasks == null ? '—' : `${s.solved} / ${s.totalTasks}`}</td>
                  <td>{s.sessionCount}</td>
                  <td>{formatDateShort(s.lastActivity)}</td>
                  <td>
                    <button
                      type="button"
                      className="user-mgmt-view-student-btn"
                      onClick={() => onReviewStudent?.(s)}
                    >
                      Review progress
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
