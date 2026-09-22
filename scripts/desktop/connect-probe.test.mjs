import assert from "node:assert/strict";
import test from "node:test";
import { uiConnectionState, connectedUiExpression } from "./connect-probe.mjs";

// Pins the smoke's connect-wait contract: the app-published
// .goalport-shell[data-connection] state decides, and the visible body text
// is only a fallback (CSS hides it on narrow viewports such as the GitHub
// runner's virtual display, where innerText never contains it).

test("the app-published shell connection state alone satisfies the probe", () => {
  assert.equal(uiConnectionState({ shellConnection: "connected", bodyText: "" }), true);
  assert.equal(uiConnectionState({ shellConnection: "connected", bodyText: null }), true);
  // The exact runner failure shape: the app IS connected, the pill text is
  // CSS-hidden, so innerText carries nothing.
  assert.equal(uiConnectionState({ shellConnection: "connected", bodyText: "GoalPort" }), true);
});

test("visible body text stays a working fallback signal", () => {
  assert.equal(uiConnectionState({ shellConnection: null, bodyText: "Core connected" }), true);
  assert.equal(uiConnectionState({ shellConnection: "disconnected", bodyText: "… Core connected …" }), true);
});

test("neither signal means still waiting — never a false positive", () => {
  assert.equal(uiConnectionState({ shellConnection: null, bodyText: "" }), false);
  assert.equal(uiConnectionState({ shellConnection: "disconnected", bodyText: "GoalPort" }), false);
  assert.equal(uiConnectionState({ shellConnection: undefined, bodyText: "Starting GoalPort" }), false);
});

test("the CDP expression probes the published attribute first and the body text second", () => {
  const expression = connectedUiExpression();
  assert.match(expression, /\.goalport-shell/);
  assert.match(expression, /dataset\?\.connection/);
  assert.match(expression, /innerText/);
  assert.match(expression, /"Core connected"/);
  // The serialized page probe embeds the SAME decision function the unit
  // tests exercise, so the contract cannot drift between test and driver.
  assert.ok(expression.includes(uiConnectionState.toString().slice(0, 60)));
  new Function(`return ${expression}`); // syntactically valid JavaScript for evaluate
});
