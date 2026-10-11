import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { materializeStubBin, stubWrapperSource, writeStubBehavior } from "./lib/stubbin.mjs";
import { createExecutionFixture, EXECUTION_FIXTURE_INCOMPLETE_SOURCE, EXECUTION_OPERATION_PRESETS, EXECUTION_PRESETS } from "./lib/execution-fixture.mjs";
import { DIAGNOSTIC_STDOUT, normalizeBehavior, STUB_BEHAVIORS } from "./stub-harness.mjs";

const require = createRequire(import.meta.url);
const {
  codexEnvironmentBlocked,
  codexReply,
  codexToolSuccess,
  claudeReply,
  discoverCliProviders,
  launchSpec,
  runCliTurn,
  writeGrant,
} = require("../../electron/cli-coordinate.cjs");
const { readHealth } = require("../../electron/harness-health.cjs");
const CLI_FIXTURE_FILE = new URL("../../electron/cli-coordinate.test.cjs", import.meta.url);
const PROVIDER_ERROR_FIXTURE_FILE = new URL("../../src/coordination/providerError.test.ts", import.meta.url);
const PROVIDER_ERROR_MODULE = new URL("../../src/coordination/providerError.ts", import.meta.url);
const STUB_PROGRAM = new URL("./stub-harness.mjs", import.meta.url);
const SECRET_PROMPT_MARKER = "fake-secret-do-not-log-m1";

function behaviorConfig({ probes, turns } = {}) {
  return {
    probes: probes ?? { codex: "codex-probe-authenticated", claude: "claude-probe-authenticated" },
    turns: turns ?? { codex: [], claude: [] },
  };
}

function fixture(t, behavior = behaviorConfig(), wrapperOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goalport stub harness M1 with spaces-"));
  const stubDir = path.join(root, "generated stub bin with spaces");
  const home = path.join(root, "isolated HOME with spaces");
  const worktree = path.join(root, "synthetic workspace with spaces");
  const stateDir = path.join(root, "isolated state");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const materialized = materializeStubBin(stubDir, { behavior, ...wrapperOptions });
  const env = {
    ...process.env,
    PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: root,
    TEMP: root,
    TMP: root,
    GOALPORT_STUB_DIR: stubDir,
    GOALPORT_STUB_SENTINEL: materialized.sentinel,
  };
  // The stub acceptance surface is intentionally hermetic. No inherited
  // checkout/profile state is allowed to steer discovery to another backend.
  for (const key of ["GOALPORT_HARNESS_CHECKOUT", "GOALPORT_HARNESS_SERVER_CWD", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) delete env[key];
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const harness = {
    root,
    stubDir,
    home,
    worktree,
    stateDir,
    env,
    sentinel: materialized.sentinel,
    nextId: 0,
    writeBehavior(next) { writeStubBehavior(stubDir, next); },
    log() {
      const text = fs.readFileSync(path.join(stubDir, "invocations.jsonl"), "utf8");
      return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    },
  };
  assertStubResolution(harness);
  return harness;
}

function assertStubResolution(harness) {
  for (const identity of ["codex", "claude"]) {
    const wrapper = harness.env.PATH.split(path.delimiter)[0];
    const filename = path.join(wrapper, `${identity}${process.platform === "win32" ? ".cmd" : ""}`);
    assert.equal(fs.existsSync(filename), true, `${identity} wrapper must exist in first PATH directory`);
    if (process.platform !== "win32") fs.accessSync(filename, fs.constants.X_OK);
    assert.equal(path.isAbsolute(process.execPath), true, "generated POSIX wrappers embed the absolute Node executable");
    if (process.platform !== "win32") assert.ok(fs.readFileSync(filename, "utf8").includes(process.execPath));
    const launch = launchSpec(identity, [], harness.env, process.platform);
    if (process.platform === "win32") {
      assert.equal(launch.file, harness.env.ComSpec || "cmd.exe");
      assert.equal(launch.verbatim, true);
      const escaped = filename.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
      assert.equal(typeof launch.args[3], "string", `${identity} must launch through cmd /c`);
      assert.ok(launch.args[3].includes(escaped), `${identity} must resolve to its generated .cmd wrapper`);
    } else {
      // POSIX spawn searches PATH, so proving the executable wrapper is first
      // prevents accidental fallthrough to any host CLI before discovery.
      assert.equal(launch.file, identity);
      assert.equal(wrapper, harness.stubDir);
    }
  }
}

function spawnStubProcess(harness, identity, args, cwd = harness.worktree, env = harness.env) {
  assert.ok(IDENTITIES.has(identity), `only a pinned stub identity may run: ${identity}`);
  const launch = process.platform === "win32"
    ? { file: process.execPath, args: [STUB_PROGRAM.pathname, identity, ...args] }
    : { file: path.join(harness.stubDir, identity), args };
  return spawnSync(launch.file, launch.args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 200000,
    shell: false,
    windowsHide: true,
  });
}

