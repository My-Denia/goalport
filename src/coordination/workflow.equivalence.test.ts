import { describe, expect, it } from "vitest";
import golden from "./__fixtures__/recommended-v1-commands.json";
import { recommendedV1Scenarios } from "./__fixtures__/recommendedV1Scenarios";
import { WORKFLOW } from "./coordinateGoal";
import type { CoordinateLaunchResult } from "./coordinateSession";
import { requestCoordination } from "./requestCoordination";
import type { ProviderSnapshot } from "./catalogFromProviders";

describe("Recommended workflow v1", () => {
  it("compiles to exactly the commands the engine ran before it was a definition", async () => {
    // The JSON was captured on the untouched engine; never regenerate it.
    expect(await recommendedV1Scenarios()).toEqual(golden);
  });

  it("names itself without entering any hashed input", () => {
    expect(WORKFLOW.workflow).toEqual({ id: "recommended", version: 1 });
    expect(JSON.stringify(golden)).not.toContain("recommended");
  });
});

const providers = [
  { instanceId: "codex", displayName: "Codex", auth: { status: "authenticated", type: "subscription" }, models: [{ slug: "default", isDefault: true }] },
  { instanceId: "claude", displayName: "Claude", auth: { status: "authenticated", type: "subscription" }, models: [{ slug: "opus", isDefault: true }] },
] as unknown as readonly ProviderSnapshot[];
const discovery = { connected: true, sendAuthorized: true, stopReason: null, providers };
const write = { instances: ["codex"], workspaceRoot: "/w", remaining: 2 };
const base = { workspacePath: "/w", goal: "g", sendKey: "k", allowedInstances: ["codex", "claude"] };

/** Scripted launches by role; a reply may override the dispatch fact or text. */
function script(reply: (role: string, nth: number) => Partial<CoordinateLaunchResult> & { verdict?: string }) {
  const seen: Record<string, number> = {};
  return {
    async launch(command: { commandId: string }): Promise<CoordinateLaunchResult> {
      const role = command.commandId.split("-")[1];
      seen[role] = (seen[role] ?? 0) + 1;
      const { verdict, ...rest } = reply(role, seen[role]);
      return { text: `${role}\n${verdict ?? ""}`.trim(), errorText: "", dispatched: true, turnsRemaining: 9, writeTurnsRemaining: 2, ...rest };
    },
  };
}
const verdictOf = (role: string, revise = false) =>
  role === "review" ? (revise ? "VERDICT: revise" : "VERDICT: carry-out") : role === "audit" ? (revise ? "VERDICT: revise" : "VERDICT: verified") : undefined;

describe("what actually ran", () => {
  it("records the workflow and only the checks whose reply came back", async () => {
    const view = await requestCoordination(base, discovery, script((role) => ({ verdict: verdictOf(role) })));
    expect(view.workflow).toEqual({ id: "recommended", version: 1 });
    expect(view.checksRan).toEqual([{ kind: "plan-check", harness: "Claude", verdict: "checked" }]);
  });

  it("counts no check when dispatch is unknown, the reply is empty, or review never ran", async () => {
    const unknown = await requestCoordination(base, discovery, script((role) => role === "review" ? { dispatched: null } : { verdict: verdictOf(role) }));
    expect(unknown.checksRan).toEqual([]);
    const empty = await requestCoordination(base, discovery, script((role) => role === "review" ? { text: "" } : {}));
    expect(empty.checksRan).toEqual([]);
    const noService = await requestCoordination(base, null, script(() => ({})));
    expect(noService.workflow).toEqual({ id: "recommended", version: 1 });
    expect(noService.checksRan).toEqual([]);
  });

  it("lists the plan check and the verification of a write chain, and both plan checks of a revision", async () => {
    const chain = await requestCoordination({ ...base, writeAuthorization: write }, discovery, script((role) => ({ verdict: verdictOf(role) })));
    expect(chain.checksRan).toEqual([
      { kind: "plan-check", harness: "Claude", verdict: "checked" },
      { kind: "audit", harness: "Claude", verdict: "verified" },
    ]);
    const revised = await requestCoordination({ ...base, writeAuthorization: write, beforePlanRevision: async () => true }, discovery,
      script((role, nth) => ({ verdict: verdictOf(role, role === "review" && nth === 1) })));
    expect(revised.checksRan?.map((check) => [check.kind, check.verdict])).toEqual([
      ["plan-check", "revise"], ["plan-check", "checked"], ["audit", "verified"],
    ]);
  });
});
