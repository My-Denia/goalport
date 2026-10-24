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
  coordinationAvailable: boolean;
  runtimeRequiredHint?: string;
  onSelect: (provider: string) => void;
}

/** Local draft Runtime choice — no Core command runs until the first Send. */
function DraftRuntimePicker({ runtimes, provider, connected, coordinationAvailable, runtimeRequiredHint, onSelect }: DraftRuntimePickerProps) {
  const selected = runtimes.find((candidate) => candidate.id === provider);
  return (
    <div className="runtime-picker draft-runtime-picker">
      <RuntimePickerMenu
        runtimes={runtimes}
        selectedId={provider}
        triggerClassName="runtime-picker-button"
        triggerAriaLabel="Select Runtime"
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
              <strong>{selected ? selected.name : (runtimeRequiredHint ? "Coordinated goal" : "Choose a Runtime")}</strong>
              <small>{coordinationAvailable
                ? "Send without picking, or pick the single-harness path."
                : (runtimeRequiredHint ?? "Choose a Runtime before sending.")}</small>
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
  /** Non-null holds Send (quiet progress, not an error): harness access for this draft is still resolving. */
  waitingOn: string | null;
  retryLabel?: string;
  error: { sentence: string; technical?: string } | null;
  canBrowse: boolean;
  coordinationAvailable: boolean;
  runtimeRequiredHint?: string;
  coordinationResult?: string | null;
  activeGoalTitle?: string | null;
  onContinueCoordination?: () => void;
  onStopCoordination?: () => void;
  linuxCanStartCoordination?: boolean;
  linuxWrite?: boolean;
  onLinuxWriteChange?: (value: boolean) => void;
  workspacePlaceholder?: string;
  workspaceHint?: string;
  harnessWarning?: string | null;
  consentWarning?: string | null;
  onGrantConsent?: () => void;
  backgroundConsent?: boolean;
  onBackgroundConsentChange?: (enabled: boolean) => void;
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
  draft, runtimes, connected, busy, blockedFromSending, waitingOn, retryLabel, error, canBrowse, coordinationAvailable, runtimeRequiredHint, coordinationResult, activeGoalTitle, onContinueCoordination, onStopCoordination, linuxCanStartCoordination = false, linuxWrite = false, onLinuxWriteChange, workspacePlaceholder, workspaceHint, harnessWarning, consentWarning, onGrantConsent, backgroundConsent = false, onBackgroundConsentChange, onBrowse, onChange, onSubmit, onDiscard
}: DraftGoalComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const canSubmit = !busy
    && !waitingOn
    && (!blockedFromSending || Boolean(retryLabel))
    && connected
    && draft.workspace.trim().length > 0
    && draft.message.trim().length > 0
    && (coordinationAvailable || linuxCanStartCoordination || draft.provider.trim().length > 0);

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
    <section className="draft-composer" aria-label={activeGoalTitle || "New goal draft"}>
      <div className="conversation-heading">
        <div className="conversation-heading-main">
          <h2>{activeGoalTitle || "Start a goal"}</h2>
          <p>{activeGoalTitle ? (coordinationResult || "This goal stays on screen.") : "What would you like to work on?"}</p>
        </div>
      </div>

      <form className="draft-composer-form" aria-label={activeGoalTitle ? "This goal" : "Start a goal"} onSubmit={onSubmit}>
        <label className="field-label" htmlFor="draft-workspace">{workspaceHint ? "Project folder" : "Workspace"}</label>
        <div className="field-with-icon draft-workspace-row">
          <span aria-hidden="true">⌂</span>
          <input
            id="draft-workspace"
            aria-label="Project folder"
            value={draft.workspace}
            onChange={(event) => onChange({ ...draft, workspace: event.target.value })}
            placeholder={workspacePlaceholder ?? "C:\\workspace\\your-project"}
            disabled={busy || Boolean(activeGoalTitle)}
          />
          {canBrowse ? (
            <button className="button button-small button-outline" type="button" onClick={onBrowse} disabled={busy}>Browse…</button>
          ) : null}
        </div>
        {workspaceHint ? <p className="draft-hint">{activeGoalTitle ? "Continue stays in this folder. New goal can use another." : workspaceHint}</p> : null}
        {harnessWarning ? <p className="draft-hint">{harnessWarning}</p> : null}
        {consentWarning ? <p className="draft-hint">{consentWarning} {onGrantConsent ? <button className="button button-small button-outline" type="button" onClick={onGrantConsent}>Allow spending subscription quota</button> : null}</p> : null}

        {linuxCanStartCoordination && !draft.provider.trim() ? (
          activeGoalTitle ? null : <p className="draft-hint">{runtimeRequiredHint}</p>
        ) : (
          <DraftRuntimePicker
            runtimes={runtimes}
            provider={draft.provider}
            connected={connected}
            coordinationAvailable={coordinationAvailable}
            runtimeRequiredHint={runtimeRequiredHint}
            onSelect={(provider) => onChange({ ...draft, provider })}
          />
        )}
        {coordinationResult && !activeGoalTitle ? <p className="draft-hint">{coordinationResult}</p> : null}
        {onLinuxWriteChange ? <label className="draft-hint"><input type="checkbox" checked={linuxWrite} onChange={(event) => onLinuxWriteChange(event.target.checked)} /> Allow Codex to change files in this workspace</label> : null}
        {onStopCoordination ? <button className="button button-small button-outline" type="button" onClick={onStopCoordination}>Stop this goal</button> : null}
        {onContinueCoordination ? <button className="button button-small button-outline" type="button" onClick={onContinueCoordination}>Continue this goal</button> : null}


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
            ? (onStopCoordination ? "This goal is still running." : activeGoalTitle ? "Add a follow-up, then Continue. The next Send starts a new goal." : "Ask GoalPort…")
            : "Reconnect Core before sending…"}
          rows={3}
          disabled={busy}
        />

        {waitingOn ? <p className="composer-wait" role="status">{waitingOn}</p> : null}

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

        {onBackgroundConsentChange ? (
          <label className="draft-background-consent">
            <input
              type="checkbox"
              aria-label="Keep working after closing"
              checked={backgroundConsent}
              disabled={busy}
              onChange={(event) => onBackgroundConsentChange(event.target.checked)}
            />
            Keep working after closing
          </label>
        ) : null}
        <div className="dialog-actions">
          {activeGoalTitle ? (
            draft.message.trim() ? <button className="button button-quiet" type="button" aria-label="Clear follow-up" onClick={onDiscard} disabled={busy}>Clear follow-up</button> : null
          ) : (
            <button className="button button-quiet" type="button" aria-label="Discard draft" onClick={onDiscard} disabled={busy}>Discard draft</button>
          )}
          <button className="button button-primary" type="submit" aria-label={retryLabel ?? "Send message"} disabled={!canSubmit}>
            {busy ? "Starting…" : (retryLabel ?? "Send")}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </form>
    </section>
  );
}
