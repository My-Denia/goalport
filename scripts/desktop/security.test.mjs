import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const { externalHttpUrl, createTrustedIpcHandler, protectRenderer, isAppDocument } = require("../../electron/security-policy.cjs");
const appUrl = "file:///goalport/dist/index.html";
const windowsAppUrl = "file:///C:/GoalPort/dist/index.html";
const documentCases = [
  [appUrl, appUrl, true],
  [`${appUrl}#anchor`, appUrl, true],
  ["https://evil.example/", appUrl, false],
  ["file:///other.html", appUrl, false],
  ["file:///c:/GoalPort/dist/index.html", windowsAppUrl, true],
  ["file:///C:/goalport/dist/INDEX.html", windowsAppUrl, true],
  [`${windowsAppUrl}#local-anchor`, windowsAppUrl, true],
  ["file://localhost/C:/GoalPort/dist/index.html", windowsAppUrl, true],
  ["file:///C:/GoalPort/dist/other.html", windowsAppUrl, false],
  [`${windowsAppUrl}?next=1`, windowsAppUrl, false],
  ["file:///C:/GoalPort/dist/index.html%2Fsecret", windowsAppUrl, false],
  ["file:///C:/GoalPort/My%20App/index.html", "file:///C:/GoalPort/My App/index.html", true],
  ["file:///C:/foo%2Fbar", "file:///C:/foo/bar", false],
  ["file://server/share/index.html", windowsAppUrl, false],
  ["file://remote/C:/GoalPort/dist/index.html", windowsAppUrl, false],
  ["https://evil.example/index.html", windowsAppUrl, false],
  ["file:///goalport/dist/Index.html", appUrl, false],
  ["not a url", windowsAppUrl, false],
  [windowsAppUrl, "://bad", false],
];

function fixture() {
  const handlers = new Map(), listeners = new Map(), opens = [];
  const mainFrame = { processId: 4, routingId: 7, detached: false, url: appUrl };
  const contents = { mainFrame, isDestroyed: () => false, getURL: () => appUrl,
    on: (name, fn) => listeners.set(name, fn), setWindowOpenHandler: (fn) => { contents.popup = fn; } };
  const win = { webContents: contents, isDestroyed: () => false };
  const handle = createTrustedIpcHandler({ handle: (name, fn) => handlers.set(name, fn) }, () => win, appUrl);
  return { handle, handlers, listeners, contents, win, mainFrame, opens,
    event: { sender: contents, senderFrame: mainFrame } };
}

