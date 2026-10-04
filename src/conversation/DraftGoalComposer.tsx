import { useRef, type FormEvent } from "react";
import type { RuntimeProfile } from "../types";
import { RuntimePickerMenu } from "../ui/RuntimePickerMenu";
import { useComposerInput } from "./useComposerInput";

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
  const selected = runtimes.find((candidate) => candidate.id === provider);
  return (
    <div className="runtime-picker draft-runtime-picker">
      <RuntimePickerMenu
        runtimes={runtimes}
        selectedId={provider}
        triggerClassName="runtime-picker-button"
        triggerAriaLabel="Select Runtime"
        triggerTitle="Choose the Runtime for this goal"
        emptyText="No Runtime information from Core yet."
        blockedHint={!connected ? "Reconnect Core to select." : null}
        isItemDisabled={(candidate) => candidate.support === "unsupported" || !connected}
        onSelect={onSelect}
        triggerContent={(
          <>
            <span className={`provider-avatar provider-${provider || "none"}`} aria-hidden="true">
              {selected ? selected.name[0] : "–"}
            </span>
            <span className="runtime-picker-copy">
              <strong>{selected ? selected.name : "Choose a Runtime"}</strong>
              <small>{selected ? "will run this goal" : "pick before sending"}</small>
            </span>
            <span aria-hidden="true">⌄</span>
          </>
        )}
      />
    </div>
  );
}

interface DraftGoalComposerProps {
  draft: GoalDraftValue;
  runtimes: RuntimeProfile[];
  connected: boolean;
  busy: boolean;
  blockedFromSending: boolean;
  retryLabel?: string;
  error: { sentence: string; technical?: string } | null;
  canBrowse: boolean;
  workspacePlaceholder?: string;
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
  draft, runtimes, connected, busy, blockedFromSending, retryLabel, error, canBrowse, workspacePlaceholder, onBrowse, onChange, onSubmit, onDiscard
}: DraftGoalComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const canSubmit = !busy
    && (!blockedFromSending || Boolean(retryLabel))
    && connected
    && draft.workspace.trim().length > 0
    && draft.provider.length > 0
    && draft.message.trim().length > 0;

  // One input layer, one copy: auto-grow, IME-safe Enter and the draft's
  // ready-for-typing focus live in useComposerInput, shared with the
  // conversation composer.
  const input = useComposerInput({
    textareaRef,
    value: draft.message,
    onCompositionChange: (message) => onChange({ ...draft, message }),
    canSubmit
    // No focusKey: the draft focuses its message box once, on mount.
  });

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
            placeholder={workspacePlaceholder ?? "C:\\workspace\\your-project"}
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
          onCompositionStart={input.onCompositionStart}
          onCompositionEnd={input.onCompositionEnd}
          onKeyDown={input.onKeyDown}
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
          <button className="button button-primary" type="submit" aria-label={retryLabel ?? "Send message"} disabled={!canSubmit}>
            {busy ? "Starting…" : (retryLabel ?? "Send")}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </form>
    </section>
  );
}
