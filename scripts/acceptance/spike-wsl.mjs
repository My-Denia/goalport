// GoalPort M0 spike (plan goalport-execute-and-native-acceptance, milestone M0).
//
// Question: can electron/main.cjs run as a REAL app (real Electron main process,
// real window, real Core over its Linux unix socket, real CDP drive) on this WSL
// host, without any real CLI or model call?
//
// Bounded attempt matrix, stop at first GO:
//   (a) plain  (b) --no-sandbox  (c) --no-sandbox --disable-gpu
//
// Per attempt: fresh isolated env (GOALPORT_REQUIRE_ISOLATED=1, run-owned DB,
// userData derived by main.cjs, absolute unix-socket pipe containing the run
// slug, fresh CDP port, hermetic HOME), codex+claude shadowed by run-owned
// refusal wrappers (exit 42, logged), GOALPORT_HARNESS_CHECKOUT /
// GOALPORT_HARNESS_SERVER_CWD removed from the child env so the local CLI
// runtime path applies. Assertions: CDP attach to a window titled GoalPort,
// bootstrap done, goalport:app-info resolves, goalport:core-snapshot round trip
// returns connection "connected" (unix-socket Core attach proof), one
// Page.captureScreenshot PNG. Quit cleanly, then stop only the processes this
// launch owned (matched by exact --pipe/--db argv) and remove this run's socket.
//
// Self-checking: exit 0 = GO, 3 = NO-GO, 2 = configuration/refusal error.
// Evidence: goal-runs/<slug>/evidence/m0-spike/report.json + per-attempt PNGs.
// Honesty labels: this is dev-mode Electron on WSLg. Packaged Windows EXE,
// native mouse/keyboard input and real-CLI behavior are NOT covered here.

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SLUG = "goalport-execute-and-native-acceptance";
const RUN_ROOT = resolve(ROOT, "goal-runs", SLUG);
const EVID = resolve(RUN_ROOT, "evidence");
const SPIKE = resolve(EVID, "m0-spike");
const STUB_BIN = resolve(SPIKE, "stub-bin");
const STUB_LOG = resolve(SPIKE, "stub-invocations.jsonl");
const FIXTURE_HOME = resolve(SPIKE, "fixtures", "home");
const SYNTHETIC_ROOT = resolve(RUN_ROOT, "fixtures", "synthetic-workspace");
const ELECTRON_BIN = resolve(ROOT, "node_modules", "electron", "dist", "electron");
const CORE_CANDIDATE = resolve(ROOT, "target", "debug", "goalport-core");
const REPORT_PATH = resolve(SPIKE, "report.json");

const ATTEMPT_DEADLINE_MS = 150_000;
const ATTACH_TIMEOUT_MS = 40_000;
const BOOTSTRAP_TIMEOUT_MS = 45_000;
const EXIT_WAIT_MS = 15_000;
const CORE_TERM_WAIT_MS = 6_000;
const STDERR_TAIL_BYTES = 8_000;

const MATRIX = [
  { name: "plain", flags: [] },
  { name: "no-sandbox", flags: ["--no-sandbox"] },
  { name: "no-sandbox-gpu", flags: ["--no-sandbox", "--disable-gpu"] },
];

const ATTEMPT_IDS = ["a", "b", "c"];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const tail = (text, bytes = STDERR_TAIL_BYTES) =>
  Buffer.from(text || "").subarray(Math.max(0, Buffer.byteLength(text || "") - bytes)).toString("utf8");

function fail(message, code = 2) {
  console.error(`spike-wsl: ${message}`);
  process.exit(code);
}

// ---- v1 isolation guards (reused unchanged, per plan D-A3) ----------------
// GOALPORT_RUN_SLUG must be set BEFORE importing v1-isolated-env.mjs so RUN_SLUG,
// EVID and FIX bind to this run instead of the module default.
process.env.GOALPORT_RUN_SLUG = SLUG;
const { assertIsolatedEnv, isolatedChildEnv } = await import(
  resolve(ROOT, "scripts", "connected", "v1-isolated-env.mjs")
);
const { attachGoalPort } = await import(resolve(ROOT, "scripts", "connected", "v1-cdp.mjs"));

