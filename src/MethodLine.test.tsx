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

// Issue #68: a plan whose review the user switched off says so, plainly, and still names the method.
it("a plan that was not reviewed reads as ready, not reviewed, and the method line says review did not run", () => {
  const stopReason = "The plan is ready. Independent review did not run, because it is off in Quick plans.";
  render(<CoordinationStatus {...round} reviewHarness={null} reviewText={null} verdict="planned" stopReason={stopReason}
    workflow={{ id: "my-0a1b2c3d", version: 2, name: "Quick plans", planReview: "off" }} checksRan={[]} />);
  expect(screen.getByText("Plan ready, not reviewed")).toBeTruthy();
  expect(screen.queryByText(stopReason)).toBeNull(); // said once, by the method line
  expect(screen.getByText("Quick plans v2 · Independent review: not run (off in Quick plans)")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Stop reason|Can be carried out|Not confirmed/);
});

// A plan nobody reviewed does not claim a check anywhere in the result.
it("a planned result's disclosure says Plan and details and carries no check rows", () => {
  render(<CoordinationStatus {...round} reviewHarness={null} reviewText={null} verdict="planned" stopReason="x"
    workflow={{ id: "my-0a1b2c3d", version: 2, name: "Quick plans", planReview: "off" }} checksRan={[]} />);
  expect(screen.getByText("Plan and details")).toBeTruthy();
  expect(screen.queryByText("Plan, check and details")).toBeNull();
  expect(screen.queryByText("Check")).toBeNull();
  expect(screen.queryByText("Checked by")).toBeNull();
  expect(screen.queryByText("Review quota")).toBeNull();
  expect(screen.getByRole("region", { name: "Plan" })).toBeTruthy();
});

it("a checked result keeps the check wording", () => {
  render(<CoordinationStatus {...round} checksRan={[{ kind: "plan-check", harness: "Pi", verdict: "checked" }]} />);
  expect(screen.getByText("Plan, check and details")).toBeTruthy();
  expect(screen.getByText("Checked by")).toBeTruthy();
});

// Issue #69: the result says which model setting each step really ran with, and says nothing new for older records.
const ran = [
  { role: "plan", harness: "claude", model: "opus", effort: "high", preference: "stronger", applied: true },
  { role: "review", harness: "codex", model: null, effort: "low", preference: "faster", applied: true },
] as const;

it("the result card shows what each step ran with under the method line", () => {
  render(<CoordinationStatus {...round} workflow={{ id: "recommended", version: 1 }} checksRan={[{ kind: "plan-check", harness: "Codex", verdict: "checked" }]} turnsRan={ran} />);
  expect(screen.getByText("Plan: Claude opus, high effort (stronger) · Check: Codex, low effort (faster)")).toBeTruthy();
  expect(document.querySelectorAll(".method-line")).toHaveLength(2);
});

it("a result with no recorded launches, or only default ones, shows no resources line", () => {
  render(<CoordinationStatus {...round} turnsRan={[{ ...ran[0], preference: "default", applied: false }]} />);
  expect(document.querySelector(".method-line")).toBeNull();
  cleanup();
  render(<CoordinationStatus {...round} />);
  expect(document.querySelector(".method-line")).toBeNull();
});

it("the Linux saved-result heading shows the resources line too", () => {
  render(<GoalStatusHeading {...base} resourcesLine="Plan: Claude opus, high effort (stronger)" />);
  expect(screen.getByText("Plan: Claude opus, high effort (stronger)")).toBeTruthy();
});

// Issue #70: a stop the user has to decide says what it needs, once, and keeps the engine's sentence in the details.
const gate = "The check asked for changes to the plan. The workflow has automatic plan revision switched off.";
const planStop = { ...round, verdict: "revise", stopReason: gate } as const;

it("an automatic-off plan stop shows one plain sentence, with the engine's sentence only in Technical details", () => {
  render(<CoordinationStatus {...planStop} decision={{ kind: "automatic-off", stage: "plan" }} onRevise={() => {}} />);
  expect(screen.getByRole("status").textContent).toContain("Your workflow stops here, so nothing more was spent. Revise to update it, or send a new goal.");
  expect(screen.getAllByText(/asked for changes to the plan/)).toHaveLength(1 + 1); // the sentence and the details copy
  const details = document.querySelector(".coordination-decision details") as HTMLElement;
  expect(details.textContent).toContain(gate);
  expect(document.querySelector(".coordination-outcome")?.textContent).not.toContain(gate);
  expect(screen.getAllByRole("button", { name: "Revise" })).toHaveLength(1);
  expect(document.body.textContent).not.toContain("This plan needs changes.");
});

it("the sentence names Revise and Agent access only when those buttons are there", () => {
  render(<CoordinationStatus {...planStop} decision={{ kind: "not-enough-turns", stage: "changes" }} />);
  expect(screen.getByRole("status").textContent).not.toMatch(/Revise|Agent access/);
  expect(screen.queryByRole("button", { name: "Revise" })).toBeNull();
  cleanup();
  render(<CoordinationStatus {...planStop} decision={{ kind: "not-enough-turns", stage: "changes" }} onRevise={() => {}} onChangeAccess={() => {}} />);
  expect(screen.getByRole("status").textContent).toMatch(/Agent access below.*Revise to update it/);
});

it("an old record without a decision renders exactly as before", () => {
  render(<CoordinationStatus {...planStop} onRevise={() => {}} />);
  expect(screen.queryByRole("status")).toBeNull();
  expect(document.querySelector(".coordination-outcome")?.textContent).toContain(gate);
  expect(screen.getByText("This plan needs changes. Revise keeps it and lets you send an update.")).toBeTruthy();
});

it("the method line does not repeat the automatic-off setting the decision sentence already says", () => {
  const wf = { id: "my-0a1b2c3d", version: 2, name: "Careful" };
  const ranOne = [{ kind: "plan-check", harness: "Pi", verdict: "revise" }] as const;
  render(<CoordinationStatus {...planStop} workflow={wf} checksRan={ranOne} decision={{ kind: "automatic-off", stage: "plan" }} />);
  expect(screen.getByText("Careful v2 · Ran: plan check by Pi")).toBeTruthy();
  expect(screen.queryByText(/Automatic plan revision/)).toBeNull();
});
