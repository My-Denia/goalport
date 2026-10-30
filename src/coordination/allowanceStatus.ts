import type { BackgroundStatus } from "./backgroundStatus";
import { parseLiveRead } from "./liveRead";
import type { HostCurrentJob, SavedCurrentBase, SubmissionCandidate } from "./savedTargetView";

export const STATUS_UNAVAILABLE = "The open allowance could not be confirmed." as const;
export type AllowanceStatusReply =
  | { source: "host-status"; job: BackgroundStatus; jobId: string }
  | { source: "unavailable"; job: null; jobId: string; reason: typeof STATUS_UNAVAILABLE };
export const validJobId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown, max = 8) => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max);

/** Shape validation, not a new store/ACK authority. Reject saved-tagged objects. */
function isBackgroundStatus(v: unknown): v is BackgroundStatus {
  if (!object(v) || "kind" in v || !validJobId(v.jobId) || !id(v.requestId) || typeof v.goal !== "string" || typeof v.workspacePath !== "string"
    || !["admitted", "running", "revoked", "completed", "failed", "stopped", "unconfirmed"].includes(String(v.state))
    || ![v.active, v.live, v.revoked].every(x => typeof x === "boolean")
    || !(v.workerPid === null || (typeof v.workerPid === "number" && Number.isInteger(v.workerPid) && v.workerPid > 0))
    || typeof v.readMaxTurns !== "number" || !Number.isInteger(v.readMaxTurns) || v.readMaxTurns < 2 || v.readMaxTurns > 32
    || !count(v.writeMaxTurns) || v.writeMaxTurns === 0
    || !(v.phase === undefined || v.phase === null || typeof v.phase === "string")
    || !(v.followUpMode === undefined || v.followUpMode === "live-read-once")
    || !(v.acceptedRequestId === undefined || id(v.acceptedRequestId))) return false;
  if (v.counters !== null && (!object(v.counters) || Object.keys(v.counters).some(k => !["readTurnsLeft", "writeTurnsLeft"].includes(k)) || !Object.entries(v.counters).every(([k, x]) => count(x, k === "readTurnsLeft" ? 32 : 8)))) return false;
  if (v.pendingCommand !== null && (!object(v.pendingCommand) || typeof v.pendingCommand.commandId !== "string" || typeof v.pendingCommand.state !== "string")) return false;
  if (!Array.isArray(v.completedCommands) || !v.completedCommands.every(c => object(c) && typeof c.commandId === "string" && object(c.facts))) return false;
  if (!(v.progress === null || (object(v.progress) && (v.progress.activity === undefined || typeof v.progress.activity === "string")))) return false;
  if (!(v.outcome === null || (object(v.outcome) && typeof v.outcome.status === "string" && (v.outcome.allowanceEnd === undefined || ["idle-stopped", "expired"].includes(String(v.outcome.allowanceEnd)))))) return false;
  if (v.liveRead !== undefined) {
    const live = parseLiveRead(v.liveRead);
    if (!live || v.followUpMode !== "live-read-once" || !v.live || live.initialRequestId !== v.requestId
      || (live.ready && (!v.active || v.state !== "running" || v.revoked || v.pendingCommand !== null || v.phase !== "awaiting-followup"))) return false;
  }
  return true;
}
export function parseAllowanceStatus(value: unknown, jobId: string): AllowanceStatusReply | null {
  if (!validJobId(jobId) || !object(value) || value.jobId !== jobId) return null;
  if (value.source === "unavailable") return Object.keys(value).sort().join(",") === "job,jobId,reason,source" && value.job === null && value.reason === STATUS_UNAVAILABLE
    ? { source: "unavailable", job: null, jobId, reason: STATUS_UNAVAILABLE } : null;
  if (value.source !== "host-status" || Object.keys(value).sort().join(",") !== "job,jobId,source" || !isBackgroundStatus(value.job) || value.job.jobId !== jobId) return null;
  return { source: "host-status", job: value.job, jobId };
}
export function statusRoot(job: BackgroundStatus): string | null {
  const live = parseLiveRead(job.liveRead);
  if (live) return live.rootRequestId;
  const continuation = (job as BackgroundStatus & { continuation?: unknown }).continuation;
  if (continuation === undefined) return job.requestId;
  return object(continuation) && id(continuation.rootRequestId) && id(continuation.parentRequestId) && typeof continuation.originalGoal === "string" && typeof continuation.followUp === "string" ? continuation.rootRequestId : null;
}
/** The single host→acknowledged-current-job conversion. Saved bases cannot enter. */
export function acknowledgedCurrentJob(reply: Extract<AllowanceStatusReply, { source: "host-status" }>): HostCurrentJob | null {
  const validated = parseAllowanceStatus(reply, reply?.jobId);
  if (validated?.source !== "host-status") return null;
  const job = validated.job, live = job.live ? parseLiveRead(job.liveRead) : null;
  const line = live?.ready ? "Ready for one follow-up. No model is running."
    : live?.reason === "busy" && job.phase === "awaiting-followup" && !live.pending && !live.childRequestId ? "Checking the open allowance. No model is running."
    : job.state === "unconfirmed" ? "The open allowance is not confirmed. Your result is kept."
    : job.progress?.activity || (job.active ? "Checking the open allowance. Your saved result is kept." : "The allowance has ended. Your result is kept.");
  return { source: "host-status", jobId: job.jobId, requestId: job.requestId, rootRequestId: statusRoot(job) ?? undefined, goal: job.goal,
    workspacePath: job.workspacePath, followUpMode: job.followUpMode, liveRead: live, identityConfirmed: statusRoot(job) !== null, line };
}
export function readyBase(base: SavedCurrentBase | null | undefined): base is SavedCurrentBase {
  return !!(base?.kind === "saved-current-base" && base.identityConfirmed && base.followUpMode === "live-read-once"
    && base.active === true && base.state === "running" && base.phase === "awaiting-followup" && base.pending === "none"
    && base.revoked === false && base.workerGone === false && base.unconfirmed === false && base.allowanceEnd === null
    && base.observedAcceptedChildId === null && base.profileUnconfirmed === false && base.leftoverHeld === false
    && base.globalSlot?.kind === "occupied" && base.globalSlot.jobId === base.jobId && base.globalSlot.admittedRequestId === base.admittedRequestId);
}
export function sameReadyBase(a: SavedCurrentBase, b: SavedCurrentBase): boolean {
  return readyBase(a) && readyBase(b) && (Object.keys(a) as (keyof SavedCurrentBase)[]).filter(k => k !== "globalSlot").every(k => a[k] === b[k])
    && a.globalSlot.kind === "occupied" && b.globalSlot.kind === "occupied" && a.globalSlot.jobId === b.globalSlot.jobId && a.globalSlot.admittedRequestId === b.globalSlot.admittedRequestId;
}
export function matchesBase(job: BackgroundStatus, base: SavedCurrentBase): boolean {
  return base.identityConfirmed && job.jobId === base.jobId && job.requestId === base.admittedRequestId && statusRoot(job) === base.rootRequestId
    && job.goal === base.goal && job.workspacePath === base.workspacePath;
}
export function confirmedAssociation(job: BackgroundStatus, candidate: SubmissionCandidate, held: { requestId: string; goal: string; workspace: string; root: string | null }): boolean {
  if (candidate.kind !== "submission-candidate" || !candidate.identityConfirmed || !held.workspace.startsWith("/")
    || candidate.admittedRequestId !== held.requestId || candidate.goal !== held.goal || candidate.workspacePath !== held.workspace
    || job.jobId !== candidate.jobId || job.requestId !== held.requestId || statusRoot(job) !== candidate.rootRequestId
    || (held.root !== null && statusRoot(job) !== held.root) || job.goal !== held.goal || job.workspacePath !== held.workspace || job.pendingCommand !== null) return false;
  return (job.active && job.live && ["admitted", "running"].includes(job.state) && !job.revoked)
    || (!job.active && !job.live && ["completed", "failed", "stopped"].includes(job.state) && job.outcome?.status === job.state);
}
export function confirmedIdleEnd(job: BackgroundStatus, held: { jobId: string; requestId: string; root: string }): boolean {
  return job.jobId === held.jobId && job.requestId === held.requestId && statusRoot(job) === held.root && job.followUpMode === "live-read-once"
    && !job.active && !job.live && job.pendingCommand === null && ["stopped", "completed"].includes(job.state) && job.outcome?.status === job.state && job.liveRead === undefined;
}
