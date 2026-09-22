const { contextBridge, ipcRenderer } = require("electron");
const requestId = () => `desktop-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Defense in depth: even an accidentally reused preload exposes nothing in a
// popup/subframe or any document other than the main process's exact app file.
// Identity of one local app file. Fragment is ignored. Query is part of the
// identity. Only an empty host is local: the URL parser already folds
// localhost into that form, and any surviving host (UNC or remote) is rejected.
// A Windows drive path is compared case-insensitively because CI showed
// Chromium and Node spelling the same file with different case in more than
// the drive letter. Percent-encoded separators are not decoded.
// Kept in lockstep with appDocumentKey in security-policy.cjs (sandbox cannot require it).
function appDocumentKey(href) {
  const url = new URL(href);
  if (url.protocol !== "file:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host && host !== "localhost") return null;
  let pathname = url.pathname.replace(/%(?!2[fF]|5[cC])[0-9a-fA-F]{2}/g, (token) => {
    try { return decodeURIComponent(token); } catch { return token; }
  });
  const drive = pathname.match(/^\/([A-Za-z])(:.*)$/);
  if (drive) pathname = `/${drive[1].toLowerCase()}${drive[2].toLowerCase()}`;
  return `file://${pathname}${url.search}`;
}
const expectedHrefs = process.argv
  .filter((arg) => arg.startsWith("--goalport-app-document="))
  .map((arg) => { try { return decodeURIComponent(arg.slice("--goalport-app-document=".length)); } catch { return ""; } })
  .filter(Boolean);
let trustedDocument = false;
let gate = "no-argument";
try {
  if (process.isMainFrame !== true) gate = "not-main-frame";
  else if (expectedHrefs.length === 0) gate = "no-argument";
  else {
    const actual = appDocumentKey(globalThis.location.href);
    trustedDocument = actual !== null && expectedHrefs.some((href) => appDocumentKey(href) === actual);
    gate = trustedDocument ? "ok" : "href-mismatch";
  }
} catch { gate = "malformed"; trustedDocument = false; }
if (!trustedDocument) console.error(`goalport-preload-gate:${gate}`);

if (trustedDocument) {
contextBridge.exposeInMainWorld("__GOALPORT_ELECTRON__", true);
contextBridge.exposeInMainWorld("goalportCore", {
  appInfo: () => ipcRenderer.invoke("goalport:app-info"),
  chooseWorkspace: () => ipcRenderer.invoke("goalport:choose-workspace"),
  snapshot: () => ipcRenderer.invoke("goalport:core-snapshot", {
    protocolVersion: "goalport.ipc.v2",
    requestId: requestId(),
    entityVersion: 0,
    messageType: "snapshot",
    payload: {}
  }),
  command: (request) => ipcRenderer.invoke("goalport:core-command", request),
  startCore: () => ipcRenderer.invoke("goalport:start-core"),
  openInVsCode: (workspaceRoot) => ipcRenderer.invoke("goalport:open-vscode", workspaceRoot),
  requestClose: () => ipcRenderer.invoke("goalport:request-close"),
  confirmCloseChoice: (payload) => ipcRenderer.invoke("goalport:confirm-close-choice", payload),
  dismissCloseChoice: () => ipcRenderer.invoke("goalport:dismiss-close-choice"),
  onClosePrompt: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("goalport:close-prompt", listener);
    return () => ipcRenderer.removeListener("goalport:close-prompt", listener);
  },
  bootstrapCurrent: () => ipcRenderer.invoke("goalport:bootstrap-current"),
  bootstrapAction: (payload) => ipcRenderer.invoke("goalport:bootstrap-action", payload),
  onBootstrapState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("goalport:bootstrap-state", listener);
    return () => ipcRenderer.removeListener("goalport:bootstrap-state", listener);
  },
  onCloseChoiceFailed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("goalport:close-choice-failed", listener);
    return () => ipcRenderer.removeListener("goalport:close-choice-failed", listener);
  }
});
}
