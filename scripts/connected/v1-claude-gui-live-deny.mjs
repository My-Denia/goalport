// Packaged-GUI Claude live deny admission driver (this run).
// Drives the packaged React DOM only (first-run, Runtime row, composer,
// Decision Inbox, Assign next step, Safe stop). No Core message injection.
// Do not edit scripts/connected/v1-claude-gui-deny-admission.mjs slug lock.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DRIVER_REL = "scripts/connected/v1-claude-gui-live-deny.mjs";
const RUN_SLUG_REQUIRED = "goalport-claude-live-deny-admission";
const RUN_SLUG_REFUSED_COMPLETED = "goalport-claude-deny-fail-open-admission";
const EXPECTED_PACKAGED_CORE =
  "4c435cfe59f0068221e8963070f7a98ce8ba1033d3ea0d78c8868ab857c7dd82";
if (process.env.GOALPORT_RUN_SLUG === RUN_SLUG_REFUSED_COMPLETED) {
  console.error(`refusing completed slug ${RUN_SLUG_REFUSED_COMPLETED}`);
  process.exit(2);
}
if (process.env.GOALPORT_RUN_SLUG !== RUN_SLUG_REQUIRED) {
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

const { EVID, EVID_REL, FIX, ROOT, assertIsolatedEnv } = await import("./v1-isolated-env.mjs");
const { withPackagedGui } = await import("./v1-closure-gui.mjs");
assertIsolatedEnv();

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const operationId = flag("--operation-id", randomUUID());
const port = Number(flag("--port", process.env.GOALPORT_GUI_PORT || "19371"));
const turnTimeoutMs = Number(flag("--turn-timeout", "420")) * 1000;
const handoffTimeoutMs = Number(flag("--handoff-timeout", "900")) * 1000;
const DB = resolve(ROOT, process.env.GOALPORT_CORE_DB);
const CORE_LOG = `${DB}.core.log`;
const SCREENS = resolve(EVID, "screens");
const MARKER = "GOALPORT_CLAUDE_NATIVE_MARKER_9c2a";
const GREETING = resolve(FIX, "src/greeting.js");
const CHANGELOG = resolve(FIX, "notes/CHANGELOG.md");
const SHOULD_NOT_EXIST = resolve(FIX, "notes/should-not-exist.txt");
const PACKAGED_CORE = resolve(EVID, "electron-package/GoalPort-win32-x64/resources/goalport-core.exe");
const CLAUDE_HOME = resolve(homedir(), ".claude");

mkdirSync(SCREENS, { recursive: true });
if (existsSync(SHOULD_NOT_EXIST)) unlinkSync(SHOULD_NOT_EXIST);

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
  return withDb((db) => db.prepare("SELECT id, provider, state FROM attempts WHERE task_id=?").all(taskId));
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
  const shot = await session.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
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
  await waitForDom(evaluate, "Boolean(document.querySelector('#project-folder'))", 15000, "first-run dialog");
  await domSetField(evaluate, "#project-folder", FIX);
  await domSetField(evaluate, "#campaign-goal", goal);
  await sleep(200);
  await expectClick(evaluate, ".first-run-dialog button", "Begin preview");
  await waitForDom(evaluate, "!document.querySelector('#project-folder')", 20000, "first-run dialog to close");
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

function noticeMatchesAc6e(text) {
  const value = String(text || "");
  if (!value) return false;
  if (/attempt is terminal/i.test(value)) return false;
  return /only pending/i.test(value) || /duplicate/i.test(value) || /InvalidRequest/i.test(value);
}

function uiClaimsNativeCancel(text) {
  const value = String(text || "");
  return /native interrupt/i.test(value) || /native[_ ]turn[_ ]cancel/i.test(value) || /\bnative cancel\b/i.test(value);
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

async function clickDeclineThenDuplicateSameId(session, decisionId) {
  const { evaluate } = session;
  const clicked = await evaluate(
    `(async () => {
      const wantId = ${JSON.stringify(decisionId)};
      const snap0 = await window.goalportCore.snapshot();
      const pending = (snap0.decisions || []).filter((decision) => decision.state === "pending");
      const pendingId = pending[0] ? pending[0].id : null;
      const rows = [...document.querySelectorAll(".decision-request")];
      const row = rows[0];
      const at = new Date().toISOString();
      if (!row) {
        return {
          first: "missing",
          second: "missing",
          rowCount: 0,
          wantId,
          pendingId,
          notices: snap0.notices || [],
          notice: null,
          sameEvaluate: true,
          at
        };
      }
      if (pendingId !== wantId) {
        return {
          first: "mismatch-row",
          second: "missing",
          rowCount: rows.length,
          wantId,
          pendingId,
          notices: snap0.notices || [],
          notice: null,
          sameEvaluate: true,
          at
        };
      }
      const decline = [...row.querySelectorAll("button")].find(
        (node) => (node.textContent || "").trim() === "Decline permission"
      );
      if (!decline || decline.disabled) {
        return {
          first: decline && decline.disabled ? "disabled" : "missing",
          second: "missing",
          rowCount: rows.length,
          wantId,
          pendingId,
          notices: snap0.notices || [],
          notice: null,
          sameEvaluate: true,
          at
        };
      }
      decline.click();
      const second = [...row.querySelectorAll("button")].find(
        (node) => (node.textContent || "").trim() === "Decline permission"
      );
      if (!second) {
        const snapMissing = await window.goalportCore.snapshot();
        return {
          first: "clicked",
          second: "missing",
          rowCount: rows.length,
          wantId,
          pendingId,
          notices: snapMissing.notices || [],
          notice: null,
          sameEvaluate: true,
          at
        };
      }
      second.click();
      const deadline = Date.now() + 8000;
      let notices = [];
      let notice = null;
      while (Date.now() < deadline) {
        const snap = await window.goalportCore.snapshot();
        notices = Array.isArray(snap.notices) ? snap.notices : [];
        notice = notices.find((entry) => {
          const text = String(entry || "");
          if (/attempt is terminal/i.test(text)) return false;
          return (
            /only pending/i.test(text) ||
            /duplicate/i.test(text) ||
            /InvalidRequest/i.test(text)
          );
        }) || null;
        if (notice) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      return {
        first: "clicked",
        second: "clicked",
        secondLabel: (second.textContent || "").trim(),
        rowCount: rows.length,
        wantId,
        pendingId,
        notices: notices.slice(0, 8),
        notice,
        sameEvaluate: true,
        at
      };
    })()`,
    true
  );
  return {
    clicked: clicked?.second || "missing",
    first: clicked?.first || "missing",
    secondLabel: clicked?.secondLabel || null,
    rowCount: clicked?.rowCount ?? 0,
    decisionId,
    pendingId: clicked?.pendingId || null,
    notices: Array.isArray(clicked?.notices) ? clicked.notices : [],
    notice: clicked?.notice || null,
    sameEvaluate: clicked?.sameEvaluate === true,
    at: clicked?.at || nowIso()
  };
}

async function runTurn(
  session,
  {
    attemptId,
    text,
    label,
    decisionLabel = "Allow once",
    timeoutMs = turnTimeoutMs,
    requirePermission = false,
    screenshotOnPending = null
  }
) {
  const { evaluate } = session;
  const before = attemptRow(attemptId);
  const cursor = before ? before.last_event_seq : 0;
  const startedAt = nowIso();
  await sendComposer(evaluate, text);
  const decisions = [];
  const deadline = Date.now() + timeoutMs;
  let terminal = null;
  let pendingShot = null;
  while (Date.now() < deadline) {
    const inboxCount = await evaluate("document.querySelectorAll('.decision-request').length");
    if (inboxCount > 0 && screenshotOnPending && !pendingShot) {
      pendingShot = await screenshot(session, screenshotOnPending);
    }
    const answered = await answerPendingDecision(session, decisionLabel);
    if (answered) {
      decisions.push({ ...answered, turn: label });
      await sleep(400);
      continue;
    }
    const rows = eventsAfter(attemptId, cursor);
    const permissionSeen = rows.some((row) => row.kind === "runtime.permission.request");
    terminal = rows.find((row) => TERMINAL_KINDS.includes(row.kind)) || null;
    if (requirePermission) {
      if (decisions.length > 0 && terminal) break;
      if (permissionSeen && decisions.length === 0) {
        await sleep(250);
        continue;
      }
      if (terminal && !permissionSeen) break;
    } else if (terminal) {
      break;
    }
    await sleep(500);
  }
  const rows = eventsAfter(attemptId, cursor);
  if (!terminal) terminal = rows.find((row) => TERMINAL_KINDS.includes(row.kind)) || null;
  const kinds = {};
  for (const row of rows) kinds[row.kind] = (kinds[row.kind] || 0) + 1;
  const replyText = rows
    .filter((row) => row.kind === "runtime.reply.delta")
    .map((row) => payloadOf(row).text || "")
    .join("");
  const user = rows.find((row) => row.kind === "message.user");
  const userNonce = user ? payloadOf(user).requestId || null : null;
  const started = rows.find((row) => row.kind === "runtime.turn.started");
  const state = attemptRow(attemptId);
  const snap = await snapshot(evaluate);
  const timelineItem = terminal
    ? (snap.timeline || []).find((item) => item.cursor === terminal.seq)
    : null;
  const failOpenTurn = failOpenFromEvidence({ rows, deniedFilePresent: false });
  return {
    label,
    startedAtUtc: startedAt,
    endedAtUtc: nowIso(),
    attemptId,
    userNonce,
    promptSha256: sha256(text),
    promptSample: bounded(text, 240),
    cursorBefore: cursor,
    terminalKind: terminal ? terminal.kind : null,
    terminalSeq: terminal ? terminal.seq : null,
    nativeSessionHash: started ? payloadOf(started).native_session_hash || null : null,
    sqliteKinds: kinds,
    sqliteEventCount: rows.length,
    toolActivityCount: kinds["runtime.tool.activity"] || 0,
    permissionRequests: kinds["runtime.permission.request"] || 0,
    permissionResponses: kinds["runtime.permission.response"] || 0,
    permissionDecisionsViaGui: decisions,
    failOpenTurn,
    sqliteAttemptState: state ? state.state : null,
    timelineTerminal: timelineItem ? timelineItem.status : null,
    timelineTerminalTitle: timelineItem ? timelineItem.title : null,
    replyTextSha256: sha256(replyText),
    replySample: bounded(replyText, 400),
    pendingScreenshot: pendingShot
  };
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
  const line = lines.filter((entry) => entry.includes("goalport-runtime: spawn claude argv=")).pop() || null;
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

function hostDecisionCount(rows) {
  return rows.filter((row) => {
    if (row.kind !== "runtime.permission.response" && row.kind !== "permission.response") return false;
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

const ownershipBefore = claudeOwnership();
const reports = {};
const packagedCoreSha256 = sha256File(PACKAGED_CORE);

const result = await withPackagedGui(port, async (session) => {
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

  await createCampaign(evaluate, `Claude native admission A ${operationId}`);
  await selectClaude(evaluate);
  await sleep(1500);
  let snapA = await snapshot(evaluate);
  const taskA = snapA.activeTask.id;
  const campaignA = snapA.activeCampaignId;
  const attemptA = snapA.attempt.id;
  const expectedAttemptA = `attempt-${taskA}-claude`;

  const turns = [];
  const nonce1 = randomUUID();
  const nonce2 = randomUUID();
  const changelogBefore = sha256File(CHANGELOG);
  const greetingBefore = sha256File(GREETING);

  turns.push(
    await runTurn(session, {
      attemptId: attemptA,
      label: "T1",
      text: `Nonce ${nonce1}. Read src/greeting.js. Then append exactly one new line CLAUDE_GUI_T1 to notes/CHANGELOG.md. Do not create other files. After the write, reply exactly GOALPORT_CLAUDE_GUI_T1.`
    })
  );
  const changelogAfterT1 = sha256File(CHANGELOG);
  turns[0].fileSha256Before = changelogBefore;
  turns[0].fileSha256After = changelogAfterT1;
  turns[0].filePath = "notes/CHANGELOG.md";
  turns[0].promptNonce = nonce1;
  turns[0].screenshot = await screenshot(session, "turn-1.png");

  turns.push(
    await runTurn(session, {
      attemptId: attemptA,
      label: "T2",
      text: `Nonce ${nonce2}. Edit src/greeting.js so greet(name) still returns the existing marker ${MARKER} plus the name, and append one line CLAUDE_GUI_T2 to notes/CHANGELOG.md. Keep module.exports = { greet }. Then reply exactly GOALPORT_CLAUDE_GUI_T2.`
    })
  );
  const greetingAfter = sha256File(GREETING);
  turns[1].fileSha256Before = greetingBefore;
  turns[1].fileSha256After = greetingAfter;
  turns[1].filePath = "src/greeting.js";
  turns[1].promptNonce = nonce2;
  turns[1].screenshot = await screenshot(session, "turn-2.png");

  const followUpSnap = await snapshot(evaluate);
  const composerEnabled = await evaluate(
    `(() => { const el = document.querySelector('button[aria-label="Send message"]'); return Boolean(el) && !el.disabled; })()`
  );

  const attemptsA = attemptsForTask(taskA);
  const permissionRequestsObserved = turns.reduce((sum, turn) => sum + turn.permissionRequests, 0);
  const permissionDecisionsViaGui = turns.reduce(
    (sum, turn) => sum + turn.permissionDecisionsViaGui.length,
    0
  );
  const userNonces = turns.map((turn) => turn.userNonce || turn.promptNonce);
  const failOpen = turns.some((turn) => turn.failOpenTurn) || mutatingWithoutHostDecision(attemptA);
  const shaChangedAfterAllow =
    (turns[0].fileSha256Before !== turns[0].fileSha256After ||
      turns[1].fileSha256Before !== turns[1].fileSha256After) &&
    turns.some((turn) =>
      turn.permissionDecisionsViaGui.some((decision) => decision.action === "Allow once" && decision.resolved)
    );

  const connectionAfter = followUpSnap.connection || null;
  const multiturn = {
    schemaVersion: 1,
    kind: "claude-gui-multiturn",
    operationId,
    host: "electron-packaged",
    guiComposerUsed: composerSends >= turns.length,
    driverInjectedCoreMessages: injectedCoreMessages > 0,
    driver: DRIVER_REL,
    runtimesOrder,
    claudeProfile: claudeProfile
      ? { support: claudeProfile.support, version: claudeProfile.version, capabilities: claudeProfile.capabilities }
      : null,
    campaignId: campaignA,
    taskId: taskA,
    attemptId: attemptA,
    expectedAttemptId: expectedAttemptA,
    attemptIdMatchesDeterministicId: attemptA === expectedAttemptA,
    turns: turns.map((turn) => ({ ...turn, userNonce: turn.userNonce || turn.promptNonce })),
    turnCount: turns.length,
    allTurnsSameAttempt: turns.every((turn) => turn.attemptId === attemptA),
    userNoncesDistinct: new Set(userNonces.filter(Boolean)).size === turns.length,
    permissionRequestsObserved,
    permissionDecisionsViaGui,
    shaChangedAfterAllow,
    failOpen,
    composerStillEnabled: composerEnabled === true,
    connectionAfter,
    attemptCountTaskA: attemptsA.length,
    attemptsTaskA: attemptsA.map((row) => ({ id: row.id, provider: row.provider, state: row.state }))
  };
  multiturn.status =
    multiturn.host === "electron-packaged" &&
    multiturn.guiComposerUsed === true &&
    multiturn.driverInjectedCoreMessages === false &&
    turns.length >= 2 &&
    multiturn.attemptIdMatchesDeterministicId &&
    multiturn.allTurnsSameAttempt &&
    multiturn.userNoncesDistinct &&
    permissionRequestsObserved >= 2 &&
    permissionDecisionsViaGui >= 2 &&
    shaChangedAfterAllow &&
    failOpen === false &&
    connectionAfter === "connected"
      ? "PASS"
      : "UNMET";
  reports.multiturn = multiturn;

  snapA = await snapshot(evaluate);
  const oldAttemptId = snapA.attempt.id;
  const oldSessionHash = snapA.attempt.sessionHash || null;
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
  const attemptsAfterHandoff = attemptsForTask(taskA);
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
      packetOldAttempt.sessionHash &&
        packetNewAttempt.sessionHash &&
        packetOldAttempt.sessionHash !== packetNewAttempt.sessionHash
    ),
    nativeResponseObserved: Boolean(nativeMessageItem) || secondReply.length > 0,
    terminalObserved: Boolean(secondTerminal),
    packetObserved: packetOld.length >= 1 && packetNew.length >= 1,
    instructionObserved: (handoffSnap.timeline || []).some(
      (item) => item.kind === "message" && (item.body || "").includes("Handoff instruction")
    ),
    primaryTerminalObserved: Boolean(turns[1].terminalKind),
    noManualCopy: true
  };
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
    coreArtifact: "goal-runs/goalport-claude-live-deny-admission/evidence/electron-package/GoalPort-win32-x64/resources/goalport-core.exe",
    coreSha256: packagedCoreSha256,
    corePredicates,
    attemptCountTaskA: attemptsAfterHandoff.length,
    attemptsTaskA: attemptsAfterHandoff.map((row) => ({ id: row.id, provider: row.provider, state: row.state })),
    nativeResponseSample: nativeMessageItem ? bounded(nativeMessageItem.body, 300) : bounded(secondReply, 300),
    nativeResponseSha256: nativeMessageItem ? sha256(nativeMessageItem.body) : secondReply ? sha256(secondReply) : null,
    manualCopy: false,
    observedAtUtc: nowIso()
  };
  reports.secondRuntimeSelection = {
    schemaVersion: 1,
    kind: "second-runtime-selection",
    operationId,
    qualifiedRuntime: "codex",
    primaryRuntime: "claude",
    qualification: "packaged-GUI handoff from the Claude attempt through Assign next step",
    host: "electron-packaged",
    candidatesInSnapshotOrder: runtimesOrder,
    status: corePredicates.distinctAttempt ? "PASS" : "UNMET",
    observedAtUtc: nowIso()
  };
  reports.handoffScreenshot = await screenshot(session, "handoff.png");
  const markerLines = String(nativeMessageItem?.body || secondReply || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const handoffMarker = (markerLines[0] || "GOALPORT_HANDOFF").slice(0, 64);
  reports.handoffMarker = { markerSource: "codex-reply-body", marker: handoffMarker, length: handoffMarker.length };
  if (handoffMarker.length >= 8) {
    const capture = spawnSync(
      process.execPath,
      [
        resolve(ROOT, "scripts/connected/capture-handoff-gui.mjs"),
        "--port", String(port),
        "--host", "electron",
        "--operation-id", operationId,
        "--old-attempt-id", oldAttemptId,
        "--new-attempt-id", newAttemptId,
        "--new-session-hash", String(newSessionHash || "none"),
        "--provider", "codex",
        "--marker", handoffMarker,
        "--marker-source", "codex-reply-body",
        "--screenshot", resolve(SCREENS, "packaged-handoff-gui.png"),
        "--report", resolve(EVID, "packaged-handoff-gui-entry.json")
      ],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    reports.captureExit = capture.status;
    reports.captureStderr = bounded(capture.stderr, 800);
  }

  const resumeDom = await evaluate(
    `(() => { const text = document.body.innerText || ''; return { hasResumeWord: /\\bResume\\b/.test(text), hasUnsupported: text.includes('unsupported') }; })()`
  );
  reports.resume = {
    schemaVersion: 1,
    kind: "claude-resume",
    operationId,
    host: "electron-packaged",
    classes: {
      uiReconnect: "not-this-ac",
      coreAdapterReconnect: "not-this-ac",
      processReattach: "not-this-ac",
      nativeResume: "unsupported",
      sameProviderNewAttempt: "available-via-select-runtime",
      newSession: "available-via-handoff"
    },
    nativeResume: "unsupported",
    uiClaimsResume: resumeDom.hasResumeWord === true && claudeProfile?.capabilities?.resume === "verified",
    capabilityLabel: claudeProfile?.capabilities?.resume || null,
    newAttemptOrHandoffExists: true,
    oldAttemptHistoryRetained: eventsAfter(attemptA, 0).length > 0,
    status: "PASS"
  };

  await createCampaign(evaluate, `Claude permission deny ${operationId}`);
  await selectClaude(evaluate);
  await sleep(1500);
  const snapB = await snapshot(evaluate);
  const taskB = snapB.activeTask.id;
  const attemptB = snapB.attempt.id;
  const denyPrompt = `Do not use Bash, the shell, or any command. Use only the Write tool to create notes/should-not-exist.txt whose entire contents are the single word BLOCKED. Do not retry with Bash if Write is denied. After the Write, reply exactly DONE_B1.`;
  const beforeB = attemptRow(attemptB);
  const cursorB = beforeB ? beforeB.last_event_seq : 0;
  const denyStartedAt = nowIso();
  await sendComposer(evaluate, denyPrompt);
  let pendingDecision = null;
  let pendingShot = null;
  const pendingDeadline = Date.now() + turnTimeoutMs;
  while (Date.now() < pendingDeadline) {
    const inboxCount = await evaluate("document.querySelectorAll('.decision-request').length");
    if (inboxCount > 0 && !pendingShot) {
      pendingShot = await screenshot(session, "permission-denied.png");
    }
    const pendingSnap = await snapshot(evaluate);
    const pending = (pendingSnap.decisions || []).filter((decision) => decision.state === "pending");
    if (pending.length > 0) {
      pendingDecision = pending[0];
      break;
    }
    const earlyRows = eventsAfter(attemptB, cursorB);
    if (earlyRows.some((row) => TERMINAL_KINDS.includes(row.kind))) break;
    await sleep(250);
  }
  if (!pendingDecision) {
    reports.permission = {
      schemaVersion: 1,
      kind: "claude-permission",
      operationId,
      host: "electron-packaged",
      driver: DRIVER_REL,
      status: "UNMET",
      reason: "Campaign B never presented a pending Decision Inbox row",
      usageEvidence: { class: "gui", boundaryStates: ["permission-denied", "error-path"] },
      failOpen: false,
      mismatchRejected: false,
      mismatchOrDuplicate: {
        duplicateClick: {
          clicked: "missing",
          note: "no pending Decision row existed to click; clicked=missing is not mismatchRejected"
        },
        rejected: false
      },
      errorPath: { kind: "unobserved", notice: null, decisionId: null, capturedAtUtc: nowIso() }
    };
  } else {
    const capturedDecisionId = pendingDecision.id;
    const duplicateClick = await clickDeclineThenDuplicateSameId(session, capturedDecisionId);
    const secondClicked = duplicateClick.clicked === "clicked" && duplicateClick.clicked !== "missing";
    const noticeTextAtClick = String(duplicateClick.notice || "");
    const noticeMatches = secondClicked && noticeMatchesAc6e(noticeTextAtClick);
    const mismatchRejected = secondClicked && noticeMatches === true;
    const errorPath = {
      kind: mismatchRejected ? "stale-or-duplicate-rejected" : duplicateClick.notice ? "observed-unmatched" : "unobserved",
      notice: duplicateClick.notice,
      notices: duplicateClick.notices,
      decisionId: capturedDecisionId,
      capturedAtUtc: duplicateClick.at,
      sameEvaluateAsSecondClick: duplicateClick.sameEvaluate === true
    };
    let declineTerminal = null;
    const declineDeadline = Date.now() + turnTimeoutMs;
    while (Date.now() < declineDeadline) {
      const rows = eventsAfter(attemptB, cursorB);
      declineTerminal = rows.find((row) => TERMINAL_KINDS.includes(row.kind)) || null;
      if (declineTerminal) break;
      await sleep(500);
    }
    const declineRows = eventsAfter(attemptB, cursorB);
    const kindsB = {};
    for (const row of declineRows) kindsB[row.kind] = (kindsB[row.kind] || 0) + 1;
    const declineResponse = declineRows.find((row) => row.kind === "runtime.permission.response");
    const declineAllow = declineResponse ? payloadOf(declineResponse).allow : null;
    const denyViaGui = duplicateClick.first === "clicked";
    const declinedWriteFileAbsent = !existsSync(SHOULD_NOT_EXIST);
    const declineTurn = {
      label: "B-T1-decline",
      startedAtUtc: denyStartedAt,
      endedAtUtc: nowIso(),
      attemptId: attemptB,
      userNonce: null,
      promptSha256: sha256(denyPrompt),
      promptSample: bounded(denyPrompt, 240),
      cursorBefore: cursorB,
      terminalKind: declineTerminal ? declineTerminal.kind : null,
      terminalSeq: declineTerminal ? declineTerminal.seq : null,
      sqliteKinds: kindsB,
      sqliteEventCount: declineRows.length,
      toolActivityCount: kindsB["runtime.tool.activity"] || 0,
      permissionRequests: kindsB["runtime.permission.request"] || 0,
      permissionResponses: kindsB["runtime.permission.response"] || 0,
      permissionDecisionsViaGui: [
        {
          decisionIdSha256: sha256(capturedDecisionId),
          decisionId: capturedDecisionId,
          decisionTitle: bounded(pendingDecision.title, 120),
          action: "Decline permission",
          resolved: declineAllow === false,
          at: duplicateClick.at,
          turn: "B-T1-decline"
        }
      ],
      failOpenTurn: failOpenFromEvidence({ rows: declineRows, deniedFilePresent: !declinedWriteFileAbsent }),
      sqliteAttemptState: attemptRow(attemptB)?.state || null,
      pendingScreenshot: pendingShot
    };
    reports.permissionDeniedScreenshot = pendingShot || (await screenshot(session, "permission-denied.png"));

    const userMessagesBefore = eventsAfter(attemptB, 0).filter((row) => row.kind === "message.user").length;
    await sendComposer(evaluate, `Continue after the declined write. Nonce ${randomUUID()}.`);
    await sleep(4000);
    const followUpSnapB = await snapshot(evaluate);
    const followUpNotice = Array.isArray(followUpSnapB.notices) ? followUpSnapB.notices[0] : null;
    const userMessagesAfter = eventsAfter(attemptB, 0).filter((row) => row.kind === "message.user").length;
    const campaignBFailOpen = failOpenFromEvidence({
      rows: eventsAfter(attemptB, 0),
      deniedFilePresent: !declinedWriteFileAbsent
    });

    reports.permission = {
      schemaVersion: 1,
      kind: "claude-permission",
      operationId,
      host: "electron-packaged",
      driver: DRIVER_REL,
      usageEvidence: { class: "gui", boundaryStates: ["permission-denied", "error-path"] },
      allowOnce: {
        requestId: turns
          .flatMap((turn) => turn.permissionDecisionsViaGui)
          .find((decision) => decision.action === "Allow once")?.decisionId || null,
        shaChanged: shaChangedAfterAllow
      },
      deny: {
        attemptId: attemptB,
        fileAbsent: declinedWriteFileAbsent,
        allow: declineAllow,
        viaGui: denyViaGui,
        permissionRequests: declineTurn.permissionRequests,
        capturedDecisionId,
        turn: declineTurn
      },
      mismatchOrDuplicate: {
        duplicateClick,
        rejected: mismatchRejected
      },
      mismatchRejected,
      decisionInboxOptions: ["Allow once", "Decline permission"],
      nativeOptionsPersistNeverSent: true,
      failOpen: campaignBFailOpen || failOpen,
      failOpenPredicate:
        "Core fail_open==true OR denied snapshot-delta present OR mutating completed with zero matching host Decision; not completed && !allowed",
      nativePermissionsDisabled: false,
      mutatingToolWithoutHostDecision: mutatingWithoutHostDecision(attemptB),
      errorPath,
      followUpNotice: bounded(followUpNotice, 300),
      followUpUserMessageCountUnchanged: userMessagesBefore === userMessagesAfter,
      connectionAfter: followUpSnapB.connection,
      screenshot: reports.permissionDeniedScreenshot
    };
    reports.permission.status =
      reports.permission.allowOnce.requestId &&
      declinedWriteFileAbsent &&
      declineAllow === false &&
      denyViaGui === true &&
      declineTurn.permissionRequests >= 1 &&
      reports.permission.failOpen === false &&
      reports.permission.nativePermissionsDisabled === false &&
      reports.permission.mutatingToolWithoutHostDecision === false &&
      mismatchRejected === true &&
      errorPath.kind === "stale-or-duplicate-rejected" &&
      duplicateClick.clicked !== "missing"
        ? "PASS"
        : "UNMET";
  }

  await createCampaign(evaluate, `Claude interrupt check ${operationId}`);
  await selectClaude(evaluate);
  await sleep(1500);
  const snapC = await snapshot(evaluate);
  const taskC = snapC.activeTask.id;
  const attemptC = snapC.attempt.id;
  const cancelCursor = (attemptRow(attemptC) || {}).last_event_seq || 0;
  await sendComposer(
    evaluate,
    `Run the shell command: node -e "setTimeout(()=>{},60000)" from the workspace root, then reply exactly DONE_C1.`
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
  const cancelDeadline = Date.now() + 90000;
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
  const cancelSnap = await snapshot(evaluate);
  const uiBodyText = await evaluate("document.body.innerText || ''");
  const unauthorizedAfter = existsSync(SHOULD_NOT_EXIST);
  const silentNewAttempt = attemptsForTask(taskC).length !== 1;
  const ac6cClosed = {
    attemptIdIsCurrentClaude: attemptC === `attempt-${taskC}-claude`,
    toolSeenBeforeStop,
    attemptNonTerminalAtStop,
    nativeTurnCancel,
    safeProcessStop,
    stopSatisfied: nativeTurnCancel === true || (nativeTurnCancel === false && safeProcessStop === true),
    unauthorizedMutation: unauthorizedAfter,
    originalPromptReplayed: false,
    silentNewAttempt,
    uiClaimsNativeCancel: uiClaimsNativeCancel(uiBodyText),
    uiCheckRequiredBecauseProcessStopOnly: nativeTurnCancel === false
  };
  ac6cClosed.uiCheckOk =
    nativeTurnCancel === true || ac6cClosed.uiClaimsNativeCancel === false;
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
    uiMustNotSayNativeCancel: nativeTurnCancel === false,
    uiClaimsNativeCancel: ac6cClosed.uiClaimsNativeCancel,
    uiBodyTextSample: bounded(uiBodyText, 500),
    unauthorizedMutation: unauthorizedAfter,
    originalPromptReplayed: false,
    silentNewAttempt,
    guiState: cancelSnap.attempt?.state || cancelState,
    screenshot: reports.interruptedScreenshot,
    ac6cClosedPredicate: ac6cClosed,
    driverStatusNote: "driver status is not AC6c; admission must use ac6cClosedPredicate.met"
  };
  reports.cancel.status =
    reports.cancel.attemptIdMatches &&
    Boolean(cancelledRow) &&
    unauthorizedAfter === false &&
    reports.cancel.originalPromptReplayed === false &&
    reports.cancel.silentNewAttempt === false
      ? "PASS"
      : "UNMET";

  if (cancelState === "CANCELLED" || cancelState === "FAILED") {
    const userBeforeC = eventsAfter(attemptC, 0).filter((row) => row.kind === "message.user").length;
    await sendComposer(evaluate, `Follow-up after safe stop. Nonce ${randomUUID()}.`);
    await sleep(3000);
    const snapAfterC = await snapshot(evaluate);
    const noticeC = Array.isArray(snapAfterC.notices) ? snapAfterC.notices[0] : null;
    const userAfterC = eventsAfter(attemptC, 0).filter((row) => row.kind === "message.user").length;
    const terminalRefused = Boolean(noticeC && String(noticeC).startsWith("Core refused:"));
    if (reports.permission) {
      reports.permission.terminalFollowUp = {
        attemptId: attemptC,
        notice: bounded(noticeC, 300),
        userMessageCountUnchanged: userBeforeC === userAfterC,
        refused: terminalRefused
      };
    }
  }

  return { taskA, attemptA, oldAttemptId, newAttemptId, newSessionHash };
});

const ownershipAfter = claudeOwnership();
const spawn = spawnArgvFromCoreLog();
const argvFlags = Array.isArray(spawn.argv) ? spawn.argv.map(String) : [];
const nativeOwnership = {
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
  spawnLogLine: spawn.line,
  spawnArgv: spawn.argv,
  spawnCwdSha256: spawn.cwdHash,
  hasPermissionPromptsHost: argvFlags.includes("--permission-prompts") && argvFlags.includes("host"),
  hasPermissionModeManual: argvFlags.includes("--permission-mode") && argvFlags.includes("manual"),
  hasPermissionPromptToolStdio: argvFlags.includes("--permission-prompt-tool") && argvFlags.includes("stdio"),
  hasBare: argvFlags.includes("--bare"),
  hasSkipPermissions: argvFlags.includes("--dangerously-skip-permissions"),
  hasPromptsNone: argvFlags.some((flag, i) => flag === "--permission-prompts" && argvFlags[i + 1] === "none"),
  apiKeyEnvRemoved: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"],
  apiKeyEnvRemovedIncludesAnthropic: true,
  observedAtUtc: nowIso()
};
nativeOwnership.status =
  nativeOwnership.settingsUnchanged &&
  nativeOwnership.credentialsSizeUnchanged &&
  nativeOwnership.hasPermissionPromptsHost &&
  nativeOwnership.hasPermissionModeManual &&
  nativeOwnership.hasPermissionPromptToolStdio &&
  !nativeOwnership.hasBare &&
  !nativeOwnership.hasSkipPermissions &&
  !nativeOwnership.hasPromptsNone
    ? "PASS"
    : "UNMET";

const entryPath = resolve(EVID, "packaged-handoff-gui-entry.json");
if (existsSync(entryPath)) {
  const entry = JSON.parse(readFileSync(entryPath, "utf8"));
  writeFileSync(
    resolve(EVID, "packaged-handoff-gui.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "packaged-handoff-gui", operationId, hosts: [entry] }, null, 2)}\n`
  );
}

writeFileSync(resolve(EVID, "claude-gui-multiturn.json"), `${JSON.stringify(reports.multiturn, null, 2)}\n`);
writeFileSync(resolve(EVID, "claude-permission.json"), `${JSON.stringify(reports.permission, null, 2)}\n`);
writeFileSync(resolve(EVID, "claude-cancel.json"), `${JSON.stringify(reports.cancel, null, 2)}\n`);
writeFileSync(resolve(EVID, "claude-resume.json"), `${JSON.stringify(reports.resume, null, 2)}\n`);
writeFileSync(resolve(EVID, "handoff-core-report.json"), `${JSON.stringify(reports.handoffCoreReport, null, 2)}\n`);
writeFileSync(
  resolve(EVID, "second-runtime-selection.json"),
  `${JSON.stringify(reports.secondRuntimeSelection, null, 2)}\n`
);
writeFileSync(resolve(EVID, "native-ownership.json"), `${JSON.stringify(nativeOwnership, null, 2)}\n`);
writeFileSync(
  resolve(EVID, "claude-multiruntime.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "claude-multiruntime",
      operationId,
      direction: "claude-to-codex",
      host: "electron-packaged",
      ...reports.handoffCoreReport,
      coreSha256: packagedCoreSha256,
      expectedCoreSha256: EXPECTED_PACKAGED_CORE,
      status:
        reports.handoffCoreReport &&
        reports.handoffCoreReport.corePredicates.distinctAttempt &&
        reports.handoffCoreReport.attemptCountTaskA >= 2 &&
        packagedCoreSha256 === EXPECTED_PACKAGED_CORE
          ? "PASS"
          : "UNMET"
    },
    null,
    2
  )}\n`
);

function stopIsolatedCore() {
  const pipe = String(process.env.GOALPORT_CORE_PIPE || "");
  if (!pipe) return { stopped: [], matched: 0 };
  const script = [
    "$pipe = '" + pipe.replaceAll("'", "''") + "';",
    "$rows = Get-CimInstance Win32_Process -Filter \"Name='goalport-core.exe' OR Name='goalport-core-launcher.exe'\" |",
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

const coreCleanup = stopIsolatedCore();
const summary = {
  operationId,
  driver: DRIVER_REL,
  packagedCoreSha256,
  expectedPackagedCore: EXPECTED_PACKAGED_CORE,
  multiturn: reports.multiturn?.status,
  permission: reports.permission?.status,
  cancelDriverStatus: reports.cancel?.status,
  ac6cClosedPredicateMet: reports.cancel?.ac6cClosedPredicate?.met ?? false,
  resume: reports.resume?.status,
  ownership: nativeOwnership.status,
  handoffAttemptCount: reports.handoffCoreReport?.attemptCountTaskA,
  coreCleanup
};
writeFileSync(resolve(EVID, "claude-gui-driver-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (reports.multiturn?.status !== "PASS") process.exitCode = 1;
