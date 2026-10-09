import { coordinateGoal, type CoordinateGoalInput, type CoordinateGoalState } from "./coordinateGoal";
import type { CoordinateTurnCommand } from "./coordinateTurn";
import { classifyProviderError, providerErrorSentence } from "./providerError";
import { verdictFromReview, type CoordinationVerdict } from "./verdict";

export interface CoordinateLaunchResult {
  readonly text: string;
  readonly errorText: string;
  readonly prepared?: boolean;
  /**
   * Whether a model turn was actually dispatched. A failed launch that never
   * dispatched (not authorized, not installed, unrecorded) may be retried
   * explicitly by the user; a dispatched or unknown outcome may not.
   */
  readonly dispatched?: boolean | null;
}

export interface CoordinateTransport {
  launch(command: CoordinateTurnCommand): Promise<CoordinateLaunchResult>;
}

export interface CoordinateSessionOptions {
  readonly sendAuthorized: boolean;
}

export interface CoordinateSessionState extends CoordinateGoalState {
  readonly planText: string | null;
  readonly reviewText: string | null;
  readonly verdict: CoordinationVerdict | null;
  readonly messageDispatched: boolean | null;
}

function reportFromPlan(
  plan: CoordinateGoalState,
  fields: {
    stopReason?: string;
    planText?: string | null;
    reviewText?: string | null;
    verdict?: CoordinationVerdict | null;
    result?: string | null;
    messageDispatched?: boolean | null;
  } = {},
): CoordinateSessionState {
  return {
    ...plan,
    stopReason: fields.stopReason ?? plan.stopReason,
    result: fields.result === undefined ? plan.result : fields.result,
    planText: fields.planText ?? null,
    reviewText: fields.reviewText ?? null,
    verdict: fields.verdict ?? null,
    // An explicit null (unknown dispatch) must survive; only an unset field
    // falls back to "nothing was sent".
    messageDispatched: fields.messageDispatched === undefined ? false : fields.messageDispatched,
  };
}

function checkStopReason(verdict: CoordinationVerdict): string {
  switch (verdict) {
    case "checked":
      return "The independent check finished, so this stopped.";
    case "revise":
      return "The independent check says the plan needs revision, so this stopped.";
    case "stopped":
      return "The independent check says to stop, so this stopped.";
    case "failed":
    case "unconfirmed":
      return "The independent check did not confirm the plan, so this stopped.";
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

function withPlanText(command: CoordinateTurnCommand, planText: string): CoordinateTurnCommand {
  return {
    ...command,
    initialMessage: {
      text: [
        command.initialMessage.text,
        "",
        "Plan:",
        planText.length > 0 ? planText : "(The planner returned no text.)",
      ].join("\n"),
    },
  };
}

/**
 * The user sent a goal and wants the product to plan, check, and stop.
 * This sends at most those two turns, and never a third implementation turn.
 */
export async function runCoordinateSession(
  input: CoordinateGoalInput,
  options: CoordinateSessionOptions,
  transport: CoordinateTransport,
): Promise<CoordinateSessionState> {
  const plan = coordinateGoal(input);
  if (plan.commands.length !== 2) return reportFromPlan(plan, { verdict: "stopped" });
  const planning = plan.commands[0];
  const review = plan.commands[1];
  if (!planning || !review || planning.modelSelection.instanceId === review.modelSelection.instanceId) {
    return reportFromPlan(
      { ...plan, commands: [], roles: [], result: null, planningHarness: null, reviewHarness: null },
      {
        verdict: "stopped",
        stopReason: "Stopped. An independent check needs a second logged-in harness, so no second role was assigned.",
      },
    );
  }
  if (!options.sendAuthorized) {
    return reportFromPlan(plan, {
      verdict: "stopped",
      stopReason: "Planning and review are assigned to two different harnesses. No model turn was sent, because this session is not authorized to spend subscription quota.",
    });
  }

  const planned = await transport.launch(planning);
  const planError = classifyProviderError(planned.errorText);
  const planText = planned.text.trim();
  if (planError === "usage_credits" || planError === "authentication" || planned.errorText.trim().length > 0) {
    return reportFromPlan(
      { ...plan, commands: [planning], roles: ["planning", "review"], result: null },
      {
        verdict: "failed",
        planText: planText.length > 0 ? planText : null,
        stopReason: providerErrorSentence(planned.errorText),
        // Tri-state passthrough: a null (the runtime died mid-turn, the turn
        // may have reached the provider) must never read as "nothing was
        // sent" — that would make an unknown outcome retryable.
        messageDispatched: planned.dispatched ?? null,
      },
    );
  }
  if (planText.length === 0) {
    return reportFromPlan(
      { ...plan, result: null },
      { verdict: "failed", stopReason: "The planner returned no text, so the check was not sent.", messageDispatched: true },
    );
  }

  const checked = await transport.launch(withPlanText(review, planText));
  const reviewText = checked.text.trim();
  if (checked.errorText.trim().length > 0) {
    return reportFromPlan(
      { ...plan, result: null },
      {
        verdict: "failed",
        planText,
        reviewText: reviewText.length > 0 ? reviewText : null,
        stopReason: providerErrorSentence(checked.errorText),
        messageDispatched: true,
      },
    );
  }
  const verdict = verdictFromReview(reviewText);
  const stopReason = checkStopReason(verdict);
  return reportFromPlan(
    { ...plan, result: reviewText.length > 0 ? reviewText : null },
    {
      verdict,
      planText,
      reviewText: reviewText.length > 0 ? reviewText : null,
      stopReason,
      messageDispatched: true,
    },
  );
}
