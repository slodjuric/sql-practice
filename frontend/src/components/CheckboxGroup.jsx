export default function CheckboxGroup({ options, selected, onChange, layout = 'column', showSelectAll = true }) {
  const allIds = options.map(o => o.id);
  const isAllSelected = allIds.length > 0 && allIds.every(id => selected.includes(id));

  function handleSelectAll(e) {
    onChange(e.target.checked ? [...allIds] : []);
  }

  function handleToggle(id) {
    onChange(
      selected.includes(id)
        ? selected.filter(s => s !== id)
        : [...selected, id]
    );
  }

  const containerClass = `create-plan-checkboxes${layout === 'row' ? ' create-plan-checkboxes--row' : ''}`;

  return (
    <div className={containerClass}>
      {showSelectAll && options.length > 0 && (
        <>
          <label className="create-plan-checkbox-label create-plan-checkbox-select-all">
            <input
              type="checkbox"
              checked={isAllSelected}
              onChange={handleSelectAll}
            />
            <span>Select All</span>
          </label>
          <div className="create-plan-checkbox-divider" />
        </>
      )}
      {options.map(opt => (
        <label key={opt.id} className="create-plan-checkbox-label">
          <input
            type="checkbox"
            checked={selected.includes(opt.id)}
            onChange={() => handleToggle(opt.id)}
          />
          <span className={opt.labelClassName}>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}
