import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CampaignNav } from "../nav/CampaignNav";
import { DEMO_SNAPSHOT, EMPTY_SNAPSHOT } from "../types";
import { evidenceCommand, coordinateGoal, replacementCommand, type CoordinateGoalInput, type ExecutionFeedback, type SyntheticCatalogInstance } from "./coordinateGoal";

import { authorizeCoordinateWriteTurn, roleOfCommandId } from "./coordinateTurn";
import { verdictFromAudit, verdictFromReview, outcomeLabel } from "./verdict";

const workspacePath = "/work/selected-goal";
const goal = "Explain the failure and leave a bounded plan.";

function instance(overrides: SyntheticCatalogInstance): SyntheticCatalogInstance {
  return overrides;
}

describe("Synthetic path", () => {
  it("names two different harnesses, a fixture review, and the stop reason that the review is in", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({ instanceId: "pi-local", name: "Pi", defaultModel: "pi-default", quota: "available" }),
        instance({ instanceId: "cursor-local", name: "Cursor", models: ["cursor-first"], quota: "available" }),
      ],
    });

    expect(state.planningHarness).toBe("Pi");
    expect(state.reviewHarness).toBe("Cursor");
    expect(state.result).toBeNull();
    expect(state.stopReason).toBe("Two different harnesses are assigned. No model turn has been sent.");
    expect(state.roles).toEqual(["planning", "review"]);
    expect(state.commands).toHaveLength(2);
    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["pi-local", "cursor-local"]);
    expect(new Set(state.commands.map((command) => command.modelSelection.instanceId)).size).toBe(2);
    for (const command of state.commands) {
      expect(command.type).toBe("goalport.coordinateTurn");
      expect(command.runtimeMode).toBe("approval-required");
      expect(command.approvalPolicy).toBe("never");
      expect(command.sandboxPolicy).toEqual({ type: "readOnly" });
    }
    expect(state.commands[0]?.initialMessage.text).toContain(goal);
    expect(state.commands[0]?.initialMessage.text).toContain(workspacePath);
    expect(state.commands[0]?.initialMessage.text).toContain("without claiming the review passed");
    expect(state.commands[0]?.initialMessage.text).toContain("Find the product contract in this workspace");
    expect(state.commands[0]?.initialMessage.text).toContain("If you cannot confirm one, say so.");
    expect(state.commands[1]?.initialMessage.text).toContain("done-claim is not a pass");
    expect(state.commands[1]?.initialMessage.text).toContain("where that contract is");
    expect(state.commands).toHaveLength(2);
  });

  it("a revision cites the saved plan and check and does not reuse the first turn", () => {
    const catalog = [
      instance({ instanceId: "pi-local", name: "Pi", defaultModel: "pi-default", quota: "available" }),
      instance({ instanceId: "cursor-local", name: "Cursor", models: ["cursor-first"], quota: "available" }),
    ];
    const first = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog });
    const revised = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog,
      priorPlan: "Bounded plan.",
      priorReview: "The contract path is missing.\nVERDICT: revise",
    });
    const plan = revised.commands[0]?.initialMessage.text ?? "";
    expect(plan).toContain("This is a revision of a saved plan.");
    expect(plan).toContain("Answer every point the independent check raised, one by one.");
    expect(plan).toContain("State the workspace state this plan relies on");
    expect(plan).toContain("Bounded plan.");
    expect(plan).toContain("The contract path is missing.");
    expect(plan).not.toContain("AGENTS.md");
    const firstSend = first.commands[0]?.initialMessage.text ?? "";
    expect(firstSend).not.toContain("Answer every point the independent check raised");
    expect(firstSend).not.toContain("State the workspace state");
    expect(revised.commands[1]?.initialMessage.text).toContain("The contract path is missing.");
    expect(revised.commands[0]?.commandId).not.toBe(first.commands[0]?.commandId);
    expect(revised.commands[1]?.commandId).not.toBe(first.commands[1]?.commandId);
  });

  it("does not select a default model that requires extra usage credits", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({
          instanceId: "codex",
          name: "Codex",
          quota: "available",
          models: [
            { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
            { slug: "gpt-6-astra", name: "GPT-6-Astra", isDefault: true },
          ],
        }),
        instance({
          instanceId: "claude",
          name: "Claude",
          quota: "available",
          models: [
            { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
            { slug: "claude-fable-5-1", name: "Claude Fable 5.1", isDefault: true },
          ],
        }),
      ],
    });

    expect(state.planningHarness).toBe("Codex");
    expect(state.reviewHarness).toBe("Claude");
    expect(state.commands.map((command) => command.modelSelection.model)).toEqual([
      "gpt-6-astra",
      "claude-opus-5-5",
    ]);
    expect(JSON.stringify(state.commands)).not.toContain("fable");

    const onlyCredits = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({
          instanceId: "codex",
          name: "Codex",
          quota: "available",
          defaultModel: "gpt-6-astra",
        }),
        instance({
          instanceId: "claude",
          name: "Claude",
          quota: "available",
          models: [{ slug: "claude-fable-5-1", name: "Claude Fable 5.1", isDefault: true }],
        }),
      ],
    });
    expect(onlyCredits.commands).toEqual([]);
    expect(onlyCredits.stopReason).toMatch(/extra usage credits/);
  });

  it("does not invent a model when a signed-in harness has none", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({
          instanceId: "codex",
          name: "Codex",
          quota: "unknown",
          authenticated: true,
          models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true }],
        }),
        instance({
          instanceId: "claude",
          name: "Claude",
          quota: "unknown",
          authenticated: true,
          billing: "subscription",
          models: [],
        }),
      ],
    });

    expect(state.commands).toEqual([]);
    expect(state.stopReason).toMatch(/no included model/);
  });

  it("stops an empty catalog because no harness catalog is connected", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [],
    });

    expect(state.planningHarness).toBeNull();
    expect(state.reviewHarness).toBeNull();
    expect(state.result).toBeNull();
    expect(state.roles).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(state.stopReason).toBe("Stopped. No harness catalog is connected, so no role was assigned.");
  });

  it("stops when the catalog has one instance and does not emit a second command", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [instance({ instanceId: "pi-local", name: "Pi", quota: "available" })],
    });

    expect(state.planningHarness).toBeNull();
    expect(state.reviewHarness).toBeNull();
    expect(state.result).toBeNull();
    expect(state.roles).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(state.stopReason).toMatch(/no second role/i);
  });

  it("stops when both roles would be the same instance and does not emit a second command", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({ instanceId: "same-instance", name: "Pi", quota: "available" }),
        instance({ instanceId: "same-instance", name: "Pi", quota: "available" }),
      ],
    });

    expect(state.reviewHarness).toBeNull();
    expect(state.roles).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(state.result).toBeNull();
    expect(state.stopReason).toMatch(/no second role/i);
  });

  it("does not give an exhausted limit window a role", () => {
    const paired = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({ instanceId: "pi-local", name: "Pi", quota: "available", models: ["pi-default"] }),
        instance({ instanceId: "spent-window", name: "Spent Window", quota: "exhausted" }),
        instance({ instanceId: "cursor-local", name: "Cursor", quota: "available", models: ["cursor-first"] }),
      ],
    });
    expect(paired.planningHarness).toBe("Pi");
    expect(paired.reviewHarness).toBe("Cursor");
    expect(paired.planningHarness).not.toBe("Spent Window");
    expect(paired.reviewHarness).not.toBe("Spent Window");
    expect(paired.commands.map((command) => command.modelSelection.instanceId)).not.toContain("spent-window");

    const onlyOneLeft = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({ instanceId: "pi-local", name: "Pi", quota: "available" }),
        instance({ instanceId: "spent-window", name: "Spent Window", quota: "exhausted" }),
      ],
    });
    expect(onlyOneLeft.planningHarness).toBeNull();
    expect(onlyOneLeft.reviewHarness).toBeNull();
    expect(onlyOneLeft.commands).toEqual([]);
    expect(onlyOneLeft.roles).toEqual([]);
  });

  it("keeps UNKNOWN as the word unknown and does not choose a paid API", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({
          instanceId: "pi-local",
          name: "Pi",
          quota: "UNKNOWN",
          billing: "subscription",
          models: ["pi-default"],
        }),
        instance({
          instanceId: "metered-api",
          name: "Metered API",
          billing: "paid-api",
          quota: { state: "available", remaining: 40 },
        }),
        instance({
          instanceId: "cursor-local",
          name: "Cursor",
          quota: "available",
          billing: "subscription",
          models: ["cursor-first"],
        }),
      ],
    });

    expect(state.quotaLabels["pi-local"]).toBe("unknown");
    expect(state.planningHarness).toBe("Pi");
    expect(state.reviewHarness).toBe("Cursor");
    expect(state.planningHarness).not.toBe("Metered API");
    expect(state.reviewHarness).not.toBe("Metered API");
    expect(state.commands.map((command) => command.modelSelection.instanceId)).not.toContain("metered-api");
    const rendered = JSON.stringify(state);
    expect(rendered).toContain("unknown");
    expect(rendered).not.toContain("40");
    expect(rendered).not.toContain("remaining");
    expect(JSON.stringify(state.quotaLabels)).not.toMatch(/\d/);

    const noFallback = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({ instanceId: "pi-local", name: "Pi", quota: "UNKNOWN" }),
        instance({
          instanceId: "metered-api",
          name: "Metered API",
          billing: "paid-api",
          quota: { state: "available", remaining: 40 },
        }),
      ],
    });
    expect(noFallback.quotaLabels["pi-local"]).toBe("unknown");
    expect(noFallback.reviewHarness).toBeNull();
    expect(noFallback.commands).toEqual([]);
    expect(noFallback.result).toBeNull();
    expect(JSON.stringify(noFallback)).not.toContain("40");
    expect(JSON.stringify(noFallback)).not.toContain("Metered API");
  });

  it("skips a harness with no selectable model and pairs the later ones", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({ instanceId: "blank", name: "Blank", quota: "available", models: [] }),
        instance({ instanceId: "omitted", name: "Omitted", quota: "available" }),
        instance({ instanceId: "pi-local", name: "Pi", quota: "available", models: ["pi-default"] }),
        instance({ instanceId: "cursor-local", name: "Cursor", quota: "available", models: ["cursor-first"] }),
      ],
    });

    expect(state.planningHarness).toBe("Pi");
    expect(state.reviewHarness).toBe("Cursor");
    expect(state.commands.map((command) => command.modelSelection.model)).toEqual(["pi-default", "cursor-first"]);
    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["pi-local", "cursor-local"]);
  });

  it("keys the commands to the individual send, not only the prompt text", () => {
    const catalog = [
      instance({ instanceId: "pi-local", name: "Pi", defaultModel: "pi-default", quota: "available" }),
      instance({ instanceId: "cursor-local", name: "Cursor", models: ["cursor-first"], quota: "available" }),
    ];
    const first = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog });
    const repeat = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog });
    const secondSend = coordinateGoal({ goal, workspacePath, sendKey: "send-1", catalog });

    expect(secondSend.commands[0]?.commandId).not.toBe(first.commands[0]?.commandId);
    expect(secondSend.commands[1]?.commandId).not.toBe(first.commands[1]?.commandId);
    expect(repeat.commands[0]?.commandId).toBe(first.commands[0]?.commandId);
    expect(repeat.commands[1]?.commandId).toBe(first.commands[1]?.commandId);
  });

  it("an avoided harness receives no role while the others keep both roles", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", defaultModel: "gpt-a", quota: "available" }),
      instance({ instanceId: "claude", name: "Claude", models: ["claude-a"], quota: "available" }),
      instance({ instanceId: "grok", name: "Grok", models: ["grok-a"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog, avoidInstances: ["codex"] });

    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["claude", "grok"]);
    expect(state.planningHarness).toBe("Claude");
    expect(state.reviewHarness).toBe("Grok");
    expect(state.quotaLabels.codex).toBe("available");
  });

  it("avoiding down to one harness names the harness that cannot run", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", defaultModel: "gpt-a", quota: "available" }),
      instance({ instanceId: "claude", name: "Claude", models: ["claude-a"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog, avoidInstances: ["codex"] });

    expect(state.commands).toHaveLength(0);
    expect(state.stopReason).toBe("Stopped. Codex cannot run on this machine right now, and an independent check needs two harnesses that can run.");
    expect(state.quotaLabels.codex).toBe("available");
  });

  it("write authorization with one usable harness assigns no role and emits no workspaceWrite", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", defaultModel: "gpt-a", quota: "available", billing: "subscription", authenticated: true, installed: true, enabled: true, launchable: true, models: [{ slug: "gpt-a", name: "gpt-a", isDefault: true }] }),
    ];
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "write-one",
      catalog,
      allowedInstances: ["codex"],
      writeAuthorization: { instances: ["codex"], workspaceRoot: workspacePath, remaining: 1 },
    });
    expect(state.commands).toEqual([]);
    expect(state.roles).toEqual([]);
    expect(state.stopReason).toBe("Stopped. An independent check needs a second logged-in harness, so no second role was assigned.");
  });

  it("an unusable catalog keeps its original stop reason even with an avoidance", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", defaultModel: "gpt-a", quota: "exhausted" }),
      instance({ instanceId: "claude", name: "Claude", models: ["claude-a"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog, avoidInstances: ["codex"] });

    expect(state.commands).toHaveLength(0);
    expect(state.stopReason).toBe("Stopped. An independent check needs a second logged-in harness, so no second role was assigned.");
  });

  it("excludes a health-blocked harness from both initial roles", () => {
    const catalog = [
      instance({ instanceId: "blocked", name: "Blocked", models: ["model-a"], quota: "available", environmentAvoided: { since: "2026-10-09T14:00:00.000Z", detail: "sandbox failed" } }),
      instance({ instanceId: "planner", name: "Planner", models: ["model-b"], quota: "available" }),
      instance({ instanceId: "reviewer", name: "Reviewer", models: ["model-c"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "health-0", catalog });

    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["planner", "reviewer"]);
    expect(state.planningHarness).toBe("Planner");
    expect(state.reviewHarness).toBe("Reviewer");
  });

  it("treats health-blocked and draft-avoided instances as a union", () => {
    const catalog = [
      instance({ instanceId: "health-blocked", name: "Health", models: ["model-a"], quota: "available", environmentAvoided: { since: "2026-10-09T14:00:00.000Z", detail: "sandbox failed" } }),
      instance({ instanceId: "draft-avoided", name: "Avoided", models: ["model-b"], quota: "available" }),
      instance({ instanceId: "planner", name: "Planner", models: ["model-c"], quota: "available" }),
      instance({ instanceId: "reviewer", name: "Reviewer", models: ["model-d"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "health-avoid-0", catalog, avoidInstances: ["draft-avoided"] });

    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["planner", "reviewer"]);
  });

  it("names the health blocker when it prevents the independent pair", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", models: ["model-a"], quota: "available", environmentAvoided: { since: "2026-10-09T14:00:00.000Z", detail: "helper_unknown_error" } }),
      instance({ instanceId: "claude", name: "Claude", models: ["model-b"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "health-stop-0", catalog });

    expect(state.commands).toEqual([]);
    expect(state.stopReason).toBe("Stopped. Codex cannot run on this machine right now, and an independent check needs two harnesses that can run.");
  });

  it("filters initial role assignment to the authorized instances", () => {
    const catalog = [
      instance({ instanceId: "outside", name: "Outside", models: ["model-a"], quota: "available" }),
      instance({ instanceId: "planner", name: "Planner", models: ["model-b"], quota: "available" }),
      instance({ instanceId: "reviewer", name: "Reviewer", models: ["model-c"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "scope-0", catalog, allowedInstances: ["reviewer", "planner"] });

    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["planner", "reviewer"]);
    const tooNarrow = coordinateGoal({ goal, workspacePath, sendKey: "scope-1", catalog, allowedInstances: ["planner"] });
    expect(tooNarrow.commands).toEqual([]);
  });

  it("keeps an instance command key stable and derives a fresh key for another instance", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", models: ["model-a"], quota: "available" }),
      instance({ instanceId: "claude", name: "Claude", models: ["model-b"], quota: "available" }),
      instance({ instanceId: "grok", name: "Grok", models: ["model-c"], quota: "available" }),
    ];
    const original = coordinateGoal({ goal, workspacePath, sendKey: "same-send", catalog });
    const sameInstance = coordinateGoal({ goal, workspacePath, sendKey: "same-send", catalog });
    const differentInstance = coordinateGoal({ goal, workspacePath, sendKey: "same-send", catalog: [catalog[2]!, catalog[1]!, catalog[0]!] });

    expect(sameInstance.commands[0]?.commandId).toBe(original.commands[0]?.commandId);
    expect(differentInstance.commands[0]?.modelSelection.instanceId).not.toBe(original.commands[0]?.modelSelection.instanceId);
    expect(differentInstance.commands[0]?.commandId).not.toBe(original.commands[0]?.commandId);
  });
});


