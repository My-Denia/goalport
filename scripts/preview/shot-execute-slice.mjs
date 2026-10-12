// Screenshot driver for the execute-slice (write consent → execution →
// independent verification). Repository-owned port of the M8 run preview:
// same seven states, same three widths, same first-user path through the
// actual BUILT UI, ending in the application-menu CLOSE. Drives the shared
// synthetic fixture (execute-slice-fixture.mjs) through the repo's preview
// harness — zero model quota, no real CLI, no file mutation. Screenshot-only;
// nothing here ships in the product.
//
// Usage: node scripts/preview/shot-execute-slice.mjs <fresh-evidence-dir>
// The directory must be new or empty; existing evidence is never overwritten.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { startPreview } from "../preview/harness.mjs";
import {
  EXECUTE_SCENARIOS,
  EXECUTE_WIDTHS,
  executeScenarioPlan,
  executeSlicePageHtml,
  prepareFreshEvidenceDir,
} from "./execute-slice-fixture.mjs";

const outDir = prepareFreshEvidenceDir(process.argv[2] ?? "", "execute-slice shots");
const shotsDir = resolve(outDir, "shots");
mkdirSync(shotsDir, { recursive: true });
const distRoot = resolve("dist");

const index = readFileSync(resolve(distRoot, "index.html"), "utf8");
writeFileSync(resolve(distRoot, "shot-execute.html"), executeSlicePageHtml(index));

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function builtAssets() {
  const assetsDir = resolve(distRoot, "assets");
  try {
    return readdirSync(assetsDir).map((name) => ({ name, sha256: sha256(resolve(assetsDir, name)) }));
  } catch {
    return [];
  }
}

const preview = await startPreview({ dist: distRoot, fixture: "empty" });
const { page, evaluate, until, viewport, click, fill, screenshot } = preview;
const port = new URL(preview.url).port;

const manifest = [];
const walkthrough = [];
let geometryGates = 0;
let closeCalls = 0;

async function goto(scenario) {
  await page.cdp("Page.navigate", { url: `http://127.0.0.1:${port}/shot-execute.html?scenario=${scenario}` });
  await until("Boolean(document.querySelector('.goalport-shell'))");
}

async function closeViaUI(scenario) {
  await click('button[aria-label="Application menu"]');
  await click('[role="menu"] [aria-label="Close window"]');
  await until("window.__ex.closed === true");
  closeCalls += 1;
  walkthrough.push({ scenario, step: "CLOSE", observed: "Actual application-menu Close window action called the synthetic requestClose; native OS/window continuation not exercised." });
}

async function collapse() {
  const closed = await evaluate("document.querySelector('.campaign-nav')?.classList.contains('nav-collapsed')");
  if (!closed) await click('[aria-label="Collapse navigation"]');
}
async function expand() {
  const closed = await evaluate("document.querySelector('.campaign-nav')?.classList.contains('nav-collapsed')");
  if (closed) await click('[aria-label="Expand navigation"]');
}

// Three-width capture with the execute-slice geometry gates: no horizontal
// overflow anywhere, and at 860 the drawer collapsed with no backdrop over
// the content. A gate failure fails the run — those states must never ship.
async function takeMatrix(scenario) {
  for (const width of EXECUTE_WIDTHS) {
    await viewport(width, 1000);
    if (width === 860) await collapse();
    else await expand();
    await evaluate("document.querySelector('.timeline-scroll').scrollTop = 0");
    const geometry = await evaluate(`(() => {
      const e = document.querySelector('.coordination-status') || document.querySelector('.authorization-panel');
      const r = e.getBoundingClientRect();
      return {
        width: innerWidth, height: innerHeight,
        content: { x: r.x, y: r.y, width: r.width, height: r.height },
        drawerCollapsed: document.querySelector('.campaign-nav').classList.contains('nav-collapsed'),
        drawerBackdrop: Boolean(document.querySelector('.mobile-nav-backdrop')),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    })()`);
    if (geometry.horizontalOverflow) throw new Error(`Geometry gate failed (${scenario}@${width}): horizontal overflow ${JSON.stringify(geometry)}`);
    geometryGates += 1;
    if (width === 860 && (!geometry.drawerCollapsed || geometry.drawerBackdrop)) {
      throw new Error(`Geometry gate failed (${scenario}@860): drawer collapsed=${geometry.drawerCollapsed} backdrop=${geometry.drawerBackdrop}`);
    }
    if (width === 860) geometryGates += 2;
    const path = resolve(shotsDir, `${scenario}-${width}.png`);
    await screenshot(path);
    manifest.push({
      scenario,
      width,
      path,
      geometry,
      synthetic: true,
      builtUI: true,
      sha256: sha256(path),
      eyeball: "pending executor/owner review; see run evidence png-eyeball notes",
    });
  }
}

