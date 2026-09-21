import { CompositionEvent, KeyboardEvent, useEffect, useRef, useState, type FormEvent } from "react";
import type { RuntimeProfile } from "../types";
import { supportStatusLabel } from "../lib/display";

export interface GoalDraftValue {
  workspace: string;
  provider: string;
  message: string;
}

interface DraftRuntimePickerProps {
  runtimes: RuntimeProfile[];
  provider: string;
  connected: boolean;
  onSelect: (provider: string) => void;
}

/** Local draft Runtime choice — no Core command runs until the first Send. */
function DraftRuntimePicker({ runtimes, provider, connected, onSelect }: DraftRuntimePickerProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const selected = runtimes.find((candidate) => candidate.id === provider);

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

  return (
    <div className="runtime-picker draft-runtime-picker" ref={boxRef}>
      <button
        className="runtime-picker-button"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select Runtime"
        title="Choose the Runtime for this goal"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`provider-avatar provider-${provider || "none"}`} aria-hidden="true">
          {selected ? selected.name[0] : "–"}
        </span>
        <span className="runtime-picker-copy">
          <strong>{selected ? selected.name : "Choose a Runtime"}</strong>
          <small>{selected ? "will run this goal" : "pick before sending"}</small>
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
              aria-selected={candidate.id === provider}
              disabled={candidate.support === "unsupported" || !connected}
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
        </div>
      ) : null}
    </div>
  );
}

interface DraftGoalComposerProps {
  draft: GoalDraftValue;
  runtimes: RuntimeProfile[];
  connected: boolean;
  busy: boolean;
  blockedFromSending: boolean;
  error: { sentence: string; technical?: string } | null;
  canBrowse: boolean;
  onBrowse: () => void;
  onChange: (value: GoalDraftValue) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDiscard: () => void;
}

/**
 * First-use surface (product-interaction-reset): a new goal is a local draft,
 * instantly editable — no name dialog, nothing durable until the first Send.
 * Workspace, Runtime and message can be filled in any order; typing is
 * possible before a Runtime is chosen.
 */
export function DraftGoalComposer({
  draft, runtimes, connected, busy, blockedFromSending, error, canBrowse, onBrowse, onChange, onSubmit, onDiscard
}: DraftGoalComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // IME composition guards, identical to the conversation composer.
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);

  const canSubmit = !busy
    && !blockedFromSending
    && connected
    && draft.workspace.trim().length > 0
    && draft.provider.length > 0
    && draft.message.trim().length > 0;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [draft.message]);

  // The draft opens ready for typing: focus the message box (workspace is
  // prefilled from the current project when there is one).
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleCompositionStart = () => { composingRef.current = true; };
  const handleCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    compositionEndedAtRef.current = Date.now();
    onChange({ ...draft, message: event.currentTarget.value });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    const stray = Date.now() - compositionEndedAtRef.current < 30;
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229 || stray) {
      return;
    }
    if (event.shiftKey) return;
    event.preventDefault();
    if (!canSubmit) return;
    if (typeof textareaRef.current?.form?.requestSubmit === "function") {
      textareaRef.current.form.requestSubmit();
    } else {
      textareaRef.current?.form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }
  };

  return (
    <section className="draft-composer" aria-label="New goal draft">
      <div className="conversation-heading">
        <div className="conversation-heading-main">
          <h2>Start a goal</h2>
          <p>What would you like to work on?</p>
        </div>
      </div>

      <form className="draft-composer-form" aria-label="Start a goal" onSubmit={onSubmit}>
        <label className="field-label" htmlFor="draft-workspace">Workspace</label>
        <div className="field-with-icon draft-workspace-row">
          <span aria-hidden="true">⌂</span>
          <input
            id="draft-workspace"
            aria-label="Project folder"
            value={draft.workspace}
            onChange={(event) => onChange({ ...draft, workspace: event.target.value })}
            placeholder="C:\workspace\your-project"
            disabled={busy}
          />
          {canBrowse ? (
            <button className="button button-small button-outline" type="button" onClick={onBrowse} disabled={busy}>Browse…</button>
          ) : null}
        </div>

        <DraftRuntimePicker
          runtimes={runtimes}
          provider={draft.provider}
          connected={connected}
          onSelect={(provider) => onChange({ ...draft, provider })}
        />


        <textarea
          ref={textareaRef}
          id="draft-message"
          aria-label="Message composer"
          value={draft.message}
          onChange={(event) => onChange({ ...draft, message: event.target.value })}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onKeyDown={handleKeyDown}
          placeholder={connected
            ? "Ask GoalPort…"
            : "Reconnect Core before sending…"}
          rows={3}
          disabled={busy}
        />

        {error ? (
          <div className="dialog-note" role="alert">
            <span aria-hidden="true">!</span>
            <span>
              {error.sentence}
              {error.technical ? (
                <details className="technical-details">
                  <summary>Technical details</summary>
                  <pre className="technical-details-pre">{error.technical}</pre>
                </details>
              ) : null}
            </span>
          </div>
        ) : null}

        <div className="dialog-actions">
          <button className="button button-quiet" type="button" onClick={onDiscard} disabled={busy}>Discard draft</button>
          <button className="button button-primary" type="submit" aria-label="Send message" disabled={!canSubmit}>
            {busy ? "Starting…" : "Send"}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </form>
    </section>
  );
}
