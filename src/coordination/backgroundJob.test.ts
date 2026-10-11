import { describe, expect, it } from "vitest";
import { catalogFromProviderSnapshots, type ProviderSnapshot } from "./catalogFromProviders";
import type { CoordinateTurnCommand } from "./coordinateTurn";
import type { CoordinateLaunchResult, CoordinateTransport } from "./coordinateSession";
import { requestCoordination as requestCoordinationFromWindow } from "./requestCoordination";
import type { RepairCheckpoint } from "./requestCoordination";
import { requestCoordination as requestCoordinationFromWorkerEntry } from "./workerEntry";
import {
  BACKGROUND_REPAIR_REFUSAL_SENTENCE,
  backgroundEngineInput,
  backgroundJobKey,
  backgroundJobSentence,
  backgroundStartRefusal,
  type BackgroundJobPhase,
  type BackgroundJobProjection,
  type BackgroundJobStartInput,
} from "./backgroundJob";
import type { SavedPlan } from "./savedPlan";

const goal = "Explain the failure and leave a bounded plan.";
const workspaceRoot = "/work/selected-goal";

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
    models: [{ slug: "gpt-6-astra", name: "GPT-6-Astra", isDefault: true }],
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
    models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: true }],
    usageLimits: { windows: [{ id: "five_hour", usedPercent: 38 }] },
  },
] as const satisfies readonly ProviderSnapshot[];

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
} as const satisfies ProviderSnapshot;

const providersWithThird: readonly ProviderSnapshot[] = [...providers, thirdProvider];

const readOnlyStart: BackgroundJobStartInput = {
  requestId: "8f0b6a58-1c2d-4e3f-9a4b-5c6d7e8f9a0b",
  goal,
  workspaceRoot,
  readInstances: ["codex", "claude"],
  readMaxTurns: 4,
  backgroundConsent: true,
};

const writeStart: BackgroundJobStartInput = {
  ...readOnlyStart,
  requestId: "8f0b6a58-1c2d-4e3f-9a4b-5c6d7e8f9a0c",
  readInstances: ["codex", "claude", "grok"],
  readMaxTurns: 6,
  write: { instances: ["codex", "claude", "grok"], workspaceRoot, maxTurns: 2 },
};

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

const ok = (text: string, turnsRemaining: number, writeTurnsRemaining: number): CoordinateLaunchResult => ({
  text, errorText: "", dispatched: true, turnsRemaining, writeTurnsRemaining,
});
const CRITIQUE_TEXT = "The unchanged checks still fail on the negative case.\nVERDICT: revise";
const VERIFIED_TEXT = "Independently inspected the repaired workspace.\nVERDICT: verified";
const reviseChain = (): CoordinateLaunchResult[] => [
  ok("Bounded plan.", 5, 2),
  ok("The plan can be carried out.\nVERDICT: carry-out", 4, 2),
  ok("First executor report; checks failed honestly.", 4, 1),
  ok(CRITIQUE_TEXT, 3, 1),
];
const repairChain = (audit: string): CoordinateLaunchResult[] => [
  ok("Corrective plan for the observed failure.", 2, 1),
  ok("The plan can be carried out.\nVERDICT: carry-out", 1, 1),
  ok("Corrective executor report; unchanged checks pass.", 1, 0),
  ok(audit, 0, 0),
];

