// Issue #70 acceptance driver: "When the check says the plan isn't good enough, I want to decide myself instead of
// GoalPort spending another round. And when something stops, I want to see right away what it needs from me."
// Drives the REAL built renderer (electron mode, injected window.goalportCore) over CDP:
// Copy Recommended -> Feedback (plan check: Stop and ask me) -> Save sends modules.feedback ->
// a saved result stopped by that setting says what it needs in one sentence; an old record without a decision is unchanged.
// Usage: node shot-issue70.mjs <outDir> <builtDistDir>   (the shot html is written next to the built index, never into repo dist/)
// Exit 1 if any assertion fails.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "./harness.mjs";

const outDir = resolve(process.argv[2] ?? "artifacts/acceptance/issue70/preview");
const distRoot = resolve(process.argv[3] ?? "");
if (!process.argv[3]) { console.error("Pass the built dist directory (vite --outDir) as the second argument."); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const usable = (id, name) => ({
  instanceId: id, displayName: name, driver: id, enabled: true, installed: true,
  availability: "available", status: "ready", auth: { status: "authenticated", type: "subscription" },
  models: [{ slug: `${id}-model`, name: `${id}-model`, isDefault: true }],
  usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
});
const claude = usable("claude", "Claude");
claude.models = [{ slug: "opus", name: "Opus", isDefault: true }, { slug: "sonnet", name: "Sonnet" }];
const providers = [usable("codex", "Codex"), claude];
const snap = {
  protocolVersion: "goalport.ipc.v2", buildId: "shot-issue70", connection: "connected",
  projects: [], selectedProjectId: "project-goal",
  project: { id: "project-goal", name: "GoalPort", workspaceRoot: "", color: "slate" },
  campaigns: [], activeCampaignId: "",
  activeTask: { id: "", title: "No task selected", acceptance: "", state: "waiting" },
  attempt: { id: "attempt-unassigned", taskId: "", provider: "unassigned", role: "executor", state: "waiting", eventCount: 0 },
  timeline: [], cursor: 0,
  runtimes: [
    { id: "codex", name: "Codex", version: "0.152.0", support: "partial", mode: "Executor", subtitle: "App-server", reasons: [], capabilities: { events: "needs-review", resume: "needs-review", permissions: "needs-review", cancel: "unsupported" } },
  ],
  decisions: [], evidence: [], stopResponsibility: null, relatedHolds: [], preview: false, notices: [], productConversation: null,
};
const configJson = JSON.stringify({ snap, providers }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const pageScript = `    <script>
window.__GOALPORT_ELECTRON__ = true;
(function () {
  var CONFIG = ${configJson};
  window.__shot = { launches: 0, launchedCommands: [], saves: [], authorizations: [] };
  var records = [
    { requestId: "shot-decision", workspacePath: "C:\\work\\demo-project", goal: "Tidy the audit notes", planningHarness: "Codex", reviewHarness: "Claude",
      planText: "1. Read the audit notes.\\n2. Group them by area.", reviewText: "The plan skips the oldest notes.\\nVERDICT: revise", result: null,
      verdict: "revise", stopReason: "The independent check says the plan needs revision, so this stopped.",
      planningQuota: "available", reviewQuota: "available", savedAt: "2026-11-05T09:30:00.000Z",
      workflow: { id: "my-0a1b2c3d", version: 2, name: "Careful plans", planReview: "on" },
      checksRan: [{ kind: "plan-check", harness: "Claude", verdict: "revise" }],
      decision: { kind: "automatic-off", stage: "plan" } },
    { requestId: "shot-old", workspacePath: "C:\\work\\demo-project", goal: "Tidy the old notes", planningHarness: "Codex", reviewHarness: "Claude",
      planText: "1. Read the old notes.\\n2. Group them by area.", reviewText: "The plan skips the oldest notes.\\nVERDICT: revise", result: null,
      verdict: "revise", stopReason: "The independent check says the plan needs revision, so this stopped.",
      planningQuota: "available", reviewQuota: "available", savedAt: "2026-11-04T09:30:00.000Z" },
  ];
  var workflows = [];
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function reply(extra) { return Object.assign({ workflows: clone(workflows), notice: null }, extra || {}); }
  window.goalportCore = {
    snapshot: async () => clone(CONFIG.snap), command: async () => clone(CONFIG.snap), startCore: async () => clone(CONFIG.snap),
    openInVsCode: async () => undefined,
    appInfo: async () => ({ version: "shot", channel: "test", testMode: false, dataPath: "profile", coordinationConfigured: true }),
    backgroundSendConsent: async () => ({ allowed: true }),
    coordinateDiscover: async () => ({ connected: true, sendAuthorized: true, providers: clone(CONFIG.providers), stopReason: null }),
    coordinateLaunch: async (command) => {
      window.__shot.launches += 1; window.__shot.launchedCommands.push(command.commandId);
      var plan = String(command.commandId).includes("plan");
      return { text: plan ? "1. Read the audit findings.\\n2. Group them by area.\\n3. Propose the smallest fix for each." : "The plan can be carried out.\\nVERDICT: carry-out", errorText: "", dispatched: true };
    },
    coordinationAuthorize: async (p) => { window.__shot.authorizations.push(clone(p)); return { ok: true, generation: 1, remaining: p.maxTurns }; },
    coordinationScope: async () => null, coordinationRevoke: async () => ({ ok: true }), coordinationUnblock: async () => ({ ok: true }),
    coordinationRecords: async () => clone(records),
    coordinationSave: async (record) => { var i = records.findIndex((r) => r.requestId === record.requestId); if (i >= 0) records[i] = record; else records.unshift(record); return record; },
    backgroundStatus: async () => null, backgroundRevoke: async () => ({ ok: true }),
    backgroundStart: async () => { throw new Error("The background path is not pressed in this driver"); },
    workflowsList: async () => reply(),
    workflowsSave: async (input) => {
      window.__shot.saves.push(clone(input));
      var existing = workflows.find((w) => w.id === input.id);
      var saved = existing
        ? Object.assign({}, existing, { name: input.name, version: existing.version + 1, modules: input.modules })
        : { schema: 1, id: "my-" + Math.random().toString(16).slice(2, 10).padEnd(8, "0"), version: 1, name: input.name, parent: "recommended@1", modules: input.modules };
      workflows = existing ? workflows.map((w) => (w.id === saved.id ? saved : w)) : workflows.concat([saved]);
      return reply({ saved: clone(saved) });
    },
    workflowsDelete: async (id) => { workflows = workflows.filter((w) => w.id !== id); return reply(); },
  };
})();
    </script>
`;
const shotHtml = resolve(distRoot, "shot-issue70.html");
writeFileSync(shotHtml, readFileSync(resolve(distRoot, "index.html"), "utf8").replace("  </head>", `${pageScript}  </head>`));

const WIDTHS = [820, 1020, 1440];
const INTERNAL = /\b(Attempt|epoch|snapshot|schema|definition|responsibility)\b/i;
const results = []; const failures = [];
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));
let preview, evaluate, until, viewport, fill, screenshot, page;

