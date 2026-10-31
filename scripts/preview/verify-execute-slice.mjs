// Behavioral/geometry acceptance for the execute-slice, driven against the
// BUILT UI through the repo's preview harness and the shared synthetic
// fixture (execute-slice-fixture.mjs). Zero model quota, no real CLI, no file
// mutation — this proves the built renderer's consent → authorize → scope →
// chain → result/history behavior, NOT native/model/FS acceptance.
//
// Checked here, in one shared state set across all seven states x three
// widths:
//   - write consent is a separate, default-off decision bound to the pinned
//     workspace root and its own 1–8 budget, with visible invalid feedback;
//   - the authorize payload carries the separate write authorization exactly
//     (and no write key at all when no consent was given);
//   - four-role launches with independent executor != auditor instances and
//     matching scope generations; independent read/write counters;
//   - result and history facts (execution/verification text, verdicts,
//     partial-failure honesty, no-write and read-budget-2 stops) without
//     transient permissions on reloaded records;
//   - final-save failure keeps the on-screen result and the pending
//     dispatched record truth;
//   - the first-user path ends in the application-menu CLOSE.
//
// Usage: node scripts/preview/verify-execute-slice.mjs <fresh-artifacts-dir>
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { startPreview } from "../preview/harness.mjs";
import {
  EXECUTE_SCENARIOS,
  EXECUTE_WIDTHS,
  EXECUTE_GOAL,
  EXECUTE_WORKSPACE,
  SYNTHETIC_LABEL,
  executeScenarioPlan,
  executeSlicePageHtml,
  prepareFreshEvidenceDir,
} from "./execute-slice-fixture.mjs";

const outDir = prepareFreshEvidenceDir(process.argv[2] ?? "", "execute-slice verify artifacts");
const distRoot = resolve("dist");

const index = readFileSync(resolve(distRoot, "index.html"), "utf8");
writeFileSync(resolve(distRoot, "verify-execute.html"), executeSlicePageHtml(index));

function builtAssets() {
  const assetsDir = resolve(distRoot, "assets");
  try {
    return readdirSync(assetsDir).map((name) => ({
      name,
      sha256: createHash("sha256").update(readFileSync(resolve(assetsDir, name))).digest("hex"),
    }));
  } catch {
    return [];
  }
}

const preview = await startPreview({ dist: distRoot, fixture: "empty" });
const { page, evaluate, until, viewport, click, fill } = preview;
const port = new URL(preview.url).port;

const failures = [];
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

