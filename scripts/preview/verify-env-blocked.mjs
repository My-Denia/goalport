// DOM-geometry acceptance for the environment-blocked slice. This session's
// image reads return CDN references rather than vision, so the visual gate is
// expressed as binary geometry/interaction checks driven through the same
// preview harness that took the screenshots. The PNG artifacts remain for
// owner eyeball verification on the real machine.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "../preview/harness.mjs";

const outDir = resolve(process.argv[2] ?? "shot-out");
const distRoot = resolve("dist");

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
  attempt: { id: "attempt-unassigned", taskId: "", provider: "unassigned", role: "executor", state: "waiting", sessionLabel: "No agent selected", eventCount: 0 },
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
  window.goalportCore = {
    snapshot: async () => stub.snapshot,
    command: async () => stub.snapshot,
    startCore: async () => stub.snapshot,
    openInVsCode: async () => undefined,
    appInfo: async () => stub.appInfo,
    coordinateDiscover: async () => ({ connected: true, sendAuthorized: true, providers: stub.discoverProviders, stopReason: null }),
    coordinateLaunch: async (command) => {
      if (command.modelSelection.instanceId === "codex") return ${JSON.stringify(environmentBlockedResult).replace(/</g, "\\u003c")};
      return command.commandId.includes("plan")
        ? { text: "Bounded plan.", errorText: "" }
        : { text: "The plan can be carried out.\\nVERDICT: carry-out", errorText: "" };
    },
    coordinationSave: async (record) => { records.unshift(record); return record; },
    coordinationRecords: async () => records,
  };
})();
</script>
`;
}

const index = readFileSync(resolve(distRoot, "index.html"), "utf8");
writeFileSync(resolve(distRoot, "verify-env2.html"), index.replace("  </head>", `${bridgeScript(["codex", "claude"])}  </head>`));
writeFileSync(resolve(distRoot, "verify-env3.html"), index.replace("  </head>", `${bridgeScript(["codex", "claude", "grok"])}  </head>`));

const preview = await startPreview({ dist: distRoot, fixture: "empty" });
const { page, evaluate, until, viewport, click, fill } = preview;
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

const failures = [];
function check(name, ok, detail = "") {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

// Geometry probe: an element is visible when it has area, sits inside the
// viewport, and the point at its center is not covered by another element.
const visibleProbe = `(selector) => (() => {
  const e = document.querySelector(selector);
  if (!e) return { missing: true };
  const r = e.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const top = document.elementFromPoint(x, y);
  return {
    missing: false,
    w: r.width, h: r.height,
    inside: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight,
    centered: top === e || e.contains(top),
  };
})()`;

const widths = [[1440, "1440"], [1020, "1020"], [860, "860"]];

// A — failure card geometry at every width, drawer collapsed (the state a
// user lands in after a send) and open (the narrow-width overlay state).
await goto("verify-env2.html");
await sendGoal("Explain the failure and leave a bounded plan.");
await until("Boolean(document.body.innerText.includes('cannot run its tools on this machine'))");
for (const [w, label] of widths) {
  await viewport(w, 900);
  await setNavCollapsed(true);
  const card = await evaluate(`(${visibleProbe})('.tl-event[data-kind="environment-blocked"]')`);
  check(`card visible, drawer collapsed @${label}`, !card.missing && card.w > 0 && card.h > 0 && card.inside && card.centered, JSON.stringify(card));
  const overflow = await evaluate("document.documentElement.scrollWidth - innerWidth");
  check(`no horizontal overflow @${label}`, overflow <= 1, `scrollWidth delta ${overflow}px`);
  if (label === "860") {
    await setNavCollapsed(false);
    const drawerCovers = await evaluate(`(() => {
      const card = document.querySelector('.tl-event[data-kind="environment-blocked"]');
      const r = card.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return Boolean(top && !card.contains(top));
    })()`);
    // The historical bug was an UNDISMISSIBLE drawer burying the content. The
    // drawer may overlay, but it must be dismissible.
    const dismissible = await evaluate("Boolean(document.querySelector('button[aria-label=\"Collapse navigation\"]'))");
    check("860 open drawer overlays but stays dismissible", drawerCovers === true && dismissible, `covers=${drawerCovers} dismissible=${dismissible}`);
    const mask = await evaluate("Boolean(document.querySelector('.nav-scrim, .campaign-nav-scrim, .drawer-mask'))");
    console.log(`INFO 860 drawer mask element present: ${mask}`);
    await setNavCollapsed(true);
  }
}

// B — the missing-harness sentence (2 providers), and the avoid draft note
// after continuing (3 providers).
const missing = await evaluate("Boolean(document.body.innerText.includes('Only 1 other usable agent is signed in'))");
check("missing-sentence with one other harness", missing);
const noButton = await evaluate("!document.querySelector('button[aria-label^=\"Send again without\"]')");
check("no send-again button when a round is impossible", noButton);

await goto("verify-env3.html");
await sendGoal("Explain the failure and leave a bounded plan.");
await until("Boolean(document.body.innerText.includes('cannot run its tools on this machine'))");
const withThird = await evaluate("!document.body.innerText.includes('Only ') || !document.body.innerText.includes('other usable harness')");
check("no missing-sentence when two others exist", withThird);
for (const [w, label] of widths) {
  await viewport(w, 900);
  await setNavCollapsed(true);
  const button = await evaluate(`(${visibleProbe})('button[aria-label="Send again without Codex"]')`);
  check(`send-again button visible @${label}`, !button.missing && button.inside && button.centered, JSON.stringify(button));
}

// C — the avoid draft: note present, note visible at every width, and the
// follow-up send assigns codex no role.
await setNavCollapsed(true);
await click('button[aria-label="Send again without Codex"]');
await until("Boolean(document.body.innerText.includes('This send will not use Codex'))");
for (const [w, label] of widths) {
  await viewport(w, 900);
  await setNavCollapsed(true);
  const note = await evaluate(`(${visibleProbe})('.revision-note')`);
  check(`avoid note visible @${label}`, !note.missing && note.inside, JSON.stringify(note));
}
await click('.draft-composer-form button[type="submit"]');
await until("Boolean(document.body.innerText.includes('Can be carried out'))");
const planner = await evaluate("document.querySelectorAll('dd')[1]?.textContent");
const reviewer = await evaluate("document.querySelectorAll('dd')[3]?.textContent");
check("continued round assigns Claude and Grok, not Codex", planner === "Claude" && reviewer === "Grok", `planner=${planner} reviewer=${reviewer}`);

await preview.stop();
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILURES:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nall geometry/interaction checks passed");