// Execute the actual main entrypoint through registration and the first window
// load. The boundary stubs prevent profile writes, process launches, and network
// access; they do not replace the production security policy or its wiring.
async function mainWiring(customModules = {}) {
  const handlers = new Map(), externalUrls = [], effects = [];
  let ready, loaded;
  const loadStarted = new Promise((resolve) => { loaded = resolve; });
  const app = {
    isPackaged: false,
    getPath: () => "/fixture/user-data",
    setAppUserModelId: () => {},
    on: () => {},
    whenReady: () => ({ then: (callback) => { ready = callback; return { catch: () => {} }; } }),
    exit: (code) => { throw new Error(`unexpected app exit: ${code}`); },
  };
  const ipcMain = { handle: (channel, handler) => {
    assert.equal(handlers.has(channel), false, `duplicate handler: ${channel}`);
    handlers.set(channel, handler);
  } };
  let win;
  class BrowserWindow {
    constructor(options) {
      win = this;
      this.options = options;
      this.listeners = new Map();
      const listeners = new Map();
      const mainFrame = { processId: 4, routingId: 7, detached: false, url: "" };
      this.webContents = {
        listeners, mainFrame,
        isDestroyed: () => false,
        getURL: () => mainFrame.url,
        on: (name, handler) => listeners.set(name, handler),
        setWindowOpenHandler: (handler) => { this.webContents.popup = handler; },
      };
    }
    isDestroyed() { return false; }
    on(name, handler) { this.listeners.set(name, handler); }
    loadFile(file) {
      this.webContents.mainFrame.url = pathToFileURL(file).href;
      this.atLoad = { file, listeners: new Map(this.webContents.listeners), popup: this.webContents.popup };
      loaded();
      // Startup is intentionally held here: the wiring under test happens
      // before load, while later bootstrap would start the Core process.
      return new Promise(() => {});
    }
  }
  const noIO = () => { throw new Error("unexpected fixture I/O"); };
  const fakeFs = {
    existsSync: () => false,
    readFileSync: (file) => {
      if (path.basename(file) === "package.json") return JSON.stringify({ version: "fixture" });
      return noIO();
    },
  };
  const modules = {
    electron: { app, BrowserWindow, ipcMain, Notification: {}, screen: {},
      shell: { openExternal: (url) => { externalUrls.push(url); } }, dialog: {} },
    "node:fs": fakeFs,
    "node:child_process": { spawn: noIO, execFile: noIO },
    "node:net": { createConnection: noIO },
    "./security-policy.cjs": require("../../electron/security-policy.cjs"),
    "./launch-config.cjs": { launchArguments: () => ({}), resolveProfilePaths: () => null, windowsPipeName: (name) => name },
    "./profile-manager.cjs": {},
    "./core-client.cjs": {
      createCoreConnection: () => ({ exchangeVerified: noIO, invoke: noIO }),
      createPendingDecisionNotifier: () => () => {},
    },
    "./window-state.cjs": { loadWindowState: () => ({ bounds: {}, maximized: false }), STATE_FILE: "window-state.json" },
    "./coordinate-service.cjs": require("../../electron/coordinate-service.cjs"),
    "./coordination-scope.cjs": require("../../electron/coordination-scope.cjs"),
    "./coordination-background.cjs": { createBackgroundHost: () => ({
      status: (jobId) => { effects.push(["status", jobId]); return { jobId }; },
      outstanding: (workspaceRoot) => {
        effects.push(["outstanding", workspaceRoot]);
        return false;
      },
    }) },
    "./native-check-host.cjs": { createNativeCheckHost: () => ({}) },
    "./background-send-consent.cjs": { backgroundSendConsent: () => ({ read: () => false }) },
    "./coordination-job.cjs": {},
    "./coordination-record.cjs": require("../../electron/coordination-record.cjs"),
    "./harness-health.cjs": {},
    "./cli-coordinate.cjs": require("../../electron/cli-coordinate.cjs"),
    "./harness-runtime.cjs": { createHarnessRuntime: () => ({ stateDir: "/injected/state", cancel: () => {} }) },
    ...customModules,
  };
  const mainFile = fileURLToPath(new URL("../../electron/main.cjs", import.meta.url));
  const source = readFileSync(mainFile, "utf8");
  const mainRequire = (name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    if (name.startsWith("node:")) return require(name);
    throw new Error(`unexpected main dependency: ${name}`);
  };
  const module = { exports: {} };
  const runMain = vm.runInNewContext(`(function (require, module, exports, __filename, __dirname) {\n${source}\n})`, {
    URL, console, process: { argv: ["electron", mainFile], env: { GOALPORT_ALLOW_MULTI_INSTANCE: "1" },
      platform: "linux", resourcesPath: "/fixture/resources", pid: 1 },
  }, { filename: mainFile });
  runMain(mainRequire, module, module.exports, mainFile, path.dirname(mainFile));
  assert.equal(typeof ready, "function", "main registered its app-ready callback");
  const startup = ready();
  await Promise.race([loadStarted, startup.then(() => { throw new Error("startup ended before window load"); })]);
  return { handlers, win, externalUrls, effects,
    event: { sender: win.webContents, senderFrame: win.webContents.mainFrame } };
}

