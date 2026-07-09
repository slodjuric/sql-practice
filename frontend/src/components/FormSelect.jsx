import { useState, useRef } from 'react';
import { useDismissOnOutsideClick } from '../utils/useDismissOnOutsideClick';

// placeholder/disabled/id are optional so existing callers (ProgressView's
// plan-type select, PracticeView's sort select) that always pass a value
// matching a real option are unaffected — they never hit the placeholder
// branch and never pass disabled.
export default function FormSelect({ id, value, onChange, options, placeholder, disabled = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useDismissOnOutsideClick(open, () => setOpen(false), ref);

  const selected = options.find(o => o.value === value);

  return (
    <div className="fs-root" ref={ref}>
      <button
        id={id}
        type="button"
        className={`fs-trigger${open ? ' fs-trigger--open' : ''}`}
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
      >
        <span className={`fs-label${selected ? '' : ' fs-label--placeholder'}`}>
          {selected?.label ?? placeholder ?? '—'}
        </span>
        <span className="fs-chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="fs-menu">
          {options.length === 0
            ? <span className="fs-empty">{placeholder ?? 'No options'}</span>
            : options.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className={`fs-item${opt.value === value ? ' fs-item--active' : ''}`}
                  onClick={() => { onChange(opt.value); setOpen(false); }}
                >
                  <span>{opt.label}</span>
                  {opt.value === value && <span className="fs-check">✓</span>}
                </button>
              ))
          }
        </div>
      )}
    </div>
  );
}
