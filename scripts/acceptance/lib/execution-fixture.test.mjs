import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { materializeStubBin, writeStubBehavior } from "./stubbin.mjs";
import {
  createExecutionFixture,
  EXECUTION_FIXTURE_INCOMPLETE_SOURCE,
  EXECUTION_FIXTURE_PARTIAL_SOURCE,
  EXECUTION_FIXTURE_REPAIRED_SOURCE,
} from "./execution-fixture.mjs";

const require = createRequire(import.meta.url);
const { runCliTurn, writeGrant } = require("../../../electron/cli-coordinate.cjs");
const SECRET_PROMPT_MARKER = "fixture-prompt-must-not-be-logged-m9";
const WINDOWS_INTEROP_OUT_OF_SCOPE = process.platform === "win32" ? "M9 file-mutation peers are exercised locally on POSIX; Windows interop is explicitly out of scope." : false;

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJsonLines(filename) {
  if (!fs.existsSync(filename)) return [];
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function setup(t, preset) {
  const fixture = createExecutionFixture(preset);
  const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-m9-execution-stub-"));
  const stubDir = path.join(stubRoot, "stub bin with spaces");
  const stateDir = path.join(stubRoot, "isolated state");
  fs.mkdirSync(stateDir, { recursive: true });
  const materialized = materializeStubBin(stubDir, {
    behavior: fixture.behavior,
    executionFixture: fixture.config,
  });
  const env = {
    ...process.env,
    PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: fixture.root,
    USERPROFILE: fixture.root,
    GOALPORT_STUB_DIR: stubDir,
    GOALPORT_STUB_SENTINEL: materialized.sentinel,
  };
  for (const key of ["GOALPORT_HARNESS_CHECKOUT", "GOALPORT_HARNESS_SERVER_CWD", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) delete env[key];
  let nextId = 0;
  const harness = {
    fixture,
    root: fixture.root,
    stubRoot,
    stubDir,
    stateDir,
    env,
    sentinel: materialized.sentinel,
    invocationPath: path.join(stubDir, "invocations.jsonl"),
    operationEvidencePath: path.join(stubDir, "execution-operations.jsonl"),
    invocations() { return readJsonLines(this.invocationPath); },
    operations() { return readJsonLines(this.operationEvidencePath); },
    setBehavior(behavior) { writeStubBehavior(stubDir, behavior); },
    async turn({ role, identity = "codex", writes = false, worktree = fixture.root, env: overrideEnv = env }) {
      nextId += 1;
      const commandId = `coordinate-${role}-m9-${nextId}`;
      const command = {
        commandId,
        type: "goalport.coordinateTurn",
        modelSelection: { instanceId: identity, model: identity === "codex" ? "gpt-6.1-sol" : "opus" },
        runtimeMode: "approval-required",
        approvalPolicy: "never",
        sandboxPolicy: { type: writes ? "workspaceWrite" : "readOnly" },
        workspaceStrategy: { type: "existing_worktree", worktreePath: worktree },
        initialMessage: { text: `Synthetic M9 ${role} turn with ${SECRET_PROMPT_MARKER}; fixture operations are closed and offline.` },
      };
      assert.equal(writeGrant(stateDir, commandId), true);
      // Pin the spawned executable by absolute path so no host vendor CLI can
      // be reached if command-name resolution changes in the runner.
      const spawnTurn = (spec) => {
        const extension = process.platform === "win32" ? ".cmd" : "";
        const wrapper = path.join(stubDir, `${spec.file}${extension}`);
        const spawned = spawnSync(wrapper, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 200000,
          shell: false,
          windowsHide: true,
        });
        return {
          code: spawned.status,
          stdout: spawned.stdout ?? "",
          stderr: spawned.stderr ?? "",
          ...(spawned.error ? { spawnError: true } : {}),
        };
      };
      return runCliTurn(command, { stateDir, env: overrideEnv, spawnTurn });
    },
  };
  t.after(() => {
    fixture.dispose();
    fs.rmSync(stubRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return harness;
}

function runOriginalFixtureTests(root, relativeTestPath = "test/add.test.mjs") {
  return spawnSync(process.execPath, ["--test", relativeTestPath], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: path.dirname(root), TEMP: path.dirname(root), TMP: path.dirname(root) },
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 100000,
    shell: false,
  });
}

test("b1 real spawned writer repairs broken fixture and a distinct read-only auditor reruns unchanged tests", { skip: WINDOWS_INTEROP_OUT_OF_SCOPE }, async (t) => {
  const harness = setup(t, "b1-full-chain");
  const { fixture } = harness;
  const initialSource = fs.readFileSync(fixture.sourcePath);
  const pinnedTests = fs.readFileSync(fixture.testPath);
  const baseline = runOriginalFixtureTests(fixture.root);
  assert.equal(baseline.error, undefined);
  assert.equal(baseline.status, 1, "original node --test checks really fail before any edits");
  assert.match(`${baseline.stdout}\n${baseline.stderr}`, /ERR_ASSERTION|AssertionError/u);
  assert.equal(hash(fs.readFileSync(fixture.sourcePath)), fixture.config.sourceSha256);
  assert.equal(hash(fs.readFileSync(fixture.testPath)), fixture.config.testSha256);

  const plan = await harness.turn({ role: "plan" });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.match(plan.text, /VERDICT: carry-out/u);
  assert.match(plan.text, /unchanged test\/add\.test\.mjs/u);
  assert.equal(hash(fs.readFileSync(fixture.sourcePath)), fixture.config.sourceSha256, "planning is read-only");

  const writer = await harness.turn({ role: "execute", writes: true });
  assert.equal(writer.ok, true, writer.errorText);
  assert.match(writer.text, /unchanged pinned checks then passed \(2\/2\)/u);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), Buffer.from(EXECUTION_FIXTURE_REPAIRED_SOURCE));
  assert.deepEqual(fs.readFileSync(fixture.testPath), pinnedTests, "the original check file is byte-for-byte unchanged");
  assert.notDeepEqual(initialSource, fs.readFileSync(fixture.sourcePath));

  const auditor = await harness.turn({ role: "audit", identity: "claude" });
  assert.equal(auditor.ok, true, auditor.errorText);
  assert.match(auditor.text, /^VERIFIED by a separate read-only Node auditor process/u);
  assert.match(auditor.text, /No independent model judgment is claimed/u);
  const operations = harness.operations();
  assert.deepEqual(operations.map(({ operation }) => operation), ["plan", "writer", "auditor"]);
  const writerEvidence = operations[1];
  const auditorEvidence = operations[2];
  assert.equal(writerEvidence.sourceLabel, "synthetic-offline-fixture");
  assert.equal(writerEvidence.role, "executor");
  assert.equal(writerEvidence.exitCode, 0);
  assert.equal(writerEvidence.verified, false, "writer success alone is not independent verification");
  assert.equal(writerEvidence.evidence.baseline.command.exitCode, 1);
  assert.equal(writerEvidence.evidence.baseline.assertionFailureObserved, true);
  assert.equal(writerEvidence.evidence.checks.command.exitCode, 0);
  assert.equal(writerEvidence.evidence.baseline.command.cwd, fixture.root);
  assert.equal(writerEvidence.evidence.checks.command.cwd, fixture.root);
  assert.match(writerEvidence.evidence.checks.command.stdout, /# pass 2/u);
  assert.equal(writerEvidence.evidence.testBytesUnchanged, true);
  assert.equal(writerEvidence.evidence.edit.afterSha256, hash(EXECUTION_FIXTURE_REPAIRED_SOURCE));
  assert.equal(writerEvidence.cli.cwd, fixture.root);
  assert.equal(writerEvidence.cli.exitCode, 0);
  assert.equal(writerEvidence.cli.argv[4], "workspace-write");
  assert.equal(writerEvidence.cli.argv.at(-1), "[redacted prompt]");

  assert.equal(auditorEvidence.role, "read-only-auditor");
  assert.equal(auditorEvidence.verified, true);
  assert.equal(auditorEvidence.evidence.auditorProcess.exitCode, 0);
  assert.equal(auditorEvidence.evidence.auditor.pid === auditorEvidence.evidence.parentPid, false, "the auditor is a distinct spawned Node process");
  assert.equal(auditorEvidence.evidence.auditor.testCommand.pid === auditorEvidence.evidence.auditor.pid, false, "the auditor's test runner is another actual Node process");
  assert.equal(auditorEvidence.evidence.auditor.cwd, fixture.root);
  assert.equal(auditorEvidence.evidence.auditor.testCommand.cwd, fixture.root);
  assert.equal(auditorEvidence.evidence.auditor.testCommand.exitCode, 0);
  assert.match(auditorEvidence.evidence.auditor.testCommand.stdout, /# pass 2/u);
  assert.equal(auditorEvidence.evidence.sourceReadText, EXECUTION_FIXTURE_REPAIRED_SOURCE);
  assert.equal(auditorEvidence.evidence.testSha256, fixture.config.testSha256);
  assert.equal(auditorEvidence.evidence.auditor.noIndependentModelClaim, true);

  const invocations = harness.invocations();
  assert.deepEqual(invocations.filter((entry) => entry.invocationType === "turn").map((entry) => entry.behaviorId), [
    "codex-fixture-plan", "codex-fixture-writer", "claude-fixture-auditor",
  ]);
  assert.ok(invocations.every((entry) => entry.sourceLabel === "synthetic-offline-stub"));
  assert.equal(JSON.stringify(invocations).includes(SECRET_PROMPT_MARKER), false);
  assert.equal(JSON.stringify(invocations).includes(harness.sentinel), false);
  assert.equal(JSON.stringify(operations).includes(SECRET_PROMPT_MARKER), false);
  assert.equal(JSON.stringify(operations).includes(harness.sentinel), false);
});

test("b2 plan and carry-out read responses preserve all fixture bytes", { skip: WINDOWS_INTEROP_OUT_OF_SCOPE }, async (t) => {
  const harness = setup(t, "b2-no-write");
  const { fixture } = harness;
  const beforeSource = fs.readFileSync(fixture.sourcePath);
  const beforeTests = fs.readFileSync(fixture.testPath);
  const plan = await harness.turn({ role: "plan" });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const carryOut = await harness.turn({ role: "review" });
  assert.equal(carryOut.ok, true, JSON.stringify(carryOut));
  assert.match(carryOut.text, /no file edit was attempted/u);
  assert.match(carryOut.text, /VERDICT: carry-out/u);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), beforeSource);
  assert.deepEqual(fs.readFileSync(fixture.testPath), beforeTests);
  assert.ok(harness.operations().every((entry) => entry.exitCode === 0 && entry.evidence.changed === false));
  assert.deepEqual(harness.invocations().filter((entry) => entry.invocationType === "turn").map((entry) => entry.fixtureOperation), ["plan", "no-write"]);
});

