export type ConnectionState = "connected" | "disconnected" | "reconnecting" | "degraded";

export type TimelineKind =
  | "message"
  | "plan"
  | "attempt"
  | "tool"
  | "permission"
  | "decision"
  | "evidence"
  | "audit"
  | "handoff"
  | "recovery"
  | "completion";

export type EvidenceState = "verified" | "needs-review" | "stale" | "unavailable" | "unsupported";
export type ProviderSupport = "supported" | "partial" | "unsupported" | "unknown";
export type AttemptState = "active" | "waiting" | "completed" | "failed" | "uncertain";

/** Transport-local result metadata. CoreSnapshot itself remains the durable projection. */
export interface CoreCommandOutcome {
  kind: "accepted" | "refused" | "transport-error";
  requestId: string;
  messageType: string;
  duplicate?: boolean;
  error?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  workspaceRoot: string;
  color: string;
}

export interface CampaignSummary {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  state: "active" | "paused" | "complete" | "blocked";
  taskCount: number;
  activeTaskTitle: string;
  updatedLabel: string;
}

export interface AttemptSummary {
  id: string;
  taskId: string;
  provider: string;
  role: "planner" | "executor" | "auditor";
  state: AttemptState;
  sessionLabel: string;
  /** Redacted identity used to compare native sessions across handoffs. */
  sessionHash?: string;
  eventCount: number;
}

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  actor: string;
  title: string;
  body: string;
  timestamp: string;
  status?: string;
  evidenceState?: EvidenceState;
  details?: string[];
  accent?: "violet" | "blue" | "amber" | "green" | "red" | "slate";
}

export interface RuntimeProfile {
  /** Core-owned Runtime identity. Unknown ids stay unknown instead of becoming Codex. */
  id: string;
  name: string;
  version: string;
  support: ProviderSupport;
  mode: string;
  subtitle: string;
  reasons: string[];
  capabilities: {
    events: EvidenceState;
    resume: EvidenceState;
    permissions: EvidenceState;
    cancel: EvidenceState;
  };
}

export interface DecisionRequest {
  id: string;
  title: string;
  kind: "permission" | "policy" | "handoff" | "lease";
  facts: string[];
  recommendation: string;
  defaultBehavior: string;
  state: "pending" | "resolved";
}

export interface EvidenceSummary {
  id: string;
  claim: string;
  state: EvidenceState;
  source: string;
  snapshot: string;
}

export interface StopResponsibilitySummary {
  attemptId: string;
  operationId: string;
  provider: string;
  nativeTurnState: "pending" | "interrupted" | "unconfirmed";
  residualExecutionState: "unknown" | "active";
  writeResponsibility: "held";
  inputUuid: string;
  sessionHash: string;
  turnEpoch: number;
  processEpoch: string;
  source: string;
  detail?: unknown;
  /// Added in the post-Stop continuation revision. All optional on the wire: a Core
  /// that predates them still normalizes to a valid held summary, and the gates that
  /// read `writeResponsibility` keep working unchanged.
  workspaceKey?: string;
  interruptedAt?: string;
  taskTitle?: string;
  campaignGoal?: string;
  blockedReason?: string;
  blocksCurrentWorkspace?: boolean;
  latestRecheck?: RecheckObservationSummary | null;
}

export interface RecheckObservationSummary {
  seq: number;
  id: string;
  observedAt: string;
  runtimeObservation: "live" | "not-running" | "unknown";
  verdict:
    | "bound-runtime-live"
    | "bound-runtime-absent-residual-still-unknown"
    | "observation-unavailable";
  observationDetail?: unknown;
  activeLeaseCount: number;
  pendingOutboxCount: number;
  attemptState: string;
}

