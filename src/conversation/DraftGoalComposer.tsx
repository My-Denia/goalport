import { PiCapacityControl } from './PiCapacityControl';
import { folderName, readRecentFolders } from "../lib/recentFolders";
import type { PiCapacitySelection } from "../../electron/pi-capacity.mjs";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { RuntimeProfile, WorkflowDefinition, WorkflowSaveInput } from "../types";
import { WorkflowEditorDialog, type WorkflowEditResult } from "../ui/WorkflowEditorDialog";
import { RuntimePickerMenu, type RuntimeChoice } from "../ui/RuntimePickerMenu";
import { useComposerInput } from "./useComposerInput";
import { WorkspaceEvidenceDetails } from "./WorkspaceEvidenceDetails";
import { shortGoalTitle } from "./shortGoalTitle";
import type { ExecutionWorkspaceEvidence, AuditInputEvidenceCoverage } from "../coordination/coordinateGoal";
import { sendDisabledReason, CHOOSE_WAY_SENTENCE } from "./sendDisabledReason";

/** What the app knows about why Send may be held; only the coordinated Windows draft passes it. */
export interface SendBlockers {
  /** The existing sentence for a folder, profile, reconnect or held-Stop block. */
  holdSentence: string | null;
  grantMissing: boolean;
  grantControlVisible: boolean;
  /** Agents that can run for this goal once the list is in (null while unknown), and how many the chosen workflow needs. */
  agentsUsable?: number | null;
  agentsNeeded?: 1 | 2;
}

export interface GoalDraftValue {
  workspace: string;
  /** Empty means a workflow (Recommended, or the saved one named by `workflowId`). */
  provider: string;
  message: string;
  /** A saved user workflow chosen for this goal; absent means Recommended. */
  workflowId?: string;
  /** A saved result's own copy of its workflow. Editing or removing the workflow drops it, so Send uses what the picker shows. */
  workflowSnapshot?: WorkflowDefinition;
}

const WORKFLOW_ROW = "workflow:";
const COPY_ROW = "workflow:copy-recommended";

/** One plain line under a saved workflow's name. */
export function workflowSubtitle(workflow: WorkflowDefinition): string {
  const checks = workflow.modules.checks;
  return `Your copy of Recommended · plan review ${checks.planReview === "off" ? "off" : "on"}${checks.reviewerNeeds.readWorkspace === "required" ? " · reviewer reads files" : ""}`;
}

