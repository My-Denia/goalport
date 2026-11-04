import { describe, expect, it, vi } from "vitest";
import { compileWorkflow } from "../../electron/workflow-checks.mjs";
import { backgroundEngineInput, backgroundStartRefusal, type BackgroundJobStartInput } from "./backgroundJob";
import { catalogFromProviderSnapshots, type ProviderSnapshot } from "./catalogFromProviders";
import {
  WORKFLOW, coordinateGoal, expectedCommandCount, replacementCommand,
  type CoordinateGoalInput, type SyntheticCatalogInstance,
} from "./coordinateGoal";
import { runCoordinateSession, type CoordinateLaunchResult } from "./coordinateSession";
import { methodLine } from "./methodLine";
import { requestCoordination } from "./requestCoordination";
import { outcomeLabel } from "./verdict";
import { preflightBackgroundContinuation } from "./workerEntry";

const definition = (planReview: "on" | "off", extra: Record<string, unknown> = {}, checks: Record<string, unknown> = {}) => ({
  schema: 1 as const, id: "my-0a1b2c3d", version: 3, name: "Quick plan", parent: "recommended@1", ...extra,
  modules: { checks: { planReview, reviewerNeeds: { readWorkspace: "preferred" }, requirementCitation: "quote-when-reviewer-cannot-read", ...checks } },
});
const reviewOff = definition("off") as never;
const compiledOff = compileWorkflow(reviewOff);

const snapshot = (instanceId: string, displayName: string) => ({
  instanceId, displayName, auth: { status: "authenticated", type: "subscription" }, models: [{ slug: "m", isDefault: true }],
});
const both = [snapshot("codex", "Codex"), snapshot("claude", "Claude")] as unknown as readonly ProviderSnapshot[];
const onlyClaude = [snapshot("claude", "Claude")] as unknown as readonly ProviderSnapshot[];
const discoveryOf = (providers: readonly ProviderSnapshot[]) => ({ connected: true, sendAuthorized: true, stopReason: null, providers });
const base = { workspacePath: "/w", goal: "g", sendKey: "k" };
const write = { instances: ["codex"], workspaceRoot: "/w", remaining: 2 };

function script(reply: (role: string, nth: number) => Partial<CoordinateLaunchResult> = () => ({})) {
  const seen: Record<string, number> = {};
  const roles: string[] = [];
  return {
    roles,
    async launch(command: { commandId: string }): Promise<CoordinateLaunchResult> {
      const role = command.commandId.split("-")[1];
      seen[role] = (seen[role] ?? 0) + 1;
      roles.push(role);
      const verdict = role === "review" ? "\nVERDICT: carry-out" : role === "audit" ? "\nVERDICT: verified" : "";
      return { text: `${role}${verdict}`, errorText: "", dispatched: true, turnsRemaining: 9, writeTurnsRemaining: 2, ...reply(role, seen[role]) };
    },
  };
}

const PLANNED_STOP = "The plan is ready. Independent review did not run, because it is off in Quick plan.";

