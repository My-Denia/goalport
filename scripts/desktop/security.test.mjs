import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const { externalHttpUrl, createTrustedIpcHandler, protectRenderer } = require("../../electron/security-policy.cjs");
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

test("preload exposes bridge only to exact main app document, never external/subframe", () => {
  const code = readFileSync(new URL("../../electron/preload.cjs", import.meta.url), "utf8");
  for (const [url, main, argument, trusted] of [
    [appUrl, true, true, true], [appUrl + "#anchor", true, true, true],
    [appUrl, false, true, false], ["https://evil.example/", true, true, false],
    ["file:///other.html", true, true, false], [appUrl, true, false, false]
  ]) {
    const exposed = [];
    vm.runInNewContext(code, { URL, location: { href: url },
      process: { isMainFrame: main, argv: argument ? [`--goalport-app-document=${encodeURIComponent(appUrl)}`] : [] },
      require: () => ({ contextBridge: { exposeInMainWorld: (name) => exposed.push(name) }, ipcRenderer: {} }) });
    assert.equal(exposed.includes("goalportCore"), trusted, `${url}/${main}/${argument}`);
  }
});
