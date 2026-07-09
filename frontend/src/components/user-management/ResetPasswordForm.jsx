import { useState } from 'react';
import PasswordField from '../shared/PasswordField';

// Inline row-expansion form for an admin resetting a user's password. Owns
// only the two password inputs (fresh on each open — the container mounts
// this per open, keyed by resettingUserId). Validation, the API call, and
// the self-reset logout flow stay in the container's handleResetPassword.
export default function ResetPasswordForm({ user, isSelf, saving, error, onSave, onCancel }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  return (
    <form
      className="user-mgmt-form user-mgmt-reset-form"
      onSubmit={e => { e.preventDefault(); onSave(user, newPassword, confirmPassword); }}
    >
      <div className="user-mgmt-reset-form-title">Reset password for {user.username}</div>

      <div className="user-mgmt-form-row">
        <label className="user-mgmt-label" htmlFor={`reset-password-${user.id}`}>New password *</label>
        <PasswordField
          id={`reset-password-${user.id}`}
          className="user-mgmt-input"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          disabled={saving}
          autoComplete="new-password"
          autoFocus
        />
      </div>

      <div className="user-mgmt-form-row">
        <label className="user-mgmt-label" htmlFor={`reset-confirm-password-${user.id}`}>Confirm password *</label>
        <PasswordField
          id={`reset-confirm-password-${user.id}`}
          className="user-mgmt-input"
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          disabled={saving}
          autoComplete="new-password"
        />
      </div>

      <div className="user-mgmt-hint">
        {isSelf
          ? 'Changing your own password will sign you out immediately — you will need to log in again with the new password.'
          : 'Changing this password will sign the user out of all active sessions.'}
      </div>

      {error && <div className="user-mgmt-error">{error}</div>}

      <div className="user-mgmt-form-actions">
        <button type="submit" className="user-mgmt-save-btn" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="user-mgmt-cancel-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
