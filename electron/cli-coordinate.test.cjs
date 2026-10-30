const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverCliProviders: discoverProviders, runCliTurn, codexReply, codexEnvironmentBlocked, codexToolSuccess, claudeReply, replyFrom, turnSpec, piWindowsLaunch, launchSpec, killProcessTree, defaultExec, writeGrant } = require("./cli-coordinate.cjs");
const { roleOfCommandId, guardCoordinateWriteCommand } = require("./coordinate-guard.cjs");
const { readHealth, markBlocked } = require("./harness-health.cjs");
const { defaultSpawn, spawnStdinTurn } = require("./cli-coordinate.cjs");
const { EventEmitter, once } = require("node:events");

// Existing discovery cases are the retained legacy host contract. New Linux
// route-aware discovery is exercised separately in pi-capacity.test.cjs.
const discoverCliProviders = io => discoverProviders({ routeAwarePi: false, ...io });

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
      // A failing pi probe keeps this test's roster at codex+claude; the pi
      // discovery cases below cover the success shape.
      if (file === "pi") return { stdout: "" };
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
      if (file === "pi") return { stdout: "" };
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
      if (file === "pi") return { stdout: "" };
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

test("a pi reply is the trimmed stdout text and never a provider failure", () => {
  assert.deepEqual(replyFrom("pi", " ok\n "), { text: "ok", failed: false });
  // Empty text stays failed:false so runCliTurn's no-text stop sentence
  // ("finished without any text") carries it through the existing path.
  assert.deepEqual(replyFrom("pi", "   \n"), { text: "", failed: false });
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

test("a POSIX Pi install is used when the pi command is not on PATH", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-pi-home-"));
  try {
    const launcher = path.join(home, ".pi", "agent", "bin", "pi");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "#!/bin/sh\n");
    const found = launchSpec("pi", ["--offline", "--list-models"], { HOME: home, PATH: "/nonexistent" }, "linux");
    assert.equal(found.file, launcher);
    assert.deepEqual(found.args, ["--offline", "--list-models"]);
    const missing = launchSpec("pi", ["--offline"], { HOME: path.join(home, "empty"), PATH: "/nonexistent" }, "linux");
    assert.equal(missing.file, "pi");
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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
      if (file === "pi") return { stdout: "" };
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
      if (file === "pi") return { stdout: "" };
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
    },
  });
  assert.equal(discovered.providers[0].models[0].slug, "gpt-6.1-sol");
});

// The real-machine probe shape (pi --offline --list-models): a provider/
// model/context header row plus model rows whose context column starts with
// a digit (1M, 262.1K, ...).
const PI_TABLE_STDOUT = [
  "provider     model                      context  max-out  thinking  images",
  "deepseek     deepseek-flash             1M       384K     yes       yes",
  "kimi-coding  kimi-for-coding            1.0M     32.8K    yes       yes",
  "",
].join("\n");

test("a pi install with an enumerable model table is discovered with its built-in default", async () => {
  const discovered = await discoverCliProviders({
    home: "/home/person",
    readFile() {
      return 'model = "gpt-6.1-sol"\n';
    },
    execFile(file, args) {
      if (file === "pi") {
        assert.deepEqual(args, ["--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--offline", "--list-models"]);
        return { stdout: PI_TABLE_STDOUT };
      }
      if (file === "codex") return { stdout: "Logged in using ChatGPT\n" };
      return { stdout: "" };
    },
  });
  assert.deepEqual(discovered.providers.map((item) => item.instanceId), ["codex", "pi"]);
  assert.deepEqual(discovered.providers[1], {
    instanceId: "pi",
    displayName: "Pi",
    driver: "pi",
    enabled: true,
    installed: true,
    availability: "available",
    status: "ready",
    auth: { status: "authenticated", type: "unknown", label: "unknown" },
    models: [{ slug: "default", name: "pi built-in default", isDefault: true, isLegacy: false }],
  });
});

test("pi oauth providers are classified as a subscription and an api key is not", async () => {
  const { discoverCliProviders } = require("./cli-coordinate.cjs");
  const discovered = await discoverCliProviders({
    routeAwarePi: false,
    home: "/home/person",
    readFile(file) {
      if (String(file).replace(/\\/g, "/").endsWith(".pi/agent/auth.json")) {
        return JSON.stringify({
          openai: { type: "oauth", access: "secret" },
          xai: { type: "oauth" },
          "kimi-coding": { type: "oauth" },
          deepseek: { type: "api_key", key: "secret" },
        });
      }
      return "";
    },
    execFile(file) {
      if (file === "where" || file === "which") throw new Error("unused");
      if (file === "pi") return { stdout: PI_TABLE_STDOUT };
      return { stdout: "" };
    },
  });
  const pi = discovered.providers.find((item) => item.instanceId === "pi");
  assert.equal(pi.auth.type, "subscription");
  assert.match(pi.auth.label, /openai/);
  assert.match(pi.auth.label, /xai/);
  assert.match(pi.auth.label, /kimi-coding/);
  assert.doesNotMatch(pi.auth.label, /deepseek|secret/);
});