try {
  for (const scenario of EXECUTE_SCENARIOS) {
    const plan = executeScenarioPlan(scenario);
    await goto(scenario);
    walkthrough.push({ scenario, step: "first launch", observed: await evaluate("document.body.innerText.slice(0, 1200)") });
    await click('[aria-label="New goal"]');
    await until("Boolean(document.querySelector('[aria-label=\"Allow changes through Codex\"]'))");
    await fill('[aria-label="Project folder"]', plan.workspaceRoot);
    await fill('[aria-label="Message composer"]', plan.goal);
    const consents = await evaluate("Array.from(document.querySelectorAll('input[type=checkbox]')).map((e) => ({ label: e.getAttribute('aria-label'), checked: e.checked, disabled: e.disabled }))");
    walkthrough.push({ scenario, step: "New goal / read both consents", observed: consents });
    if (scenario === "consent") {
      await takeMatrix(scenario);
      await closeViaUI(scenario);
      continue;
    }
    if (plan.writeConsent) await click('[aria-label="Allow changes through Codex"]');
    if (plan.readTurns !== 4) await fill('[aria-label="Model turns to allow"]', String(plan.readTurns));
    walkthrough.push({
      scenario,
      step: "authorization / permission",
      observed: "Two read members selected; the file-change member is separately checked only for write scenarios, bound to the pinned workspace root with its own budget. No provider permission prompt; workspaceWrite authorization is engine/bridge scoped, not a real CLI permission acceptance.",
    });
    await click('[aria-label="Send message"]');
    if (plan.hold) {
      const activity = scenario === "making-changes" ? "making changes" : "verifying";
      await until(`document.querySelector('.coordination-progress-activity')?.textContent.includes(${JSON.stringify(activity)})`);
    } else {
      await until("Boolean(document.querySelector('.coordination-outcome')) && !document.querySelector('.coordination-progress')");
    }
    walkthrough.push({
      scenario,
      step: "Send / progress / result",
      observed: await evaluate("({ body: document.querySelector('.conversation-column').innerText, log: window.__ex.log, saves: window.__ex.saves })"),
    });
    await takeMatrix(scenario);
    if (plan.hold) {
      await evaluate("window.__ex.release()");
      await until("Boolean(document.querySelector('.coordination-outcome')) && !document.querySelector('.coordination-progress')");
    }
    await closeViaUI(scenario);
  }

  const built = builtAssets();
  writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(resolve(outDir, "walkthrough.json"), JSON.stringify(walkthrough, null, 2));
  writeFileSync(resolve(outDir, "report.json"), JSON.stringify({
    driver: "scripts/preview/shot-execute-slice.mjs",
    fixture: "scripts/preview/execute-slice-fixture.mjs",
    harness: "scripts/preview/harness.mjs (headless Chromium over CDP, built dist)",
    synthetic: "zero-quota bridge preview; no real vendor/model/CLI call, no file mutation, not native/model/FS acceptance",
    scenarios: EXECUTE_SCENARIOS.length,
    widths: EXECUTE_WIDTHS,
    shots: manifest.length,
    geometryGates,
    closeCalls,
    builtAssets: built,
    outDir,
  }, null, 2));
  console.log(`Captured ${manifest.length} actual built-UI PNGs (${EXECUTE_SCENARIOS.length} states x ${EXECUTE_WIDTHS.length} widths); ${geometryGates} geometry gates passed; ${closeCalls} CLOSE actions via the application menu. Evidence: ${outDir}`);
} catch (error) {
  console.error(`shot-execute-slice failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await preview.stop();
}
