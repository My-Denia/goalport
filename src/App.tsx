import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getCoreClient,
  mergeHistoryPageIntoSnapshot,
  mergeSnapshotHistory,
  persistedAttemptId,
  reusableAttemptId,
  type AppInfo,
  type CoreCommand
} from "./ipc";
import {
  HISTORY_WINDOW_ADVANCED_NOTICE,
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
import { CoordinationStatus, type CoordinationQuotaWord } from "./conversation/CoordinationStatus";
import { requestCoordination } from "./coordination/requestCoordination";
import type { CoordinateTurnCommand } from "./coordination/coordinateTurn";
import { PendingApprovals } from "./panels/PendingApprovals";
import { BackgroundAttention } from "./panels/BackgroundAttention";
import { TurnResults } from "./panels/TurnResults";
import { StatusBanners, type ActiveNotice } from "./panels/StatusBanners";
import { BlockedWorkPanel } from "./panels/BlockedWorkPanel";
import { SessionDetails } from "./panels/SessionDetails";
import { DiagnosticsDrawer } from "./panels/DiagnosticsDrawer";
import { CloseChoiceDialog } from "./dialog/CloseChoiceDialog";
import { HandoffDialog } from "./dialog/HandoffDialog";
import { BootstrapScreen } from "./dialog/BootstrapScreen";
import type { BootstrapState } from "./ipc";
import { conversationTitle, headlineState } from "./lib/display";
import { GoalDialog } from "./ui/GoalDialog";
import { useScrollAnchor, visibleConversationSignature } from "./lib/useScrollAnchor";
import { useCoreSnapshot } from "./lib/useCoreSnapshot";
import { campaignIdFromLocation, pushGoalRoute, replaceGoalRoute } from "./lib/goalRoute";
import { useConversationDrafts } from "./lib/useConversationDrafts";
import {
  canExplicitlyRetry,
  conversationSendIntent,
  retryLabel,
  settleSendIntent,
  startConversationIntent,
  type SendIntent
} from "./lib/sendIntent";
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
  intent?: SendIntent;
}

