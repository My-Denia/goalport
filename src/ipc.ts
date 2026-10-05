import { invoke } from "@tauri-apps/api/core";
import {
  appendPreviewConversationMessage,
  appendPreviewMessage,
  createPreviewCampaign,
  DEMO_SNAPSHOT,
  EMPTY_PREVIEW_SNAPSHOT,
  EMPTY_SNAPSHOT,
  HISTORY_WINDOW_ADVANCED_NOTICE,
  normalizeCommandRejection,
  normalizeHistoryPageInfo,
  normalizeProductConversationItem,
  normalizeTimelineItem,
  renamePreviewConversation,
  resolveCoreSnapshot,
  resolvePermission,
  startPreviewConversation,
  withConnection,
  type ConnectionState,
  type CommandRejection,
  type CoreCommandOutcome,
  type CoreSnapshot,
  type GoalCard,
  type GoalOverview,
  type HistoryPageInfo,
  PREVIEW_PROVIDER_QUOTA,
  type ProductConversation,
  type ProductConversationItem,
  type TimelineItem
} from "./types";

export const IPC_PROTOCOL_VERSION = "goalport.ipc.v2";

export function previewInitialSnapshot(): CoreSnapshot {
  const fixture = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("preview") : null;
  if (fixture === "empty") return EMPTY_PREVIEW_SNAPSHOT;
  if (fixture === "starting") {
    return {
      ...DEMO_SNAPSHOT, decisions: [], stopResponsibility: null,
      productConversation: {
        ...DEMO_SNAPSHOT.productConversation!,
        runtime: { state: "starting", provider: "codex", name: "Codex" },
        session: { state: "starting", nativeIdKnown: false },
        turn: { state: "starting", canSend: false, canStop: true, reason: "Codex is starting. You can stop while it connects." }
      }
    };
  }
  if (fixture === "completed") {
    const resultSummary = "Synthetic example: corrected addition and checked the three example tests.";
    return {
      ...DEMO_SNAPSHOT,
      decisions: [],
      stopResponsibility: null,
      productConversation: {
        ...DEMO_SNAPSHOT.productConversation!,
        title: "Fix sample addition",
        items: [{ id: "preview-completed-result", kind: "assistant-message", body: resultSummary }],
        turn: { state: "completed", canSend: false, canStop: false, reason: "Browser preview does not send work to a Runtime." },
        resultSummary
      }
    };
  }
  if (fixture === "quota") {
    return {
      ...DEMO_SNAPSHOT, decisions: [], stopResponsibility: null,
      productConversation: {
        ...DEMO_SNAPSHOT.productConversation!,
        runtime: { state: "selected", provider: "codex", name: "Codex" },
        session: { state: "attached", nativeIdKnown: false },
        turn: { state: "failed", canSend: true, canStop: false, reasonCode: PREVIEW_PROVIDER_QUOTA, actions: ["select-runtime", "send"] },
        items: [{ id: "preview-quota", kind: "actionable-error", body: "Codex has reached its usage limit. Wait for the limit to reset or choose another Runtime.", technicalDetails: "Synthetic example: usageLimitExceeded", actions: ["select-runtime"] }]
      }
    };
  }
  if (fixture === "recovery") {
    return {
      ...DEMO_SNAPSHOT, decisions: [], stopResponsibility: null,
      productConversation: {
        ...DEMO_SNAPSHOT.productConversation!,
        runtime: { state: "unavailable", provider: "codex", name: "Codex" },
        session: { state: "detached", nativeIdKnown: true },
        turn: { state: "completed", canSend: false, canStop: false, reasonCode: "session-detached", reason: "Resume this session to continue. Earlier messages will not be sent again.", actions: ["resume-session"] }
      }
    };
  }
  return DEMO_SNAPSHOT;
}

/** Display-only identity Core uses when a task has no persisted Attempt. */
export const UNASSIGNED_ATTEMPT_ID = "attempt-unassigned";

export function persistedAttemptId(attemptId: string | undefined | null): string | undefined {
  const trimmed = attemptId?.trim();
  if (!trimmed || trimmed === UNASSIGNED_ATTEMPT_ID) return undefined;
  return trimmed;
}

/** Identities Core may reuse or roll over on select_runtime. Display placeholders and uncertain snapshots are omitted. Terminal IDs are forwarded so Core can mint a replacement. */
export function reusableAttemptId(
  attempt: { id?: string | null; state?: string | null } | null | undefined
): string | undefined {
  const id = persistedAttemptId(attempt?.id);
  if (!id) return undefined;
  if (attempt?.state === "uncertain") return undefined;
  return id;
}

export interface CloseChoicePayload {
  requestId: string;
  choice: "continue" | "stop";
  continueClickIssuedAtUtc?: string;
}

export interface CoreCommand {
  protocolVersion: string;
  requestId: string;
  entityVersion: number;
  messageType:
    | "snapshot"
    | "select_project"
    | "select_campaign"
    | "create_campaign"
    | "create_campaign_with_task"
    | "select_runtime"
    | "start_conversation"
    | "conversation_send"
    | "history_page"
    | "rename_conversation"
    | "send_message"
    | "resolve_decision"
    | "permission_response"
    | "interrupt"
    | "close_session"
    | "safe_stop"
    | "reconnect"
    | "handoff"
    | "revoke_authorization"
    | "request_owner_action"
    | "resume_native_session"
    | "classify_recovery"
    | "close_adapter_transport"
    | "mark_runtime_exit"
    | "observe_workspace_edit"
    | "queue_override"
    | "record_close_choice"
    | "get_startup_receipt"
    | "get_close_choice_receipt"
    | "recheck_stop_responsibility"
    | "continue_in_isolated_workspace";
  payload: Record<string, string | number | boolean>;
}