export interface CoreSnapshot {
  protocolVersion: string;
  buildId: string;
  connection: ConnectionState;
  projects: ProjectSummary[];
  selectedProjectId: string;
  project: ProjectSummary;
  campaigns: CampaignSummary[];
  activeCampaignId: string;
  activeTask: {
    id: string;
    title: string;
    acceptance: string;
    state: "waiting" | "in-progress" | "blocked" | "complete";
  };
  attempt: AttemptSummary;
  timeline: TimelineItem[];
  cursor: number;
  runtimes: RuntimeProfile[];
  decisions: DecisionRequest[];
  evidence: EvidenceSummary[];
  stopResponsibility: StopResponsibilitySummary | null;
  relatedHolds: StopResponsibilitySummary[];
  preview: boolean;
  notices: string[];
  /** Added by the desktop client only for the Promise that completed a command. */
  commandOutcome?: CoreCommandOutcome;
}

const initialTimeline: TimelineItem[] = [
  {
    id: "timeline-plan-1",
    kind: "plan",
    actor: "Claude Code · Planner",
    title: "Plan accepted for the preview slice",
    body: "Keep the desktop conversation focused: persist the Campaign, then hand the active Task to the selected Runtime.",
    timestamp: "Today · 09:41",
    status: "active plan",
    details: ["Root Task: GoalPort preview", "Acceptance: structured events + recoverable history"],
    accent: "violet"
  },
  {
    id: "timeline-attempt-1",
    kind: "attempt",
    actor: "Codex · Executor",
    title: "Attempt is running",
    body: "Codex owns the current implementation step. Core has committed 18 events and is still consuming output.",
    timestamp: "Today · 09:42",
    status: "ACTIVE",
    details: ["Task: Build a durable preview", "Lease: held · workspace root", "Session: native session · diagnostic detail only"],
    accent: "blue"
  },
  {
    id: "timeline-tool-1",
    kind: "tool",
    actor: "Codex · Tool activity",
    title: "Output is grouped in the timeline",
    body: "Incremental tool output is persisted by Core. Expand the source in the native Runtime when the full transcript is needed.",
    timestamp: "Today · 09:43",
    status: "18 events",
    details: ["Output: 3 chunks", "Backpressure: within policy"],
    accent: "slate"
  },
  {
    id: "timeline-permission-1",
    kind: "permission",
    actor: "Core · Permission",
    title: "Workspace write permission was declined",
    body: "No write action was sent after the approval was declined. The Attempt remains waiting for a safe next action.",
    timestamp: "Today · 09:45",
    status: "DENIED",
    details: ["Requested: mutate files in the bound workspace", "Effect: no external write observed", "Next: resolve the Decision Inbox item"],
    accent: "red"
  },
  {
    id: "timeline-evidence-1",
    kind: "evidence",
    actor: "Core · Evidence",
    title: "Synthetic workspace snapshot captured",
    body: "The preview baseline is bound to this Task. It needs review from a real Core before it can support a verified completion.",
    timestamp: "Today · 09:46",
    status: "SYNTHETIC",
    evidenceState: "needs-review",
    details: ["Snapshot: synthetic-ws-7f3a · 12 generated files", "Claim: preview baseline is clean", "Range: synthetic command exit 0 · 1–12"],
    accent: "amber"
  },
  {
    id: "timeline-recovery-1",
    kind: "recovery",
    actor: "System · Recovery",
    title: "UI can reconnect without replaying a prompt",
    body: "Core owns the committed Attempt and event journal. Closing this window does not resend the last user message. No prompt will be replayed on reconnect.",
    timestamp: "Today · 09:47",
    status: "READY",
    details: ["Last committed event: 18", "Prompt replay: blocked by command identity"],
    accent: "amber"
  },
  {
    id: "timeline-audit-1",
    kind: "audit",
    actor: "Grok · Auditor",
    title: "Independent audit is unsupported in this preview",
    body: "Grok is visible in the support matrix, but no unsupported capability is treated as a successful audit.",
    timestamp: "Today · 09:48",
    status: "UNSUPPORTED",
    evidenceState: "unsupported",
    details: ["Reason: structured permission and resume evidence not verified", "Fallback: request an audit after a supported Runtime is available"],
    accent: "slate"
  }
];

