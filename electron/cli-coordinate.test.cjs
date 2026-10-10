const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverCliProviders, runCliTurn, codexReply, codexEnvironmentBlocked, codexToolSuccess, claudeReply, turnSpec, launchSpec, killProcessTree, defaultExec, writeGrant } = require("./cli-coordinate.cjs");
const { readHealth, markBlocked } = require("./harness-health.cjs");

function command(instanceId, model, commandId = `coordinate-plan-${instanceId}`) {
  return {
    commandId,
    type: "goalport.coordinateTurn",
    modelSelection: { instanceId, model },
    runtimeMode: "approval-required",
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
    workspaceStrategy: { type: "existing_worktree", worktreePath: "/work/goal" },
    initialMessage: { text: "Plan only." },
  };
}

test("installed subscription CLIs are visible without a checkout", async () => {
  const discovered = await discoverCliProviders({
    home: "/home/person",
    readFile(file) {
      assert.equal(file, path.join("/home/person", ".codex", "config.toml"));
      return 'model = "gpt-6.1-sol"\n';
    },
    execFile(file, args) {
      if (file === "codex") {
        assert.deepEqual(args, ["login", "status"]);
        return { stdout: "Logged in using ChatGPT\n" };
      }
      assert.equal(file, "claude");
      assert.deepEqual(args, ["auth", "status", "--json"]);
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "hidden@example.invalid" }) };
    },
  });
  assert.equal(discovered.ok, true);
  assert.deepEqual(discovered.providers.map((item) => item.instanceId), ["codex", "claude"]);
  assert.equal(discovered.providers[0].models[0].slug, "gpt-6.1-sol");
  assert.equal(discovered.providers[1].models[0].slug, "opus");
  assert.equal(JSON.stringify(discovered).includes("hidden@example.invalid"), false);
  assert.equal(JSON.stringify(discovered).includes("fable"), false);
});

test("Codex login status on stderr still counts as signed in", async () => {
  const discovered = await discoverCliProviders({
    home: "/home/person",
    readFile() {
      return 'model = "gpt-6.1-sol"\n';
    },
    execFile(file) {
      if (file === "codex") return { stdout: "", stderr: "Logged in using ChatGPT\n" };
      return { stdout: "", stderr: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }) };
    },
  });
  assert.deepEqual(discovered.providers.map((item) => item.instanceId), ["codex", "claude"]);
  assert.equal(discovered.providers[0].models[0].slug, "gpt-6.1-sol");
  assert.equal(discovered.providers[1].models[0].slug, "opus");
});

test("an API-key login is not given an included model", async () => {
  const discovered = await discoverCliProviders({
    home: "/home/person",
    readFile() {
      return 'model = "gpt-6.1-sol"\n';
    },
    execFile(file) {
      if (file === "codex") return { stdout: "Logged in using an API key\n" };
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: "apiKey" }) };
    },
  });
  assert.equal(discovered.providers[0].auth.type, "apiKey");
  assert.deepEqual(discovered.providers[0].models, []);
  assert.equal(discovered.providers[1].auth.type, "apiKey");
  assert.deepEqual(discovered.providers[1].models, []);
});

test("codex and claude replies keep the assistant text", () => {
  assert.equal(codexReply('{"type":"item.completed","item":{"type":"agent_message","text":"Bounded plan."}}\n'), "Bounded plan.");
  assert.equal(claudeReply('{"type":"result","result":"Needs a smaller step.\\nVERDICT: revise","is_error":false}').text, "Needs a smaller step.\nVERDICT: revise");
});

