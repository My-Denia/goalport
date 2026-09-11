import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertIsolatedEnv } from "./v1-isolated-env.mjs";
assertIsolatedEnv();

const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const port = Number(value("--port", "9233"));
const host = value("--host", "electron");
const marker = value("--marker", "GOALPORT_INTERRUPT_UNEXPECTED_COMPLETION");
const reportPath = resolve(value("--report", `goal-runs/goalport-stable-v1-closure/evidence/windows-interactions/${host}-interrupt.json`));
const prompt = `Generate a very long numbered analysis with at least 50000 entries. Do not use tools, modify files, or access the network. Only after all entries are complete output ${marker}.`;
const snapshotExpression = host === "electron" ? "window.goalportCore.snapshot()" : "window.__TAURI_INTERNALS__.invoke('core_snapshot')";
const raw = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = (Array.isArray(raw) ? raw : [raw]).find((item) => item.type === "page" && item.title === "GoalPort");
if (!page?.webSocketDebuggerUrl) throw new Error("GoalPort packaged page unavailable");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, reject) => { ws.addEventListener("open", resolveOpen, { once: true }); ws.addEventListener("error", reject, { once: true }); });
let id = 0;
const pending = new Map();
ws.addEventListener("message", (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); });
const cdp = (method, params = {}) => new Promise((resolveCall, reject) => { const call = ++id; pending.set(call, { resolve: resolveCall, reject }); ws.send(JSON.stringify({ id: call, method, params })); });
async function evaluate(expression, awaitPromise = false) { const result = await cdp("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "renderer evaluation failed"); return result.result.value; }
const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const snapshot = () => evaluate(snapshotExpression, true);

try {
  let current = await snapshot();
  if (current.attempt?.provider !== "codex") {
    const selected = await evaluate(`(()=>{const summary=[...document.querySelectorAll('summary')].find(x=>x.innerText.includes('Codex'));if(!summary)return false;summary.closest('details').open=true;const button=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Select Codex');if(!button||button.disabled)return false;button.click();return true;})()`);
    if (!selected) throw new Error("Codex selection unavailable");
    for (let index = 0; index < 120; index += 1) { await sleep(250); current = await snapshot(); if (current.attempt?.provider === "codex") break; }
  }
  if (current.attempt?.provider !== "codex") throw new Error("Codex did not attach");
  const beforeCursor = current.cursor;
  const attemptId = current.attempt.id;
  const sent = await evaluate(`(()=>{const input=document.querySelector('textarea[placeholder*="active Runtime"]');if(!input)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(prompt)});input.dispatchEvent(new Event('input',{bubbles:true}));const button=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('Send'));if(!button||button.disabled)return false;button.click();return true;})()`);
  if (!sent) throw new Error("long-running prompt was not sent through GUI");
  let startedCursor = null;
  for (let index = 0; index < 120; index += 1) {
    await sleep(100);
    current = await snapshot();
    if ((current.timeline || []).some((event) => event.cursor > beforeCursor && event.body === "runtime.turn.started")) { startedCursor = current.cursor; break; }
  }
  if (startedCursor === null) throw new Error("native turn did not start before interrupt window");
  const clicked = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('Safe stop'));if(!button||button.disabled)return false;button.click();return true;})()`);
  if (!clicked) throw new Error("Safe stop GUI action unavailable");
  let cancelled = false;
  const observations = [];
  for (let index = 0; index < 240; index += 1) {
    await sleep(250);
    current = await snapshot();
    const events = (current.timeline || []).filter((event) => event.cursor > beforeCursor);
    observations.push({ atUtc: new Date().toISOString(), cursor: current.cursor, state: current.attempt.state, kinds: [...new Set(events.map((event) => event.kind))] });
    cancelled = events.some((event) => event.body === "runtime.turn.cancelled") || current.attempt.state === "failed";
    if (cancelled) break;
  }
  const events = (current.timeline || []).filter((event) => event.cursor > beforeCursor);
  const interruptRequested = events.some((event) => event.body === "attempt.interrupt.requested");
  const unexpectedMarker = events.some((event) => event.actor === "Native Runtime" && String(event.body).includes(marker));
  const report = {
    schemaVersion: 1,
    kind: "packaged-native-safe-stop-gui",
    operationId: `${host}-interrupt-final`,
    host,
    attemptId,
    providerSessionHash: current.attempt.sessionHash,
    beforeCursor,
    startedCursor,
    afterCursor: current.cursor,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    interruptRequested,
    nativeCancelled: cancelled,
    unexpectedCompletionMarker: unexpectedMarker,
    finalState: current.attempt.state,
    observations,
    coreBuildId: current.buildId,
    status: interruptRequested && cancelled && !unexpectedMarker ? "PASS" : "UNMET"
  };
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : 1;
} finally {
  ws.close();
}
