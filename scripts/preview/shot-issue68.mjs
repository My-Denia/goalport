// Issue #68 acceptance driver: "I copy the recommended method, switch off what I don't need, give it a
// name, and from now on I can pick it and see that it was actually followed."
// Drives the REAL built renderer (electron mode, injected window.goalportCore) over CDP and walks the
// whole path: Copy Recommended -> editor -> Save -> it is picked -> Send -> a plan that says review did not run.
// The workflow store, discovery and launch are faked in-page; nothing here proves the main process admits a
// one-agent background job (the background path is not pressed).
// Usage: node shot-issue68.mjs <outDir> <builtDistDir>   (the shot html is written next to the built index, never into repo dist/)
// Exit 1 if any assertion fails.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "./harness.mjs";

const outDir = resolve(process.argv[2] ?? "artifacts/acceptance/issue68/preview");
const distRoot = resolve(process.argv[3] ?? "");
if (!process.argv[3]) { console.error("Pass the built dist directory (vite --outDir) as the second argument."); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const usable = (id, name) => ({
  instanceId: id, displayName: name, driver: id, enabled: true, installed: true,
  availability: "available", status: "ready", auth: { status: "authenticated", type: "subscription" },
  models: [{ slug: `${id}-model`, name: `${id}-model`, isDefault: true }],
  usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
});
// One signed-in agent: enough only because the user switched plan review off.
const providers = [usable("codex", "Codex")];
const snap = {
  protocolVersion: "goalport.ipc.v2", buildId: "shot-issue68", connection: "connected",
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
  window.__shot = { launches: 0, launchedCommands: [], saves: [], deletes: 0 };
  var records = [];
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
      return { text: "1. Read the audit findings.\\n2. Group them by area.\\n3. Propose the smallest fix for each.", errorText: "", dispatched: true };
    },
    coordinationAuthorize: async (p) => ({ ok: true, generation: 1, remaining: p.maxTurns }),
    coordinationScope: async () => null, coordinationRevoke: async () => ({ ok: true }), coordinationUnblock: async () => ({ ok: true }),
    coordinationRecords: async () => clone(records),
    coordinationSave: async (record) => { var i = records.findIndex((r) => r.requestId === record.requestId); if (i >= 0) records[i] = record; else records.unshift(record); return record; },
    backgroundStatus: async () => null, backgroundRevoke: async () => ({ ok: true }),
    backgroundStart: async () => { throw new Error("The background path is not pressed in this driver"); },
    workflowsList: async () => reply(),
    workflowsSave: async (input) => {
      window.__shot.saves.push(clone(input));
      if (workflows.some((w) => w.id !== input.id && (w.name || "").toLowerCase() === input.name.toLowerCase())) return { error: "You already have a workflow with that name." };
      var existing = workflows.find((w) => w.id === input.id);
      var saved = existing
        ? Object.assign({}, existing, { name: input.name, version: existing.version + 1, modules: input.modules })
        : { schema: 1, id: "my-" + Math.random().toString(16).slice(2, 10).padEnd(8, "0"), version: 1, name: input.name, parent: "recommended@1", modules: input.modules };
      workflows = existing ? workflows.map((w) => (w.id === saved.id ? saved : w)) : workflows.concat([saved]);
      return reply({ saved: clone(saved) });
    },
    workflowsDelete: async (id) => { window.__shot.deletes += 1; workflows = workflows.filter((w) => w.id !== id); return reply(); },
  };
})();
    </script>
`;
const shotHtml = resolve(distRoot, "shot-issue68.html");
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
    return r.width > 0 && s.visibility !== 'hidden' && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('[data-closed], .nav-collapsed');
  }).slice(0, 5).map((e) => (e.className || e.tagName).toString().slice(0, 40));
  return { body: document.body.innerText || "", dialog: rect(dialog), list: rect(list), innerW: innerWidth, innerH: innerHeight, scrollW: document.documentElement.scrollWidth,
    trigger: document.querySelector('.runtime-picker-button')?.textContent || "", overflowing,
    sendDisabled: document.querySelector('button[aria-label="Send message"]')?.disabled ?? null,
    reason: document.querySelector('.send-disabled-reason')?.textContent || null };
})()`);

