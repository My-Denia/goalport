import { describe, expect, it } from "vitest";
import { DEFAULT_RESOURCES, RECOMMENDED_V1, compileWorkflow, type WorkflowDefinition } from "../../electron/workflow-checks.mjs";
import { catalogFromProviderSnapshots, type ProviderSnapshot } from "./catalogFromProviders";
import {
  WORKFLOW, coordinateGoal, evidenceCommand, replacementCommand,
  type CoordinateGoalInput, type SyntheticCatalogInstance,
} from "./coordinateGoal";
import { runCoordinateSession, type CoordinateLaunchResult } from "./coordinateSession";
import type { CoordinateTurnCommand } from "./coordinateTurn";
import { resourcesLine, type TurnRan } from "./methodLine";
import { requestCoordination } from "./requestCoordination";

const workspace = "/work/goal";
const goal = "Fix it.";
type Preference = "default" | "faster" | "stronger";
const definition = (roles: Partial<Record<"plan" | "review" | "execute" | "audit", Preference>> = {}, withResources = true): WorkflowDefinition => ({
  schema: 1, id: "my-0a1b2c3d", version: 2, name: "Mine", parent: "recommended@1",
  modules: {
    checks: RECOMMENDED_V1.modules.checks,
    ...(withResources ? { resources: { roles: { ...DEFAULT_RESOURCES.roles, ...roles }, budget: { readTurns: 4, writeTurns: 2 } } } : {}),
  },
});
const compiled = (roles: Parameters<typeof definition>[0] = {}) => compileWorkflow(definition(roles));

const codex: SyntheticCatalogInstance = { instanceId: "codex", name: "Codex", billing: "subscription", models: ["default"] };
const claude: SyntheticCatalogInstance = { instanceId: "claude", name: "Claude", billing: "subscription", models: ["opus", "sonnet"] };
const claudeOpusOnly: SyntheticCatalogInstance = { ...claude, models: ["opus"] };
const claudeSonnetGated: SyntheticCatalogInstance = { ...claude, overageWindowIds: ["seven_day_sonnet"] };
const pi: SyntheticCatalogInstance = { instanceId: "pi", name: "Pi", billing: "subscription", models: ["default"] };
const write = { instances: ["codex"], workspaceRoot: workspace, remaining: 2 };
const input = (catalog: SyntheticCatalogInstance[], roles: Parameters<typeof definition>[0] = {}): CoordinateGoalInput =>
  ({ catalog, goal, workspacePath: workspace, sendKey: "k", allowedInstances: catalog.map((c) => c.instanceId), workflow: compiled(roles) });
const selectionOf = (command: CoordinateTurnCommand) => command.modelSelection as Record<string, unknown>;

describe("the resources module compiles", () => {
  it("defaults a definition without it, so saved workflows keep today's commands", () => {
    expect(compileWorkflow(definition({}, false)).resources).toEqual(DEFAULT_RESOURCES);
    expect(WORKFLOW.resources).toEqual(DEFAULT_RESOURCES);
    expect(Object.isFrozen(DEFAULT_RESOURCES)).toBe(true);
    const commands = coordinateGoal({ ...input([codex, claude]), workflow: compileWorkflow(definition({}, false)) }).commands;
    expect(commands.map((c) => Object.keys(c.modelSelection))).toEqual([["instanceId", "model"], ["instanceId", "model"]]);
  });
  it("rejects anything outside the closed shape", () => {
    const bad = (resources: unknown) => () => compileWorkflow({ ...definition(), modules: { checks: RECOMMENDED_V1.modules.checks, resources } } as never);
    const ok = { roles: DEFAULT_RESOURCES.roles, budget: DEFAULT_RESOURCES.budget };
    expect(bad(ok)).not.toThrow();
    expect(bad({ ...ok, roles: { ...ok.roles, plan: "turbo" } })).toThrow("Unsupported workflow definition.");
    expect(bad({ ...ok, roles: { ...ok.roles, extra: "faster" } })).toThrow();
    expect(bad({ ...ok, roles: { plan: "faster", review: "faster", execute: "faster" } })).toThrow();
    expect(bad({ ...ok, extra: 1 })).toThrow();
    for (const readTurns of [1, 33, 2.5, "4", null]) expect(bad({ ...ok, budget: { ...ok.budget, readTurns } })).toThrow();
    for (const writeTurns of [0, 9, 1.5, "2"]) expect(bad({ ...ok, budget: { ...ok.budget, writeTurns } })).toThrow();
    expect(bad({ ...ok, budget: { readTurns: 32, writeTurns: 8 } })).not.toThrow();
    expect(bad({ ...ok, budget: { readTurns: 2, writeTurns: 1 } })).not.toThrow();
  });
});

