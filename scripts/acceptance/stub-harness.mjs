#!/usr/bin/env node
// Offline acceptance CLI used only behind the generated codex/claude wrappers.
// Corpus provenance is pinned to electron/cli-coordinate.test.cjs fixtures.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const IDENTITIES = Object.freeze(["codex", "claude"]);
const LOG_FILE = "invocations.jsonl";
const BEHAVIOR_FILE = "behavior.json";
const SENTINEL_ENV = "GOALPORT_STUB_SENTINEL";
const STUB_DIR_ENV = "GOALPORT_STUB_DIR";

// These are the response bodies used by GoalPort's real probes and
// normalizers. Turn fixture strings below are copied from
// electron/cli-coordinate.test.cjs (references are asserted in stub-harness.test.mjs).
const DIAGNOSTIC_STDOUT = "{\"type\": \"thread.started\", \"thread_id\": \"01a11e93-bded-7ee3-919e-9f38d019ba92\"}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_0\", \"type\": \"error\", \"message\": \"Under-development features enabled: local_thread_store_compression. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in C:\\\\Users\\\\user\\\\.codex\\\\config.toml.\"}}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_1\", \"type\": \"error\", \"message\": \"Configured service tier `standard` is not advertised as supported for model `gpt-6.1-sol` and will be omitted from requests.\"}}\n{\"type\": \"turn.started\"}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_2\", \"type\": \"agent_message\", \"text\": \"I’ll read the root AGENTS.md and quote its first heading.\\n\"}}\n{\"type\": \"item.started\", \"item\": {\"id\": \"item_3\", \"type\": \"command_execution\", \"command\": \"\\\"C:\\\\\\\\Users\\\\\\\\user\\\\\\\\AppData\\\\\\\\Local\\\\\\\\Microsoft\\\\\\\\WindowsApps\\\\\\\\pwsh.exe\\\" -Command \\\"Get-Content -LiteralPath 'C:\\\\\\\\Files\\\\\\\\goalport\\\\\\\\AGENTS.md' -TotalCount 12\\\"\", \"aggregated_output\": \"\", \"exit_code\": null, \"status\": \"in_progress\"}}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_3\", \"type\": \"command_execution\", \"command\": \"\\\"C:\\\\\\\\Users\\\\\\\\user\\\\\\\\AppData\\\\\\\\Local\\\\\\\\Microsoft\\\\\\\\WindowsApps\\\\\\\\pwsh.exe\\\" -Command \\\"Get-Content -LiteralPath 'C:\\\\\\\\Files\\\\\\\\goalport\\\\\\\\AGENTS.md' -TotalCount 12\\\"\", \"aggregated_output\": \"Failed to create unified exec process: helper_unknown_error: setup refresh had errors\", \"exit_code\": -1, \"status\": \"failed\"}}\n{\"type\": \"item.started\", \"item\": {\"id\": \"item_4\", \"type\": \"mcp_tool_call\", \"server\": \"node_repl\", \"tool\": \"js\", \"arguments\": {\"code\": \"var fs = await import('node:fs/promises'); var content = await fs.readFile('C:/Files/goalport/AGENTS.md', 'utf8'); nodeRepl.write(content.split(/\\\\r?\\\\n/).find(line => /^#{1,6}\\\\s/.test(line)));\", \"title\": \"Read first heading of AGENTS.md\"}, \"result\": null, \"error\": null, \"status\": \"in_progress\"}}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_4\", \"type\": \"mcp_tool_call\", \"server\": \"node_repl\", \"tool\": \"js\", \"arguments\": {\"code\": \"var fs = await import('node:fs/promises'); var content = await fs.readFile('C:/Files/goalport/AGENTS.md', 'utf8'); nodeRepl.write(content.split(/\\\\r?\\\\n/).find(line => /^#{1,6}\\\\s/.test(line)));\", \"title\": \"Read first heading of AGENTS.md\"}, \"result\": {\"content\": [{\"type\": \"text\", \"text\": \"trusted Node process exited unexpectedly; kernel reset, rerun your request\"}], \"structured_content\": null}, \"error\": null, \"status\": \"failed\"}}\n{\"type\": \"item.started\", \"item\": {\"id\": \"item_5\", \"type\": \"mcp_tool_call\", \"server\": \"node_repl\", \"tool\": \"js\", \"arguments\": {\"code\": \"var fs = await import('node:fs/promises'); var content = await fs.readFile('C:/Files/goalport/AGENTS.md', 'utf8'); nodeRepl.write(content.split(/\\\\r?\\\\n/).find(line => /^#{1,6}\\\\s/.test(line)));\", \"title\": \"Read AGENTS.md heading\"}, \"result\": null, \"error\": null, \"status\": \"in_progress\"}}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_5\", \"type\": \"mcp_tool_call\", \"server\": \"node_repl\", \"tool\": \"js\", \"arguments\": {\"code\": \"var fs = await import('node:fs/promises'); var content = await fs.readFile('C:/Files/goalport/AGENTS.md', 'utf8'); nodeRepl.write(content.split(/\\\\r?\\\\n/).find(line => /^#{1,6}\\\\s/.test(line)));\", \"title\": \"Read AGENTS.md heading\"}, \"result\": {\"content\": [{\"type\": \"text\", \"text\": \"node_repl kernel exited unexpectedly\\n\\nnode_repl diagnostics: {\\\"kernel_pid\\\":18040,\\\"kernel_status\\\":\\\"exited(code=1)\\\",\\\"kernel_stderr_tail\\\":\\\"windows sandbox failed: helper_unknown_error: setup refresh had errors\\\",\\\"reason\\\":\\\"stdout_eof\\\",\\\"stream_error\\\":null}\"}], \"structured_content\": null}, \"error\": null, \"status\": \"failed\"}}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_6\", \"type\": \"agent_message\", \"text\": \"I couldn’t read the file because the sandbox failed to initialize. The AGENTS.md text supplied in your message starts with:\\n\\n```text\\n# Codex adapter for shared owner policy\\n```\\n\\nNo files were created, modified, or deleted.\"}}\n{\"type\": \"turn.completed\", \"usage\": {\"input_tokens\": 154539, \"cached_input_tokens\": 118784, \"cache_write_input_tokens\": 0, \"output_tokens\": 388, \"reasoning_output_tokens\": 17}}";