export const DEMO_SNAPSHOT: CoreSnapshot = {
  protocolVersion: "goalport.ipc.v1",
  buildId: "preview-local",
  connection: "connected",
  projects: [],
  selectedProjectId: "project-goalport",
  project: {
    id: "project-goalport",
    name: "GoalPort",
    workspaceRoot: "C:\\workspace\\goalport",
    color: "violet"
  },
  campaigns: [
    {
      id: "campaign-durable-preview",
      projectId: "project-goalport",
      title: "Build a durable preview",
      goal: "Build a durable preview of the GoalPort desktop control plane",
      state: "active",
      taskCount: 3,
      activeTaskTitle: "Connect the structured desktop slice",
      updatedLabel: "Active · 2m ago"
    },
    {
      id: "campaign-evidence-loop",
      projectId: "project-goalport",
      title: "Evidence loop",
      goal: "Make runtime outcomes easy to verify",
      state: "paused",
      taskCount: 2,
      activeTaskTitle: "Define review bundle",
      updatedLabel: "Paused · yesterday"
    }
  ],
  activeCampaignId: "campaign-durable-preview",
  activeTask: {
    id: "task-structured-desktop",
    title: "Connect the structured desktop slice",
    acceptance: "Send one message, retain ordered events, and recover the view without replay.",
    state: "in-progress"
  },
  attempt: {
    id: "attempt-codex-executor-1",
    taskId: "task-structured-desktop",
    provider: "Codex",
    role: "executor",
    state: "active",
    sessionLabel: "native session · hidden by default",
    eventCount: 18
  },
  timeline: initialTimeline,
  cursor: 18,
  runtimes: [
    {
      id: "claude",
      name: "Claude Code",
      version: "2.1.252",
      support: "partial",
      mode: "Planner",
      subtitle: "Native CLI · Preview path",
      reasons: ["Structured planning events observed", "Resume and native config still need desktop evidence"],
      capabilities: { events: "needs-review", resume: "needs-review", permissions: "needs-review", cancel: "unsupported" }
    },
    {
      id: "codex",
      name: "Codex",
      version: "0.152.0",
      support: "partial",
      mode: "Executor",
      subtitle: "App-server candidate · Preview path",
      reasons: ["Current role matches workspace execution", "Approval and reconnect remain capability-gated"],
      capabilities: { events: "needs-review", resume: "needs-review", permissions: "needs-review", cancel: "unsupported" }
    },
    {
      id: "grok",
      name: "Grok",
      version: "1.0.13",
      support: "partial",
      mode: "Auditor",
      subtitle: "ACP stdio · subscription path",
      reasons: ["Uses the installed subscription-authenticated Grok CLI over ACP stdio", "Native permission prompts are enabled per session; approvals stay one-shot"],
      capabilities: { events: "needs-review", resume: "needs-review", permissions: "needs-review", cancel: "needs-review" }
    }
  ],
  decisions: [
    {
      id: "decision-permission-1",
      title: "Workspace write permission",
      kind: "permission",
      facts: ["Attempt requested a mutating action", "The request is scoped to the bound workspace", "No action was sent after decline"],
      recommendation: "Keep the action declined until you have reviewed the exact change.",
      defaultBehavior: "Remain waiting; do not retry automatically.",
      state: "pending"
    }
  ],
  evidence: [
    {
      id: "evidence-protocol",
      claim: "Desktop protocol version is compatible",
      state: "verified",
      source: "Deterministic IPC contract · goalport.ipc.v1",
      snapshot: "protocol-v1"
    },
    {
      id: "evidence-baseline",
      claim: "Synthetic workspace baseline captured",
      state: "needs-review",
      source: "Preview projection synthetic-ws-7f3a",
      snapshot: "synthetic-ws-7f3a"
    },
    {
      id: "evidence-external-edit",
      claim: "Runtime output still matches the current workspace",
      state: "stale",
      source: "External edit detected by watcher",
      snapshot: "ws-7f3a"
    },
    {
      id: "evidence-grok-audit",
      claim: "Independent Grok audit completed",
      state: "unsupported",
      source: "No verified ACP permission/resume path",
      snapshot: "unavailable"
    },
    {
      id: "evidence-desktop-continuity",
      claim: "Real Desktop restart continuity",
      state: "unavailable",
      source: "Direct Windows Desktop evidence has not been captured",
      snapshot: "unavailable"
    }
  ],
  stopResponsibility: null,
  relatedHolds: [],
  preview: true,
  notices: [
    "Preview: Runtime support is capability-gated and may be unsupported.",
    "Core projection is authoritative; this browser preview uses synthetic data when Tauri is unavailable."
  ]
};

