// Renderer-interaction acceptance driver for the PR #27 bounded closeout
// (GAH run pr27-panel-gate-copy-20261012): Send admission vs harness-access
// load, and the settled-stop sentence.
//
// User intent for the states below:
//   "I wrote a goal without picking a Runtime and pressed Send: GoalPort is
//    still checking which harnesses can work — I want Send to wait for MY
//    confirmation, tell me plainly when that check fails, and let me retry;
//    and when I come back to a job I stopped, I want to be told it actually
//    stopped and what survived."
//
// Like scripts/preview/shot-bg-closeout.mjs this drives the REAL built
// renderer (dist/shot-panel-gate.html gets the Electron preload port
// window.goalportCore injected BEFORE head scripts run) in electron mode:
// real CDP mouse/keyboard input against the live DOM against a scripted
// bridge that mirrors the bridge CONTRACT, not real worker execution. It
// FAILS (exit 1) if any asserted sentence is not visible in the real DOM.
// This harness accepts CDP expression strings ONLY.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "./harness.mjs";

const runDir = resolve("goal-runs/pr27-panel-gate-copy-20261012");
const outDir = resolve(process.argv[2] ?? resolve(runDir, "evidence/shots"));
const distRoot = resolve("dist");
mkdirSync(outDir, { recursive: true });

