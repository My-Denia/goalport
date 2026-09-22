// The local main renderer is the only principal allowed to use the bridge.
// Runtime text, subframes, popups and other WebContents are not principals.
// Identity of one local app file. Fragment is ignored. Query is part of the
// identity. Only an empty host is local: the URL parser already folds
// localhost into that form, and any surviving host (UNC or remote) is rejected.
// The only case fold is the Windows drive letter. The rest of the path,
// including percent-encoded separators, stays as the URL serializer stored it.
// Kept in lockstep with the copy in preload.cjs (sandbox cannot require this file).
function appDocumentKey(href) {
  const url = new URL(href);
  if (url.protocol !== "file:") return null;
  if (url.username || url.password || url.hostname) return null;
  url.hash = "";
  const drive = url.pathname.match(/^\/([A-Za-z])(:.*)$/);
  if (drive) url.pathname = `/${drive[1].toLowerCase()}${drive[2]}`;
  return url.href;
}

function isAppDocument(value, appUrl) {
  try {
    const actual = appDocumentKey(value);
    return actual !== null && actual === appDocumentKey(appUrl);
  } catch { return false; }
}

function externalHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function requireMainWindowSender(event, getMainWindow, appUrl) {
  try {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) throw new Error();
    const contents = win.webContents;
    const frame = event?.senderFrame;
    const mainFrame = contents.mainFrame;
    if (contents.isDestroyed() || event?.sender !== contents || !frame || frame.detached || !mainFrame || mainFrame.detached
      || !Number.isInteger(frame.processId) || !Number.isInteger(frame.routingId)
      || frame.processId !== mainFrame.processId || frame.routingId !== mainFrame.routingId
      || !isAppDocument(frame.url, appUrl) || !isAppDocument(contents.getURL(), appUrl)) throw new Error();
    return contents;
  } catch { throw new Error("Untrusted GoalPort IPC sender"); }
}

function createTrustedIpcHandler(ipcMain, getMainWindow, appUrl) {
  return (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    requireMainWindowSender(event, getMainWindow, appUrl);
    return handler(event, ...args);
  });
}

function protectRenderer(contents, appUrl, openExternal) {
  const openHttp = (value) => {
    const url = externalHttpUrl(value);
    if (url) Promise.resolve().then(() => openExternal(url)).catch(() => { /* OS refusal grants no app capability. */ });
  };
  contents.setWindowOpenHandler(({ url }) => {
    openHttp(url);
    return { action: "deny" };
  });
  // Renderer navigation is never used to load app documents. Initial load and
  // reload are main-process operations. Deny even alternate local files.
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  return { appUrl };
}

module.exports = { isAppDocument, externalHttpUrl, requireMainWindowSender, createTrustedIpcHandler, protectRenderer };
