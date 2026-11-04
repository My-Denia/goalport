const { test } = require("node:test");
const assert = require("node:assert/strict");
const { turnSpec } = require("./cli-coordinate.cjs");

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