export const STUB_BEHAVIORS = Object.freeze({
  "codex-probe-authenticated": Object.freeze({
    kind: "probe",
    exitCode: 0,
    stdout: "Logged in using ChatGPT (goalport-stub)\n",
    stderr: "",
  }),
  "codex-probe-unavailable": Object.freeze({ kind: "probe", exitCode: 1, stdout: "Not logged in\n", stderr: "" }),
  "claude-probe-authenticated": Object.freeze({
    kind: "probe",
    exitCode: 0,
    stdout: "{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\"}\n",
    stderr: "",
  }),
  "claude-probe-unavailable": Object.freeze({
    kind: "probe",
    exitCode: 1,
    stdout: "{\"loggedIn\":false,\"authMethod\":\"claude.ai\"}\n",
    stderr: "",
  }),
  "codex-success": Object.freeze({
    kind: "turn",
    exitCode: 0,
    stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Bounded plan."}}\n',
    stderr: "",
  }),
  "claude-success": Object.freeze({
    kind: "turn",
    exitCode: 0,
    stdout: '{"type":"result","result":"Stop.\\nVERDICT: stop","is_error":false}',
    stderr: "",
  }),
  "claude-review-success": Object.freeze({
    kind: "turn",
    exitCode: 0,
    stdout: '{"type":"result","result":"Needs a smaller step.\\nVERDICT: revise","is_error":false}',
    stderr: "",
  }),
  "claude-carry-out": Object.freeze({
    kind: "turn", exitCode: 0,
    stdout: '{"type":"result","result":"The plan can be carried out.\\nVERDICT: carry-out","is_error":false}', stderr: "",
  }),
  "claude-carry-out-delayed": Object.freeze({
    kind: "turn", exitCode: 0, delayMs: 6000,
    stdout: '{"type":"result","result":"The plan can be carried out.\\nVERDICT: carry-out","is_error":false}', stderr: "",
  }),
  "claude-no-text": Object.freeze({ kind: "turn", exitCode: 0, stdout: "", stderr: "" }),
  "codex-tool-success": Object.freeze({
    kind: "turn",
    exitCode: 0,
    stdout: [
      '{"type":"item.completed","item":{"type":"command_execution","command":"ls","aggregated_output":"AGENTS.md","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Bounded plan."}}',
    ].join("\n") + "\n",
    stderr: "",
  }),
  "codex-environment-blocked": Object.freeze({ kind: "turn", exitCode: 0, stdout: DIAGNOSTIC_STDOUT, stderr: "" }),
  "codex-no-text": Object.freeze({ kind: "turn", exitCode: 0, stdout: "", stderr: "" }),
  "codex-not-finished": Object.freeze({
    kind: "turn",
    exitCode: 1,
    stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\n',
    stderr: "",
  }),
  "claude-is-error": Object.freeze({
    kind: "turn",
    exitCode: 1,
    stdout: '{"result":"Model refused.","is_error":true}',
    stderr: "",
  }),
  "claude-stderr-environment-fallback": Object.freeze({
    kind: "turn",
    exitCode: 1,
    stdout: '{"result":"partial","is_error":false}',
    stderr: "ERROR windows sandbox failed: helper_unknown_error",
  }),
  "claude-usage-limit": Object.freeze({ kind: "turn", exitCode: 1, stdout: "", stderr: "usage limit reached" }),
});

