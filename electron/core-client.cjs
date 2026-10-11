// Mutating commands are never retried automatically after a lost acknowledgement.
// Snapshot retries are safe and still verify the Core attachment through ensureCore.
// In the Electron main process the injected transport is the verified request gate.
const { randomUUID } = require("node:crypto");

function createPendingDecisionNotifier(show) {
  const announced = new Set();
  return (snapshot) => {
    const fresh = (Array.isArray(snapshot?.decisions) ? snapshot.decisions : []).filter((decision) =>
      decision?.state === "pending" && typeof decision.id === "string" && decision.id.trim() && !announced.has(decision.id));
    if (!fresh.length) return;
    const body = fresh.length === 1 ? fresh[0].title || "A permission request needs your answer."
      : `${fresh.length} permission requests need your answer.`;
    try {
      // Optional desktop notifications must never turn an accepted Core
      // command into a transport error. Remember only a delivered toast.
      if (show("GoalPort decision", body) !== false) fresh.forEach((decision) => announced.add(decision.id));
    } catch { /* The conversation still contains the pending decisions. */ }
  };
}

async function invokeCoreRequest(request, { exchange, ensureCore, delay, onResult }) {
  async function attempt() {
    const response = await exchange(request);
    if (response?.requestId !== request.requestId) {
      throw new Error("Core response identity does not match the request; result remains unknown");
    }
    if (response?.ok === false) {
      const error = String(response.error || "Core rejected the request");
      // A refused read contains no projection. It must not replace a cached
      // active/held Attempt or be retried as if its result were unknown.
      if (request.messageType === "snapshot") {
        throw Object.assign(new Error(error), { goalportRejected: true });
      }
      const rejected = response.payload;
      if (rejected && (rejected.requestId !== request.requestId || rejected.accepted !== false)) {
        throw new Error("Core rejection identity does not match the request; result remains unknown");
      }
      return { ...rejected, goalportRejected: true, requestId: request.requestId, error };
    }
    const body = response?.payload || response;
    if (request.messageType === "snapshot") return body?.snapshot || body;
    if (request.messageType === "history_page") {
      if (body?.requestId !== request.requestId || body?.accepted !== true || !body.historyPage) {
        throw new Error("Core did not return a matching history page");
      }
      return body;
    }
    if (!body || body.requestId !== request.requestId || body.accepted !== true || !body.snapshot) {
      throw new Error("Core did not return a matching command acknowledgement; result remains unknown");
    }
    return body;
  }
  let result;
  try { result = await attempt(); }
  catch (error) {
    if (request.messageType !== "snapshot" || error?.goalportRejected) throw error;
    // No attachment owner is wired: a lost snapshot is never retried blind.
    if (!ensureCore) throw error;
    await ensureCore();
    await delay(120);
    result = await attempt();
  }
  if (result?.snapshot) onResult?.(result.snapshot);
  else if (request.messageType === "snapshot" && !result?.goalportRejected) onResult?.(result);
  return result;
}

function acknowledgedStopSnapshot(result, requestId, requiresHold) {
  if (result?.goalportRejected) throw new Error(result.error || "Core rejected durable Stop");
  if (result?.requestId !== requestId || result?.accepted !== true || !result.snapshot) throw new Error("Stop acknowledgement identity is unavailable");
  const snapshot = result.snapshot;
  const responsibility = snapshot.stopResponsibility || snapshot.stop_responsibility;
  const held = String(responsibility?.writeResponsibility || responsibility?.write_responsibility || "").toLowerCase() === "held";
  if (requiresHold && !held) throw new Error("durable-stop-hold-missing");
  return snapshot;
}

const VERIFY_DEADLINE_MS = 120000;
const PEER_BUSY_RETRY_MS = 100;
const SERVER_REFUSAL = "Core pipe server identity could not be verified; attachment refused";