/** Empty transport state used only while a packaged Core is being connected. */
export const EMPTY_SNAPSHOT: CoreSnapshot = {
  protocolVersion: "goalport.ipc.v2",
  buildId: "unbound",
  connection: "disconnected",
  projects: [],
  selectedProjectId: "",
  project: { id: "", name: "No project", workspaceRoot: "", color: "slate" },
  campaigns: [],
  activeCampaignId: "",
  activeTask: { id: "", title: "No task selected", acceptance: "", state: "waiting" },
  attempt: { id: "attempt-unassigned", taskId: "", provider: "unassigned", role: "executor", state: "waiting", sessionLabel: "No Runtime selected", sessionHash: undefined, eventCount: 0 },
  timeline: [],
  cursor: 0,
  runtimes: [],
  decisions: [],
  evidence: [],
  stopResponsibility: null,
  relatedHolds: [],
  preview: false,
  notices: ["Connecting to the detached Core projection…"]
};

export function createPreviewCampaign(snapshot: CoreSnapshot, workspaceRoot: string, goal: string): CoreSnapshot {
  const cleanGoal = goal.trim();
  const title = cleanGoal.length > 44 ? `${cleanGoal.slice(0, 44)}…` : cleanGoal || "Untitled campaign";
  const id = `campaign-preview-${Date.now()}`;
  const taskId = `task-preview-${Date.now()}`;
  const campaign: CampaignSummary = {
    id,
    projectId: snapshot.project.id,
    title,
    goal: cleanGoal || "Explore a GoalPort campaign",
    state: "active",
    taskCount: 1,
    activeTaskTitle: title,
    updatedLabel: "Active · just now"
  };
  return {
    ...snapshot,
    project: { ...snapshot.project, workspaceRoot: workspaceRoot.trim() || snapshot.project.workspaceRoot },
    campaigns: [campaign, ...snapshot.campaigns],
    activeCampaignId: id,
    activeTask: {
      id: taskId,
      title,
      acceptance: "Campaign created in the local preview projection; connect a Core to execute it.",
      state: "in-progress"
    },
    attempt: {
      ...snapshot.attempt,
      id: `attempt-preview-${Date.now()}`,
      taskId,
      state: "waiting",
      eventCount: 0
    },
    timeline: [
      {
        id: `timeline-first-run-${Date.now()}`,
        kind: "message",
        actor: "User",
        title: "Campaign started from first-run setup",
        body: cleanGoal || "Explore a GoalPort campaign",
        timestamp: "Just now",
        status: "SAVED LOCALLY",
        details: [`Workspace: ${workspaceRoot.trim() || snapshot.project.workspaceRoot}`],
        accent: "violet"
      },
      {
        id: `timeline-preview-notice-${Date.now()}`,
        kind: "recovery",
        actor: "System · Preview",
        title: "Execution is waiting for Core",
        body: "The campaign is visible immediately. A Core connection is required before a Runtime receives work.",
        timestamp: "Just now",
        status: "WAITING",
        evidenceState: "unavailable",
        accent: "amber"
      },
      ...snapshot.timeline
    ],
    decisions: [],
    notices: [
      "First-run campaign saved to the browser preview projection.",
      ...snapshot.notices
    ]
  };
}

