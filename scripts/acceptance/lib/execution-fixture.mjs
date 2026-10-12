import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const EXECUTION_PRESETS = Object.freeze({
  "b1-full-chain": Object.freeze({ codex: Object.freeze(["codex-fixture-plan", "codex-fixture-writer"]), claude: Object.freeze(["claude-fixture-auditor"]) }),
  "b2-no-write": Object.freeze({ codex: Object.freeze(["codex-fixture-plan", "codex-fixture-no-write"]), claude: Object.freeze([]) }),
  "b3-partial-failure": Object.freeze({ codex: Object.freeze(["codex-fixture-plan", "codex-fixture-partial-writer"]), claude: Object.freeze([]) }),
  // Closed continuation preset: one initial planner turn, then the fixed
  // continuation story (incomplete writer -> read-only critique -> corrective
  // plan -> corrective writer) plus two separate read-only checker processes.
  "c1-feedback-repair": Object.freeze({
    codex: Object.freeze(["codex-fixture-plan", "codex-fixture-incomplete-writer", "codex-fixture-corrective-plan", "codex-fixture-corrective-writer"]),
    claude: Object.freeze(["claude-fixture-critique-checker", "claude-fixture-auditor"]),
  }),
  // Closed plan-revision preset: a genuinely flawed first plan, a separate
  // read-only plan critique, the revised plan that answers it, then the
  // existing one-shot writer and separate read-only auditor.
  "c4-plan-revision": Object.freeze({
    codex: Object.freeze(["codex-fixture-flawed-plan", "codex-fixture-revised-plan", "codex-fixture-writer"]),
    claude: Object.freeze(["claude-fixture-plan-critique-checker", "claude-carry-out", "claude-fixture-auditor"]),
  }),
});

/**
 * Closed operation matrix. Every fixture operation is bound to the presets
 * that may request it; no preset can reach an operation outside its own row,
 * and no argument can name a command, target file or patch.
 */
export const EXECUTION_OPERATION_PRESETS = Object.freeze({
  plan: Object.freeze(["b1-full-chain", "b2-no-write", "b3-partial-failure", "c1-feedback-repair"]),
  "no-write": Object.freeze(["b2-no-write"]),
  writer: Object.freeze(["b1-full-chain", "c4-plan-revision"]),
  "partial-writer": Object.freeze(["b3-partial-failure"]),
  "incomplete-writer": Object.freeze(["c1-feedback-repair"]),
  "corrective-plan": Object.freeze(["c1-feedback-repair"]),
  "corrective-writer": Object.freeze(["c1-feedback-repair"]),
  "critique-checker": Object.freeze(["c1-feedback-repair"]),
  auditor: Object.freeze(["b1-full-chain", "c1-feedback-repair", "c4-plan-revision"]),
  "flawed-plan": Object.freeze(["c4-plan-revision"]),
  "revised-plan": Object.freeze(["c4-plan-revision"]),
  "plan-critique-checker": Object.freeze(["c4-plan-revision"]),
});

const CONTINUATION_PRESET = "c1-feedback-repair";

export const EXECUTION_FIXTURE_FILES = Object.freeze({
  marker: ".goalport-offline-fixture.json",
  source: "src/add.mjs",
  test: "test/add.test.mjs",
});

const FIXTURE_PREFIX = "goalport-execution-fixture-";
const MARKER_SCHEMA_VERSION = 1;
const MAX_OUTPUT = 100_000;
const PROCESS_TIMEOUT_MS = 15_000;
const HELPER_PATH = fileURLToPath(import.meta.url);

export const EXECUTION_FIXTURE_SOURCE = "export function add(a, b) { return a - b; }\n";
export const EXECUTION_FIXTURE_REPAIRED_SOURCE = "export function add(a, b) { return a + b; }\n";
export const EXECUTION_FIXTURE_PARTIAL_SOURCE = "export function add(a, b) { return a + b + 1; }\n";
// The continuation preset's first writer leaves this genuinely incomplete
// edit behind: the positive case is fixed, the negative case still fails, so
// the unchanged checks really fail (1 passed, 1 failed) while the CLI turn
// itself completes honestly.
export const EXECUTION_FIXTURE_INCOMPLETE_SOURCE = "export function add(a, b) { if (a >= 0) return a + b; return a - b; }\n";
// The plan-revision preset's first plan is genuinely flawed in one specific
// way: it covers only positive inputs and names no workspace check, while the
// unchanged pinned tests contain a negative-value case. The separate critique
// checker names exactly that missing requirement.
export const EXECUTION_FIXTURE_FLAWED_PLAN = "Plan: read the pinned src/add.mjs and replace its subtraction with a plain addition for the positive inputs this workspace uses, then report the changed file. This is a closed synthetic fixture operation; no model judgment or arbitrary command is involved.";
export const EXECUTION_FIXTURE_REVISED_PLAN = "Revised plan: the independent check said the plan ignored the negative-value case and named no workspace check. Read the current src/add.mjs and the unchanged test/add.test.mjs; replace the subtraction with a plain addition that returns the sum for negative and positive values alike; run the unchanged pinned node --test checks so both pinned cases pass; then have a separate read-only auditor read the result and rerun those checks. This is a closed synthetic fixture operation; no model judgment or arbitrary command is involved.";
export const EXECUTION_FIXTURE_TEST = [
  'import assert from "node:assert/strict";',
  'import { test } from "node:test";',
  'import { add } from "../src/add.mjs";',
  "",
  'test("add returns the sum of positive values", () => {',
  "  assert.equal(add(2, 3), 5);",
  "});",
  "",
  'test("add returns the sum of negative values", () => {',
  "  assert.equal(add(-2, -3), -5);",
  "});",
  "",
].join("\n");

