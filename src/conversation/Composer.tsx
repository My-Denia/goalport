import { CompositionEvent, KeyboardEvent, useEffect, useRef, useState, type FormEvent } from "react";
import type { CoreSnapshot, ProductRuntimeSelection, ProductTurn, RuntimeProfile } from "../types";
import { runtimeSelectionDisplay, supportStatusLabel } from "../lib/display";

interface RuntimePickerProps {
  runtimes: RuntimeProfile[];
  runtime: ProductRuntimeSelection;
  blocked: boolean;
  connected: boolean;
  onSelect: (provider: string) => void;
  /** Bumped by the app to open and focus the chooser (Session details → Change Runtime). */
  focusSignal: number;
}

/**
 * Runtime chooser attached to the composer, so the destination of the next
 * message is visible before sending. The chip label comes from the product
 * Runtime selection (which survives stopped/unavailable states) — never from
 * `attempt.state`.
 */
export function RuntimePicker({ runtimes, runtime, blocked, connected, onSelect, focusSignal }: RuntimePickerProps) {
  const [open, setOpen] = useState(false);
  const display = runtimeSelectionDisplay(runtime);
  const selectBlocked = blocked || !connected;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (focusSignal <= 0) return;
    setOpen(true);
    buttonRef.current?.focus();
  }, [focusSignal]);

  return (
    <div className="runtime-picker" ref={boxRef}>
      <button
        className="runtime-picker-button"
        type="button"
        ref={buttonRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select Runtime"
        title="Choose the Runtime for your next message"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`provider-avatar provider-${runtime.provider.toLowerCase() || "none"}`} aria-hidden="true">{display.glyph}</span>
        <span className="runtime-picker-copy">
          <strong>{display.label}</strong>
          <small>{display.detail}</small>
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className="runtime-picker-list" role="listbox" aria-label="Runtimes">
          {runtimes.length === 0 ? <p className="runtime-picker-empty">No Runtime information from Core yet.</p> : null}
          {runtimes.map((candidate) => (
            <button
              key={candidate.id}
              className="runtime-picker-item"
              type="button"
              role="option"
              aria-selected={runtime.provider.toLowerCase() === candidate.id.toLowerCase()}
              disabled={candidate.support === "unsupported" || selectBlocked}
              onClick={() => {
                setOpen(false);
                onSelect(candidate.id);
              }}
            >
              <span className={`provider-avatar provider-${candidate.id}`} aria-hidden="true">{candidate.name[0]}</span>
              <span className="runtime-picker-copy">
                <strong>{candidate.name}</strong>
                <small>{candidate.subtitle}</small>
              </span>
              <span className={`support-chip support-${candidate.support}`}>
                {supportStatusLabel(candidate)}
              </span>
            </button>
          ))}
          {selectBlocked ? (
            <p className="runtime-picker-hint">
              {!connected ? "Reconnect Core to select." : "Selection is blocked while a hold governs this workspace."}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface ComposerProps {
  draft: string;
  snapshot: CoreSnapshot;
  runtime: ProductRuntimeSelection;
  turn: ProductTurn;
  busy: boolean;
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
export function Composer({ draft, snapshot, runtime, turn, busy, chooserFocusSignal, onChange, onSubmit, onSelectRuntime, onStop }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // IME composition guards. `composing` covers the active composition; the
  // timestamp catches the stray Enter some IMEs emit right after
  // compositionend with isComposing already false.
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);

  const held = snapshot.stopResponsibility?.writeResponsibility === "held";
  const connected = snapshot.connection === "connected";
  const canSubmit = draft.trim().length > 0 && connected && !held && turn.canSend && !busy;
  const pending = turn.state === "starting" || turn.state === "stopping";

  // Auto-grow: keep the textarea matched to its content within a sane maximum.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [draft]);

  // The composer is the primary input of the app: it takes focus when it
  // appears (goal created / goal selected), so the next step is always typing.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleCompositionStart = () => { composingRef.current = true; };
  const handleCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    compositionEndedAtRef.current = Date.now();
    onChange(event.currentTarget.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    // 229 is the keyCode IMEs use while composing; isComposing covers modern
    // browsers. An Enter within 30ms after compositionend is the Korean-IME
    // stray commit — never a send.
    const stray = Date.now() - compositionEndedAtRef.current < 30;
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229 || stray) {
      return;
    }
    if (event.shiftKey) return; // explicit newline
    event.preventDefault();
    if (!canSubmit) return;
    if (typeof textareaRef.current?.form?.requestSubmit === "function") {
      textareaRef.current.form.requestSubmit();
    } else {
      textareaRef.current?.form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }
  };

  const placeholder = held
    ? "Core holds write responsibility while residual execution is unknown…"
    : !connected
      ? "Reconnect Core before sending a new message…"
      : !turn.canSend
        ? turn.reason || "Sending is not available right now…"
        : "Ask the selected Runtime to continue… (Enter to send, Shift+Enter for a new line)";

  const hint = held
    ? "Sending is blocked: Core holds write responsibility for residual execution."
    : !connected
      ? "Reconnect to send. Your draft stays in this window."
      : !turn.canSend
        ? turn.reason || "Sending is not available right now."
        : "Draft stays with this goal · Enter to send";

  return (
    <div className="composer-dock">
      <RuntimePicker
        runtimes={snapshot.runtimes}
        runtime={runtime}
        blocked={held}
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
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={2}
          disabled={held}
        />
        <div className="composer-actions">
          <span className="composer-hint">{hint}</span>
          <div className="composer-buttons">
            {turn.canStop ? (
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
              <button className="send-button" type="submit" aria-label="Send message" disabled={!canSubmit}>
                <span>{busy ? "Sending…" : "Send"}</span>
                <span className="send-arrow" aria-hidden="true">↗</span>
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
