// Local, no-network Electron integration fixture. Uses the production policy
// and preload; the OS browser is replaced by a recording dependency.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { once } = require("node:events");
const { protectRenderer, createTrustedIpcHandler } = require("../../electron/security-policy.cjs");
const out = process.argv.find((arg) => arg.startsWith("--fixture-out="))?.slice(14);
if (!out || !path.isAbsolute(out)) throw new Error("absolute fixture output required");
app.setPath("userData", path.join(out, "browser"));
const report = { passed: false, assertions: [], externalUrls: [], unexpectedWindows: 0 };
let mainWindow;
app.whenReady().then(async () => {
  const file = path.join(out, "index.html");
  fs.writeFileSync(file, '<!doctype html><title>Local security fixture</title><body>Fixture</body>');
  const appUrl = pathToFileURL(file).href;
  const prefs = { preload: path.resolve(__dirname, "../../electron/preload.cjs"), contextIsolation: true,
    sandbox: true, nodeIntegration: false, additionalArguments: [`--goalport-app-document=${encodeURIComponent(appUrl)}`] };
  mainWindow = new BrowserWindow({ show: false, webPreferences: prefs });
  let accepted = 0;
  createTrustedIpcHandler(ipcMain, () => mainWindow, appUrl)("goalport:core-command", () => { accepted++; return { accepted: true }; });
  protectRenderer(mainWindow.webContents, appUrl, (url) => report.externalUrls.push(url));
  mainWindow.webContents.on("did-create-window", () => report.unexpectedWindows++);
  await mainWindow.loadFile(file);
  assert.equal(await mainWindow.webContents.executeJavaScript("Boolean(window.goalportCore)"), true);
  await mainWindow.webContents.executeJavaScript("window.goalportCore.command({})");
  assert.equal(accepted, 1);
  report.assertions.push("real main-frame IPC accepted");
  await mainWindow.webContents.executeJavaScript(`
    window.open('https://evil.example/window-open');
    const link = document.createElement('a'); link.href = 'https://evil.example/markdown'; link.target = '_blank'; link.rel = 'noopener noreferrer'; document.body.append(link); link.click();
    for (const url of ['javascript:alert(1)', 'file:///private', 'data:text/html,untrusted', 'shell:run', 'custom:foo']) window.open(url);
  `);
  // Give browser events a turn; timeout is a fixture scheduling bound, not a
  // relaxation of product startup or a network request.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(report.externalUrls.sort(), ['https://evil.example/markdown', 'https://evil.example/window-open']);
  assert.equal(report.unexpectedWindows, 0);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  report.assertions.push("window.open and target=_blank never create app window; only HTTP(S) shell spy called");
  let navigations = 0;
  mainWindow.webContents.on("will-frame-navigate", () => navigations++);
  await mainWindow.webContents.executeJavaScript(`{ const navigationLink = document.createElement('a'); navigationLink.href = 'https://evil.example/navigation'; document.body.append(navigationLink); navigationLink.click(); }`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(navigations > 0);
  assert.equal(mainWindow.webContents.getURL(), appUrl);
  report.assertions.push("real main-frame external navigation prevented");
  // Deliberately give a foreign window the genuine app file + preload: even
  // this stronger-than-external attacker cannot invoke privileged IPC.
  const foreign = new BrowserWindow({ show: false, webPreferences: prefs });
  await foreign.loadFile(file);
  assert.equal(await foreign.webContents.executeJavaScript("Boolean(window.goalportCore)"), true);
  const denied = await foreign.webContents.executeJavaScript("window.goalportCore.command({}).then(() => false, () => true)");
  assert.equal(denied, true);
  assert.equal(accepted, 1);
  report.assertions.push("foreign WebContents with genuine bridge denied before handler effect");
  await foreign.loadURL("data:text/html,<title>Untrusted</title>");
  assert.equal(await foreign.webContents.executeJavaScript("Boolean(window.goalportCore)"), false);
  report.assertions.push("untrusted document receives no production preload bridge");
  foreign.destroy();
  // Force preload into subframes in a separate test-only window; production
  // does not enable nodeIntegrationInSubFrames. The preload still fails closed.
  const subframe = new BrowserWindow({ show: false, webPreferences: { ...prefs, nodeIntegrationInSubFrames: true } });
  await subframe.loadFile(file);
  const subBridge = await subframe.webContents.executeJavaScript(`new Promise(resolve => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(appUrl)}; frame.onload = () => resolve(Boolean(frame.contentWindow.goalportCore)); document.body.append(frame); })`);
  assert.equal(subBridge, false);
  subframe.destroy();
  report.assertions.push("same-document subframe receives no preload bridge");
  await mainWindow.webContents.executeJavaScript("location.hash = 'local-anchor'; window.goalportCore.command({})");
  assert.equal(accepted, 2);
  const reloaded = once(mainWindow.webContents, "did-finish-load");
  mainWindow.webContents.reload();
  await reloaded;
  await mainWindow.webContents.executeJavaScript("window.goalportCore.command({})");
  assert.equal(accepted, 3);
  report.assertions.push("main reload and local anchor retain trusted IPC");
  report.passed = true;
}).catch((error) => { report.error = String(error.stack || error); }).finally(() => {
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  app.exit(report.passed ? 0 : 1);
});
