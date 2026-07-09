import { useEffect } from 'react';

// Closes an open dropdown/menu on an outside mousedown or an Escape key
// press. Shared by FormSelect and Sidebar's local SidebarDropdown, which
// both carried a byte-identical copy of this listener-registration effect.
//
// `containerRefs` is one ref (or an array of refs) whose contained DOM
// should NOT count as "outside" — SidebarDropdown needs two (the trigger
// button and a separately-rendered, fixed-position menu), FormSelect needs
// just one (a single wrapping div contains both).
//
// Deliberately NOT a full merge of FormSelect/SidebarDropdown into one
// component: SidebarDropdown's menu is `position: fixed` with its
// coordinates computed from the trigger's bounding rect (so it can escape
// the sidebar's narrow, resizable, scrollable column), plus it supports a
// prefix icon/tooltip and label-overflow tooltips that FormSelect doesn't
// need. Forcing them into one implementation would risk visibly changing
// the sidebar's session switcher; only this actually-duplicated listener
// logic is shared.
export function useDismissOnOutsideClick(open, onDismiss, containerRefs) {
  useEffect(() => {
    if (!open) return;
    const refs = Array.isArray(containerRefs) ? containerRefs : [containerRefs];
    function onDown(e) {
      if (refs.some(ref => ref?.current?.contains(e.target))) return;
      onDismiss();
    }
    function onKey(e) { if (e.key === 'Escape') onDismiss(); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}
