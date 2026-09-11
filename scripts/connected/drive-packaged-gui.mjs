import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertIsolatedEnv } from "./v1-isolated-env.mjs";
assertIsolatedEnv();

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const port = Number(value("--port", "9230"));
const host = value("--host", "electron");
const workspace = value("--workspace", "");
const goal = value("--goal", `Final ${host} connected campaign`);
const marker = value("--marker", `GOALPORT_${host.toUpperCase()}_NATIVE_OK`);
const prompt = value("--prompt", `Read only .goalport/native-marker.txt with the native file tool. Do not modify files. Then reply exactly ${marker}.`);
const reportPath = resolve(value("--report", `goal-runs/goalport-stable-v1-closure/evidence/windows-interactions/${host}-connected-operation.json`));
const snapshotExpression = host === "electron"
  ? "window.goalportCore.snapshot()"
  : "window.__TAURI_INTERNALS__.invoke('core_snapshot')";

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = (Array.isArray(targets) ? targets : [targets]).find((item) => item.type === "page" && item.title === "GoalPort");
if (!page?.webSocketDebuggerUrl) throw new Error(`GoalPort CDP page is unavailable on port ${port}`);
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
async function evaluate(expression, awaitPromise = false) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "renderer evaluation failed");
  return result.result.value;
}
const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function waitFor(expression, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression, true)) return true;
    await sleep(250);
  }
  return false;
}
const steps = [];
function step(id, detail) { steps.push({ id, detail, atUtc: new Date().toISOString() }); }

try {
  if (!workspace) throw new Error("--workspace is required");
  if (!(await waitFor(`document.body.innerText.includes('Core connected')`, 15_000))) throw new Error("packaged GUI never displayed Core connected");
  step("connected", page.url);

  const projectSelected = await evaluate(`(()=>{const select=document.querySelector('select[aria-label="Project"]');if(!select)return false;select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  if (!projectSelected) throw new Error("project selector unavailable");
  step("select-project", "React project selector dispatched through the packaged renderer");

  const opened = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('New campaign'));if(!button)return false;button.click();return true;})()`);
  if (!opened || !(await waitFor(`Boolean(document.querySelector('#project-folder'))`, 5_000))) throw new Error("new campaign dialog unavailable");
  await evaluate(`(()=>{const set=(selector,value)=>{const input=document.querySelector(selector);if(!input)return false;const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));return true;};return set('#project-folder',${JSON.stringify(workspace)})&&set('#campaign-goal',${JSON.stringify(goal)});})()`);
  const submitted = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('Begin preview'));if(!button||button.disabled)return false;button.click();return true;})()`);
  if (!submitted || !(await waitFor(`!document.querySelector('#campaign-goal') && document.body.innerText.includes(${JSON.stringify(goal)})`, 15_000))) throw new Error("campaign/task creation did not reach the GUI");
  step("create-campaign-task", goal);

  const selectedCodex = await evaluate(`(()=>{const summary=[...document.querySelectorAll('summary')].find(x=>x.innerText.includes('Codex'));if(!summary)return false;summary.closest('details').open=true;const button=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Select Codex');if(!button||button.disabled)return false;button.click();return true;})()`);
  if (!selectedCodex || !(await waitFor(`${snapshotExpression}.then(x=>x.attempt?.provider==='codex')`, 30_000))) throw new Error("Codex Runtime was not selected through the GUI");
  step("select-codex", "Native app-server selected");

  const entered = await evaluate(`(()=>{const input=document.querySelector('textarea[placeholder*="active Runtime"]');if(!input)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(prompt)});input.dispatchEvent(new Event('input',{bubbles:true}));return input.value===${JSON.stringify(prompt)};})()`);
  if (!entered) throw new Error("composer input failed");
  const sent = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('Send'));if(!button||button.disabled)return false;button.click();return true;})()`);
  if (!sent) throw new Error("GUI Send button did not dispatch");
  step("send-native-prompt", createHash("sha256").update(prompt).digest("hex"));

  const approvals = [];
  let terminal = false;
  const terminalDeadline = Date.now() + 180_000;
  while (Date.now() < terminalDeadline) {
    const pending = await evaluate(`${snapshotExpression}.then(x=>(x.decisions||[]).filter(d=>d.state==='pending').map(d=>d.id))`, true);
    if (pending.length > 0) {
      const clicked = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Allow once');if(!button||button.disabled)return false;button.click();return true;})()`);
      if (clicked) approvals.push({ decisionHash: createHash("sha256").update(String(pending[0])).digest("hex"), action: "allow-once", atUtc: new Date().toISOString() });
    }
    terminal = await evaluate(`(()=>{const cards=[...document.querySelectorAll('.timeline-card')].map(x=>x.innerText);return cards.some(x=>x.includes('Native Runtime')&&x.includes(${JSON.stringify(marker)}))&&cards.some(x=>x.includes('Native Runtime')&&x.includes('Attempt state updated')&&x.includes('COMMITTED'))&&cards.some(x=>x.includes('Tool'));})()`);
    if (terminal) break;
    await sleep(250);
  }
  if (!terminal) throw new Error("GUI did not display native reply, tool activity and terminal state");
  const snapshot = await evaluate(snapshotExpression, true);
  const dom = await evaluate(`(()=>{const cards=[...document.querySelectorAll('.timeline-card')].map(x=>x.innerText);return {connected:document.body.innerText.includes('Core connected'),toolVisible:cards.some(x=>x.includes('Tool')),replyVisible:cards.some(x=>x.includes('Native Runtime')&&x.includes(${JSON.stringify(marker)})),terminalVisible:cards.some(x=>x.includes('Native Runtime')&&x.includes('Attempt state updated')&&x.includes('COMMITTED')),campaignVisible:document.body.innerText.includes(${JSON.stringify(goal)})};})()`);
  step("observe-terminal", `${snapshot.attempt.id}:${snapshot.cursor}`);
  const report = {
    schemaVersion: 1,
    kind: "packaged-connected-gui-operation",
    operationId: `${host}-connected-final`,
    host,
    targetUrl: page.url.replace(/[A-Za-z]:[\\/][^\s]*/g, "<workspace>"),
    steps,
    projectId: snapshot.project.id,
    campaignId: snapshot.activeCampaignId,
    taskId: snapshot.activeTask.id,
    attemptId: snapshot.attempt.id,
    provider: snapshot.attempt.provider,
    providerSessionHash: snapshot.attempt.sessionHash,
    cursor: snapshot.cursor,
    eventCount: snapshot.attempt.eventCount,
    protocolVersion: snapshot.protocolVersion,
    coreBuildId: snapshot.buildId,
    markerSha256: createHash("sha256").update(marker).digest("hex"),
    approvals,
    dom,
    status: Object.values(dom).every(Boolean) && snapshot.attempt.provider === "codex" && typeof snapshot.attempt.sessionHash === "string" ? "PASS" : "UNMET"
  };
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : 1;
} finally {
  ws.close();
}