test("b3 writer leaves a real partial edit, reports failed unchanged tests, and exits 1", { skip: WINDOWS_INTEROP_OUT_OF_SCOPE }, async (t) => {
  const harness = setup(t, "b3-partial-failure");
  const { fixture } = harness;
  const testBytes = fs.readFileSync(fixture.testPath);
  const result = await harness.turn({ role: "plan" });
  assert.equal(result.ok, true);
  const writer = await harness.turn({ role: "execute", writes: true });
  assert.equal(writer.ok, false);
  assert.equal(writer.stopCode, "not-finished");
  assert.match(writer.text, /Partial edit retained/u);
  assert.match(writer.text, /no verification success is claimed/u);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), Buffer.from(EXECUTION_FIXTURE_PARTIAL_SOURCE));
  assert.deepEqual(fs.readFileSync(fixture.testPath), testBytes);
  const evidence = harness.operations().at(-1);
  assert.equal(evidence.operation, "partial-writer");
  assert.equal(evidence.status, "partial-failure");
  assert.equal(evidence.exitCode, 1);
  assert.equal(evidence.evidence.edit.actualFileChanged, true);
  assert.equal(evidence.evidence.checks.command.exitCode, 1);
  assert.match(evidence.evidence.checks.command.stdout, /# fail 2/u);
  assert.equal(evidence.evidence.testBytesUnchanged, true);
  const invocation = harness.invocations().filter((entry) => entry.fixtureOperation === "partial-writer").at(-1);
  assert.equal(invocation.exitCode, 1);
  assert.equal(invocation.fixtureVerified, false);
  assert.equal(invocation.stdoutSha256, hash(invocation.stdout));
});

