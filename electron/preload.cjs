const { contextBridge, ipcRenderer } = require("electron");
const requestId = () => `desktop-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;

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
  onCloseChoiceFailed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("goalport:close-choice-failed", listener);
    return () => ipcRenderer.removeListener("goalport:close-choice-failed", listener);
  }
});
