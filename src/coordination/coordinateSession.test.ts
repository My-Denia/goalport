import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogFromProviderSnapshots, type ProviderSnapshot } from "./catalogFromProviders";
import { coordinateGoal } from "./coordinateGoal";
import { runCoordinateSession, type CoordinateLaunchResult, type CoordinateTransport, type CoordinateSessionEvent } from "./coordinateSession";
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

const thirdProvider = {
  instanceId: "grok",
  displayName: "Grok",
  driver: "grok",
  enabled: true,
  installed: true,
  availability: "available",
  status: "ready",
  auth: { status: "authenticated", type: "subscription" },
  models: [{ slug: "grok-fast", name: "Grok Fast", isDefault: true }],
  usageLimits: { windows: [{ id: "five_hour", usedPercent: 10 }] },
} as const;

function recordingTransport(results: CoordinateLaunchResult[]): CoordinateTransport & { calls: CoordinateTurnCommand[] } {
  const calls: CoordinateTurnCommand[] = [];
  return {
    calls,
    async launch(command) {
      calls.push(command);
      const next = results[calls.length - 1];
      if (!next) throw new Error("a turn was launched without a fixture");
      return next;
    },
  };
}

async function scopedSession(
  source: readonly ProviderSnapshot[],
  results: CoordinateLaunchResult[],
  onEvent?: (event: CoordinateSessionEvent) => void,
) {
  const catalog = catalogFromProviderSnapshots(source);
  const transport = recordingTransport(results);
  const state = await runCoordinateSession(
    { catalog, goal, workspacePath, sendKey: "scoped-send" },
    { sendAuthorized: true, allowedInstances: catalog.map((item) => item.instanceId), onEvent },
    transport,
  );
  return { state, transport, catalog };
}

const providersWithThird: readonly ProviderSnapshot[] = [...providers, thirdProvider];

