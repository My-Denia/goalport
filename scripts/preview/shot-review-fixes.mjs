// Screenshot acceptance driver for PR #26 review fixes (F6 collapsed-rail plan
// labels, F9 returning to the active goal). Runs the repo's own preview
// harness (headless Chromium over CDP) against vite-built dist. Screenshot-only;
// nothing here ships in the product.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "../preview/harness.mjs";

const outDir = resolve(process.argv[2] ?? "shot-out");
const distRoot = resolve("dist");

// The stub page is generated from the built index.html: the preview client
// supplies the demo snapshot; the injected bridge only feeds the saved-plans
// list (window.goalportCore.coordinationRecords is read directly, so preview
// mode still renders the Plans sidebar).
const records = [
  {
    requestId: "shot-plan-3", workspacePath: "C:\\workspace\\goalport", goal: "Ship the review fixes",
    planningHarness: "Codex", reviewHarness: "Claude",
    planText: "Bounded plan from the third send.",
    reviewText: "The plan can be carried out.\nVERDICT: carry-out",
    result: "The plan can be carried out.\nVERDICT: carry-out",
    verdict: "checked", stopReason: "The independent check finished, so this stopped.",
    planningQuota: "available", reviewQuota: "available", savedAt: "2026-10-09T08:30:00.000Z",
  },
  {
    requestId: "shot-plan-2", workspacePath: "C:\\workspace\\goalport", goal: "Ship the review fixes",
    planningHarness: "Codex", reviewHarness: "Claude",
    planText: "Bounded plan from the second send.",
    reviewText: "Name the contract the plan uses.\nVERDICT: revise",
    result: "Name the contract the plan uses.\nVERDICT: revise",
    verdict: "revise", stopReason: "The independent check says the plan needs revision, so this stopped.",
    planningQuota: "available", reviewQuota: "available", savedAt: "2026-10-09T07:10:00.000Z",
  },
  {
    requestId: "shot-plan-1", workspacePath: "C:\\workspace\\goalport", goal: "Explain the sandbox failure",
    planningHarness: "Codex", reviewHarness: "Claude",
    planText: null, reviewText: null, result: null,
    verdict: "unconfirmed", stopReason: "A send started and will not be repeated.",
    planningQuota: "unknown", reviewQuota: "unknown", savedAt: "2026-10-08T18:45:00.000Z",
  },
];
const stub = `    <script>window.goalportCore = { coordinationRecords: async () => ${JSON.stringify(records)} };</script>\n`;
const index = readFileSync(resolve(distRoot, "index.html"), "utf8");
writeFileSync(resolve(distRoot, "shot-plans.html"), index.replace("  </head>", `${stub}  </head>`));

const preview = await startPreview({ dist: distRoot, fixture: "empty" });
const { page, evaluate, until, viewport, click, fill, screenshot } = preview;
const port = new URL(preview.url).port;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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

const widths = [[1440, "1440"], [1020, "1020"], [860, "860"]];

// State A — saved plans in the sidebar: expanded view and the collapsed rail.
await goto("shot-plans.html");
await until("document.querySelectorAll('button[aria-label^=\"Plan:\"]').length >= 3");
await viewport(1440, 900);
await click('button[aria-label^="Plan: Ship the review fixes, Can be carried out"]');
await until("Boolean(document.querySelector('.timeline-scroll[aria-label=\"Saved plan\"]'))");
for (const [w, label] of widths) {
  await viewport(w, 900);
  await setNavCollapsed(false);
  await screenshot(resolve(outDir, `plans-expanded-${label}.png`));
  await setNavCollapsed(true);
  if (label === "1440") {
    // Show the collapsed-rail tooltip that now carries the plan's outcome.
    const center = await evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('button[aria-label^="Plan:"]'));
      const target = buttons.find((b) => b.getAttribute('aria-label').includes('Needs revision')) ?? buttons[0];
      const r = target.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", ...center });
    await sleep(500);
    await screenshot(resolve(outDir, `plans-collapsed-tooltip-1440.png`));
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", x: 8, y: 8 });
    await sleep(200);
  }
  await screenshot(resolve(outDir, `plans-collapsed-${label}.png`));
  await setNavCollapsed(false);
}

// State B — the F9 walkthrough: a mounted planning draft gives way to the
// conversation when the user clicks the already-active goal.
await goto("index.html");
await until("document.querySelectorAll('.campaign-list .campaign-item').length >= 2");
for (const [w, label] of widths) {
  await viewport(w, 900);
  await setNavCollapsed(false);
  await click('button[aria-label="New goal"]');
  await until("Boolean(document.querySelector('#draft-message'))");
  await fill("#draft-message", "check the layout after returning to the goal");
  // At <=860 New goal auto-collapses the drawer: that collapsed draft state is
  // the natural narrow-width shot; re-open the drawer to reach the goal after.
  await screenshot(resolve(outDir, `draft-open-${label}.png`));
  await setNavCollapsed(false);
  await click(".campaign-list .campaign-item-wrap:nth-child(1) .campaign-item");
  await until("!document.querySelector('#draft-message')");
  await screenshot(resolve(outDir, `back-on-goal-${label}.png`));
}

await preview.stop();
console.log(`wrote screenshots to ${outDir}`);
