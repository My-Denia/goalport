import { catalogFromProviderSnapshots, type ProviderSnapshot } from "./catalogFromProviders";
import { coordinateGoal } from "./coordinateGoal";
import { runCoordinateSession, type CoordinateTransport } from "./coordinateSession";
import type { CoordinationQuotaWord } from "../conversation/CoordinationStatus";

export interface CoordinationView {
  planningHarness: string | null;
  reviewHarness: string | null;
  result: string | null;
  stopReason: string;
  planningQuota: CoordinationQuotaWord | null;
  reviewQuota: CoordinationQuotaWord | null;
}

export interface CoordinationDiscovery {
  readonly connected: boolean;
  readonly sendAuthorized: boolean;
  readonly providers: readonly ProviderSnapshot[];
  readonly stopReason: string | null;
}

function viewFrom(input: {
  planningHarness: string | null;
  reviewHarness: string | null;
  result: string | null;
  stopReason: string;
  planningQuota: CoordinationQuotaWord | null;
  reviewQuota: CoordinationQuotaWord | null;
}): CoordinationView {
  return input;
}

function unavailable(stopReason: string): CoordinationView {
  return viewFrom({
    planningHarness: null,
    reviewHarness: null,
    result: null,
    stopReason,
    planningQuota: null,
    reviewQuota: null,
  });
}

/**
 * The user sends a goal without picking a runtime and should see the planning
 * harness, the review harness, and why the product stopped.
 */
export async function requestCoordination(
  input: { readonly workspacePath: string; readonly goal: string },
  discovery: CoordinationDiscovery | null,
  transport: CoordinateTransport,
): Promise<CoordinationView> {
  if (discovery === null || !discovery.connected) {
    return unavailable(discovery?.stopReason ?? "This window has no coordination service. Open the GoalPort app window and send the goal there.");
  }
  const catalog = catalogFromProviderSnapshots(discovery.providers);
  const planned = coordinateGoal({
    catalog,
    goal: input.goal,
    workspacePath: input.workspacePath,
  });
  if (planned.commands.length !== 2) {
    return viewFrom({
      planningHarness: planned.planningHarness,
      reviewHarness: planned.reviewHarness,
      result: null,
      stopReason: planned.stopReason,
      planningQuota: planned.planningQuota,
      reviewQuota: planned.reviewQuota,
    });
  }
  if (!discovery.sendAuthorized) {
    const planning = planned.commands[0];
    const review = planned.commands[1];
    const preparedPlanning = await transport.launch(planning);
    const preparedReview = await transport.launch(review);
    if (preparedPlanning.prepared !== true || preparedReview.prepared !== true) {
      const errorText = preparedPlanning.prepared !== true
        ? preparedPlanning.errorText
        : preparedReview.errorText;
      return viewFrom({
        planningHarness: null,
        reviewHarness: null,
        result: null,
        stopReason: errorText.trim().length > 0
          ? errorText
          : "The read-only session was not prepared, so nothing was sent.",
        planningQuota: null,
        reviewQuota: null,
      });
    }
    return viewFrom({
      planningHarness: planned.planningHarness,
      reviewHarness: planned.reviewHarness,
      result: null,
      stopReason: "Planning and review are assigned to two different harnesses. No model turn was sent, because this session is not authorized to spend subscription quota.",
      planningQuota: planned.planningQuota,
      reviewQuota: planned.reviewQuota,
    });
  }
  const sent = await runCoordinateSession(
    { catalog, goal: input.goal, workspacePath: input.workspacePath },
    { sendAuthorized: true },
    transport,
  );
  return viewFrom({
    planningHarness: sent.planningHarness,
    reviewHarness: sent.reviewHarness,
    result: sent.result,
    stopReason: sent.stopReason,
    planningQuota: sent.planningQuota,
    reviewQuota: sent.reviewQuota,
  });
}
