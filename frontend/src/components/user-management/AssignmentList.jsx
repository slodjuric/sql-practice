// Existing professor↔student assignment cards. Removal (with its confirm
// dialog) stays in the container — this only renders the list.
export default function AssignmentList({ assignments, removingId, onRemove }) {
  return (
    <div className="user-mgmt-assignment-list">
      {assignments.map(a => (
        <div className="user-mgmt-assignment-card" key={a.id}>
          <div className="user-mgmt-assignment-info">
            <div><span className="user-mgmt-assignment-label">Professor:</span> {a.mentor_username}</div>
            <div><span className="user-mgmt-assignment-label">Student:</span> {a.student_username}</div>
          </div>
          <button
            type="button"
            className="user-mgmt-cancel-btn user-mgmt-remove-btn"
            onClick={() => onRemove(a)}
            disabled={removingId === a.id}
          >
            {removingId === a.id ? 'Removing…' : 'Remove'}
          </button>
        </div>
      ))}
    </div>
  );
}