const readDom = () => evaluate(`(() => {
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
  const dialog = document.querySelector('.workflow-editor-dialog');
  const list = document.querySelector('.runtime-picker-list');
  const overflowing = Array.from(document.querySelectorAll('body *')).filter((e) => {
    const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && s.visibility !== 'hidden' && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('[data-closed], .nav-collapsed, .workflow-editor-dialog');
  }).slice(0, 5).map((e) => (e.className || e.tagName).toString().slice(0, 40));
  const dialogCut = dialog ? Array.from(dialog.querySelectorAll("*:not(.dialog-sr-close)")).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > dialog.getBoundingClientRect().right + 1 || e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible'); }).slice(0, 4).map((e) => (e.className || e.tagName).toString().slice(0, 40)) : [];
  return { body: document.body.innerText || "", dialog: rect(dialog), list: rect(list), innerW: innerWidth, innerH: innerHeight, scrollW: document.documentElement.scrollWidth,
    trigger: document.querySelector('.runtime-picker-button')?.textContent || "", overflowing, dialogCut,
    turns: document.querySelector('#authorization-turns')?.value ?? null,
    sendDisabled: document.querySelector('button[aria-label="Send message"]')?.disabled ?? null };
})()`);

async function capture({ state, needles = [], absent = [], expectDialog, extra }) {
  for (const width of WIDTHS) {
    await viewport(width, 900); await sleep(350);
    const dom = await readDom();
    const checks = [];
    const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
    for (const n of needles) add(`has: ${n}`, dom.body.includes(n));
    for (const n of absent) add(`absent: ${n}`, !dom.body.includes(n));
    add("no internal words", !INTERNAL.test(dom.body), (dom.body.match(INTERNAL) || [""])[0]);
    add("no horizontal overflow", dom.scrollW <= dom.innerW, `scrollW ${dom.scrollW} inner ${dom.innerW}`);
    add("nothing sticks out of the window", dom.overflowing.length === 0, JSON.stringify(dom.overflowing));
    if (expectDialog) {
      add("dialog fully on screen", Boolean(dom.dialog) && dom.dialog.x >= 0 && dom.dialog.y >= 0 && dom.dialog.r <= dom.innerW && dom.dialog.b <= dom.innerH, JSON.stringify(dom.dialog));
      add("nothing cut off inside the dialog", dom.dialogCut.length === 0, JSON.stringify(dom.dialogCut));
    }
    if (extra) for (const c of await extra(dom)) add(c.name, c.ok, c.detail);
    const failed = checks.filter((c) => !c.ok);
    results.push({ state, width, checks });
    await screenshot(resolve(outDir, `${state}-${width}.png`));
    if (failed.length) failures.push({ state, width, failed });
    console.log(`${failed.length ? "FAIL" : "PASS"} ${state} @${width}${failed.length ? ` ${JSON.stringify(failed)}` : ""}`);
  }
  await viewport(1440, 900); await sleep(200);
}

