import { coordinateGoal, type CoordinateGoalInput, type CoordinateGoalState } from "./coordinateGoal";
import type { CoordinateTurnCommand } from "./coordinateTurn";
import { classifyProviderError, providerErrorSentence } from "./providerError";

export interface CoordinateLaunchResult {
  readonly text: string;
  readonly errorText: string;
  readonly prepared?: boolean;
}

export interface CoordinateTransport {
  launch(command: CoordinateTurnCommand): Promise<CoordinateLaunchResult>;
}

export interface CoordinateSessionOptions {
  readonly sendAuthorized: boolean;
}

function reportFromPlan(plan: CoordinateGoalState, stopReason = plan.stopReason): CoordinateGoalState {
  return { ...plan, stopReason };
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
): Promise<CoordinateGoalState> {
  const plan = coordinateGoal(input);
  if (plan.commands.length !== 2) return plan;
  const planning = plan.commands[0];
  const review = plan.commands[1];
  if (!planning || !review || planning.modelSelection.instanceId === review.modelSelection.instanceId) {
    return reportFromPlan(
      { ...plan, commands: [], roles: [], result: null, planningHarness: null, reviewHarness: null },
      "Stopped. An independent check needs a second logged-in harness, so no second role was assigned.",
    );
  }
  if (!options.sendAuthorized) {
    return reportFromPlan(
      plan,
      "Planning and review are assigned to two different harnesses. No model turn was sent, because this session is not authorized to spend subscription quota.",
    );
  }

  const planned = await transport.launch(planning);
  const planError = classifyProviderError(planned.errorText);
  if (planError === "usage_credits" || planError === "authentication" || planned.errorText.trim().length > 0) {
    return reportFromPlan(
      { ...plan, commands: [planning], roles: ["planning", "review"], result: null },
      providerErrorSentence(planned.errorText),
    );
  }

  const checked = await transport.launch(withPlanText(review, planned.text));
  if (checked.errorText.trim().length > 0) {
    return reportFromPlan(
      { ...plan, result: null },
      providerErrorSentence(checked.errorText),
    );
  }
  return reportFromPlan(
    { ...plan, result: checked.text.trim().length > 0 ? checked.text.trim() : null },
    "The independent check finished, so this stopped.",
  );
}