async function goto(path, { keepWindowName = false } = {}) {
  if (!keepWindowName) await evaluate("window.name = \"\"");
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

async function closeViaUI(label) {
  await click('button[aria-label="Application menu"]');
  await click('[role="menu"] [aria-label="Close window"]');
  await until("window.__ex.closed === true");
  check(`${label}: application-menu CLOSE reached synthetic requestClose`, true);
}

// Clear a filled input through real key events (select all + backspace), so
// states like "no workspace root yet" are reached the way a user reaches them.
async function clearInput(selector) {
  await click(selector);
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
}

// Same geometry gate as the shot driver: content present, no horizontal
// overflow, and at 860 a collapsed drawer with no backdrop over the content.
async function geometryChecks(label) {
  for (const width of EXECUTE_WIDTHS) {
    await viewport(width, 1000);
    await setNavCollapsed(width === 860);
    await evaluate("document.querySelector('.timeline-scroll').scrollTop = 0");
    const geometry = await evaluate(`(() => {
      const e = document.querySelector('.coordination-status') || document.querySelector('.authorization-panel');
      if (!e) return { missing: true };
      const r = e.getBoundingClientRect();
      return {
        missing: false,
        hasArea: r.width > 0 && r.height > 0,
        inside: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight,
        drawerCollapsed: document.querySelector('.campaign-nav').classList.contains('nav-collapsed'),
        drawerBackdrop: Boolean(document.querySelector('.mobile-nav-backdrop')),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    })()`);
    check(`${label}: content geometry @${width}`, !geometry.missing && geometry.hasArea && geometry.inside, JSON.stringify(geometry));
    check(`${label}: no horizontal overflow @${width}`, !geometry.missing && !geometry.horizontalOverflow, `overflow=${geometry.horizontalOverflow}`);
    if (width === 860) {
      check(`${label}: 860 drawer collapsed, no backdrop`, !geometry.missing && geometry.drawerCollapsed && !geometry.drawerBackdrop, `collapsed=${geometry.drawerCollapsed} backdrop=${geometry.drawerBackdrop}`);
    }
  }
}

async function runScenario(scenario, { pageQuery = scenario, keepWindowName = false } = {}) {
  const plan = executeScenarioPlan(scenario);
  await goto(`verify-execute.html?scenario=${pageQuery}`, { keepWindowName });
  await click('[aria-label="New goal"]');
  await until("Boolean(document.querySelector('[aria-label=\"Allow changes through Codex\"]'))");
  await fill('[aria-label="Project folder"]', plan.workspaceRoot);
  await fill('[aria-label="Message composer"]', plan.goal);
  if (plan.writeConsent) await click('[aria-label="Allow changes through Codex"]');
  if (plan.readTurns !== 4) await fill('[aria-label="Model turns to allow"]', String(plan.readTurns));
  await click('[aria-label="Send message"]');
  if (plan.hold) {
    const activity = scenario === "making-changes" ? "making changes" : "verifying";
    await until(`document.querySelector('.coordination-progress-activity')?.textContent.includes(${JSON.stringify(activity)})`);
  } else {
    await until("Boolean(document.querySelector('.coordination-outcome')) && !document.querySelector('.coordination-progress')");
  }
  return plan;
}

async function releaseHolds() {
  await evaluate("window.__ex.release()");
  await until("Boolean(document.querySelector('.coordination-outcome')) && !document.querySelector('.coordination-progress')");
}

const text = (expression) => evaluate(expression);

try {
  // ── A. consent: default-off separate write decision ──────────────────────
  await goto(`verify-execute.html?scenario=consent`);
  const labelPresent = await evaluate(`Array.from(document.querySelectorAll('div')).some((d) => d.textContent === ${JSON.stringify(SYNTHETIC_LABEL)})`);
  check("synthetic label present on the built page", labelPresent === true);
  await click('[aria-label="New goal"]');
  await until("Boolean(document.querySelector('[aria-label=\"Allow changes through Codex\"]'))");
  // The draft boots with the snapshot's workspace; clear it through the field
  // to reach the genuine no-root state a first-time user can create.
  await clearInput('[aria-label="Project folder"]');
  const beforeRoot = await evaluate(`(() => ({
    codexDisabled: document.querySelector('input[aria-label=\"Allow changes through Codex\"]').disabled,
    claudeDisabled: document.querySelector('input[aria-label=\"Allow changes through Claude\"]').disabled,
    hint: document.querySelector('.authorization-workspace')?.textContent,
    section: Boolean(document.querySelector('.authorization-write-section[aria-label=\"Workspace changes\"]')),
  }))()`);
  check("write section exists and blocks checkboxes before a workspace root is set",
    beforeRoot.section && beforeRoot.codexDisabled && beforeRoot.claudeDisabled && beforeRoot.hint === "Choose a project folder before allowing file changes.",
    JSON.stringify(beforeRoot));
  await fill('[aria-label="Project folder"]', EXECUTE_WORKSPACE);
  const afterRoot = await evaluate(`(() => ({
    codex: { checked: document.querySelector('input[aria-label=\"Allow changes through Codex\"]').checked, disabled: document.querySelector('input[aria-label=\"Allow changes through Codex\"]').disabled },
    claude: { checked: document.querySelector('input[aria-label=\"Allow changes through Claude\"]').checked, disabled: document.querySelector('input[aria-label=\"Allow changes through Claude\"]').disabled },
    readCodex: document.querySelector('input[aria-label=\"Select Codex\"]').checked,
    readClaude: document.querySelector('input[aria-label=\"Select Claude\"]').checked,
    writeTurns: document.querySelector('#authorization-write-turns').value,
    defaultOffLine: document.body.innerText.includes('No file changes are allowed unless you check an agent here and press Send.'),
  }))()`);
  check("write consent default OFF and enabled once root is set",
    afterRoot.codex.checked === false && afterRoot.claude.checked === false && !afterRoot.codex.disabled && !afterRoot.claude.disabled, JSON.stringify(afterRoot));
  check("read members default ON, write budget defaults to 2", afterRoot.readCodex && afterRoot.readClaude && afterRoot.writeTurns === "2", JSON.stringify(afterRoot));
  check("default-off sentence present", afterRoot.defaultOffLine);
  await fill('#authorization-write-turns', "9");
  const invalidBudget = await evaluate(`(() => ({ alert: document.querySelector('.authorization-write-section p[role=\"alert\"]')?.textContent ?? null }))()`);
  check("out-of-range write budget shows visible invalid feedback",
    invalidBudget.alert === "Choose 1 to 8 write turns before allowing workspace changes.", JSON.stringify(invalidBudget));
  await fill('#authorization-write-turns', "2");
  await geometryChecks("consent panel");
  await closeViaUI("consent");

  // ── B. verified: exact separate write authorization, four roles, dual counters ──
  await runScenario("verified");
  const log = await evaluate("window.__ex.log");
  const authorize = log.find((entry) => entry.authorize)?.authorize;
  check("write authorize payload is the exact separate authorization",
    JSON.stringify(authorize) === JSON.stringify({ instances: ["codex", "claude"], maxTurns: 4, workspaceRoot: EXECUTE_WORKSPACE, write: { instances: ["codex"], maxTurns: 2, workspaceRoot: EXECUTE_WORKSPACE } }),
    JSON.stringify(authorize));
  const launches = log.filter((entry) => entry.role);
  check("four launches: plan, review, execute, audit",
    JSON.stringify(launches.map((l) => l.role)) === JSON.stringify(["plan", "review", "execute", "audit"]), JSON.stringify(launches.map((l) => l.role)));
  const executor = launches.find((l) => l.role === "execute");
  const auditor = launches.find((l) => l.role === "audit");
  check("executor and auditor are different harnesses (independence)",
    executor?.instance === "codex" && auditor?.instance === "claude" && executor.instance !== auditor.instance,
    `executor=${executor?.instance} auditor=${auditor?.instance}`);
  const authorizeGeneration = log.find((entry) => entry.authorize)?.generation;
  check("every launch carries the captured scope generation and pinned workspace",
    launches.every((l) => l.scopeGeneration === authorizeGeneration && l.workspace === EXECUTE_WORKSPACE),
    JSON.stringify(launches.map((l) => ({ scopeGeneration: l.scopeGeneration, workspace: l.workspace }))));
  check("sandbox pairing: only the execute turn asks for workspaceWrite",
    launches.every((l) => l.sandbox === (l.role === "execute" ? "workspaceWrite" : "readOnly")),
    JSON.stringify(launches.map((l) => ({ role: l.role, sandbox: l.sandbox }))));
  const verifiedFacts = await evaluate(`(() => {
    const body = document.querySelector('.conversation-column').innerText;
    return {
      outcome: Array.from(document.querySelectorAll('.coordination-outcome dd'))[0]?.textContent,
      changes: document.querySelector('article[aria-label=\"Workspace changes result\"]')?.innerText ?? null,
      verification: document.querySelector('article[aria-label=\"Independent verification result\"]')?.innerText ?? null,
      budgets: Array.from(document.querySelectorAll('.coordination-budget')).map((e) => e.textContent),
    };
  })()`);
  check("verified outcome and result-first articles", verifiedFacts.outcome === "Changes verified"
    && verifiedFacts.changes?.includes("Changes — Codex") && verifiedFacts.changes.includes("Updated helper.ts and helper.test.ts")
    && verifiedFacts.verification?.includes("Independent verification — Claude") && verifiedFacts.verification.includes("VERDICT: verified"), JSON.stringify(verifiedFacts).slice(0, 400));
  check("dual counters update independently (read 1 of 4, write 1 of 2)",
    verifiedFacts.budgets.some((t) => t.includes("1 of 4 turns left")) && verifiedFacts.budgets.some((t) => t.includes("1 of 2 write turns left")),
    JSON.stringify(verifiedFacts.budgets));
  await geometryChecks("verified terminal");
  await closeViaUI("verified");

  // ── C. making-changes / verifying: held in-flight states, then complete ──
  await runScenario("making-changes");
  const makingFacts = await evaluate(`(() => ({
    activity: document.querySelector('.coordination-progress-activity')?.textContent,
    body: document.body.innerText,
  }))()`);
  check("making-changes names the writer and keeps both counters",
    makingFacts.activity?.includes("Codex") && makingFacts.activity?.includes("making changes")
    && makingFacts.body.includes("2 of 4 turns left.") && makingFacts.body.includes("2 of 2 write turns left."),
    JSON.stringify({ activity: makingFacts.activity, tail: makingFacts.body.slice(-260) }));
  await geometryChecks("making-changes progress");
  await releaseHolds();
  check("making-changes completes to verified after release",
    (await text("Array.from(document.querySelectorAll('.coordination-outcome dd'))[0]?.textContent")) === "Changes verified");
  await closeViaUI("making-changes");

  await runScenario("verifying");
  const verifyingFacts = await evaluate(`(() => ({
    activity: document.querySelector('.coordination-progress-activity')?.textContent,
    body: document.body.innerText,
  }))()`);
  check("verifying names a DIFFERENT harness than the writer and decrements only the write counter",
    verifyingFacts.activity?.includes("Claude") && verifyingFacts.activity?.includes("verifying")
      && !verifyingFacts.activity?.includes("Codex")
    && verifyingFacts.body.includes("2 of 4 turns left.") && verifyingFacts.body.includes("1 of 2 write turns left."),
    JSON.stringify({ activity: verifyingFacts.activity, tail: verifyingFacts.body.slice(-260) }));
  await geometryChecks("verifying progress");
  await releaseHolds();
  await closeViaUI("verifying");

  // ── D. partial write failure: honest terminal, no takeover, no fake audit ──
  await runScenario("partial-write-failure");
  const partialFacts = await evaluate(`(() => ({
    outcome: Array.from(document.querySelectorAll('.coordination-outcome dd'))[0]?.textContent,
    stopReason: Array.from(document.querySelectorAll('.coordination-outcome dd'))[1]?.textContent,
    changes: document.querySelector('article[aria-label=\"Workspace changes result\"]')?.innerText ?? null,
    verification: document.querySelector('article[aria-label=\"Independent verification result\"]')?.innerText ?? null,
    budgets: Array.from(document.querySelectorAll('.coordination-budget')).map((e) => e.textContent),
  }))()`);
  check("partial failure keeps outcome Failed with the midway stop reason",
    partialFacts.outcome === "Failed" && partialFacts.stopReason?.includes("The changes stopped midway"), JSON.stringify(partialFacts).slice(0, 400));
  check("partial execution text retained; no verification success claimed",
    partialFacts.changes?.includes("Updated helper.ts, but the test update did not finish.") && partialFacts.verification === null, JSON.stringify(partialFacts).slice(0, 400));
  check("partial failure honesty lives in the stop reason (inspect, no automatic retry) and one write turn is consumed",
    partialFacts.stopReason?.includes("The changes stopped midway. Files may already have changed. Workspace changes were not retried; inspect any partial changes before sending again.")
    && partialFacts.budgets.some((t) => t.includes("1 of 2 write turns left")), JSON.stringify(partialFacts).slice(0, 400));
  await geometryChecks("partial-write-failure terminal");
  await closeViaUI("partial-write-failure");

  // ── E. no-write stop: no write key ever sent, honest sentence ────────────
  await runScenario("no-write-stop");
  const noWriteLog = await evaluate("window.__ex.log");
  const noWriteAuthorize = noWriteLog.find((entry) => entry.authorize)?.authorize;
  check("read-only authorize payload has NO write key",
    JSON.stringify(noWriteAuthorize) === JSON.stringify({ instances: ["codex", "claude"], maxTurns: 4, workspaceRoot: EXECUTE_WORKSPACE }), JSON.stringify(noWriteAuthorize));
  check("no-write stop launches only plan and review",
    JSON.stringify(noWriteLog.filter((e) => e.role).map((l) => l.role)) === JSON.stringify(["plan", "review"]));
  const noWriteFacts = await evaluate(`(() => ({
    sentence: document.body.innerText.includes('The plan passed its check. No harness is allowed to change files, so this stopped here.'),
    changes: Boolean(document.querySelector('article[aria-label=\"Workspace changes result\"]')),
    writeLine: document.body.innerText.includes('write turns left'),
    budgets: Array.from(document.querySelectorAll('.coordination-budget')).map((e) => e.textContent),
  }))()`);
  check("no-write stop shows the honest sentence, no changes card, no write budget line",
    noWriteFacts.sentence && !noWriteFacts.changes && !noWriteFacts.writeLine && noWriteFacts.budgets.some((t) => t.includes("2 of 4 turns left")),
    JSON.stringify(noWriteFacts));
  await geometryChecks("no-write-stop terminal");
  await closeViaUI("no-write-stop");

  // ── F. read-budget-2 stop: zero edits, untouched write budget ────────────
  await runScenario("read-budget2-stop");
  const budget2Log = await evaluate("window.__ex.log");
  const budget2Authorize = budget2Log.find((entry) => entry.authorize)?.authorize;
  check("read-budget-2 authorize carries read 2 plus the separate write authorization",
    JSON.stringify(budget2Authorize) === JSON.stringify({ instances: ["codex", "claude"], maxTurns: 2, workspaceRoot: EXECUTE_WORKSPACE, write: { instances: ["codex"], maxTurns: 2, workspaceRoot: EXECUTE_WORKSPACE } }),
    JSON.stringify(budget2Authorize));
  check("read-budget-2 stops before execution: only plan and review launched",
    JSON.stringify(budget2Log.filter((e) => e.role).map((l) => l.role)) === JSON.stringify(["plan", "review"]),
    JSON.stringify(budget2Log.filter((e) => e.role).map((l) => l.role)));
  const budget2Facts = await evaluate(`(() => ({
    stopReason: Array.from(document.querySelectorAll('.coordination-outcome dd'))[1]?.textContent,
    budgets: Array.from(document.querySelectorAll('.coordination-budget')).map((e) => e.textContent),
    changes: Boolean(document.querySelector('article[aria-label=\"Workspace changes result\"]')),
    warning: document.body.innerText.includes('Files may have changed'),
  }))()`);
  check("read-budget-2 stop sentence is exact",
    budget2Facts.stopReason === "Verification needs one more authorized read turn, so no workspace changes were sent.", JSON.stringify(budget2Facts.stopReason));
  check("read-budget-2: read counter 0 of 2, write budget untouched 2 of 2, no changes card or warning",
    budget2Facts.budgets.some((t) => t.includes("0 of 2 turns left")) && budget2Facts.budgets.some((t) => t.includes("2 of 2 write turns left"))
    && !budget2Facts.changes && !budget2Facts.warning, JSON.stringify(budget2Facts));
  await geometryChecks("read-budget2-stop terminal");
  await closeViaUI("read-budget2-stop");

  // ── G. history: reloaded record keeps facts, drops transient permissions ──
  await runScenario("verified");
  await evaluate("window.name = JSON.stringify({ __exRecords: window.__ex.records() })");
  await goto("verify-execute.html?scenario=verified-history", { keepWindowName: true });
  await until("Boolean(document.querySelector('.coordination-outcome'))");
  const historyFacts = await evaluate(`(() => ({
    outcome: Array.from(document.querySelectorAll('.coordination-outcome dd'))[0]?.textContent,
    changes: document.querySelector('article[aria-label=\"Workspace changes result\"]')?.innerText ?? null,
    verification: document.querySelector('article[aria-label=\"Independent verification result\"]')?.innerText ?? null,
    budgetLines: Array.from(document.querySelectorAll('.coordination-budget')).map((e) => e.textContent),
    budgetText: document.body.innerText.includes('turns left'),
    change: Boolean(document.querySelector('.coordination-access button[aria-label=\"Change\"]')),
    stop: Boolean(document.querySelector('.coordination-access button[aria-label=\"Stop allowing\"]')),
  }))()`);
  check("history keeps execution and verification facts",
    historyFacts.outcome === "Changes verified" && historyFacts.changes?.includes("Changes — Codex") && historyFacts.verification?.includes("Independent verification — Claude"),
    JSON.stringify(historyFacts).slice(0, 400));
  check("history shows NO transient budget lines or authorization controls",
    historyFacts.budgetLines.length === 0 && !historyFacts.budgetText && !historyFacts.change && !historyFacts.stop,
    JSON.stringify(historyFacts).slice(0, 400));
  await closeViaUI("verified-history");

  // ── H. save failure: result stays, pending dispatched truth, no retry ────
  await runScenario("verified", { pageQuery: "verified&mode=save-failure" });
  await releaseHolds();
  const saveFacts = await evaluate(`(() => ({
    changes: document.querySelector('article[aria-label=\"Workspace changes result\"]')?.innerText ?? null,
    notice: document.body.innerText.includes('The result is on screen, but it could not be saved for the next time you open GoalPort. Any changes already made are not undone; inspect the workspace before a new send.'),
    sendDisabled: document.querySelector('.draft-composer-form button[type=\"submit\"]')?.disabled ?? null,
    saves: window.__ex.saves.map((s) => ({ verdict: s.verdict, dispatched: s.messageDispatched })),
    saveFailures: window.__ex.saveFailures,
  }))()`);
  check("save failure keeps the on-screen result and shows the honest notice",
    saveFacts.changes?.includes("Changes — Codex") && saveFacts.notice, JSON.stringify(saveFacts).slice(0, 400));
  check("persisted history stays at the pending dispatched record; final save attempted and failed",
    saveFacts.saves.length === 1 && saveFacts.saves[0]?.verdict === "unconfirmed" && saveFacts.saves[0]?.dispatched === true && saveFacts.saveFailures.length === 1,
    JSON.stringify({ saves: saveFacts.saves, saveFailures: saveFacts.saveFailures }));
  check("save failure leaves Send disabled (no retry offered)",
    saveFacts.sendDisabled === true, `sendDisabled=${saveFacts.sendDisabled}`);
  await closeViaUI("verified-save-failure");

  await preview.stop();

  // Report + exit status (exit code decided before printing the summary).
  const passed = checks.filter((c) => c.ok).length;
  writeFileSync(resolve(outDir, "verify-report.json"), JSON.stringify({
    driver: "scripts/preview/verify-execute-slice.mjs",
    fixture: "scripts/preview/execute-slice-fixture.mjs",
    harness: "scripts/preview/harness.mjs (headless Chromium over CDP, built dist)",
    synthetic: "zero-quota bridge preview; no real vendor/model/CLI call, no file mutation, not native/model/FS acceptance",
    scenariosCovered: [...EXECUTE_SCENARIOS, "verified-history", "verified-save-failure"],
    widths: EXECUTE_WIDTHS,
    checks: checks.length,
    passed,
    failed: checks.length - passed,
    builtAssets: builtAssets(),
    outDir,
    results: checks,
  }, null, 2));
  if (failures.length > 0) {
    console.error(`\n${failures.length} FAILURES:\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`\nall ${checks.length} execute-slice checks passed (artifacts dir: ${outDir})`);
  }
} catch (error) {
  console.error(`verify-execute-slice failed: ${error.message}`);
  process.exitCode = 1;
  try {
    await preview.stop();
  } catch { /* harness already cleaned up */ }
}
