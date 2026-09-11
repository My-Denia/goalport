import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertIsolatedEnv } from "./v1-isolated-env.mjs";
assertIsolatedEnv();

const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const port = Number(value("--port", "9232"));
const host = value("--host", "electron");
const marker = value("--marker", "GOALPORT_PERMISSION_GUI_OK");
const prompt = `Run exactly cmd /c echo ${marker} in this synthetic workspace. Do not modify files or access the network. Approvals must come from the GoalPort GUI. After the command finishes, reply exactly ${marker}.`;
const reportPath = resolve(value("--report", `goal-runs/goalport-stable-v1-closure/evidence/windows-interactions/${host}-permission.json`));
const snapshotExpression = host === "electron" ? "window.goalportCore.snapshot()" : "window.__TAURI_INTERNALS__.invoke('core_snapshot')";
const raw = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = (Array.isArray(raw) ? raw : [raw]).find((item) => item.type === "page" && item.title === "GoalPort");
if (!page?.webSocketDebuggerUrl) throw new Error("packaged GoalPort page unavailable");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, reject) => { ws.addEventListener("open", resolveOpen, { once: true }); ws.addEventListener("error", reject, { once: true }); });
let nextId = 0;
const pendingCalls = new Map();
ws.addEventListener("message", (event) => { const message = JSON.parse(event.data); const waiter = pendingCalls.get(message.id); if (!waiter) return; pendingCalls.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); });
const cdp = (method, params = {}) => new Promise((resolveCall, reject) => { const id = ++nextId; pendingCalls.set(id, { resolve: resolveCall, reject }); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression, awaitPromise = false) { const result = await cdp("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "renderer evaluation failed"); return result.result.value; }
const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function snapshot() { return evaluate(snapshotExpression, true); }
const approvals = [];
const observations = [];

try {
  let current;
  current = await snapshot();
  if (current.attempt?.provider !== "codex") {
    const selected = await evaluate(`(()=>{const summary=[...document.querySelectorAll('summary')].find(x=>x.innerText.includes('Codex'));if(!summary)return false;summary.closest('details').open=true;const button=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Select Codex');if(!button||button.disabled)return false;button.click();return true;})()`);
    if (!selected) throw new Error("Codex selection unavailable");
  }
  for (let index = 0; index < 120; index += 1) { await sleep(250); current = await snapshot(); if (current.attempt?.provider === "codex") break; }
  if (current?.attempt?.provider !== "codex") throw new Error("Codex did not attach");
  const beforeCursor = current.cursor;
  const attemptId = current.attempt.id;
  if (!(current.decisions || []).some((decision) => decision.state === "pending")) {
    const entered = await evaluate(`(()=>{const input=document.querySelector('textarea[placeholder*="active Runtime"]');if(!input)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(prompt)});input.dispatchEvent(new Event('input',{bubbles:true}));const button=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('Send'));if(!button||button.disabled)return false;button.click();return true;})()`);
    if (!entered) throw new Error("permission prompt was not sent through the GUI");
  }
  const deadline = Date.now() + 180_000;
  let terminal = false;
  while (Date.now() < deadline) {
    await sleep(250);
    current = await snapshot();
    const pending = (current.decisions || []).filter((decision) => decision.state === "pending");
    observations.push({ atUtc: new Date().toISOString(), cursor: current.cursor, state: current.attempt.state, pending: pending.length });
    if (pending.length > 0) {
      const decision = pending[0];
      const decisionHash = createHash("sha256").update(decision.id).digest("hex");
      if (!approvals.some((item) => item.decisionHash === decisionHash)) {
        const clicked = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Allow once');if(!button||button.disabled)return false;button.click();return true;})()`);
        if (clicked) approvals.push({ decisionHash, atUtc: new Date().toISOString(), action: "allow-once" });
      }
    }
    const cards = await evaluate(`[...document.querySelectorAll('.timeline-card')].map(x=>x.innerText)`);
    terminal = cards.some((text) => text.includes("Native Runtime") && text.includes(marker))
      && cards.some((text) => text.includes("Native Runtime") && text.includes("Attempt state updated") && text.includes("COMMITTED"))
      && !(current.decisions || []).some((decision) => decision.state === "pending");
    if (terminal) break;
  }
  const cards = await evaluate(`[...document.querySelectorAll('.timeline-card')].map(x=>x.innerText)`);
  const dom = {
    permissionVisible: cards.some((text) => text.includes("Permission")),
    toolVisible: cards.some((text) => text.includes("Tool")),
    replyVisible: cards.some((text) => text.includes("Native Runtime") && text.includes(marker)),
    terminalVisible: cards.some((text) => text.includes("Native Runtime") && text.includes("Attempt state updated") && text.includes("COMMITTED"))
  };
  const allResolved = approvals.length > 0 && (current.decisions || []).filter((decision) => approvals.some((item) => item.decisionHash === createHash("sha256").update(decision.id).digest("hex"))).every((decision) => decision.state === "resolved");
  const report = {
    schemaVersion: 1,
    kind: "packaged-native-permission-gui",
    operationId: `${host}-permission-final`,
    host,
    attemptId,
    providerSessionHash: current.attempt.sessionHash,
    beforeCursor,
    afterCursor: current.cursor,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    approvals,
    observations,
    dom,
    allResolved,
    terminal,
    coreBuildId: current.buildId,
    status: approvals.length > 0 && allResolved && terminal && Object.values(dom).every(Boolean) ? "PASS" : "UNMET"
  };
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : 1;
} finally {
  ws.close();
}
