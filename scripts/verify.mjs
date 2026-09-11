#!/usr/bin/env node

/*
 * GoalPort verification entry point.
 *
 * This file is deliberately a small, dependency-free gate. It never treats
 * an exit code by itself as evidence: every gate needs a non-zero execution
 * range, a current build identity, and an explicit limitation record. Real
 * Runtime probes are preflight-only unless --live is supplied.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_EVIDENCE_DIR = path.join(ROOT, "goal-runs", "goalport-v1", "evidence");
const SCENARIO_MANIFEST = path.join(ROOT, "tests", "scenarios", "manifest.json");
const MAX_TIMEOUT_SECONDS = 3600;
const OUTPUT_LIMIT = 1024 * 1024;
const REDACTED_ROOT = "<workspace>";
const SYNTHETIC_TASK = "Reply exactly GOALPORT_RUNTIME_OK. Do not use tools, read or write files, access the network, or perform any external action.";

const SCENARIO_IDS = [
  "DUR-01", "DUR-02", "DUR-03", "DUR-04",
  "QUA-01", "QUA-02", "QUA-03", "QUA-04",
  "ROU-01", "ROU-02", "ROU-03",
  "EFF-01", "EFF-02", "EFF-03",
  "SEC-01", "SEC-02",
  "SAF-01", "SAF-02",
  "COM-01", "COM-02",
  "RES-01", "RES-02",
  "DAT-01"
];

const REQUIRED_M0_CASES = [
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
    ],
    live: {
      send: {
        argvClass: "codex.synthetic-exec",
        args: ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--cd", "<synthetic-root>", "GOALPORT_SYNTHETIC_TASK"]
      },
      probe: ["app-server", "--help"]
    }
  },
  grok: {
    displayName: "Grok",
    executable: "grok",
    transport: "acp-stdio",
    preflight: [
      { name: "version", argvClass: "grok.version", args: ["--version"] },
      { name: "help", argvClass: "grok.agent-help", args: ["agent", "--help"] },
      { name: "auth", argvClass: "grok.models", args: ["models"] }
    ],
    live: {
      send: {
        argvClass: "grok.synthetic-headless",
        args: ["-p", "GOALPORT_SYNTHETIC_TASK", "--output-format", "streaming-json", "--max-turns", "1", "--no-subagents", "--disable-web-search"]
      },
      probe: ["agent", "--help"]
    }
  },
  claude: {
    displayName: "Claude Code",
    executable: "claude",
    transport: "native-cli-stream-json",
    preflight: [
      { name: "version", argvClass: "claude.version", args: ["--version"] },
      { name: "help", argvClass: "claude.help", args: ["--help"] },
      { name: "auth", argvClass: "claude.auth-status", args: ["auth", "status", "--json"] }
    ],
    live: {
      send: {
        argvClass: "claude.synthetic-print",
        args: ["-p", "GOALPORT_SYNTHETIC_TASK", "--output-format", "stream-json", "--max-turns", "1", "--verbose"]
      },
      probe: ["--help"]
    }
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

function safeArgs(args, syntheticRoot) {
  // The child is started with cwd=syntheticRoot for the task case. Keep the
  // placeholder relative and do not put a user path in argv evidence.
  return args.map((value) => value === "<synthetic-root>" ? "." : value === "GOALPORT_SYNTHETIC_TASK" ? SYNTHETIC_TASK : value);
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
  const requestedCases = splitList(args.cases, REQUIRED_M0_CASES);
  for (const name of requestedCases) {
    if (!REQUIRED_M0_CASES.includes(name)) fail("unknown Runtime probe case", { case: name });
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
    const spec = name === "send" ? profile.live.send : {
      argvClass: profile.executable + "." + name + "-capability-probe",
      args: profile.live.probe
    };
    const remaining = Math.max(0, (deadlineAt - Date.now()) / 1000);
    const result = remaining <= 0
      ? { exit: null, timedOut: true, spawnError: "provider total timeout elapsed", stdoutBytes: 0, stderrBytes: 0, stdoutSha256: sha256(""), stderrSha256: sha256(""), stdoutPreview: "", stderrPreview: "", stdoutText: "", stderrText: "" }
      : await runProcess(invocation.command, [...invocation.prefix, ...safeArgs(spec.args, syntheticRoot)], {
        timeoutSeconds: Math.min(caseTimeout, remaining),
        cwd: name === "send" ? syntheticRoot : ROOT,
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
      argvClass: spec.argvClass,
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

function parseVitestSummary(output) {
  const values = [];
  for (const match of output.matchAll(/Tests\s+[^0-9]*(\d+)\s+passed/gi)) values.push(Number(match[1]));
  const passed = values.length ? Math.max(...values) : (output.match(/^\s*[✓✔]\s+/gm) || []).length;
  const failed = (output.match(/^\s*[×✘]\s+/gm) || []).length;
  const skipped = (output.match(/\b(\d+)\s+skipped\b/gi) || []).reduce((sum, line) => sum + Number(line.match(/\d+/)[0]), 0);
  return { passed, failed, skipped, executed: passed + failed };
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

async function runPnpm(args, timeoutSeconds) {
  const pnpm = executableFor(process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  return runProcess(pnpm, args, { timeoutSeconds });
}

function requireNonZeroTests(summary, label, minimum = 1) {
  if (summary.executed < minimum || summary.failed > 0 || summary.skipped > 0) {
    fail(label + " did not execute the required non-zero test range", summary);
  }
}

async function coreRunner() {
  const candidates = [
    path.join(ROOT, "target", "debug", process.platform === "win32" ? "goalport-core.exe" : "goalport-core"),
    path.join(ROOT, "target", "release", process.platform === "win32" ? "goalport-core.exe" : "goalport-core")
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let binaryStamp = 0;
    try {
      binaryStamp = (await fs.stat(candidate)).mtimeMs;
      const sourceFiles = await walkFiles(path.join(ROOT, "crates", "goalport-core", "src"));
      const latestSource = Math.max(...(await Promise.all(sourceFiles.map(async (file) => (await fs.stat(file)).mtimeMs))), 0);
      if (binaryStamp < latestSource) continue;
    } catch {
      continue;
    }
    return { command: candidate, prefix: [] };
  }
  const cargoFile = executableFor(process.platform === "win32" ? "cargo.exe" : "cargo");
  try {
    const build = await execFileAsync(cargoFile, ["build", "-p", "goalport-core", "--bin", "goalport-core", "--quiet"], {
      cwd: ROOT,
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 256 * 1024
    });
    void build;
    const candidate = path.join(ROOT, "target", "debug", process.platform === "win32" ? "goalport-core.exe" : "goalport-core");
    if (existsSync(candidate)) return { command: candidate, prefix: [] };
  } catch {
    // A source checkout without a buildable Core cannot satisfy S.
  }
  try {
    await execFileAsync(cargoFile, ["metadata", "--no-deps", "--format-version", "1"], {
      cwd: ROOT,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
  } catch {
    return null;
  }
  return { command: cargoFile, prefix: ["run", "--quiet", "-p", "goalport-core", "--"] };
}

function parseCoreJson(output) {
  const lines = String(output || "").trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // Keep looking for the final structured result.
    }
  }
  return null;
}

function readField(value, ...names) {
  for (const name of names) {
    if (value && value[name] !== undefined) return value[name];
  }
  return undefined;
}

function normalizeCoreSummary(raw) {
  const range = readField(raw, "nonZeroRange", "non_zero_range", "range") || {};
  const forbidden = readField(raw, "forbiddenEffects", "forbidden_effects");
  const coreBuildId = readField(raw, "coreBuildId", "core_build_id", "buildId", "build_id");
  const status = String(readField(raw, "status", "verdict") || "").toUpperCase();
  return {
    scenarioId: readField(raw, "scenarioId", "scenario_id", "id"),
    status,
    engine: String(readField(raw, "engine", "runner", "source") || ""),
    coreBuildId: coreBuildId === undefined ? null : String(coreBuildId),
    executed: Number(readField(raw, "executed", "commandsExecuted") ?? range.executed ?? 0),
    assertions: Number(readField(raw, "assertions", "assertionsExecuted") ?? range.assertions ?? 0),
    skipped: Number(readField(raw, "skipped", "skippedAssertions") ?? range.skipped ?? 0),
    forbiddenEffects: Array.isArray(forbidden) ? forbidden : null,
    predicateSet: readField(raw, "predicateSet", "predicate_set") || null,
    predicates: Array.isArray(readField(raw, "predicates", "predicate_names"))
      ? readField(raw, "predicates", "predicate_names")
      : null,
    nonZeroRange: range,
    raw
  };
}

export function predicateBindingErrors(summary, id) {
  const errors = [];
  if (summary.predicateSet !== id) errors.push("scenario predicate set is not bound to the selected ID");
  if (!summary.predicates || summary.predicates.length < 2) errors.push("scenario needs at least two named specific predicates");
  if (summary.predicates && summary.predicates.some((name) => !String(name).startsWith(id + ":"))) errors.push("scenario predicate name is not ID-scoped");
  if (summary.predicates && new Set(summary.predicates).size !== summary.predicates.length) errors.push("scenario predicate names must be unique");
  if (summary.predicates && summary.predicates.some((name) => /generic/i.test(String(name)))) errors.push("generic scenario predicates are forbidden");
  return errors;
}

async function loadManifest(file = SCENARIO_MANIFEST) {
  const manifestFile = workspacePath(file, "scenario manifest");
  const manifest = await readJson(manifestFile, "scenario manifest");
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.scenarios)) {
    fail("scenario manifest schema must be version 1 with a scenarios array");
  }
  if (manifest.scenarios.length !== SCENARIO_IDS.length) {
    fail("scenario manifest must contain exactly 23 scenarios", { count: manifest.scenarios.length });
  }
  const ids = manifest.scenarios.map((scenario) => scenario && scenario.id);
  if (new Set(ids).size !== ids.length || SCENARIO_IDS.some((id) => !ids.includes(id))) {
    fail("scenario manifest IDs do not match the required 23 IDs", { ids });
  }
  for (const scenario of manifest.scenarios) {
    const required = ["initialState", "inputs", "faults", "expectedEvents", "expectedFinalState", "forbiddenEffects", "requiredLevels"];
    for (const key of required) {
      if (scenario[key] === undefined) fail("scenario is missing required declarative field", { id: scenario.id, field: key });
    }
    if (!Array.isArray(scenario.requiredLevels) || !scenario.requiredLevels.includes("S")) {
      fail("every scenario must require executable S evidence", { id: scenario.id });
    }
    if (!Array.isArray(scenario.forbiddenEffects)) fail("forbiddenEffects must be an array", { id: scenario.id });
  }
  return { file: manifestFile, manifest, manifestHash: sha256(JSON.stringify(manifest)) };
}

async function runScenario(args, build) {
  const loaded = await loadManifest(option(args, "scenario-manifest") || SCENARIO_MANIFEST);
  const id = String(option(args, "id") || "");
  if (!SCENARIO_IDS.includes(id)) fail("scenario --id must name one of the 23 declared scenarios");
  const scenario = loaded.manifest.scenarios.find((item) => item.id === id);
  const timeoutSeconds = seconds(option(args, "timeout"), 60, "scenario timeout");
  const reportFile = option(args, "report") || path.join(DEFAULT_EVIDENCE_DIR, "scenarios", id + ".json");
  const base = {
    schemaVersion: 1,
    kind: "scenario-result",
    buildId: build.buildId,
    scenarioId: id,
    requiredLevels: scenario.requiredLevels,
    manifest: relativeWorkspace(loaded.file),
    manifestHash: loaded.manifestHash,
    startedAt: now(),
    timeoutSeconds,
    evidence: {
      S: { status: "UNMET", required: true, executed: 0, assertions: 0 },
      R: { status: scenario.requiredLevels.includes("R") ? "UNMET" : "NOT_REQUIRED", required: scenario.requiredLevels.includes("R") },
      D: { status: scenario.requiredLevels.includes("D") ? "UNMET" : "NOT_REQUIRED", required: scenario.requiredLevels.includes("D") }
    },
    limitations: ["R/D evidence is a separate obligation and is never inferred from Scenario execution."]
  };
  const runner = await coreRunner();
  if (!runner) {
    const report = { ...base, status: "BLOCKED", executed: 0, assertions: 0, skipped: 1, forbiddenEffects: [], error: "goalport-core scenario CLI is unavailable", finishedAt: now() };
    await writeJson(reportFile, report);
    fail("scenario S runner is unavailable; no synthetic assertion was executed");
  }
  const argsForCore = [
    ...runner.prefix,
    "scenario",
    "--manifest", relativeWorkspace(loaded.file),
    "--id", id,
    "--json",
    "--timeout", String(timeoutSeconds),
    "--build-id", build.buildId
  ];
  const result = await runProcess(runner.command, argsForCore, { timeoutSeconds });
  const raw = parseCoreJson(result.stdoutText);
  if (!raw) {
    const report = { ...base, status: "FAIL", executed: 0, assertions: 0, skipped: 1, forbiddenEffects: [], process: { exit: result.exit, timedOut: result.timedOut, spawnError: result.spawnError, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 }, error: "Core did not return a structured scenario result", finishedAt: now() };
    await writeJson(reportFile, report);
    fail("Core scenario CLI returned no structured result");
  }
  const summary = normalizeCoreSummary(raw);
  const reasons = [];
  if (summary.scenarioId && summary.scenarioId !== id) reasons.push("scenario ID mismatch");
  if (summary.coreBuildId && summary.coreBuildId !== build.buildId) reasons.push("Core build ID is stale");
  if (!summary.coreBuildId) reasons.push("Core result did not bind itself to the current build ID");
  if (summary.engine && /mock|fake|stub/i.test(summary.engine)) reasons.push("mock/fake/stub engine is not admissible");
  if (result.timedOut) reasons.push("scenario timed out");
  if (result.exit !== 0) reasons.push("Core exited non-zero");
  if (summary.executed !== 1) reasons.push("scenario executed count must equal 1");
  if (summary.assertions <= 0) reasons.push("scenario assertion count must be greater than zero");
  if (summary.skipped !== 0) reasons.push("required scenario assertions were skipped");
  if (summary.forbiddenEffects === null) reasons.push("Core did not report forbidden effects");
  if (summary.forbiddenEffects && summary.forbiddenEffects.length > 0) reasons.push("forbidden effect observed");
  reasons.push(...predicateBindingErrors(summary, id));
  if (summary.status !== "PASS" && summary.status !== "SUPPORTED") reasons.push("Core scenario verdict is not PASS");
  const report = {
    ...base,
    status: reasons.length === 0 ? "PASS" : "FAIL",
    executed: summary.executed,
    assertions: summary.assertions,
    skipped: summary.skipped,
    forbiddenEffects: summary.forbiddenEffects || [],
    evidence: {
      ...base.evidence,
      S: { status: reasons.length === 0 ? "PASS" : "UNMET", required: true, executed: summary.executed, assertions: summary.assertions, skipped: summary.skipped, engine: summary.engine || "unknown" }
    },
    core: { status: summary.status, engine: summary.engine || "unknown", buildId: summary.coreBuildId, predicateSet: summary.predicateSet, predicates: summary.predicates, nonZeroRange: summary.nonZeroRange },
    process: { exit: result.exit, timedOut: result.timedOut, spawnError: result.spawnError, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 },
    failures: reasons,
    finishedAt: now()
  };
  await writeJson(reportFile, report);
  if (reasons.length > 0) fail("scenario failed closed", { id, reasons });
  return report;
}

function reportBuildId(report, expected) {
  if (!report || report.buildId !== expected) fail("evidence report build ID is stale or missing", { expected, observed: report && report.buildId });
}

async function loadEvidence(file, expectedBuildId, label) {
  const reportFile = workspacePath(file, label);
  const report = await readJson(reportFile, label);
  reportBuildId(report, expectedBuildId);
  return report;
}

function requireReportRange(report, label, minimum = 1) {
  if (!Number.isInteger(report.executed) || report.executed < minimum || !Number.isInteger(report.assertions) || report.assertions <= 0 || report.skipped !== 0) {
    fail(label + " lacks a non-zero, non-skipped execution range", { executed: report.executed, assertions: report.assertions, skipped: report.skipped });
  }
  if (report.forbiddenEffects && report.forbiddenEffects.length > 0) fail(label + " contains a forbidden effect");
}

async function scenarioSet(args, build, ids = SCENARIO_IDS) {
  const results = [];
  for (const id of ids) {
    const scenarioArgs = { ...args, id, report: path.join(DEFAULT_EVIDENCE_DIR, "scenarios", id + ".json") };
    try {
      results.push(await runScenario(scenarioArgs, build));
    } catch (error) {
      results.push({ scenarioId: id, status: "FAIL", error: error.message });
    }
  }
  const passed = results.filter((item) => item.status === "PASS").length;
  if (passed !== ids.length) fail("not every required scenario passed S", { expected: ids.length, passed, results });
  return results;
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

async function runBaseline(args, build) {
  const timeoutSeconds = seconds(option(args, "timeout"), 300, "baseline timeout");
  const events = integer(args.events, 10000, "events", 1);
  const history = integer(args.history, 1000, "history", 1);
  const reconnects = integer(args.reconnects, 20, "reconnects", 1);
  const reportFile = option(args, "report") || path.join(DEFAULT_EVIDENCE_DIR, "m1-baseline.json");
  const target = path.join(ROOT, "crates", "goalport-core", "tests", "baseline_m1.rs");
  let result;
  let summary = { passed: 0, failed: 0, ignored: 0, executed: 0, skipped: 0, summaries: 0 };
  if (existsSync(target)) {
    const output = await runCargoTest("baseline_m1", timeoutSeconds, {
      GOALPORT_BASELINE_EVENTS: String(events),
      GOALPORT_BASELINE_HISTORY: String(history),
      GOALPORT_BASELINE_RECONNECTS: String(reconnects)
    });
    result = output.result;
    summary = output.summary;
  } else {
    result = { exit: null, timedOut: false, spawnError: "baseline_m1 integration test target is absent", stdoutBytes: 0, stderrBytes: 0, stdoutSha256: sha256(""), stderrSha256: sha256("") };
  }
  const outputText = result.stdoutText + "\n" + result.stderrText;
  const observed = {
    events: Number((outputText.match(/events(?:=|:|\s+)(\d+)/i) || [])[1] || 0),
    history: Number((outputText.match(/history(?:=|:|\s+)(\d+)/i) || [])[1] || 0),
    reconnects: Number((outputText.match(/reconnects?(?:=|:|\s+)(\d+)/i) || [])[1] || 0)
  };
  const measured = observed.events >= events && observed.history >= history && observed.reconnects >= reconnects;
  const status = result.exit === 0 && !result.timedOut && summary.executed > 0 && summary.failed === 0 && summary.skipped === 0 && measured ? "PASS" : "FAIL";
  const report = {
    schemaVersion: 1, kind: "m1-baseline", buildId: build.buildId, startedAt: now(), finishedAt: now(), timeoutSeconds,
    requested: { events, history, reconnects }, observed, status, executed: summary.executed, assertions: summary.executed, skipped: summary.skipped,
    nonZeroRange: { tests: summary.executed, events: observed.events, history: observed.history, reconnects: observed.reconnects },
    process: { exit: result.exit, timedOut: result.timedOut, spawnError: result.spawnError, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256 },
    limitations: measured ? [] : ["The baseline must print measured event, history, and reconnect counts; configured numbers are not evidence."]
  };
  await writeJson(reportFile, report);
  if (status !== "PASS") fail("M1 baseline failed closed", report);
  return report;
}

async function requireLiveLayer(file, expectedBuildId, layer, label) {
  const report = await loadEvidence(file, expectedBuildId, label);
  requireReportRange(report, label);
  if (String(report.layer || report.evidenceLayer || "").toUpperCase() !== layer) fail(label + " has the wrong evidence layer");
  if (report.directObservation !== true && report.actual !== true && report.real !== true) fail(label + " must explicitly identify a direct real observation");
  if (report.mock === true || /mock|fake|stub/i.test(String(report.mode || "") + " " + String(report.engine || ""))) fail(label + " cannot use a mock/fake/stub for a real evidence layer");
  if (report.status !== "PASS" && report.status !== "SUPPORTED") fail(label + " is not a passing direct observation");
  return report;
}

async function runM1(args, build) {
  const timeoutSeconds = seconds(args.timeout, 900, "M1 timeout");
  const reportFile = args.report || path.join(DEFAULT_EVIDENCE_DIR, "m1.json");
  const selectionFile = args["runtime-selection"];
  const checks = [];
  if (!selectionFile) fail("M1 requires --runtime-selection");
  const selection = await loadEvidence(selectionFile, build.buildId, "runtime selection");
  const selected = selection.selected || selection.providers || {};
  const provider = String(selected.primary || selection.primary || "").toLowerCase();
  assertKnownProvider(provider);
  if (selection.status && !["PASS", "SUPPORTED", "SELECTED"].includes(String(selection.status).toUpperCase())) fail("M0 runtime selection is not passing");
  const rust = await runCargoTest("m1", timeoutSeconds);
  requireNonZeroTests(rust.summary, "M1 Rust tests", 15);
  checks.push({ name: "rust", ...rust.summary, exit: rust.result.exit });
  const ui = await runPnpm(["test", "--", "--run"], timeoutSeconds);
  const uiSummary = parseVitestSummary(ui.stdoutPreview + "\n" + ui.stderrPreview);
  if (ui.result.exit !== 0 || uiSummary.executed < 6 || uiSummary.failed > 0 || uiSummary.skipped > 0) fail("M1 UI tests failed closed", uiSummary);
  checks.push({ name: "ui", ...uiSummary, exit: ui.result.exit });
  const buildResult = await runPnpm(["build"], timeoutSeconds);
  if (buildResult.exit !== 0 || buildResult.timedOut) fail("M1 frontend build failed", { exit: buildResult.exit, timedOut: buildResult.timedOut });
  const runtimeEvidence = option(args, "runtime-evidence");
  const desktopEvidence = option(args, "desktop-evidence");
  if (!runtimeEvidence || !desktopEvidence) fail("M1 requires direct R and D evidence; Scenario or Mock output cannot substitute");
  await requireLiveLayer(runtimeEvidence, build.buildId, "R", "M1 Runtime evidence");
  await requireLiveLayer(desktopEvidence, build.buildId, "D", "M1 Desktop evidence");
  const report = {
    schemaVersion: 1, kind: "m1-gate", buildId: build.buildId, status: "PASS", provider, startedAt: now(), finishedAt: now(), checks,
    executed: checks.reduce((sum, item) => sum + item.executed, 0), assertions: checks.reduce((sum, item) => sum + item.executed, 0), skipped: 0,
    nonZeroRange: { rustTests: rust.summary.executed, uiTests: uiSummary.executed, realTurn: 1, uiRestart: 1 }, limitations: []
  };
  await writeJson(reportFile, report);
  return report;
}

async function runM2(args, build) {
  const timeoutSeconds = seconds(args.timeout, 1200, "M2 timeout");
  const reportFile = args.report || path.join(DEFAULT_EVIDENCE_DIR, "m2.json");
  const selectionFile = args["runtime-selection"];
  if (!selectionFile) fail("M2 requires --runtime-selection");
  const selection = await loadEvidence(selectionFile, build.buildId, "runtime selection");
  const ranked = splitList(args["provider-ranks"], ["primary", "secondary"]);
  if (ranked.length < 2) fail("M2 requires primary and secondary runtime ranks");
  const selected = selection.selected || selection.providers || {};
  for (const rank of ranked.slice(0, 2)) assertKnownProvider(String(selected[rank] || "").toLowerCase());
  const contract = await runCargoTest("m2", timeoutSeconds);
  requireNonZeroTests(contract.summary, "M2 cross-adapter contract tests", 12);
  const requiredIds = ["QUA-02", "ROU-01", "ROU-02", "ROU-03", "EFF-03"];
  const scenarios = await scenarioSet(args, build, requiredIds);
  const runtimeEvidence = option(args, "runtime-evidence");
  const desktopEvidence = option(args, "desktop-evidence");
  if (!runtimeEvidence || !desktopEvidence) fail("M2 requires two direct Runtime reports and one direct Desktop report");
  const runtimeReports = String(runtimeEvidence).split(",").map((item) => item.trim()).filter(Boolean);
  if (runtimeReports.length < 2) fail("M2 --runtime-evidence must contain two report paths");
  for (const file of runtimeReports.slice(0, 2)) await requireLiveLayer(file, build.buildId, "R", "M2 Runtime evidence");
  await requireLiveLayer(desktopEvidence, build.buildId, "D", "M2 Desktop evidence");
  const report = {
    schemaVersion: 1, kind: "m2-gate", buildId: build.buildId, status: "PASS", startedAt: now(), finishedAt: now(),
    providers: ranked.slice(0, 2).map((rank) => selected[rank]),
    executed: contract.summary.executed + scenarios.length,
    assertions: contract.summary.executed + scenarios.reduce((sum, item) => sum + item.assertions, 0),
    skipped: 0, nonZeroRange: { contractTests: contract.summary.executed, scenarios: scenarios.length },
    limitations: ["R/D obligations remain direct evidence requirements; this gate does not promote S to R/D."]
  };
  await writeJson(reportFile, report);
  return report;
}

async function runM3(args, build) {
  const timeoutSeconds = seconds(args.timeout, 900, "M3 timeout");
  const reportFile = args.report || path.join(DEFAULT_EVIDENCE_DIR, "m3.json");
  const loaded = await loadManifest(option(args, "scenario-manifest") || SCENARIO_MANIFEST);
  if (loaded.manifest.scenarios.length !== 23) fail("M3 requires exactly 23 scenarios");
  const traces = integer(args.traces, 1000, "traces", 1);
  const scenarios = await scenarioSet(args, build);
  const stateMachine = await runCargoTest("state_machine", timeoutSeconds, { GOALPORT_STATE_MACHINE_TRACES: String(traces) });
  requireNonZeroTests(stateMachine.summary, "M3 state-machine tests", 1);
  const stateMachineOutput = stateMachine.result.stdoutText + "\n" + stateMachine.result.stderrText;
  const observedTraces = Number((stateMachineOutput.match(/traces(?:=|:|\s+)(\d+)/i) || [])[1] || 0);
  if (observedTraces < traces) fail("M3 state-machine test did not report the requested non-zero trace range", { requested: traces, observed: observedTraces });
  const report = {
    schemaVersion: 1, kind: "m3-gate", buildId: build.buildId, status: "PASS", startedAt: now(), finishedAt: now(),
    scenarios: 23, tracesRequested: traces, executed: scenarios.length + stateMachine.summary.executed,
    assertions: scenarios.reduce((sum, item) => sum + item.assertions, 0) + stateMachine.summary.executed, skipped: 0,
    nonZeroRange: { scenarios: scenarios.length, traces: observedTraces, stateMachineTests: stateMachine.summary.executed },
    limitations: ["Only S is settled here; each required R/D result remains a separate direct observation."]
  };
  await writeJson(reportFile, report);
  return report;
}

async function validateSupportMatrix(file, expectedBuildId) {
  const matrixFile = workspacePath(file || path.join(ROOT, "docs", "runtime-support-matrix.md"), "support matrix");
  const text = await fs.readFile(matrixFile, "utf8");
  const missingScenarios = SCENARIO_IDS.filter((id) => !text.includes("| " + id + " |"));
  if (missingScenarios.length > 0) fail("support matrix is missing scenario rows", { missingScenarios });
  for (const provider of Object.keys(PROVIDERS)) {
    if (!new RegExp("\\|\\s*" + provider + "\\s*\\|", "i").test(text)) fail("support matrix is missing provider row", { provider });
  }
  if (!/Agent SDK/i.test(text) || !/unmodified(?: Claude Code)? CLI/i.test(text)) fail("support matrix must record the Claude CLI/Agent SDK boundary");
  const buildMarker = text.match(/Build ID:\s*([a-f0-9]{64})/i);
  if (buildMarker && buildMarker[1] !== expectedBuildId) fail("support matrix build ID is stale", { expected: expectedBuildId, observed: buildMarker[1] });
  return { file: relativeWorkspace(matrixFile), scenarioRows: SCENARIO_IDS.length, providers: Object.keys(PROVIDERS), buildId: buildMarker ? buildMarker[1] : null };
}

async function runM4(args, build) {
  const timeoutSeconds = seconds(args.timeout, 1200, "M4 timeout");
  const reportFile = args.report || path.join(DEFAULT_EVIDENCE_DIR, "m4.json");
  const providers = splitList(args.providers, Object.keys(PROVIDERS));
  if (providers.length !== 3 || new Set(providers).size !== 3) fail("M4 requires all three provider IDs");
  providers.forEach(assertKnownProvider);
  const matrix = await validateSupportMatrix(args["support-matrix"], build.buildId);
  const runtimeReports = [];
  for (const provider of providers) {
    const candidate = option(args, provider + "-report") || path.join(DEFAULT_EVIDENCE_DIR, "m0-" + provider + ".json");
    const report = await loadEvidence(candidate, build.buildId, provider + " Runtime evidence");
    if (!report.liveRequested) fail(provider + " Runtime report is preflight-only; M4 needs attempted live evidence");
    if (!Number.isInteger(report.nonZeroRange && report.nonZeroRange.casesAttempted) || report.nonZeroRange.casesAttempted < 8) fail(provider + " did not attempt all eight Runtime cases");
    runtimeReports.push({ provider, status: report.status, casesAttempted: report.nonZeroRange.casesAttempted });
  }
  const report = {
    schemaVersion: 1, kind: "m4-gate", buildId: build.buildId, status: "PASS", productLabel: "Preview", startedAt: now(), finishedAt: now(),
    providers: runtimeReports, supportMatrix: matrix,
    executed: runtimeReports.reduce((sum, item) => sum + item.casesAttempted, 0), assertions: runtimeReports.length, skipped: 0,
    nonZeroRange: { providers: runtimeReports.length, providerCases: runtimeReports.reduce((sum, item) => sum + item.casesAttempted, 0) },
    limitations: ["Stable remains ineligible until every provider and every required R/D layer has direct passing evidence."]
  };
  await writeJson(reportFile, report);
  return report;
}

async function scanForSecrets() {
  const files = [];
  for (const root of ["scripts", "tests", "docs", "src", "src-tauri", "crates"]) {
    const directory = path.join(ROOT, root);
    if (existsSync(directory)) await walkFiles(directory, files);
  }
  const findings = [];
  const secret = /(?:sk-[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+\/=-]{20,})/;
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    if (secret.test(text)) findings.push(relativeWorkspace(file));
  }
  return { files: files.length, findings };
}

async function runM5(args, build) {
  const timeoutSeconds = seconds(args.timeout, 1800, "M5 timeout");
  const reportFile = args.report || path.join(DEFAULT_EVIDENCE_DIR, "m5.json");
  const events = integer(args.events, 10000, "events", 1);
  const history = integer(args.history, 1000, "history", 1);
  const outputBytes = integer(args["output-bytes"], 16 * 1024 * 1024, "output-bytes", 1);
  const soakSeconds = integer(args["soak-seconds"], 600, "soak-seconds", 1);
  const security = await scanForSecrets();
  if (security.findings.length > 0) fail("diagnostic/source secret scan failed", security);
  const hardening = await runCargoTest("hardening", timeoutSeconds, {
    GOALPORT_HARDEN_EVENTS: String(events),
    GOALPORT_HARDEN_HISTORY: String(history),
    GOALPORT_HARDEN_OUTPUT_BYTES: String(outputBytes),
    GOALPORT_HARDEN_SOAK_SECONDS: String(soakSeconds)
  });
  requireNonZeroTests(hardening.summary, "M5 hardening tests", 1);
  if (hardening.result.exit !== 0 || hardening.result.timedOut) fail("M5 hardening test process failed");
  const output = hardening.result.stdoutText + "\n" + hardening.result.stderrText;
  const measuredSoak = Number((output.match(/wall[-_ ]?clock(?:_seconds| seconds)?(?:=|:|\\s+)(\\d+(?:\\.\\d+)?)/i) || [])[1] || 0);
  if (measuredSoak < soakSeconds) fail("M5 requires a measured real wall-clock soak; virtual configuration is not evidence", { requested: soakSeconds, observed: measuredSoak });
  const report = {
    schemaVersion: 1, kind: "m5-gate", buildId: build.buildId, status: "PASS", productLabel: "Preview", startedAt: now(), finishedAt: now(),
    security, requested: { events, history, outputBytes, soakSeconds }, observed: { wallClockSeconds: measuredSoak },
    executed: hardening.summary.executed, assertions: hardening.summary.executed, skipped: 0,
    nonZeroRange: { hardeningTests: hardening.summary.executed, events, history, outputBytes, wallClockSeconds: measuredSoak },
    limitations: ["Stable requires separate direct Desktop and Runtime evidence for all required scenario layers and all three providers."]
  };
  await writeJson(reportFile, report);
  return report;
}

function help() {
  console.log([
    "GoalPort verification",
    "",
    "Commands:",
    "  build-id       compute the current source/tool build identity",
    "  scenario       run exactly one declared S scenario through the Core CLI",
    "  runtime        preflight a native Runtime; add --live for synthetic execution",
    "  ipc            run the real ipc_lifecycle integration target",
    "  baseline-m1     run the real baseline_m1 integration target",
    "  m0 .. m5       execute the corresponding fail-closed milestone gate",
    "",
    "Every report is bound to the current build ID. Reports with zero/skipped",
    "tests, stale IDs, forbidden effects, unsupported Core output, or timeouts fail."
  ].join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args._[0] || "");
  if (!command || command === "help" || args.help) {
    help();
    return;
  }
  const build = await currentBuild(args);
  if (command === "build-id") {
    const output = option(args, "out", "report") || path.join(DEFAULT_EVIDENCE_DIR, "build-id.json");
    await writeJson(output, { schemaVersion: 1, kind: "build-id", ...build, computedAt: now(), host: os.platform() + "-" + os.arch() });
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId, fileCount: build.fileCount, output: relativeWorkspace(workspacePath(output, "report path")) }));
    return;
  }
  if (command === "scenario") {
    await runScenario(args, build);
    console.log(JSON.stringify({ status: "PASS", scenarioId: args.id, buildId: build.buildId }));
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
  if (command === "baseline-m1") {
    await runBaseline(args, build);
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId }));
    return;
  }
  if (command === "m0") {
    const timeoutSeconds = seconds(args.timeout, 1200, "M0 timeout");
    const providers = splitList(args.providers, Object.keys(PROVIDERS));
    const reports = [];
    for (const provider of providers) reports.push(await runRuntimeProbe(provider, { ...args, live: asBoolean(args.live), "total-timeout": Math.min(timeoutSeconds, 420), "case-timeout": Math.min(seconds(args["case-timeout"], 90, "case-timeout"), 90), cases: REQUIRED_M0_CASES.join(",") }, build));
    let ipc = null;
    try {
      ipc = await runIpc({ ...args, timeout: Math.min(timeoutSeconds, 120), report: path.join(DEFAULT_EVIDENCE_DIR, "m0-ipc.json") }, build);
    } catch (error) {
      ipc = { status: "FAIL", error: error.message };
    }
    const primaryCases = ["auth", "send", "approval", "resume", "native-config", "adapter-exit", "connection-owner"];
    const secondaryCases = ["auth", "send", "resume", "native-config", "adapter-exit", "connection-owner"];
    const statusMap = (report) => Object.fromEntries(report.cases.map((item) => [item.name, item.status]));
    const primaryEligible = reports.filter((report) => {
      const statuses = statusMap(report);
      const requiredPass = primaryCases.every((name) => statuses[name] === "PASS");
      const cancelGap = statuses.cancel === "PASS" || (statuses.cancel === "UNSUPPORTED" && report.liveRequested);
      return report.liveRequested && requiredPass && cancelGap;
    }).map((report) => report.provider);
    const secondaryEligible = reports.filter((report) => {
      const statuses = statusMap(report);
      return report.liveRequested && secondaryCases.every((name) => statuses[name] === "PASS");
    }).map((report) => report.provider);
    const secondary = secondaryEligible.find((provider) => !primaryEligible.includes(provider));
    const selected = primaryEligible.length > 0 && secondary && ipc && ipc.status === "PASS" ? { primary: primaryEligible[0], secondary } : null;
    const reportFile = args.report || path.join(DEFAULT_EVIDENCE_DIR, "m0-selection.json");
    const report = {
      schemaVersion: 1, kind: "m0-selection", buildId: build.buildId, status: selected ? "PASS" : "BLOCKED", productLabel: "Preview",
      startedAt: now(), finishedAt: now(), providers: reports, ipc, selected,
      executed: reports.reduce((sum, item) => sum + item.executed, 0) + (ipc ? ipc.executed || 0 : 0),
      assertions: reports.reduce((sum, item) => sum + item.assertions, 0) + (ipc ? ipc.assertions || 0 : 0),
      skipped: reports.reduce((sum, item) => sum + item.skipped, 0) + (ipc ? ipc.skipped || 0 : 0),
      nonZeroRange: { providerCases: reports.reduce((sum, item) => sum + item.nonZeroRange.casesAttempted, 0), ipcTests: ipc ? ipc.executed || 0 : 0 },
      limitations: selected ? [] : ["M0 selection is withheld until IPC and at least two live native capability reports pass; preflight cannot select a provider."]
    };
    await writeJson(reportFile, report);
    if (!selected) fail("M0 selection failed closed; no provider was promoted", { report: relativeWorkspace(workspacePath(reportFile, "report path")) });
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId, selected }));
    return;
  }
  if (command === "m1") {
    await runM1(args, build);
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId }));
    return;
  }
  if (command === "m2") {
    await runM2(args, build);
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId }));
    return;
  }
  if (command === "m3") {
    await runM3(args, build);
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId }));
    return;
  }
  if (command === "m4") {
    await runM4(args, build);
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId }));
    return;
  }
  if (command === "m5") {
    await runM5(args, build);
    console.log(JSON.stringify({ status: "PASS", buildId: build.buildId }));
    return;
  }
  fail("unknown verification command", { command });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const details = error instanceof VerificationError ? error.details : {};
    console.error(JSON.stringify({ status: "FAIL", error: error.message, details }));
    process.exitCode = 1;
  });
}
