// @vitest-environment jsdom
import type React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { GoalStatusHeading } from "./conversation/DraftGoalComposer";
import { CoordinationStatus } from "./conversation/CoordinationStatus";
import { methodLine } from "./coordination/methodLine";

afterEach(cleanup);
const base: React.ComponentProps<typeof GoalStatusHeading> = { runtimes: [], connected: true, waitingOn: null, error: null, canBrowse: false, coordinationAvailable: true, onBrowse: () => {}, onChange: () => {}, onSubmit: () => {}, onDiscard: () => {},  draft: { workspace: "", provider: "", message: "" }, busy: false, blockedFromSending: false, activeGoalTitle: "Fix helper", savedResultLabel: "Saved result", savedResultOutcome: "Checked" };

// Linux workbench heading.
it("saved result heading shows which method ran and which checks came back", () => {
  const line = methodLine({ id: "recommended", version: 1 }, [{ kind: "plan-check", harness: "Pi", verdict: null }]);
  render(<GoalStatusHeading {...base} methodLine={line} />);
  expect(screen.getByText("Recommended workflow v1 · Ran: plan check by Pi")).toBeTruthy();
});

it("a saved record without method data shows no line in the heading", () => {
  render(<GoalStatusHeading {...base} methodLine={methodLine(undefined, undefined)} />);
  expect(document.querySelector(".method-line")).toBeNull();
});

// Windows result surfaces (live, background job and saved plan card) all render CoordinationStatus.
const round = { planningHarness: "Codex", reviewHarness: "Pi", planText: "Plan", reviewText: "Check", verdict: "checked", stopReason: "Done.", planningQuota: null, reviewQuota: null } as const;

it("the result card names the method and the checks that came back", () => {
  render(<CoordinationStatus {...round} workflow={{ id: "recommended", version: 1 }} checksRan={[{ kind: "plan-check", harness: "Pi", verdict: "checked" }]} />);
  expect(screen.getByText("Recommended workflow v1 · Ran: plan check by Pi")).toBeTruthy();
});

it("an older result card without method data shows no line", () => {
  render(<CoordinationStatus {...round} />);
  expect(document.querySelector(".method-line")).toBeNull();
});