const IDENTITIES = new Set(["codex", "claude"]);

function commandFor(harness, instanceId, { writes = false, worktree = harness.worktree } = {}) {
  harness.nextId += 1;
  return {
    commandId: `coordinate-plan-${instanceId}-m1-${harness.nextId}`,
    type: "goalport.coordinateTurn",
    modelSelection: { instanceId, model: instanceId === "codex" ? "gpt-6.1-sol" : "opus" },
    runtimeMode: "approval-required",
    approvalPolicy: "never",
    sandboxPolicy: { type: writes ? "workspaceWrite" : "readOnly" },
    workspaceStrategy: { type: "existing_worktree", worktreePath: worktree },
    initialMessage: { text: `Offline acceptance prompt containing ${SECRET_PROMPT_MARKER}; never put this prompt in invocation logs.` },
  };
}

async function runTurn(harness, instanceId, { writes = false, worktree = harness.worktree } = {}) {
  const command = commandFor(harness, instanceId, { writes, worktree });
  assert.equal(writeGrant(harness.stateDir, command.commandId), true);
  // Spawn only the generated wrapper by absolute path. This still exercises
  // runCliTurn's real argv/normalization path, but cannot fall through to a
  // host vendor CLI if bare-command resolution ignores this invocation PATH.
  const spawnTurn = (spec) => {
    const child = spawnStubProcess(harness, instanceId, spec.args, spec.cwd);
    return {
      code: child.status,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
      ...(child.error ? { spawnError: true } : {}),
    };
  };
  return runCliTurn(command, { stateDir: harness.stateDir, env: harness.env, spawnTurn });
}

async function discoverProviders(harness) {
  return discoverCliProviders({
    home: harness.home,
    stateDir: harness.stateDir,
    env: harness.env,
    timeoutMs: 5000,
    execFile(file, args) {
      assert.ok(IDENTITIES.has(file), `only a pinned stub identity may be probed: ${file}`);
      const child = spawnStubProcess(harness, file, args, harness.worktree);
      if (child.error) throw child.error;
      if (child.status !== 0) {
        const error = new Error(`synthetic ${file} probe exited ${child.status}`);
        error.stdout = child.stdout ?? "";
        error.stderr = child.stderr ?? "";
        throw error;
      }
      return { stdout: child.stdout ?? "", stderr: child.stderr ?? "", code: child.status };
    },
  });
}

async function providerErrorClassifier() {
  const module = await import(PROVIDER_ERROR_MODULE.href);
  return module.classifyProviderError;
}

