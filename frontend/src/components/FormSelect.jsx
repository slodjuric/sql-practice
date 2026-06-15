import { useState, useRef, useEffect } from 'react';

export default function FormSelect({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (ref.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find(o => o.value === value);

  return (
    <div className="fs-root" ref={ref}>
      <button
        type="button"
        className={`fs-trigger${open ? ' fs-trigger--open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="fs-label">{selected?.label ?? '—'}</span>
        <span className="fs-chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="fs-menu">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`fs-item${opt.value === value ? ' fs-item--active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              <span>{opt.label}</span>
              {opt.value === value && <span className="fs-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
