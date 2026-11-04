import { describe, expect, it, vi } from "vitest";
import type { ProviderSnapshot } from "./catalogFromProviders";
import type { CoordinateLaunchResult } from "./coordinateSession";
import { requestCoordination } from "./requestCoordination";

const snapshot = (instanceId: string) => ({
  instanceId, auth: { status: "authenticated", type: "subscription" }, models: [{ slug: "m", isDefault: true }],
});
const providers = [snapshot("codex"), snapshot("claude")] as unknown as readonly ProviderSnapshot[];
const discovery = { connected: true, sendAuthorized: true, stopReason: null, providers };
const base = { workspacePath: "/w", goal: "g", sendKey: "k", allowedInstances: ["codex", "claude"] };
const write = { instances: ["codex"], workspaceRoot: "/w", remaining: 2 };
const definition = (feedback: Record<string, string>) => ({
  schema: 1 as const, id: "my-0a1b2c3d", version: 1, name: "Mine", parent: "recommended@1",
  modules: { checks: { planReview: "on", reviewerNeeds: { readWorkspace: "preferred" }, requirementCitation: "quote-when-reviewer-cannot-read" }, feedback },
}) as never;

/** Scripted transport: reviseReview(n)/reviseAudit(n) decide the nth review/audit verdict. */
function script(opts: { reviseReview?: (nth: number) => boolean; reviseAudit?: (nth: number) => boolean; turnsRemaining?: number } = {}) {
  const seen: Record<string, number> = {};
  const roles: string[] = [];
  const ids: string[] = [];
  return {
    roles, ids,
    async launch(command: { commandId: string }): Promise<CoordinateLaunchResult> {
      const role = command.commandId.split("-")[1];
      seen[role] = (seen[role] ?? 0) + 1;
      roles.push(role);
      ids.push(command.commandId);
      const verdict = role === "review" ? `\nVERDICT: ${opts.reviseReview?.(seen[role]) ? "revise" : "carry-out"}`
        : role === "audit" ? `\nVERDICT: ${opts.reviseAudit?.(seen[role]) ? "revise" : "verified"}` : "";
      return { text: `${role}${verdict}`, errorText: "", dispatched: true, turnsRemaining: opts.turnsRemaining ?? 9, writeTurnsRemaining: 2 };
    },
  };
}
const planRevise = { reviseReview: (nth: number) => nth === 1 };
const FIRST_CHAIN = ["plan", "review"];