const REPAIRED_SOURCE_HASH = sha256(EXECUTION_FIXTURE_REPAIRED_SOURCE);
const PARTIAL_SOURCE_HASH = sha256(EXECUTION_FIXTURE_PARTIAL_SOURCE);
const INCOMPLETE_SOURCE_HASH = sha256(EXECUTION_FIXTURE_INCOMPLETE_SOURCE);
const KNOWN_PRESETS = new Set(Object.keys(EXECUTION_PRESETS));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fixturePaths(root) {
  return {
    markerPath: path.join(root, EXECUTION_FIXTURE_FILES.marker),
    sourcePath: path.join(root, EXECUTION_FIXTURE_FILES.source),
    testPath: path.join(root, EXECUTION_FIXTURE_FILES.test),
  };
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

/**
 * Validate the small driver-to-stub fixture binding. Only the known fixture
 * files, three closed presets, and an OS-temp fixture root are accepted.
 */
export function normalizeExecutionFixture(input) {
  if (input === undefined) return undefined;
  if (!isPlainRecord(input)) throw new TypeError("execution fixture config must be an object");
  assertExactKeys(input, ["schemaVersion", "preset", "root", "markerSha256", "sourcePath", "testPath", "sourceSha256", "testSha256"], "execution fixture config");
  if (input.schemaVersion !== 1 || !KNOWN_PRESETS.has(input.preset)) throw new TypeError("execution fixture config has an unsupported version or preset");
  if (typeof input.root !== "string" || !path.isAbsolute(input.root) || path.basename(input.root).startsWith(FIXTURE_PREFIX) === false) {
    throw new TypeError("execution fixture root must be an absolute disposable fixture directory");
  }
  const root = path.resolve(input.root);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, root);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw new TypeError("execution fixture root must be under the OS temporary directory");
  if (input.sourcePath !== EXECUTION_FIXTURE_FILES.source || input.testPath !== EXECUTION_FIXTURE_FILES.test) throw new TypeError("execution fixture paths are fixed");
  for (const field of ["markerSha256", "sourceSha256", "testSha256"]) {
    if (typeof input[field] !== "string" || !/^[a-f0-9]{64}$/.test(input[field])) throw new TypeError(`execution fixture ${field} must be a SHA-256 digest`);
  }
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    preset: input.preset,
    root,
    markerSha256: input.markerSha256,
    sourcePath: input.sourcePath,
    testPath: input.testPath,
    sourceSha256: input.sourceSha256,
    testSha256: input.testSha256,
  });
}

function markerContent(config) {
  return `${JSON.stringify({
    schemaVersion: MARKER_SCHEMA_VERSION,
    kind: "goalport-offline-execution-fixture",
    preset: config.preset,
    root: config.root,
    sourcePath: EXECUTION_FIXTURE_FILES.source,
    testPath: EXECUTION_FIXTURE_FILES.test,
    sourceSha256: config.sourceSha256,
    testSha256: config.testSha256,
  }, null, 2)}\n`;
}

/**
 * Seed a fresh, bounded Node-only fixture under the OS temp directory. The
 * returned config is passed to materializeStubBin; all source/test content is
 * fixed here and no caller-provided patch or command is accepted.
 */
export function createExecutionFixture(preset) {
  if (!KNOWN_PRESETS.has(preset)) throw new TypeError(`unknown execution fixture preset: ${preset}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX));
  const paths = fixturePaths(root);
  fs.mkdirSync(path.dirname(paths.sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(paths.testPath), { recursive: true });
  fs.writeFileSync(paths.sourcePath, EXECUTION_FIXTURE_SOURCE, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(paths.testPath, EXECUTION_FIXTURE_TEST, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const configWithoutMarker = {
    schemaVersion: 1,
    preset,
    root: path.resolve(root),
    markerSha256: "0".repeat(64),
    sourcePath: EXECUTION_FIXTURE_FILES.source,
    testPath: EXECUTION_FIXTURE_FILES.test,
    sourceSha256: sha256(EXECUTION_FIXTURE_SOURCE),
    testSha256: sha256(EXECUTION_FIXTURE_TEST),
  };
  const marker = markerContent(configWithoutMarker);
  const config = { ...configWithoutMarker, markerSha256: sha256(marker) };
  fs.writeFileSync(paths.markerPath, marker, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const frozenConfig = normalizeExecutionFixture(config);
  return Object.freeze({
    ...paths,
    root: frozenConfig.root,
    preset,
    config: frozenConfig,
    behavior: Object.freeze({
      probes: Object.freeze({ codex: "codex-probe-authenticated", claude: "claude-probe-authenticated" }),
      turns: Object.freeze({ codex: EXECUTION_PRESETS[preset].codex, claude: EXECUTION_PRESETS[preset].claude }),
    }),
    dispose() { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); },
  });
}

function checkedRegularFile(filename, label) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular fixture file`);
  return fs.readFileSync(filename);
}

function validateMarker(config, cwd) {
  const normalized = normalizeExecutionFixture(config);
  const canonicalRoot = fs.realpathSync(normalized.root);
  const canonicalCwd = fs.realpathSync(cwd);
  if (canonicalRoot !== canonicalCwd) throw new Error("fixture cwd does not match the driver-bound fixture root");
  if (path.basename(canonicalRoot).startsWith(FIXTURE_PREFIX) === false) throw new Error("fixture root marker is outside the disposable fixture namespace");
  const markerPath = path.join(canonicalRoot, EXECUTION_FIXTURE_FILES.marker);
  if (!fs.existsSync(markerPath)) throw new Error("fixture marker is absent");
  const markerBytes = checkedRegularFile(markerPath, "fixture marker");
  if (sha256(markerBytes) !== normalized.markerSha256) throw new Error("fixture marker is absent or does not match the driver binding");
  let marker;
  try { marker = JSON.parse(markerBytes.toString("utf8")); } catch { throw new Error("fixture marker is invalid"); }
  const expectedMarker = JSON.parse(markerContent(normalized));
  if (JSON.stringify(marker) !== JSON.stringify(expectedMarker)) throw new Error("fixture marker does not match the pinned fixture files and root");
  return normalized;
}