describe("each role's preference reaches its command", () => {
  const read = (roles: Parameters<typeof definition>[0], catalog = [codex, claude]) => coordinateGoal(input(catalog, roles)).commands;

  it("codex moves effort only and keeps its model, whichever role it holds", () => {
    const [plan, review] = read({ plan: "faster", review: "stronger" }, [claude, codex]);
    // claude is the planner here (first harness that reads), codex the reviewer.
    expect(selectionOf(plan)).toEqual({ instanceId: "claude", model: "sonnet", effort: "faster" });
    expect(selectionOf(review)).toEqual({ instanceId: "codex", model: "default", effort: "stronger" });
  });
  it("claude swaps the model: faster is sonnet, stronger is opus", () => {
    const [plan, review] = read({ plan: "stronger", review: "faster" });
    expect(selectionOf(plan)).toEqual({ instanceId: "codex", model: "default", effort: "stronger" });
    expect(selectionOf(review)).toEqual({ instanceId: "claude", model: "sonnet", effort: "faster" });
    const [, stronger] = read({ review: "stronger" });
    expect(selectionOf(stronger)).toEqual({ instanceId: "claude", model: "opus", effort: "stronger" });
  });
  it("a default role leaves the command exactly as today, with no effort key", () => {
    for (const command of read({ plan: "faster" })) {
      if (command.commandId.startsWith("coordinate-review-")) expect(command.modelSelection).toEqual({ instanceId: "claude", model: "opus" });
    }
    const [, review] = read({ plan: "faster" });
    expect("effort" in review.modelSelection).toBe(false);
  });
  it("execute and audit take their own role's preference", () => {
    const withWrite = { ...input([codex, claude], { execute: "faster", audit: "stronger" }), writeAuthorization: write };
    const execute = evidenceCommand("execute", codex, withWrite, { planText: "Plan", reviewText: "VERDICT: carry-out" });
    const audit = evidenceCommand("audit", claude, withWrite, { planText: "Plan", reviewText: "VERDICT: carry-out", executionText: "Report" });
    expect(selectionOf(execute)).toEqual({ instanceId: "codex", model: "default", effort: "faster" });
    expect(selectionOf(audit)).toEqual({ instanceId: "claude", model: "opus", effort: "stronger" });
  });
  it("a replacement uses the role's preference with the snapshot's definition", () => {
    const base = input([codex, claude, pi], { plan: "stronger", review: "faster" });
    expect(selectionOf(replacementCommand("review", pi, base, "r1"))).toEqual({ instanceId: "pi", model: "default", effort: "faster" });
    expect(selectionOf(replacementCommand("plan", pi, base, "r2"))).toEqual({ instanceId: "pi", model: "default", effort: "stronger" });
    expect(selectionOf(replacementCommand("review", claude, base, "r3"))).toEqual({ instanceId: "claude", model: "sonnet", effort: "faster" });
  });
  it("a claude swap that cannot happen leaves the command unchanged", () => {
    for (const unavailable of [claudeOpusOnly, claudeSonnetGated]) {
      const command = replacementCommand("review", unavailable, input([codex, unavailable], { review: "faster" }), "r1");
      expect(command.modelSelection).toEqual({ instanceId: "claude", model: "opus" });
      expect("effort" in command.modelSelection).toBe(false);
    }
  });
});