describe("explicit write assembly and phase verdicts", () => {
  const catalog: SyntheticCatalogInstance[] = [
    { instanceId: "a", name: "A", defaultModel: "included" },
    { instanceId: "b", name: "B", defaultModel: "included" },
  ];
  const input: CoordinateGoalInput = {
    catalog, goal, workspacePath, sendKey: "write-send", allowedInstances: ["a", "b"],
    writeAuthorization: { instances: ["a"], workspaceRoot: workspacePath, remaining: 1 },
  };
  it("advertises four roles but creates only the first two read commands until evidence exists", () => {
    const selected = coordinateGoal(input);
    expect(selected.roles).toEqual(["planning", "review", "execution", "audit"]);
    expect(selected.commands).toHaveLength(2);
    expect(selected.commands.map((command) => roleOfCommandId(command.commandId))).toEqual(["plan", "review"]);
    for (const command of selected.commands) {
      expect(authorizeCoordinateWriteTurn(command).outcome).toBe("write-authorized");
      expect(command.sandboxPolicy.type).toBe("readOnly");
    }
    const { writeAuthorization: _write, ...readInput } = input;
    expect(JSON.stringify(coordinateGoal(readInput))).toBe(JSON.stringify(coordinateGoal({ ...readInput, writeAuthorization: undefined })));
    expect(coordinateGoal(readInput).roles).toEqual(["planning", "review"]);
  });
  it.each([
    { ...input, allowedInstances: undefined },
    { ...input, workspacePath: "/work/other" },
    { ...input, workspacePath: "relative", writeAuthorization: { ...input.writeAuthorization!, workspaceRoot: "relative" } },
    { ...input, writeAuthorization: { ...input.writeAuthorization!, instances: [] } },
    { ...input, writeAuthorization: { ...input.writeAuthorization!, instances: ["unknown"] } },
  ])("refuses missing scope, wrong/relative root or unstaffable write membership before sending", (invalid) => {
    expect(coordinateGoal(invalid).commands).toEqual([]);
  });
  it("pairs lazy roles with sandbox/root and keys ids to role, instance, send and evidence", () => {
    const evidence = { planText: "Actual approved plan", reviewText: "VERDICT: carry-out", executionText: "Checks: exit 0", executionFacts: "actual facts" };
    const writer = evidenceCommand("execute", catalog[0]!, input, evidence);
    const audit = evidenceCommand("audit", catalog[1]!, input, evidence);
    expect(roleOfCommandId(writer.commandId)).toBe("execute");
    expect(roleOfCommandId(audit.commandId)).toBe("audit");
    expect(writer.sandboxPolicy.type).toBe("workspaceWrite");
    expect(audit.sandboxPolicy.type).toBe("readOnly");
    expect(writer.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: workspacePath });
    for (const command of [writer, audit]) {
      expect(authorizeCoordinateWriteTurn(command).outcome).toBe("write-authorized");
      expect(command.initialMessage.text).toContain(evidence.planText);
      expect(command.initialMessage.text).toContain(evidence.reviewText);
    }
    expect(writer.initialMessage.text).toContain("actual output and exit results");
    expect(audit.initialMessage.text).toContain(evidence.executionText);
    expect(audit.initialMessage.text).toContain(evidence.executionFacts);
    expect(audit.initialMessage.text).toContain("GoalPort has not independently run a machine-test stage");
    expect(evidenceCommand("execute", catalog[0]!, input, evidence)).toEqual(writer);
    expect(evidenceCommand("execute", catalog[0]!, { ...input, sendKey: "new-send" }, evidence).commandId).not.toBe(writer.commandId);
    expect(evidenceCommand("execute", catalog[0]!, input, { ...evidence, planText: "Other approved plan" }).commandId).not.toBe(writer.commandId);
    expect(evidenceCommand("audit", catalog[0]!, input, evidence).commandId).not.toBe(audit.commandId);
    expect(evidenceCommand("audit", catalog[1]!, input, { ...evidence, executionText: "different report" }).commandId).not.toBe(audit.commandId);
    expect(() => evidenceCommand("execute", catalog[1]!, input, evidence)).toThrow(/consent/);
  });
  it("carries execution feedback separately, uses repair-1 identities, and preserves read/write role gates", () => {
    const original = coordinateGoal(input);
    const originalEvidence = {
      planText: "Bounded plan for the original send.",
      reviewText: "VERDICT: carry-out",
      executionText: "pnpm test failed: 1 assertion",
      executionFacts: "original run facts",
    };
    const originalWriter = evidenceCommand("execute", catalog[0]!, input, originalEvidence);
    const originalAudit = evidenceCommand("audit", catalog[1]!, input, originalEvidence);
    const feedback: ExecutionFeedback = {
      previousPlan: originalEvidence.planText,
      previousPlanReview: originalEvidence.reviewText,
      previousExecutionReport: originalEvidence.executionText,
      previousExecutionAudit: "The configuration file was not updated.\nVERDICT: revise",
      previousCommandIds: [
        ...original.commands.map((command) => command.commandId),
        originalWriter.commandId,
        originalAudit.commandId,
      ],
    };
    const repairInput = { ...input, executionFeedback: feedback };
    const repair = coordinateGoal(repairInput);
    const [planner, reviewer] = repair.commands;
    const plannerText = planner?.initialMessage.text ?? "";
    const reviewerText = reviewer?.initialMessage.text ?? "";

    expect(repair.roles).toEqual(["planning", "review", "execution", "audit"]);
    expect(repair.commands.map((command) => roleOfCommandId(command.commandId))).toEqual(["plan", "review"]);
    expect(repair.commands.map((command) => command.modelSelection.instanceId)).toEqual(["a", "b"]);
    for (const command of repair.commands) {
      expect(command.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: workspacePath });
      expect(command.sandboxPolicy).toEqual({ type: "readOnly" });
      expect(feedback.previousCommandIds).not.toContain(command.commandId);
    }
    expect(plannerText).toContain(goal);
    expect(plannerText).toContain(workspacePath);
    expect(plannerText).toContain("Inspect the CURRENT workspace");
    expect(plannerText).toContain("Answer each finding in the previous independent execution audit");
    expect(plannerText).toContain(feedback.previousPlan!);
    expect(plannerText).toContain(feedback.previousPlanReview!);
    expect(plannerText).toContain(feedback.previousExecutionReport!);
    expect(plannerText).toContain("The configuration file was not updated.");
    expect(plannerText).toContain(originalWriter.commandId);
    expect(plannerText).toContain("references only; never replay or resubmit");
    expect(plannerText).not.toContain("This is a revision of a saved plan.");
    expect(reviewerText).toContain("independent check of the newly proposed corrective plan");
    expect(reviewerText).toContain("A writer is not eligible until this plan receives a carry-out verdict.");
    expect(reviewerText).toContain("The configuration file was not updated.");

    // Existing manual plan revision context remains independent from execution feedback.
    const withBoth = coordinateGoal({ ...repairInput, priorPlan: "Manual saved plan", priorReview: "Manual plan check" });
    expect(withBoth.commands[0]?.initialMessage.text).toContain("This is a revision of a saved plan.");
    expect(withBoth.commands[0]?.initialMessage.text).toContain("Manual saved plan");
    expect(withBoth.commands[0]?.initialMessage.text).toContain("This is the one bounded corrective planning pass");

    const sameEvidence = {
      planText: "Bounded corrective plan.",
      reviewText: "VERDICT: carry-out",
      executionText: "pnpm test: unchanged checks passed",
      executionFacts: "corrective run facts",
    };
    const firstLikeWriter = evidenceCommand("execute", catalog[0]!, input, sameEvidence);
    const firstLikeAudit = evidenceCommand("audit", catalog[1]!, input, sameEvidence);
    const repairWriter = evidenceCommand("execute", catalog[0]!, repairInput, sameEvidence);
    const repairAudit = evidenceCommand("audit", catalog[1]!, repairInput, sameEvidence);
    const recoveredPlanner = replacementCommand("plan", catalog[0]!, repairInput, input.sendKey);

    expect(roleOfCommandId(recoveredPlanner.commandId)).toBe("plan");
    expect(recoveredPlanner.sandboxPolicy).toEqual({ type: "readOnly" });
    expect(recoveredPlanner.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: workspacePath });
    expect(repairWriter.commandId).not.toBe(firstLikeWriter.commandId);
    expect(repairAudit.commandId).not.toBe(firstLikeAudit.commandId);
    expect([repairWriter, repairAudit, recoveredPlanner].map((command) => roleOfCommandId(command.commandId))).toEqual(["execute", "audit", "plan"]);
    expect(repairWriter.sandboxPolicy).toEqual({ type: "workspaceWrite" });
    expect(repairAudit.sandboxPolicy).toEqual({ type: "readOnly" });
    for (const command of [repairWriter, repairAudit]) {
      expect(command.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: workspacePath });
      expect(command.initialMessage.text).toContain("Bounded corrective plan.");
      expect(command.initialMessage.text).toContain("VERDICT: carry-out");
      expect(command.initialMessage.text).toContain(feedback.previousExecutionAudit!);
      expect(command.initialMessage.text).toContain(originalAudit.commandId);
      expect(feedback.previousCommandIds).not.toContain(command.commandId);
    }
    expect(repairWriter.initialMessage.text).toContain("newly reviewed bounded corrective plan");
    expect(repairWriter.initialMessage.text).toContain("Historical commands and command IDs are evidence only");
    expect(repairAudit.initialMessage.text).toContain("current workspace read-only");
    expect(repairAudit.initialMessage.text).toContain("Corrective execution report:");
    expect(repairAudit.initialMessage.text).toContain(sameEvidence.executionText);
    expect(evidenceCommand("execute", catalog[0]!, repairInput, sameEvidence)).toEqual(repairWriter);
  });
  it.each([
    ["VERDICT: verified", "unconfirmed", "verified"],
    ["VERDICT: carry-out", "checked", "unconfirmed"],
    ["VERDICT: revise", "revise", "revise"],
    ["VERDICT: stop", "stopped", "stopped"],
    ["VERDICT: verified\nMore prose", "unconfirmed", "unconfirmed"],
    ["verified", "unconfirmed", "unconfirmed"],
  ])("keeps verdicts phase-specific: %s", (text, review, audit) => {
    expect(verdictFromReview(text)).toBe(review);
    expect(verdictFromAudit(text)).toBe(audit);
    expect(outcomeLabel("verified")).toBe("Changes verified");
  });
});

