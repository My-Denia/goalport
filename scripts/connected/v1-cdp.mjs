function timeoutValue(value, name) {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} must be a positive timeout`);
  return value;
}

export function waitForWebSocketOpen(ws, timeoutMs = 10_000) {
  timeoutValue(timeoutMs, "connectTimeoutMs");
  if (ws.readyState === 1) return Promise.resolve();
  if (ws.readyState !== 0) return Promise.reject(new Error("CDP WebSocket closed before connecting"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener("open", opened);
      ws.removeEventListener("error", failed);
      ws.removeEventListener("close", closed);
      if (error) {
        try { ws.close(); } catch {}
        reject(error);
      } else resolve();
    };
    const opened = () => finish();
    const failed = (event) => finish(event.error instanceof Error ? event.error : new Error("CDP WebSocket connection failed"));
    const closed = () => finish(new Error("CDP WebSocket closed before connecting"));
    const timer = setTimeout(() => finish(new Error("CDP WebSocket connection timed out")), timeoutMs);
    ws.addEventListener("open", opened);
    ws.addEventListener("error", failed);
    ws.addEventListener("close", closed);
  });
}

export function createCdpClient(ws, { requestTimeoutMs = 30_000 } = {}) {
  timeoutValue(requestTimeoutMs, "requestTimeoutMs");
  let nextId = 0;
  let terminalError;
  const pending = new Map();
  const settle = (id, error, result) => {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    error ? waiter.reject(error) : waiter.resolve(result);
  };
  const end = (error) => {
    if (terminalError) return;
    terminalError = error;
    ws.removeEventListener("message", messageReceived);
    ws.removeEventListener("close", closed);
    ws.removeEventListener("error", failed);
    for (const id of pending.keys()) settle(id, error);
    try { ws.close(); } catch {}
  };
  const closed = () => end(new Error("CDP WebSocket closed"));
  const failed = (event) => end(event.error instanceof Error ? event.error : new Error("CDP WebSocket failed"));
  const messageReceived = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { end(new Error("Invalid CDP response")); return; }
    if (!message || typeof message !== "object") { end(new Error("Invalid CDP response")); return; }
    settle(message.id, message.error ? new Error(message.error.message || "CDP command failed") : null, message.result);
  };
  ws.addEventListener("message", messageReceived);
  ws.addEventListener("close", closed);
  ws.addEventListener("error", failed);
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    if (terminalError || ws.readyState !== 1) { reject(terminalError || new Error("CDP WebSocket is not open")); return; }
    const id = ++nextId;
    const timer = setTimeout(() => settle(id, new Error(`CDP command timed out: ${method}`)), requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (error) { settle(id, error); }
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "renderer evaluation failed");
    return result.result.value;
  };
  return { ws, cdp, evaluate, close: () => end(new Error("CDP client closed")) };
}

export async function attachGoalPort(port, { requestTimeoutMs = 30_000, connectTimeoutMs = 10_000 } = {}) {
  timeoutValue(requestTimeoutMs, "requestTimeoutMs");
  timeoutValue(connectTimeoutMs, "connectTimeoutMs");
  const deadline = Date.now() + 30_000;
  let page;
  while (Date.now() < deadline) {
    try {
      const raw = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json();
      page = (Array.isArray(raw) ? raw : [raw]).find((item) => item.type === "page" && String(item.title || "").includes("GoalPort"));
      if (page?.webSocketDebuggerUrl) break;
    } catch {
      page = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!page?.webSocketDebuggerUrl) throw new Error(`GoalPort CDP page unavailable on ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await waitForWebSocketOpen(ws, connectTimeoutMs);
  return { page, ...createCdpClient(ws, { requestTimeoutMs }) };
}

export async function waitFor(evaluate, expression, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression, true)) return true;
    } catch {
      // renderer may not be ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
