const { app, BrowserWindow, ipcMain, Notification, screen, shell, dialog } = require("electron");
const { spawn, execFile } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");
const { createTrustedIpcHandler, protectRenderer } = require("./security-policy.cjs");
const { launchArguments, relaunchArguments, resolveProfilePaths, assertProfileStorageBoundary, validateProfileIdentity, assertCoreIdentity, childEnvironment, assertPipePeer, pipePeerBusy } = require("./launch-config.cjs");
const { ProfileManager } = require("./profile-manager.cjs");
const { invokeCoreRequest, acknowledgedStopSnapshot, verifyCoreServer, createCoreGate } = require("./core-client.cjs");
const { loadWindowState, saveWindowState, STATE_FILE } = require("./window-state.cjs");

const appRoot = fs.existsSync(path.join(__dirname, "dist")) ? __dirname : path.join(__dirname, "..");
function reportStartupFailure(error) {
  console.error("GoalPort startup refused:", error);
  dialog.showErrorBox("GoalPort could not start", String(error.message || error));
  app.exit(1);
}

// Build identity: distribution separates the release channel from development
// candidates. Packaged apps read it from build-info.json (inside the asar);
// an unpackaged run is `dev`. A packaged app without build-info falls back to
// `release` (the historical behavior; verify-package flags such a package).
function readBuildInfo() {
  for (const candidate of [path.join(__dirname, "build-info.json"), path.join(appRoot, "build-info.json")]) {
    try { return JSON.parse(fs.readFileSync(candidate, "utf8")); } catch { /* absent or unreadable */ }
  }
  return null;
}
function resolveChannel() {
  if (!app.isPackaged) return "dev";
  const info = readBuildInfo();
  return info?.distribution === "dev-candidate" ? "dev-candidate" : "release";
}
function channelLabel(channel) {
  if (channel === "release") return "RC";
  if (channel === "dev-candidate") return "Dev candidate";
  return "Dev";
}

// The standard Chromium switch relocates the application-data ROOT (profiles
// live under <dir>/GoalPort/<channel>). This is a real product feature for
// redirected/portable homes, not a test hook: the full default profile
// selection (channel namespace, discovery, compatibility) keeps running inside
// the relocated root. Windows known-folder resolution ignores the APPDATA
// environment variable, so this switch is the supported way to relocate.
function appDataRoot(argv, electronAppData) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === "--user-data-dir" && argv[index + 1] && path.isAbsolute(argv[index + 1])) return path.resolve(argv[index + 1]);
    if (arg.startsWith("--user-data-dir=")) {
      const value = arg.slice("--user-data-dir=".length);
      if (value && path.isAbsolute(value)) return path.resolve(value);
    }
  }
  return electronAppData;
}

let appVersion, profile, profileManager, launchChannel;
let selectedCoreBinary, selectedLauncherBinary;
let legacyIsolated = false;
try {
  const launchArgs = launchArguments(process.argv);
  legacyIsolated = process.env.GOALPORT_REQUIRE_ISOLATED === "1" && !launchArgs["--data-dir"] && !launchArgs["--test-profile"];
  // Resolve before sanitizing launch variables. Hashing one executable then
  // selecting another after scrub breaks dev startup's identity contract.
  selectedCoreBinary = resolveCoreBinary();
  selectedLauncherBinary = resolveLauncherBinary();
  appVersion = app.isPackaged ? app.getVersion() : JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
  launchChannel = legacyIsolated ? null : resolveChannel();
  profile = legacyIsolated ? null : resolveProfilePaths({
    args: launchArgs, appData: appDataRoot(process.argv, app.getPath("appData")), channel: launchChannel,
    coreSha256: fileSha256(coreBinary() || "")
  });
  if (profile) {
    // Storage-boundary startup sequence: Electron/Chromium userData points at
    // the BROWSER-STATE namespace, a directory physically separate from the
    // durable profile root and derived from the durable identity only. The
    // durable root is NEVER created or written pre-ready — Chromium therefore
    // cannot put anything into it, and "is this a fresh durable profile" can
    // no longer race with transient session files. Nothing else is decided
    // here: every compatibility/ownership decision happens in the post-ready
    // bootstrap with a real window on screen, against the durable root only.
    assertProfileStorageBoundary(profile);
    fs.mkdirSync(profile.browserStateDirectory, { recursive: true });
    assertProfileStorageBoundary(profile);
    // Chromium itself needs a writable userData; probe now so an unwritable
    // browser-state directory produces an honest refusal instead of a silent
    // exit. (Durable-root writability is NOT probed here: the bootstrap's
    // classifyFsError reports an unwritable durable location honestly once a
    // window exists.)
    {
      const probe = path.join(profile.browserStateDirectory, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, "writable-probe");
      fs.rmSync(probe, { force: true });
    }
    app.setPath("userData", profile.browserStateDirectory);
    profileManager = new ProfileManager({
      directory: profile.durableDirectory,
      appData: appDataRoot(process.argv, app.getPath("appData")),
      build: {
        version: appVersion,
        distribution: app.isPackaged ? launchChannel : "dev",
        channel: profile.channel,
        coreSha256: profile.coreSha256,
        mode: profile.mode,
        profileKey: profile.profileKey
      },
      deps: { execCore: runTracedCoreProfileCommand, log: (line) => console.log(`[profile] ${line}`) }
    });
    const env = childEnvironment(process.env, profile);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GOALPORT_") && !(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
  }
} catch (error) {
  reportStartupFailure(error);
  return;
}

const RUN_SLUG = profile?.slug || process.env.GOALPORT_RUN_SLUG || "goalport-electron-rc-resume-chain";
const PRESERVE_SLUGS = [
  "goalport-connected-dual-desktop",
  "goalport-electron-stable-v1",
  "goalport-stable-v1-closure",
  "goalport-evidence-verifier-core-restart",
  "goalport-grok-native-admission",
  "goalport-resume-chain-collect-b",
  "goalport-claude-native-control-admission",
  "goalport-claude-live-deny-admission",
  "goalport-claude-deny-fail-open-admission",
  "goalport-claude-notice-stop-dup-admission"
];

function isolatedRequired() {
  return process.env.GOALPORT_REQUIRE_ISOLATED === "1";
}