test("stub output corpus is pinned to the real Electron fixtures", () => {
  const source = fs.readFileSync(CLI_FIXTURE_FILE, "utf8");
  const diagnostic = /^const DIAGNOSTIC_STDOUT = ("(?:[^"\\]|\\.)*");$/m.exec(source);
  assert.ok(diagnostic, "the real CLI test keeps the captured diagnostic fixture declaration");
  assert.equal(DIAGNOSTIC_STDOUT, JSON.parse(diagnostic[1]), "environment-blocked output is byte-copied from DIAGNOSTIC_STDOUT");
  assert.equal(STUB_BEHAVIORS["codex-environment-blocked"].stdout, JSON.parse(diagnostic[1]));

  for (const line of STUB_BEHAVIORS["codex-tool-success"].stdout.trim().split("\n")) {
    assert.ok(source.includes(line), `codex tool-success fixture line is copied: ${line}`);
  }
  for (const behaviorId of ["codex-success", "codex-not-finished", "claude-success", "claude-review-success", "claude-is-error", "claude-stderr-environment-fallback"]) {
    const behavior = STUB_BEHAVIORS[behaviorId];
    const sourceText = behavior.stdout || behavior.stderr;
    for (const line of sourceText.split("\n").filter(Boolean)) {
      const sourceLiteralText = line.replaceAll("\\", "\\\\");
      assert.ok(source.includes(sourceLiteralText), `${behaviorId} fixture line is copied from cli-coordinate.test.cjs: ${line}`);
    }
  }
  const providerFixture = fs.readFileSync(PROVIDER_ERROR_FIXTURE_FILE, "utf8");
  assert.ok(providerFixture.includes("usage limit reached"), "usage-limit phrase matches the actual closed-set classifier fixture");
  assert.equal(STUB_BEHAVIORS["claude-usage-limit"].stderr, "usage limit reached");

  assert.equal(codexReply(STUB_BEHAVIORS["codex-success"].stdout), "Bounded plan.");
  assert.equal(codexToolSuccess(STUB_BEHAVIORS["codex-tool-success"].stdout), true);
  assert.equal(codexReply(STUB_BEHAVIORS["codex-tool-success"].stdout), "Bounded plan.");
  assert.equal(codexEnvironmentBlocked(DIAGNOSTIC_STDOUT)?.includes("helper_unknown_error"), true);
  assert.deepEqual(claudeReply(STUB_BEHAVIORS["claude-success"].stdout), { text: "Stop.\nVERDICT: stop", failed: false });
  assert.deepEqual(claudeReply(STUB_BEHAVIORS["claude-is-error"].stdout), { text: "Model refused.", failed: true });
});

test("real discovery probes, unavailable-provider response, turn queues, and prompt-safe invocation accounting", async (t) => {
  const harness = fixture(t, behaviorConfig({
    turns: { codex: ["codex-success", "codex-not-finished"], claude: [] },
  }));

  const firstDiscovery = await discoverProviders(harness);
  assert.deepEqual(firstDiscovery.providers.map((provider) => provider.instanceId), ["codex", "claude"]);
  assert.equal(firstDiscovery.providers[0].auth.type, "chatgpt");
  assert.equal(firstDiscovery.providers[1].auth.type, "subscription");

  const firstTurn = await runTurn(harness, "codex");
  assert.equal(firstTurn.ok, true);
  assert.equal(firstTurn.text, "Bounded plan.");

  // Probes run between turn queue entries but cannot consume a queued turn.
  const secondDiscovery = await discoverProviders(harness);
  assert.deepEqual(secondDiscovery.providers.map((provider) => provider.instanceId), ["codex", "claude"]);
  const secondTurn = await runTurn(harness, "codex");
  assert.equal(secondTurn.ok, false);
  assert.equal(secondTurn.stopCode, "not-finished");

  // Rewriting behavior.json is observed by the very next spawned invocation.
  harness.writeBehavior(behaviorConfig({
    probes: { codex: "codex-probe-authenticated", claude: "claude-probe-unavailable" },
    turns: { codex: ["codex-no-text"], claude: [] },
  }));
  const unavailable = await discoverProviders(harness);
  assert.deepEqual(unavailable.providers.map((provider) => provider.instanceId), ["codex"]);
  const thirdTurn = await runTurn(harness, "codex");
  assert.equal(thirdTurn.ok, false);
  assert.equal(thirdTurn.stopCode, "no-text");

  const log = harness.log();
  const probes = log.filter((entry) => entry.invocationType === "probe");
  const turns = log.filter((entry) => entry.invocationType === "turn");
  assert.equal(probes.length, 6, "both wrapper-backed probes ran for each of three discoveries");
  assert.equal(probes.filter((entry) => entry.identity === "codex").length, 3);
  assert.equal(probes.filter((entry) => entry.identity === "claude").length, 3);
  assert.deepEqual(turns.map((entry) => entry.behaviorId), ["codex-success", "codex-not-finished", "codex-no-text"]);
  assert.deepEqual(turns.map((entry) => entry.queueIndex), [0, 1, 0], "probe calls do not advance turn queues and a behavior rewrite starts a new epoch");
  assert.equal(log.find((entry) => entry.identity === "claude" && entry.behaviorId === "claude-probe-unavailable").invocationType, "probe");
  assert.equal(log.every((entry) => typeof entry.identity === "string" && Array.isArray(entry.argv) && typeof entry.cwd === "string" && typeof entry.behaviorId === "string"), true);
  assert.equal(JSON.stringify(log).includes(SECRET_PROMPT_MARKER), false, "user-authored prompt is never logged");
  assert.equal(JSON.stringify(log).includes(harness.sentinel), false, "sentinel is never logged");
  assert.ok(turns.every((entry) => entry.argv.at(-1) === "[redacted prompt]"));
  assert.ok(log.every((entry) => entry.cwd === harness.worktree || entry.invocationType === "probe"));
});