export function appendPreviewMessage(snapshot: CoreSnapshot, message: string): CoreSnapshot {
  const cleanMessage = message.trim();
  if (!cleanMessage) return snapshot;
  const now = Date.now();
  const messageItem: TimelineItem = {
    id: `timeline-message-${now}`,
    kind: "message",
    actor: "User",
    title: "Message sent to the active Attempt",
    body: cleanMessage,
    timestamp: "Just now",
    status: "QUEUED",
    details: ["Command identity: preview-local", "Replay: blocked until Core confirms the request"],
    accent: "violet"
  };
  const queuedItem: TimelineItem = {
    id: `timeline-message-queued-${now}`,
    kind: "attempt",
    actor: "Core · Attempt",
    title: "Message queued for the active Attempt",
    body: "The preview records the intent. A connected Core decides whether the native Runtime can receive it.",
    timestamp: "Just now",
    status: "WAITING",
    details: ["No duplicate send on reconnect", "Current lease remains unchanged"],
    accent: "blue"
  };
  return {
    ...snapshot,
    timeline: [...snapshot.timeline, messageItem, queuedItem],
    attempt: { ...snapshot.attempt, eventCount: snapshot.attempt.eventCount + 2 }
  };
}

export function withConnection(snapshot: CoreSnapshot, connection: ConnectionState): CoreSnapshot {
  return { ...snapshot, connection };
}

export function resolvePermission(snapshot: CoreSnapshot, allow = false): CoreSnapshot {
  return {
    ...snapshot,
    decisions: snapshot.decisions.map((decision) => (decision.kind === "permission" ? { ...decision, state: "resolved" } : decision)),
    timeline: [
      ...snapshot.timeline,
      {
        id: `timeline-permission-resolved-${Date.now()}`,
        kind: "permission",
        actor: "User · Decision Inbox",
        title: allow ? "Permission allowed once" : "Permission denied",
        body: allow ? "The native Runtime received a one-time approval for this request." : "No write action was sent. The active Attempt remains waiting for an explicit safe next action.",
        timestamp: "Just now",
        status: allow ? "APPROVED ONCE" : "DECLINED",
        details: ["Decision recorded by Core command path", "Session-wide approval: disabled"],
        accent: allow ? "green" : "red"
      }
    ]
  };
}

export function resolveCoreSnapshot(input: unknown): CoreSnapshot | null {
  const raw = asRecord(input);
  if (!raw || !asRecord(raw.project) || !Array.isArray(raw.campaigns) || !Array.isArray(raw.timeline)) return null;
  const rawProject = asRecord(raw.project) ?? {};
  const rawCampaigns = raw.campaigns.map(normalizeCampaign).filter(isPresent);
  const rawTimeline = raw.timeline.map(normalizeTimelineItem).filter(isPresent);
  const rawAttempt = normalizeAttempt(raw.attempt);
  const rawActiveTask = normalizeActiveTask(raw.activeTask ?? raw.active_task);
  return {
    ...EMPTY_SNAPSHOT,
    protocolVersion: asText(raw.protocolVersion ?? raw.protocol_version, EMPTY_SNAPSHOT.protocolVersion),
    buildId: asText(raw.buildId ?? raw.build_id, EMPTY_SNAPSHOT.buildId),
    connection: normalizeConnection(raw.connection),
    projects: Array.isArray(raw.projects)
      ? raw.projects.map(normalizeProject).filter(isPresent)
      : [],
    selectedProjectId: asText(raw.selectedProjectId ?? raw.selected_project_id, asText(rawProject.id, "")),
    project: {
      id: asText(rawProject.id, ""),
      name: asText(rawProject.name, "No workspace selected"),
      workspaceRoot: asText(rawProject.workspaceRoot ?? rawProject.workspace_root, ""),
      color: asText(rawProject.color, "slate")
    },
    campaigns: rawCampaigns,
    activeCampaignId: asText(raw.activeCampaignId ?? raw.active_campaign_id, ""),
    activeTask: rawActiveTask,
    attempt: rawAttempt,
    timeline: rawTimeline,
    cursor: asNumber(raw.cursor, rawTimeline.length),
    runtimes: Array.isArray(raw.runtimes) ? raw.runtimes.map(normalizeRuntime).filter(isPresent) : [],
    decisions: Array.isArray(raw.decisions) ? raw.decisions.map(normalizeDecision).filter(isPresent) : [],
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map(normalizeEvidence).filter(isPresent) : [],
    stopResponsibility: normalizeStopResponsibility(raw.stopResponsibility ?? raw.stop_responsibility),
    relatedHolds: Array.isArray(raw.relatedHolds ?? raw.related_holds)
      ? ((raw.relatedHolds ?? raw.related_holds) as unknown[])
          .map(normalizeStopResponsibility)
          .filter((hold): hold is StopResponsibilitySummary => hold !== null)
      : [],
    preview: raw.preview === true,
    notices: Array.isArray(raw.notices) ? raw.notices.map((notice) => asText(notice, "")).filter(Boolean) : [],
    commandOutcome: undefined
  };
}

