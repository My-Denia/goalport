import type { BackgroundHeldWorkspaces, BackgroundStatus } from "./coordination/backgroundStatus";
import {
  BACKGROUND_ADMISSION_UNCONFIRMED_SENTENCE,
  backgroundStartOutcome,
  isDefiniteBackgroundStartRefusal,
  type BackgroundStartOutcome,
} from "./coordination/backgroundJob";
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
import { CoordinationStatus, CoordinationProgress, BackgroundCoordinationStatus } from "./conversation/CoordinationStatus";
import { AuthorizationPanel } from "./conversation/AuthorizationPanel";
import { requestCoordination, type CoordinationView } from "./coordination/requestCoordination";
import { coordinationReplyLine, coordinationStartAdmitted, signedInLine } from "./coordination/replyLine";
import { catalogFromProviderSnapshots, type ProviderSnapshot } from "./coordination/catalogFromProviders";
import { usableInstanceIds, type CoordinationWriteAuthorization, type ExecutionFeedback } from "./coordination/coordinateGoal";
import type { SavedPlan } from "./coordination/savedPlan";
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
import { conversationTitle, headlineState, formatTimestamp } from "./lib/display";
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

/** Fallback for the one main-process competing-job sentence; the rejection envelope normally carries it. */
const BACKGROUND_JOB_OUTSTANDING_SENTENCE =
  "This profile has an outstanding background goal. Return to that job or stop allowing its access; no competing work was admitted.";

/**
 * The confirmed-terminal job states. This mirrors the main process's
 * confirmed-terminal set (electron/coordination-background.cjs `projection`):
 * only these prove the round ended, and only the main process may decide
 * that. Every other state (including "revoked" before release and honest
 * "unconfirmed") is still live-or-unknown and gets no terminal treatment.
 */
const BACKGROUND_JOB_TERMINAL_STATES = new Set(["completed", "failed", "stopped"]);