export interface CoreClient {
  readonly mode: "tauri" | "electron" | "browser-preview" | "linux-core";
  snapshot(): Promise<CoreSnapshot>;
  createCampaign(workspaceRoot: string, goal: string): Promise<CoreSnapshot>;
  sendMessage(message: string, campaignId: string, attemptId: string, taskId?: string): Promise<CoreSnapshot>;
  resolveDecision(decisionId: string, allow?: boolean): Promise<CoreSnapshot>;
  reconnect(): Promise<CoreSnapshot>;
  handoff?(provider: string, oldAttemptId: string, instruction: string): Promise<CoreSnapshot>;
  startCore(): Promise<CoreSnapshot>;
  setConnection(connection: ConnectionState): Promise<CoreSnapshot>;
  openInVsCode(workspaceRoot: string): Promise<void>;
  selectProject?(projectId: string): Promise<CoreSnapshot>;
  selectCampaign?(campaignId: string): Promise<CoreSnapshot>;
  /** Keep background reads on this goal before the first poll adopts Core's shared selection. */
  pinView?(campaignId: string): void;
  /** A routed goal Core could not open. Empty when the last read matched the route. */
  takeRouteMiss?(): string;
  selectRuntime?(provider: string, campaignId: string, taskId: string, attemptId?: string): Promise<CoreSnapshot>;
  interrupt?(attemptId: string): Promise<CoreSnapshot>;
  closeSession?(attemptId: string): Promise<CoreSnapshot>;
  resumeSession?(attemptId: string): Promise<CoreSnapshot>;
  recheckStopResponsibility?(attemptId: string): Promise<CoreSnapshot>;
  continueInIsolatedWorkspace?(attemptId: string, targetWorkspace: string): Promise<CoreSnapshot>;
  revokeAuthorization?(campaignId: string, scope?: string): Promise<CoreSnapshot>;
  requestOwnerAction?(action: string, planApproved?: boolean, auditPassed?: boolean): Promise<CoreSnapshot>;
  notify?(title: string, body: string): Promise<boolean>;
  chooseWorkspace?(): Promise<string | null>;
  appInfo?(): Promise<AppInfo>;
  dispatch?(request: CoreCommand): Promise<CoreSnapshot>;
  /**
   * First-send orchestration (product-interaction-reset): ONE
   * `start_conversation` dispatch carrying a caller-stable request id. Optional
   * for compatibility with older CoreClient fixtures; the desktop
   * implementations dispatch the new command.
   */
  startConversation?(workspaceRoot: string, provider: string, message: string, requestId: string): Promise<CoreSnapshot>;
  /** Explicit Send on an existing conversation: `conversation_send`, gated by product.turn.canSend upstream. */
  conversationSend?(message: string, campaignId: string, attemptId: string | undefined, requestId: string): Promise<CoreSnapshot>;
  historyPage?(request: HistoryPageRequest): Promise<HistoryPage>;
  /** Durable product title rename. */
  renameConversation?(campaignId: string, title: string): Promise<CoreSnapshot>;
}

export interface HistoryPageRequest {
  scope: "conversation" | "timeline";
  ownerId: string;
  direction: "older" | "newer";
  cursor?: string;
}

export interface HistoryPage {
  scope: "conversation" | "timeline";
  ownerId: string;
  conversationItems?: ProductConversationItem[];
  timelineItems?: TimelineItem[];
  pageInfo: HistoryPageInfo;
}

export interface AppInfo {
  version: string;
  channel: string;
  distribution?: string;
  testMode: boolean;
  dataPath: string;
}

export interface BootstrapFacts {
  sourcePath: string | null;
  createdBy: { version: string | null; coreSha256: string | null; distribution: string | null } | null;
  markerSchema: number | null;
  counts: Record<string, number> | null;
  schemaVersion: number | null;
  bytes: number | null;
  needsRecovery: boolean;
  liveSource: boolean;
  recoveryDisposition?: "NOT_REQUIRED" | "POSITIVELY_IDENTIFIED_RECOVERABLE";
  recoveryMethod?: string | null;
  recoveryProofToken?: string | null;
  operationId?: string | null;
  sourceMutationOnAccept?: "NONE";
}

export type BootstrapState =
  | { phase: "checking" | "backing-up" | "importing" | "done" }
  | { phase: "import-offer"; facts: BootstrapFacts }
  | { phase: "import-incompatible"; facts: BootstrapFacts; reason: string }
  | { phase: "coordination"; kind: "live-core" | "unknown-core"; headline: string; detail: Record<string, unknown> | null; dataPath: string | null }
  | { phase: "error"; kind: string; headline: string; message: string; canChooseDir: boolean; dataPath: string | null };

export type BootstrapActionType =
  | "import-accept"
  | "fresh"
  | "retry"
  | "exit"
  | "open-folder"
  | "choose-dir";

export type BootstrapAction =
  | { type: Exclude<BootstrapActionType, "import-accept"> }
  | { type: "import-accept"; operationId?: string; recoveryProofToken?: string };

