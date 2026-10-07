import { describe, expect, it } from "vitest";
import { coordinateGoal, type SyntheticCatalogInstance } from "./coordinateGoal";

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
    expect(state.commands[1]?.initialMessage.text).toContain("done-claim is not a pass");
    expect(state.commands).toHaveLength(2);
  });

  it("does not select a default model that requires extra usage credits", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
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

  it("stops an empty catalog because no harness catalog is connected", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
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
});
