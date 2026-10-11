import { catalogFromProviderSnapshots, type ProviderSnapshot } from "./catalogFromProviders";
import {
  coordinateGoal,
  type CoordinateGoalInput,
  type CoordinationWriteAuthorization,
  type ExecutionFeedback,
} from "./coordinateGoal";
import {
  runCoordinateSession,
  type CoordinateSessionEvent,
  type CoordinateSessionState,
  type CoordinateTransport,
  type EnvironmentBlockedInfo,
} from "./coordinateSession";
import type { CoordinationRoundFact, RoundEvent } from "./savedPlan";
import type { CoordinationQuotaWord } from "../conversation/CoordinationStatus";
import type { CoordinationVerdict } from "./verdict";

export interface CoordinationView {
  planningHarness: string | null;
  reviewHarness: string | null;
  planText: string | null;
  reviewText: string | null;
  executionText?: string | null;
  auditText?: string | null;
  executionHarness?: string | null;
  auditHarness?: string | null;
  readonly authorizedWriteTurnsLeft?: number | null;
  result: string | null;
  verdict: CoordinationVerdict | null;
  stopReason: string;
  planningQuota: CoordinationQuotaWord | null;
  reviewQuota: CoordinationQuotaWord | null;
  /**
   * False only when the round provably dispatched no model turn (not
   * authorized, not installed, unrecorded): such a failure may be retried
   * explicitly. True, null, or absent (a record from before this field
   * existed) must never be resent silently.
   */
  readonly messageDispatched?: boolean | null;
  /** Set when a turn proved the harness cannot run its tools on this machine. */
  readonly environmentBlocked?: EnvironmentBlockedInfo | null;
  /** Completed recovery facts (failures and takeovers) for this round. */
  readonly roundEvents?: readonly RoundEvent[];
  /** Scope budget after the last launch; present only on scoped rounds. */
  readonly authorizedTurnsLeft?: number | null;
  /** True when the authorized scope ran out of model turns. */
  readonly scopeExhausted?: boolean;
  /**
   * Retained facts of the completed first pass, present only when the one
   * corrective pass actually launched in this Send. Top-level fields are the
   * latest pass; history never restores live permissions.
   */
  readonly feedbackHistory?: readonly CoordinationRoundFact[];
}

/**
 * What the product adapter may checkpoint before the one corrective pass:
 * the completed first round whose independent audit requested revision and
 * the remaining authorized counters at that moment.
 */
export interface RepairCheckpoint {
  readonly firstRound: CoordinationView;
  readonly remainingReadTurns: number | null;
  readonly remainingWriteTurns: number | null;
}

export interface CoordinationDiscovery {
  readonly connected: boolean;
  readonly sendAuthorized: boolean;
  readonly providers: readonly ProviderSnapshot[];
  readonly stopReason: string | null;
}

function viewFrom(input: CoordinationView): CoordinationView {
  return input;
}

const REPLACED = "The coordination request was replaced, so nothing was sent.";

// The one in-window corrective boundary: a full second chain needs a fresh
// plan, check and independent audit (three read turns) plus one write turn.
const REPAIR_NEEDED_READ_TURNS = 3;
const REPAIR_NEEDED_WRITE_TURNS = 1;
const BUDGET_STOP_SENTENCE = "There is not enough access left for one more checked repair, which needs three model turns and one write turn. GoalPort did not add turns.";
const REFUSED_REPAIR_SENTENCE = "GoalPort could not confirm this window for the automatic repair, so the repair did not start.";
const UNSTAFFED_REPAIR_SENTENCE = "The automatic repair could not be staffed with the harnesses you allowed, so it did not start.";
const REPAIR_CEILING_SENTENCE = "This send already used its one automatic repair.";

function unavailable(stopReason: string, verdict: CoordinationVerdict = "stopped"): CoordinationView {
  return viewFrom({
    planningHarness: null,
    reviewHarness: null,
    planText: null,
    reviewText: null,
    result: null,
    verdict,
    stopReason,
    planningQuota: null,
    reviewQuota: null,
    messageDispatched: false,
    environmentBlocked: null,
    roundEvents: [],
  });
}

/**
 * The user sends a goal without picking a runtime and should see the planning
 * harness, the review harness, and why the product stopped.
 */
/** Send-wide dispatch across both passes: a later pass that proves it sent
 * nothing cannot erase an earlier sent or unknown pass and make the goal look
 * retryable. */
function sendWideDispatched(first: boolean | null, second: boolean | null | undefined): boolean | null {
  if (first === true || second === true) return true;
  if (first === null || second === null) return null;
  return false;
}

/** Permission-free facts of one completed pass, for retained history. */
function roundFactFrom(sent: CoordinateSessionState): CoordinationRoundFact {
  return {
    planningHarness: sent.planningHarness,
    reviewHarness: sent.reviewHarness,
    planText: sent.planText,
    reviewText: sent.reviewText,
    executionText: sent.executionText ?? null,
    auditText: sent.auditText ?? null,
    executionHarness: sent.executionHarness ?? null,
    auditHarness: sent.auditHarness ?? null,
    result: sent.result,
    verdict: sent.verdict,
    stopReason: sent.stopReason,
    messageDispatched: sent.messageDispatched,
    roundEvents: sent.roundEvents,
    commandIds: sent.commands.map((command) => command.commandId),
  };
}