function commandFailure(next: CoreSnapshot, messageType: string): ActiveNotice | null {
  const outcome = next.commandOutcome;
  if (outcome?.messageType === messageType) {
    if (outcome.kind === "accepted") return null;
    // The one known competing-job guard is a definite pre-dispatch refusal:
    // its own human sentence is the message, not a generic Core failure.
    if (outcome.kind === "refused" && outcome.rejection?.code === "background-job-outstanding") {
      return {
        sentence: outcome.error ?? BACKGROUND_JOB_OUTSTANDING_SENTENCE,
        technical: outcome.rejection.message || outcome.error || "background-job-outstanding"
      };
    }
    const technical = outcome.error ?? (outcome.kind === "refused" ? "request not accepted" : "transport unavailable");
    const runtimeDidNotStart = /not a valid Windows application|unable to start|os error 193/i.test(technical);
    return {
      sentence: outcome.kind === "refused"
        ? (runtimeDidNotStart
          ? "That Runtime didn't start. Nothing was sent."
          : "GoalPort could not complete that action.")
        : "GoalPort could not reach Core for that action.",
      technical
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

export function coordinationGeneration(scope: string, request: number): string {
  return `${scope}-${request}`;
}

/** The panel's turn budget input: default 4, clamped to [2, 32]. */
function clampTurns(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(32, Math.max(2, parsed));
}

/** Selectable-by-default rows: usable, not blocked on this machine, not paid-api. */
function selectableDefaults(providers: readonly ProviderSnapshot[]): string[] {
  return catalogFromProviderSnapshots(providers).flatMap((instance) => {
    if (instance.billing === "paid-api" || instance.billing === "unknown") return [];
    if (instance.environmentAvoided) return [];
    if (instance.enabled === false || instance.installed === false
      || instance.authenticated === false || instance.launchable === false) return [];
    if (typeof instance.quota === "string" && instance.quota.toLowerCase() === "exhausted") return [];
    if (!instance.models || instance.models.length === 0) return [];
    return [instance.instanceId];
  });
}

/** A new-goal draft: local only, one stable request id for the first Send. */
interface GoalDraft extends GoalDraftValue {
  requestId: string;
  baselineCampaignId: string;
  acceptNextCampaign?: boolean;
  intent?: SendIntent;
  revision?: { planText: string | null; reviewText: string | null } & Partial<Pick<ExecutionFeedback,
    "previousExecutionReport" | "previousExecutionAudit">>;
  /**
   * Set when this draft continues a round whose harness proved it cannot run
   * its tools on this machine: that harness receives no role on this send.
   * Draft-only, never persisted as harness health.
   */
  avoid?: { instanceId: string; harness: string; startedAt: string | null };
  /** Shown on a fresh draft opened from Use again or an interrupted job. Nothing has been sent. */
  readyNote?: string;
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
  const [coordination, setCoordination] = useState<CoordinationView | null>(null);
  // Harness-access panel state for a runtime-less draft (M4): one discovery
  // per draft open, the user's selection, and a mirror of the authorized
  // scope. All of it is window-local and never touches the draft text.
  const [panelProviders, setPanelProviders] = useState<readonly ProviderSnapshot[] | null>(null);
  // Harness-access panel load phase for the current runtime-less draft:
  // "idle" before the draft exists, "loading" while discovery runs,
  // "ready" once the panel can render, "failed" when discovery cannot
  // connect. A failed load is retryable and NEVER falls back to an
  // unscoped send: a panel-capable build holds Send until access is seen.
  const [panelLoad, setPanelLoad] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [panelFailSentence, setPanelFailSentence] = useState<string | null>(null);
  const [panelAttempt, setPanelAttempt] = useState(0);
  const [panelRequestId, setPanelRequestId] = useState<string | null>(null);
  const [selectedInstances, setSelectedInstances] = useState<readonly string[]>([]);
  const [allowedTurns, setAllowedTurns] = useState(4);
  const [writeInstances, setWriteInstances] = useState<readonly string[]>([]);
  const [writeTurns, setWriteTurns] = useState(2);
  const [backgroundConsent, setBackgroundConsent] = useState(false);
  const [backgroundJob, setBackgroundJob] = useState<BackgroundStatus | null>(null);
  const [backgroundHolds, setBackgroundHolds] = useState<BackgroundHeldWorkspaces>(() => ({
    holds: [], complete: !window.goalportCore?.backgroundHeldWorkspaces,
    globalBlock: Boolean(window.goalportCore?.backgroundHeldWorkspaces),
  }));
  const [backgroundView, setBackgroundView] = useState(false);
  const backgroundAttached = useRef(false);
  // Job id whose terminal closeout already re-listed the plans in this
  // session — set only AFTER a valid records array actually replaced the
  // plans, so failed reads retry on later polls instead of being skipped.
  const plansListedTerminalRef = useRef<string | null>(null);
  // True while a terminal-triggered records read is in flight: one read at
  // a time, so the 700ms poll never stacks concurrent duplicate reads.
  const terminalListInFlightRef = useRef(false);
  const [scopeMirror, setScopeMirror] = useState<{
    instances: readonly string[];
    maxTurns: number;
    remaining: number;
    generation: number;
    write?: { instances: readonly string[]; maxTurns: number; remaining: number | null; workspaceRoot: string };
  } | null>(null);
  const [panelChangeMode, setPanelChangeMode] = useState(false);
  // Transient state of the CURRENT round, keyed by its request id: never
  // persisted, re-attached to the selected plan only while the request ids
  // match. Historical or reloaded records never receive these controls.
  const [liveRound, setLiveRound] = useState<{
    requestId: string;
    scoped: boolean;
    turnsLeft: number | null;
    maxTurns: number | null;
    exhausted: boolean;
    writeTurnsLeft: number | null;
    maxWriteTurns: number | null;
  } | null>(null);
  // In-flight round progress from this window's onEvent stream.
  const [roundProgress, setRoundProgress] = useState<{
    requestId: string;
    failures: string[];
    activity: string | null;
    /** True while the one in-window corrective pass is running. */
    repair?: boolean;
    /** True while the one in-window plan revision is running. */
    planRevision?: boolean;
  } | null>(null);
  // The most recent coordination discovery, so an environment failure can say
  // honestly whether another usable harness exists. Null until this window
  // has discovered at least once.
  const discoveredProvidersRef = useRef<readonly ProviderSnapshot[] | null>(null);
  const [plans, setPlans] = useState<SavedPlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
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
  const linuxRuntimeRequired = "Send starts a coordinated goal. File changes stay off unless you check the box below.";
  const coordinationAvailable = client.mode === "electron"
    && appInfo?.coordinationConfigured === true
    && Boolean(window.goalportCore?.coordinateDiscover && window.goalportCore?.coordinateLaunch);
  // The full harness-access surface (panel, scoped sends, Use again) needs the
  // whole scope bridge. A build with only the legacy discover/launch pair
  // keeps the pre-panel behavior untouched.
  // Discovery can show the grant affordance before any quota-spending Send.
  const scopeBridgeReady = (coordinationAvailable
    || (client.mode === "electron" && Boolean(window.goalportCore?.backgroundSendConsent)
      && Boolean(window.goalportCore?.coordinateDiscover && window.goalportCore?.coordinateLaunch)))
    && Boolean(window.goalportCore?.coordinationAuthorize)
    && Boolean(window.goalportCore?.coordinationScope)
    && Boolean(window.goalportCore?.coordinationRevoke)
    && Boolean(window.goalportCore?.coordinationUnblock);
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
  const coordinationScope = useRef(freshRequestId());
  const coordinationRequest = useRef(0);
  const draftGoalRef = useRef(draftGoal);
  const linuxFreshDraft = useRef(false);
  const linuxStatusEpoch = useRef(0);
  const linuxActionSettled = useRef(0);
  const leftRequestIds = useRef(new Set<string>());
  const linuxRequestRef = useRef<string | null>(null);
  const seenJobId = useRef<string | null>(null);
  const leftJobIds = useRef(new Set<string>());
  const linuxActionOpen = useRef(false);
  const grantError = useRef(false);
  const grantAllowed = useRef(false);
  const [leftRevision, setLeftRevision] = useState(0);
  const [linuxShowingFreshDraft, setLinuxShowingFreshDraft] = useState(false);
  draftGoalRef.current = draftGoal;
  // Set when a handler opens a fresh draft whose panel must start in change
  // mode; the draft-open effect consumes it exactly once.
  const openPanelInChangeMode = useRef(false);
  // Set by handleConfirmAccessChange: the access-save rotates the draft's
  // requestId (anti-replay, unchanged), and the panel effect must NOT wipe
  // the write/consent selections the user just saved on that rotation.
  const preservePanelSelections = useRef(false);
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
  const [linuxCoordinationLine, setLinuxCoordinationLine] = useState<string | null>(null);
  const workerGone = linuxCoordinationLine === "The worker is gone. Its exit is not confirmed, so another goal cannot start yet.";
  const [linuxCoordinationDetail, setLinuxCoordinationDetail] = useState<string | null>(null);
  const [linuxCoordinationChange, setLinuxCoordinationChange] = useState<string | null>(null);
  const [linuxCoordinationRequest, setLinuxCoordinationRequest] = useState<string | null>(null);
  linuxRequestRef.current = linuxCoordinationRequest;
  const leftUnreplayed = (linuxCoordinationLine === "The interrupted job stays unreplayed; the same request id cannot be admitted again." || (linuxCoordinationRequest ? leftRequestIds.current.has(linuxCoordinationRequest) : false)) && leftRevision >= 0;
  const [linuxCoordinationLive, setLinuxCoordinationLive] = useState(false);
  const [linuxCoordinationGoal, setLinuxCoordinationGoal] = useState<string | null>(null);
  const [linuxCoordinationWorkspace, setLinuxCoordinationWorkspace] = useState<string | null>(null);
  const [linuxHarnessSentence, setLinuxHarnessSentence] = useState<string | null>(null);
  const [linuxSignedIn, setLinuxSignedIn] = useState<string[]>([]);
  const [linuxDiscoverChecked, setLinuxDiscoverChecked] = useState(false);
  const [linuxConsentMissing, setLinuxConsentMissing] = useState(false);
  const [linuxLeftoverHeld, setLinuxLeftoverHeld] = useState(false);
  const [linuxGranting, setLinuxGranting] = useState(false);
  const [linuxActionBusy, setLinuxActionBusy] = useState(false);
  const [linuxHoldLine, setLinuxHoldLine] = useState(false);
  const [sidebarUnconfirmed, setSidebarUnconfirmed] = useState(false);
  const linuxHoldLineRef = useRef(false);
  const heldJobId = useRef<string | null>(null);
  const [linuxDiscoverNonce, setLinuxDiscoverNonce] = useState(0);
  const [linuxWrite, setLinuxWrite] = useState(false);
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
  const selectedPlan = plans.find((plan) => plan.requestId === selectedPlanId) ?? null;
  const draftActive = selectedPlan === null && (draftGoal !== null
    || (confirmedEmptyProfile && !hasGoal && !draftDismissed));

  useEffect(() => {
    const list = window.goalportCore?.coordinationRecords;
    if (!list) return;
    let cancelled = false;
    void list().then((records) => {
      if (!cancelled) setPlans(records);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!booted || draftGoal || selectedPlanId || snapshot.activeCampaignId.trim() || plans.length === 0) return;
    const newest = plans[0];
    if (newest) setSelectedPlanId(newest.requestId);
  }, [booted, draftGoal, selectedPlanId, snapshot.activeCampaignId, plans]);

  // One discovery per runtime-less draft open powers the harness-access panel.
  // This writes only panel state: a discovery that resolves while the user is
  // typing never overwrites the message and never closes or opens anything.
  useEffect(() => {
    if (!coreReady) return;
    const read = window.goalportCore?.backgroundStatus;
    if (!read) return;
    let cancelled = false;
    let reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const job = await read();
        if (cancelled) return;
        setBackgroundJob(current => current?.jobId === job?.jobId && ((current?.revoked && !job?.revoked) || (current?.active === false && job?.active === true)) ? current : job);
        // Only a job that still holds admission may take the main view on
        // its own: the user's live work (running, or honestly unconfirmed)
        // reattaches visibly, while a restored TERMINAL job is history and
        // must not hijack the startup view — its closeout stays one click
        // away on the background-return button, and its record is already
        // in Plans through the records load.
        if (job?.active && !backgroundAttached.current) {
          backgroundAttached.current = true;
          // Narrow widths: the job view must not sit under the drawer mask.
          if (window.innerWidth <= 860) setNavCollapsed(true);
          setBackgroundView(true);
        }
        // A background round persists its plan record BEFORE the job store
        // records the terminal outcome (electron/coordination-worker.cjs),
        // so the first poll that sees a confirmed-terminal state can re-list
        // the plans: without this, a round that finishes in the background
        // never reaches Plans in this session and Revise cannot continue
        // from the current view. The send path's own disk re-read keeps
        // command identity (record count) unchanged.
        // The per-job mark is set ONLY after a valid records array actually
        // replaced the plans: a read that throws, resolves to a non-array,
        // or finds no records port leaves the job unmarked, so the next
        // poll retries it instead of permanently skipping the finished
        // round. One read in flight at a time; failures never double-stack.
        if (job && job.active === false && BACKGROUND_JOB_TERMINAL_STATES.has(job.state)
          && plansListedTerminalRef.current !== job.jobId && !terminalListInFlightRef.current) {
          const list = window.goalportCore?.coordinationRecords;
          if (list) {
            terminalListInFlightRef.current = true;
            const listedJobId = job.jobId;
            void list().then((records) => {
              if (!cancelled && Array.isArray(records)) {
                plansListedTerminalRef.current = listedJobId;
                setPlans(records);
              }
            }).catch(() => undefined)
              .finally(() => { terminalListInFlightRef.current = false; });
          }
        }
      } catch {
        if (!cancelled) setBackgroundJob(job => job ? { ...job, state: "unconfirmed", live: false } : null);
      } finally { reading = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 700);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [coreReady]);
  // Retry intents retain their original workspace even if the draft text changes.
  const candidateWorkspace = draftGoal?.intent?.workspaceRoot ?? draftGoal?.workspace.trim()
    ?? snapshot.project.workspaceRoot ?? "";
  const holdRevision = `${backgroundJob?.jobId ?? ""}:${backgroundJob?.acknowledgedStuckAt ?? ""}:${backgroundJob?.state ?? ""}:${backgroundJob?.active ?? ""}`;
  const [checkedHoldRevision, setCheckedHoldRevision] = useState<string | null>(null);
  useEffect(() => {
    if (!coreReady) return;
    const read = window.goalportCore?.backgroundHeldWorkspaces;
    if (!read) return;
    let cancelled = false;
    let reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const facts = await read(candidateWorkspace);
        if (cancelled) return;
        if (!facts || !Array.isArray(facts.holds) || facts.holds.length > 256
          || facts.candidate !== candidateWorkspace || typeof facts.candidateBlocked !== "boolean"
          || typeof facts.complete !== "boolean" || typeof facts.globalBlock !== "boolean"
          || facts.holds.some(hold => !hold || typeof hold.jobId !== "string"
            || typeof hold.workspacePath !== "string" || !workspaceIdentityKey(hold.workspacePath))) {
          throw new Error("Incomplete workspace reservations");
        }
        setCheckedHoldRevision(holdRevision);
        setBackgroundHolds(current => facts.complete ? facts : {
          holds: [...new Map([...current.holds, ...facts.holds].map(hold => [hold.jobId, hold])).values()].slice(0, 256),
          complete: false, globalBlock: true,
        });
      } catch {
        // A failed read cannot release a known hold. Until complete facts
        // return, do not promise a new send in any folder.
        if (!cancelled) setBackgroundHolds(current => ({ ...current, complete: false, globalBlock: true }));
      } finally { reading = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 700);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [coreReady, candidateWorkspace, holdRevision]);
  const runtimeLessDraftKey = draftGoal && draftGoal.provider.trim() === "" ? draftGoal.requestId : null;
  useEffect(() => {
    if (!runtimeLessDraftKey || !scopeBridgeReady) return undefined;
    const bridge = window.goalportCore;
    const discover = bridge?.coordinateDiscover;
    const readScope = bridge?.coordinationScope;
    if (!discover || !readScope) return undefined;
    let cancelled = false;
    setPanelProviders(null);
    setPanelLoad("loading");
    setPanelFailSentence(null);
    setScopeMirror(null);
    // Each fresh draft starts without file-change consent. Never restore it
    // from history or from another draft's live scope — except across the
    // requestId rotation that a Save-harness-access performs, where the
    // user's just-saved selections are exactly what must survive.
    const preserveSelections = preservePanelSelections.current;
    preservePanelSelections.current = false;
    if (!preserveSelections) {
      setWriteInstances([]);
      setWriteTurns(2);
      setBackgroundConsent(false);
    }
    setPanelRequestId(runtimeLessDraftKey);
    setPanelChangeMode(openPanelInChangeMode.current);
    openPanelInChangeMode.current = false;
    void (async () => {
      let scope: { instances: string[]; maxTurns: number; remaining: number; generation: number } | null = null;
      try {
        scope = await readScope();
      } catch {
        scope = null;
      }
      if (cancelled) return;
      if (scope) {
        setScopeMirror({ instances: scope.instances, maxTurns: scope.maxTurns, remaining: scope.remaining, generation: scope.generation });
        setAllowedTurns(scope.maxTurns);
      }
      let discovery: {
        connected: boolean;
        sendAuthorized: boolean;
        providers: readonly ProviderSnapshot[];
        stopReason: string | null;
      } | null = null;
      try {
        discovery = await discover();
      } catch {
        discovery = null;
      }
      if (cancelled) return;
      if (!discovery || !discovery.connected) {
        setPanelLoad("failed");
        setPanelFailSentence(discovery?.stopReason ?? null);
        return;
      }
      discoveredProvidersRef.current = discovery.providers;
      setPanelProviders(discovery.providers);
      setPanelLoad("ready");
      // A scope member the current catalog can no longer staff (a paid-api
      // login, a since-blocked harness nobody re-authorized for) never lands
      // in the checked set: rows show reality, and the checked set stays a
      // subset of what can actually take a role. Scope members that are
      // selectable-but-currently-blocked (blocked after the authorize) stay
      // checked — the authorization really does include them.
      const selectable = new Set(selectableDefaults(discovery.providers));
      setSelectedInstances(scope && scope.instances.length > 0
        ? scope.instances.filter((instanceId) => {
          const catalog = catalogFromProviderSnapshots(discovery.providers).find((item) => item.instanceId === instanceId);
          return catalog ? catalog.billing === "subscription" || catalog.billing === "included" || catalog.billing === "unknown" : false;
        })
        : [...selectable]);
    })();
    return () => { cancelled = true; };
  }, [runtimeLessDraftKey, scopeBridgeReady, panelAttempt]);
  // Send admission for a runtime-less draft in a panel-capable build: the
  // user must see (or retry loading) their harness-access choices before
  // any model turn can be spent. Legacy builds without the scope bridge
  // keep the pre-panel behavior untouched.
  const panelForDraftLive = draftGoal !== null && draftGoal.provider.trim() === "" && panelRequestId === draftGoal.requestId;
  const panelHoldsSend = scopeBridgeReady && panelForDraftLive && panelLoad !== "ready";
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
      if (draftGoal.acceptNextCampaign) {
        setDraftGoal((current) => current ? {
          ...current,
          baselineCampaignId: snapshot.activeCampaignId,
          acceptNextCampaign: false,
        } : current);
        return;
      }
      closeDraft();
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
  // The read-only host inventory includes older acknowledged reservations,
  // not just the currently displayed job. Mirror the current job too so an
  // acknowledgement is visible immediately, before the next inventory poll.
  // Only complete refreshed facts can release an older reservation.
  const heldWorkspace = backgroundJob && backgroundJob.acknowledgedStuckAt && !confirmedTerminalJob(backgroundJob)
    ? (backgroundJob.workspacePath ?? "")
    : "";
  const heldWorkspaces = [...backgroundHolds.holds.map(hold => hold.workspacePath), ...(heldWorkspace ? [heldWorkspace] : [])];
  const targetsAnyHeldWorkspace = (workspace: string) => heldWorkspaces.some(held => targetsHeldWorkspace(workspace, held));
  const candidateChecked = !window.goalportCore?.backgroundHeldWorkspaces
    || (backgroundHolds.candidate === candidateWorkspace && checkedHoldRevision === holdRevision
      && backgroundHolds.complete && typeof backgroundHolds.candidateBlocked === "boolean");
  const workspaceHeldByBackground = (workspace: string): boolean => {
    if (targetsAnyHeldWorkspace(workspace)) {
      if (candidateChecked && backgroundHolds.candidateBlocked === false && !backgroundHolds.globalBlock) {
        return false;
      }
      return true;
    }
    return candidateChecked && backgroundHolds.candidateBlocked === true && !backgroundHolds.globalBlock;
  };
  const draftHeld = workspaceHeldByBackground(candidateWorkspace);
  const draftHeldSentence = heldWorkspaces.length > 0 ? HELD_FOLDER_SENTENCE : UNIDENTIFIABLE_FOLDER_SENTENCE;
  useEffect(() => {
    if (!draftHeld) setDraftError(current => (current?.sentence === HELD_FOLDER_SENTENCE || current?.sentence === UNIDENTIFIABLE_FOLDER_SENTENCE) ? null : current);
  }, [draftHeld]);
  const conversationWorkspace = snapshot.project?.workspaceRoot ?? "";
  const conversationHeldByBackground = conversationWorkspace !== "" && (
    candidateWorkspace === conversationWorkspace
      ? workspaceHeldByBackground(conversationWorkspace)
      : targetsAnyHeldWorkspace(conversationWorkspace)
  );
  // The host's profile slot admits no competing send while a background job's
  // active pointer exists, in any folder. Present that before Send rather than
  // letting the draft look started and then be refused at admission.
  const backgroundSlotBlocked = !candidateChecked || backgroundHolds.globalBlock || !backgroundHolds.complete
    || Boolean(backgroundJob?.active && !backgroundJob.acknowledgedStuckAt);
  const backgroundSlotSentence = !candidateChecked || !backgroundHolds.complete
    ? "Workspace reservations could not be checked. Wait for status to refresh before sending; nothing was sent."
    : backgroundJob?.active && confirmedTerminalJob(backgroundJob)
    ? "This finished goal still holds the profile slot. Open it and choose its new-send control to release it; nothing was sent."
    : "A background goal is still active. Return to it and stop it before starting another send; nothing was sent.";
  // Usable harness ids from the last discovery in this window, so an
  // environment failure can honestly say whether a round without that
  // harness is possible (an independent check needs two).
  const usableProviderIds = discoveredProvidersRef.current === null
    ? null
    : usableInstanceIds(catalogFromProviderSnapshots(discoveredProvidersRef.current));
  const environmentAlternatives = (blocked: { instanceId: string } | null | undefined): number | null => {
    if (!blocked || usableProviderIds === null) return null;
    return usableProviderIds.filter((id) => id !== blocked.instanceId).length;
  };

  // -----------------------------------------------------------------------
  // First send: ONE start_conversation dispatch with a caller-stable request
  // id. No createCampaign+sendMessage dual path. No auto replay on rejection
  // or transport error; the draft is preserved and, if Core actually created
  // the goal, recovered from the snapshot (see the effect above).
  // -----------------------------------------------------------------------
  async function handleDraftSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftGoal || draftBusy || draftInFlight.current || (client.mode === "linux-core" && linuxActionBusy)) return;
    const retrying = canExplicitlyRetry(draftGoal.intent);
    if (draftBlocked && !retrying) return;
    const workspace = draftGoal.intent?.workspaceRoot ?? draftGoal.workspace.trim();
    const provider = draftGoal.intent?.provider ?? draftGoal.provider;
    const message = draftGoal.intent?.message ?? draftGoal.message.trim();
    if (!workspace || !message) return;
    if (workspaceHeldByBackground(workspace)) {
      setDraftError({ sentence: draftHeldSentence });
      return;
    }
    if (backgroundSlotBlocked) {
      setDraftError({ sentence: backgroundSlotSentence });
      return;
    }
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
      if (client.mode === "linux-core") {
        if (linuxCoordinationLive || !linuxDiscoverChecked || Boolean(linuxHarnessSentence) || linuxConsentMissing || !backgroundConsent || linuxSignedIn.length < 2) {
          if (linuxSignedIn.length < 2 && linuxDiscoverChecked && !linuxHarnessSentence && !linuxCoordinationLive) {
            setLinuxHarnessSentence("An independent check needs a second logged-in harness, so nothing will be sent.");
          }
          return;
        }
        const statusEpoch = ++linuxStatusEpoch.current;
        linuxActionOpen.current = true;
        setLinuxActionBusy(true);
        linuxHoldLineRef.current = false;
        heldJobId.current = null;
        grantAllowed.current = false;
        setLinuxHoldLine(false);
        setLinuxCoordinationLine("Sending.");
        void fetch("/goalport/ipc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageType: "coordination_start", payload: { goal: message, workspaceRoot: workspace, write: linuxWrite, background: backgroundConsent, instances: linuxSignedIn.length >= 2 ? linuxSignedIn.join(",") : undefined } }),
        }).then(async (response) => response.json()).then((body) => {
          if (statusEpoch !== linuxStatusEpoch.current) return;
          linuxActionSettled.current = statusEpoch;
          const text = coordinationReplyLine(body, "The coordinated goal was sent.");
          const shown = text.includes("Run acknowledge before starting another") ? "The left goal could not be released, so nothing was sent." : text;
          setLinuxCoordinationLine(shown);
          const failed = !body || (body as { ok?: unknown }).ok === false || (typeof (body as { error?: unknown }).error === "string" && (body as { error: string }).error.trim().length > 0);
          linuxHoldLineRef.current = failed && !coordinationStartAdmitted(body);
          setLinuxHoldLine(failed && !coordinationStartAdmitted(body));
          if (failed && !coordinationStartAdmitted(body) && shown !== "The left goal could not be released, so nothing was sent.") setSidebarUnconfirmed(true);
          if (coordinationStartAdmitted(body)) {
            setLinuxLeftoverHeld(false);
            setSidebarUnconfirmed(false);
            linuxFreshDraft.current = false;
            setLinuxShowingFreshDraft(false);
            setLinuxCoordinationLive(true);
            setLinuxCoordinationGoal(message);
            setLinuxCoordinationWorkspace(workspace);
            setDraftGoal((current) => current ? { ...current, message: "" } : current);
          }
        }).catch(() => {
          if (statusEpoch !== linuxStatusEpoch.current) return;
          linuxActionSettled.current = statusEpoch;
          setLinuxCoordinationLine("The coordinated goal could not be sent.");
          linuxHoldLineRef.current = true;
          setLinuxHoldLine(true);
          setSidebarUnconfirmed(true);
          setDraftError(null);
        }).finally(() => { if (statusEpoch === linuxStatusEpoch.current) { linuxActionOpen.current = false; setLinuxActionBusy(false); } });
        return;
      }
      if (!coordinationAvailable || !discover || !launch) {
        setDraftError({ sentence: "Choose a Runtime before sending." });
        return;
      }
      const remembered = plans.find((plan) => plan.requestId === draftGoal.requestId);
      // Only a round that provably dispatched nothing (not authorized, not
      // installed, never recorded) may be sent again from this draft; a
      // dispatched or unknown outcome is shown, never silently resent.
      if (remembered && remembered.messageDispatched !== false) {
        setCoordination(remembered);
        setSelectedPlanId(remembered.requestId);
        return;
      }
      // The harness-access panel decides who may work when its discovery for
      // this draft is in. Fewer than two selected harnesses cannot run an
      // independent check, so nothing is authorized and nothing is sent.
      const panelForDraft = panelRequestId === draftGoal.requestId ? panelProviders : null;
      const scopedSend = scopeBridgeReady && panelForDraft !== null;
      if (scopeBridgeReady && panelForDraft === null) {
        // A panel-capable build never silently falls back to the legacy
        // unscoped path while harness access is unresolved (P1).
        setDraftError(panelLoad === "failed"
          ? { sentence: "Your harness-access choices could not be loaded, so nothing was sent. Retry the load, or pick a single Runtime.", technical: panelFailSentence ?? undefined }
          : { sentence: "Harness access is still loading, so nothing was sent. Send unlocks once your harness-access choices are ready." });
        return;
      }
      if (scopedSend && writeInstances.length > 0 && (!Number.isInteger(writeTurns) || writeTurns < 1 || writeTurns > 8)) {
        setDraftError({ sentence: "Choose 1 to 8 write turns before allowing workspace changes." });
        return;
      }
      if (scopedSend && selectedInstances.length < 2) {
        setDraftError({ sentence: "An independent check needs two harnesses that can run, so select at least two." });
        return;
      }
      setDraftError(null);
      const request = ++coordinationRequest.current;
      const generation = coordinationGeneration(coordinationScope.current, request);
      const stillCurrent = () => coordinationRequest.current === request;
      let sendRecorded = false;
      let completedReport: CoordinationView | null = null;
      // A manual Revise of a terminal execution-audit revision carries the
      // completed reports as execution feedback; the plain plan-revision
      // inputs stay for a plan check revision. Built ONCE here, before the
      // background/window choice, so both send modes share the same object.
      // Nothing is sent until the user presses Send.
      const revisionFeedback: ExecutionFeedback | null =
        draftGoal.revision && (draftGoal.revision.previousExecutionReport || draftGoal.revision.previousExecutionAudit)
          ? {
              previousPlan: draftGoal.revision.planText,
              previousPlanReview: draftGoal.revision.reviewText,
              previousExecutionReport: draftGoal.revision.previousExecutionReport ?? null,
              previousExecutionAudit: draftGoal.revision.previousExecutionAudit ?? null,
              previousCommandIds: [],
            }
          : null;
      setDraftBusy(true);
      try {
        if (backgroundConsent) {
          if (appInfo?.coordinationConfigured !== true) return; // Grant affordance explains the blocked Send.
          const start = window.goalportCore?.backgroundStart;
          if (!scopedSend || !start) { setDraftError({ sentence: "Background Send is unavailable; nothing was admitted." }); return; }
          // Admission is this job's single Send, never a retryable draft or
          // an ordinary main-process record write. Even a lost Start reply
          // cannot authorize another owner or a window-only resend.
          setDraftBlocked(true);
          const submittedRequestId = draftGoal.requestId;
          // One honest unknown-outcome settlement: the draft stays blocked,
          // and a single read-only probe may reattach this request's job.
          // Nothing here restarts a job, authorizes the window path, or
          // writes an ordinary coordination record.
          const admissionUnconfirmed = async (technical: string) => {
            if (!stillCurrent() || draftGoalRef.current?.requestId !== submittedRequestId) return;
            setBackgroundConsent(false);
            setDraftError({ sentence: BACKGROUND_ADMISSION_UNCONFIRMED_SENTENCE, technical });
            const probe = window.goalportCore?.backgroundStatus;
            if (!probe) return;
            try {
              const job = await probe();
              if (!stillCurrent() || draftGoalRef.current?.requestId !== submittedRequestId) return;
              if (job && job.requestId === submittedRequestId) {
                setBackgroundJob(job); backgroundAttached.current = true;
                // Narrow widths: entering the job view closes the drawer so
                // its backdrop cannot cover the Stop control.
                if (window.innerWidth <= 860) setNavCollapsed(true);
                setBackgroundView(true);
              }
            } catch {
              // A failed status read proves nothing; the draft stays blocked.
            }
          };
          let outcome: BackgroundStartOutcome;
          let settledValue: unknown = null;
          try {
            settledValue = await start({ requestId: draftGoal.requestId, goal: message, workspaceRoot: workspace,
              readInstances: [...selectedInstances], readMaxTurns: allowedTurns,
              ...(writeInstances.length ? { write: { instances: [...writeInstances], workspaceRoot: workspace, maxTurns: writeTurns } } : {}),
              ...(revisionFeedback
                ? { executionFeedback: revisionFeedback, priorPlan: null, priorReview: null }
                : { priorPlan: draftGoal.revision?.planText, priorReview: draftGoal.revision?.reviewText }),
              ...(draftGoal.avoid ? { avoidInstances: [draftGoal.avoid.instanceId] } : {}), backgroundConsent: true });
            outcome = backgroundStartOutcome(settledValue);
          } catch (error) {
            await admissionUnconfirmed(error instanceof Error && error.message ? error.message : "The reply about this background start never arrived.");
            return;
          }
          if (!stillCurrent()) return;
          if (outcome.kind === "refused") {
            setBackgroundConsent(false);
            if (isDefiniteBackgroundStartRefusal(outcome)) {
              // Definite refusal: nothing was admitted, so the draft becomes
              // usable again; a corrected send re-opts into background.
              setDraftBlocked(false);
              const lead = outcome.message.trim() || "Background Send was refused.";
              setDraftError({ sentence: `${lead} Nothing was started, so this draft is still yours to change and send.`, technical: outcome.code });
            } else {
              await admissionUnconfirmed(outcome.message || outcome.code);
            }
            return;
          }
          if (outcome.kind === "unknown") {
            const rawMessage = settledValue && typeof settledValue === "object"
              ? (settledValue as { message?: unknown }).message
              : null;
            await admissionUnconfirmed(typeof rawMessage === "string" && rawMessage.trim()
              ? rawMessage
              : "The reply about this background start was not a recognizable result.");
            return;
          }
          setBackgroundJob(outcome.status); backgroundAttached.current = true;
          // Narrow widths: entering the job view closes the drawer so its
          // backdrop cannot cover the Stop control.
          if (window.innerWidth <= 860) setNavCollapsed(true);
          setBackgroundView(true);
          setBackgroundConsent(false);
          return;
        }
        // Authorize before anything else: a failed authorization shows its
        // sentence and sends nothing at all.
        let scopeGeneration: number | undefined;
        let writeAuthorization: CoordinationWriteAuthorization | undefined;
        if (scopedSend) {
          setCoordination(null);
          setRoundProgress({ requestId: draftGoal.requestId, failures: [], activity: null });
          const chosen = [...selectedInstances];
          const requestedWrite = writeInstances.length > 0
            ? { instances: [...writeInstances], maxTurns: writeTurns, workspaceRoot: workspace }
            : undefined;
          const authorized = await window.goalportCore!.coordinationAuthorize!({ instances: chosen, maxTurns: allowedTurns, workspaceRoot: workspace, ...(requestedWrite ? { write: requestedWrite } : {}) });
          if (!stillCurrent()) return;
          if (!authorized || authorized.ok !== true) {
            setDraftError({ sentence: authorized?.errorText?.trim() || "Harness access could not be authorized, so nothing was sent." });
            return;
          }
          scopeGeneration = authorized.generation;
          setScopeMirror({ instances: chosen, maxTurns: allowedTurns, remaining: authorized.remaining, generation: authorized.generation });
          if (requestedWrite) {
            // Consent is not authority. The actual M6 scope must still be live,
            // generation-matched and bound to this pinned workspace.
            const scope = await window.goalportCore!.coordinationScope!();
            if (!stillCurrent()) return;
            const write = scope?.write;
            if (!scope || scope.generation !== scopeGeneration || !write
              || write.workspaceRoot !== workspace || draftGoalRef.current?.workspace.trim() !== workspace
              || draftGoalRef.current?.requestId !== draftGoal.requestId
              || write.maxTurns !== requestedWrite.maxTurns
              || !Number.isInteger(write.remaining) || write.remaining < 1 || write.remaining > write.maxTurns
              || write.instances.length !== requestedWrite.instances.length
              || !write.instances.every((id) => requestedWrite.instances.includes(id))
              || scope.instances.length !== chosen.length || !scope.instances.every((id) => chosen.includes(id))) {
              setWriteInstances([]);
              setScopeMirror(null);
              setDraftError({ sentence: "Workspace-change access changed or was stopped. Check this workspace and authorize again; no edits were sent." });
              return;
            }
            writeAuthorization = { instances: [...write.instances], workspaceRoot: write.workspaceRoot, remaining: write.remaining };
            setScopeMirror(scope);
          }
        }
        // Each recorded send gets its own command identity, so a second send
        // of the same words is a new round, not a replay of the first round's
        // stored result. The count must be the records on disk right now —
        // the same number an owner precomputes for the authorization — not
        // the asynchronously loaded plans list: sending before that load
        // settles (or after it failed) would recycle an earlier round's id
        // and replay its stored result.
        let recordCount = plans.length;
        const listRecords = window.goalportCore?.coordinationRecords;
        if (listRecords) {
          let disk: SavedPlan[] | null = null;
          try {
            disk = await listRecords();
          } catch {
            disk = null;
          }
          if (!stillCurrent()) return;
          if (!Array.isArray(disk)) {
            setDraftError({ sentence: "The saved plans could not be read, so nothing was sent. Try again in a moment." });
            return;
          }
          recordCount = disk.length;
          setPlans(disk);
        }
        const sendKey = `send-${recordCount}`;
        const discovery = await discover(generation);
        if (!stillCurrent()) return;
        if (discovery.connected) discoveredProvidersRef.current = discovery.providers;
        // Shared liveness/scope validator for BOTH in-window continuations
        // (the one pre-write plan revision and the one corrective repair).
        // Same checks a first send made: current request and draft, governing
        // Core state, the captured scope generation, unchanged memberships
        // and root, and honest remaining counters. Returns the validated
        // live scope or null; null always means "launch nothing further".
        const confirmContinuationScope = async (neededReadTurns: number | null) => {
          if (!stillCurrent()) return null;
          const currentDraft = draftGoalRef.current;
          if (!currentDraft || currentDraft.requestId !== draftGoal.requestId
            || currentDraft.workspace.trim() !== workspace) return null;
          // The same new-work capacity and governing-held checks as a
          // first send: a coordination verdict never releases or
          // bypasses native Core state.
          const liveSnapshot = snapshotRef.current;
          if (liveSnapshot.bounds?.projectionUnavailable) return null;
          if (liveSnapshot.stopResponsibility?.writeResponsibility === "held"
            && liveSnapshot.stopResponsibility.blocksCurrentWorkspace !== false) return null;
          let scope: { instances: string[]; maxTurns: number; remaining: number; generation: number;
            write?: { instances: string[]; maxTurns: number; remaining: number | null; workspaceRoot: string } } | null = null;
          try {
            scope = await window.goalportCore!.coordinationScope!();
          } catch {
            return null;
          }
          if (!stillCurrent()) return null;
          if (!scope || scope.generation !== scopeGeneration) return null;
          if (scope.instances.length !== selectedInstances.length
            || !scope.instances.every((id) => selectedInstances.includes(id))) return null;
          const liveWrite = scope.write;
          if (!liveWrite || liveWrite.workspaceRoot !== workspace
            || liveWrite.instances.length !== writeAuthorization!.instances.length
            || !liveWrite.instances.every((id) => writeAuthorization!.instances.includes(id))) return null;
          if (!Number.isInteger(scope.remaining) || scope.remaining < (neededReadTurns ?? 0)) return null;
          if (!Number.isInteger(liveWrite.remaining) || (liveWrite.remaining ?? 0) < 1) return null;
          return scope;
        };
        const report = await requestCoordination(
          {
            workspacePath: workspace,
            goal: message,
            sendKey,
            priorPlan: revisionFeedback ? null : draftGoal.revision?.planText ?? null,
            priorReview: revisionFeedback ? null : draftGoal.revision?.reviewText ?? null,
            executionFeedback: revisionFeedback ?? undefined,
            avoidInstances: draftGoal.avoid ? [draftGoal.avoid.instanceId] : undefined,
            allowedInstances: scopedSend ? [...selectedInstances] : undefined,
            writeAuthorization,
            // The one in-window corrective pass and the one pre-write plan
            // revision share one local liveness/scope validator: only a
            // scoped, explicitly write-consented send with record persistence
            // available gets either, and each gate must have re-confirmed
            // liveness and checkpointed the completed pass before its next
            // turn. Neither gate introduces a new authority — the same
            // captured scope generation, memberships, root and live counters
            // a first send checked are re-read from the same IPC.
            beforeRepair: scopedSend && writeAuthorization
              && typeof window.goalportCore?.coordinationSave === "function"
              && typeof window.goalportCore?.coordinationScope === "function"
              ? async (checkpoint) => {
                const scope = await confirmContinuationScope(checkpoint.remainingReadTurns);
                if (scope === null) return false;
                // Checkpoint the completed first round with an honest
                // unconfirmed repair intent BEFORE the first corrective
                // launch; a failed recording sends no corrective turn.
                const checkpointView: CoordinationView = {
                  ...checkpoint.firstRound,
                  stopReason: `${checkpoint.firstRound.stopReason} One checked repair is being organized with the remaining access; its outcome is not confirmed yet.`,
                };
                const remembered = await rememberPlan(draftGoal.requestId, workspace, message, checkpointView);
                if (!stillCurrent()) return false;
                if (!remembered || !remembered.recorded) return false;
                setPlans((current) => [remembered.record, ...current.filter((plan) => plan.requestId !== remembered.record.requestId)]);
                setRoundProgress((current) => current && current.requestId === draftGoal.requestId
                  ? { ...current, repair: true }
                  : current);
                return true;
              }
              : undefined,
            beforePlanRevision: scopedSend && writeAuthorization
              && typeof window.goalportCore?.coordinationSave === "function"
              && typeof window.goalportCore?.coordinationScope === "function"
              ? async (checkpoint) => {
                const scope = await confirmContinuationScope(checkpoint.remainingReadTurns);
                if (scope === null) return false;
                // Same honest unconfirmed-intent checkpoint, distinct wording:
                // a plan revision happens before any writer launched.
                const checkpointView: CoordinationView = {
                  ...checkpoint.firstRound,
                  stopReason: `${checkpoint.firstRound.stopReason} One checked plan revision is being organized with the remaining access; its outcome is not confirmed yet.`,
                };
                const remembered = await rememberPlan(draftGoal.requestId, workspace, message, checkpointView);
                if (!stillCurrent()) return false;
                if (!remembered || !remembered.recorded) return false;
                setPlans((current) => [remembered.record, ...current.filter((plan) => plan.requestId !== remembered.record.requestId)]);
                setRoundProgress((current) => current && current.requestId === draftGoal.requestId
                  ? { ...current, planRevision: true }
                  : current);
                return true;
              }
              : undefined,
            onEvent: scopedSend
              ? (event) => {
                if (!stillCurrent()) return;
                setRoundProgress((current) => {
                  const base = current ?? { requestId: draftGoal.requestId, failures: [], activity: null };
                  if (event.kind === "started") {
                    const harness = event.harness?.trim() || event.instanceId;
                    return { ...base, activity: `${harness} is ${event.role === "planning" ? "planning" : event.role === "review" ? "checking" : event.role === "execution" ? "making changes" : "verifying"}…` };
                  }
                  if (event.kind === "continued") return { ...base, activity: event.sentence };
                  return { ...base, failures: [...base.failures, event.sentence], activity: null };
                });
              }
              : undefined,
          },
          discovery,
          {
            launch: async (command: CoordinateTurnCommand) => {
              if (!stillCurrent()) {
                return { text: "", errorText: "The coordination request was replaced, so nothing was sent." };
              }
              // The user just sent a goal that will call a harness. The record
              // has to be on disk before that call returns, so a crash or a
              // closed window still shows the send and does not start another.
              if (!sendRecorded) {
                sendRecorded = true;
                const pending: CoordinationView = {
                  planningHarness: null,
                  reviewHarness: null,
                  planText: null,
                  reviewText: null,
                  result: null,
                  verdict: "unconfirmed",
                  stopReason: "A send started and will not be repeated.",
                  planningQuota: null,
                  reviewQuota: null,
                  messageDispatched: true,
                };
                const remembered = await rememberPlan(draftGoal.requestId, workspace, message, pending);
                if (!stillCurrent()) {
                  return { text: "", errorText: "The coordination request was replaced, so nothing was sent." };
                }
                if (remembered && !remembered.recorded) {
                  return { text: "", errorText: "The send could not be recorded, so nothing was sent." };
                }
                if (remembered) {
                  setPlans((current) => [remembered.record, ...current.filter((plan) => plan.requestId !== remembered.record.requestId)]);
                }
              }
              const result = await launch(command, generation, scopeGeneration, workspace);
              // Each launch reports the authorized budget it spent from; the
              // mirror (and the in-flight progress line) follow it live.
              if (stillCurrent() && result) {
                // Forward transport literally; null means unknown/revoked, not
                // a stale last-known number. READ and WRITE are independent.
                setScopeMirror((current) => {
                  if (!current) return current;
                  if (result.turnsRemaining === null) return null;
                  return {
                    ...current,
                    remaining: typeof result.turnsRemaining === "number" ? result.turnsRemaining : current.remaining,
                    ...(current.write && result.writeTurnsRemaining !== undefined
                      ? { write: { ...current.write, remaining: result.writeTurnsRemaining } } : {}),
                  };
                });
              }
              return result;
            },
          },
          stillCurrent,
        );
        if (coordinationRequest.current !== request) return;
        completedReport = report;
        setCoordination(report);
        setDraftBlocked(report.messageDispatched !== false);
        setLiveRound({
          requestId: draftGoal.requestId,
          scoped: scopedSend,
          turnsLeft: report.authorizedTurnsLeft ?? null,
          maxTurns: scopedSend ? allowedTurns : null,
          exhausted: report.scopeExhausted === true,
          writeTurnsLeft: report.authorizedWriteTurnsLeft ?? null,
          maxWriteTurns: writeAuthorization ? writeTurns : null,
        });
        const saved = await rememberPlan(draftGoal.requestId, workspace, message, report);
        if (coordinationRequest.current !== request) return;
        if (saved?.recorded) {
          setPlans((current) => [saved.record, ...current.filter((plan) => plan.requestId !== saved.record.requestId)]);
          setSelectedPlanId(saved.record.requestId);
        }
      } catch (error) {
        if (coordinationRequest.current !== request) return;
        if (completedReport) {
          setCoordination(completedReport);
          setDraftBlocked(completedReport.messageDispatched !== false);
          setActiveNotice({ sentence: "The result is on screen, but it could not be saved. Do not resend without inspecting the workspace." });
          return;
        }
        const failed: CoordinationView = {
          planningHarness: null,
          reviewHarness: null,
          planText: null,
          reviewText: null,
          result: null,
          verdict: "failed",
          stopReason: error instanceof Error ? error.message : "The coordination service is not available.",
          planningQuota: null,
          reviewQuota: null,
          // sendRecorded means the launch callback was entered: the outcome
          // is unknown, so the failure must not be resendable.
          messageDispatched: sendRecorded,
        };
        setCoordination(failed);
        const saved = await rememberPlan(draftGoal.requestId, workspace, message, failed);
        if (saved?.recorded) setPlans((current) => [saved.record, ...current.filter((plan) => plan.requestId !== saved.record.requestId)]);
      } finally {
        if (coordinationRequest.current === request) {
          setDraftBusy(false);
          setRoundProgress(null);
        }
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
      // New goal replaced this send. Publishing its campaign first would close
      // the replacement draft and put the user on the goal they just left.
      if (epoch !== draftEpoch.current) return;
      setSnapshot(next);
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
      closeDraft(false);
    } catch (error) {
      // A client that genuinely rejects instead of returning a snapshot is
      // definite ONLY for the known competing-background guard. Every other
      // throw stays ambiguous: the same request identity returns for a
      // non-dispatching reconciliation, and nothing is claimed as delivered.
      if (epoch !== draftEpoch.current) return;
      const coded = error instanceof Error ? (error as { code?: unknown }).code : undefined;
      const detail = error instanceof Error ? error.message : String(error);
      if (coded === "background-job-outstanding") {
        setDraftError({ sentence: detail.trim() ? detail : BACKGROUND_JOB_OUTSTANDING_SENTENCE, technical: detail });
        setDraftBlocked(false);
        setDraftGoal((current) => current ? { ...current, requestId: freshRequestId(), intent: undefined } : current);
      } else {
        setDraftError({ sentence: "GoalPort did not confirm it could start the conversation.", technical: detail });
        const retained = settleSendIntent(intent, undefined);
        setDraftGoal((current) => current ? {
          ...current,
          ...(retained ? { requestId: retained.requestId, intent: retained } : { requestId: freshRequestId(), intent: undefined }),
        } : current);
      }
    } finally {
      draftInFlight.current = false;
      setDraftBusy(false);
    }
  }

  // Every way off a draft stops an in-flight assignment. New goal, discard,
  // picking another goal, and Core opening a conversation all come through here.
  function closeDraft(dismissed?: boolean) {
    setDraftGoal(null);
    setDraftError(null);
    setDraftBlocked(false);
    if (dismissed !== undefined) setDraftDismissed(dismissed);
    abandonCoordination();
  }

  function abandonCoordination() {
    draftEpoch.current += 1;
    const previous = coordinationRequest.current;
    coordinationRequest.current += 1;
    if (previous > 0) {
      void window.goalportCore?.coordinateCancel?.(coordinationGeneration(coordinationScope.current, previous));
    }
    setCoordination(null);
    setRoundProgress(null);
    // A selected Runtime send owns the busy flag until it settles. Clearing it
    // here re-enables Send while that send is still in flight, and the click
    // is then dropped.
    if (!draftInFlight.current) setDraftBusy(false);
  }

  // A plan that could not be persisted is returned with recorded=false: it
  // must not enter the plans list, because that list mirrors the persisted
  // records and its count keys the next send's command identity.
  async function rememberPlan(
    requestId: string,
    workspacePath: string,
    goal: string,
    view: CoordinationView,
  ): Promise<{ record: SavedPlan; recorded: boolean } | null> {
    if (!view.verdict || view.stopReason.toLowerCase().includes("replaced")) return null;
    const record: SavedPlan = { ...view, requestId, workspacePath, goal };
    const save = window.goalportCore?.coordinationSave;
    if (!save) return { record, recorded: true };
    try {
      const stamped = await save(record);
      return { record: stamped ?? record, recorded: true };
    } catch {
      setActiveNotice({ sentence: "The result is on screen, but it could not be saved for the next time you open GoalPort. Any changes already made are not undone; inspect the workspace before a new send." });
      return { record, recorded: false };
    }
  }

  function handleRevise(plan: SavedPlan) {
    if (window.innerWidth <= 860) setNavCollapsed(true);
    closeDraft(false);
    setSelectedPlanId(null);
    // A terminal execution-audit revision carries its completed execution
    // report and audit into the fresh draft as execution feedback; a plan-check
    // revision keeps the plan-revision inputs. Either way nothing is sent
    // until the user presses Send, and write consent starts OFF.
    const executionRevision = Boolean(plan.executionText || plan.auditText);
    setDraftGoal({
      requestId: freshRequestId(),
      baselineCampaignId: snapshot.activeCampaignId,
      workspace: plan.workspacePath,
      provider: "",
      message: plan.goal,
      revision: {
        planText: plan.planText,
        reviewText: plan.reviewText,
        ...(executionRevision ? {
          previousExecutionReport: plan.executionText ?? null,
          previousExecutionAudit: plan.auditText ?? null,
        } : {}),
      },
    });
  }

  // Continue a round whose harness proved it cannot run its tools on this
  // machine: a fresh draft of the same goal that assigns no role to that
  // harness. Nothing is sent until the user presses Send, and the new send is
  // a new round with its own grant — the failed round is never replayed.
  function handleSendAgainWithout(plan: SavedPlan) {
    const blocked = plan.environmentBlocked;
    if (!blocked) return;
    if (window.innerWidth <= 860) setNavCollapsed(true);
    closeDraft(false);
    setSelectedPlanId(null);
    setDraftGoal({
      requestId: freshRequestId(),
      baselineCampaignId: snapshot.activeCampaignId,
      workspace: plan.workspacePath,
      provider: "",
      message: plan.goal,
      avoid: {
        instanceId: blocked.instanceId,
        harness: blocked.harness ?? blocked.instanceId,
        startedAt: plan.savedAt ?? null,
      },
    });
  }

  function openReadyDraft(source: { workspace: string; message: string; note: string }) {
    if (window.innerWidth <= 860) setNavCollapsed(true);
    setSelectedPlanId(null);
    closeDraft(false);
    setBackgroundView(false);
    setDraftGoal({
      requestId: freshRequestId(),
      baselineCampaignId: snapshot.activeCampaignId,
      workspace: source.workspace,
      provider: "",
      message: source.message,
      readyNote: source.note,
    });
  }

  // Forget that this machine could not run the harness's tools. From a finished
  // result this also opens a new draft of the same goal; the failed round is
  // not replayed, and nothing is sent until Send. From the access panel the
  // draft already open stays put and the row becomes selectable.
  async function handleUseAgain(instanceId: string, continueFrom?: { workspacePath: string; goal: string; harness: string }) {
    const bridge = window.goalportCore;
    if (!bridge?.coordinationUnblock) return;
    try {
      await bridge.coordinationUnblock(instanceId);
    } catch {
      setActiveNotice({ sentence: "GoalPort could not forget that this harness was blocked. Try again in a moment." });
      return;
    }
    if (continueFrom) {
      openReadyDraft({
        workspace: continueFrom.workspacePath,
        message: continueFrom.goal,
        note: `${continueFrom.harness} can be used again. Nothing is sent until you press Send.`,
      });
      return;
    }
    if (!bridge.coordinateDiscover) return;
    try {
      const discovery = await bridge.coordinateDiscover();
      if (!discovery.connected) return;
      discoveredProvidersRef.current = discovery.providers;
      const forDraft = draftGoalRef.current;
      if (forDraft && panelRequestId === forDraft.requestId) {
        setPanelProviders(discovery.providers);
        const cleared = catalogFromProviderSnapshots(discovery.providers)
          .find((instance) => instance.instanceId === instanceId);
        if (cleared && !cleared.environmentAvoided && (cleared.billing === "subscription" || cleared.billing === "included")) {
          setSelectedInstances((current) => (current.includes(instanceId) ? current : [...current, instanceId]));
        }
      }
    } catch {
      // The row stays as it was; the next draft open discovers again.
    }
  }

  // Revoking ends the authorization: a round already in flight finishes
  // settling, and any new send needs a fresh authorization first.
  async function handleStopAllowing() {
    const bridge = window.goalportCore;
    if (!bridge?.coordinationRevoke) return;
    try {
      await bridge.coordinationRevoke();
    } catch {
      setActiveNotice({ sentence: "Harness access could not be stopped. Try again in a moment." });
      return;
    }
    setScopeMirror(null);
    setWriteInstances([]);
    setPanelChangeMode(false);
    // The finished round stays on screen, but its budget state belonged to
    // the revoked authorization: no authorization controls remain on it.
    setLiveRound(null);
  }

  // Change / Allow more turns land in the same place: the panel opens in
  // change mode on a draft of this goal. Saving there re-authorizes (a new
  // generation) and rotates the draft's request id, so the next Send is
  // explicitly a NEW round — nothing is sent automatically. A call from a
  // result card (fromTerminal) must not route into the panel of a finished
  // round's remnant draft, where it would be an invisible no-op: it always
  // takes the fresh change-mode draft path.
  function handleChangeHarnessAccess(source: { workspacePath: string; goal: string } | null, fromTerminal = false) {
    if (draftGoal && !fromTerminal) {
      setPanelChangeMode(true);
      return;
    }
    const plan = source ?? selectedPlan;
    if (!plan) return;
    if (window.innerWidth <= 860) setNavCollapsed(true);
    closeDraft(false);
    setSelectedPlanId(null);
    openPanelInChangeMode.current = true;
    setDraftGoal({
      requestId: freshRequestId(),
      baselineCampaignId: snapshot.activeCampaignId,
      workspace: plan.workspacePath,
      provider: "",
      message: plan.goal,
    });
  }

  async function handleConfirmAccessChange() {
    const bridge = window.goalportCore;
    if (!bridge?.coordinationAuthorize) return;
    if (selectedInstances.length < 2) {
      setDraftError({ sentence: "An independent check needs two harnesses that can run, so select at least two." });
      return;
    }
    let authorized: { ok: boolean; generation: number; remaining: number; errorText?: string };
    try {
      if (writeInstances.length > 0 && (!Number.isInteger(writeTurns) || writeTurns < 1 || writeTurns > 8 || !draftGoal?.workspace.trim())) {
        setDraftError({ sentence: "Choose a workspace and 1 to 8 write turns before allowing changes." });
        return;
      }
      authorized = await bridge.coordinationAuthorize({ instances: [...selectedInstances], maxTurns: allowedTurns, workspaceRoot: draftGoal?.workspace.trim(),
        ...(writeInstances.length > 0 ? { write: { instances: [...writeInstances], maxTurns: writeTurns, workspaceRoot: draftGoal!.workspace.trim() } } : {}) });
    } catch (error) {
      setDraftError({
        sentence: "Harness access could not be updated.",
        technical: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    if (authorized.ok !== true) {
      setDraftError({ sentence: authorized.errorText?.trim() || "Harness access could not be updated, so nothing changed." });
      return;
    }
    setDraftError(null);
    setScopeMirror({
      instances: [...selectedInstances],
      maxTurns: allowedTurns,
      remaining: authorized.remaining,
      generation: authorized.generation
    });
    setLiveRound((current) => (current
      ? { ...current, turnsLeft: authorized.remaining, maxTurns: allowedTurns, exhausted: false }
      : current));
    setPanelChangeMode(false);
    // The saved change makes the next Send a new round, never a replay of the
    // round whose record already carries this draft's old request id. The
    // rotation below re-keys the panel effect; flag it to keep the write
    // instances/turns and background consent the user just saved.
    preservePanelSelections.current = true;
    setDraftGoal((current) => (current ? { ...current, requestId: freshRequestId(), intent: undefined } : current));
  }

  async function handleContinueBackgroundJob() {
    const job = backgroundJob;
    if (!job) return;
    const interrupted = job.state === "unconfirmed" || Boolean(job.pendingCommand);
    let current = job;
    const finishedButStillActive = job.active && !job.live && !job.pendingCommand && (job.state === "completed" || job.state === "failed" || job.state === "stopped") && Boolean(job.outcome);
    if (finishedButStillActive) {
      const release = window.goalportCore?.backgroundReleaseTerminal;
      if (!release) {
        setActiveNotice({ sentence: "This finished goal is still in the way, so a new send was not opened." });
        return;
      }
      try {
        const next = await release(job.jobId);
        current = next;
        setBackgroundJob(next);
      } catch (error) {
        setActiveNotice({
          sentence: "This finished goal is still in the way, so a new send was not opened.",
          technical: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (interrupted && !job.acknowledgedStuckAt) {
      const acknowledge = window.goalportCore?.backgroundAcknowledge;
      if (!acknowledge) {
        setActiveNotice({ sentence: "This build cannot leave the interrupted job, so a new send was not opened." });
        return;
      }
      try {
        const next = await acknowledge(job.jobId);
        current = next;
        setBackgroundJob(next);
      } catch (error) {
        setActiveNotice({
          sentence: "The interrupted job is still in the way, so no new send was opened.",
          technical: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    // A confirmed finished job releases its folder; the SAME folder may be
    // sent again and is prefilled. An interrupted job only frees the profile
    // slot: inspectPriorAdmissions keeps its folder held until a confirmed
    // terminal outcome, so this draft must not offer that folder.
    const heldFolder = interrupted && !confirmedTerminalJob(current) && Boolean(current.acknowledgedStuckAt)
      ? (current.workspacePath ?? "")
      : "";
    openReadyDraft({
      workspace: heldFolder ? "" : (current.workspacePath ?? ""),
      message: current.goal,
      note: heldFolder
        ? `The interrupted turn was not replayed. ${workspaceFolder(heldFolder)} stays reserved until its exit is confirmed, so choose a different folder for this new send. Nothing goes out until you press Send.`
        : interrupted
          ? "The interrupted turn was not replayed. This is a new send, and nothing goes out until you press Send."
          : "This is a new send for the same goal. Nothing goes out until you press Send.",
    });
  }

  function handleNewGoal() {
    if (client.mode === "linux-core" && (linuxActionBusy || linuxGranting || linuxCoordinationLive)) return;
    if (client.mode === "linux-core") { linuxHoldLineRef.current = false; heldJobId.current = null; grantAllowed.current = false; setLinuxHoldLine(false); }
    if (window.innerWidth <= 860) setNavCollapsed(true);
    setSelectedPlanId(null);
    const acceptNextCampaign = draftInFlight.current;
    closeDraft(false);
    setDraftGoal({
      requestId: freshRequestId(),
      baselineCampaignId: snapshot.activeCampaignId,
      acceptNextCampaign,
      workspace: client.mode === "linux-core" ? (linuxCoordinationWorkspace || "") : (snapshot.project.workspaceRoot || ""),
      provider: "",
      message: ""
    });
    if (client.mode === "linux-core" && !linuxCoordinationLive) {
      linuxFreshDraft.current = true;
      setLinuxShowingFreshDraft(true);
    }
  }

  function handleDiscardDraft() {
    if (client.mode === "linux-core" && (linuxCoordinationGoal || linuxCoordinationLive)) {
      setDraftGoal((current) => current ? { ...current, message: "" } : current);
      setDraftError(null);
      return;
    }
    closeDraft(true);
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
    const heldByResidualBackground = conversationHeldByBackground;
    if (heldByResidualBackground) {
      setActiveNotice({ sentence: HELD_CONVERSATION_SENTENCE });
      return;
    }
    if (backgroundSlotBlocked) {
      setActiveNotice({ sentence: backgroundSlotSentence });
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
    if (conversationHeldByBackground) {
      setActiveNotice({ sentence: HELD_CONVERSATION_SENTENCE });
      return;
    }
    if (backgroundSlotBlocked) {
      setActiveNotice({ sentence: backgroundSlotSentence });
      return;
    }
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
    // Preview has no Core command receipt. A missing receipt there is not a
    // failed resume; the session state below is the result.
    const failure = client.mode === "browser-preview" ? null : commandFailure(next, "resume_native_session");
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
    if (!known) return;
    // Explicit navigation closes a pending draft first — also for the
    // already-active goal, where the early return below used to keep a
    // planning draft mounted over the conversation.
    if (draftGoal) closeDraft(true);
    // Narrow widths: choosing any goal, including the active one, puts the
    // drawer away so the conversation is what the user sees next.
    if (window.innerWidth <= 860) setNavCollapsed(true);
    if (campaignId === snapshot.activeCampaignId) return;
    if (client.mode === "linux-core") pushGoalRoute(campaignId);
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
    if (client.mode !== "linux-core") return undefined;
    let cancelled = false;
    let generation = 0;
    let inFlight = false;
    const refresh = () => {
      if (inFlight || linuxActionOpen.current) return;
      inFlight = true;
      const request = ++generation;
      const settledAtStart = linuxActionSettled.current;
      const epochAtStart = linuxStatusEpoch.current;
      void fetch("/goalport/ipc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageType: "coordination_latest", payload: {} }),
      }).then(async (response) => (response.ok ? response.json() : null)).then((body) => {
        if (cancelled || request !== generation || linuxActionOpen.current || settledAtStart !== linuxActionSettled.current || epochAtStart !== linuxStatusEpoch.current || !body || typeof body !== "object") return;
        const payload = (body as { payload?: { line?: unknown; jobId?: unknown; leftRequestIds?: unknown; unconfirmedGoal?: unknown; leftoverHeld?: unknown; record?: { verdict?: unknown; planningHarness?: unknown; reviewHarness?: unknown; requestId?: unknown; goal?: unknown; workspacePath?: unknown; outcome?: unknown; detail?: unknown; change?: unknown } | null; reason?: unknown } }).payload;
        if (Array.isArray(payload?.leftRequestIds)) {
          let added = false;
          for (const id of payload.leftRequestIds) {
            if (typeof id === "string" && id && !leftRequestIds.current.has(id)) {
              leftRequestIds.current.add(id);
              added = true;
            }
          }
          if (added) setLeftRevision((value) => value + 1);
        }
        if (payload?.unconfirmedGoal === true && !(linuxRequestRef.current && leftRequestIds.current.has(linuxRequestRef.current))) setSidebarUnconfirmed(true);
        setLinuxLeftoverHeld(payload?.leftoverHeld === true);
        const jobLeft = typeof payload?.jobId === "string" && leftJobIds.current.has(payload.jobId);
        const liveJob = !jobLeft && typeof payload?.line === "string" && payload.line && typeof payload?.jobId === "string" && payload.jobId;
        const workerGoneLine = payload?.line === "The worker is gone. Its exit is not confirmed, so another goal cannot start yet.";
        const exitUnconfirmed = payload?.line === "This goal's exit is not confirmed, so another goal cannot start yet.";
        if (grantAllowed.current && !liveJob && !workerGoneLine && !exitUnconfirmed) return;
        if (linuxHoldLineRef.current && !workerGoneLine && !exitUnconfirmed && !liveJob) {
          setLinuxCoordinationLive(false);
          return;
        }
        if (linuxHoldLineRef.current && !workerGoneLine && !exitUnconfirmed && typeof payload?.jobId === "string" && payload.jobId === heldJobId.current) return;
        if (liveJob && typeof payload?.line === "string" && typeof payload.jobId === "string") {
          grantAllowed.current = false;
          linuxHoldLineRef.current = false;
          heldJobId.current = null;
          setLinuxHoldLine(false);
          seenJobId.current = payload.jobId;
          linuxFreshDraft.current = false;
          setLinuxShowingFreshDraft(false);
          setLinuxCoordinationLine(payload.line);
          if (payload.line !== "This goal's exit is not confirmed, so another goal cannot start yet." && payload.line !== "The worker is gone. Its exit is not confirmed, so another goal cannot start yet.") {
            setSidebarUnconfirmed(false);
          }
          setLinuxCoordinationDetail(null);
          setLinuxCoordinationChange(null);
          setLinuxCoordinationRequest(null);
          setLinuxCoordinationLive(true);
          return;
        }
        if (linuxFreshDraft.current) return;
        setLinuxCoordinationLive(false);
        const record = payload?.record;
        if (record && typeof record.goal === "string" && record.goal.trim()) setLinuxCoordinationGoal(record.goal);
        if (record && typeof record.workspacePath === "string" && record.workspacePath.trim()) {
          const goalFolder = record.workspacePath.trim();
          setLinuxCoordinationWorkspace(goalFolder);
          if (!linuxFreshDraft.current) {
            setDraftGoal((current) => {
              if (!current || current.workspace === goalFolder) return current;
              const coreDefault = snapshotRef.current.project.workspaceRoot || "";
              if (current.workspace !== "" && current.workspace !== coreDefault) return current;
              return { ...current, workspace: goalFolder };
            });
          }
        }
        if (!record || typeof record.verdict !== "string") {
          if (payload?.reason === "no coordination profile configured") {
            setLinuxCoordinationRequest(null);
            setLinuxCoordinationLine("No coordinated result is saved for this workbench profile.");
          }
          return;
        }
        const planned = typeof record.planningHarness === "string" ? record.planningHarness : "One harness";
        const checked = typeof record.reviewHarness === "string" ? record.reviewHarness : "another";
        setLinuxCoordinationRequest(typeof record.requestId === "string" ? record.requestId : null);
        const outcome = typeof record.outcome === "string" && record.outcome.trim() ? record.outcome.trim() : null;
        setLinuxCoordinationLine(outcome
          ? `${record.verdict}. ${outcome}`
          : `Last coordinated goal: ${record.verdict}. ${planned} planned, ${checked} checked.`);
        setLinuxCoordinationDetail(typeof record.detail === "string" && record.detail.trim() ? record.detail.trim() : null);
        setLinuxCoordinationChange(typeof record.change === "string" && record.change.trim() ? record.change.trim() : null);
      }).catch(() => { /* a failed read is not a missing goal; keep the last line */ }).finally(() => { inFlight = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, linuxCoordinationLive ? 2000 : 8000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [client.mode, linuxCoordinationLive]);

  const leftoverSlotLine = client.mode === "linux-core" && linuxLeftoverHeld && !linuxCoordinationLive && !linuxActionBusy && !linuxHoldLine
    ? (linuxCoordinationRequest && !linuxShowingFreshDraft && !sidebarUnconfirmed && !leftUnreplayed && !linuxHarnessSentence && !linuxConsentMissing && backgroundConsent && linuxDiscoverChecked && !leftRequestIds.current.has(linuxCoordinationRequest)
      ? "A left goal still holds the slot. The next valid send or continue will release it."
      : "A left goal still holds the slot. The next valid send will release it.")
    : null;

  useEffect(() => {
    if (client.mode !== "linux-core") return undefined;
    const previous = document.title;
    const goal = !linuxShowingFreshDraft && linuxCoordinationGoal ? linuxCoordinationGoal.trim() : "";
    const short = goal.length > 48 ? `${goal.slice(0, 45)}...` : goal;
    const pending = linuxCoordinationLine === "Sending." || linuxCoordinationLine === "Continuing." || linuxCoordinationLine === "Stopping this goal." || linuxCoordinationLine === "Recording the stop." || linuxCoordinationLine === "Allowing Background Send." || linuxCoordinationLine === "Leaving this unreplayed.";
    document.title = pending || linuxHoldLine ? linuxCoordinationLine : linuxHarnessSentence && !linuxCoordinationLive ? linuxHarnessSentence : linuxCoordinationLine === "Background Send is allowed." ? linuxCoordinationLine : linuxConsentMissing && !linuxCoordinationLive ? "Background Send is not ready in this GoalPort window yet." : leftoverSlotLine ? (short ? `${short} — slot held` : leftoverSlotLine) : (short ? (workerGone ? `${short} — worker gone` : sidebarUnconfirmed ? `${short} — not confirmed` : leftUnreplayed ? `${short} — unreplayed` : linuxCoordinationLive ? `${short} — running` : short) : linuxShowingFreshDraft ? "New goal" : "GoalPort");
    return () => { document.title = previous; };
  }, [client.mode, linuxShowingFreshDraft, linuxCoordinationGoal, linuxCoordinationLive, linuxCoordinationLine, linuxCoordinationRequest, linuxHoldLine, sidebarUnconfirmed, linuxHarnessSentence, linuxConsentMissing, linuxLeftoverHeld, linuxActionBusy, leftUnreplayed, backgroundConsent, linuxDiscoverChecked]);

  useEffect(() => {
    if (client.mode !== "linux-core") return undefined;
    let cancelled = false;
    let generation = 0;
    let inFlight = false;
    const check = () => {
      if (inFlight) return;
      inFlight = true;
      const request = ++generation;
      void fetch("/goalport/ipc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageType: "coordination_discover", payload: {} }),
      }).then(async (response) => response.json().catch(() => null)).then((body) => {
        if (cancelled || request !== generation) return;
        const unchecked = "The signed-in harnesses could not be checked, so nothing will be sent.";
        if (!body || typeof body !== "object" || (body as { ok?: unknown }).ok === false) {
          const error = (body as { error?: unknown } | null)?.error;
          setLinuxHarnessSentence(typeof error === "string" && error.trim() ? error.trim() : unchecked);
          setLinuxSignedIn([]);
          setLinuxDiscoverChecked(true);
          return;
        }
        const payload = (body as { payload?: { sentence?: unknown; consentMissing?: unknown; harnesses?: unknown } }).payload;
        const sentence = payload?.sentence;
        const consentStillMissing = payload?.consentMissing === true;
        if (consentStillMissing && grantAllowed.current) {
          grantAllowed.current = false;
          setLinuxCoordinationLine("Background Send is not ready in this GoalPort window yet.");
        }
        if (!(grantError.current && consentStillMissing)) {
          if (!consentStillMissing) grantError.current = false;
          const names = Array.isArray(payload?.harnesses) ? payload.harnesses.filter((name): name is string => typeof name === "string" && name.trim().length > 0) : [];
          const reported = typeof sentence === "string" && sentence.trim() ? sentence.trim() : null;
          setLinuxHarnessSentence(reported ?? (names.length === 0 ? "No signed-in subscription harness was found on this machine, so nothing will be sent." : names.length < 2 ? "An independent check needs a second logged-in harness, so nothing will be sent." : null));
        }
        setLinuxConsentMissing(consentStillMissing);
        setLinuxSignedIn(Array.isArray(payload?.harnesses) ? payload.harnesses.filter((name): name is string => typeof name === "string" && name.trim().length > 0) : []);
        setLinuxDiscoverChecked(true);
      }).catch(() => { if (!cancelled && request !== generation) return; if (!cancelled) { setLinuxHarnessSentence("The signed-in harnesses could not be checked, so nothing will be sent."); setLinuxSignedIn([]); setLinuxDiscoverChecked(true); } }).finally(() => { inFlight = false; });
    };
    check();
    const timer = window.setInterval(check, linuxHarnessSentence ? 2000 : 8000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [client.mode, linuxCoordinationGoal, linuxShowingFreshDraft, linuxHarnessSentence, linuxDiscoverNonce]);

  useEffect(() => {
    if (client.mode !== "linux-core" || linuxShowingFreshDraft || !linuxCoordinationWorkspace || !draftGoal) return;
    const coreDefault = snapshot.project.workspaceRoot || "";
    if (draftGoal.workspace === linuxCoordinationWorkspace) return;
    if (draftGoal.workspace !== "" && draftGoal.workspace !== coreDefault) return;
    setDraftGoal({ ...draftGoal, workspace: linuxCoordinationWorkspace });
  }, [client.mode, linuxShowingFreshDraft, linuxCoordinationWorkspace, draftGoal, snapshot.project.workspaceRoot]);

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
  // The live overlay exists only for the round that just ran in this window
  // and only while its request id is the one selected. A reloaded or
  // historical record never matches, so it renders without any of it.
  const selectedPlanOverlay = liveRound !== null && selectedPlan !== null
    && selectedPlan.requestId === liveRound.requestId && liveRound.scoped
    ? liveRound
    : null;
  const draftOverlay = liveRound !== null && liveRound.scoped && liveRound.requestId === draftGoal?.requestId
    ? liveRound
    : null;
  const roundSummaryLine = (planning: string | null, review: string | null, plan: string | null, check: string | null): string | null =>
    planning && review && plan && check
      ? `${planning} planned and ${review} checked — the harnesses you authorized that can run.`
      : null;
  const unblockAvailable = Boolean(window.goalportCore?.coordinationUnblock);

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
        campaignTitle={hasGoal && !(backgroundView && backgroundJob) ? title : null}
        workspaceLabel={backgroundView && backgroundJob?.workspacePath ? workspaceFolder(backgroundJob.workspacePath) : client.mode === "linux-core" && linuxCoordinationWorkspace && !linuxShowingFreshDraft && !leftUnreplayed ? workspaceFolder(linuxCoordinationWorkspace) : null}
        workspaceTitle={backgroundView && backgroundJob?.workspacePath ? backgroundJob.workspacePath : client.mode === "linux-core" && linuxCoordinationWorkspace && !linuxShowingFreshDraft && !leftUnreplayed ? linuxCoordinationWorkspace : null}
        appInfo={appInfo}
        navCollapsed={navCollapsed}
        onToggleNav={() => setNavCollapsed((value) => !value)}
        detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen((value) => !value)}
        onOpenDiagnostics={() => setDiagnosticsOpen(true)}
        onNewGoal={() => { if (client.mode === "linux-core" && (linuxActionBusy || linuxGranting || linuxCoordinationLive)) return; backgroundAttached.current = true; setBackgroundView(false); handleNewGoal(); }}
        newGoalDisabled={client.mode === "linux-core" && (linuxActionBusy || linuxGranting || linuxCoordinationLive)}
        onOpenAbout={() => setAboutOpen(true)}
        onReconnect={handleReconnect}
        onCloseWindow={handleCloseWindow}
      />

      <div className={`workspace-grid${navCollapsed ? " nav-collapsed" : ""}`}>
        {!navCollapsed ? <button className="mobile-nav-backdrop" type="button" aria-label="Close navigation" onClick={() => setNavCollapsed(true)} /> : null}
        <CampaignNav
          snapshot={snapshot}
          collapsed={navCollapsed}
          plans={plans.map((plan) => ({
            requestId: plan.requestId,
            title: plan.goal,
            active: plan.requestId === selectedPlanId,
            verdict: plan.verdict,
            savedAt: plan.savedAt,
          }))}
          onSelectPlan={(requestId) => {
            backgroundAttached.current = true; setBackgroundView(false);
            closeDraft(false);
            setSelectedPlanId(requestId);
          }}
          navigationLocked={client.mode === "linux-core" && (linuxActionBusy || linuxGranting || linuxCoordinationLive)}
          onSelectCampaign={(campaignId) => {
            if (client.mode === "linux-core" && (linuxActionBusy || linuxGranting)) return;
            backgroundAttached.current = true; setBackgroundView(false);
            setSelectedPlanId(null);
            void selectCampaign(campaignId);
          }}
          onSelectProject={(projectId) => { if (client.mode === "linux-core" && (linuxActionBusy || linuxGranting)) return; void selectProject(projectId); }}
          onRenameCampaign={(campaignId, renameTitle) => { void handleRenameCampaign(campaignId, renameTitle); }}
          runningJob={backgroundJob ? {
            goal: backgroundJob.goal,
            viewing: backgroundView,
            stateLabel: backgroundJob.state === "unconfirmed" ? "Interrupted" : backgroundJob.revoked ? "Stopped" : backgroundJob.live ? "Running" : "Finished",
          } : client.mode === "linux-core" && linuxCoordinationGoal ? {
            goal: linuxCoordinationGoal,
            viewing: !linuxShowingFreshDraft,
            locked: linuxActionBusy,
            stateLabel: (linuxActionBusy || linuxGranting) && (linuxCoordinationLine === "Sending." || linuxCoordinationLine === "Stopping this goal." || linuxCoordinationLine === "Recording the stop." || linuxCoordinationLine === "Continuing." || linuxCoordinationLine === "Leaving this unreplayed." || linuxCoordinationLine === "Allowing Background Send.") ? linuxCoordinationLine : workerGone ? "Worker gone" : sidebarUnconfirmed ? "Not confirmed" : leftUnreplayed ? "Unreplayed" : linuxCoordinationLive ? "Running" : "Finished",
          } : null}
          onOpenRunningJob={() => { if (client.mode === "linux-core" && (linuxActionBusy || linuxGranting)) return; if (window.innerWidth <= 860) setNavCollapsed(true); if (backgroundJob) setBackgroundView(true); else { linuxFreshDraft.current = false; setLinuxShowingFreshDraft(false); } }}
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

          {draftError && ((backgroundView && backgroundJob) || selectedPlan) ? (
            <div className="dialog-note" role="alert">
              <span aria-hidden="true">!</span>
              <span>
                {draftError.sentence}
                {draftError.technical ? (
                  <details className="technical-details">
                    <summary>Technical details</summary>
                    <pre className="technical-details-pre">{draftError.technical}</pre>
                  </details>
                ) : null}
              </span>
            </div>
          ) : null}
          {backgroundJob ? <div className="background-return"><button type="button" className="button button-outline" onClick={() => { if (!backgroundView && window.innerWidth <= 860) setNavCollapsed(true); setBackgroundView(value => !value); }}>{backgroundView ? "Leave job view" : "Return to background goal"}</button></div> : null}
          {backgroundView && backgroundJob ? <div className="timeline-scroll" tabIndex={-1} aria-label="Background job progress">
            <BackgroundCoordinationStatus job={backgroundJob} onContinue={!backgroundJob.live ? () => { void handleContinueBackgroundJob(); } : undefined} onStopAllowing={() => {
              void window.goalportCore?.backgroundRevoke?.(backgroundJob.jobId).then(setBackgroundJob).catch(() => setBackgroundJob(job => job ? { ...job, live: false, state: "unconfirmed" } : null));
            }} />
          </div> : selectedPlan ? (
            <div className="timeline-scroll" tabIndex={-1} aria-label="Saved plan">
              <CoordinationStatus
                goal={selectedPlan.goal}
                planningHarness={selectedPlan.planningHarness}
                reviewHarness={selectedPlan.reviewHarness}
                planText={selectedPlan.planText}
                reviewText={selectedPlan.reviewText}
                executionText={selectedPlan.executionText}
                auditText={selectedPlan.auditText}
                executionHarness={selectedPlan.executionHarness}
                auditHarness={selectedPlan.auditHarness}
                verdict={selectedPlan.verdict}
                stopReason={selectedPlan.stopReason}
                planningQuota={selectedPlan.planningQuota}
                reviewQuota={selectedPlan.reviewQuota}
                savedAt={selectedPlan.savedAt}
                onRevise={selectedPlan.verdict === "revise" ? () => handleRevise(selectedPlan) : undefined}
                environmentBlocked={selectedPlan.environmentBlocked ?? null}
                environmentAlternatives={environmentAlternatives(selectedPlan.environmentBlocked)}
                onSendAgainWithout={selectedPlan.environmentBlocked ? () => handleSendAgainWithout(selectedPlan) : undefined}
                roundEvents={selectedPlan.roundEvents ?? []}
                feedbackHistory={selectedPlan.feedbackHistory ?? []}
                planRevisionHistory={selectedPlan.planRevisionHistory ?? []}
                onUseAgain={selectedPlan.environmentBlocked && unblockAvailable
                  ? () => { void handleUseAgain(selectedPlan.environmentBlocked!.instanceId, {
                    workspacePath: selectedPlan.workspacePath,
                    goal: selectedPlan.goal,
                    harness: selectedPlan.environmentBlocked!.harness ?? selectedPlan.environmentBlocked!.instanceId,
                  }); }
                  : undefined}
                roundSummary={selectedPlanOverlay
                  ? roundSummaryLine(selectedPlan.planningHarness, selectedPlan.reviewHarness, selectedPlan.planText, selectedPlan.reviewText)
                  : null}
                budget={selectedPlanOverlay && selectedPlanOverlay.turnsLeft !== null && selectedPlanOverlay.maxTurns !== null
                  ? { remaining: selectedPlanOverlay.turnsLeft, maxTurns: selectedPlanOverlay.maxTurns }
                  : null}
                writeBudget={selectedPlanOverlay && selectedPlanOverlay.maxWriteTurns !== null
                  ? { remaining: selectedPlanOverlay.writeTurnsLeft, maxTurns: selectedPlanOverlay.maxWriteTurns } : null}
                scopeExhausted={selectedPlanOverlay?.exhausted === true}
                onAllowMoreTurns={selectedPlanOverlay ? () => handleChangeHarnessAccess(selectedPlan, true) : undefined}
                onChangeAccess={selectedPlanOverlay ? () => handleChangeHarnessAccess(selectedPlan, true) : undefined}
                onStopAllowing={selectedPlanOverlay ? () => { void handleStopAllowing(); } : undefined}
              />
            </div>
          ) : draftActive ? (
            <div className="timeline-scroll" tabIndex={-1} aria-label={client.mode === "linux-core" && (linuxActionBusy || linuxGranting || linuxHoldLine) ? linuxCoordinationLine : client.mode === "linux-core" && linuxHarnessSentence && !linuxCoordinationLive ? linuxHarnessSentence : client.mode === "linux-core" && linuxCoordinationLine === "Background Send is allowed." ? linuxCoordinationLine : client.mode === "linux-core" && linuxConsentMissing && !linuxCoordinationLive ? "Background Send is not ready in this GoalPort window yet." : leftoverSlotLine ? (client.mode === "linux-core" && !linuxShowingFreshDraft && linuxCoordinationGoal ? `${linuxCoordinationGoal} — slot held` : leftoverSlotLine) : (leftUnreplayed && !linuxShowingFreshDraft ? "The interrupted job stays unreplayed; the same request id cannot be admitted again." : client.mode === "linux-core" && !linuxShowingFreshDraft && linuxCoordinationGoal && sidebarUnconfirmed ? `${linuxCoordinationGoal} — not confirmed` : client.mode === "linux-core" && !linuxShowingFreshDraft && linuxCoordinationGoal && !leftUnreplayed ? linuxCoordinationGoal : "New goal")}>
              {coordination ? (
                <CoordinationStatus
                  goal={draftGoal?.message}
                  planningHarness={coordination.planningHarness}
                  reviewHarness={coordination.reviewHarness}
                  planText={coordination.planText}
                  reviewText={coordination.reviewText}
                  executionText={coordination.executionText}
                  auditText={coordination.auditText}
                  executionHarness={coordination.executionHarness}
                  auditHarness={coordination.auditHarness}
                  verdict={coordination.verdict}
                  stopReason={coordination.stopReason}
                  planningQuota={coordination.planningQuota}
                  reviewQuota={coordination.reviewQuota}
                  environmentBlocked={coordination.environmentBlocked ?? null}
                  environmentAlternatives={environmentAlternatives(coordination.environmentBlocked)}
                  onSendAgainWithout={() => handleSendAgainWithout({
                    requestId: draftGoal?.requestId ?? "",
                    goal: draftGoal?.message ?? "",
                    workspacePath: draftGoal?.workspace ?? "",
                    ...coordination,
                    savedAt: null,
                  })}
                  roundEvents={coordination.roundEvents ?? []}
                  feedbackHistory={coordination.feedbackHistory ?? []}
                  planRevisionHistory={coordination.planRevisionHistory ?? []}
                  onUseAgain={coordination.environmentBlocked && unblockAvailable
                    ? () => { void handleUseAgain(coordination.environmentBlocked!.instanceId, {
                      workspacePath: draftGoal?.workspace ?? "",
                      goal: draftGoal?.message ?? "",
                      harness: coordination.environmentBlocked!.harness ?? coordination.environmentBlocked!.instanceId,
                    }); }
                    : undefined}
                  roundSummary={draftOverlay
                    ? roundSummaryLine(coordination.planningHarness, coordination.reviewHarness, coordination.planText, coordination.reviewText)
                    : null}
                  budget={draftOverlay && draftOverlay.turnsLeft !== null && draftOverlay.maxTurns !== null
                    ? { remaining: draftOverlay.turnsLeft, maxTurns: draftOverlay.maxTurns }
                    : null}
                  writeBudget={draftOverlay && draftOverlay.maxWriteTurns !== null
                    ? { remaining: draftOverlay.writeTurnsLeft, maxTurns: draftOverlay.maxWriteTurns } : null}
                  scopeExhausted={draftOverlay?.exhausted === true}
                  onAllowMoreTurns={draftOverlay ? () => handleChangeHarnessAccess(null, true) : undefined}
                  onChangeAccess={draftOverlay ? () => handleChangeHarnessAccess(null, true) : undefined}
                  onStopAllowing={draftOverlay ? () => { void handleStopAllowing(); } : undefined}
                />
              ) : null}
              {draftGoal?.revision ? (
                <p className="revision-note">
                  {draftGoal.revision.previousExecutionAudit || draftGoal.revision.previousExecutionReport
                    ? "Continuing from a completed execution round. The earlier plan, changes and independent audit are below."
                    : "Revising a saved plan. The earlier plan stays in Plans."}
                  {draftGoal.revision.previousExecutionAudit
                    ? `\n\nThe independent audit said:\n${draftGoal.revision.previousExecutionAudit}`
                    : draftGoal.revision.reviewText
                      ? `\n\nThe check said:\n${draftGoal.revision.reviewText}`
                      : ""}
                </p>
              ) : null}
              {draftGoal?.readyNote ? (
                <p className="revision-note">{draftGoal.readyNote}</p>
              ) : null}
              {draftGoal?.avoid ? (
                <p className="revision-note">
                  This send will not use {draftGoal.avoid.harness}, which could not run its tools on this machine
                  {draftGoal.avoid.startedAt ? ` in the round started ${formatTimestamp(draftGoal.avoid.startedAt)}` : ""}.
                </p>
              ) : null}
              {roundProgress !== null && roundProgress.requestId === draftGoal?.requestId ? (
                <CoordinationProgress
                  failures={roundProgress.failures}
                  activity={roundProgress.activity}
                  repair={roundProgress.repair === true}
                  planRevision={roundProgress.planRevision === true}
                  remaining={scopeMirror?.remaining ?? null}
                  maxTurns={scopeMirror?.maxTurns ?? null}
                  writeRemaining={scopeMirror?.write?.remaining ?? null}
                  maxWriteTurns={scopeMirror?.write?.maxTurns ?? null}
                  onStopAllowing={scopeBridgeReady ? () => { void handleStopAllowing(); } : undefined}
                />
              ) : (
                <>
                  <DraftGoalComposer
                    draft={draftGoal ?? { workspace: (!linuxShowingFreshDraft && linuxCoordinationWorkspace) || snapshot.project.workspaceRoot || "", provider: "", message: "" }}
                    runtimes={snapshot.runtimes}
                    connected={snapshot.connection === "connected"}
                    busy={draftBusy}
                    blockedFromSending={draftBlocked || draftHeld || backgroundSlotBlocked || linuxCoordinationLive || linuxActionBusy || (client.mode === "linux-core" && !linuxDiscoverChecked) || (client.mode === "linux-core" && linuxDiscoverChecked && linuxSignedIn.length < 2) || Boolean(linuxHarnessSentence) || linuxConsentMissing || (client.mode === "linux-core" && !backgroundConsent) || (Boolean(window.goalportCore?.backgroundSendConsent) && draftGoal?.provider.trim() === "" && !coordinationAvailable) || (backgroundConsent && client.mode !== "linux-core" && appInfo?.coordinationConfigured !== true) || Boolean(snapshot.bounds?.projectionUnavailable && !draftRetryLabel)}
                    waitingOn={panelHoldsSend
                      ? (panelLoad === "failed"
                        ? "Send is waiting: your harness-access choices could not be loaded."
                        : "Checking which harnesses can work on this goal… Send unlocks once your harness-access choices are ready.")
                      : null}
                    retryLabel={draftRetryLabel}
                    error={draftHeld ? { sentence: draftHeldSentence } : backgroundSlotBlocked ? { sentence: backgroundSlotSentence } : draftError}
                    canBrowse={client.mode === "electron" && Boolean(client.chooseWorkspace)}
                    coordinationAvailable={coordinationAvailable}
                    runtimeRequiredHint={client.mode === "linux-core" ? linuxRuntimeRequired : undefined}
                    linuxCanStartCoordination={client.mode === "linux-core"}
                    linuxWrite={client.mode === "linux-core" ? linuxWrite : false}
                    onLinuxWriteChange={client.mode === "linux-core" ? setLinuxWrite : undefined}
                    inputsLocked={client.mode === "linux-core" && (linuxActionBusy || linuxGranting)}
                    coordinationResult={client.mode === "linux-core" && (linuxActionBusy || linuxGranting || linuxHoldLine || linuxCoordinationLine === "Background Send is allowed." || !linuxShowingFreshDraft) ? (sidebarUnconfirmed && !linuxActionBusy && !linuxGranting && !linuxHoldLine && !leftUnreplayed ? (linuxCoordinationLive ? "This goal's exit is not confirmed, so another goal cannot start yet." : "This goal's exit is not confirmed.") : leftUnreplayed && !linuxActionBusy && !linuxGranting ? "The interrupted job stays unreplayed; the same request id cannot be admitted again." : linuxCoordinationLine) : null}
                    failureHeadline={client.mode === "linux-core" && linuxHoldLine ? linuxCoordinationLine : null}
                    goalDetail={client.mode === "linux-core" && !linuxShowingFreshDraft && !linuxCoordinationLive && !sidebarUnconfirmed && !leftUnreplayed ? linuxCoordinationDetail : null}
                    goalChange={client.mode === "linux-core" && !linuxShowingFreshDraft && !linuxCoordinationLive && !sidebarUnconfirmed && !leftUnreplayed ? linuxCoordinationChange : null}
                    activeGoalTitle={client.mode === "linux-core" && !linuxShowingFreshDraft ? linuxCoordinationGoal : null}
                    stopLabel={workerGone || linuxCoordinationLine === "This goal's exit is not confirmed, so another goal cannot start yet." ? "Record the stop" : "Stop this goal"}
                    onLeaveGoal={workerGone || linuxCoordinationLine === "Leaving this unreplayed." ? () => {
                      if (linuxActionBusy) return;
                      const statusEpoch = ++linuxStatusEpoch.current;
                      linuxActionOpen.current = true;
                      setLinuxActionBusy(true);
                      setLinuxCoordinationLine("Leaving this unreplayed.");
                      void fetch("/goalport/ipc", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ messageType: "coordination_acknowledge", payload: {} }),
                      }).then(async (response) => response.json().catch(() => null)).then((body) => {
                        if (statusEpoch !== linuxStatusEpoch.current) return;
                        linuxActionSettled.current = statusEpoch;
                        if (body && body.ok !== false && !(typeof body.error === "string" && body.error.trim())) {
                          setLinuxCoordinationLive(false);
                          setLinuxLeftoverHeld(false);
                          linuxHoldLineRef.current = false;
                          setLinuxHoldLine(false);
                          setSidebarUnconfirmed(false);
                          if (linuxCoordinationRequest) leftRequestIds.current.add(linuxCoordinationRequest);
                          if (seenJobId.current) leftJobIds.current.add(seenJobId.current);
                          setLinuxCoordinationLine("The interrupted job stays unreplayed; the same request id cannot be admitted again.");
                          setDraftGoal((current) => current ? { ...current, message: "" } : current);
                          setDraftError(null);
                          return;
                        }
                        const text = typeof body?.error === "string" && body.error.trim()
                          ? body.error.trim()
                          : "The job could not be left.";
                        linuxHoldLineRef.current = true;
                        setLinuxHoldLine(true);
                        setLinuxCoordinationLine(text);
                      }).catch(() => {
                        if (statusEpoch !== linuxStatusEpoch.current) return;
                        linuxActionSettled.current = statusEpoch;
                        linuxHoldLineRef.current = true;
                        setLinuxHoldLine(true);
                        setLinuxCoordinationLine("The job could not be left.");
                      }).finally(() => { if (statusEpoch === linuxStatusEpoch.current) { linuxActionOpen.current = false; setLinuxActionBusy(false); } });
                    } : undefined}
                    onStopCoordination={client.mode === "linux-core" && (linuxCoordinationLive || linuxCoordinationLine === "Stopping this goal." || linuxCoordinationLine === "Recording the stop.") ? () => {
                      if (linuxActionBusy) return;
                      const wasGone = workerGone;
                      const wasUnconfirmed = linuxCoordinationLine === "This goal's exit is not confirmed, so another goal cannot start yet.";
                      const statusEpoch = ++linuxStatusEpoch.current;
                      linuxActionOpen.current = true;
                      setLinuxActionBusy(true);
                      linuxHoldLineRef.current = false;
                      heldJobId.current = null;
                      setLinuxHoldLine(false);
                      setLinuxCoordinationLine(workerGone || linuxCoordinationLine === "This goal's exit is not confirmed, so another goal cannot start yet." ? "Recording the stop." : "Stopping this goal.");
                      void fetch("/goalport/ipc", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ messageType: "coordination_stop", payload: {} }),
                      }).then(async (response) => response.json()).then((body) => {
                        if (statusEpoch !== linuxStatusEpoch.current) return;
                        linuxActionSettled.current = statusEpoch;
                        const text = coordinationReplyLine(body, "Stop was sent.");
                        const gone = "The worker is gone. Its exit is not confirmed, so another goal cannot start yet.";
                        const confirmed = /unconfirmed|not confirmed/i.test(text || "");
                        setLinuxCoordinationLine(wasGone && !confirmed ? gone : wasUnconfirmed && !confirmed ? "This goal's exit is not confirmed, so another goal cannot start yet." : (text || "Stop was sent."));
                        if (!body || (body as { ok?: unknown }).ok === false || /unconfirmed/i.test(text || "") || (wasUnconfirmed && !confirmed)) {
                          linuxHoldLineRef.current = true;
                          heldJobId.current = seenJobId.current;
                          setLinuxHoldLine(true);
                          setSidebarUnconfirmed(true);
                        }
                      }).catch(() => {
                        if (statusEpoch !== linuxStatusEpoch.current) return;
                        linuxActionSettled.current = statusEpoch;
                        linuxHoldLineRef.current = true;
                        heldJobId.current = seenJobId.current;
                        setLinuxHoldLine(true);
                        setSidebarUnconfirmed(true);
                        setLinuxCoordinationLine("Stop could not be sent.");
                      }).finally(() => { if (statusEpoch === linuxStatusEpoch.current) { linuxActionOpen.current = false; setLinuxActionBusy(false); } });
                    } : undefined}
                    onContinueCoordination={client.mode === "linux-core" && (linuxCoordinationLine === "Continuing." || (!sidebarUnconfirmed && !linuxHoldLine && !linuxCoordinationLive && !linuxShowingFreshDraft && linuxCoordinationRequest && !linuxHarnessSentence && !linuxConsentMissing && backgroundConsent && !linuxActionBusy && linuxDiscoverChecked && !leftUnreplayed && !leftRequestIds.current.has(linuxCoordinationRequest))) ? () => {
                      if (linuxActionBusy || sidebarUnconfirmed || linuxHoldLine || linuxCoordinationLive || !linuxDiscoverChecked || Boolean(linuxHarnessSentence) || linuxConsentMissing || !backgroundConsent || linuxSignedIn.length < 2) {
                        if (linuxSignedIn.length < 2 && linuxDiscoverChecked && !linuxHarnessSentence && !linuxCoordinationLive) {
                          setLinuxHarnessSentence("An independent check needs a second logged-in harness, so nothing will be sent.");
                        }
                        return;
                      }
                      const statusEpoch = ++linuxStatusEpoch.current;
                      linuxActionOpen.current = true;
                      setLinuxActionBusy(true);
                      linuxHoldLineRef.current = false;
                      heldJobId.current = null;
                      setLinuxHoldLine(false);
                      setLinuxCoordinationLine("Continuing.");
                      void fetch("/goalport/ipc", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ messageType: "coordination_continue", payload: { followUp: draftGoal?.message ?? "", write: linuxWrite, background: backgroundConsent, instances: linuxSignedIn.length >= 2 ? linuxSignedIn.join(",") : undefined } }),
                      }).then(async (response) => response.json()).then((body) => {
                        if (statusEpoch !== linuxStatusEpoch.current) return;
                        linuxActionSettled.current = statusEpoch;
                        const text = coordinationReplyLine(body, "Continue was sent.");
                        const shown = text.includes("Run acknowledge before starting another") ? "The left goal could not be released, so nothing was sent." : text;
                        setLinuxCoordinationLine(shown || "Continue was sent.");
                        const failed = !body || (body as { ok?: unknown }).ok === false || (typeof (body as { error?: unknown }).error === "string" && (body as { error: string }).error.trim().length > 0);
                        if ((failed && !coordinationStartAdmitted(body)) || /unconfirmed/i.test(text || "")) {
                          linuxHoldLineRef.current = true;
                          heldJobId.current = seenJobId.current;
                          setLinuxHoldLine(true);
                          if (shown !== "The left goal could not be released, so nothing was sent.") setSidebarUnconfirmed(true);
                        }
                        if (coordinationStartAdmitted(body)) {
                          setLinuxLeftoverHeld(false);
                          setSidebarUnconfirmed(false);
                          linuxFreshDraft.current = false;
                          setLinuxShowingFreshDraft(false);
                          setLinuxCoordinationLive(true);
                          if (draftGoal?.message.trim()) setLinuxCoordinationGoal(draftGoal.message.trim());
                          setDraftGoal((current) => current ? { ...current, message: "" } : current);
                        }
                      }).catch(() => {
                        if (statusEpoch !== linuxStatusEpoch.current) return;
                        linuxActionSettled.current = statusEpoch;
                        linuxHoldLineRef.current = true;
                        heldJobId.current = seenJobId.current;
                        setLinuxHoldLine(true);
                        setSidebarUnconfirmed(true);
                        setLinuxCoordinationLine("Continue could not be sent.");
                      }).finally(() => { if (statusEpoch === linuxStatusEpoch.current) { linuxActionOpen.current = false; setLinuxActionBusy(false); } });
                    } : undefined}
                    workspacePlaceholder={client.mode === "linux-core" ? "/home/you/project" : undefined}
                    workspaceHint={client.mode === "linux-core" ? "Use a full path. A leading ~ is your home folder." : undefined}
                    harnessWarning={client.mode === "linux-core" && !linuxCoordinationLive && !linuxActionBusy ? linuxHarnessSentence : null}
                    signedInHint={client.mode === "linux-core" && !linuxHarnessSentence && (!linuxCoordinationGoal || linuxShowingFreshDraft) ? signedInLine(linuxSignedIn) : null}
                    discoverHint={client.mode === "linux-core" && !linuxDiscoverChecked && !workerGone && !linuxCoordinationLive && !linuxActionBusy ? "Checking signed-in harnesses." : null}
                    consentWarning={client.mode === "linux-core" && linuxConsentMissing && !linuxCoordinationLive && !linuxActionBusy ? "Background Send is not ready in this GoalPort window yet." : null}
                    leftoverHint={leftoverSlotLine}
                    onGrantConsent={client.mode === "linux-core" && (linuxCoordinationLine === "Allowing Background Send." || (linuxConsentMissing && !linuxGranting)) ? () => {
                      if (linuxGranting) return;
                      grantError.current = false;
                      linuxActionOpen.current = true;
                      setLinuxGranting(true);
                      setLinuxCoordinationLine("Allowing Background Send.");
                      void fetch("/goalport/ipc", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ messageType: "coordination_grant", payload: {} }),
                      }).then(async (response) => response.json().catch(() => null)).then((body) => {
                        if (!body || (body as { ok?: unknown }).ok === false) {
                          const error = (body as { error?: unknown } | null)?.error;
                          const sentence = typeof error === "string" && error.trim() ? error.trim() : "Background Send is not ready in this GoalPort window yet.";
                          grantError.current = true;
                          setLinuxHarnessSentence(sentence);
                          setLinuxCoordinationLine(sentence);
                          return;
                        }
                        grantError.current = false;
                        setLinuxConsentMissing(false);
                        setLinuxHarnessSentence(null);
                        grantAllowed.current = true;
                        setLinuxCoordinationLine("Background Send is allowed.");
                        setLinuxDiscoverNonce((value) => value + 1);
                      }).catch(() => {
                        const sentence = "The signed-in harnesses could not be checked, so nothing will be sent.";
                        setLinuxHarnessSentence(sentence);
                        setLinuxCoordinationLine(sentence);
                      }).finally(() => { linuxActionOpen.current = false; setLinuxGranting(false); });
                    } : undefined}
                    backgroundConsent={backgroundConsent}
                    onBackgroundConsentChange={client.mode === "linux-core" || (window.goalportCore?.backgroundStart && !draftGoal?.provider.trim()) ? setBackgroundConsent : undefined}
                    keepRunningHint={client.mode === "linux-core" && linuxDiscoverChecked && !backgroundConsent && !linuxCoordinationLive && !linuxHarnessSentence && !linuxConsentMissing ? "Keep working after closing must be explicitly selected." : null}
                    onBrowse={() => { void chooseWorkspace(); }}
                    onChange={(value) => {
                      if (value.provider.trim()) setBackgroundConsent(false);
                      const current = draftGoal;
                      if (!current) {
                        setDraftGoal({ ...value, requestId: freshRequestId(), baselineCampaignId: snapshot.activeCampaignId });
                        return;
                      }
                      const changed = current.workspace !== value.workspace
                        || current.provider !== value.provider
                        || current.message !== value.message;
                      if (current.workspace !== value.workspace) {
                        setWriteInstances([]);
                        setScopeMirror((scope) => scope ? { instances: scope.instances, generation: scope.generation, maxTurns: scope.maxTurns, remaining: scope.remaining } : null);
                      }
                      if (changed) abandonCoordination();
                      const savedForDraft = plans.some((plan) => plan.requestId === current.requestId);
                      setDraftGoal({
                        ...current,
                        ...value,
                        ...(changed && (current.intent || savedForDraft) ? { requestId: freshRequestId(), intent: undefined } : {})
                      });
                    }}
                    onSubmit={handleDraftSend}
                    onDiscard={handleDiscardDraft}
                  />
                  {draftGoal && draftGoal.provider.trim() === "" && panelRequestId === draftGoal.requestId && panelProviders !== null ? (
                    <AuthorizationPanel
                      backgroundConsent={backgroundConsent}
                      backgroundConfigured={appInfo?.coordinationConfigured === true}
                      onAllowBackgroundSend={window.goalportCore?.backgroundSendConsent ? async () => {
                        const consent = await window.goalportCore!.backgroundSendConsent!("grant");
                        if (!consent.allowed) throw new Error("Background Send consent was not granted.");
                        const info = await client.appInfo?.();
                        if (!info?.coordinationConfigured) throw new Error("Background Send capability is not ready.");
                        setAppInfo(info);
                      } : undefined}
                      onBackgroundConsentChange={window.goalportCore?.backgroundStart ? setBackgroundConsent : undefined}
                      providers={panelProviders}
                      selected={selectedInstances}
                      onToggle={(instanceId, selected) => {
                        setSelectedInstances((current) => selected
                          ? (current.includes(instanceId) ? current : [...current, instanceId])
                          : current.filter((id) => id !== instanceId));
                      }}
                      maxTurns={allowedTurns}
                      onMaxTurnsChange={(raw) => setAllowedTurns(clampTurns(raw))}
                      workspaceRoot={draftGoal.workspace.trim()}
                      writeSelected={writeInstances}
                      onWriteToggle={(id, selected) => setWriteInstances((current) => selected
                        ? (current.includes(id) ? current : [...current, id]) : current.filter((item) => item !== id))}
                      writeTurns={writeTurns}
                      onWriteTurnsChange={(raw) => setWriteTurns(raw === "" ? NaN : Number(raw))}
                      writeScope={scopeMirror?.write ?? null}
                      scope={scopeMirror ? { remaining: scopeMirror.remaining, maxTurns: scopeMirror.maxTurns } : null}
                      changeMode={panelChangeMode}
                      onEnterChangeMode={() => setPanelChangeMode(true)}
                      onStopAllowing={() => { void handleStopAllowing(); }}
                      onConfirmChange={() => { void handleConfirmAccessChange(); }}
                      onUseAgain={(instanceId) => { void handleUseAgain(instanceId); }}
                    />
                  ) : draftGoal && draftGoal.provider.trim() === "" && panelRequestId === draftGoal.requestId && panelLoad === "failed" ? (
                    <div className="dialog-note" role="alert">
                      <span aria-hidden="true">!</span>
                      <span>
                        GoalPort could not load your harness-access choices, so nothing can be sent from this draft yet.
                        <button className="button button-small button-outline" type="button" onClick={() => setPanelAttempt((attempt) => attempt + 1)}>Retry harness access</button>
                        {panelFailSentence ? (
                          <details className="technical-details">
                            <summary>Technical details</summary>
                            <pre className="technical-details-pre">{panelFailSentence}</pre>
                          </details>
                        ) : null}
                      </span>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : confirmedEmptyProfile && !hasGoal ? (
            <section className="empty-goal" aria-label="No goal yet">
              <h2>No goal open</h2>
              <p>Start one when you are ready. Nothing is saved until you send it.</p>
              <button
                className="button button-primary empty-goal-cta"
                type="button"
                onClick={() => { backgroundAttached.current = true; setBackgroundView(false); handleNewGoal(); }}
              >
                New goal
              </button>
            </section>
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
                turn={conversationHeldByBackground
                  ? { ...product.turn, canSend: false, reason: HELD_CONVERSATION_SENTENCE, reasonCode: undefined }
                  : backgroundSlotBlocked
                    ? { ...product.turn, canSend: false, reason: backgroundSlotSentence, reasonCode: undefined }
                    : snapshot.bounds?.projectionUnavailable && !activeRetryLabel
                      ? { ...product.turn, canSend: false, reason: "Core returned a capacity-limited view. Reconnect before starting new work." }
                      : product.turn}
                busy={sendBusy}
                closingSession={closingSession}
                retryLabel={(conversationHeldByBackground || backgroundSlotBlocked) ? undefined : activeRetryLabel}
                chooserFocusSignal={chooserFocusSignal}
                onChange={updateVisibleCampaignDraft}
                onSubmit={handleSend}
                onSelectRuntime={(provider) => { void selectRuntime(provider); }}
                onStop={() => { void handleStop(); }}
                onResume={(conversationHeldByBackground || backgroundSlotBlocked)
                  ? undefined
                  : () => { void handleResumeSession(); }}
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

function workspaceFolder(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** A terminal outcome with no pending command is the only fact that releases a folder. */
function confirmedTerminalJob(job: BackgroundStatus): boolean {
  return (job.state === "completed" || job.state === "failed" || job.state === "stopped")
    && Boolean(job.outcome) && !job.pendingCommand;
}

/**
 * Conservative lexical warning only, never proof that an alias is safe.
 * Physical identity belongs to the candidate-bound host query and admission.
 * Relative text has no identity (the host fails closed on it too).
 */
export function workspaceIdentityKey(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const drive = /^[A-Za-z]:[\\/]/.test(text);
  const unc = /^[\\/]{2}[^\\/]/.test(text);
  const rooted = !drive && !unc && /^[\\/]/.test(text);
  if (!drive && !unc && !rooted) return null;
  const windowsHost = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  const windowsLike = drive || unc || windowsHost;
  const rest = drive ? text.slice(2) : text.replace(/^[\\/]+/, "");
  const parts: string[] = [];
  const segments = windowsLike ? rest.split(/[\\/]+/) : rest.split("/");
  for (const part of segments) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length > (unc ? 2 : 0)) parts.pop(); continue; }
    parts.push(part);
  }
  const separator = windowsLike ? "\\" : "/";
  const body = parts.join(separator);
  const prefix = drive ? text.slice(0, 2) + separator : unc ? separator + separator : separator;
  const key = prefix + body;
  return windowsLike ? key.toLowerCase() : key;
}

function sameWorkspaceIdentity(left: string, right: string): boolean {
  const a = workspaceIdentityKey(left);
  const b = workspaceIdentityKey(right);
  return a !== null && b !== null && a === b;
}

/** While a folder is held, an unidentifiable path is never presented as sendable. */
function targetsHeldWorkspace(value: string, held: string): boolean {
  if (!held) return false;
  if (workspaceIdentityKey(value) === null) return value.trim().length > 0;
  return sameWorkspaceIdentity(value, held);
}

const HELD_CONVERSATION_SENTENCE = "This folder is still reserved while the interrupted goal's exit is unconfirmed. Return to the background goal to release it; nothing was sent.";
const HELD_FOLDER_SENTENCE = "This folder is still reserved while the interrupted goal's exit is unconfirmed. Choose a different folder; nothing was sent.";
const UNIDENTIFIABLE_FOLDER_SENTENCE = "GoalPort needs an absolute folder path (for example C:\\workspace\\your-project) before it can check this folder or start work; nothing was sent.";

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