function readPinnedFixture(config, { expectedSourceSha256 = config.sourceSha256 } = {}) {
  const sourceBytes = checkedRegularFile(path.join(config.root, config.sourcePath), "fixture source");
  const testBytes = checkedRegularFile(path.join(config.root, config.testPath), "fixture test");
  const sourceSha256 = sha256(sourceBytes);
  const testSha256 = sha256(testBytes);
  if (testSha256 !== config.testSha256) throw new Error("original fixture test bytes changed; refusing to run an unpinned check");
  if (expectedSourceSha256 !== null && sourceSha256 !== expectedSourceSha256) throw new Error("fixture source hash is not the expected state for this operation");
  return { sourceBytes, testBytes, sourceSha256, testSha256 };
}

function cliMode(identity, argv, cwd, config) {
  if (identity === "codex") {
    const sandboxIndex = argv.indexOf("--sandbox");
    const sandboxMode = sandboxIndex >= 0 ? argv[sandboxIndex + 1] : "";
    const cdIndex = argv.indexOf("--cd");
    const cliRoot = cdIndex >= 0 ? argv[cdIndex + 1] : "";
    if (!cliRoot || path.resolve(cliRoot) !== config.root || path.resolve(cwd) !== config.root) return "root-mismatch";
    return sandboxMode === "workspace-write" ? "write" : sandboxMode === "read-only" ? "read" : "wrong-mode";
  }
  if (identity === "claude") {
    if (path.resolve(cwd) !== config.root) return "root-mismatch";
    const modeIndex = argv.indexOf("--permission-mode");
    const permissionMode = modeIndex >= 0 ? argv[modeIndex + 1] : "";
    return permissionMode === "acceptEdits" ? "write" : permissionMode === "plan" ? "read" : "wrong-mode";
  }
  return "wrong-role";
}

function commandRecord(args, cwd, result) {
  return {
    executable: process.execPath,
    args,
    cwd,
    shell: false,
    pid: result.pid ?? null,
    exitCode: result.status,
    signal: result.signal ?? null,
    stdout: String(result.stdout ?? "").slice(-MAX_OUTPUT),
    stderr: String(result.stderr ?? "").slice(-MAX_OUTPUT),
    timedOut: result.error?.code === "ETIMEDOUT" || /timed out/i.test(result.error?.message ?? ""),
    error: result.error ? `${result.error.name}: ${result.error.message}` : null,
  };
}

function runNode(args, cwd) {
  // Keep os.tmpdir() anchored at the parent of this fixture, so a subprocess
  // can revalidate that the bound fixture itself is inside the temp namespace.
  const tempParent = path.dirname(cwd);
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      USERPROFILE: cwd,
      TMPDIR: tempParent,
      TEMP: tempParent,
      TMP: tempParent,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    shell: false,
    windowsHide: true,
  });
  return commandRecord(args, cwd, result);
}

function isAssertionFailure(command) {
  const output = `${command.stdout}\n${command.stderr}`;
  return command.exitCode !== 0 && /ERR_ASSERTION|AssertionError|not ok \d+/u.test(output);
}

function summaryCount(output, label) {
  const match = String(output ?? "").match(new RegExp(`(?:^|\\n)(?:#|ℹ|info)\\s+${label}\\s+(\\d+)\\b`, "u"));
  return match ? Number(match[1]) : null;
}

// Node 22 prints TAP (`# pass 2`). Node 24's default spec reporter prints
// `ℹ pass 2`. The pinned fixture still requires those exact counts.
export function nodeTestSummary(output, { pass, fail }) {
  return summaryCount(output, "pass") === pass && summaryCount(output, "fail") === fail;
}

function passingTestOutput(command) {
  return command.exitCode === 0 && nodeTestSummary(command.stdout, { pass: 2, fail: 0 });
}

function fixedPlan(config, sourceBytes) {
  const source = sourceBytes.toString("utf8");
  if (source !== EXECUTION_FIXTURE_SOURCE) throw new Error("plan response requires the original broken add fixture");
  return "Plan: read the pinned src/add.mjs and unchanged test/add.test.mjs, replace the fixture's subtraction with addition, run the original node --test checks, then have a separate read-only auditor read the result and rerun those checks. This is a closed synthetic fixture operation; no model judgment or arbitrary command is involved. VERDICT: carry-out";
}

const WRITE_OPERATIONS = Object.freeze(["writer", "partial-writer", "incomplete-writer", "corrective-writer"]);

function isWriteOperation(operation) {
  return WRITE_OPERATIONS.includes(operation);
}

function expectedOperationRole(operation) {
  return isWriteOperation(operation) ? "write" : "read";
}

// Refusal wording keeps the pre-existing plan/executor/auditor roles; the
// continuation checker and writer add their own closed labels.
function operationRole(operation) {
  if (isWriteOperation(operation)) return "executor";
  if (operation === "auditor") return "read-only-auditor";
  if (operation === "critique-checker") return "read-only-checker";
  if (operation === "plan-critique-checker") return "read-only-plan-checker";
  return "plan";
}

function caughtErrorRole(operation) {
  if (isWriteOperation(operation)) return "executor";
  if (operation === "auditor") return "read-only-auditor";
  if (operation === "critique-checker") return "read-only-checker";
  if (operation === "plan-critique-checker") return "read-only-plan-checker";
  return "read-only-plan";
}

function operationAllowed(operation, preset) {
  return EXECUTION_OPERATION_PRESETS[operation]?.includes(preset) === true;
}