function pipeBareName(raw) {
  const name = String(raw || "");
  const prefix = "\\\\.\\pipe\\";
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function isThisRunIsolatedPipe(raw) {
  const name = String(raw || "");
  const bare = pipeBareName(name);
  if (!bare || bare === "goalport-core-v1") return false;
  return bare.includes(RUN_SLUG) || name.includes(RUN_SLUG);
}

function containsPreserveSlug(value) {
  const n = String(value || "").replaceAll("/", "\\").toLowerCase();
  return PRESERVE_SLUGS.some((slug) => n.includes(slug.toLowerCase()));
}

function containedUnder(candidate, parent) {
  const resolved = path.resolve(candidate);
  const root = path.resolve(parent);
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function thisRunRoot(resolvedPath) {
  const parts = path.resolve(resolvedPath).split(/[\\/]/);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === "goal-runs" && parts[index + 1] === RUN_SLUG) {
      return parts.slice(0, index + 2).join(path.sep);
    }
  }
  return null;
}

function assertIsolatedLaunch() {
  if (profile) return; // Profile ownership, mode and component identity were checked above.
  if (!isolatedRequired()) return;
  const db = process.env.GOALPORT_CORE_DB;
  const pipe = process.env.GOALPORT_CORE_PIPE;
  const synthetic = process.env.GOALPORT_SYNTHETIC_ROOT;
  if (!db || !pipe || !synthetic) {
    console.error("GOALPORT_REQUIRE_ISOLATED=1 requires GOALPORT_CORE_PIPE, GOALPORT_CORE_DB, GOALPORT_SYNTHETIC_ROOT");
    app.exit(2);
    return;
  }
  if (!isThisRunIsolatedPipe(pipe)) {
    console.error(`isolated Electron refused non this-run Core pipe: ${pipe}`);
    app.exit(2);
    return;
  }
  const resolvedDb = path.resolve(db);
  if (containsPreserveSlug(resolvedDb)) {
    console.error(`isolated Electron refused preserved-run DB: ${resolvedDb}`);
    app.exit(2);
    return;
  }
  const runRoot = thisRunRoot(resolvedDb);
  if (!runRoot || !containedUnder(resolvedDb, runRoot)) {
    console.error(`isolated Electron DB is outside this-run folder: ${resolvedDb}`);
    app.exit(2);
    return;
  }
  const isolatedUserData = path.join(path.dirname(resolvedDb), "electron-userData");
  if (!containedUnder(isolatedUserData, runRoot)) {
    console.error(`isolated userData would escape this-run folder: ${isolatedUserData}`);
    app.exit(2);
    return;
  }
  fs.mkdirSync(isolatedUserData, { recursive: true });
  app.setPath("userData", isolatedUserData);
}

assertIsolatedLaunch();
if (process.env.GOALPORT_CDP_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", String(process.env.GOALPORT_CDP_PORT));
}
app.setAppUserModelId("GoalPort.Desktop");

const configuredPipeName = profile?.pipe || (isolatedRequired()
  ? (process.env.GOALPORT_CORE_PIPE || `${RUN_SLUG}-missing-pipe`)
  : (process.env.GOALPORT_CORE_PIPE || "goalport-core-v1"));
const PIPE_NAME = configuredPipeName.startsWith("\\\\.\\pipe\\")
  ? configuredPipeName
  : `\\\\.\\pipe\\${configuredPipeName}`;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
let mainWindow;
const appDocumentUrl = pathToFileURL(path.join(appRoot, "dist", "index.html")).href;
const handleTrusted = createTrustedIpcHandler(ipcMain, () => mainWindow, appDocumentUrl);
if (process.env.GOALPORT_ALLOW_MULTI_INSTANCE !== "1") {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.exit(0);
  } else {
    app.on("second-instance", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  }
}
let coreChild;
let coreLaunchPromise;
let allowQuitAfterCloseChoice = false;
let closePromptOpen = false;
let lastAttemptActive = false;
let lastProjectionUnavailable = false;
let lastAttemptId = "";
let lastAttemptProvider = "";
let lastStopResponsibilityHeld = false;
let lastHeldAttemptId = "";
let lastCampaignId = "";
let lastLaunchNonce = "";

function fileSha256(target) {
  try {
    return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  } catch {
    return "";
  }
}

function isoNow() {
  return new Date().toISOString();
}

let cachedElectronIdentity;

function electronIdentity() {
  if (cachedElectronIdentity) return cachedElectronIdentity;
  const exe = app.getPath("exe") || process.execPath;
  const createdMs = Math.floor(Number(performance.timeOrigin) || Date.now());
  cachedElectronIdentity = {
    pid: process.pid,
    createdMs,
    creationDate: `/Date(${createdMs})/`,
    executablePath: exe,
    executableSha256: fs.existsSync(exe) ? fileSha256(exe) : ""
  };
  return cachedElectronIdentity;
}

function normalizeClosePayload(payload) {
  if (typeof payload === "string") {
    return { choice: payload, requestId: randomUUID() };
  }
  const choice = String(payload?.choice || "");
  const requestId = String(payload?.requestId || randomUUID());
  return {
    choice,
    requestId,
    continueClickIssuedAtUtc: payload?.continueClickIssuedAtUtc ? String(payload.continueClickIssuedAtUtc) : undefined,
    uiPid: payload?.uiPid,
    uiCreatedMs: payload?.uiCreatedMs
  };
}

function coreBinary() {
  return selectedCoreBinary;
}
function resolveCoreBinary() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "goalport-core.exe");
    return fs.existsSync(bundled) ? bundled : undefined;
  }
  const configured = process.env.GOALPORT_CORE_BIN;
  if (configured) return configured;
  const candidates = [
    path.join(process.resourcesPath, "goalport-core.exe"),
    path.join(appRoot, "target", "release", "goalport-core.exe"),
    path.join(appRoot, "target", "debug", "goalport-core.exe")
  ];
  return candidates.find((candidate) => require("node:fs").existsSync(candidate));
}

function launcherBinary() {
  return selectedLauncherBinary;
}
function resolveLauncherBinary() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "goalport-core-launcher.exe");
    return fs.existsSync(bundled) ? bundled : undefined;
  }
  const configured = process.env.GOALPORT_CORE_LAUNCHER_BIN;
  if (configured) return configured;
  const candidates = [
    path.join(process.resourcesPath, "goalport-core-launcher.exe"),
    path.join(appRoot, "target", "release", "goalport-core-launcher.exe"),
    path.join(appRoot, "target", "debug", "goalport-core-launcher.exe")
  ];
  return candidates.find((candidate) => require("node:fs").existsSync(candidate));
}

function dbPath() {
  if (profile) return profile.database;
  if (isolatedRequired()) {
    if (!process.env.GOALPORT_CORE_DB) {
      throw new Error("isolated Electron refused app.getPath(userData) SQLite");
    }
    return process.env.GOALPORT_CORE_DB;
  }
  return process.env.GOALPORT_CORE_DB || path.join(app.getPath("userData"), "goalport.sqlite");
}

