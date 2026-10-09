import { catalogFromProviderSnapshots, type ProviderSnapshot } from "./catalogFromProviders";
import { coordinateGoal } from "./coordinateGoal";
import { runCoordinateSession, type CoordinateTransport } from "./coordinateSession";
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
    });
  }
  const sent = await runCoordinateSession(
    goalInput,
    { sendAuthorized: true },
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
  });
}