describe("a review-off definition on a read-only goal", () => {
  const modes = [
    ["the legacy round", { sendAuthorized: true }],
    ["the scoped round", { sendAuthorized: true, allowedInstances: ["claude"] }],
  ] as const;
  for (const [label, options] of modes) {
    it(`sends the planner only through ${label}, with a single usable agent`, async () => {
      const transport = script();
      const sent = await runCoordinateSession(
        { ...base, catalog: catalogFromProviderSnapshots(onlyClaude), workflow: compiledOff }, options, transport);
      expect(transport.roles).toEqual(["plan"]);
      expect(sent.commands).toHaveLength(1);
      expect(sent.commands[0].commandId).toMatch(/^coordinate-plan-/);
      expect(sent.verdict).toBe("planned");
      expect(sent.checksRan ?? []).toEqual([]);
      expect(sent.planText).toBe("plan");
      expect(sent.reviewText).toBeNull();
      expect(sent.reviewHarness).toBeNull();
      expect(sent.roles).toEqual(["planning"]);
      expect(sent.stopReason).toBe(PLANNED_STOP);
      expect(sent.messageDispatched).toBe(true);
      expect(methodLine({ id: "my-0a1b2c3d", version: 3, name: "Quick plan", planReview: "off" }, sent.checksRan ?? []))
        .toBe("Quick plan v3 · Independent review: not run (off in Quick plan)");
    });
  }

  it("hands a failed planner to the next allowed agent in the scoped round and still sends no review", async () => {
    const transport = script((_role, nth) => nth === 1 ? { text: "", errorText: "", stopCode: "not-installed", dispatched: false } : {});
    const sent = await runCoordinateSession(
      { ...base, catalog: catalogFromProviderSnapshots(both), workflow: compiledOff },
      { sendAuthorized: true, allowedInstances: ["codex", "claude"] }, transport);
    expect(transport.roles).toEqual(["plan", "plan"]);
    expect(new Set(sent.commands.map((command) => command.commandId)).size).toBe(2);
    expect(sent.verdict).toBe("planned");
    expect(sent.roundEvents.map((event) => event.kind)).toEqual(["failed", "continued"]);
  });

  it("never resends a planner whose dispatch is unknown", async () => {
    const transport = script(() => ({ text: "", errorText: "The connection closed.", dispatched: null }));
    const sent = await runCoordinateSession(
      { ...base, catalog: catalogFromProviderSnapshots(both), workflow: compiledOff },
      { sendAuthorized: true, allowedInstances: ["codex", "claude"] }, transport);
    expect(transport.roles).toHaveLength(1);
    expect(sent.verdict).toBe("failed");
    expect(sent.messageDispatched).toBeNull();
  });

  it("stops with nothing sent when no agent can run", () => {
    const state = coordinateGoal({ ...base, catalog: [], workflow: compiledOff });
    expect(state.commands).toEqual([]);
    expect(expectedCommandCount({ workflow: compiledOff })).toBe(1);
  });

  it("keeps the review when the goal may change files", async () => {
    const transport = script();
    const view = await requestCoordination(
      { ...base, allowedInstances: ["codex", "claude"], writeAuthorization: write, workflowDefinition: reviewOff },
      discoveryOf(both), transport);
    expect(transport.roles.slice(0, 2)).toEqual(["plan", "review"]);
    expect(view.workflow).toEqual({ id: "my-0a1b2c3d", version: 3, name: "Quick plan", planReview: "on" });
    expect(expectedCommandCount({ workflow: compiledOff, writeAuthorization: write })).toBe(2);
  });

  it("never reaches the plan-revision gate", async () => {
    const beforePlanRevision = vi.fn(async () => true);
    const transport = script();
    const view = await requestCoordination(
      { ...base, allowedInstances: ["claude"], beforePlanRevision, workflowDefinition: reviewOff }, discoveryOf(onlyClaude), transport);
    expect(beforePlanRevision).not.toHaveBeenCalled();
    expect(view.verdict).toBe("planned");
    expect(transport.roles).toEqual(["plan"]);
  });

  it("is labelled as a plan that was not reviewed", () => {
    expect(outcomeLabel("planned")).toBe("Plan ready, not reviewed");
  });
});

describe("the definition chosen at Send drives role and citation choices", () => {
  const grok: SyntheticCatalogInstance = {
    instanceId: "grok", name: "Grok", enabled: true, installed: true, authenticated: true, launchable: true,
    quota: "available", billing: "subscription", defaultModel: "m",
  };
  const claude: SyntheticCatalogInstance = { ...grok, instanceId: "claude", name: "Claude" };
  const input: CoordinateGoalInput = { ...base, catalog: [claude, grok] };

  it("chooseRoles reads the definition: a reviewer who must read files rules out an agent that cannot", () => {
    expect(coordinateGoal(input).commands).toHaveLength(2);
    const strict = compileWorkflow(definition("on", {}, { reviewerNeeds: { readWorkspace: "required" } }) as never);
    expect(coordinateGoal({ ...input, workflow: strict }).commands).toEqual([]);
  });

  it("never replaces a failed reviewer with an agent that cannot read files when reading is required", async () => {
    const codex: SyntheticCatalogInstance = { ...grok, instanceId: "codex", name: "Codex" };
    const strict = compileWorkflow(definition("on", {}, { reviewerNeeds: { readWorkspace: "required" } }) as never);
    const transport = script((role) => role === "review" ? { text: "", errorText: "", stopCode: "no-text" } : {});
    const state = await runCoordinateSession({ ...base, catalog: [codex, claude, grok], workflow: strict }, { sendAuthorized: true, allowedInstances: ["codex", "claude", "grok"] }, transport);
    expect(state.commands.map((c) => c.modelSelection.instanceId)).not.toContain("grok");
    expect(transport.roles).toEqual(["plan", "review"]);
    expect(state.verdict).not.toBe("checked");
  });

  it("replacementCommand words the plan by the definition's citation rule", () => {
    const quoting = replacementCommand("plan", claude, input, "k", "grok");
    expect(quoting.initialMessage.text).toContain("Quoted from");
    const path = compileWorkflow(definition("on", {}, { requirementCitation: "path" }) as never);
    const reading = replacementCommand("plan", claude, { ...input, workflow: path }, "k", "grok");
    expect(reading.initialMessage.text).not.toContain("Quoted from");
    expect(WORKFLOW.checks.requirementCitation).toBe("quote-when-reviewer-cannot-read");
  });
});

