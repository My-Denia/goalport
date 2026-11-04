// Issue #80 acceptance driver: why Send is off + the one-time grant as a real button.
// User intent: "I typed my goal and picked a folder but Send is greyed out - tell me why in plain
// words next to the button, and let me fix it with one obvious button."
// Drives the REAL built renderer (electron mode, injected window.goalportCore) over CDP.
// Writes only under artifacts/acceptance/issue80/preview. Exit 1 if any assertion fails.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "./harness.mjs";

const outDir = resolve(process.argv[2] ?? "artifacts/acceptance/issue80/preview");
const distRoot = resolve("dist");
mkdirSync(outDir, { recursive: true });

const usable = (id, name) => ({
  instanceId: id, displayName: name, driver: id, enabled: true, installed: true,
  availability: "available", status: "ready", auth: { status: "authenticated", type: "subscription" },
  models: [{ slug: `${id}-model`, name: `${id}-model`, isDefault: true }],
  usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
});
const providers = [usable("codex", "Codex"), usable("claude", "Claude")];
const snap = {
  protocolVersion: "goalport.ipc.v2", buildId: "shot-issue80", connection: "connected",
  projects: [], selectedProjectId: "project-goal",
  project: { id: "project-goal", name: "GoalPort", workspaceRoot: "", color: "slate" },
  campaigns: [], activeCampaignId: "",
  activeTask: { id: "", title: "No task selected", acceptance: "", state: "waiting" },
  attempt: { id: "attempt-unassigned", taskId: "", provider: "unassigned", role: "executor", state: "waiting", eventCount: 0 },
  timeline: [], cursor: 0,
  runtimes: [
    { id: "claude", name: "Claude Code", version: "2.1.252", support: "partial", mode: "Planner", subtitle: "Native CLI", reasons: [], capabilities: { events: "needs-review", resume: "needs-review", permissions: "needs-review", cancel: "unsupported" } },
    { id: "codex", name: "Codex", version: "0.152.0", support: "partial", mode: "Executor", subtitle: "App-server", reasons: [], capabilities: { events: "needs-review", resume: "needs-review", permissions: "needs-review", cancel: "unsupported" } },
  ],
  decisions: [], evidence: [], stopResponsibility: null, relatedHolds: [], preview: false, notices: [], productConversation: null,
};
const configJson = JSON.stringify({ snap, providers }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const pageScript = `    <script>
window.__GOALPORT_ELECTRON__ = true;
(function () {
  var CONFIG = ${configJson};
  var q = new URLSearchParams(location.search);
  window.__shot = { discover: q.get("discover") || "ok", configured: false, discovers: 0, launches: 0 };
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  window.goalportCore = {
    snapshot: async () => clone(CONFIG.snap), command: async () => clone(CONFIG.snap), startCore: async () => clone(CONFIG.snap),
    openInVsCode: async () => undefined,
    appInfo: async () => ({ version: "shot", channel: "test", testMode: false, dataPath: "profile", coordinationConfigured: window.__shot.configured }),
    backgroundSendConsent: async (action) => {
      if (action === "grant") { window.__shot.configured = true; return { allowed: true, grantedAt: new Date().toISOString() }; }
      return { allowed: window.__shot.configured };
    },
    coordinateDiscover: async () => {
      window.__shot.discovers += 1;
      if (window.__shot.discover === "hold") return new Promise(function (r) { window.__shot.release = function () { r({ connected: true, sendAuthorized: window.__shot.configured, providers: clone(CONFIG.providers), stopReason: null }); }; });
      return { connected: true, sendAuthorized: window.__shot.configured, providers: clone(CONFIG.providers), stopReason: null };
    },
    coordinateLaunch: async () => { window.__shot.launches += 1; return { text: "", errorText: "" }; },
    coordinationAuthorize: async (p) => ({ ok: true, generation: 1, remaining: p.maxTurns }),
    coordinationScope: async () => null, coordinationRevoke: async () => ({ ok: true }), coordinationUnblock: async () => ({ ok: true }),
    coordinationRecords: async () => [], coordinationSave: async () => undefined,
    backgroundStatus: async () => null, backgroundRevoke: async () => ({ ok: true }),
    backgroundStart: async () => { throw new Error("Send is never pressed in this driver"); },
  };
})();
    </script>
`;
writeFileSync(resolve(distRoot, "shot-issue80.html"), readFileSync(resolve(distRoot, "index.html"), "utf8").replace("  </head>", `${pageScript}  </head>`));

const GRANT_LABEL = "Allow GoalPort to run agent turns on this profile";
const GRANT_NOTE = "GoalPort asks once per profile. After that, the agents you choose below can run turns here.";
const R_GRANT = `Press “${GRANT_LABEL}” above to send.`;
const R_FOLDER = "Choose a project folder.";
const R_GOAL = "Write your goal.";
const WAIT_LOAD = "Checking which agents can work on this goal";

const results = []; const failures = [];
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));
let preview, evaluate, until, viewport, click, fill, screenshot, page;

