import { useEffect, useRef } from 'react';

// Themed replacement for window.confirm() — a centered, backdrop-dimmed
// modal matching the app's existing panel/button styling (see the
// confirm-modal-* rules in App.css). Purely presentational; see
// utils/useConfirmDialog.js for the imperative confirm()-returns-a-promise
// API that drives `open`/`onConfirm`/`onCancel` here.
//
// `variant`: 'danger' for irreversible/destructive actions (delete, etc.),
// 'info' for lower-stakes confirmations (archive, complete). Only affects
// the confirm button's color and the two safety behaviors below — never
// which fields are shown.
export default function ConfirmModal({
  open,
  title,
  message,
  details,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'info',
  loading = false,
  error = null,
  onConfirm,
  onCancel,
}) {
  const cancelBtnRef = useRef(null);
  const previouslyFocusedRef = useRef(null);

  // Focus management: move focus into the modal (onto the safe Cancel
  // button — never the destructive Confirm button) when it opens, and
  // return focus to whatever triggered it once it closes.
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = document.activeElement;
      const raf = requestAnimationFrame(() => cancelBtnRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    if (previouslyFocusedRef.current && document.contains(previouslyFocusedRef.current)) {
      previouslyFocusedRef.current.focus();
    }
    previouslyFocusedRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel?.();
      } else if (e.key === 'Enter' && variant !== 'danger') {
        // Destructive (danger) confirmations are never triggered by Enter —
        // only an explicit click on the confirm button counts, so a stray
        // Enter (e.g. from a keyboard flow elsewhere) can never delete
        // something. Non-danger dialogs may confirm on Enter, matching the
        // app's existing convention of Enter-submits on its own (all
        // non-destructive) forms — see Sidebar's add-session input.
        e.stopPropagation();
        onConfirm?.();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, variant, onCancel, onConfirm]);

  if (!open) return null;

  function handleBackdropMouseDown() {
    // Destructive confirmations are never dismissed by an outside click.
    // Cancel is one intentional click away regardless, so this isn't about
    // making Cancel harder to reach — it's about never letting a misclick
    // near the modal be mistaken for a reviewed decision either way.
    // Non-destructive dialogs treat an outside click the same as Escape.
    if (variant !== 'danger') onCancel?.();
  }

  return (
    <div className="confirm-modal-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        className={`confirm-modal confirm-modal--${variant}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="confirm-modal-header">
          <span className="confirm-modal-icon">{variant === 'danger' ? '⚠️' : 'ℹ️'}</span>
          <h3 id="confirm-modal-title" className="confirm-modal-title">{title}</h3>
        </div>

        <p id="confirm-modal-message" className="confirm-modal-message">{message}</p>

        {details && (
          <p className={`confirm-modal-details confirm-modal-details--${variant}`}>{details}</p>
        )}

        {error && <div className="confirm-modal-error">{error}</div>}

        <div className="confirm-modal-actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
