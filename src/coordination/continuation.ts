/**
 * SavedTargetContinuation descriptor and shape validation.
 *
 * Closed descriptor describing origin of a coordinated goal continuation:
 * parentRequestId, rootRequestId, originalGoal, and followUp.
 * Describes origin only; never grant, scope, remaining budget, or native handle.
 */

export interface SavedTargetContinuation {
  readonly parentRequestId: string;
  readonly rootRequestId: string;
  readonly originalGoal: string;
  readonly followUp: string;
}

export type SavedTargetRelationStatus =
  | "valid"
  | "root"
  | "legacy-root"
  | "invalid"
  | "ambiguous";

export const MAX_CONTINUATION_CHARS = 100_000;
export const MAX_CONTINUATION_PROMPT_BYTES = 100_000;
export const CONTINUATION_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidContinuationDescriptor(value: unknown): value is SavedTargetContinuation {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !keys.every((key) => ["parentRequestId", "rootRequestId", "originalGoal", "followUp"].includes(key))) return false;
  if (typeof value.parentRequestId !== "string" || typeof value.rootRequestId !== "string") return false;
  const parentRequestId = value.parentRequestId.trim();
  const rootRequestId = value.rootRequestId.trim();
  if (!parentRequestId || !rootRequestId) return false;
  if (!CONTINUATION_REQUEST_ID_PATTERN.test(parentRequestId) || !CONTINUATION_REQUEST_ID_PATTERN.test(rootRequestId)) return false;
  if (parentRequestId.length > 256 || rootRequestId.length > 256) return false;
  if (typeof value.originalGoal !== "string" || typeof value.followUp !== "string") return false;
  const originalGoal = value.originalGoal.trim();
  if (originalGoal.length === 0) return false;
  const followUp = value.followUp.trim();
  if (originalGoal.length > MAX_CONTINUATION_CHARS || followUp.length > MAX_CONTINUATION_CHARS) return false;
  if (originalGoal.length + followUp.length > MAX_CONTINUATION_CHARS) return false;
  return true;
}

export function normalizeContinuationDescriptor(value: unknown): SavedTargetContinuation | null {
  if (!isValidContinuationDescriptor(value)) return null;
  return {
    parentRequestId: value.parentRequestId.trim(),
    rootRequestId: value.rootRequestId.trim(),
    originalGoal: value.originalGoal.trim(),
    followUp: value.followUp.trim(),
  };
}

export function validatedContinuationOf(record: { continuation?: unknown } | null | undefined): SavedTargetContinuation | undefined {
  if (!record || typeof record !== "object") return undefined;
  if (record.continuation === undefined || record.continuation === null) return undefined;
  return normalizeContinuationDescriptor(record.continuation) ?? undefined;
}