function refused(operation, reason, config, cwd) {
  return {
    operation,
    role: operationRole(operation),
    preset: config?.preset ?? null,
    status: "refused",
    verified: false,
    exitCode: 42,
    report: `Fixture operation refused before workspace mutation: ${reason}. No fixture files were changed.`,
    evidence: { cwd, reason, changed: false },
  };
}

function evidenceBase(operation, config, cwd) {
  return {
    schemaVersion: 1,
    sourceLabel: "synthetic-offline-fixture",
    operation,
    preset: config.preset,
    cwd,
    fixtureRoot: config.root,
    sourcePath: config.sourcePath,
    testPath: config.testPath,
    verified: false,
    changed: false,
    noModelJudgment: true,
  };
}

function runWriter({ operation, config, cwd, parentPid }) {
  const before = readPinnedFixture(config);
  const baselineCommand = runNode(["--test", config.testPath], config.root);
  if (!isAssertionFailure(baselineCommand)) {
    return refused(operation, "the baseline node --test run did not observe the expected assertion failure", config, cwd);
  }
  const sourcePath = path.join(config.root, config.sourcePath);
  const sourceAfterBaseline = checkedRegularFile(sourcePath, "fixture source");
  const testAfterBaseline = checkedRegularFile(path.join(config.root, config.testPath), "fixture test");
  if (sha256(sourceAfterBaseline) !== config.sourceSha256 || sha256(testAfterBaseline) !== config.testSha256) {
    return refused(operation, "fixture bytes changed before the bounded writer edit", config, cwd);
  }
  const nextSource = operation === "writer" ? EXECUTION_FIXTURE_REPAIRED_SOURCE : EXECUTION_FIXTURE_PARTIAL_SOURCE;
  fs.writeFileSync(sourcePath, nextSource, { encoding: "utf8", mode: 0o600 });
  const changedSource = checkedRegularFile(sourcePath, "fixture source after edit");
  const unchangedTest = checkedRegularFile(path.join(config.root, config.testPath), "fixture test after edit");
  const changedHash = sha256(changedSource);
  const unchangedTestHash = sha256(unchangedTest);
  const checksCommand = runNode(["--test", config.testPath], config.root);
  const baseline = {
    command: baselineCommand,
    sourceSha256: before.sourceSha256,
    testSha256: before.testSha256,
    assertionFailureObserved: true,
  };
  const after = {
    command: checksCommand,
    sourceSha256: changedHash,
    sourceText: changedSource.toString("utf8"),
    testSha256: unchangedTestHash,
    testUnchanged: unchangedTestHash === config.testSha256,
    testsPassed: passingTestOutput(checksCommand),
  };
  const partial = operation === "partial-writer";
  const succeeds = !partial && changedHash === REPAIRED_SOURCE_HASH && after.testUnchanged && after.testsPassed;
  const failedTruthfully = partial && changedHash === PARTIAL_SOURCE_HASH && after.testUnchanged && !after.testsPassed && checksCommand.exitCode !== 0;
  const status = succeeds ? "completed" : failedTruthfully ? "partial-failure" : "revise-or-stop";
  const exitCode = succeeds ? 0 : 1;
  const report = succeeds
    ? "Executor repaired src/add.mjs after the original node --test checks failed; the unchanged pinned checks then passed (2/2). This is an offline fixture result, not a model judgment."
    : failedTruthfully
      ? "Partial edit retained in src/add.mjs; the unchanged original node --test checks still fail (0/2 passed). Executor stopped with exit 1; no verification success is claimed."
      : "Executor could not establish the expected fixture result; revise or stop. The observed node --test output and file hashes are retained; no verified result is claimed.";
  return {
    operation,
    role: "executor",
    preset: config.preset,
    status,
    verified: false,
    exitCode,
    report,
    evidence: {
      ...evidenceBase(operation, config, cwd),
      parentPid,
      baseline,
      edit: {
        path: config.sourcePath,
        beforeSha256: before.sourceSha256,
        afterSha256: changedHash,
        sourceText: changedSource.toString("utf8"),
        actualFileChanged: changedHash !== before.sourceSha256,
      },
      checks: after,
      testBytesUnchanged: unchangedTestHash === config.testSha256,
      sourceHashes: { before: before.sourceSha256, after: changedHash },
      testSha256: unchangedTestHash,
    },
  };
}

const CONTINUATION_WRITER_STEPS = Object.freeze({
  "incomplete-writer": Object.freeze({ nextSource: EXECUTION_FIXTURE_INCOMPLETE_SOURCE, checksMustFail: true }),
  "corrective-writer": Object.freeze({ nextSource: EXECUTION_FIXTURE_REPAIRED_SOURCE, checksMustFail: false }),
});

function checkCounts(command) {
  const passed = /# pass (\d+)/u.exec(command?.stdout ?? "");
  const failed = /# fail (\d+)/u.exec(command?.stdout ?? "");
  return { passed: passed ? Number(passed[1]) : null, failed: failed ? Number(failed[1]) : null };
}

/**
 * The continuation preset's two writers. Both CLI turns complete (exit 0)
 * while the spawned node --test command keeps its own exit status: the pinned
 * check failure is reported as feedback by a completed turn. The b3 partial
 * writer is untouched and still ends in a failed CLI turn.
 */