const readDom = () => evaluate(`(() => {
  const body = document.body.innerText || "";
  const reasons = Array.from(document.querySelectorAll('.send-disabled-reason'));
  const send = document.querySelector('button[aria-label="Send message"]');
  const grant = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent||"").trim() === ${JSON.stringify(GRANT_LABEL)});
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; };
  const actions = document.querySelector('.dialog-actions');
  const kids = actions ? Array.from(actions.children).map((c) => ({ tag: c.tagName, cls: c.className, rect: rect(c) })) : [];
  const sr = rect(send), rr = rect(reasons[0] || null);
  const overlap = sr && rr ? !(rr.r <= sr.x || sr.r <= rr.x || rr.b <= sr.y || sr.b <= rr.y) : false;
  return { body, reasonTexts: reasons.map((e) => e.textContent), sendDisabled: send ? send.disabled : null, sendRect: sr, reasonRect: rr,
    reasonOverlapsSend: overlap, grantRect: rect(grant), grantInViewport: grant ? (grant.getBoundingClientRect().top >= 0 && grant.getBoundingClientRect().bottom <= innerHeight) : null,
    grantDisabled: grant ? grant.disabled : null, grantClass: grant ? grant.className : null,
    sendInViewport: send ? (send.getBoundingClientRect().top >= 0 && send.getBoundingClientRect().bottom <= innerHeight) : null,
    scrollW: document.documentElement.scrollWidth, innerW: innerWidth, bodyScrollW: document.body.scrollWidth, kids };
})()`);

async function capture({ state, width, height = 900, reason, noReason, grantVisible, sendDisabled, needles = [], absent = [] }) {
  await viewport(width, height); await sleep(350);
  const dom = await readDom();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  if (reason) add(`reason="${reason}"`, dom.reasonTexts.length === 1 && dom.reasonTexts[0] === reason, `got ${JSON.stringify(dom.reasonTexts)}`);
  if (noReason) add("no reason line", dom.reasonTexts.length === 0, `got ${JSON.stringify(dom.reasonTexts)}`);
  if (dom.reasonTexts.length > 1) add("reason not duplicated", false, JSON.stringify(dom.reasonTexts));
  if (reason) add("reason sentence appears once in body", dom.body.split(reason).length === 2, `count ${dom.body.split(reason).length - 1}`);
  if (grantVisible !== undefined) add(`grant button present=${grantVisible}`, (dom.grantRect !== null) === grantVisible, JSON.stringify(dom.grantRect));
  if (grantVisible) { add("grant is button-primary", /button-primary/.test(dom.grantClass || ""), dom.grantClass); add("grant note text", dom.body.includes(GRANT_NOTE), "note"); }
  if (sendDisabled !== undefined) add(`sendDisabled=${sendDisabled}`, dom.sendDisabled === sendDisabled, `actual ${dom.sendDisabled}`);
  for (const n of needles) add(`has:${n}`, dom.body.includes(n), "");
  for (const n of absent) add(`absent:${n}`, !dom.body.includes(n), "");
  add("no horizontal overflow", dom.scrollW <= dom.innerW && dom.bodyScrollW <= dom.innerW, `scrollW ${dom.scrollW} inner ${dom.innerW}`);
  add("reason does not overlap Send", !dom.reasonOverlapsSend, JSON.stringify({ s: dom.sendRect, r: dom.reasonRect }));
  const failed = checks.filter((c) => !c.ok);
  results.push({ state, width, grantInViewport: dom.grantInViewport, sendInViewport: dom.sendInViewport, grantRect: dom.grantRect, sendRect: dom.sendRect, reasonRect: dom.reasonRect, actions: dom.kids, checks });
  await screenshot(resolve(outDir, `${state}-${width}.png`));
  if (failed.length) failures.push({ state, width, failed });
  console.log(`${failed.length ? "FAIL" : "PASS"} ${state} @${width} grantOnScreen=${dom.grantInViewport} sendOnScreen=${dom.sendInViewport} reason=${JSON.stringify(dom.reasonTexts)}`);
}

