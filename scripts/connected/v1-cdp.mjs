export async function attachGoalPort(port) {
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
  await new Promise((resolveOpen, reject) => {
    ws.addEventListener("open", resolveOpen, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  const cdp = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveCall, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "renderer evaluation failed");
    return result.result.value;
  };
  const close = () => {
    try { ws.close(); } catch {}
  };
  return { page, ws, cdp, evaluate, close };
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
