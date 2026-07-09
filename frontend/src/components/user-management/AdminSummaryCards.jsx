const SUMMARY_LABELS = {
  total_users: 'Total Users',
  admins: 'Admins',
  mentors: 'Professors',
  students: 'Students',
  active_sessions: 'Active Sessions',
  completed_sessions: 'Completed Sessions',
  archived_sessions: 'Archived Sessions',
  mentor_assignments: 'Assignments',
};

// Order the summary cards are displayed in — keeps user counts together,
// then session lifecycle counts, then the assignment count.
const SUMMARY_CARD_ORDER = [
  'total_users', 'admins', 'mentors', 'students',
  'active_sessions', 'completed_sessions', 'archived_sessions', 'mentor_assignments',
];

// Aggregated counts above the Users/Assignments tabs — purely presentational,
// data comes from GET /api/users/admin-summary via the container's loadSummary.
export default function AdminSummaryCards({ summary, error }) {
  if (error) {
    return <div className="user-mgmt-error">{error}</div>;
  }
  return (
    <div className="admin-summary-grid">
      {SUMMARY_CARD_ORDER.map(key => (
        <div
          className={`progress-stat-card admin-summary-card${key === 'total_users' ? ' progress-stat-card--main' : ''}`}
          key={key}
        >
          <div className="progress-stat-value">{summary ? summary[key] : '—'}</div>
          <div className="progress-stat-label">{SUMMARY_LABELS[key]}</div>
        </div>
      ))}
    </div>
  );
}
