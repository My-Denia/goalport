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
});

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

function passingTestOutput(command) {
  return command.exitCode === 0 && /# pass 2\b/u.test(command.stdout) && /# fail 0\b/u.test(command.stdout);
}

function fixedPlan(config, sourceBytes) {
  const source = sourceBytes.toString("utf8");
  if (source !== EXECUTION_FIXTURE_SOURCE) throw new Error("plan response requires the original broken add fixture");
  return "Plan: read the pinned src/add.mjs and unchanged test/add.test.mjs, replace the fixture's subtraction with addition, run the original node --test checks, then have a separate read-only auditor read the result and rerun those checks. This is a closed synthetic fixture operation; no model judgment or arbitrary command is involved. VERDICT: carry-out";
}

function expectedOperationRole(operation) {
  if (operation === "writer" || operation === "partial-writer") return "write";
  return "read";
}

function operationAllowed(operation, preset) {
  const expectedPreset = {
    plan: ["b1-full-chain", "b2-no-write", "b3-partial-failure"],
    "no-write": ["b2-no-write"],
    writer: ["b1-full-chain"],
    "partial-writer": ["b3-partial-failure"],
    auditor: ["b1-full-chain"],
  };
  return expectedPreset[operation]?.includes(preset) === true;
}

function refused(operation, reason, config, cwd) {
  return {
    operation,
    role: operation === "writer" || operation === "partial-writer" ? "executor" : operation === "auditor" ? "read-only-auditor" : "plan",
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
    if (config.preset !== "b1-full-chain") throw new Error("auditor only accepts the full-chain fixture preset");
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
    ? "VERIFIED by a separate read-only Node auditor process: it read the changed source and the unchanged pinned node --test checks passed (2/2). No independent model judgment is claimed."
    : `Auditor could not verify the observed fixture checks; revise or stop. ${auditor?.reason ?? "The actual auditor process did not report passing pinned tests."} No success is claimed.`;
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
    const before = readPinnedFixture(config, { expectedSourceSha256: operation === "auditor" ? null : config.sourceSha256 });
    if (operation === "plan") {
      return {
        operation,
        role: "read-only-plan",
        preset: config.preset,
        status: "completed",
        verified: false,
        exitCode: 0,
        report: fixedPlan(config, before.sourceBytes),
        evidence: { ...evidenceBase(operation, config, cwd), parentPid, sourceSha256: before.sourceSha256, testSha256: before.testSha256, sourceText: before.sourceBytes.toString("utf8"), changed: false },
      };
    }
    if (operation === "no-write") return runNoWrite({ operation, config, cwd, sourceBytes: before.sourceBytes, testBytes: before.testBytes, parentPid });
    if (operation === "writer" || operation === "partial-writer") return runWriter({ operation, config, cwd, parentPid });
    if (operation === "auditor") return runAuditor({ config, cwd, stubDir, parentPid });
    return refused(operation, "operation is not in the closed fixture allowlist", config, cwd);
  } catch (error) {
    return {
      operation,
      role: operation === "writer" || operation === "partial-writer" ? "executor" : operation === "auditor" ? "read-only-auditor" : "read-only-plan",
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

if (process.argv[1] && path.resolve(process.argv[1]) === HELPER_PATH && process.argv[2] === "--offline-audit") {
  if (process.argv.length !== 4) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, role: "read-only-auditor", status: "revise-or-stop", verified: false, reason: "auditor argv is not the fixed offline form", cwd: process.cwd(), pid: process.pid, testCommand: null })}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = auditorMain(process.argv[3]);
  }
}