describe("background job contract", () => {
  it("the worker entry exports the same engine implementation, not a copied role scheduler", () => {
    expect(typeof requestCoordinationFromWorkerEntry).toBe("function");
    expect(requestCoordinationFromWorkerEntry).toBe(requestCoordinationFromWindow);
  });

  it("a full checked round through the worker entry behaves like the window engine", async () => {
    // Read members are a closed list, so the adapter always passes
    // allowedInstances and the job runs the scoped round with literal
    // dispatch tracking: fixtures must prove dispatched: true.
    const first = recordingTransport([
      { text: "Bounded plan.", errorText: "", dispatched: true },
      { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "", dispatched: true },
    ]);
    const view = await requestCoordinationFromWorkerEntry(
      backgroundEngineInput(readOnlyStart),
      { connected: true, sendAuthorized: true, providers, stopReason: null },
      first,
    );
    expect(first.calls).toHaveLength(2);
    expect(view.verdict).toBe("checked");
    expect(view.messageDispatched).toBe(true);
    expect(view.planText).toBe("Bounded plan.");
    // Read-only admission without a write block: no execution surface exists.
    expect(view).not.toHaveProperty("executionText");
    expect(view).not.toHaveProperty("auditText");

    // The send key derives from the request id, so a second identical job
    // derives identical command identities; history length plays no part.
    const second = recordingTransport([
      { text: "Bounded plan.", errorText: "", dispatched: true },
      { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "", dispatched: true },
    ]);
    await requestCoordinationFromWorkerEntry(
      backgroundEngineInput(readOnlyStart),
      { connected: true, sendAuthorized: true, providers, stopReason: null },
      second,
    );
    expect(second.calls.map((command) => command.commandId)).toEqual(first.calls.map((command) => command.commandId));
  });

  it("derives one stable identity from the request id, never from history length", () => {
    expect(backgroundJobKey(readOnlyStart.requestId)).toBe(`background-job:${readOnlyStart.requestId}`);
    expect(backgroundJobKey(readOnlyStart.requestId)).toBe(backgroundJobKey(readOnlyStart.requestId));
    expect(backgroundJobKey(readOnlyStart.requestId)).not.toBe(backgroundJobKey(writeStart.requestId));
    const engineInput = backgroundEngineInput(readOnlyStart);
    expect(engineInput.sendKey).toBe(backgroundJobKey(readOnlyStart.requestId));
    expect(engineInput.sendKey).not.toMatch(/^send-/);
  });

  it("accepts well-formed read-only and write starts at the runtime boundary", () => {
    expect(backgroundStartRefusal(readOnlyStart)).toBeNull();
    expect(backgroundStartRefusal(writeStart)).toBeNull();
  });

  it.each([
    ["request id", "request id", { ...readOnlyStart, requestId: "" }],
    ["request id", "request id", { ...readOnlyStart, requestId: "../escape" }],
    ["request id", "request id", { ...readOnlyStart, requestId: "has spaces" }],
    ["goal", "goal text", { ...readOnlyStart, goal: "   " }],
    ["workspace root", "workspace root", { ...readOnlyStart, workspaceRoot: "work/relative" }],
    ["read members", "read harness member", { ...readOnlyStart, readInstances: [] }],
    ["read members", "read harness member", { ...readOnlyStart, readInstances: ["codex", "codex"] }],
    ["read members", "read harness member", { ...readOnlyStart, readInstances: ["codex", 7 as unknown as string] }],
    ["read cap", "read turn cap", { ...readOnlyStart, readMaxTurns: 0 }],
    ["read cap", "read turn cap", { ...readOnlyStart, readMaxTurns: 2.5 }],
    ["background consent", "keep-working-after-closing", { ...readOnlyStart, backgroundConsent: false as unknown as true }],
    ["background consent", "keep-working-after-closing", { ...readOnlyStart, backgroundConsent: undefined as unknown as true }],
  ])("refuses a malformed %s before anything is admitted", (_field, expectedInSentence, start) => {
    const refusal = backgroundStartRefusal(start as BackgroundJobStartInput);
    expect(refusal).toContain(expectedInSentence);
    expect(refusal).toContain("nothing was admitted");
  });

  it.each([
    ["write members", { ...writeStart, write: { instances: [] as readonly string[], workspaceRoot, maxTurns: 2 } }],
    ["write members", { ...writeStart, write: { instances: ["codex", "codex"], workspaceRoot, maxTurns: 2 } }],
    ["write root", { ...writeStart, write: { instances: ["codex"], workspaceRoot: "relative/root", maxTurns: 2 } }],
    ["write cap", { ...writeStart, write: { instances: ["codex"], workspaceRoot, maxTurns: 0 } }],
  ])("refuses malformed %s instead of silently dropping the write block", (_field, start) => {
    const refusal = backgroundStartRefusal(start as BackgroundJobStartInput);
    expect(refusal).toContain("nothing was admitted");
  });

  it("refuses duplicated avoidance entries", () => {
    expect(backgroundStartRefusal({ ...readOnlyStart, avoidInstances: ["codex", "codex"] })).toContain("duplicate");
  });

  it("background consent without a write block never maps to a write authorization", () => {
    const engineInput = backgroundEngineInput(readOnlyStart);
    expect("writeAuthorization" in engineInput).toBe(false);
    expect(engineInput.repairRefusalSentence).toBe(BACKGROUND_REPAIR_REFUSAL_SENTENCE);
    expect(engineInput.repairRefusalSentence).toContain("background job");
    expect(engineInput.repairRefusalSentence).not.toContain("this window");
  });

  it("maps the separate write consent onto the engine as an admission-time seed only", () => {
    const engineInput = backgroundEngineInput(writeStart);
    expect(engineInput.writeAuthorization).toEqual({
      instances: ["codex", "claude", "grok"],
      workspaceRoot,
      remaining: 2,
    });
    // Copies, not live references: later mutation of the admission record
    // cannot reach the engine input.
    expect(engineInput.writeAuthorization?.instances).not.toBe(writeStart.write?.instances);
    expect(engineInput.allowedInstances).not.toBe(writeStart.readInstances);
  });

  it("carries revision and avoidance context into the engine input", () => {
    const engineInput = backgroundEngineInput({
      ...writeStart,
      priorPlan: "Old plan.",
      priorReview: "Old check.",
      avoidInstances: ["grok"],
    });
    expect(engineInput.priorPlan).toBe("Old plan.");
    expect(engineInput.priorReview).toBe("Old check.");
    expect(engineInput.avoidInstances).toEqual(["grok"]);
  });

  it("leaves progress callbacks and liveness to the worker, never the admission record", () => {
    const engineInput = backgroundEngineInput(writeStart);
    expect("onEvent" in engineInput).toBe(false);
    expect("beforeRepair" in engineInput).toBe(false);
  });

  it("uses the background repair-refusal wording when the adapter gate refuses", async () => {
    const transport = recordingTransport(reviseChain());
    const view = await requestCoordinationFromWorkerEntry(
      { ...backgroundEngineInput(writeStart), beforeRepair: async () => false },
      { connected: true, sendAuthorized: true, providers: providersWithThird, stopReason: null },
      transport,
    );
    expect(transport.calls).toHaveLength(4);
    expect(view.verdict).toBe("revise");
    expect(view.stopReason).toContain(BACKGROUND_REPAIR_REFUSAL_SENTENCE);
    expect(view.stopReason).not.toContain("this window");
  });

  it("keeps the window-only repair wording the default when no adapter sentence is supplied", async () => {
    const transport = recordingTransport(reviseChain());
    const view = await requestCoordinationFromWindow(
      {
        goal, workspacePath: workspaceRoot, sendKey: "repair-send",
        allowedInstances: ["codex", "claude", "grok"],
        writeAuthorization: { instances: ["codex", "claude", "grok"], workspaceRoot, remaining: 2 },
        beforeRepair: async () => false,
      },
      { connected: true, sendAuthorized: true, providers: providersWithThird, stopReason: null },
      transport,
    );
    expect(transport.calls).toHaveLength(4);
    expect(view.stopReason).toContain("could not confirm this window for the automatic repair");
    expect(view.stopReason).not.toContain(BACKGROUND_REPAIR_REFUSAL_SENTENCE);
  });

  it("runs the same one-repair boundary and ceilings through the background adapter", async () => {
    const transport = recordingTransport([...reviseChain(), ...repairChain(VERIFIED_TEXT)]);
    const checkpoints: RepairCheckpoint[] = [];
    const view = await requestCoordinationFromWorkerEntry(
      {
        ...backgroundEngineInput(writeStart),
        beforeRepair: async (checkpoint) => {
          checkpoints.push(checkpoint);
          return true;
        },
      },
      { connected: true, sendAuthorized: true, providers: providersWithThird, stopReason: null },
      transport,
    );
    expect(transport.calls).toHaveLength(8);
    expect(view.verdict).toBe("verified");
    expect(view.feedbackHistory).toHaveLength(1);
    expect(view.feedbackHistory?.[0]?.verdict).toBe("revise");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.remainingReadTurns).toBe(3);
    expect(checkpoints[0]?.remainingWriteTurns).toBe(1);
  });

  it("a second revise stays terminal with the unchanged ceiling sentence", async () => {
    const transport = recordingTransport([...reviseChain(), ...repairChain("Still incomplete.\nVERDICT: revise")]);
    const view = await requestCoordinationFromWorkerEntry(
      { ...backgroundEngineInput(writeStart), beforeRepair: async () => true },
      { connected: true, sendAuthorized: true, providers: providersWithThird, stopReason: null },
      transport,
    );
    expect(transport.calls).toHaveLength(8);
    expect(view.verdict).toBe("revise");
    expect(view.stopReason).toContain("This send already used its one automatic repair.");
    expect(view.stopReason).not.toContain(BACKGROUND_REPAIR_REFUSAL_SENTENCE);
  });
});

