import { useState } from 'react';
import { roleLabel } from '../../utils/roleLabels';

// Logged-in user block (real identity via /api/auth/me — no switcher).
// Self-delete only — no create/switch; see Step 6c. `confirm` is the
// container's useConfirmDialog function, so the whole sidebar shares one
// ConfirmModal instance.
export default function SidebarUserPanel({ activeUser, onLogout, onDeleteUser, confirm }) {
  const [userDeleting, setUserDeleting] = useState(false);
  const [userDeleteError, setUserDeleteError] = useState(null);

  async function handleDeleteUser() {
    if (!activeUser) return;
    const confirmed = await confirm({
      title: 'Delete my account',
      message: `Are you sure you want to delete your account "${activeUser.username}"?`,
      details: 'This will delete all sessions, progress and activity for this account, and you will be logged out.',
      confirmLabel: 'Delete account',
      variant: 'danger',
    });
    if (!confirmed) return;
    setUserDeleting(true);
    setUserDeleteError(null);
    try {
      await onDeleteUser();
    } catch (err) {
      setUserDeleteError(err.message);
    } finally {
      setUserDeleting(false);
    }
  }

  return (
    <div className="sidebar-user">
      <div className="sidebar-user-name" title={activeUser?.username}>
        {activeUser?.username}
      </div>
      <div className="sidebar-user-row">
        <span className="sidebar-user-role">{roleLabel(activeUser?.role)}</span>
        <div className="sidebar-user-controls">
          {activeUser?.role === 'admin' && (
            <button
              className="sidebar-delete-user-btn"
              onClick={handleDeleteUser}
              title="Delete my account"
              disabled={userDeleting}
            >🗑</button>
          )}
          <button
            className="sidebar-logout-btn"
            // Not onClick={onLogout} — App's handleLogout(notice) renders
            // its first argument on the login screen, so passing the raw
            // click event would crash LoginView ("Objects are not valid
            // as a React child").
            onClick={() => onLogout()}
            title="Log out"
          >Log out</button>
        </div>
      </div>

      {userDeleteError && (
        <div className="sidebar-add-user-error">{userDeleteError}</div>
      )}
    </div>
  );
}
