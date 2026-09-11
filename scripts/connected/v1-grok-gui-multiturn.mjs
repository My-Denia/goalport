// Packaged-GUI Grok admission driver for goal-runs/goalport-grok-native-admission.
//
// Everything a user would do is done through the real React DOM of the packaged
// Electron window (first-run dialog, Runtime row, composer, Decision Inbox,
// Assign next step, Safe stop). The Core projection is only ever READ, and the
// binding facts (event kinds, attempt states, permission option kinds) are read
// from the run-owned SQLite file, never from the relabelled UI timeline.
//
// Bearers written under goal-runs/<slug>/evidence/:
//   grok-gui-multiturn.json     AC2   Campaign A / task A multi-turn tool run
//   second-runtime-selection.json + handoff-core-report.json + packaged-handoff-gui.json
//                               AC5   Grok -> Codex handoff produced by the GUI
//   grok-fail-closed.json       AC3b  Campaign B decline + refused follow-up, Campaign C interrupt
//   native-ownership.json       AC4   ~/.grok untouched, spawn argv, permission source
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const RUN_SLUG_REQUIRED = "goalport-grok-native-admission";
if (process.env.GOALPORT_RUN_SLUG !== RUN_SLUG_REQUIRED) {
  console.error(`GOALPORT_RUN_SLUG must be ${RUN_SLUG_REQUIRED}`);
  process.exit(2);
}
process.env.GOALPORT_REQUIRE_ISOLATED = "1";
process.env.GOALPORT_DEBUG = process.env.GOALPORT_DEBUG || "1";
process.env.GOALPORT_CORE_PIPE =
  process.env.GOALPORT_CORE_PIPE || `\\\\.\\pipe\\${RUN_SLUG_REQUIRED}-gui-${process.pid}`;