function showToast(title, body) {
  if (!Notification.isSupported()) return false;
  new Notification({ title, body }).show();
  return true;
}

function pipeAvailable() {
  return new Promise((resolve) => {
    const socket = net.createConnection(PIPE_NAME);
    const finish = (available) => { socket.destroy(); resolve(available); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(100, () => finish(false));
  });
}

// The profile bootstrap owns the decision whether this build may open the
// data at all; the renderer's snapshot polling must not spawn a Core before
// that decision is made (in the old pre-ready-marker architecture this could
// not happen because the profile was settled before any window existed).
let profileReady = false;

async function ensureCore() {
  if (!profile && isolatedRequired() && !isThisRunIsolatedPipe(process.env.GOALPORT_CORE_PIPE || configuredPipeName)) {
    throw new Error(`isolated Electron refused to attach to non this-run pipe: ${process.env.GOALPORT_CORE_PIPE || configuredPipeName}`);
  }
  if (profileManager && !profileReady) {
    throw new Error("GoalPort is still preparing this data profile; Core start is gated");
  }
  if (await pipeAvailable()) return coreGate.verify();
  if (coreLaunchPromise) return coreLaunchPromise;
  if (lastLaunchNonce) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await pipeAvailable()) return coreGate.verify();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Lifecycle-independent Core pipe disappeared; refusing to spawn a second Core");
  }
  const binary = coreBinary();
  if (!binary) throw new Error("GoalPort Core binary is missing; build goalport-core before launching Electron");
  coreLaunchPromise = (async () => {
    const launcher = launcherBinary();
    if (app.isPackaged && !launcher) throw new Error("The packaged Core launcher is missing; verify or rebuild the complete RC package");
    const command = launcher || binary;
    const commandArgs = launcher
      ? [binary, "serve", "--pipe", PIPE_NAME, "--db", dbPath()]
      : ["serve", "--pipe", PIPE_NAME, "--db", dbPath()];
    const launchNonce = randomUUID();
    lastLaunchNonce = launchNonce;
    const identity = electronIdentity();
    const launchRequestedAt = isoNow();
    const childEnv = {
      ...childEnvironment(process.env, profile),
      GOALPORT_CORE_BIN: binary,
      GOALPORT_LAUNCH_NONCE: launchNonce,
      GOALPORT_RUN_SLUG: RUN_SLUG,
      GOALPORT_LAUNCH_REQUESTED_AT: launchRequestedAt,
      GOALPORT_ELECTRON_PID: String(identity.pid),
      GOALPORT_ELECTRON_CREATED_MS: String(identity.createdMs),
      GOALPORT_ELECTRON_EXE: identity.executablePath,
      GOALPORT_ELECTRON_SHA256: identity.executableSha256
    };
    coreChild = spawn(command, commandArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: childEnv
    });
    let spawnError;
    coreChild.once("error", (error) => { spawnError = error; });
    coreChild.unref();
    // A cold Windows launch can spend several seconds in SQLite migration and
    // process setup. Keep the host alive long enough for the detached Core to
    // expose the pipe instead of turning a slow first run into a false crash.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawnError) throw new Error(`Core launcher could not start: ${spawnError.message}`);
      if (await pipeAvailable()) return coreGate.verify();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let detail = "";
    for (const suffix of [".launcher.log", ".core.log"]) {
      try { detail += fs.readFileSync(`${dbPath()}${suffix}`, "utf8").slice(-1500); } catch {}
    }
    throw new Error(`Core did not expose its Named Pipe within 10 seconds.${detail ? `\n${detail.trim()}` : ""}`);
  })().finally(() => { coreLaunchPromise = undefined; });
  return coreLaunchPromise;
}

// Authenticates the pipe server before attachment: `goalport-core pipe-peer`
// proves the server runs as this Windows user behind the Core-only descriptor,
// and its PID must be the Core that committed the startup receipt.
function runPipePeer() {
  return new Promise((resolve) => {
    const binary = coreBinary();
    if (!binary) return resolve({ code: null, stdout: "" });
    execFile(binary, ["pipe-peer", "--pipe", PIPE_NAME], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout: String(stdout ?? "") });
    });
  });
}

// ONE full verification of the Core connection (profile mode only).
async function verifyCoreConnection() {
  if (!profile) return;
  return verifyCoreServer({
    runPeer: runPipePeer,
    isBusy: pipePeerBusy,
    now: () => Date.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    requestReceipt: async (timeoutMs) => {
      const requestId = `identity-${randomUUID()}`;
      const response = await exchange({
        protocolVersion: "goalport.ipc.v2", requestId,
        entityVersion: 0, messageType: "get_startup_receipt", payload: {}
      }, { timeoutMs });
      if (!response || response.requestId !== requestId || response.ok === false) throw new Error("Core startup identity is unavailable; attachment refused");
      return response.payload?.receipt;
    },
    assertPeer: (peerStdout, receipt) => {
      assertPipePeer(peerStdout, receipt);
      assertCoreIdentity(receipt, profile);
    }
  });
}

// Synchronous-looking async wrapper for `goalport-core profile ...`
// subcommands (inspect / backup / import). Never spawns a server, never
// migrates a database.
const { execFile: execFileAsync } = require("node:child_process");
function runCoreProfileCommand(args) {
  const binary = coreBinary();
  if (!binary) return Promise.resolve({ code: -1, stdout: "", error: "Core binary is missing" });
  return new Promise((resolve) => {
    execFileAsync(binary, args, { timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout ?? ""), error: error?.message });
    });
  });
}

// ---------- Original startup inspection diagnostics ----------
// Bounded, in-memory trace of the `goalport-core profile inspect` that the
// profile bootstrap itself issues during startup. This is the ONLY record of
// the original startup inspection; the separately-labelled post-failure
// re-probe lives in scripts/desktop/diagnostics.mjs and never substitutes for
// it. Diagnostic constraints:
//   * additive only: the trace observes execCore results and NEVER alters
//     them, the profile decision, the phase/kind contract or any
//     goalport:bootstrap-state notification. It is exposed solely as the
//     optional `diagnostics` child of the goalport:bootstrap-current result.
//   * bounded and sanitized at the source: at most
//     ORIGINAL_INSPECT_MAX_RECORDS records are kept; every captured string is
//     capped and user-profile paths are redacted; stdout is never captured or
//     exposed — only selected fact fields of the parsed report survive.
//   * fail-safe: any error inside the trace is swallowed; diagnostics can
//     never mask, delay or replace the original startup failure.
const ORIGINAL_INSPECT_MAX_RECORDS = 8;
const ORIGINAL_INSPECT_STRING_CAP = 200;
const originalInspectTrace = { records: [], total: 0 };

