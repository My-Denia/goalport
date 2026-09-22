import type { StopResponsibilitySummary } from "../types";
import { useModalFocus } from "../lib/useModalFocus";

interface CloseChoiceDialogProps {
  provider: string;
  active: boolean;
  stopResponsibility: StopResponsibilitySummary | null;
  onContinue: () => void;
  onStop: () => void;
  onKeepOpen: () => void;
}

// Accessible names "Keep window open" / "Continue in background" /
// "Stop background work and quit" are part of the safety contract and stay
// verbatim; the receipt-acceptance conditions live in App (unchanged).
export function CloseChoiceDialog({ provider, active, stopResponsibility, onContinue, onStop, onKeepOpen }: CloseChoiceDialogProps) {
  const dialogRef = useModalFocus(onKeepOpen);
  const targetProvider = active ? provider : stopResponsibility?.provider || provider;
  const isClaude = targetProvider.toLowerCase() === "claude";
  const isScenario = targetProvider.toLowerCase() === "scenario";
  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="first-run-dialog close-choice-dialog" role="dialog" aria-modal="true" aria-label="Continue running in the background?">
        <p className="eyebrow">WINDOW CLOSE</p>
        <h2>Continue running in the background?</h2>
        <p className="dialog-lead">
          {stopResponsibility
            ? "Residual execution remains unknown. Core keeps write responsibility held. Continue closes only this window and starts no new work; Stop waits for the durable Core response before quit acknowledgement."
            : isClaude
              ? "Stop requests interruption of the current native Claude turn. Started tools may keep running; Core records residual responsibility before closing. Continue closes this window and starts no new work."
              : isScenario
                ? "This is a synthetic Scenario turn. Stop records the synthetic Attempt transition; no native provider process is implied. Continue closes only this window and starts no new work."
                : "Long-running work remains Core-owned while this window is closed. Continue leaves Core and the authorized Runtime running. Stop asks Core to end the active Attempt, then quits this window."}
        </p>
        <div className="dialog-actions">
          <button className="button button-quiet" type="button" onClick={onKeepOpen}>Keep window open</button>
          <button className="button button-danger" type="button" onClick={onStop}>{isClaude ? "Stop Claude turn and quit" : isScenario ? "Stop synthetic Scenario and quit" : "Stop background work and quit"}</button>
          <button className="button button-primary" type="button" onClick={onContinue}>Continue in background</button>
        </div>
      </section>
    </div>
  );
}
