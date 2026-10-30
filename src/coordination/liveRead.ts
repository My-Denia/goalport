import { samePiPair } from "../../electron/pi-capacity.mjs";
import type { PiCapacitySelection } from "../../electron/pi-capacity.mjs";
import type { HostCurrentJob, SavedTargetResult } from "./savedTargetView";
export interface LiveReadStatus {
  mode: "live-read-once";
  ready: boolean;
  initialRequestId: string;
  fromRequestId: string;
  rootRequestId: string;
  remainingReads: number | null;
  readonly: boolean;
  pending: boolean;
  revoked: boolean;
  childRequestId: string | null;
  expiresAt: string | null;
  reason: null | "busy" | "revoked" | "expired" | "no-live-scope" | "not-enough-reads" | "unconfirmed" | "context-unavailable";
}
const fields = ["mode", "ready", "initialRequestId", "fromRequestId", "rootRequestId", "remainingReads", "readonly", "pending", "revoked", "childRequestId", "expiresAt", "reason"].sort().join(",");
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(value);
/** Parse the closed permission-free acknowledgement. Malformed is unavailable. */
export function parseLiveRead(value: unknown): LiveReadStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== fields) return null;
  const v = value as LiveReadStatus;
  if (v.mode !== "live-read-once" || !id(v.initialRequestId) || v.fromRequestId !== v.initialRequestId || !id(v.rootRequestId)
    || ![v.ready, v.readonly, v.pending, v.revoked].every(x => typeof x === "boolean")
    || !(v.remainingReads === null || (Number.isInteger(v.remainingReads) && v.remainingReads >= 0 && v.remainingReads <= 4))
    || !(v.childRequestId === null || (id(v.childRequestId) && v.childRequestId !== v.initialRequestId))
    || !(v.expiresAt === null || (typeof v.expiresAt === "string" && Number.isFinite(Date.parse(v.expiresAt))))
    || ![null, "busy", "revoked", "expired", "no-live-scope", "not-enough-reads", "unconfirmed", "context-unavailable"].includes(v.reason)
    || (v.ready && (!v.readonly || v.pending || v.revoked || v.childRequestId !== null || v.remainingReads === null || v.remainingReads < 2 || !v.expiresAt || v.reason !== null))) return null;
  return { ...v };
}
export function matchingAcknowledgedLiveReady(job: HostCurrentJob | null, selected: SavedTargetResult | null, pair?: PiCapacitySelection): boolean {
  const live = parseLiveRead(job?.liveRead);
  return !!(job?.source === "host-status" && job.identityConfirmed && job.followUpMode === "live-read-once" && selected && live?.ready
    && live.initialRequestId === job.requestId && live.fromRequestId === selected.requestId && job.requestId === selected.requestId
    && live.rootRequestId === selected.rootRequestId && job.rootRequestId === selected.rootRequestId
    && live.expiresAt !== null && Date.now() < Date.parse(live.expiresAt)
    && selected.rootLatestId === selected.requestId && selected.workspacePath === job.workspacePath
    && samePiPair(selected.piCapacity, pair) && samePiPair(selected.rememberedIntent?.piCapacity, pair)
    && selected.rememberedIntent?.background === true && selected.rememberedIntent.write === false);
}
export function liveAcceptedRequest(body: unknown, jobId?: string, fromRequestId?: string): string | null {
  if (!body || typeof body !== "object") return null;
  const reply = body as { ok?: boolean; payload?: { stdout?: unknown } };
  if (reply.ok !== true || typeof reply.payload?.stdout !== "string") return null;
  if ((jobId !== undefined && reply.payload.stdout.match(/^job: ([A-Za-z0-9._-]{1,256})$/m)?.[1] !== jobId)
    || (fromRequestId !== undefined && reply.payload.stdout.match(/^request: ([A-Za-z0-9._-]{1,256})$/m)?.[1] !== fromRequestId)) return null;
  return reply.payload.stdout.match(/^live accepted request: ([A-Za-z0-9._-]{1,256})$/m)?.[1] ?? null;
}