function redactTraceText(value) {
  return String(value ?? "")
    .replace(/[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, "<user-profile>")
    .replace(/\/(?:home|Users)\/[^/\s"']+/g, "<user-profile>")
    .slice(0, ORIGINAL_INSPECT_STRING_CAP);
}

// Selected fact fields of the inspect report only. Anything else the report
// carries (counts, epochs, foreign tables, arbitrary extra fields) is dropped.
function selectedInspectFacts(value) {
  if (!value || typeof value !== "object") return null;
  const facts = {};
  for (const key of ["ok", "exists", "openable", "needsRecovery", "empty"]) {
    facts[key] = typeof value[key] === "boolean" ? value[key] : null;
  }
  for (const key of ["schemaVersion", "currentSchemaVersion"]) {
    facts[key] = Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null;
  }
  facts.quickCheck = typeof value.quickCheck === "string" ? redactTraceText(value.quickCheck) : null;
  facts.errorReason = typeof value.error === "string" ? redactTraceText(value.error) : null;
  return facts;
}

// Names the inspected database WITHOUT recording any path: the bootstrap's
// own profile database vs. a discovery/import inspection of other data.
function originalInspectTarget(args) {
  try {
    const dbIndex = args.indexOf("--db");
    if (dbIndex < 0 || !args[dbIndex + 1] || !profile) return "unknown";
    const relative = path.relative(path.resolve(profile.directory), path.resolve(String(args[dbIndex + 1])));
    return relative.toLowerCase() === "goalport.sqlite" ? "own-database" : "other-database";
  } catch {
    return "unknown";
  }
}

function beginOriginalInspectRecord(args, purpose) {
  const record = {
    target: originalInspectTarget(args),
    purpose: purpose === "post-core-open" ? "post-core-open" : "classification",
    status: "pending",
    startedAt: isoNow(),
    startedAtMs: Date.now(),
    endedAt: null,
    elapsedMs: null,
    exitCode: null,
    execError: null,
    malformed: null,
    parseNote: null,
    facts: null
  };
  originalInspectTrace.records.push(record);
  originalInspectTrace.total += 1;
  if (originalInspectTrace.records.length > ORIGINAL_INSPECT_MAX_RECORDS) {
    originalInspectTrace.records.splice(0, originalInspectTrace.records.length - ORIGINAL_INSPECT_MAX_RECORDS);
  }
  return record;
}

function completeOriginalInspectRecord(record, result) {
  record.status = "completed";
  record.endedAt = isoNow();
  record.elapsedMs = Math.max(0, Date.now() - record.startedAtMs);
  record.exitCode = Number.isInteger(result?.code) ? result.code : null;
  record.execError = result?.error ? redactTraceText(result.error) : null;
  try {
    const line = String(result?.stdout || "").split(/\r?\n/).find((candidate) => candidate.trim());
    if (!line) {
      record.malformed = true;
      record.parseNote = "no parsable output line";
      return;
    }
    record.facts = selectedInspectFacts(JSON.parse(line));
    record.malformed = false;
  } catch (error) {
    record.malformed = true;
    record.parseNote = redactTraceText(error?.message || error);
  }
}

// Snapshot for the optional diagnostics child of goalport:bootstrap-current.
// A pending record reports its elapsed-so-far in the copy only; the live
// record keeps waiting for its completion facts.
function originalInspectDiagnostics() {
  return {
    kind: "original-startup-inspect-trace",
    note: "bounded in-memory trace of the original startup `goalport-core profile inspect` recorded by this build; distinct from any post-failure diagnostic re-probe",
    totalInspections: originalInspectTrace.total,
    droppedRecords: Math.max(0, originalInspectTrace.total - originalInspectTrace.records.length),
    records: originalInspectTrace.records.map((record) => {
      const { startedAtMs, ...snapshot } = { ...record };
      if (snapshot.status === "pending") snapshot.elapsedMs = Math.max(0, Date.now() - startedAtMs);
      return snapshot;
    })
  };
}

function runTracedCoreProfileCommand(args, context) {
  let record = null;
  try {
    if (Array.isArray(args) && args[0] === "profile" && args[1] === "inspect") record = beginOriginalInspectRecord(args, context?.purpose);
  } catch { /* diagnostics must never break startup */ }
  const finish = (result) => {
    try { if (record) completeOriginalInspectRecord(record, result); } catch { /* swallow */ }
  };
  return runCoreProfileCommand(args).then(
    (result) => { finish(result); return result; },
    (error) => {
      finish({ code: -1, stdout: "", error: String(error?.message || error) });
      throw error;
    }
  );
}

// ---------- profile bootstrap (startup continuity) ----------
// All profile compatibility/ownership decisions run here, after a real window
// exists, with structured states pushed to the renderer. The renderer only
// displays facts and forwards user actions; it never decides.
// A bootstrap that may continue returns the structured outcome (its
// `formatVersion` is the schema fact the resolved decision committed to);
// every terminal path returns the string "exit".
let bootstrapWaiter = null;
function waitForBootstrapAction() {
  return new Promise((resolve) => { bootstrapWaiter = resolve; });
}
let lastBootstrapState = { phase: "checking" };
let profileDisposition = null;
function pushBootstrap(state) {
  lastBootstrapState = state;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send("goalport:bootstrap-state", state); } catch { /* window mid-close */ }
}
function importFacts(discovery) {
  return {
    sourcePath: discovery?.path ?? null,
    createdBy: discovery?.marker?.createdBy ?? null,
    markerSchema: discovery?.marker?.markerSchemaVersion ?? null,
    counts: discovery?.inspection?.counts ?? null,
    schemaVersion: discovery?.inspection?.schemaVersion ?? null,
    bytes: discovery?.inspection?.bytes ?? null,
    recoveryDisposition: "NOT_REQUIRED",
    recoveryMethod: null,
    recoveryProofToken: null,
    operationId: null,
    sourceMutationOnAccept: "NONE",
    liveSource: discovery?.inspection?.latestEpoch?.priorCore === "live-exact"
  };
}
function quitFromBootstrap() {
  allowQuitAfterCloseChoice = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  app.exit(0);
}
async function chooseFreshDirectoryAndRelaunch() {
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: "Choose an empty folder for a fresh GoalPort data profile",
    properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
  });
  if (choice.canceled || !choice.filePaths[0]) return false;
  // relaunchArguments strips the mutually-exclusive --data-dir/--test-profile
  // pair (both spellings) and keeps every other switch — a --user-data-dir
  // relocation or a debugging switch survives the relaunch.
  app.relaunch({ args: relaunchArguments(process.argv.slice(1), choice.filePaths[0]) });
  quitFromBootstrap();
  return true;
}
const BOOTSTRAP_ERROR_SCREENS = {
  "newer-schema": { canChooseDir: true, headline: "This data profile is from a newer GoalPort." },
  "unsupported-legacy": { canChooseDir: true, headline: "This data profile uses an unsupported legacy format." },
  "corrupt": { canChooseDir: true, headline: "This data profile failed an integrity check." },
  "corrupt-marker": { canChooseDir: true, headline: "This data profile's record file is damaged." },
  "missing-database": { canChooseDir: true, headline: "This data profile record exists but its database is missing." },
  "not-a-profile": { canChooseDir: true, headline: "This data directory is not an empty or existing GoalPort profile." },
  "identity-mismatch": { canChooseDir: true, headline: "This data directory belongs to a different profile identity." },
  "inspection-failed": { canChooseDir: true, headline: "This data profile could not be examined." },
  "needs-recovery": { canChooseDir: true, headline: "This data profile's database cannot be verified without recovery." },
  "readonly-dir": { canChooseDir: true, headline: "The data directory cannot be written." },
  "disk-full": { canChooseDir: true, headline: "There is not enough disk space to continue." },
  "import-failed": { canChooseDir: true, headline: "Importing the existing data did not complete." },
  "backup-failed": { canChooseDir: true, headline: "A safety backup of the existing data could not be created." },
  "core-start": { canChooseDir: false, headline: "The local Core could not start with this data profile." },
  "internal-error": { canChooseDir: false, headline: "GoalPort hit an unexpected condition while opening this data profile." }
};
async function bootstrapErrorScreen(kind, message) {
  const screen = BOOTSTRAP_ERROR_SCREENS[kind] || BOOTSTRAP_ERROR_SCREENS["internal-error"];
  pushBootstrap({ phase: "error", kind, headline: screen.headline, message: String(message || ""), canChooseDir: screen.canChooseDir, dataPath: profile?.directory ?? null });
  while (true) {
    const action = await waitForBootstrapAction();
    if (action?.type === "choose-dir") { if (await chooseFreshDirectoryAndRelaunch()) return "exit"; continue; }
    if (action?.type === "open-folder" && profile?.directory) { shell.openPath(profile.directory); continue; }
    if (action?.type === "exit") return "exit";
  }
}
function classifyFsError(error) {
  const code = String(error?.code || "");
  if (["EACCES", "EPERM", "EROFS"].includes(code)) return "readonly-dir";
  if (["ENOSPC", "EDQUOT"].includes(code)) return "disk-full";
  return "internal-error";
}
async function runProfileBootstrap() {
  pushBootstrap({ phase: "checking" });
  let outcome;
  try {
    outcome = await profileManager.resolve();
    profileDisposition = outcome.kind;
  } catch (error) {
    return (await bootstrapErrorScreen(classifyFsError(error), error?.message)) === "exit" ? "exit" : "exit";
  }
  switch (outcome.kind) {
    case "fresh":
      try { profileManager.beginFresh(); } catch (error) { return await bootstrapExitOnError(classifyFsError(error), error); }
      return outcome;
    case "resume-import":
      try { profileManager.finalizeImport(outcome.journal); } catch (error) { return await bootstrapExitOnError(classifyFsError(error), error); }
      return outcome;
    case "reopen":
      if (outcome.needsBackup) {
        pushBootstrap({ phase: "backing-up" });
        try { await profileManager.backupOwnDatabase(); } catch (error) { return await bootstrapExitOnError("backup-failed", error); }
      }
      return outcome;
    case "adopt-v1": {
      // Explicit --data-dir carrying a v1 marker: verified backup, then an
      // in-place marker upgrade (metadata only; the database never moves).
      pushBootstrap({ phase: "backing-up" });
      try { await profileManager.backupOwnDatabase(); } catch (error) { return await bootstrapExitOnError("backup-failed", error); }
      try {
        const state = profileManager.readMarker();
        if (!state || state.problem) throw new Error(state?.problem || "marker disappeared");
        profileManager.adoptV1Marker(state);
      } catch (error) { return await bootstrapExitOnError("internal-error", error); }
      return outcome;
    }
    case "import-offer":
    case "import-recovery-offer": {
      const recovery = outcome.kind === "import-recovery-offer";
      const facts = { ...importFacts(outcome.discovery), ...(recovery ? outcome.recovery : {}) };
      pushBootstrap({ phase: "import-offer", facts });
      while (true) {
        const action = await waitForBootstrapAction();
        if (action?.type === "exit") return "exit";
        if (action?.type === "import-accept") {
          pushBootstrap({ phase: "importing", facts });
          try {
            if (recovery) await profileManager.acceptRecovery(outcome.journal, {
              operationId: action.operationId, recoveryProofToken: action.recoveryProofToken
            });
            else await profileManager.runImport(outcome.discovery);
          } catch (error) {
            return await bootstrapExitOnError("import-failed", error);
          }
          return outcome;
        }
        if (action?.type !== "fresh") continue;
        // Only an explicit decline can abandon an owned recovery probe. A
        // malformed action, exit or stale consent must never fall into fresh.
        try {
          if (recovery) await profileManager.declineRecovery(outcome.journal);
          profileManager.beginFresh();
        } catch (error) { return await bootstrapExitOnError(classifyFsError(error), error); }
        return outcome;
      }
    }
    case "import-incompatible": {
      pushBootstrap({ phase: "import-incompatible", facts: importFacts(outcome.discovery), reason: outcome.reason });
      while (true) {
        const action = await waitForBootstrapAction();
        if (action?.type === "fresh") {
          try { profileManager.beginFresh(); } catch (error) { return await bootstrapExitOnError(classifyFsError(error), error); }
          return outcome;
        }
        if (action?.type === "open-folder" && outcome.discovery?.path) { shell.openPath(outcome.discovery.path); continue; }
        if (action?.type === "exit") return "exit";
      }
    }
    case "live-core":
    case "unknown-core": {
      const live = outcome.kind === "live-core";
      while (true) {
        pushBootstrap({
          phase: "coordination",
          kind: outcome.kind,
          headline: live
            ? "Your GoalPort data is still in use by a running GoalPort Core."
            : "GoalPort cannot confirm whether a previous Core is still using this data.",
          detail: outcome.epoch ?? null,
          dataPath: profile?.directory ?? null
        });
        const action = await waitForBootstrapAction();
        if (action?.type === "retry") {
          return await runProfileBootstrap();
        }
        if (action?.type === "open-folder" && profile?.directory) { shell.openPath(profile.directory); continue; }
        if (action?.type === "exit") return "exit";
      }
    }
    default:
      return await bootstrapExitOnError(outcome.kind, outcome.reason || outcome.kind);
  }
}
async function bootstrapExitOnError(kind, error) {
  const disposition = await bootstrapErrorScreen(kind, error?.message || error);
  return disposition === "exit" ? "exit" : "exit";
}
// Synthetic (--test-profile) bootstrap: the same fail-closed decisions as
// normal data, minus channel behaviors (discovery/import/v1 adoption) that
// never apply to an explicit per-test directory. Only a genuinely fresh
// directory or a compatible synthetic reopen may continue; every other
// outcome refuses BEFORE any marker write, backup write-open or Core launch.
// Synthetic data is disposable, so a compatible reopen skips the consistency
// backup — no write-open ever happens on this path.
async function runSyntheticProfileBootstrap() {
  pushBootstrap({ phase: "checking" });
  let outcome;
  try {
    outcome = await profileManager.resolve();
    profileDisposition = outcome.kind;
  } catch (error) {
    return await bootstrapExitOnError(classifyFsError(error), error);
  }
  switch (outcome.kind) {
    case "fresh":
      try { profileManager.beginFresh(); } catch (error) { return await bootstrapExitOnError(classifyFsError(error), error); }
      return outcome;
    case "reopen":
      return outcome;
    default:
      return await bootstrapExitOnError(outcome.kind, outcome.reason || outcome.kind);
  }
}
// The Core spawn itself can still lose an ownership race with a Core that
// became live between inspection and spawn: classify structurally, never by
// matching the error text.
async function startCoreWithCoordination() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ensureCore();
      return true;
    } catch (error) {
      let outcome = null;
      try { outcome = await profileManager.resolve(); } catch { /* classify below */ }
      if (attempt < 20 && (outcome?.kind === "live-core" || outcome?.kind === "unknown-core")) {
        const disposition = await coordinationFromOutcome(outcome);
        if (disposition === "retry") continue;
        return false;
      }
      await bootstrapExitOnError("core-start", error);
      return false;
    }
  }
}
async function coordinationFromOutcome(outcome) {
  const live = outcome.kind === "live-core";
  while (true) {
    pushBootstrap({
      phase: "coordination",
      kind: outcome.kind,
      headline: live
        ? "Your GoalPort data is still in use by a running GoalPort Core."
        : "GoalPort cannot confirm whether a previous Core is still using this data.",
      detail: outcome.epoch ?? null,
      dataPath: profile?.directory ?? null
    });
    const action = await waitForBootstrapAction();
    if (action?.type === "retry") return "retry";
    if (action?.type === "open-folder" && profile?.directory) { shell.openPath(profile.directory); continue; }
    if (action?.type === "exit") return "exit";
  }
}

