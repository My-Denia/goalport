// Mutating commands are never retried automatically after a lost acknowledgement.
// Snapshot retries are safe and still verify the Core attachment through ensureCore.
async function invokeCoreRequest(request, { exchange, ensureCore, delay, onResult }) {
  async function attempt() {
    const response = await exchange(request);
    if (response?.requestId !== request.requestId) {
      throw new Error("Core response identity does not match the request; result remains unknown");
    }
    if (response?.ok === false) return { goalportRejected: true, requestId: request.requestId, error: String(response.error || "Core rejected the request") };
    const body = response?.payload || response;
    if (request.messageType === "snapshot") return body?.snapshot || body;
    if (!body || body.requestId !== request.requestId || body.accepted !== true || !body.snapshot) {
      throw new Error("Core did not return a matching command acknowledgement; result remains unknown");
    }
    return body;
  }
  let result;
  try { result = await attempt(); }
  catch (error) {
    if (request.messageType !== "snapshot") throw error;
    await ensureCore();
    await delay(120);
    result = await attempt();
  }
  if (!result?.goalportRejected) onResult?.(result?.snapshot || result);
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

module.exports = { invokeCoreRequest, acknowledgedStopSnapshot };