type WireRecord = Record<string, unknown>;

function asRecord(value: unknown): WireRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as WireRecord) : null;
}

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalized(value: unknown, fallback: string): string {
  return asText(value, fallback).trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function normalizeProject(value: unknown): ProjectSummary | null {
  const raw = asRecord(value) ?? {};
  const id = optionalText(raw.id);
  if (!id) return null;
  return {
    id,
    name: asText(raw.name, "Project"),
    workspaceRoot: asText(raw.workspaceRoot ?? raw.workspace_root, ""),
    color: asText(raw.color, "violet")
  };
}

function normalizeConnection(value: unknown): ConnectionState {
  const state = normalized(value, "disconnected");
  if (state === "disconnected" || state === "reconnecting" || state === "degraded") return state;
  return state === "connected" ? "connected" : "disconnected";
}

function normalizeCampaign(value: unknown): CampaignSummary | null {
  const raw = asRecord(value) ?? {};
  const id = optionalText(raw.id);
  if (!id) return null;
  const title = asText(raw.title ?? raw.name, "Untitled campaign");
  const state = normalized(raw.state, "active");
  return {
    id,
    projectId: asText(raw.projectId ?? raw.project_id, ""),
    title,
    goal: asText(raw.goal, title),
    state: state === "paused" || state === "complete" || state === "blocked" ? state : "active",
    taskCount: asNumber(raw.taskCount ?? raw.task_count, 0),
    activeTaskTitle: asText(raw.activeTaskTitle ?? raw.active_task_title, title),
    updatedLabel: asText(raw.updatedLabel ?? raw.updated_label, "Updated just now")
  };
}

function normalizeTimelineItem(value: unknown): TimelineItem | null {
  const raw = asRecord(value) ?? {};
  const id = optionalText(raw.id);
  if (!id) return null;
  const kindValue = normalized(raw.kind, "message");
  const kind: TimelineKind = isTimelineKind(kindValue) ? kindValue : "message";
  const details = Array.isArray(raw.details) ? raw.details.map((detail) => asText(detail, "")).filter(Boolean) : undefined;
  return {
    id,
    kind,
    actor: asText(raw.actor ?? raw.author, "Core"),
    title: asText(raw.title, KIND_META_TITLE[kind]),
    body: asText(raw.body ?? raw.message, "Core projection event"),
    timestamp: asText(raw.timestamp ?? raw.createdAt ?? raw.created_at, "Just now"),
    status: typeof raw.status === "string" ? raw.status : undefined,
    evidenceState: normalizeEvidenceState(raw.evidenceState ?? raw.evidence_state),
    details,
    accent: normalizeAccent(raw.accent)
  };
}

const KIND_META_TITLE: Record<TimelineKind, string> = {
  message: "Message recorded",
  plan: "Plan updated",
  attempt: "Attempt updated",
  tool: "Tool activity recorded",
  permission: "Permission decision recorded",
  decision: "Decision recorded",
  evidence: "Evidence captured",
  audit: "Audit recorded",
  handoff: "Handoff recorded",
  recovery: "Recovery recorded",
  completion: "Completion recorded"
};

function isTimelineKind(value: string): value is TimelineKind {
  return value in KIND_META_TITLE;
}

function normalizeAccent(value: unknown): TimelineItem["accent"] {
  const accent = normalized(value, "slate");
  return accent === "violet" || accent === "blue" || accent === "amber" || accent === "green" || accent === "red" ? accent : "slate";
}

function normalizeActiveTask(value: unknown): CoreSnapshot["activeTask"] {
  const raw = asRecord(value) ?? {};
  const state = normalized(raw.state, "in-progress");
  return {
    id: asText(raw.id, ""),
    title: asText(raw.title, "No task selected"),
    acceptance: asText(raw.acceptance, ""),
    state: state === "waiting" || state === "blocked" || state === "complete" ? state : "in-progress"
  };
}

function normalizeAttempt(value: unknown): AttemptSummary {
  const raw = asRecord(value) ?? {};
  const state = normalized(raw.state, "uncertain");
  const role = normalized(raw.role, "executor");
  return {
    id: asText(raw.id, "attempt-unassigned"),
    taskId: asText(raw.taskId ?? raw.task_id, ""),
    provider: asText(raw.provider, "unassigned"),
    role: role === "planner" || role === "auditor" ? role : "executor",
    state: state === "waiting" || state === "completed" || state === "failed" || state === "uncertain" ? state : "active",
    sessionLabel: asText(raw.sessionLabel ?? raw.session_label, "Runtime identity unavailable"),
    sessionHash: typeof raw.sessionHash === "string" ? raw.sessionHash : typeof raw.session_hash === "string" ? raw.session_hash : undefined,
    eventCount: asNumber(raw.eventCount ?? raw.event_count, 0)
  };
}

function normalizeRuntime(value: unknown): RuntimeProfile | null {
  const raw = asRecord(value) ?? {};
  const explicitId = optionalText(raw.id);
  if (!explicitId) return null;
  const name = asText(raw.name, "Runtime");
  const support = normalized(raw.support, "unknown");
  const capabilities = asRecord(raw.capabilities) ?? {};
  return {
    id: explicitId,
    name,
    version: asText(raw.version, "unknown"),
    support: support === "supported" || support === "partial" || support === "unsupported" ? support : "unknown",
    mode: asText(raw.mode, "Unassigned"),
    subtitle: asText(raw.subtitle, "Capability-gated path"),
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map((reason) => asText(reason, "")).filter(Boolean) : ["No routing reason was provided by Core"],
    capabilities: {
      events: normalizeEvidenceState(capabilities.events) ?? "needs-review",
      resume: normalizeEvidenceState(capabilities.resume) ?? "needs-review",
      permissions: normalizeEvidenceState(capabilities.permissions) ?? "needs-review",
      cancel: normalizeEvidenceState(capabilities.cancel) ?? "needs-review"
    }
  };
}

function normalizeDecision(value: unknown): DecisionRequest | null {
  const raw = asRecord(value) ?? {};
  const id = optionalText(raw.id);
  if (!id) return null;
  const kind = normalized(raw.kind, "permission");
  return {
    id,
    title: asText(raw.title, "Core decision"),
    kind: kind === "policy" || kind === "handoff" || kind === "lease" ? kind : "permission",
    facts: Array.isArray(raw.facts) ? raw.facts.map((fact) => asText(fact, "")).filter(Boolean) : [],
    recommendation: asText(raw.recommendation, "Review the facts before allowing an external effect."),
    defaultBehavior: asText(raw.defaultBehavior ?? raw.default_behavior, "Remain blocked; do not retry automatically."),
    state: normalized(raw.state, "pending") === "resolved" ? "resolved" : "pending"
  };
}

function normalizeEvidence(value: unknown): EvidenceSummary | null {
  const raw = asRecord(value) ?? {};
  const id = optionalText(raw.id);
  if (!id) return null;
  return {
    id,
    claim: asText(raw.claim, "Evidence claim"),
    state: normalizeEvidenceState(raw.state) ?? "needs-review",
    source: asText(raw.source, "Core projection"),
    snapshot: asText(raw.snapshot ?? raw.snapshotHash ?? raw.snapshot_hash, "unknown")
  };
}

function normalizeStopResponsibility(value: unknown): StopResponsibilitySummary | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const nativeTurnState = normalized(raw.nativeTurnState ?? raw.native_turn_state, "");
  const residualExecutionState = normalized(raw.residualExecutionState ?? raw.residual_execution_state, "");
  const writeResponsibility = normalized(raw.writeResponsibility ?? raw.write_responsibility, "");
  if (
    !["pending", "interrupted", "unconfirmed"].includes(nativeTurnState)
    || !["unknown", "active"].includes(residualExecutionState)
    || writeResponsibility !== "held"
  ) return null;
  return {
    attemptId: asText(raw.attemptId ?? raw.attempt_id, "unbound"),
    operationId: asText(raw.operationId ?? raw.operation_id, "unbound"),
    provider: asText(raw.provider, "Claude"),
    nativeTurnState: nativeTurnState as StopResponsibilitySummary["nativeTurnState"],
    residualExecutionState: residualExecutionState as StopResponsibilitySummary["residualExecutionState"],
    writeResponsibility: "held",
    inputUuid: asText(raw.inputUuid ?? raw.input_uuid, "unbound"),
    sessionHash: asText(raw.sessionHash ?? raw.session_hash, "unbound"),
    turnEpoch: asNumber(raw.turnEpoch ?? raw.turn_epoch, 0),
    processEpoch: asText(raw.processEpoch ?? raw.process_epoch, "unbound"),
    source: asText(raw.source, "Core durable Stop responsibility"),
    detail: raw.detail,
    // Every field below is OPTIONAL and none participates in the validation above.
    // A Core that predates this revision sends none of them and still yields a
    // valid held summary -- which matters more than it looks: this function
    // returning null would make `responsibilityHeld` false in App.tsx and silently
    // open every gate that guards a held workspace.
    workspaceKey: optionalText(raw.workspaceKey ?? raw.workspace_key),
    interruptedAt: optionalText(raw.interruptedAt ?? raw.interrupted_at),
    taskTitle: optionalText(raw.taskTitle ?? raw.task_title),
    campaignGoal: optionalText(raw.campaignGoal ?? raw.campaign_goal),
    blockedReason: optionalText(raw.blockedReason ?? raw.blocked_reason),
    // Absent means "governs the workspace on screen". Only an explicit false
    // downgrades the panel to a related hold, so an older Core cannot accidentally
    // present a governing hold as somebody else's.
    blocksCurrentWorkspace:
      (raw.blocksCurrentWorkspace ?? raw.blocks_current_workspace) === false ? false : true,
    latestRecheck: normalizeRecheck(raw.latestRecheck ?? raw.latest_recheck)
  };
}

