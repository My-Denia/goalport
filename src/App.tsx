import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCoreClient, persistedAttemptId, reusableAttemptId, type AppInfo, type CoreCommand } from "./ipc";
import {
  DEMO_SNAPSHOT,
  EMPTY_SNAPSHOT,
  resolvePermission,
  withConnection,
  type CoreSnapshot,
  type StopResponsibilitySummary
} from "./types";
import { TitleBar } from "./shell/TitleBar";
import { CampaignNav } from "./nav/CampaignNav";
import { ProductConversationView } from "./conversation/ProductConversationView";
import { Composer } from "./conversation/Composer";
import { DraftGoalComposer, type GoalDraftValue } from "./conversation/DraftGoalComposer";
import { PendingApprovals } from "./panels/PendingApprovals";
import { StatusBanners, type ActiveNotice } from "./panels/StatusBanners";
import { BlockedWorkPanel } from "./panels/BlockedWorkPanel";
import { SessionDetails } from "./panels/SessionDetails";
import { DiagnosticsDrawer } from "./panels/DiagnosticsDrawer";
import { CloseChoiceDialog } from "./dialog/CloseChoiceDialog";
import { HandoffDialog } from "./dialog/HandoffDialog";
import { BootstrapScreen } from "./dialog/BootstrapScreen";
import type { BootstrapState } from "./ipc";
import { conversationTitle, headlineState } from "./lib/display";
import { useModalFocus } from "./lib/useModalFocus";
import { useScrollAnchor, visibleConversationSignature } from "./lib/useScrollAnchor";
import "./styles.css";

function noticeAfterRuntimeSelect(next: CoreSnapshot, current: ActiveNotice | null): ActiveNotice | null {
  return commandFailure(next, "select_runtime") ?? (next.connection === "disconnected" ? current : null);
}

// User-facing nouns for internal Core message types. The Core model keeps its
// own names (Campaign, Attempt, …); the normal UI never shows them.
const MESSAGE_TYPE_LABEL: Record<string, string> = {
  create_campaign: "create the goal",
  select_campaign: "select the goal",
  select_project: "select the project",
  start_conversation: "start the conversation",
  conversation_send: "send the message",
  rename_conversation: "rename the goal"
};

function commandFailure(next: CoreSnapshot, messageType: string): ActiveNotice | null {
  const outcome = next.commandOutcome;
  if (outcome?.messageType === messageType) {
    if (outcome.kind === "accepted") return null;
    return {
      sentence: outcome.kind === "refused"
        ? "GoalPort could not complete that action."
        : "GoalPort could not reach Core for that action.",
      technical: outcome.error ?? (outcome.kind === "refused" ? "request not accepted" : "transport unavailable")
    };
  }
  const notices = next.notices ?? [];
  const explicit = notices.find((notice) =>
    notice.startsWith("Core refused:")
    || notice.startsWith("Core request failed:")
    || notice.startsWith("Core unavailable")
  );
  if (explicit) return { sentence: "GoalPort could not complete that action.", technical: explicit };
  return {
    sentence: `GoalPort did not confirm it could ${MESSAGE_TYPE_LABEL[messageType] ?? messageType.replace(/_/g, " ")}.`
  };
}

function commandTargetKey(campaignId: string, taskId: string, attemptId: string): string {
  return `${campaignId}\u001f${taskId}\u001f${attemptId}`;
}

function snapshotTargetKey(snapshot: CoreSnapshot): string {
  return commandTargetKey(snapshot.activeCampaignId, snapshot.activeTask.id, snapshot.attempt.id);
}

function freshRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `goalport-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** A new-goal draft: local only, one stable request id for the first Send. */
interface GoalDraft extends GoalDraftValue {
  requestId: string;
  baselineCampaignId: string;
}

function App() {
  const client = useMemo(() => getCoreClient(), []);
  const [snapshot, setSnapshot] = useState<CoreSnapshot>(() => client.mode === "browser-preview" ? DEMO_SNAPSHOT : EMPTY_SNAPSHOT);
  const [campaignDrafts, setCampaignDrafts] = useState<Record<string, string>>({});
  const [draftGoal, setDraftGoal] = useState<GoalDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<ActiveNotice | null>(null);
  const [draftBlocked, setDraftBlocked] = useState(false);
  const [draftDismissed, setDraftDismissed] = useState(false);
  const [activeNotice, setActiveNotice] = useState<ActiveNotice | null>(null);
  const [targetNotices, setTargetNotices] = useState<Record<string, ActiveNotice>>({});
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [closeChoiceOpen, setCloseChoiceOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [chooserFocusSignal, setChooserFocusSignal] = useState(0);
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  // Bootstrap gating of Core polling: while the main-process profile bootstrap
  // is still deciding (checking / importing / backing-up / coordination /
  // error), polling goalport:core-snapshot would only hit the profileReady
  // gate ("Core start is gated") every cycle. Snapshot polling and the
  // auto-start therefore begin on the positive "bootstrap done" signal only —
  // nothing is swallowed. Hosts without a bootstrap channel (browser preview,
  // tauri, older preload/test mounts) have no profile bootstrap and are ready
  // immediately.
  const [coreReady, setCoreReady] = useState(
    () => client.mode !== "electron" || !window.goalportCore?.onBootstrapState
  );
  // Browser preview starts from a complete snapshot; only the desktop app has a
  // real Core cold start that can take seconds to answer the first snapshot.
  const [booted, setBooted] = useState(() => client.mode === "browser-preview");
  const selectionIntent = useRef(0);
  const sendInFlight = useRef(false);
  const draftInFlight = useRef(false);

  useEffect(() => {
    const api = window.goalportCore;
    if (!api?.onBootstrapState) return undefined;
    let active = true;
    let eventReceived = false;
    void api.bootstrapCurrent?.().then((state) => {
      if (!active || eventReceived) return;
      setBootstrap(state?.phase === "done" ? null : state);
      setCoreReady(state?.phase === "done");
    });
    const unsubscribe = api.onBootstrapState((state) => {
      eventReceived = true;
      setBootstrap(state?.phase === "done" ? null : state);
      setCoreReady(state?.phase === "done");
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  const activeCampaign = snapshot.campaigns.find((campaign) => campaign.id === snapshot.activeCampaignId);
  const draftCampaignId = activeCampaign?.id ?? "";
  const draft = draftCampaignId ? campaignDrafts[draftCampaignId] ?? "" : "";
  const product = snapshot.productConversation;
  const hasGoal = Boolean(draftCampaignId);
  const draftActive = draftGoal !== null || (!hasGoal && !draftDismissed);

  // Scroll follow/unseen is driven by visible content identity, not item
  // count: streaming grows one item's body at constant length, and identical
  // polls must stay silent. See useScrollAnchor for the reset semantics.
  const anchor = useScrollAnchor(snapshot.activeCampaignId, visibleConversationSignature(product?.items));

  function updateVisibleCampaignDraft(value: string) {
    // Selection is authoritative only after Core returns its projection. While a
    // selection is pending, the visible composer remains bound to the campaign
    // still on screen, so keystrokes cannot silently move to the requested one.
    if (!draftCampaignId) return;
    setCampaignDrafts((current) => ({ ...current, [draftCampaignId]: value }));
  }

  useEffect(() => {
    // Bootstrap not done yet: no snapshot poll, no Core auto-start. The effect
    // re-runs with coreReady=true the moment the bootstrap reaches done.
    if (!coreReady) return undefined;
    let mounted = true;
    let autoStartAttempted = false;
    const refresh = async (allowStart: boolean) => {
      const next = await client.snapshot();
      if (!mounted) return;
      setSnapshot(next);
      setBooted(true);
      if (allowStart && !autoStartAttempted && next.connection !== "connected" && client.mode !== "browser-preview") {
        autoStartAttempted = true;
        const started = await client.startCore();
        if (mounted) setSnapshot(started);
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => {
      if (!mounted) return;
      void refresh(false);
    }, 750);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [client, coreReady]);

  // First-use recovery: if Core created (or moved to) a conversation while a
  // draft was open — including after a failed start whose delivery was
  // uncertain — the snapshot is the authority. The draft closes and nothing is
  // ever submitted again from it.
  useEffect(() => {
    if (!draftGoal) return;
    if (snapshot.activeCampaignId && snapshot.activeCampaignId !== draftGoal.baselineCampaignId) {
      setDraftGoal(null);
      setDraftError(null);
      setDraftBlocked(false);
    }
  }, [snapshot.activeCampaignId, draftGoal]);

  // Ctrl+I toggles the Session details drawer — a keyboard path that does not
  // depend on hitting a small title-bar target inside the window drag region.
  // Never fires while a text field has focus or a modal dialog is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "i")) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (closeChoiceOpen || handoffOpen || aboutOpen) return;
      event.preventDefault();
      setDetailsOpen((value) => !value);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeChoiceOpen, handoffOpen, aboutOpen]);

  useEffect(() => {
    let mounted = true;
    if (client.appInfo) {
      void client.appInfo().then((info) => {
        if (mounted) setAppInfo(info);
      }).catch(() => undefined);
    }
    return () => { mounted = false; };
  }, [client]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const bindIsolatedDispatch = (): boolean => {
      if (window.__GOALPORT_ISOLATED !== 1) return false;
      if (typeof client.dispatch !== "function") return false;
      window.__goalportDispatch = (request: CoreCommand) => client.dispatch!(request);
      window.__goalportAppSnapshot = () => client.snapshot();
      return true;
    };
    if (bindIsolatedDispatch()) {
      return () => {
        delete window.__goalportDispatch;
        delete window.__goalportAppSnapshot;
      };
    }
    const interval = window.setInterval(() => {
      if (bindIsolatedDispatch()) window.clearInterval(interval);
    }, 50);
    const timeout = window.setTimeout(() => window.clearInterval(interval), 8000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      if (window.__GOALPORT_ISOLATED === 1) {
        delete window.__goalportDispatch;
        delete window.__goalportAppSnapshot;
      }
    };
  }, [client]);

  useEffect(() => {
    const api = window.goalportCore;
    if (!api?.onClosePrompt) return;
    const stopPrompt = api.onClosePrompt(() => setCloseChoiceOpen(true));
    const stopFailed = api.onCloseChoiceFailed?.(() => {
      setCloseChoiceOpen(true);
      setActiveNotice({ sentence: "Continue in background was not recorded. The window stays open." });
    });
    return () => {
      stopPrompt();
      stopFailed?.();
    };
  }, []);

  function attemptIsActive(state: string | undefined): boolean {
    return state === "active" || state === "ACTIVE";
  }

  function handleCloseWindow() {
    if (attemptIsActive(snapshot.attempt.state) || snapshot.stopResponsibility?.writeResponsibility === "held") {
      setCloseChoiceOpen(true);
      return;
    }
    if (window.goalportCore?.requestClose) {
      void window.goalportCore.requestClose();
      return;
    }
  }

  function handleCloseChoice(choice: "continue" | "stop") {
    if (!window.goalportCore?.confirmCloseChoice) {
      setCloseChoiceOpen(false);
      return;
    }
    void confirmCloseChoiceWithReceipt(choice);
  }

  async function confirmCloseChoiceWithReceipt(choice: "continue" | "stop") {
    const requestId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `close-${Date.now()}`;
    const continueClickIssuedAtUtc = new Date().toISOString();
    window.__goalportCloseRequestId = requestId;
    try {
      const result = await window.goalportCore?.confirmCloseChoice?.({
        requestId,
        choice,
        continueClickIssuedAtUtc
      }) as {
        ok?: boolean;
        receiptId?: string;
        coreAcknowledged?: boolean;
        allowQuitLatch?: boolean;
        choice?: string;
      } | undefined;
      const accepted = result?.ok === true
        && result.coreAcknowledged === true
        && result.allowQuitLatch === true
        && Boolean(result.receiptId)
        && result.choice === choice;
      if (!accepted) {
        setCloseChoiceOpen(true);
        setActiveNotice(choice === "continue"
          ? { sentence: "Continue in background was not recorded. The window stays open." }
          : { sentence: "Stop was not durably acknowledged by Core. The window stays open." });
        return;
      }
      setCloseChoiceOpen(false);
    } catch {
      setCloseChoiceOpen(true);
      setActiveNotice(choice === "continue"
        ? { sentence: "Continue in background failed. The window stays open." }
        : { sentence: "Stop failed before durable Core acknowledgement. The window stays open." });
    }
  }

  function handleDismissCloseChoice() {
    setCloseChoiceOpen(false);
    if (window.goalportCore?.dismissCloseChoice) void window.goalportCore.dismissCloseChoice();
  }

  const activeTargetKey = snapshotTargetKey(snapshot);
  const displayedNotice = activeNotice ?? targetNotices[activeTargetKey] ?? null;

  // -----------------------------------------------------------------------
  // First send: ONE start_conversation dispatch with a caller-stable request
  // id. No createCampaign+sendMessage dual path. No auto replay on rejection
  // or transport error; the draft is preserved and, if Core actually created
  // the goal, recovered from the snapshot (see the effect above).
  // -----------------------------------------------------------------------
  async function handleDraftSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftGoal || draftBusy || draftBlocked || draftInFlight.current) return;
    const workspace = draftGoal.workspace.trim();
    const provider = draftGoal.provider;
    const message = draftGoal.message.trim();
    if (!workspace || !provider || !message) return;
    if (!client.startConversation) {
      setDraftError({ sentence: "This build of GoalPort cannot start a new conversation. Update GoalPort and try again." });
      return;
    }
    if (snapshot.stopResponsibility?.writeResponsibility === "held"
      && snapshot.stopResponsibility.blocksCurrentWorkspace !== false) {
      setDraftError({ sentence: "A held Stop governs a workspace in this view, so no new goal can start here." });
      return;
    }
    draftInFlight.current = true;
    setDraftBusy(true);
    try {
      const next = await client.startConversation(workspace, provider, message, draftGoal.requestId);
      setSnapshot(next);
      const failure = client.mode === "browser-preview" ? null : commandFailure(next, "start_conversation");
      if (failure) {
        // Definitive refusal: a later explicit attempt may mint a new request
        // id. Transport error: delivery is uncertain, so the same id stays and
        // resubmission is blocked (Core deduplicates by this id).
        setDraftError(failure);
        if (next.commandOutcome?.kind === "transport-error") {
          setDraftBlocked(true);
        } else {
          setDraftGoal((current) => current ? { ...current, requestId: freshRequestId() } : current);
        }
        return;
      }
      setDraftGoal(null);
      setDraftError(null);
      setDraftBlocked(false);
      setDraftDismissed(false);
    } finally {
      draftInFlight.current = false;
      setDraftBusy(false);
    }
  }

  function handleNewGoal() {
    setDraftDismissed(false);
    setDraftError(null);
    setDraftBlocked(false);
    setDraftGoal({
      requestId: freshRequestId(),
      baselineCampaignId: snapshot.activeCampaignId,
      workspace: snapshot.project.workspaceRoot || "",
      provider: "",
      message: ""
    });
  }

  function handleDiscardDraft() {
    setDraftGoal(null);
    setDraftError(null);
    setDraftBlocked(false);
    setDraftDismissed(true);
  }

  // -----------------------------------------------------------------------
  // Explicit Send on an existing conversation: conversation_send, gated by
  // product.turn.canSend. Success is quiet; failure keeps the draft.
  // -----------------------------------------------------------------------
  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (snapshot.stopResponsibility?.writeResponsibility === "held") {
      setActiveNotice({ sentence: "Core refused new work while residual execution is unknown and write responsibility is held." });
      return;
    }
    const turn = product?.turn;
    if (!turn?.canSend) {
      setActiveNotice({ sentence: turn?.reason || "Sending is not available for this conversation right now." });
      return;
    }
    if (sendInFlight.current) return;
    const submittedDraft = draft;
    const message = submittedDraft.trim();
    if (!message) return;
    const target = {
      campaignId: snapshot.activeCampaignId,
      taskId: snapshot.activeTask.id,
      attemptId: persistedAttemptId(snapshot.attempt.id) ?? snapshot.attempt.id,
      selection: selectionIntent.current
    };
    const targetKey = commandTargetKey(target.campaignId, target.taskId, target.attemptId);
    sendInFlight.current = true;
    setSendBusy(true);
    try {
      const next = client.conversationSend
        ? await client.conversationSend(message, target.campaignId, target.attemptId)
        : await client.sendMessage(message, target.campaignId, target.attemptId, target.taskId);
      if (target.selection === selectionIntent.current) setSnapshot(next);
      const messageType = client.conversationSend ? "conversation_send" : "send_message";
      const failure = client.mode === "browser-preview" ? null : commandFailure(next, messageType);
      if (failure) {
        setTargetNotices((current) => ({ ...current, [targetKey]: failure }));
        if (target.selection === selectionIntent.current) setActiveNotice(failure);
        return;
      }
      // Quiet success: only the accepted campaign's draft clears.
      setCampaignDrafts((current) => current[target.campaignId] === submittedDraft
        ? { ...current, [target.campaignId]: "" }
        : current);
    } finally {
      sendInFlight.current = false;
      setSendBusy(false);
    }
  }

  async function handlePermissionDecision(decisionId: string, allow: boolean) {
    if (allow && snapshot.stopResponsibility?.writeResponsibility === "held") {
      setActiveNotice({ sentence: "Permission Allow is blocked while Core holds Stop responsibility. Decline remains available." });
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = client.mode === "browser-preview" ? resolvePermission(snapshot, allow) : await client.resolveDecision(decisionId, allow);
    if (viewIntent === selectionIntent.current) setSnapshot(next);
    if (client.mode !== "browser-preview") {
      const failure = commandFailure(next, "resolve_decision");
      if (failure) {
        setActiveNotice(failure);
        return;
      }
    }
    setActiveNotice(allow
      ? { sentence: "Permission allowed once. Session-wide approval remains disabled." }
      : { sentence: "Permission denied. No write action was sent and automatic retry is disabled." });
    if (client.notify) {
      void client.notify(allow ? "GoalPort decision" : "GoalPort decision", allow ? "Permission allowed once." : "Permission denied.");
    }
  }

  async function handleRevoke(scope: string) {
    if (!client.revokeAuthorization || !snapshot.activeCampaignId) {
      setActiveNotice({ sentence: "Revocation is unavailable until a goal is selected." });
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = await client.revokeAuthorization(snapshot.activeCampaignId, scope);
    if (viewIntent === selectionIntent.current) setSnapshot(next);
    const failure = commandFailure(next, "revoke_authorization");
    if (failure) {
      setActiveNotice(failure);
      return;
    }
    setActiveNotice({ sentence: `Current ${scope} authorization revoked. The next related action will re-check current auth.` });
    if (client.notify) void client.notify("GoalPort decision", `Authorization revoked: ${scope}`);
  }

  async function handleOwnerAction(action: string) {
    if (!client.requestOwnerAction) {
      setActiveNotice({ sentence: "Owner-only requests require a connected Core." });
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = await client.requestOwnerAction(action, true, true);
    if (viewIntent === selectionIntent.current) setSnapshot(next);
    const failure = commandFailure(next, "request_owner_action");
    setActiveNotice(failure ?? { sentence: `Owner-only ${action} was blocked. Plan/audit flags do not grant authority.` });
  }

  // A re-check reads current reality and appends one observation. It cannot release
  // anything, so it needs no confirmation -- but it can fail, and a failed re-check
  // must say so rather than leaving the previous verdict on screen looking current.
  async function handleRecheck(attemptId: string) {
    if (!client.recheckStopResponsibility) {
      setActiveNotice({ sentence: "This build cannot re-check a hold." });
      return;
    }
    setRecoveryBusy(true);
    const viewIntent = selectionIntent.current;
    try {
      const next = await client.recheckStopResponsibility(attemptId);
      if (viewIntent === selectionIntent.current) setSnapshot(next);
      const failure = commandFailure(next, "recheck_stop_responsibility");
      if (failure) setActiveNotice(failure);
    } catch (error) {
      setActiveNotice({ sentence: "Re-check failed.", technical: error instanceof Error ? error.message : String(error) });
    } finally {
      setRecoveryBusy(false);
    }
  }

  // Continuing does not release the held workspace and never claims to. Core
  // refuses an overlapping target, a stale observation, or a replay; those
  // refusals are surfaced with their exact reason in Technical details rather
  // than reworded, because Core's wording names the specific cause.
  async function handleContinue(attemptId: string) {
    if (!client.continueInIsolatedWorkspace) {
      setActiveNotice({ sentence: "This build cannot continue in a new workspace." });
      return;
    }
    const hold = snapshot.stopResponsibility?.attemptId === attemptId
      ? snapshot.stopResponsibility
      : snapshot.relatedHolds.find((candidate) => candidate.attemptId === attemptId);
    const source = hold?.workspaceKey ?? "";
    if (!source) {
      setActiveNotice({ sentence: "Core did not report which workspace this hold covers, so no continuation target can be proposed." });
      return;
    }
    // A sibling, never a child: a child of the held workspace overlaps it and Core
    // would refuse. Proposing one anyway would train the user to expect a refusal.
    const suggestion = `${source.replace(/[\/]+$/, "")}-continued-${Date.now().toString(36)}`;
    setRecoveryBusy(true);
    const viewIntent = selectionIntent.current;
    try {
      const next = await client.continueInIsolatedWorkspace(attemptId, suggestion);
      if (viewIntent === selectionIntent.current) setSnapshot(next);
      const failure = commandFailure(next, "continue_in_isolated_workspace");
      if (failure) {
        setActiveNotice(failure);
        return;
      }
      setActiveNotice({ sentence: `Continued in ${suggestion}. The original workspace stays held.` });
    } catch (error) {
      setActiveNotice({ sentence: "Continuation refused.", technical: error instanceof Error ? error.message : String(error) });
    } finally {
      setRecoveryBusy(false);
    }
  }

  function openHandoffDialog() {
    if (snapshot.stopResponsibility?.writeResponsibility === "held") {
      setActiveNotice({ sentence: "Handoff is blocked while residual execution remains unknown and Core holds write responsibility." });
      return;
    }
    if (!client.handoff || !snapshot.attempt.id) {
      setActiveNotice({ sentence: "Core handoff is unavailable until a connected Runtime Attempt is selected." });
      return;
    }
    setHandoffOpen(true);
  }

  // Handoff target is chosen by the user in the dialog — never the first
  // other runtime. The choice is visible before the command is sent.
  async function handleHandoffConfirm(provider: string) {
    setHandoffOpen(false);
    if (!client.handoff || !snapshot.attempt.id) {
      setActiveNotice({ sentence: "Core handoff is unavailable until a connected Runtime Attempt is selected." });
      return;
    }
    const runtime = snapshot.runtimes.find((candidate) => candidate.id === provider);
    if (!runtime || runtime.support === "unsupported") {
      setActiveNotice({ sentence: "That Runtime has no verified capability path for handoff." });
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = await client.handoff(
      provider,
      snapshot.attempt.id,
      "Continue from the Core generated handoff packet and report the next safe step."
    );
    if (viewIntent === selectionIntent.current) setSnapshot(next);
    const failure = commandFailure(next, "handoff");
    if (failure) {
      setActiveNotice(failure);
      return;
    }
    // Quiet success: the handoff summary appears in the conversation.
  }

  async function handleOffline() {
    const next = client.mode === "browser-preview" ? withConnection(snapshot, "disconnected") : await client.setConnection("disconnected");
    setSnapshot(next);
    setActiveNotice({ sentence: "UI is offline. Core keeps committed task state; uncommitted input remains in this window." });
  }

  // Stop appears only for a proven cancellable live turn (product turn
  // canStop); never for an idle session.
  async function handleStop() {
    const attemptId = persistedAttemptId(snapshot.attempt.id);
    if (!client.interrupt || !attemptId || !product?.turn.canStop) {
      setActiveNotice({ sentence: "There is no Runtime turn that can be stopped right now." });
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = await client.interrupt(attemptId);
    if (viewIntent === selectionIntent.current) setSnapshot(next);
    const failure = commandFailure(next, "interrupt");
    if (failure) setActiveNotice(failure);
  }

  async function handleReconnect() {
    const next = client.mode === "browser-preview" ? withConnection(snapshot, "connected") : await client.startCore();
    setSnapshot(next);
    const failure = client.mode === "browser-preview" || next.connection === "connected"
      ? null
      : { sentence: "Core connection remains unavailable. Nothing was re-sent.", technical: next.commandOutcome?.error };
    if (failure) setActiveNotice(failure);
  }

  function handleKeepWaiting() {
    setActiveNotice({ sentence: "Decision remains pending. No action was sent and the Runtime will stay waiting." });
  }

  async function handleRenameCampaign(campaignId: string, title: string) {
    if (!client.renameConversation) {
      setActiveNotice({ sentence: "This build of GoalPort cannot rename goals." });
      return;
    }
    const next = await client.renameConversation(campaignId, title);
    setSnapshot(next);
    const failure = commandFailure(next, "rename_conversation");
    if (failure) setActiveNotice(failure);
    // Quiet success: the sidebar shows the new title.
  }

  async function selectCampaign(campaignId: string) {
    const selected = snapshot.campaigns.find((campaign) => campaign.id === campaignId);
    if (!selected || selected.id === snapshot.activeCampaignId) return;
    // Explicit navigation closes a pending draft; it is not a submission.
    if (draftGoal) {
      setDraftGoal(null);
      setDraftError(null);
      setDraftBlocked(false);
      setDraftDismissed(true);
    }
    if (client.selectCampaign) {
      const intent = ++selectionIntent.current;
      const next = await client.selectCampaign(campaignId);
      if (intent !== selectionIntent.current) return;
      setSnapshot(next);
      const failure = commandFailure(next, "select_campaign");
      setActiveNotice(failure);
      return;
    }
    setSnapshot({
      ...snapshot,
      activeCampaignId: selected.id,
      activeTask: { ...snapshot.activeTask, title: selected.activeTaskTitle },
      notices: [`Viewing ${selected.title}.`, ...snapshot.notices]
    });
  }

  async function selectProject(projectId: string) {
    if (!client.selectProject || projectId === snapshot.selectedProjectId) return;
    const intent = ++selectionIntent.current;
    const next = await client.selectProject(projectId);
    if (intent !== selectionIntent.current) return;
    setSnapshot(next);
    const failure = commandFailure(next, "select_project");
    setActiveNotice(failure);
  }

  async function selectRuntime(provider: string) {
    if (!client.selectRuntime || !snapshot.activeCampaignId || !snapshot.activeTask.id) {
      setActiveNotice({ sentence: "Select or start a goal before choosing a Runtime." });
      return;
    }
    const intent = ++selectionIntent.current;
    const campaignId = snapshot.activeCampaignId;
    const taskId = snapshot.activeTask.id;
    const attemptId = reusableAttemptId(snapshot.attempt);
    const next = attemptId
      ? await client.selectRuntime(provider, campaignId, taskId, attemptId)
      : await client.selectRuntime(provider, campaignId, taskId);
    if (intent !== selectionIntent.current) return;
    setSnapshot(next);
    setActiveNotice((current) => noticeAfterRuntimeSelect(next, current));
    if (typeof window !== "undefined" && window.__GOALPORT_ISOLATED === 1) {
      window.__goalportLastSelectResult = next;
      window.__goalportLastSnapshot = next;
    }
  }

  async function chooseWorkspace() {
    if (client.mode !== "electron" || !client.chooseWorkspace) return;
    try {
      const selected = await client.chooseWorkspace();
      if (selected) {
        setDraftGoal((current) => current ? { ...current, workspace: selected } : current);
        setDraftError(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDraftError({ sentence: "Workspace selection failed.", technical: message });
    }
  }

  const heldPanel = snapshot.stopResponsibility;
  const relatedHolds: StopResponsibilitySummary[] = snapshot.relatedHolds ?? [];
  const heldNow = heldPanel?.writeResponsibility === "held";
  const taskState = headlineState(product, snapshot);
  const title = conversationTitle(snapshot);

  if (bootstrap && bootstrap.phase !== "done" && bootstrap.phase !== "checking") {
    return <BootstrapScreen state={bootstrap} />;
  }
  if (!booted) {
    return (
      <div className="boot-shell" role="status" aria-label="Starting GoalPort">
        <span className="boot-mark" aria-hidden="true">◎</span>
        <p>Starting GoalPort…</p>
        <small>The local Core is restoring its record. This can take a moment.</small>
      </div>
    );
  }

  return (
    <div className="goalport-shell" data-connection={snapshot.connection} data-preview={snapshot.preview}
      data-attempt-id={snapshot.attempt.id} data-campaign-id={snapshot.activeCampaignId} data-core-build-id={snapshot.buildId}>
      <TitleBar
        snapshot={snapshot}
        campaignTitle={hasGoal ? title : null}
        appInfo={appInfo}
        navCollapsed={navCollapsed}
        onToggleNav={() => setNavCollapsed((value) => !value)}
        detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen((value) => !value)}
        onOpenDiagnostics={() => setDiagnosticsOpen(true)}
        onNewGoal={handleNewGoal}
        onOpenAbout={() => setAboutOpen(true)}
        onReconnect={handleReconnect}
        onCloseWindow={handleCloseWindow}
      />

      <div className={`workspace-grid${navCollapsed ? " nav-collapsed" : ""}`}>
        <CampaignNav
          snapshot={snapshot}
          collapsed={navCollapsed}
          onSelectCampaign={(campaignId) => { void selectCampaign(campaignId); }}
          onSelectProject={(projectId) => { void selectProject(projectId); }}
          onRenameCampaign={(campaignId, renameTitle) => { void handleRenameCampaign(campaignId, renameTitle); }}
        />

        <main className="conversation-column" aria-label="Goal conversation">
          <StatusBanners
            snapshot={snapshot}
            activeNotice={displayedNotice}
            onDismissNotice={() => {
              setActiveNotice(null);
              setTargetNotices((current) => {
                const next = { ...current };
                delete next[activeTargetKey];
                return next;
              });
            }}
            onReconnect={handleReconnect}
          />

          {draftActive ? (
            <div className="timeline-scroll" tabIndex={-1} aria-label="New goal draft">
              <DraftGoalComposer
                draft={draftGoal ?? { workspace: snapshot.project.workspaceRoot || "", provider: "", message: "" }}
                runtimes={snapshot.runtimes}
                connected={snapshot.connection === "connected"}
                busy={draftBusy}
                blockedFromSending={draftBlocked}
                error={draftError}
                canBrowse={client.mode === "electron" && Boolean(client.chooseWorkspace)}
                onBrowse={() => { void chooseWorkspace(); }}
                onChange={(value) => setDraftGoal((current) =>
                  current ? { ...current, ...value } : { ...value, requestId: freshRequestId(), baselineCampaignId: snapshot.activeCampaignId })}
                onSubmit={handleDraftSend}
                onDiscard={handleDiscardDraft}
              />
            </div>
          ) : !hasGoal ? null : product === null ? (
            <div className="compatibility-notice" role="status">
              <h2>Conversation view unavailable</h2>
              <p>
                This GoalPort Core build does not provide the conversation view. Update GoalPort to
                the current version to chat here. Your recorded work is not lost.
              </p>
              <p className="rail-caption">Raw events remain available in Developer diagnostics, in the application menu.</p>
            </div>
          ) : (
            <>
              <div className="conversation-heading">
                <div className="conversation-heading-main">
                  <h2>{title || snapshot.activeTask.title}</h2>
                  <p>{activeCampaign?.goal ?? ""}</p>
                </div>
                <span className={`task-state task-state-${taskState.tone}`}>{taskState.label}</span>
              </div>

              <PendingApprovals
                snapshot={snapshot}
                onPermissionDecision={(decisionId, allow) => { void handlePermissionDecision(decisionId, allow); }}
                onKeepWaiting={handleKeepWaiting}
              />

              <div className="timeline-scroll" ref={anchor.ref} onScroll={anchor.handleScroll} tabIndex={-1} aria-label="Conversation timeline">
                <ProductConversationView product={product} />
                {anchor.unseenCount > 0 ? (
                  <button className="jump-latest" type="button" onClick={() => anchor.scrollToBottom()}>
                    {anchor.unseenCount} new {anchor.unseenCount === 1 ? "message" : "messages"} ↓
                  </button>
                ) : null}
              </div>

              {heldPanel ? (
                <BlockedWorkPanel
                  hold={heldPanel}
                  onRecheck={(attemptId) => { void handleRecheck(attemptId); }}
                  onContinue={(attemptId) => { void handleContinue(attemptId); }}
                  busy={recoveryBusy}
                />
              ) : null}
              {relatedHolds.map((hold) => (
                <BlockedWorkPanel
                  key={hold.attemptId}
                  hold={hold}
                  onRecheck={(attemptId) => { void handleRecheck(attemptId); }}
                  onContinue={(attemptId) => { void handleContinue(attemptId); }}
                  busy={recoveryBusy}
                />
              ))}

              <Composer
                draft={draft}
                snapshot={snapshot}
                runtime={product.runtime}
                turn={product.turn}
                busy={sendBusy}
                chooserFocusSignal={chooserFocusSignal}
                onChange={updateVisibleCampaignDraft}
                onSubmit={handleSend}
                onSelectRuntime={(provider) => { void selectRuntime(provider); }}
                onStop={() => { void handleStop(); }}
              />
            </>
          )}

          <SessionDetails
            open={detailsOpen}
            onClose={() => setDetailsOpen(false)}
            snapshot={snapshot}
            product={product}
            onChangeRuntime={() => {
              setDetailsOpen(false);
              setChooserFocusSignal((value) => value + 1);
            }}
            onOpenHandoff={openHandoffDialog}
            onOpenWorkspaceFolder={() => {
              void client.openInVsCode(snapshot.project.workspaceRoot).catch(() => {
                setActiveNotice({ sentence: "The workspace folder could not be opened." });
              });
            }}
          />
        </main>
      </div>

      <DiagnosticsDrawer
        open={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
        snapshot={snapshot}
        appInfo={appInfo}
        onRevoke={(scope) => { void handleRevoke(scope); }}
        onOwnerAction={(action) => { void handleOwnerAction(action); }}
        onOffline={() => { void handleOffline(); }}
      />

      {closeChoiceOpen ? (
        <CloseChoiceDialog
          provider={snapshot.attempt.provider}
          active={attemptIsActive(snapshot.attempt.state)}
          stopResponsibility={snapshot.stopResponsibility}
          onContinue={() => { void handleCloseChoice("continue"); }}
          onStop={() => { void handleCloseChoice("stop"); }}
          onKeepOpen={handleDismissCloseChoice}
        />
      ) : null}

      {handoffOpen ? (
        <HandoffDialog
          snapshot={snapshot}
          onCancel={() => setHandoffOpen(false)}
          onConfirm={(provider) => { void handleHandoffConfirm(provider); }}
        />
      ) : null}

      {aboutOpen ? (
        <AboutDialog appInfo={appInfo} onClose={() => setAboutOpen(false)} />
      ) : null}
    </div>
  );
}

function AboutDialog({ appInfo, onClose }: { appInfo: AppInfo | null; onClose: () => void }) {
  const dialogRef = useModalFocus(onClose);
  const development = appInfo?.testMode === true || appInfo?.distribution === "dev";
  const rows: Array<[string, string]> = [
    ["Version", appInfo?.version ? appInfo.version : "unknown"],
    ["Build", development ? "Development build" : (appInfo?.channel || "Release")]
  ];
  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="first-run-dialog about-dialog" role="dialog" aria-modal="true" aria-label="About GoalPort">
        <button className="dialog-close" type="button" aria-label="Close about" onClick={onClose}>×</button>
        <p className="eyebrow">ABOUT</p>
        <h2>GoalPort</h2>
        <dl className="about-rows">
          {rows.map(([key, value]) => (
            <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
          ))}
        </dl>
        {development ? (
          <p className="about-note">Development build: fault injection is available in Developer diagnostics.</p>
        ) : null}
        <div className="dialog-actions">
          <button className="button button-quiet" type="button" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}

export default App;
