# Electron renderer trust boundary

The trusted principal is the current main GoalPort window, showing the exact
local `dist/index.html` document. Runtime-authored Markdown, external pages,
other BrowserWindows and every subframe are untrusted.

`electron/security-policy.cjs` owns the boundary. Every IPC registration in
`main.cjs` uses `createTrustedIpcHandler`, including snapshots and diagnostics.
Before invoking a handler it requires a live main window and WebContents,
identical `event.sender`, a live sender frame matching the main frame's process
and routing IDs, and the expected local document URL on both frame and contents.
Missing, detached, destroyed, foreign or externally navigated senders fail closed.
The gate runs before any filesystem, Core, dialog or shell side effect.

The production preload exposes its narrow bridge only in the main frame at the
exact app document supplied by the main process. This is defense in depth; the
main-process gate remains authoritative even if another window obtains a bridge.
Node integration is disabled; context isolation and sandboxing remain enabled.

Before the first document load, `protectRenderer` installs a window-open handler
that always denies creation. HTTP/HTTPS links are parsed with `new URL`, require
a hostname and no credentials, and are passed to `shell.openExternal`. All other
schemes, malformed URLs and credential-bearing URLs are refused. No external URL
is loaded into an app-owned window. Runtime Markdown renders only these safe
HTTP/HTTPS anchors with `target="_blank"` and `rel="noreferrer noopener"`.

Renderer-initiated main-frame and subframe navigation, redirects and webview
attachment are denied. The main process alone loads the app file. Normal reload
revalidates the current main frame rather than trusting a stale frame object.

`scripts/desktop/security.test.mjs` checks the full IPC inventory and positive
and negative sender controls, URL policy, navigation and preload exposure.
`security-live.mjs` runs real Electron with the production policy/preload in a
local fixture: popup and target-blank behavior, navigation, forced foreign-window
bridge calls, untrusted documents, subframes and reload. It records shell calls
without visiting an external website or launching the system browser. These
checks prove the shell boundary, not native provider admission or final owner UI
acceptance.
