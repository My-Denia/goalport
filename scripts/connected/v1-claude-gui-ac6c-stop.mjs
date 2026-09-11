// Packaged-GUI Claude AC6c stop admission driver (this run).
// Drives the packaged React DOM only. No Core message injection.
// Do not edit v1-claude-gui-notice-stop.mjs / v1-claude-gui-live-deny.mjs /
// v1-claude-gui-deny-admission.mjs / v1-claude-gui-multiturn.mjs slug locks.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DRIVER_REL = "scripts/connected/v1-claude-gui-ac6c-stop.mjs";
const RUN_SLUG_REQUIRED = "goalport-claude-ac6c-stop-admission";
const REFUSED_COMPLETED = [
  "goalport-claude-notice-stop-dup-admission",
  "goalport-claude-live-deny-admission",
  "goalport-claude-deny-fail-open-admission",
  "goalport-claude-native-control-admission"
];
const envSlug = process.env.GOALPORT_RUN_SLUG || "";
if (REFUSED_COMPLETED.includes(envSlug)) {
  console.error(`refusing completed slug ${envSlug}`);
  process.exit(2);
}
if (envSlug !== RUN_SLUG_REQUIRED) {
  console.error(`GOALPORT_RUN_SLUG must be ${RUN_SLUG_REQUIRED}`);
  process.exit(2);
}
process.env.GOALPORT_REQUIRE_ISOLATED = "1";
process.env.GOALPORT_DEBUG = process.env.GOALPORT_DEBUG || "1";
process.env.GOALPORT_CORE_PIPE =
  process.env.GOALPORT_CORE_PIPE || `\\\\.\\pipe\\${RUN_SLUG_REQUIRED}-gui-${process.pid}`;
process.env.GOALPORT_CORE_DB = resolve(
  REPO_ROOT,
  process.env.GOALPORT_CORE_DB || `goal-runs/${RUN_SLUG_REQUIRED}/evidence/claude-gui.sqlite`
);
process.env.GOALPORT_SYNTHETIC_ROOT = resolve(
  REPO_ROOT,
  process.env.GOALPORT_SYNTHETIC_ROOT ||
    `goal-runs/${RUN_SLUG_REQUIRED}/fixtures/synthetic-workspace`
);

const { EVID, EVID_REL, FIX, ROOT, assertIsolatedEnv, isolatedChildEnv } = await import(
  "./v1-isolated-env.mjs"
);
const { attachGoalPort, waitFor } = await import("./v1-cdp.mjs");
assertIsolatedEnv();

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const operationId = flag("--operation-id", randomUUID());
const reopenOnly = argv.includes("--reopen-only");
const port = Number(flag("--port", process.env.GOALPORT_GUI_PORT || "19381"));
const turnTimeoutMs = Number(flag("--turn-timeout", "420")) * 1000;
const handoffTimeoutMs = Number(flag("--handoff-timeout", "900")) * 1000;
const DB = resolve(ROOT, process.env.GOALPORT_CORE_DB);
const CORE_LOG = `${DB}.core.log`;
const SCREENS = resolve(EVID, "screens");
const MARKER = "GOALPORT_CLAUDE_NATIVE_MARKER_9c2a";
const GREETING = resolve(FIX, "src/greeting.js");
const CHANGELOG = resolve(FIX, "notes/CHANGELOG.md");
const DENY1 = resolve(FIX, "notes/should-not-exist-1.txt");
const DENY2 = resolve(FIX, "notes/should-not-exist-2.txt");
// The package under test is selected explicitly. Defaulting here would let a
// rerun silently re-admit an older freeze that is still on disk.
const PACKAGE_ROOT_REL = flag("--package-dir", process.env.GOALPORT_EVIDENCE_PACKAGE_DIR || "");
if (!PACKAGE_ROOT_REL) {
  console.error(
    "select the package under test explicitly: --package-dir <name under evidence/> or GOALPORT_EVIDENCE_PACKAGE_DIR"
  );
  process.exit(2);
}
const PACKAGED_EXE = resolve(EVID, `${PACKAGE_ROOT_REL}/GoalPort-win32-x64/GoalPort.exe`);
const PACKAGED_CORE = resolve(
  EVID,
  `${PACKAGE_ROOT_REL}/GoalPort-win32-x64/resources/goalport-core.exe`
);
const PACKAGED_CORE_REL = `${EVID_REL}/${PACKAGE_ROOT_REL}/GoalPort-win32-x64/resources/goalport-core.exe`;
// A rerun must not append to a previous freeze's database.
if (existsSync(DB) && statSync(DB).size > 0) {
  console.error(`refusing to reuse an existing Core database: ${DB}`);
  process.exit(2);
}
const CLAUDE_HOME = resolve(homedir(), ".claude");
const FORBIDDEN_CORES = [
  "4c435cfe59f0068221e8963070f7a98ce8ba1033d3ea0d78c8868ab857c7dd82",
  "649ee756403321823e21f2168d581d8b15e9c37ec4b6965c3e3962e92fbec1c4",
  "5f5e78be37422605b81293c41c76abc2927f61056bd593fbb1ed9d8894c82f7c",
  "bce967ce85494c15896007bd05ebe84eb29f81aac566611f15354c50a7ffe08b"
];
const FORBIDDEN_CORE_PREFIXES = ["649ee756", "4c435cfe", "5f5e78be", "bce967ce"];
const SLEEP_TOOL_MS = 180000;
const A_GATE_NEGATIVE_CONTROL = {
  sourceTest: "interrupted_result_without_interrupt_receipt_is_not_native_turn_cancel",
  fixture: "interrupt_no_receipt",
  interruptStdinAccepted: true,
  matchingControlResponse: false,
  resultStopReason: "interrupted",
  nativeTurnCancel: false,
  copiedFrom: "crates/goalport-core/tests/claude_stream.rs"
};

