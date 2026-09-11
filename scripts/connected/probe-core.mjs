import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertIsolatedEnv } from "./v1-isolated-env.mjs";
assertIsolatedEnv();

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const has = (name) => args.includes(name);
const pipe = arg("--pipe", process.env.GOALPORT_CORE_PIPE || `goalport-core-connected-${process.pid}`);
const pipePath = pipe.startsWith("\\\\.\\pipe\\") ? pipe : `\\\\.\\pipe\\${pipe}`;
const db = resolve(root, arg("--db", process.env.GOALPORT_CORE_DB || `goal-runs/goalport-stable-v1-closure/evidence/probe-${process.pid}.sqlite`));
const core = resolve(root, arg("--core", "target/release/goalport-core.exe"));
const provider = arg("--provider", "scenario");
const prompt = arg("--prompt", "connected preview probe");
const keepAlive = setInterval(() => {}, 1_000);
if (!existsSync(core)) {
  console.error(`Core binary does not exist: ${core}`);
  process.exit(2);
}
mkdirSync(resolve(db, ".."), { recursive: true });

let coreChild;
async function connectProbe() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await exchange({
        protocolVersion: "goalport.ipc.v2",
        requestId: `probe-bootstrap-${process.pid}-${attempt}`,
        entityVersion: 0,
        messageType: "snapshot",
        payload: {}
      });
    } catch (error) {
      if (attempt === 0 && has("--start")) {
        coreChild = spawn(core, ["serve", "--pipe", pipe, "--db", db], { detached: true, stdio: "ignore", windowsHide: true });
        coreChild.unref();
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error("Core Named Pipe did not become available within 3 seconds");
}

function exchange(request) {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(pipePath);
    const chunks = [];
    let expected;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error("Core IPC response timed out after 900 seconds")), 900_000);
    const fail = (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      }
    };
    socket.once("error", fail);
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (expected === undefined && bytes.length >= 4) expected = bytes.readUInt32LE(0);
      if (expected !== undefined && expected > 16 * 1024 * 1024) return fail(new Error("Core response frame exceeds limit"));
      if (expected !== undefined && bytes.length >= expected + 4) {
        settled = true;
        socket.destroy();
        try { resolveResponse(JSON.parse(bytes.subarray(4, expected + 4).toString("utf8"))); }
        catch (error) { reject(error); }
      }
    });
    const payloadBytes = Buffer.from(JSON.stringify(request));
    if (payloadBytes.length > 16 * 1024 * 1024) return fail(new Error("Core request frame exceeds limit"));
    const frame = Buffer.allocUnsafe(payloadBytes.length + 4);
    frame.writeUInt32LE(payloadBytes.length, 0);
    payloadBytes.copy(frame, 4);
    socket.once("connect", () => socket.write(frame));
  });
}

const unwrap = (response) => {
  if (response?.ok === false) throw new Error(response.error || "Core rejected request");
  return response?.payload?.snapshot || response?.payload || response;
};

try {
  const operations = [];
  const snapshotResponse = await connectProbe();
  let snapshot = unwrap(snapshotResponse);
  operations.push({ id: "snapshot", ok: true, cursor: snapshot.cursor, projectId: snapshot.project?.id, attemptId: snapshot.attempt?.id });
  const selectResponse = await exchange({ protocolVersion: "goalport.ipc.v2", requestId: `probe-select-${process.pid}`, entityVersion: 0, messageType: "select_runtime", payload: { projectId: snapshot.selectedProjectId || snapshot.project.id, campaignId: snapshot.activeCampaignId, taskId: snapshot.activeTask.id, provider } });
  snapshot = unwrap(selectResponse);
  operations.push({ id: "select-runtime", ok: true, provider: snapshot.attempt?.provider, attemptId: snapshot.attempt?.id, cursor: snapshot.cursor });
  const sendRequestId = `probe-send-${process.pid}`;
  const sendResponse = await exchange({ protocolVersion: "goalport.ipc.v2", requestId: sendRequestId, entityVersion: 0, messageType: "send_message", payload: { campaignId: snapshot.activeCampaignId, taskId: snapshot.activeTask.id, attemptId: snapshot.attempt.id, message: prompt } });
  snapshot = unwrap(sendResponse);
  operations.push({ id: "send-message", ok: true, duplicate: sendResponse.payload?.duplicate === true, cursor: snapshot.cursor, eventKinds: (snapshot.timeline || []).map((event) => event.kind) });
  const reconnectResponse = await exchange({ protocolVersion: "goalport.ipc.v2", requestId: `probe-reconnect-${process.pid}`, entityVersion: 0, messageType: "reconnect", payload: { cursor: operations[1].cursor } });
  const reconnected = unwrap(reconnectResponse);
  operations.push({ id: "reconnect", ok: true, cursor: reconnected.cursor, backfillCount: reconnected.timeline?.length || 0, attemptId: reconnected.attempt?.id });
  const report = { schemaVersion: 1, kind: "connected-core-probe", protocolVersion: "goalport.ipc.v2", coreBuildId: snapshot.buildId, provider, pipe: pipePath.replace(/\\d+$/, "[PID]"), operations, accepted: operations.every((operation) => operation.ok) };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.accepted ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
  if (coreChild && !has("--keep-core")) {
    try { coreChild.kill(); } catch {}
  }
}

// A detached Windows named-pipe client can retain a native handle after the
// response socket is destroyed. Force the already-recorded result exit once
// cleanup has run so a probe never masquerades as a hung command.
setImmediate(() => process.exit(process.exitCode ?? 0));
