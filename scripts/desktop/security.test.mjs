import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const { externalHttpUrl, createTrustedIpcHandler, protectRenderer, isAppDocument } = require("../../electron/security-policy.cjs");
const appUrl = "file:///goalport/dist/index.html";

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

test("every real IPC channel uses one fail-closed sender gate", () => {
  const source = readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ipcMain\.handle\(/);
  const channels = [...source.matchAll(/handleTrusted\("([^"]+)"/g)].map((m) => m[1]);
  assert.equal(channels.length, 11);
  for (const channel of channels) {
    const f = fixture(); let calls = 0;
    f.handle(channel, () => ++calls);
    const invoke = f.handlers.get(channel);
    for (const bad of [null, {}, { sender: {} }, { ...f.event, sender: {} },
      { ...f.event, senderFrame: null }, { ...f.event, senderFrame: { ...f.mainFrame, detached: true } },
      { ...f.event, senderFrame: { ...f.mainFrame, routingId: 8 } },
      { ...f.event, senderFrame: { ...f.mainFrame, processId: 5 } },
      { ...f.event, senderFrame: { ...f.mainFrame, url: "https://evil.example/" } },
      { ...f.event, senderFrame: { ...f.mainFrame, url: "file:///goalport/dist/other.html" } }]) {
      assert.throws(() => invoke(bad), /Untrusted/, channel);
    }
    assert.equal(calls, 0);
    assert.equal(invoke(f.event), 1, channel);
    f.win.isDestroyed = () => true;
    assert.throws(() => invoke(f.event), /Untrusted/);
    f.win.isDestroyed = () => false;
    f.contents.isDestroyed = () => true;
    assert.throws(() => invoke(f.event), /Untrusted/);
    f.contents.isDestroyed = () => false;
    f.contents.getURL = () => "https://evil.example/";
    assert.throws(() => invoke(f.event), /Untrusted/);
    assert.equal(calls, 1);
  }
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

test("renderer main/subframe navigation, redirects and webviews are denied before load", () => {
  const f = fixture(); protectRenderer(f.contents, appUrl, () => assert.fail());
  for (const name of ["will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview"]) {
    let prevented = 0;
    f.listeners.get(name)({ preventDefault: () => prevented++ }, "https://evil.example/");
    assert.equal(prevented, 1, name);
  }
  const main = readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
  assert.ok(main.indexOf("protectRenderer(mainWindow.webContents") < main.indexOf("await mainWindow.loadFile"));
});

test("app document identity folds only the Windows drive letter", () => {
  const app = "file:///C:/GoalPort/dist/index.html";
  assert.equal(isAppDocument("file:///c:/GoalPort/dist/index.html", app), true);
  assert.equal(isAppDocument(`${app}#local-anchor`, app), true);
  assert.equal(isAppDocument("file://localhost/C:/GoalPort/dist/index.html", app), true);
  assert.equal(isAppDocument("file:///C:/goalport/dist/index.html", app), false);
  assert.equal(isAppDocument("file:///C:/GoalPort/dist/other.html", app), false);
  assert.equal(isAppDocument(`${app}?next=1`, app), false);
  assert.equal(isAppDocument("file:///C:/GoalPort/dist/index.html%2Fsecret", app), false);
  assert.equal(isAppDocument("file:///C:/foo%2Fbar", "file:///C:/foo/bar"), false);
  assert.equal(isAppDocument("file://server/share/index.html", app), false);
  assert.equal(isAppDocument("file://remote/C:/GoalPort/dist/index.html", app), false);
  assert.equal(isAppDocument("https://evil.example/index.html", app), false);
  assert.equal(isAppDocument("file:///goalport/dist/Index.html", "file:///goalport/dist/index.html"), false);
  assert.equal(isAppDocument("not a url", app), false);
  assert.equal(isAppDocument("file:///C:/GoalPort/dist/index.html", "://bad"), false);
});

test("preload exposes bridge only to exact main app document, never external/subframe", () => {
  const code = readFileSync(new URL("../../electron/preload.cjs", import.meta.url), "utf8");
  const policy = readFileSync(new URL("../../electron/security-policy.cjs", import.meta.url), "utf8");
  const key = (source) => source.slice(source.indexOf("function appDocumentKey(href) {"), source.indexOf("\n}", source.indexOf("function appDocumentKey(href) {")) + 2);
  assert.equal(key(code).replace(/\r\n/g, "\n"), key(policy).replace(/\r\n/g, "\n"));
  for (const [url, main, argument, trusted, expected] of [
    [appUrl, true, true, true], [appUrl + "#anchor", true, true, true],
    [appUrl, false, true, false], ["https://evil.example/", true, true, false],
    ["file:///other.html", true, true, false], [appUrl, true, false, false],
    ["file:///c:/GoalPort/dist/index.html", true, true, true, "file:///C:/GoalPort/dist/index.html"],
    ["file:///C:/GoalPort/dist/index.html#anchor", true, true, true, "file:///C:/GoalPort/dist/index.html"],
    ["file:///C:/goalport/dist/index.html", true, true, false, "file:///C:/GoalPort/dist/index.html"],
    ["file:///C:/GoalPort/dist/index.html?next=1", true, true, false, "file:///C:/GoalPort/dist/index.html"],
    ["file://server/share/index.html", true, true, false, "file:///C:/GoalPort/dist/index.html"],
    ["file://remote/C:/GoalPort/dist/index.html", true, true, false, "file:///C:/GoalPort/dist/index.html"],
    ["https://evil.example/", true, true, false, "file:///C:/GoalPort/dist/index.html"],
    ["file:///C:/GoalPort/dist/other.html", true, true, false, "file:///C:/GoalPort/dist/index.html"]
  ]) {
    const exposed = [];
    const logs = [];
    vm.runInNewContext(code, { URL, location: { href: url }, console: { error: (line) => logs.push(line) },
      process: { isMainFrame: main, argv: argument ? [`--goalport-app-document=${encodeURIComponent(expected || appUrl)}`] : [] },
      require: () => ({ contextBridge: { exposeInMainWorld: (name) => exposed.push(name) }, ipcRenderer: {} }) });
    assert.equal(exposed.includes("goalportCore"), trusted, `${url}/${main}/${argument}`);
    assert.equal(logs.length, trusted ? 0 : 1, logs.join(" "));
  }
});
