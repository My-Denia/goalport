// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { GoalStatusHeading } from "./conversation/DraftGoalComposer";
import { methodLine } from "./coordination/methodLine";

afterEach(cleanup);
const base = { draft: { workspace: "", provider: "", message: "" }, busy: false, blockedFromSending: false, activeGoalTitle: "Fix helper", savedResultLabel: "Saved result", savedResultOutcome: "Checked" };

it("saved result shows which method ran and which checks came back", () => {
  const line = methodLine({ id: "recommended", version: 1 }, [{ kind: "plan-check", harness: "Pi", verdict: null }]);
  render(<GoalStatusHeading {...base} methodLine={line} />);
  expect(screen.getByText("Recommended workflow v1 · Ran: plan check by Pi")).toBeTruthy();
});

it("a saved record without method data shows no line", () => {
  render(<GoalStatusHeading {...base} methodLine={methodLine(undefined, undefined)} />);
  expect(document.querySelector(".method-line")).toBeNull();
});