async function capture({ state, needles = [], absent = [], expectDialog, expectList, extra }) {
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
    if (expectDialog) add("dialog fully on screen", Boolean(dom.dialog) && dom.dialog.x >= 0 && dom.dialog.y >= 0 && dom.dialog.r <= dom.innerW && dom.dialog.b <= dom.innerH, JSON.stringify(dom.dialog));
    if (expectList) add("picker list fully on screen", Boolean(dom.list) && dom.list.x >= 0 && dom.list.r <= dom.innerW && dom.list.b <= dom.innerH, JSON.stringify(dom.list));
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

try {
  preview = await startPreview({ dist: distRoot, fixture: "empty" });
  ({ page, evaluate, until, viewport, fill, screenshot } = preview);

  await page.cdp("Page.navigate", { url: `${new URL(preview.url).origin}/shot-issue68.html?preview=empty` });
  await until("Boolean(document.querySelector('.goalport-shell'))");
  await viewport(1440, 900);
  await clickText(/new goal/i);
  await until("Boolean(document.querySelector('#draft-message'))");
  await fill("#draft-message", "Review the audit findings and keep the round bounded.");
  await fill("#draft-workspace", "C:\\work\\demo-project");
  await until(`!!document.querySelector('.runtime-picker-button')`);
  await sleep(500);

  // 1. Nothing saved yet: the picker offers Recommended and a way to make a copy, and no "coming soon" row.
  await clickOn('.runtime-picker-button', /./);
  await until(`Boolean(document.querySelector('.runtime-picker-list [role="option"]'))`);
  await capture({ state: "01-picker-nothing-saved", expectList: true, needles: ["Recommended workflow", "Copy Recommended…"], absent: ["Coming soon", "My workflow"] });

  // 2. Copy Recommended… opens the one editor dialog.
  await clickText(/Copy Recommended…/);
  await until(`Boolean(document.querySelector('.workflow-editor-dialog'))`);
  await sleep(300);
  await capture({ state: "02-editor-copy", expectDialog: true,
    needles: ["Copy Recommended workflow", "Independent plan review", "Reviewer must be able to read your files", "Goals that change files are always reviewed first.", "Same as Recommended v1"],
    extra: async () => [{ name: "name field has focus", ok: await evaluate(`document.activeElement?.id === 'workflow-name'`) }] });

  // 3. Rename, switch plan review off, save: it is picked right away.
  await fill("#workflow-name", "Quick plans");
  await clickOn('.workflow-option', /Independent plan review/);
  await until(`document.querySelector('.workflow-editor-dialog input[type="checkbox"]')?.checked === false`);
  await capture({ state: "03-editor-review-off", expectDialog: true, needles: ["Copy Recommended workflow"],
    extra: async () => [{ name: "name is what the user typed", ok: await evaluate(`document.querySelector('#workflow-name')?.value === 'Quick plans'`) }] });
  await clickOn('button', /^Save$/);
  await until(`!document.querySelector('.workflow-editor-dialog')`);
  await sleep(300);
  await capture({ state: "04-saved-and-picked", needles: ["Quick plans"], absent: ["Copy Recommended workflow"],
    extra: async (dom) => [
      { name: "trigger names the workflow", ok: dom.trigger.includes("Quick plans"), detail: dom.trigger },
      { name: "one agent is enough with review off: Send is on", ok: dom.sendDisabled === false, detail: String(dom.sendDisabled) },
      { name: "no reason line", ok: dom.reason === null, detail: String(dom.reason) },
    ] });

  // 4. The picker now lists it with a plain line.
  await clickOn('.runtime-picker-button', /./);
  await until(`Boolean(document.querySelector('.runtime-picker-list [role="option"]'))`);
  await capture({ state: "05-picker-with-saved", expectList: true, needles: ["Quick plans", "Your copy of Recommended · plan review off", "Copy Recommended…"], absent: ["Coming soon"] });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(`!document.querySelector('.runtime-picker-list:not([data-closed])')`);

  // 5. Edit reopens the saved one with the same choices.
  await clickOn('button', /^Edit$/);
  await until(`Boolean(document.querySelector('.workflow-editor-dialog'))`);
  await sleep(300);
  await capture({ state: "06-editor-edit-existing", expectDialog: true, needles: ["Edit workflow", "Delete…"],
    extra: async () => [{ name: "name is the saved one", ok: await evaluate(`document.querySelector('#workflow-name')?.value === 'Quick plans'`) }] });
  await clickOn('button', /^Cancel$/);
  await until(`!document.querySelector('.workflow-editor-dialog')`);

  // 6. Send: the plan is made by the one agent, review is said not to have run, and the method line shows it.
  await sleep(300);
  await clickOn('button[aria-label="Send message"]', /./);
  await until(`(document.body.innerText||"").includes('Plan ready, not reviewed')`, 20_000);
  await sleep(500);
  const launched = await evaluate("window.__shot.launchedCommands.length");
  await capture({ state: "07-result-review-off", needles: ["Plan ready, not reviewed", "Independent review: not run (off in Quick plans)"], absent: ["Can be carried out", "Stop reason"],
    extra: async () => [{ name: "exactly one agent turn ran (no review turn)", ok: launched === 1, detail: `launches ${launched}` }] });
} catch (e) {
  failures.push({ state: "driver", width: null, failed: [{ name: "driver threw", ok: false, detail: String((e && e.stack) || e) }] });
  try { await screenshot(resolve(outDir, "driver-error.png")); } catch { /* best effort */ }
} finally {
  try { await preview?.stop(); } catch { /* best effort */ }
}
writeFileSync(resolve(outDir, "issue68-results.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
if (failures.length) { console.error(`shot-issue68: ${failures.length} failing`); for (const f of failures) console.error(JSON.stringify(f, null, 2).slice(0, 2500)); process.exit(1); }
console.log(`shot-issue68: all states verified; shots in ${outDir}`);
process.exit(0);