function App() {
  const client = useMemo(() => getCoreClient(), []);
  const [coreReady, setCoreReady] = useState(
    () => client.mode !== "electron" || !window.goalportCore?.onBootstrapState
  );
  const [snapshot, setSnapshot, booted] = useCoreSnapshot(client, coreReady);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const { drafts: campaignDrafts, setDrafts: setCampaignDrafts, intents: sendIntents, setIntents: setSendIntents, update: updateCampaignDraft } = useConversationDrafts();
  const [draftGoal, setDraftGoal] = useState<GoalDraft | null>(null);
  const [coordination, setCoordination] = useState<{
    planningHarness: string | null;
    reviewHarness: string | null;
    result: string | null;
    stopReason: string;
    planningQuota: CoordinationQuotaWord | null;
    reviewQuota: CoordinationQuotaWord | null;
  } | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<ActiveNotice | null>(null);
  const [draftBlocked, setDraftBlocked] = useState(false);
  const [draftDismissed, setDraftDismissed] = useState(false);
  const [activeNotice, setActiveNotice] = useState<ActiveNotice | null>(null);
  const [targetNotices, setTargetNotices] = useState<Record<string, ActiveNotice>>({});
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  // A first send with no Runtime chosen only proceeds when this window can assign a harness.
  const coordinationAvailable = client.mode === "electron"
    && appInfo?.coordinationConfigured === true
    && Boolean(window.goalportCore?.coordinateDiscover && window.goalportCore?.coordinateLaunch);
  const [closeChoiceOpen, setCloseChoiceOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => typeof window !== "undefined" && window.innerWidth <= 860);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [closingSession, setClosingSession] = useState(false);
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
  const selectionIntent = useRef(0);
  const resumeWatch = useRef<{ attemptId: string; sentence: string } | null>(null);
  useEffect(() => {
    const watch = resumeWatch.current;
    if (!watch || snapshot.attempt.id !== watch.attemptId) return;
    const turn = snapshot.productConversation?.turn;
    const session = snapshot.productConversation?.session;
    if (turn?.reasonCode === "resume-pending-verification") return;
    if (turn?.reasonCode === "resume-verification-failed" || turn?.reasonCode === "resume-spawn-failed") {
      resumeWatch.current = null;
      setActiveNotice({
        sentence: turn.reason || "The last resume failed to start or did not verify the stored session id. Resume to try again; earlier messages will not be sent again."
      });
      return;
    }
    const verified = session?.nativeIdKnown === true
      || turn?.state === "running"
      || turn?.state === "completed"
      || turn?.state === "waiting-permission"
      || turn?.state === "stopped";
    if (!verified) return;
    resumeWatch.current = null;
    setActiveNotice((current) => current?.sentence === watch.sentence ? null : current);
  }, [snapshot]);
  useLayoutEffect(() => {
    const routedGoal = campaignIdFromLocation();
    if (routedGoal) client.pinView?.(routedGoal);
  }, [client]);
  const sendInFlight = useRef(false);
  const draftInFlight = useRef(false);
  const draftEpoch = useRef(0);
  const coordinationRequest = useRef(0);
  const draftGoalRef = useRef(draftGoal);
  draftGoalRef.current = draftGoal;
  const historyRequest = useRef(0);

  useEffect(() => {
    const onResize = () => { if (window.innerWidth <= 860) setNavCollapsed(true); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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

  const projectionUnavailable = snapshot.bounds?.projectionUnavailable === true;
  const activeCampaign = snapshot.campaigns.find((campaign) => campaign.id === snapshot.activeCampaignId);
  // The visible goal follows the authoritative active id, not only a campaign
  // row. Right after send, and on a capacity acknowledgement, that id is
  // already set while the row may still be missing. Dropping it blanks the
  // conversation. An empty id is still a fresh profile, so the draft composer
  // is not remounted over a goal that Core has already opened.
  const draftCampaignId = activeCampaign?.id ?? snapshot.activeCampaignId.trim();
  const draft = draftCampaignId ? campaignDrafts[draftCampaignId] ?? "" : "";
  const product = snapshot.productConversation;
  const hasGoal = Boolean(draftCampaignId);
  // The draft surface stays mounted across capacity-limited polls: unmounting
  // it on a poll flip would re-run the composer's mount-focus effect and
  // steal focus (and any in-flight typing) from the user. But a capacity
  // view alone never proves a fresh profile (goals may exist beyond the
  // capacity cut — review-debt contract), so the empty-profile draft only
  // opens once a full projection has actually confirmed emptiness; sending
  // stays blocked while the projection is unavailable. Only real transitions
  // close the draft: explicit navigation, Discard, or Core creating/moving
  // to a conversation (the snapshot-authority effect above).
  const [confirmedEmptyProfile, setConfirmedEmptyProfile] = useState(false);
  useLayoutEffect(() => {
    // Only a full projection that actually arrived counts as evidence —
    // never the pre-connect placeholder, never a capacity acknowledgement.
    // Emptiness is the AUTHORITATIVE active id being empty, not the campaigns
    // list lookup: right after a draft's first send the active id is already
    // set while the list may not contain the new campaign yet, and latching
    // on that transient would re-mount the draft composer over the fresh
    // conversation for a frame (caught by the packaged Windows smoke).
    if (!booted || projectionUnavailable) return;
    setConfirmedEmptyProfile(snapshot.activeCampaignId.trim() === "");
  }, [booted, projectionUnavailable, snapshot.activeCampaignId]);
  const draftActive = draftGoal !== null
    || (confirmedEmptyProfile && !hasGoal && !draftDismissed);
  const activeSendIntent = sendIntents[draftCampaignId];
  const activeRetryLabel = retryLabel(activeSendIntent);
  const draftRetryLabel = retryLabel(draftGoal?.intent);

  function capacityBlocksNewWork(action: string): boolean {
    if (!snapshot.bounds?.projectionUnavailable) return false;
    setActiveNotice({ sentence: `Core returned a capacity-limited control view, so GoalPort cannot ${action} until a full control snapshot is available.` });
    return true;
  }

  // Scroll follow/unseen is driven by visible content identity, not item
  // count: streaming grows one item's body at constant length, and identical
  // polls must stay silent. See useScrollAnchor for the reset semantics.
  const anchor = useScrollAnchor(snapshot.activeCampaignId, visibleConversationSignature(product?.items));

  function updateVisibleCampaignDraft(value: string) {
    // Selection is authoritative only after Core returns its projection. While a
    // selection is pending, the visible composer remains bound to the campaign
    // still on screen, so keystrokes cannot silently move to the requested one.
    updateCampaignDraft(draftCampaignId, value);
  }

  // First-use recovery: if Core created (or moved to) a conversation while a
  // draft was open — including after a failed start whose delivery was
  // uncertain — the snapshot is the authority. The draft closes and nothing is
  // ever submitted again from it.
  useEffect(() => {
    if (!draftGoal) return;
    if (!draftGoal.intent && snapshot.activeCampaignId && snapshot.activeCampaignId !== draftGoal.baselineCampaignId) {
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
    if (snapshot.bounds?.projectionUnavailable) {
      setActiveNotice({ sentence: "Core returned a capacity-limited control view, so GoalPort cannot target this Runtime for a close action. Keep the window open and reconnect first." });
      setCloseChoiceOpen(true);
      return;
    }
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
    if (import.meta.env.DEV && window.__GOALPORT_ISOLATED === 1) window.__goalportCloseRequestId = requestId;
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
    if (!draftGoal || draftBusy || draftInFlight.current) return;
    const retrying = canExplicitlyRetry(draftGoal.intent);
    if (draftBlocked && !retrying) return;
    const workspace = draftGoal.intent?.workspaceRoot ?? draftGoal.workspace.trim();
    const provider = draftGoal.intent?.provider ?? draftGoal.provider;
    const message = draftGoal.intent?.message ?? draftGoal.message.trim();
    if (!workspace || !message) return;
    if (!retrying && snapshot.bounds?.projectionUnavailable) {
      setDraftError({ sentence: "Core confirmed the previous state but could not project enough control data to start new work. Retry a pending request or reconnect first." });
      return;
    }
    if (!retrying && snapshot.stopResponsibility?.writeResponsibility === "held"
      && snapshot.stopResponsibility.blocksCurrentWorkspace !== false) {
      setDraftError({ sentence: "A held Stop governs a workspace in this view, so no new goal can start here." });
      return;
    }
    if (!provider) {
      const bridge = window.goalportCore;
      const discover = bridge?.coordinateDiscover;
      const launch = bridge?.coordinateLaunch;
      if (!coordinationAvailable || !discover || !launch) {
        setDraftError({ sentence: "Choose a Runtime before sending." });
        return;
      }
      setDraftError(null);
      const request = ++coordinationRequest.current;
      const generation = String(request);
      const stillCurrent = () => coordinationRequest.current === request;
      setDraftBusy(true);
      try {
        const discovery = await discover(generation);
        if (!stillCurrent()) return;
        const report = await requestCoordination(
          { workspacePath: workspace, goal: message },
          discovery,
          {
            launch: async (command: CoordinateTurnCommand) => {
              if (!stillCurrent()) {
                return { text: "", errorText: "The coordination request was replaced, so nothing was sent." };
              }
              return launch(command, generation);
            },
          },
          stillCurrent,
        );
        if (coordinationRequest.current !== request) return;
        setCoordination(report);
      } catch (error) {
        if (coordinationRequest.current !== request) return;
        setCoordination({
          planningHarness: null,
          reviewHarness: null,
          result: null,
          stopReason: error instanceof Error ? error.message : "The coordination service is not available.",
          planningQuota: null,
          reviewQuota: null,
        });
      } finally {
        if (coordinationRequest.current === request) setDraftBusy(false);
      }
      return;
    }
    if (!client.startConversation) {
      setDraftError({ sentence: "This build of GoalPort cannot start a new conversation. Update GoalPort and try again." });
      return;
    }
    setCoordination(null);
    const epoch = draftEpoch.current;
    draftInFlight.current = true;
    setDraftBusy(true);
    const intent = draftGoal.intent
      ? { ...draftGoal.intent, state: "sending" as const }
      : startConversationIntent(draftGoal.requestId, workspace, provider, message);
    setDraftGoal((current) => current ? { ...current, intent } : current);
    try {
      const next = await client.startConversation(workspace, provider, message, intent.requestId);
      setSnapshot(next);
      // New goal, discard, and a draft edit replace this send. Their draft
      // stays; this result must not wipe it or paste the old error onto it.
      if (epoch !== draftEpoch.current) return;
      const failure = client.mode === "browser-preview" ? null : commandFailure(next, "start_conversation");
      if (failure) {
        setDraftError(failure);
        const retained = settleSendIntent(intent, next.commandOutcome);
        setDraftBlocked(false);
        setDraftGoal((current) => current ? {
          ...current,
          ...(retained ? { requestId: retained.requestId, intent: retained } : { requestId: freshRequestId(), intent: undefined }),
          baselineCampaignId: next.commandOutcome?.rejection?.reservation?.campaignId ?? current.baselineCampaignId
        } : current);
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

  function abandonCoordination() {
    draftEpoch.current += 1;
    const previous = coordinationRequest.current;
    coordinationRequest.current += 1;
    if (previous > 0) void window.goalportCore?.coordinateCancel?.(String(previous));
    setCoordination(null);
    // A selected Runtime send owns the busy flag until it settles. Clearing it
    // here re-enables Send while that send is still in flight, and the click
    // is then dropped.
    if (!draftInFlight.current) setDraftBusy(false);
  }

  function handleNewGoal() {
    if (window.innerWidth <= 860) setNavCollapsed(true);
    setDraftDismissed(false);
    setDraftError(null);
    setDraftBlocked(false);
    abandonCoordination();
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
    abandonCoordination();
  }

  // -----------------------------------------------------------------------
  // Explicit Send on an existing conversation: conversation_send, gated by
  // product.turn.canSend. Success is quiet; failure keeps the draft.
  // -----------------------------------------------------------------------
  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const retainedIntent = sendIntents[draftCampaignId];
    const retrying = canExplicitlyRetry(retainedIntent);
    if (!retrying && snapshot.bounds?.projectionUnavailable) {
      setActiveNotice({ sentence: "Core acknowledged the last action with a capacity-limited view. Reconnect before starting new work." });
      return;
    }
    if (!retrying && snapshot.stopResponsibility?.writeResponsibility === "held") {
      setActiveNotice({ sentence: "Core refused new work while residual execution is unknown and write responsibility is held." });
      return;
    }
    const turn = product?.turn;
    if (!retrying && !turn?.canSend) {
      setActiveNotice({ sentence: turn?.reason || "Sending is not available for this conversation right now." });
      return;
    }
    if (sendInFlight.current) return;
    const submittedDraft = draft;
    const message = retainedIntent?.message ?? submittedDraft.trim();
    if (!message) return;
    const target = {
      campaignId: retainedIntent?.campaignId ?? snapshot.activeCampaignId,
      taskId: snapshot.activeTask.id,
      attemptId: retainedIntent?.attemptId ?? persistedAttemptId(snapshot.attempt.id) ?? snapshot.attempt.id,
      selection: selectionIntent.current
    };
    const targetKey = commandTargetKey(target.campaignId, target.taskId, target.attemptId);
    sendInFlight.current = true;
    setSendBusy(true);
    const intent = retainedIntent
      ? { ...retainedIntent, state: "sending" as const }
      : conversationSendIntent(freshRequestId(), target.campaignId, target.attemptId, message);
    setSendIntents((current) => ({ ...current, [target.campaignId]: intent }));
    try {
      const next = client.conversationSend
        ? await client.conversationSend(message, target.campaignId, target.attemptId, intent.requestId)
        : await client.sendMessage(message, target.campaignId, target.attemptId, target.taskId);
      if (target.selection === selectionIntent.current) {
        setSnapshot((current) => current.loadedHistory ? mergeSnapshotHistory(current, next) : next);
      }
      const messageType = client.conversationSend ? "conversation_send" : "send_message";
      const failure = client.mode === "browser-preview" ? null : commandFailure(next, messageType);
      if (failure) {
        const retained = settleSendIntent(intent, next.commandOutcome);
        setSendIntents((current) => {
          const updated = { ...current };
          if (retained) updated[target.campaignId] = retained;
          else delete updated[target.campaignId];
          return updated;
        });
        const reservationAttempt = next.commandOutcome?.rejection?.reservation?.attemptId;
        const noticeKey = reservationAttempt
          ? commandTargetKey(target.campaignId, target.taskId, reservationAttempt)
          : targetKey;
        setTargetNotices((current) => ({ ...current, [noticeKey]: failure }));
        if (target.selection === selectionIntent.current) setActiveNotice(failure);
        return;
      }
      setSendIntents((current) => {
        const updated = { ...current };
        delete updated[target.campaignId];
        return updated;
      });
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
    if (allow && snapshot.bounds?.projectionUnavailable) {
      setActiveNotice({ sentence: "Permission Allow requires the full request facts, which are unavailable in this capacity-limited view. Decline remains available." });
      return;
    }
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
    if (capacityBlocksNewWork(`request owner-only ${action}`)) return;
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
    if (capacityBlocksNewWork("create isolated follow-up work")) return;
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
    if (capacityBlocksNewWork("start a handoff")) return;
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
    if (capacityBlocksNewWork("change the Runtime transport state")) return;
    const next = client.mode === "browser-preview" ? withConnection(snapshot, "disconnected") : await client.setConnection("disconnected");
    setSnapshot(next);
    setActiveNotice({ sentence: client.mode === "browser-preview"
      ? "Browser preview is offline. Your local draft stays in this page."
      : "UI is offline. Core keeps committed task state; uncommitted input remains in this window." });
  }

  // Stop appears only for a proven cancellable live turn (product turn
  // canStop); never for an idle session.
  async function handleStop() {
    if (capacityBlocksNewWork("target this Runtime with Stop")) return;
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

  async function handleCloseSession() {
    const attemptId = persistedAttemptId(snapshot.attempt.id);
    if (!client.closeSession || snapshot.connection !== "connected" || snapshot.stopResponsibility?.writeResponsibility === "held"
      || !attemptId || !product?.turn.actions?.includes("close-session")) {
      setActiveNotice({ sentence: "This Runtime session cannot be closed right now." });
      return;
    }
    const viewIntent = selectionIntent.current;
    setClosingSession(true);
    try {
      const next = await client.closeSession(attemptId);
      if (viewIntent === selectionIntent.current) setSnapshot(next);
      const failure = commandFailure(next, "close_session");
      if (failure) setActiveNotice(failure);
      else setActiveNotice({ sentence: "Runtime session closed. This goal remains available." });
    } finally {
      setClosingSession(false);
    }
  }

  async function handleResumeSession() {
    const attemptId = persistedAttemptId(snapshot.attempt.id);
    if (!client.resumeSession || snapshot.connection !== "connected" || snapshot.stopResponsibility?.writeResponsibility === "held"
      || !attemptId || !product?.turn.actions?.includes("resume-session")) {
      setActiveNotice({ sentence: "This session cannot be resumed right now. Check its status in details." });
      return;
    }
    const viewIntent = selectionIntent.current;
    const next = await client.resumeSession(attemptId);
    if (viewIntent !== selectionIntent.current) return;
    setSnapshot(next);
    const failure = commandFailure(next, "resume_native_session");
    const turn = next.productConversation?.turn;
    // A retry can reuse the same attempt. The pending reason, not a new id,
    // is what means verification has not finished.
    const pendingVerification = turn?.reasonCode === "resume-pending-verification";
    if (failure) {
      resumeWatch.current = null;
      setActiveNotice(failure);
    } else if (pendingVerification) {
      const sentence = turn?.reason || "Session is starting again. Send a message to continue. Earlier messages will not be sent again.";
      resumeWatch.current = { attemptId: next.attempt.id, sentence };
      setActiveNotice({ sentence });
    } else if (next.attempt.id === attemptId && next.productConversation?.session?.state === "attached") {
      resumeWatch.current = null;
      setActiveNotice({ sentence: "Runtime session resumed. You can continue this goal." });
    } else {
      resumeWatch.current = null;
      setActiveNotice({ sentence: turn?.reason || "Session resume was not confirmed. Check its status in details." });
    }
  }

  async function handleReconnect() {
    const next = client.mode === "browser-preview" ? withConnection(snapshot, "connected") : await client.startCore();
    setSnapshot(next);
    const failure = client.mode === "browser-preview" || next.connection === "connected"
      ? null
      : { sentence: "Core connection remains unavailable. Nothing was re-sent.", technical: next.commandOutcome?.error };
    if (failure) setActiveNotice(failure);
    else setActiveNotice(null);
  }

  function handleKeepWaiting() {
    setActiveNotice({ sentence: "Decision remains pending. No action was sent and the Runtime will stay waiting." });
  }

  async function handleRenameCampaign(campaignId: string, title: string) {
    if (capacityBlocksNewWork("rename this goal")) return;
    if (!client.renameConversation) {
      setActiveNotice({ sentence: "This build of GoalPort cannot rename goals." });
      return;
    }
    const next = await client.renameConversation(campaignId, title);
    setSnapshot(next);
    const failure = client.mode === "browser-preview" ? null : commandFailure(next, "rename_conversation");
    if (failure) setActiveNotice(failure);
    // Quiet success: the sidebar shows the new title.
  }

  async function selectCampaign(campaignId: string) {
    const known = snapshot.campaigns.some((campaign) => campaign.id === campaignId)
      || snapshot.goalOverview?.goals.some((goal) => goal.campaignId === campaignId);
    if (!known || campaignId === snapshot.activeCampaignId) return;
    if (client.mode === "linux-core") pushGoalRoute(campaignId);
    if (window.innerWidth <= 860) setNavCollapsed(true);
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
      const failure = client.mode === "browser-preview" || client.mode === "linux-core"
        ? (client.mode === "linux-core" && next.connection === "disconnected"
          ? { sentence: "That goal could not be opened.", technical: next.notices[0] }
          : null)
        : commandFailure(next, "select_campaign");
      setActiveNotice(failure);
      return;
    }
    const selected = snapshot.campaigns.find((campaign) => campaign.id === campaignId);
    if (!selected) return;
    setSnapshot({
      ...snapshot,
      activeCampaignId: selected.id,
      activeTask: { ...snapshot.activeTask, title: selected.activeTaskTitle },
      notices: [`Viewing ${selected.title}.`, ...snapshot.notices]
    });
  }

  useEffect(() => {
    if (client.mode !== "linux-core" || !booted) return undefined;
    const miss = client.takeRouteMiss?.() ?? "";
    if (miss) {
      setActiveNotice({ sentence: "That goal is no longer available." });
      replaceGoalRoute(snapshot.activeCampaignId || null);
    } else if (snapshot.activeCampaignId) {
      replaceGoalRoute(snapshot.activeCampaignId);
    }
    const onPop = () => {
      const id = campaignIdFromLocation();
      if (!id || id === snapshotRef.current.activeCampaignId) return;
      void selectCampaign(id);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [booted, client, snapshot.activeCampaignId]);

  async function selectProject(projectId: string) {
    if (!client.selectProject || projectId === snapshot.selectedProjectId) return;
    if (window.innerWidth <= 860) setNavCollapsed(true);
    const intent = ++selectionIntent.current;
    const next = await client.selectProject(projectId);
    if (intent !== selectionIntent.current) return;
    setSnapshot(next);
    const failure = client.mode === "browser-preview" ? null : commandFailure(next, "select_project");
    setActiveNotice(failure);
  }

  async function selectRuntime(provider: string) {
    if (capacityBlocksNewWork("select a new Runtime")) return;
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
    setActiveNotice((current) => client.mode === "browser-preview" ? null : noticeAfterRuntimeSelect(next, current));
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
        const current = draftGoalRef.current;
        const workspaceChanged = !current || current.workspace !== selected;
        setDraftGoal((latest) => latest
          ? { ...latest, workspace: selected, intent: undefined, requestId: latest.intent ? freshRequestId() : latest.requestId }
          : {
              workspace: selected,
              provider: "",
              message: "",
              requestId: freshRequestId(),
              baselineCampaignId: snapshot.activeCampaignId
            });
        setDraftError(null);
        if (workspaceChanged) abandonCoordination();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDraftError({ sentence: "Workspace selection failed.", technical: message });
    }
  }

  async function loadEarlierConversation() {
    const pageInfo = snapshot.productConversation?.pageInfo;
    const ownerId = snapshot.activeCampaignId;
    if (!client.historyPage || !ownerId || !pageInfo?.hasOlder || !pageInfo.olderCursor || historyLoading) return;
    const requestedOlderCursor = pageInfo.olderCursor;
    const requestGeneration = ++historyRequest.current;
    const viewIntent = selectionIntent.current;
    setHistoryLoading(true);
    try {
      const page = await client.historyPage({
        scope: "conversation",
        ownerId,
        direction: "older",
        cursor: requestedOlderCursor
      });
      if (requestGeneration !== historyRequest.current || viewIntent !== selectionIntent.current
        || page.scope !== "conversation" || page.ownerId !== ownerId
        || snapshotRef.current.activeCampaignId !== ownerId) return;
      if (snapshotRef.current.productConversation?.pageInfo?.olderCursor !== requestedOlderCursor) {
        setSnapshot((current) => current.notices.includes(HISTORY_WINDOW_ADVANCED_NOTICE)
          ? current
          : { ...current, notices: [HISTORY_WINDOW_ADVANCED_NOTICE, ...current.notices] });
        setActiveNotice({ sentence: HISTORY_WINDOW_ADVANCED_NOTICE });
        return;
      }
      anchor.prepareForPrepend();
      setSnapshot((current) => current.activeCampaignId === ownerId
        ? mergeHistoryPageIntoSnapshot(current, page, requestedOlderCursor)
        : current);
    } catch (error) {
      if (requestGeneration === historyRequest.current) {
        setActiveNotice({ sentence: "Earlier conversation history could not be loaded.", technical: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (requestGeneration === historyRequest.current) setHistoryLoading(false);
    }
  }

  const heldPanel = snapshot.stopResponsibility;
  const relatedHolds: StopResponsibilitySummary[] = snapshot.relatedHolds ?? [];
  const heldNow = heldPanel?.writeResponsibility === "held";
  const taskState = headlineState(product, snapshot, closingSession ? "closing-session" : undefined);
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
        browserPreview={client.mode === "browser-preview"}
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
        {!navCollapsed ? <button className="mobile-nav-backdrop" type="button" aria-label="Close navigation" onClick={() => setNavCollapsed(true)} /> : null}
        <CampaignNav
          snapshot={snapshot}
          collapsed={navCollapsed}
          onSelectCampaign={(campaignId) => { void selectCampaign(campaignId); }}
          onSelectProject={(projectId) => { void selectProject(projectId); }}
          onRenameCampaign={(campaignId, renameTitle) => { void handleRenameCampaign(campaignId, renameTitle); }}
        />

        <main className="conversation-column" aria-label="Goal conversation">
          <StatusBanners
            browserPreview={client.mode === "browser-preview" && coordination === null}
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
              {coordination ? (
                <CoordinationStatus
                  planningHarness={coordination.planningHarness}
                  reviewHarness={coordination.reviewHarness}
                  result={coordination.result}
                  stopReason={coordination.stopReason}
                  planningQuota={coordination.planningQuota}
                  reviewQuota={coordination.reviewQuota}
                />
              ) : null}
              <DraftGoalComposer
                draft={draftGoal ?? { workspace: snapshot.project.workspaceRoot || "", provider: "", message: "" }}
                runtimes={snapshot.runtimes}
                connected={snapshot.connection === "connected"}
                busy={draftBusy}
                blockedFromSending={draftBlocked || Boolean(snapshot.bounds?.projectionUnavailable && !draftRetryLabel)}
                retryLabel={draftRetryLabel}
                error={draftError}
                canBrowse={client.mode === "electron" && Boolean(client.chooseWorkspace)}
                coordinationAvailable={coordinationAvailable}
                workspacePlaceholder={client.mode === "linux-core" ? "/home/you/project" : undefined}
                onBrowse={() => { void chooseWorkspace(); }}
                onChange={(value) => {
                  const current = draftGoal;
                  if (!current) {
                    setDraftGoal({ ...value, requestId: freshRequestId(), baselineCampaignId: snapshot.activeCampaignId });
                    return;
                  }
                  const changed = current.workspace !== value.workspace
                    || current.provider !== value.provider
                    || current.message !== value.message;
                  if (changed) abandonCoordination();
                  setDraftGoal({
                    ...current,
                    ...value,
                    ...(changed && current.intent ? { requestId: freshRequestId(), intent: undefined } : {})
                  });
                }}
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

              <TurnResults results={snapshot.turnResults} omittedTurns={snapshot.bounds?.omittedCounts.turnResults ?? 0} />

              <BackgroundAttention
                snapshot={snapshot}
                onOpen={(campaignId) => { void selectCampaign(campaignId); }}
              />

              <PendingApprovals
                snapshot={snapshot}
                onPermissionDecision={(decisionId, allow) => { void handlePermissionDecision(decisionId, allow); }}
                onKeepWaiting={handleKeepWaiting}
              />

              <div className="timeline-scroll" ref={anchor.ref} onScroll={anchor.handleScroll} tabIndex={-1} aria-label="Conversation timeline">
                <ProductConversationView
                  product={product}
                  loadingEarlier={historyLoading}
                  onLoadEarlier={client.historyPage ? () => { void loadEarlierConversation(); } : undefined}
                  onChooseRuntime={() => setChooserFocusSignal((value) => value + 1)}
                  onDiagnose={() => setDiagnosticsOpen(true)}
                />
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
                focusKey={snapshot.activeCampaignId}
                draft={draft}
                snapshot={snapshot}
                runtime={product.runtime}
                turn={snapshot.bounds?.projectionUnavailable && !activeRetryLabel
                  ? { ...product.turn, canSend: false, reason: "Core returned a capacity-limited view. Reconnect before starting new work." }
                  : product.turn}
                busy={sendBusy}
                closingSession={closingSession}
                retryLabel={activeRetryLabel}
                chooserFocusSignal={chooserFocusSignal}
                onChange={updateVisibleCampaignDraft}
                onSubmit={handleSend}
                onSelectRuntime={(provider) => { void selectRuntime(provider); }}
                onStop={() => { void handleStop(); }}
              />
            </>
          )}

          <SessionDetails
            browserPreview={client.mode === "browser-preview"}
            open={detailsOpen}
            onClose={() => setDetailsOpen(false)}
            snapshot={snapshot}
            product={product}
            onChangeRuntime={() => {
              setDetailsOpen(false);
              setChooserFocusSignal((value) => value + 1);
            }}
            onOpenHandoff={openHandoffDialog}
            onCloseSession={() => { void handleCloseSession(); }}
            closingSession={closingSession}
            onResumeSession={() => { void handleResumeSession(); }}
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
  const development = appInfo?.testMode === true || appInfo?.distribution === "dev";
  const rows: Array<[string, string]> = [
    ["Version", appInfo?.version ? appInfo.version : "unknown"],
    ["Build", development ? "Development build" : (appInfo?.channel || "Release")]
  ];
  return (
    <GoalDialog label="About GoalPort" className="about-dialog" onDismiss={onClose}>
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
    </GoalDialog>
  );
}

export default App;