test("main registers its actual IPC handlers behind the sender gate", async () => {
  const f = await mainWiring();
  for (const channel of ["goalport:app-info", "goalport:core-command", "goalport:background-send-consent", "goalport:background-start", "goalport:native-check", "goalport:background-status", "goalport:background-continue", "goalport:background-revoke", "goalport:background-acknowledge", "goalport:background-release-terminal", "goalport:background-held-workspaces"]) {
    assert.ok(f.handlers.has(channel), `missing ${channel}`);
  }
  const { win, event } = f;
  const contents = win.webContents, mainFrame = contents.mainFrame;
  for (const [channel, invoke] of f.handlers) {
    for (const bad of [null, {}, { sender: {} }, { ...event, sender: {} },
      { ...event, senderFrame: null }, { ...event, senderFrame: { ...mainFrame, detached: true } },
      { ...event, senderFrame: { ...mainFrame, routingId: 8 } },
      { ...event, senderFrame: { ...mainFrame, processId: 5 } },
      { ...event, senderFrame: { ...mainFrame, url: "https://evil.example/" } },
      { ...event, senderFrame: { ...mainFrame, url: "file:///goalport/dist/other.html" } }]) {
      await assert.rejects(async () => invoke(bad), /Untrusted/, channel);
    }
    for (const [target, key, replacement] of [
      [win, "isDestroyed", () => true],
      [contents, "isDestroyed", () => true],
      [contents, "getURL", () => "https://evil.example/"],
    ]) {
      const original = target[key];
      target[key] = replacement;
      try { await assert.rejects(async () => invoke(event), /Untrusted/, channel); }
      finally { target[key] = original; }
    }
  }
  assert.deepEqual(f.effects, []);
  assert.deepEqual(await f.handlers.get("goalport:background-status")(event, "job-1"), { jobId: "job-1" });
  assert.deepEqual(f.effects, [["status", "job-1"]]);
});

test("main protects the actual window before loading the app document", async () => {
  const { win, externalUrls } = await mainWiring();
  assert.equal(path.basename(win.atLoad.file), "index.html");
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(typeof win.atLoad.popup, "function", "popup policy installed before load");
  assert.deepEqual(win.atLoad.popup({ url: "https://external.example/path" }), { action: "deny" });
  assert.deepEqual(win.atLoad.popup({ url: "javascript:alert(1)" }), { action: "deny" });
  for (const name of ["will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview"]) {
    const handler = win.atLoad.listeners.get(name);
    assert.equal(typeof handler, "function", `${name} installed before load`);
    let prevented = false;
    handler({ preventDefault: () => { prevented = true; } }, "https://evil.example/");
    assert.equal(prevented, true, name);
  }
  await Promise.resolve();
  assert.deepEqual(externalUrls, ["https://external.example/path"]);
});

test("popup always denied; only credential-free HTTP(S) reaches system shell", async () => {
  const f = fixture();
  protectRenderer(f.contents, appUrl, (url) => f.opens.push(url));
  for (const url of ["https://external.example/path", "http://external.example/"]) {
    assert.deepEqual(f.contents.popup({ url }), { action: "deny" });
  }
  for (const url of ["javascript:alert(1)", "file:///private", "data:text/html,test", "shell:run", "custom:foo", "about:blank", "https://user:pass@evil.example/", "nonsense"]) {
    assert.equal(externalHttpUrl(url), null);
    assert.deepEqual(f.contents.popup({ url }), { action: "deny" });
  }
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.opens, ["https://external.example/path", "http://external.example/"]);
});

test("renderer main/subframe navigation, redirects and webviews are denied", () => {
  const f = fixture(); protectRenderer(f.contents, appUrl, () => assert.fail());
  for (const name of ["will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview"]) {
    let prevented = 0;
    f.listeners.get(name)({ preventDefault: () => prevented++ }, "https://evil.example/");
    assert.equal(prevented, 1, name);
  }
});

test("app document identity folds Windows drive-path case only", () => {
  for (const [actual, expected, trusted] of documentCases) {
    assert.equal(isAppDocument(actual, expected), trusted, `${actual} against ${expected}`);
  }
});

