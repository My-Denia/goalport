import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { uiConnectionState, connectedUiExpression } from "./connect-probe.mjs";

for (const state of ["connected", "disconnected", "connecting", "unavailable", null, undefined]) {
  test(`published connection state ${String(state)} controls both probes`, () => {
    const bodyText = "Core connected yesterday. Current connection lost.";
    const expected = state === "connected";
    assert.equal(uiConnectionState({ shellConnection: state, bodyText }), expected);
    const document = {
      querySelector(selector) {
        assert.equal(selector, ".goalport-shell");
        return state == null ? null : { dataset: { connection: state } };
      },
      body: { innerText: bodyText },
    };
    assert.equal(vm.runInNewContext(connectedUiExpression(), { document }), expected);
  });
}

test("connected shell works without visible status text", () => {
  const document = { querySelector: () => ({ dataset: { connection: "connected" } }) };
  assert.equal(vm.runInNewContext(connectedUiExpression(), { document }), true);
});