test("a granted command spawns once and a repeat returns the stored text", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-once-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\ncoordinate-review-claude\n");
  const spawned = [];
  const spawnTurn = async (spec) => {
    spawned.push(spec);
    const text = spec.file === "codex"
      ? '{"type":"item.completed","item":{"type":"agent_message","text":"Bounded plan."}}\n'
      : '{"type":"result","result":"Stop.\\nVERDICT: stop","is_error":false}';
    return { code: 0, stdout: text };
  };
  try {
    const plan = command("codex", "gpt-6.1-sol");
    const first = await runCliTurn(plan, { stateDir: directory, spawnTurn });
    const second = await runCliTurn(plan, { stateDir: directory, spawnTurn });
    const review = await runCliTurn(command("claude", "opus", "coordinate-review-claude"), { stateDir: directory, spawnTurn });
    const reviewAgain = await runCliTurn(command("claude", "opus", "coordinate-review-claude"), { stateDir: directory, spawnTurn });
    assert.equal(first.ok, true);
    assert.equal(first.text, "Bounded plan.");
    assert.equal(second.text, "Bounded plan.");
    assert.equal(review.text, "Stop.\nVERDICT: stop");
    assert.equal(reviewAgain.ok, true);
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned[0].args, ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", "/work/goal", "Plan only."]);
    assert.deepEqual(spawned[1].args, ["-p", "--output-format", "json", "--permission-mode", "plan", "--permission-prompts", "none", "--model", "opus", "Plan only."]);
    assert.equal(spawned[0].env.OPENAI_API_KEY, undefined);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-plan-codex")), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a missing grant and a credit model do not spawn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-grant-"));
  let spawned = 0;
  const spawnTurn = async () => {
    spawned += 1;
    return { code: 0, stdout: "nope" };
  };
  try {
    const missing = await runCliTurn(command("codex", "gpt-6.1-sol"), { stateDir: directory, spawnTurn });
    assert.match(missing.errorText, /not authorized/);
    fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\n");
    const credits = await runCliTurn(command("codex", "gpt-6-fable"), { stateDir: directory, spawnTurn });
    assert.match(credits.errorText, /extra usage credits/);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8").includes("coordinate-plan-codex"), true);
    assert.equal(spawned, 0);
    assert.equal(turnSpec(command("codex", "gpt-6.1-sol")).args.includes("--sandbox"), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a process that never starts can be tried once later, and a started turn cannot", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-retry-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\n");
  let calls = 0;
  try {
    const failed = await runCliTurn(command("codex", "gpt-6.1-sol"), {
      stateDir: directory,
      spawnTurn: async () => {
        calls += 1;
        return { spawnError: true };
      },
    });
    assert.match(failed.errorText, /not installed/);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8").includes("coordinate-plan-codex"), true);
    const started = await runCliTurn(command("codex", "gpt-6.1-sol"), {
      stateDir: directory,
      spawnTurn: async () => {
        calls += 1;
        return { code: 1, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\n' };
      },
    });
    assert.equal(started.ok, false);
    assert.equal(started.messageDispatched, true);
    const again = await runCliTurn(command("codex", "gpt-6.1-sol"), {
      stateDir: directory,
      spawnTurn: async () => {
        calls += 1;
        return { code: 0, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}\n' };
      },
    });
    assert.equal(again.text, "partial");
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a Windows cmd shim is quoted and launched through cmd.exe", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-"));
  try {
    fs.writeFileSync(path.join(directory, "codex"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(directory, "codex.cmd"), "@echo off\r\n");
    const spec = launchSpec("codex", ["login", "status"], {
      PATH: directory,
      PATHEXT: ".cmd",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    }, "win32");
    assert.equal(spec.file, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(spec.verbatim, true);
    assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.match(spec.args[3], /^".*codex\.cmd \^\^\^"login\^\^\^" \^\^\^"status\^\^\^""$/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a resolved cmd path with spaces survives the cmd.exe payload", () => {
  // Reproduction of the packaged-build blocker: /d /s /c strips the payload's
  // first and last quote, so quoting each element alone split the path at its
  // first space and ran the prompt tail as commands. The canonical payload
  // keeps the spaced path inert (careted space) inside one outer quote pair.
  const spaced = launchSpec("C:\\Program Files\\nodejs\\codex.cmd", ["exec", "say \"hello\" & stop"], {
    PATH: "/nonexistent",
    PATHEXT: ".cmd",
    ComSpec: "cmd.exe",
  }, "win32");
  assert.equal(spaced.file, "cmd.exe");
  assert.equal(spaced.verbatim, true);
  assert.equal(spaced.args[3], String.raw`"C:\Program^ Files\nodejs\codex.cmd ^^^"exec^^^" ^^^"say^^^ \^^^"hello\^^^"^^^ ^^^&^^^ stop^^^""`);
});

test("cmd metacharacters in a prompt stay arguments, never commands", () => {
  const hostile = launchSpec("C:\\spaced dir\\claude.cmd", ["-p", "--model", "opus", "goal & <risk> ^ \"q\" %PATH% tail"], {
    PATH: "/nonexistent",
    PATHEXT: ".cmd",
    ComSpec: "cmd.exe",
  }, "win32");
  assert.equal(hostile.args[3], String.raw`"C:\spaced^ dir\claude.cmd ^^^"-p^^^" ^^^"--model^^^" ^^^"opus^^^" ^^^"goal^^^ ^^^&^^^ ^^^<risk^^^>^^^ ^^^^^^^ \^^^"q\^^^"^^^ ^^^%PATH^^^%^^^ tail^^^""`);
});

test("cmd argument escaping doubles backslashes before quotes and at the end", () => {
  const spec = launchSpec("C:\\x\\codex.cmd", ["--cd", "C:\\work dir\\", "plain"], {
    PATH: "/nonexistent",
    PATHEXT: ".cmd",
    ComSpec: "cmd.exe",
  }, "win32");
  assert.equal(spec.args[3], String.raw`"C:\x\codex.cmd ^^^"--cd^^^" ^^^"C:\work^^^ dir\\^^^" ^^^"plain^^^""`);
  const empty = launchSpec("C:\\x\\codex.cmd", [""], {
    PATH: "/nonexistent",
    PATHEXT: ".cmd",
    ComSpec: "cmd.exe",
  }, "win32");
  assert.equal(empty.args[3], String.raw`"C:\x\codex.cmd ^^^"^^^""`);
});

test("discovery never blocks the Electron main thread synchronously", () => {
  const source = fs.readFileSync(path.join(__dirname, "cli-coordinate.cjs"), "utf8");
  assert.equal(source.includes("spawnSync"), false);
});

test("an async probe timeout rejects instead of hanging discovery", async () => {
  await assert.rejects(
    defaultExec(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 100 }),
    (error) => error.code === "ETIMEDOUT",
  );
});

test("an async probe with a nonzero exit still hands back its output", async () => {
  const result = await defaultExec(process.execPath, ["-e", "process.stdout.write('Logged in using ChatGPT\\n'); process.exit(3)"], { timeoutMs: 8000 });
  assert.match(result.stdout, /Logged in using ChatGPT/);
});

test("an async probe for a missing binary rejects", async () => {
  await assert.rejects(defaultExec("goalport-definitely-missing-binary", ["--version"], { timeoutMs: 8000 }));
});

test("a Windows cancellation terminates the whole process tree", () => {
  const calls = [];
  const spawnFn = (file, args) => {
    calls.push([file, args]);
    return { on() { /* the killer needs no events in this test */ } };
  };
  killProcessTree({ pid: 4242, kill() { calls.push(["direct-kill"]); } }, { platform: "win32", spawnFn });
  assert.deepEqual(calls, [[
    "taskkill",
    ["/T", "/F", "/PID", "4242"],
  ]]);
});

test("a Windows cancellation falls back to a direct kill if taskkill cannot start", () => {
  const kills = [];
  const spawnFn = () => ({
    on(event, handler) {
      if (event === "error") setImmediate(handler);
    },
  });
  killProcessTree({ pid: 99, kill() { kills.push("direct"); } }, { platform: "win32", spawnFn });
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.deepEqual(kills, ["direct"]);
      resolve();
    });
  });
});

