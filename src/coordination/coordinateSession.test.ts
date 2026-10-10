import { describe, expect, it } from "vitest";
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
