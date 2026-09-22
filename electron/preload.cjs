const { contextBridge, ipcRenderer } = require("electron");
const requestId = () => `desktop-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Defense in depth: even an accidentally reused preload exposes nothing in a
// popup/subframe or any document other than the main process's exact app file.
const expectedArgument = process.argv.find((arg) => arg.startsWith("--goalport-app-document="));
let trustedDocument = false;
try {
  const expected = new URL(decodeURIComponent(expectedArgument?.slice("--goalport-app-document=".length) || ""));
  const actual = new URL(globalThis.location.href);
  actual.hash = "";
  trustedDocument = process.isMainFrame === true && expected.protocol === "file:" && actual.href === expected.href;
} catch { /* Missing or malformed identity fails closed. */ }

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
