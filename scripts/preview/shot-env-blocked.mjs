// Screenshot acceptance driver for the environment-blocked harness slice.
// Drives the real send flow through an injected electron-style bridge (stub
// page sets __GOALPORT_ELECTRON__ and a full window.goalportCore), so the
// failure card, the missing-harness sentence, the "Send again without Codex"
// draft, and the saved Plans view are all exercised end to end against
// vite-built dist. Screenshot-only; nothing here ships in the product.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "../preview/harness.mjs";

const outDir = resolve(process.argv[2] ?? "shot-out");
const distRoot = resolve("dist");

// Minimal connected CoreSnapshot (the shape of EMPTY_SNAPSHOT with a live
// connection) so the electron stub boots into the first-run state.
const emptySnapshot = {
  protocolVersion: "goalport.ipc.v2",
  buildId: "shot-stub",
  connection: "connected",
  projects: [],
  selectedProjectId: "",
  project: { id: "", name: "No project", workspaceRoot: "C:\\workspace\\goalport", color: "slate" },
  campaigns: [],
  activeCampaignId: "",
  activeTask: { id: "", title: "No task selected", acceptance: "", state: "waiting" },
  attempt: { id: "attempt-unassigned", taskId: "", provider: "unassigned", role: "executor", state: "waiting", sessionLabel: "No Runtime selected", eventCount: 0 },
  timeline: [],
  cursor: 0,
  runtimes: [],
  decisions: [],
  evidence: [],
  stopResponsibility: null,
  relatedHolds: [],
  preview: false,
  notices: [],
  productConversation: null,
};

const providers = (ids) => ids.map((id) => ({
  instanceId: id,
  displayName: id === "codex" ? "Codex" : id === "claude" ? "Claude" : "Grok",
  enabled: true,
  installed: true,
  availability: "available",
  status: "ready",
  auth: { status: "authenticated", type: "subscription" },
  models: [{ slug: `${id}-model`, name: `${id}-model`, isDefault: true }],
  usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
}));

const environmentBlockedResult = {
  text: "I couldn't read the file because the sandbox failed to initialize.",
  errorText: "This agent cannot run its tools on this machine, so this stopped.",
  dispatched: true,
  environmentBlocked: true,
  environmentDetail: "Failed to create unified exec process: helper_unknown_error: setup refresh had errors",
};

// The bridge: a failing codex planner, healthy others, records that persist
// in-page so the Plans sidebar shows the saved failed round.
function bridgeScript(ids) {
  const bridge = {
    snapshot: emptySnapshot,
    appInfo: { version: "shot", channel: "shot", testMode: false, dataPath: "profile", coordinationConfigured: true },
    discoverProviders: providers(ids),
  };
  const json = JSON.stringify(bridge)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `    <script>
window.__GOALPORT_ELECTRON__ = true;
(() => {
  const stub = ${json};
  const records = [];
  let launches = 0;
  window.goalportCore = {
    snapshot: async () => stub.snapshot,
    command: async () => stub.snapshot,
    startCore: async () => stub.snapshot,
    openInVsCode: async () => undefined,
    appInfo: async () => stub.appInfo,
    coordinateDiscover: async () => ({ connected: true, sendAuthorized: true, providers: stub.discoverProviders, stopReason: null }),
    coordinateLaunch: async (command) => {
      launches += 1;
      if (command.modelSelection.instanceId === "codex") return ${JSON.stringify(environmentBlockedResult).replace(/</g, "\\u003c")};
      return command.commandId.includes("plan")
        ? { text: "Bounded plan.", errorText: "" }
        : { text: "The plan can be carried out.\\nVERDICT: carry-out", errorText: "" };
    },
    coordinationSave: async (record) => {
      const index = records.findIndex((item) => item.requestId === record.requestId);
      if (index >= 0) records[index] = record; else records.unshift(record);
      return record;
    },
    coordinationRecords: async () => records,
  };
})();
</script>
`;
}

const index = readFileSync(resolve(distRoot, "index.html"), "utf8");
writeFileSync(resolve(distRoot, "shot-env2.html"), index.replace("  </head>", `${bridgeScript(["codex", "claude"])}  </head>`));
writeFileSync(resolve(distRoot, "shot-env3.html"), index.replace("  </head>", `${bridgeScript(["codex", "claude", "grok"])}  </head>`));

const preview = await startPreview({ dist: distRoot, fixture: "empty" });
const { page, evaluate, until, viewport, click, fill, screenshot } = preview;
const port = new URL(preview.url).port;