const usableHarness = (instanceId, displayName) => ({
  instanceId, displayName, driver: instanceId, enabled: true, installed: true,
  availability: "available", status: "ready", auth: { status: "authenticated", type: "subscription" },
  models: [{ slug: `${instanceId}-model`, name: `${instanceId}-model`, isDefault: true }],
  usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
});
const providers = [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")];

const emptySnapshot = {
  protocolVersion: "goalport.ipc.v2",
  buildId: "shot-panel-gate",
  connection: "connected",
  projects: [],
  selectedProjectId: "project-goal",
  project: { id: "project-goal", name: "GoalPort", workspaceRoot: "/work/goal", color: "slate" },
  campaigns: [],
  activeCampaignId: "",
  activeTask: { id: "", title: "No task selected", acceptance: "", state: "waiting" },
  attempt: { id: "attempt-unassigned", taskId: "", provider: "unassigned", role: "executor", state: "waiting", eventCount: 0 },
  timeline: [],
  cursor: 0,
  runtimes: [
    { id: "claude", name: "Claude Code", version: "2.1.252", support: "partial", mode: "Planner", subtitle: "Native CLI · Preview path", reasons: ["Structured planning events observed"], capabilities: { events: "needs-review", resume: "needs-review", permissions: "needs-review", cancel: "unsupported" } },
    { id: "codex", name: "Codex", version: "0.152.0", support: "partial", mode: "Executor", subtitle: "App-server candidate · Preview path", reasons: ["Current role matches workspace execution"], capabilities: { events: "needs-review", resume: "needs-review", permissions: "needs-review", cancel: "unsupported" } },
  ],
  decisions: [],
  evidence: [],
  stopResponsibility: null,
  relatedHolds: [],
  preview: false,
  notices: [],
  productConversation: null,
};

const stoppedJob = {
  jobId: "job-stopped", requestId: "shot-stopped", goal: "Fix the helper.",
  state: "stopped", live: false, active: false, revoked: true, workerPid: 42,
  readMaxTurns: 4, writeMaxTurns: null, counters: { readTurnsLeft: 1, writeTurnsLeft: null },
  pendingCommand: null, completedCommands: [], progress: null,
  outcome: { status: "stopped" },
};

// JSON inside a <script> tag needs "<" and the two JS line separators
// escaped (CodeQL posture, mirrors shot-bg-closeout.mjs).
const configJson = JSON.stringify({ emptySnapshot, providers, stoppedJob })
  .replace(/</g, "\\u003c")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");

const pageScript = `    <script>
window.__GOALPORT_ELECTRON__ = true;
(function () {
  var CONFIG = ${configJson};
  var mode = new URLSearchParams(location.search).get("discover") || "hold";
  window.__shot = { discover: mode, status: null, launches: 0, discovers: 0 };
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  window.goalportCore = {
    snapshot: async () => clone(CONFIG.emptySnapshot),
    command: async () => clone(CONFIG.emptySnapshot),
    startCore: async () => clone(CONFIG.emptySnapshot),
    openInVsCode: async () => undefined,
    appInfo: async () => ({ version: "shot", channel: "test", testMode: false, dataPath: "profile", coordinationConfigured: true }),
    coordinateDiscover: async () => {
      window.__shot.discovers += 1;
      if (window.__shot.discover === "hold") {
        return new Promise(function (resolve) {
          window.__shot.release = function () {
            resolve({ connected: true, sendAuthorized: true, providers: clone(CONFIG.providers), stopReason: null });
          };
        });
      }
      if (window.__shot.discover === "fail") return { connected: false, sendAuthorized: false, providers: [], stopReason: "Send is not enabled." };
      return { connected: true, sendAuthorized: true, providers: clone(CONFIG.providers), stopReason: null };
    },
    coordinateLaunch: async () => { window.__shot.launches += 1; return { text: "", errorText: "" }; },
    coordinationAuthorize: async (payload) => ({ ok: true, generation: 1, remaining: payload.maxTurns }),
    coordinationScope: async () => null,
    coordinationRevoke: async () => ({ ok: true }),
    coordinationUnblock: async () => ({ ok: true }),
    coordinationRecords: async () => [],
    coordinationSave: async () => undefined,
    backgroundStatus: async () => (window.__shot.status ? clone(window.__shot.status) : null),
    backgroundRevoke: async () => ({ ok: true }),
    backgroundStart: async () => { throw new Error("not used in this shot"); },
  };
})();
    </script>
`;

const index = readFileSync(resolve(distRoot, "index.html"), "utf8");
writeFileSync(resolve(distRoot, "shot-panel-gate.html"), index.replace("  </head>", `${pageScript}  </head>`));

const WAIT_SENTENCE = "Checking which harnesses can work on this goal";
const PANEL_LEAD = "Nothing is sent until you press Send.";
const FAIL_SENTENCE = "could not load your harness-access choices";
const RETRY_LABEL = "Retry harness access";
const STOP_REASON = "Send is not enabled.";
const SETTLED_SENTENCE = "This goal was stopped and has settled";
const INFLIGHT_CLAIM = "The current turn may finish";

let preview = null;
let page = null;
let evaluate = null;
let until = null;
let viewport = null;
let click = null;
let fill = null;
let screenshot = null;
const results = [];
const failures = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function readDom() {
  return evaluate(`(() => {
    const body = document.body.innerText || "";
    const send = document.querySelector('button[aria-label="Send message"], button[aria-label="Send"]');
    return {
      body,
      sendDisabled: send ? send.disabled : null,
      statuses: Array.from(document.querySelectorAll('[role="status"]')).map((e) => e.textContent || ""),
    };
  })()`);
}

async function capture({ state, width, needles = [], absentNeedles = [], sendDisabled = undefined }) {
  await viewport(width, 900);
  await sleep(300);
  const dom = await readDom();
  const checks = [];
  const missing = needles.filter((needle) => !dom.body.includes(needle));
  checks.push({ name: `text:${needles.join(" | ") || "(none)"}`, ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(" | ")}` : "all visible" });
  if (absentNeedles.length) {
    const present = absentNeedles.filter((needle) => dom.body.includes(needle));
    checks.push({ name: `absent:${absentNeedles.join(" | ")}`, ok: present.length === 0, detail: present.length ? `unexpectedly visible: ${present.join(" | ")}` : "none present" });
  }
  if (sendDisabled !== undefined) checks.push({ name: `sendDisabled=${sendDisabled}`, ok: dom.sendDisabled === sendDisabled, detail: `actual ${dom.sendDisabled}` });
  const failed = checks.filter((check) => !check.ok);
  results.push({ state, width, checks: checks.map((check) => ({ name: check.name, ok: check.ok, detail: check.detail })) });
  await screenshot(resolve(outDir, `${state}-${width}.png`));
  if (failed.length) failures.push({ state, width, failed, body: dom.body.slice(0, 2000) });
}

function clickText(pattern) {
  return `(() => {
    const target = Array.from(document.querySelectorAll('button')).find((b) => ${pattern}.test(b.textContent || ""));
    if (!target || target.disabled) return null;
    target.scrollIntoView({ block: "center" });
    const r = target.getBoundingClientRect();
    return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  })()`;
}

try {
  preview = await startPreview({ dist: distRoot, fixture: "empty" });
  ({ page, evaluate, until, viewport, click, fill, screenshot } = preview);

  // ---- S1: panel loading holds Send ------------------------------------
  await page.cdp("Page.navigate", { url: `${new URL(preview.url).origin}/shot-panel-gate.html?preview=empty&discover=hold` });
  await until("Boolean(document.querySelector('.goalport-shell'))");
  await until(clickText("/new goal/i"));
  const newGoalPoint = await evaluate(clickText("/new goal/i"));
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...newGoalPoint });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...newGoalPoint });
  await until("Boolean(document.querySelector('#draft-message'))");
  await fill("#draft-message", "Fold the audit findings in and keep the round bounded.");
  await until(`(document.body.innerText || "").includes(${JSON.stringify(WAIT_SENTENCE)})`);
  for (const width of [860, 1020, 1440]) {
    await capture({ state: "panel-loading", width, needles: [WAIT_SENTENCE], absentNeedles: [PANEL_LEAD], sendDisabled: true });
  }

  // ---- S2: the panel lands and Send unlocks -----------------------------
  await evaluate("window.__shot.release && window.__shot.release()");
  await until(`(document.body.innerText || "").includes(${JSON.stringify(PANEL_LEAD)})`);
  for (const width of [860, 1020, 1440]) {
    await capture({ state: "panel-ready", width, needles: [PANEL_LEAD], absentNeedles: [WAIT_SENTENCE], sendDisabled: false });
  }
  const launchesWhileHeld = await evaluate("window.__shot.launches");
  if (launchesWhileHeld !== 0) failures.push({ state: "no-launch-while-held", width: null, failed: [{ name: "launches", ok: false, detail: `legacy launch fired ${launchesWhileHeld} times` }] });

  // ---- S3: discovery fails, retry recovers ------------------------------
  await page.cdp("Page.navigate", { url: `${new URL(preview.url).origin}/shot-panel-gate.html?preview=empty&discover=fail` });
  await until("Boolean(document.querySelector('.goalport-shell'))");
  await until(clickText("/new goal/i"));
  const newGoalPoint2 = await evaluate(clickText("/new goal/i"));
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...newGoalPoint2 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...newGoalPoint2 });
  await until("Boolean(document.querySelector('#draft-message'))");
  await fill("#draft-message", "Fold the audit findings in and keep the round bounded.");
  await until(`(document.body.innerText || "").includes(${JSON.stringify(FAIL_SENTENCE)})`);
  // Open the collapsed technical details so the stop reason is part of the shot.
  await click("details.technical-details summary");
  await sleep(150);
  for (const width of [860, 1020, 1440]) {
    await capture({ state: "panel-failed", width, needles: [FAIL_SENTENCE, RETRY_LABEL, STOP_REASON], sendDisabled: true });
  }
  const discoversBeforeRetry = await evaluate("window.__shot.discovers");
  await evaluate("window.__shot.discover = 'ok'");
  await until(clickText("/Retry harness access/"));
  const retryPoint = await evaluate(clickText("/Retry harness access/"));
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...retryPoint });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...retryPoint });
  await until(`(document.body.innerText || "").includes(${JSON.stringify(PANEL_LEAD)})`);
  const discoversAfterRetry = await evaluate("window.__shot.discovers");
  if (discoversAfterRetry !== discoversBeforeRetry + 1) failures.push({ state: "retry-runs-discovery", width: null, failed: [{ name: "discover calls", ok: false, detail: `before ${discoversBeforeRetry}, after ${discoversAfterRetry}` }] });
  await capture({ state: "panel-recovered", width: 1440, needles: [PANEL_LEAD], absentNeedles: [FAIL_SENTENCE], sendDisabled: false });

  // ---- S4: a settled stop is told as settled ----------------------------
  await evaluate(`window.__shot.status = JSON.parse(${JSON.stringify(JSON.stringify(stoppedJob))})`);
  await until(`Array.from(document.querySelectorAll('button')).some((b) => /Return to background goal/.test(b.textContent || ""))`);
  await until(clickText("/Return to background goal/"));
  const returnPoint = await evaluate(clickText("/Return to background goal/"));
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...returnPoint });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...returnPoint });
  await until(`(document.body.innerText || "").includes(${JSON.stringify(SETTLED_SENTENCE)})`);
  for (const width of [860, 1020, 1440]) {
    await capture({ state: "stopped-settled", width, needles: [SETTLED_SENTENCE, "Fix the helper."], absentNeedles: [INFLIGHT_CLAIM] });
  }
} catch (error) {
  failures.push({ state: "driver", width: null, failed: [{ name: "driver threw", ok: false, detail: String((error && error.stack) || error) }] });
} finally {
  try { await preview?.cleanup(); } catch { /* best effort */ }
}

writeFileSync(resolve(outDir, "panel-gate-results.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
if (failures.length) {
  console.error(`shot-panel-gate: ${failures.length} failing state(s):`);
  for (const failure of failures) console.error(JSON.stringify(failure, null, 2).slice(0, 3000));
  process.exit(1);
}
console.log(`shot-panel-gate: all states verified; shots in ${outDir}`);
// Windows: an orphaned delegated headless shell or a lingering WebSocket can
// hold the event loop after everything is flushed; the evidence is complete.
process.exit(0);