const coreGate = createCoreGate({ verify: verifyCoreConnection });

// Every request to Core goes through this gate (see createCoreGate).
function exchangeVerified(request) {
  return coreGate.send(request, exchange);
}

function exchange(request, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PIPE_NAME);
    const chunks = [];
    let expected = null;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error(`Core IPC response timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} seconds`)), timeoutMs);
    const fail = (error) => { if (!settled) { settled = true; clearTimeout(timeout); socket.destroy(); reject(error); } };
    socket.on("error", fail);
    socket.on("end", () => { if (!settled) fail(new Error("Core closed the connection before acknowledging the request")); });
    socket.on("close", () => { if (!settled) fail(new Error("Core connection closed before acknowledgement")); });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (expected == null && bytes.length >= 4) expected = bytes.readUInt32LE(0);
      if (expected != null && expected > MAX_FRAME_BYTES) return fail(new Error("Core response frame exceeds limit"));
      if (expected != null && bytes.length >= expected + 4) {
        settled = true;
        clearTimeout(timeout);
        socket.end();
        try { resolve(JSON.parse(bytes.subarray(4, expected + 4).toString("utf8"))); }
        catch (error) { reject(error); }
      }
    });
    const payload = Buffer.from(JSON.stringify(request));
    if (payload.length > MAX_FRAME_BYTES) {
      return fail(new Error("Core request frame exceeds limit"));
    }
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    // Do not half-close a Windows Named Pipe before a slow native response.
    socket.on("connect", () => socket.write(frame));
  });
}