// Compatibility regression only, not UI or product execution acceptance.
it("marks only the background row current while that job is the view", () => {
  const viewing = renderToStaticMarkup(createElement(CampaignNav, {
    snapshot: DEMO_SNAPSHOT, collapsed: false,
    runningJob: { goal: "Keep the helper running", stateLabel: "Running", viewing: true },
    onSelectCampaign() {}, onSelectProject() {}, onRenameCampaign() {},
  }));
  expect(viewing.match(/campaign-active/g)).toHaveLength(1);
  expect(viewing).toContain("Keep the helper running");
  expect(viewing).not.toContain("Rename goal");
  const parked = renderToStaticMarkup(createElement(CampaignNav, {
    snapshot: DEMO_SNAPSHOT, collapsed: false,
    runningJob: { goal: "Keep the helper running", stateLabel: "Running", viewing: false },
    onSelectCampaign() {}, onSelectProject() {}, onRenameCampaign() {},
  }));
  expect(parked).toContain("campaign-active");
  expect(parked).toContain("Build a durable preview");
  expect(parked).not.toContain("Keep the helper running</strong></span><span class=\"active-arrow\"");
});

it("the approved nav type seam renders verified with the existing complete class and outcome label", () => {
  const html = renderToStaticMarkup(createElement(CampaignNav, {
    snapshot: EMPTY_SNAPSHOT, collapsed: false,
    plans: [{ requestId: "verified-type-seam", title: "Verified type seam", active: false, verdict: "verified" }],
    onSelectCampaign() {}, onSelectProject() {}, onRenameCampaign() {},
  }));
  expect(html).toContain('aria-label="Plan: Verified type seam, Changes verified"');
  expect(html).toContain('class="campaign-state campaign-state-complete"');
  expect(html).toContain('<small>Changes verified</small>');
});