describe("coordinate session", () => {
  it("assigns two harnesses from a real snapshot and does not send when unauthorized", async () => {
    const transport = recordingTransport([
      { text: "", errorText: "No model turn was sent, because this session is not authorized to spend subscription quota.", prepared: true },
      { text: "", errorText: "No model turn was sent, because this session is not authorized to spend subscription quota.", prepared: true },
    ]);
    const view = await requestCoordination(
      { goal, workspacePath, sendKey: "send-0" },
      { connected: true, sendAuthorized: false, providers, stopReason: null },
      transport,
    );
    expect(view.planningHarness).toBe("Codex");
    expect(view.reviewHarness).toBe("Claude");
    expect(view.planningQuota).toBe("available");
    expect(view.reviewQuota).toBe("available");
    expect(view.result).toBeNull();
    expect(view.stopReason).toMatch(/not authorized to spend subscription quota/);
    expect(transport.calls).toHaveLength(0);
    const selected = coordinateGoal({
      catalog: catalogFromProviderSnapshots(providers),
      goal,
      workspacePath,
      sendKey: "send-0",
    });
    expect(selected.commands.map((command) => command.modelSelection.model)).toEqual([
      "gpt-6-astra",
      "claude-opus-5-5",
    ]);
  });

  it("stops after the critic and does not start an implementation turn", async () => {
    const transport = recordingTransport([
      { text: "Bounded plan.", errorText: "" },
      { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "" },
    ]);
    const catalog = catalogFromProviderSnapshots(providers);
    const state = await runCoordinateSession(
      { catalog, goal, workspacePath, sendKey: "send-0" },
      { sendAuthorized: true },
      transport,
    );
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.modelSelection.model).toBe("gpt-6-astra");
    expect(transport.calls[1]?.modelSelection.model).toBe("claude-opus-5-5");
    expect(transport.calls[0]?.modelSelection.instanceId).not.toBe(transport.calls[1]?.modelSelection.instanceId);
    expect(transport.calls[1]?.initialMessage.text).toContain("Bounded plan.");
    expect(state.planText).toBe("Bounded plan.");
    expect(state.reviewText).toBe("The plan can be carried out.\nVERDICT: carry-out");
    expect(state.verdict).toBe("checked");
    expect(state.result).toBe("The plan can be carried out.\nVERDICT: carry-out");
    expect(state.stopReason).toBe("The independent check finished, so this stopped.");
    expect(state.messageDispatched).toBe(true);
  });

  it("does not treat a review without a verdict line as carried out", async () => {
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath, sendKey: "send-0" },
      { sendAuthorized: true },
      recordingTransport([
        { text: "Bounded plan.", errorText: "" },
        { text: "The plan can be carried out.", errorText: "" },
      ]),
    );
    expect(state.planText).toBe("Bounded plan.");
    expect(state.verdict).toBe("unconfirmed");
    expect(state.stopReason).toBe("The independent check did not confirm the plan, so this stopped.");
  });

  it("shows a credits refusal as credits, not as a usage-limit wait, and does not launch the critic", async () => {
    const transport = recordingTransport([
      { text: "", errorText: "Claude Fable requires usage credits" },
      { text: "should not run", errorText: "" },
    ]);
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath, sendKey: "send-0" },
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
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath, sendKey: "send-0" },
      { sendAuthorized: true },
      recordingTransport([{ text: "", errorText: "Codex usage limit reached. The session limit resets in 3h." }]),
    );
    expect(limited.stopReason).toContain("usage limit reached");
    expect(limited.stopReason).toContain("3h");

    const signedOut = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath, sendKey: "send-0" },
      { sendAuthorized: true },
      recordingTransport([{ text: "", errorText: "authentication failed" }]),
    );
    expect(signedOut.stopReason).toBe("This harness is not signed in.");
  });

  it("does not launch the review harness after the request is replaced", async () => {
    let launches = 0;
    const view = await requestCoordination(
      { goal, workspacePath, sendKey: "send-0" },
      { connected: true, sendAuthorized: true, providers, stopReason: null },
      {
        async launch() {
          launches += 1;
          return { text: "Bounded plan.", errorText: "" };
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
    const selected = coordinateGoal({ catalog, goal, workspacePath, sendKey: "send-0" });
    expect(selected.commands).toHaveLength(2);
    expect(selected.commands.map((command) => command.modelSelection.model)).toContain("gpt-6-astra");
    expect(selected.commands.map((command) => command.modelSelection.model)).not.toContain("gpt-6-fable");

    const generalSpent = catalogFromProviderSnapshots([{
      ...withFableSpent[0],
      usageLimits: { windows: [{ id: "five_hour", usedPercent: 100 }, { id: "seven_day_fable", usedPercent: 10 }] },
    }]);
    expect(generalSpent[0]?.quota).toBe("exhausted");

    const onlyModelWindow = catalogFromProviderSnapshots([{
      ...withFableSpent[0],
      usageLimits: { windows: [{ id: "seven_day_fable", usedPercent: 100 }] },
    }, withFableSpent[1]]);
    expect(onlyModelWindow.find((instance) => instance.instanceId === "codex")?.quota).toBe("unknown");
    const stillPaired = coordinateGoal({ catalog: onlyModelWindow, goal, workspacePath, sendKey: "send-0" });
    expect(stillPaired.commands).toHaveLength(2);
    expect(stillPaired.commands.map((command) => command.modelSelection.model)).toContain("gpt-6-astra");
    expect(stillPaired.commands.map((command) => command.modelSelection.model)).not.toContain("gpt-6-fable");
  });

  it("does not send a revision when this session is not authorized", async () => {
    const transport = recordingTransport([]);
    const view = await requestCoordination(
      {
        goal,
        workspacePath,
        sendKey: "send-0",
        priorPlan: "Bounded plan.",
        priorReview: "The contract path is missing.\nVERDICT: revise",
      },
      { connected: true, sendAuthorized: false, providers, stopReason: null },
      transport,
    );
    expect(transport.calls).toHaveLength(0);
    expect(view.stopReason).toMatch(/not authorized to spend subscription quota/);
    expect(view.planText).toBeNull();
  });

  it("does not invent a harness when the coordination service is missing", async () => {
    const view = await requestCoordination({ goal, workspacePath, sendKey: "send-0" }, null, recordingTransport([]));
    expect(view.planningHarness).toBeNull();
    expect(view.reviewHarness).toBeNull();
    expect(view.stopReason).toMatch(/no coordination service/);
  });

  it("maps a stderr-borne authentication phrase and keeps the round retryable", async () => {
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath, sendKey: "send-0" },
      { sendAuthorized: true },
      recordingTransport([
        { text: "", errorText: "The harness finished without any text, so this stopped. stream error: You are not logged in. Run codex login.", dispatched: false },
      ]),
    );
    expect(state.verdict).toBe("failed");
    expect(state.stopReason).toBe("This harness is not signed in.");
    expect(state.messageDispatched).toBe(false);
  });

  it("a dispatched failure is never marked retryable", async () => {
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath, sendKey: "send-0" },
      { sendAuthorized: true },
      recordingTransport([
        { text: "", errorText: "The harness did not finish, so this stopped.", dispatched: true },
      ]),
    );
    expect(state.verdict).toBe("failed");
    expect(state.messageDispatched).toBe(true);
  });

  it("a launch result without a dispatch state is unknown, never retryable", async () => {
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath, sendKey: "send-0" },
      { sendAuthorized: true },
      recordingTransport([{ text: "", errorText: "The coordination service stopped." }]),
    );
    expect(state.verdict).toBe("failed");
    expect(state.messageDispatched).toBeNull();
  });

  it("an environment-blocked planner turn stops without sending the review", async () => {
    const transport = recordingTransport([
      {
        text: "I couldn't read the file because the sandbox failed to initialize.",
        errorText: "This harness cannot run its tools on this machine, so this stopped.",
        dispatched: true,
        environmentBlocked: true,
        environmentDetail: "Failed to create unified exec process: helper_unknown_error: setup refresh had errors",
      },
    ]);
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath, sendKey: "send-0" },
      { sendAuthorized: true },
      transport,
    );
    expect(transport.calls).toHaveLength(1);
    expect(state.verdict).toBe("failed");
    expect(state.messageDispatched).toBe(true);
    expect(state.planText).toBe("I couldn't read the file because the sandbox failed to initialize.");
    expect(state.stopReason).toBe("The harness could not finish the turn, so this stopped.");
    expect(state.environmentBlocked).toEqual({
      role: "planning",
      instanceId: "codex",
      harness: "Codex",
      detail: "Failed to create unified exec process: helper_unknown_error: setup refresh had errors",
    });
  });

  it("an environment-blocked review turn fails the round and names the review role", async () => {
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath, sendKey: "send-0" },
      { sendAuthorized: true },
      recordingTransport([
        { text: "Bounded plan.", errorText: "" },
        {
          text: "",
          errorText: "This harness cannot run its tools on this machine, so this stopped.",
          dispatched: true,
          environmentBlocked: true,
          environmentDetail: "windows sandbox failed: helper_unknown_error",
        },
      ]),
    );
    expect(state.verdict).toBe("failed");
    expect(state.planText).toBe("Bounded plan.");
    expect(state.stopReason).toBe("The harness could not finish the turn, so this stopped.");
    expect(state.environmentBlocked).toEqual({
      role: "review",
      instanceId: "claude",
      harness: "Claude",
      detail: "windows sandbox failed: helper_unknown_error",
    });
  });

  it("a stderr signature alone still classifies the round as environment-blocked", async () => {
    const transport = recordingTransport([
      {
        text: "",
        errorText: "The harness did not finish, so this stopped. ERROR codex_core::tools::router: Failed to create unified exec process: helper_unknown_error: setup refresh had errors",
        dispatched: true,
      },
    ]);
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(providers), goal, workspacePath, sendKey: "send-0" },
      { sendAuthorized: true },
      transport,
    );
    expect(transport.calls).toHaveLength(1);
    expect(state.verdict).toBe("failed");
    expect(state.environmentBlocked).toEqual({
      role: "planning",
      instanceId: "codex",
      harness: "Codex",
      detail: "helper_unknown_error",
    });
    expect(state.stopReason).toBe("The harness could not finish the turn, so this stopped.");
  });

  it("① a typed environment failure takes over planning and reaches an independent checked review", async () => {
    const { state, transport } = await scopedSession(providersWithThird, [
      {
        text: "",
        errorText: "sandbox failed",
        dispatched: true,
        environmentBlocked: true,
        environmentDetail: "typed helper failure",
        stopCode: "not-installed",
      },
      { text: "Recovered plan.", errorText: "", dispatched: true },
      { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "", dispatched: true },
    ]);

    expect(transport.calls).toHaveLength(3);
    expect(transport.calls.map((command) => command.modelSelection.instanceId)).toEqual(["codex", "claude", "grok"]);
    expect(transport.calls.map((command) => command.commandId).filter((id, index, all) => all.indexOf(id) !== index)).toEqual([]);
    expect(state.verdict).toBe("checked");
    expect(state.planningHarness).toBe("Claude");
    expect(state.reviewHarness).toBe("Grok");
    expect(state.planningHarness).not.toBe(state.reviewHarness);
    expect(state.environmentBlocked?.detail).toBe("typed helper failure");
  });

  it("①b a proven-not-sent environment failure also takes over", async () => {
    const { state, transport } = await scopedSession(providersWithThird, [
      { text: "", errorText: "", dispatched: false, environmentBlocked: true, environmentDetail: "not dispatched" },
      { text: "Recovered plan.", errorText: "", dispatched: true },
      { text: "Plan accepted.\nVERDICT: carry-out", errorText: "", dispatched: true },
    ]);

    expect(transport.calls).toHaveLength(3);
    expect(state.verdict).toBe("checked");
    expect(state.roundEvents[0]?.kind).toBe("failed");
  });

  it("② a two-instance environment failure stops before any replacement launch", async () => {
    const { state, transport } = await scopedSession(providers, [
      { text: "", errorText: "", dispatched: true, environmentBlocked: true, environmentDetail: "helper_unknown_error" },
    ]);

    expect(transport.calls).toHaveLength(1);
    expect(state.stopReason).toBe("Stopped. Codex cannot run on this machine right now, and an independent check needs two harnesses that can run.");
    expect(state.roundEvents.map((event) => event.kind)).toEqual(["failed"]);
  });

  it("③ a reviewer environment failure gives the replacement the plan and keeps it independent", async () => {
    const { state, transport } = await scopedSession(providersWithThird, [
      { text: "Bounded plan.", errorText: "", dispatched: true },
      { text: "", errorText: "", dispatched: true, environmentBlocked: true, environmentDetail: "sandbox helper failed" },
      { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "", dispatched: true },
    ]);

    expect(transport.calls).toHaveLength(3);
    expect(transport.calls[2]?.modelSelection.instanceId).toBe("grok");
    expect(transport.calls[2]?.modelSelection.instanceId).not.toBe(transport.calls[0]?.modelSelection.instanceId);
    expect(transport.calls[2]?.initialMessage.text).toContain("Bounded plan.");
    expect(state.planningHarness).toBe("Codex");
    expect(state.reviewHarness).toBe("Grok");
  });

  it("④ dispatched null and ④b an absent dispatch field are both unknown and never take over", async () => {
    const unknownResults: CoordinateLaunchResult[] = [
      { text: "", errorText: "Codex usage limit reached", dispatched: null },
      { text: "", errorText: "Codex usage limit reached" },
    ];
    for (const result of unknownResults) {
      const { state, transport } = await scopedSession(providersWithThird, [result]);
      expect(transport.calls).toHaveLength(1);
      expect(state.messageDispatched).toBeNull();
      expect(state.roundEvents.map((event) => event.kind)).toEqual(["failed"]);
    }
  });

  it("⑤ REPLACED stops without taking over", async () => {
    const { state, transport } = await scopedSession(providersWithThird, [
      { text: "", errorText: "The coordination request was replaced, so nothing was sent.", dispatched: false },
    ]);

    expect(transport.calls).toHaveLength(1);
    expect(state.stopReason).toMatch(/replaced/);
    expect(state.roundEvents.map((event) => event.kind)).toEqual(["failed"]);
  });

  it("⑥ usage-limit failures take over, with stopCode precedence over provider text", async () => {
    const usageLimit = await scopedSession(providersWithThird, [
      { text: "", errorText: "Codex usage limit reached; resets in 2h.", dispatched: true },
      { text: "Recovered plan.", errorText: "", dispatched: true },
      { text: "Plan accepted.\nVERDICT: carry-out", errorText: "", dispatched: true },
    ]);
    expect(usageLimit.transport.calls).toHaveLength(3);
    expect(usageLimit.state.roundEvents[0]?.sentence).toContain("usage limit reached");

    const stopCodes: Array<{ result: CoordinateLaunchResult; sentence: string }> = [
      {
        result: { text: "", errorText: "Failed to create unified exec process: helper_unknown_error", stopCode: "not-installed", dispatched: false },
        sentence: "Codex is not installed on this machine, so this stopped for it.",
      },
      {
        result: { text: "", errorText: "authentication failed", stopCode: "no-text", dispatched: true },
        sentence: "Codex finished without any text, so this stopped for it.",
      },
      {
        result: { text: "partial output", errorText: "authentication failed", stopCode: "not-finished", dispatched: true },
        sentence: "Codex did not finish its turn, so this stopped for it.",
      },
    ];
    for (const { result, sentence } of stopCodes) {
      const recovery = await scopedSession(providersWithThird, [
        result,
        { text: "Recovered plan.", errorText: "", dispatched: true },
        { text: "Plan accepted.\nVERDICT: carry-out", errorText: "", dispatched: true },
      ]);
      expect(recovery.transport.calls).toHaveLength(3);
      expect(recovery.state.roundEvents[0]?.sentence).toBe(sentence);
      expect(recovery.state.environmentBlocked).toBeNull();
    }
  });

  it("⑦ a generic provider_error and ⑦b an is_error-style reply without stopCode never take over", async () => {
    const failures: CoordinateLaunchResult[] = [
      { text: "", errorText: "The provider returned an unclassified failure.", dispatched: true },
      { text: "", errorText: "", dispatched: true },
    ];
    for (const result of failures) {
      const { state, transport } = await scopedSession(providersWithThird, [result]);
      expect(transport.calls).toHaveLength(1);
      expect(state.verdict).toBe("failed");
      expect(state.roundEvents.map((event) => event.kind)).toEqual(["failed"]);
    }
  });

  it("⑧ scope exhaustion stops with the fixed sentence and view flag", async () => {
    const transport = recordingTransport([{
      text: "",
      errorText: "",
      dispatched: false,
      stopCode: "scope-exhausted",
      scopeExhausted: true,
      turnsRemaining: 0,
    }]);
    const view = await requestCoordination(
      { goal, workspacePath, sendKey: "scope-exhausted", allowedInstances: ["codex", "claude"] },
      { connected: true, sendAuthorized: true, providers, stopReason: null },
      transport,
    );

    expect(transport.calls).toHaveLength(1);
    expect(view.scopeExhausted).toBe(true);
    expect(view.authorizedTurnsLeft).toBe(0);
    expect(view.stopReason).toBe("All authorized model turns were used, so this stopped.");

    const recoveryTransport = recordingTransport([
      { text: "", errorText: "", dispatched: true, environmentBlocked: true, environmentDetail: "helper failure" },
      { text: "", errorText: "", dispatched: false, stopCode: "scope-exhausted", scopeExhausted: true, turnsRemaining: 0 },
    ]);
    const recoveryView = await requestCoordination(
      { goal, workspacePath, sendKey: "scope-exhausted-after-failure", allowedInstances: ["codex", "claude", "grok"] },
      { connected: true, sendAuthorized: true, providers: providersWithThird, stopReason: null },
      recoveryTransport,
    );
    expect(recoveryTransport.calls).toHaveLength(2);
    expect(recoveryView.roundEvents?.map((event) => event.kind)).toEqual(["failed"]);
  });

  it("⑨ pre-checks the complete chain after two planner failures and blocks a third launch", async () => {
    const { state, transport } = await scopedSession(providersWithThird, [
      { text: "", errorText: "", dispatched: true, environmentBlocked: true, environmentDetail: "first helper failure" },
      { text: "", errorText: "", dispatched: true, environmentBlocked: true, environmentDetail: "second helper failure" },
    ]);

    expect(transport.calls).toHaveLength(2);
    expect(state.stopReason).toBe("Stopped. Claude cannot run on this machine right now, and an independent check needs two harnesses that can run.");
  });

  it("⑩ emits ordered live events and persists only bounded completed facts", async () => {
    const events: CoordinateSessionEvent[] = [];
    const detail = "x".repeat(500);
    const { state, transport } = await scopedSession(providersWithThird, [
      { text: "", errorText: "", dispatched: true, environmentBlocked: true, environmentDetail: detail },
      { text: "Recovered plan.", errorText: "", dispatched: true },
      { text: "Plan accepted.\nVERDICT: carry-out", errorText: "", dispatched: true },
    ], (event) => events.push(event));

    expect(events.map((event) => event.kind)).toEqual(["started", "failed", "continued", "started", "continued", "started"]);
    expect(state.roundEvents.map((event) => event.kind)).toEqual(["failed", "continued", "continued"]);
    expect(state.roundEvents[0]).toMatchObject({
      role: "planning",
      instanceId: "codex",
      harness: "Codex",
      sentence: "Codex could not run its tools on this machine, so this stopped for it.",
      detail: "x".repeat(300),
    });
    expect(state.roundEvents[1]).toMatchObject({
      kind: "continued",
      role: "planning",
      instanceId: "claude",
      harness: "Claude",
      sentence: "Claude is planning instead.",
    });
    expect(state.roundEvents[2]).toMatchObject({
      kind: "continued",
      role: "review",
      instanceId: "grok",
      harness: "Grok",
      sentence: "Grok is checking instead.",
    });
    expect(state.roundEvents.length).toBeLessThanOrEqual(transport.calls.length * 2);
    expect(new Set(transport.calls.map((command) => command.modelSelection.instanceId)).size).toBe(transport.calls.length);
  });
});