function isProbe(identity, argv) {
  return identity === "codex"
    ? argv.length === 2 && argv[0] === "login" && argv[1] === "status"
    : argv.length === 3 && argv[0] === "auth" && argv[1] === "status" && argv[2] === "--json";
}

function normalizeBehavior(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("behavior must be an object");
  const probes = {};
  const turns = {};
  for (const identity of IDENTITIES) {
    const probeId = input.probes?.[identity];
    if (typeof probeId !== "string" || !probeId.startsWith(`${identity}-probe-`) || STUB_BEHAVIORS[probeId]?.kind !== "probe") {
      throw new Error(`behavior.probes.${identity} must name a known ${identity} probe response`);
    }
    probes[identity] = probeId;
    const queue = input.turns?.[identity];
    if (!Array.isArray(queue) || queue.some((behaviorId) => typeof behaviorId !== "string" || !behaviorId.startsWith(`${identity}-`) || STUB_BEHAVIORS[behaviorId]?.kind !== "turn")) {
      throw new Error(`behavior.turns.${identity} must be an ordered queue of known turn responses`);
    }
    turns[identity] = [...queue];
  }
  return { probes, turns };
}

function readBehavior(stubDir) {
  const config = JSON.parse(fs.readFileSync(path.join(stubDir, BEHAVIOR_FILE), "utf8"));
  if (config?.schemaVersion !== 1 || typeof config.sentinel !== "string" || !config.sentinel || typeof config.queueEpoch !== "string" || !config.queueEpoch) {
    throw new Error("behavior file has an unsupported or incomplete header");
  }
  return { ...normalizeBehavior(config), sentinel: config.sentinel, queueEpoch: config.queueEpoch };
}

function queueIndex(stubDir, identity, queueEpoch) {
  const filename = path.join(stubDir, LOG_FILE);
  let lines = "";
  try {
    lines = fs.readFileSync(filename, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let count = 0;
  for (const line of lines.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.identity === identity && entry.invocationType === "turn" && entry.consumesQueue === true && entry.queueEpoch === queueEpoch) count += 1;
    } catch {
      // Ignore a partial/torn tail; appends made by this harness are one JSON line.
    }
  }
  return count;
}

