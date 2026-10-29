import { normalizePiCapacity, samePiPair, type PiCapacitySelection } from "../../electron/pi-capacity.mjs";
import type { ExecutionWorkspaceEvidence, AuditInputEvidenceCoverage } from "./coordinateGoal";
import type { SavedTargetContinuation, SavedTargetRelationStatus } from "./continuation";
import type { LiveReadStatus } from "./liveRead";

/** Public workbench projection only. No admission/scope/control material. */
export interface SavedTargetResult {
  requestId: string;
  rootRequestId: string | null;
  rootLatestId: string | null;
  goal: string;
  workspacePath: string;
  verdict: string;
  outcome: string | null;
  statusLabel?: string;
  relationStatus: SavedTargetRelationStatus;
  relationUnavailableReason: string | null;
  continuation?: SavedTargetContinuation;
  detail?: string | null;
  change?: string | null;
  executionEvidence?: ExecutionWorkspaceEvidence | null;
  auditInputEvidenceCoverage?: AuditInputEvidenceCoverage | null;
  auditInputEvidenceText?: string | null;
  piCapacity?: PiCapacitySelection;
  rememberedIntent?: { background: boolean; write: boolean; piCapacity?: PiCapacitySelection; legacyPi?: boolean } | null;
}
export interface SavedTargetSummary {
  requestId: string;
  rootRequestId: string | null;
  title: string;
  workspacePath: string;
  outcome: string | null;
  statusLabel?: string;
  reason?: string | null;
}
export interface CoordinatedCurrentJob {
  jobId: string;
  requestId?: string;
  rootRequestId?: string;
  goal?: string;
  workspacePath?: string;
  followUpMode?: "live-read-once";
  liveRead?: LiveReadStatus | null;
  identityConfirmed: boolean;
  line: string;
}
export interface HostCurrentJob extends CoordinatedCurrentJob {
  source: "host-status";
}
export interface SavedAllowanceView {
  kind: "saved-allowance";
  jobId: string;
  initialRequestId: string;
  rootRequestId: string | null;
  state: string;
  phase: string | null;
  allowanceEnd: "idle-stopped" | "expired" | null;
  liveRead?: never;
  counters?: never;
  acceptedRequestId?: never;
}
export type GlobalSlot = { kind: "empty" } | { kind: "occupied"; jobId: string; admittedRequestId: string } | { kind: "unknown" };
export interface SavedCurrentBase {
  kind: "saved-current-base";
  jobId: string;
  admittedRequestId: string | null;
  rootRequestId: string | null;
  goal: string | null;
  workspacePath: string | null;
  identityConfirmed: boolean;
  followUpMode: "live-read-once" | null;
  state: string;
  phase: string | null;
  pending: "none" | "present" | "unknown";
  revoked: boolean | "unknown";
  workerGone: boolean | "unknown";
  unconfirmed: boolean;
  active: boolean | "unknown";
  allowanceEnd: "idle-stopped" | "expired" | null | "unknown";
  observedAcceptedChildId: string | null;
  globalSlot: GlobalSlot;
  profileUnconfirmed: boolean;
  leftoverHeld: boolean;
  liveRead?: never;
  counters?: never;
  acceptedRequestId?: never;
}
export interface SubmissionCandidate {
  kind: "submission-candidate";
  jobId: string;
  admittedRequestId: string;
  rootRequestId: string;
  goal: string;
  workspacePath: string;
  identityConfirmed: boolean;
  active: boolean | "unknown";
}
export interface SavedTargetPayload {
  ok?: boolean;
  record?: SavedTargetResult | null;
  roots?: SavedTargetSummary[];
  history?: { requestId: string; savedAt?: string; outcome?: string }[];
  currentBase?: SavedCurrentBase | null;
  savedAllowanceView?: SavedAllowanceView | null;
  globalSlot?: GlobalSlot;
  submissionCandidate?: SubmissionCandidate | null;
  currentJob?: never;
  allowanceJob?: never;
  currentGoal?: { goal?: string; workspacePath?: string };
  line?: string | null;
  jobId?: string | null;
  leftRequestIds?: string[];
  unconfirmedGoal?: boolean;
  leftoverHeld?: boolean;
  reason?: string;
}

export function continuationUnavailable(record: SavedTargetResult | null): string | null {
  if (!record) return "That saved goal is no longer available or cannot be identified.";
  if (Object.hasOwn(record, "piCapacity") && (!normalizePiCapacity(record.piCapacity) || !normalizePiCapacity(record.rememberedIntent?.piCapacity) || !samePiPair(record.piCapacity, record.rememberedIntent?.piCapacity))) return "This saved Pi route is unavailable. Its result is still shown.";
  if (!record.rootRequestId) return record.relationUnavailableReason || "The saved goal relationship is unavailable.";
  if (!record.rootLatestId) return "The latest result cannot be identified.";
  if (record.rootLatestId !== record.requestId) return "Open the newer result before continuing.";
  return null;
}

export function admittedIdentity(body: { ok?: boolean; error?: unknown; payload?: { stdout?: unknown } } | null): { requestId: string; jobId: string | null } | null {
  if (!body || body.ok === false || body.error || typeof body.payload?.stdout !== "string") return null;
  const stdout = body.payload.stdout;
  const match = stdout.match(/The goal was admitted with request id ([A-Za-z0-9._-]{1,256})[;,]/);
  if (!match) return null;
  const job = stdout.match(/^job: ([A-Za-z0-9._-]{1,256})$/m);
  return { requestId: match[1], jobId: job?.[1] ?? null };
}
