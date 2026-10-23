import assert from "node:assert/strict";
import test from "node:test";
import { clickPointFor, firstVisible } from "./click-target.mjs";

function target({ rect = { x: 10, y: 20, width: 100, height: 40 }, disabled = false, hit = "self" } = {}) {
  const child = {};
  const element = {
    disabled,
    getAttribute: () => null,
    getBoundingClientRect: () => rect,
    contains: (value) => value === child,
    ownerDocument: {
      defaultView: { innerWidth: 1440, innerHeight: 900 },
      elementFromPoint: () => hit === "self" ? element : hit === "child" ? child : {}
    }
  };
  return element;
}

test("a zero-size menu clone does not hide the visible option", () => {
  const hidden = target({ rect: { x: 0, y: 0, width: 0, height: 0 } });
  const visible = target();
  assert.equal(firstVisible([hidden, visible]), visible);
  assert.equal(firstVisible([hidden]), null);
});

test("click point must hit the intended control or one of its children", () => {
  assert.deepEqual(clickPointFor(target()), { x: 60, y: 40 });
  assert.deepEqual(clickPointFor(target({ hit: "child" })), { x: 60, y: 40 });
  assert.throws(() => clickPointFor(target({ hit: "overlay" })), /hidden or occluded/);
});

test("missing, disabled, hidden and offscreen controls cannot become mouse input", () => {
  assert.throws(() => clickPointFor(null), /missing/);
  assert.throws(() => clickPointFor(target({ disabled: true })), /disabled/);
  assert.throws(() => clickPointFor(target({ rect: { x: 0, y: 0, width: 0, height: 0 } })), /no visible area/);
  assert.throws(() => clickPointFor(target({ rect: { x: 1500, y: 20, width: 100, height: 40 } })), /outside the viewport/);
  assert.throws(() => clickPointFor(target({ rect: { x: Number.NaN, y: 20, width: 100, height: 40 } })), /no visible area/);
});