// Absolute: the packaged Electron process resolves these against its own cwd.
process.env.GOALPORT_CORE_DB = resolve(
  REPO_ROOT,
  process.env.GOALPORT_CORE_DB || `goal-runs/${RUN_SLUG_REQUIRED}/evidence/grok-gui-r6.sqlite`
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
const port = Number(flag("--port", process.env.GOALPORT_GUI_PORT || "19341"));
const turnTimeoutMs = Number(flag("--turn-timeout", "420")) * 1000;
// The Codex handoff turn is a single external-Runtime turn that has twice exceeded the Grok turn
// budget (rounds 4 and 6). Waiting longer for the SAME turn changes no predicate and never retries
// inside the Attempt; it only stops the driver giving up before Codex reaches its terminal.
const handoffTimeoutMs = Number(flag("--handoff-timeout", "900")) * 1000;
const DB = resolve(ROOT, process.env.GOALPORT_CORE_DB);
const CORE_LOG = `${DB}.core.log`;
const SCREENS = resolve(EVID, "screens");
const MARKER = readFileSync(resolve(FIX, ".goalport/native-marker.txt"), "utf8").trim();
const GREETING = resolve(FIX, "src/greeting.js");
const SHOULD_NOT_EXIST = resolve(FIX, "notes/should-not-exist.txt");
const GROK_HOME = resolve(homedir(), ".grok");

mkdirSync(SCREENS, { recursive: true });

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha256File = (path) => (existsSync(path) ? sha256(readFileSync(path)) : null);
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const bounded = (value, max = 400) => String(value ?? "").slice(0, max);

// ---------------------------------------------------------------------------
// SQLite (read-only): the binding bearer for kinds, states and payloads.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Real-DOM actions. Nothing below fabricates a React state change: values are
// written through the native setter and an `input` event, buttons are clicked.
// ---------------------------------------------------------------------------
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

async function domText(evaluate, selector) {
  return evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.textContent || '').trim() : null; })()`
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
      // the renderer may be mid-render
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

async function selectGrok(evaluate) {
  const result = await evaluate(
    `(() => { const rows = [...document.querySelectorAll('details.runtime-row')];
      const row = rows.find((node) => (node.querySelector('.runtime-copy strong')?.textContent || '').trim() === 'Grok');
      if (!row) return 'no-row';
      row.open = true;
      const button = [...row.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === 'Select Grok');
      if (!button) return 'no-button';
      if (button.disabled) return 'disabled';
      button.click();
      return 'clicked'; })()`
  );
  if (result !== "clicked") throw new Error(`Select Grok returned ${result}`);
}

let composerSends = 0;

async function sendComposer(evaluate, text) {
  const set = await domSetField(evaluate, 'textarea[aria-label="Message composer"]', text);
  if (set !== "set") throw new Error(`composer textarea ${set}`);
  await sleep(250);
  const clicked = await domClickText(evaluate, 'button[aria-label="Send message"]', "Send");
  if (clicked !== "clicked") throw new Error(`Send message button ${clicked}`);
  composerSends += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Turn driver: answer every pending Decision through the Decision Inbox while
// the native turn runs, then wait for the SQLite terminal event for that turn.
// ---------------------------------------------------------------------------
const TERMINAL_KINDS = ["runtime.turn.completed", "runtime.turn.failed", "runtime.turn.cancelled"];

async function answerPendingDecision(session, label) {
  const { evaluate } = session;
  const domCount = await evaluate("document.querySelectorAll('.decision-request').length");
  if (!domCount) return null;
  const snap = await snapshot(evaluate);
  const pending = (snap.decisions || []).filter((decision) => decision.state === "pending");
  // Only act when the rendered Decision Inbox and the Core projection agree; a stale
  // render must never make the script answer a different Decision than it records.
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
    decisionTitle: bounded(target.title, 120),
    action: label,
    resolved: resolvedDecision,
    at: nowIso()
  };
}

async function runTurn(session, { attemptId, text, label, decisionLabel = "Allow once", timeoutMs = turnTimeoutMs }) {
  const { evaluate } = session;
  const before = attemptRow(attemptId);
  const cursor = before ? before.last_event_seq : 0;
  const startedAt = nowIso();
  await sendComposer(evaluate, text);
  const decisions = [];
  const deadline = Date.now() + timeoutMs;
  let terminal = null;
  while (Date.now() < deadline) {
    const answered = await answerPendingDecision(session, decisionLabel);
    if (answered) {
      decisions.push({ ...answered, turn: label });
      await sleep(400);
      continue;
    }
    const rows = eventsAfter(attemptId, cursor);
    terminal = rows.find((row) => TERMINAL_KINDS.includes(row.kind)) || null;
    if (terminal) break;
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
  const started = rows.find((row) => row.kind === "runtime.turn.started");
  const state = attemptRow(attemptId);
  const snap = await snapshot(evaluate);
  const timelineItem = terminal
    ? (snap.timeline || []).find((item) => item.cursor === terminal.seq)
    : null;
  return {
    label,
    startedAtUtc: startedAt,
    endedAtUtc: nowIso(),
    attemptId,
    promptSha256: sha256(text),
    promptSample: bounded(text, 240),
    cursorBefore: cursor,
    terminalKind: terminal ? terminal.kind : null,
    terminalSeq: terminal ? terminal.seq : null,
    nativeTurnHash: started ? payloadOf(started).native_turn_hash || null : null,
    nativeThreadHash: started ? payloadOf(started).native_thread_hash || null : null,
    sqliteKinds: kinds,
    sqliteEventCount: rows.length,
    toolActivityCount: kinds["runtime.tool.activity"] || 0,
    permissionRequests: kinds["runtime.permission.request"] || 0,
    permissionResponses: kinds["runtime.permission.response"] || 0,
    permissionDecisionsViaGui: decisions,
    sqliteAttemptState: state ? state.state : null,
    timelineTerminal: timelineItem ? timelineItem.status : null,
    timelineTerminalTitle: timelineItem ? timelineItem.title : null,
    replyTextSha256: sha256(replyText),
    replySample: bounded(replyText, 400),
    replyContainsMarker: replyText.includes(MARKER)
  };
}

// ---------------------------------------------------------------------------
// AC4: native ownership snapshots (hashes and sizes only, never content).
// ---------------------------------------------------------------------------
function grokOwnership() {
  const configPath = resolve(GROK_HOME, "config.toml");
  const authPath = resolve(GROK_HOME, "auth.json");
  return {
    configTomlSha256: sha256File(configPath),
    configTomlPresent: existsSync(configPath),
    authJsonBytes: existsSync(authPath) ? statSync(authPath).size : null,
    authJsonPresent: existsSync(authPath),
    observedAtUtc: nowIso()
  };
}

function spawnArgvFromCoreLog() {
  if (!existsSync(CORE_LOG)) return { line: null, argv: null, cwdHash: null, exePathSha256: null };
  const lines = readFileSync(CORE_LOG, "utf8").split(/\r?\n/);
  const line = lines.filter((entry) => entry.includes("goalport-runtime: spawn grok argv=")).pop() || null;
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const ownershipBefore = grokOwnership();
const reports = {};

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
  const grokProfile = (boot.runtimes || []).find((runtime) => runtime.id === "grok") || null;

  // ---- Campaign A / task A -------------------------------------------------
  await createCampaign(evaluate, `Grok native admission A ${operationId}`);
  await selectGrok(evaluate);
  await waitForDom(
    evaluate,
    "Boolean(window.goalportCore) && true",
    5000,
    "runtime selection"
  );
  await sleep(1500);
  let snapA = await snapshot(evaluate);
  const taskA = snapA.activeTask.id;
  const campaignA = snapA.activeCampaignId;
  const attemptA = snapA.attempt.id;
  const expectedAttemptA = `attempt-${taskA}-grok`;

  const turns = [];
  const fileBefore = sha256File(GREETING);
  turns.push(
    await runTurn(session, {
      attemptId: attemptA,
      label: "T1",
      text: `Read the file .goalport/native-marker.txt with your file tool. Do not modify any file. Then reply with exactly the marker text you read and nothing else.`
    })
  );
  turns[0].screenshot = await screenshot(session, "turn-1.png");

  turns.push(
    await runTurn(session, {
      attemptId: attemptA,
      label: "T2",
      text: `Edit src/greeting.js so that greet(name) returns the marker you read in the previous turn, then a space, then the name, and append one line to notes/CHANGELOG.md describing the change. Keep module.exports = { greet }. Then reply exactly DONE_T2.`
    })
  );
  const fileAfter = sha256File(GREETING);
  turns[1].fileSha256Before = fileBefore;
  turns[1].fileSha256After = fileAfter;
  turns[1].filePath = "src/greeting.js";
  turns[1].screenshot = await screenshot(session, "turn-2.png");

  turns.push(
    await runTurn(session, {
      attemptId: attemptA,
      label: "T3",
      text: `Run the shell command: node -e "console.log(require('./src/greeting.js').greet('goalport'))" from the workspace root, then reply with exactly the line it printed.`
    })
  );
  turns[2].verificationOutputObserved = turns[2].replyContainsMarker;
  turns[2].screenshot = await screenshot(session, "turn-3.png");

  turns.push(
    await runTurn(session, {
      attemptId: attemptA,
      label: "T4",
      text: `Without using any tools, summarise in one sentence what you changed in this session.`
    })
  );
  turns[3].screenshot = await screenshot(session, "turn-4.png");

  const attemptsA = attemptsForTask(taskA);
  const turnHashes = turns.map((turn) => turn.nativeTurnHash);
  const sessionCreated = eventsAfter(attemptA, 0).find((row) => row.kind === "runtime.session.created");
  const permissionRequestsObserved = turns.reduce((sum, turn) => sum + turn.permissionRequests, 0);
  const permissionDecisionsViaGui = turns.reduce(
    (sum, turn) => sum + turn.permissionDecisionsViaGui.length,
    0
  );
  const multiturn = {
    schemaVersion: 1,
    kind: "grok-gui-multiturn",
    operationId,
    host: "electron-packaged",
    guiComposerUsed: composerSends === turns.length,
    runtimesOrder,
    grokProfile: grokProfile
      ? { support: grokProfile.support, subtitle: grokProfile.subtitle, capabilities: grokProfile.capabilities }
      : null,
    campaignId: campaignA,
    taskId: taskA,
    attemptId: attemptA,
    expectedAttemptId: expectedAttemptA,
    attemptIdMatchesDeterministicId: attemptA === expectedAttemptA,
    marker: MARKER,
    nativePermissionPrompts: sessionCreated ? payloadOf(sessionCreated).native_permission_prompts || null : null,
    turns,
    turnCount: turns.length,
    turnHashesDistinct: new Set(turnHashes.filter(Boolean)).size === turns.length,
    allTurnsSameAttempt: turns.every((turn) => turn.attemptId === attemptA),
    permissionRequestsObserved,
    permissionDecisionsViaGui,
    allGuiDecisionsResolved: turns.every((turn) =>
      turn.permissionDecisionsViaGui.every((decision) => decision.resolved === true)
    ),
    attemptCountTaskA: attemptsA.length,
    attemptsTaskA: attemptsA.map((row) => ({ id: row.id, provider: row.provider, state: row.state }))
  };
  multiturn.status =
    multiturn.host === "electron-packaged" &&
    multiturn.guiComposerUsed === true &&
    runtimesOrder.length > 0 &&
    turns.length >= 4 &&
    multiturn.attemptIdMatchesDeterministicId &&
    multiturn.allTurnsSameAttempt &&
    multiturn.turnHashesDistinct &&
    turns.slice(0, 3).every((turn) => turn.toolActivityCount >= 1) &&
    permissionRequestsObserved >= 2 &&
    permissionDecisionsViaGui >= 2 &&
    multiturn.allGuiDecisionsResolved === true &&
    turns[1].fileSha256Before !== turns[1].fileSha256After &&
    turns[2].verificationOutputObserved === true &&
    turns.every((turn) => turn.sqliteAttemptState === "AWAITING_REVIEW") &&
    turns.every((turn) => turn.timelineTerminal === "COMMITTED") &&
    attemptsA.length === 1
      ? "PASS"
      : "UNMET";
  reports.multiturn = multiturn;

  // ---- Handoff (task A) ----------------------------------------------------
  snapA = await snapshot(evaluate);
  const oldAttemptId = snapA.attempt.id;
  const oldSessionHash = snapA.attempt.sessionHash || null;
  const primaryTerminalObserved = turns[3].timelineTerminal === "COMMITTED";
  await expectClick(evaluate, ".rail-action", "Assign next step");
  await sleep(2000);
  let handoffSnap = await snapshot(evaluate);
  const handoffDeadline = Date.now() + handoffTimeoutMs;
  let newAttemptId = handoffSnap.attempt.id;
  let codexTerminal = null;
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
      codexTerminal = rows.find((row) => TERMINAL_KINDS.includes(row.kind)) || null;
      if (codexTerminal) break;
    }
    await sleep(500);
  }
  handoffSnap = await snapshot(evaluate);
  newAttemptId = handoffSnap.attempt.id;
  const newSessionHash = handoffSnap.attempt.sessionHash || null;
  const handoffTimeline = handoffSnap.timeline || [];
  const codexRows = eventsAfter(newAttemptId, 0);
  const codexReply = codexRows
    .filter((row) => row.kind === "runtime.reply.delta")
    .map((row) => payloadOf(row).text || "")
    .join("");
  const nativeMessageItem =
    handoffTimeline
      .filter(
        (item) =>
          item.actor === "Native Runtime" &&
          item.kind === "message" &&
          (item.body || "").trim().length > 0
      )
      .sort((left, right) => (right.body || "").length - (left.body || "").length)[0] || null;
  const sessionHashDetailObserved = handoffTimeline.some((item) =>
    (item.details || []).some((detail) => detail.startsWith("Provider session hash "))
  );
  // plan rev 4.2: distinctNativeSession comes from the Core-persisted handoff.completed
  // packet, because the historical "Provider session hash" timeline proxy is emitted only by
  // runtime.session.bound and app-server/ACP transports bind their session at create_session.
  const packetOld = eventsAfter(oldAttemptId, 0).filter((row) => row.kind === "handoff.completed");
  const packetNew = codexRows.filter((row) => row.kind === "handoff.completed");
  const packet = packetNew.length ? payloadOf(packetNew[0]) : {};
  const packetOldPayload = packetOld.length ? payloadOf(packetOld[0]) : {};
  const packetOldAttempt = packet.oldAttempt || {};
  const packetNewAttempt = packet.newAttempt || {};
  const hex64 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const oldRow = attemptRow(oldAttemptId) || {};
  const newRow = attemptRow(newAttemptId) || {};
  const distinctNativeSessionFacts = {
    handoffPacketOnBothAttempts: packetOld.length >= 1 && packetNew.length >= 1,
    handoffPacketsAgree:
      (packetOldPayload.oldAttempt || {}).sessionHash === packetOldAttempt.sessionHash &&
      (packetOldPayload.newAttempt || {}).sessionHash === packetNewAttempt.sessionHash,
    packetVersion: packet.packetVersion || null,
    oldAttemptSessionHash: packetOldAttempt.sessionHash || null,
    newAttemptSessionHash: packetNewAttempt.sessionHash || null,
    oldSessionHashIs64Hex: hex64(packetOldAttempt.sessionHash),
    newSessionHashIs64Hex: hex64(packetNewAttempt.sessionHash),
    sessionHashesDiffer: packetOldAttempt.sessionHash !== packetNewAttempt.sessionHash,
    newAttemptNativeSessionBound: packetNewAttempt.nativeSessionBound === true,
    oldAttemptProvider: packetOldAttempt.provider || null,
    newAttemptProvider: packetNewAttempt.provider || null,
    sqliteOldProviderSessionNonEmpty: Boolean(String(oldRow.provider_session || "").trim()),
    sqliteNewProviderSessionNonEmpty: Boolean(String(newRow.provider_session || "").trim())
  };
  const distinctNativeSession =
    distinctNativeSessionFacts.handoffPacketOnBothAttempts &&
    distinctNativeSessionFacts.handoffPacketsAgree &&
    distinctNativeSessionFacts.oldSessionHashIs64Hex &&
    distinctNativeSessionFacts.newSessionHashIs64Hex &&
    distinctNativeSessionFacts.sessionHashesDiffer &&
    distinctNativeSessionFacts.newAttemptNativeSessionBound &&
    distinctNativeSessionFacts.oldAttemptProvider === "grok" &&
    distinctNativeSessionFacts.newAttemptProvider === "codex" &&
    distinctNativeSessionFacts.sqliteOldProviderSessionNonEmpty &&
    distinctNativeSessionFacts.sqliteNewProviderSessionNonEmpty;
  const packetObserved = handoffTimeline.some(
    (item) => item.kind === "handoff" && item.body === "Core handoff packet committed"
  );
  const instructionObserved = handoffTimeline.some(
    (item) => item.kind === "message" && (item.body || "").includes("Handoff instruction")
  );
  const codexPermissionRequests = codexRows.filter((row) => row.kind === "runtime.permission.request").length;
  const corePredicates = {
    distinctAttempt: newAttemptId !== oldAttemptId && handoffSnap.attempt.id === newAttemptId,
    distinctNativeSession: Boolean(distinctNativeSession),
    nativeResponseObserved: Boolean(nativeMessageItem),
    terminalObserved: Boolean(codexTerminal && codexTerminal.kind === "runtime.turn.completed"),
    packetObserved,
    instructionObserved,
    primaryTerminalObserved,
    noManualCopy: true
  };
  const attemptsAfterHandoff = attemptsForTask(taskA);
  const handoffCoreReport = {
    schemaVersion: 2,
    kind: "core-constructed-runtime-handoff",
    operationId,
    qualifiedRuntime: "codex",
    primaryRuntime: "grok",
    hosts: ["electron"],
    oldAttemptId,
    newAttemptId,
    oldSessionHash,
    newSessionHash,
    coreArtifact: "target/release/goalport-core.exe",
    coreSha256: sha256File(resolve(ROOT, "target/release/goalport-core.exe")),
    corePredicates,
    predicateDefinitions: {
      distinctAttempt: "snapshot+sqlite: new id != old id, snapshot attempt == new attempt",
      distinctNativeSession: "handoff.completed-packet",
      nativeResponseObserved:
        "snapshot timeline: a Native Runtime message item on the new attempt with a non-empty body",
      terminalObserved: "sqlite-events: runtime.turn.completed on the new attempt",
      packetObserved:
        "snapshot timeline: handoff-kind item with body \"Core handoff packet committed\"",
      instructionObserved:
        "snapshot timeline: message-kind item containing \"Handoff instruction\"",
      primaryTerminalObserved: "the Grok T4 turn reached timeline status COMMITTED",
      noManualCopy:
        "Core built the handoff packet and the first instruction message; the host copied nothing"
    },
    distinctNativeSessionFacts,
    sessionHashDetailObserved,
    sessionHashDetailNote:
      "The historical \"Provider session hash ...\" timeline proxy is emitted only by " +
      "runtime.session.bound, which Core raises only when a Runtime returns a session id " +
      "different from the one already stored. App-server and ACP transports bind the native id " +
      "at create_session, so the proxy is unsatisfiable for the codex second Runtime AC5 " +
      "mandates. Recorded honestly so its absence stays visible.",
    codexPermissionRequests,
    nativeResponseSha256: nativeMessageItem ? sha256(nativeMessageItem.body) : null,
    nativeResponseSample: nativeMessageItem ? bounded(nativeMessageItem.body, 300) : null,
    codexReplySha256: codexReply ? sha256(codexReply) : null,
    codexReplySample: bounded(codexReply, 300),
    attemptCountTaskA: attemptsAfterHandoff.length,
    attemptsTaskA: attemptsAfterHandoff.map((row) => ({ id: row.id, provider: row.provider, state: row.state })),
    manualCopy: false,
    observedAtUtc: nowIso()
  };
  reports.handoffCoreReport = handoffCoreReport;
  reports.secondRuntimeSelection = {
    schemaVersion: 1,
    kind: "second-runtime-selection",
    operationId,
    qualifiedRuntime: "codex",
    primaryRuntime: "grok",
    qualification: "packaged-GUI handoff from the Grok attempt through the App's Assign next step action",
    host: "electron-packaged",
    candidatesInSnapshotOrder: runtimesOrder,
    status: corePredicates.distinctAttempt && corePredicates.terminalObserved ? "PASS" : "UNMET",
    observedAtUtc: nowIso()
  };
  reports.handoffScreenshot = await screenshot(session, "handoff.png");

  // Marker for the packaged-GUI capture: a bounded slice of the Codex reply body
  // that is present in the DOM only because Codex answered.
  // A single rendered line keeps the marker matchable against document.body.innerText.
  const markerLines = String(nativeMessageItem?.body || codexReply || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const handoffMarker = (markerLines[0] || "").slice(0, 64);
  reports.handoffMarker = { markerSource: "codex-reply-body", marker: handoffMarker, length: handoffMarker.length };

  if (handoffMarker.length >= 24) {
    const capture = spawnSync(
      process.execPath,
      [
        resolve(ROOT, "scripts/connected/capture-handoff-gui.mjs"),
        "--port", String(port),
        "--host", "electron",
        "--operation-id", operationId,
        "--old-attempt-id", oldAttemptId,
        "--new-attempt-id", newAttemptId,
        "--new-session-hash", String(newSessionHash),
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
  } else {
    reports.captureExit = null;
    reports.captureStderr = "handoff marker shorter than 24 characters; capture not run";
  }

  // ---- Campaign B / task B: permission-denied and error-path ---------------
  // Attempt 1 proved that a reject_once answer ends the Grok turn with
  // stopReason "cancelled", so the declined Attempt is terminal immediately.
  await createCampaign(evaluate, `Grok fail-closed check ${operationId}`);
  await selectGrok(evaluate);
  await sleep(1500);
  const snapB = await snapshot(evaluate);
  const taskB = snapB.activeTask.id;
  const attemptB = snapB.attempt.id;
  const expectedAttemptB = `attempt-${taskB}-grok`;
  const attemptCountTaskBBefore = attemptsForTask(taskB).length;

  const declineTurn = await runTurn(session, {
    attemptId: attemptB,
    label: "B-T1-decline",
    text: `Create the file notes/should-not-exist.txt whose only content is the word BLOCKED, then reply exactly DONE_B1.`,
    decisionLabel: "Decline permission"
  });
  const declineRows = eventsAfter(attemptB, declineTurn.cursorBefore);
  const declineResponse = declineRows.find((row) => row.kind === "runtime.permission.response");
  const declineOptionKind = declineResponse ? payloadOf(declineResponse).option_kind || null : null;
  const declinedWriteFileAbsent = !existsSync(SHOULD_NOT_EXIST);
  const declineCancelledRow = declineRows.find((row) => row.kind === "runtime.turn.cancelled") || null;
  const declineSnapshot = await snapshot(evaluate);
  const declineTimelineItem = declineCancelledRow
    ? (declineSnapshot.timeline || []).find((item) => item.cursor === declineCancelledRow.seq)
    : null;
  const reasonTextObserved = Boolean(
    declineTimelineItem && (declineTimelineItem.body || "").includes("Grok turn cancelled")
  );
  const declineState = (attemptRow(attemptB) || {}).state || null;
  const declineScreenshot = await screenshot(session, "fail-closed-decline.png");

  const userMessagesBefore = eventsAfter(attemptB, 0).filter((row) => row.kind === "message.user").length;
  const eventsBeforeFollowUp = eventsAfter(attemptB, 0).length;
  await sendComposer(evaluate, `Continue with the next step now that the previous write was declined.`);
  await sleep(3000);
  const noticeText = await domText(evaluate, ".footer-message span");
  const domConnection = await evaluate(
    "(() => { const el = document.querySelector('.goalport-shell'); return el ? el.getAttribute('data-connection') : null; })()"
  );
  const followUpSnapshot = await snapshot(evaluate);
  const userMessagesAfter = eventsAfter(attemptB, 0).filter((row) => row.kind === "message.user").length;
  const eventsAfterFollowUp = eventsAfter(attemptB, 0).length;
  const refusalScreenshot = await screenshot(session, "fail-closed-refusal.png");
  const attemptCountTaskBAfter = attemptsForTask(taskB).length;

  // ---- Campaign C / task C: interrupted ------------------------------------
  await createCampaign(evaluate, `Grok interrupt check ${operationId}`);
  await selectGrok(evaluate);
  await sleep(1500);
  const snapC = await snapshot(evaluate);
  const taskC = snapC.activeTask.id;
  const attemptC = snapC.attempt.id;
  const attemptCountTaskCBefore = attemptsForTask(taskC).length;
  const cancelCursor = (attemptRow(attemptC) || {}).last_event_seq || 0;
  await sendComposer(
    evaluate,
    `Run the shell command: node -e "setTimeout(()=>{},25000)" from the workspace root, then reply exactly DONE_C1.`
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
    if (rows.some((row) => row.kind === "runtime.tool.activity" && payloadOf(row).kind === "execute")) {
      toolSeen = true;
      if (!executeSeenAt) executeSeenAt = Date.now();
      // The tool_call frame can arrive before its permission request, so only treat the
      // command as running once the prompt has been answered in the GUI (or none appeared).
      if (cancelDecisions.length > 0 || Date.now() - executeSeenAt > 15000) break;
    }
    if (rows.some((row) => TERMINAL_KINDS.includes(row.kind))) break;
    await sleep(500);
  }
  await sleep(2500);
  const safeStopAtUtc = nowIso();
  await expectClick(evaluate, ".rail-action-danger", "Safe stop");
  let cancelledRow = null;
  let cancelState = null;
  const cancelDeadline = Date.now() + 90000;
  while (Date.now() < cancelDeadline) {
    const rows = eventsAfter(attemptC, cancelCursor);
    cancelledRow = rows.find((row) => row.kind === "runtime.turn.cancelled") || null;
    cancelState = (attemptRow(attemptC) || {}).state || null;
    if (cancelledRow && cancelState === "CANCELLED") break;
    await sleep(500);
  }
  const cancelDurationMs = Date.now() - Date.parse(safeStopAtUtc);
  const cancelSnapshot = await snapshot(evaluate);
  const cancelTimelineItem = cancelledRow
    ? (cancelSnapshot.timeline || []).find((item) => item.cursor === cancelledRow.seq)
    : null;
  const cancelReasonTextObserved = Boolean(
    cancelTimelineItem && (cancelTimelineItem.body || "").includes("Grok turn cancelled")
  );
  const cancelScreenshot = await screenshot(session, "fail-closed-cancel.png");
  const attemptCountTaskCAfter = attemptsForTask(taskC).length;

  const permissionDenied =
    declineOptionKind === "reject_once" && declinedWriteFileAbsent && declineState === "CANCELLED";
  const interrupted = Boolean(toolSeen && cancelledRow && cancelState === "CANCELLED");
  const errorPath = Boolean(
    noticeText && noticeText.startsWith("Core refused:") && noticeText.includes("terminal")
  );
  const boundaryStates = [
    permissionDenied ? "permission-denied" : null,
    interrupted ? "interrupted" : null,
    errorPath ? "error-path" : null
  ].filter(Boolean);

  const failClosed = {
    schemaVersion: 1,
    kind: "grok-fail-closed",
    operationId,
    host: "electron-packaged",
    note:
      "A reject_once answer ends the Grok turn with stopReason cancelled, so the declined Attempt " +
      "is terminal at once. Campaign B therefore carries permission-denied and error-path; the " +
      "interrupted boundary is carried by Campaign C on its own task and Attempt.",
    campaignId: snapB.activeCampaignId,
    taskId: taskB,
    attemptId: attemptB,
    expectedAttemptId: expectedAttemptB,
    attemptIdMatchesDeterministicId: attemptB === expectedAttemptB,
    declineTurn,
    declineOptionKind,
    declinedWriteFileAbsent,
    declineTerminalKind: declineTurn.terminalKind,
    declineScreenshot,
    sqliteAttemptState: declineState,
    runtimeTurnCancelledPresent: Boolean(declineCancelledRow),
    reasonTextObserved,
    cancelTimelineBody: declineTimelineItem ? bounded(declineTimelineItem.body, 200) : null,
    followUpNotice: bounded(noticeText, 300),
    followUpRefused: errorPath,
    connectionAfterRefusal: domConnection,
    coreSnapshotConnection: followUpSnapshot.connection,
    userMessageCountBefore: userMessagesBefore,
    userMessageCountAfter: userMessagesAfter,
    userMessageCountUnchanged: userMessagesBefore === userMessagesAfter,
    eventsBeforeFollowUp,
    eventsAfterFollowUp,
    attemptCountTaskBBefore,
    attemptCountTaskBAfter,
    refusalScreenshot,
    interrupt: {
      campaignId: snapC.activeCampaignId,
      taskId: taskC,
      attemptId: attemptC,
      decisions: cancelDecisions,
      executeToolObservedBeforeCancel: toolSeen,
      safeStopAtUtc,
      cancelDurationMs,
      cancelDuringToolExecution: toolSeen && cancelledRow ? "PROVEN" : "UNPROVEN",
      sqliteAttemptState: cancelState,
      runtimeTurnCancelledPresent: Boolean(cancelledRow),
      reasonTextObserved: cancelReasonTextObserved,
      cancelTimelineBody: cancelTimelineItem ? bounded(cancelTimelineItem.body, 200) : null,
      attemptCountTaskCBefore,
      attemptCountTaskCAfter,
      screenshot: cancelScreenshot
    },
    boundaryStates
  };
  failClosed.status =
    failClosed.attemptIdMatchesDeterministicId &&
    declinedWriteFileAbsent &&
    declineOptionKind === "reject_once" &&
    declineState === "CANCELLED" &&
    Boolean(declineCancelledRow) &&
    reasonTextObserved &&
    errorPath &&
    domConnection === "connected" &&
    failClosed.userMessageCountUnchanged &&
    attemptCountTaskBBefore === 1 &&
    attemptCountTaskBAfter === 1 &&
    interrupted &&
    cancelReasonTextObserved &&
    attemptCountTaskCAfter === 1 &&
    boundaryStates.length === 3
      ? "PASS"
      : "UNMET";
  reports.failClosed = failClosed;

  return {
    taskA,
    taskB,
    taskC,
    attemptA,
    attemptB,
    attemptC,
    oldAttemptId,
    newAttemptId,
    newSessionHash
  };
});

const ownershipAfter = grokOwnership();
const spawn = spawnArgvFromCoreLog();
const nativeOwnership = {
  schemaVersion: 1,
  kind: "native-ownership",
  operationId,
  grokHome: "[user home]/.grok",
  configTomlSha256Before: ownershipBefore.configTomlSha256,
  configTomlSha256After: ownershipAfter.configTomlSha256,
  configTomlUnchanged: ownershipBefore.configTomlSha256 === ownershipAfter.configTomlSha256,
  authJsonBytesBefore: ownershipBefore.authJsonBytes,
  authJsonBytesAfter: ownershipAfter.authJsonBytes,
  authJsonSizeUnchanged: ownershipBefore.authJsonBytes === ownershipAfter.authJsonBytes,
  observedBeforeUtc: ownershipBefore.observedAtUtc,
  observedAfterUtc: ownershipAfter.observedAtUtc,
  // The real launcher log for THIS run: `${db}.core.log`. Hardcoding a name here made
  // native-ownership.json point at a file the run never wrote.
  coreLog: CORE_LOG.replace(`${ROOT}\\`, "").replaceAll("\\", "/"),
  coreLogPresent: existsSync(CORE_LOG),
  spawnLogLine: spawn.line,
  spawnArgv: spawn.argv,
  spawnCwdSha256: spawn.cwdHash,
  spawnExePathSha256: spawn.exePathSha256,
  alwaysApproveFlag: Array.isArray(spawn.argv)
    ? spawn.argv.some((item) => String(item).includes("always-approve"))
    : null,
  permissionPromptsEnabledBy:
    reports.multiturn?.nativePermissionPrompts === "enabled-by-session-command"
      ? "session-command:/always-approve off"
      : reports.multiturn?.nativePermissionPrompts || "unknown",
  apiKeyEnvRemoved: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"],
  apiKeyEnvRemovedSource: "crates/goalport-core/src/runtime_manager.rs GrokAcpProcess::ensure_started",
  observedAtUtc: nowIso()
};
nativeOwnership.status =
  nativeOwnership.configTomlUnchanged &&
  nativeOwnership.authJsonSizeUnchanged &&
  Array.isArray(spawn.argv) &&
  spawn.argv.slice(-2).join(" ") === "agent stdio" &&
  nativeOwnership.alwaysApproveFlag === false &&
  nativeOwnership.permissionPromptsEnabledBy === "session-command:/always-approve off"
    ? "PASS"
    : "UNMET";

// packaged-handoff-gui.json wraps the capture entry in the shape strict-predicates expects.
const entryPath = resolve(EVID, "packaged-handoff-gui-entry.json");
if (existsSync(entryPath)) {
  const entry = JSON.parse(readFileSync(entryPath, "utf8"));
  writeFileSync(
    resolve(EVID, "packaged-handoff-gui.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "packaged-handoff-gui",
        operationId,
        markerSource: "codex-reply-body",
        markerLength: reports.handoffMarker?.length ?? null,
        nativeResponseItemSha256: reports.handoffCoreReport?.nativeResponseSha256 ?? null,
        hosts: [entry]
      },
      null,
      2
    )}\n`
  );
}