test("c1 continuation preset: a completed failed-check writer is critiqued, replanned, repaired, and verified", { skip: WINDOWS_INTEROP_OUT_OF_SCOPE }, async (t) => {
  const harness = setup(t, "c1-feedback-repair");
  const { fixture } = harness;
  const initialSource = fs.readFileSync(fixture.sourcePath);
  const pinnedTests = fs.readFileSync(fixture.testPath);
  const baseline = runOriginalFixtureTests(fixture.root);
  assert.equal(baseline.status, 1, "the pinned checks really fail before any continuation edit");
  assert.match(`${baseline.stdout}\n${baseline.stderr}`, /ERR_ASSERTION|AssertionError/u);

  const plan = await harness.turn({ role: "plan" });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.match(plan.text, /VERDICT: carry-out$/u);
  assert.equal(hash(fs.readFileSync(fixture.sourcePath)), fixture.config.sourceSha256, "the first plan is read-only");

  // 1. First writer: incomplete edit, really failing unchanged checks, and a
  // completed CLI turn that reports the failure honestly.
  const firstWriter = await harness.turn({ role: "execute", writes: true });
  assert.equal(firstWriter.ok, true, "a completed critique path starts from a completed CLI turn, not a failed one");
  assert.match(firstWriter.text, /still fail \(1 passed, 1 failed\)/u);
  assert.match(firstWriter.text, /claims no verification/u);
  assert.doesNotMatch(firstWriter.text, /VERIFIED/u);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), Buffer.from(EXECUTION_FIXTURE_INCOMPLETE_SOURCE));
  assert.deepEqual(fs.readFileSync(fixture.testPath), pinnedTests, "the original checks stay byte-for-byte unchanged");
  const intermediateBytes = fs.readFileSync(fixture.sourcePath);
  const intermediateHash = hash(intermediateBytes);
  assert.notDeepEqual(initialSource, intermediateBytes);
  const firstEvidence = harness.operations().at(-1);
  assert.equal(firstEvidence.operation, "incomplete-writer");
  assert.equal(firstEvidence.role, "executor");
  assert.equal(firstEvidence.status, "completed");
  assert.equal(firstEvidence.exitCode, 0, "the CLI turn completes; the failure belongs to the subprocess check command");
  assert.equal(firstEvidence.evidence.cliTurnCompleted, true);
  assert.equal(firstEvidence.evidence.checksFailed, true);
  assert.equal(firstEvidence.evidence.checks.command.exitCode, 1);
  assert.match(firstEvidence.evidence.checks.command.stdout, /# pass 1/u);
  assert.match(firstEvidence.evidence.checks.command.stdout, /# fail 1/u);
  assert.equal(firstEvidence.evidence.checks.testsPassed, false);
  assert.equal(firstEvidence.evidence.checks.testsFailed, true);
  assert.equal(firstEvidence.evidence.testBytesUnchanged, true);
  assert.equal(firstEvidence.evidence.edit.afterSha256, hash(EXECUTION_FIXTURE_INCOMPLETE_SOURCE));
  assert.equal(firstEvidence.evidence.baseline.command.exitCode, 1);
  assert.equal(firstEvidence.cli.exitCode, 0);
  assert.equal(firstEvidence.cli.cwd, fixture.root);

  // 2. Separate read-only checker: it observes the real failure in its own
  // process and only then completes its turn with a revise verdict.
  const critique = await harness.turn({ role: "audit", identity: "claude" });
  assert.equal(critique.ok, true, "a completed critique is not a failed CLI turn");
  assert.match(critique.text, /VERDICT: revise$/u);
  assert.match(critique.text, /which really failed \(1 passed, 1 failed\)/u);
  assert.doesNotMatch(critique.text, /VERIFIED/u);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), intermediateBytes, "the read-only checker changes nothing");
  const critiqueEvidence = harness.operations().at(-1);
  assert.equal(critiqueEvidence.operation, "critique-checker");
  assert.equal(critiqueEvidence.role, "read-only-checker");
  assert.equal(critiqueEvidence.status, "completed");
  assert.equal(critiqueEvidence.verdict, "revise");
  assert.equal(critiqueEvidence.verified, false, "a critique is feedback, not verification");
  assert.equal(critiqueEvidence.exitCode, 0);
  assert.equal(critiqueEvidence.evidence.observedFailure, true);
  assert.equal(critiqueEvidence.evidence.checkCommandFailed, true);
  assert.equal(critiqueEvidence.evidence.testCommandExitCode, 1);
  assert.equal(critiqueEvidence.evidence.checker.testCommand.exitCode, 1);
  assert.match(critiqueEvidence.evidence.checker.testCommand.stdout, /# fail 1/u);
  assert.equal(critiqueEvidence.evidence.sourceReadSha256, intermediateHash);
  assert.equal(critiqueEvidence.evidence.sourceReadText, EXECUTION_FIXTURE_INCOMPLETE_SOURCE);
  assert.equal(critiqueEvidence.evidence.checker.sourceRead.matchesIncompleteEdit, true);
  assert.equal(critiqueEvidence.evidence.testSha256, fixture.config.testSha256);
  assert.equal(critiqueEvidence.evidence.checker.originalTests.matchesPinnedBytes, true);
  assert.equal(critiqueEvidence.evidence.checker.noIndependentModelClaim, true);
  assert.equal(critiqueEvidence.evidence.checker.pid === critiqueEvidence.evidence.parentPid, false, "the critique checker is a distinct spawned Node process");
  assert.equal(critiqueEvidence.evidence.checker.testCommand.pid === critiqueEvidence.evidence.checker.pid, false, "the checker's check runner is another actual Node process");
  assert.equal(critiqueEvidence.cli.cwd, fixture.root);
  assert.equal(critiqueEvidence.cli.exitCode, 0);

  // 3. Corrective planner reads the actual intermediate source, not the
  // original plan's assumption.
  const correctivePlan = await harness.turn({ role: "plan" });
  assert.equal(correctivePlan.ok, true, JSON.stringify(correctivePlan));
  assert.match(correctivePlan.text, /current intermediate src\/add\.mjs/u);
  assert.match(correctivePlan.text, /observed those unchanged pinned checks fail/u);
  assert.match(correctivePlan.text, /VERDICT: carry-out$/u);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), intermediateBytes, "the corrective planner only reads");
  const planEvidence = harness.operations().at(-1);
  assert.equal(planEvidence.operation, "corrective-plan");
  assert.equal(planEvidence.role, "read-only-plan");
  assert.equal(planEvidence.evidence.sourceSha256, intermediateHash);
  assert.equal(planEvidence.evidence.sourceText, EXECUTION_FIXTURE_INCOMPLETE_SOURCE);

  // 4. Corrective writer repairs the actual intermediate file and reruns the
  // unchanged checks.
  const correctiveWriter = await harness.turn({ role: "execute", writes: true });
  assert.equal(correctiveWriter.ok, true, JSON.stringify(correctiveWriter));
  assert.match(correctiveWriter.text, /passes the unchanged pinned node --test checks \(2\/2\)/u);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), Buffer.from(EXECUTION_FIXTURE_REPAIRED_SOURCE));
  assert.deepEqual(fs.readFileSync(fixture.testPath), pinnedTests);
  const writerEvidence = harness.operations().at(-1);
  assert.equal(writerEvidence.operation, "corrective-writer");
  assert.equal(writerEvidence.status, "completed");
  assert.equal(writerEvidence.exitCode, 0);
  assert.equal(writerEvidence.evidence.cliTurnCompleted, true);
  assert.equal(writerEvidence.evidence.checksFailed, false);
  assert.equal(writerEvidence.evidence.checks.command.exitCode, 0);
  assert.match(writerEvidence.evidence.checks.command.stdout, /# pass 2/u);
  assert.equal(writerEvidence.evidence.baseline.command.exitCode, 1, "the corrective writer first observed the real intermediate failure");
  assert.equal(writerEvidence.evidence.edit.beforeSha256, intermediateHash);
  assert.equal(writerEvidence.evidence.edit.afterSha256, hash(EXECUTION_FIXTURE_REPAIRED_SOURCE));
  assert.equal(writerEvidence.evidence.testBytesUnchanged, true);

  // 5. Separate read-only checker verifies only after the passing rerun.
  const secondChecker = await harness.turn({ role: "audit", identity: "claude" });
  assert.equal(secondChecker.ok, true, secondChecker.errorText);
  assert.match(secondChecker.text, /^VERIFIED by a separate read-only Node auditor process/u);
  assert.match(secondChecker.text, /VERDICT: verified$/u);
  const auditorEvidence = harness.operations().at(-1);
  assert.equal(auditorEvidence.operation, "auditor");
  assert.equal(auditorEvidence.verified, true);
  assert.equal(auditorEvidence.evidence.auditor.testCommand.exitCode, 0);
  assert.match(auditorEvidence.evidence.auditor.testCommand.stdout, /# pass 2/u);
  assert.equal(auditorEvidence.evidence.auditor.pid === auditorEvidence.evidence.parentPid, false);
  assert.equal(auditorEvidence.evidence.auditor.pid === critiqueEvidence.evidence.checker.pid, false, "each read-only checker is its own process");
  assert.equal(auditorEvidence.evidence.auditor.testCommand.pid === auditorEvidence.evidence.auditor.pid, false);
  assert.equal(auditorEvidence.evidence.testSha256, fixture.config.testSha256);

  const operations = harness.operations();
  assert.deepEqual(operations.map(({ operation }) => operation), ["plan", "incomplete-writer", "critique-checker", "corrective-plan", "corrective-writer", "auditor"]);
  const turnInvocations = harness.invocations().filter((entry) => entry.invocationType === "turn");
  assert.deepEqual(turnInvocations.map((entry) => entry.behaviorId), [
    "codex-fixture-plan",
    "codex-fixture-incomplete-writer",
    "claude-fixture-critique-checker",
    "codex-fixture-corrective-plan",
    "codex-fixture-corrective-writer",
    "claude-fixture-auditor",
  ]);
  assert.deepEqual(turnInvocations.map((entry) => entry.exitCode), [0, 0, 0, 0, 0, 0], "all six CLI turns complete");
  assert.deepEqual(turnInvocations.map((entry) => entry.cwd), [fixture.root, fixture.root, fixture.root, fixture.root, fixture.root, fixture.root]);
  for (const entry of [turnInvocations[0], turnInvocations[3], turnInvocations[5]]) {
    assert.equal(entry.identity === "codex" ? entry.argv[entry.argv.indexOf("--sandbox") + 1] : entry.argv[entry.argv.indexOf("--permission-mode") + 1], entry.identity === "codex" ? "read-only" : "plan");
  }
  for (const entry of [turnInvocations[1], turnInvocations[4]]) {
    assert.equal(entry.argv[entry.argv.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(entry.argv[entry.argv.indexOf("--cd") + 1], fixture.root);
  }
  assert.equal(turnInvocations[1].fixtureStatus, "completed");
  assert.equal(turnInvocations[1].fixtureVerdict, null);
  assert.equal(turnInvocations[2].fixtureStatus, "completed");
  assert.equal(turnInvocations[2].fixtureVerdict, "revise");
  assert.match(turnInvocations[2].stdout, /"is_error":false/u);
  assert.match(turnInvocations[2].stdout, /VERDICT: revise/u);
  assert.equal(turnInvocations.at(-1).fixtureVerified, true);
  assert.equal(JSON.stringify(harness.invocations()).includes(SECRET_PROMPT_MARKER), false);
  assert.equal(JSON.stringify(harness.invocations()).includes(harness.sentinel), false);
  assert.equal(JSON.stringify(operations).includes(SECRET_PROMPT_MARKER), false);
  assert.equal(JSON.stringify(operations).includes(harness.sentinel), false);
});

test("c1 critique checker never claims revise without observing the pinned failure", { skip: WINDOWS_INTEROP_OUT_OF_SCOPE }, async (t) => {
  {
    // The checks do fail here, but on the original broken source rather than
    // the pinned intermediate edit: a verdict must not be invented from that.
    const harness = setup(t, "c1-feedback-repair");
    const before = fs.readFileSync(harness.fixture.sourcePath);
    const result = await harness.turn({ role: "audit", identity: "claude" });
    assert.equal(result.ok, false, "no completed critique without the observed pinned failure");
    assert.doesNotMatch(result.text, /VERDICT: revise/u);
    assert.match(result.text, /VERDICT: stop$/u);
    const evidence = harness.operations().at(-1);
    assert.equal(evidence.operation, "critique-checker");
    assert.equal(evidence.status, "revise-or-stop");
    assert.equal(evidence.verdict, "stop");
    assert.equal(evidence.exitCode, 1);
    assert.equal(evidence.evidence.observedFailure, false);
    assert.equal(evidence.evidence.checkCommandFailed, true, "the checks failed, but not on the pinned intermediate edit");
    assert.equal(evidence.evidence.checker.intermediateSourceObserved, false);
    assert.equal(evidence.evidence.checker.testCommand.exitCode, 1, "the checks failed, but not on the pinned intermediate edit");
    assert.deepEqual(fs.readFileSync(harness.fixture.sourcePath), before);
  }
  {
    const harness = setup(t, "c1-feedback-repair");
    fs.writeFileSync(harness.fixture.sourcePath, EXECUTION_FIXTURE_REPAIRED_SOURCE, { encoding: "utf8", mode: 0o600 });
    const before = fs.readFileSync(harness.fixture.sourcePath);
    const result = await harness.turn({ role: "audit", identity: "claude" });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.text, /VERDICT: revise/u);
    const evidence = harness.operations().at(-1);
    assert.equal(evidence.verdict, "stop");
    assert.equal(evidence.evidence.observedFailure, false);
    assert.equal(evidence.evidence.checkCommandFailed, false);
    assert.equal(evidence.evidence.testCommandExitCode, 0, "passing checks without the intermediate edit are not a critique");
    assert.deepEqual(fs.readFileSync(harness.fixture.sourcePath), before);
  }
  {
    // A corrective plan cannot be produced from the stale original state.
    const harness = setup(t, "c1-feedback-repair");
    const before = fs.readFileSync(harness.fixture.sourcePath);
    harness.setBehavior({
      probes: { codex: "codex-probe-authenticated", claude: "claude-probe-authenticated" },
      turns: { codex: ["codex-fixture-corrective-plan"], claude: [] },
    });
    const result = await harness.turn({ role: "plan" });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.text, /VERDICT: carry-out/u);
    assert.match(result.text, /not the expected state for this operation/u);
    const evidence = harness.operations().at(-1);
    assert.equal(evidence.operation, "corrective-plan");
    assert.equal(evidence.status, "revise-or-stop");
    assert.deepEqual(fs.readFileSync(harness.fixture.sourcePath), before);
  }
});

