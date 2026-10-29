import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CampaignNav } from "../nav/CampaignNav";
import { DEMO_SNAPSHOT, EMPTY_SNAPSHOT } from "../types";
import {
  evidenceCommand,
  formatEvidenceForAudit,
  coordinateGoal,
  replacementCommand,
  usableInstanceIds,
  MAX_AUDIT_PROMPT_BYTES,
  MAX_CONTINUATION_PROMPT_BYTES,
  MAX_CONTINUATION_CHARS,
  WINDOWS_CMD_MAX_CHARS,
  windowsCmdWorstCaseChars,
  type CoordinateGoalInput,
  type ExecutionFeedback,
  type SyntheticCatalogInstance,
} from "./coordinateGoal";
import type { SavedTargetContinuation } from "./continuation";

const { launchSpec, turnSpec } = createRequire(import.meta.url)("../../electron/cli-coordinate.cjs") as {
  launchSpec(file: string, args: string[], env: NodeJS.ProcessEnv, platform: string): { file: string; args: string[]; verbatim: boolean };
  turnSpec(command: CoordinateTurnCommand, env: NodeJS.ProcessEnv, platform: string): { args?: string[]; errorText?: string };
};

import { authorizeCoordinateWriteTurn, roleOfCommandId, type CoordinateTurnCommand } from "./coordinateTurn";
import { verdictFromAudit, verdictFromReview, outcomeLabel } from "./verdict";

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
      sendKey: "send-0",
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
    expect(state.commands[0]?.initialMessage.text).toContain("Find the product contract in this workspace");
    expect(state.commands[0]?.initialMessage.text).toContain("If you cannot confirm one, say so.");
    expect(state.commands[1]?.initialMessage.text).toContain("done-claim is not a pass");
    expect(state.commands[1]?.initialMessage.text).toContain("where that contract is");
    expect(state.commands).toHaveLength(2);
  });

  it("a revision cites the saved plan and check and does not reuse the first turn", () => {
    const catalog = [
      instance({ instanceId: "pi-local", name: "Pi", defaultModel: "pi-default", quota: "available" }),
      instance({ instanceId: "cursor-local", name: "Cursor", models: ["cursor-first"], quota: "available" }),
    ];
    const first = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog });
    const revised = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog,
      priorPlan: "Bounded plan.",
      priorReview: "The contract path is missing.\nVERDICT: revise",
    });
    const plan = revised.commands[0]?.initialMessage.text ?? "";
    expect(plan).toContain("This is a revision of a saved plan.");
    expect(plan).toContain("Answer every point the independent check raised, one by one.");
    expect(plan).toContain("State the workspace state this plan relies on");
    expect(plan).toContain("Bounded plan.");
    expect(plan).toContain("The contract path is missing.");
    expect(plan).not.toContain("AGENTS.md");
    const firstSend = first.commands[0]?.initialMessage.text ?? "";
    expect(firstSend).not.toContain("Answer every point the independent check raised");
    expect(firstSend).not.toContain("State the workspace state");
    expect(revised.commands[1]?.initialMessage.text).toContain("The contract path is missing.");
    expect(revised.commands[0]?.commandId).not.toBe(first.commands[0]?.commandId);
    expect(revised.commands[1]?.commandId).not.toBe(first.commands[1]?.commandId);
  });

  it("does not select a default model that requires extra usage credits", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
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
      sendKey: "send-0",
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

  it("does not invent a model when a signed-in harness has none", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
      catalog: [
        instance({
          instanceId: "codex",
          name: "Codex",
          quota: "unknown",
          authenticated: true,
          models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true }],
        }),
        instance({
          instanceId: "claude",
          name: "Claude",
          quota: "unknown",
          authenticated: true,
          billing: "subscription",
          models: [],
        }),
      ],
    });

    expect(state.commands).toEqual([]);
    expect(state.stopReason).toMatch(/no included model/);
  });

  it("stops an empty catalog because no harness catalog is connected", () => {
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "send-0",
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
      sendKey: "send-0",
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
      sendKey: "send-0",
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
      sendKey: "send-0",
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
      sendKey: "send-0",
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
      sendKey: "send-0",
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
      sendKey: "send-0",
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
      sendKey: "send-0",
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

  it("keys the commands to the individual send, not only the prompt text", () => {
    const catalog = [
      instance({ instanceId: "pi-local", name: "Pi", defaultModel: "pi-default", quota: "available" }),
      instance({ instanceId: "cursor-local", name: "Cursor", models: ["cursor-first"], quota: "available" }),
    ];
    const first = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog });
    const repeat = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog });
    const secondSend = coordinateGoal({ goal, workspacePath, sendKey: "send-1", catalog });

    expect(secondSend.commands[0]?.commandId).not.toBe(first.commands[0]?.commandId);
    expect(secondSend.commands[1]?.commandId).not.toBe(first.commands[1]?.commandId);
    expect(repeat.commands[0]?.commandId).toBe(first.commands[0]?.commandId);
    expect(repeat.commands[1]?.commandId).toBe(first.commands[1]?.commandId);
  });

  it("an avoided harness receives no role while the others keep both roles", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", defaultModel: "gpt-a", quota: "available" }),
      instance({ instanceId: "claude", name: "Claude", models: ["claude-a"], quota: "available" }),
      instance({ instanceId: "grok", name: "Grok", models: ["grok-a"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog, avoidInstances: ["codex"] });

    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["claude", "grok"]);
    expect(state.planningHarness).toBe("Claude");
    expect(state.reviewHarness).toBe("Grok");
    expect(state.quotaLabels.codex).toBe("available");
  });

  it("avoiding down to one harness names the harness that cannot run", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", defaultModel: "gpt-a", quota: "available" }),
      instance({ instanceId: "claude", name: "Claude", models: ["claude-a"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog, avoidInstances: ["codex"] });

    expect(state.commands).toHaveLength(0);
    expect(state.stopReason).toBe("Stopped. Codex cannot run on this machine right now, and an independent check needs two harnesses that can run.");
    expect(state.quotaLabels.codex).toBe("available");
  });

  it("an explicitly named harness with unknown billing can take a role and is not called a subscription", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", defaultModel: "gpt-a", quota: "available", billing: "subscription", authenticated: true, installed: true, enabled: true, launchable: true }),
      instance({ instanceId: "pi", name: "Pi", defaultModel: "pi-default", quota: "unknown", billing: "unknown", authenticated: true, installed: true, enabled: true, launchable: true }),
    ];
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "use-pi",
      catalog,
      allowedInstances: ["codex", "pi"],
    });
    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["codex", "pi"]);
    expect(state.roles).toEqual(["planning", "review"]);
    expect(usableInstanceIds(catalog)).toEqual(["codex"]);
  });

  it("write authorization with one usable harness assigns no role and emits no workspaceWrite", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", defaultModel: "gpt-a", quota: "available", billing: "subscription", authenticated: true, installed: true, enabled: true, launchable: true, models: [{ slug: "gpt-a", name: "gpt-a", isDefault: true }] }),
    ];
    const state = coordinateGoal({
      goal,
      workspacePath,
      sendKey: "write-one",
      catalog,
      allowedInstances: ["codex"],
      writeAuthorization: { instances: ["codex"], workspaceRoot: workspacePath, remaining: 1 },
    });
    expect(state.commands).toEqual([]);
    expect(state.roles).toEqual([]);
    expect(state.stopReason).toBe("Stopped. An independent check needs a second logged-in harness, so no second role was assigned.");
  });

  it("an unusable catalog keeps its original stop reason even with an avoidance", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", defaultModel: "gpt-a", quota: "exhausted" }),
      instance({ instanceId: "claude", name: "Claude", models: ["claude-a"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "send-0", catalog, avoidInstances: ["codex"] });

    expect(state.commands).toHaveLength(0);
    expect(state.stopReason).toBe("Stopped. An independent check needs a second logged-in harness, so no second role was assigned.");
  });

  it("excludes a health-blocked harness from both initial roles", () => {
    const catalog = [
      instance({ instanceId: "blocked", name: "Blocked", models: ["model-a"], quota: "available", environmentAvoided: { since: "2026-10-09T14:00:00.000Z", detail: "sandbox failed" } }),
      instance({ instanceId: "planner", name: "Planner", models: ["model-b"], quota: "available" }),
      instance({ instanceId: "reviewer", name: "Reviewer", models: ["model-c"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "health-0", catalog });

    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["planner", "reviewer"]);
    expect(state.planningHarness).toBe("Planner");
    expect(state.reviewHarness).toBe("Reviewer");
  });

  it("treats health-blocked and draft-avoided instances as a union", () => {
    const catalog = [
      instance({ instanceId: "health-blocked", name: "Health", models: ["model-a"], quota: "available", environmentAvoided: { since: "2026-10-09T14:00:00.000Z", detail: "sandbox failed" } }),
      instance({ instanceId: "draft-avoided", name: "Avoided", models: ["model-b"], quota: "available" }),
      instance({ instanceId: "planner", name: "Planner", models: ["model-c"], quota: "available" }),
      instance({ instanceId: "reviewer", name: "Reviewer", models: ["model-d"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "health-avoid-0", catalog, avoidInstances: ["draft-avoided"] });

    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["planner", "reviewer"]);
  });

  it("names the health blocker when it prevents the independent pair", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", models: ["model-a"], quota: "available", environmentAvoided: { since: "2026-10-09T14:00:00.000Z", detail: "helper_unknown_error" } }),
      instance({ instanceId: "claude", name: "Claude", models: ["model-b"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "health-stop-0", catalog });

    expect(state.commands).toEqual([]);
    expect(state.stopReason).toBe("Stopped. Codex cannot run on this machine right now, and an independent check needs two harnesses that can run.");
  });

  it("filters initial role assignment to the authorized instances", () => {
    const catalog = [
      instance({ instanceId: "outside", name: "Outside", models: ["model-a"], quota: "available" }),
      instance({ instanceId: "planner", name: "Planner", models: ["model-b"], quota: "available" }),
      instance({ instanceId: "reviewer", name: "Reviewer", models: ["model-c"], quota: "available" }),
    ];
    const state = coordinateGoal({ goal, workspacePath, sendKey: "scope-0", catalog, allowedInstances: ["reviewer", "planner"] });

    expect(state.commands.map((command) => command.modelSelection.instanceId)).toEqual(["planner", "reviewer"]);
    const tooNarrow = coordinateGoal({ goal, workspacePath, sendKey: "scope-1", catalog, allowedInstances: ["planner"] });
    expect(tooNarrow.commands).toEqual([]);
  });

  it("keeps an instance command key stable and derives a fresh key for another instance", () => {
    const catalog = [
      instance({ instanceId: "codex", name: "Codex", models: ["model-a"], quota: "available" }),
      instance({ instanceId: "claude", name: "Claude", models: ["model-b"], quota: "available" }),
      instance({ instanceId: "grok", name: "Grok", models: ["model-c"], quota: "available" }),
    ];
    const original = coordinateGoal({ goal, workspacePath, sendKey: "same-send", catalog });
    const sameInstance = coordinateGoal({ goal, workspacePath, sendKey: "same-send", catalog });
    const differentInstance = coordinateGoal({ goal, workspacePath, sendKey: "same-send", catalog: [catalog[2]!, catalog[1]!, catalog[0]!] });

    expect(sameInstance.commands[0]?.commandId).toBe(original.commands[0]?.commandId);
    expect(differentInstance.commands[0]?.modelSelection.instanceId).not.toBe(original.commands[0]?.modelSelection.instanceId);
    expect(differentInstance.commands[0]?.commandId).not.toBe(original.commands[0]?.commandId);
  });
});