// All extra-catalog cases are synthetic staffing fixtures, not third-native admission.
describe("explicitly authorized execution and independent audit", () => {
  const catalog = catalogFromProviderSnapshots(providersWithThird);
  const allowedInstances = ["codex", "claude", "grok"];
  const writeAuthorization = { instances: allowedInstances, workspaceRoot: workspacePath, remaining: 1 };
  const input = { catalog, goal, workspacePath, sendKey: "write-send", allowedInstances, writeAuthorization };
  const ok = (text: string, turnsRemaining: number | null = 2, writeTurnsRemaining: number | null = 1): CoordinateLaunchResult => ({
    text, errorText: "", dispatched: true, turnsRemaining, writeTurnsRemaining,
  });
  const planReply = ok("Approved bounded plan with workspace checks", 2);
  const reviewReply = ok("Independent plan accepted\nVERDICT: carry-out", 1);
  const executeReply = ok("Changed file; workspace checks actually ran: test exit 0", 1, 0);
  const auditReply = ok("Independently inspected the workspace\nVERDICT: verified", 0, 0);
  const run = async (results: CoordinateLaunchResult[], overrides: Partial<typeof input> = {}, onEvent?: (event: CoordinateSessionEvent) => void) => {
    const transport = recordingTransport(results);
    const state = await runCoordinateSession({ ...input, ...overrides }, { sendAuthorized: true, onEvent }, transport);
    return { state, transport };
  };
  it("runs scoped A/B/A/B with independent READ/WRITE counters, lazy evidence and typed events", async () => {
    let read = 3;
    let write = 1;
    const events: CoordinateSessionEvent[] = [];
    const transport: CoordinateTransport & { calls: CoordinateTurnCommand[] } = {
      calls: [],
      async launch(command) {
        expect(events.at(-1)?.kind).toBe("started");
        expect(events.at(-1)?.instanceId).toBe(command.modelSelection.instanceId);
        transport.calls.push(command);
        if (command.sandboxPolicy.type === "workspaceWrite") write -= 1;
        else read -= 1;
        const replies = [planReply.text, reviewReply.text, executeReply.text, auditReply.text];
        return ok(replies[transport.calls.length - 1]!, read, write);
      },
    };
    const state = await runCoordinateSession(
      { ...input, catalog: catalog.slice(0, 2), allowedInstances: ["codex", "claude"], writeAuthorization: { ...writeAuthorization, instances: ["codex", "claude"] } },
      { sendAuthorized: true, allowedInstances: ["codex", "claude"], onEvent: (event) => events.push(event) }, transport,
    );
    expect(transport.calls.map((command) => command.modelSelection.instanceId)).toEqual(["codex", "claude", "codex", "claude"]);
    expect(transport.calls.map((command) => command.sandboxPolicy.type)).toEqual(["readOnly", "readOnly", "workspaceWrite", "readOnly"]);
    expect(transport.calls.map((command) => command.commandId.split("-")[1])).toEqual(["plan", "review", "execute", "audit"]);
    expect(new Set(transport.calls.map((command) => command.commandId)).size).toBe(4);
    expect(events.map((event) => `${event.kind}:${event.role}`)).toEqual(["started:planning", "started:review", "started:execution", "started:audit"]);
    expect(state.roundEvents).toEqual([]);
    expect(state.verdict).toBe("verified");
    expect(state.executionHarness).toBe("Codex");
    expect(state.auditHarness).toBe("Claude");
    expect(state.executionText).toBe(executeReply.text);
    expect(state.auditText).toBe(auditReply.text);
    expect(state.authorizedTurnsLeft).toBe(0);
    expect(state.authorizedWriteTurnsLeft).toBe(0);
    expect([read, write]).toEqual([0, 0]);
    const writer = transport.calls[2]!;
    const audit = transport.calls[3]!;
    expect(writer.initialMessage.text).toContain(planReply.text);
    expect(writer.initialMessage.text).toContain(reviewReply.text);
    expect(audit.initialMessage.text).toContain(executeReply.text);
    expect(audit.initialMessage.text).toContain(writer.commandId);
    expect(audit.initialMessage.text).toContain('"instanceId":"codex"');
    expect(audit.initialMessage.text).toContain('"turnsRemaining":1');
    expect(audit.initialMessage.text).toContain('"writeTurnsRemaining":0');
    expect(audit.initialMessage.text).toContain(workspacePath);
  });
  const dispatchProbes = [
    { name: "true", dispatched: true },
    { name: "false", dispatched: false },
    { name: "null", dispatched: null },
    { name: "absent", dispatched: undefined },
  ] as const;
  const writePhases = [
    { role: "planning", index: 0, text: "Partial planning response" },
    { role: "review", index: 1, text: "Partial review evidence\nVERDICT: carry-out" },
    { role: "execution", index: 2, text: "Partial execution report" },
    { role: "audit", index: 3, text: "Partial verification report\nVERDICT: verified" },
  ] as const;
  const phaseBudgets = [
    { turnsRemaining: 2, writeTurnsRemaining: 1 },
    { turnsRemaining: 1, writeTurnsRemaining: 1 },
    { turnsRemaining: 1, writeTurnsRemaining: 0 },
    { turnsRemaining: 0, writeTurnsRemaining: 0 },
  ] as const;
  it.each(writePhases.flatMap((phase) => dispatchProbes.map((probe) => ({ ...phase, ...probe }))))(
    "requires literal dispatch=true for $role output when metadata is $name",
    async ({ role, index, text, dispatched }) => {
      const phaseResults: CoordinateLaunchResult[] = [planReply, reviewReply, executeReply, auditReply];
      const budget = phaseBudgets[index]!;
      const partial: CoordinateLaunchResult = {
        text, errorText: "", ...budget,
        ...(dispatched === undefined ? {} : { dispatched }),
      };
      phaseResults[index] = partial;
      const { state, transport } = await run(phaseResults);

      const successfulChain = dispatched === true;
      expect(transport.calls.map((command) => command.commandId.split("-")[1])).toEqual(
        (successfulChain ? ["plan", "review", "execute", "audit"] : ["plan", "review", "execute", "audit"].slice(0, index + 1)),
      );
      expect(state.planText).toBe(index === 0 ? text : planReply.text);
      expect(state.reviewText).toBe(index === 1 ? text : index > 1 || successfulChain ? reviewReply.text : null);
      expect(state.executionText).toBe(index === 2 ? text : index > 2 || successfulChain ? executeReply.text : null);
      expect(state.auditText).toBe(index === 3 ? text : successfulChain ? auditReply.text : null);
      const finalBudget = successfulChain ? phaseBudgets[3]! : budget;
      expect(state.authorizedTurnsLeft).toBe(finalBudget.turnsRemaining);
      expect(state.authorizedWriteTurnsLeft).toBe(finalBudget.writeTurnsRemaining);
      expect(state.messageDispatched).toBe(successfulChain || index > 0 ? true : dispatched === false ? false : null);

      if (successfulChain) {
        expect(transport.calls).toHaveLength(4);
        expect(state.verdict).toBe("verified");
        expect(state.roundEvents).toEqual([]);
        return;
      }
      expect(transport.calls).toHaveLength(index + 1);
      expect(state.verdict).toBe("failed");
      expect(state.result).toBeNull();
      expect(state.roundEvents.map((event) => `${event.kind}:${event.role}`)).toEqual([`failed:${role}`]);
      expect(state.stopReason).toContain(dispatched === false ? "marked not sent" : "is unknown");
    },
  );
  it("leaves legacy read-only completion behavior unchanged for unknown dispatch metadata", async () => {
    const transport = recordingTransport([
      { text: "Bounded plan.", errorText: "", dispatched: null },
      { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "" },
    ]);
    const state = await runCoordinateSession(
      { catalog, goal, workspacePath, sendKey: "legacy-read" },
      { sendAuthorized: true },
      transport,
    );
    expect(transport.calls).toHaveLength(2);
    expect(state.verdict).toBe("checked");
    expect(state.messageDispatched).toBe(true);
  });
  it.each(["VERDICT: revise", "VERDICT: stop", "VERDICT: verified", "Looks fine."])("does not write without a checked review: %s", async (text) => {
    const { state, transport } = await run([planReply, ok(text)]);
    expect(transport.calls).toHaveLength(2);
    expect(state.executionText).toBeNull();
    expect(state.auditText).toBeNull();
    expect(state.verdict).not.toBe("verified");
    expect(state.authorizedWriteTurnsLeft).toBe(1);
  });
  it("keeps audit carry-out unconfirmed, not checked/verified", async () => {
    const { state, transport } = await run([planReply, reviewReply, executeReply, ok("VERDICT: carry-out", 0, 0)]);
    expect(transport.calls).toHaveLength(4);
    expect(state.verdict).toBe("unconfirmed");
    expect(state.stopReason).toContain("verification did not confirm");
  });
  it.each([0, null, undefined, Number.NaN])("read budget 2 or unknown (%s) runs plan+review then stops before write", async (remaining) => {
    const { state, transport } = await run([ok(planReply.text, 1), { ...reviewReply, turnsRemaining: remaining }]);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls.every((command) => command.sandboxPolicy.type === "readOnly")).toBe(true);
    expect(state.authorizedWriteTurnsLeft).toBe(1);
    expect(state.executionText).toBeNull();
    expect(state.stopReason).toBe("Verification needs one more authorized read turn, so no workspace changes were sent.");
  });
  it.each([0, null, undefined])("refuses unavailable/unknown write budget (%s) without swapping read and write", async (remaining) => {
    const { state, transport } = await run([planReply, { ...reviewReply, writeTurnsRemaining: remaining }]);
    expect(transport.calls).toHaveLength(2);
    expect(state.authorizedTurnsLeft).toBe(1);
    expect(state.authorizedWriteTurnsLeft).toBe(remaining ?? null);
    expect(state.stopReason).toContain("available authorized write turn");
  });
  it("staffs independent audit when write and read memberships differ", async () => {
    const { state, transport } = await run([planReply, reviewReply, executeReply, auditReply], {
      allowedInstances: ["codex", "claude"], writeAuthorization: { ...writeAuthorization, instances: ["grok"] },
    });
    expect(transport.calls.map((command) => command.modelSelection.instanceId)).toEqual(["codex", "claude", "grok", "codex"]);
    expect(state.executionHarness).toBe("Grok");
    expect(state.auditHarness).toBe("Codex");
    expect(state.verdict).toBe("verified");
  });
  it.each(["planning", "review"])("keeps %s failures global while two surviving successes may take later roles", async (role) => {
    const failed: CoordinateLaunchResult = { text: "", errorText: "authentication failed", dispatched: true, turnsRemaining: 5, writeTurnsRemaining: 1 };
    const results = role === "planning" ? [failed, planReply, reviewReply, executeReply, auditReply] : [planReply, failed, reviewReply, executeReply, auditReply];
    const { state, transport } = await run(results);
    const expected = role === "planning" ? ["codex", "claude", "grok", "claude", "grok"] : ["codex", "claude", "grok", "codex", "grok"];
    expect(transport.calls.map((command) => command.modelSelection.instanceId)).toEqual(expected);
    expect(state.verdict).toBe("verified");
    expect(new Set(transport.calls.map((command) => command.commandId)).size).toBe(5);
    const burned = role === "planning" ? "codex" : "claude";
    expect(transport.calls.slice(role === "planning" ? 1 : 2).some((command) => command.modelSelection.instanceId === burned)).toBe(false);
  });
  it("preserves the two-instance planning-failure pre-check: no doomed replacement", async () => {
    const { state, transport } = await run([{ text: "", errorText: "", dispatched: true, environmentBlocked: true, turnsRemaining: 3, writeTurnsRemaining: 1 }], {
      catalog: catalog.slice(0, 2), allowedInstances: ["codex", "claude"],
    });
    expect(transport.calls).toHaveLength(1);
    expect(state.stopReason).toContain("two harnesses that can run");
  });
  it("stops before writing when a failed review leaves no independent auditor", async () => {
    const failed = { text: "", errorText: "authentication failed", dispatched: true, turnsRemaining: 2, writeTurnsRemaining: 1 };
    const { state, transport } = await run([planReply, failed], {
      allowedInstances: ["codex", "claude"], writeAuthorization: { ...writeAuthorization, instances: ["codex"] },
    });
    expect(transport.calls).toHaveLength(2);
    expect(state.authorizedWriteTurnsLeft).toBe(1);
    expect(state.verdict).toBe("failed");
  });
  it("reselects a failed auditor without reusing executor or burned auditor", async () => {
    const events: CoordinateSessionEvent[] = [];
    const { state, transport } = await run([
      planReply, reviewReply, executeReply,
      { text: "Partial audit", errorText: "", environmentBlocked: true, environmentDetail: "helper failure", dispatched: true, turnsRemaining: 1, writeTurnsRemaining: 0 },
      auditReply,
    ], {}, (event) => events.push(event));
    expect(transport.calls.map((command) => command.modelSelection.instanceId)).toEqual(["codex", "claude", "codex", "claude", "grok"]);
    expect(state.environmentBlocked?.role).toBe("audit");
    expect(state.verdict).toBe("verified");
    expect(state.roundEvents.map((event) => `${event.kind}:${event.role}`)).toEqual(["failed:audit", "continued:audit"]);
    expect(events.at(-2)).toMatchObject({ kind: "continued", role: "audit", instanceId: "grok" });
    expect(transport.calls[4]?.initialMessage.text).toContain(executeReply.text);
  });
  it.each([true, false, null, undefined])("never retries any write failure, even known-not-sent: dispatch %s", async (dispatched) => {
    const { state, transport } = await run([planReply, reviewReply, {
      text: "Partial file changes", errorText: "", environmentBlocked: true, environmentDetail: "tool failed", dispatched,
      turnsRemaining: 1, writeTurnsRemaining: 0,
    }]);
    expect(transport.calls).toHaveLength(3);
    expect(state.executionText).toBe("Partial file changes");
    expect(state.auditText).toBeNull();
    expect(state.verdict).toBe("failed");
    expect(state.environmentBlocked?.role).toBe("execution");
    expect(state.roundEvents.map((event) => `${event.kind}:${event.role}`)).toEqual(["failed:execution"]);
    expect(state.stopReason).toContain("not retried");
    expect(state.authorizedTurnsLeft).toBe(1);
    expect(state.authorizedWriteTurnsLeft).toBe(0);
  });
  it.each(["scope-revoked", "scope-exhausted"] as const)("keeps partial write text on terminal %s", async (stopCode) => {
    const { state, transport } = await run([planReply, reviewReply, {
      text: "Partial changes before stop", errorText: "Scope stopped", stopCode, dispatched: null,
      turnsRemaining: null, writeTurnsRemaining: null,
    }]);
    expect(transport.calls).toHaveLength(3);
    expect(state.executionText).toBe("Partial changes before stop");
    expect(state.auditText).toBeNull();
    expect(state.authorizedTurnsLeft).toBeNull();
    expect(state.authorizedWriteTurnsLeft).toBeNull();
  });
  it("converts rejected write transport to terminal unknown without replay or audit", async () => {
    let launches = 0;
    const state = await runCoordinateSession(input, { sendAuthorized: true }, {
      async launch() {
        launches += 1;
        if (launches === 1) return planReply;
        if (launches === 2) return reviewReply;
        throw new Error("transport died");
      },
    });
    expect(launches).toBe(3);
    expect(state.verdict).toBe("failed");
    expect(state.auditText).toBeNull();
    expect(state.stopReason).toContain("dispatch is unknown");
    expect(state.authorizedWriteTurnsLeft).toBeNull();
  });
  it.each(["synchronous", "rejected"])("preserves executor evidence when audit transport is %s unknown", async (mode) => {
    let launches = 0;
    const state = await runCoordinateSession(input, { sendAuthorized: true }, {
      launch() {
        launches += 1;
        const reply = [planReply, reviewReply, executeReply][launches - 1];
        if (reply) return Promise.resolve(reply);
        if (mode === "synchronous") throw new Error("IPC died before returning a promise");
        return Promise.reject(new Error("IPC died mid-turn"));
      },
    });
    expect(launches).toBe(4);
    expect(state.executionText).toBe(executeReply.text);
    expect(state.verdict).toBe("failed");
    expect(state.messageDispatched).toBe(true);
    expect(state.stopReason).toContain("audit transport did not return a result");
    expect(state.roundEvents.map((event) => event.kind)).toEqual(["failed"]);
  });
  it.each(["no-text", "not-finished", "not-installed"] as const)("never recovers a write completion failure %s", async (stopCode) => {
    const { state, transport } = await run([planReply, reviewReply, {
      text: "Partial execution report", errorText: "", dispatched: false, stopCode,
      turnsRemaining: 1, writeTurnsRemaining: 1,
    }]);
    expect(transport.calls).toHaveLength(3);
    expect(state.executionText).toBe("Partial execution report");
    expect(state.verdict).toBe("failed");
    expect(state.auditText).toBeNull();
    expect(state.roundEvents.map((event) => event.kind)).toEqual(["failed"]);
  });
  it("does not assign a burned write-only member to execution during review recovery", async () => {
    const { state, transport } = await run([
      planReply,
      { text: "", errorText: "authentication failed", dispatched: false, turnsRemaining: 3, writeTurnsRemaining: 1 },
    ], { writeAuthorization: { ...writeAuthorization, instances: ["claude"] } });
    expect(transport.calls).toHaveLength(2);
    expect(state.authorizedWriteTurnsLeft).toBe(1);
    expect(state.executionText).toBeNull();
  });
  it("revoked scopes terminate before the writer without recovery", async () => {
    const { state, transport } = await run([planReply, {
      text: "Partial review", errorText: "Scope was revoked", dispatched: false, stopCode: "scope-revoked", turnsRemaining: null, writeTurnsRemaining: null,
    }]);
    expect(transport.calls).toHaveLength(2);
    expect(state.executionText).toBeNull();
    expect(state.verdict).toBe("failed");
    expect(state.authorizedWriteTurnsLeft).toBeNull();
  });
  it.each(["VERDICT: revise", "VERDICT: stop"])("uses the audit-specific terminal line for %s", async (text) => {
    const { state, transport } = await run([planReply, reviewReply, executeReply, ok(text, 0, 0)]);
    expect(transport.calls).toHaveLength(4);
    expect(state.stopReason).toContain("independent verification");
    expect(state.verdict).toBe(text.endsWith("revise") ? "revise" : "stopped");
  });
  it.each([null, undefined])("never recovers unknown read dispatch (%s) in a write-enabled round", async (dispatched) => {
    const { state, transport } = await run([{ text: "", errorText: "authentication failed", dispatched, turnsRemaining: 3, writeTurnsRemaining: 1 }]);
    expect(transport.calls).toHaveLength(1);
    expect(state.messageDispatched).toBeNull();
    expect(state.verdict).toBe("failed");
    expect(state.executionText).toBeNull();
  });
  it("propagates four-role request fields and refuses a new write after replacement without erasing executed evidence", async () => {
    const transport = recordingTransport([planReply, reviewReply, executeReply, auditReply]);
    const view = await requestCoordination(
      { goal, workspacePath, sendKey: input.sendKey, allowedInstances, writeAuthorization },
      { connected: true, sendAuthorized: true, providers: providersWithThird, stopReason: null }, transport,
    );
    expect(transport.calls).toHaveLength(4);
    expect(view.verdict).toBe("verified");
    expect(view.executionText).toBe(executeReply.text);
    expect(view.auditText).toBe(auditReply.text);
    expect(view.executionHarness).toBe("Codex");
    expect(view.auditHarness).toBe("Claude");
    expect(view.authorizedWriteTurnsLeft).toBe(0);

    const replacedTransport = recordingTransport([planReply, reviewReply, executeReply]);
    const replaced = await requestCoordination(
      { goal, workspacePath, sendKey: input.sendKey, allowedInstances, writeAuthorization },
      { connected: true, sendAuthorized: true, providers: providersWithThird, stopReason: null }, replacedTransport,
      () => replacedTransport.calls.length < 3,
    );
    expect(replacedTransport.calls).toHaveLength(3);
    expect(replaced.executionText).toBe(executeReply.text);
    expect(replaced.messageDispatched).toBe(true);
    expect(replaced.verdict).toBe("failed");
    expect(replaced.stopReason).toContain("replaced");
  });
  it("without write consent still stops at checked and omits all new optional result fields", async () => {
    const { writeAuthorization: _write, ...readInput } = input;
    const transport = recordingTransport([planReply, reviewReply]);
    const state = await runCoordinateSession(readInput, { sendAuthorized: true, allowedInstances }, transport);
    expect(transport.calls).toHaveLength(2);
    expect(state.verdict).toBe("checked");
    expect(state.stopReason).toBe("The independent check finished, so this stopped.");
    for (const field of ["executionText", "auditText", "executionHarness", "auditHarness", "authorizedWriteTurnsLeft"]) expect(state).not.toHaveProperty(field);
  });
});