test("all failure and success classes flow through actual spawned wrappers and production normalizers", async (t) => {
  const harness = fixture(t, behaviorConfig({
    turns: {
      codex: ["codex-success", "codex-tool-success", "codex-environment-blocked", "codex-no-text", "codex-not-finished"],
      claude: ["claude-success", "claude-is-error", "claude-stderr-environment-fallback", "claude-usage-limit"],
    },
  }));
  const classifyProviderError = await providerErrorClassifier();
  const discovered = await discoverProviders(harness);
  assert.deepEqual(discovered.providers.map((provider) => provider.instanceId), ["codex", "claude"]);

  const codexSuccess = await runTurn(harness, "codex");
  assert.equal(codexSuccess.ok, true);
  assert.equal(codexSuccess.text, "Bounded plan.");

  const toolSuccess = await runTurn(harness, "codex");
  assert.equal(toolSuccess.ok, true);
  assert.equal(codexToolSuccess(STUB_BEHAVIORS["codex-tool-success"].stdout), true);

  const typedEnvironment = await runTurn(harness, "codex");
  assert.equal(typedEnvironment.ok, false);
  assert.equal(typedEnvironment.environmentBlocked, true);
  assert.equal(typedEnvironment.messageDispatched, true);
  assert.match(typedEnvironment.environmentDetail, /helper_unknown_error/);
  assert.equal(classifyProviderError(typedEnvironment.environmentDetail), "environment");
  assert.equal(readHealth(harness.stateDir).codex.commandId.startsWith("coordinate-plan-codex-m1-"), true);

  const noText = await runTurn(harness, "codex");
  assert.equal(noText.stopCode, "no-text");
  assert.equal(noText.messageDispatched, true);

  const notFinished = await runTurn(harness, "codex");
  assert.equal(notFinished.stopCode, "not-finished");
  assert.equal(notFinished.text, "partial");

  const claudeSuccess = await runTurn(harness, "claude");
  assert.equal(claudeSuccess.ok, true);
  assert.equal(claudeSuccess.text, "Stop.\nVERDICT: stop");

  const isError = await runTurn(harness, "claude");
  assert.equal(isError.ok, false);
  assert.equal(isError.text, "Model refused.");
  assert.equal(isError.stopCode, null, "provider-level is_error does not become a resumable stop code");

  const stderrFallback = await runTurn(harness, "claude");
  assert.equal(stderrFallback.ok, false);
  assert.equal(stderrFallback.environmentBlocked, undefined, "stderr fallback is not the typed Codex JSONL branch");
  assert.equal(classifyProviderError(stderrFallback.errorText), "environment");
  assert.match(readHealth(harness.stateDir).claude.detail, /windows sandbox failed: helper_unknown_error/);

  const usageLimit = await runTurn(harness, "claude");
  assert.equal(usageLimit.ok, false);
  assert.equal(classifyProviderError(usageLimit.errorText), "usage_limit");

  const turnLog = harness.log().filter((entry) => entry.invocationType === "turn");
  assert.deepEqual(turnLog.map((entry) => entry.behaviorId), [
    "codex-success",
    "codex-tool-success",
    "codex-environment-blocked",
    "codex-no-text",
    "codex-not-finished",
    "claude-success",
    "claude-is-error",
    "claude-stderr-environment-fallback",
    "claude-usage-limit",
  ]);
  assert.equal(turnLog.length, 9);
});

