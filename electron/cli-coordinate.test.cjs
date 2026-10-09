const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverCliProviders, runCliTurn, codexReply, claudeReply, turnSpec, launchSpec, killProcessTree, defaultExec } = require("./cli-coordinate.cjs");

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
