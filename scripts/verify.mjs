#!/usr/bin/env node

/*
 * GoalPort verification entry point.
 *
 * Runtime probes are preflight-only unless --live is supplied. Historical
 * milestone and scenario wrappers are retired; current tests own their contracts.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runtimeProbeCommand } from "./runtime-probe-command.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_EVIDENCE_DIR = path.join(ROOT, "goal-runs", "goalport-v1", "evidence");
const MAX_TIMEOUT_SECONDS = 3600;
const OUTPUT_LIMIT = 1024 * 1024;
const REDACTED_ROOT = "<workspace>";

const RUNTIME_CASES = [
  "auth", "send", "approval", "cancel", "resume",
  "native-config", "adapter-exit", "connection-owner"
];

const PROVIDERS = {
  codex: {
    displayName: "Codex",
    executable: "codex",
    transport: "app-server-stdio",
    preflight: [
      { name: "version", argvClass: "codex.version", args: ["--version"] },
      { name: "help", argvClass: "codex.app-server-help", args: ["app-server", "--help"] },
      { name: "auth", argvClass: "codex.login-status", args: ["login", "status"] }
    ]
  },
  grok: {
    displayName: "Grok",
    executable: "grok",
    transport: "acp-stdio",
    preflight: [
      { name: "version", argvClass: "grok.version", args: ["--version"] },
      { name: "help", argvClass: "grok.agent-help", args: ["agent", "--help"] },
      { name: "auth", argvClass: "grok.models", args: ["models"] }
    ]
  },
  claude: {
    displayName: "Claude Code",
    executable: "claude",
    transport: "native-cli-stream-json",
    preflight: [
      { name: "version", argvClass: "claude.version", args: ["--version"] },
      { name: "help", argvClass: "claude.help", args: ["--help"] },
      { name: "auth", argvClass: "claude.auth-status", args: ["auth", "status", "--json"] }
    ]
  }
};

class VerificationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "VerificationError";
    this.details = details;
  }
}

function fail(message, details = {}) {
  throw new VerificationError(message, details);
}

function now() {
  return new Date().toISOString();
}

function sha256(value) {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function workspacePath(input, label, fallback = undefined) {
  const value = input ?? fallback;
  if (!value) fail(label + " is required");
  const candidate = path.resolve(ROOT, value);
  if (!isWithin(ROOT, candidate)) fail(label + " must remain inside the workspace", { path: REDACTED_ROOT });
  return candidate;
}

function relativeWorkspace(candidate) {
  return path.relative(ROOT, candidate).split(path.sep).join("/");
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    if (equal > 2) {
      result[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const key = token.slice(2);
    if (key.startsWith("no-")) {
      result[key.slice(3)] = false;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function option(args, ...names) {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function asBoolean(value) {
  if (value === true || value === undefined) return value === true;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function seconds(value, fallback, label) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_SECONDS) {
    fail(label + " must be greater than zero and no more than " + MAX_TIMEOUT_SECONDS + " seconds");
  }
  return parsed;
}

function integer(value, fallback, label, minimum = 0) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) fail(label + " must be an integer >= " + minimum);
  return parsed;
}

function splitList(value, fallback = []) {
  if (value === undefined || value === "") return [...fallback];
  return String(value).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

async function readJson(file, label) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    fail("cannot read " + label, { message: String(error.message || error) });
  }
}

async function writeJson(file, value) {
  const target = workspacePath(file, "report path");
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = target + ".tmp-" + process.pid;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(temporary, target);
  return target;
}

async function walkFiles(directory, result = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "target", "dist", "goal-runs", ".goal-runs", ".git"].includes(entry.name)) continue;
      await walkFiles(full, result);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".tsbuildinfo") || entry.name.endsWith(".sqlite") || entry.name.endsWith(".db")) continue;
      result.push(full);
    }
  }
  return result;
}

async function toolVersion(command, args) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: ROOT,
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 32 * 1024
    });
    const output = String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0];
    return output.slice(0, 160) || "EMPTY";
  } catch {
    return "UNAVAILABLE";
  }
}

async function buildIdentity() {
  const files = (await walkFiles(ROOT)).sort((left, right) => left.localeCompare(right));
  const fileHash = createHash("sha256");
  let bytes = 0;
  const names = [];
  for (const file of files) {
    const relative = relativeWorkspace(file);
    const data = await fs.readFile(file);
    fileHash.update(relative + "\0");
    fileHash.update(data);
    fileHash.update("\0");
    bytes += data.byteLength;
    names.push(relative);
  }
  const toolVersions = {
    node: process.version,
    pnpm: await toolVersion(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--version"]),
    rustc: await toolVersion(process.platform === "win32" ? "rustc.exe" : "rustc", ["--version"]),
    cargo: await toolVersion(process.platform === "win32" ? "cargo.exe" : "cargo", ["--version"])
  };
  const filesDigest = fileHash.digest("hex");
  const identityPayload = JSON.stringify({
    algorithm: "goalport-build-id-v1",
    filesDigest,
    fileCount: files.length,
    bytes,
    toolVersions
  });
  return {
    buildId: sha256(identityPayload),
    algorithm: "goalport-build-id-v1",
    filesDigest,
    fileCount: files.length,
    bytes,
    toolVersions,
    files: names
  };
}

async function currentBuild(args = {}) {
  const identity = await buildIdentity();
  const expected = option(args, "build-id", "expected-build-id");
  if (expected && String(expected) !== identity.buildId) {
    fail("build ID mismatch", { expected: String(expected), actual: identity.buildId });
  }
  const buildFile = option(args, "build-id-file");
  if (buildFile) {
    const file = workspacePath(buildFile, "build ID file");
    const recorded = await readJson(file, "build ID file");
    if (recorded.buildId !== identity.buildId) {
      fail("build ID file is stale", { expected: identity.buildId, observed: recorded.buildId || "missing" });
    }
  }
  return identity;
}

function redactedPreview(value) {
  let text = String(value || "");
  text = text.replace(/[A-Za-z]:[\\/][^\r\n"']{1,240}/g, REDACTED_ROOT);
  text = text.replace(/(?:^|[\s"'=])(?:\/Users|\/home|\/mnt\/[a-z])\/[^\s"']{1,240}/gi, " " + REDACTED_ROOT);
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>");
  text = text.replace(/\b(?:sk|xai|api|token|key)[-_][A-Za-z0-9_-]{8,}\b/gi, "<secret>");
  text = text.replace(/\b(?:ghp|github_pat|AIza)[-_]?[A-Za-z0-9._~+\/=-]{8,}\b/gi, "<secret>");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}\b/gi, "Bearer <secret>");
  text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>");
  text = text.replace(/\b[0-9a-f]{32,}\b/gi, "<opaque-id>");
  text = text.replace(/("(?:subscriptionType|orgName)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"');
  return text.slice(0, 512);
}

function executableFor(name) {
  if (process.platform === "win32" && !name.endsWith(".cmd") && !name.endsWith(".exe")) return name + ".cmd";
  return name;
}

function providerInvocation(profile) {
  if (process.platform !== "win32") {
    return { command: profile.executable, prefix: [] };
  }
  const userProfile = process.env.USERPROFILE || "";
  if (profile.executable === "codex") {
    const script = path.join(
      process.env.APPDATA || "",
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js"
    );
    if (existsSync(script)) return { command: process.execPath, prefix: [script] };
  }
  const nativeCandidates = {
    claude: [path.join(userProfile, ".local", "bin", "claude.exe")],
    grok: [path.join(userProfile, ".grok", "bin", "grok.exe")]
  }[profile.executable] || [];
  const native = nativeCandidates.find((candidate) => existsSync(candidate));
  if (native) return { command: native, prefix: [] };
  return { command: profile.executable + ".exe", prefix: [] };
}

function runProcess(command, args, options = {}) {
  const timeoutMs = Math.max(1, Math.round(options.timeoutSeconds * 1000));
  const startedAt = now();
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let timer;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        command,
        exit: typeof code === "number" ? code : null,
        signal: signal || null,
        timedOut,
        spawnError: spawnError ? String(spawnError.message || spawnError) : null,
        stdoutBytes,
        stderrBytes,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
        stdoutPreview: redactedPreview(stdout),
        stderrPreview: redactedPreview(stderr),
        stdoutText: stdout,
        stderrText: stderr,
        startedAt,
        finishedAt: now()
      });
    };
    try {
      const env = { ...process.env, NO_COLOR: "1", ...(options.env || {}) };
      for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "CODEX_API_KEY"]) {
        delete env[key];
      }
      child = spawn(command, args, {
        cwd: options.cwd || ROOT,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdoutBytes += Buffer.byteLength(text);
        if (stdout.length < OUTPUT_LIMIT) stdout += text.slice(0, OUTPUT_LIMIT - stdout.length);
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderrBytes += Buffer.byteLength(text);
        if (stderr.length < OUTPUT_LIMIT) stderr += text.slice(0, OUTPUT_LIMIT - stderr.length);
      });
      child.once("error", (error) => {
        spawnError = error;
        finish(null, null);
      });
      child.once("close", finish);
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try {
          child.kill();
        } catch {
          // The close event will carry the timeout result.
        }
      }, timeoutMs);
    } catch (error) {
      spawnError = error;
      finish(null, null);
    }
  });
}

function parseStructuredEvents(output) {
  const events = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of list) {
        if (value && typeof value === "object") {
          events.push({
            type: typeof value.type === "string" ? value.type.slice(0, 80) : "unknown",
            hasSequence: Number.isInteger(value.sequence) || Number.isInteger(value.seq)
          });
        }
      }
    } catch {
      // A non-JSON line is not a structured event and is never counted.
    }
  }
  return events;
}

async function ensureSyntheticRoot(input) {
  const root = workspacePath(input, "synthetic root");
  const allowedPrefix = path.join(ROOT, "goal-runs", "goalport-v1", "fixtures", "runtime");
  if (!isWithin(allowedPrefix, root)) fail("synthetic root must be under the run-owned runtime fixture directory");
  const marker = path.join(root, ".goalport-synthetic.json");
  const metadata = await readJson(marker, "synthetic fixture marker");
  if (metadata.synthetic !== true || metadata.schemaVersion !== 1) fail("synthetic fixture marker is invalid");
  return root;
}

function assertKnownProvider(provider) {
  if (!PROVIDERS[provider]) fail("unknown provider", { provider });
}

function preflightStatus(result) {
  if (result.timedOut) return "TIMEOUT";
  if (result.spawnError) return "MISSING";
  return result.exit === 0 ? "PASS" : "FAIL";
}

async function runProviderPreflight(provider, timeoutSeconds, deadlineAt = Date.now() + timeoutSeconds * 1000) {
  const profile = PROVIDERS[provider];
  const invocation = providerInvocation(profile);
  const checks = [];
  for (const check of profile.preflight) {
    const remaining = Math.max(0, (deadlineAt - Date.now()) / 1000);
    const result = remaining <= 0
      ? { exit: null, timedOut: true, spawnError: "provider total timeout elapsed", stdoutBytes: 0, stderrBytes: 0, stdoutSha256: sha256(""), stderrSha256: sha256(""), stdoutPreview: "", stderrPreview: "", stdoutText: "", stderrText: "" }
      : await runProcess(invocation.command, [...invocation.prefix, ...check.args], { timeoutSeconds: Math.min(timeoutSeconds, remaining) });
    checks.push({
      name: check.name,
      argvClass: check.argvClass,
      status: preflightStatus(result),
      exit: result.exit,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutSha256: result.stdoutSha256,
      stderrSha256: result.stderrSha256,
      outputPreview: result.stdoutPreview || result.stderrPreview
    });
  }
  return checks;
}

async function runRuntimeProbe(provider, args, build) {
  assertKnownProvider(provider);
  const profile = PROVIDERS[provider];
  const invocation = providerInvocation(profile);
  const live = asBoolean(args.live);
  const totalTimeout = seconds(option(args, "total-timeout", "timeout"), live ? 420 : 120, "timeout");
  const caseTimeout = seconds(option(args, "case-timeout"), live ? 90 : Math.min(30, totalTimeout), "case-timeout");
  const requestedCases = splitList(args.cases, RUNTIME_CASES);
  for (const name of requestedCases) {
    if (!RUNTIME_CASES.includes(name)) fail("unknown Runtime probe case", { case: name });
  }
  let syntheticRoot = null;
  if (live) syntheticRoot = await ensureSyntheticRoot(option(args, "synthetic-root"));
  const startedAt = now();
  const deadlineAt = Date.now() + totalTimeout * 1000;
  const preflight = await runProviderPreflight(provider, Math.min(caseTimeout, totalTimeout), deadlineAt);
  const authCheck = preflight.find((item) => item.name === "auth");
  const cases = [];
  for (const name of requestedCases) {
    if (!live && name !== "auth") {
      cases.push({
        name,
        status: "NOT_RUN_PREFLIGHT_ONLY",
        attempted: 0,
        executed: 0,
        assertions: 0,
        skipped: 0,
        limitation: "--live is required for synthetic Runtime execution"
      });
      continue;
    }
    if (name === "auth") {
      cases.push({
        name,
        status: authCheck && authCheck.status === "PASS" ? "PASS" : "UNSUPPORTED",
        attempted: 1,
        executed: authCheck && authCheck.status === "PASS" ? 1 : 0,
        assertions: authCheck && authCheck.status === "PASS" ? 1 : 0,
        skipped: 0,
        source: "runtime-preflight",
        limitation: authCheck && authCheck.status === "PASS" ? null : "native authentication was not observed"
      });
      continue;
    }
    if (!live) continue;
    const command = runtimeProbeCommand({ provider, executable: profile.executable, invocation, name, syntheticRoot, root: ROOT });
    const remaining = Math.max(0, (deadlineAt - Date.now()) / 1000);
    const result = remaining <= 0
      ? { exit: null, timedOut: true, spawnError: "provider total timeout elapsed", stdoutBytes: 0, stderrBytes: 0, stdoutSha256: sha256(""), stderrSha256: sha256(""), stdoutPreview: "", stderrPreview: "", stdoutText: "", stderrText: "" }
      : await runProcess(command.command, command.args, {
        timeoutSeconds: Math.min(caseTimeout, remaining),
        cwd: command.cwd,
        env: { GOALPORT_SYNTHETIC_PROBE: "1" }
      });
    const events = parseStructuredEvents(result.stdoutText);
    const sendPass = name === "send" && result.exit === 0 && !result.timedOut && events.length > 0;
    cases.push({
      name,
      status: sendPass ? "PASS" : "UNSUPPORTED",
      attempted: 1,
      executed: result.timedOut || result.spawnError ? 0 : 1,
      assertions: sendPass ? 2 : 0,
      skipped: 0,
      argvClass: command.argvClass,
      exit: result.exit,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
      structuredEvents: events.length,
      eventTypes: [...new Set(events.map((event) => event.type))].slice(0, 20),
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutSha256: result.stdoutSha256,
      stderrSha256: result.stderrSha256,
      outputPreview: result.stdoutPreview || result.stderrPreview,
      limitation: sendPass ? null : "no direct structured capability assertion was observed"
    });
  }
  const executed = cases.reduce((sum, item) => sum + item.executed, 0);
  const assertions = cases.reduce((sum, item) => sum + item.assertions, 0);
  const skipped = cases.reduce((sum, item) => sum + item.skipped, 0);
  const allRequestedAttempted = live && cases.every((item) => item.attempted === 1);
  const status = live && allRequestedAttempted && assertions > 0 && skipped === 0 ? "PARTIAL" : "PREFLIGHT_ONLY";
  return {
    schemaVersion: 1,
    kind: "runtime-probe",
    buildId: build.buildId,
    provider,
    providerName: profile.displayName,
    transport: profile.transport,
    mode: live ? "live-synthetic" : "preflight",
    liveRequested: live,
    nativeAuthOnly: true,
    apiFallback: false,
    syntheticRoot: live ? "<synthetic-fixture>" : null,
    startedAt,
    finishedAt: now(),
    timeoutSeconds: totalTimeout,
    caseTimeoutSeconds: caseTimeout,
    preflight,
    cases,
    status,
    executed,
    assertions,
    skipped,
    nonZeroRange: {
      casesRequested: requestedCases.length,
      casesAttempted: cases.filter((item) => item.attempted > 0).length,
      structuredEvents: cases.reduce((sum, item) => sum + (item.structuredEvents || 0), 0)
    },
    limitations: live ? ["Only capabilities with direct structured observations can be promoted."] : ["Preflight does not prove a Runtime turn, subscription routing, permissions, cancellation, or resume."],
    sanitized: true
  };
}

function parseRustTestSummary(output) {
  let passed = 0;
  let failed = 0;
  let ignored = 0;
  let summaries = 0;
  const pattern = /test result:\s+(?:ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/gi;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    summaries += 1;
    passed += Number(match[1]);
    failed += Number(match[2]);
    ignored += Number(match[3]);
  }
  if (summaries === 0) {
    passed = (output.match(/^test\s+.+\.\.\.\s+ok\s*$/gim) || []).length;
    failed = (output.match(/^test\s+.+\.\.\.\s+(?:FAILED|fail)\s*$/gim) || []).length;
  }
  return { passed, failed, ignored, executed: passed + failed, skipped: ignored, summaries };
}

async function runCargoTest(target, timeoutSeconds, extraEnv = {}) {
  const cargo = executableFor(process.platform === "win32" ? "cargo.exe" : "cargo");
  const result = await runProcess(cargo, ["test", "-p", "goalport-core", "--test", target, "--", "--nocapture"], {
    timeoutSeconds,
    env: extraEnv
  });
  const summary = parseRustTestSummary(result.stdoutText + "\n" + result.stderrText);
  return { result, summary };
}

async function runIpc(args, build) {
  const timeoutSeconds = seconds(option(args, "timeout"), 120, "IPC timeout");
  const reportFile = option(args, "report") || path.join(DEFAULT_EVIDENCE_DIR, "m0-ipc.json");
  const target = path.join(ROOT, "crates", "goalport-core", "tests", "ipc_lifecycle.rs");
  const startedAt = now();
  let result;
  let summary = { passed: 0, failed: 0, ignored: 0, executed: 0, skipped: 0, summaries: 0 };
  if (existsSync(target)) {
    const output = await runCargoTest("ipc_lifecycle", timeoutSeconds);
    result = output.result;
    summary = output.summary;
  } else {
    result = { exit: null, timedOut: false, spawnError: "ipc_lifecycle integration test target is absent", stdoutBytes: 0, stderrBytes: 0, stdoutSha256: sha256(""), stderrSha256: sha256("") };
  }
  const status = result.exit === 0 && !result.timedOut && summary.executed > 0 && summary.failed === 0 && summary.skipped === 0 ? "PASS" : "FAIL";
  const report = {
    schemaVersion: 1, kind: "ipc-gate", buildId: build.buildId, startedAt, finishedAt: now(), timeoutSeconds, status,
    executed: summary.executed, assertions: summary.executed, skipped: summary.skipped,
    nonZeroRange: { tests: summary.executed, passed: summary.passed, failed: summary.failed },
    process: { exit: result.exit, timedOut: result.timedOut, spawnError: result.spawnError, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 },
    limitations: status === "PASS" ? [] : ["IPC gate is not satisfied until the real ipc_lifecycle integration target executes non-zero tests."]
  };
  await writeJson(reportFile, report);
  if (status !== "PASS") fail("IPC gate failed closed", report);
  return report;
}

function help() {
  console.log([
    "GoalPort verification",
    "",
    "Commands:",
    "  build-id       compute the current source/tool build identity",
    "  runtime        preflight a native Runtime; add --live for synthetic execution",
    "  ipc            run the real ipc_lifecycle integration target",
    "  Legacy milestone and scenario gates are retired; see docs/testing.md.",
    "",
    "Every report is bound to the current build ID. Reports with zero/skipped",
    "tests, stale IDs, forbidden effects, unsupported Core output, or timeouts fail."
  ].join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args._[0] || "");
  if (!command || command === "help" || args.help) { help(); return; }
  if (/^m[0-5]$/.test(command) || ["scenario", "baseline-m1"].includes(command)) {
    console.error("Retired milestone/scenario gate. Use the current unit, IPC and packaged acceptance commands in docs/testing.md. Historical reports are not current capability evidence.");
    process.exitCode = 2; return;
  }
  if (!["build-id", "runtime", "ipc"].includes(command)) fail("unknown verification command", { command });
  const build = await currentBuild(args);
  if (command === "build-id") {
    const output = option(args, "out", "report") || path.join(DEFAULT_EVIDENCE_DIR, "build-id.json");
    await writeJson(output, { schemaVersion: 1, kind: "build-id", ...build, computedAt: now(), host: os.platform() + "-" + os.arch() });
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId, fileCount: build.fileCount, output: relativeWorkspace(workspacePath(output, "report path")) }));
    return;
  }
  if (command === "runtime") {
    const providers = splitList(args.provider, Object.keys(PROVIDERS));
    const reports = [];
    for (const provider of providers) reports.push(await runRuntimeProbe(provider, args, build));
    const output = option(args, "report");
    if (output) {
      if (reports.length === 1) await writeJson(output, reports[0]);
      else await writeJson(output, { schemaVersion: 1, kind: "runtime-probe-set", buildId: build.buildId, reports });
    }
    const failed = reports.some((report) => report.liveRequested ? report.assertions <= 0 || report.skipped > 0 : report.preflight.some((check) => check.status !== "PASS"));
    if (failed) fail("Runtime probe did not satisfy its requested evidence level", { providers, live: asBoolean(args.live) });
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId, providers, mode: asBoolean(args.live) ? "live-synthetic" : "preflight" }));
    return;
  }
  if (command === "ipc") {
    await runIpc(args, build);
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId }));
    return;
  }
  fail("unknown verification command", { command });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ status: "FAIL", error: error.message, details: error instanceof VerificationError ? error.details : {} }));
    process.exitCode = 1;
  });
}