test("continuation operations and presets stay mutually closed and mode-checked", { skip: WINDOWS_INTEROP_OUT_OF_SCOPE }, async (t) => {
  const cases = [
    { preset: "b1-full-chain", behavior: "codex-fixture-incomplete-writer", role: "execute", writes: true, identity: "codex", expected: /operation incomplete-writer is not allowed by preset b1-full-chain/u },
    { preset: "b1-full-chain", behavior: "codex-fixture-corrective-writer", role: "execute", writes: true, identity: "codex", expected: /operation corrective-writer is not allowed by preset b1-full-chain/u },
    { preset: "b3-partial-failure", behavior: "claude-fixture-critique-checker", role: "audit", writes: false, identity: "claude", expected: /operation critique-checker is not allowed by preset b3-partial-failure/u },
    { preset: "c1-feedback-repair", behavior: "codex-fixture-writer", role: "execute", writes: true, identity: "codex", expected: /operation writer is not allowed by preset c1-feedback-repair/u },
    { preset: "c1-feedback-repair", behavior: "codex-fixture-partial-writer", role: "execute", writes: true, identity: "codex", expected: /operation partial-writer is not allowed by preset c1-feedback-repair/u },
    { preset: "c1-feedback-repair", behavior: "codex-fixture-incomplete-writer", role: "audit", writes: false, identity: "codex", expected: /requires write mode but observed read/u },
    { preset: "c1-feedback-repair", behavior: "codex-fixture-corrective-plan", role: "execute", writes: true, identity: "codex", expected: /requires read mode but observed write/u },
  ];
  for (const item of cases) {
    const harness = setup(t, item.preset);
    const before = fs.readFileSync(harness.fixture.sourcePath);
    harness.setBehavior({
      probes: { codex: "codex-probe-authenticated", claude: "claude-probe-authenticated" },
      turns: { codex: item.identity === "codex" ? [item.behavior] : [], claude: item.identity === "claude" ? [item.behavior] : [] },
    });
    const result = await harness.turn({ role: item.role, identity: item.identity, writes: item.writes });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.text, item.expected, JSON.stringify(result));
    assert.deepEqual(fs.readFileSync(harness.fixture.sourcePath), before, "a refused continuation operation never mutates the fixture");
    const evidence = harness.operations().at(-1);
    assert.equal(evidence.status, "refused");
    assert.equal(evidence.exitCode, 42);
    assert.equal(evidence.evidence.changed, false);
  }
});