test("sentinel absence refuses before output or turn accounting", (t) => {
  const harness = fixture(t, behaviorConfig({ turns: { codex: ["codex-success"], claude: [] } }));
  const env = { ...harness.env };
  delete env.GOALPORT_STUB_SENTINEL;
  const result = spawnSync(process.execPath, [STUB_PROGRAM.pathname, "codex", "login", "status"], {
    cwd: harness.worktree,
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 42);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /sentinel missing or mismatched/);
  const [entry] = harness.log();
  assert.equal(entry.identity, "codex");
  assert.equal(entry.invocationType, "probe");
  assert.equal(entry.behaviorId, "sentinel-refused");
  assert.equal(entry.consumesQueue, false);
  assert.equal(entry.queueIndex, null);
  assert.equal(JSON.stringify(entry).includes(harness.sentinel), false);
});

test("generated Windows wrappers and launchSpec keep absolute paths and argv quoted across spaces", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goalport windows stub wrapper M1 with spaces-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const stubDir = path.join(root, "generated Windows bin with spaces");
  const nodeExecutable = "C:\\Program Files\\Node.js\\node.exe";
  const scriptPath = "C:\\Repo With Spaces\\scripts\\acceptance\\stub-harness.mjs";
  const materialized = materializeStubBin(stubDir, {
    platform: "win32",
    nodeExecutable,
    scriptPath,
    behavior: behaviorConfig(),
  });
  for (const identity of ["codex", "claude"]) {
    const source = fs.readFileSync(materialized.wrappers[identity], "utf8");
    assert.match(source, /set "GOALPORT_STUB_DIR=%~dp0"/);
    assert.ok(source.includes(`"${nodeExecutable}" "${scriptPath}" ${identity} %*`));
    assert.match(source, /exit \/b %errorlevel%/);
    assert.equal(source.includes("%GOALPORT_STUB_SENTINEL%"), false, "wrapper never logs or substitutes the sentinel");
  }
  assert.equal(stubWrapperSource.windows("codex", nodeExecutable, scriptPath), fs.readFileSync(materialized.wrappers.codex, "utf8"));

  const env = {
    PATH: stubDir,
    PATHEXT: ".COM;.EXE;.BAT;.cmd",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  };
  const launch = launchSpec("codex", ["exec", "--cd", "C:\\workspace with spaces", "prompt (safe) & not a command"], env, "win32");
  assert.equal(launch.file, env.ComSpec);
  assert.equal(launch.verbatim, true);
  assert.equal(launch.args.slice(0, 3).join(" "), "/d /s /c");
  assert.ok(launch.args[3].includes("generated^ Windows^ bin^ with^ spaces"), "the actual launchSpec contract quotes the .cmd path with spaces");
  assert.ok(launch.args[3].includes("^&"), "prompt metacharacters stay inert through cmd.exe");
  assert.ok(launch.args[3].includes("^("), "prompt parentheses stay inert through cmd.exe");
});

test("M2 carry-out, Claude no-text and fixed bounded delay use actual spawned stubs", async (t) => {
  const harness = fixture(t, behaviorConfig({ turns: { codex: [], claude: ['claude-carry-out', 'claude-no-text', 'claude-carry-out-delayed'] } }));
  const sessionFixture = fs.readFileSync(new URL('../../src/coordination/coordinateSession.test.ts', import.meta.url), 'utf8');
  const expected = 'The plan can be carried out.\nVERDICT: carry-out';
  assert.ok(sessionFixture.includes(JSON.stringify(expected)));
  assert.deepEqual(claudeReply(STUB_BEHAVIORS['claude-carry-out'].stdout), {text:expected, failed:false});
  assert.equal(STUB_BEHAVIORS['claude-carry-out-delayed'].stdout, STUB_BEHAVIORS['claude-carry-out'].stdout);
  const success = await runTurn(harness, 'claude');
  assert.equal(success.ok, true);
  assert.equal(success.text, expected);
  const empty = await runTurn(harness, 'claude');
  assert.equal(empty.stopCode, 'no-text');
  assert.equal(empty.messageDispatched, true);
  const start = Date.now();
  const delayed = await runTurn(harness, 'claude');
  assert.ok(Date.now() - start >= 5900);
  assert.equal(STUB_BEHAVIORS['claude-carry-out-delayed'].delayMs, 6000);
  assert.equal(delayed.ok, true);
  assert.equal(delayed.text, expected);
  assert.equal(harness.log().filter(e => e.invocationType === 'turn').length, 3);
});

