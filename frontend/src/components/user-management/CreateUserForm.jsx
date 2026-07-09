import { useState } from 'react';
import { roleLabel } from '../../utils/roleLabels';
import PasswordField from '../shared/PasswordField';
import FormSelect from '../FormSelect';
import { ROLE_OPTIONS } from './constants';

// Inline "+ Add user" form. Owns only its input values — they reset naturally
// because the container mounts this fresh each time the form is opened.
// Validation, the API call, saving state, and the error message stay in the
// container (handleCreateUser), which passes them back down as props.
export default function CreateUserForm({ onSubmit, onCancel, saving, error }) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('student');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  return (
    <form
      className="user-mgmt-form"
      onSubmit={e => { e.preventDefault(); onSubmit({ username, role, password, confirmPassword }); }}
    >
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
        <FormSelect
          id="new-user-role"
          value={role}
          onChange={setRole}
          options={ROLE_OPTIONS.map(r => ({ value: r, label: roleLabel(r) }))}
          disabled={saving}
        />
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

      {error && <div className="user-mgmt-error">{error}</div>}

      <div className="user-mgmt-form-actions">
        <button type="submit" className="user-mgmt-save-btn" disabled={saving}>
          {saving ? 'Creating…' : 'Create user'}
        </button>
        <button type="button" className="user-mgmt-cancel-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
