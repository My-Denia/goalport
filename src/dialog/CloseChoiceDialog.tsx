import type { StopResponsibilitySummary } from "../types";
import { GoalDialog } from "../ui/GoalDialog";

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
  const targetProvider = active ? provider : stopResponsibility?.provider || provider;
  const isClaude = targetProvider.toLowerCase() === "claude";
  const isScenario = targetProvider.toLowerCase() === "scenario";
  return (
    <GoalDialog label="Continue running in the background?" className="close-choice-dialog" onDismiss={onKeepOpen}>
        <p className="eyebrow">WINDOW CLOSE</p>
        <h2>Continue running in the background?</h2>
        <p className="dialog-lead">
          {stopResponsibility
            ? "Some tools may still be running. Continue closes this window and keeps the workspace protected. Stop waits for a recorded response before closing."
            : isClaude
              ? "Continue closes this window and leaves your task running. Stop asks Claude to interrupt the current turn; tools already started may keep running."
              : isScenario
                ? "This is a synthetic example. Continue closes the window; Stop ends the example before closing."
                : "Continue closes this window and leaves your task running. Stop interrupts the current turn before closing."}
        </p>
        {stopResponsibility ? (
          <details className="technical-details">
            <summary>Technical details</summary>
            <p>Residual execution remains unknown. Core keeps write responsibility held.</p>
          </details>
        ) : null}
        <div className="dialog-actions">
          <button className="button button-quiet" type="button" onClick={onKeepOpen}>Keep window open</button>
          <button className="button button-danger" type="button" onClick={onStop}>{isClaude ? "Stop Claude turn and quit" : isScenario ? "Stop synthetic Scenario and quit" : "Stop background work and quit"}</button>
          <button className="button button-primary" type="button" onClick={onContinue}>Continue in background</button>
        </div>
    </GoalDialog>
  );
}
