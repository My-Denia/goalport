import type { CoreSnapshot } from "../types";
import { useModalFocus } from "../lib/useModalFocus";

interface HandoffDialogProps {
  snapshot: CoreSnapshot;
  onCancel: () => void;
  onConfirm: (provider: string) => void;
}

/**
 * Explicit handoff target selection. The old flow silently picked the first
 * non-current runtime; a handoff must show who will receive the persisted
 * packet and let the user choose. Unsupported runtimes are listed but not
 * selectable, so the reason stays visible instead of hidden behind a filter.
 */
export function HandoffDialog({ snapshot, onCancel, onConfirm }: HandoffDialogProps) {
  const dialogRef = useModalFocus(onCancel);
  const candidates = snapshot.runtimes.filter((runtime) => runtime.id !== snapshot.attempt.provider.toLowerCase());
  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="first-run-dialog handoff-dialog" role="dialog" aria-modal="true" aria-label="Assign the next step">
        <p className="eyebrow">HANDOFF</p>
        <h2>Assign the next step</h2>
        <p className="dialog-lead">
          Core will hand the persisted packet from <strong>{snapshot.attempt.provider}</strong> to the Runtime you
          choose. The receiving Runtime continues from the recorded handoff packet and reports the next safe step.
        </p>
        {candidates.length === 0 ? (
          <div className="dialog-note" role="alert">
            <span aria-hidden="true">!</span>
            <span>No other Runtime is available from Core. Handoff needs a second Runtime with a capability path.</span>
          </div>
        ) : (
          <div className="handoff-list" role="listbox" aria-label="Handoff target">
            {candidates.map((runtime) => (
              <button
                key={runtime.id}
                className="handoff-item"
                type="button"
                role="option"
                aria-selected={false}
                disabled={runtime.support === "unsupported"}
                onClick={() => onConfirm(runtime.id)}
              >
                <span className={`provider-avatar provider-${runtime.id}`} aria-hidden="true">{runtime.name[0]}</span>
                <span className="runtime-picker-copy">
                  <strong>{runtime.name}</strong>
                  <small>{runtime.support === "unsupported" ? "Unsupported for handoff" : runtime.subtitle}</small>
                </span>
                <span className={`support-chip support-${runtime.support}`}>
                  {runtime.id === "scenario" ? "Synthetic" : runtime.support === "partial" ? "Preview" : runtime.support}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="dialog-actions">
          <button className="button button-quiet" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </section>
    </div>
  );
}
