import { useEffect, useState } from 'react';
import { api } from '../../api';

// Create-session form. Owns its inputs, the dataset list, and its own
// saving/error state — the panel remounts it (via a changing key) on every
// open, which is what resets the fields and refetches the dataset list.
// `onSave(name, description, datasetId)` (the panel) performs the actual
// create and post-success bookkeeping; it throws on failure so this form
// keeps its inputs and shows the error.
export default function SidebarAddSessionForm({ viewedUser, onSave, onCancel }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [availableDatasets, setAvailableDatasets] = useState([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [selectedDatasetId, setSelectedDatasetId] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.datasets.list()
      .then(list => {
        if (cancelled) return;
        setAvailableDatasets(list);
        if (list.length > 0) setSelectedDatasetId(list[0].id);
      })
      .catch(() => { if (!cancelled) setAvailableDatasets([]); })
      .finally(() => { if (!cancelled) setDatasetsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(name.trim(), description.trim() || null, selectedDatasetId);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="sidebar-add-session-form">
      {viewedUser && (
        <div className="sidebar-add-session-target-hint">
          Creating session for: <strong>{viewedUser.username}</strong>
        </div>
      )}
      <input
        className="sidebar-add-session-input"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Session name..."
        onKeyDown={e => {
          if (e.key === 'Enter') handleSave();
          if (e.key === 'Escape') onCancel();
        }}
        autoFocus
        disabled={saving}
      />
      <div className="sidebar-add-session-dataset-row">
        {datasetsLoading ? (
          <span className="sidebar-add-session-dataset-loading">Loading…</span>
        ) : (
          <select
            className="sidebar-add-session-select"
            value={selectedDatasetId ?? ''}
            onChange={e => setSelectedDatasetId(parseInt(e.target.value, 10))}
            disabled={saving || availableDatasets.length <= 1}
          >
            {availableDatasets.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        )}
        <span className="sidebar-add-session-dataset-hint">Dataset (fixed after creation)</span>
      </div>
      <textarea
        className="sidebar-add-session-textarea"
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Description (optional)..."
        disabled={saving}
        rows={2}
      />
      <div className="sidebar-add-session-actions">
        <button className="sidebar-add-session-save" onClick={handleSave} disabled={saving || !name.trim() || !selectedDatasetId}>
          {saving ? '...' : 'Save'}
        </button>
        <button className="sidebar-add-session-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
      {error && <div className="sidebar-add-session-error">{error}</div>}
    </div>
  );
}
