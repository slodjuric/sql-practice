import { useState, useEffect } from 'react';
import { api } from '../../api';
import FormSelect from '../FormSelect';
import CheckboxGroup from '../CheckboxGroup';
import { PLAN_TOPICS } from '../../constants/topics';
import { PLAN_DIFFICULTY_OPTIONS } from '../../constants/difficulties';
import { PLAN_PROJECTS } from '../../constants/projects';

const PLAN_TYPE_OPTIONS = [
  { value: 'topic',    label: 'Learn by Topic' },
  { value: 'category', label: 'Learn by Category' },
  { value: 'project',  label: 'Practice Projects' },
];

export default function EditPlanForm({ activeSession, sessionFilters, onSave, onCancel }) {
  const [name,                 setName]                 = useState(activeSession.name);
  const [description,          setDescription]          = useState(activeSession.description || '');
  const [planType,             setPlanType]             = useState(activeSession.plan_type || 'topic');
  const [selectedTopics,       setSelectedTopics]       = useState(sessionFilters?.topics       ?? []);
  const [selectedDifficulties, setSelectedDifficulties] = useState(sessionFilters?.difficulties ?? []);
  const [selectedProjects,     setSelectedProjects]     = useState(sessionFilters?.projects     ?? []);
  const [selectedCategories,   setSelectedCategories]   = useState(sessionFilters?.categories   ?? []);
  const [availableCategories,  setAvailableCategories]  = useState([]);
  const [saving,               setSaving]               = useState(false);
  const [error,                setError]                = useState(null);

  useEffect(() => {
    api.tasks.categories().then(setAvailableCategories).catch(() => {});
  }, []);

  function handlePlanTypeChange(newType) {
    setPlanType(newType);
    if (newType === 'topic')    { setSelectedProjects([]); setSelectedCategories([]); }
    if (newType === 'category') { setSelectedTopics([]);   setSelectedProjects([]); }
    if (newType === 'project')  { setSelectedTopics([]);   setSelectedCategories([]); }
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!name.trim()) { setError('Plan name is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name:         name.trim(),
        description:  description.trim() || null,
        planType,
        topics:       selectedTopics,
        difficulties: selectedDifficulties,
        projects:     selectedProjects,
        categories:   selectedCategories,
      });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="create-plan-form" onSubmit={handleSave}>
      <div className="create-plan-field">
        <label className="create-plan-label">Plan name <span className="create-plan-required">*</span></label>
        <input
          className="create-plan-input"
          type="text"
          value={name}
          onChange={e => { setName(e.target.value); setError(null); }}
          autoFocus
        />
      </div>

      <div className="create-plan-field">
        <label className="create-plan-label">
          Description <span className="create-plan-optional">(optional)</span>
        </label>
        <textarea
          className="create-plan-textarea"
          placeholder="What is this plan about?"
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={3}
        />
      </div>

      <div className="create-plan-field">
        <label className="create-plan-label">Plan type</label>
        <FormSelect
          value={planType}
          onChange={handlePlanTypeChange}
          options={PLAN_TYPE_OPTIONS}
        />
      </div>

      {planType === 'topic' && (
        <div className="create-plan-field">
          <label className="create-plan-label">
            Learn by Topic <span className="create-plan-optional">(optional)</span>
          </label>
          <CheckboxGroup
            options={PLAN_TOPICS}
            selected={selectedTopics}
            onChange={setSelectedTopics}
          />
        </div>
      )}

      {planType === 'category' && (
        <div className="create-plan-field">
          <label className="create-plan-label">
            Learn by Category <span className="create-plan-optional">(optional)</span>
          </label>
          <CheckboxGroup
            options={availableCategories.map(c => ({ id: c, label: c }))}
            selected={selectedCategories}
            onChange={setSelectedCategories}
          />
        </div>
      )}

      {planType === 'project' && (
        <div className="create-plan-field">
          <label className="create-plan-label">
            Practice Projects <span className="create-plan-optional">(optional)</span>
          </label>
          <CheckboxGroup
            options={PLAN_PROJECTS}
            selected={selectedProjects}
            onChange={setSelectedProjects}
          />
        </div>
      )}

      <div className="create-plan-field">
        <label className="create-plan-label">
          Learn by Level <span className="create-plan-optional">(optional)</span>
        </label>
        <CheckboxGroup
          options={PLAN_DIFFICULTY_OPTIONS}
          selected={selectedDifficulties}
          onChange={setSelectedDifficulties}
          layout="row"
          showSelectAll={false}
        />
      </div>

      {error && <div className="create-plan-error">{error}</div>}

      <div className="create-plan-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={saving || !name.trim()}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
