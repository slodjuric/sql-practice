import { useState } from 'react';
import FormSelect from '../FormSelect';

// Professor/Student picker + Assign button. Owns its own selections, saving
// flag, and error display; `onAssign(mentorId, studentId)` (the container)
// performs the API call and list refresh, and throws on failure so the
// selections are only cleared after a successful assign.
export default function AssignmentForm({ mentors, students, onAssign }) {
  const [selectedMentorId, setSelectedMentorId] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState(null);

  async function handleAssign() {
    if (!selectedMentorId || !selectedStudentId) return;
    setError(null);
    setAssigning(true);
    try {
      await onAssign(parseInt(selectedMentorId, 10), parseInt(selectedStudentId, 10));
      setSelectedMentorId('');
      setSelectedStudentId('');
    } catch (err) {
      setError(err.message);
    } finally {
      setAssigning(false);
    }
  }

  return (
    <>
      <div className="user-mgmt-assign-form">
        <div className="user-mgmt-form-row">
          <label className="user-mgmt-label" htmlFor="assign-mentor">Professor</label>
          <FormSelect
            id="assign-mentor"
            value={selectedMentorId}
            onChange={setSelectedMentorId}
            options={mentors.map(m => ({ value: String(m.id), label: m.username }))}
            placeholder="Select a professor…"
            disabled={assigning || mentors.length === 0}
          />
        </div>

        <div className="user-mgmt-form-row">
          <label className="user-mgmt-label" htmlFor="assign-student">Student</label>
          <FormSelect
            id="assign-student"
            value={selectedStudentId}
            onChange={setSelectedStudentId}
            options={students.map(s => ({ value: String(s.id), label: s.username }))}
            placeholder="Select a student…"
            disabled={assigning || students.length === 0}
          />
        </div>

        <button
          type="button"
          className="user-mgmt-save-btn user-mgmt-assign-btn"
          onClick={handleAssign}
          disabled={assigning || !selectedMentorId || !selectedStudentId}
        >
          {assigning ? 'Assigning…' : 'Assign'}
        </button>
      </div>

      {error && <div className="user-mgmt-error">{error}</div>}
    </>
  );
}