describe("the plan-revision gate honours the feedback setting", () => {
  it("ask: never calls the gate, launches only the first chain, and names the decision", async () => {
    const beforePlanRevision = vi.fn(async () => true);
    const transport = script(planRevise);
    const view = await requestCoordination(
      { ...base, writeAuthorization: write, beforePlanRevision, workflowDefinition: definition({ planRevision: "ask", repair: "automatic" }) },
      discovery, transport);
    expect(beforePlanRevision).not.toHaveBeenCalled();
    expect(transport.roles).toEqual(FIRST_CHAIN);
    expect(view.decision).toEqual({ kind: "automatic-off", stage: "plan" });
    expect(view.stopReason).not.toMatch(/plan revision/);
    expect(view.planRevisionHistory).toBeUndefined();
  });

  it("Recommended (no setting) still runs exactly one revision chain, and sets no decision", async () => {
    const beforePlanRevision = vi.fn(async () => true);
    const transport = script(planRevise);
    const view = await requestCoordination({ ...base, writeAuthorization: write, beforePlanRevision }, discovery, transport);
    expect(beforePlanRevision).toHaveBeenCalledTimes(1);
    expect(transport.roles.slice(0, 4)).toEqual(["plan", "review", "plan", "review"]);
    expect(view.planRevisionHistory).toHaveLength(1);
    expect(view.decision).toBeUndefined();
  });

  it("not-enough-turns", async () => {
    const view = await requestCoordination(
      { ...base, writeAuthorization: write, beforePlanRevision: async () => true },
      discovery, script({ ...planRevise, turnsRemaining: 2 }));
    expect(view.decision).toEqual({ kind: "not-enough-turns", stage: "plan" });
    expect(view.stopReason).toContain("There is not enough access left for one more checked plan revision");
  });

  it("unstaffed when the agents you allowed cannot cover the revised chain", async () => {
    const allowedInstances = ["codex", "claude"];
    const inner = script(planRevise);
    const transport = { roles: inner.roles, async launch(command: { commandId: string }) {
      const result = await inner.launch(command);
      if (inner.roles.length === 2) allowedInstances.splice(1, 1); // the second agent goes away after the check
      return result;
    } };
    const view = await requestCoordination(
      { ...base, allowedInstances, writeAuthorization: write, beforePlanRevision: async () => true }, discovery, transport);
    expect(view.decision).toEqual({ kind: "unstaffed", stage: "plan" });
    expect(view.stopReason).toContain("could not be staffed with the agents you allowed");
    expect(transport.roles).toEqual(FIRST_CHAIN);
  });

  it("a background job's refusal says so on the decision; a window's does not", async () => {
    const background = await requestCoordination({ ...base, writeAuthorization: write, beforePlanRevision: async () => false, planRevisionRefusalSentence: "Background refusal." }, discovery, script(planRevise));
    expect(background.decision).toEqual({ kind: "window-refused", stage: "plan", where: "background" });
    const window = await requestCoordination({ ...base, writeAuthorization: write, beforePlanRevision: async () => false }, discovery, script(planRevise));
    expect(window.decision).toEqual({ kind: "window-refused", stage: "plan" });
    const repair = await requestCoordination({ ...base, writeAuthorization: write, beforeRepair: async () => false, repairRefusalSentence: "Background refusal." }, discovery, script({ reviseAudit: (nth: number) => nth === 1 }));
    expect(repair.decision).toEqual({ kind: "window-refused", stage: "changes", where: "background" });
  });

  it("window-refused when the gate says no, throws, or the request went stale", async () => {
    for (const beforePlanRevision of [async () => false, async () => { throw new Error("x"); }]) {
      const view = await requestCoordination({ ...base, writeAuthorization: write, beforePlanRevision }, discovery, script(planRevise));
      expect(view.decision).toEqual({ kind: "window-refused", stage: "plan" });
      expect(view.stopReason).toContain("could not confirm this window for the automatic plan revision");
    }
    let current = true;
    const transport = script(planRevise);
    const view = await requestCoordination(
      { ...base, writeAuthorization: write, beforePlanRevision: async () => { current = false; return true; } },
      discovery, transport, () => current);
    expect(view.decision).toEqual({ kind: "window-refused", stage: "plan" });
    expect(transport.roles).toEqual(FIRST_CHAIN);
  });

  it("limit-reached when the revised plan is rejected again", async () => {
    const view = await requestCoordination(
      { ...base, writeAuthorization: write, beforePlanRevision: async () => true },
      discovery, script({ reviseReview: () => true }));
    expect(view.decision).toEqual({ kind: "limit-reached", stage: "plan" });
    expect(view.stopReason).toContain("This send already used its one automatic plan revision.");
  });

  it("revise when no automatic round exists: no gate hook, or a read-only goal", async () => {
    const noHook = await requestCoordination({ ...base, writeAuthorization: write }, discovery, script(planRevise));
    expect(noHook.decision).toEqual({ kind: "revise", stage: "plan" });
    const readOnly = await requestCoordination({ ...base, beforePlanRevision: async () => true }, discovery, script(planRevise));
    expect(readOnly.decision).toEqual({ kind: "revise", stage: "plan" });
  });

  it("a verified run carries no decision", async () => {
    const view = await requestCoordination({ ...base, writeAuthorization: write, beforePlanRevision: async () => true, beforeRepair: async () => true }, discovery, script());
    expect(view.decision).toBeUndefined();
  });
});

