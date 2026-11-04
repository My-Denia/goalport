import { describe, expect, it } from "vitest";
import { decisionSentence } from "./decisionSentence";

const actions = { canRevise: true, canChangeAccess: false };

describe("decisionSentence window-refused", () => {
  it("blames this window for a window refusal", () => {
    expect(decisionSentence({ kind: "window-refused", stage: "plan" }, actions))
      .toBe("The check asked for changes to the plan. GoalPort couldn't confirm this window, so the revision didn't start. Revise to update it, or send a new goal.");
  });
  it("blames the background job, not a window, for a background refusal", () => {
    const plan = decisionSentence({ kind: "window-refused", stage: "plan", where: "background" }, actions);
    expect(plan).toContain("couldn't confirm the background job could continue, so the revision didn't start.");
    expect(plan).not.toContain("this window");
    const repair = decisionSentence({ kind: "window-refused", stage: "changes", where: "background" }, actions);
    expect(repair).toContain("couldn't confirm the background job could continue, so the repair didn't start.");
  });
});

describe("decisionSentence repair-plan-revise", () => {
  it("says the repair plan was rejected after the one automatic repair, not that verification asked again", () => {
    const sentence = decisionSentence({ kind: "repair-plan-revise", stage: "plan" }, actions);
    expect(sentence).toBe("The check asked for changes to the repair plan. GoalPort already used its one automatic repair, so nothing more was spent. Revise to update it, or send a new goal.");
    expect(sentence).not.toContain("Verification");
  });
});
