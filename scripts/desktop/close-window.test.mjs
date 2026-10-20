import assert from "node:assert/strict";
import test from "node:test";
import { createCdpClient } from "../connected/v1-cdp.mjs";
import { isExpectedCloseTeardownError, performCloseWindow } from "./close-window-helper.mjs";

class MockSocket {
  readyState = 1;
  listeners = new Map();
  sent = [];
  addEventListener(kind, listener) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, new Set());
    this.listeners.get(kind).add(listener);
  }
  removeEventListener(kind, listener) {
    this.listeners.get(kind)?.delete(listener);
  }
  emit(kind, event = {}) {
    for (const listener of [...(this.listeners.get(kind) || [])]) listener(event);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  reply(id, result, error) {
    this.emit("message", { data: JSON.stringify({ id, result, error }) });
  }
}

test("isExpectedCloseTeardownError strictly accepts eventType === 'mouseReleased' and rejects 'mousePressed'", () => {
  const validRelease = {
    method: "Input.dispatchMouseEvent",
    eventType: "mouseReleased",
    requestSent: true,
    transportClosed: true,
  };
  assert.equal(isExpectedCloseTeardownError(validRelease), true);

  // COUNTEREXAMPLE: failure during mousePressed MUST NOT be accepted as close teardown
  const pressError = {
    method: "Input.dispatchMouseEvent",
    eventType: "mousePressed",
    requestSent: true,
    transportClosed: true,
  };
  assert.equal(isExpectedCloseTeardownError(pressError), false);

  // Evaluate or other methods must reject
  assert.equal(isExpectedCloseTeardownError({ ...validRelease, method: "Runtime.evaluate" }), false);

  // Closed before send must reject
  assert.equal(isExpectedCloseTeardownError({ ...validRelease, requestSent: false, alreadyClosed: true }), false);

  // Send failure must reject
  assert.equal(isExpectedCloseTeardownError({ ...validRelease, sendFailed: true }), false);

  // Timeout must reject
  assert.equal(isExpectedCloseTeardownError({ ...validRelease, isTimeout: true }), false);
});

test("COUNTEREXAMPLE REPRODUCER: performCloseWindow fails closed if transport closes during mousePressed", async () => {
  const ws = new MockSocket();
  const client = createCdpClient(ws);
  const fakeChild = { exitCode: 0, signalCode: null }; // child exits 0
  let clicked = 0;

  try {
    await performCloseWindow({
      click: async (selector, text, opts = {}) => {
        if (++clicked === 1) return; // App menu opens
        // Dispatch mousePressed, and socket closes while mousePressed is in flight
        const press = client.cdp("Input.dispatchMouseEvent", { type: "mousePressed" });
        queueMicrotask(() => ws.close());
        try {
          await press;
        } catch (error) {
          // If caller checks allowCloseTeardown, verify it rejects
          if (opts.allowCloseTeardown && isExpectedCloseTeardownError(error)) {
            return;
          }
          throw error;
        }
      },
      until: async (desc, fn) => {
        if (!fn()) throw new Error("until condition not met");
      },
      read: async () => true,
      body: async () => "",
      child: fakeChild,
      sleep: async () => {},
      timeoutMs: 100,
    });
    assert.fail("performCloseWindow must REJECT when transport closes during mousePressed");
  } catch (error) {
    assert.match(error.message, /CDP WebSocket closed/);
  } finally {
    client.close();
  }
});

test("SUCCESS PATH: performCloseWindow succeeds when mouseReleased is closed in-flight and child exits 0", async () => {
  const ws = new MockSocket();
  const client = createCdpClient(ws);
  const fakeChild = { exitCode: null, signalCode: null };
  let clicked = 0;

  const closePromise = performCloseWindow({
    click: async (selector, text, opts = {}) => {
      if (++clicked === 1) return; // App menu
      // mousePressed succeeds
      const press = client.cdp("Input.dispatchMouseEvent", { type: "mousePressed" });
      ws.reply(1, {});
      await press;

      // mouseReleased is sent, then socket closes in flight
      const release = client.cdp("Input.dispatchMouseEvent", { type: "mouseReleased" });
      setTimeout(() => {
        ws.close();
        fakeChild.exitCode = 0; // Child exits cleanly after window close
      }, 5);
      try {
        await release;
      } catch (error) {
        if (opts.allowCloseTeardown && isExpectedCloseTeardownError(error)) {
          return;
        }
        throw error;
      }
    },
    until: async (desc, fn, timeoutMs = 1000) => {
      const deadline = Date.now() + timeoutMs;
      while (!fn()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${desc}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    read: async () => true,
    body: async () => "",
    child: fakeChild,
    sleep: async () => {},
    timeoutMs: 1000,
  });

  await closePromise;
  assert.equal(fakeChild.exitCode, 0);
  client.close();
});

test("performCloseWindow fails closed if child exits nonzero after mouseReleased teardown", async () => {
  const ws = new MockSocket();
  const client = createCdpClient(ws);
  const fakeChild = { exitCode: null, signalCode: null };
  let clicked = 0;

  await assert.rejects(
    performCloseWindow({
      click: async (selector, text, opts = {}) => {
        if (++clicked === 1) return;
        const press = client.cdp("Input.dispatchMouseEvent", { type: "mousePressed" });
        ws.reply(1, {});
        await press;

        const release = client.cdp("Input.dispatchMouseEvent", { type: "mouseReleased" });
        setTimeout(() => {
          ws.close();
          fakeChild.exitCode = 1; // Child exits with error code 1!
        }, 5);
        try {
          await release;
        } catch (error) {
          if (opts.allowCloseTeardown && isExpectedCloseTeardownError(error)) {
            return;
          }
          throw error;
        }
      },
      until: async (desc, fn, timeoutMs = 200) => {
        const deadline = Date.now() + timeoutMs;
        while (!fn()) {
          if (Date.now() > deadline) throw new Error(`Timed out: ${desc}`);
          await new Promise((r) => setTimeout(r, 5));
        }
      },
      read: async () => true,
      body: async () => "",
      child: fakeChild,
      sleep: async () => {},
      timeoutMs: 200,
    }),
    /Timed out: Electron clean close/
  );

  client.close();
});

test("performCloseWindow fails closed if child hangs (never exits)", async () => {
  const ws = new MockSocket();
  const client = createCdpClient(ws);
  const fakeChild = { exitCode: null, signalCode: null }; // Never exits
  let seq = 0;

  await assert.rejects(
    performCloseWindow({
      click: async (selector, text, opts = {}) => {
        const press = client.cdp("Input.dispatchMouseEvent", { type: "mousePressed" });
        ws.reply(++seq, {});
        await press;
        const release = client.cdp("Input.dispatchMouseEvent", { type: "mouseReleased" });
        ws.reply(++seq, {});
        await release;
      },
      until: async (desc, fn, timeoutMs = 50) => {
        const deadline = Date.now() + timeoutMs;
        while (!fn()) {
          if (Date.now() > deadline) throw new Error(`Timed out: ${desc}`);
          await new Promise((r) => setTimeout(r, 5));
        }
      },
      read: async () => true,
      body: async () => "",
      child: fakeChild,
      sleep: async () => {},
      timeoutMs: 50,
    }),
    /Timed out: Electron clean close/
  );

  client.close();
});