test("a non-Windows cancellation keeps the direct kill", () => {
  const kills = [];
  const spawnFn = () => { throw new Error("taskkill must not spawn off Windows"); };
  killProcessTree({ pid: 7, kill(signal) { kills.push(signal); } }, { platform: "linux", spawnFn });
  killProcessTree({ pid: 8, kill(signal) { kills.push(signal); } }, { platform: "win32", spawnFn: () => ({
    on(event, handler) {
      if (event === "error") setImmediate(handler);
    },
  }) });
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.deepEqual(kills, ["SIGKILL", "SIGKILL"]);
      resolve();
    });
  });
});

test("a nonzero exit keeps the stderr reason next to the stop sentence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-stderr-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\n");
  try {
    const result = await runCliTurn(command("codex", "gpt-6.1-sol"), {
      stateDir: directory,
      spawnTurn: async () => ({
        code: 1,
        stdout: "",
        stderr: "loading config\nstream error: You are not logged in. Run codex login.\n",
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.errorText, /finished without any text/);
    assert.match(result.errorText, /You are not logged in\. Run codex login\./);
    assert.equal(result.text, "");
    assert.equal(result.messageDispatched, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, retryDelay: 100 });
  }
});

test("a clean stop without stderr keeps the generic sentence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-stderr-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\n");
  try {
    const result = await runCliTurn(command("codex", "gpt-6.1-sol"), {
      stateDir: directory,
      spawnTurn: async () => ({ code: 1, stdout: "" }),
    });
    assert.equal(result.errorText, "The harness finished without any text, so this stopped.");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, retryDelay: 100 });
  }
});