async function realClick(point) {
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
const pointOf = (selector, pattern) => `(() => { const t = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((b) => ${pattern}.test(b.textContent || b.getAttribute('aria-label') || "")); if (!t || t.disabled) return null; t.scrollIntoView({ block: "center" }); const r = t.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`;
async function clickOn(selector, pattern) { await until(pointOf(selector, pattern)); await realClick(await evaluate(pointOf(selector, pattern))); }
const clickText = (pattern) => clickOn('button,[role="option"],[role="menuitem"]', pattern);
// A segmented choice: the option named `option` inside the row named `row`.
const optionPoint = (row, option) => `(() => { const r = Array.from(document.querySelectorAll('.resource-row')).find((x) => x.querySelector('.resource-label')?.textContent.startsWith(${JSON.stringify(row)})); const o = r && Array.from(r.querySelectorAll('.resource-seg-option')).find((x) => x.textContent === ${JSON.stringify(option)}); if (!o) return null; o.scrollIntoView({ block: "center" }); const b = o.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`;
async function choose(row, option) { await until(optionPoint(row, option)); await realClick(await evaluate(optionPoint(row, option))); }
const checkedIn = (row) => evaluate(`Array.from(document.querySelectorAll('.resource-row')).find((x) => x.querySelector('.resource-label')?.textContent.startsWith(${JSON.stringify(row)}))?.querySelector('input:checked')?.value`);

try {
  preview = await startPreview({ dist: distRoot, fixture: "empty" });
  ({ page, evaluate, until, viewport, fill, screenshot } = preview);

  await page.cdp("Page.navigate", { url: `${new URL(preview.url).origin}/shot-issue70.html?preview=empty` });
  await until("Boolean(document.querySelector('.goalport-shell'))");
  await viewport(1440, 900);
  await clickText(/new goal/i);
  await until("Boolean(document.querySelector('#draft-message'))");
  await fill("#draft-message", "Review the audit findings and keep the round bounded.");
  await fill("#draft-workspace", "C:\\work\\demo-project");
  await until(`!!document.querySelector('.runtime-picker-button')`);
  await sleep(500);

  // 1. Copy Recommended… -> Feedback: both rows start on automatic; set the plan check to Stop and ask me.
  await clickOn('.runtime-picker-button', /./);
  await until(`Boolean(document.querySelector('.runtime-picker-list [role="option"]'))`);
  await clickText(/Copy Recommended…/);
  await until(`Boolean(document.querySelector('.workflow-editor-dialog'))`);
  await sleep(300);
  await fill("#workflow-name", "Careful plans");
  const before = [await checkedIn("When the plan check"), await checkedIn("When verification")];
  await choose("When the plan check", "Stop and ask me");
  await until(`Array.from(document.querySelectorAll('.resource-row')).find((x) => x.querySelector('.resource-label')?.textContent.startsWith('When the plan check'))?.querySelector('input:checked')?.value === 'ask'`);
  await evaluate(`document.querySelector('[aria-label="Feedback & continuation"]').scrollIntoView({ block: "center" })`);
  await sleep(200);
  await capture({ state: "01-editor-feedback", expectDialog: true,
    needles: ["Feedback & continuation", "When the plan check asks for changes", "When verification asks for changes", "Revise the plan automatically", "Repair automatically", "Stop and ask me", "Recommended"],
    absent: ["Same as Recommended v1 Feedback"],
    extra: async () => [
      { name: "both rows started on automatic", ok: before[0] === "automatic" && before[1] === "automatic", detail: JSON.stringify(before) },
      { name: "plan check is Stop and ask me", ok: (await checkedIn("When the plan check")) === "ask" },
      { name: "verification still automatic", ok: (await checkedIn("When verification")) === "automatic" },
      { name: "Feedback no longer says Same as Recommended", ok: !(await evaluate(`document.querySelector('[aria-label="Feedback & continuation"]').textContent.includes('Same as Recommended')`)) },
    ] });

  await clickOn('button', /^Save$/);
  await until(`!document.querySelector('.workflow-editor-dialog')`);
  const sent = await evaluate("window.__shot.saves[0]?.modules?.feedback");
  if (!sent || sent.planRevision !== "ask" || sent.repair !== "automatic") failures.push({ state: "save", width: null, failed: [{ name: "Save sent the chosen feedback", ok: false, detail: JSON.stringify(sent) }] });

  // 2. A saved result the setting stopped: one sentence saying what it needs.
  await clickOn('button[aria-label^="Plan: Tidy the audit notes"]', /./);
  await until(`Boolean(document.querySelector('.coordination-decision'))`);
  await sleep(300);
  await capture({ state: "02-result-decision", needles: ["The check asked for changes to the plan.", "Your workflow stops here, so nothing more was spent.", "Automatic plan revision: off in Careful plans", "Technical details"],
    absent: ["This plan needs changes.", "Stop reason"],
    extra: async () => [
      { name: "the engine sentence is not visible outside Technical details", ok: await evaluate(`(() => { const t = document.querySelector('.coordination-outcome').textContent; return !t.includes('so this stopped'); })()`) },
      { name: "the sentence appears once", ok: (await evaluate(`document.body.innerText.split('Your workflow stops here').length - 1`)) === 1 },
    ] });

  // 3. An old record (no decision) renders exactly as before.
  await clickOn('button[aria-label^="Plan: Tidy the old notes"]', /./);
  await until(`Boolean(document.querySelector('.coordination-status')) && !document.querySelector('.coordination-decision') && document.body.innerText.includes('Tidy the old notes') || !document.querySelector('.coordination-decision')`);
  await sleep(300);
  await capture({ state: "03-result-old-record", needles: ["Stop reason", "This plan needs changes. Revise keeps it and lets you send an update."], absent: ["Your workflow stops here", "off in Careful plans"] });
} catch (e) {
  failures.push({ state: "driver", width: null, failed: [{ name: "driver threw", ok: false, detail: String((e && e.stack) || e) }] });
  try { await screenshot(resolve(outDir, "driver-error.png")); } catch { /* best effort */ }
} finally {
  try { await preview?.stop(); } catch { /* best effort */ }
}
writeFileSync(resolve(outDir, "issue70-results.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
if (failures.length) { console.error(`shot-issue70: ${failures.length} failing`); for (const f of failures) console.error(JSON.stringify(f, null, 2).slice(0, 2500)); process.exit(1); }
console.log(`shot-issue70: all states verified; shots in ${outDir}`);
process.exit(0);
