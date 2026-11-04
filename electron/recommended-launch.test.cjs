const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { turnSpec, runCliTurn } = require("./cli-coordinate.cjs");

// Today's Recommended launch commands (no resource preference), recorded as
// literals. A later change that adds optional launch flags must not move any
// of these bytes.
function turn(instanceId, model, { writes = false, provider } = {}) {
  return {
    commandId: `coordinate-${writes ? "execute" : "plan"}-${instanceId}`,
    type: "goalport.coordinateTurn",
    modelSelection: { instanceId, model, ...(provider ? { provider } : {}) },
    runtimeMode: "approval-required",
    approvalPolicy: "never",
    sandboxPolicy: { type: writes ? "workspaceWrite" : "readOnly" },
    workspaceStrategy: { type: "existing_worktree", worktreePath: "/work/goal" },
    initialMessage: { text: "Do it." },
  };
}

test("Recommended launch commands for Codex, Claude and Pi are pinned", () => {
  assert.deepEqual(turnSpec(turn("codex", "gpt-6.1-sol"), {}, "linux"), {
    file: "codex", cwd: "/work/goal",
    args: ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", "/work/goal", "Do it."],
  });
  assert.deepEqual(turnSpec(turn("codex", "gpt-6.1-sol", { writes: true }), {}, "linux"), {
    file: "codex", cwd: "/work/goal",
    args: ["exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--skip-git-repo-check", "--cd", "/work/goal", "Do it."],
  });
  assert.deepEqual(turnSpec(turn("claude", "opus"), {}, "linux"), {
    file: "claude", cwd: "/work/goal",
    args: ["-p", "--output-format", "json", "--permission-mode", "plan", "--permission-prompts", "none", "--model", "opus", "Do it."],
  });
  assert.deepEqual(turnSpec(turn("claude", "opus", { writes: true }), {}, "linux"), {
    file: "claude", cwd: "/work/goal",
    args: ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--model", "opus", "Do it."],
  });
  assert.deepEqual(turnSpec(turn("pi", "alpha", { provider: "Fixture" }), {}, "linux"), {
    file: "pi", cwd: "/work/goal",
    args: ["-p", "--no-session", "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "-na", "--no-tools", "--mode", "text", "--provider", "Fixture", "--model", "alpha", "Do it."],
  });
  assert.deepEqual(turnSpec(turn("pi", "default"), {}, "linux"), {
    file: "pi", cwd: "/work/goal",
    args: ["-p", "--no-session", "--no-context-files", "--no-extensions", "--no-mcp", "--no-skills", "-na", "--no-tools", "--mode", "text", "Do it."],
  });
});

const { RESOURCE_LAUNCH } = require("./workflow-checks.mjs");
const withEffort = (base, effort, extra = {}) => ({ ...base, modelSelection: { ...base.modelSelection, ...extra, effort } });

test("a resource preference adds fixed literals before the prompt and nothing else", () => {
  const codex = turn("codex", "gpt-6.1-sol");
  assert.deepEqual(turnSpec(withEffort(codex, "faster"), {}, "linux").args, [
    "exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", "/work/goal", "-c", 'model_reasoning_effort="low"', "Do it."]);
  assert.deepEqual(turnSpec(withEffort(turn("codex", "gpt-6.1-sol", { writes: true }), "stronger"), {}, "linux").args, [
    "exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--skip-git-repo-check", "--cd", "/work/goal", "-c", 'model_reasoning_effort="high"', "Do it."]);
  assert.deepEqual(turnSpec(withEffort(turn("claude", "sonnet"), "faster"), {}, "linux").args,
    ["-p", "--output-format", "json", "--permission-mode", "plan", "--permission-prompts", "none", "--model", "sonnet", "Do it."]);
  assert.deepEqual(turnSpec(withEffort(turn("claude", "opus", { writes: true }), "stronger"), {}, "linux").args,
    ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--model", "opus", "--effort", "high", "Do it."]);
  const piPlain = turnSpec(withEffort(turn("pi", "default"), "faster"), {}, "linux").args;
  assert.deepEqual(piPlain, [...turnSpec(turn("pi", "default"), {}, "linux").args.slice(0, -1), "--thinking", "low", "Do it."]);
  const piRoute = turnSpec(withEffort(turn("pi", "alpha", { provider: "Fixture" }), "stronger"), {}, "linux").args;
  assert.deepEqual(piRoute, [...turnSpec(turn("pi", "alpha", { provider: "Fixture" }), {}, "linux").args.slice(0, -1), "--thinking", "high", "Do it."]);
  assert.equal(RESOURCE_LAUNCH.codex.faster.effort, "low");
});

test("an unknown preference, or a claude swap that does not match its model, is refused unsent", () => {
  for (const bad of ["turbo", null, "", "FASTER", {}, 1]) {
    for (const base of [turn("codex", "gpt-6.1-sol"), turn("claude", "opus"), turn("pi", "default")]) {
      const spec = turnSpec({ ...base, modelSelection: { ...base.modelSelection, effort: bad } }, {}, "linux");
      assert.equal(typeof spec.errorText, "string");
      assert.equal(spec.file, undefined);
    }
  }
  assert.ok(turnSpec(withEffort(turn("claude", "opus"), "faster"), {}, "linux").errorText);
  assert.ok(turnSpec(withEffort(turn("claude", "sonnet"), "stronger"), {}, "linux").errorText);
  assert.ok(turnSpec(withEffort(turn("claude", "fable-1"), "faster"), {}, "linux").errorText);
  assert.equal(turnSpec({ ...turn("codex", "gpt-6.1-sol"), modelSelection: { instanceId: "codex", model: "gpt-6.1-sol", effort: undefined } }, {}, "linux").args.includes("-c"), false);
});

// The send gate itself, not just turnSpec: the grant, the guards, the claim and
// the admitted Pi route all see a command that carries the extra key.
async function sentArgv(command, options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-effort-gate-"));
  try {
    fs.writeFileSync(path.join(stateDir, "send-authorization"), `${command.commandId}\n`);
    let spawned = null;
    const result = await runCliTurn(command, {
      stateDir, ...options,
      spawnTurn: async (spec) => { spawned = spec; return { code: 0, stdout: options.stdout ?? "Plan text" }; },
    });
    return { result, spawned };
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
}

test("a preference goes through the send gate for Codex and Claude and lands in the launched argv", async () => {
  const codex = await sentArgv(withEffort(turn("codex", "gpt-6.1-sol"), "faster"), { stdout: JSON.stringify({ item: { type: "agent_message", text: "Plan text" } }) });
  assert.equal(codex.result.messageDispatched, true);
  assert.deepEqual(codex.spawned.args.slice(-3), ["-c", 'model_reasoning_effort="low"', "Do it."]);
  const claude = await sentArgv(withEffort(turn("claude", "opus"), "stronger"), { stdout: JSON.stringify({ result: "Plan text", is_error: false }) });
  assert.equal(claude.result.messageDispatched, true);
  assert.deepEqual(claude.spawned.args.slice(-5), ["--model", "opus", "--effort", "high", "Do it."]);
});

test("a Pi turn on the admitted route accepts a preference and launches with the thinking level", async () => {
  const pair = { provider: "Fixture", model: "alpha", useExistingCapacity: true };
  const table = "provider model context max-out thinking images\nFixture alpha 128K 16K yes yes\n";
  const command = withEffort(turn("pi", "alpha", { provider: "Fixture" }), "faster");
  const { result, spawned } = await sentArgv(command, { piCapacity: pair, env: { PATH: "" }, metadataExec: async () => ({ code: 0, stdout: table }), stdout: "Checked" });
  assert.equal(result.errorText, "");
  assert.equal(result.messageDispatched, true);
  assert.deepEqual(spawned.args.slice(-7), ["--provider", "Fixture", "--model", "alpha", "--thinking", "low", "Do it."]);
});
