import { invoke } from "@tauri-apps/api/core";
import {
  appendPreviewMessage,
  createPreviewCampaign,
  DEMO_SNAPSHOT,
  EMPTY_SNAPSHOT,
  resolveCoreSnapshot,
  resolvePermission,
  withConnection,
  type ConnectionState,
  type CoreCommandOutcome,
  type CoreSnapshot,
  type TimelineItem
} from "./types";

export const IPC_PROTOCOL_VERSION = "goalport.ipc.v1";

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
    | "send_message"
    | "resolve_decision"
    | "permission_response"
    | "interrupt"
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
  readonly mode: "tauri" | "electron" | "browser-preview";
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
  selectRuntime?(provider: string, campaignId: string, taskId: string, attemptId?: string): Promise<CoreSnapshot>;
  interrupt?(attemptId: string): Promise<CoreSnapshot>;
  recheckStopResponsibility?(attemptId: string): Promise<CoreSnapshot>;
  continueInIsolatedWorkspace?(attemptId: string, targetWorkspace: string): Promise<CoreSnapshot>;
  revokeAuthorization?(campaignId: string, scope?: string): Promise<CoreSnapshot>;
  requestOwnerAction?(action: string, planApproved?: boolean, auditPassed?: boolean): Promise<CoreSnapshot>;
  notify?(title: string, body: string): Promise<boolean>;
  chooseWorkspace?(): Promise<string | null>;
  appInfo?(): Promise<AppInfo>;
  dispatch?(request: CoreCommand): Promise<CoreSnapshot>;
}

export interface AppInfo {
  version: string;
  channel: string;
  testMode: boolean;
  dataPath: string;
}

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
  private state: CoreSnapshot = DEMO_SNAPSHOT;

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

  async openInVsCode(): Promise<void> {
    // The browser preview cannot launch a local editor. The UI keeps this action explicit.
    return Promise.resolve();
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
        authorization: "goalport-ui-user-action",
        authorizationManifest: "goal-runs/goalport-electron-stable-v1/evidence/locks/shared-interface-freeze.json"
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
        this.lastSnapshot = {
          ...this.lastSnapshot,
          commandOutcome: commandOutcome(command, "refused", message),
          notices: [`Core refused: ${message}`, ...this.lastSnapshot.notices]
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

  private rememberIsolatedSnapshot(): void {
    if (typeof window !== "undefined" && window.__GOALPORT_ISOLATED === 1) {
      window.__goalportLastSnapshot = this.lastSnapshot;
    }
  }

  async interrupt(attemptId: string): Promise<CoreSnapshot> {
    return this.dispatch({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: requestId(), entityVersion: this.entityVersion, messageType: "interrupt", payload: { attemptId } });
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
  error?: string
): CoreCommandOutcome {
  return {
    kind,
    requestId: command.requestId,
    messageType: command.messageType,
    ...(error ? { error } : {})
  };
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
  const timeline = dedupeTimeline([...previous.timeline, ...next.timeline]);
  return { ...next, timeline, cursor: Math.max(previous.cursor, next.cursor) };
}

function dedupeTimeline(items: TimelineItem[]): TimelineItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
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

let sharedClient: CoreClient | undefined;

export function getCoreClient(): CoreClient {
  // A browser preview has no durable process to share. Keeping a fresh
  // synthetic transport per mounted App prevents one test/demo window from
  // leaking its projection into another. Tauri uses one client because it
  // represents the single local Core connection for the desktop window.
  if (typeof window !== "undefined" && window.__GOALPORT_ELECTRON__ && window.goalportCore) return new TauriCoreClient("electron");
  if (!isTauriRuntime()) return new PreviewCoreClient();
  if (!sharedClient) sharedClient = new TauriCoreClient();
  return sharedClient;
}

export function resetCoreClientForTests(): void {
  sharedClient = undefined;
}