function capitalize(word: string): string {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

interface DraftRuntimePickerProps {
  linuxEntry?: boolean;
  runtimes: RuntimeProfile[];
  provider: string;
  connected: boolean;
  coordinationAvailable: boolean;
  runtimeRequiredHint?: string;
  /** Saved user workflows; undefined when this build cannot keep any, which hides their rows. */
  workflows?: readonly WorkflowDefinition[];
  workflowId?: string;
  /** Name to show if the chosen workflow came from a saved result and is no longer in the list. */
  workflowFallbackName?: string | null;
  disabled?: boolean;
  onSelect: (value: Pick<GoalDraftValue, "provider" | "workflowId">) => void;
  onCopyRecommended: () => void;
  onEditWorkflow: (id: string) => void;
}

/** Local draft Runtime choice — no Core command runs until the first Send. */
function DraftRuntimePicker({ runtimes, provider, connected, coordinationAvailable, runtimeRequiredHint, workflows, workflowId, workflowFallbackName, disabled = false, onSelect, onCopyRecommended, onEditWorkflow, linuxEntry = false }: DraftRuntimePickerProps) {
  const selected = runtimes.find((candidate) => candidate.id === provider);
  const savedWorkflow = !provider && workflowId ? workflows?.find((candidate) => candidate.id === workflowId) : undefined;
  const userWorkflowName = !provider && workflowId ? (savedWorkflow?.name ?? workflowFallbackName ?? "Your workflow") : null;
  const nativeAvailable = runtimes.some(item => item.id === "codex" && item.nativeSessionTransport === "app-server");
  const recommended = {
    id: "", name: "Recommended workflow", group: "Workflow",
    subtitle: "Plan first, then another agent checks the plan",
    ...(!linuxEntry && !coordinationAvailable ? { disabled: true, subtitle: runtimeRequiredHint ?? "Needs the desktop app with Background Send set up." } : {})
  };
  const usable = !recommended.disabled;
  // Saved workflows run on the coordinated path, so they are offered wherever Recommended can run.
  const mine: RuntimeChoice[] = workflows && !linuxEntry && usable ? [
    ...workflows.map((workflow) => ({ id: `${WORKFLOW_ROW}${workflow.id}`, name: workflow.name ?? "Your workflow", group: "Workflow", subtitle: workflowSubtitle(workflow) })),
    { id: COPY_ROW, name: "Copy Recommended…", group: "Workflow", subtitle: "Make your own version and switch off what you don't need.", avatar: "+" },
  ] : [];
  const choices: RuntimeChoice[] = linuxEntry ? [
    ...(nativeAvailable ? [{ id: "codex", name: "Codex conversation", group: "Direct", subtitle: "Use Codex on its own" }] : []),
    recommended
  ] : [
    ...runtimes.map(runtime => ({ id: runtime.id, name: runtime.name, group: "Direct", subtitle: runtime.support === "unsupported" ? "" : `Use ${runtime.name} on its own` })),
    recommended, ...mine
  ];
  const pick = (value: string) => {
    if (value === COPY_ROW) { onCopyRecommended(); return; }
    if (value.startsWith(WORKFLOW_ROW)) { onSelect({ provider: "", workflowId: value.slice(WORKFLOW_ROW.length) }); return; }
    onSelect({ provider: value, workflowId: undefined });
  };
  return (
    <div className="runtime-picker draft-runtime-picker">
      <RuntimePickerMenu
        runtimes={runtimes}
        choices={choices}
        selectedId={provider || (workflowId ? `${WORKFLOW_ROW}${workflowId}` : "")}
        triggerClassName="runtime-picker-button"
        triggerAriaLabel={linuxEntry ? "Choose goal mode" : "Select agent"}
        emptyText="Agents are still loading."
        blockedHint={!connected ? "Reconnect to select." : linuxEntry && !nativeAvailable ? "Codex conversations are unavailable: Core has not confirmed the app-server adapter." : null}
        isItemDisabled={(candidate) => candidate.support === "unsupported" || !connected}
        onSelect={pick}
        triggerContent={(
          <>
            <span className={`provider-avatar provider-${userWorkflowName ? "unassigned" : provider || "none"}`} aria-hidden="true">
              {userWorkflowName ? userWorkflowName[0] : selected ? selected.name[0] : coordinationAvailable || linuxEntry ? "R" : "–"}
            </span>
            <span className="runtime-picker-copy">
              <strong>{linuxEntry ? (provider === "codex" ? "Codex conversation" : "Recommended workflow") : userWorkflowName ?? (selected ? selected.name : coordinationAvailable ? "Recommended workflow" : "Choose how to work")}</strong>
              <small>{linuxEntry ? (provider === "codex" ? "Direct" : "Plan first, then another agent checks the plan") : userWorkflowName ? (savedWorkflow ? workflowSubtitle(savedWorkflow) : "Saved with this result") : selected ? "Direct" : coordinationAvailable
                ? "Plan first, then another agent checks the plan"
                : (runtimeRequiredHint ?? "Choose how to work before sending.")}</small>
            </span>
            <span aria-hidden="true">⌄</span>
          </>
        )}
      />
      {savedWorkflow && workflowId ? <button className="button button-small button-quiet" type="button" disabled={disabled} onClick={() => onEditWorkflow(workflowId)}>Edit</button> : null}
    </div>
  );
}

interface DraftGoalComposerProps {
  linuxEntry?: boolean;
  draft: GoalDraftValue;
  runtimes: RuntimeProfile[];
  connected: boolean;
  busy: boolean;
  blockedFromSending: boolean;
  /** When given, one plain reason sits beside a disabled Send and replaces the waiting line. */
  sendBlockers?: SendBlockers;
  /** Non-null holds Send (quiet progress, not an error): harness access for this draft is still resolving. */
  waitingOn: string | null;
  retryLabel?: string;
  error: { sentence: string; technical?: string } | null;
  canBrowse: boolean;
  coordinationAvailable: boolean;
  coordinationEntryAvailable?: boolean;
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
  /** One quiet line saying which method ran and which checks came back; null when unknown. */
  methodLine?: string | null;
  savedResultOutcome?: string | null;
  continueDisabledReason?: string | null;
  continueLabel?: string;
  liveAllowanceHint?: string | null;
  onLeaveGoal?: () => void;
  linuxCanStartCoordination?: boolean;
  linuxWrite?: boolean;
  piCapacity?: PiCapacitySelection;
  piCapacityChecked?: boolean;
  piCapacityReason?: string | null;
  piLegacy?: boolean;
  onPiCapacityChange?: (enabled: boolean) => void;
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
  /** Saved user workflows; omit where this build cannot keep any (their picker rows then do not exist). */
  workflows?: readonly WorkflowDefinition[];
  /** Name of the workflow a saved result ran under, for a draft made from it when that workflow is gone. */
  workflowFallbackName?: string | null;
  onSaveWorkflow?: (input: WorkflowSaveInput) => Promise<WorkflowEditResult>;
  onDeleteWorkflow?: (id: string) => Promise<WorkflowEditResult>;
}

/**
 * First-use surface (product-interaction-reset): a new goal is a local draft,
 * instantly editable — no name dialog, nothing durable until the first Send.
 * Workspace, Runtime and message can be filled in any order; typing is
 * possible before a Runtime is chosen.
 */
export function GoalStatusHeading({
  draft, busy, blockedFromSending, coordinationResult, failureHeadline = null, goalDetail, goalChange, goalEvidence, auditInputEvidenceCoverage, auditInputEvidenceText, activeGoalTitle, onContinueCoordination, inputsLocked = false, harnessWarning, discoverHint, consentWarning, leftoverHint, backgroundConsent = false, linuxCanStartCoordination = false, savedResultLabel, savedResultOutcome, methodLine
}: DraftGoalComposerProps) {
  const inFlightLine = coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." || coordinationResult === "Allowing Background Send.";
  const missingGoalLabel = coordinationResult === "That goal is no longer available." ? "That goal is no longer available. New goal can still start." : coordinationResult;
  const admissionUnsaidResult = Boolean(coordinationResult?.startsWith("The send returned without saying the goal was admitted.") || coordinationResult?.startsWith("Continue returned without saying the goal was admitted."));
  const stoppedResult = Boolean(coordinationResult?.toLowerCase().includes("no further turn was sent."));
  const signInFollow = harnessWarning?.startsWith("No signed-in") ? harnessWarning : "Sign in another agent before sending.";
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
          <p>{savedResultLabel ? savedResultOutcome : inFlightLine ? "Wait for this to finish." : coordinationResult === "Background Send is allowed." ? (harnessWarning ?? allowedFollow) : coordinationResult === "That goal is no longer available." ? "The draft is still here." : stoppedResult ? (activeGoalTitle ? coordinationResult : onContinueCoordination ? "Continue starts the next step." : "No further turn was sent.") : admissionUnsaidResult ? (coordinationResult?.includes("exit is not confirmed") ? "Another goal cannot start yet." : "The send is not confirmed. Your draft is kept; check current work before sending again.") : coordinationResult?.startsWith("That address is no longer available.") ? (activeGoalTitle || "The draft is still here.") : activeGoalTitle ? (failureHeadline || coordinationResult === leftoverHint ? activeGoalTitle : coordinationResult || "This goal stays on screen.") : (inputsLocked ? "This send has not returned." : harnessWarning && harnessWarning !== failureHeadline ? signInFollow : failureHeadline ? "The draft is still here." : consentWarning ? (linuxCanStartCoordination ? "Write your goal, then allow the agents below." : "Allow Background Send before sending.") : leftoverHint ? "You can still write the next goal." : coordinationResult?.includes("stays unreplayed") ? coordinationResult : "What would you like to work on?")}</p>
          {methodLine && (savedResultLabel || activeGoalTitle) ? <p className="method-line">{methodLine}</p> : null}
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
  linuxEntry = false, draft, runtimes, connected, busy, blockedFromSending, sendBlockers, waitingOn, retryLabel, error, canBrowse, coordinationAvailable, coordinationEntryAvailable = false, runtimeRequiredHint, coordinationResult, failureHeadline = null, goalDetail, goalChange, activeGoalTitle, onContinueCoordination, onStopCoordination, stopLabel = "Stop this goal", currentWorkTitle, currentWorkLine, continueDisabledReason, continueLabel, liveAllowanceHint, savedResultOutcome, onLeaveGoal, linuxCanStartCoordination = false, linuxWrite = false, piCapacity, piCapacityChecked = false, piCapacityReason, piLegacy = false, onPiCapacityChange, onLinuxWriteChange, inputsLocked = false, workspacePlaceholder, workspaceHint, harnessWarning, signedInHint, discoverHint, consentWarning, leftoverHint, onGrantConsent, keepRunningHint, backgroundConsent = false, onBackgroundConsentChange, optionsRestored = false, discoveredHarnesses = [], isLinuxActiveTarget = false, continueDisabled = false, onBrowse, onChange, onSubmit, onDiscard, workflows, workflowFallbackName, onSaveWorkflow, onDeleteWorkflow
}: DraftGoalComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // null: closed. id null: a new copy of Recommended. Otherwise the saved workflow being edited.
  const [editor, setEditor] = useState<{ id: string | null } | null>(null);
  // The picker menu hands focus back to its trigger as it closes; open the dialog after that settles.
  const openEditor = (id: string | null) => { window.setTimeout(() => setEditor({ id }), 0); };
  const allowanceExplained = useRef(false);
  const [showAllowanceExplanation, setShowAllowanceExplanation] = useState(false);
  // Linux offers the Pi choice with the rest of its entry; Windows passes only the choice itself.
  const piChoiceOffered = linuxCanStartCoordination || Boolean(onPiCapacityChange);
  useEffect(() => {
    const eligible = !isLinuxActiveTarget && piChoiceOffered && piCapacityChecked && backgroundConsent && !linuxWrite;
    // A dropped Pi choice is a new consent next time, so it is explained again.
    if (!piCapacityChecked) allowanceExplained.current = false;
    if (eligible && !allowanceExplained.current) { allowanceExplained.current = true; setShowAllowanceExplanation(true); }
    else if (!eligible) setShowAllowanceExplanation(false);
  }, [isLinuxActiveTarget, piChoiceOffered, piCapacityChecked, backgroundConsent, linuxWrite]);

  const inFlightLine = coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." || coordinationResult === "Allowing Background Send.";
  const addressGone = coordinationResult === "That goal is no longer available." || Boolean(coordinationResult?.startsWith("That address is no longer available."));
  const admissionUnsaidResult = Boolean(coordinationResult?.startsWith("The send returned without saying the goal was admitted.") || coordinationResult?.startsWith("Continue returned without saying the goal was admitted."));
  const stoppedResult = Boolean(coordinationResult?.toLowerCase().includes("no further turn was sent."));
  const [recentFolders] = useState(readRecentFolders);
  const otherFolders = recentFolders.filter((folder) => folder.toLowerCase() !== draft.workspace.trim().toLowerCase());
  const folderHint = !workspaceHint || inFlightLine || (addressGone && (blockedFromSending || consentWarning || harnessWarning || !activeGoalTitle)) ? null : leftoverHint ? (activeGoalTitle ? "The next goal stays in this folder." : `You can change the folder before the next goal. ${workspaceHint}`) : activeGoalTitle ? (stoppedResult ? "The new send stays in this folder." : admissionUnsaidResult ? (coordinationResult?.includes("exit is not confirmed") ? "Another goal cannot start in this folder yet." : "Your unconfirmed send stays in this folder.") : onContinueCoordination ? (addressGone ? "Continue is the goal on screen, not the missing address." : "Continue stays in this folder. New goal can use another.") : onStopCoordination ? "This goal stays in this folder." : failureHeadline && (blockedFromSending || consentWarning || harnessWarning) ? null : addressGone ? "A new send stays in this folder. It does not open the missing address." : "A new send stays in this folder. New goal can use another.") : workspaceHint;
  const signInFollow = harnessWarning?.startsWith("No signed-in") ? "Sign in a subscription agent before sending." : "Sign in another agent before sending.";
  const allowedFollow = harnessWarning || consentWarning || discoverHint || !backgroundConsent || blockedFromSending || busy
    ? "You can send when the other checks pass."
    : !draft.workspace.trim()
      ? "Choose a folder, then send."
      : !draft.message.trim()
        ? "Write the goal, then send."
        : "You can send.";

  const agentsShort = sendBlockers?.agentsUsable != null && sendBlockers.agentsUsable < (sendBlockers.agentsNeeded ?? 2);
  const canSubmit = isLinuxActiveTarget
    ? (!busy && !inputsLocked && !continueDisabled && draft.message.trim().length > 0 && Boolean(onContinueCoordination))
    : (!busy
       && (!inputsLocked || (linuxEntry && draft.provider === "codex" && retryLabel === "Check result"))
       && !waitingOn
       && (!blockedFromSending || Boolean(retryLabel))
       && connected
       && draft.workspace.trim().length > 0
       && draft.message.trim().length > 0
       && !agentsShort
       && (coordinationAvailable || linuxCanStartCoordination || draft.provider.trim().length > 0));

  // A retry bypasses the held and grant checks (see canSubmit), so it bypasses their reasons too.
  const retrying = Boolean(retryLabel);
  const sendDisabled = !canSubmit || coordinationResult === "Sending.";
  let disabledReason = sendBlockers && sendDisabled ? sendDisabledReason({
    inFlight: busy || inFlightLine,
    connected,
    holdSentence: retrying ? null : sendBlockers.holdSentence,
    waitingOn,
    grantMissing: !retrying && sendBlockers.grantMissing,
    grantControlVisible: sendBlockers.grantControlVisible,
    wayToWorkMissing: !coordinationAvailable && !linuxCanStartCoordination && draft.provider.trim().length === 0,
    workspaceMissing: draft.workspace.trim().length === 0,
    messageMissing: draft.message.trim().length === 0,
    otherBlocked: inputsLocked || (blockedFromSending && !retrying),
    agentsUsable: sendBlockers.agentsUsable,
    agentsNeeded: sendBlockers.agentsNeeded,
  }) : null;
  // The picker trigger and the error alert already say these; say each once.
  const pickerSaysChoose = !linuxEntry && !runtimes.some((candidate) => candidate.id === draft.provider)
    && !(coordinationAvailable || coordinationEntryAvailable) && !runtimeRequiredHint;
  // A retry stays sendable, but the folder or slot hold is still worth saying in advance.
  const retryHold = retrying && sendBlockers?.holdSentence && sendBlockers.holdSentence !== error?.sentence ? sendBlockers.holdSentence : null;
  if (disabledReason === error?.sentence || (disabledReason === CHOOSE_WAY_SENTENCE && pickerSaysChoose)) disabledReason = null;

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
      : discoveredHarnesses && discoveredHarnesses.length === 2
        ? `Allow ${discoveredHarnesses.map(capitalize).join(" and ")} to work`
        : discoveredHarnesses && discoveredHarnesses.length === 1
          ? `Allow ${capitalize(discoveredHarnesses[0])} to work`
          : "Allow background work";

  const continueButtonLabel = coordinationResult === "Continuing." ? "Continuing…" : continueLabel || "Continue";

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
        <textarea
          ref={textareaRef}
          id="draft-message"
          aria-label="Message composer"
          value={draft.message}
          onChange={(event) => { setShowAllowanceExplanation(false); onChange({ ...draft, message: event.target.value }); }}
          onCompositionStart={input.onCompositionStart}
          onCompositionEnd={input.onCompositionEnd}
          onKeyDown={input.onKeyDown}
          placeholder={connected
            ? (inFlightLine ? "Wait for this to finish." : isLinuxActiveTarget ? "Add a follow-up (optional)" : linuxCanStartCoordination && !admissionUnsaidResult && !addressGone ? "What would you like to accomplish?" : coordinationResult === "Allowing Background Send." ? "Wait for this to finish." : coordinationResult === "Background Send is allowed." ? (harnessWarning ?? allowedFollow) : coordinationResult === "Sending." || coordinationResult === "Stopping this goal." || coordinationResult === "Recording the stop." || coordinationResult === "Continuing." || coordinationResult === "Leaving this unreplayed." ? "Wait for this to finish." : coordinationResult === "That goal is no longer available." ? "You can write the next goal." : admissionUnsaidResult ? (coordinationResult?.includes("exit is not confirmed") ? "Another goal cannot start yet." : "The send is not confirmed. Your draft is kept; check current work before sending again.") : stoppedResult ? (onContinueCoordination ? "This stop is not resumed. Continue as a new send." : "A new send can still start.") : coordinationResult?.startsWith("That address is no longer available.") ? (activeGoalTitle && !blockedFromSending && !consentWarning && !harnessWarning ? "A new send can still start." : "The draft is still here.") : onStopCoordination ? (coordinationResult === "The worker is gone. Its exit is not confirmed, so another goal cannot start yet." ? "The worker is gone. Its exit is not confirmed." : coordinationResult?.startsWith("This goal's exit is not confirmed") ? coordinationResult : /unconfirmed/i.test(coordinationResult || "") ? "Stop is not confirmed." : "This goal is still running.") : harnessWarning && harnessWarning !== failureHeadline ? signInFollow : leftoverHint ? "You can still write the next goal." : failureHeadline ? (activeGoalTitle && !blockedFromSending && !consentWarning ? "A new send can still start. This goal is not continued." : "The draft is still here.") : consentWarning ? "Allow Background Send before sending." : coordinationResult?.includes("stays unreplayed") ? "A new send can still start." : activeGoalTitle ? (onContinueCoordination ? "Add a follow-up, then Continue. The next Send starts a new goal." : "The next Send starts a new goal.") : "Ask GoalPort…")
            : "Reconnect before sending…"}
          rows={isLinuxActiveTarget ? 2 : 3}
          disabled={busy || inputsLocked}
        />
        {!isLinuxActiveTarget ? <label className="field-label" htmlFor="draft-workspace">Project folder</label> : null}
        <div className={`field-with-icon draft-workspace-row${isLinuxActiveTarget ? " compact-workspace-row" : ""}`} title={draft.workspace}>
          <span aria-hidden="true">⌂</span>
          <input
            id="draft-workspace"
            aria-label="Project folder"
            aria-describedby={folderHint ? "draft-folder-hint" : undefined}
            value={draft.workspace}
            onChange={(event) => onChange({ ...draft, workspace: event.target.value })}
            placeholder={workspacePlaceholder ?? "Project folder"}
            disabled={busy || inputsLocked || Boolean(activeGoalTitle)}
            readOnly={isLinuxActiveTarget}
            title={draft.workspace}
            className={isLinuxActiveTarget ? "compact-workspace-input" : undefined}
          />
          {canBrowse && !isLinuxActiveTarget ? (
            <button className="button button-small button-outline" type="button" onClick={onBrowse} disabled={busy || inputsLocked || Boolean(activeGoalTitle)}>Browse…</button>
          ) : null}
        </div>
        {!isLinuxActiveTarget && !activeGoalTitle && otherFolders.length > 0 ? (
          <div className="recent-folders" role="group" aria-label="Recent folders">
            {otherFolders.map((folder) => (
              <button key={folder} className="button button-small button-quiet" type="button" title={folder} disabled={busy || inputsLocked} onClick={() => onChange({ ...draft, workspace: folder })}>{folderName(folder)}</button>
            ))}
          </div>
        ) : null}
        {folderHint && !isLinuxActiveTarget ? <p id="draft-folder-hint" className="draft-hint">{folderHint}</p> : null}
        {harnessWarning && harnessWarning !== failureHeadline && (activeGoalTitle || !harnessWarning.startsWith("No signed-in")) ? <p className="draft-hint">{harnessWarning}</p> : null}
        {discoverHint ? <p className="draft-hint">{discoverHint}</p> : null}
        {signedInHint && !harnessWarning ? <p className="draft-hint">{signedInHint}</p> : null}

        {linuxCanStartCoordination && !draft.provider.trim() && !linuxEntry ? null : (
          <DraftRuntimePicker
            linuxEntry={linuxEntry}
            runtimes={runtimes}
            provider={draft.provider}
            connected={connected}
            coordinationAvailable={coordinationAvailable || coordinationEntryAvailable}
            runtimeRequiredHint={runtimeRequiredHint}
            workflows={onSaveWorkflow ? workflows : undefined}
            workflowId={draft.workflowId}
            workflowFallbackName={workflowFallbackName}
            disabled={busy || inputsLocked}
            onSelect={(value) => onChange({ ...draft, ...value })}
            onCopyRecommended={() => openEditor(null)}
            onEditWorkflow={openEditor}
          />
        )}
        {coordinationResult && !activeGoalTitle && !inputsLocked && coordinationResult !== failureHeadline && !coordinationResult.includes("stays unreplayed") ? <p className="draft-hint">{coordinationResult}</p> : null}


        {piChoiceOffered && (piCapacity || piCapacityReason || piLegacy) ? <div className="draft-hint" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <span>{piCapacityChecked
            ? (discoveredHarnesses.includes("codex") ? `Selected roles: Codex plans${linuxWrite ? " / writes" : ""} · Pi independently checks` : "Codex is needed to plan with this Pi capacity.")
            : piLegacy ? "Legacy agent selection" : "Available choice: Codex + Pi"}</span>
          {piCapacity ? <PiCapacityControl capacity={piCapacity} checked={piCapacityChecked === true} disabled={Boolean(busy || inputsLocked || piCapacityReason)} onChange={onPiCapacityChange} /> : piLegacy ? <div>Pi route not recorded · Continue is unpinned</div> : null}
          {piCapacityReason ? <div role="status">{piCapacityReason}</div> : null}
        </div> : null}
        {waitingOn && !sendBlockers ? <p className="composer-wait" role="status">{waitingOn}</p> : null}
        {showAllowanceExplanation ? <p className="draft-hint">After a checked read-only result, this allowance can stay open for one follow-up, for up to 15 minutes.</p> : null}
        {liveAllowanceHint ? <p className="draft-hint" role="status">{liveAllowanceHint}</p> : null}
        {isLinuxActiveTarget && continueDisabledReason && continueDisabledReason !== currentWorkLine && continueDisabledReason !== savedResultOutcome && continueDisabledReason !== liveAllowanceHint ? <p className="draft-hint" role="status">{continueDisabledReason}</p> : null}

        {retryHold ? <p className="send-disabled-reason" role="alert">{retryHold}</p> : null}
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
                <span className="draft-hint-note"> {discoveredHarnesses.length > 0 ? "Uses your existing agent access. Nothing runs until you send a goal." : "Available agents work only after you send a goal."}</span>
              </>
            ) : null}
          </p>
        ) : null}
        {onLinuxWriteChange && (isLinuxActiveTarget || discoveredHarnesses.includes("codex")) ? <label className="draft-hint"><input type="checkbox" checked={linuxWrite} disabled={busy || inputsLocked || Boolean(onStopCoordination)} onChange={(event) => onLinuxWriteChange(event.target.checked)} /> Allow Codex to change files in this workspace</label> : null}
        {onBackgroundConsentChange && (linuxEntry || !runtimes.some((candidate) => candidate.id === draft.provider)) ? (
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
          {disabledReason ? <p className="send-disabled-reason" role="status" id="send-disabled-reason">{disabledReason}</p> : null}
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
                draft.message.trim() || draft.workspace.trim() || inputsLocked ? <button className="button button-quiet" type="button" aria-label="Discard draft" onClick={onDiscard} disabled={busy || inputsLocked}>Discard draft</button> : null
              )}
              <button className="button button-primary" type="submit" aria-describedby={disabledReason ? "send-disabled-reason" : undefined} aria-label={coordinationResult === "Sending." ? "Sending." : admissionUnsaidResult ? "Send not confirmed" : addressGone ? "Send a new goal" : retryLabel ?? "Send message"} disabled={sendDisabled}>
                {coordinationResult === "Sending." ? "Sending." : busy ? "Starting…" : admissionUnsaidResult ? "Not confirmed" : addressGone ? "Send a new goal" : (retryLabel ?? "Send")}
                <span aria-hidden="true">↗</span>
              </button>
            </>
          )}
        </div>
      </form>
      {editor && onSaveWorkflow ? (
        <WorkflowEditorDialog
          workflow={editor.id ? workflows?.find((candidate) => candidate.id === editor.id) ?? null : null}
          otherNames={(workflows ?? []).filter((candidate) => candidate.id !== editor.id).map((candidate) => candidate.name ?? "")}
          onSave={async (input) => {
            const result = await onSaveWorkflow(input);
            if (result.ok) {
              setEditor(null);
              // The user made or changed it to use it: it is the workflow for this goal now.
              if (result.saved) onChange({ ...draft, provider: "", workflowId: result.saved.id, workflowSnapshot: undefined });
            }
            return result;
          }}
          onDelete={onDeleteWorkflow ? async (id) => {
            const result = await onDeleteWorkflow(id);
            if (result.ok) {
              setEditor(null);
              if (draft.workflowId === id) onChange({ ...draft, workflowId: undefined, workflowSnapshot: undefined });
            }
            return result;
          } : undefined}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </section>
  );
}
