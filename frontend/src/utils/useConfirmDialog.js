import { useRef, useState } from 'react';

const DEFAULTS = {
  title: 'Are you sure?',
  message: '',
  details: null,
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  variant: 'info',
};

// Themed, promise-based replacement for window.confirm() —
//   const confirmed = await confirm({ title, message, variant: 'danger' });
//   if (!confirmed) return;
// resolves true/false exactly like window.confirm's return value, so every
// existing `if (!confirmed) return;` call site keeps working unchanged; only
// the one line that used to call window.confirm(...) changes.
//
// Deliberately does NOT run the caller's action itself (no onConfirm
// callback owned by the dialog) — it only gates the decision, the same as
// window.confirm did. The actual async action, its loading state, and its
// error display stay exactly where they already were (page-level, not
// modal-level) so every flow's behavior — including the ones that never had
// a confirm() at all, like Reopen — stays visually and functionally
// consistent. ConfirmModal still accepts loading/error props for a future
// caller that wants a self-contained async dialog; this hook simply never
// populates them, since resolving immediately on click already prevents any
// double-submit (the dialog is gone before the real action starts, and the
// existing per-action `disabled={xIsSaving}` buttons handle the rest).
export function useConfirmDialog() {
  const [dialog, setDialog] = useState(null); // options object while open, else null
  const resolverRef = useRef(null);

  function confirm(options) {
    return new Promise(resolve => {
      resolverRef.current = resolve;
      setDialog({ ...DEFAULTS, ...options });
    });
  }

  function settle(result) {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setDialog(null);
  }

  const dialogProps = {
    ...dialog,
    open: dialog !== null,
    onConfirm: () => settle(true),
    onCancel: () => settle(false),
  };

  return { confirm, dialogProps };
}
