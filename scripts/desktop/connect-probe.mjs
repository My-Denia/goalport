// Connection probe for the packaged smoke driver.
//
// The CONTRACT the smoke waits on is the application's PUBLISHED connection
// state — the `data-connection` attribute the renderer sets on
// `.goalport-shell` from every Core snapshot (src/App.tsx) — not
// CSS-dependent text. styles.css hides `.connection-pill .connection-text`
// below 1020px-wide viewports (and the whole pill below 560px), so on a
// small virtual display such as the GitHub runner's, `innerText` never
// contains "Core connected" even while the app IS connected; a wait on that
// text alone can never succeed there. The visible body text stays in the
// decision only as a FALLBACK signal (satisfying either one is enough).

/** Pure decision: app-published shell state first, visible text as fallback. */
export function uiConnectionState({ shellConnection, bodyText }) {
  if (shellConnection === "connected") return true;
  return String(bodyText || "").includes("Core connected");
}

/**
 * Serialized for CDP `page.evaluate`: runs the SAME exported decision inside
 * the page against the live DOM, so the unit-tested logic and the probe the
 * driver executes cannot drift apart.
 */
export function connectedUiExpression() {
  return `Boolean((${uiConnectionState.toString()})({ shellConnection: document.querySelector('.goalport-shell')?.dataset?.connection ?? null, bodyText: document.body ? document.body.innerText : "" }))`;
}
