import { useRef, useState } from 'react';
import { useDismissOnOutsideClick } from '../../utils/useDismissOnOutsideClick';
import OverflowLabel from './OverflowLabel';

// The sidebar's session switcher dropdown. Deliberately separate from
// FormSelect (see utils/useDismissOnOutsideClick's comment): its menu is
// position-fixed with coordinates computed from the trigger's bounding rect
// so it can escape the sidebar's narrow, resizable, scrollable column, and
// it supports prefix icons and overflow tooltips that FormSelect doesn't.
export default function SidebarDropdown({ options, value, onChange, disabled, placeholder }) {
  const [open, setOpen]           = useState(false);
  const [menuStyle, setMenuStyle] = useState({});
  const triggerRef                = useRef(null);
  const menuRef                   = useRef(null);

  useDismissOnOutsideClick(open, () => setOpen(false), [triggerRef, menuRef]);

  function toggle() {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setMenuStyle({ top: r.bottom + 2, left: r.left, minWidth: Math.max(r.width, 200) });
    }
    setOpen(o => !o);
  }

  const selected = options.find(o => o.id === value);

  return (
    <div className="sd-root" ref={triggerRef}>
      <button
        type="button"
        className={`sd-trigger${open ? ' sd-trigger--open' : ''}`}
        onClick={toggle}
        disabled={disabled}
      >
        {selected?.prefixIcon && (
          <span className="sd-trigger-prefix" title={selected.prefixTitle}>{selected.prefixIcon}</span>
        )}
        <OverflowLabel
          text={selected?.label ?? placeholder ?? '—'}
          className="sd-trigger-label"
        />
        <span className="sd-chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div ref={menuRef} className="sd-menu" style={menuStyle}>
          {options.length === 0
            ? <span className="sd-empty">{placeholder ?? 'No options'}</span>
            : options.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  className={`sd-item${opt.id === value ? ' sd-item--active' : ''}`}
                  onClick={() => { onChange(opt.id); setOpen(false); }}
                >
                  {opt.prefixIcon && (
                    <span className="sd-item-prefix" title={opt.prefixTitle}>{opt.prefixIcon}</span>
                  )}
                  <OverflowLabel text={opt.label} className="sd-item-label" />
                  {opt.id === value && <span className="sd-item-check" title="Current session">✓</span>}
                </button>
              ))
          }
        </div>
      )}
    </div>
  );
}