writeFileSync(resolve(EVID, "grok-gui-multiturn.json"), `${JSON.stringify(reports.multiturn, null, 2)}\n`);
writeFileSync(
  resolve(EVID, "handoff-core-report.json"),
  `${JSON.stringify(reports.handoffCoreReport, null, 2)}\n`
);
writeFileSync(
  resolve(EVID, "second-runtime-selection.json"),
  `${JSON.stringify(reports.secondRuntimeSelection, null, 2)}\n`
);
writeFileSync(resolve(EVID, "grok-fail-closed.json"), `${JSON.stringify(reports.failClosed, null, 2)}\n`);
writeFileSync(resolve(EVID, "native-ownership.json"), `${JSON.stringify(nativeOwnership, null, 2)}\n`);

// The packaged host spawns Core detached on purpose, so killing the window leaves it
// running. Only this run's Core (matched on this run's pipe name) is stopped, and only
// after every bearer has been written and every SQLite read has completed.
function stopIsolatedCore() {
  const pipe = String(process.env.GOALPORT_CORE_PIPE || "");
  if (!pipe) return { stopped: [], matched: 0 };
  const script = [
    // PowerShell single quotes: a backslash is a literal, only ' needs doubling.
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
  multiturn: reports.multiturn?.status,
  failClosed: reports.failClosed?.status,
  secondRuntimeSelection: reports.secondRuntimeSelection?.status,
  nativeOwnership: nativeOwnership.status,
  handoffCorePredicates: reports.handoffCoreReport?.corePredicates,
  captureExit: reports.captureExit,
  captureStderr: reports.captureStderr,
  coreCleanup,
  ids: result
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode =
  reports.multiturn?.status === "PASS" &&
  reports.failClosed?.status === "PASS" &&
  nativeOwnership.status === "PASS"
    ? 0
    : 1;
