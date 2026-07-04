import { useState, useEffect } from 'react';
import { api } from '../api';
import { roleLabel } from '../utils/roleLabels';

const ROLE_OPTIONS = ['student', 'mentor', 'admin'];
const MIN_PASSWORD_LENGTH = 8;

export default function UserManagementView() {
  const [activeTab, setActiveTab] = useState('users');

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [showForm, setShowForm] = useState(false);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('student');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState(null);

  const [assignments, setAssignments] = useState([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(true);
  const [assignmentsError, setAssignmentsError] = useState(null);
  const [selectedMentorId, setSelectedMentorId] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [assignError, setAssignError] = useState(null);
  const [assigning, setAssigning] = useState(false);
  const [removingId, setRemovingId] = useState(null);

  function loadUsers() {
    setLoading(true);
    setError(null);
    api.users.list()
      .then(setUsers)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }

  function loadAssignments() {
    setAssignmentsLoading(true);
    setAssignmentsError(null);
    api.mentorAssignments.list()
      .then(setAssignments)
      .catch(err => setAssignmentsError(err.message))
      .finally(() => setAssignmentsLoading(false));
  }

  useEffect(() => {
    loadUsers();
    loadAssignments();
  }, []);

  function resetForm() {
    setUsername('');
    setRole('student');
    setPassword('');
    setConfirmPassword('');
    setFormError(null);
  }

  function openForm() {
    resetForm();
    setSuccessMessage(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    resetForm();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    setSuccessMessage(null);

    if (!username.trim()) {
      setFormError('Username is required.');
      return;
    }
    if (!ROLE_OPTIONS.includes(role)) {
      setFormError(`Role must be one of: ${ROLE_OPTIONS.join(', ')}.`);
      return;
    }
    if (!password) {
      setFormError('Password is required.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFormError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      const newUser = await api.users.create(username.trim(), role, password);
      setUsers(prev => [...prev, newUser]);
      setSuccessMessage(`User "${newUser.username}" created successfully.`);
      resetForm();
      setShowForm(false);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAssign() {
    if (!selectedMentorId || !selectedStudentId) return;
    setAssignError(null);
    setAssigning(true);
    try {
      // A 200 (already-existing assignment) and a 201 (newly created) are
      // both treated as success — either way the desired assignment exists.
      await api.mentorAssignments.create(
        parseInt(selectedMentorId, 10),
        parseInt(selectedStudentId, 10)
      );
      setSelectedMentorId('');
      setSelectedStudentId('');
      loadAssignments();
    } catch (err) {
      setAssignError(err.message);
    } finally {
      setAssigning(false);
    }
  }

  async function handleRemove(assignmentId) {
    setAssignmentsError(null);
    setRemovingId(assignmentId);
    try {
      await api.mentorAssignments.delete(assignmentId);
      setAssignments(prev => prev.filter(a => a.id !== assignmentId));
    } catch (err) {
      setAssignmentsError(err.message);
    } finally {
      setRemovingId(null);
    }
  }

  const mentors = users.filter(u => u.role === 'mentor');
  const students = users.filter(u => u.role === 'student');

  return (
    <div className="user-mgmt-view">
      <div className="page-header">
        <h2>User Management</h2>
        <p>Manage application users and roles.</p>
      </div>

      <div className="user-mgmt-tabs">
        <button
          type="button"
          className={`user-mgmt-tab ${activeTab === 'users' ? 'active' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          Users
        </button>
        <button
          type="button"
          className={`user-mgmt-tab ${activeTab === 'assignments' ? 'active' : ''}`}
          onClick={() => setActiveTab('assignments')}
        >
          Assignments
        </button>
      </div>

      {activeTab === 'users' && (
        <div className="page-body">
          <div className="user-mgmt-toolbar">
            <button
              type="button"
              className="user-mgmt-add-btn"
              onClick={() => (showForm ? closeForm() : openForm())}
            >
              {showForm ? 'Cancel' : '+ Add user'}
            </button>
          </div>

          {successMessage && <div className="user-mgmt-success">{successMessage}</div>}

          {showForm && (
            <form className="user-mgmt-form" onSubmit={handleSubmit}>
              <div className="user-mgmt-form-row">
                <label className="user-mgmt-label" htmlFor="new-user-username">Username *</label>
                <input
                  id="new-user-username"
                  className="user-mgmt-input"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  disabled={saving}
                  autoComplete="off"
                  autoFocus
                />
              </div>

              <div className="user-mgmt-form-row">
                <label className="user-mgmt-label" htmlFor="new-user-role">Role *</label>
                <select
                  id="new-user-role"
                  className="user-mgmt-select"
                  value={role}
                  onChange={e => setRole(e.target.value)}
                  disabled={saving}
                >
                  {ROLE_OPTIONS.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
                </select>
              </div>

              <div className="user-mgmt-form-row">
                <label className="user-mgmt-label" htmlFor="new-user-password">Password *</label>
                <input
                  id="new-user-password"
                  type="password"
                  className="user-mgmt-input"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={saving}
                  autoComplete="new-password"
                />
              </div>

              <div className="user-mgmt-form-row">
                <label className="user-mgmt-label" htmlFor="new-user-confirm-password">Confirm password *</label>
                <input
                  id="new-user-confirm-password"
                  type="password"
                  className="user-mgmt-input"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  disabled={saving}
                  autoComplete="new-password"
                />
              </div>

              {formError && <div className="user-mgmt-error">{formError}</div>}

              <div className="user-mgmt-form-actions">
                <button type="submit" className="user-mgmt-save-btn" disabled={saving}>
                  {saving ? 'Creating…' : 'Create user'}
                </button>
                <button type="button" className="user-mgmt-cancel-btn" onClick={closeForm} disabled={saving}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {loading ? (
            <div className="loading">Loading users…</div>
          ) : error ? (
            <div className="user-mgmt-error">{error}</div>
          ) : (
            <table className="result-table user-mgmt-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td>{u.username}</td>
                    <td>{roleLabel(u.role)}</td>
                    <td>{new Date(u.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'assignments' && (
        <div className="page-body">
          {!loading && mentors.length === 0 && (
            <div className="user-mgmt-hint">Create a Professor user before assigning students.</div>
          )}
          {!loading && students.length === 0 && (
            <div className="user-mgmt-hint">Create a Student user before assigning students.</div>
          )}

          <div className="user-mgmt-assign-form">
            <div className="user-mgmt-form-row">
              <label className="user-mgmt-label" htmlFor="assign-mentor">Professor</label>
              <select
                id="assign-mentor"
                className="user-mgmt-select"
                value={selectedMentorId}
                onChange={e => setSelectedMentorId(e.target.value)}
                disabled={assigning || mentors.length === 0}
              >
                <option value="">Select a professor…</option>
                {mentors.map(m => <option key={m.id} value={m.id}>{m.username}</option>)}
              </select>
            </div>

            <div className="user-mgmt-form-row">
              <label className="user-mgmt-label" htmlFor="assign-student">Student</label>
              <select
                id="assign-student"
                className="user-mgmt-select"
                value={selectedStudentId}
                onChange={e => setSelectedStudentId(e.target.value)}
                disabled={assigning || students.length === 0}
              >
                <option value="">Select a student…</option>
                {students.map(s => <option key={s.id} value={s.id}>{s.username}</option>)}
              </select>
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

          {assignError && <div className="user-mgmt-error">{assignError}</div>}

          {assignmentsLoading ? (
            <div className="loading">Loading assignments…</div>
          ) : assignmentsError ? (
            <div className="user-mgmt-error">{assignmentsError}</div>
          ) : assignments.length === 0 ? (
            <div className="user-mgmt-hint">No professor-student assignments yet.</div>
          ) : (
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
                    onClick={() => handleRemove(a.id)}
                    disabled={removingId === a.id}
                  >
                    {removingId === a.id ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