function optionalText(value: unknown): string | undefined {
  const text = asText(value, "");
  return text.length > 0 ? text : undefined;
}

function normalizeRecheck(value: unknown): RecheckObservationSummary | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const runtimeObservation = normalized(raw.runtimeObservation ?? raw.runtime_observation, "");
  const verdict = normalized(raw.verdict, "");
  // The verdict domain has no quiescence member, here as in Core and in SQLite. An
  // unrecognised verdict is dropped rather than passed through, so a future Core
  // cannot introduce a reassuring word this GUI would render verbatim.
  if (
    !["live", "not-running", "unknown"].includes(runtimeObservation)
    || ![
      "bound-runtime-live",
      "bound-runtime-absent-residual-still-unknown",
      "observation-unavailable"
    ].includes(verdict)
  ) return null;
  return {
    seq: asNumber(raw.seq, 0),
    id: asText(raw.id, ""),
    observedAt: asText(raw.observedAt ?? raw.observed_at, ""),
    runtimeObservation: runtimeObservation as RecheckObservationSummary["runtimeObservation"],
    verdict: verdict as RecheckObservationSummary["verdict"],
    observationDetail: raw.observationDetail ?? raw.observation_detail,
    activeLeaseCount: asNumber(raw.activeLeaseCount ?? raw.active_lease_count, 0),
    pendingOutboxCount: asNumber(raw.pendingOutboxCount ?? raw.pending_outbox_count, 0),
    attemptState: asText(raw.attemptState ?? raw.attempt_state, "")
  };
}

function normalizeEvidenceState(value: unknown): EvidenceState | undefined {
  const state = normalized(value, "");
  if (state === "verified" || state === "needs-review" || state === "stale" || state === "unavailable" || state === "unsupported") return state;
  return undefined;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