function closeAttemptTarget(active, selectedId, held, heldId) {
  return active && selectedId ? selectedId : held ? heldId : selectedId;
}

function cacheAttempt(snapshot) {
  lastProjectionUnavailable = snapshot?.bounds?.projectionUnavailable === true || snapshot?.bounds?.projection_unavailable === true;
  if (lastProjectionUnavailable) return; // Capacity acknowledgement is not evidence that held/active work ended.
  const state = String(snapshot?.attempt?.state || "");
  lastAttemptActive = state === "active" || state === "ACTIVE";
  lastAttemptId = String(snapshot?.attempt?.id || lastAttemptId || "");
  lastAttemptProvider = String(snapshot?.attempt?.provider || lastAttemptProvider || "").toLowerCase();
  const responsibility = snapshot?.stopResponsibility || snapshot?.stop_responsibility;
  const writeResponsibility = String(responsibility?.writeResponsibility || responsibility?.write_responsibility || "").toLowerCase();
  lastStopResponsibilityHeld = writeResponsibility === "held";
  lastHeldAttemptId = lastStopResponsibilityHeld
    ? String(responsibility?.attemptId || responsibility?.attempt_id || lastHeldAttemptId || "")
    : "";
  lastCampaignId = String(snapshot?.activeCampaignId || lastCampaignId || "");
}

function notifyCloseChoiceFailed(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("goalport:close-choice-failed", payload);
}

async function persistCloseChoice(payload) {
  const response = await exchangeVerified({
    protocolVersion: "goalport.ipc.v2",
    // Keep the owner operation in payload.requestId, while using a distinct
    // Core-ledger identity for the receipt command. Replays remain deterministic.
    requestId: `close-receipt:${payload.requestId}`,
    entityVersion: 0,
    messageType: "record_close_choice",
    payload
  });
  if (!response || response.ok === false) {
    throw new Error(response?.error || "Core rejected close-choice");
  }
  const body = response.payload || {};
  if (body.snapshot) cacheAttempt(body.snapshot);
  return body.receipt || null;
}

async function refreshAttemptCache() {
  try {
    const snapshot = await invokeCore({
      protocolVersion: "goalport.ipc.v2",
      requestId: `close-cache-${Date.now()}`,
      entityVersion: 0,
      messageType: "snapshot",
      payload: {}
    });
    cacheAttempt(snapshot);
  } catch {
    // Keep the last observed Attempt state if Core is briefly unreachable.
  }
}