const snapshots = (...ids: string[]) => ids.map((id) => ({
  instanceId: id, displayName: id[0].toUpperCase() + id.slice(1), auth: { status: "authenticated", type: "subscription" },
  models: id === "claude" ? [{ slug: "opus", isDefault: true }, { slug: "sonnet" }] : [{ slug: "m", isDefault: true }],
})) as unknown as readonly ProviderSnapshot[];
const ready = (providers: readonly ProviderSnapshot[]) => ({ connected: true, sendAuthorized: true, stopReason: null, providers });
const reply = (role: string): CoordinateLaunchResult => ({
  text: `${role}${role === "review" ? "\nVERDICT: carry-out" : ""}`, errorText: "", dispatched: true, turnsRemaining: 9, writeTurnsRemaining: 2,
});

describe("what actually ran is recorded", () => {
  it("records every dispatched turn from the command that launched", async () => {
    const view = await requestCoordination(
      { workspacePath: workspace, goal, sendKey: "k", allowedInstances: ["codex", "claude"], workflowDefinition: definition({ plan: "faster", review: "stronger" }) },
      ready(snapshots("codex", "claude")),
      { async launch(command) { return reply(command.commandId.split("-")[1]); } },
    );
    expect(view.turnsRan).toEqual([
      { role: "plan", harness: "codex", model: null, effort: "low", preference: "faster", applied: true },
      { role: "review", harness: "claude", model: "opus", effort: "high", preference: "stronger", applied: true },
    ]);
    expect(view.workflowDefinition).toEqual(definition({ plan: "faster", review: "stronger" }));
  });

  it("a Recommended send records default turns and shows no resources line", async () => {
    const view = await requestCoordination(
      { workspacePath: workspace, goal, sendKey: "k", allowedInstances: ["codex", "claude"] },
      ready(snapshots("codex", "claude")),
      { async launch(command) { return reply(command.commandId.split("-")[1]); } },
    );
    expect(view.turnsRan).toEqual([
      { role: "plan", harness: "codex", model: null, effort: null, preference: "default", applied: false },
      { role: "review", harness: "claude", model: "opus", effort: null, preference: "default", applied: false },
    ]);
    expect(resourcesLine(view.turnsRan)).toBeNull();
  });

  it("claude faster records the model it passed and no effort", async () => {
    const view = await requestCoordination(
      { workspacePath: workspace, goal, sendKey: "k", allowedInstances: ["codex", "claude"], workflowDefinition: definition({ review: "faster" }) },
      ready(snapshots("codex", "claude")),
      { async launch(command) { return reply(command.commandId.split("-")[1]); } },
    );
    expect(view.turnsRan?.[1]).toEqual({ role: "review", harness: "claude", model: "sonnet", effort: null, preference: "faster", applied: true });
    expect(resourcesLine(view.turnsRan)).toBe("Plan: Codex (its own setting) · Check: Claude sonnet (faster)");
  });

  it("an unavailable swap runs unchanged and says so", async () => {
    const opusOnly = snapshots("codex", "claude").map((p) => p.instanceId === "claude" ? { ...p, models: [{ slug: "opus", isDefault: true }] } : p) as unknown as readonly ProviderSnapshot[];
    const view = await requestCoordination(
      { workspacePath: workspace, goal, sendKey: "k", allowedInstances: ["codex", "claude"], workflowDefinition: definition({ review: "faster" }) },
      ready(opusOnly),
      { async launch(command) { return reply(command.commandId.split("-")[1]); } },
    );
    expect(view.turnsRan?.[1]).toEqual({ role: "review", harness: "claude", model: "opus", effort: null, preference: "faster", applied: false });
    expect(resourcesLine(view.turnsRan)).toBe("Plan: Codex (its own setting) · Check: Claude opus (no change)");
  });

  it("a recovered reviewer keeps the review role's preference from the snapshot, and only dispatched turns are recorded", async () => {
    const seen: CoordinateTurnCommand[] = [];
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(snapshots("codex", "claude", "pi")), goal, workspacePath: workspace, sendKey: "k", allowedInstances: ["codex", "claude", "pi"], workflow: compiled({ review: "faster" }) },
      { sendAuthorized: true, allowedInstances: ["codex", "claude", "pi"] },
      {
        async launch(command) {
          seen.push(command);
          const role = command.commandId.split("-")[1];
          if (role === "review" && command.modelSelection.instanceId === "claude") {
            return { text: "", errorText: "not installed", dispatched: false, stopCode: "not-installed", turnsRemaining: 9 };
          }
          return reply(role);
        },
      },
    );
    const reviews = seen.filter((c) => c.commandId.startsWith("coordinate-review-"));
    expect(reviews.map((c) => c.modelSelection)).toEqual([
      { instanceId: "claude", model: "sonnet", effort: "faster" },
      { instanceId: "pi", model: "m", effort: "faster" },
    ]);
    expect(state.turnsRan).toEqual([
      { role: "plan", harness: "codex", model: null, effort: null, preference: "default", applied: false },
      { role: "review", harness: "pi", model: null, effort: "low", preference: "faster", applied: true },
    ]);
    expect(resourcesLine(state.turnsRan)).toBe("Plan: Codex (its own setting) · Check: Pi, low thinking (faster)");
  });

  it("the legacy two-turn round records its turns too", async () => {
    const state = await runCoordinateSession(
      { catalog: catalogFromProviderSnapshots(snapshots("codex", "claude")), goal, workspacePath: workspace, sendKey: "k", workflow: compiled({ plan: "stronger" }) },
      { sendAuthorized: true },
      { async launch(command) { return reply(command.commandId.split("-")[1]); } },
    );
    expect(state.turnsRan?.map((t) => [t.role, t.harness, t.effort, t.applied])).toEqual([["plan", "codex", "high", true], ["review", "claude", null, false]]);
  });
});

