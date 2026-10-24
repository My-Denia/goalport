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
  failureHeadline?: string | null;
  goalDetail?: string | null;
  goalChange?: string | null;
  activeGoalTitle?: string | null;
  onContinueCoordination?: () => void;
  onStopCoordination?: () => void;
  stopLabel?: string;
  onLeaveGoal?: () => void;
  linuxCanStartCoordination?: boolean;
  linuxWrite?: boolean;
  inputsLocked?: boolean;
  onLinuxWriteChange?: (value: boolean) => void;
  workspacePlaceholder?: string;
  workspaceHint?: string;
  harnessWarning?: string | null;
  signedInHint?: string | null;
  discoverHint?: string | null;
  consentWarning?: string | null;
  leftoverHint?: string | null;
  onGrantConsent?: () => void;
  keepRunningHint?: string | null;
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
  draft, runtimes, connected, busy, blockedFromSending, waitingOn, retryLabel, error, canBrowse, coordinationAvailable, runtimeRequiredHint, coordinationResult, failureHeadline = null, goalDetail, goalChange, activeGoalTitle, onContinueCoordination, onStopCoordination, stopLabel = "Stop this goal", onLeaveGoal, linuxCanStartCoordination = false, linuxWrite = false, onLinuxWriteChange, inputsLocked = false, workspacePlaceholder, workspaceHint, harnessWarning, signedInHint, discoverHint, consentWarning, leftoverHint, onGrantConsent, keepRunningHint, backgroundConsent = false, onBackgroundConsentChange, onBrowse, onChange, onSubmit, onDiscard
}: DraftGoalComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const inFlightLine = coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." || coordinationResult === "Allowing Background Send.";
  const addressGone = coordinationResult === "That goal is no longer available." || Boolean(coordinationResult?.startsWith("That address is no longer available."));
  const missingGoalLabel = coordinationResult === "That goal is no longer available." ? "That goal is no longer available. New goal can still start." : coordinationResult;
  const folderHint = !workspaceHint || inFlightLine || (addressGone && (blockedFromSending || consentWarning || harnessWarning || !activeGoalTitle)) ? null : leftoverHint ? (activeGoalTitle ? "The next goal stays in this folder." : `You can change the folder before the next goal. ${workspaceHint}`) : activeGoalTitle ? (onContinueCoordination ? (addressGone ? "Continue is the goal on screen, not the missing address." : "Continue stays in this folder. New goal can use another.") : onStopCoordination ? "This goal stays in this folder." : failureHeadline && (blockedFromSending || consentWarning || harnessWarning) ? null : addressGone ? "A new send stays in this folder. It does not open the missing address." : "A new send stays in this folder. New goal can use another.") : workspaceHint;
  const signInFollow = harnessWarning?.startsWith("No signed-in") ? "Sign in a subscription harness before sending." : "Sign in another harness before sending.";
  const allowedFollow = harnessWarning || consentWarning || discoverHint || !backgroundConsent || blockedFromSending || busy
    ? "You can send when the other checks pass."
    : !draft.workspace.trim()
      ? "Choose a folder, then send."
      : !draft.message.trim()
        ? "Write the goal, then send."
        : "You can send.";
  const canSubmit = !busy
    && !inputsLocked
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
    <section className="draft-composer" aria-label={coordinationResult === "That goal is no longer available." || coordinationResult?.startsWith("That address is no longer available.") || coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." || coordinationResult === "Allowing Background Send." || (coordinationResult === "Background Send is allowed." && !harnessWarning) ? missingGoalLabel : leftoverHint || failureHeadline || harnessWarning || (!activeGoalTitle && consentWarning) || (activeGoalTitle ? (coordinationResult?.includes("stays unreplayed") ? coordinationResult : coordinationResult?.startsWith("This goal's exit is not confirmed") ? `${activeGoalTitle} — not confirmed` : activeGoalTitle) : coordinationResult || "New goal")}>
      <div className="conversation-heading">
        <div className="conversation-heading-main">
          <h2>{coordinationResult === "That goal is no longer available." || coordinationResult?.startsWith("That address is no longer available.") || coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." || coordinationResult === "Allowing Background Send." || (coordinationResult === "Background Send is allowed." && !harnessWarning) ? coordinationResult : leftoverHint || failureHeadline || (!activeGoalTitle && (harnessWarning || consentWarning)) || activeGoalTitle || (inputsLocked && coordinationResult ? coordinationResult : "Start a goal")}</h2>
          <p>{inFlightLine ? "Wait for this to finish." : coordinationResult === "Background Send is allowed." ? (harnessWarning ? signInFollow : allowedFollow) : coordinationResult === "That goal is no longer available." ? "New goal can still start." : coordinationResult?.startsWith("That address is no longer available.") ? (activeGoalTitle || "The draft is still here.") : activeGoalTitle ? (failureHeadline || coordinationResult === leftoverHint ? activeGoalTitle : coordinationResult || "This goal stays on screen.") : (inputsLocked ? "This send has not returned." : harnessWarning && harnessWarning !== failureHeadline ? signInFollow : failureHeadline ? "The draft is still here." : consentWarning ? "Allow Background Send before sending." : leftoverHint ? "You can still write the next goal." : coordinationResult?.includes("stays unreplayed") ? coordinationResult : "What would you like to work on?")}</p>
          {activeGoalTitle && goalChange ? (
            <details className="draft-hint">
              <summary>What changed</summary>
              <p>{goalChange}</p>
            </details>
          ) : null}
          {activeGoalTitle && goalDetail ? (
            <details className="draft-hint">
              <summary>What was checked</summary>
              <p>{goalDetail}</p>
            </details>
          ) : null}
        </div>
      </div>

      <form className="draft-composer-form" aria-label={coordinationResult === "That goal is no longer available." || coordinationResult?.startsWith("That address is no longer available.") || coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." || coordinationResult === "Allowing Background Send." || (coordinationResult === "Background Send is allowed." && !harnessWarning) ? missingGoalLabel : leftoverHint || failureHeadline || harnessWarning || (!activeGoalTitle && consentWarning) || (activeGoalTitle ? (coordinationResult?.includes("stays unreplayed") ? coordinationResult : coordinationResult?.startsWith("This goal's exit is not confirmed") ? "This goal is not confirmed" : "This goal") : coordinationResult?.includes("stays unreplayed") ? coordinationResult : "Start a goal")} onSubmit={onSubmit}>
        <label className="field-label" htmlFor="draft-workspace">{workspaceHint ? "Project folder" : "Workspace"}</label>
        <div className="field-with-icon draft-workspace-row">
          <span aria-hidden="true">⌂</span>
          <input
            id="draft-workspace"
            aria-label="Project folder"
            aria-describedby={folderHint ? "draft-folder-hint" : undefined}
            value={draft.workspace}
            onChange={(event) => onChange({ ...draft, workspace: event.target.value })}
            placeholder={workspacePlaceholder ?? "C:\\workspace\\your-project"}
            disabled={busy || inputsLocked || Boolean(activeGoalTitle)}
          />
          {canBrowse ? (
            <button className="button button-small button-outline" type="button" onClick={onBrowse} disabled={busy || inputsLocked || Boolean(activeGoalTitle)}>Browse…</button>
          ) : null}
        </div>
        {folderHint ? <p id="draft-folder-hint" className="draft-hint">{folderHint}</p> : null}
        {harnessWarning && activeGoalTitle && harnessWarning !== failureHeadline ? <p className="draft-hint">{harnessWarning}</p> : null}
        {discoverHint ? <p className="draft-hint">{discoverHint}</p> : null}
        {signedInHint && !harnessWarning ? <p className="draft-hint">{signedInHint}</p> : null}
        {consentWarning ? <p className="draft-hint">{activeGoalTitle || harnessWarning ? consentWarning : null} {onGrantConsent ? <button className="button button-small button-outline" type="button" disabled={inFlightLine} onClick={onGrantConsent}>{coordinationResult === "Allowing Background Send." ? coordinationResult : "Allow spending subscription quota"}</button> : null}</p> : null}

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
        {coordinationResult && !activeGoalTitle && !inputsLocked && coordinationResult !== failureHeadline && !coordinationResult.includes("stays unreplayed") ? <p className="draft-hint">{coordinationResult}</p> : null}
        {onLinuxWriteChange ? <label className="draft-hint"><input type="checkbox" checked={linuxWrite} disabled={busy || inputsLocked || Boolean(onStopCoordination)} onChange={(event) => onLinuxWriteChange(event.target.checked)} /> Allow Codex to change files in this workspace</label> : null}
        {onStopCoordination ? <button className="button button-small button-outline" type="button" disabled={inFlightLine} onClick={onStopCoordination}>{coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." ? coordinationResult : stopLabel}</button> : null}
        {onLeaveGoal ? <button className="button button-small button-outline" type="button" disabled={inFlightLine} onClick={onLeaveGoal}>{coordinationResult === "Leaving this unreplayed." ? coordinationResult : "Leave it unreplayed"}</button> : null}
        {onContinueCoordination ? <button className="button button-small button-outline" type="button" disabled={inFlightLine} onClick={onContinueCoordination}>{coordinationResult === "Continuing." ? coordinationResult : addressGone ? "Continue the goal on screen" : "Continue this goal"}</button> : null}


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
            ? (coordinationResult === "Allowing Background Send." ? "Wait for this to finish." : coordinationResult === "Background Send is allowed." ? (harnessWarning ? signInFollow : allowedFollow) : coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." ? "Wait for this to finish." : coordinationResult === "That goal is no longer available." ? "New goal can still start." : coordinationResult?.startsWith("That address is no longer available.") ? (activeGoalTitle && !blockedFromSending && !consentWarning && !harnessWarning ? "A new send can still start." : "The draft is still here.") : onStopCoordination ? (coordinationResult === "The worker is gone. Its exit is not confirmed, so another goal cannot start yet." ? "The worker is gone. Its exit is not confirmed." : coordinationResult?.startsWith("This goal's exit is not confirmed") ? coordinationResult : /unconfirmed/i.test(coordinationResult || "") ? "Stop is not confirmed." : "This goal is still running.") : harnessWarning && harnessWarning !== failureHeadline ? signInFollow : leftoverHint ? "You can still write the next goal." : failureHeadline ? (activeGoalTitle && !blockedFromSending && !consentWarning ? "A new send can still start. This goal is not continued." : "The draft is still here.") : consentWarning ? "Allow Background Send before sending." : coordinationResult?.includes("stays unreplayed") ? "A new send can still start." : activeGoalTitle ? (onContinueCoordination ? "Add a follow-up, then Continue. The next Send starts a new goal." : "The next Send starts a new goal.") : "Ask GoalPort…")
            : "Reconnect Core before sending…"}
          rows={3}
          disabled={busy || inputsLocked}
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
              disabled={busy || inputsLocked || Boolean(onStopCoordination) || Boolean(consentWarning)}
              onChange={(event) => onBackgroundConsentChange(event.target.checked)}
            />
            Keep working after closing
          </label>
        ) : null}
        {keepRunningHint ? <p className="draft-hint">{keepRunningHint}</p> : null}
        <div className="dialog-actions">
          {activeGoalTitle ? (
            draft.message.trim() ? <button className="button button-quiet" type="button" aria-label="Clear follow-up" onClick={onDiscard} disabled={busy || inputsLocked}>Clear follow-up</button> : null
          ) : (
            <button className="button button-quiet" type="button" aria-label="Discard draft" onClick={onDiscard} disabled={busy || inputsLocked}>Discard draft</button>
          )}
          <button className="button button-primary" type="submit" aria-label={coordinationResult === "Sending." ? "Sending." : discoverHint === "Saved plans could not be read. Send will try again. Continue stays hidden until that read succeeds." ? "Try again" : addressGone ? "Send a new goal" : retryLabel ?? "Send message"} disabled={!canSubmit || coordinationResult === "Sending."}>
            {coordinationResult === "Sending." ? "Sending." : busy ? "Starting…" : discoverHint === "Saved plans could not be read. Send will try again. Continue stays hidden until that read succeeds." ? "Try again" : addressGone ? "Send a new goal" : (retryLabel ?? "Send")}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </form>
    </section>
  );
}
