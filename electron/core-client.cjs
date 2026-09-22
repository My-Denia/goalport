// Mutating commands are never retried automatically after a lost acknowledgement.
// Snapshot retries are safe and still verify the Core attachment through ensureCore.
// In the Electron main process the injected transport is the verified request gate.
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

module.exports = { invokeCoreRequest, acknowledgedStopSnapshot, verifyCoreServer, createCoreGate, VERIFY_DEADLINE_MS, SERVER_REFUSAL };