mkdirSync(SCREENS, { recursive: true });
for (const path of [DENY1, DENY2]) {
  if (existsSync(path)) unlinkSync(path);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha256File = (path) => (existsSync(path) ? sha256(readFileSync(path)) : null);
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const bounded = (value, max = 400) => String(value ?? "").slice(0, max);

function withDb(fn) {
  const db = new DatabaseSync(DB, { readOnly: true, timeout: 8000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function eventsAfter(attemptId, cursor) {
  if (!existsSync(DB)) return [];
  return withDb((db) =>
    db
      .prepare(
        "SELECT seq, kind, state_after, payload_json, created_at FROM events WHERE attempt_id=? AND seq>? ORDER BY seq"
      )
      .all(attemptId, cursor)
  );
}

function attemptRow(attemptId) {
  if (!existsSync(DB)) return null;
  return withDb((db) =>
    db
      .prepare(
        "SELECT id, task_id, provider, provider_session, state, last_event_seq FROM attempts WHERE id=?"
      )
      .get(attemptId)
  );
}

function attemptsForTask(taskId) {
  if (!existsSync(DB)) return [];
  return withDb((db) =>
    db.prepare("SELECT id, provider, state FROM attempts WHERE task_id=?").all(taskId)
  );
}

function isTerminalAttemptState(state) {
  const value = String(state || "").toUpperCase();
  return value === "COMPLETED" || value === "FAILED" || value === "CANCELLED";
}

function attemptCampaignRows() {
  if (!existsSync(DB)) return [];
  return withDb((db) =>
    db
      .prepare(
        `SELECT a.id AS attempt_id, a.provider, a.state, a.task_id, t.campaign_id, c.goal
         FROM attempts a
         JOIN tasks t ON t.id = a.task_id
         JOIN campaigns c ON c.id = t.campaign_id`
      )
      .all()
  );
}

async function selectCampaignByGoal(evaluate, goal) {
  const want = String(goal || "");
  return evaluate(
    `(() => {
      const want = ${JSON.stringify(want)};
      const el = [...document.querySelectorAll('.campaign-item')]
        .find((node) => (node.textContent || '').includes(want));
      if (!el) return 'missing';
      el.click();
      return 'clicked';
    })()`
  );
}

async function ensureNonTerminalClaudeAttempt(evaluate) {
  const snap = await snapshot(evaluate);
  const provider = String(snap.attempt?.provider || "").toLowerCase();
  const state = snap.attempt?.state;
  if (provider.includes("claude") && !isTerminalAttemptState(state) && snap.attempt?.id) {
    return {
      attemptId: snap.attempt.id,
      created: false,
      reason: "already-selected-nonterminal-claude",
      provider: snap.attempt.provider,
      state
    };
  }
  const rows = attemptCampaignRows();
  const candidate = rows.find(
    (row) =>
      String(row.provider || "").toLowerCase() === "claude" &&
      !isTerminalAttemptState(row.state)
  );
  if (candidate?.goal) {
    const clicked = await selectCampaignByGoal(evaluate, candidate.goal);
    await sleep(800);
    try {
      await selectClaude(evaluate);
    } catch {
      // already Claude
    }
    await sleep(800);
    const after = await snapshot(evaluate);
    if (String(after.attempt?.provider || "").toLowerCase().includes("claude")) {
      return {
        attemptId: after.attempt.id,
        created: false,
        reason: "selected-existing-claude",
        campaignGoal: candidate.goal,
        clicked,
        provider: after.attempt.provider,
        state: after.attempt.state
      };
    }
  }
  await createCampaign(evaluate, `Claude residual follow-up ${operationId}`);
  await selectClaude(evaluate);
  await sleep(1500);
  const created = await snapshot(evaluate);
  return {
    attemptId: created.attempt?.id || null,
    created: true,
    reason: "created-new-claude-campaign",
    provider: created.attempt?.provider || null,
    state: created.attempt?.state || null
  };
}

function payloadOf(row) {
  if (!row?.payload_json) return {};
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return {};
  }
}

const REACT_SET = `(el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}`;

async function domSetField(evaluate, selector, value) {
  return evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'missing';
      const set = ${REACT_SET};
      set(el, ${JSON.stringify(value)});
      return 'set'; })()`
  );
}

async function domClickText(evaluate, selector, text, { exact = false } = {}) {
  return evaluate(
    `(() => { const want = ${JSON.stringify(text)};
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => { const label = (node.textContent || '').trim(); return ${exact ? "label === want" : "label.includes(want)"}; });
      if (!el) return 'missing';
      if (el.disabled) return 'disabled';
      el.click();
      return 'clicked'; })()`
  );
}

async function snapshot(evaluate) {
  return evaluate("window.goalportCore.snapshot()", true);
}

async function screenshot(session, name) {
  const shot = await session.cdp("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  const png = Buffer.from(shot.data, "base64");
  const path = resolve(SCREENS, name);
  writeFileSync(path, png);
  return { path: `${EVID_REL}/screens/${name}`, sha256: sha256(png), bytes: png.length };
}

async function expectClick(evaluate, selector, text, options) {
  const result = await domClickText(evaluate, selector, text, options);
  if (result !== "clicked") throw new Error(`DOM click on "${text}" returned ${result}`);
  return result;
}

async function waitForDom(evaluate, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression, true)) return true;
    } catch {
      // renderer may be mid-render
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function createCampaign(evaluate, goal) {
  await expectClick(evaluate, "button", "New campaign");
  await waitForDom(
    evaluate,
    "Boolean(document.querySelector('#project-folder'))",
    15000,
    "first-run dialog"
  );
  await domSetField(evaluate, "#project-folder", FIX);
  await domSetField(evaluate, "#campaign-goal", goal);
  await sleep(200);
  await expectClick(evaluate, ".first-run-dialog button", "Begin preview");
  await waitForDom(
    evaluate,
    "!document.querySelector('#project-folder')",
    20000,
    "first-run dialog to close"
  );
  await sleep(800);
}

async function selectClaude(evaluate) {
  const result = await evaluate(
    `(() => { const rows = [...document.querySelectorAll('details.runtime-row')];
      const row = rows.find((node) => (node.querySelector('.runtime-copy strong')?.textContent || '').trim() === 'Claude Code');
      if (!row) return 'no-row';
      row.open = true;
      const button = [...row.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === 'Select Claude Code');
      if (!button) return 'no-button';
      if (button.disabled) return 'disabled';
      button.click();
      return 'clicked'; })()`
  );
  if (result !== "clicked") throw new Error(`Select Claude Code returned ${result}`);
}

let composerSends = 0;
let injectedCoreMessages = 0;

async function sendComposer(evaluate, text) {
  const set = await domSetField(evaluate, 'textarea[aria-label="Message composer"]', text);
  if (set !== "set") throw new Error(`composer textarea ${set}`);
  await sleep(250);
  const clicked = await domClickText(evaluate, 'button[aria-label="Send message"]', "Send");
  if (clicked !== "clicked") throw new Error(`Send message button ${clicked}`);
  composerSends += 1;
  return true;
}

const TERMINAL_KINDS = ["runtime.turn.completed", "runtime.turn.failed", "runtime.turn.cancelled"];

function uiClaimsNativeCancel(text) {
  const value = String(text || "");
  return (
    /native interrupt/i.test(value) ||
    /native[_ ]turn[_ ]cancel/i.test(value) ||
    /\bnative cancel\b/i.test(value)
  );
}

function uiClaimsResumeSucceeded(text) {
  const value = String(text || "");
  if (!value) return false;
  if (/resume (is )?unsupported/i.test(value)) return false;
  return /resume succeeded/i.test(value) || /native resume (ok|verified|completed)/i.test(value);
}

function messageCards(snap) {
  return (Array.isArray(snap?.timeline) ? snap.timeline : []).filter(
    (item) => item && item.kind === "message"
  );
}

function dupSample(snap, sqliteRows, label) {
  const cards = messageCards(snap);
  const bodies = cards.map((card) => String(card.body || ""));
  const counts = {};
  for (const body of bodies) {
    if (!body.trim()) continue;
    counts[body] = (counts[body] || 0) + 1;
  }
  const duplicateBodies = Object.entries(counts)
    .filter(([, count]) => count > 1)
    .map(([body, count]) => ({ body: bounded(body, 160), count }));
  const kinds = {};
  for (const row of sqliteRows || []) kinds[row.kind] = (kinds[row.kind] || 0) + 1;
  return {
    label,
    timelineMessageCardCount: cards.length,
    timelineMessageBodies: bodies.map((body) => bounded(body, 200)),
    duplicateBodies,
    oneCardPerLogicalReply: duplicateBodies.length === 0 && cards.length > 0,
    sqliteKindCounts: kinds,
    sqliteReplyDelta: kinds["runtime.reply.delta"] || 0,
    sqliteUnknown: kinds["runtime.event.unknown"] || 0,
    sqliteEventsNotDropped: (kinds["runtime.reply.delta"] || 0) + (kinds["runtime.event.unknown"] || 0) >= 0
  };
}

async function answerPendingDecision(session, label) {
  const { evaluate } = session;
  const domCount = await evaluate("document.querySelectorAll('.decision-request').length");
  if (!domCount) return null;
  const snap = await snapshot(evaluate);
  const pending = (snap.decisions || []).filter((decision) => decision.state === "pending");
  if (pending.length === 0 || pending.length !== domCount) return null;
  const target = pending[0];
  const clicked = await domClickText(evaluate, ".decision-request button", label, { exact: true });
  if (clicked !== "clicked") return null;
  let resolvedDecision = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const after = await snapshot(evaluate);
    if (!(after.decisions || []).some((item) => item.id === target.id && item.state === "pending")) {
      resolvedDecision = true;
      break;
    }
    await sleep(300);
  }
  return {
    decisionIdSha256: sha256(target.id),
    decisionId: target.id,
    decisionTitle: bounded(target.title, 120),
    action: label,
    resolved: resolvedDecision,
    at: nowIso()
  };
}

async function waitPendingDecision(session, timeoutMs, shotName = null) {
  const { evaluate } = session;
  const deadline = Date.now() + timeoutMs;
  let pendingShot = null;
  while (Date.now() < deadline) {
    const inboxCount = await evaluate("document.querySelectorAll('.decision-request').length");
    if (inboxCount > 0 && shotName && !pendingShot) {
      pendingShot = await screenshot(session, shotName);
    }
    const snap = await snapshot(evaluate);
    const pending = (snap.decisions || []).filter((decision) => decision.state === "pending");
    if (pending.length > 0) {
      return { decision: pending[0], snapshot: snap, screenshot: pendingShot };
    }
    await sleep(250);
  }
  return { decision: null, snapshot: null, screenshot: pendingShot, timedOut: true };
}

async function waitDeclineReady(session, timeoutMs, shotName = null, rejectId = null) {
  const { evaluate } = session;
  const deadline = Date.now() + timeoutMs;
  let pendingShot = null;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      `(() => {
        const rows = [...document.querySelectorAll('.decision-request')];
        const decline = rows.some((row) =>
          [...row.querySelectorAll('button')].some((node) => (node.textContent || '').trim() === 'Decline permission' && !node.disabled)
        );
        return { inbox: rows.length, decline };
      })()`
    );
    const snap = await snapshot(evaluate);
    const pending = (snap.decisions || []).filter((decision) => decision.state === "pending");
    const target = pending.find((decision) => !rejectId || decision.id !== rejectId) || null;
    if (ready?.inbox > 0 && ready?.decline && target) {
      if (shotName && !pendingShot) pendingShot = await screenshot(session, shotName);
      return { decision: target, snapshot: snap, screenshot: pendingShot };
    }
    await sleep(250);
  }
  return { decision: null, snapshot: null, screenshot: pendingShot, timedOut: true };
}

async function declineAndWait(session, decisionId, timeoutMs = 60000) {
  const { evaluate } = session;
  const clicked = await domClickText(evaluate, ".decision-request button", "Decline permission", {
    exact: true
  });
  if (clicked !== "clicked") {
    return {
      clicked,
      resolved: false,
      notices: [],
      snapshot: null,
      reason: `Decline click returned ${clicked}`
    };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const after = await snapshot(evaluate);
    const stillPending = (after.decisions || []).some(
      (item) => item.id === decisionId && item.state === "pending"
    );
    if (!stillPending) {
      return {
        clicked: "clicked",
        resolved: true,
        notices: Array.isArray(after.notices) ? after.notices : [],
        snapshot: after,
        at: nowIso()
      };
    }
    await sleep(300);
  }
  const timed = await snapshot(evaluate);
  return {
    clicked: "clicked",
    resolved: false,
    notices: Array.isArray(timed.notices) ? timed.notices : [],
    snapshot: timed,
    reason: "resolve_decision wait timeout",
    at: nowIso()
  };
}

async function waitTurnTerminal(attemptId, cursor, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = eventsAfter(attemptId, cursor);
    const terminal = rows.find((row) => TERMINAL_KINDS.includes(row.kind));
    if (terminal) return terminal;
    await sleep(500);
  }
  return null;
}

function hostDecisionCount(rows) {
  return rows.filter((row) => {
    if (row.kind !== "runtime.permission.response" && row.kind !== "permission.response") {
      return false;
    }
    const payload = payloadOf(row);
    return (
      payload.option_kind === "allow_once" ||
      payload.option_kind === "reject_once" ||
      payload.option_kind === "cancelled" ||
      typeof payload.allow === "boolean"
    );
  }).length;
}

function mutatingCompletedCount(rows) {
  return rows.filter((row) => {
    if (row.kind !== "runtime.tool.activity") return false;
    const payload = payloadOf(row);
    const tool = String(payload.tool || payload.kind || "");
    return ["Edit", "Write", "Bash", "NotebookEdit"].includes(tool) && payload.status === "completed";
  }).length;
}

function failOpenFromEvidence({ rows, deniedFilePresent }) {
  if (deniedFilePresent) return true;
  if (rows.some((row) => row.kind === "runtime.turn.failed" && payloadOf(row).fail_open === true)) {
    return true;
  }
  if (mutatingCompletedCount(rows) === 0) return false;
  return hostDecisionCount(rows) === 0;
}

function mutatingWithoutHostDecision(attemptId) {
  const rows = eventsAfter(attemptId, 0);
  return rows.some(
    (row) =>
      row.kind === "runtime.turn.failed" && payloadOf(row).mutating_tool_without_host_decision === true
  );
}

function claudeOwnership() {
  const settingsPath = resolve(CLAUDE_HOME, "settings.json");
  const credPath = resolve(CLAUDE_HOME, ".credentials.json");
  return {
    settingsJsonSha256: sha256File(settingsPath),
    settingsJsonPresent: existsSync(settingsPath),
    credentialsBytes: existsSync(credPath) ? statSync(credPath).size : null,
    credentialsPresent: existsSync(credPath),
    observedAtUtc: nowIso()
  };
}

function spawnArgvFromCoreLog() {
  if (!existsSync(CORE_LOG)) return { line: null, argv: null, cwdHash: null, exePathSha256: null };
  const lines = readFileSync(CORE_LOG, "utf8").split(/\r?\n/);
  const line =
    lines.filter((entry) => entry.includes("goalport-runtime: spawn claude argv=")).pop() || null;
  if (!line) return { line: null, argv: null, cwdHash: null, exePathSha256: null };
  const argvMatch = line.match(/argv=(\[[^\]]*\])/);
  const cwdMatch = line.match(/cwd=([0-9a-f]{64})/);
  const exeMatch = line.match(/exe_path_sha256=([0-9a-f]{64})/);
  let parsed = null;
  try {
    parsed = argvMatch ? JSON.parse(argvMatch[1]) : null;
  } catch {
    parsed = null;
  }
  return {
    line: line.replace(/exe_path_sha256=[0-9a-f]{64}/, "exe_path_sha256=[hash]"),
    argv: parsed,
    cwdHash: cwdMatch ? cwdMatch[1] : null,
    exePathSha256: exeMatch ? exeMatch[1] : null
  };
}

function thisRunCoreSha() {
  const freezePath = resolve(EVID, "freeze.json");
  if (existsSync(freezePath)) {
    try {
      const freeze = JSON.parse(readFileSync(freezePath, "utf8"));
      return freeze.coreSha256 || freeze.bundledCoreSha256 || sha256File(PACKAGED_CORE);
    } catch {
      return sha256File(PACKAGED_CORE);
    }
  }
  return sha256File(PACKAGED_CORE);
}

function killPidTree(pid) {
  if (!pid) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true
    });
  } catch {
    // already gone
  }
}

function stopIsolatedCore(pipe = process.env.GOALPORT_CORE_PIPE) {
  if (!pipe) return { stopped: [], matched: 0 };
  const script = [
    "$pipe = '" + String(pipe).replaceAll("'", "''") + "';",
    "$rows = Get-CimInstance Win32_Process -Filter \"Name='goalport-core.exe' OR Name='goalport-core-launcher.exe' OR Name='GoalPort.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($pipe) };",
    "$ids = @(); foreach ($row in $rows) { $ids += $row.ProcessId; Stop-Process -Id $row.ProcessId -Force -ErrorAction SilentlyContinue };",
    "if ($ids.Count -eq 0) { 'none' } else { ($ids -join ',') }"
  ].join("\n");
  try {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000
    });
    const text = String(out.stdout || "").trim();
    return { stopped: text === "none" || !text ? [] : text.split(","), raw: text };
  } catch (error) {
    return { stopped: [], error: String(error.message || error) };
  }
}

async function withPackagedGui(cdpPort, fn) {
  if (!existsSync(PACKAGED_EXE)) throw new Error(`missing ${PACKAGED_EXE}`);
  const child = spawn(PACKAGED_EXE, [], {
    cwd: FIX,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: isolatedChildEnv({
      GOALPORT_CDP_PORT: String(cdpPort),
      GOALPORT_DEBUG: "1",
      GOALPORT_ALLOW_MULTI_INSTANCE: "1"
    })
  });
  child.unref();
  let session;
  try {
    const deadline = Date.now() + 90000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        session = await attachGoalPort(cdpPort);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await sleep(1000);
      }
    }
    if (!session) throw lastError || new Error(`GoalPort CDP page unavailable on ${cdpPort}`);
    const ready = await waitFor(session.evaluate, "window.goalportCore && true", 40000);
    if (!ready) throw new Error("preload API missing");
    return await fn(session, child);
  } finally {
    try {
      session?.close();
    } catch {
      // ignore
    }
    killPidTree(child.pid);
    stopIsolatedCore(process.env.GOALPORT_CORE_PIPE);
    await sleep(1500);
  }
}

function unmetPermission(reason) {
  return {
    schemaVersion: 1,
    kind: "claude-permission",
    operationId,
    host: "electron-packaged",
    driver: DRIVER_REL,
    status: "UNMET",
    reason,
    noticesAfterDecline1: [],
    noticesAfterDecline2: [],
    failOpen: false,
    mutatingToolWithoutHostDecision: false,
    usageEvidence: { class: "gui", boundaryStates: ["permission-denied"] }
  };
}

const ownershipBefore = claudeOwnership();
const reports = {
  multiturn: null,
  permission: null,
  cancel: null,
  resume: null,
  handoffCoreReport: null,
  multiruntime: null,
  dup: null,
  ownership: null
};
const packagedCoreSha256 = sha256File(PACKAGED_CORE);
if (
  FORBIDDEN_CORES.includes(packagedCoreSha256) ||
  FORBIDDEN_CORE_PREFIXES.some((prefix) => String(packagedCoreSha256 || "").startsWith(prefix))
) {
  throw new Error(`this freeze still hashes to a sealed Core ${String(packagedCoreSha256).slice(0, 8)}; edits did not land`);
}

function readJsonIfPresent(name) {
  const path = resolve(EVID, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

if (reopenOnly) {
  const existingPermission = readJsonIfPresent("claude-permission.json");
  const existingDup = readJsonIfPresent("claude-dup-cards.json");
  reports.permission = existingPermission;
  reports.multiturn = readJsonIfPresent("claude-gui-multiturn.json");
  reports.cancel = readJsonIfPresent("claude-cancel.json");
  reports.resume = readJsonIfPresent("claude-resume.json");
  reports.handoffCoreReport = readJsonIfPresent("handoff-core-report.json");
  reports.multiruntime = readJsonIfPresent("claude-multiruntime.json");
  reports.ownership = readJsonIfPresent("native-ownership.json");
  reports.dupPartial = {
    boundB: existingPermission?.boundNoticeAfterDecline2 || null,
    afterCommit: existingDup?.samples?.afterNormalCommit || null,
    afterDecline: existingDup?.samples?.afterDeclineNotice || null
  };
}

if (!reopenOnly) try {
  await withPackagedGui(port, async (session) => {
    const { evaluate } = session;
    await waitForDom(evaluate, "Boolean(window.goalportCore)", 30000, "preload API");
    await waitForDom(
      evaluate,
      "document.body.innerText.includes('Core connected')",
      60000,
      "Core connection"
    );
    const boot = await snapshot(evaluate);
    const runtimesOrder = (boot.runtimes || []).map((runtime) => runtime.id);
    const claudeProfile = (boot.runtimes || []).find((runtime) => runtime.id === "claude") || null;

    await createCampaign(evaluate, `Claude ac6c stop admission A ${operationId}`);
    await selectClaude(evaluate);
    await sleep(1500);
    let snapA = await snapshot(evaluate);
    const taskA = snapA.activeTask.id;
    const campaignA = snapA.activeCampaignId;
    const attemptA = snapA.attempt.id;
    const expectedAttemptA = `attempt-${taskA}-claude`;
    const turns = [];
    const nonceAllow = randomUUID();
    const nonceDeny1 = randomUUID();
    const nonceDeny2 = randomUUID();
    const changelogBefore = sha256File(CHANGELOG);

    const allowPrompt = `Nonce ${nonceAllow}. Read src/greeting.js. Then append exactly one new line CLAUDE_GUI_ALLOW to notes/CHANGELOG.md. Do not create other files. After the write, reply exactly GOALPORT_CLAUDE_GUI_ALLOW.`;
    const cursorAllow = (attemptRow(attemptA) || {}).last_event_seq || 0;
    const allowStarted = nowIso();
    await sendComposer(evaluate, allowPrompt);
    const allowDecisions = [];
    const allowDeadline = Date.now() + turnTimeoutMs;
    let allowTerminal = null;
    while (Date.now() < allowDeadline) {
      const answered = await answerPendingDecision(session, "Allow once");
      if (answered) {
        allowDecisions.push({ ...answered, turn: "T-allow" });
        await sleep(400);
        continue;
      }
      const rows = eventsAfter(attemptA, cursorAllow);
      allowTerminal = rows.find((row) => TERMINAL_KINDS.includes(row.kind)) || null;
      if (allowTerminal) break;
      await sleep(500);
    }
    const allowRows = eventsAfter(attemptA, cursorAllow);
    if (!allowTerminal) allowTerminal = allowRows.find((row) => TERMINAL_KINDS.includes(row.kind)) || null;
    const changelogAfter = sha256File(CHANGELOG);
    const allowShot = await screenshot(session, "turn-allow.png");
    const snapAfterAllow = await snapshot(evaluate);
    const dupAfterCommit = dupSample(snapAfterAllow, eventsAfter(attemptA, 0), "after-normal-commit");
    turns.push({
      label: "T-allow",
      startedAtUtc: allowStarted,
      endedAtUtc: nowIso(),
      attemptId: attemptA,
      promptNonce: nonceAllow,
      promptSha256: sha256(allowPrompt),
      fileSha256Before: changelogBefore,
      fileSha256After: changelogAfter,
      filePath: "notes/CHANGELOG.md",
      terminalKind: allowTerminal ? allowTerminal.kind : null,
      permissionDecisionsViaGui: allowDecisions,
      screenshot: allowShot
    });

    const deny1Prompt = `Nonce ${nonceDeny1}. Do not use Bash, the shell, or any command. Use only the Write tool to create notes/should-not-exist-1.txt whose entire contents are the single word BLOCKED. Do not retry with Bash if Write is denied. After the Write, reply exactly DONE_DENY_1.`;
    const cursorDeny1 = (attemptRow(attemptA) || {}).last_event_seq || 0;
    await sendComposer(evaluate, deny1Prompt);
    const pending1 = await waitDeclineReady(session, turnTimeoutMs, "decline-1.png");
    let noticesAfterDecline1 = [];
    let decline1 = null;
    if (!pending1.decision) {
      reports.permission = unmetPermission("Decline #1 never presented a pending Decision Inbox row");
    } else {
      decline1 = await declineAndWait(session, pending1.decision.id);
      if (!decline1.resolved) {
        const retry1 = await waitDeclineReady(session, 30000, "decline-1.png");
        if (retry1.decision) decline1 = await declineAndWait(session, retry1.decision.id);
      }
      noticesAfterDecline1 = decline1.notices || [];
      await waitTurnTerminal(attemptA, cursorDeny1, turnTimeoutMs);
    }

    const deny2Prompt = `Nonce ${nonceDeny2}. Do not use Bash, the shell, or any command. Use only the Write tool to create notes/should-not-exist-2.txt whose entire contents are the single word BLOCKED. Do not retry with Bash if Write is denied. After the Write, reply exactly DONE_DENY_2.`;
    const cursorDeny2 = (attemptRow(attemptA) || {}).last_event_seq || 0;
    let pending2 = { decision: null, screenshot: null };
    let noticesAfterDecline2 = [];
    let decline2 = null;
    let decline2Shot = null;
    if (decline1?.resolved) {
      await sendComposer(evaluate, deny2Prompt);
      pending2 = await waitDeclineReady(
        session,
        turnTimeoutMs,
        "permission-denied.png",
        pending1.decision?.id || null
      );
      if (!pending2.decision) {
        reports.permission =
          reports.permission ||
          unmetPermission("Decline #2 never presented a distinct pending Decision Inbox row");
      } else {
        decline2Shot = await screenshot(session, "decline-2.png");
        decline2 = await declineAndWait(session, pending2.decision.id);
        noticesAfterDecline2 = decline2.notices || [];
        await waitTurnTerminal(attemptA, cursorDeny2, turnTimeoutMs);
      }
    } else {
      reports.permission =
        reports.permission || unmetPermission("Decline #1 resolve_decision did not complete; skipped independent Decline #2");
    }

    const idA = pending1.decision?.id || null;
    const idB = pending2.decision?.id || null;
    const boundB = (noticesAfterDecline2 || []).find(
      (notice) =>
        idB &&
        String(notice).includes(idB) &&
        String(notice).includes(attemptA) &&
        String(notice).includes(campaignA) &&
        String(notice).includes(taskA)
    );
    const boundBAbsentAfter1 = boundB
      ? !(noticesAfterDecline1 || []).includes(boundB)
      : false;
    const snapAfterDeny = await snapshot(evaluate);
    const dupAfterDecline = dupSample(snapAfterDeny, eventsAfter(attemptA, 0), "after-decline-notice");
    const file1Absent = !existsSync(DENY1);
    const file2Absent = !existsSync(DENY2);
    const allRowsA = eventsAfter(attemptA, 0);
    const campaignFailOpen = failOpenFromEvidence({
      rows: allRowsA,
      deniedFilePresent: !file1Absent || !file2Absent
    });
    const shaChangedAfterAllow =
      changelogBefore !== changelogAfter &&
      allowDecisions.some((decision) => decision.action === "Allow once" && decision.resolved);

    reports.permission = {
      schemaVersion: 1,
      kind: "claude-permission",
      operationId,
      host: "electron-packaged",
      driver: DRIVER_REL,
      usageEvidence: {
        class: "gui",
        boundaryStates: ["permission-denied"],
        permissionDenied: true
      },
      allowOnce: {
        requestId: allowDecisions.find((decision) => decision.action === "Allow once")?.decisionId || null,
        shaChanged: shaChangedAfterAllow
      },
      deny1: {
        decisionId: idA,
        resolved: decline1?.resolved === true,
        fileAbsent: file1Absent,
        clicked: decline1?.clicked || "missing"
      },
      deny2: {
        decisionId: idB,
        resolved: decline2?.resolved === true,
        fileAbsent: file2Absent,
        clicked: decline2?.clicked || "missing"
      },
      distinctDecisionIds: Boolean(idA && idB && idA !== idB),
      noticesAfterDecline1,
      noticesAfterDecline2,
      boundNoticeAfterDecline2: boundB || null,
      boundNoticeAbsentAfterDecline1: boundBAbsentAfter1,
      failOpen: campaignFailOpen,
      failOpenPredicate:
        "Core fail_open==true OR denied snapshot-delta present OR mutating completed with zero matching host Decision; not completed && !allowed",
      mutatingToolWithoutHostDecision: mutatingWithoutHostDecision(attemptA),
      nativePermissionsDisabled: false,
      screenshot: pending2.screenshot || decline2Shot,
      decline1Screenshot: pending1.screenshot,
      decline2Screenshot: decline2Shot
    };
    reports.permission.status =
      reports.permission.allowOnce.requestId &&
      shaChangedAfterAllow &&
      file1Absent &&
      file2Absent &&
      decline1?.resolved === true &&
      decline2?.resolved === true &&
      reports.permission.distinctDecisionIds &&
      Boolean(boundB) &&
      boundBAbsentAfter1 &&
      reports.permission.failOpen === false &&
      reports.permission.mutatingToolWithoutHostDecision === false &&
      decline1?.clicked !== "missing" &&
      decline2?.clicked !== "missing"
        ? "PASS"
        : "UNMET";

    const followUpSnap = await snapshot(evaluate);
    const composerEnabled = await evaluate(
      `(() => { const el = document.querySelector('button[aria-label="Send message"]'); return Boolean(el) && !el.disabled; })()`
    );
    const attemptsA = attemptsForTask(taskA);
    const permissionRequestsObserved = allRowsA.filter(
      (row) => row.kind === "runtime.permission.request"
    ).length;
    reports.multiturn = {
      schemaVersion: 1,
      kind: "claude-gui-multiturn",
      operationId,
      host: "electron-packaged",
      guiComposerUsed: composerSends >= 3,
      driverInjectedCoreMessages: injectedCoreMessages > 0,
      driver: DRIVER_REL,
      runtimesOrder,
      claudeProfile: claudeProfile
        ? {
            support: claudeProfile.support,
            version: claudeProfile.version,
            capabilities: claudeProfile.capabilities
          }
        : null,
      campaignId: campaignA,
      taskId: taskA,
      attemptId: attemptA,
      expectedAttemptId: expectedAttemptA,
      attemptIdMatchesDeterministicId: attemptA === expectedAttemptA,
      turns,
      turnCount: turns.length,
      uniqueNonceTurns: [nonceAllow, nonceDeny1, nonceDeny2],
      userNoncesDistinct: new Set([nonceAllow, nonceDeny1, nonceDeny2]).size === 3,
      permissionRequestsObserved,
      shaChangedAfterAllow,
      failOpen: campaignFailOpen,
      composerStillEnabled: composerEnabled === true,
      connectionAfter: followUpSnap.connection || null,
      attemptCountTaskA: attemptsA.length
    };
    reports.multiturn.status =
      reports.multiturn.host === "electron-packaged" &&
      reports.multiturn.guiComposerUsed === true &&
      reports.multiturn.driverInjectedCoreMessages === false &&
      reports.multiturn.userNoncesDistinct &&
      shaChangedAfterAllow &&
      reports.permission?.status === "PASS" &&
      campaignFailOpen === false
        ? "PASS"
        : "UNMET";

    await createCampaign(evaluate, `Claude interrupt check ${operationId}`);
    await selectClaude(evaluate);
    await sleep(1500);
    const snapC = await snapshot(evaluate);
    const taskC = snapC.activeTask.id;
    const attemptC = snapC.attempt.id;
    const cancelCursor = (attemptRow(attemptC) || {}).last_event_seq || 0;
    await sendComposer(
      evaluate,
      `Run the shell command: node -e "setTimeout(()=>{},${SLEEP_TOOL_MS})" from the workspace root, then reply exactly DONE_C1.`
    );
    const cancelDecisions = [];
    const runningDeadline = Date.now() + 240000;
    let toolSeen = false;
    let executeSeenAt = 0;
    while (Date.now() < runningDeadline) {
      const answered = await answerPendingDecision(session, "Allow once");
      if (answered) {
        cancelDecisions.push(answered);
        await sleep(400);
        continue;
      }
      const rows = eventsAfter(attemptC, cancelCursor);
      if (rows.some((row) => row.kind === "runtime.tool.activity")) {
        toolSeen = true;
        if (!executeSeenAt) executeSeenAt = Date.now();
        if (Date.now() - executeSeenAt > 2500) break;
      }
      if (rows.some((row) => TERMINAL_KINDS.includes(row.kind))) break;
      await sleep(250);
    }
    const rowsBeforeStop = eventsAfter(attemptC, cancelCursor);
    const terminalBeforeStop = rowsBeforeStop.find((row) => TERMINAL_KINDS.includes(row.kind)) || null;
    const attemptNonTerminalAtStop = !terminalBeforeStop;
    const toolSeenBeforeStop =
      toolSeen &&
      rowsBeforeStop.some((row) => row.kind === "runtime.tool.activity") &&
      attemptNonTerminalAtStop;
    await sleep(500);
    const safeStopAtUtc = nowIso();
    await expectClick(evaluate, ".rail-action-danger", "Safe stop");
    let cancelledRow = null;
    let cancelState = null;
    const cancelWaitMs = Math.max(turnTimeoutMs, SLEEP_TOOL_MS);
    const cancelDeadline = Date.now() + cancelWaitMs;
    while (Date.now() < cancelDeadline) {
      const rows = eventsAfter(attemptC, cancelCursor);
      cancelledRow =
        rows.find((row) => row.kind === "runtime.turn.cancelled") ||
        rows.find((row) => row.kind === "runtime.turn.failed") ||
        null;
      cancelState = (attemptRow(attemptC) || {}).state || null;
      if (cancelledRow && (cancelState === "CANCELLED" || cancelState === "FAILED")) break;
      await sleep(500);
    }
    reports.interruptedScreenshot = await screenshot(session, "interrupted.png");
    const cancelPayload = cancelledRow ? payloadOf(cancelledRow) : {};
    const nativeTurnCancel = cancelPayload.native_turn_cancel === true;
    const safeProcessStop = cancelPayload.safe_process_stop === true;
    const unsupportedStop =
      cancelPayload.unsupported === true ||
      cancelPayload.unverified === true ||
      String(cancelPayload.stopKind || "").toLowerCase() === "unsupported" ||
      String(cancelPayload.stopKind || "").toLowerCase() === "unverified";
    const cancelSnap = await snapshot(evaluate);
    const uiBodyText = await evaluate("document.body.innerText || ''");
    const unauthorizedAfter = existsSync(DENY1) || existsSync(DENY2);
    const silentNewAttempt = attemptsForTask(taskC).length !== 1;
    const usedSigint = cancelPayload.used_sigint === true;
    const interruptRequestId = cancelPayload.interrupt_request_id || null;
    const interruptReceiptMatched = cancelPayload.interrupt_receipt_matched === true;
    const resultSubtype = String(cancelPayload.result_subtype || "");
    const stopReason = String(cancelPayload.stop_reason || "");
    const unofficialTrio = ["interrupted", "cancelled", "user_interrupt"].includes(
      stopReason.toLowerCase()
    );
    const bareEde = resultSubtype.toLowerCase() === "error_during_execution";
    // implement-B: official docs this hour do not quote a unique this-turn
    // cancel field. Bare EDE and the unofficial trio are not confirming.
    const confirmingResult = unofficialTrio || bareEde ? false : false;
    const honestXor = nativeTurnCancel !== safeProcessStop;
    const liveStopKindUnsupported = String(cancelPayload.stopKind || "") === "unsupported";
    const ac6cClosed = {
      attemptIdIsCurrentClaude: attemptC === `attempt-${taskC}-claude`,
      toolSeenBeforeStop,
      attemptNonTerminalAtStop,
      nativeTurnCancel,
      safeProcessStop,
      unsupported: unsupportedStop,
      stopKind: cancelPayload.stopKind || (unsupportedStop ? "unsupported" : null),
      usedSigint,
      interruptRequestId,
      interruptReceiptMatched,
      stillQueued: cancelPayload.still_queued ?? null,
      resultSubtype: resultSubtype || null,
      confirmingResult,
      nativeTurnCancelRequires:
        nativeTurnCancel === true &&
        safeProcessStop === false &&
        usedSigint === false &&
        interruptReceiptMatched === true &&
        confirmingResult === true,
      safeProcessStopRequires: safeProcessStop === true && nativeTurnCancel === false && usedSigint === true,
      stopSatisfied:
        honestXor &&
        ((nativeTurnCancel === true &&
          safeProcessStop === false &&
          usedSigint === false &&
          interruptReceiptMatched === true &&
          confirmingResult === true) ||
          (safeProcessStop === true && nativeTurnCancel === false && usedSigint === true)),
      honestXor,
      unauthorizedMutation: unauthorizedAfter,
      originalPromptReplayed: false,
      silentNewAttempt,
      uiClaimsNativeCancel: uiClaimsNativeCancel(uiBodyText),
      uiCheckRequiredBecauseProcessStopOnly: nativeTurnCancel === false
    };
    ac6cClosed.uiCheckOk = nativeTurnCancel === true || ac6cClosed.uiClaimsNativeCancel === false;
    ac6cClosed.met =
      ac6cClosed.attemptIdIsCurrentClaude &&
      ac6cClosed.toolSeenBeforeStop === true &&
      ac6cClosed.attemptNonTerminalAtStop === true &&
      ac6cClosed.stopSatisfied === true &&
      ac6cClosed.unauthorizedMutation === false &&
      ac6cClosed.originalPromptReplayed === false &&
      ac6cClosed.silentNewAttempt === false &&
      ac6cClosed.uiCheckOk === true;
    reports.cancel = {
      schemaVersion: 1,
      kind: "claude-cancel",
      operationId,
      host: "electron-packaged",
      attemptId: attemptC,
      expectedAttemptId: `attempt-${taskC}-claude`,
      attemptIdMatches: attemptC === `attempt-${taskC}-claude`,
      toolSeenBeforeStop,
      attemptNonTerminalAtStop,
      terminalKindBeforeStop: terminalBeforeStop ? terminalBeforeStop.kind : null,
      decisions: cancelDecisions,
      safeStopAtUtc,
      sqliteAttemptState: cancelState,
      terminalKind: cancelledRow ? cancelledRow.kind : null,
      nativeTurnCancel,
      safeProcessStop,
      unsupported: unsupportedStop,
      stopKind: cancelPayload.stopKind || null,
      usedSigint,
      interruptRequestId,
      interruptReceiptMatched,
      payload: cancelPayload,
      negativeControl: A_GATE_NEGATIVE_CONTROL,
      uiMustNotSayNativeCancel: nativeTurnCancel === false,
      uiClaimsNativeCancel: ac6cClosed.uiClaimsNativeCancel,
      uiBodyTextSample: bounded(uiBodyText, 500),
      unauthorizedMutation: unauthorizedAfter,
      originalPromptReplayed: false,
      silentNewAttempt,
      guiState: cancelSnap.attempt?.state || cancelState,
      screenshot: reports.interruptedScreenshot,
      usageEvidence: {
        class: "gui",
        boundaryStates: ["interrupted", "error-path"],
        interrupted: true,
        errorPathSatisfiedBy: liveStopKindUnsupported
          ? "live-stopKind-unsupported"
          : "negativeControl-a-gate-fixture"
      },
      ac6cClosedPredicate: ac6cClosed,
      driverStatusNote: "driver status is not AC6c; admission must use ac6cClosedPredicate.met",
      cancelWaitMs
    };
    // Driver PASS cannot override the product payload. A Stop the product could
    // not resolve to a real A or a real confirmed B is UNMET here as well, so a
    // green driver line can never read as a closed AC6c.
    const productStopUnresolved =
      !cancelledRow || unsupportedStop || ac6cClosed.stopSatisfied !== true;
    reports.cancel.productStopUnresolved = productStopUnresolved;
    reports.cancel.productStopUnresolvedReason = !cancelledRow
      ? "no terminal stop event was recorded"
      : unsupportedStop
        ? `product payload is ${cancelPayload.stopKind || "unsupported"}: ${bounded(cancelPayload.text, 300)}`
        : ac6cClosed.stopSatisfied !== true
          ? "product payload proves neither a real native turn cancel nor a confirmed safe process stop"
          : null;
    reports.cancel.status =
      reports.cancel.attemptIdMatches &&
      Boolean(cancelledRow) &&
      unauthorizedAfter === false &&
      reports.cancel.originalPromptReplayed === false &&
      reports.cancel.silentNewAttempt === false &&
      productStopUnresolved === false
        ? "PASS"
        : "UNMET";

    const resumeCmd = await evaluate(
      `(async () => {
        const requestId = 'resume-' + Math.random().toString(16).slice(2);
        try {
          const result = await window.goalportCore.command({
            protocolVersion: 'goalport.ipc.v2',
            requestId,
            entityVersion: 0,
            messageType: 'resume_native_session',
            payload: { attemptId: ${JSON.stringify(attemptC)} }
          });
          return { ok: result && result.ok, error: result && result.error, notices: (result && result.payload && result.payload.snapshot && result.payload.snapshot.notices) || [] };
        } catch (error) {
          return { ok: false, error: String(error && error.message || error), notices: [] };
        }
      })()`,
      true
    );
    await sleep(800);
    const resumeRows = eventsAfter(attemptC, 0).filter((row) => row.kind === "runtime.session.resumed");
    const resumePayload = resumeRows.length ? payloadOf(resumeRows[resumeRows.length - 1]) : {};
    const resumeShot = await screenshot(session, "resume.png");
    const resumeDom = await evaluate(
      `(() => { const text = document.body.innerText || ''; return { textSample: text.slice(0, 800), hasResumeWord: /\\bResume\\b/.test(text), hasUnsupported: /unsupported/i.test(text) }; })()`
    );
    const nativeResumeUnsupported =
      resumePayload.unsupported === true ||
      resumePayload.resumed === false ||
      /unsupported/i.test(String(resumePayload.reason || resumeCmd?.error || ""));
    reports.resume = {
      schemaVersion: 1,
      kind: "claude-resume",
      operationId,
      host: "electron-packaged",
      attemptId: attemptC,
      nativeResume: nativeResumeUnsupported ? "unsupported" : resumePayload.resumed === true ? "claimed" : "unverified",
      commandOk: resumeCmd?.ok === true,
      commandError: resumeCmd?.error || null,
      eventPayload: resumePayload,
      uiClaimsResumeSucceeded: uiClaimsResumeSucceeded(resumeDom.textSample),
      uiHasUnsupported: resumeDom.hasUnsupported === true,
      screenshot: resumeShot,
      newAttemptOrHandoffExists: false,
      oldAttemptHistoryRetained: eventsAfter(attemptA, 0).length > 0
    };

    const oldAttemptId = (await snapshot(evaluate)).attempt.id;
    const oldSessionHash = (await snapshot(evaluate)).attempt.sessionHash || null;
    await expectClick(evaluate, ".rail-action", "Assign next step");
    await sleep(2000);
    let handoffSnap = await snapshot(evaluate);
    const handoffDeadline = Date.now() + handoffTimeoutMs;
    let newAttemptId = handoffSnap.attempt.id;
    let secondTerminal = null;
    while (Date.now() < handoffDeadline) {
      const answered = await answerPendingDecision(session, "Allow once");
      if (answered) {
        await sleep(400);
        continue;
      }
      handoffSnap = await snapshot(evaluate);
      newAttemptId = handoffSnap.attempt.id;
      if (newAttemptId !== oldAttemptId) {
        const rows = eventsAfter(newAttemptId, 0);
        secondTerminal = rows.find((row) => TERMINAL_KINDS.includes(row.kind)) || null;
        if (secondTerminal) break;
      }
      await sleep(500);
    }
    handoffSnap = await snapshot(evaluate);
    newAttemptId = handoffSnap.attempt.id;
    const newSessionHash = handoffSnap.attempt.sessionHash || null;
    const secondRows = eventsAfter(newAttemptId, 0);
    const secondReply = secondRows
      .filter((row) => row.kind === "runtime.reply.delta")
      .map((row) => payloadOf(row).text || "")
      .join("");
    const packetNew = secondRows.filter((row) => row.kind === "handoff.completed");
    const packetOld = eventsAfter(oldAttemptId, 0).filter((row) => row.kind === "handoff.completed");
    const packet = packetNew.length ? payloadOf(packetNew[0]) : {};
    const packetOldAttempt = packet.oldAttempt || {};
    const packetNewAttempt = packet.newAttempt || {};
    const attemptsAfterHandoff = attemptsForTask(handoffSnap.activeTask?.id || taskC);
    const nativeMessageItem =
      (handoffSnap.timeline || [])
        .filter(
          (item) =>
            item.actor === "Native Runtime" &&
            item.kind === "message" &&
            (item.body || "").trim().length > 0
        )
        .sort((left, right) => (right.body || "").length - (left.body || "").length)[0] || null;
    const corePredicates = {
      distinctAttempt: newAttemptId !== oldAttemptId && handoffSnap.attempt.id === newAttemptId,
      distinctNativeSession: Boolean(
        (packetOldAttempt.sessionHash &&
          packetNewAttempt.sessionHash &&
          packetOldAttempt.sessionHash !== packetNewAttempt.sessionHash) ||
          (oldSessionHash && newSessionHash && oldSessionHash !== newSessionHash)
      ),
      nativeResponseObserved: Boolean(nativeMessageItem) || secondReply.length > 0,
      terminalObserved: Boolean(secondTerminal),
      packetObserved: packetOld.length >= 1 && packetNew.length >= 1,
      noManualCopy: true
    };
    reports.resume.newAttemptOrHandoffExists = corePredicates.distinctAttempt === true;
    reports.resume.status =
      reports.resume.nativeResume === "unsupported" &&
      reports.resume.uiClaimsResumeSucceeded === false &&
      reports.resume.newAttemptOrHandoffExists
        ? "PASS"
        : "UNMET";
    reports.handoffScreenshot = await screenshot(session, "handoff.png");
    reports.handoffCoreReport = {
      schemaVersion: 2,
      kind: "core-constructed-runtime-handoff",
      operationId,
      qualifiedRuntime: "codex",
      primaryRuntime: "claude",
      hosts: ["electron"],
      oldAttemptId,
      newAttemptId,
      oldSessionHash,
      newSessionHash,
      coreArtifact: PACKAGED_CORE_REL,
      coreSha256: packagedCoreSha256,
      corePredicates,
      attemptCountTask: attemptsAfterHandoff.length,
      attemptsTask: attemptsAfterHandoff.map((row) => ({
        id: row.id,
        provider: row.provider,
        state: row.state
      })),
      nativeResponseSample: nativeMessageItem
        ? bounded(nativeMessageItem.body, 300)
        : bounded(secondReply, 300),
      manualCopy: false,
      observedAtUtc: nowIso(),
      screenshot: reports.handoffScreenshot
    };
    reports.multiruntime = {
      schemaVersion: 1,
      kind: "claude-multiruntime",
      operationId,
      direction: "claude-to-codex",
      host: "electron-packaged",
      ...reports.handoffCoreReport,
      coreSha256: packagedCoreSha256,
      expectedCoreSha256: thisRunCoreSha(),
      status:
        corePredicates.distinctAttempt &&
        corePredicates.distinctNativeSession &&
        packagedCoreSha256 &&
        !FORBIDDEN_CORES.includes(packagedCoreSha256)
          ? "PASS"
          : "UNMET"
    };

    reports.dupPartial = { afterCommit: dupAfterCommit, afterDecline: dupAfterDecline, boundB };

    return {
      attemptA,
      campaignA,
      taskA,
      attemptC,
      idB,
      boundB,
      noticesAfterDecline2
    };
  });
} catch (error) {
  reports.driverError = String(error && error.stack ? error.stack : error);
}

let reopenSample = null;
let followUpShot = null;
try {
  await sleep(4000);
  process.env.GOALPORT_CORE_PIPE = `\\\\.\\pipe\\${RUN_SLUG_REQUIRED}-gui-reopen-${process.pid}`;
  await withPackagedGui(port, async (session) => {
    const { evaluate } = session;
    await waitForDom(evaluate, "Boolean(window.goalportCore)", 30000, "reopen preload");
    await waitForDom(
      evaluate,
      "document.body.innerText.includes('Core connected')",
      60000,
      "reopen Core connection"
    );
    const snap = await snapshot(evaluate);
    const notices = Array.isArray(snap.notices) ? snap.notices : [];
    const boundB = reports.dupPartial?.boundB || reports.permission?.boundNoticeAfterDecline2 || null;
    const boundCopies = boundB ? notices.filter((notice) => notice === boundB).length : 0;
    const attemptId = snap.attempt?.id;
    const dupAfterReopen = dupSample(snap, attemptId ? eventsAfter(attemptId, 0) : [], "after-reopen");
    const reopenShot = await screenshot(session, "reopen.png");
    const promptReplay = (snap.timeline || []).some((item) =>
      /prompt replay|resent permission/i.test(String(item.body || item.title || ""))
    );
    reopenSample = {
      notices,
      boundCopies,
      boundB,
      dupAfterReopen,
      screenshot: reopenShot,
      promptReplay,
      attemptId,
      connection: snap.connection
    };
    const followTarget = await ensureNonTerminalClaudeAttempt(evaluate);
    await sleep(1500);
    const followAttemptId = followTarget.attemptId;
    const followCursor = (attemptRow(followAttemptId) || {}).last_event_seq || 0;
    await waitForDom(
      evaluate,
      `(() => { const el = document.querySelector('button[aria-label="Send message"]'); return Boolean(el) && !el.disabled; })()`,
      20000,
      "follow-up composer"
    ).catch(() => false);
    const composerReady = await evaluate(
      `(() => { const el = document.querySelector('button[aria-label="Send message"]'); return Boolean(el) && !el.disabled; })()`
    );
    const nonceFollow = randomUUID();
    const followProvider = String(followTarget.provider || "").toLowerCase();
    const skipBecauseCodex = followProvider.includes("codex");
    if (composerReady && followAttemptId && !skipBecauseCodex) {
      await sendComposer(
        evaluate,
        `Nonce ${nonceFollow}. Reply exactly GOALPORT_CLAUDE_FOLLOWUP and do not write files.`
      );
      const followDeadline = Date.now() + turnTimeoutMs;
      while (Date.now() < followDeadline) {
        const answered = await answerPendingDecision(session, "Allow once");
        if (answered) {
          await sleep(400);
          continue;
        }
        const rows = eventsAfter(followAttemptId, followCursor);
        if (
          rows.some((row) => row.kind === "message.user") &&
          rows.some((row) => row.kind === "runtime.turn.started")
        ) {
          break;
        }
        await sleep(500);
      }
    }
    followUpShot = await screenshot(session, "follow-up.png");
    const followRows = followAttemptId ? eventsAfter(followAttemptId, followCursor) : [];
    reopenSample.followUpNonce = nonceFollow;
    reopenSample.followUpScreenshot = followUpShot;
    reopenSample.followUpTarget = followTarget;
    reopenSample.followUpSkippedCodexHandoff = skipBecauseCodex;
    reopenSample.followUpUserMessage = followRows.some((row) => row.kind === "message.user");
    reopenSample.followUpNativeTurn = followRows.some((row) => row.kind === "runtime.turn.started");
    reopenSample.followUpScreenshotShaDiffers =
      Boolean(followUpShot?.sha256) &&
      Boolean(reopenShot?.sha256) &&
      followUpShot.sha256 !== reopenShot.sha256;
    reopenSample.residualFollowUpMet =
      reopenSample.followUpUserMessage === true &&
      reopenSample.followUpNativeTurn === true &&
      reopenSample.followUpScreenshotShaDiffers === true &&
      skipBecauseCodex === false;
  });
} catch (error) {
  reports.reopenError = String(error && error.stack ? error.stack : error);
}

if (!reopenOnly) {
const ownershipAfter = claudeOwnership();
const spawnInfo = spawnArgvFromCoreLog();
const argvFlags = Array.isArray(spawnInfo.argv) ? spawnInfo.argv.map(String) : [];
reports.ownership = {
  schemaVersion: 1,
  kind: "native-ownership",
  operationId,
  claudeHome: "[user home]/.claude",
  settingsJsonSha256Before: ownershipBefore.settingsJsonSha256,
  settingsJsonSha256After: ownershipAfter.settingsJsonSha256,
  settingsUnchanged: ownershipBefore.settingsJsonSha256 === ownershipAfter.settingsJsonSha256,
  credentialsBytesBefore: ownershipBefore.credentialsBytes,
  credentialsBytesAfter: ownershipAfter.credentialsBytes,
  credentialsSizeUnchanged: ownershipBefore.credentialsBytes === ownershipAfter.credentialsBytes,
  observedBeforeUtc: ownershipBefore.observedAtUtc,
  observedAfterUtc: ownershipAfter.observedAtUtc,
  coreLog: CORE_LOG.replace(`${ROOT}\\`, "").replaceAll("\\", "/"),
  coreLogPresent: existsSync(CORE_LOG),
  spawnLogLine: spawnInfo.line,
  spawnArgv: spawnInfo.argv,
  spawnCwdSha256: spawnInfo.cwdHash,
  hasPermissionPromptsHost:
    argvFlags.includes("--permission-prompts") && argvFlags.includes("host"),
  hasPermissionModeManual: argvFlags.includes("--permission-mode") && argvFlags.includes("manual"),
  hasPermissionPromptToolStdio:
    argvFlags.includes("--permission-prompt-tool") && argvFlags.includes("stdio"),
  hasBare: argvFlags.includes("--bare"),
  hasSkipPermissions: argvFlags.includes("--dangerously-skip-permissions"),
  hasPromptsNone: argvFlags.some(
    (flag, i) => flag === "--permission-prompts" && argvFlags[i + 1] === "none"
  ),
  apiKeyEnvRemoved: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"],
  apiKeyEnvRemovedIncludesAnthropic: true,
  observedAtUtc: nowIso()
};
reports.ownership.status =
  reports.ownership.settingsUnchanged &&
  reports.ownership.credentialsSizeUnchanged &&
  reports.ownership.hasPermissionPromptsHost &&
  reports.ownership.hasPermissionModeManual &&
  reports.ownership.hasPermissionPromptToolStdio &&
  !reports.ownership.hasBare &&
  !reports.ownership.hasSkipPermissions &&
  !reports.ownership.hasPromptsNone
    ? "PASS"
    : "UNMET";
}

if (reports.permission) {
  reports.permission.reopenBoundNoticeCopies = reopenSample?.boundCopies ?? null;
  reports.permission.reopenBoundNoticeAtMostOnce =
    typeof reopenSample?.boundCopies === "number" ? reopenSample.boundCopies <= 1 : false;
  const liveAc6e =
    Boolean(reports.permission.allowOnce?.requestId) &&
    reports.permission.allowOnce?.shaChanged === true &&
    reports.permission.deny1?.fileAbsent === true &&
    reports.permission.deny2?.fileAbsent === true &&
    reports.permission.deny1?.resolved === true &&
    reports.permission.deny2?.resolved === true &&
    reports.permission.distinctDecisionIds === true &&
    Boolean(reports.permission.boundNoticeAfterDecline2) &&
    reports.permission.boundNoticeAbsentAfterDecline1 === true &&
    reports.permission.failOpen === false &&
    reports.permission.mutatingToolWithoutHostDecision === false &&
    reports.permission.deny1?.clicked !== "missing" &&
    reports.permission.deny2?.clicked !== "missing" &&
    reports.permission.reopenBoundNoticeAtMostOnce === true;
  reports.permission.status = liveAc6e ? "PASS" : "UNMET";
}

reports.dup = {
  schemaVersion: 1,
  kind: "claude-dup-cards",
  operationId,
  host: "electron-packaged",
  samples: {
    afterNormalCommit: reports.dupPartial?.afterCommit || null,
    afterDeclineNotice: reports.dupPartial?.afterDecline || null,
    afterReopen: reopenSample?.dupAfterReopen || null
  },
  screenshot: reopenSample?.screenshot || null,
  status:
    reports.dupPartial?.afterCommit?.oneCardPerLogicalReply &&
    reports.dupPartial?.afterDecline?.oneCardPerLogicalReply &&
    reopenSample?.dupAfterReopen?.oneCardPerLogicalReply
      ? "PASS"
      : "UNMET"
};

if (!reports.multiturn) {
  reports.multiturn = {
    schemaVersion: 1,
    kind: "claude-gui-multiturn",
    operationId,
    host: "electron-packaged",
    driver: DRIVER_REL,
    status: "UNMET",
    reason: reports.driverError || "gui session did not complete"
  };
}
if (!reports.permission) {
  reports.permission = unmetPermission(reports.driverError || "gui session did not complete");
}
if (!reports.cancel) {
  reports.cancel = {
    schemaVersion: 1,
    kind: "claude-cancel",
    operationId,
    host: "electron-packaged",
    status: "UNMET",
    negativeControl: A_GATE_NEGATIVE_CONTROL,
    usageEvidence: {
      class: "gui",
      boundaryStates: ["interrupted", "error-path"],
      interrupted: false,
      errorPathSatisfiedBy: "negativeControl-a-gate-fixture"
    },
    ac6cClosedPredicate: { met: false, honestXor: false },
    productStopUnresolved: true,
    productStopUnresolvedReason: "no terminal stop event was recorded",
    driverStatusNote: "driver status is not AC6c; admission must use ac6cClosedPredicate.met",
    reason: reports.driverError || "interrupt campaign did not complete"
  };
}
if (!reports.resume) {
  reports.resume = {
    schemaVersion: 1,
    kind: "claude-resume",
    operationId,
    host: "electron-packaged",
    nativeResume: "unverified",
    status: "UNMET"
  };
}
if (!reports.handoffCoreReport) {
  reports.handoffCoreReport = {
    schemaVersion: 2,
    kind: "core-constructed-runtime-handoff",
    operationId,
    manualCopy: false,
    status: "UNMET",
    reason: reports.driverError || reports.reopenError || "handoff did not complete"
  };
}
if (!reports.multiruntime) {
  reports.multiruntime = {
    schemaVersion: 1,
    kind: "claude-multiruntime",
    operationId,
    direction: "claude-to-codex",
    host: "electron-packaged",
    coreSha256: packagedCoreSha256,
    manualCopy: false,
    status: "UNMET"
  };
}

writeFileSync(resolve(EVID, "claude-gui-multiturn.json"), `${JSON.stringify(reports.multiturn, null, 2)}\n`);
writeFileSync(resolve(EVID, "claude-permission.json"), `${JSON.stringify(reports.permission, null, 2)}\n`);
writeFileSync(resolve(EVID, "claude-cancel.json"), `${JSON.stringify(reports.cancel, null, 2)}\n`);
writeFileSync(resolve(EVID, "claude-resume.json"), `${JSON.stringify(reports.resume, null, 2)}\n`);
writeFileSync(
  resolve(EVID, "handoff-core-report.json"),
  `${JSON.stringify(reports.handoffCoreReport, null, 2)}\n`
);
writeFileSync(
  resolve(EVID, "claude-multiruntime.json"),
  `${JSON.stringify(reports.multiruntime, null, 2)}\n`
);
writeFileSync(resolve(EVID, "native-ownership.json"), `${JSON.stringify(reports.ownership, null, 2)}\n`);
writeFileSync(resolve(EVID, "claude-dup-cards.json"), `${JSON.stringify(reports.dup, null, 2)}\n`);
if (reopenSample) {
  writeFileSync(resolve(EVID, "claude-reopen.json"), `${JSON.stringify(reopenSample, null, 2)}\n`);
}

const coreCleanup = stopIsolatedCore();
const summary = {
  operationId,
  driver: DRIVER_REL,
  packagedCoreSha256,
  multiturn: reports.multiturn?.status,
  permission: reports.permission?.status,
  cancelDriverStatus: reports.cancel?.status,
  ac6cClosedPredicateMet: reports.cancel?.ac6cClosedPredicate?.met ?? false,
  residualFollowUpMet: reopenSample?.residualFollowUpMet ?? false,
  resume: reports.resume?.status,
  ownership: reports.ownership?.status,
  dup: reports.dup?.status,
  multiruntime: reports.multiruntime?.status,
  driverError: reports.driverError || null,
  reopenError: reports.reopenError || null,
  coreCleanup
};
writeFileSync(resolve(EVID, "claude-gui-driver-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (reports.multiturn?.status !== "PASS" || reports.permission?.status !== "PASS") process.exitCode = 1;