test("preload exposes bridge only to exact main app document, never external/subframe", () => {
  const code = readFileSync(new URL("../../electron/preload.cjs", import.meta.url), "utf8");
  const cases = [
    ...documentCases.map(([url, expected, trusted]) => [url, true, true, trusted, expected]),
    [appUrl, false, true, false, appUrl],
    [appUrl, true, false, false, appUrl],
  ];
  for (const [url, main, argument, trusted, expected] of cases) {
    const exposed = [];
    const logs = [];
    vm.runInNewContext(code, { URL, location: { href: url }, console: { error: (line) => logs.push(line) },
      process: { isMainFrame: main, argv: argument ? [`--goalport-app-document=${encodeURIComponent(expected)}`] : [] },
      require: () => ({ contextBridge: { exposeInMainWorld: (name) => exposed.push(name) }, ipcRenderer: {} }) });
    assert.equal(exposed.includes("goalportCore"), trusted, `${url}/${main}/${argument}`);
    assert.equal(logs.length, trusted ? 0 : 1, logs.join(" "));
  }
});

test("trusted authorization handler validates optional write through the tested fresh-discovery bridge", async () => {
  const coordinationScope = require("../../electron/coordination-scope.cjs");
  let probes = 0;
  let outstanding = false;
  const f = await mainWiring({
    "./cli-coordinate.cjs": {
      discoverCliProviders: async (options) => {
        probes += 1;
        assert.equal(options.stateDir, "/injected/state");
        return { ok: true, providers: [{ instanceId: "codex", auth: { type: "chatgpt" } }] };
      },
    },
    "./coordination-background.cjs": {
      createBackgroundHost: () => ({
        status: (jobId) => ({ jobId }),
        outstanding: () => outstanding,
      }),
    },
  });

  const authorize = f.handlers.get("goalport:coordination-authorize");
  const query = f.handlers.get("goalport:coordination-scope");
  const revoke = f.handlers.get("goalport:coordination-revoke");
  const payload = { instances: ["codex"], maxTurns: 4, write: { instances: ["codex"], maxTurns: 2, workspaceRoot: "/work/goal" } };
  coordinationScope.revoke();
  try {
    assert.throws(() => authorize({ sender: {} }, payload), /Untrusted/);
    assert.equal(probes, 0);
    const result = await authorize(f.event, payload);
    assert.equal(result.ok, true);
    assert.equal(result.remaining, 4);
    assert.equal(result.writeTurnsRemaining, 2);
    assert.equal(probes, 1);
    assert.deepEqual(query(f.event).write, { instances: ["codex"], maxTurns: 2, remaining: 2, workspaceRoot: "/work/goal" });
    const before = query(f.event);
    const denied = await authorize(f.event, { ...payload, write: { ...payload.write, instances: ["missing"] } });
    assert.equal(denied.ok, false);
    assert.equal(probes, 2);
    assert.deepEqual(query(f.event), before);
    const invalid = await authorize(f.event, { ...payload, write: { ...payload.write, workspaceRoot: "relative" } });
    assert.equal(invalid.ok, false);
    assert.equal(probes, 2);
    assert.deepEqual(query(f.event), before);
    outstanding = true;
    assert.throws(() => authorize(f.event, payload), /outstanding background goal/);
    assert.equal(probes, 2);
    assert.equal(revoke(f.event).ok, true);
    assert.equal(query(f.event), null);
  } finally { coordinationScope.revoke(); }
});

test("trusted preload forwards read-only and explicit-write requests on the same channel unchanged", async () => {
  const code = readFileSync(new URL("../../electron/preload.cjs", import.meta.url), "utf8");
  const exposed = new Map();
  const calls = [];
  vm.runInNewContext(code, {
    URL, location: { href: appUrl }, console,
    process: { isMainFrame: true, argv: [`--goalport-app-document=${encodeURIComponent(appUrl)}`] },
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, bridge) => exposed.set(name, bridge) },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true }; } },
    }),
  });
  const bridge = exposed.get("goalportCore");
  for (const payload of [
    { instances: ["codex"], maxTurns: 4 },
    { instances: ["codex"], maxTurns: 4, write: { instances: ["codex"], maxTurns: 2, workspaceRoot: "/work/goal" } },
  ]) {
    await bridge.coordinationAuthorize(payload);
    assert.equal(calls.at(-1)[0], "goalport:coordination-authorize");
    assert.equal(calls.at(-1)[1], payload);
    assert.equal(calls.at(-1).length, 2);
  }
});