it("a complete authorized engine result round-trips through the actual record store", async () => {
  // Injected transport fixtures only, not real independent model judgment.
  const transport = recordingTransport([
    { text: "Bounded plan.", errorText: "", dispatched: true, turnsRemaining: 5, writeTurnsRemaining: 2 },
    { text: "Checked.\nVERDICT: carry-out", errorText: "", dispatched: true, turnsRemaining: 4, writeTurnsRemaining: 2 },
    { text: "Changed fixture and checked it.", errorText: "", dispatched: true, turnsRemaining: 4, writeTurnsRemaining: 1 },
    { text: "Inspected fixture.\nVERDICT: verified", errorText: "", dispatched: true, turnsRemaining: 3, writeTurnsRemaining: 1 },
  ]);
  const view = await requestCoordination({
    goal, workspacePath, sendKey: "combined-record-integration",
    allowedInstances: ["codex", "claude"],
    writeAuthorization: { instances: ["codex"], workspaceRoot: workspacePath, remaining: 2 },
  }, { connected: true, sendAuthorized: true, providers, stopReason: null }, transport);
  expect(view.verdict).toBe("verified");
  expect(transport.calls).toHaveLength(4);
  const directory = mkdtempSync(join(tmpdir(), "goalport-engine-record-"));
  const { saveRecord, readRecords } = createRequire(import.meta.url)("../../electron/coordination-record.cjs");
  try {
    saveRecord(directory, { ...view, requestId: "combined-record", goal, workspacePath });
    const [record] = readRecords(directory);
    expect(record.verdict).toBe("verified");
    expect(record.executionText).toBe("Changed fixture and checked it.");
    expect(record.auditText).toBe("Inspected fixture.\nVERDICT: verified");
    expect(record.executionHarness).toBe("Codex");
    expect(record.auditHarness).toBe("Claude");
    expect(record.messageDispatched).toBe(true);
    expect(record).not.toHaveProperty("authorizedTurnsLeft");
    expect(record).not.toHaveProperty("authorizedWriteTurnsLeft");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The one in-window corrective pass (C1): request-level boundary tests.
// A completed execution audit ending VERDICT: revise may start exactly one
// repair chain in the same Send; everything else stays terminal.
describe("one in-window corrective pass", () => {
  const repairCatalog = catalogFromProviderSnapshots(providersWithThird);
  const repairAllowed = ["codex", "claude", "grok"];
  const repairWrite = { instances: repairAllowed, workspaceRoot: workspacePath, remaining: 2 };
  const CRITIQUE_TEXT = "The unchanged checks still fail on the negative case.\nVERDICT: revise";
  const VERIFIED_TEXT = "Independently inspected the repaired workspace.\nVERDICT: verified";
  const ok = (text: string, turnsRemaining: number, writeTurnsRemaining: number): CoordinateLaunchResult => ({
    text, errorText: "", dispatched: true, turnsRemaining, writeTurnsRemaining,
  });
  // A healthy first chain that ends in a completed revise verdict.
  const reviseChain = (): CoordinateLaunchResult[] => [
    ok("Bounded plan.", 5, 2),
    ok("The plan can be carried out.\nVERDICT: carry-out", 4, 2),
    ok("First executor report; checks failed honestly.", 4, 1),
    ok(CRITIQUE_TEXT, 3, 1),
  ];
  // A healthy corrective chain.
  const repairChain = (audit: string): CoordinateLaunchResult[] => [
    ok("Corrective plan for the observed failure.", 2, 1),
    ok("The plan can be carried out.\nVERDICT: carry-out", 1, 1),
    ok("Corrective executor report; unchanged checks pass.", 1, 0),
    ok(audit, 0, 0),
  ];
  const request = async (
    results: CoordinateLaunchResult[],
    overrides: {
      beforeRepair?: (checkpoint: import("./requestCoordination").RepairCheckpoint) => Promise<boolean>;
      stillCurrent?: () => boolean;
    } = {},
  ) => {
    const transport = recordingTransport(results);
    const view = await requestCoordination(
      {
        goal, workspacePath, sendKey: "repair-send",
        allowedInstances: repairAllowed, writeAuthorization: repairWrite,
        ...(overrides.beforeRepair === undefined ? {} : { beforeRepair: overrides.beforeRepair }),
      },
      { connected: true, sendAuthorized: true, providers: providersWithThird, stopReason: null },
      transport,
      overrides.stillCurrent,
    );
    return { view, transport };
  };

  it("runs exactly one repair chain after a completed revise, with fresh identities and retained first-round facts", async () => {
    const checkpoints: import("./requestCoordination").RepairCheckpoint[] = [];
    const { view, transport } = await request([...reviseChain(), ...repairChain(VERIFIED_TEXT)], {
      beforeRepair: async (checkpoint) => { checkpoints.push(checkpoint); return true; },
    });
    expect(transport.calls).toHaveLength(8);
    expect(transport.calls.map((command) => command.modelSelection.instanceId)).toEqual([
      "codex", "claude", "codex", "claude", "codex", "claude", "codex", "claude",
    ]);
    // Fresh command identities: the repair-1 suffix keeps every id distinct.
    const ids = transport.calls.map((command) => command.commandId);
    expect(new Set(ids).size).toBe(8);
    // The corrective prompts carry the actual first-round evidence.
    expect(transport.calls[4]?.initialMessage.text).toContain(CRITIQUE_TEXT);
    expect(transport.calls[4]?.initialMessage.text).toContain("Inspect the CURRENT workspace");
    expect(transport.calls[7]?.initialMessage.text).toContain("Corrective executor report; unchanged checks pass.");
    expect(view.verdict).toBe("verified");
    expect(view.executionText).toBe("Corrective executor report; unchanged checks pass.");
    expect(view.auditText).toBe(VERIFIED_TEXT);
    expect(view.messageDispatched).toBe(true);
    expect(view.feedbackHistory).toHaveLength(1);
    expect(view.feedbackHistory?.[0]).toMatchObject({
      verdict: "revise", executionHarness: "Codex", auditHarness: "Claude",
      planText: "Bounded plan.", result: CRITIQUE_TEXT, messageDispatched: true,
    });
    expect(view.feedbackHistory?.[0]?.commandIds).toEqual(ids.slice(0, 4));
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.firstRound.verdict).toBe("revise");
    expect(checkpoints[0]?.remainingReadTurns).toBe(3);
    expect(checkpoints[0]?.remainingWriteTurns).toBe(1);
  });

  it("keeps the corrective pass on the same scope and never a second authorization", async () => {
    const { view, transport } = await request([...reviseChain(), ...repairChain(VERIFIED_TEXT)], {
      beforeRepair: async () => true,
    });
    expect(transport.calls).toHaveLength(8);
    // Every corrective turn is a workspaceWrite only for the writer, and the
    // write authorization object (memberships + root) is carried unchanged.
    expect(transport.calls.slice(4).map((command) => command.sandboxPolicy.type)).toEqual([
      "readOnly", "readOnly", "workspaceWrite", "readOnly",
    ]);
    expect(view.authorizedTurnsLeft).toBe(0);
    expect(view.authorizedWriteTurnsLeft).toBe(0);
  });

  it("a second revise is terminal even though budget remains", async () => {
    const { view, transport } = await request([...reviseChain(), ...repairChain("Still incomplete.\nVERDICT: revise")], {
      beforeRepair: async () => true,
    });
    expect(transport.calls).toHaveLength(8);
    expect(view.verdict).toBe("revise");
    expect(view.stopReason).toContain("independent verification says the changes need revision");
    expect(view.stopReason).toContain("This send already used its one automatic repair.");
    expect(view.feedbackHistory?.[0]?.verdict).toBe("revise");
    expect(view.authorizedTurnsLeft).toBe(0);
  });

  it("a rejected corrective plan stops before a second writer and spends the allowance", async () => {
    const results = [...reviseChain(), ok("Corrective plan.", 2, 1), ok("The corrective plan does not answer the audit.\nVERDICT: revise", 1, 1)];
    const { view, transport } = await request(results, { beforeRepair: async () => true });
    expect(transport.calls).toHaveLength(6);
    expect(transport.calls.slice(4).every((command) => command.sandboxPolicy.type === "readOnly")).toBe(true);
    expect(view.verdict).toBe("revise");
    expect(view.stopReason).toContain("already used its one automatic repair");
    expect(view.authorizedWriteTurnsLeft).toBe(1);
  });

  it("insufficient remaining budget explains the stop and launches no corrective turn", async () => {
    // Four authorized read turns: 3 spent by the first chain, 1 left.
    const tight = [
      ok("Bounded plan.", 3, 2),
      ok("The plan can be carried out.\nVERDICT: carry-out", 2, 2),
      ok("First executor report.", 2, 1),
      ok(CRITIQUE_TEXT, 1, 1),
    ];
    const beforeRepair = vi.fn(async () => true);
    const { view, transport } = await request(tight, { beforeRepair });
    expect(transport.calls).toHaveLength(4);
    expect(view.verdict).toBe("revise");
    expect(view.stopReason).toContain("There is not enough access left for one more checked repair");
    expect(view.stopReason).toContain("GoalPort did not add turns");
    expect(view.messageDispatched).toBe(true);
    expect(view).not.toHaveProperty("feedbackHistory");
    expect(beforeRepair).not.toHaveBeenCalled();
  });

  it("without the adapter gate the send keeps its one-round behavior", async () => {
    const { view, transport } = await request([...reviseChain(), ...repairChain(VERIFIED_TEXT)]);
    expect(transport.calls).toHaveLength(4);
    expect(view.verdict).toBe("revise");
    expect(view.stopReason).toBe("The independent verification says the changes need revision, so this stopped.");
    expect(view).not.toHaveProperty("feedbackHistory");
  });

  it.each([
    ["refused", async () => false],
    ["threw", async () => { throw new Error("checkpoint failed"); }],
  ])("a %s gate keeps the completed first round and its evidence", async (_kind, beforeRepair) => {
    const { view, transport } = await request([...reviseChain(), ...repairChain(VERIFIED_TEXT)], { beforeRepair });
    expect(transport.calls).toHaveLength(4);
    expect(view.verdict).toBe("revise");
    expect(view.stopReason).toContain("could not confirm this window for the automatic repair");
    expect(view.messageDispatched).toBe(true);
    expect(view.planText).toBe("Bounded plan.");
    expect(view.auditText).toBe(CRITIQUE_TEXT);
  });

  it("a proven-not-sent first corrective launch keeps the already-sent goal non-retryable", async () => {
    const { view, transport } = await request([
      ...reviseChain(),
      { text: "", errorText: "The authorized harness scope was revoked, so this stopped.", dispatched: false, stopCode: "scope-revoked" },
    ], { beforeRepair: async () => true });
    expect(transport.calls).toHaveLength(5);
    expect(view.verdict).toBe("failed");
    expect(view.stopReason).toContain("revoked");
    // Send-wide dispatch: the first chain really sent, so this goal is never silently resendable.
    expect(view.messageDispatched).toBe(true);
    expect(view.feedbackHistory?.[0]?.verdict).toBe("revise");
    const directory = mkdtempSync(join(tmpdir(), "goalport-repair-record-"));
    const { saveRecord, readRecords } = createRequire(import.meta.url)("../../electron/coordination-record.cjs");
    try {
      saveRecord(directory, { ...view, requestId: "refused-repair", goal, workspacePath });
      const [record] = readRecords(directory);
      expect(record.verdict).toBe("failed");
      expect(record.messageDispatched).toBe(true);
      expect(record.feedbackHistory?.[0]?.commandIds).toEqual(transport.calls.slice(0, 4).map((command) => command.commandId));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("an unknown corrective launch stays terminal without making the goal retryable", async () => {
    let launches = 0;
    const transport: CoordinateTransport & { calls: CoordinateTurnCommand[] } = {
      calls: [],
      async launch(command) {
        transport.calls.push(command);
        launches += 1;
        if (launches <= 4) return reviseChain()[launches - 1]!;
        throw new Error("IPC died before the corrective turn");
      },
    };
    const view = await requestCoordination(
      { goal, workspacePath, sendKey: "repair-send", allowedInstances: repairAllowed, writeAuthorization: repairWrite, beforeRepair: async () => true },
      { connected: true, sendAuthorized: true, providers: providersWithThird, stopReason: null },
      transport,
    );
    expect(transport.calls).toHaveLength(5);
    expect(view.verdict).toBe("failed");
    expect(view.stopReason).toContain("dispatch is unknown");
    expect(view.messageDispatched).toBe(true);
    expect(view.feedbackHistory?.[0]?.verdict).toBe("revise");
  });

  it("cancellation before the corrective writer keeps the first round sent and its facts", async () => {
    const transport = recordingTransport([...reviseChain(), ...repairChain(VERIFIED_TEXT)]);
    const view = await requestCoordination(
      { goal, workspacePath, sendKey: "repair-send", allowedInstances: repairAllowed, writeAuthorization: repairWrite, beforeRepair: async () => true },
      { connected: true, sendAuthorized: true, providers: providersWithThird, stopReason: null },
      transport,
      () => transport.calls.length < 6,
    );
    // Both corrective read turns ran; the corrective writer was refused as replaced.
    expect(transport.calls).toHaveLength(6);
    expect(view.verdict).toBe("failed");
    expect(view.stopReason).toContain("replaced");
    expect(view.messageDispatched).toBe(true);
    expect(view.reviewText).toBe("The plan can be carried out.\nVERDICT: carry-out");
    expect(view.feedbackHistory?.[0]?.verdict).toBe("revise");
    expect(view.feedbackHistory?.[0]?.auditText).toBe(CRITIQUE_TEXT);
  });

  it("carries burned harnesses into the corrective exclusions", async () => {
    const { view, transport } = await request([
      { text: "", errorText: "This harness cannot run its tools on this machine, so this stopped.", dispatched: true, environmentBlocked: true, environmentDetail: "helper failure", turnsRemaining: 5, writeTurnsRemaining: 2 },
      ok("Recovered plan.", 5, 2),
      ok("The plan can be carried out.\nVERDICT: carry-out", 4, 2),
      ok("First executor report.", 4, 1),
      ok(CRITIQUE_TEXT, 3, 1),
      ...repairChain(VERIFIED_TEXT),
    ], { beforeRepair: async () => true });
    expect(transport.calls).toHaveLength(9);
    // The corrective chain never reuses the burned codex instance.
    expect(transport.calls.slice(5).map((command) => command.modelSelection.instanceId)).not.toContain("codex");
    expect(view.verdict).toBe("verified");
    expect(view.feedbackHistory?.[0]?.roundEvents?.map((event) => `${event.kind}:${event.role}`)).toEqual([
      "failed:planning", "continued:planning", "continued:review",
    ]);
  });

  it("a failed round that merely mentions revision never starts a repair", async () => {
    const { view, transport } = await request([
      ok("Bounded plan.", 5, 2),
      ok("The plan can be carried out.\nVERDICT: carry-out", 4, 2),
      { text: "Partial edit retained; revise or stop.", errorText: "The harness did not finish, so this stopped.", dispatched: true, turnsRemaining: 4, writeTurnsRemaining: 1 },
    ], { beforeRepair: async () => true });
    expect(transport.calls).toHaveLength(3);
    expect(view.verdict).toBe("failed");
    expect(view).not.toHaveProperty("feedbackHistory");
  });
});