export interface CommandTraceEntry {
  phase: "issued" | "settled";
  requestId: string;
  messageType: string;
  provider?: string;
  campaignId?: string;
  taskId?: string;
  attemptId?: string;
  kind?: CoreCommandOutcome["kind"];
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __GOALPORT_ELECTRON__?: boolean;
    __GOALPORT_ISOLATED?: number;
    __goalportDispatch?: (request: CoreCommand) => Promise<CoreSnapshot>;
    __goalportAppSnapshot?: () => Promise<CoreSnapshot>;
    __goalportLastEnvelope?: CoreCommand;
    __goalportLastSnapshot?: CoreSnapshot;
    __goalportLastSelectResult?: CoreSnapshot;
    __goalportCommandTrace?: CommandTraceEntry[];
    __goalportCloseRequestId?: string;
    __GOALPORT_LINUX_CORE__?: { bridge?: string } | true;
    goalportCore?: {
      snapshot: () => Promise<unknown>;
      command: (request: CoreCommand) => Promise<unknown>;
      startCore: () => Promise<unknown>;
      openInVsCode: (workspaceRoot: string) => Promise<void>;
      notify?: (title: string, body: string) => Promise<boolean>;
      chooseWorkspace?: () => Promise<string | null>;
      appInfo?: () => Promise<AppInfo>;
      requestClose?: () => Promise<unknown>;
      confirmCloseChoice?: (payload: CloseChoicePayload | "continue" | "stop") => Promise<unknown>;
      dismissCloseChoice?: () => Promise<unknown>;
      bootstrapCurrent?: () => Promise<BootstrapState>;
      bootstrapAction?: (payload: BootstrapAction) => Promise<unknown>;
      onBootstrapState?: (callback: (state: BootstrapState) => void) => () => void;
      onClosePrompt?: (callback: () => void) => () => void;
      onCloseChoiceFailed?: (callback: (payload?: unknown) => void) => () => void;
    };
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function requestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `goalport-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Core request failed";
}

async function invokeCore<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

class PreviewCoreClient implements CoreClient {
  readonly mode = "browser-preview" as const;
  private state: CoreSnapshot = previewInitialSnapshot();
  private views = new Map<string, { product: ProductConversation | null; task: CoreSnapshot["activeTask"]; attempt: CoreSnapshot["attempt"]; decisions: CoreSnapshot["decisions"] }>();

  async snapshot(): Promise<CoreSnapshot> {
    return this.state;
  }

  async createCampaign(workspaceRoot: string, goal: string): Promise<CoreSnapshot> {
    this.state = createPreviewCampaign(this.state, workspaceRoot, goal);
    return this.state;
  }

  async sendMessage(message: string): Promise<CoreSnapshot> {
    this.state = appendPreviewMessage(this.state, message);
    return this.state;
  }

  async resolveDecision(_decisionId: string, allow = false): Promise<CoreSnapshot> {
    this.state = resolvePermission(this.state, allow);
    return this.state;
  }

  async reconnect(): Promise<CoreSnapshot> {
    this.state = withConnection(this.state, "connected");
    return this.state;
  }

  async handoff(): Promise<CoreSnapshot> {
    this.state = withConnection(this.state, "connected");
    return this.state;
  }

  async startCore(): Promise<CoreSnapshot> {
    this.state = withConnection(this.state, "connected");
    return this.state;
  }

  async setConnection(connection: ConnectionState): Promise<CoreSnapshot> {
    this.state = withConnection(this.state, connection);
    return this.state;
  }

  async startConversation(workspaceRoot: string, provider: string, message: string, requestId: string): Promise<CoreSnapshot> {
    this.state = startPreviewConversation(this.state, workspaceRoot, provider, message, requestId);
    return this.state;
  }

  async conversationSend(message: string, _campaignId?: string, _attemptId?: string, _requestId?: string): Promise<CoreSnapshot> {
    // appendPreviewMessage records the legacy timeline copy (diagnostics) and the
    // product items (conversation) in one step, with an honest preview note.
    this.state = appendPreviewMessage(this.state, message);
    return this.state;
  }

  async historyPage(request: HistoryPageRequest): Promise<HistoryPage> {
    return {
      scope: request.scope,
      ownerId: request.ownerId,
      ...(request.scope === "conversation" ? { conversationItems: [] } : { timelineItems: [] }),
      pageInfo: { olderCursor: null, newerCursor: null, hasOlder: false, hasNewer: false, contentBytes: 2, itemCount: 0 }
    };
  }

  async renameConversation(campaignId: string, title: string): Promise<CoreSnapshot> {
    this.state = renamePreviewConversation(this.state, campaignId, title);
    return this.state;
  }

  async selectCampaign(campaignId: string): Promise<CoreSnapshot> {
    const selected = this.state.campaigns.find((campaign) => campaign.id === campaignId);
    if (selected && campaignId !== this.state.activeCampaignId) {
      if (this.state.activeCampaignId) this.views.set(this.state.activeCampaignId, {
        product: this.state.productConversation,
        task: this.state.activeTask,
        attempt: this.state.attempt,
        decisions: this.state.decisions
      });
      const saved = this.views.get(campaignId);
      this.state = {
        ...this.state,
        activeCampaignId: campaignId,
        activeTask: saved?.task ?? { id: `task-${campaignId}`, title: selected.activeTaskTitle, acceptance: "Preview only", state: "waiting" },
        attempt: saved?.attempt ?? { ...this.state.attempt, id: "attempt-unassigned", taskId: `task-${campaignId}`, provider: "unassigned", state: "waiting", eventCount: 0 },
        decisions: saved?.decisions ?? [],
        productConversation: saved?.product ?? {
          items: [], title: selected.title,
          runtime: { state: "none", provider: "", name: "" },
          turn: { state: "idle", canStop: false, canSend: false, reason: "The browser preview has no Runtime; nothing runs here." }
        }
      };
    }
    return this.state;
  }

  async selectRuntime(provider: string): Promise<CoreSnapshot> {
    const runtime = this.state.runtimes.find((candidate) => candidate.id === provider);
    if (runtime && this.state.productConversation) this.state = {
      ...this.state,
      productConversation: {
        ...this.state.productConversation,
        runtime: { state: "selected", provider, name: runtime.name },
        turn: { state: "idle", canStop: false, canSend: false, reason: "The browser preview has no Runtime; nothing runs here." }
      }
    };
    return this.state;
  }

  async openInVsCode(): Promise<void> {
    // The browser preview cannot launch a local editor. The UI keeps this action explicit.
    return Promise.resolve();
  }

  async appInfo(): Promise<AppInfo> {
    // The browser preview is a development surface, and says so honestly:
    // fault injection in Developer diagnostics is gated on exactly this.
    return { version: "preview", channel: "preview", distribution: "dev", testMode: false, dataPath: "" };
  }
}

class TauriCoreClient implements CoreClient {
  readonly mode: "tauri" | "electron";
  private lastSnapshot: CoreSnapshot = EMPTY_SNAPSHOT;
  private entityVersion = 0;
  private mutationGeneration = 0;
  private pendingMutations = 0;
  private commandTail: Promise<void> = Promise.resolve();
  private snapshotInFlight: Promise<CoreSnapshot> | null = null;

  constructor(mode: "tauri" | "electron" = "tauri") {
    this.mode = mode;
  }

  async snapshot(): Promise<CoreSnapshot> {
    // A poll must never race a command and later replace its result. Calls that
    // arrive while a mutation is queued use the last accepted projection; the
    // next interval obtains a fresh full snapshot after the queue drains.
    if (this.snapshotInFlight) return this.snapshotInFlight;
    const pending = this.pendingMutations > 0
      ? this.waitForMutationQueue()
      : this.readSnapshot(this.mutationGeneration);
    this.snapshotInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.snapshotInFlight === pending) this.snapshotInFlight = null;
    }
  }

  private async readSnapshot(generation: number): Promise<CoreSnapshot> {
    try {
      const raw = await this.invoke<unknown>("core_snapshot");
      if (generation !== this.mutationGeneration || this.pendingMutations > 0) return this.waitForMutationQueue();
      const snapshot = resolveCoreSnapshot(raw);
      if (!snapshot) throw new Error("Core returned an invalid snapshot");
      this.lastSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      if (generation !== this.mutationGeneration || this.pendingMutations > 0) return this.waitForMutationQueue();
      this.lastSnapshot = {
        ...this.lastSnapshot,
        commandOutcome: undefined,
        connection: "disconnected",
        notices: [`Core unavailable: ${errorMessage(error)}`, ...this.lastSnapshot.notices]
      };
      return this.lastSnapshot;
    }
  }

  private async waitForMutationQueue(): Promise<CoreSnapshot> {
    while (this.pendingMutations > 0) {
      const tail = this.commandTail;
      await tail;
      if (tail === this.commandTail && this.pendingMutations === 0) break;
    }
    return this.lastSnapshot;
  }

  async sendMessage(message: string, campaignId: string, attemptId: string, taskId?: string): Promise<CoreSnapshot> {
    const command: CoreCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: requestId(),
      entityVersion: this.entityVersion,
      messageType: "send_message",
      payload: { message, campaignId, attemptId, taskId: taskId ?? this.lastSnapshot.activeTask.id }
    };
    return this.dispatch(command);
  }

  async createCampaign(workspaceRoot: string, goal: string): Promise<CoreSnapshot> {
    const command: CoreCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: requestId(),
      entityVersion: this.entityVersion,
      messageType: "create_campaign",
      payload: { workspaceRoot, goal, title: goal, acceptance: "Persist ordered Runtime events and recover without replay." }
    };
    return this.dispatch(command);
  }

  async resolveDecision(decisionId: string, allow = false): Promise<CoreSnapshot> {
    const command: CoreCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: requestId(),
      entityVersion: this.entityVersion,
      messageType: "resolve_decision",
      payload: { decisionId, allow }
    };
    return this.dispatch(command);
  }

  async reconnect(): Promise<CoreSnapshot> {
    const command: CoreCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: requestId(),
      entityVersion: this.entityVersion,
      messageType: "reconnect",
      payload: { cursor: this.lastSnapshot.cursor }
    };
    return this.dispatch(command);
  }

  async handoff(provider: string, oldAttemptId: string, instruction: string): Promise<CoreSnapshot> {
    return this.dispatch({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: requestId(),
      entityVersion: this.entityVersion,
      messageType: "handoff",
      payload: {
        provider,
        oldAttemptId,
        handoffInstruction: instruction,
        authorization: "goalport-ui-user-action"
      }
    });
  }

  async startCore(): Promise<CoreSnapshot> {
    try {
      await this.invoke("start_core");
      // Core owns its own process lifetime. Retry the pipe briefly after a
      // freshly spawned release sidecar; no static projection is used.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        const probe = await this.snapshot();
        if (probe.connection === "connected") return probe;
      }
    } catch (error) {
      this.lastSnapshot = {
        ...this.lastSnapshot,
        connection: "disconnected",
        notices: [`Unable to start Core: ${errorMessage(error)}`, ...this.lastSnapshot.notices]
      };
    }
    return this.snapshot();
  }

  async setConnection(connection: ConnectionState): Promise<CoreSnapshot> {
    if (connection === "connected") return this.reconnect();
    this.lastSnapshot = { ...withConnection(this.lastSnapshot, connection), commandOutcome: undefined };
    return this.lastSnapshot;
  }

  async openInVsCode(workspaceRoot: string): Promise<void> {
    await this.invoke("open_in_vscode", { workspaceRoot });
  }

  async dispatch(command: CoreCommand): Promise<CoreSnapshot> {
    traceCommand("issued", command);
    this.pendingMutations += 1;
    this.mutationGeneration += 1;
    const previous = this.commandTail;
    const run = previous.then(() => this.performDispatch(command));
    const traced = run.then((snapshot) => {
      traceCommand("settled", command, snapshot.commandOutcome?.kind ?? "transport-error");
      return snapshot;
    });
    const settled = traced.finally(() => {
      this.pendingMutations -= 1;
    });
    this.commandTail = settled.then(() => undefined, () => undefined);
    return settled;
  }

  private async performDispatch(command: CoreCommand): Promise<CoreSnapshot> {
    if (typeof window !== "undefined" && window.__GOALPORT_ISOLATED === 1) {
      window.__goalportLastEnvelope = command;
    }
    try {
      const raw = await this.invoke<unknown>("core_command", { request: command });
      const rawRecord = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      if (rawRecord && rawRecord.goalportRejected) {
        const rejectedRequestId = rawRecord.requestId ?? rawRecord.request_id;
        if (typeof rejectedRequestId === "string" && rejectedRequestId !== command.requestId) {
          throw new Error("Core rejection identity did not match the request");
        }
        const message = errorMessage(rawRecord.error);
        const rejection = normalizeCommandRejection(rawRecord.rejection);
        const authoritative = resolveCoreSnapshot(rawRecord.snapshot);
        if (rejection?.reservation && rejection.reservation.requestId !== command.requestId) {
          throw new Error("Core rejection reservation identity did not match the request");
        }
        if (authoritative) this.entityVersion += 1;
        const base = authoritative ?? this.lastSnapshot;
        this.lastSnapshot = {
          ...base,
          commandOutcome: commandOutcome(command, "refused", message, rejection),
          notices: [`Core refused: ${message}`, ...base.notices]
        };
        this.rememberIsolatedSnapshot();
        return this.lastSnapshot;
      }
      const envelope = commandEnvelope(raw, command);
      const snapshot = resolveCoreSnapshot(envelope.snapshot);
      if (!snapshot) throw new Error("Core returned an invalid command projection");
      this.entityVersion += 1;
      const projected = command.messageType === "reconnect"
        ? mergeReconnectProjection(this.lastSnapshot, snapshot)
        : snapshot;
      this.lastSnapshot = {
        ...projected,
        commandOutcome: {
          ...commandOutcome(command, "accepted"),
          duplicate: envelope.duplicate
        }
      };
      this.rememberIsolatedSnapshot();
      return this.lastSnapshot;
    } catch (error) {
      const message = errorMessage(error);
      this.lastSnapshot = {
        ...this.lastSnapshot,
        commandOutcome: commandOutcome(command, "transport-error", message),
        connection: "disconnected",
        notices: [`Core request failed: ${message}`, ...this.lastSnapshot.notices]
      };
      this.rememberIsolatedSnapshot();
      return this.lastSnapshot;
    }
  }

  async selectProject(projectId: string): Promise<CoreSnapshot> {
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "select_project", payload: { projectId } });
  }

  async selectCampaign(campaignId: string): Promise<CoreSnapshot> {
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "select_campaign", payload: { campaignId } });
  }

  async selectRuntime(provider: string, campaignId: string, taskId: string, attemptId?: string): Promise<CoreSnapshot> {
    const payload: Record<string, string | number | boolean> = { provider, campaignId, taskId };
    const persisted = persistedAttemptId(attemptId);
    if (persisted) payload.attemptId = persisted;
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "select_runtime", payload });
  }

  async startConversation(workspaceRoot: string, provider: string, message: string, stableRequestId: string): Promise<CoreSnapshot> {
    // ONE dispatch for the whole first-send orchestration; Core owns the
    // at-most-once claim with this request identity. The caller keeps the id
    // stable across retries of the same intent.
    return this.dispatch({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: stableRequestId,
      entityVersion: this.entityVersion,
      messageType: "start_conversation",
      payload: { workspaceRoot, provider, message }
    });
  }

  async conversationSend(message: string, campaignId: string, attemptId: string | undefined, stableRequestId: string): Promise<CoreSnapshot> {
    const payload: Record<string, string | number | boolean> = { message, campaignId };
    const persisted = persistedAttemptId(attemptId);
    if (persisted) payload.attemptId = persisted;
    return this.dispatch({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: stableRequestId,
      entityVersion: this.entityVersion,
      messageType: "conversation_send",
      payload
    });
  }

  async historyPage(request: HistoryPageRequest): Promise<HistoryPage> {
    await this.waitForMutationQueue();
    const command: CoreCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: requestId(),
      entityVersion: this.entityVersion,
      messageType: "history_page",
      payload: {
        scope: request.scope,
        ownerId: request.ownerId,
        direction: request.direction,
        ...(request.cursor ? { cursor: request.cursor } : {})
      }
    };
    traceCommand("issued", command);
    const raw = await this.invoke<unknown>("core_command", { request: command });
    const page = historyPageEnvelope(raw, command);
    traceCommand("settled", command, "accepted");
    return page;
  }

  async renameConversation(campaignId: string, title: string): Promise<CoreSnapshot> {
    return this.dispatch({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: requestId(),
      entityVersion: this.entityVersion,
      messageType: "rename_conversation",
      payload: { campaignId, title }
    });
  }

  private rememberIsolatedSnapshot(): void {
    if (typeof window !== "undefined" && window.__GOALPORT_ISOLATED === 1) {
      window.__goalportLastSnapshot = this.lastSnapshot;
    }
  }

  async interrupt(attemptId: string): Promise<CoreSnapshot> {
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "interrupt", payload: { attemptId } });
  }

  async closeSession(attemptId: string): Promise<CoreSnapshot> {
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "close_session", payload: { attemptId } });
  }

  async resumeSession(attemptId: string): Promise<CoreSnapshot> {
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "resume_native_session", payload: { attemptId } });
  }

  async recheckStopResponsibility(attemptId: string): Promise<CoreSnapshot> {
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "recheck_stop_responsibility", payload: { attemptId } });
  }

  async continueInIsolatedWorkspace(attemptId: string, targetWorkspace: string): Promise<CoreSnapshot> {
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "continue_in_isolated_workspace", payload: { attemptId, targetWorkspace } });
  }

  async revokeAuthorization(campaignId: string, scope = "action"): Promise<CoreSnapshot> {
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "revoke_authorization", payload: { campaignId, scope } });
  }

  async requestOwnerAction(action: string, planApproved = true, auditPassed = true): Promise<CoreSnapshot> {
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "request_owner_action", payload: { action, planApproved, auditPassed } });
  }

  async notify(title: string, body: string): Promise<boolean> {
    if (this.mode !== "electron") return false;
    const api = window.goalportCore;
    if (!api?.notify) return false;
    return api.notify(title, body);
  }

  async chooseWorkspace(): Promise<string | null> {
    if (this.mode !== "electron") return null;
    return window.goalportCore?.chooseWorkspace?.() ?? null;
  }

  async appInfo(): Promise<AppInfo> {
    if (this.mode !== "electron" || !window.goalportCore?.appInfo) {
      return { version: "", channel: this.mode === "tauri" ? "desktop" : "preview", testMode: false, dataPath: "" };
    }
    return window.goalportCore.appInfo();
  }

  private async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (this.mode === "electron") {
      const api = window.goalportCore;
      if (!api) throw new Error("Electron preload API is unavailable");
      if (command === "core_snapshot") return api.snapshot() as Promise<T>;
      if (command === "start_core") return api.startCore() as Promise<T>;
      if (command === "open_in_vscode") return api.openInVsCode(String(args?.workspaceRoot ?? "")) as Promise<T>;
      return api.command((args?.request ?? {}) as CoreCommand) as Promise<T>;
    }
    return invokeCore<T>(command, args);
  }
}

function commandOutcome(
  command: CoreCommand,
  kind: CoreCommandOutcome["kind"],
  error?: string,
  rejection?: CommandRejection
): CoreCommandOutcome {
  return {
    kind,
    requestId: command.requestId,
    messageType: command.messageType,
    ...(error ? { error } : {}),
    ...(rejection ? { rejection } : {})
  };
}

function historyPageEnvelope(raw: unknown, command: CoreCommand): HistoryPage {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!record || record.requestId !== command.requestId || record.accepted !== true) {
    throw new Error("Core did not return a matching history page acknowledgement");
  }
  const page = record.historyPage && typeof record.historyPage === "object"
    ? record.historyPage as Record<string, unknown>
    : null;
  if (!page) throw new Error("Core did not return a history page");
  const scope = page.scope;
  const ownerId = page.ownerId ?? page.owner_id;
  if ((scope !== "conversation" && scope !== "timeline") || typeof ownerId !== "string") {
    throw new Error("Core returned an invalid history page identity");
  }
  const pageInfo = normalizeHistoryPageInfo(page.pageInfo ?? page.page_info);
  if (!pageInfo) throw new Error("Core returned invalid history page metadata");
  return {
    scope,
    ownerId,
    ...(scope === "conversation" ? {
      conversationItems: Array.isArray(page.conversationItems ?? page.conversation_items)
        ? ((page.conversationItems ?? page.conversation_items) as unknown[]).map(normalizeProductConversationItem).filter(isPresent)
        : []
    } : {
      timelineItems: Array.isArray(page.timelineItems ?? page.timeline_items)
        ? ((page.timelineItems ?? page.timeline_items) as unknown[]).map(normalizeTimelineItem).filter(isPresent)
        : []
    }),
    pageInfo
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function commandEnvelope(raw: unknown, command: CoreCommand): { snapshot: unknown; duplicate?: boolean } {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!record || !("snapshot" in record)) return { snapshot: raw };
  if (record.accepted !== true) throw new Error("Core did not acknowledge the command");
  if (record.requestId !== command.requestId && record.request_id !== command.requestId) {
    throw new Error("Core command response identity did not match the request");
  }
  return {
    snapshot: record.snapshot,
    duplicate: typeof record.duplicate === "boolean" ? record.duplicate : undefined
  };
}

function mergeReconnectProjection(previous: CoreSnapshot, next: CoreSnapshot): CoreSnapshot {
  const sameView = previous.selectedProjectId === next.selectedProjectId
    && previous.activeCampaignId === next.activeCampaignId
    && previous.activeTask.id === next.activeTask.id
    && previous.attempt.id === next.attempt.id;
  if (!sameView) return next;
  const timeline = mergeByStableId(previous.timeline, next.timeline);
  const productConversation = previous.productConversation && next.productConversation
    ? {
        ...next.productConversation,
        items: mergeByStableId(previous.productConversation.items, next.productConversation.items),
        pageInfo: mergePageInfo(previous.productConversation.pageInfo, next.productConversation.pageInfo)
      }
    : next.productConversation;
  return {
    ...next,
    timeline,
    timelinePageInfo: mergePageInfo(previous.timelinePageInfo, next.timelinePageInfo),
    productConversation,
    cursor: Math.max(previous.cursor, next.cursor)
  };
}

function mergeByStableId<T extends { id: string }>(earlier: readonly T[], later: readonly T[]): T[] {
  const order: string[] = [];
  const byId = new Map<string, T>();
  for (const item of [...earlier, ...later]) {
    if (!byId.has(item.id)) order.push(item.id);
    byId.set(item.id, item);
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

function mergePageInfo(older: HistoryPageInfo | undefined, newer: HistoryPageInfo | undefined): HistoryPageInfo | undefined {
  if (!older) return newer;
  if (!newer) return older;
  return {
    olderCursor: older.olderCursor,
    newerCursor: newer.newerCursor,
    hasOlder: older.hasOlder,
    hasNewer: newer.hasNewer,
    contentBytes: newer.contentBytes,
    itemCount: newer.itemCount
  };
}

function rangesOverlap<T extends { id: string }>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const ids = new Set(left.map((item) => item.id));
  return right.some((item) => ids.has(item.id));
}

function withHistoryAdvancedNotice(snapshot: CoreSnapshot): CoreSnapshot {
  if (snapshot.notices.includes(HISTORY_WINDOW_ADVANCED_NOTICE)) return snapshot;
  return { ...snapshot, notices: [HISTORY_WINDOW_ADVANCED_NOTICE, ...snapshot.notices] };
}

/** Preserve pages the reader explicitly loaded while accepting newer polling state. */
export function mergeSnapshotHistory(previous: CoreSnapshot, next: CoreSnapshot): CoreSnapshot {
  const sameConversation = previous.activeCampaignId === next.activeCampaignId;
  if (!sameConversation) return next;
  const requestedConversationHistory = previous.loadedHistory?.conversationOwnerId === next.activeCampaignId;
  const keepConversationHistory = requestedConversationHistory
    && Boolean(previous.productConversation && next.productConversation)
    && rangesOverlap(previous.productConversation?.items ?? [], next.productConversation?.items ?? []);
  const productConversation = keepConversationHistory && previous.productConversation && next.productConversation
    ? {
        ...next.productConversation,
        items: mergeByStableId(previous.productConversation.items, next.productConversation.items),
        pageInfo: mergePageInfo(previous.productConversation.pageInfo, next.productConversation.pageInfo)
      }
    : next.productConversation;
  const requestedTimelineHistory = previous.attempt.id === next.attempt.id
    && previous.loadedHistory?.timelineOwnerId === next.attempt.id;
  const sameAttempt = requestedTimelineHistory && rangesOverlap(previous.timeline, next.timeline);
  const loadedHistory = {
    ...(keepConversationHistory ? { conversationOwnerId: next.activeCampaignId } : {}),
    ...(sameAttempt ? { timelineOwnerId: next.attempt.id } : {})
  };
  const merged = {
    ...next,
    loadedHistory: Object.keys(loadedHistory).length > 0 ? loadedHistory : undefined,
    productConversation,
    timeline: sameAttempt ? mergeByStableId(previous.timeline, next.timeline) : next.timeline,
    timelinePageInfo: sameAttempt ? mergePageInfo(previous.timelinePageInfo, next.timelinePageInfo) : next.timelinePageInfo
  };
  const historyAdvanced = previous.notices.includes(HISTORY_WINDOW_ADVANCED_NOTICE)
    || (requestedConversationHistory && !keepConversationHistory);
  return historyAdvanced ? withHistoryAdvancedNotice(merged) : merged;
}

export function mergeHistoryPageIntoSnapshot(
  snapshot: CoreSnapshot,
  page: HistoryPage,
  requestedOlderCursor?: string
): CoreSnapshot {
  if (page.scope === "conversation") {
    if (page.ownerId !== snapshot.activeCampaignId || !snapshot.productConversation) return snapshot;
    if (requestedOlderCursor !== undefined
      && snapshot.productConversation.pageInfo?.olderCursor !== requestedOlderCursor) {
      return withHistoryAdvancedNotice(snapshot);
    }
    return {
      ...snapshot,
      notices: snapshot.notices.filter((notice) => notice !== HISTORY_WINDOW_ADVANCED_NOTICE),
      loadedHistory: { ...snapshot.loadedHistory, conversationOwnerId: page.ownerId },
      productConversation: {
        ...snapshot.productConversation,
        items: mergeByStableId(page.conversationItems ?? [], snapshot.productConversation.items),
        pageInfo: {
          ...page.pageInfo,
          newerCursor: snapshot.productConversation.pageInfo?.newerCursor ?? page.pageInfo.newerCursor,
          hasNewer: snapshot.productConversation.pageInfo?.hasNewer ?? page.pageInfo.hasNewer,
          itemCount: mergeByStableId(page.conversationItems ?? [], snapshot.productConversation.items).length
        }
      }
    };
  }
  if (page.ownerId !== snapshot.attempt.id) return snapshot;
  const timeline = mergeByStableId(page.timelineItems ?? [], snapshot.timeline);
  return {
    ...snapshot,
    loadedHistory: { ...snapshot.loadedHistory, timelineOwnerId: page.ownerId },
    timeline,
    timelinePageInfo: {
      ...page.pageInfo,
      newerCursor: snapshot.timelinePageInfo?.newerCursor ?? page.pageInfo.newerCursor,
      hasNewer: snapshot.timelinePageInfo?.hasNewer ?? page.pageInfo.hasNewer,
      itemCount: timeline.length
    }
  };
}

function traceCommand(
  phase: CommandTraceEntry["phase"],
  command: CoreCommand,
  kind?: CoreCommandOutcome["kind"]
): void {
  if (typeof window === "undefined" || window.__GOALPORT_ISOLATED !== 1) return;
  const textField = (key: string): string | undefined => {
    const value = command.payload[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const entry: CommandTraceEntry = {
    phase,
    requestId: command.requestId,
    messageType: command.messageType,
    provider: textField("provider"),
    campaignId: textField("campaignId"),
    taskId: textField("taskId"),
    attemptId: textField("attemptId"),
    ...(kind ? { kind } : {})
  };
  window.__goalportCommandTrace = [...(window.__goalportCommandTrace ?? []), entry].slice(-64);
}

const GOAL_ATTENTION = new Set(["running", "awaiting_approval", "failed", "needs_recovery", "idle", "complete"]);

function normalizeGoalOverview(value: unknown): GoalOverview {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const goals = record?.goals;
  const pending = record?.pending;
  if (!record || !Array.isArray(goals) || !Array.isArray(pending)) {
    throw new Error("Core returned an invalid goal overview");
  }
  return {
    revision: typeof record.revision === "string" ? record.revision : "",
    truncated: record.truncated === true,
    goals: goals.map((item) => {
      const goal = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const attention = typeof goal.attention === "string" && GOAL_ATTENTION.has(goal.attention)
        ? goal.attention as GoalCard["attention"]
        : "idle";
      return {
        campaignId: typeof goal.campaignId === "string" ? goal.campaignId : "",
        projectId: typeof goal.projectId === "string" ? goal.projectId : "",
        workspaceRoot: typeof goal.workspaceRoot === "string" ? goal.workspaceRoot : "",
        title: typeof goal.title === "string" && goal.title.trim() ? goal.title : "Untitled goal",
        attention,
        attemptId: typeof goal.attemptId === "string" ? goal.attemptId : "",
        provider: typeof goal.provider === "string" ? goal.provider : ""
      };
    }).filter((goal) => goal.campaignId),
    pending: pending.map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        decisionId: typeof row.decisionId === "string" ? row.decisionId : "",
        campaignId: typeof row.campaignId === "string" ? row.campaignId : "",
        attemptId: typeof row.attemptId === "string" ? row.attemptId : "",
        title: typeof row.title === "string" ? row.title : "Approval needed",
        kind: typeof row.kind === "string" ? row.kind : "permission"
      };
    }).filter((item) => item.decisionId && item.campaignId)
  };
}

class CoreRequestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreRequestRefused";
  }
}

function isCoreRefusal(error: unknown): error is CoreRequestRefused {
  return error instanceof CoreRequestRefused;
}

/**
 * The user is looking at one real Linux goal. This client asks Core for that
 * goal by id and never substitutes the sample preview when the socket is down.
 */
class LinuxCoreClient implements CoreClient {
  readonly mode = "linux-core" as const;
  private viewCampaignId = "";
  private viewPinned = false;
  private revision = "";
  private suspended = false;
  private generation = 0;
  private appliedGeneration = 0;
  private mutationDepth = 0;
  private routeMiss = "";
  private lastSnapshot: CoreSnapshot = { ...EMPTY_SNAPSHOT, preview: false, notices: [] };

  pinView(campaignId: string): void {
    if (!campaignId) return;
    this.viewCampaignId = campaignId;
    this.viewPinned = true;
    this.revision = "";
  }

  takeRouteMiss(): string {
    const miss = this.routeMiss;
    this.routeMiss = "";
    return miss;
  }

  private claimGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private commitSnapshot(generation: number, snapshot: CoreSnapshot): CoreSnapshot {
    if (generation < this.appliedGeneration) return this.lastSnapshot;
    this.appliedGeneration = generation;
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async snapshot(): Promise<CoreSnapshot> {
    if (this.suspended) return this.lastSnapshot;
    const generation = this.claimGeneration();
    const mutationAtStart = this.mutationDepth;
    try {
      const payload: Record<string, string> = {};
      if (this.viewCampaignId) payload.campaignId = this.viewCampaignId;
      if (this.revision) payload.revision = this.revision;
      const response = await this.post("snapshot_if_changed", payload);
      const envelope = payloadOf(response);
      const overview = await this.readOverview();
      if (mutationAtStart !== 0 || this.mutationDepth !== 0 || generation < this.appliedGeneration) return this.lastSnapshot;
      if (envelope.unchanged === true) {
        this.revision = typeof envelope.revision === "string" ? envelope.revision : this.revision;
        return this.commitSnapshot(generation, { ...this.lastSnapshot, preview: false, goalOverview: overview });
      }
      const snapshot = resolveCoreSnapshot(envelope.snapshot);
      if (!snapshot) throw new Error("Core returned an invalid snapshot");
      if (!this.viewPinned && !this.viewCampaignId && snapshot.activeCampaignId) this.viewCampaignId = snapshot.activeCampaignId;
      this.revision = typeof envelope.revision === "string" ? envelope.revision : "";
      return this.commitSnapshot(generation, { ...snapshot, preview: false, goalOverview: overview });
    } catch (error) {
      if (mutationAtStart !== 0 || this.mutationDepth !== 0 || generation < this.appliedGeneration) return this.lastSnapshot;
      const message = errorMessage(error);
      const missing = this.viewPinned && this.viewCampaignId && (
        message.includes("has no owning project")
        || message.includes("entity not found")
        || message.includes("Query returned no rows")
      );
      if (isCoreRefusal(error)) {
        if (missing) {
          this.routeMiss = this.viewCampaignId;
          this.viewPinned = false;
          this.viewCampaignId = "";
          this.revision = "";
          return this.snapshot();
        }
        const notice = `Core refused: ${message}`;
        return this.commitSnapshot(generation, {
          ...this.lastSnapshot,
          preview: false,
          notices: [notice, ...this.lastSnapshot.notices.filter((item) => item !== notice)]
        });
      }
      return this.fail(error);
    }
  }

  async selectCampaign(campaignId: string): Promise<CoreSnapshot> {
    const generation = this.claimGeneration();
    this.mutationDepth += 1;
    const previousView = this.viewCampaignId;
    const previousRevision = this.revision;
    const previousPinned = this.viewPinned;
    this.viewCampaignId = campaignId;
    this.viewPinned = true;
    this.revision = "";
    try {
      const response = await this.post("goal_detail", { campaignId });
      const envelope = payloadOf(response);
      const snapshot = resolveCoreSnapshot(envelope.snapshot);
      if (!snapshot || snapshot.activeCampaignId !== campaignId) {
        throw new Error("Core did not return that goal");
      }
      this.revision = typeof envelope.revision === "string" ? envelope.revision : "";
      const overview = await this.readOverview();
      if (generation < this.appliedGeneration) return this.lastSnapshot;
      return this.commitSnapshot(generation, { ...snapshot, preview: false, goalOverview: overview });
    } catch (error) {
      if (generation < this.appliedGeneration) return this.lastSnapshot;
      this.viewCampaignId = previousView;
      this.viewPinned = previousPinned;
      this.revision = previousRevision;
      if (isCoreRefusal(error)) {
        const message = errorMessage(error);
        const notice = `Core refused: ${message}`;
        return this.commitSnapshot(generation, {
          ...this.lastSnapshot,
          preview: false,
          notices: [notice, ...this.lastSnapshot.notices.filter((item) => item !== notice)]
        });
      }
      return this.fail(error);
    } finally {
      this.mutationDepth -= 1;
    }
  }

  async selectProject(): Promise<CoreSnapshot> {
    // Which project is on screen is this page's choice. Opening a goal loads
    // it; there is no shared project selection to update.
    return this.lastSnapshot;
  }

  async createCampaign(workspaceRoot: string, goal: string): Promise<CoreSnapshot> {
    return this.mutate("create_campaign", { workspaceRoot, goal }, true);
  }

  async sendMessage(message: string, campaignId: string, attemptId: string, taskId?: string): Promise<CoreSnapshot> {
    const payload: Record<string, string> = { message, campaignId, attemptId };
    if (taskId) payload.taskId = taskId;
    return this.mutate("send_message", payload, false);
  }

  async resolveDecision(decisionId: string, allow = false): Promise<CoreSnapshot> {
    return this.mutate("resolve_decision", { decisionId, allow }, false);
  }

  async reconnect(): Promise<CoreSnapshot> {
    this.suspended = false;
    return this.snapshot();
  }

  async startCore(): Promise<CoreSnapshot> {
    this.suspended = false;
    return this.snapshot();
  }

  async setConnection(connection: ConnectionState): Promise<CoreSnapshot> {
    if (connection === "disconnected") {
      this.suspended = true;
      this.lastSnapshot = { ...this.lastSnapshot, connection: "disconnected", preview: false };
      return this.lastSnapshot;
    }
    this.suspended = false;
    return this.snapshot();
  }

  async openInVsCode(): Promise<void> {
    return Promise.resolve();
  }

  async startConversation(workspaceRoot: string, provider: string, message: string, stableRequestId: string): Promise<CoreSnapshot> {
    return this.mutate("start_conversation", { workspaceRoot, provider, message }, true, stableRequestId);
  }

  async conversationSend(message: string, campaignId: string, attemptId: string | undefined, stableRequestId: string): Promise<CoreSnapshot> {
    const payload: Record<string, string> = { message, campaignId };
    const persisted = persistedAttemptId(attemptId);
    if (persisted) payload.attemptId = persisted;
    return this.mutate("conversation_send", payload, false, stableRequestId);
  }

  async historyPage(request: HistoryPageRequest): Promise<HistoryPage> {
    const command: CoreCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: requestId(),
      entityVersion: 1,
      messageType: "history_page",
      payload: {
        scope: request.scope,
        ownerId: request.ownerId,
        direction: request.direction,
        ...(request.cursor ? { cursor: request.cursor } : {})
      }
    };
    const response = await this.post(command.messageType, command.payload, command.requestId);
    return historyPageEnvelope(payloadOf(response), command);
  }

  async renameConversation(campaignId: string, title: string): Promise<CoreSnapshot> {
    return this.mutate("rename_conversation", { campaignId, title }, false);
  }

  async selectRuntime(provider: string, campaignId: string, taskId: string, attemptId?: string): Promise<CoreSnapshot> {
    const payload: Record<string, string> = { provider, campaignId, taskId };
    const persisted = persistedAttemptId(attemptId);
    if (persisted) payload.attemptId = persisted;
    return this.mutate("select_runtime", payload, false);
  }

  async interrupt(attemptId: string): Promise<CoreSnapshot> {
    return this.mutate("interrupt", { attemptId }, false);
  }

  async closeSession(attemptId: string): Promise<CoreSnapshot> {
    return this.mutate("close_session", { attemptId }, false);
  }

  async resumeSession(attemptId: string): Promise<CoreSnapshot> {
    return this.mutate("resume_native_session", { attemptId }, false);
  }

  async recheckStopResponsibility(attemptId: string): Promise<CoreSnapshot> {
    return this.mutate("recheck_stop_responsibility", { attemptId }, false);
  }

  async continueInIsolatedWorkspace(attemptId: string, targetWorkspace: string): Promise<CoreSnapshot> {
    return this.mutate("continue_in_isolated_workspace", { attemptId, targetWorkspace }, false);
  }

  async handoff(provider: string, oldAttemptId: string, instruction: string): Promise<CoreSnapshot> {
    return this.mutate("handoff", { provider, oldAttemptId, instruction }, false);
  }

  async revokeAuthorization(campaignId: string, scope = "action"): Promise<CoreSnapshot> {
    return this.mutate("revoke_authorization", { campaignId, scope }, false);
  }

  async requestOwnerAction(action: string, planApproved = true, auditPassed = true): Promise<CoreSnapshot> {
    return this.mutate("request_owner_action", { action, planApproved, auditPassed }, false);
  }

  async notify(): Promise<boolean> {
    return false;
  }

  async chooseWorkspace(): Promise<string | null> {
    return null;
  }

  async appInfo(): Promise<AppInfo> {
    return { version: "", channel: "linux-core", testMode: false, dataPath: "" };
  }

  private async readOverview(): Promise<GoalOverview> {
    const response = await this.post("goal_overview", {});
    return normalizeGoalOverview(payloadOf(response).overview);
  }

  private async mutate(
    messageType: CoreCommand["messageType"],
    payload: Record<string, string | number | boolean>,
    adoptView: boolean,
    stableRequestId?: string
  ): Promise<CoreSnapshot> {
    const generation = this.claimGeneration();
    this.mutationDepth += 1;
    const command: CoreCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: stableRequestId ?? requestId(),
      entityVersion: 1,
      messageType,
      payload
    };
    try {
      const response = await this.post(messageType, payload, command.requestId);
      const snapshot = resolveCoreSnapshot(payloadOf(response).snapshot);
      if (!snapshot) throw new Error("Core returned an invalid snapshot");
      if (generation < this.appliedGeneration) return this.lastSnapshot;
      if (adoptView && snapshot.activeCampaignId) {
        this.viewCampaignId = snapshot.activeCampaignId;
        this.viewPinned = true;
        this.revision = "";
      }
      return this.commitSnapshot(generation, {
        ...snapshot,
        preview: false,
        goalOverview: this.lastSnapshot.goalOverview,
        commandOutcome: commandOutcome(command, "accepted")
      });
    } catch (error) {
      if (generation < this.appliedGeneration) return this.lastSnapshot;
      if (isCoreRefusal(error)) {
        const message = errorMessage(error);
        return this.commitSnapshot(generation, {
          ...this.lastSnapshot,
          preview: false,
          commandOutcome: commandOutcome(command, "refused", message),
          notices: [`Core refused: ${message}`, ...this.lastSnapshot.notices.filter((notice) => notice !== `Core refused: ${message}`)]
        });
      }
      const message = errorMessage(error);
      return this.commitSnapshot(generation, {
        ...this.lastSnapshot,
        preview: false,
        connection: "disconnected",
        commandOutcome: commandOutcome(command, "transport-error", message),
        notices: [`Core request failed: ${message}`, ...this.lastSnapshot.notices]
      });
    } finally {
      this.mutationDepth -= 1;
    }
  }

  private fail(error: unknown): CoreSnapshot {
    const message = errorMessage(error);
    this.lastSnapshot = {
      ...this.lastSnapshot,
      preview: false,
      connection: "disconnected",
      notices: [`Core request failed: ${message}`, ...this.lastSnapshot.notices.filter((notice) => !notice.startsWith("Core request failed:"))]
    };
    return this.lastSnapshot;
  }

  private async post(messageType: string, payload: Record<string, unknown>, stableRequestId?: string): Promise<Record<string, unknown>> {
    const requestIdValue = stableRequestId ?? requestId();
    let response: Response;
    try {
      response = await fetch("/goalport/ipc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: IPC_PROTOCOL_VERSION,
          requestId: requestIdValue,
          entityVersion: 1,
          messageType,
          payload
        })
      });
    } catch (error) {
      throw new Error(errorMessage(error));
    }
    if (!response.ok) throw new Error("Linux Core is not connected");
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object") throw new Error("Core returned an unreadable response");
    const record = parsed as Record<string, unknown>;
    if (record.ok !== true) {
      const message = typeof record.error === "string" ? record.error : "Core refused the request";
      throw new CoreRequestRefused(message);
    }
    return record;
  }
}

function payloadOf(response: Record<string, unknown>): Record<string, unknown> {
  return response.payload && typeof response.payload === "object" ? response.payload as Record<string, unknown> : {};
}

function linuxCoreEnabled(): boolean {
  return typeof window !== "undefined" && Boolean(window.__GOALPORT_LINUX_CORE__);
}

let sharedClient: CoreClient | undefined;

export function getCoreClient(): CoreClient {
  // A browser preview has no durable process to share. Keeping a fresh
  // synthetic transport per mounted App prevents one test/demo window from
  // leaking its projection into another. Tauri uses one client because it
  // represents the single local Core connection for the desktop window.
  // The Linux bridge is explicit: a missing socket stays disconnected and
  // never falls through to the sample preview.
  if (typeof window !== "undefined" && window.__GOALPORT_ELECTRON__ && window.goalportCore) return new TauriCoreClient("electron");
  if (linuxCoreEnabled()) return new LinuxCoreClient();
  if (!isTauriRuntime()) return new PreviewCoreClient();
  if (!sharedClient) sharedClient = new TauriCoreClient();
  return sharedClient;
}

export function resetCoreClientForTests(): void {
  sharedClient = undefined;
}