function promptRendererCloseChoice() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (closePromptOpen) return;
  closePromptOpen = true;
  mainWindow.webContents.send("goalport:close-prompt");
}

async function quitAfterCloseChoice() {
  allowQuitAfterCloseChoice = true;
  closePromptOpen = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    saveWindowState({ statePath: path.join(app.getPath("userData"), STATE_FILE), win: mainWindow });
    mainWindow.destroy();
  }
  app.quit();
}

async function invokeCore(request) {
  return invokeCoreRequest(request, {
    exchange: exchangeVerified, ensureCore, delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onResult: (snapshot) => { cacheAttempt(snapshot); maybeNotify(request, snapshot); }
  });
}

function maybeNotify(request, result) {
  const type = request?.messageType;
  if (type === "send_message") {
    const attemptState = result?.attempt?.state;
    if (attemptState === "completed" || attemptState === "failed") {
      showToast("GoalPort task", `Attempt ${attemptState}.`);
    }
  }
  const pending = Array.isArray(result?.decisions) ? result.decisions.filter((item) => item?.state === "pending") : [];
  if (pending.length > 0 && (type === "send_message" || type === "snapshot" || type === "permission_response")) {
    showToast("GoalPort decision", pending[0].title || "A blocking decision is waiting.");
  }
}

// Integrated title bar (Windows): keep the native window controls via the
// Window Controls Overlay and let the renderer own the bar surface. The height
// matches the CSS title bar height in styles.css; colors follow the app surface.
const TITLE_BAR_HEIGHT = 40;

// The screen API can be absent in embedded/test hosts; window sizing then falls
// back to the rc.1 defaults instead of refusing to start.
function primaryDisplay() {
  try {
    return screen?.getPrimaryDisplay?.() ?? null;
  } catch {
    return null;
  }
}

function allDisplays() {
  try {
    return screen?.getAllDisplays?.() ?? [];
  } catch {
    return [];
  }
}