test("a pi probe that fails, stays empty, or prints non-table text is not discovered", async () => {
  const roster = async (piProbe) => discoverCliProviders({
    home: "/home/person",
    readFile() {
      return "";
    },
    execFile(file) {
      if (file === "pi") {
        if (piProbe instanceof Error) throw piProbe;
        return piProbe;
      }
      return { stdout: "" };
    },
  });
  // A spawn failure rejects, so the provider arm yields null.
  assert.deepEqual((await roster(new Error("spawn pi ENOENT"))).providers, []);
  assert.deepEqual((await roster({ stdout: "" })).providers, []);
  // Nonempty error text on either stream never matches the table shape, so
  // a nonzero exit cannot smuggle a provider in through the discarded code.
  assert.deepEqual((await roster({ stdout: "", stderr: "error: offline mode cannot list models\n" })).providers, []);
  assert.deepEqual((await roster({ stdout: "pi: failed to load models\nrun 'pi auth login' first\n" })).providers, []);
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
      if (file === "pi") return { stdout: "" };
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

// M5 dormant write capability: the explicitly-write twin of the read command,
// same grant/claim/ledger semantics, guarded by the id's role.
function writeCommand(instanceId, model, commandId = `coordinate-execute-${instanceId}`) {
  return {
    commandId,
    type: "goalport.coordinateTurn",
    modelSelection: { instanceId, model },
    runtimeMode: "approval-required",
    approvalPolicy: "never",
    sandboxPolicy: { type: "workspaceWrite" },
    workspaceStrategy: { type: "existing_worktree", worktreePath: "/work/goal" },
    initialMessage: { text: "Carry out the plan." },
  };
}

for (const failedBaseline of [false, true]) test(`cancellation during asynchronous execution baseline (failure=${failedBaseline}) starts no CLI and is not replayed`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cancel-baseline-"));
  const input = writeCommand("codex", "gpt-6.1-sol", `coordinate-execute-cancel-baseline-${failedBaseline}`);
  writeGrant(directory, input.commandId);
  let cancelled = false, spawns = 0, entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const options = { stateDir: directory, cancelled: () => cancelled,
    captureBaseline: async () => { entered(); await gate; if (failedBaseline) throw Error("synthetic baseline failure"); return null; },
    spawnTurn: async () => { spawns++; return {code:0,stdout:'{"type":"agent_message","text":"must not run"}'}; } };
  try {
    const pending = runCliTurn(input, options);
    await started; cancelled = true; release();
    const result = await pending;
    assert.equal(spawns, 0);
    assert.equal(result.ok, false); assert.equal(result.messageDispatched, false);
    assert.match(result.errorText, /replaced/i);
    const again = await runCliTurn(input, { ...options, cancelled: () => false });
    assert.deepEqual(again, result); assert.equal(spawns, 0);
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
  } finally { fs.rmSync(directory, {recursive:true,force:true}); }
});

test("roleOfCommandId classifies the closed prefix set and nothing else", () => {
  assert.equal(roleOfCommandId("coordinate-plan-abc123"), "plan");
  assert.equal(roleOfCommandId("coordinate-review-abc123"), "review");
  assert.equal(roleOfCommandId("coordinate-execute-abc123"), "execute");
  assert.equal(roleOfCommandId("coordinate-audit-abc123"), "audit");
  assert.equal(roleOfCommandId("coordinate-other-abc123"), null);
  assert.equal(roleOfCommandId("coordinate-plan"), null);
  assert.equal(roleOfCommandId(""), null);
  assert.equal(roleOfCommandId(42), null);
});

test("guardCoordinateWriteCommand demands the write literals and an absolute existing worktree", () => {
  assert.equal(guardCoordinateWriteCommand(writeCommand("codex", "gpt-6.1-sol")), null);
  assert.equal(guardCoordinateWriteCommand({ ...writeCommand("codex", "gpt-6.1-sol"), workspaceStrategy: { type: "existing_worktree", worktreePath: "C:\\work\\goal" } }), null);
  assert.equal(guardCoordinateWriteCommand({ ...writeCommand("codex", "gpt-6.1-sol"), type: "message.dispatch" }), "The command is not a coordinate turn.");
  assert.equal(guardCoordinateWriteCommand({ ...writeCommand("codex", "gpt-6.1-sol"), runtimeMode: "full-access" }), "runtimeMode must be approval-required.");
  assert.equal(guardCoordinateWriteCommand({ ...writeCommand("codex", "gpt-6.1-sol"), approvalPolicy: "on-request" }), "approvalPolicy must be never. approval-required alone asks for every read.");
  assert.equal(guardCoordinateWriteCommand({ ...writeCommand("codex", "gpt-6.1-sol"), sandboxPolicy: { type: "readOnly" } }), "sandboxPolicy.type must be workspaceWrite.");
  assert.equal(guardCoordinateWriteCommand({ ...writeCommand("codex", "gpt-6.1-sol"), sandboxPolicy: { type: "dangerFullAccess" } }), "sandboxPolicy.type must be workspaceWrite.");
  assert.equal(guardCoordinateWriteCommand({ ...writeCommand("codex", "gpt-6.1-sol"), workspaceStrategy: { type: "root" } }), "A write turn must run in an existing worktree.");
  assert.equal(guardCoordinateWriteCommand({ ...writeCommand("codex", "gpt-6.1-sol"), workspaceStrategy: { type: "existing_worktree", worktreePath: "   " } }), "A write turn must run in an existing worktree.");
  assert.equal(guardCoordinateWriteCommand({ ...writeCommand("codex", "gpt-6.1-sol"), workspaceStrategy: { type: "existing_worktree", worktreePath: "work/relative" } }), "A write turn needs an absolute worktree path.");
});

test("write argv flips exactly one flag per harness; read argv stays byte-identical", () => {
  const readCodex = turnSpec(command("codex", "gpt-6.1-sol", "coordinate-execute-codex"));
  const writeCodex = turnSpec(writeCommand("codex", "gpt-6.1-sol"));
  assert.deepEqual(writeCodex.args, ["exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--skip-git-repo-check", "--cd", "/work/goal", "Carry out the plan."]);
  assert.deepEqual(readCodex.args, ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", "/work/goal", "Plan only."]);
  assert.equal(writeCodex.args.length, readCodex.args.length);
  const codexDiffs = writeCodex.args.filter((arg, index) => arg !== ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", "/work/goal", "Carry out the plan."][index]);
  assert.deepEqual(codexDiffs, ["workspace-write"]);
  const writeClaude = turnSpec(writeCommand("claude", "opus"));
  assert.deepEqual(writeClaude.args, ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--model", "opus", "Carry out the plan."]);
  const readClaude = turnSpec(command("claude", "opus", "coordinate-execute-claude"));
  assert.equal(writeClaude.args.length, readClaude.args.length);
  const claudeDiffs = writeClaude.args.filter((arg, index) => arg !== ["-p", "--output-format", "json", "--permission-mode", "plan", "--permission-prompts", "none", "--model", "opus", "Carry out the plan."][index]);
  assert.deepEqual(claudeDiffs, ["acceptEdits"]);
});

test("a pi read turn is toolless and modelless, and a pi write turn is refused", () => {
  const read = turnSpec(command("pi", "default", "coordinate-plan-pi"), {}, "linux");
  assert.deepEqual(read, {
    file: "pi",
    cwd: "/work/goal",
    args: ["-p", "--no-session", "--no-context-files", "--no-extensions", "--no-mcp", "--no-skills", "-na", "--no-tools", "--mode", "text", "Plan only."],
  });
  assert.equal(read.args.includes("--model"), false);
  assert.deepEqual(turnSpec(writeCommand("pi", "default")), {
    errorText: "Pi runs read-only turns in this build; workspace changes need a harness with a write sandbox.",
  });
});

function piLaunchFixture(t, { cli = true, node = true, shim = ".cmd" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-pi-launch-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const prefix = path.join(directory, "npm prefix");
  const runtime = path.join(directory, "node runtime");
  const cliJs = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  const nodeExe = path.join(runtime, "node.exe");
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  if (shim) fs.writeFileSync(path.join(prefix, `pi${shim}`), "@echo off\r\n");
  if (cli) {
    fs.mkdirSync(path.dirname(cliJs), { recursive: true });
    fs.writeFileSync(cliJs, "// fixture only\n");
  }
  if (node) fs.writeFileSync(nodeExe, "fixture only\n");
  return { env: { PATH: [prefix, runtime].join(path.delimiter), PATHEXT: ".exe;.cmd;.bat" }, cliJs, nodeExe };
}

test("a Windows pi npm shim launches node.exe with only cli.js prepended to the read argv", (t) => {
  const input = command("pi", "default");
  input.initialMessage.text = 'Plan "only" & <risk> ^ %PATH% tail\\';
  const expected = turnSpec(input, {}, "linux");
  for (const shim of [".cmd", ".bat"]) {
    const { env, cliJs, nodeExe } = piLaunchFixture(t, { shim });
    assert.deepEqual(piWindowsLaunch(env, "win32"), { file: nodeExe, prefixArgs: [cliJs] });
    const spec = turnSpec(input, env, "win32");
    assert.deepEqual(spec, { file: nodeExe, cwd: expected.cwd, args: [cliJs, ...expected.args] });
    assert.equal(JSON.stringify(spec.args.slice(1)), JSON.stringify(expected.args));
    assert.deepEqual(turnSpec(writeCommand("pi", "default"), env, "win32"), {
      errorText: "Pi runs read-only turns in this build; workspace changes need a harness with a write sandbox.",
    });
  }
});

test("a Windows pi shim without the npm-layout cli.js keeps the exact legacy fallback", (t) => {
  const { env } = piLaunchFixture(t, { cli: false });
  const input = command("pi", "default");
  assert.equal(piWindowsLaunch(env, "win32"), null);
  assert.deepEqual(turnSpec(input, env, "win32"), turnSpec(input, env, "linux"));
  assert.equal(turnSpec(input, env, "win32").file, "pi");
});

test("a Windows pi shim without node.exe keeps the exact legacy fallback", (t) => {
  const { env } = piLaunchFixture(t, { node: false });
  const input = command("pi", "default");
  assert.equal(piWindowsLaunch(env, "win32"), null);
  assert.deepEqual(turnSpec(input, env, "win32"), turnSpec(input, env, "linux"));
  assert.equal(turnSpec(input, env, "win32").file, "pi");
});

test("a Windows pi launch without a cmd or bat shim keeps the exact legacy fallback", (t) => {
  const { env } = piLaunchFixture(t, { shim: "" });
  const input = command("pi", "default");
  assert.equal(piWindowsLaunch(env, "win32"), null);
  assert.deepEqual(turnSpec(input, env, "win32"), turnSpec(input, env, "linux"));
});

test("the pi Windows launch helper does not probe files off Windows", () => {
  const fsApi = { existsSync() { throw new Error("must not probe off Windows"); } };
  assert.equal(piWindowsLaunch({}, "linux", fsApi), null);
  assert.equal(piWindowsLaunch({}, "darwin", fsApi), null);
});

// Byte-frozen regression lock: the codex and claude argv exactly as on HEAD,
// read and write, while pi joins the roster.
test("codex and claude argv stay byte-frozen for both read and write turns", () => {
  assert.deepEqual(turnSpec(command("codex", "gpt-6.1-sol", "coordinate-plan-codex")), {
    file: "codex",
    cwd: "/work/goal",
    args: ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", "/work/goal", "Plan only."],
  });
  assert.deepEqual(turnSpec(writeCommand("codex", "gpt-6.1-sol")), {
    file: "codex",
    cwd: "/work/goal",
    args: ["exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--skip-git-repo-check", "--cd", "/work/goal", "Carry out the plan."],
  });
  assert.deepEqual(turnSpec(command("claude", "opus", "coordinate-plan-claude")), {
    file: "claude",
    cwd: "/work/goal",
    args: ["-p", "--output-format", "json", "--permission-mode", "plan", "--permission-prompts", "none", "--model", "opus", "Plan only."],
  });
  assert.deepEqual(turnSpec(writeCommand("claude", "opus")), {
    file: "claude",
    cwd: "/work/goal",
    args: ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--model", "opus", "Carry out the plan."],
  });
});

test("a granted pi turn returns the trimmed text, and a refused write turn never spawns", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-pi-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-plan-pi\ncoordinate-execute-pi\n");
  let spawns = 0;
  const expected = turnSpec(command("pi", "default", "coordinate-plan-pi"));
  const spawnTurn = async (spec) => {
    spawns += 1;
    assert.equal(spec.file, expected.file);
    assert.equal(spec.cwd, "/work/goal");
    assert.deepEqual(spec.args, expected.args);
    return { code: 0, stdout: " ok\n " };
  };
  try {
    const plan = await runCliTurn(command("pi", "default", "coordinate-plan-pi"), { stateDir: directory, spawnTurn });
    assert.deepEqual(plan, { ok: true, text: "ok", errorText: "", messageDispatched: true });
    const write = await runCliTurn(writeCommand("pi", "default"), { stateDir: directory, spawnTurn });
    assert.equal(write.ok, false);
    assert.equal(write.messageDispatched, false);
    assert.equal(write.errorText, "Pi runs read-only turns in this build; workspace changes need a harness with a write sandbox.");
    assert.equal(spawns, 1);
    // The refusal came before the claim, so its grant line stayed intact.
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), "coordinate-execute-pi\n");
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-execute-pi")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("pairing is refused in both directions before any spawn, with the grant left intact", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-pairing-"));
  let spawns = 0;
  const spawnTurn = async () => {
    spawns += 1;
    return { code: 0, stdout: "" };
  };
  try {
    // An execute-role id carrying the read-only sandbox hits the write guard.
    fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-execute-codex\ncoordinate-plan-codex\n");
    const executeReadOnly = await runCliTurn({ ...writeCommand("codex", "gpt-6.1-sol", "coordinate-execute-codex"), sandboxPolicy: { type: "readOnly" } }, { stateDir: directory, spawnTurn });
    assert.equal(executeReadOnly.ok, false);
    assert.equal(executeReadOnly.errorText, "sandboxPolicy.type must be workspaceWrite.");
    assert.equal(executeReadOnly.messageDispatched, false);
    // A plan-role id carrying the write sandbox hits the read guard.
    const planWrite = await runCliTurn({ ...command("codex", "gpt-6.1-sol", "coordinate-plan-codex"), sandboxPolicy: { type: "workspaceWrite" } }, { stateDir: directory, spawnTurn });
    assert.equal(planWrite.ok, false);
    assert.equal(planWrite.errorText, "sandboxPolicy.type must be readOnly.");
    assert.equal(planWrite.messageDispatched, false);
    assert.equal(spawns, 0);
    // Neither refusal consumed its grant or left a claim behind.
    const grants = fs.readFileSync(path.join(directory, "send-authorization"), "utf8");
    assert.equal(grants.includes("coordinate-execute-codex"), true);
    assert.equal(grants.includes("coordinate-plan-codex"), true);
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-execute-codex")), false);
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-plan-codex")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a granted write turn consumes its grant, keeps the claim ledger semantics, and replays", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-write-"));
  fs.writeFileSync(path.join(directory, "send-authorization"), "coordinate-execute-codex\n");
  const spawned = [];
  const spawnTurn = async (spec) => {
    spawned.push(spec);
    return { code: 0, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Carried out."}}\n' };
  };
  try {
    const first = await runCliTurn(writeCommand("codex", "gpt-6.1-sol"), { stateDir: directory, spawnTurn });
    assert.equal(first.ok, true);
    assert.equal(first.text, "Carried out.");
    assert.deepEqual(spawned[0].args, ["exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--skip-git-repo-check", "--cd", "/work/goal", "Carry out the plan."]);
    assert.equal(spawned[0].cwd, "/work/goal");
    assert.equal(fs.existsSync(path.join(directory, "send-authorization")), false);
    assert.equal(fs.existsSync(path.join(directory, "claim-coordinate-execute-codex")), true);
    const second = await runCliTurn(writeCommand("codex", "gpt-6.1-sol"), { stateDir: directory, spawnTurn });
    assert.equal(second.text, "Carried out.");
    assert.equal(spawned.length, 1);
    const ledger = JSON.parse(fs.readFileSync(path.join(directory, "sent-turns.json"), "utf8"));
    assert.equal(ledger["coordinate-execute-codex"].ok, true);
    assert.equal(ledger["coordinate-execute-codex"].text, "Carried out.");
    assert.equal(ledger["coordinate-execute-codex"].errorText, "");
    assert.equal(ledger["coordinate-execute-codex"].messageDispatched, true);
    assert.ok(ledger["coordinate-execute-codex"].executionEvidence);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("Pi stdin selector is exactly audit/Pi/Linux-or-Windows/readOnly; other turns remain argv", () => {
  for (const role of ["plan", "review", "execute", "audit"]) {
    for (const instance of ["pi", "codex", "claude"]) for (const platform of ["linux", "win32", "darwin"]) {
      for (const sandbox of ["readOnly", "workspaceWrite"]) {
        const input = { ...command(instance, "default", `coordinate-${role}-matrix`), sandboxPolicy: { type: sandbox }, promptDelivery: "stdin" };
        const spec = turnSpec(input, {}, platform);
        const eligible = role === "audit" && instance === "pi" && platform !== "darwin" && sandbox === "readOnly";
        assert.equal(!spec.errorText, eligible, JSON.stringify({ role, instance, platform, sandbox }));
        if (eligible) {
          assert.deepEqual(spec.args, ["-p", "--no-session", "--no-context-files", "--no-extensions", "--no-mcp", "--no-skills", "-na", "--no-tools", "--mode", "text"]);
          assert.equal(spec.stdinBody.toString(), input.initialMessage.text);
        }
      }
    }
  }
  const input = command("pi", "default", "coordinate-audit-selector");
  assert.equal(turnSpec(input, {}, "linux").args.at(-1), input.initialMessage.text);
  for (const instance of ["pi", "codex", "claude"]) {
    for (const role of ["plan", "review", "execute", "audit"]) {
      const input = command(instance, "default", `coordinate-${role}-argv`);
      input.initialMessage.text = "字😀".repeat(700);
      assert.ok(Buffer.byteLength(input.initialMessage.text) > 4096);
      for (const platform of ["linux", "win32"]) {
        const spec = turnSpec(input, {}, platform);
        assert.equal(spec.errorText, undefined, `${instance}/${role}/${platform}`);
        assert.equal(spec.args.at(-1), input.initialMessage.text);
        assert.equal("stdinBody" in spec, false);
      }
    }
  }
  for (const promptDelivery of [null, undefined, "argv", "other", {}, false]) {
    assert.ok(turnSpec({ ...input, promptDelivery }, {}, "linux").errorText);
  }
  assert.equal(turnSpec({ ...input, promptDelivery: "stdin", initialMessage: { text: "😀".repeat(8192) } }, {}, "linux").stdinBody.length, 32768);
  assert.ok(turnSpec(Object.assign(Object.create({ promptDelivery: null }), input), {}, "linux").errorText);
  assert.ok(turnSpec({ ...input, promptDelivery: "stdin", initialMessage: { text: "字".repeat(10923) } }, {}, "linux").errorText);
});

test("present invalid selector/oversize refuses before claims and preserves an old claim", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-stdin-guard-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = command("pi", "default", "coordinate-audit-guard");
  writeGrant(directory, input.commandId);
  let spawns = 0;
  const options = { stateDir: directory, spawnTurn: async () => { spawns++; return { code: 0, stdout: "Original." }; } };
  for (const promptDelivery of [null, undefined, "argv"]) {
    assert.equal((await runCliTurn({ ...input, promptDelivery }, options)).messageDispatched, false);
    assert.equal(fs.existsSync(path.join(directory, `claim-${input.commandId}`)), false);
    assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), `${input.commandId}\n`);
  }
  const original = await runCliTurn(input, options);
  const ledger = fs.readFileSync(path.join(directory, "sent-turns.json"), "utf8");
  const rejected = await runCliTurn({ ...input, promptDelivery: null }, options);
  assert.equal(rejected.messageDispatched, false);
  assert.equal(fs.readFileSync(path.join(directory, "sent-turns.json"), "utf8"), ledger);
  assert.deepEqual(await runCliTurn(input, options), original);
  assert.equal(spawns, 1);
  if (process.platform === "linux") {
    const big = { ...input, commandId: "coordinate-audit-big", promptDelivery: "stdin", initialMessage: { text: "😀".repeat(8193) } };
    writeGrant(directory, big.commandId);
    assert.equal((await runCliTurn(big, options)).messageDispatched, false);
    assert.equal(fs.existsSync(path.join(directory, `claim-${big.commandId}`)), false);
  }
});

function mixedWidthAuditPrompt() {
  const prefix = ` \n${"aé字😀'\"$&|<>^%`\\\n".repeat(1000)}`;
  const tail = "\nAUDIT_INPUT_END_字😀 \n\t";
  return prefix + "x".repeat(32768 - Buffer.byteLength(prefix + tail, "utf8")) + tail;
}

test("mixed-width Pi stdin accepts exactly 32768 bytes after refusing one extra byte without consuming authorization", { skip: process.platform !== "linux" }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-stdin-boundary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const text = mixedWidthAuditPrompt();
  assert.equal(Buffer.byteLength(text, "utf8"), 32768);
  const input = { ...command("pi", "default", "coordinate-audit-boundary"), promptDelivery: "stdin", initialMessage: { text } };
  writeGrant(directory, input.commandId);
  let spawns = 0;
  const options = { stateDir: directory, spawnTurn: async spec => {
    spawns++;
    assert.deepEqual(spec.stdinBody, Buffer.from(text, "utf8"));
    assert.equal(spec.args.includes(text), false);
    return { code: 0, stdout: "Boundary audit complete.", childStarted: true, inputEnded: true };
  } };

  const refused = await runCliTurn({ ...input, initialMessage: { text: text + "x" } }, options);
  assert.equal(refused.ok, false);
  assert.equal(refused.messageDispatched, false);
  assert.match(refused.errorText, /32,768-byte limit/);
  assert.equal(spawns, 0);
  assert.equal(fs.existsSync(path.join(directory, `claim-${input.commandId}`)), false);
  assert.equal(fs.readFileSync(path.join(directory, "send-authorization"), "utf8"), `${input.commandId}\n`);

  const accepted = await runCliTurn(input, options);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.messageDispatched, true);
  assert.deepEqual(accepted.auditInputTransport, { instanceId: "pi", promptDelivery: "stdin", inputBytes: 32768, inputEnded: true });
  assert.equal(spawns, 1);
});

test("a Windows .cmd Pi shim still receives the exact 32768-byte body and EOF through cmd.exe", { skip: process.platform !== "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-stdin-shim-"));
  try {
    const script = path.join(directory, "echo.js"), shim = path.join(directory, "fake-pi.cmd");
    fs.writeFileSync(script, "const b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>process.stdout.write(JSON.stringify({body:Buffer.concat(b).toString('base64'),args:process.argv.slice(2)})))");
    fs.writeFileSync(shim, `@echo off
"${process.execPath}" "${script}" %*
`);
    const body = Buffer.from(mixedWidthAuditPrompt(), "utf8");
    const result = await defaultSpawn({ file: shim, args: ["-p", "--mode", "text"], cwd: directory, env: process.env, stdinBody: body });
    assert.equal(result.code, 0);
    assert.equal(result.inputEnded, true);
    const seen = JSON.parse(result.stdout);
    assert.equal(Buffer.from(seen.body, "base64").equals(body), true);
    assert.deepEqual(seen.args, ["-p", "--mode", "text"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("production stdin seam sends exact 32768-byte mixed-width UTF-8 input and EOF to a real non-model Node child", async () => {
  const body = Buffer.from(mixedWidthAuditPrompt(), "utf8");
  assert.equal(body.length, 32768);
  let registered = false;
  let ends = 0;
  const result = await defaultSpawn({ file: process.execPath, args: ["-e", "const b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>process.stdout.write(JSON.stringify({body:Buffer.concat(b).toString('base64'),eof:true})))"],
    cwd: process.cwd(), env: process.env, stdinBody: body,
    register(child) {
      registered = typeof child.pid === "number";
      const end = child.stdin.end.bind(child.stdin);
      child.stdin.end = (...args) => { assert.equal(registered, true); ends++; return end(...args); };
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.childStarted, true);
  assert.equal(result.inputEnded, true);
  const read = JSON.parse(result.stdout);
  assert.equal(read.eof, true);
  const received = Buffer.from(read.body, "base64");
  assert.deepEqual(received, body);
  assert.equal(received.toString("utf8").endsWith("\nAUDIT_INPUT_END_字😀 \n\t"), true);
  assert.equal(ends, 1);
});

test("real async ENOENT has no pid/spawn proof and remains proven not-sent", async () => {
  const result = await defaultSpawn({ file: path.join(os.tmpdir(), "goalport-missing-executable-stdin-289641"), args: [], env: process.env, stdinBody: Buffer.from("not sent") });
  assert.equal(result.spawnError, true);
  assert.equal(result.childStarted, false);
  assert.equal(result.inputEnded, false);
  assert.notEqual(result.deliveryUnknown, true);
});

test("real child closes stdin after pid proof: EPIPE stays unknown and registered Stop handle survives", { skip: process.platform !== "linux" }, async () => {
  let child;
  let closed;
  const result = await defaultSpawn({ file: process.execPath,
    args: ["-e", "require('node:fs').closeSync(0);process.stdout.write('closed');setInterval(()=>{},1000)"],
    cwd: process.cwd(), env: process.env, stdinBody: Buffer.from("字😀".repeat(4000)),
    register(proc) {
      child = proc;
      closed = once(proc, "close");
      const end = proc.stdin.end.bind(proc.stdin);
      proc.stdin.end = (...args) => { proc.stdout.once("data", chunk => { assert.equal(String(chunk), "closed"); end(...args); }); return proc.stdin; };
    },
    timeoutMs: 5000,
  });
  try {
    assert.equal(result.childStarted, true);
    assert.equal(result.deliveryUnknown, true);
    assert.equal(result.inputEnded, false);
    assert.equal(child.exitCode, null);
  } finally { child.kill("SIGKILL"); await closed; }
});

function controlledStdinChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  child.kill = () => { child.emit("close", null); return true; };
  return child;
}

test("stdin setup/end/early-close/timeout races settle once; unknown cannot become success", async () => {
  for (const failure of ["register", "listener", "end-throw", "end-callback", "early-close", "timeout"]) {
    const child = controlledStdinChild();
    child.stdin.end = (_body, cb) => {
      if (failure === "end-throw") throw Error("end failed");
      if (failure === "end-callback") queueMicrotask(() => cb(Error("EPIPE")));
      if (failure === "early-close") queueMicrotask(() => child.emit("close", 0));
    };
    if (failure === "listener") child.stdout.setEncoding = () => { throw Error("setup failed"); };
    const pending = spawnStdinTurn({ file: "unused", args: [], stdinBody: Buffer.from("body"), timeoutMs: 0,
      register() { if (failure === "register") throw Error("register failed"); },
    }, () => { queueMicrotask(() => child.emit("spawn")); return child; });
    const result = await pending;
    assert.equal(result.deliveryUnknown, true, failure);
    assert.equal(result.inputEnded, false, failure);
    assert.notEqual(result.spawnError, true, failure);
    child.emit("close", 0);
    assert.equal(result.deliveryUnknown, true);
  }
});

test("Stop before confirmed input-end remains unknown, and post-error timeout still owns cleanup", async () => {
  for (const failInput of [false, true]) {
    const child = controlledStdinChild();
    let stopped = false;
    let kill;
    const killed = new Promise(resolve => { kill = resolve; });
    child.kill = () => { kill(); child.emit("close", null); return true; };
    child.stdin.end = (_body, callback) => {
      stopped = true;
      queueMicrotask(() => callback(failInput ? Error("EPIPE") : null));
    };
    const result = await spawnStdinTurn({ file: "unused", args: [], stdinBody: Buffer.from("body"), timeoutMs: 0, cancelled: () => stopped }, () => {
      queueMicrotask(() => child.emit("spawn")); return child;
    });
    assert.equal(result.deliveryUnknown, true);
    assert.equal(result.inputEnded, false);
    await killed; // ordinary timer's actual kill event, not a sleep/poll
    child.emit("close", 0);
    assert.equal(result.deliveryUnknown, true);
  }
});

test("stdin actual runtime facts persist once; throws and after-child errors keep claim/grant consumed", { skip: process.platform !== "linux" }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-stdin-result-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const outcome of ["success", "unknown", "throw", "missing-start-proof", "adapter-spawnerror", "nochild"]) {
    const input = { ...command("pi", "default", `coordinate-audit-${outcome}`), promptDelivery: "stdin", initialMessage: { text: " 中文😀\n" } };
    writeGrant(directory, input.commandId);
    let calls = 0;
    const options = { stateDir: directory, cancelled: () => outcome === "unknown" && calls > 0,
      spawnTurn: async spec => {
        calls++;
        assert.equal(spec.args.includes(input.initialMessage.text), false);
        assert.equal(spec.stdinBody.toString(), input.initialMessage.text);
        if (outcome === "throw") throw Error("adapter spawned then threw");
        if (outcome === "missing-start-proof") return { code: 0, stdout: "Claimed success", inputEnded: true };
        if (outcome === "adapter-spawnerror") return { code: null, stdout: "", spawnError: true };
        if (outcome === "nochild") return defaultSpawn({ ...spec, file: path.join(directory, "no-executable") });
        return { code: 0, stdout: "Partial or complete audit.", childStarted: true, inputEnded: outcome === "success", ...(outcome === "unknown" ? { deliveryUnknown: true } : {}) };
      } };
    const result = await runCliTurn(input, options);
    assert.equal(result.messageDispatched, outcome === "nochild" ? false : outcome === "success" ? true : null);
    assert.deepEqual(result.auditInputTransport, { instanceId: "pi", promptDelivery: "stdin", inputBytes: Buffer.byteLength(input.initialMessage.text), inputEnded: outcome === "success" });
    assert.equal(fs.existsSync(path.join(directory, `claim-${input.commandId}`)), outcome !== "nochild");
    const grants = fs.existsSync(path.join(directory, "send-authorization")) ? fs.readFileSync(path.join(directory, "send-authorization"), "utf8") : "";
    assert.equal(grants.includes(input.commandId), outcome === "nochild");
    if (outcome !== "nochild") {
      assert.deepEqual(await runCliTurn(input, options), result);
      assert.equal(calls, 1);
    }
  }
});

test("extended role ids cannot substitute for per-turn authorization grants", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-cli-no-write-grant-"));
  let spawns = 0;
  try {
    for (const role of ["execute", "audit"]) {
      const commandId = `coordinate-${role}-codex`;
      const input = role === "execute"
        ? writeCommand("codex", "gpt-6.1-sol", commandId)
        : command("codex", "gpt-6.1-sol", commandId);
      const result = await runCliTurn(input, { stateDir: directory, spawnTurn: async () => {
        spawns += 1;
        return { code: 0, stdout: "" };
      } });
      assert.equal(result.ok, false);
      assert.equal(result.messageDispatched, false);
      assert.equal(fs.existsSync(path.join(directory, `claim-${commandId}`)), false);
    }
    assert.equal(spawns, 0);
    // Live scoped write consent is separately enforced by coordinate-service.
    // M7 may now mint these ids; the obsolete M5 grep-only dormant pin is gone.
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
