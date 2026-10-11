import type { CoordinationWriteAuthorization } from "./coordinateGoal";

/**
 * C2 background job contract: the typed admission input for the ONE
 * explicitly opted-in coordination job that may outlive the desktop window,
 * plus the permission-free projections the rest of the product reads.
 *
 * Layer rules this module exists to keep true:
 * - Background consent and write consent stay separate decisions. The literal
 *   `backgroundConsent: true` admits a job to keep RUNNING after the window
 *   closes; only the separate optional `write` block lets it change the
 *   workspace, with its own members, root and cap.
 * - Job state is its own type. It must never become SavedPlan or
 *   CoordinationView authority: history alone restores no permission.
 * - Membership lists and turn caps are carried here as the caller's request;
 *   the existing scope module stays the only authority that validates the
 *   closed ranges and grants turns. This adapter never re-owns budgets, and
 *   a missing or malformed admission is never permission to respawn.
 */

/** The one repair-refusal line for the background adapter: no window exists to confirm. */
export const BACKGROUND_REPAIR_REFUSAL_SENTENCE =
  "GoalPort could not confirm this background job for the automatic repair, so the repair did not start.";

/**
 * Caller-stable request id shape: letters, digits, dots, underscores, colons
 * and hyphens, so the same id is safe in logs, endpoint names and job file
 * names without silent rewriting. The existing id generators (UUID, and the
 * goalport-/close- fallbacks) all fit.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Separate explicit write consent for an admitted job. Absent means it never writes. */
export interface BackgroundJobWriteScope {
  /** Closed write-membership list; the live scope module remains the authority. */
  readonly instances: readonly string[];
  /** The one workspace root these write turns may change. */
  readonly workspaceRoot: string;
  /** Requested write-turn cap at admission; the scope module owns the closed range. */
  readonly maxTurns: number;
}

/**
 * Typed start input for one background job. Everything here becomes the
 * immutable admission record: the caller-stable request id, the original
 * goal and root, the existing revision/avoidance context, the read members
 * and cap, the separate optional write members/root/cap, and the literal
 * background consent.
 */
