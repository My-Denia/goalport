import { describe, expect, it } from "vitest";
import { catalogFromProviderSnapshots } from "./catalogFromProviders";
import { coordinateGoal } from "./coordinateGoal";
import { runCoordinateSession, type CoordinateTransport } from "./coordinateSession";
import { requestCoordination } from "./requestCoordination";
import type { CoordinateTurnCommand } from "./coordinateTurn";

const goal = "Explain the failure and leave a bounded plan.";
const workspacePath = "/work/selected-goal";

const providers = [
  {
    instanceId: "codex",
    displayName: "Codex",
    driver: "codex",
    enabled: true,
    installed: true,
    availability: "available",
    status: "ready",
    auth: { status: "authenticated", type: "chatgpt" },
    models: [
      { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: false },
      { slug: "gpt-6-astra", name: "GPT-6-Astra", isDefault: true },
    ],
    usageLimits: { windows: [{ id: "five_hour", usedPercent: 10 }] },
  },
  {
    instanceId: "claude",
    displayName: "Claude",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    availability: "available",
    status: "ready",
    auth: { status: "authenticated", type: "subscription" },
    models: [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: false },
      { slug: "claude-fable-5-1", name: "Claude Fable 5.1", isDefault: true },
    ],
    usageLimits: {
      windows: [
        { id: "five_hour", usedPercent: 38 },
        { id: "seven_day", usedPercent: 12 },
      ],
    },
  },
] as const;

function recordingTransport(results: Array<{ text: string; errorText: string; prepared?: boolean }>): CoordinateTransport & { calls: CoordinateTurnCommand[] } {
  const calls: CoordinateTurnCommand[] = [];
  return {
    calls,
    async launch(command) {
      calls.push(command);
      const next = results[calls.length - 1];
      if (!next) throw new Error("a third turn was launched");
      return next;
    },
  };
}

describe("coordinate session", () => {
  it("assigns two harnesses from a real snapshot and does not send when unauthorized", async () => {
    const transport = recordingTransport([
      { text: "", errorText: "No model turn was sent, because this session is not authorized to spend subscription quota.", prepared: true },
      { text: "", errorText: "No model turn was sent, because this session is not authorized to spend subscription quota.", prepared: true },
    ]);
    const view = await requestCoordination(
      { goal, workspacePath },
      { connected: true, sendAuthorized: false, providers, stopReason: null },
      transport,
    );
    expect(view.planningHarness).toBe("Codex");
    expect(view.reviewHarness).toBe("Claude");
    expect(view.planningQuota).toBe("available");
    expect(view.reviewQuota).toBe("available");
    expect(view.result).toBeNull();
    expect(view.stopReason).toMatch(/not authorized to spend subscription quota/);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.modelSelection.instanceId).not.toBe(transport.calls[1]?.modelSelection.instanceId);
    const selected = coordinateGoal({
      catalog: catalogFromProviderSnapshots(providers),
      goal,
      workspacePath,
    });
    expect(selected.commands.map((command) => command.modelSelection.model)).toEqual([
      "gpt-6-astra",
      "claude-opus-5-5",
    ]);
  });

  it("stops after the critic and does not start an implementation turn", async () => {
    const transport = recordingTransport([
      { text: "Bounded plan.", errorText: "" },
      { text: "The plan can be carried out.", errorText: "" },
    ]);
    const catalog = catalogFromProviderSnapshots(providers);
    const state = await runCoordinateSession(
      { catalog, goal, workspacePath },
      { sendAuthorized: true },
      transport,
    );
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.modelSelection.model).toBe("gpt-6-astra");
    expect(transport.calls[1]?.modelSelection.model).toBe("claude-opus-5-5");
    expect(transport.calls[0]?.modelSelection.instanceId).not.toBe(transport.calls[1]?.modelSelection.instanceId);
    expect(transport.calls[1]?.initialMessage.text).toContain("Bounded plan.");
    expect(state.result).toBe("The plan can be carried out.");
    expect(state.stopReason).toBe("The independent check finished, so this stopped.");
  });

  it("shows a credits refusal as credits, not as a usage-limit wait, and does not launch the critic", async () => {
    const transport = recordingTransport([
      { text: "", errorText: "Claude Fable requires usage credits" },
      { text: "should not run", errorText: "" },
    ]);
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath },
      { sendAuthorized: true },
      transport,
    );
    expect(transport.calls).toHaveLength(1);
    expect(state.result).toBeNull();
    expect(state.stopReason).toBe("This model requires extra usage credits. It was not used.");
    expect(state.stopReason).not.toMatch(/591h|usage limit reached/i);
  });

  it("keeps a real usage limit and an authentication failure distinct", async () => {
    const limited = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath },
      { sendAuthorized: true },
      recordingTransport([{ text: "", errorText: "Codex usage limit reached. The session limit resets in 3h." }]),
    );
    expect(limited.stopReason).toContain("usage limit reached");
    expect(limited.stopReason).toContain("3h");

    const signedOut = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath },
      { sendAuthorized: true },
      recordingTransport([{ text: "", errorText: "authentication failed" }]),
    );
    expect(signedOut.stopReason).toBe("This harness is not signed in.");
  });

  it("does not launch the review harness after the request is replaced", async () => {
    let launches = 0;
    const view = await requestCoordination(
      { goal, workspacePath },
      { connected: true, sendAuthorized: false, providers, stopReason: null },
      {
        async launch() {
          launches += 1;
          return { text: "", errorText: "", prepared: true };
        },
      },
      () => launches === 0,
    );
    expect(launches).toBe(1);
    expect(view.planningHarness).toBeNull();
    expect(view.reviewHarness).toBeNull();
    expect(view.stopReason).toMatch(/replaced/);
  });

  it("keeps a harness when only another model's window is exhausted", () => {
    const withFableSpent = providers.map((provider) => provider.instanceId === "codex"
      ? {
          ...provider,
          models: [
            { slug: "gpt-6-fable", name: "GPT-6 Fable", isDefault: false },
            ...provider.models,
          ],
          usageLimits: {
            windows: [
              { id: "five_hour", usedPercent: 10 },
              { id: "seven_day_fable", usedPercent: 100 },
            ],
          },
        }
      : provider);
    const catalog = catalogFromProviderSnapshots(withFableSpent);
    expect(catalog.find((instance) => instance.instanceId === "codex")?.quota).toBe("available");
    const selected = coordinateGoal({ catalog, goal, workspacePath });
    expect(selected.commands).toHaveLength(2);
    expect(selected.commands.map((command) => command.modelSelection.model)).toContain("gpt-6-astra");
    expect(selected.commands.map((command) => command.modelSelection.model)).not.toContain("gpt-6-fable");

    const generalSpent = catalogFromProviderSnapshots([{
      ...withFableSpent[0],
      usageLimits: { windows: [{ id: "five_hour", usedPercent: 100 }, { id: "seven_day_fable", usedPercent: 10 }] },
    }]);
    expect(generalSpent[0]?.quota).toBe("exhausted");
  });

  it("does not invent a harness when the coordination service is missing", async () => {
    const view = await requestCoordination({ goal, workspacePath }, null, recordingTransport([]));
    expect(view.planningHarness).toBeNull();
    expect(view.reviewHarness).toBeNull();
    expect(view.stopReason).toMatch(/no coordination service/);
  });
});