async function createWindow() {
  const primary = primaryDisplay();
  const displays = allDisplays();
  const state = loadWindowState({
    statePath: path.join(app.getPath("userData"), STATE_FILE),
    displays,
    primaryDisplay: primary ?? { workArea: { x: 0, y: 0, width: 1440, height: 920 } }
  });
  mainWindow = new BrowserWindow({
    ...state.bounds,
    minWidth: 480,
    minHeight: 420,
    title: `GoalPort ${appVersion} · ${profile?.testMode ? "Synthetic test" : (launchChannel ? channelLabel(launchChannel) : "RC")}`,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#1a1a1e",
      symbolColor: "#c8c7c5",
      height: TITLE_BAR_HEIGHT
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--goalport-app-document=${encodeURIComponent(appDocumentUrl)}`]
    }
  });
  protectRenderer(mainWindow.webContents, appDocumentUrl, (url) => shell.openExternal(url));
  if (state.maximized) mainWindow.maximize();
  const rememberWindowState = () => saveWindowState({
    statePath: path.join(app.getPath("userData"), STATE_FILE),
    win: mainWindow
  });
  mainWindow.on("resize", rememberWindowState);
  mainWindow.on("move", rememberWindowState);
  await mainWindow.loadFile(path.join(appRoot, "dist", "index.html"));
  if (isolatedRequired() && mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.webContents.executeJavaScript("window.__GOALPORT_ISOLATED=1");
  }
  mainWindow.on("close", (event) => {
    saveWindowState({ statePath: path.join(app.getPath("userData"), STATE_FILE), win: mainWindow });
    if (allowQuitAfterCloseChoice) return;
    if (!lastAttemptActive && !lastStopResponsibilityHeld && !lastProjectionUnavailable) return;
    event.preventDefault();
    promptRendererCloseChoice();
  });
  if (profileManager && profile && profile.mode === "normal" && !profile.testMode) {
    const outcome = await runProfileBootstrap();
    if (!outcome || outcome === "exit") { quitFromBootstrap(); return; }
    profileReady = true;
    if (!(await startCoreWithCoordination())) { quitFromBootstrap(); return; }
    try { await profileManager.recordOpenedDatabase(); } catch (error) {
      profileReady = false;
      await bootstrapExitOnError("inspection-failed", error);
      quitFromBootstrap(); return;
    }
    pushBootstrap({ phase: "done" });
  } else if (profileManager && profile) {
    // Synthetic test profiles (--test-profile) pass the SAME ProfileManager
    // validation before any Core launch: marker product/mode/path identity,
    // then database compatibility through the read-only inspection. There is
    // no synthetic profileReady shortcut anymore — a damaged, foreign, newer
    // or unmarked directory refuses without spawning Core, and only a fresh
    // or compatible-reopen bootstrap reaches ensureCore.
    const outcome = await runSyntheticProfileBootstrap();
    if (!outcome || outcome === "exit") { quitFromBootstrap(); return; }
    profileReady = true;
    await ensureCore();
    try { await profileManager.recordOpenedDatabase(); } catch (error) {
      profileReady = false;
      await bootstrapExitOnError("inspection-failed", error);
      quitFromBootstrap(); return;
    }
    pushBootstrap({ phase: "done" });
  } else {
    // Legacy isolated tooling (no profile; env-bound contract asserted
    // pre-ready in assertIsolatedLaunch) keeps the direct path. It now also
    // receives the bootstrap done signal: this branch is an active admission
    // contract, and a renderer that subscribes to bootstrap states must not
    // wait on "checking" forever (nothing else will ever push a state here).
    profileReady = true;
    await ensureCore();
    pushBootstrap({ phase: "done" });
  }
  await refreshAttemptCache();
}

app.whenReady().then(() => {
  handleTrusted("goalport:app-info", () => ({
    version: appVersion,
    channel: profile?.testMode ? "Synthetic test" : (launchChannel === "release" || !launchChannel ? "Stable V1 RC" : channelLabel(launchChannel)),
    distribution: app.isPackaged ? (launchChannel || "release") : "dev",
    testMode: isolatedRequired(),
    // dataPath is the durable profile root (the user's backup/migration
    // unit); browserStatePath is the separate Electron/Chromium namespace.
    // Profile-less legacy isolated runs keep reporting their env-bound
    // userData as both.
    dataPath: profile?.durableDirectory ?? app.getPath("userData"),
    browserStatePath: profile?.browserStateDirectory ?? app.getPath("userData")
  }));
  handleTrusted("goalport:bootstrap-current", () => {
    // An additive optional diagnostics child exposes
    // the bounded original-inspect trace. The bootstrap state itself — every
    // phase/kind and every goalport:bootstrap-state notification — is returned
    // unchanged, and the child is never stored into lastBootstrapState.
    if (!profileManager) return lastBootstrapState;
    try {
      return { ...lastBootstrapState, diagnostics: { profileDisposition, originalProfileInspect: originalInspectDiagnostics() } };
    } catch {
      return lastBootstrapState;
    }
  });
  handleTrusted("goalport:bootstrap-action", (event, payload) => {
    if (bootstrapWaiter) {
      const resolve = bootstrapWaiter;
      bootstrapWaiter = null;
      resolve(payload);
    }
    return { ok: true };
  });
  handleTrusted("goalport:choose-workspace", async () => {
    const choice = await dialog.showOpenDialog(mainWindow, { title: "Choose a project workspace", properties: ["openDirectory"] });
    return choice.canceled ? null : choice.filePaths[0] || null;
  });
  handleTrusted("goalport:core-snapshot", (_, request) => invokeCore(request));
  handleTrusted("goalport:core-command", (_, request) => invokeCore(request));
  handleTrusted("goalport:start-core", async () => { await ensureCore(); return { connected: true, pipeName: PIPE_NAME }; });
  handleTrusted("goalport:open-vscode", (_, workspaceRoot) => shell.openPath(workspaceRoot));
  handleTrusted("goalport:request-close", async () => {
    if (allowQuitAfterCloseChoice) {
      await quitAfterCloseChoice();
      return { ok: true, allowQuitLatch: true };
    }
    await refreshAttemptCache();
    if (!lastAttemptActive && !lastStopResponsibilityHeld && !lastProjectionUnavailable) {
      await quitAfterCloseChoice();
      return { ok: true, allowQuitLatch: true, prompted: false };
    }
    promptRendererCloseChoice();
    return { ok: true, prompted: true, allowQuitLatch: false };
  });
  handleTrusted("goalport:confirm-close-choice", async (event, rawPayload) => {
    const parsed = normalizeClosePayload(rawPayload);
    const selected = parsed.choice;
    const requestId = parsed.requestId;
    const identity = electronIdentity();
    const mainReceivedAtUtc = isoNow();
    await refreshAttemptCache();
    if (lastProjectionUnavailable) {
      const error = "Core acknowledged the operation, but its current control projection is unavailable. Reconnect before changing close responsibility.";
      notifyCloseChoiceFailed({ requestId, error });
      return { ok: false, requestId, choice: selected, allowQuitLatch: false, coreAcknowledged: false, error };
    }
    const closeAttemptId = closeAttemptTarget(lastAttemptActive, lastAttemptId, lastStopResponsibilityHeld, lastHeldAttemptId);
    if (selected === "continue") {
      if ((!lastAttemptActive && !lastStopResponsibilityHeld) || !closeAttemptId) {
        notifyCloseChoiceFailed({ requestId, error: "no-core-owned-attempt" });
        return { ok: false, requestId, choice: "continue", allowQuitLatch: false, coreAcknowledged: false, error: "no-core-owned-attempt" };
      }
      let receipt;
      try {
        receipt = await persistCloseChoice({
          requestId,
          choice: "continue",
          attemptId: closeAttemptId,
          campaignId: lastCampaignId,
          uiPid: identity.pid,
          uiCreatedMs: identity.createdMs,
          continueClickIssuedAtUtc: parsed.continueClickIssuedAtUtc || mainReceivedAtUtc,
          mainReceivedAtUtc
        });
      } catch (error) {
        notifyCloseChoiceFailed({ requestId, error: String(error.message || error) });
        return { ok: false, requestId, choice: "continue", allowQuitLatch: false, coreAcknowledged: false, error: String(error.message || error) };
      }
      const receiptId = String(receipt?.receiptId || "");
      if (!receiptId || String(receipt?.choice) !== "continue-background") {
        notifyCloseChoiceFailed({ requestId, error: "core-receipt-missing" });
        return { ok: false, requestId, choice: "continue", allowQuitLatch: false, coreAcknowledged: false, error: "core-receipt-missing" };
      }
      allowQuitAfterCloseChoice = true;
      closePromptOpen = false;
      const response = {
        ok: true,
        requestId,
        receiptId,
        choice: "continue",
        allowQuitLatch: true,
        coreAcknowledged: true
      };
      setImmediate(() => { void quitAfterCloseChoice(); });
      return response;
    }
    if (selected !== "stop") {
      return { ok: false, requestId, choice: selected, allowQuitLatch: false, coreAcknowledged: false, error: "unsupported-close-choice" };
    }
    try {
      if (!closeAttemptId) {
        throw new Error("no-core-owned-attempt");
      }
      const requiresHold = lastStopResponsibilityHeld || lastAttemptProvider === "claude";
      const stopped = await invokeCore({
        protocolVersion: "goalport.ipc.v2",
        requestId,
        entityVersion: 0,
        messageType: "safe_stop",
        payload: { attemptId: closeAttemptId }
      });
      acknowledgedStopSnapshot(stopped, requestId, requiresHold);
      const receipt = await persistCloseChoice({
        requestId,
        choice: "stop",
        attemptId: closeAttemptId,
        campaignId: lastCampaignId,
        uiPid: identity.pid,
        uiCreatedMs: identity.createdMs,
        mainReceivedAtUtc
      });
      const receiptId = String(receipt?.receiptId || "");
      if (!receiptId || String(receipt?.choice) !== "stop-background") {
        throw new Error("core-stop-receipt-missing");
      }
      allowQuitAfterCloseChoice = true;
      closePromptOpen = false;
      setImmediate(() => { void quitAfterCloseChoice(); });
      return { ok: true, requestId, receiptId, choice: "stop", allowQuitLatch: true, coreAcknowledged: true };
    } catch (error) {
      const message = String(error.message || error);
      notifyCloseChoiceFailed({ requestId, error: message });
      return { ok: false, requestId, choice: "stop", allowQuitLatch: false, coreAcknowledged: false, error: message };
    }
  });
  handleTrusted("goalport:dismiss-close-choice", () => {
    closePromptOpen = false;
    return { ok: true, allowQuitLatch: allowQuitAfterCloseChoice };
  });
  return createWindow();
}).catch(reportStartupFailure);

app.on("before-quit", (event) => {
  if (allowQuitAfterCloseChoice) return;
  if (!lastAttemptActive && !lastStopResponsibilityHeld && !lastProjectionUnavailable) return;
  event.preventDefault();
  promptRendererCloseChoice();
});

app.on("window-all-closed", () => {
  if (allowQuitAfterCloseChoice || (!lastAttemptActive && !lastStopResponsibilityHeld && !lastProjectionUnavailable)) {
    if (process.platform !== "darwin") app.quit();
  }
});