function safeLogText(value) {
  return String(value)
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[REDACTED]")
    .replace(/([?&](?:key|token|secret)=)[^&\s]+/gi, "$1[REDACTED]");
}

function safeArgv(argv, invocationType) {
  const sanitized = argv.map(safeLogText);
  // The last argument to both pinned turnSpec variants is user-authored text.
  // Preserve argv shape and flags but never put prompt contents into the log.
  if (invocationType === "turn" && sanitized.length > 0) sanitized[sanitized.length - 1] = "[redacted prompt]";
  return sanitized;
}

function appendInvocation(stubDir, entry) {
  fs.appendFileSync(path.join(stubDir, LOG_FILE), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function main(argv = process.argv.slice(2)) {
  const [identity, ...cliArgv] = argv;
  if (!IDENTITIES.includes(identity)) {
    process.stderr.write("GoalPort acceptance stub refused invocation: wrapper identity is invalid.\n");
    process.exitCode = 42;
    return;
  }
  const stubDir = process.env[STUB_DIR_ENV];
  if (!stubDir) {
    process.stderr.write("GoalPort acceptance stub refused invocation: stub directory is not configured.\n");
    process.exitCode = 42;
    return;
  }
  let config;
  try {
    config = readBehavior(stubDir);
  } catch {
    process.stderr.write("GoalPort acceptance stub refused invocation: behavior file is missing or invalid.\n");
    process.exitCode = 42;
    return;
  }
  const invocationType = isProbe(identity, cliArgv) ? "probe" : "turn";
  const hasSentinel = typeof process.env[SENTINEL_ENV] === "string" && process.env[SENTINEL_ENV] === config.sentinel;
  if (!hasSentinel) {
    appendInvocation(stubDir, {
      ts: new Date().toISOString(),
      identity,
      invocationType,
      argv: safeArgv(cliArgv, invocationType),
      cwd: safeLogText(process.cwd()),
      behaviorId: "sentinel-refused",
      queueEpoch: invocationType === "turn" ? config.queueEpoch : null,
      queueIndex: null,
      consumesQueue: false,
    });
    process.stderr.write("GoalPort acceptance stub refused invocation: sentinel missing or mismatched.\n");
    process.exitCode = 42;
    return;
  }

  const index = invocationType === "turn" ? queueIndex(stubDir, identity, config.queueEpoch) : null;
  const behaviorId = invocationType === "probe" ? config.probes[identity] : config.turns[identity][index];
  const behavior = STUB_BEHAVIORS[behaviorId];
  if (!behavior) {
    appendInvocation(stubDir, {
      ts: new Date().toISOString(),
      identity,
      invocationType,
      argv: safeArgv(cliArgv, invocationType),
      cwd: safeLogText(process.cwd()),
      behaviorId: "turn-queue-exhausted",
      queueEpoch: invocationType === "turn" ? config.queueEpoch : null,
      queueIndex: index,
      consumesQueue: false,
    });
    process.stderr.write(`GoalPort acceptance stub has no ${identity} ${invocationType} behavior queued.\n`);
    process.exitCode = 43;
    return;
  }

  appendInvocation(stubDir, {
    ts: new Date().toISOString(),
    identity,
    invocationType,
    argv: safeArgv(cliArgv, invocationType),
    cwd: safeLogText(process.cwd()),
    behaviorId,
    queueEpoch: invocationType === "turn" ? config.queueEpoch : null,
    queueIndex: index,
    consumesQueue: invocationType === "turn",
  });
  // A fixed, bounded offline delay makes real-window progress observable.
  if (behavior.delayMs) await new Promise(resolve => setTimeout(resolve, behavior.delayMs));
  if (behavior.stdout) process.stdout.write(behavior.stdout);
  if (behavior.stderr) process.stderr.write(behavior.stderr);
  process.exitCode = behavior.exitCode;
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryPath === import.meta.url) await main();

export { normalizeBehavior, DIAGNOSTIC_STDOUT };
