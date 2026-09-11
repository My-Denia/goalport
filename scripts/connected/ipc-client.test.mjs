import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { exchange, pipePath } from "./ipc-client.mjs";

test("named-pipe client keeps read side open for delayed Core response", async () => {
  const name = `goalport-ipc-regression-${process.pid}-${Date.now()}`;
  const server = createServer((socket) => {
    const chunks = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (bytes.length < 4 || bytes.length < bytes.readUInt32LE(0) + 4) return;
      setTimeout(() => {
        const payload = Buffer.from(JSON.stringify({ ok: true, delayed: true }));
        const frame = Buffer.allocUnsafe(payload.length + 4);
        frame.writeUInt32LE(payload.length, 0);
        payload.copy(frame, 4);
        socket.write(frame);
      }, 150);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath(name), resolve);
  });
  try {
    const response = await exchange(name, { protocolVersion: "goalport.ipc.v2", requestId: "delayed", entityVersion: 0, messageType: "snapshot", payload: {} }, 2_000);
    assert.equal(response.delayed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
