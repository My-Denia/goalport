import { useRef, type FormEvent } from "react";
import type { RuntimeProfile } from "../types";
import { RuntimePickerMenu } from "../ui/RuntimePickerMenu";
import { useComposerInput } from "./useComposerInput";
import { WorkspaceEvidenceDetails } from "./WorkspaceEvidenceDetails";
import { shortGoalTitle } from "./shortGoalTitle";
import type { ExecutionWorkspaceEvidence, AuditInputEvidenceCoverage } from "../coordination/coordinateGoal";

export interface GoalDraftValue {
  workspace: string;
  provider: string;
  message: string;
}

function capitalize(word: string): string {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1);
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
  goalEvidence?: ExecutionWorkspaceEvidence | null;
  auditInputEvidenceCoverage?: AuditInputEvidenceCoverage | null;
  auditInputEvidenceText?: string | null;
  activeGoalTitle?: string | null;
  onContinueCoordination?: () => void;
  onStopCoordination?: () => void;
  stopLabel?: string;
  currentWorkTitle?: string | null;
  currentWorkLine?: string | null;
  savedResultLabel?: string | null;
  savedResultOutcome?: string | null;
  continueDisabledReason?: string | null;
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
  optionsRestored?: boolean;
  discoveredHarnesses?: readonly string[];
  isLinuxActiveTarget?: boolean;
  continueDisabled?: boolean;
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
export function GoalStatusHeading({
  draft, busy, blockedFromSending, coordinationResult, failureHeadline = null, goalDetail, goalChange, goalEvidence, auditInputEvidenceCoverage, auditInputEvidenceText, activeGoalTitle, onContinueCoordination, inputsLocked = false, harnessWarning, discoverHint, consentWarning, leftoverHint, backgroundConsent = false, linuxCanStartCoordination = false, savedResultLabel, savedResultOutcome
}: DraftGoalComposerProps) {
  const inFlightLine = coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." || coordinationResult === "Allowing Background Send.";
  const missingGoalLabel = coordinationResult === "That goal is no longer available." ? "That goal is no longer available. New goal can still start." : coordinationResult;
  const admissionUnsaidResult = Boolean(coordinationResult?.startsWith("The send returned without saying the goal was admitted.") || coordinationResult?.startsWith("Continue returned without saying the goal was admitted."));
  const stoppedResult = Boolean(coordinationResult?.toLowerCase().includes("no further turn was sent."));
  const signInFollow = harnessWarning?.startsWith("No signed-in") ? "Sign in a subscription harness before sending." : "Sign in another harness before sending.";
  const allowedFollow = harnessWarning || consentWarning || discoverHint || !backgroundConsent || blockedFromSending || busy
    ? "You can send when the other checks pass."
    : !draft.workspace.trim()
      ? "Choose a folder, then send."
      : !draft.message.trim()
        ? "Write the goal, then send."
        : "You can send.";

  const headingText = linuxCanStartCoordination && !activeGoalTitle && (coordinationResult === "Allowing Background Send." || coordinationResult === "Background Send is allowed.") ? "Start a goal" : (coordinationResult === "That goal is no longer available." || coordinationResult?.startsWith("That address is no longer available.") || coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." || coordinationResult === "Allowing Background Send." || (coordinationResult === "Background Send is allowed." && !harnessWarning) || admissionUnsaidResult || (stoppedResult && !activeGoalTitle))
    ? missingGoalLabel
    : leftoverHint || failureHeadline || (activeGoalTitle ? shortGoalTitle(activeGoalTitle) : (inputsLocked && coordinationResult ? coordinationResult : "Start a goal"));

  return (
      <div className="conversation-heading">
        <div className="conversation-heading-main">
          {savedResultLabel ? <p className="workspace-evidence-label">{savedResultLabel}</p> : null}
          <h2 title={activeGoalTitle || undefined} aria-label={activeGoalTitle || undefined}>{savedResultLabel ? (activeGoalTitle ? shortGoalTitle(activeGoalTitle) : "Saved goal unavailable") : headingText}</h2>
          <p>{savedResultLabel ? savedResultOutcome : inFlightLine ? "Wait for this to finish." : coordinationResult === "Background Send is allowed." ? (harnessWarning ? signInFollow : allowedFollow) : coordinationResult === "That goal is no longer available." ? "The draft is still here." : stoppedResult ? (activeGoalTitle ? coordinationResult : onContinueCoordination ? "Continue starts the next step." : "No further turn was sent.") : admissionUnsaidResult ? (coordinationResult?.includes("exit is not confirmed") ? "Another goal cannot start yet." : "You can try again.") : coordinationResult?.startsWith("That address is no longer available.") ? (activeGoalTitle || "The draft is still here.") : activeGoalTitle ? (failureHeadline || coordinationResult === leftoverHint ? activeGoalTitle : coordinationResult || "This goal stays on screen.") : (inputsLocked ? "This send has not returned." : harnessWarning && harnessWarning !== failureHeadline ? signInFollow : failureHeadline ? "The draft is still here." : consentWarning ? (linuxCanStartCoordination ? "Write your goal, then allow the agents below." : "Allow Background Send before sending.") : leftoverHint ? "You can still write the next goal." : coordinationResult?.includes("stays unreplayed") ? coordinationResult : "What would you like to work on?")}</p>
          {!savedResultLabel && activeGoalTitle && stoppedResult && (goalChange || goalEvidence) ? (
            <p className="workspace-evidence-label">Previous saved result; the stop message above describes the current job.</p>
          ) : null}
          {activeGoalTitle && (goalChange || goalEvidence) ? (
            <WorkspaceEvidenceDetails
              evidence={goalEvidence}
              executionText={goalChange}
              auditInputEvidenceCoverage={auditInputEvidenceCoverage}
              auditInputEvidenceText={auditInputEvidenceText}
            />
          ) : null}
          {activeGoalTitle && goalDetail ? (
            <details className="draft-hint">
              <summary>What was checked</summary>
              <p>{goalDetail}</p>
            </details>
          ) : null}
        </div>
      </div>
  );
}

export function DraftGoalComposer({
  draft, runtimes, connected, busy, blockedFromSending, waitingOn, retryLabel, error, canBrowse, coordinationAvailable, runtimeRequiredHint, coordinationResult, failureHeadline = null, goalDetail, goalChange, activeGoalTitle, onContinueCoordination, onStopCoordination, stopLabel = "Stop this goal", currentWorkTitle, currentWorkLine, continueDisabledReason, savedResultOutcome, onLeaveGoal, linuxCanStartCoordination = false, linuxWrite = false, onLinuxWriteChange, inputsLocked = false, workspacePlaceholder, workspaceHint, harnessWarning, signedInHint, discoverHint, consentWarning, leftoverHint, onGrantConsent, keepRunningHint, backgroundConsent = false, onBackgroundConsentChange, optionsRestored = false, discoveredHarnesses = [], isLinuxActiveTarget = false, continueDisabled = false, onBrowse, onChange, onSubmit, onDiscard
}: DraftGoalComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const inFlightLine = coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." || coordinationResult === "Allowing Background Send.";
  const addressGone = coordinationResult === "That goal is no longer available." || Boolean(coordinationResult?.startsWith("That address is no longer available."));
  const admissionUnsaidResult = Boolean(coordinationResult?.startsWith("The send returned without saying the goal was admitted.") || coordinationResult?.startsWith("Continue returned without saying the goal was admitted."));
  const stoppedResult = Boolean(coordinationResult?.toLowerCase().includes("no further turn was sent."));
  const folderHint = !workspaceHint || inFlightLine || (addressGone && (blockedFromSending || consentWarning || harnessWarning || !activeGoalTitle)) ? null : leftoverHint ? (activeGoalTitle ? "The next goal stays in this folder." : `You can change the folder before the next goal. ${workspaceHint}`) : activeGoalTitle ? (stoppedResult ? "The new send stays in this folder." : admissionUnsaidResult ? (coordinationResult?.includes("exit is not confirmed") ? "Another goal cannot start in this folder yet." : "The retry stays in this folder.") : onContinueCoordination ? (addressGone ? "Continue is the goal on screen, not the missing address." : "Continue stays in this folder. New goal can use another.") : onStopCoordination ? "This goal stays in this folder." : failureHeadline && (blockedFromSending || consentWarning || harnessWarning) ? null : addressGone ? "A new send stays in this folder. It does not open the missing address." : "A new send stays in this folder. New goal can use another.") : workspaceHint;
  const signInFollow = harnessWarning?.startsWith("No signed-in") ? "Sign in a subscription harness before sending." : "Sign in another harness before sending.";
  const allowedFollow = harnessWarning || consentWarning || discoverHint || !backgroundConsent || blockedFromSending || busy
    ? "You can send when the other checks pass."
    : !draft.workspace.trim()
      ? "Choose a folder, then send."
      : !draft.message.trim()
        ? "Write the goal, then send."
        : "You can send.";

  const canSubmit = isLinuxActiveTarget
    ? (!busy && !inputsLocked && !continueDisabled && draft.message.trim().length > 0 && Boolean(onContinueCoordination))
    : (!busy
       && !inputsLocked
       && !waitingOn
       && (!blockedFromSending || Boolean(retryLabel))
       && connected
       && draft.workspace.trim().length > 0
       && draft.message.trim().length > 0
       && (coordinationAvailable || linuxCanStartCoordination || draft.provider.trim().length > 0));

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

  const grantButtonLabel = inFlightLine && coordinationResult === "Allowing Background Send."
    ? "Allowing agents…"
    : harnessWarning === "Background Send was not allowed." || coordinationResult === "Background Send was not allowed."
      ? "Try again"
      : discoveredHarnesses && discoveredHarnesses.length >= 2
        ? `Allow ${discoveredHarnesses.map(capitalize).join(" and ")} to work`
        : discoveredHarnesses && discoveredHarnesses.length === 1
          ? `Allow ${capitalize(discoveredHarnesses[0])} to work`
          : "Allow background work";

  const continueButtonLabel = coordinationResult === "Continuing." ? "Continuing…" : "Continue";

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLinuxActiveTarget) {
      if (draft.message.trim().length > 0 && !continueDisabled && onContinueCoordination) {
        onContinueCoordination();
      }
      return;
    }
    onSubmit(event);
  };

  return (
    <section className={`draft-composer${isLinuxActiveTarget ? " draft-composer-active" : ""}`} aria-label={activeGoalTitle || "New goal"}>
      {currentWorkLine ? <div className="current-work-strip" role="status" aria-label="Current work">
        <div><strong title={currentWorkTitle || undefined}>{currentWorkTitle ? `Current work — ${shortGoalTitle(currentWorkTitle)}` : "Current work — not confirmed"}</strong><p>{currentWorkLine}</p></div>
        {onStopCoordination ? <button className="button button-small button-outline" type="button" title={stopLabel} aria-label={stopLabel} disabled={busy || inputsLocked || inFlightLine} onClick={onStopCoordination}>{currentWorkTitle ? shortGoalTitle(stopLabel, 64) : stopLabel}</button> : null}
        {onLeaveGoal ? <button className="button button-small button-outline" type="button" disabled={busy || inputsLocked || inFlightLine} onClick={onLeaveGoal}>Leave it unreplayed</button> : null}
      </div> : null}
      <form className="draft-composer-form" aria-label={activeGoalTitle ? "This goal" : "Start a goal"} onSubmit={handleFormSubmit}>
        {!isLinuxActiveTarget ? <label className="field-label" htmlFor="draft-workspace">{workspaceHint ? "Project folder" : "Workspace"}</label> : null}
        <div className={`field-with-icon draft-workspace-row${isLinuxActiveTarget ? " compact-workspace-row" : ""}`} title={draft.workspace}>
          <span aria-hidden="true">⌂</span>
          <input
            id="draft-workspace"
            aria-label="Project folder"
            aria-describedby={folderHint ? "draft-folder-hint" : undefined}
            value={draft.workspace}
            onChange={(event) => onChange({ ...draft, workspace: event.target.value })}
            placeholder={workspacePlaceholder ?? "C:\\workspace\\your-project"}
            disabled={busy || inputsLocked || Boolean(activeGoalTitle)}
            readOnly={isLinuxActiveTarget}
            title={draft.workspace}
            className={isLinuxActiveTarget ? "compact-workspace-input" : undefined}
          />
          {canBrowse && !isLinuxActiveTarget ? (
            <button className="button button-small button-outline" type="button" onClick={onBrowse} disabled={busy || inputsLocked || Boolean(activeGoalTitle)}>Browse…</button>
          ) : null}
        </div>
        {folderHint && !isLinuxActiveTarget ? <p id="draft-folder-hint" className="draft-hint">{folderHint}</p> : null}
        {harnessWarning && harnessWarning !== failureHeadline ? <p className="draft-hint">{harnessWarning}</p> : null}
        {discoverHint ? <p className="draft-hint">{discoverHint}</p> : null}
        {signedInHint && !harnessWarning ? <p className="draft-hint">{signedInHint}</p> : null}

        {linuxCanStartCoordination && !draft.provider.trim() ? null : (
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
            ? (inFlightLine ? "Wait for this to finish." : isLinuxActiveTarget ? "Add a follow-up (optional)" : linuxCanStartCoordination && !admissionUnsaidResult && !addressGone ? "What would you like to accomplish?" : coordinationResult === "Allowing Background Send." ? "Wait for this to finish." : coordinationResult === "Background Send is allowed." ? (harnessWarning ? signInFollow : allowedFollow) : coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." ? "Wait for this to finish." : coordinationResult === "That goal is no longer available." ? "You can write the next goal." : admissionUnsaidResult ? (coordinationResult?.includes("exit is not confirmed") ? "Another goal cannot start yet." : "You can try again.") : stoppedResult ? (onContinueCoordination ? "This stop is not resumed. Continue as a new send." : "A new send can still start.") : coordinationResult?.startsWith("That address is no longer available.") ? (activeGoalTitle && !blockedFromSending && !consentWarning && !harnessWarning ? "A new send can still start." : "The draft is still here.") : onStopCoordination ? (coordinationResult === "The worker is gone. Its exit is not confirmed, so another goal cannot start yet." ? "The worker is gone. Its exit is not confirmed." : coordinationResult?.startsWith("This goal's exit is not confirmed") ? coordinationResult : /unconfirmed/i.test(coordinationResult || "") ? "Stop is not confirmed." : "This goal is still running.") : harnessWarning && harnessWarning !== failureHeadline ? signInFollow : leftoverHint ? "You can still write the next goal." : failureHeadline ? (activeGoalTitle && !blockedFromSending && !consentWarning ? "A new send can still start. This goal is not continued." : "The draft is still here.") : consentWarning ? "Allow Background Send before sending." : coordinationResult?.includes("stays unreplayed") ? "A new send can still start." : activeGoalTitle ? (onContinueCoordination ? "Add a follow-up, then Continue. The next Send starts a new goal." : "The next Send starts a new goal.") : "Ask GoalPort…")
            : "Reconnect Core before sending…"}
          rows={isLinuxActiveTarget ? 2 : 3}
          disabled={busy || inputsLocked}
        />

        {waitingOn ? <p className="composer-wait" role="status">{waitingOn}</p> : null}
        {isLinuxActiveTarget && continueDisabledReason && continueDisabledReason !== currentWorkLine && continueDisabledReason !== savedResultOutcome ? <p className="draft-hint" role="status">{continueDisabledReason}</p> : null}

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

        {consentWarning ? (
          <p className="draft-hint">
            {harnessWarning === "Background Send was not allowed." ? null : (activeGoalTitle || harnessWarning ? consentWarning : null)}
            {onGrantConsent ? (
              <>
                <button className="button button-small button-outline" type="button" disabled={inFlightLine} onClick={onGrantConsent}>
                  {grantButtonLabel}
                </button>
                <span className="draft-hint-note"> {discoveredHarnesses.length > 0 ? "Uses your existing subscriptions. Nothing runs until you send a goal." : "Available agents work only after you send a goal."}</span>
              </>
            ) : null}
          </p>
        ) : null}
        {onLinuxWriteChange && (isLinuxActiveTarget || discoveredHarnesses.includes("codex")) ? <label className="draft-hint"><input type="checkbox" checked={linuxWrite} disabled={busy || inputsLocked || Boolean(onStopCoordination)} onChange={(event) => onLinuxWriteChange(event.target.checked)} /> Allow Codex to change files in this workspace</label> : null}
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
        {optionsRestored ? (
          <p className="draft-hint options-restored-note">Last used options restored</p>
        ) : null}
        {keepRunningHint ? <p className="draft-hint">{keepRunningHint}</p> : null}
        <div className="dialog-actions">
          {onStopCoordination && !currentWorkLine ? <button className="button button-small button-outline" type="button" title={stopLabel} aria-label={stopLabel} disabled={coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop."} onClick={onStopCoordination}>{coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." ? coordinationResult : currentWorkTitle ? shortGoalTitle(stopLabel, 64) : stopLabel}</button> : null}
          {onLeaveGoal && !currentWorkLine ? <button className="button button-small button-outline" type="button" disabled={inFlightLine} onClick={onLeaveGoal}>{coordinationResult === "Leaving this unreplayed." ? coordinationResult : "Leave it unreplayed"}</button> : null}
          {isLinuxActiveTarget ? (
            <>
              {draft.message.trim() ? (
                <button className="button button-quiet" type="button" aria-label="Clear follow-up" onClick={onDiscard} disabled={busy || inputsLocked}>Clear follow-up</button>
              ) : null}
              {<button
                className="button button-primary"
                type="button"
                aria-label="Continue this goal"
                disabled={continueDisabled || busy || inputsLocked || !connected || !onContinueCoordination}
                title={continueDisabledReason || undefined}
                onClick={onContinueCoordination}
              >
                {continueButtonLabel}
                <span aria-hidden="true">↗</span>
              </button>}
            </>
          ) : (
            <>
              {onContinueCoordination && !linuxCanStartCoordination ? <button className="button button-small button-outline" type="button" disabled={inFlightLine} onClick={onContinueCoordination}>{coordinationResult === "Continuing." ? coordinationResult : stoppedResult ? "Continue as a new send" : coordinationResult?.startsWith("Continue returned without saying the goal was admitted.") ? "Try again" : addressGone ? "Continue the goal on screen" : "Continue this goal"}</button> : null}
              {activeGoalTitle ? (
                draft.message.trim() ? <button className="button button-quiet" type="button" aria-label="Clear follow-up" onClick={onDiscard} disabled={busy || inputsLocked}>Clear follow-up</button> : null
              ) : (
                <button className="button button-quiet" type="button" aria-label="Discard draft" onClick={onDiscard} disabled={busy || inputsLocked}>Discard draft</button>
              )}
              <button className="button button-primary" type="submit" aria-label={coordinationResult === "Sending." ? "Sending." : (coordinationResult?.startsWith("The send returned without saying the goal was admitted.") && !coordinationResult.includes("exit is not confirmed")) ? "Try again" : addressGone ? "Send a new goal" : retryLabel ?? "Send message"} disabled={!canSubmit || coordinationResult === "Sending."}>
                {coordinationResult === "Sending." ? "Sending." : busy ? "Starting…" : (coordinationResult?.startsWith("The send returned without saying the goal was admitted.") && !coordinationResult.includes("exit is not confirmed")) ? "Try again" : addressGone ? "Send a new goal" : (retryLabel ?? "Send")}
                <span aria-hidden="true">↗</span>
              </button>
            </>
          )}
        </div>
      </form>
    </section>
  );
}