describe("what the view records", () => {
  it("stamps the definition it used, and Recommended v1 when none was given", async () => {
    const used = await requestCoordination(
      { ...base, allowedInstances: ["codex", "claude"], workflowDefinition: definition("on") as never }, discoveryOf(both), script());
    expect(used.workflow).toEqual({ id: "my-0a1b2c3d", version: 3, name: "Quick plan", planReview: "on" });
    expect(used.workflowDefinition).toEqual(definition("on"));
    const fallback = await requestCoordination({ ...base, allowedInstances: ["codex", "claude"] }, discoveryOf(both), script());
    expect(fallback.workflow).toEqual({ id: "recommended", version: 1, name: "Recommended workflow", planReview: "on" });
    expect(fallback.workflowDefinition?.id).toBe("recommended");
    const off = await requestCoordination({ ...base, allowedInstances: ["claude"], workflowDefinition: reviewOff }, discoveryOf(onlyClaude), script());
    expect(off.workflow?.planReview).toBe("off");
    expect(off.workflowDefinition).toEqual(definition("off"));
    expect(off.checksRan).toEqual([]);
  });

  it("stops with nothing sent when the definition cannot be read", async () => {
    const transport = { launch: vi.fn(async () => ({ text: "x", errorText: "" })) };
    const view = await requestCoordination(
      { ...base, allowedInstances: ["codex", "claude"], workflowDefinition: { ...definition("on"), schema: 2 } as never },
      discoveryOf(both), transport);
    expect(transport.launch).not.toHaveBeenCalled();
    expect(view.verdict).toBe("stopped");
    expect(view.messageDispatched).toBe(false);
    expect(view.stopReason).toBe("This workflow could not be read, so nothing was sent.");
    expect(view.workflow).toBeUndefined();
  });
});

describe("methodLine names", () => {
  it("uses the name on the record, keeps Recommended's, and guesses nothing for an unnamed unknown id", () => {
    expect(methodLine({ id: "my-1", version: 2, name: "Quick plan", planReview: "on" }, [])).toBe("Quick plan v2 · No check ran");
    expect(methodLine({ id: "recommended", version: 1, planReview: "off" }, [])).toBe("Recommended workflow v1 · Independent review: not run (off in Recommended workflow)");
    expect(methodLine({ id: "my-1", version: 2 }, [])).toBeNull();
  });
});

describe("a background job", () => {
  const start: BackgroundJobStartInput = {
    requestId: "job-1", goal: "g", workspaceRoot: "/w", readInstances: ["claude"], readMaxTurns: 3, backgroundConsent: true,
  };

  it("carries the snapshot into the engine input and omits it otherwise", () => {
    expect(backgroundEngineInput({ ...start, workflowDefinition: reviewOff }).workflowDefinition).toEqual(definition("off"));
    expect("workflowDefinition" in backgroundEngineInput(start)).toBe(false);
  });

  it("refuses a definition that cannot be read", () => {
    expect(backgroundStartRefusal({ ...start, workflowDefinition: reviewOff })).toBeNull();
    expect(backgroundStartRefusal({ ...start, workflowDefinition: { schema: 9 } as never })).toMatch(/workflow could not be read/);
  });

  it("preflights a review-off continuation with one agent", () => {
    expect(() => preflightBackgroundContinuation({ ...start, workflowDefinition: reviewOff }, onlyClaude)).not.toThrow();
    expect(() => preflightBackgroundContinuation(start, onlyClaude)).toThrow();
  });
});