test("a ChatGPT login without an explicit model still names the built-in default", async () => {
  const discovered = await discoverCliProviders({
    home: "/home/person",
    readFile() {
      return "enable_experimental_thread_store_compression = true\n";
    },
    execFile(file) {
      if (file === "codex") return { stdout: "Logged in using ChatGPT\n" };
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }) };
    },
  });
  assert.equal(discovered.providers[0].models.length, 1);
  assert.equal(discovered.providers[0].models[0].slug, "default");
  assert.equal(discovered.providers[0].models[0].isDefault, true);
});

test("a single-quoted top-level model line is read", async () => {
  const discovered = await discoverCliProviders({
    home: "/home/person",
    readFile() {
      return "model = 'gpt-6.1-sol'\n";
    },
    execFile(file) {
      if (file === "codex") return { stdout: "Logged in using ChatGPT\n" };
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
    },
  });
  assert.equal(discovered.providers[0].models[0].slug, "gpt-6.1-sol");
});

// The captured diagnostic turn (goal-runs/goalport-pr26-blockers-codex-diag/
// evidence/diag/stdout.jsonl), with the username and home path redacted. The
// structure is byte-faithful: two config warnings, an honest intent, three
// failed tool calls (two carrying sandbox-helper signatures), and the model's
// honest final report. codex exits 0 on this turn.
const DIAGNOSTIC_STDOUT = "{\"type\": \"thread.started\", \"thread_id\": \"01a11e93-bded-7ee3-919e-9f38d019ba92\"}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_0\", \"type\": \"error\", \"message\": \"Under-development features enabled: local_thread_store_compression. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in C:\\\\Users\\\\user\\\\.codex\\\\config.toml.\"}}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_1\", \"type\": \"error\", \"message\": \"Configured service tier `standard` is not advertised as supported for model `gpt-6.1-sol` and will be omitted from requests.\"}}\n{\"type\": \"turn.started\"}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_2\", \"type\": \"agent_message\", \"text\": \"I’ll read the root AGENTS.md and quote its first heading.\\n\"}}\n{\"type\": \"item.started\", \"item\": {\"id\": \"item_3\", \"type\": \"command_execution\", \"command\": \"\\\"C:\\\\\\\\Users\\\\\\\\user\\\\\\\\AppData\\\\\\\\Local\\\\\\\\Microsoft\\\\\\\\WindowsApps\\\\\\\\pwsh.exe\\\" -Command \\\"Get-Content -LiteralPath 'C:\\\\\\\\Files\\\\\\\\goalport\\\\\\\\AGENTS.md' -TotalCount 12\\\"\", \"aggregated_output\": \"\", \"exit_code\": null, \"status\": \"in_progress\"}}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_3\", \"type\": \"command_execution\", \"command\": \"\\\"C:\\\\\\\\Users\\\\\\\\user\\\\\\\\AppData\\\\\\\\Local\\\\\\\\Microsoft\\\\\\\\WindowsApps\\\\\\\\pwsh.exe\\\" -Command \\\"Get-Content -LiteralPath 'C:\\\\\\\\Files\\\\\\\\goalport\\\\\\\\AGENTS.md' -TotalCount 12\\\"\", \"aggregated_output\": \"Failed to create unified exec process: helper_unknown_error: setup refresh had errors\", \"exit_code\": -1, \"status\": \"failed\"}}\n{\"type\": \"item.started\", \"item\": {\"id\": \"item_4\", \"type\": \"mcp_tool_call\", \"server\": \"node_repl\", \"tool\": \"js\", \"arguments\": {\"code\": \"var fs = await import('node:fs/promises'); var content = await fs.readFile('C:/Files/goalport/AGENTS.md', 'utf8'); nodeRepl.write(content.split(/\\\\r?\\\\n/).find(line => /^#{1,6}\\\\s/.test(line)));\", \"title\": \"Read first heading of AGENTS.md\"}, \"result\": null, \"error\": null, \"status\": \"in_progress\"}}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_4\", \"type\": \"mcp_tool_call\", \"server\": \"node_repl\", \"tool\": \"js\", \"arguments\": {\"code\": \"var fs = await import('node:fs/promises'); var content = await fs.readFile('C:/Files/goalport/AGENTS.md', 'utf8'); nodeRepl.write(content.split(/\\\\r?\\\\n/).find(line => /^#{1,6}\\\\s/.test(line)));\", \"title\": \"Read first heading of AGENTS.md\"}, \"result\": {\"content\": [{\"type\": \"text\", \"text\": \"trusted Node process exited unexpectedly; kernel reset, rerun your request\"}], \"structured_content\": null}, \"error\": null, \"status\": \"failed\"}}\n{\"type\": \"item.started\", \"item\": {\"id\": \"item_5\", \"type\": \"mcp_tool_call\", \"server\": \"node_repl\", \"tool\": \"js\", \"arguments\": {\"code\": \"var fs = await import('node:fs/promises'); var content = await fs.readFile('C:/Files/goalport/AGENTS.md', 'utf8'); nodeRepl.write(content.split(/\\\\r?\\\\n/).find(line => /^#{1,6}\\\\s/.test(line)));\", \"title\": \"Read AGENTS.md heading\"}, \"result\": null, \"error\": null, \"status\": \"in_progress\"}}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_5\", \"type\": \"mcp_tool_call\", \"server\": \"node_repl\", \"tool\": \"js\", \"arguments\": {\"code\": \"var fs = await import('node:fs/promises'); var content = await fs.readFile('C:/Files/goalport/AGENTS.md', 'utf8'); nodeRepl.write(content.split(/\\\\r?\\\\n/).find(line => /^#{1,6}\\\\s/.test(line)));\", \"title\": \"Read AGENTS.md heading\"}, \"result\": {\"content\": [{\"type\": \"text\", \"text\": \"node_repl kernel exited unexpectedly\\n\\nnode_repl diagnostics: {\\\"kernel_pid\\\":18040,\\\"kernel_status\\\":\\\"exited(code=1)\\\",\\\"kernel_stderr_tail\\\":\\\"windows sandbox failed: helper_unknown_error: setup refresh had errors\\\",\\\"reason\\\":\\\"stdout_eof\\\",\\\"stream_error\\\":null}\"}], \"structured_content\": null}, \"error\": null, \"status\": \"failed\"}}\n{\"type\": \"item.completed\", \"item\": {\"id\": \"item_6\", \"type\": \"agent_message\", \"text\": \"I couldn’t read the file because the sandbox failed to initialize. The AGENTS.md text supplied in your message starts with:\\n\\n```text\\n# Codex adapter for shared owner policy\\n```\\n\\nNo files were created, modified, or deleted.\"}}\n{\"type\": \"turn.completed\", \"usage\": {\"input_tokens\": 154539, \"cached_input_tokens\": 118784, \"cache_write_input_tokens\": 0, \"output_tokens\": 388, \"reasoning_output_tokens\": 17}}";