test("auditor failure reports revise-or-stop and never fabricates verified", { skip: WINDOWS_INTEROP_OUT_OF_SCOPE }, async (t) => {
  const harness = setup(t, "b1-full-chain");
  const plan = await harness.turn({ role: "plan" });
  assert.equal(plan.ok, true);
  const writer = await harness.turn({ role: "execute", writes: true });
  assert.equal(writer.ok, true);
  fs.writeFileSync(harness.fixture.sourcePath, EXECUTION_FIXTURE_PARTIAL_SOURCE, { encoding: "utf8", mode: 0o600 });
  const auditor = await harness.turn({ role: "audit", identity: "claude" });
  assert.equal(auditor.ok, false);
  assert.match(auditor.text, /revise or stop/u);
  assert.doesNotMatch(auditor.text, /VERIFIED/u);
  const evidence = harness.operations().at(-1);
  assert.equal(evidence.operation, "auditor");
  assert.equal(evidence.status, "revise-or-stop");
  assert.equal(evidence.verified, false);
  assert.equal(evidence.evidence.auditor.testCommand.exitCode, 1);
  assert.equal(evidence.evidence.auditor.sourceRead.matchesRepairedSource, false);
  assert.match(evidence.evidence.auditor.testCommand.stdout, /# fail 2/u);
  assert.equal(evidence.evidence.testSha256, harness.fixture.config.testSha256);
  assert.equal(harness.invocations().at(-1).fixtureVerified, false);
});

test("fixture root, marker, mode, role, and sentinel tripwires refuse before source mutation", { skip: WINDOWS_INTEROP_OUT_OF_SCOPE }, async (t) => {
  {
    const harness = setup(t, "b1-full-chain");
    const original = fs.readFileSync(harness.fixture.sourcePath);
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-m9-wrong-root-"));
    t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
    const result = await harness.turn({ role: "execute", writes: true, worktree: otherRoot });
    assert.equal(result.ok, false);
    assert.match(result.text, /fixture cwd does not match/u);
    assert.deepEqual(fs.readFileSync(harness.fixture.sourcePath), original);
    assert.equal(harness.operations().at(-1).status, "refused");
    assert.equal(harness.operations().at(-1).evidence.changed, false);
  }
  {
    const harness = setup(t, "b1-full-chain");
    const original = fs.readFileSync(harness.fixture.sourcePath);
    fs.rmSync(harness.fixture.markerPath);
    const result = await harness.turn({ role: "execute", writes: true });
    assert.equal(result.ok, false);
    assert.match(result.text, /marker is absent/u);
    assert.deepEqual(fs.readFileSync(harness.fixture.sourcePath), original);
  }
  {
    const harness = setup(t, "b1-full-chain");
    const original = fs.readFileSync(harness.fixture.sourcePath);
    // The closed writer behavior presented under the actual read-only audit
    // argv/mode refuses; no arbitrary role prompt is promoted into a write.
    harness.setBehavior({
      probes: { codex: "codex-probe-authenticated", claude: "claude-probe-authenticated" },
      turns: { codex: ["codex-fixture-writer"], claude: [] },
    });
    const result = await harness.turn({ role: "audit", writes: false });
    assert.equal(result.ok, false);
    assert.match(result.text, /requires write mode but observed read/u);
    assert.deepEqual(fs.readFileSync(harness.fixture.sourcePath), original);
    assert.equal(harness.operations().at(-1).status, "refused");
  }
  {
    const harness = setup(t, "b1-full-chain");
    const original = fs.readFileSync(harness.fixture.sourcePath);
    const result = await harness.turn({ role: "audit", writes: true });
    assert.equal(result.messageDispatched, false, "the actual coordinate role guard refuses audit+workspaceWrite before spawn");
    assert.deepEqual(fs.readFileSync(harness.fixture.sourcePath), original);
    assert.equal(harness.invocations().length, 0);
    assert.equal(harness.operations().length, 0);
  }
  {
    const harness = setup(t, "b1-full-chain");
    const original = fs.readFileSync(harness.fixture.sourcePath);
    const env = { ...harness.env };
    delete env.GOALPORT_STUB_SENTINEL;
    const result = await harness.turn({ role: "execute", writes: true, env });
    assert.equal(result.ok, false);
    assert.equal(result.messageDispatched, true);
    assert.deepEqual(fs.readFileSync(harness.fixture.sourcePath), original);
    assert.equal(harness.operations().length, 0, "sentinel denial occurs before fixture operation or evidence mutation");
    assert.equal(harness.invocations()[0].behaviorId, "sentinel-refused");
    assert.equal(harness.invocations()[0].exitCode, 42);
    assert.equal(JSON.stringify(harness.invocations()).includes(harness.sentinel), false);
  }
});
