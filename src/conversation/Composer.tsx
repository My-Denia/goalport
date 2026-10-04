import { useRef, type FormEvent } from "react";
import type { CoreSnapshot, ProductRuntimeSelection, ProductTurn, RuntimeProfile } from "../types";
import { runtimeSelectionDisplay } from "../lib/display";
import { turnErrorCopy } from "../lib/turnErrorCopy";
import { RuntimePickerMenu } from "../ui/RuntimePickerMenu";
import { useComposerInput } from "./useComposerInput";

interface RuntimePickerProps {
  runtimes: RuntimeProfile[];
  runtime: ProductRuntimeSelection;
  blocked: boolean;
  blockedReason?: string;
  connected: boolean;
  onSelect: (provider: string) => void;
  /** Bumped by the app to open and focus the chooser (Session details → Change Runtime). */
  focusSignal: number;
}

/**
 * Runtime chooser attached to the composer, so the destination of the next
 * message is visible before sending. The chip label comes from the product
 * Runtime selection (which survives stopped/unavailable states) — never from
 * `attempt.state`. Behavior (positioning, outside-press/Escape close) lives in
 * the shared RuntimePickerMenu.
 */
export function RuntimePicker({ runtimes, runtime, blocked, blockedReason, connected, onSelect, focusSignal }: RuntimePickerProps) {
  const display = runtimeSelectionDisplay(runtime);
  const selectBlocked = blocked || !connected;
  return (
    <div className="runtime-picker">
      <RuntimePickerMenu
        runtimes={runtimes}
        selectedId={runtime.provider}
        triggerClassName="runtime-picker-button"
        triggerAriaLabel="Select Runtime"
        triggerTitle="Choose the Runtime for your next message"
        emptyText="No Runtime information from Core yet."
        blockedHint={selectBlocked
          ? (!connected ? "Reconnect Core to select." : (blockedReason ?? "Selection is blocked while a hold governs this workspace."))
          : null}
        isItemDisabled={(candidate) => candidate.support === "unsupported" || selectBlocked}
        onSelect={onSelect}
        focusSignal={focusSignal}
        triggerContent={(
          <>
            <span className={`provider-avatar provider-${runtime.provider.toLowerCase() || "none"}`} aria-hidden="true">{display.glyph}</span>
            <span className="runtime-picker-copy">
              <strong>{display.label}</strong>
              <small>{display.detail}</small>
            </span>
            <span aria-hidden="true">⌄</span>
          </>
        )}
      />
    </div>
  );
}

interface ComposerProps {
  /** Changes only when the user moves to another goal; snapshot polls leave it stable. */
  focusKey: string;
  draft: string;
  snapshot: CoreSnapshot;
  runtime: ProductRuntimeSelection;
  turn: ProductTurn;
  busy: boolean;
  closingSession?: boolean;
  retryLabel?: string;
  /** Bumped by the app to open and focus the chooser (Session details → Change Runtime). */
  chooserFocusSignal: number;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSelectRuntime: (provider: string) => void;
  onStop: () => void;
}

/**
 * The conversation composer. The primary action is mutually exclusive:
 * - live `turn.canStop` → a Stop button (the only place Stop ever appears);
 * - `turn.state` starting/stopping → a disabled pending button;
 * - otherwise Send, enabled only while `turn.canSend` and the draft is ready.
 * The textarea stays editable while a turn runs (drafting ahead is always
 * possible; concurrent sends are not).
 */
export function Composer({ focusKey, draft, snapshot, runtime, turn, busy, closingSession = false, retryLabel, chooserFocusSignal, onChange, onSubmit, onSelectRuntime, onStop }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const held = snapshot.stopResponsibility?.writeResponsibility === "held";
  const controlUnavailable = snapshot.bounds?.projectionUnavailable === true;
  const connected = snapshot.connection === "connected";
  const reconciling = Boolean(retryLabel);
  const canSubmit = draft.trim().length > 0 && connected && !busy
    && (reconciling || (!held && turn.canSend));
  const pending = turn.state === "starting" || turn.state === "stopping";
  const turnProblem = turnErrorCopy(turn);

  // One input layer, one copy: auto-grow, IME-safe Enter and focus-on-goal
  // switch live in useComposerInput, shared with the draft composer.
  const input = useComposerInput({
    textareaRef,
    value: draft,
    onCompositionChange: onChange,
    canSubmit,
    focusKey
  });

  const placeholder = "Ask the selected Runtime to continue…";

  const hint = closingSession
    ? "Closing the Runtime session…"
    : reconciling
    ? "Check whether the previous message was received. It will not be sent again."
    : held
    ? "Some tools may still be running. Your draft stays here while the workspace is protected."
    : !connected
      ? "Reconnect to send. Your draft stays in this window."
      : !turn.canSend
        ? turnProblem || "Sending is not available right now."
        : "Enter to send · Shift+Enter for a new line";

  return (
    <div className="composer-dock">
      <RuntimePicker
        runtimes={snapshot.runtimes}
        runtime={runtime}
        blocked={held || controlUnavailable}
        blockedReason={controlUnavailable ? "Selection is unavailable until Core provides a full control snapshot." : undefined}
        connected={connected}
        onSelect={onSelectRuntime}
        focusSignal={chooserFocusSignal}
      />
      <form className="composer" aria-label="Message composer" onSubmit={onSubmit}>
        <textarea
          ref={textareaRef}
          aria-label="Message composer"
          value={draft}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={input.onCompositionStart}
          onCompositionEnd={input.onCompositionEnd}
          onKeyDown={input.onKeyDown}
          placeholder={placeholder}
          rows={2}
          disabled={held && !reconciling}
        />
        <div className="composer-actions">
          <span className="composer-hint">{hint}</span>
          <div className="composer-buttons">
            {closingSession ? (
              <button className="composer-secondary" type="button" aria-label="Closing session" disabled>
                <span aria-hidden="true">◌</span> Closing session…
              </button>
            ) : turn.canStop ? (
              <button
                className="composer-secondary composer-stop"
                type="button"
                aria-label="Stop the running Runtime turn"
                title="Stop the running Runtime turn"
                onClick={onStop}
                disabled={busy}
              >
                <span aria-hidden="true">■</span> Stop
              </button>
            ) : pending ? (
              <button
                className="composer-secondary"
                type="button"
                aria-label={turn.state === "stopping" ? "Stopping" : "Starting"}
                title={turn.state === "stopping"
                  ? "The Runtime is stopping this turn; nothing new can start until it settles."
                  : "The Runtime has not confirmed the turn start yet."}
                disabled
              >
                <span aria-hidden="true">◌</span> {turn.state === "stopping" ? "Stopping…" : "Starting…"}
              </button>
            ) : (
              <button className="send-button" type="submit" aria-label={retryLabel ?? "Send message"} disabled={!canSubmit}>
                <span>{busy ? "Sending…" : (retryLabel ?? "Send")}</span>
                <span className="send-arrow" aria-hidden="true">↗</span>
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
