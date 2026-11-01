import assert from "node:assert/strict";
import test from "node:test";
import { runtimeProbeCommand } from "./runtime-probe-command.mjs";

const root = "/workspace with spaces";
const syntheticRoot = "/workspace with spaces/fixtures/runtime/non-git";
const task = "Reply exactly GOALPORT_RUNTIME_OK. Do not use tools, read or write files, access the network, or perform any external action.";

test("Codex send runs the synthetic task read-only and ephemeral in the fixture", () => {
  const invocation = { command: "node", prefix: ["/runtime tools/codex.js"] };
  assert.deepEqual(runtimeProbeCommand({ provider: "codex", executable: "codex", invocation, name: "send", syntheticRoot, root }), {
    argvClass: "codex.synthetic-exec",
    command: "node",
    args: ["/runtime tools/codex.js", "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--cd", ".", task],
    cwd: syntheticRoot
  });
});

test("Grok send uses a bounded headless structured turn in the fixture", () => {
  const invocation = { command: "grok", prefix: [] };
  assert.deepEqual(runtimeProbeCommand({ provider: "grok", executable: "grok", invocation, name: "send", syntheticRoot, root }), {
    argvClass: "grok.synthetic-headless",
    command: "grok",
    args: ["-p", task, "--output-format", "streaming-json", "--max-turns", "1", "--no-subagents", "--disable-web-search"],
    cwd: syntheticRoot
  });
});

test("Claude send uses process cwd and a single structured turn", () => {
  const invocation = { command: "claude", prefix: [] };
  assert.deepEqual(runtimeProbeCommand({ provider: "claude", executable: "claude", invocation, name: "send", syntheticRoot, root }), {
    argvClass: "claude.synthetic-print",
    command: "claude",
    args: ["-p", task, "--output-format", "stream-json", "--max-turns", "1", "--verbose"],
    cwd: syntheticRoot
  });
});

for (const [provider, args] of [
  ["codex", ["app-server", "--help"]],
  ["grok", ["agent", "--help"]],
  ["claude", ["--help"]]
]) {
  test(`${provider} capability probes keep their help command and workspace cwd`, () => {
    const invocation = { command: provider, prefix: [] };
    for (const name of ["approval", "cancel", "resume", "native-config", "adapter-exit", "connection-owner"]) {
      assert.deepEqual(runtimeProbeCommand({ provider, executable: provider, invocation, name, syntheticRoot, root }), {
        argvClass: `${provider}.${name}-capability-probe`,
        command: provider,
        args,
        cwd: root
      });
    }
  });
}
