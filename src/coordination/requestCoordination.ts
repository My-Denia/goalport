import { catalogFromProviderSnapshots, type ProviderSnapshot } from "./catalogFromProviders";
import { coordinateGoal } from "./coordinateGoal";
import {
  runCoordinateSession,
  type CoordinateSessionEvent,
  type CoordinateTransport,
  type EnvironmentBlockedInfo,
} from "./coordinateSession";
import type { RoundEvent } from "./savedPlan";
import type { CoordinationQuotaWord } from "../conversation/CoordinationStatus";
import type { CoordinationVerdict } from "./verdict";

export interface CoordinationView {
  planningHarness: string | null;
  reviewHarness: string | null;
  planText: string | null;
  reviewText: string | null;
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
  };
  const planned = coordinateGoal(goalInput);
  if (planned.commands.length !== 2) {
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
  if (sent.stopReason.toLowerCase().includes("replaced")) return unavailable(REPLACED);
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
    authorizedTurnsLeft: sent.authorizedTurnsLeft,
    scopeExhausted: sent.scopeExhausted,
  });
}
