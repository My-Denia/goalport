const { app, BrowserWindow, ipcMain, Notification, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { launchArguments, prepareProfile, assertCoreIdentity, childEnvironment } = require("./launch-config.cjs");
const { invokeCoreRequest, acknowledgedStopSnapshot } = require("./core-client.cjs");

const appRoot = fs.existsSync(path.join(__dirname, "dist")) ? __dirname : path.join(__dirname, "..");
function reportStartupFailure(error) {
  console.error("GoalPort startup refused:", error);
  dialog.showErrorBox("GoalPort could not start", String(error.message || error));
  app.exit(1);
}

let appVersion, profile;
try {
  const launchArgs = launchArguments(process.argv);
  const legacyIsolated = process.env.GOALPORT_REQUIRE_ISOLATED === "1" && !launchArgs["--data-dir"] && !launchArgs["--test-profile"];
  appVersion = app.isPackaged ? app.getVersion() : JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
  profile = legacyIsolated ? null : prepareProfile({
    args: launchArgs, appData: app.getPath("appData"), version: appVersion,
    coreSha256: fileSha256(coreBinary() || "")
  });
  if (profile) {
    app.setPath("userData", profile.directory);
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

async function ensureCore() {
  if (!profile && isolatedRequired() && !isThisRunIsolatedPipe(process.env.GOALPORT_CORE_PIPE || configuredPipeName)) {
    throw new Error(`isolated Electron refused to attach to non this-run pipe: ${process.env.GOALPORT_CORE_PIPE || configuredPipeName}`);
  }
  if (await pipeAvailable()) return verifyCoreConnection();
  if (coreLaunchPromise) return coreLaunchPromise;
  if (lastLaunchNonce) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await pipeAvailable()) return verifyCoreConnection();
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
      if (await pipeAvailable()) return verifyCoreConnection();
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

async function verifyCoreConnection() {
  if (!profile) return;
  const requestId = `identity-${randomUUID()}`;
  const response = await exchange({
    protocolVersion: "goalport.ipc.v2", requestId,
    entityVersion: 0, messageType: "get_startup_receipt", payload: {}
  });
  if (!response || response.requestId !== requestId || response.ok === false) throw new Error("Core startup identity is unavailable; attachment refused");
  assertCoreIdentity(response.payload?.receipt, profile);
}

function exchange(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PIPE_NAME);
    const chunks = [];
    let expected = null;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error("Core IPC response timed out after 120 seconds")), 120000);
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
  const response = await exchange({
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  app.quit();
}

async function invokeCore(request) {
  return invokeCoreRequest(request, {
    exchange, ensureCore, delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

async function createWindow() {
  await ensureCore();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 640,
    title: `GoalPort ${appVersion} · ${profile?.testMode ? "Synthetic test" : "RC"}`,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await mainWindow.loadFile(path.join(appRoot, "dist", "index.html"));
  if (isolatedRequired() && mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.webContents.executeJavaScript("window.__GOALPORT_ISOLATED=1");
  }
  mainWindow.on("close", (event) => {
    if (allowQuitAfterCloseChoice) return;
    if (!lastAttemptActive && !lastStopResponsibilityHeld) return;
    event.preventDefault();
    promptRendererCloseChoice();
  });
  await refreshAttemptCache();
}

app.whenReady().then(() => {
  ipcMain.handle("goalport:app-info", () => ({
    version: appVersion, channel: "Stable V1 RC", testMode: isolatedRequired(), dataPath: app.getPath("userData")
  }));
  ipcMain.handle("goalport:choose-workspace", async () => {
    const choice = await dialog.showOpenDialog(mainWindow, { title: "Choose a project workspace", properties: ["openDirectory"] });
    return choice.canceled ? null : choice.filePaths[0] || null;
  });
  ipcMain.handle("goalport:core-snapshot", (_, request) => invokeCore(request));
  ipcMain.handle("goalport:core-command", (_, request) => invokeCore(request));
  ipcMain.handle("goalport:start-core", async () => { await ensureCore(); return { connected: true, pipeName: PIPE_NAME }; });
  ipcMain.handle("goalport:open-vscode", (_, workspaceRoot) => shell.openPath(workspaceRoot));
  ipcMain.handle("goalport:request-close", async () => {
    if (allowQuitAfterCloseChoice) {
      await quitAfterCloseChoice();
      return { ok: true, allowQuitLatch: true };
    }
    await refreshAttemptCache();
    if (!lastAttemptActive && !lastStopResponsibilityHeld) {
      await quitAfterCloseChoice();
      return { ok: true, allowQuitLatch: true, prompted: false };
    }
    promptRendererCloseChoice();
    return { ok: true, prompted: true, allowQuitLatch: false };
  });
  ipcMain.handle("goalport:confirm-close-choice", async (event, rawPayload) => {
    const parsed = normalizeClosePayload(rawPayload);
    const selected = parsed.choice;
    const requestId = parsed.requestId;
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const identity = electronIdentity();
    const mainReceivedAtUtc = isoNow();
    if (!senderWindow || senderWindow.isDestroyed() || senderWindow !== mainWindow) {
      return { ok: false, requestId, choice: selected, allowQuitLatch: false, coreAcknowledged: false, error: "window-mismatch" };
    }
    await refreshAttemptCache();
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
  ipcMain.handle("goalport:dismiss-close-choice", () => {
    closePromptOpen = false;
    return { ok: true, allowQuitLatch: allowQuitAfterCloseChoice };
  });
  return createWindow();
}).catch(reportStartupFailure);

app.on("before-quit", (event) => {
  if (allowQuitAfterCloseChoice) return;
  if (!lastAttemptActive && !lastStopResponsibilityHeld) return;
  event.preventDefault();
  promptRendererCloseChoice();
});

app.on("window-all-closed", () => {
  if (allowQuitAfterCloseChoice || (!lastAttemptActive && !lastStopResponsibilityHeld)) {
    if (process.platform !== "darwin") app.quit();
  }
});