async function realClick(point) {
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
const textPoint = (pattern) => `(() => { const t = Array.from(document.querySelectorAll('button,[role="option"],[role="menuitem"]')).find((b) => ${pattern}.test(b.textContent || "")); if (!t || t.disabled) return null; t.scrollIntoView({ block: "center" }); const r = t.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`;
async function clickText(pattern) { await until(textPoint(pattern)); await realClick(await evaluate(textPoint(pattern))); }

async function openDraft(query) {
  await page.cdp("Page.navigate", { url: `${new URL(preview.url).origin}/shot-issue80.html?preview=empty${query}` });
  await until("Boolean(document.querySelector('.goalport-shell'))");
  await viewport(1440, 900);
}
async function newGoalRecommended() {
  await clickText(/new goal/i);
  await until("Boolean(document.querySelector('#draft-message'))");
  const chosen = await evaluate(`Boolean(document.querySelector('.runtime-picker-button strong')?.textContent?.includes('Recommended'))`);
  if (!chosen) {
    await click(".runtime-picker-button");
    await sleep(200);
    await clickText(/Recommended workflow/);
    await sleep(300);
  }
}

try {
  preview = await startPreview({ dist: distRoot, fixture: "empty" });
  ({ page, evaluate, until, viewport, click, fill, screenshot } = preview);

  await openDraft("&discover=ok");
  for (const w of [860, 1020, 1440]) await capture({ state: "00-first-launch", width: w });

  await newGoalRecommended();
  await fill("#draft-message", "Review the audit findings and keep the round bounded.");
  await fill("#draft-workspace", "C:\\work\\demo-project");
  await until(`(document.body.innerText||"").includes(${JSON.stringify(GRANT_LABEL)})`);
  for (const w of [860, 1020, 1440]) await capture({ state: "01-grant-missing", width: w, reason: R_GRANT, grantVisible: true, sendDisabled: true, absent: [WAIT_LOAD] });

  await viewport(1440, 900);
  await clickText(new RegExp(GRANT_LABEL));
  await until(`!(document.body.innerText||"").includes(${JSON.stringify(R_GRANT)})`);
  await sleep(400);
  for (const w of [860, 1020, 1440]) await capture({ state: "02-after-grant", width: w, noReason: true, grantVisible: false, sendDisabled: false, absent: [R_GRANT] });

  await fill("#draft-workspace", "");
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await sleep(300);
  for (const w of [860, 1020, 1440]) await capture({ state: "03-no-folder", width: w, reason: R_FOLDER, sendDisabled: true });

  await fill("#draft-workspace", "C:\\work\\demo-project");
  await fill("#draft-message", "x");
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await sleep(300);
  for (const w of [860, 1020, 1440]) await capture({ state: "04-empty-goal", width: w, reason: R_GOAL, sendDisabled: true });

  await openDraft("&discover=hold");
  await newGoalRecommended();
  await fill("#draft-message", "Review the audit findings and keep the round bounded.");
  await fill("#draft-workspace", "C:\\work\\demo-project");
  await sleep(500);
  const dl = await evaluate(`(document.body.innerText||"").includes(${JSON.stringify(WAIT_LOAD)})`);
  if (dl) for (const w of [860, 1020, 1440]) await capture({ state: "05-agents-loading", width: w, needles: [WAIT_LOAD], sendDisabled: true });
  else { failures.push({ state: "05-agents-loading", width: null, failed: [{ name: "loading sentence not reproducible", ok: false, detail: "" }] }); await screenshot(resolve(outDir, "05-agents-loading-notrepro.png")); }
  const launches = await evaluate("window.__shot.launches");
  if (launches !== 0) failures.push({ state: "no-launch", width: null, failed: [{ name: "launches", ok: false, detail: String(launches) }] });
} catch (e) {
  failures.push({ state: "driver", width: null, failed: [{ name: "driver threw", ok: false, detail: String((e && e.stack) || e) }] });
  try { await screenshot(resolve(outDir, "driver-error.png")); } catch { /* best effort */ }
} finally {
  try { await preview?.stop(); } catch { /* best effort */ }
}
writeFileSync(resolve(outDir, "issue80-results.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
if (failures.length) { console.error(`shot-issue80: ${failures.length} failing`); for (const f of failures) console.error(JSON.stringify(f, null, 2).slice(0, 2500)); process.exit(1); }
console.log(`shot-issue80: all states verified; shots in ${outDir}`);
process.exit(0);
