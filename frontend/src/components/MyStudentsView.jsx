import { useState, useEffect } from 'react';
import { api } from '../api';
import { roleLabel } from '../utils/roleLabels';
import { fetchStudentStats, formatDateShort } from '../utils/studentRoster';

export default function MyStudentsView({ onSelectStudent }) {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.mentorStudents.list()
      .then(async (list) => {
        const withSummaries = await Promise.all(list.map(async (s) => ({
          ...s,
          ...(await fetchStudentStats(s.id)),
        })));
        if (!cancelled) setStudents(withSummaries);
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, []);

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
          <table className="result-table user-mgmt-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Assigned</th>
                <th>Solved / Total</th>
                <th>Sessions</th>
                <th>Last activity</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {students.map(s => (
                <tr key={s.id}>
                  <td>{s.username}</td>
                  <td>{roleLabel(s.role)}</td>
                  <td>{new Date(s.assigned_at).toLocaleString()}</td>
                  <td>{s.totalTasks == null ? '—' : `${s.solved} / ${s.totalTasks}`}</td>
                  <td>{s.sessionCount}</td>
                  <td>{formatDateShort(s.lastActivity)}</td>
                  <td>
                    <button
                      type="button"
                      className="user-mgmt-view-student-btn"
                      onClick={() => onSelectStudent?.(s)}
                    >
                      View student
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