function scopedViewFromSession(sent: CoordinateSessionState, hasWriteConsent: boolean): CoordinationView {
  return viewFrom({
    planningHarness: sent.planningHarness,
    reviewHarness: sent.reviewHarness,
    planText: sent.planText,
    reviewText: sent.reviewText,
    result: sent.result,
    verdict: sent.verdict,
    stopReason: sent.stopReason,
    planningQuota: sent.planningQuota,
    reviewQuota: sent.reviewQuota,
    messageDispatched: sent.messageDispatched,
    environmentBlocked: sent.environmentBlocked ?? null,
    roundEvents: sent.roundEvents,
    ...(hasWriteConsent ? {
      executionText: sent.executionText, auditText: sent.auditText,
      executionHarness: sent.executionHarness, auditHarness: sent.auditHarness,
      authorizedWriteTurnsLeft: sent.authorizedWriteTurnsLeft,
    } : {}),
    authorizedTurnsLeft: sent.authorizedTurnsLeft,
    scopeExhausted: sent.scopeExhausted,
  });
}

export async function requestCoordination(
  input: {
    readonly workspacePath: string;
    readonly goal: string;
    readonly sendKey: string;
    readonly priorPlan?: string | null;
    readonly priorReview?: string | null;
    readonly avoidInstances?: readonly string[];
    /** Scoped round membership: present means recovery is authorized. */
    readonly allowedInstances?: readonly string[];
    /** Explicit M6 scope.write snapshot after separate user consent. */
    readonly writeAuthorization?: CoordinationWriteAuthorization;
    /** Completed execution feedback carried into a manual continuation send. */
    readonly executionFeedback?: ExecutionFeedback | null;
    /**
     * Product adapter gate for the ONE corrective pass inside this Send:
     * confirm liveness and checkpoint first-round evidence, then return true.
     * Refusal, an exception, or a stale request keeps the completed first
     * pass as the final result. Absence preserves the one-round behavior:
     * no corrective pass is attempted at all.
     */
    readonly beforeRepair?: (checkpoint: RepairCheckpoint) => Promise<boolean>;
    /**
     * Adapter-specific wording for the one repair-refusal stop line: a
     * background job has no window to confirm. Absent keeps the existing
     * window-only copy. Wording only — repair eligibility and ceilings are
     * unchanged.
     */
    readonly repairRefusalSentence?: string;
    /** Synchronous round events (started is transient; failed/continued persist). */
    readonly onEvent?: (event: CoordinateSessionEvent) => void;
  },
  discovery: CoordinationDiscovery | null,
  transport: CoordinateTransport,
  stillCurrent: () => boolean = () => true,
): Promise<CoordinationView> {
  if (discovery === null || !discovery.connected) {
    return unavailable(discovery?.stopReason ?? "This window has no coordination service. Open the GoalPort app window and send the goal there.");
  }
  const catalog = catalogFromProviderSnapshots(discovery.providers);
  const goalInput = {
    catalog,
    goal: input.goal,
    workspacePath: input.workspacePath,
    sendKey: input.sendKey,
    priorPlan: input.priorPlan,
    priorReview: input.priorReview,
    avoidInstances: input.avoidInstances,
    allowedInstances: input.allowedInstances,
    writeAuthorization: input.writeAuthorization,
    executionFeedback: input.executionFeedback,
  };
  const planned = coordinateGoal(goalInput);
  if (planned.roles.length === 0) {
    return viewFrom({
      planningHarness: planned.planningHarness,
      reviewHarness: planned.reviewHarness,
      planText: null,
      reviewText: null,
      result: null,
      verdict: "stopped",
      stopReason: planned.stopReason,
      planningQuota: planned.planningQuota,
      reviewQuota: planned.reviewQuota,
      messageDispatched: false,
      environmentBlocked: null,
      roundEvents: [],
    });
  }
  if (!stillCurrent()) return unavailable(REPLACED);
  if (!discovery.sendAuthorized) {
    return viewFrom({
      planningHarness: planned.planningHarness,
      reviewHarness: planned.reviewHarness,
      planText: null,
      reviewText: null,
      result: null,
      verdict: "stopped",
      stopReason: "Planning and review are assigned to two different harnesses. No model turn was sent, because this session is not authorized to spend subscription quota.",
      planningQuota: planned.planningQuota,
      reviewQuota: planned.reviewQuota,
      messageDispatched: false,
      environmentBlocked: null,
    });
  }
  const sent = await runCoordinateSession(
    goalInput,
    {
      sendAuthorized: true,
      allowedInstances: input.allowedInstances,
      onEvent: input.onEvent,
    },
    {
      async launch(command) {
        if (!stillCurrent()) return { text: "", errorText: REPLACED };
        return transport.launch(command);
      },
    },
  );
  // A cancellation after a writer ran must not erase its partial result or
  // make the round look unsent/retryable. Legacy read replacement stays exact.
  if (sent.stopReason.toLowerCase().includes("replaced") &&
      !(input.writeAuthorization && sent.commands.some((command) => command.sandboxPolicy.type === "workspaceWrite"))) {
    return unavailable(REPLACED);
  }
  const hasWriteConsent = input.writeAuthorization !== undefined;
  const firstRound = scopedViewFromSession(sent, hasWriteConsent);

  // -----------------------------------------------------------------------
  // The one in-window corrective boundary. Only a COMPLETED execution audit
  // that ended VERDICT: revise may start one repair chain in the same Send,
  // under the same scope generation (never a second authorization), with
  // fresh command identities and the remaining budgets. A refusal, unknown
  // launch, cancellation, or corrective failure stays terminal, and the
  // first round's evidence is retained either way.
  // -----------------------------------------------------------------------
  const eligibleForRepair = input.beforeRepair !== undefined
    && hasWriteConsent
    && sent.verdict === "revise"
    && (sent.auditText ?? "").trim().length > 0
    && ((sent.executionText ?? "").trim().length > 0 || Boolean(sent.executionHarness));
  let repaired: CoordinateSessionState | null = null;
  let noRepairSentence: string | null = null;
  if (eligibleForRepair) {
    const burned = [...new Set([
      ...(input.avoidInstances ?? []),
      ...sent.roundEvents.filter((event) => event.kind === "failed").map((event) => event.instanceId),
    ])];
    const feedback: ExecutionFeedback = {
      previousPlan: sent.planText,
      previousPlanReview: sent.reviewText,
      previousExecutionReport: sent.executionText ?? null,
      previousExecutionAudit: sent.auditText ?? null,
      // Historical ids are references for the prompts only; the corrective
      // chain derives fresh ids (sendKey + repair-1), so nothing is replayed.
      previousCommandIds: sent.commands.map((command) => command.commandId),
    };
    const correctiveInput: CoordinateGoalInput = {
      catalog,
      goal: input.goal,
      workspacePath: input.workspacePath,
      sendKey: input.sendKey,
      avoidInstances: burned,
      allowedInstances: input.allowedInstances,
      // Same memberships and root as the original consent; only the observed
      // remaining write counter is carried honestly. No new authorization.
      writeAuthorization: {
        ...input.writeAuthorization!,
        remaining: typeof sent.authorizedWriteTurnsLeft === "number" && Number.isFinite(sent.authorizedWriteTurnsLeft)
          ? sent.authorizedWriteTurnsLeft
          : input.writeAuthorization!.remaining,
      },
      executionFeedback: feedback,
    };
    const reads = sent.authorizedTurnsLeft;
    const writes = sent.authorizedWriteTurnsLeft;
    const budgetAllows = Number.isInteger(reads) && (reads as number) >= REPAIR_NEEDED_READ_TURNS
      && Number.isInteger(writes) && (writes as number) >= REPAIR_NEEDED_WRITE_TURNS;
    const staffed = budgetAllows && coordinateGoal(correctiveInput).commands.length === 2;
    if (!budgetAllows) {
      noRepairSentence = BUDGET_STOP_SENTENCE;
    } else if (!staffed) {
      noRepairSentence = UNSTAFFED_REPAIR_SENTENCE;
    } else if (!stillCurrent()) {
      noRepairSentence = input.repairRefusalSentence ?? REFUSED_REPAIR_SENTENCE;
    } else {
      let allowed = false;
      try {
        allowed = (await input.beforeRepair!({
          firstRound,
          remainingReadTurns: reads ?? null,
          remainingWriteTurns: writes ?? null,
        })) === true;
      } catch {
        allowed = false;
      }
      if (!allowed || !stillCurrent()) {
        noRepairSentence = input.repairRefusalSentence ?? REFUSED_REPAIR_SENTENCE;
      } else {
        repaired = await runCoordinateSession(
          correctiveInput,
          { sendAuthorized: true, allowedInstances: input.allowedInstances, onEvent: input.onEvent },
          {
            async launch(command) {
              if (!stillCurrent()) return { text: "", errorText: REPLACED };
              return transport.launch(command);
            },
          },
        );
      }
    }
  }
  if (repaired === null) {
    if (noRepairSentence === null) return firstRound;
    return viewFrom({ ...firstRound, stopReason: `${firstRound.stopReason} ${noRepairSentence}` });
  }
  // Latest pass on top; first pass retained as history. Send-wide dispatch
  // keeps the goal non-retryable even when the corrective launch provably
  // dispatched nothing. A second revise is terminal: one repair per Send.
  const secondRevise = repaired.verdict === "revise";
  return viewFrom({
    ...scopedViewFromSession(repaired, hasWriteConsent),
    messageDispatched: sendWideDispatched(sent.messageDispatched, repaired.messageDispatched),
    feedbackHistory: [roundFactFrom(sent)],
    ...(secondRevise ? { stopReason: `${repaired.stopReason} ${REPAIR_CEILING_SENTENCE}` } : {}),
  });
}