describe("resourcesLine", () => {
  const turn = (over: Partial<TurnRan>): TurnRan => ({ role: "plan", harness: "codex", model: null, effort: null, preference: "default", applied: false, ...over });
  it("is null with nothing recorded or nothing changed", () => {
    expect(resourcesLine(undefined)).toBeNull();
    expect(resourcesLine(null)).toBeNull();
    expect(resourcesLine([])).toBeNull();
    expect(resourcesLine([turn({}), turn({ role: "review", harness: "claude", model: "opus" })])).toBeNull();
  });
  it("words applied changes from the recorded values, in role order", () => {
    expect(resourcesLine([
      turn({ role: "audit", harness: "claude", model: "opus", effort: "high", preference: "stronger", applied: true }),
      turn({ role: "execute", effort: "low", preference: "faster", applied: true }),
      turn({ role: "review", harness: "claude", model: "sonnet", preference: "faster", applied: true }),
      turn({ role: "plan", harness: "pi", effort: "high", preference: "stronger", applied: true }),
    ])).toBe("Plan: Pi, high thinking (stronger) · Check: Claude sonnet (faster) · Changes: Codex, low effort (faster) · Verification: Claude opus, high effort (stronger)");
  });
  it("the last launch for a role wins and never claims an unapplied change", () => {
    expect(resourcesLine([
      turn({ harness: "claude", model: "sonnet", preference: "faster", applied: true }),
      turn({ harness: "claude", model: null, preference: "faster", applied: false }),
      turn({ role: "review", harness: "claude", model: "opus", preference: "stronger", applied: false }),
    ])).toBe("Plan: Claude (no change with an API key) · Check: Claude opus (no change)");
    expect(resourcesLine([turn({ harness: "pi", model: "alpha" }), turn({ role: "review", preference: "faster", effort: "low", applied: true })]))
      .toBe("Plan: Pi alpha · Check: Codex, low effort (faster)");
  });
  it("uses no internal words", () => {
    const line = resourcesLine([turn({ preference: "faster", effort: "low", applied: true })])!;
    expect(line).not.toMatch(/attempt|epoch|turn|command/i);
  });
});