async function goto(path) {
  await page.cdp("Page.navigate", { url: `http://127.0.0.1:${port}/${path}` });
  await until("Boolean(document.querySelector('.goalport-shell'))");
}

async function setNavCollapsed(collapsed) {
  const isCollapsed = await evaluate("Boolean(document.querySelector('.campaign-nav.nav-collapsed'))");
  if (isCollapsed !== collapsed) {
    await click(collapsed ? 'button[aria-label="Collapse navigation"]' : 'button[aria-label="Expand navigation"]');
    await until(`document.querySelector('.campaign-nav')?.classList.contains('nav-collapsed') === ${collapsed}`);
  }
}

async function sendGoal(text) {
  await click('button[aria-label="New goal"]');
  await until("Boolean(document.querySelector('#draft-message'))");
  await fill("#draft-message", text);
  await click('.draft-composer-form button[type="submit"]');
}

const widths = [[1440, "1440"], [1020, "1020"], [860, "860"]];

// State 1 — the real-machine case: codex fails, only Claude remains, so the
// card explains the machine problem and says what is missing (no button).
await goto("shot-env2.html");
await sendGoal("Explain the failure and leave a bounded plan.");
await until("Boolean(document.body.innerText.includes('cannot run its tools on this machine'))");
await until("Boolean(document.body.innerText.includes('Only 1 other usable agent is signed in'))");
for (const [w, label] of widths) {
  await viewport(w, 900);
  await setNavCollapsed(false);
  await screenshot(resolve(outDir, `env-card-${label}.png`));
}

// State 2 — a third harness exists: the card offers "Send again without
// Codex"; clicking it drafts a fresh round that says who it will not use.
// Clicks run with the drawer collapsed (at <=860 the open drawer overlays the
// main content); the drawer is opened per width only for the screenshot.
await goto("shot-env3.html");
await sendGoal("Explain the failure and leave a bounded plan.");
await until("Boolean(document.body.innerText.includes('cannot run its tools on this machine'))");
for (const [w, label] of widths) {
  await viewport(w, 900);
  await setNavCollapsed(true);
  await click('button[aria-label="Send again without Codex"]');
  await until("Boolean(document.body.innerText.includes('This send will not use Codex'))");
  await setNavCollapsed(false);
  await screenshot(resolve(outDir, `env-draft-${label}.png`));
  // Back out of the draft to the failed round for the next width.
  await setNavCollapsed(true);
  await click('button[aria-label="Discard draft"]');
  await until("!document.querySelector('#draft-message')");
  await until("Boolean(document.body.innerText.includes('cannot run its tools on this machine'))");
}

// State 3 — the saved failed round reopened from Plans (the failed record was
// saved by the same send). Technical details open shows the raw signature.
await setNavCollapsed(false);
await click('button[aria-label^="Plan:"]');
await until("Boolean(document.querySelector('.timeline-scroll[aria-label=\"Saved plan\"]'))");
await until("Boolean(document.body.innerText.includes('cannot run its tools on this machine'))");
await setNavCollapsed(true);
await click('.tl-event[data-kind="environment-blocked"] details summary');
await until("Boolean(document.body.innerText.includes('helper_unknown_error'))");
for (const [w, label] of widths) {
  await viewport(w, 900);
  await setNavCollapsed(false);
  await screenshot(resolve(outDir, `env-plan-${label}.png`));
}

// New-user walkthrough at 1020: failure card → open evidence → continue
// without Codex → send → the round is checked. Every step a first-time user
// sees, in order.
await goto("shot-env3.html");
await viewport(1020, 900);
await sendGoal("Explain the failure and leave a bounded plan.");
await until("Boolean(document.body.innerText.includes('cannot run its tools on this machine'))");
await click('.tl-event[data-kind="environment-blocked"] details summary');
await until("Boolean(document.body.innerText.includes('helper_unknown_error'))");
await screenshot(resolve(outDir, "walkthrough-1-card-open.png"));
await click('button[aria-label="Send again without Codex"]');
await until("Boolean(document.body.innerText.includes('This send will not use Codex'))");
await screenshot(resolve(outDir, "walkthrough-2-avoid-draft.png"));
await click('.draft-composer-form button[type="submit"]');
await until("Boolean(document.body.innerText.includes('Can be carried out'))");
await screenshot(resolve(outDir, "walkthrough-3-checked.png"));
const assigned = await evaluate("Array.from(document.querySelectorAll('dd')).map((d) => d.textContent).slice(0, 4)");
console.log("walkthrough dl:", JSON.stringify(assigned));

await preview.stop();
console.log(`wrote screenshots to ${outDir}`);
