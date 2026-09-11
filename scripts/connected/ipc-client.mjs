import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function pipeNameFor(label = "run") {
  return `goalport-${label}-${process.pid}-${Date.now()}`;
}

export function pipePath(name) {
  return name.startsWith("\\\\.\\pipe\\") ? name : `\\\\.\\pipe\\${name}`;
}

export function exchange(name, request, timeoutMs = 30_000) {
  const target = pipePath(name);
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(target);
    const chunks = [];
    let expected;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error(`Core IPC timed out after ${timeoutMs}ms`)), timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (expected === undefined && bytes.length >= 4) expected = bytes.readUInt32LE(0);
      if (expected !== undefined && expected > MAX_FRAME_BYTES) return fail(new Error("Core response frame exceeds limit"));
      if (expected !== undefined && bytes.length >= expected + 4) {
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        try { resolveResponse(JSON.parse(bytes.subarray(4, expected + 4).toString("utf8"))); }
        catch (error) { reject(error); }
      }
    });
    const payload = Buffer.from(JSON.stringify(request));
    if (payload.length > MAX_FRAME_BYTES) return fail(new Error("Core request frame exceeds limit"));
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    // Keep the read side open. `socket.end(frame)` half-closes a Windows
    // Named Pipe and can prevent a slow native select/send response.
    socket.once("connect", () => socket.write(frame));
  });
}

export function unwrap(response) {
  if (response?.ok === false) throw new Error(response.error || "Core rejected UI request");
  return response?.payload?.snapshot || response?.payload || response;
}

export function uiRequest(requestId, messageType, payload = {}) {
  return {
    protocolVersion: "goalport.ipc.v2",
    requestId,
    entityVersion: 0,
    messageType,
    payload
  };
}

export async function waitForPipe(name, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await exchange(name, uiRequest(`wait-${process.pid}-${Date.now()}`, "snapshot"), 500);
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error(`Core Named Pipe ${pipePath(name)} did not become available`);
}

export function spawnCore({ core, launcher, pipe, db, cwd }) {
  const corePath = resolve(cwd, core);
  if (!existsSync(corePath)) throw new Error(`Core binary does not exist: ${corePath}`);
  const launcherPath = launcher ? resolve(cwd, launcher) : undefined;
  const command = launcherPath && existsSync(launcherPath) ? launcherPath : corePath;
  const args = command === launcherPath
    ? [corePath, "serve", "--pipe", pipe, "--db", resolve(cwd, db)]
    : ["serve", "--pipe", pipe, "--db", resolve(cwd, db)];
  const env = { ...process.env };
  if (process.env.GOALPORT_REQUIRE_ISOLATED === "1") {
    if (!process.env.GOALPORT_CORE_PIPE || !process.env.GOALPORT_CORE_DB || !process.env.GOALPORT_SYNTHETIC_ROOT) {
      throw new Error("isolated Core spawn requires GOALPORT_CORE_PIPE, GOALPORT_CORE_DB, GOALPORT_SYNTHETIC_ROOT");
    }
    const dbText = String(resolve(cwd, db)).replaceAll("/", "\\").toLowerCase();
    if (dbText.includes("goalport-connected-dual-desktop") || dbText.includes("\\appdata\\")) {
      throw new Error(`refusing to open non-isolated Core DB: ${db}`);
    }
  }
  const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: true, env });
  child.unref();
  return child;
}

export async function ensureCore({ core, launcher, pipe, db, cwd, timeoutMs = 5_000 }) {
  try {
    await waitForPipe(pipe, 500);
    return null;
  } catch {
    const child = spawnCore({ core, launcher, pipe, db, cwd });
    await waitForPipe(pipe, timeoutMs);
    return child;
  }
}