test("continuation fixture operations stay closed to their preset and pin the b1-b3 queues", () => {
  const continuation = {
    "codex-fixture-incomplete-writer": "incomplete-writer",
    "codex-fixture-corrective-plan": "corrective-plan",
    "codex-fixture-corrective-writer": "corrective-writer",
    "claude-fixture-critique-checker": "critique-checker",
  };
  for (const [behaviorId, operation] of Object.entries(continuation)) {
    const behavior = STUB_BEHAVIORS[behaviorId];
    assert.equal(behavior?.kind, "turn", `${behaviorId} is a closed turn behavior`);
    assert.equal(behavior.fixtureOperation, operation);
    assert.equal(behavior.stdout, "", "fixture operations build provider output from their own evidence, not canned text");
    assert.deepEqual(EXECUTION_OPERATION_PRESETS[operation], ["c1-feedback-repair"]);
    assert.equal(behavior.exitCode, 0, `${behaviorId} declares a completed CLI turn`);
  }
  assert.deepEqual(EXECUTION_PRESETS["c1-feedback-repair"].codex, ["codex-fixture-plan", "codex-fixture-incomplete-writer", "codex-fixture-corrective-plan", "codex-fixture-corrective-writer"]);
  assert.deepEqual(EXECUTION_PRESETS["c1-feedback-repair"].claude, ["claude-fixture-critique-checker", "claude-fixture-auditor"]);
  // b1/b2/b3 keep their exact closed queues and the partial writer keeps its
  // terminal failed turn.
  assert.deepEqual(EXECUTION_PRESETS["b1-full-chain"].codex, ["codex-fixture-plan", "codex-fixture-writer"]);
  assert.deepEqual(EXECUTION_PRESETS["b1-full-chain"].claude, ["claude-fixture-auditor"]);
  assert.deepEqual(EXECUTION_PRESETS["b2-no-write"].codex, ["codex-fixture-plan", "codex-fixture-no-write"]);
  assert.deepEqual(EXECUTION_PRESETS["b3-partial-failure"].codex, ["codex-fixture-plan", "codex-fixture-partial-writer"]);
  assert.equal(STUB_BEHAVIORS["codex-fixture-partial-writer"].exitCode, 1, "the b3 partial writer stays a failed CLI turn");
  assert.deepEqual(EXECUTION_OPERATION_PRESETS["partial-writer"], ["b3-partial-failure"]);
  const knownOperations = new Set(Object.keys(EXECUTION_OPERATION_PRESETS));
  for (const [behaviorId, behavior] of Object.entries(STUB_BEHAVIORS)) {
    if (behavior.fixtureOperation === undefined) continue;
    assert.ok(knownOperations.has(behavior.fixtureOperation), `${behaviorId} names an operation in the closed matrix`);
  }
  assert.throws(() => normalizeBehavior(behaviorConfig({ turns: { codex: ["codex-fixture-arbitrary-command"], claude: [] } })), /known turn responses/u);
});

