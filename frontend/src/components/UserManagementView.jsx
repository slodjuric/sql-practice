import { useState, useEffect, Fragment } from 'react';
import { api } from '../api';
import { roleLabel } from '../utils/roleLabels';
import ConfirmModal from './shared/ConfirmModal';
import { useConfirmDialog } from '../utils/useConfirmDialog';
import AdminSummaryCards from './user-management/AdminSummaryCards';
import CreateUserForm from './user-management/CreateUserForm';
import RoleEditForm from './user-management/RoleEditForm';
import ResetPasswordForm from './user-management/ResetPasswordForm';
import AssignmentForm from './user-management/AssignmentForm';
import AssignmentList from './user-management/AssignmentList';
import { ROLE_OPTIONS, MIN_PASSWORD_LENGTH } from './user-management/constants';

// Reviewing a student shows their progress; reviewing a mentor shows their
// assigned-student roster (Mentor Overview), not their own sessions — the
// button label should set that expectation up front instead of a generic
// "Review" that implies the same thing for every row.
function reviewLabel(role) {
  if (role === 'student') return 'Review progress';
  if (role === 'mentor')  return 'View students';
  return 'View activity';
}

export default function UserManagementView({ activeUser, onReviewUser, onUserDeleted, onSelfRoleChanged, onSelfPasswordReset }) {
  const { confirm, dialogProps } = useConfirmDialog();

  const [activeTab, setActiveTab] = useState('users');

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);

  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState(null);

  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  // Reset-password inline form — keyed by user id so only one row's form is
  // ever open at a time (opening a new one implicitly replaces any other).
  // The password inputs themselves live in ResetPasswordForm, mounted fresh
  // per open.
  const [resettingUserId, setResettingUserId] = useState(null);
  const [resetFormError, setResetFormError] = useState(null);
  const [resetSaving, setResetSaving] = useState(false);

  const [assignments, setAssignments] = useState([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(true);
  const [assignmentsError, setAssignmentsError] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  // Edit-role inline form — same keyed-by-user-id pattern as the reset
  // password row above, so only one row's form is open at a time.
  const [editingRoleId, setEditingRoleId] = useState(null);
  const [editRoleError, setEditRoleError] = useState(null);
  const [editRoleSaving, setEditRoleSaving] = useState(false);

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

  // Aggregated counts for the summary cards above the table — fetched once
  // on mount, and refreshed after any action that could change the numbers
  // (create/delete/role-change all call this again).
  function loadSummary() {
    setSummaryError(null);
    api.users.adminSummary()
      .then(setSummary)
      .catch(err => setSummaryError(err.message));
  }

  useEffect(() => {
    loadUsers();
    loadAssignments();
    loadSummary();
  }, []);

  function openForm() {
    setFormError(null);
    setSuccessMessage(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setFormError(null);
  }

  async function handleCreateUser({ username, role, password, confirmPassword }) {
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
      setShowForm(false);
      loadSummary();
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
    const confirmed = await confirm({
      title: 'Delete user',
      message: `Permanently delete "${user.username}" (${roleLabel(user.role)})?`,
      details:
        `This cannot be undone. Any sessions, progress, and answer history OWNED by this account will be permanently deleted.\n\n` +
        `Sessions this user only created on behalf of someone else will NOT be deleted — they remain with their original owner, just without a listed creator.` +
        (user.role === 'mentor' ? `\n\nThis professor's student assignments will also be removed.` : ''),
      confirmLabel: 'Delete user',
      variant: 'danger',
    });
    if (!confirmed) return;

    setDeleteError(null);
    setDeletingId(user.id);
    try {
      await api.users.delete(user.id);
      setUsers(prev => prev.filter(u => u.id !== user.id));
      setSuccessMessage(`User "${user.username}" deleted.`);
      onUserDeleted?.(user.id);
      loadSummary();
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeletingId(null);
    }
  }

  function openResetForm(user) {
    setResettingUserId(user.id);
    setResetFormError(null);
    setSuccessMessage(null);
  }

  function closeResetForm() {
    setResettingUserId(null);
    setResetFormError(null);
  }

  // PATCH /api/users/:id/password deletes every one of the target's active
  // sessions in the same transaction (see backend/src/routes/users.js) —
  // including, when the target is the acting admin themselves, the session
  // this very request is running on. Left unhandled, the UI kept looking
  // logged in while the backend could no longer resolve an acting user, so
  // the next unrelated admin action surfaced a confusing "Acting user is
  // required." instead of a clean re-login prompt. Self-reset is otherwise
  // unrestricted (same as before — resetting a password isn't destructive,
  // so there's no reason to hide this for your own row), it just ends in a
  // full logout instead of a success banner, mirroring how self-role-change
  // already handles the same "this action just invalidated my own access"
  // situation via onSelfRoleChanged.
  async function handleResetPassword(user, newPassword, confirmPassword) {
    setResetFormError(null);

    if (!newPassword) {
      setResetFormError('New password is required.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setResetFormError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setResetFormError('Passwords do not match.');
      return;
    }

    const isSelf = user.id === activeUser?.id;

    setResetSaving(true);
    try {
      await api.users.resetPassword(user.id, newPassword);
      closeResetForm();

      if (isSelf) {
        onSelfPasswordReset?.();
        return;
      }

      setSuccessMessage(`Password reset for "${user.username}".`);
    } catch (err) {
      setResetFormError(err.message);
    } finally {
      setResetSaving(false);
    }
  }

  function openRoleEdit(user) {
    setEditingRoleId(user.id);
    setEditRoleError(null);
    setSuccessMessage(null);
  }

  function closeRoleEdit() {
    setEditingRoleId(null);
    setEditRoleError(null);
  }

  // Changing a role can invalidate mentor_assignments rows for that user
  // (backend cleans these up server-side, see PATCH /api/users/:id/role) —
  // reloading both the summary counts and the assignments list keeps every
  // view in this screen consistent without requiring a manual tab switch.
  //
  // Self-role-change gets its own confirmation and outcome: the acting admin
  // is always currently 'admin' to even see this screen, so changing their
  // OWN role away from admin risks losing access to this screen mid-session.
  // Rather than leave a stale, now-wrong-permission UI on screen, this logs
  // them out immediately on success (via onSelfRoleChanged, wired to the same
  // logout flow as Sidebar's own account panel) so their next login lands on
  // the correct default view for their new role.
  async function handleRoleSave(user, newRole) {
    setEditRoleError(null);

    if (newRole === user.role) {
      closeRoleEdit();
      return;
    }

    const isSelf = user.id === activeUser?.id;
    // Transitions into/out of 'admin' are the only role changes that touch
    // the security perimeter (granting or revoking full administrative
    // access) — mentor<->student stays unconfirmed here since it's already
    // covered by the accurate, consequence-specific hints in RoleEditForm.
    // Backend last-admin protection (PATCH /api/users/:id/role) stays the
    // sole authority on whether a demotion is actually allowed; this is only
    // a confirmation gate, not a duplicate of that check.
    const touchesAdmin = user.role === 'admin' || newRole === 'admin';

    if (isSelf) {
      const confirmed = await confirm({
        title: 'Change your own role',
        message: `You are changing your OWN role from ${roleLabel(user.role)} to ${roleLabel(newRole)}.`,
        details: 'If you no longer have the Admin role, you will lose access to User Management immediately and be logged out so you can log back in with your new role.',
        confirmLabel: 'Change role',
        variant: 'danger',
      });
      if (!confirmed) return;
    } else if (touchesAdmin) {
      const details = newRole === 'admin'
        ? `This grants ${user.username} full administrative access — managing users, roles, mentor assignments, and every session/dataset in the app.`
        : `This immediately removes ${user.username}'s administrative access. They will no longer be able to manage users, roles, or mentor assignments.`;
      const confirmed = await confirm({
        title: `Change role for ${user.username}`,
        message: `Change ${user.username}'s role from ${roleLabel(user.role)} to ${roleLabel(newRole)}?`,
        details,
        confirmLabel: 'Change role',
        variant: 'danger',
      });
      if (!confirmed) return;
    }

    setEditRoleSaving(true);
    try {
      const updated = await api.users.updateRole(user.id, newRole);
      closeRoleEdit();

      if (isSelf) {
        onSelfRoleChanged?.();
        return;
      }

      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, role: updated.role } : u));
      const removedNote = updated.removedAssignments > 0
        ? ` ${updated.removedAssignments} mentor-student assignment${updated.removedAssignments === 1 ? '' : 's'} involving this user ${updated.removedAssignments === 1 ? 'was' : 'were'} removed as a result.`
        : '';
      setSuccessMessage(`Role for "${user.username}" changed to ${roleLabel(updated.role)}.${removedNote}`);
      loadSummary();
      if (updated.removedAssignments > 0) loadAssignments();
    } catch (err) {
      setEditRoleError(err.message);
    } finally {
      setEditRoleSaving(false);
    }
  }

  // AssignmentForm awaits this and only clears its selections when it
  // resolves — a thrown error (surfaced inside the form) keeps them intact.
  // A 200 (already-existing assignment) and a 201 (newly created) are both
  // treated as success — either way the desired assignment exists.
  async function handleAssign(mentorId, studentId) {
    await api.mentorAssignments.create(mentorId, studentId);
    loadAssignments();
  }

  // Removing an assignment takes effect immediately (canAccessStudent is
  // re-derived live on every request, never cached) — the mentor loses
  // access to this student's sessions/progress on their very next request.
  // Not data-destructive (no sessions/progress are touched) and reversible
  // via re-Assign, but with zero prior friction this was the easiest of the
  // admin actions to trigger by accident, so it gets the same danger-variant
  // confirmation as the genuinely destructive actions above.
  async function handleRemove(assignment) {
    const confirmed = await confirm({
      title: 'Remove assignment',
      message: `Remove the assignment between "${assignment.mentor_username}" (Professor) and "${assignment.student_username}" (Student)?`,
      details:
        `"${assignment.mentor_username}" will immediately lose access to ${assignment.student_username}'s sessions and progress.\n\n` +
        `You can re-assign them later if needed.`,
      confirmLabel: 'Remove assignment',
      variant: 'danger',
    });
    if (!confirmed) return;

    setAssignmentsError(null);
    setRemovingId(assignment.id);
    try {
      await api.mentorAssignments.delete(assignment.id);
      setAssignments(prev => prev.filter(a => a.id !== assignment.id));
      setSuccessMessage(`Removed assignment between "${assignment.mentor_username}" and "${assignment.student_username}".`);
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

      <AdminSummaryCards summary={summary} error={summaryError} />

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
            <CreateUserForm
              onSubmit={handleCreateUser}
              onCancel={closeForm}
              saving={saving}
              error={formError}
            />
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
                        {/* Allowed for the admin's own row too — changing your
                            own role is guarded by its own confirmation inside
                            handleRoleSave rather than being hidden here, since
                            an admin correcting their own mistaken role is a
                            legitimate case, not just an accident to prevent. */}
                        <button
                          type="button"
                          className="user-mgmt-edit-role-btn"
                          onClick={() => (editingRoleId === u.id ? closeRoleEdit() : openRoleEdit(u))}
                        >
                          {editingRoleId === u.id ? 'Cancel' : 'Edit role'}
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
                    {editingRoleId === u.id && (
                      <tr className="user-mgmt-reset-row">
                        <td colSpan={7}>
                          <RoleEditForm
                            user={u}
                            saving={editRoleSaving}
                            error={editRoleError}
                            onSave={handleRoleSave}
                            onCancel={closeRoleEdit}
                          />
                        </td>
                      </tr>
                    )}
                    {resettingUserId === u.id && (
                      <tr className="user-mgmt-reset-row">
                        <td colSpan={7}>
                          <ResetPasswordForm
                            user={u}
                            isSelf={u.id === activeUser?.id}
                            saving={resetSaving}
                            error={resetFormError}
                            onSave={handleResetPassword}
                            onCancel={closeResetForm}
                          />
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
          {successMessage && <div className="user-mgmt-success">{successMessage}</div>}

          {!loading && mentors.length === 0 && (
            <div className="user-mgmt-hint">Create a Professor user before assigning students.</div>
          )}
          {!loading && students.length === 0 && (
            <div className="user-mgmt-hint">Create a Student user before assigning students.</div>
          )}

          <AssignmentForm mentors={mentors} students={students} onAssign={handleAssign} />

          {assignmentsLoading ? (
            <div className="loading">Loading assignments…</div>
          ) : assignmentsError ? (
            <div className="user-mgmt-error">{assignmentsError}</div>
          ) : assignments.length === 0 ? (
            <div className="user-mgmt-hint">No professor-student assignments yet.</div>
          ) : (
            <AssignmentList assignments={assignments} removingId={removingId} onRemove={handleRemove} />
          )}
        </div>
      )}

      <ConfirmModal {...dialogProps} />
    </div>
  );
}
