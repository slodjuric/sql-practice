import { useState, useEffect, Fragment } from 'react';
import { api } from '../api';
import { roleLabel } from '../utils/roleLabels';
import PasswordField from './shared/PasswordField';

const ROLE_OPTIONS = ['student', 'mentor', 'admin'];
const MIN_PASSWORD_LENGTH = 8;

// Reviewing a student shows their progress; reviewing a mentor shows their
// assigned-student roster (Mentor Overview), not their own sessions — the
// button label should set that expectation up front instead of a generic
// "Review" that implies the same thing for every row.
function reviewLabel(role) {
  if (role === 'student') return 'Review progress';
  if (role === 'mentor')  return 'View students';
  return 'View activity';
}
export default function UserManagementView({ activeUser, onReviewUser, onUserDeleted }) {
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

  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  // Reset-password inline form — keyed by user id so only one row's form is
  // ever open at a time (opening a new one implicitly replaces any other).
  const [resettingUserId, setResettingUserId] = useState(null);
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');
  const [resetFormError, setResetFormError] = useState(null);
  const [resetSaving, setResetSaving] = useState(false);

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

  // Admin-only, permanent. Deleting a user destroys everything THEY own
  // (their sessions, and each owned session's task_attempts/user_task_progress
  // — see DELETE /api/users/:id) but never touches another user's data:
  // sessions this user only *created* for someone else keep existing, just
  // with created_by_user_id nulled out (ON DELETE SET NULL, see initDb.js),
  // and any mentor_assignments row is cleaned up automatically at the DB
  // level. The confirmation below spells this out rather than a vague
  // "are you sure?", since the two outcomes (owned vs. merely-created data)
  // are easy to conflate.
  async function handleDeleteUser(user) {
    const confirmed = window.confirm(
      `Permanently delete "${user.username}" (${roleLabel(user.role)})?\n\n` +
      `This cannot be undone. Any sessions, progress, and answer history OWNED by this account will be permanently deleted.\n\n` +
      `Sessions this user only created on behalf of someone else will NOT be deleted — they remain with their original owner, just without a listed creator.` +
      (user.role === 'mentor' ? `\n\nThis professor's student assignments will also be removed.` : '')
    );
    if (!confirmed) return;

    setDeleteError(null);
    setDeletingId(user.id);
    try {
      await api.users.delete(user.id);
      setUsers(prev => prev.filter(u => u.id !== user.id));
      setSuccessMessage(`User "${user.username}" deleted.`);
      onUserDeleted?.(user.id);
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeletingId(null);
    }
  }

  function openResetForm(user) {
    setResettingUserId(user.id);
    setResetNewPassword('');
    setResetConfirmPassword('');
    setResetFormError(null);
    setSuccessMessage(null);
  }

  function closeResetForm() {
    setResettingUserId(null);
    setResetNewPassword('');
    setResetConfirmPassword('');
    setResetFormError(null);
  }

  async function handleResetPassword(user) {
    setResetFormError(null);

    if (!resetNewPassword) {
      setResetFormError('New password is required.');
      return;
    }
    if (resetNewPassword.length < MIN_PASSWORD_LENGTH) {
      setResetFormError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (resetNewPassword !== resetConfirmPassword) {
      setResetFormError('Passwords do not match.');
      return;
    }

    setResetSaving(true);
    try {
      await api.users.resetPassword(user.id, resetNewPassword);
      setSuccessMessage(`Password reset for "${user.username}".`);
      closeResetForm();
    } catch (err) {
      setResetFormError(err.message);
    } finally {
      setResetSaving(false);
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
                <PasswordField
                  id="new-user-password"
                  className="user-mgmt-input"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={saving}
                  autoComplete="new-password"
                />
              </div>

              <div className="user-mgmt-form-row">
                <label className="user-mgmt-label" htmlFor="new-user-confirm-password">Confirm password *</label>
                <PasswordField
                  id="new-user-confirm-password"
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

          {deleteError && <div className="user-mgmt-error">{deleteError}</div>}

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
                  <th></th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <Fragment key={u.id}>
                    <tr>
                      <td>{u.username}</td>
                      <td>{roleLabel(u.role)}</td>
                      <td>{new Date(u.created_at).toLocaleString()}</td>
                      <td>
                        <button
                          type="button"
                          className="user-mgmt-review-btn user-mgmt-view-student-btn"
                          onClick={() => onReviewUser?.(u)}
                        >
                          {reviewLabel(u.role)}
                        </button>
                      </td>
                      <td>
                        {/* Allowed for the admin's own row too, unlike Delete
                            below — resetting a password isn't destructive
                            (no data loss, no risk of locking out admin
                            capability), so there's no need to redirect this
                            to a separate self-service flow. */}
                        <button
                          type="button"
                          className="user-mgmt-reset-password-btn"
                          onClick={() => (resettingUserId === u.id ? closeResetForm() : openResetForm(u))}
                        >
                          {resettingUserId === u.id ? 'Cancel' : 'Reset password'}
                        </button>
                      </td>
                      <td>
                        {/* Never shown for the currently logged-in admin's own
                            row — self-delete already has its own dedicated
                            flow (Sidebar's "delete my account" button), with
                            its own confirmation copy. Showing a second delete
                            path here for the same account would be confusing
                            and redundant, not safer. */}
                        {u.id !== activeUser?.id && (
                          <button
                            type="button"
                            className="user-mgmt-delete-btn"
                            onClick={() => handleDeleteUser(u)}
                            disabled={deletingId === u.id}
                          >
                            {deletingId === u.id ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {resettingUserId === u.id && (
                      <tr className="user-mgmt-reset-row">
                        <td colSpan={6}>
                          <form
                            className="user-mgmt-form user-mgmt-reset-form"
                            onSubmit={e => { e.preventDefault(); handleResetPassword(u); }}
                          >
                            <div className="user-mgmt-reset-form-title">Reset password for {u.username}</div>

                            <div className="user-mgmt-form-row">
                              <label className="user-mgmt-label" htmlFor={`reset-password-${u.id}`}>New password *</label>
                              <PasswordField
                                id={`reset-password-${u.id}`}
                                className="user-mgmt-input"
                                value={resetNewPassword}
                                onChange={e => setResetNewPassword(e.target.value)}
                                disabled={resetSaving}
                                autoComplete="new-password"
                                autoFocus
                              />
                            </div>

                            <div className="user-mgmt-form-row">
                              <label className="user-mgmt-label" htmlFor={`reset-confirm-password-${u.id}`}>Confirm password *</label>
                              <PasswordField
                                id={`reset-confirm-password-${u.id}`}
                                className="user-mgmt-input"
                                value={resetConfirmPassword}
                                onChange={e => setResetConfirmPassword(e.target.value)}
                                disabled={resetSaving}
                                autoComplete="new-password"
                              />
                            </div>

                            {resetFormError && <div className="user-mgmt-error">{resetFormError}</div>}

                            <div className="user-mgmt-form-actions">
                              <button type="submit" className="user-mgmt-save-btn" disabled={resetSaving}>
                                {resetSaving ? 'Saving…' : 'Save'}
                              </button>
                              <button type="button" className="user-mgmt-cancel-btn" onClick={closeResetForm} disabled={resetSaving}>
                                Cancel
                              </button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