describe("background job projections", () => {
  it("gives one honest sentence per phase, with no promised restart and no quiescence claim", () => {
    const phases: readonly BackgroundJobPhase[] = ["admitted", "running", "stopping", "completed", "unconfirmed"];
    for (const phase of phases) {
      expect(backgroundJobSentence(phase).length).toBeGreaterThan(0);
    }
    expect(backgroundJobSentence("unconfirmed")).toMatch(/cannot confirm/);
    expect(backgroundJobSentence("unconfirmed")).toMatch(/will not retry/);
    expect(backgroundJobSentence("stopping")).toMatch(/current turn may finish/);
    expect(backgroundJobSentence("stopping")).not.toMatch(/undo|quiesc|stopped all tools/i);
  });

  it("keeps job state its own type, separate from SavedPlan and CoordinationView authority", () => {
    const projection: BackgroundJobProjection = {
      requestId: readOnlyStart.requestId,
      jobKey: backgroundJobKey(readOnlyStart.requestId),
      phase: "running",
      sentence: backgroundJobSentence("running"),
      goal,
    };
    // Compile-time guard: if the projection surface is ever grafted onto the
    // saved-plan authority (or vice versa), these assignments start to type
    // check and the tests fail to compile.
    // @ts-expect-error a job projection must never become SavedPlan authority
    const asPlan: SavedPlan = projection;
    // @ts-expect-error a job projection must never become CoordinationView authority
    const asView: import("./requestCoordination").CoordinationView = projection;
    void asPlan;
    void asView;
    // Runtime surface: identity, phase and display facts only. No memberships,
    // scopes, grants or live controls.
    expect(Object.keys(projection).sort()).toEqual(["goal", "jobKey", "phase", "requestId", "sentence"]);
    expect(projection.sentence).toBe(backgroundJobSentence("running"));
    const observing: BackgroundJobProjection = {
      ...projection,
      observed: { readTurnsLeft: 3, writeTurnsLeft: null },
    };
    expect(observing.observed?.readTurnsLeft).toBe(3);
    expect(observing.observed?.writeTurnsLeft).toBeNull();
  });
});
