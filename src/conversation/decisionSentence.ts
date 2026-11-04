import type { CoordinationDecision } from "../../electron/coordination-decision.mjs";

/** The actions the result page really renders, so the sentence never names one that is not there. */
export interface DecisionActions {
  readonly canRevise: boolean;
  readonly canChangeAccess: boolean;
}

/**
 * The one plain sentence for a result that stopped with something for the user to decide.
 * The engine's own stop sentence stays in the details; this is what is read first.
 */
export function decisionSentence(decision: CoordinationDecision, actions: DecisionActions): string {
  const plan = decision.stage === "plan";
  const asked = plan ? "The check asked for changes to the plan." : "Verification asked for changes to what was done.";
  const revision = plan ? "revise the plan" : "repair";
  const next = actions.canRevise ? "Revise to update it, or send a new goal." : "Send a new goal when you're ready.";
  const access = actions.canChangeAccess ? " Agent access below lets you allow more." : "";
  switch (decision.kind) {
    case "automatic-off":
      return `${asked} Your workflow stops here, so nothing more was spent. ${next}`;
    case "limit-reached":
      return `${plan ? "The check asked for changes again after GoalPort's one automatic revision" : "Verification asked for changes again after GoalPort's one automatic repair"}, so it stopped. ${next}`;
    case "not-enough-turns":
      return `${asked} Not enough turns were left to ${revision} automatically, so nothing extra was added.${access} ${next}`;
    case "unstaffed":
      return `${asked} The agents you allowed couldn't take on the ${plan ? "revision" : "repair"}.${access} ${next}`;
    case "window-refused":
      return `${asked} GoalPort couldn't confirm this window, so it didn't start the ${plan ? "revision" : "repair"}. ${next}`;
    case "revise":
      return `${asked} ${next}`;
  }
}