function runFeedbackWriter({ operation, config, cwd, parentPid }) {
  const step = CONTINUATION_WRITER_STEPS[operation];
  const expectedBefore = operation === "corrective-writer" ? INCOMPLETE_SOURCE_HASH : config.sourceSha256;
  const before = readPinnedFixture(config, { expectedSourceSha256: expectedBefore });
  const baselineCommand = runNode(["--test", config.testPath], config.root);
  if (!isAssertionFailure(baselineCommand)) {
    return refused(operation, "the baseline node --test run did not observe the expected assertion failure", config, cwd);
  }
  const sourcePath = path.join(config.root, config.sourcePath);
  const sourceAfterBaseline = checkedRegularFile(sourcePath, "fixture source");
  const testAfterBaseline = checkedRegularFile(path.join(config.root, config.testPath), "fixture test");
  if (sha256(sourceAfterBaseline) !== before.sourceSha256 || sha256(testAfterBaseline) !== config.testSha256) {
    return refused(operation, "fixture bytes changed before the bounded writer edit", config, cwd);
  }
  fs.writeFileSync(sourcePath, step.nextSource, { encoding: "utf8", mode: 0o600 });
  const changedSource = checkedRegularFile(sourcePath, "fixture source after edit");
  const unchangedTest = checkedRegularFile(path.join(config.root, config.testPath), "fixture test after edit");
  const changedHash = sha256(changedSource);
  const unchangedTestHash = sha256(unchangedTest);
  const checksCommand = runNode(["--test", config.testPath], config.root);
  const baseline = {
    command: baselineCommand,
    sourceSha256: before.sourceSha256,
    testSha256: before.testSha256,
    assertionFailureObserved: true,
  };
  const checks = {
    command: checksCommand,
    sourceSha256: changedHash,
    sourceText: changedSource.toString("utf8"),
    testSha256: unchangedTestHash,
    testUnchanged: unchangedTestHash === config.testSha256,
    testsPassed: passingTestOutput(checksCommand),
    testsFailed: isAssertionFailure(checksCommand),
  };
  const counts = checkCounts(checksCommand);
  const completed = changedHash === sha256(step.nextSource)
    && checks.testUnchanged
    && (step.checksMustFail ? checks.testsFailed : checks.testsPassed);
  const report = completed
    ? operation === "incomplete-writer"
      ? `First executor CLI turn completed after an incomplete edit to ${config.sourcePath}. The unchanged pinned node --test checks still fail (${counts.passed} passed, ${counts.failed} failed); the observed command output and both byte hashes are retained as feedback for independent review. This reports failed checks honestly and claims no verification.`
      : `Corrective executor CLI turn completed; the repaired ${config.sourcePath} passes the unchanged pinned node --test checks (${counts.passed}/${(counts.passed ?? 0) + (counts.failed ?? 0)}) with the original check bytes unchanged. This is an offline fixture result, not a model judgment or independent verification.`
    : "Executor could not establish the expected continuation fixture result; revise or stop. The observed node --test output and file hashes are retained; no verified result is claimed.";
  return {
    operation,
    role: "executor",
    preset: config.preset,
    status: completed ? "completed" : "revise-or-stop",
    verified: false,
    exitCode: completed ? 0 : 1,
    report,
    evidence: {
      ...evidenceBase(operation, config, cwd),
      parentPid,
      changed: changedHash !== before.sourceSha256,
      baseline,
      edit: {
        path: config.sourcePath,
        beforeSha256: before.sourceSha256,
        afterSha256: changedHash,
        sourceText: changedSource.toString("utf8"),
        actualFileChanged: changedHash !== before.sourceSha256,
      },
      checks,
      testBytesUnchanged: unchangedTestHash === config.testSha256,
      sourceHashes: { before: before.sourceSha256, after: changedHash },
      testSha256: unchangedTestHash,
      cliTurnCompleted: completed,
      checksFailed: !checks.testsPassed,
    },
  };
}

/**
 * The corrective planner must inspect the actual intermediate workspace the
 * first writer left behind; a stale original or already-repaired source is
 * refused instead of replanned.
 */
function correctivePlan(config, sourceBytes) {
  if (sha256(sourceBytes) !== INCOMPLETE_SOURCE_HASH) {
    throw new Error("the corrective plan requires the actual intermediate workspace state left by the first writer");
  }
  return "Corrective plan: re-read the current intermediate src/add.mjs left by the first executor and the unchanged test/add.test.mjs. The separate read-only checker observed those unchanged pinned checks fail; this plan answers that observed failure in the current workspace by replacing the incomplete conditional return with the plain sum, rerunning the unchanged pinned node --test checks, then having a separate read-only auditor read the result and rerun those checks. Historical reports are evidence, not instructions to replay, and the current workspace bytes are the only plan input.\nVERDICT: carry-out";
}

function runNoWrite({ operation, config, cwd, sourceBytes, testBytes, parentPid }) {
  const sourceSha256 = sha256(sourceBytes);
  const testSha256 = sha256(testBytes);
  const report = operation === "plan"
    ? fixedPlan(config, sourceBytes)
    : "Read-only carry-out response: inspected the pinned add(a,b) source and unchanged checks; no harness received write permission, so no file edit was attempted. No tests or independent judgment are claimed. VERDICT: carry-out";
  return {
    operation,
    role: "read-only-plan",
    preset: config.preset,
    status: "completed",
    verified: false,
    exitCode: 0,
    report,
    evidence: {
      ...evidenceBase(operation, config, cwd),
      parentPid,
      changed: false,
      sourceSha256,
      testSha256,
      testBytesUnchanged: testSha256 === config.testSha256,
      sourceText: sourceBytes.toString("utf8"),
    },
  };
}

