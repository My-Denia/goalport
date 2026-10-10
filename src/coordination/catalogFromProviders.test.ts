import { describe, expect, it } from "vitest";
import { catalogFromProviderSnapshots } from "./catalogFromProviders";
import { coordinateGoal, usableInstanceIds } from "./coordinateGoal";

const baseProvider = {
  instanceId: "codex",
  displayName: "Codex",
  driver: "codex",
  enabled: true,
  installed: true,
  availability: "available",
  status: "ready",
  auth: { status: "authenticated", type: "chatgpt" },
  models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true }],
  usageLimits: { windows: [{ id: "five_hour", usedPercent: 10 }] },
} as const;

function usableInstance(instanceId: string, environmentHealth?: unknown) {
  return {
    ...baseProvider,
    instanceId,
    ...(environmentHealth === undefined ? {} : { environmentHealth }),
  };
}

describe("catalog environment health", () => {
  it("maps stored health evidence to an avoided instance and excludes it from usable ids", () => {
    const catalog = catalogFromProviderSnapshots([
      usableInstance("blocked", { since: " 2026-10-09T14:00:00.000Z ", detail: " helper_unknown_error " }),
      usableInstance("healthy"),
    ]);

    expect(catalog[0]?.environmentAvoided).toEqual({
      since: "2026-10-09T14:00:00.000Z",
      detail: "helper_unknown_error",
    });
    expect(usableInstanceIds(catalog)).toEqual(["healthy"]);
  });

  it("degrades malformed health shapes to no evidence rather than blocking a provider", () => {
    const catalog = catalogFromProviderSnapshots([
      usableInstance("wrong-type", "blocked"),
      usableInstance("missing-detail", { since: "2026-10-09T14:00:00.000Z" }),
      usableInstance("empty-since", { since: " ", detail: "helper_unknown_error" }),
      usableInstance("healthy", null),
    ]);

    expect(catalog.map((item) => item.environmentAvoided)).toEqual([null, null, null, null]);
    expect(usableInstanceIds(catalog)).toEqual(["wrong-type", "missing-detail", "empty-since", "healthy"]);
  });

  it("leaves the catalog exactly unchanged when the health field is absent", () => {
    const before = catalogFromProviderSnapshots([usableInstance("codex")]);
    const after = catalogFromProviderSnapshots([{ ...baseProvider, instanceId: "codex" }]);

    expect(after).toEqual(before);
    expect(after[0]).not.toHaveProperty("environmentAvoided");
  });

  it("treats health and draft avoidance as a union for role eligibility", () => {
    const catalog = catalogFromProviderSnapshots([
      usableInstance("health-blocked", { since: "2026-10-09T14:00:00.000Z", detail: "sandbox failed" }),
      usableInstance("draft-avoided"),
      usableInstance("planner"),
      usableInstance("reviewer"),
    ]);

    const state = coordinateGoal({
      catalog,
      goal: "Explain the failure.",
      workspacePath: "/work/goal",
      sendKey: "send-health-avoid",
      avoidInstances: ["draft-avoided"],
    });
    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["planner", "reviewer"]);
  });
});