// ---- run-owned refusal stubs (codex/claude shadowing) ---------------------
function stubWrapper(name) {
  return `#!/bin/sh
# GoalPort M0 spike refusal stub shadowing the real "${name}" CLI.
# It NEVER launches the real CLI and never touches the network: every
# invocation is logged and refused with exit 42.
log="\${GOALPORT_M0_STUB_LOG:-${STUB_LOG}}"
[ -d "\${log%/*}" ] || mkdir -p "\${log%/*}"
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
esc=$(printf '%s' "$*" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')
printf '{"ts":"%s","identity":"${name}","argv":"%s","refusal":"m0-spike-refusal-stub"}\\n' "$ts" "$esc" >> "$log" 2>/dev/null
echo "goalport-m0-refusal-stub(${name}): real CLI must never launch in the M0 spike; refusing" >&2
exit 42
`;
}

function materializeStubs() {
  mkdirSync(STUB_BIN, { recursive: true });
  for (const name of ["codex", "claude"]) {
    const wrapper = resolve(STUB_BIN, name);
    writeFileSync(wrapper, stubWrapper(name), { mode: 0o755 });
  }
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

// ---- /proc helpers (Linux) -------------------------------------------------
function procCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function findProcessesByArgv(predicate) {
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const argv = procCmdline(pid);
    if (argv && predicate(argv)) found.push({ pid, argv });
  }
  return found;
}