describe("explicit write assembly and phase verdicts", () => {
  const catalog: SyntheticCatalogInstance[] = [
    { instanceId: "a", name: "A", defaultModel: "included" },
    { instanceId: "b", name: "B", defaultModel: "included" },
  ];
  const input: CoordinateGoalInput = {
    catalog, goal, workspacePath, sendKey: "write-send", allowedInstances: ["a", "b"],
    writeAuthorization: { instances: ["a"], workspaceRoot: workspacePath, remaining: 1 },
  };
  it("advertises four roles but creates only the first two read commands until evidence exists", () => {
    const selected = coordinateGoal(input);
    expect(selected.roles).toEqual(["planning", "review", "execution", "audit"]);
    expect(selected.commands).toHaveLength(2);
    expect(selected.commands.map((command) => roleOfCommandId(command.commandId))).toEqual(["plan", "review"]);
    for (const command of selected.commands) {
      expect(authorizeCoordinateWriteTurn(command).outcome).toBe("write-authorized");
      expect(command.sandboxPolicy.type).toBe("readOnly");
    }
    const { writeAuthorization: _write, ...readInput } = input;
    expect(JSON.stringify(coordinateGoal(readInput))).toBe(JSON.stringify(coordinateGoal({ ...readInput, writeAuthorization: undefined })));
    expect(coordinateGoal(readInput).roles).toEqual(["planning", "review"]);
  });
  it.each([
    { ...input, allowedInstances: undefined },
    { ...input, workspacePath: "/work/other" },
    { ...input, workspacePath: "relative", writeAuthorization: { ...input.writeAuthorization!, workspaceRoot: "relative" } },
    { ...input, writeAuthorization: { ...input.writeAuthorization!, instances: [] } },
    { ...input, writeAuthorization: { ...input.writeAuthorization!, instances: ["unknown"] } },
  ])("refuses missing scope, wrong/relative root or unstaffable write membership before sending", (invalid) => {
    expect(coordinateGoal(invalid).commands).toEqual([]);
  });
  it("pairs lazy roles with sandbox/root and keys ids to role, instance, send and evidence", () => {
    const evidence = { planText: "Actual approved plan", reviewText: "VERDICT: carry-out", executionText: "Checks: exit 0", executionFacts: "actual facts" };
    const writer = evidenceCommand("execute", catalog[0]!, input, evidence);
    const audit = evidenceCommand("audit", catalog[1]!, input, evidence);
    expect(roleOfCommandId(writer.commandId)).toBe("execute");
    expect(roleOfCommandId(audit.commandId)).toBe("audit");
    expect(writer.sandboxPolicy.type).toBe("workspaceWrite");
    expect(audit.sandboxPolicy.type).toBe("readOnly");
    expect(writer.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: workspacePath });
    for (const command of [writer, audit]) {
      expect(authorizeCoordinateWriteTurn(command).outcome).toBe("write-authorized");
      expect(command.initialMessage.text).toContain(evidence.planText);
      expect(command.initialMessage.text).toContain(evidence.reviewText);
    }
    expect(writer.initialMessage.text).toContain("actual output and exit results");
    expect(audit.initialMessage.text).toContain(evidence.executionText);
    expect(audit.initialMessage.text).toContain(evidence.executionFacts);
    expect(audit.initialMessage.text).toContain("GoalPort has not independently run a machine-test stage");
    expect(evidenceCommand("execute", catalog[0]!, input, evidence)).toEqual(writer);
    expect(evidenceCommand("execute", catalog[0]!, { ...input, sendKey: "new-send" }, evidence).commandId).not.toBe(writer.commandId);
    expect(evidenceCommand("execute", catalog[0]!, input, { ...evidence, planText: "Other approved plan" }).commandId).not.toBe(writer.commandId);
    expect(evidenceCommand("audit", catalog[0]!, input, evidence).commandId).not.toBe(audit.commandId);
    expect(evidenceCommand("audit", catalog[1]!, input, { ...evidence, executionText: "different report" }).commandId).not.toBe(audit.commandId);
    expect(() => evidenceCommand("execute", catalog[1]!, input, evidence)).toThrow(/consent/);
  });
  it("carries execution feedback separately, uses repair-1 identities, and preserves read/write role gates", () => {
    const original = coordinateGoal(input);
    const originalEvidence = {
      planText: "Bounded plan for the original send.",
      reviewText: "VERDICT: carry-out",
      executionText: "pnpm test failed: 1 assertion",
      executionFacts: "original run facts",
    };
    const originalWriter = evidenceCommand("execute", catalog[0]!, input, originalEvidence);
    const originalAudit = evidenceCommand("audit", catalog[1]!, input, originalEvidence);
    const feedback: ExecutionFeedback = {
      previousPlan: originalEvidence.planText,
      previousPlanReview: originalEvidence.reviewText,
      previousExecutionReport: originalEvidence.executionText,
      previousExecutionAudit: "The configuration file was not updated.\nVERDICT: revise",
      previousCommandIds: [
        ...original.commands.map((command) => command.commandId),
        originalWriter.commandId,
        originalAudit.commandId,
      ],
    };
    const repairInput = { ...input, executionFeedback: feedback };
    const repair = coordinateGoal(repairInput);
    const [planner, reviewer] = repair.commands;
    const plannerText = planner?.initialMessage.text ?? "";
    const reviewerText = reviewer?.initialMessage.text ?? "";

    expect(repair.roles).toEqual(["planning", "review", "execution", "audit"]);
    expect(repair.commands.map((command) => roleOfCommandId(command.commandId))).toEqual(["plan", "review"]);
    expect(repair.commands.map((command) => command.modelSelection.instanceId)).toEqual(["a", "b"]);
    for (const command of repair.commands) {
      expect(command.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: workspacePath });
      expect(command.sandboxPolicy).toEqual({ type: "readOnly" });
      expect(feedback.previousCommandIds).not.toContain(command.commandId);
    }
    expect(plannerText).toContain(goal);
    expect(plannerText).toContain(workspacePath);
    expect(plannerText).toContain("Inspect the CURRENT workspace");
    expect(plannerText).toContain("Answer each finding in the previous independent execution audit");
    expect(plannerText).toContain(feedback.previousPlan!);
    expect(plannerText).toContain(feedback.previousPlanReview!);
    expect(plannerText).toContain(feedback.previousExecutionReport!);
    expect(plannerText).toContain("The configuration file was not updated.");
    expect(plannerText).toContain(originalWriter.commandId);
    expect(plannerText).toContain("references only; never replay or resubmit");
    expect(plannerText).not.toContain("This is a revision of a saved plan.");
    expect(reviewerText).toContain("independent check of the newly proposed corrective plan");
    expect(reviewerText).toContain("A writer is not eligible until this plan receives a carry-out verdict.");
    expect(reviewerText).toContain("The configuration file was not updated.");

    // Existing manual plan revision context remains independent from execution feedback.
    const withBoth = coordinateGoal({ ...repairInput, priorPlan: "Manual saved plan", priorReview: "Manual plan check" });
    expect(withBoth.commands[0]?.initialMessage.text).toContain("This is a revision of a saved plan.");
    expect(withBoth.commands[0]?.initialMessage.text).toContain("Manual saved plan");
    expect(withBoth.commands[0]?.initialMessage.text).toContain("This is the one bounded corrective planning pass");

    const sameEvidence = {
      planText: "Bounded corrective plan.",
      reviewText: "VERDICT: carry-out",
      executionText: "pnpm test: unchanged checks passed",
      executionFacts: "corrective run facts",
    };
    const firstLikeWriter = evidenceCommand("execute", catalog[0]!, input, sameEvidence);
    const firstLikeAudit = evidenceCommand("audit", catalog[1]!, input, sameEvidence);
    const repairWriter = evidenceCommand("execute", catalog[0]!, repairInput, sameEvidence);
    const repairAudit = evidenceCommand("audit", catalog[1]!, repairInput, sameEvidence);
    const recoveredPlanner = replacementCommand("plan", catalog[0]!, repairInput, input.sendKey);

    expect(roleOfCommandId(recoveredPlanner.commandId)).toBe("plan");
    expect(recoveredPlanner.sandboxPolicy).toEqual({ type: "readOnly" });
    expect(recoveredPlanner.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: workspacePath });
    expect(repairWriter.commandId).not.toBe(firstLikeWriter.commandId);
    expect(repairAudit.commandId).not.toBe(firstLikeAudit.commandId);
    expect([repairWriter, repairAudit, recoveredPlanner].map((command) => roleOfCommandId(command.commandId))).toEqual(["execute", "audit", "plan"]);
    expect(repairWriter.sandboxPolicy).toEqual({ type: "workspaceWrite" });
    expect(repairAudit.sandboxPolicy).toEqual({ type: "readOnly" });
    for (const command of [repairWriter, repairAudit]) {
      expect(command.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: workspacePath });
      expect(command.initialMessage.text).toContain("Bounded corrective plan.");
      expect(command.initialMessage.text).toContain("VERDICT: carry-out");
      expect(command.initialMessage.text).toContain(feedback.previousExecutionAudit!);
      expect(command.initialMessage.text).toContain(originalAudit.commandId);
      expect(feedback.previousCommandIds).not.toContain(command.commandId);
    }
    expect(repairWriter.initialMessage.text).toContain("newly reviewed bounded corrective plan");
    expect(repairWriter.initialMessage.text).toContain("Historical commands and command IDs are evidence only");
    expect(repairAudit.initialMessage.text).toContain("current workspace read-only");
    expect(repairAudit.initialMessage.text).toContain("Corrective execution report:");
    expect(repairAudit.initialMessage.text).toContain(sameEvidence.executionText);
    expect(evidenceCommand("execute", catalog[0]!, repairInput, sameEvidence)).toEqual(repairWriter);
  });
  it("Linux Pi delivers full formatted multi-file material >4KiB within 32KiB; legacy remains cropped", () => {
    const pi = { ...catalog[1]!, instanceId: "pi", name: "Pi" };
    const afterDiff = ["diff --git a/src/one.ts b/src/one.ts", ...Array.from({ length: 110 }, (_, n) => `+export const rule${n} = '中文😀: preserve actual file content';`), "diff --git a/src/two.ts b/src/two.ts", "+export const finalBeyondOldEnvelope = 'tail-marker';"].join("\n");
    const executionEvidence = { status: "available" as const, complete: true, changed: true, beforeDiff: "baseline-marker", afterDiff,
      untrackedFiles: [{ path: "checks.txt", size: 21, content: "untracked-tail-marker" }] };
    const material = { planText: "approved-plan-marker", reviewText: "check-marker VERDICT: carry-out", executionText: "actual-report-marker", executionFacts: "facts-marker", executionEvidence };
    const host = { ...input, auditPromptTransport: "linux-pi-stdin" as const };
    const audit = evidenceCommand("audit", pi, host, material);
    const full = formatEvidenceForAudit(executionEvidence, Number.MAX_SAFE_INTEGER);
    expect(full.coverage.totalEvidenceBytes).toBeGreaterThan(4096);
    expect(audit.auditInputEvidenceText).toBe(full.text);
    expect(audit.auditInputEvidenceCoverage).toMatchObject({ totalEvidenceBytes: full.coverage.totalEvidenceBytes, includedEvidenceBytes: full.coverage.totalEvidenceBytes, cropped: false, promptBudgetBytes: 32768, promptDelivery: "stdin", croppedSections: [] });
    const bytes = new TextEncoder().encode(audit.initialMessage.text).length;
    expect(bytes).toBeGreaterThan(8192);
    expect(bytes).toBeLessThan(24576);
    expect(audit.auditInputEvidenceCoverage!.promptBytes).toBe(bytes);
    expect(audit.auditInputEvidenceCoverage).not.toHaveProperty("windowsCmdWorstCaseChars");
    expect(windowsCmdWorstCaseChars(audit.initialMessage.text)).toBeGreaterThan(WINDOWS_CMD_MAX_CHARS);
    expect(audit.promptDelivery).toBe("stdin");
    for (const marker of [afterDiff, "baseline-marker", "untracked-tail-marker", "approved-plan-marker", "actual-report-marker", "facts-marker"]) expect(audit.initialMessage.text).toContain(marker);
    const legacy = evidenceCommand("audit", pi, input, material);
    expect(legacy).not.toHaveProperty("promptDelivery");
    expect(legacy.auditInputEvidenceCoverage).not.toHaveProperty("promptDelivery");
    expect(legacy.auditInputEvidenceCoverage!.promptBudgetBytes).toBe(4096);
    expect(legacy.auditInputEvidenceCoverage!.cropped).toBe(true);
    expect(legacy.initialMessage.text).toContain("cropped for transport");
    // Capacity must not leak from this selection into a different instance,
    // then must become available again when Pi is selected anew.
    const other = evidenceCommand("audit", catalog[1]!, host, material);
    expect(other.auditInputEvidenceCoverage!.promptBudgetBytes).toBe(4096);
    expect(other).not.toHaveProperty("promptDelivery");
    expect(evidenceCommand("audit", pi, host, material)).toEqual(audit);
  });
  it("32KiB overflow has finite labeled crop and leaves execute/plan/review uncapped at 4KiB", () => {
    const pi = { ...catalog[1]!, instanceId: "pi", name: "Pi" };
    const host = { ...input, auditPromptTransport: "linux-pi-stdin" as const, goal: "goal-material ".repeat(3000) };
    const material = { planText: "plan-material ".repeat(3000), reviewText: "review-material ".repeat(3000), executionText: "report-material ".repeat(3000), executionEvidence: { status: "incomplete" as const, complete: false, changed: true, beforeDiff: "前😀".repeat(12000), afterDiff: "後😀".repeat(12000), untrackedFiles: [{ path: "binary", binary: true, size: 50 }] } };
    const audit = evidenceCommand("audit", pi, host, material);
    expect(audit.auditInputEvidenceCoverage!.promptBytes).toBeLessThanOrEqual(32768);
    expect(audit.auditInputEvidenceCoverage!.promptBytes).toBe(new TextEncoder().encode(audit.initialMessage.text).length);
    expect(audit.auditInputEvidenceCoverage!.cropped).toBe(true);
    expect(audit.auditInputEvidenceCoverage!.croppedSections!.length).toBeGreaterThan(0);
    expect(audit.initialMessage.text).toContain("cropped for transport");
    expect(audit.auditInputEvidenceText).toContain("Workspace AFTER tracked diff cropped");
    expect(audit.auditInputEvidenceCoverage).not.toHaveProperty("windowsCmdWorstCaseChars");
    expect(new TextDecoder("utf8", { fatal: true }).decode(new TextEncoder().encode(audit.initialMessage.text))).toBe(audit.initialMessage.text);
    const execute = evidenceCommand("execute", catalog[0]!, host, material);
    expect(execute.initialMessage.text).toContain(material.planText);
    expect(execute.initialMessage.text.length).toBeGreaterThan(4096);
    expect(execute).not.toHaveProperty("promptDelivery");
    for (const planned of coordinateGoal(host).commands) {
      expect(planned.initialMessage.text.length).toBeGreaterThan(4096);
      expect(planned).not.toHaveProperty("promptDelivery");
    }
  });
  it("delivers captured BEFORE/AFTER diffs and untracked text as the exact retained audit subset", () => {
    const executionEvidence = {
      status: "available" as const,
      complete: true,
      changed: true,
      beforeDiff: "UNIQUE_BEFORE_TRACKED_MARKER",
      afterDiff: "UNIQUE_AFTER_TRACKED_MARKER",
      beforeUntrackedFiles: [{ path: "old.txt", size: 25, content: "UNIQUE_BEFORE_UNTRACKED_MARKER", binary: false as const }],
      untrackedFiles: [{ path: "pong.txt", size: 26, content: "UNIQUE_NEW_FILE_CONTENT_MARKER", binary: false as const }],
      comparisonBaseline: { headCommit: "abc", capturedAt: "2026-10-28T00:00:00Z" },
    };
    const audit = evidenceCommand("audit", catalog[1]!, input, {
      planText: "plan", reviewText: "VERDICT: carry-out", executionText: "report", executionEvidence,
    });
    for (const marker of ["UNIQUE_BEFORE_TRACKED_MARKER", "UNIQUE_AFTER_TRACKED_MARKER", "UNIQUE_BEFORE_UNTRACKED_MARKER", "UNIQUE_NEW_FILE_CONTENT_MARKER"]) {
      expect(audit.initialMessage.text).toContain(marker);
      expect(audit.auditInputEvidenceText).toContain(marker);
    }
    expect(audit.initialMessage.text.endsWith(audit.auditInputEvidenceText!)).toBe(true);
    expect(audit.auditInputEvidenceCoverage!.promptBytes).toBe(new TextEncoder().encode(audit.initialMessage.text).length);
    expect(audit.auditInputEvidenceCoverage!.totalEvidenceBytes).toBeGreaterThan(100);
    expect(audit.auditInputEvidenceCoverage!.includedEvidenceBytes).toBe(audit.auditInputEvidenceCoverage!.totalEvidenceBytes);
    expect(audit.auditInputEvidenceCoverage!.cropped).toBe(false);
  });
  it("constructs the same audit with browser-native encoding and no global Buffer", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
    Object.defineProperty(globalThis, "Buffer", { value: undefined, configurable: true, writable: true });
    try {
      const audit = evidenceCommand("audit", catalog[1]!, input, {
        planText: "plan 🎯", reviewText: "VERDICT: carry-out", executionText: "report",
        executionEvidence: {
          status: "available", complete: true, changed: true,
          beforeDiff: "BEFORE_NO_BUFFER", afterDiff: "AFTER_NO_BUFFER",
          untrackedFiles: [{ path: "新增.txt", content: "TEXT_WITHOUT_BUFFER", binary: false }],
        },
      });
      expect(audit.initialMessage.text).toContain("TEXT_WITHOUT_BUFFER");
      expect(audit.initialMessage.text).toContain("BEFORE_NO_BUFFER");
      expect(audit.auditInputEvidenceCoverage!.promptBytes).toBe(new TextEncoder().encode(audit.initialMessage.text).length);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "Buffer", descriptor);
    }
  });
  it("does not crop any small evidence section when the complete capture fits its allocated budget", () => {
    const evidence = {
      status: "available" as const, complete: true, changed: true,
      beforeDiff: "diff --git a/note.txt b/note.txt\nindex 90be1f3..5b816da 100644\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1,2 @@\n before\n+pong\n",
      afterDiff: "diff --git a/note.txt b/note.txt\nindex 90be1f3..03e8786 100644\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1,3 @@\n before\n+pong\n+pong2\n",
      beforeUntrackedFiles: [], untrackedFiles: [],
      comparisonBaseline: { headCommit: "fb3e547623dc82d2a2d651bc73c50a231f1ee035", capturedAt: "2026-10-28T00:00:00Z" },
    };
    const full = formatEvidenceForAudit(evidence, 10000);
    const exact = formatEvidenceForAudit(evidence, new TextEncoder().encode(full.text).length);
    expect(exact.text).toBe(full.text);
    expect(exact.coverage.cropped).toBe(false);
  });

  it("keeps a complete small Continue diff when only the prior reports exceed the prompt budget", () => {
    const audit = evidenceCommand("audit", catalog[1]!, { ...input, executionFeedback: {
      previousPlan: "prior plan".repeat(1000), previousPlanReview: "prior review".repeat(1000),
      previousExecutionReport: "prior report".repeat(1000), previousExecutionAudit: "prior audit".repeat(1000), previousCommandIds: [],
    } }, {
      planText: "current plan".repeat(1000), reviewText: "review".repeat(1000), executionText: "executor report".repeat(1000),
      executionEvidence: {
        status: "available", complete: true, changed: true,
        beforeDiff: "diff --git a/note.txt b/note.txt\n@@ -1 +1,2 @@\n before\n+pong\n",
        afterDiff: "diff --git a/note.txt b/note.txt\n@@ -1 +1,3 @@\n before\n+pong\n+pong2\n",
        beforeUntrackedFiles: [], untrackedFiles: [],
        comparisonBaseline: { headCommit: "abc", capturedAt: "2026-10-28T00:00:00Z" },
      },
    });
    expect(audit.auditInputEvidenceText).toContain("+pong2");
    expect(audit.auditInputEvidenceText).not.toContain("cropped for transport");
    expect(audit.auditInputEvidenceCoverage?.includedEvidenceBytes).toBe(audit.auditInputEvidenceCoverage?.totalEvidenceBytes);
    expect(audit.auditInputEvidenceCoverage?.promptBytes).toBeLessThanOrEqual(MAX_AUDIT_PROMPT_BYTES);
  });

  it("bounds oversize goal/plan/review/report/feedback/metadata as well as evidence with visible crops", () => {
    const feedback: ExecutionFeedback = {
      previousPlan: "previous-plan".repeat(2000),
      previousPlanReview: "previous-review".repeat(2000),
      previousExecutionReport: "previous-report".repeat(2000),
      previousExecutionAudit: "previous-audit".repeat(2000),
      previousCommandIds: Array.from({ length: 1000 }, (_, index) => `coordinate-old-${index}`),
    };
    const audit = evidenceCommand("audit", catalog[1]!, { ...input, goal: "goal".repeat(5000), executionFeedback: feedback }, {
      planText: "p".repeat(20000), reviewText: "r".repeat(20000), executionText: "e".repeat(20000),
      executionFacts: "f".repeat(20000),
      executionEvidence: {
        status: "available", complete: true, changed: true,
        beforeDiff: "b".repeat(20000), afterDiff: "a".repeat(20000),
        untrackedFiles: [{ path: "new.txt", content: "n".repeat(20000), binary: false }],
      },
    });
    const actualBytes = new TextEncoder().encode(audit.initialMessage.text).length;
    expect(actualBytes).toBeLessThanOrEqual(MAX_AUDIT_PROMPT_BYTES);
    expect(audit.auditInputEvidenceCoverage!.promptBytes).toBe(actualBytes);
    expect(audit.auditInputEvidenceCoverage!.promptBytes).not.toBe(183);
    expect(audit.auditInputEvidenceCoverage!.windowsCmdWorstCaseChars).toBe(windowsCmdWorstCaseChars(audit.initialMessage.text));
    expect(audit.auditInputEvidenceCoverage!.windowsCmdWorstCaseChars!).toBeLessThanOrEqual(WINDOWS_CMD_MAX_CHARS);
    for (const label of ["Goal", "Approved plan", "Independent plan check", "Prior-round feedback and metadata", "Corrective execution report", "Recorded execution facts", "Workspace AFTER tracked diff", "Workspace BEFORE tracked diff", "Workspace AFTER untracked files"]) {
      expect(audit.auditInputEvidenceCoverage!.croppedSections).toContain(label);
    }
    expect(audit.initialMessage.text).toContain("[Goal cropped for transport:");
    expect(audit.initialMessage.text).toContain("[Approved plan cropped for transport:");
    expect(audit.initialMessage.text).toMatch(/\[Workspace .* cropped for transport:/);
    expect(audit.initialMessage.text).toContain("Full capture retained in GoalPort record.]");
  });
  it("keeps multibyte/cmd-metacharacter audit text launchable through the actual Windows argv shape", () => {
    const audit = evidenceCommand("audit", { instanceId: "codex", name: "Codex", defaultModel: "gpt-fixture" }, input, {
      planText: "plan 🎯 & %PATH%", reviewText: "VERDICT: carry-out", executionText: "report <ok>",
      executionEvidence: {
        status: "available", complete: true, changed: true,
        beforeDiff: "before 🎯", afterDiff: "🎯\"&%<>|^ ,;*?".repeat(1500),
        untrackedFiles: [{ path: "新增.txt", content: "新增内容 & <text>".repeat(300), binary: false }],
      },
    });
    const directory = mkdtempSync(join(tmpdir(), "goalport-audit-launch-"));
    try {
      const fixture = join(directory, "harmless.cmd");
      writeFileSync(fixture, "@echo off\r\necho HARMLESS_AUDIT_FIXTURE\r\n");
      const actual = turnSpec(audit, process.env, "linux");
      expect(actual.errorText).toBeUndefined();
      const spec = launchSpec(fixture, actual.args!, process.env, "win32");
      const escapedChars = spec.args.join(" ").length;
      expect(escapedChars).toBeLessThanOrEqual(WINDOWS_CMD_MAX_CHARS);
      expect(windowsCmdWorstCaseChars(audit.initialMessage.text)).toBeLessThanOrEqual(WINDOWS_CMD_MAX_CHARS);
      if (process.platform === "win32") {
        const launched = spawnSync(spec.file, spec.args, { windowsVerbatimArguments: spec.verbatim, encoding: "utf8" });
        expect(launched.error).toBeUndefined();
        expect(launched.status).toBe(0);
        expect(launched.stdout).toContain("HARMLESS_AUDIT_FIXTURE");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
  it("bounds the COMPLETE audit prompt to transport-safe byte budget and handles multibyte evidence", () => {
    // Generate large multibyte evidence (e.g. 50 KiB of emoji and Chinese text)
    const multibyteChunk = "🎯 修复文件：测试数据 🌟\n";
    const hugeDiff = multibyteChunk.repeat(2000); // ~50,000 bytes
    const evidence = {
      planText: "Approved repair plan for multibyte issue.",
      reviewText: "VERDICT: carry-out",
      executionText: "Executor says it modified the files.",
      executionFacts: "executor facts",
      executionEvidence: {
        status: "available" as const,
        complete: true,
        changed: true,
        beforeDiff: "",
        afterDiff: hugeDiff,
        untrackedFiles: [{ path: "test🎯.txt", size: 100 }],
        comparisonBaseline: { headCommit: "2dbea545040c2bb3bdc66b95602975adc951d5a0", capturedAt: "2026-10-28T00:00:00Z" },
        reason: "Changes observed",
      },
    };

    const auditCmd = evidenceCommand("audit", catalog[1]!, input, evidence);
    const promptText = auditCmd.initialMessage.text;
    const promptBytes = Buffer.byteLength(promptText, "utf8");

    // Must be bounded within the transport budget
    expect(promptBytes).toBeLessThanOrEqual(MAX_AUDIT_PROMPT_BYTES);
    expect(auditCmd.auditInputEvidenceCoverage!.promptBytes).toBe(promptBytes);

    // Must retain visible crop notice
    expect(promptText).toMatch(/\[Workspace .* cropped for transport:/);
    expect(promptText).toContain("Full capture retained in GoalPort record.]");

    // Audit coverage must accurately state what was included vs total
    expect(auditCmd.auditInputEvidenceCoverage).toBeDefined();
    expect(auditCmd.auditInputEvidenceCoverage!.cropped).toBe(true);
    expect(auditCmd.auditInputEvidenceCoverage!.totalEvidenceBytes).toBeGreaterThan(16384);
    expect(auditCmd.auditInputEvidenceCoverage!.includedEvidenceBytes).toBeLessThan(16384);

    // Verify multibyte valid decode (no broken UTF-8 sequences)
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(promptText, "utf8"))).not.toThrow();
  });

  describe("Continuation descriptor and bounded prompt", () => {
    const catalog = [
      instance({ instanceId: "pi-local", name: "Pi", defaultModel: "pi-default", quota: "available" }),
      instance({ instanceId: "cursor-local", name: "Cursor", models: ["cursor-first"], quota: "available" }),
    ];

    it("builds planning command with explicit Original goal and Current follow-up, keeping all 4 prior feedback labels and exact texts", () => {
      const continuation: SavedTargetContinuation = {
        parentRequestId: "req-parent-123",
        rootRequestId: "req-root-001",
        originalGoal: "Root original goal with CJK 中文 and Emoji 🚀",
        followUp: "Current follow-up with Japanese 日本語 and Emoji 🎯",
      };

      const feedback: ExecutionFeedback = {
        previousPlan: "Exact previous plan text: 方案详情",
        previousPlanReview: "Exact previous plan check: 审查结论\nVERDICT: carry-out",
        previousExecutionReport: "Exact previous execution report: 执行修改",
        previousExecutionAudit: "Exact previous execution audit: 独立审计\nVERDICT: revise",
        previousCommandIds: ["cmd-prev-1", "cmd-prev-2"],
      };

      const state = coordinateGoal({
        goal: continuation.originalGoal,
        workspacePath,
        sendKey: "send-cont-1",
        catalog,
        continuation,
        priorPlan: "Prior plan text",
        priorReview: "Prior review text",
        executionFeedback: feedback,
      });

      expect(state.commands).toHaveLength(2);
      const planningText = state.commands[0]?.initialMessage.text ?? "";

      // Must start with explicit Original goal and Current follow-up sections
      expect(planningText).toContain("Original goal:\nRoot original goal with CJK 中文 and Emoji 🚀");
      expect(planningText).toContain("Current follow-up:\nCurrent follow-up with Japanese 日本語 and Emoji 🎯");
      expect(planningText).toContain(workspacePath);
      expect(planningText).toContain("Find the product contract in this workspace");

      // All four prior feedback labels and exact texts must be present
      expect(planningText).toContain("Previous plan:\nExact previous plan text: 方案详情");
      expect(planningText).toContain("Previous independent plan check:\nExact previous plan check: 审查结论\nVERDICT: carry-out");
      expect(planningText).toContain("Previous execution report:\nExact previous execution report: 执行修改");
      expect(planningText).toContain("Previous independent execution audit:\nExact previous execution audit: 独立审计\nVERDICT: revise");
      expect(planningText).toContain("cmd-prev-1\ncmd-prev-2");

      // Check review command also carries full context
      const reviewPromptText = state.commands[1]?.initialMessage.text ?? "";
      expect(reviewPromptText).toContain("Original goal:\nRoot original goal with CJK 中文 and Emoji 🚀");
      expect(reviewPromptText).toContain("Current follow-up:\nCurrent follow-up with Japanese 日本語 and Emoji 🎯");
      expect(reviewPromptText).toContain("The planner's done-claim is not a pass.");
    });

    it("handles empty followUp by explicitly emitting (no additional instruction)", () => {
      const continuation: SavedTargetContinuation = {
        parentRequestId: "req-parent-empty",
        rootRequestId: "req-root-empty",
        originalGoal: "Standalone original goal",
        followUp: "",
      };

      const state = coordinateGoal({
        goal: continuation.originalGoal,
        workspacePath,
        sendKey: "send-empty-fu",
        catalog,
        continuation,
      });

      expect(state.commands).toHaveLength(2);
      const planningText = state.commands[0]?.initialMessage.text ?? "";
      expect(planningText).toContain("Original goal:\nStandalone original goal");
      expect(planningText).toContain("Current follow-up:\n(no additional instruction)");

      const reviewPromptText = state.commands[1]?.initialMessage.text ?? "";
      expect(reviewPromptText).toContain("Original goal:\nStandalone original goal");
      expect(reviewPromptText).toContain("Current follow-up:\n(no additional instruction)");
    });

    it("refuses continuation when combined characters exceed 100,000 without returning role commands", () => {
      const continuation: SavedTargetContinuation = {
        parentRequestId: "req-parent-toolong",
        rootRequestId: "req-root-toolong",
        originalGoal: "a".repeat(60_000),
        followUp: "b".repeat(40_001),
      };

      const state = coordinateGoal({
        goal: continuation.originalGoal,
        workspacePath,
        sendKey: "send-overflow",
        catalog,
        continuation,
      });

      expect(state.roles).toHaveLength(0);
      expect(state.commands).toHaveLength(0);
      expect(state.stopReason).toContain("The combined character length of the original goal and follow-up exceeds 100,000 characters");
      expect(state.stopReason).toContain("no turn was sent");
    });

    it("refuses continuation when assembled planning or review prompt exceeds 100,000 UTF-8 bytes without returning role commands", () => {
      // Multibyte CJK characters: 3 bytes each in UTF-8
      // 35,000 characters * 3 = 105,000 bytes > 100,000 bytes limit, while char count 35,000 <= 100,000
      const continuation: SavedTargetContinuation = {
        parentRequestId: "req-parent-utf8",
        rootRequestId: "req-root-utf8",
        originalGoal: "字".repeat(34_000),
        followUp: "词".repeat(1_000),
      };

      const state = coordinateGoal({
        goal: continuation.originalGoal,
        workspacePath,
        sendKey: "send-utf8-overflow",
        catalog,
        continuation,
      });

      expect(state.roles).toHaveLength(0);
      expect(state.commands).toHaveLength(0);
      expect(state.stopReason).toContain("assembled continuation prompt exceeded the 100,000-byte limit");
      expect(state.stopReason).toContain("no turn was sent");
    });

    it("legacy absent descriptor prompt behavior remains completely unchanged", () => {
      const state = coordinateGoal({
        goal: "Legacy goal text without continuation",
        workspacePath,
        sendKey: "send-legacy",
        catalog,
      });

      expect(state.commands).toHaveLength(2);
      const planningText = state.commands[0]?.initialMessage.text ?? "";
      expect(planningText.startsWith("Legacy goal text without continuation\n")).toBe(true);
      expect(planningText).not.toContain("Original goal:");
      expect(planningText).not.toContain("Current follow-up:");
    });
  });

  it.each([
    ["VERDICT: verified", "unconfirmed", "verified"],
    ["VERDICT: carry-out", "checked", "unconfirmed"],
    ["VERDICT: revise", "revise", "revise"],
    ["VERDICT: stop", "stopped", "stopped"],
    ["VERDICT: verified\nMore prose", "unconfirmed", "unconfirmed"],
    ["verified", "unconfirmed", "unconfirmed"],
  ])("keeps verdicts phase-specific: %s", (text, review, audit) => {
    expect(verdictFromReview(text)).toBe(review);
    expect(verdictFromAudit(text)).toBe(audit);
    expect(outcomeLabel("verified")).toBe("Changes verified");
  });
});

// Compatibility regression only, not UI or product execution acceptance.
it("marks only the background row current while that job is the view", () => {
  const viewing = renderToStaticMarkup(createElement(CampaignNav, {
    snapshot: DEMO_SNAPSHOT, collapsed: false,
    runningJob: { goal: "Keep the helper running", stateLabel: "Running", viewing: true },
    onSelectCampaign() {}, onSelectProject() {}, onRenameCampaign() {},
  }));
  expect(viewing.match(/campaign-active/g)).toHaveLength(1);
  expect(viewing).toContain("Keep the helper running");
  expect(viewing).not.toContain("Rename goal");
  const parked = renderToStaticMarkup(createElement(CampaignNav, {
    snapshot: DEMO_SNAPSHOT, collapsed: false,
    runningJob: { goal: "Keep the helper running", stateLabel: "Running", viewing: false },
    onSelectCampaign() {}, onSelectProject() {}, onRenameCampaign() {},
  }));
  expect(parked).toContain("campaign-active");
  expect(parked).toContain("Build a durable preview");
  expect(parked).not.toContain("Keep the helper running</strong></span><span class=\"active-arrow\"");
});

it("the approved nav type seam renders verified with the existing complete class and outcome label", () => {
  const html = renderToStaticMarkup(createElement(CampaignNav, {
    snapshot: EMPTY_SNAPSHOT, collapsed: false,
    plans: [{ requestId: "verified-type-seam", title: "Verified type seam", active: false, verdict: "verified" }],
    onSelectCampaign() {}, onSelectProject() {}, onRenameCampaign() {},
  }));
  expect(html).toContain('aria-label="Plan: Verified type seam, Changes verified"');
  expect(html).toContain('class="campaign-state campaign-state-complete"');
  expect(html).toContain('<small>Changes verified</small>');
});