test("a completed failed-check turn stays distinct from the terminal b3 failed turn at the spawned boundary", async (t) => {
  const continuation = createExecutionFixture("c1-feedback-repair");
  const partial = createExecutionFixture("b3-partial-failure");
  t.after(() => { continuation.dispose(); partial.dispose(); });
  const c1 = fixture(t, behaviorConfig({
    turns: { codex: ["codex-fixture-incomplete-writer"], claude: ["claude-fixture-critique-checker"] },
  }), { executionFixture: continuation.config });
  const b3 = fixture(t, behaviorConfig({ turns: { codex: ["codex-fixture-partial-writer"], claude: [] } }), { executionFixture: partial.config });
  // The stub validates that the driver-bound fixture root really lives under
  // the OS temp directory; this helper's own TMPDIR is the harness root, so
  // these spawns keep the real temp directory the fixture was created under.
  const c1Env = { ...c1.env, TMPDIR: path.dirname(continuation.root), TEMP: path.dirname(continuation.root), TMP: path.dirname(continuation.root) };
  const b3Env = { ...b3.env, TMPDIR: path.dirname(partial.root), TEMP: path.dirname(partial.root), TMP: path.dirname(partial.root) };

  const firstWriter = spawnStubProcess(c1, "codex", ["exec", "--sandbox", "workspace-write", "--cd", continuation.root, "prompt"], continuation.root, c1Env);
  assert.equal(firstWriter.status, 0, "failed checks are feedback reported by a completed CLI turn");
  const firstMessage = JSON.parse(firstWriter.stdout);
  assert.match(firstMessage.item.text, /still fail \(1 passed, 1 failed\)/u);
  assert.equal(codexReply(firstWriter.stdout), firstMessage.item.text.trim());
  assert.equal(fs.readFileSync(continuation.sourcePath, "utf8"), EXECUTION_FIXTURE_INCOMPLETE_SOURCE);

  const critique = spawnStubProcess(c1, "claude", ["--permission-mode", "plan", "prompt"], continuation.root, c1Env);
  assert.equal(critique.status, 0, "the critique turn completes while its own check command exits 1");
  const critiqueMessage = JSON.parse(critique.stdout);
  assert.equal(critiqueMessage.is_error, false);
  assert.match(critiqueMessage.result, /VERDICT: revise$/u);
  assert.deepEqual(claudeReply(critique.stdout), { text: critiqueMessage.result.trim(), failed: false });

  const partialTurn = spawnStubProcess(b3, "codex", ["exec", "--sandbox", "workspace-write", "--cd", partial.root, "prompt"], partial.root, b3Env);
  assert.equal(partialTurn.status, 1, "a failed CLI turn stays terminal");
  const partialMessage = JSON.parse(partialTurn.stdout);
  assert.match(partialMessage.item.text, /Partial edit retained/u);
  assert.doesNotMatch(partialMessage.item.text, /VERDICT: revise/u);
  assert.equal(codexReply(partialTurn.stdout), partialMessage.item.text.trim());

  const operations = fs.readFileSync(path.join(c1.stubDir, "execution-operations.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(operations.map(({ operation }) => operation), ["incomplete-writer", "critique-checker"]);
  assert.equal(operations[0].exitCode, 0);
  assert.equal(operations[0].evidence.checks.command.exitCode, 1, "the writer's own check command really failed");
  assert.equal(operations[1].status, "completed");
  assert.equal(operations[1].verdict, "revise");
  assert.equal(operations[1].evidence.observedFailure, true);
  assert.equal(operations[1].evidence.checker.testCommand.exitCode, 1, "the checker's own check command really failed");
  assert.equal(operations[1].evidence.checker.pid === operations[1].evidence.parentPid, false, "the checker is its own process");
  assert.equal(operations[1].evidence.checker.testCommand.pid === operations[1].evidence.checker.pid, false, "the checker's check runner is another process");

  const turnLog = c1.log().filter((entry) => entry.invocationType === "turn");
  assert.deepEqual(turnLog.map((entry) => [entry.behaviorId, entry.exitCode, entry.fixtureStatus, entry.fixtureVerdict]), [
    ["codex-fixture-incomplete-writer", 0, "completed", null],
    ["claude-fixture-critique-checker", 0, "completed", "revise"],
  ]);
  assert.equal(JSON.stringify(c1.log()).includes(SECRET_PROMPT_MARKER), false);
  assert.equal(JSON.stringify(c1.log()).includes(c1.sentinel), false);
  assert.equal(JSON.stringify(operations).includes(c1.sentinel), false);

  // Rewriting behavior.json keeps the driver-bound fixture config, so the
  // corrective plan still reads the actual intermediate workspace bytes.
  c1.writeBehavior(behaviorConfig({ turns: { codex: ["codex-fixture-corrective-plan"], claude: [] } }));
  const correctivePlan = spawnStubProcess(c1, "codex", ["exec", "--sandbox", "read-only", "--cd", continuation.root, "prompt"], continuation.root, c1Env);
  assert.equal(correctivePlan.status, 0);
  const planMessage = JSON.parse(correctivePlan.stdout);
  assert.match(planMessage.item.text, /current intermediate src\/add\.mjs/u);
  assert.match(planMessage.item.text, /VERDICT: carry-out$/u);
  const planEvidence = JSON.parse(fs.readFileSync(path.join(c1.stubDir, "execution-operations.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(planEvidence.operation, "corrective-plan");
  assert.equal(planEvidence.evidence.sourceText, EXECUTION_FIXTURE_INCOMPLETE_SOURCE);
});