async function stopOwnedCoreProcesses(pipePath, dbPath) {
  const matches = findProcessesByArgv((argv) =>
    argv.some((arg, index) => arg === pipePath || (arg === "--pipe" && argv[index + 1] === pipePath))
    && argv.includes(dbPath));
  const record = { matchedPids: matches.map((item) => item.pid), actions: [], verifiedStopped: false };
  for (const item of matches) {
    try { process.kill(item.pid, "SIGTERM"); record.actions.push({ pid: item.pid, signal: "SIGTERM" }); }
    catch (error) { record.actions.push({ pid: item.pid, error: String(error.message || error) }); }
  }
  const deadline = Date.now() + CORE_TERM_WAIT_MS;
  let remaining = matches.map((item) => item.pid);
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(200);
    remaining = remaining.filter((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
  }
  for (const pid of remaining) {
    try { process.kill(pid, "SIGKILL"); record.actions.push({ pid, signal: "SIGKILL" }); }
    catch (error) { record.actions.push({ pid, error: String(error.message || error) }); }
  }
  await sleep(300);
  record.verifiedStopped = matches.every((item) => {
    try { process.kill(item.pid, 0); return false; } catch { return true; }
  });
  try { unlinkSync(pipePath); record.socketRemoved = pipePath; } catch { /* absent already */ }
  return record;
}

function cleanupElectronGroup(child) {
  const record = { electronPid: child.pid, actions: [] };
  try { process.kill(-child.pid, "SIGTERM"); record.actions.push("SIGTERM process group"); }
  catch { try { child.kill("SIGTERM"); record.actions.push("SIGTERM child"); } catch { /* gone */ } }
  return record;
}

// ---- environment assembly --------------------------------------------------
function buildChildEnv(attemptId, pipePath, dbPath, cdpPort) {
  // The driver's own env carries the three isolation anchors so the real
  // assertIsolatedEnv guards validate them; isolatedChildEnv then passes the
  // assembled env to the child unchanged in structure.
  process.env.GOALPORT_REQUIRE_ISOLATED = "1";
  process.env.GOALPORT_CORE_PIPE = pipePath;
  process.env.GOALPORT_CORE_DB = dbPath;
  process.env.GOALPORT_SYNTHETIC_ROOT = SYNTHETIC_ROOT;
  assertIsolatedEnv({ argv: [] }); // throws on preserve-slug or out-of-run paths
  const env = isolatedChildEnv({
    GOALPORT_CORE_PIPE: pipePath,
    GOALPORT_CORE_DB: dbPath,
    GOALPORT_CDP_PORT: String(cdpPort),
    GOALPORT_HARNESS_STATE_DIR: resolve(SPIKE, "attempts", attemptId, "harness-state"),
    HOME: FIXTURE_HOME,
    PATH: `${STUB_BIN}:${process.env.PATH || ""}`,
    GOALPORT_M0_STUB_LOG: STUB_LOG,
  });
  // Inherit no remote harness checkout/server cwd (plan D-A5(2)); never let the
  // send gate or a run-as-node switch leak into this run.
  delete env.GOALPORT_HARNESS_CHECKOUT;
  delete env.GOALPORT_HARNESS_SERVER_CWD;
  delete env.GOALPORT_COORDINATE_SEND;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function selectedEnvView(env) {
  const pathEntries = String(env.PATH || "").split(":");
  return {
    GOALPORT_RUN_SLUG: env.GOALPORT_RUN_SLUG,
    GOALPORT_REQUIRE_ISOLATED: env.GOALPORT_REQUIRE_ISOLATED,
    GOALPORT_CORE_PIPE: env.GOALPORT_CORE_PIPE,
    GOALPORT_CORE_DB: env.GOALPORT_CORE_DB,
    GOALPORT_SYNTHETIC_ROOT: env.GOALPORT_SYNTHETIC_ROOT,
    GOALPORT_CDP_PORT: env.GOALPORT_CDP_PORT,
    GOALPORT_HARNESS_STATE_DIR: env.GOALPORT_HARNESS_STATE_DIR,
    GOALPORT_HARNESS_CHECKOUT: env.GOALPORT_HARNESS_CHECKOUT ?? null,
    GOALPORT_HARNESS_SERVER_CWD: env.GOALPORT_HARNESS_SERVER_CWD ?? null,
    GOALPORT_COORDINATE_SEND: env.GOALPORT_COORDINATE_SEND ?? null,
    ELECTRON_RUN_AS_NODE: env.ELECTRON_RUN_AS_NODE ?? null,
    GOALPORT_M0_STUB_LOG: env.GOALPORT_M0_STUB_LOG,
    HOME: env.HOME,
    PATH_HEAD: pathEntries.slice(0, 3),
    PATH_ENTRY_COUNT: pathEntries.length,
    DISPLAY: env.DISPLAY ?? null,
    WAYLAND_DISPLAY: env.WAYLAND_DISPLAY ?? null,
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? null,
  };
}

// ---- preflight --------------------------------------------------------------
function preflight(childEnv) {
  const notes = {};
  if (!existsSync(ELECTRON_BIN)) fail(`Electron dev binary missing: ${ELECTRON_BIN}`);
  if (!existsSync(CORE_CANDIDATE)) fail(`Core binary missing: ${CORE_CANDIDATE}`);
  const distIndex = resolve(ROOT, "dist", "index.html");
  if (!existsSync(distIndex)) fail("dist/index.html missing; run pnpm build first");
  const distMtime = statSync(distIndex).mtimeMs;
  const newerSources = [];
  for (const base of ["src", "index.html", "vite.config.ts", "package.json"]) {
    const full = resolve(ROOT, base);
    const stat = statSync(full);
    if (stat.isFile() && stat.mtimeMs > distMtime) newerSources.push(base);
    if (stat.isDirectory()) {
      const stack = [full];
      while (stack.length > 0 && newerSources.length < 20) {
        const dir = stack.pop();
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          const child = resolve(dir, entry.name);
          if (entry.isDirectory()) stack.push(child);
          else if (statSync(child).mtimeMs > distMtime) newerSources.push(child.slice(ROOT.length + 1));
        }
      }
    }
  }
  notes.distFresh = newerSources.length === 0;
  notes.distNewerThanSources = !notes.distFresh;
  notes.newerSources = newerSources.slice(0, 20);
  notes.buildRunBySpike = false; // recorded baseline build (exit 0) is reused when fresh

  // Real CLI locations WITHOUT the stub dir: recorded as present-but-shadowed.
  const hostResolve = spawnSync("/bin/sh", ["-c", "command -v codex; command -v claude"], { encoding: "utf8" });
  const [realCodex, realClaude] = String(hostResolve.stdout || "").split("\n").filter(Boolean);
  notes.realCliLocations = { codex: realCodex || null, claude: realClaude || null, executed: false };

  // Child PATH resolution must land inside the stub dir for BOTH names.
  // `command -v` only resolves names; it never executes them.
  const childResolve = spawnSync("/bin/sh", ["-c", "command -v codex; command -v claude"], {
    env: childEnv, encoding: "utf8",
  });
  const [childCodex, childClaude] = String(childResolve.stdout || "").split("\n").filter(Boolean);
  notes.childResolution = { codex: childCodex || null, claude: childClaude || null };
  notes.childResolutionInsideStubDir = Boolean(
    childCodex && childClaude
    && childCodex.startsWith(STUB_BIN) && childClaude.startsWith(STUB_BIN)
  );
  notes.pipeByteLength = Buffer.byteLength(childEnv.GOALPORT_CORE_PIPE);
  notes.pipeWithinSunPath = notes.pipeByteLength <= 107;
  return notes;
}

// ---- one bounded attempt ----------------------------------------------------
async function runAttempt(attempt) {
  const startedAt = new Date().toISOString();
  const attemptDir = resolve(SPIKE, "attempts", attempt.id);
  await rm(attemptDir, { recursive: true, force: true });
  mkdirSync(attemptDir, { recursive: true });
  mkdirSync(FIXTURE_HOME, { recursive: true });
  mkdirSync(SYNTHETIC_ROOT, { recursive: true });

  const pipePath = resolve(tmpdir(), `${SLUG}-m0-${attempt.id}.sock`);
  const dbPath = resolve(attemptDir, "core.sqlite");
  const cdpPort = await freePort();
  const childEnv = buildChildEnv(attempt.id, pipePath, dbPath, cdpPort);

  const record = {
    id: attempt.id,
    name: attempt.name,
    flags: attempt.flags,
    argv: ["node_modules/electron/dist/electron", ".", ...attempt.flags],
    cdpPort,
    pipe: pipePath,
    pipeByteLength: Buffer.byteLength(pipePath),
    db: dbPath,
    syntheticRoot: SYNTHETIC_ROOT,
    hermeticHome: FIXTURE_HOME,
    selectedEnv: selectedEnvView(childEnv),
    preflight: null,
    launchedAtUtc: startedAt,
    stderrTail: "",
    stdoutTail: "",
    exit: null,
    attach: null,
    assertions: {},
    screenshot: null,
    appInfo: null,
    coreProcess: null,
    cleanup: {},
    verdict: "NO-GO",
    failure: null,
  };

  const pf = preflight(childEnv);
  record.preflight = pf;
  if (!pf.childResolutionInsideStubDir) {
    record.failure = "preflight: child PATH does not resolve codex+claude inside the run-owned stub dir";
    return record;
  }
  if (!pf.pipeWithinSunPath) {
    record.failure = `preflight: pipe path exceeds 107 sun_path bytes (${pf.pipeByteLength})`;
    return record;
  }

  const deadline = Date.now() + ATTEMPT_DEADLINE_MS;
  let stderrText = "";
  let stdoutText = "";
  const child = spawn(ELECTRON_BIN, [".", ...attempt.flags], {
    cwd: ROOT,
    detached: true, // own process group; cleanup targets exactly this group
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdoutText = (stdoutText + chunk).slice(-STDERR_TAIL_BYTES); });
  child.stderr.on("data", (chunk) => { stderrText = (stderrText + chunk).slice(-STDERR_TAIL_BYTES); });

  let exited = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
  try {
    // 1) CDP attach to the real window (title must contain "GoalPort").
    const attached = await attachGoalPort(cdpPort, {
      connectTimeoutMs: 10_000,
      requestTimeoutMs: 20_000,
    });
    record.attach = {
      pageUrl: attached.page.url,
      pageTitle: attached.page.title,
      titleContainsGoalPort: String(attached.page.title || "").includes("GoalPort"),
    };
    record.assertions.cdpAttach = true;
    record.assertions.windowTitle = record.attach.titleContainsGoalPort;
    await attached.cdp("Page.enable");

    const remaining = () => Math.max(0, deadline - Date.now());
    const evaluateWithTimeout = async (expression, label, timeoutMs) => {
      let timer;
      const timeout = new Promise((_, rejectReject) => {
        timer = setTimeout(() => rejectReject(new Error(`${label} timed out after ${timeoutMs}ms`)), Math.min(timeoutMs, remaining() + 1));
      });
      return Promise.race([attached.evaluate(expression, true), timeout]).finally(() => clearTimeout(timer));
    };

    // 2) Bootstrap done (legacy isolated branch pushes phase "done" after Core attach).
    const bootstrapDeadline = Date.now() + Math.min(BOOTSTRAP_TIMEOUT_MS, remaining());
    let bootstrap = null;
    while (Date.now() < bootstrapDeadline) {
      try {
        bootstrap = await evaluateWithTimeout("window.goalportCore.bootstrapCurrent()", "bootstrapCurrent", 5_000);
        if (bootstrap && bootstrap.phase === "done") break;
      } catch { /* renderer not ready yet */ }
      await sleep(300);
    }
    record.assertions.bootstrapDone = Boolean(bootstrap && bootstrap.phase === "done");
    record.bootstrapState = bootstrap ? { phase: bootstrap.phase, kind: bootstrap.kind ?? null } : null;
    if (!record.assertions.bootstrapDone) throw new Error(`bootstrap did not reach done (last: ${JSON.stringify(bootstrap)})`);

    // 3) Isolation marker set by main.cjs in isolated mode.
    const isolatedMarker = await evaluateWithTimeout("window.__GOALPORT_ISOLATED", "isolated marker", 5_000);
    record.assertions.isolatedMarker = isolatedMarker === 1;

    // 4) Actual appInfo via the real preload API.
    const appInfo = await evaluateWithTimeout("window.goalportCore.appInfo()", "appInfo", 10_000);
    record.appInfo = appInfo;
    record.assertions.appInfoResolved = Boolean(appInfo && appInfo.version);
    record.assertions.appInfoDataPathRunOwned = Boolean(
      appInfo && typeof appInfo.dataPath === "string" && appInfo.dataPath.startsWith(attemptDir)
    );

    // 5) goalport:core-snapshot round trip — proves the unix-socket Core attach.
    const snapshot = await evaluateWithTimeout("window.goalportCore.snapshot()", "core snapshot", 30_000);
    record.snapshotSummary = snapshot ? {
      connection: snapshot.connection ?? null,
      protocolVersion: snapshot.protocolVersion ?? null,
      buildId: snapshot.buildId ?? null,
    } : null;
    record.assertions.coreSnapshotConnected = Boolean(
      snapshot && snapshot.connection === "connected" && snapshot.protocolVersion === "goalport.ipc.v2"
    );

    // 6) One real rendered-window PNG.
    await sleep(700);
    const shot = await evaluateWithTimeout("true", "noop", 1_000); // keep-alive sanity
    void shot;
    const shotResult = await attached.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const png = Buffer.from(shotResult.data, "base64");
    const shotPath = resolve(SPIKE, `m0-window-${attempt.id}-${attempt.name}.png`);
    writeFileSync(shotPath, png);
    record.screenshot = {
      path: shotPath.slice(ROOT.length + 1),
      bytes: png.length,
      sha256: sha256(png),
      width: png.length > 24 ? png.readUInt32BE(16) : 0,
      height: png.length > 24 ? png.readUInt32BE(20) : 0,
    };
    record.assertions.screenshotCaptured = png.length > 10_000 && png.subarray(0, 4).toString("latin1") === "\x89PNG";

    // 7) Identify the Core process this launch owns (exact pipe+db argv match).
    await sleep(150);
    const coreMatches = findProcessesByArgv((argv) =>
      argv.includes("--pipe") && argv.includes(pipePath) && argv.includes(dbPath));
    record.coreProcess = {
      count: coreMatches.length,
      processes: coreMatches.map((item) => ({ pid: item.pid, executable: basename(item.argv[0] || "") })),
    };

    // 8) Quit cleanly through the product's own close path.
    await evaluateWithTimeout("window.goalportCore.requestClose()", "requestClose", 5_000).catch(() => {});
    const exitDeadline = Date.now() + EXIT_WAIT_MS;
    let result = await Promise.race([exited, sleep(EXIT_WAIT_MS).then(() => null)]);
    if (!result) {
      record.cleanup.electron = cleanupElectronGroup(child);
      result = await Promise.race([exited, sleep(5_000).then(() => null)]);
      if (!result) {
        try { process.kill(-child.pid, "SIGKILL"); record.cleanup.electron.actions.push("SIGKILL process group"); } catch { /* gone */ }
        result = await Promise.race([exited, sleep(3_000).then(() => null)]);
      }
      record.cleanup.electronForced = true;
    }
    record.exit = result ? { code: result.code, signal: result.signal } : { code: null, signal: null, stillRunning: true };
    record.assertions.cleanQuit = Boolean(result && result.code === 0);
    try { attached.close(); } catch { /* ws already closed by quit */ }

    record.verdict = Object.values(record.assertions).every(Boolean) ? "GO" : "NO-GO";
    if (record.verdict === "NO-GO" && !record.failure) {
      const failedOnes = Object.entries(record.assertions).filter(([, ok]) => !ok).map(([key]) => key);
      record.failure = `failed assertions: ${failedOnes.join(", ")}`;
    }
  } catch (error) {
    record.failure = String(error?.message || error);
    record.verdict = "NO-GO";
    // The window may never have existed; still stop the attempt's processes.
    record.cleanup.electron = cleanupElectronGroup(child);
    const result = await Promise.race([exited, sleep(5_000).then(() => null)]);
    record.exit = result ? { code: result.code, signal: result.signal } : { code: null, signal: null, stillRunning: true };
  }

  record.stderrTail = tail(stderrText);
  record.stdoutTail = tail(stdoutText);

  // Owned-process cleanup: only processes matched by this attempt's exact
  // --pipe/--db argv; unrelated Core processes are never touched.
  try {
    record.cleanup.core = await stopOwnedCoreProcesses(pipePath, dbPath);
  } catch (error) {
    record.cleanup.core = { error: String(error.message || error) };
  }
  record.endedAtUtc = new Date().toISOString();
  record.durationMs = Date.parse(record.endedAtUtc) - Date.parse(startedAt);
  return record;
}

// ---- main -------------------------------------------------------------------
function writeReport(report) {
  mkdirSync(SPIKE, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

function stubInvocationSummary() {
  try {
    const text = readFileSync(STUB_LOG, "utf8").trim();
    return { count: text ? text.split("\n").length : 0, entries: text ? text.split("\n").slice(0, 20) : [] };
  } catch {
    return { count: 0, entries: [] };
  }
}

const onlyIndex = process.argv.indexOf("--only");
const onlyName = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;

mkdirSync(SPIKE, { recursive: true });
materializeStubs();

const statusBefore = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
const headBefore = spawnSync("git", ["log", "-1", "--format=%H"], { cwd: ROOT, encoding: "utf8" });

const report = {
  schemaVersion: 1,
  kind: "goalport-m0-wsl-spike",
  slug: SLUG,
  head: String(headBefore.stdout || "").trim(),
  trackedStatusCleanBeforeRun: String(statusBefore.stdout || "").trim() === "",
  spikeScript: "scripts/acceptance/spike-wsl.mjs (new in this M0 execution; absent at HEAD 747d4e2)",
  evidenceNote: "goal-runs/<slug>/evidence/m0-spike/* are run-owned, untracked evidence files",
  generatedAtUtc: new Date().toISOString(),
  baselineAuthority: "goal-runs/goalport-execute-and-native-acceptance/evidence/m0-baseline-summary.txt (HEAD 747d4e2; reused, no rebuild)",
  honestyLabels: [
    "dev-mode Electron on WSLg, not the packaged product",
    "Windows packaged-EXE acceptance, native mouse/keyboard input, and real CLI/model behavior remain untested here",
  ],
  attempts: [],
  stubInvocationsAfterRun: null,
  verdict: "NO-GO",
  goAttempt: null,
};

let overallPass = false;
try {
  const planned = onlyName ? MATRIX.filter((item) => item.name === onlyName) : MATRIX;
  if (planned.length === 0) fail(`unknown --only attempt: ${onlyName}`);
  for (const [index, item] of planned.entries()) {
    const attempt = { ...item, id: ATTEMPT_IDS[MATRIX.indexOf(item)] ?? ATTEMPT_IDS[index] };
    if (!onlyName) {
      const prior = report.attempts.find((entry) => entry.verdict === "GO");
      if (prior) break; // stop at first GO
    }
    console.error(`spike-wsl: attempt ${attempt.id} (${attempt.name}) launching...`);
    const record = await runAttempt(attempt);
    report.attempts.push(record);
    writeReport(report); // retain exact attempt evidence incrementally
    console.error(`spike-wsl: attempt ${attempt.id} (${attempt.name}) -> ${record.verdict}${record.failure ? ` (${record.failure})` : ""}`);
    if (record.verdict === "GO") { overallPass = true; break; }
  }
} finally {
  report.stubInvocationsAfterRun = stubInvocationSummary();
  const go = report.attempts.find((entry) => entry.verdict === "GO");
  report.verdict = go ? "GO" : "NO-GO";
  report.goAttempt = go ? go.name : null;
  report.completedAtUtc = new Date().toISOString();
  writeReport(report);
  const after = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  report.trackedStatusAfterRun = String(after.stdout || "").trim() === ""
    ? "clean (spike script is untracked-new; evidence is gitignored)"
    : String(after.stdout || "").trim().split("\n").slice(0, 10);
  writeReport(report);
  console.error(`spike-wsl: verdict ${report.verdict}${go ? ` via ${go.name}` : ""}; report ${REPORT_PATH.slice(ROOT.length + 1)}`);
  const anyCoreLeft = report.attempts.some((entry) => entry.cleanup?.core && entry.cleanup.core.verifiedStopped === false);
  process.exitCode = overallPass ? 0 : 3;
  if (anyCoreLeft) console.error("spike-wsl: WARNING an owned Core process did not confirm exit; inspect report cleanup records");
}
