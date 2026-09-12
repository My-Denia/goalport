import assert from "node:assert/strict";
import test from "node:test";
import { createCdpClient, waitForWebSocketOpen } from "./v1-cdp.mjs";

class Socket {
  readyState = 1;
  listeners = new Map();
  sent = [];
  addEventListener(kind, listener) { if (!this.listeners.has(kind)) this.listeners.set(kind, new Set()); this.listeners.get(kind).add(listener); }
  removeEventListener(kind, listener) { this.listeners.get(kind)?.delete(listener); }
  emit(kind, event = {}) { for (const listener of [...(this.listeners.get(kind) || [])]) listener(event); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.emit("close"); }
  reply(id, result, error) { this.emit("message", { data: JSON.stringify({ id, result, error }) }); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.size, 0); }
}

test("CDP correlates responses and protocol errors without retry or duplicate settlement", async () => {
  const ws = new Socket();
  const client = createCdpClient(ws);
  const a = client.cdp("A");
  const b = client.cdp("B");
  const refused = assert.rejects(b, /protocol refusal/);
  ws.reply(2, null, { message: "protocol refusal" });
  ws.reply(1, { value: 7 });
  ws.reply(1, { value: 8 });
  assert.deepEqual(await a, { value: 7 });
  await refused;
  assert.equal(ws.sent.length, 2);
  client.close();
  assert.equal(ws.listenerCount(), 0);
});

test("a timed-out request rejects once and a late response cannot affect the next request", async () => {
  const ws = new Socket();
  const client = createCdpClient(ws, { requestTimeoutMs: 20 });
  await assert.rejects(client.cdp("slow"), /timed out: slow/);
  const next = client.cdp("next");
  ws.reply(1, { stale: true });
  ws.reply(2, { current: true });
  assert.deepEqual(await next, { current: true });
  assert.equal(ws.sent.length, 2);
  client.close();
});

for (const kind of ["close", "error", "explicit"]) {
  test(`${kind} rejects all pending CDP calls and removes transport listeners`, async () => {
    const ws = new Socket();
    const client = createCdpClient(ws, { requestTimeoutMs: 60_000 });
    const pending = Promise.all([assert.rejects(client.cdp("A"), /closed|failed/), assert.rejects(client.cdp("B"), /closed|failed/)]);
    if (kind === "explicit") client.close(); else ws.emit(kind);
    await pending;
    assert.equal(ws.listenerCount(), 0);
    await assert.rejects(client.cdp("C"), /closed|failed/);
    assert.equal(ws.sent.length, 2);
    client.close();
  });
}

test("synchronous send failure and malformed messages settle pending calls", async () => {
  const ws = new Socket();
  const client = createCdpClient(ws);
  ws.send = () => { throw new Error("send failed"); };
  await assert.rejects(client.cdp("A"), /send failed/);
  ws.send = Socket.prototype.send;
  const failed = assert.rejects(client.cdp("B"), /Invalid CDP response/);
  ws.emit("message", { data: "not-json" });
  await failed;
  assert.equal(ws.listenerCount(), 0);
});

test("renderer evaluation retains the actual exception description", async () => {
  const ws = new Socket();
  const client = createCdpClient(ws);
  const failed = assert.rejects(client.evaluate("hiddenControl()"), /click target has no visible area/);
  ws.reply(1, { exceptionDetails: { text: "Uncaught", exception: { description: "Error: click target has no visible area" } } });
  await failed;
  client.close();
});

test("connection open, close, error and timeout are bounded and remove handshake listeners", async () => {
  for (const kind of ["open", "close", "error", "timeout"]) {
    const ws = new Socket(); ws.readyState = 0;
    const connection = waitForWebSocketOpen(ws, 20);
    const observed = kind === "open" ? connection : assert.rejects(connection, /closed|failed|timed out/);
    if (kind !== "timeout") { if (kind === "open") ws.readyState = 1; ws.emit(kind); }
    await observed;
    assert.equal(ws.listenerCount(), 0);
    if (kind !== "open") assert.equal(ws.readyState, 3);
  }
});

test("invalid timeout values and already-closed connections refuse immediately", async () => {
  const ws = new Socket();
  assert.throws(() => createCdpClient(ws, { requestTimeoutMs: 0 }), /positive timeout/);
  assert.throws(() => waitForWebSocketOpen(ws, Number.NaN), /positive timeout/);
  ws.readyState = 3;
  await assert.rejects(waitForWebSocketOpen(ws), /closed/);
});