test("coordination launch, authorize and save hand the draft workspace to the outstanding-job guard", async () => {
  const guarded = [];
  let outstanding = false;
  let authorizeCalls = 0;
  let launchCalls = 0;
  let saveCalls = 0;

  const f = await mainWiring({
    "./coordinate-service.cjs": {
      launchOne: (...args) => { launchCalls += 1; return { launched: true, args }; },
      authorizeCoordination: (...args) => { authorizeCalls += 1; return { ok: true, args }; },
    },
    "./cli-coordinate.cjs": {
      discoverCliProviders: async () => ({ ok: true, providers: [{ instanceId: "codex", auth: { type: "chatgpt" } }] }),
    },
    "./coordination-record.cjs": {
      saveRecordAsync: async (...args) => { saveCalls += 1; return { saved: true, args }; },
      readRecords: () => [],
    },
    "./coordination-background.cjs": {
      createBackgroundHost: () => ({
        status: (jobId) => ({ jobId }),
        outstanding: (workspaceRoot) => {
          guarded.push(workspaceRoot);
          return outstanding;
        },
      }),
    },
  });

  const launch = f.handlers.get("goalport:coordinate-launch");
  const authorize = f.handlers.get("goalport:coordination-authorize");
  const save = f.handlers.get("goalport:coordination-save");

  const command = { type: "goalport.coordinateTurn", commandId: "coordinate-plan-fixture" };
  await launch(f.event, command, "generation-1", 7, "/work/draft-goal");
  assert.deepEqual(guarded, ["/work/draft-goal"]);
  assert.equal(launchCalls, 1);
  // A launch without the draft workspace keeps the legacy shape; the guard is
  // still consulted first, with no workspace (the guard fails closed).
  await launch(f.event, command, "generation-1");
  assert.deepEqual(guarded, ["/work/draft-goal", undefined]);
  assert.equal(launchCalls, 2);

  await authorize(f.event, { instances: ["codex"], maxTurns: 4, workspaceRoot: "/work/draft-goal" });
  assert.deepEqual(guarded.at(-1), "/work/draft-goal");
  assert.equal(authorizeCalls, 1);
  // Read-only authorize payloads without the draft field keep the write
  // binding as their workspace fact; with neither, the guard sees none.
  await authorize(f.event, { instances: ["codex"], maxTurns: 4, write: { instances: ["codex"], maxTurns: 2, workspaceRoot: "/work/draft-goal" } });
  assert.deepEqual(guarded.at(-1), "/work/draft-goal");
  assert.equal(authorizeCalls, 2);
  await authorize(f.event, { instances: ["codex"], maxTurns: 4 });
  assert.deepEqual(guarded.at(-1), undefined);
  assert.equal(authorizeCalls, 3);

  const saved = await save(f.event, { requestId: "r1", workspacePath: "/work/draft-goal", goal: "g" });
  assert.equal(saved.saved, true);
  assert.deepEqual(guarded.at(-1), "/work/draft-goal");
  assert.equal(saveCalls, 1);

  // A raised guard refuses BEFORE any authorization, launch or save happens.
  outstanding = true;
  assert.throws(() => launch(f.event, command, "generation-1", 7, "/work/draft-goal"), /outstanding background goal/);
  assert.throws(() => authorize(f.event, { instances: ["codex"], maxTurns: 4, workspaceRoot: "/work/draft-goal" }), /outstanding background goal/);
  assert.throws(() => save(f.event, { requestId: "r1", workspacePath: "/work/draft-goal", goal: "g" }), /outstanding background goal/);
  assert.equal(launchCalls, 2);
  assert.equal(authorizeCalls, 3);
  assert.equal(saveCalls, 1);
});
