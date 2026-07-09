import { useState } from 'react';
import { roleLabel } from '../../utils/roleLabels';
import FormSelect from '../FormSelect';
import { ROLE_OPTIONS } from './constants';

// Inline row-expansion form for changing an existing user's role. Owns only
// the selected role value (initialized from the user's current role on each
// open — the container mounts this fresh per open, keyed by editingRoleId).
// The save flow — self/admin-touching confirmations, the API call, list and
// summary refreshes — stays in the container's handleRoleSave.
export default function RoleEditForm({ user, saving, error, onSave, onCancel }) {
  const [value, setValue] = useState(user.role);

  return (
    <form
      className="user-mgmt-form user-mgmt-role-edit-form"
      onSubmit={e => { e.preventDefault(); onSave(user, value); }}
    >
      <div className="user-mgmt-reset-form-title">Edit role for {user.username}</div>

      <div className="user-mgmt-form-row">
        <label className="user-mgmt-label" htmlFor={`edit-role-${user.id}`}>Role *</label>
        <FormSelect
          id={`edit-role-${user.id}`}
          value={value}
          onChange={setValue}
          options={ROLE_OPTIONS.map(r => ({ value: r, label: roleLabel(r) }))}
          disabled={saving}
        />
      </div>

      {user.role === 'mentor' && value !== 'mentor' && (
        <div className="user-mgmt-hint">
          This professor's assigned students will be unassigned — mentor_assignments rows for this user will be removed.
        </div>
      )}
      {user.role === 'student' && value !== 'student' && (
        <div className="user-mgmt-hint">
          This student's professor assignment will be removed, if one exists.
        </div>
      )}

      {error && <div className="user-mgmt-error">{error}</div>}

      <div className="user-mgmt-form-actions">
        <button type="submit" className="user-mgmt-save-btn" disabled={saving || value === user.role}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="user-mgmt-cancel-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
