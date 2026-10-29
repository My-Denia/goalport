import type { ExecutionWorkspaceEvidence, AuditInputEvidenceCoverage } from "./coordinateGoal";
import type { SavedTargetContinuation, SavedTargetRelationStatus } from "./continuation";

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
  rememberedIntent?: { background: boolean; write: boolean } | null;
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
  identityConfirmed: boolean;
  line: string;
}
export interface SavedTargetPayload {
  ok?: boolean;
  record?: SavedTargetResult | null;
  roots?: SavedTargetSummary[];
  history?: { requestId: string; savedAt?: string; outcome?: string }[];
  currentJob?: CoordinatedCurrentJob | null;
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