export interface BackgroundJobStartInput {
  /**
   * Caller-stable id. Job identity and the engine send key derive from it —
   * never from history length — so a reattached UI and the running worker
   * always name the same send.
   */
  readonly requestId: string;
  readonly goal: string;
  /** The workspace this job plans, checks and (only with write consent) edits. */
  readonly workspaceRoot: string;
  /** Authorized read members (closed list) for the whole chain. */
  readonly readInstances: readonly string[];
  /** Requested read-turn cap; the existing scope module owns the closed range. */
  readonly readMaxTurns: number;
  /** Absent means this job can never write, whatever background consent says. */
  readonly write?: BackgroundJobWriteScope;
  /** Existing revision context carried into the plan, exactly as in a window Send. */
  readonly priorPlan?: string | null;
  readonly priorReview?: string | null;
  /** Harnesses this send must avoid (e.g. a draft "Send again without X"). */
  readonly avoidInstances?: readonly string[];
  /**
   * Literal `true`: the type forces call sites to write the consent out, and
   * the runtime gate re-checks it because IPC data carries no types. This is
   * the decision that the job may keep running after the window closes; it
   * is NOT write consent and never implies one.
   */
  readonly backgroundConsent: true;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAbsoluteRootShape(root: string): boolean {
  return /^[/\\]/.test(root) || /^[A-Za-z]:[/\\]/.test(root);
}

function isWholePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Shape-only membership check; ranges and grants stay with the scope module. */
function memberListRefusal(values: readonly unknown[], what: string): string | null {
  if (!Array.isArray(values) || values.length === 0) {
    return `The background request needs at least one ${what} harness member, so nothing was admitted.`;
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (!nonEmptyString(value)) {
      return `A ${what} harness member is missing or not a harness id, so nothing was admitted.`;
    }
    if (seen.has(value)) {
      return `The ${what} harness members contain a duplicate, so nothing was admitted.`;
    }
    seen.add(value);
  }
  return null;
}

/**
 * Runtime shape gate for admission data that arrives without types (IPC,
 * job files). Shape only: the closed membership/budget ranges stay with the
 * existing scope module, and root equality stays with the engine and the
 * live scope, so this gate never becomes a second authority. Returns null
 * when the input is admittable, otherwise one honest sentence.
 */
export function backgroundStartRefusal(start: BackgroundJobStartInput): string | null {
  if (!start || typeof start !== "object") {
    return "The background request is missing, so nothing was admitted.";
  }
  if (typeof start.requestId !== "string" || !REQUEST_ID_PATTERN.test(start.requestId)) {
    return "The background request needs a request id made of letters, digits, dots, underscores, colons or hyphens, so nothing was admitted.";
  }
  if (!nonEmptyString(start.goal)) {
    return "The background request needs the original goal text, so nothing was admitted.";
  }
  if (typeof start.workspaceRoot !== "string" || !isAbsoluteRootShape(start.workspaceRoot.trim())) {
    return "The background request needs an absolute workspace root, so nothing was admitted.";
  }
  const readRefusal = memberListRefusal(start.readInstances as readonly unknown[], "read");
  if (readRefusal !== null) return readRefusal;
  if (!isWholePositive(start.readMaxTurns)) {
    return "The background request needs a whole positive read turn cap, so nothing was admitted.";
  }
  if (start.backgroundConsent !== true) {
    return "The background request needs the explicit keep-working-after-closing consent set to yes, so nothing was admitted.";
  }
  if (start.write !== undefined) {
    const write = start.write;
    if (!write || typeof write !== "object") {
      return "The background write consent is malformed, so nothing was admitted.";
    }
    const writeRefusal = memberListRefusal(write.instances as readonly unknown[], "write");
    if (writeRefusal !== null) return writeRefusal;
    if (typeof write.workspaceRoot !== "string" || !isAbsoluteRootShape(write.workspaceRoot.trim())) {
      return "The background write consent needs its own absolute workspace root, so nothing was admitted.";
    }
    if (!isWholePositive(write.maxTurns)) {
      return "The background write consent needs a whole positive write turn cap, so nothing was admitted.";
    }
  }
  if (start.avoidInstances !== undefined) {
    const seen = new Set<string>();
    for (const value of start.avoidInstances as readonly unknown[]) {
      if (!nonEmptyString(value)) {
        return "An avoided harness entry is missing or not a harness id, so nothing was admitted.";
      }
      if (seen.has(value)) {
        return "The avoided harness entries contain a duplicate, so nothing was admitted.";
      }
      seen.add(value);
    }
  }
  return null;
}

/**
 * Stable identity of one admitted job, derived only from its request id —
 * never from history length. The worker reuses the same value as the engine
 * send key, so reattachment, admission logs and the running chain all name
 * the same send.
 */
export function backgroundJobKey(requestId: string): string {
  return `background-job:${requestId}`;
}

/**
 * The exact slice of `requestCoordination`'s input that a background job
 * fills in. The worker adds its own job-owned `onEvent`, `beforeRepair` and
 * liveness callbacks on top; nothing here carries renderer or draft identity.
 */
export interface BackgroundEngineInput {
  readonly workspacePath: string;
  readonly goal: string;
  readonly sendKey: string;
  readonly allowedInstances: readonly string[];
  readonly writeAuthorization?: CoordinationWriteAuthorization;
  readonly priorPlan?: string | null;
  readonly priorReview?: string | null;
  readonly avoidInstances?: readonly string[];
  readonly repairRefusalSentence: string;
}

/**
 * Map an admitted start input onto the SAME engine the window uses. The
 * write cap seeds the write counter at admission only; from the first launch
 * on, the live scope's observed counters are the only truth. The refusal
 * sentence here is the background wording; window calls omit the field and
 * keep the window-only copy as the default.
 */
export function backgroundEngineInput(start: BackgroundJobStartInput): BackgroundEngineInput {
  return {
    workspacePath: start.workspaceRoot,
    goal: start.goal,
    sendKey: backgroundJobKey(start.requestId),
    allowedInstances: [...start.readInstances],
    ...(start.write === undefined
      ? {}
      : {
          writeAuthorization: {
            instances: [...start.write.instances],
            workspaceRoot: start.write.workspaceRoot,
            remaining: start.write.maxTurns,
          },
        }),
    ...(start.priorPlan === undefined ? {} : { priorPlan: start.priorPlan }),
    ...(start.priorReview === undefined ? {} : { priorReview: start.priorReview }),
    ...(start.avoidInstances === undefined ? {} : { avoidInstances: [...start.avoidInstances] }),
    repairRefusalSentence: BACKGROUND_REPAIR_REFUSAL_SENTENCE,
  };
}

/**
 * Phases of one admitted job. "unconfirmed" is honest uncertainty about an
 * interrupted owner — never a retryable failure; C2 does not restart it and
 * does not reclaim its admission slot.
 */
export type BackgroundJobPhase =
  | "admitted"
  | "running"
  | "stopping"
  | "completed"
  | "unconfirmed";

/** The one user-facing sentence per phase, derived from the phase, never stored as authority. */
export function backgroundJobSentence(phase: BackgroundJobPhase): string {
  switch (phase) {
    case "admitted":
      return "This goal may keep working after GoalPort closes; the background run has not confirmed that it started yet.";
    case "running":
      return "This goal is running on its own; you can close GoalPort and come back to this job later.";
    case "stopping":
      return "Stop allowing was pressed; the current turn may finish, and no further turn will start.";
    case "completed":
      return "This background job finished; its outcome is kept with the goal's record.";
    case "unconfirmed":
      return "GoalPort cannot confirm what happened to this background job; it did not restart it and will not retry it on its own.";
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

/** Display-only counter snapshot from the live scope; a recovery/display fact, never a budget authority. */
export interface BackgroundJobCounters {
  readonly readTurnsLeft?: number | null;
  readonly writeTurnsLeft?: number | null;
}

/**
 * What the product may show about a job: identity, phase, display sentence,
 * and display-only counters. Deliberately narrow — no memberships, no scopes,
 * no grants, no live controls. A projection must never become SavedPlan or
 * CoordinationView authority, and history built from it must stay
 * permission-free.
 */
export interface BackgroundJobProjection {
  readonly requestId: string;
  readonly jobKey: string;
  readonly phase: BackgroundJobPhase;
  readonly sentence: string;
  /** The admitted goal text, so the user can tell which job this is. */
  readonly goal: string;
  readonly observed?: BackgroundJobCounters | null;
}