// One full verification of the Core pipe server: a fresh `pipe-peer` run (busy
// results are retried 100 ms apart), then the startup receipt, then the peer and
// identity assertions. A single deadline covers the whole verification.
async function verifyCoreServer({ runPeer, requestReceipt, assertPeer, isBusy, now, delay, deadlineMs = VERIFY_DEADLINE_MS, retryMs = PEER_BUSY_RETRY_MS }) {
  const deadline = now() + deadlineMs;
  let peer;
  while (true) {
    try { peer = await runPeer(); } catch { throw new Error(SERVER_REFUSAL); }
    if (peer?.code === 0) break;
    if (peer?.code === 3 && isBusy(peer.stdout) && now() + retryMs < deadline) {
      await delay(retryMs);
      continue;
    }
    throw new Error(SERVER_REFUSAL);
  }
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error(SERVER_REFUSAL);
  const receipt = await requestReceipt(remaining);
  assertPeer(peer.stdout, receipt);
  return receipt;
}

// Single request gate: every non-snapshot request, and any request after a
// failed transport or verification, runs a full verification first. Only a
// successful verification that started after the last failure clears it.
// A request that needs verification waits at most VERIFY_DEADLINE_MS from its
// own entry (queued and repeated verifications included), then is refused.
function createCoreGate({ verify, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let failures = 0, cleared = 0, current = null;
  // Waits for `promise` until `deadline`. Local expiry refuses without touching
  // the counters; the underlying verification keeps its own outcome handlers.
  function withinDeadline(promise, deadline) {
    return new Promise((resolve, reject) => {
      const remaining = deadline - now();
      let timer = null;
      let settled = false;
      const settle = (finish, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimer(timer);
        timer = null;
        finish(value);
      };
      promise.then((value) => settle(resolve, value), (error) => settle(reject, error));
      if (remaining <= 0) settle(reject, new Error(SERVER_REFUSAL));
      else timer = setTimer(() => { timer = null; settle(reject, new Error(SERVER_REFUSAL)); }, remaining);
    });
  }
  function verifyNow() {
    if (current && current.startedAt === failures) return current.promise;
    const previous = current ? current.promise.catch(() => {}) : Promise.resolve();
    const startedAt = failures;
    const promise = previous.then(() => verify()).then(
      (value) => { if (cleared < startedAt) cleared = startedAt; return value; },
      (error) => { failures += 1; throw error; }
    );
    const entry = { startedAt, promise };
    current = entry;
    promise.catch(() => {}).finally(() => { if (current === entry) current = null; });
    return promise;
  }
  async function send(request, transport) {
    if (request?.messageType !== "snapshot" || failures > cleared) {
      const deadline = now() + VERIFY_DEADLINE_MS;
      await withinDeadline(verifyNow(), deadline);
      // A failure observed while that verification was in flight is not
      // cleared by it; verify again before sending, within the same deadline.
      while (failures > cleared) await withinDeadline(verifyNow(), deadline);
    }
    try {
      return await transport(request);
    } catch (error) {
      failures += 1;
      throw error;
    }
  }
  return { verify: verifyNow, send, needsVerification: () => failures > cleared };
}

// ---------- Reusable verified Core connection ----------

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;

// One verified Core connection, extracted from the Electron main process so
// any host (main, or a detached worker) shares the exact same mechanics:
//   * the length-prefixed JSON frame exchange with its size limits, deadlines
//     and response rules (invokeCoreRequest below),
//   * the startup verification composition (verifyCoreServer): pipe-peer,
//     startup receipt, peer/identity assertions under one deadline,
//   * the single request gate (createCoreGate) in front of every frame.
// The constructor owns ONLY mechanics. Every identity decision stays with the
// host: connectPath (the resolved endpoint), runPeer (the resolved Core
// binary + serve pipe), assertPeer (pipe-peer plus profile identity), and
// ensureCore — attachment and process lifetime. This module never spawns or
// recovers a Core process and never originates a command; hosts that must not
// change Core responsibility pass allowedMessageTypes so a disallowed request
// is refused before any socket exists (proof that command was not sent).
function createCoreConnection({
  connectPath, connect, runPeer, isBusy, assertPeer,
  verificationSkipped, ensureCore, allowedMessageTypes, onResult,
  now = Date.now,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimer = setTimeout, clearTimer = clearTimeout,
  newRequestId = randomUUID,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  maxFrameBytes = MAX_FRAME_BYTES,
  verifyDeadlineMs = VERIFY_DEADLINE_MS,
  peerBusyRetryMs = PEER_BUSY_RETRY_MS
} = {}) {
  for (const [name, value] of Object.entries({ connectPath, connect, runPeer, isBusy, assertPeer })) {
    if (typeof value !== "function") throw new Error(`createCoreConnection requires a ${name} function`);
  }

  function assertAllowed(request) {
    if (!allowedMessageTypes || allowedMessageTypes.includes(request?.messageType)) return;
    throw new Error(`This Core connection accepts only ${allowedMessageTypes.join(", ")} requests; ${JSON.stringify(request?.messageType ?? null)} was refused and nothing was sent`);
  }

  // The frame exchange, verbatim from the main process: one connection per
  // request, a 4-byte little-endian length prefix, a bounded frame size and a
  // per-request deadline. Do not half-close a Windows Named Pipe before a
  // slow native response.
  function exchangeFrame(request, { timeoutMs = requestTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const socket = connect(connectPath());
      const chunks = [];
      let expected = null;
      let settled = false;
      const timeout = setTimer(() => fail(new Error(`Core IPC response timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} seconds`)), timeoutMs);
      const fail = (error) => { if (!settled) { settled = true; clearTimer(timeout); socket.destroy(); reject(error); } };
      socket.on("error", fail);
      socket.on("end", () => { if (!settled) fail(new Error("Core closed the connection before acknowledging the request")); });
      socket.on("close", () => { if (!settled) fail(new Error("Core connection closed before acknowledgement")); });
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        if (expected == null && bytes.length >= 4) expected = bytes.readUInt32LE(0);
        if (expected != null && expected > maxFrameBytes) return fail(new Error("Core response frame exceeds limit"));
        if (expected != null && bytes.length >= expected + 4) {
          settled = true;
          clearTimer(timeout);
          socket.end();
          try { resolve(JSON.parse(bytes.subarray(4, expected + 4).toString("utf8"))); }
          catch (error) { reject(error); }
        }
      });
      const payload = Buffer.from(JSON.stringify(request));
      if (payload.length > maxFrameBytes) {
        return fail(new Error("Core request frame exceeds limit"));
      }
      const frame = Buffer.allocUnsafe(4 + payload.length);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      socket.on("connect", () => socket.write(frame));
    });
  }

  // The startup receipt travels over the RAW exchange: verification must not
  // recurse through the gate that demands verification.
  async function requestStartupReceipt(timeoutMs) {
    const requestId = `identity-${newRequestId()}`;
    const response = await exchangeFrame({
      protocolVersion: "goalport.ipc.v2", requestId,
      entityVersion: 0, messageType: "get_startup_receipt", payload: {}
    }, { timeoutMs });
    if (!response || response.requestId !== requestId || response.ok === false) throw new Error("Core startup identity is unavailable; attachment refused");
    return response.payload?.receipt;
  }

  // ONE full verification of the Core connection. A host may skip it only for
  // a contract with no identity to assert (the legacy profile-less isolated
  // runs); every profile mode keeps the full verification.
  async function verify() {
    if (verificationSkipped?.()) return;
    return verifyCoreServer({
      runPeer, isBusy, now, delay,
      requestReceipt: requestStartupReceipt,
      assertPeer,
      deadlineMs: verifyDeadlineMs,
      retryMs: peerBusyRetryMs
    });
  }

  const gate = createCoreGate({ verify, now, setTimer, clearTimer });

  async function exchange(request, options) {
    assertAllowed(request);
    return exchangeFrame(request, options);
  }

  async function exchangeVerified(request) {
    assertAllowed(request);
    return gate.send(request, exchangeFrame);
  }

  // Same request/response rules as the main process: identity checks, refusal
  // tagging, one attachment-checked snapshot retry, snapshot observation.
  async function invoke(request) {
    return invokeCoreRequest(request, {
      exchange: exchangeVerified,
      ensureCore,
      delay,
      onResult: (snapshot) => onResult?.(snapshot, request)
    });
  }

  // `verify` is the GATE's verifyNow on purpose: a host re-attachment check
  // shares the gate's memoized verification and its failure/cleared counters,
  // so an ensureCore() that just verified must not force a second verification
  // on the retried request (the main-process behavior this must preserve).
  return { exchange, exchangeVerified, invoke, verify: gate.verify, needsVerification: gate.needsVerification };
}

module.exports = { invokeCoreRequest, acknowledgedStopSnapshot, verifyCoreServer, createCoreGate, createPendingDecisionNotifier, createCoreConnection, VERIFY_DEADLINE_MS, SERVER_REFUSAL, MAX_FRAME_BYTES };