describe("the repair gate honours the feedback setting", () => {
  const auditRevise = { reviseAudit: (nth: number) => nth === 1 };

  it("ask: never calls the gate, launches only the first chain, and names the decision", async () => {
    const beforeRepair = vi.fn(async () => true);
    const transport = script(auditRevise);
    const view = await requestCoordination(
      { ...base, writeAuthorization: write, beforeRepair, workflowDefinition: definition({ planRevision: "automatic", repair: "ask" }) },
      discovery, transport);
    expect(beforeRepair).not.toHaveBeenCalled();
    expect(transport.roles).toEqual(["plan", "review", "execute", "audit"]);
    expect(view.decision).toEqual({ kind: "automatic-off", stage: "changes" });
    expect(view.feedbackHistory).toBeUndefined();
  });

  it("Recommended (no setting) still runs exactly one repair chain", async () => {
    const beforeRepair = vi.fn(async () => true);
    const transport = script(auditRevise);
    const view = await requestCoordination({ ...base, writeAuthorization: write, beforeRepair }, discovery, transport);
    expect(beforeRepair).toHaveBeenCalledTimes(1);
    expect(transport.roles).toEqual(["plan", "review", "execute", "audit", "plan", "review", "execute", "audit"]);
    expect(view.feedbackHistory).toHaveLength(1);
    expect(view.decision).toBeUndefined();
  });

  it("not-enough-turns", async () => {
    const view = await requestCoordination(
      { ...base, writeAuthorization: write, beforeRepair: async () => true }, discovery, script({ ...auditRevise, turnsRemaining: 2 }));
    expect(view.decision).toEqual({ kind: "not-enough-turns", stage: "changes" });
    expect(view.stopReason).toContain("There is not enough access left for one more checked repair");
  });

  it("unstaffed when the agents you allowed cannot cover the repair chain", async () => {
    const allowedInstances = ["codex", "claude"];
    const inner = script({ reviseAudit: (nth) => nth === 1 });
    const transport = { roles: inner.roles, async launch(command: { commandId: string }) {
      const result = await inner.launch(command);
      if (inner.roles.length === 4) allowedInstances.splice(1, 1);
      return result;
    } };
    const view = await requestCoordination(
      { ...base, allowedInstances, writeAuthorization: write, beforeRepair: async () => true }, discovery, transport);
    expect(view.decision).toEqual({ kind: "unstaffed", stage: "changes" });
    expect(view.stopReason).toContain("could not be staffed with the agents you allowed");
  });

  it("window-refused when the gate says no or throws", async () => {
    for (const beforeRepair of [async () => false, async () => { throw new Error("x"); }]) {
      const view = await requestCoordination({ ...base, writeAuthorization: write, beforeRepair }, discovery, script(auditRevise));
      expect(view.decision).toEqual({ kind: "window-refused", stage: "changes" });
    }
  });

  it("limit-reached when the repair is rejected again", async () => {
    const view = await requestCoordination(
      { ...base, writeAuthorization: write, beforeRepair: async () => true }, discovery, script({ reviseAudit: () => true }));
    expect(view.decision).toEqual({ kind: "limit-reached", stage: "changes" });
    expect(view.stopReason).toContain("This send already used its one automatic repair.");
    expect(view.checksRan?.at(-1)?.kind).toBe("audit");
    expect(view.checksRan?.at(-1)?.kind).toBe("audit");
  });

  it("repair-plan-revise when the repair's own plan check asks for changes", async () => {
    const view = await requestCoordination(
      { ...base, writeAuthorization: write, beforeRepair: async () => true },
      discovery, script({ reviseAudit: (nth) => nth === 1, reviseReview: (nth) => nth === 2 }));
    expect(view.decision).toEqual({ kind: "repair-plan-revise", stage: "plan" });
    expect(view.stopReason).toContain("This send already used its one automatic repair.");
  });

  it("revise when there is no repair hook", async () => {
    const view = await requestCoordination({ ...base, writeAuthorization: write }, discovery, script(auditRevise));
    expect(view.decision).toEqual({ kind: "revise", stage: "changes" });
  });
});