test("codexEnvironmentBlocked recognizes the captured diagnostic turn", () => {
  const detail = codexEnvironmentBlocked(DIAGNOSTIC_STDOUT);
  assert.ok(detail, "the diagnostic turn is environment-blocked");
  assert.match(detail, /helper_unknown_error/);
});

test("a turn with a successful tool call is not environment-blocked", () => {
  const stdout = [
    '{"type":"item.completed","item":{"type":"command_execution","command":"ls","aggregated_output":"AGENTS.md","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"type":"command_execution","command":"grep x","aggregated_output":"helper_unknown_error in a doc","exit_code":0,"status":"completed"}}',
  ].join("\n");
  assert.equal(codexEnvironmentBlocked(stdout), null);
});

test("failed tool calls without a signature are not environment-blocked", () => {
  const stdout = [
    '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"node_repl","tool":"js","result":{"content":[{"type":"text","text":"trusted Node process exited unexpectedly; kernel reset, rerun your request"}]},"status":"failed"}}',
  ].join("\n");
  assert.equal(codexEnvironmentBlocked(stdout), null);
});

test("a turn with no tool events is not environment-blocked", () => {
  const stdout = '{"type":"item.completed","item":{"type":"agent_message","text":"Bounded plan."}}\n';
  assert.equal(codexEnvironmentBlocked(stdout), null);
});