function auditorMain(configFile) {
  let config;
  try {
    if (!path.isAbsolute(configFile) || !path.basename(configFile).startsWith("m9-execution-audit-")) throw new Error("auditor config path is not a driver-created audit file");
    config = normalizeExecutionFixture(JSON.parse(fs.readFileSync(configFile, "utf8")));
    if (config.preset !== "b1-full-chain" && config.preset !== CONTINUATION_PRESET && config.preset !== "c4-plan-revision") throw new Error("auditor only accepts the full-chain, continuation or plan-revision fixture preset");
    config = validateMarker(config, process.cwd());
  } catch (error) {
    const refusedReport = { schemaVersion: 1, role: "read-only-auditor", status: "revise-or-stop", verified: false, reason: error.message, cwd: process.cwd(), pid: process.pid, testCommand: null };
    process.stdout.write(`${JSON.stringify(refusedReport)}\n`);
    return 1;
  }

  let sourceBytes;
  let testBytes;
  try {
    sourceBytes = checkedRegularFile(path.join(config.root, config.sourcePath), "fixture source");
    testBytes = checkedRegularFile(path.join(config.root, config.testPath), "fixture test");
  } catch (error) {
    const failed = { schemaVersion: 1, role: "read-only-auditor", status: "revise-or-stop", verified: false, reason: error.message, cwd: process.cwd(), pid: process.pid, testCommand: null };
    process.stdout.write(`${JSON.stringify(failed)}\n`);
    return 1;
  }
  const sourceSha256 = sha256(sourceBytes);
  const testSha256 = sha256(testBytes);
  const expectedSource = sourceSha256 === REPAIRED_SOURCE_HASH;
  const pinnedTests = testSha256 === config.testSha256;
  const testCommand = pinnedTests ? runNode(["--test", config.testPath], config.root) : null;
  const testsPassed = testCommand ? passingTestOutput(testCommand) : false;
  const verified = expectedSource && pinnedTests && testsPassed;
  const report = {
    schemaVersion: 1,
    role: "read-only-auditor",
    auditorKind: "separate-read-only-node-process",
    noIndependentModelClaim: true,
    status: verified ? "verified" : "revise-or-stop",
    verified,
    cwd: process.cwd(),
    pid: process.pid,
    sourceRead: { path: config.sourcePath, sha256: sourceSha256, text: sourceBytes.toString("utf8"), matchesRepairedSource: expectedSource },
    originalTests: { path: config.testPath, sha256: testSha256, matchesPinnedBytes: pinnedTests },
    testCommand,
    testsPassed,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return verified ? 0 : 1;
}

function critiqueMain(configFile) {
  const emit = (report, code) => { process.stdout.write(`${JSON.stringify(report)}\n`); return code; };
  const refusedReport = (reason) => ({
    schemaVersion: 1,
    role: "read-only-checker",
    checkerKind: "separate-read-only-node-process",
    noIndependentModelClaim: true,
    status: "revise-or-stop",
    verdict: "stop",
    observedFailure: false,
    verified: false,
    reason,
    cwd: process.cwd(),
    pid: process.pid,
    testCommand: null,
  });
  let config;
  try {
    if (!path.isAbsolute(configFile) || !path.basename(configFile).startsWith("m9-execution-critique-")) throw new Error("critique config path is not a driver-created critique file");
    config = normalizeExecutionFixture(JSON.parse(fs.readFileSync(configFile, "utf8")));
    if (config.preset !== CONTINUATION_PRESET) throw new Error("the critique checker only accepts the continuation feedback preset");
    config = validateMarker(config, process.cwd());
  } catch (error) {
    return emit(refusedReport(error.message), 1);
  }

  let sourceBytes;
  let testBytes;
  try {
    sourceBytes = checkedRegularFile(path.join(config.root, config.sourcePath), "fixture source");
    testBytes = checkedRegularFile(path.join(config.root, config.testPath), "fixture test");
  } catch (error) {
    return emit(refusedReport(error.message), 1);
  }
  const sourceSha256 = sha256(sourceBytes);
  const testSha256 = sha256(testBytes);
  const pinnedTests = testSha256 === config.testSha256;
  const intermediateSourceObserved = sourceSha256 === INCOMPLETE_SOURCE_HASH;
  const testCommand = pinnedTests ? runNode(["--test", config.testPath], config.root) : null;
  // A verdict is only emitted after this process actually observed the
  // pinned failing checks on the pinned intermediate edit. The check command's
  // own nonzero exit is the feedback; this checker process still completes.
  const checkCommandFailed = Boolean(testCommand) && testCommand.exitCode !== 0 && isAssertionFailure(testCommand);
  const expected = intermediateSourceObserved && pinnedTests && checkCommandFailed;
  const report = {
    schemaVersion: 1,
    role: "read-only-checker",
    checkerKind: "separate-read-only-node-process",
    noIndependentModelClaim: true,
    status: expected ? "completed" : "revise-or-stop",
    verdict: expected ? "revise" : "stop",
    observedFailure: expected,
    checkCommandFailed,
    intermediateSourceObserved,
    cwd: process.cwd(),
    pid: process.pid,
    sourceRead: { path: config.sourcePath, sha256: sourceSha256, text: sourceBytes.toString("utf8"), matchesIncompleteEdit: intermediateSourceObserved },
    originalTests: { path: config.testPath, sha256: testSha256, matchesPinnedBytes: pinnedTests },
    testCommand,
    reason: expected ? null : "the checker did not observe the expected failing unchanged checks on the pinned intermediate edit",
  };
  return emit(report, expected ? 0 : 1);
}

function runAuditor({ config, cwd, stubDir, parentPid }) {
  const configPath = path.join(stubDir, `m9-execution-audit-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  let command;
  try {
    command = runNode([HELPER_PATH, "--offline-audit", configPath], cwd);
  } finally {
    fs.rmSync(configPath, { force: true });
  }
  let auditor;
  try { auditor = JSON.parse(command.stdout); } catch { auditor = null; }
  const verified = command.exitCode === 0 && auditor?.verified === true && auditor?.role === "read-only-auditor";
  const report = verified
    ? "VERIFIED by a separate read-only Node auditor process: it read the changed source and the unchanged pinned node --test checks passed (2/2). No independent model judgment is claimed.\nVERDICT: verified"
    : `Auditor could not verify the observed fixture checks; revise or stop. ${auditor?.reason ?? "The actual auditor process did not report passing pinned tests."} No success is claimed.\nVERDICT: revise`;
  return {
    operation: "auditor",
    role: "read-only-auditor",
    preset: config.preset,
    status: verified ? "verified" : "revise-or-stop",
    verified,
    exitCode: verified ? 0 : 1,
    report,
    evidence: {
      ...evidenceBase("auditor", config, cwd),
      parentPid,
      auditorProcess: command,
      auditor,
      sourceReadSha256: auditor?.sourceRead?.sha256 ?? null,
      sourceReadText: auditor?.sourceRead?.text ?? null,
      testSha256: auditor?.originalTests?.sha256 ?? null,
      testsPassed: auditor?.testsPassed === true,
      verified,
    },
  };
}

function planCritiqueMain(configFile) {
  const emit = (report, code) => { process.stdout.write(`${JSON.stringify(report)}\n`); return code; };
  const refusedReport = (reason) => ({
    schemaVersion: 1,
    role: "read-only-plan-checker",
    checkerKind: "separate-read-only-node-process",
    noIndependentModelClaim: true,
    status: "revise-or-stop",
    verdict: "stop",
    observedRequirement: false,
    verified: false,
    reason,
    cwd: process.cwd(),
    pid: process.pid,
    testCommand: null,
  });
  let config;
  try {
    if (!path.isAbsolute(configFile) || !path.basename(configFile).startsWith("m9-plan-critique-")) throw new Error("plan critique config path is not a driver-created plan-critique file");
    config = normalizeExecutionFixture(JSON.parse(fs.readFileSync(configFile, "utf8")));
    if (config.preset !== "c4-plan-revision") throw new Error("the plan critique checker only accepts the plan-revision preset");
    config = validateMarker(config, process.cwd());
  } catch (error) {
    return emit(refusedReport(error.message), 1);
  }
  let testBytes;
  try {
    testBytes = checkedRegularFile(path.join(config.root, config.testPath), "fixture test");
  } catch (error) {
    return emit(refusedReport(error.message), 1);
  }
  const testSha256 = sha256(testBytes);
  const pinnedTests = testSha256 === config.testSha256;
  // The named missing requirement is observable in the fixture itself: the
  // unchanged pinned tests contain a negative-value case.
  const negativeCasePresent = /add\(\s*-\s*2\s*,\s*-\s*3\s*\)/u.test(testBytes.toString("utf8"));
  const expected = pinnedTests && negativeCasePresent;
  const report = {
    schemaVersion: 1,
    role: "read-only-plan-checker",
    checkerKind: "separate-read-only-node-process",
    noIndependentModelClaim: true,
    status: expected ? "completed" : "revise-or-stop",
    verdict: expected ? "revise" : "stop",
    observedRequirement: expected,
    negativeCasePresent,
    cwd: process.cwd(),
    pid: process.pid,
    originalTests: { path: config.testPath, sha256: testSha256, matchesPinnedBytes: pinnedTests },
    testCommand: null,
    reason: expected ? null : "the checker did not observe the negative-value case in the unchanged pinned tests",
  };
  return emit(report, expected ? 0 : 1);
}

function runPlanCritiqueCheck({ config, cwd, stubDir, parentPid }) {
  const configPath = path.join(stubDir, `m9-plan-critique-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  let command;
  try {
    command = runNode([HELPER_PATH, "--offline-plan-critique", configPath], cwd);
  } finally {
    fs.rmSync(configPath, { force: true });
  }
  let checker;
  try { checker = JSON.parse(command.stdout); } catch { checker = null; }
  const observed = command.exitCode === 0 && checker?.role === "read-only-plan-checker" && checker?.verdict === "revise" && checker?.observedRequirement === true;
  const report = observed
    ? `Completed plan critique from a separate read-only Node checker process (pid ${checker.pid}): the unchanged pinned tests contain a negative-value case, and the proposed plan covers only positive inputs and names no workspace check. The plan must say how the change covers the negative case and which unchanged checks it will run before any file changes. This critique turn completed and claims no verification and no independent model judgment.\nVERDICT: revise`
    : `Plan critique checker could not observe the named missing requirement, so no critique is claimed. ${checker?.reason ?? "The actual checker process did not report the pinned negative-value case."}\nVERDICT: stop`;
  return {
    operation: "plan-critique-checker",
    role: "read-only-plan-checker",
    preset: config.preset,
    status: observed ? "completed" : "revise-or-stop",
    verdict: observed ? "revise" : "stop",
    verified: false,
    exitCode: observed ? 0 : 1,
    report,
    evidence: {
      ...evidenceBase("plan-critique-checker", config, cwd),
      parentPid,
      checkerProcess: command,
      checker,
      checkerKind: checker?.checkerKind ?? null,
      negativeCasePresent: checker?.negativeCasePresent === true,
      observedRequirement: checker?.observedRequirement === true,
      testSha256: checker?.originalTests?.sha256 ?? null,
      cliTurnCompleted: observed,
      verdict: observed ? "revise" : "stop",
    },
  };
}

function runCritiqueCheck({ config, cwd, stubDir, parentPid }) {
  const configPath = path.join(stubDir, `m9-execution-critique-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  let command;
  try {
    command = runNode([HELPER_PATH, "--offline-critique", configPath], cwd);
  } finally {
    fs.rmSync(configPath, { force: true });
  }
  let checker;
  try { checker = JSON.parse(command.stdout); } catch { checker = null; }
  const observed = command.exitCode === 0 && checker?.role === "read-only-checker" && checker?.verdict === "revise" && checker?.observedFailure === true;
  const counts = checkCounts(checker?.testCommand);
  const report = observed
    ? `Completed critique from a separate read-only Node checker process (pid ${checker.pid}): it read the intermediate ${config.sourcePath} and ran the unchanged pinned node --test checks, which really failed (${counts.passed} passed, ${counts.failed} failed). The checker's own check command exited ${checker.testCommand.exitCode}; this critique turn itself completed and claims no verification and no independent model judgment.\nVERDICT: revise`
    : `Critique checker could not observe the expected failing unchanged checks, so no critique is claimed. ${checker?.reason ?? "The actual checker process did not report the expected failing pinned checks."}\nVERDICT: stop`;
  return {
    operation: "critique-checker",
    role: "read-only-checker",
    preset: config.preset,
    status: observed ? "completed" : "revise-or-stop",
    verdict: observed ? "revise" : "stop",
    verified: false,
    exitCode: observed ? 0 : 1,
    report,
    evidence: {
      ...evidenceBase("critique-checker", config, cwd),
      parentPid,
      checkerProcess: command,
      checker,
      checkerKind: checker?.checkerKind ?? null,
      sourceReadSha256: checker?.sourceRead?.sha256 ?? null,
      sourceReadText: checker?.sourceRead?.text ?? null,
      testSha256: checker?.originalTests?.sha256 ?? null,
      observedFailure: checker?.observedFailure === true,
      checkCommandFailed: checker?.checkCommandFailed === true,
      testCommandExitCode: checker?.testCommand?.exitCode ?? null,
      cliTurnCompleted: observed,
      verdict: observed ? "revise" : "stop",
    },
  };
}

/**
 * Execute one fixed fixture behavior selected by a closed STUB_BEHAVIORS ID.
 * `argv` is the actual intercepted CLI argv. No argument can name a command,
 * target file, or patch. Sentinel gating and queue accounting happen first in
 * stub-harness.mjs; this function rechecks the fixture root and exact mode.
 */
export function runExecutionFixtureOperation({ operation, config: rawConfig, identity, argv, cwd, stubDir, parentPid = process.pid }) {
  let config;
  try { config = validateMarker(rawConfig, cwd); } catch (error) { return refused(operation, error.message, rawConfig, cwd); }
  if (!operationAllowed(operation, config.preset)) return refused(operation, `operation ${operation} is not allowed by preset ${config.preset}`, config, cwd);
  const mode = cliMode(identity, argv, cwd, config);
  if (mode !== expectedOperationRole(operation)) return refused(operation, `operation ${operation} requires ${expectedOperationRole(operation)} mode but observed ${mode}`, config, cwd);

  try {
    const expectedSourceSha256 = operation === "auditor" || operation === "critique-checker" || operation === "plan-critique-checker"
      ? null
      : operation === "corrective-plan" || operation === "corrective-writer"
        ? INCOMPLETE_SOURCE_HASH
        : config.sourceSha256;
    const before = readPinnedFixture(config, { expectedSourceSha256 });
    if (operation === "plan" || operation === "corrective-plan" || operation === "flawed-plan" || operation === "revised-plan") {
      const planReport = operation === "plan"
        ? fixedPlan(config, before.sourceBytes)
        : operation === "corrective-plan"
          ? correctivePlan(config, before.sourceBytes)
          : operation === "flawed-plan"
            ? EXECUTION_FIXTURE_FLAWED_PLAN
            : EXECUTION_FIXTURE_REVISED_PLAN;
      return {
        operation,
        role: "read-only-plan",
        preset: config.preset,
        status: "completed",
        verified: false,
        exitCode: 0,
        report: planReport,
        evidence: {
          ...evidenceBase(operation, config, cwd),
          parentPid,
          sourceSha256: before.sourceSha256,
          testSha256: before.testSha256,
          sourceText: before.sourceBytes.toString("utf8"),
          changed: false,
          ...(operation === "flawed-plan" ? { missingRequirement: "negative-case-coverage-and-named-checks" } : {}),
          ...(operation === "revised-plan" ? { answersCritique: "negative-case-coverage-and-named-checks" } : {}),
        },
      };
    }
    if (operation === "no-write") return runNoWrite({ operation, config, cwd, sourceBytes: before.sourceBytes, testBytes: before.testBytes, parentPid });
    if (operation === "writer" || operation === "partial-writer") return runWriter({ operation, config, cwd, parentPid });
    if (operation === "incomplete-writer" || operation === "corrective-writer") return runFeedbackWriter({ operation, config, cwd, parentPid });
    if (operation === "critique-checker") return runCritiqueCheck({ config, cwd, stubDir, parentPid });
    if (operation === "plan-critique-checker") return runPlanCritiqueCheck({ config, cwd, stubDir, parentPid });
    if (operation === "auditor") return runAuditor({ config, cwd, stubDir, parentPid });
    return refused(operation, "operation is not in the closed fixture allowlist", config, cwd);
  } catch (error) {
    return {
      operation,
      role: caughtErrorRole(operation),
      preset: config.preset,
      status: "revise-or-stop",
      verified: false,
      exitCode: 1,
      report: `Fixture operation stopped after an observed local error: ${error.message}. No verified result is claimed.`,
      evidence: { ...evidenceBase(operation, config, cwd), parentPid, error: `${error.name}: ${error.message}`, changed: false },
    };
  }
}

export function appendExecutionOperationEvidence(stubDir, record) {
  const evidencePath = path.join(stubDir, "execution-operations.jsonl");
  fs.appendFileSync(evidencePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return evidencePath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === HELPER_PATH && (process.argv[2] === "--offline-audit" || process.argv[2] === "--offline-critique" || process.argv[2] === "--offline-plan-critique")) {
  const mode = process.argv[2];
  const role = mode === "--offline-critique" ? "read-only-checker" : mode === "--offline-plan-critique" ? "read-only-plan-checker" : "read-only-auditor";
  if (process.argv.length !== 4) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, role, status: "revise-or-stop", verified: false, reason: "offline helper argv is not the fixed form", cwd: process.cwd(), pid: process.pid, testCommand: null })}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = mode === "--offline-audit" ? auditorMain(process.argv[3]) : mode === "--offline-critique" ? critiqueMain(process.argv[3]) : planCritiqueMain(process.argv[3]);
  }
}