test("an environment-blocked turn fails with the machine sentence, stays dispatched, and is never respawned", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-env-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\n");
  let spawns = 0;
  const spawnTurn = async () => {
    spawns += 1;
    return { code: 0, stdout: DIAGNOSTIC_STDOUT, stderr: "" };
  };
  try {
    const first = await runCliTurn(command("codex", "gpt-6.1-sol"), { stateDir: directory, spawnTurn });
    assert.equal(first.ok, false);
    assert.equal(first.environmentBlocked, true);
    assert.equal(first.messageDispatched, true);
    assert.match(first.text, /sandbox failed to initialize/);
    assert.equal(first.errorText, "This harness cannot run its tools on this machine, so this stopped.");
    assert.match(first.environmentDetail, /helper_unknown_error/);
    assert.ok(first.environmentDetail.length <= 300);
    // The quota was spent, so the grant is consumed and the claim persists.
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-plan-codex")), true);
    // A repeat of the same command id replays the stored result, never a new turn.
    const second = await runCliTurn(command("codex", "gpt-6.1-sol"), { stateDir: directory, spawnTurn });
    assert.equal(second.ok, false);
    assert.equal(second.environmentBlocked, true);
    assert.equal(second.environmentDetail, first.environmentDetail);
    assert.equal(spawns, 1);
    const ledger = JSON.parse(fs.readFileSync(path.join(directory, "sent-turns.json"), "utf8"));
    assert.equal(ledger["coordinate-plan-codex"].environmentBlocked, true);
    assert.match(ledger["coordinate-plan-codex"].environmentDetail, /helper_unknown_error/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a claude turn never reports environment blocking even with a signature on stderr", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-env-claude-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-review-claude\n");
  try {
    const ran = await runCliTurn(command("claude", "opus", "coordinate-review-claude"), {
      stateDir: directory,
      spawnTurn: async () => ({
        code: 1,
        stdout: '{"result":"partial","is_error":false}',
        stderr: "ERROR windows sandbox failed: helper_unknown_error",
      }),
    });
    assert.equal(ran.environmentBlocked, undefined);
    assert.match(ran.errorText, /helper_unknown_error/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("an environment-blocked turn leaves a health record for its instance", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-health-env-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\n");
  try {
    const result = await runCliTurn(command("codex", "gpt-6.1-sol"), {
      stateDir: directory,
      spawnTurn: async () => ({ code: 0, stdout: DIAGNOSTIC_STDOUT, stderr: "" }),
    });
    assert.equal(result.environmentBlocked, true);
    const health = readHealth(directory);
    assert.deepEqual(Object.keys(health), ["codex"]);
    assert.equal(health.codex.commandId, "coordinate-plan-codex");
    assert.equal(typeof health.codex.blockedAt, "string");
    assert.equal(Number.isNaN(Date.parse(health.codex.blockedAt)), false);
    assert.ok(health.codex.detail.length <= 300);
    assert.match(health.codex.detail, /helper_unknown_error/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a failing turn whose stderr tail carries a proven signature marks claude too", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-health-stderr-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-review-claude\n");
  try {
    const result = await runCliTurn(command("claude", "opus", "coordinate-review-claude"), {
      stateDir: directory,
      spawnTurn: async () => ({
        code: 1,
        stdout: "",
        stderr: "setup\nwindows sandbox failed: helper_unknown_error: setup refresh had errors\n",
      }),
    });
    // The turn result keeps today's shape: no typed flag, just the stop text.
    assert.equal(result.ok, false);
    assert.equal(result.environmentBlocked, undefined);
    assert.match(result.errorText, /helper_unknown_error/);
    const health = readHealth(directory);
    assert.equal(health.claude.commandId, "coordinate-review-claude");
    assert.match(health.claude.detail, /sandbox failed/);
    assert.ok(health.claude.detail.length <= 300);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a codex success turn without tool events keeps an existing health record", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-health-keep-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\n");
  markBlocked(directory, "codex", "sandbox failed", "coordinate-plan-older");
  try {
    const done = await runCliTurn(command("codex", "gpt-6.1-sol"), {
      stateDir: directory,
      spawnTurn: async () => ({
        code: 0,
        stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Bounded plan."}}\n',
      }),
    });
    assert.equal(done.ok, true);
    const health = readHealth(directory);
    assert.match(health.codex.detail, /sandbox failed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a codex success turn with a completed tool clears the health record", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-health-clear-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-codex\n");
  markBlocked(directory, "codex", "sandbox failed", "coordinate-plan-older");
  try {
    const done = await runCliTurn(command("codex", "gpt-6.1-sol"), {
      stateDir: directory,
      spawnTurn: async () => ({
        code: 0,
        stdout: [
          '{"type":"item.completed","item":{"type":"command_execution","command":"ls","aggregated_output":"AGENTS.md","exit_code":0,"status":"completed"}}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"Bounded plan."}}',
        ].join("\n") + "\n",
      }),
    });
    assert.equal(done.ok, true);
    assert.deepEqual(readHealth(directory), {});
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a claude ok turn clears its own health record", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-health-claude-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-review-claude\n");
  markBlocked(directory, "claude", "sandbox failed", "coordinate-review-older");
  try {
    const done = await runCliTurn(command("claude", "opus", "coordinate-review-claude"), {
      stateDir: directory,
      spawnTurn: async () => ({
        code: 0,
        stdout: '{"type":"result","result":"Stop.\\nVERDICT: stop","is_error":false}',
      }),
    });
    assert.equal(done.ok, true);
    assert.deepEqual(readHealth(directory), {});
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("discovery merges health onto matching instances and leaves the rest byte-identical", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-health-discover-"));
  const probe = {
    home: "/home/person",
    readFile() {
      return 'model = "gpt-6.1-sol"\n';
    },
    execFile(file) {
      if (file === "codex") return { stdout: "Logged in using ChatGPT\n" };
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }) };
    },
  };
  try {
    const base = await discoverCliProviders(probe);
    assert.equal(JSON.stringify(base).includes("environmentHealth"), false);
    // No health file at all: identical snapshot.
    const withoutFile = await discoverCliProviders({ ...probe, stateDir: directory });
    assert.deepEqual(withoutFile.providers, base.providers);
    // A record lands only on its own instance.
    markBlocked(directory, "codex", "sandbox failed", "coordinate-plan-codex");
    const merged = await discoverCliProviders({ ...probe, stateDir: directory });
    assert.deepEqual(merged.providers.find((item) => item.instanceId === "claude"), base.providers.find((item) => item.instanceId === "claude"));
    const codex = merged.providers.find((item) => item.instanceId === "codex");
    assert.equal(codex.environmentHealth.detail, "sandbox failed");
    assert.equal(typeof codex.environmentHealth.since, "string");
    // An empty state dir behaves as no health.
    const emptyState = await discoverCliProviders({ ...probe, stateDir: "" });
    assert.deepEqual(emptyState.providers, base.providers);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("codexToolSuccess demands a completed non-failed tool event", () => {
  assert.equal(codexToolSuccess('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n'), false);
  assert.equal(codexToolSuccess('{"type":"item.started","item":{"type":"command_execution","command":"ls","status":"in_progress"}}\n'), false);
  assert.equal(codexToolSuccess('{"type":"item.completed","item":{"type":"command_execution","command":"ls","status":"failed","aggregated_output":"boom"}}\n'), false);
  assert.equal(codexToolSuccess('{"type":"item.completed","item":{"type":"command_execution","command":"ls","status":"completed","aggregated_output":"ok"}}\n'), true);
  assert.equal(codexToolSuccess('not json at all'), false);
});

test("writeGrant appends only when the line is absent and preserves hand-written lines", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-writegrant-"));
  try {
    // Absent line: inserted, and the caller learns it owns the line.
    assert.equal(writeGrant(directory, "coordinate-plan-codex"), true);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-plan-codex\n");
    // Same line again: no duplicate, no write.
    assert.equal(writeGrant(directory, "coordinate-plan-codex"), false);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-plan-codex\n");
    // A hand-written line is preserved; a new line is appended after it.
    fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-review-claude\n");
    assert.equal(writeGrant(directory, "coordinate-plan-codex"), true);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-review-claude\ncoordinate-plan-codex\n");
    // The pre-existing line is never duplicated either.
    assert.equal(writeGrant(directory, "coordinate-review-claude"), false);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-review-claude\ncoordinate-plan-codex\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("an old-format command id with a claim still returns its stored result without replay", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-old-command-id-"));
  const oldCommandId = "coordinate-plan-legacyhash";
  let spawns = 0;
  try {
    fs.writeFileSync(path.join(directory, `claim-${oldCommandId}`), "");
    fs.writeFileSync(path.join(directory, "sent-turns.json"), JSON.stringify({
      [oldCommandId]: { ok: true, text: "Legacy stored plan.", errorText: "", messageDispatched: true },
    }));
    const result = await runCliTurn(command("codex", "gpt-6.1-sol", oldCommandId), {
      stateDir: directory,
      spawnTurn: async () => {
        spawns += 1;
        return { code: 0, stdout: "must not run" };
      },
    });

    assert.deepEqual(result, { ok: true, text: "Legacy stored plan.", errorText: "", messageDispatched: true });
    assert.equal(spawns, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("failure branches emit their stop codes: no-text, not-finished, not-installed, and none for is_error", async () => {
  const run = async (instanceId, model, spawnTurn, commandId = `coordinate-plan-${instanceId}`) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-stopcode-"));
    try {
      fs.writeFileSync(path.join(directory, "send-authorization"), `${commandId}\n`);
      return await runCliTurn(command(instanceId, model, commandId), { stateDir: directory, spawnTurn });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  };
  // Clean exit without any reply text is the only producer of "no-text".
  const noText = await run("codex", "gpt-6.1-sol", async () => ({ code: 0, stdout: "" }));
  assert.equal(noText.errorText, "The harness finished without any text, so this stopped.");
  assert.equal(noText.stopCode, "no-text");
  // A nonzero exit with text that is not a provider-level failure is "not-finished".
  const notFinished = await run("codex", "gpt-6.1-sol", async () => ({
    code: 1,
    stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\n',
  }));
  assert.equal(notFinished.stopCode, "not-finished");
  assert.equal(notFinished.messageDispatched, true);
  // A provider-level failure (claude is_error) gets NO stop code: its class
  // falls to the errorText mapping and it must never look resumable.
  const isError = await run("claude", "opus", async () => ({
    code: 1,
    stdout: '{"result":"Model refused.","is_error":true}',
  }), "coordinate-review-claude");
  assert.equal(isError.text, "Model refused.");
  assert.equal(isError.messageDispatched, true);
  assert.equal(isError.stopCode, null);
  // A spawn failure is "not-installed", and the grant came back for a retry.
  const notInstalled = await run("codex", "gpt-6.1-sol", async () => ({ spawnError: true }));
  assert.match(notInstalled.errorText, /not installed/);
  assert.equal(notInstalled.stopCode, "not-installed");
  assert.equal(notInstalled.messageDispatched, false);
});
