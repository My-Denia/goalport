import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { attachGoalPort, waitFor } from "./v1-cdp.mjs";
import {
  EVID,
  FIX,
  RUN_SLUG,
  assertIsolatedEnv,
  isolatedChildEnv,
  refusePriorMutation
} from "./v1-isolated-env.mjs";

export const FREEZE_SHA = {
  core: "93b5ddbd265c2b755f645c2cf279c610081de24771d734286d5965bd2bb0e7ea",
  launcher: "c791f4aa9ea21facb1dd7dcdc1dd55938bb168d33674e3d55550776249c925d5",
  exe: "cb32e182da8efdd56444a7dbc96a038624734a9fd1eda098ce2e11797505dae6",
  asar: "9589cf5e04856629fa8d3b099a15b5383dd04afedd8ca1a933e1d530399d043c"
};

export const LIVE_REQUIRED_KEYS = [
  "host",
  "exeSha256",
  "coreSha256",
  "asarSha256",
  "campaignId",
  "taskId",
  "attemptId",
  "providerSessionHash",
  "runtimeProcessEpoch",
  "runtimeBinding",
  "originalPromptSha256",
  "userEntry",
  "closeOrKill",
  "attemptStateAtAction",
  "hostExited",
  "coreAlive",
  "nativeAlive",
  "absenceEvents",
  "reopenAttemptId",
  "originalPromptUserMessageCount",
  "promptReplay",
  "reconnectWhileActive",
  "originalStepTerminal",
  "followUp",
  "corePrespawn",
  "coreRespawn",
  "coreBefore",
  "coreAfter",
  "runtimeBefore",
  "runtimeAfter",
  "launchedGoalPortPids",
  "hostChain",
  "spawnFreezeCoreCalled",
  "pipePreexisting",
  "attemptCountAtSubmit",
  "attemptCountAtUiExit",
  "attemptCountAtReopen",
  "attemptCountAfterFollowUp",
  "attemptIdAtSubmit",
  "attemptIdAtUiExit",
  "attemptIdAtReopen",
  "attemptIdAfterFollowUp",
  "launchNonce",
  "startupReceipt",
  "launchReadyReceipt",
  "runStartedAtUtc",
  "runFinishedAtUtc",
  "taskSubmittedAtUtc",
  "driverOutcome"
];

const FOLLOW_UP_TEXT = "Append a single line FOLLOW-UP-OK to DONE.txt. Do not use the network. Stay inside this folder.";
const ORIGINAL_PROMPT =
  "Run `node long-work.mjs` in this folder and wait until that process exits. Do not rewrite the script. Do not skip the wait. Then stop. Do not use the network. Do not read or write any path outside this folder.";

export function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function isActiveState(state) {
  return /^(active|ACTIVE)$/.test(String(state || ""));
}

export function isTerminalState(state) {
  return /^(waiting|AwaitingReview|completed|Closed|failed|FAILED|Cancelled|cancelled)$/i.test(String(state || ""));
}

export function isEff01TerminalState(state) {
  const value = String(state || "");
  if (/^(failed|FAILED|Cancelled|cancelled)$/i.test(value)) return false;
  return /^(waiting|AwaitingReview|completed|Closed)$/i.test(value);
}

export function kindAllowed(kind) {
  const value = String(kind || "");
  if (/heartbeat/i.test(value)) return false;
  return value.startsWith("message.") || value.startsWith("runtime.");
}

function hex64(value) {
  return /^[0-9a-f]{64}$/i.test(String(value || ""));
}

export function sameProcessIdentity(a, b) {
  if (!a || !b) return false;
  if (!a.creationDate || !b.creationDate) return false;
  return Number(a.pid) === Number(b.pid) && String(a.creationDate) === String(b.creationDate);
}

export function sameFullProcessIdentity(a, b) {
  return sameProcessIdentity(a, b)
    && Boolean(a?.executablePath)
    && Boolean(b?.executablePath)
    && normPath(a.executablePath) === normPath(b.executablePath);
}

export function pinUniqueCodexChild(processes, corePid) {
  const rows = (processes || []).filter((row) => {
    const name = String(row.Name || row.name || "").toLowerCase();
    const parent = Number(row.ParentProcessId ?? row.parentPid);
    return name === "codex.exe" && parent === Number(corePid);
  });
  return { count: rows.length, row: rows.length === 1 ? rows[0] : null };
}

export function parseCimDateMs(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^\/Date\((\d{13})\)\/$/);
  if (!match) return NaN;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : NaN;
}

export function parseUtcInstant(value) {
  const raw = String(value || "").trim();
  if (/^\d{13}$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : NaN;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) return NaN;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) return NaN;
  return parsed;
}

export function forbiddenHarnessParent(name) {
  return /^(node|nodejs|powershell|pwsh|cmd|python|pythonw)\.exe$/i.test(String(name || ""));
}

export function continueBackgroundFromProductPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return payload.ok === true
    && payload.allowQuitLatch === true
    && payload.coreAcknowledged === true
    && String(payload.choice) === "continue"
    && Boolean(payload.receiptId)
    && Boolean(payload.requestId);
}

export function pipeBareName(raw) {
  const name = String(raw || "");
  const prefix = "\\\\.\\pipe\\";
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

export function startupReceiptValid(report) {
  const receipt = report?.startupReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, reason: "missing" };
  }
  if (String(receipt.kind) !== "startup") return { ok: false, reason: "kind" };
  const nonce = String(receipt.launchNonce || "");
  if (!nonce || String(report.launchNonce || "") !== nonce) return { ok: false, reason: "nonce" };
  if (!isUuid(nonce)) return { ok: false, reason: "nonce-format" };
  if (report.runSlug && String(receipt.runSlug || "") !== String(report.runSlug)) return { ok: false, reason: "runSlug" };
  const receiptPipe = pipeBareName(receipt.pipe || receipt.pipeIdentity);
  const reportPipe = pipeBareName(report.pipeBare || report.pipe);
  if (reportPipe && receiptPipe && receiptPipe !== reportPipe) return { ok: false, reason: "pipe" };
  const receiptDb = normPath(receipt.database || receipt.databaseIdentity);
  const reportDb = normPath(report.dbPath || report.database);
  if (reportDb && receiptDb && receiptDb !== reportDb) return { ok: false, reason: "database" };
  const electronPid = Number(receipt.electron?.pid);
  const launched = new Set((report.launchedGoalPortPids || []).map((pid) => Number(pid)));
  if (!Number.isFinite(electronPid) || electronPid <= 0) return { ok: false, reason: "electron-pid" };
  if (launched.size > 0 && !launched.has(electronPid)) return { ok: false, reason: "electron-pid" };
  const launcherPid = Number(receipt.launcher?.pid);
  const observedParent = Number(receipt.launcher?.observedParentPid ?? receipt.launcher?.parentPid);
  if (!Number.isFinite(launcherPid) || launcherPid <= 0) return { ok: false, reason: "launcher-pid" };
  if (observedParent !== electronPid) return { ok: false, reason: "launcher-parent" };
  const corePid = Number(receipt.core?.pid);
  const coreParent = Number(receipt.core?.observedParentPid ?? receipt.core?.observedLauncherPid ?? receipt.core?.parentPid);
  if (!Number.isFinite(corePid) || corePid <= 0) return { ok: false, reason: "core-pid" };
  if (coreParent !== launcherPid) return { ok: false, reason: "core-parent" };
  if (!report.coreBefore || Number(report.coreBefore.pid) !== corePid) return { ok: false, reason: "core-pid-mismatch" };
  const receiptCoreCreated = receipt.core?.creationDate
    || (receipt.core?.createdMs != null ? `/Date(${receipt.core.createdMs})/` : "");
  if (!report.coreBefore?.creationDate || !receiptCoreCreated) return { ok: false, reason: "core-creation-missing" };
  const liveMs = parseCimDateMs(report.coreBefore.creationDate);
  const receiptMs = parseCimDateMs(receiptCoreCreated);
  if (!Number.isFinite(liveMs) || !Number.isFinite(receiptMs) || liveMs !== receiptMs) {
    return { ok: false, reason: "core-creation" };
  }
  if (normPath(receipt.core?.executablePath) !== normPath(report.coreBefore.executablePath)) return { ok: false, reason: "core-path-mismatch" };
  if (!hex64(receipt.core?.executableSha256)) return { ok: false, reason: "core-sha256" };
  if (!receipt.coreEpochId
    || String(receipt.epochState) !== "READY_COMMITTED"
    || String(receipt.startupState) !== "READY_COMMITTED"
    || !receipt.startupReceiptId
    || !receipt.launchReadyReceiptId) return { ok: false, reason: "core-epoch" };
  if (String(receipt.reconciliation?.status) !== "completed") return { ok: false, reason: "reconciliation" };
  const timestamps = receipt.timestamps || {};
  const ordered = [
    timestamps.launchRequestedAtUtc,
    timestamps.launcherStartedAtUtc,
    timestamps.coreSpawnedAtUtc,
    timestamps.coreReadyAtUtc,
    timestamps.receiptPersistedAtUtc
  ];
  if (ordered.some((value) => !Number.isFinite(parseUtcInstant(value)))) {
    return { ok: false, reason: "timestamps" };
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (parseUtcInstant(ordered[index]) < parseUtcInstant(ordered[index - 1])) return { ok: false, reason: "timestamp-order" };
  }
  if (!receipt.electron?.executablePath || !receipt.launcher?.executablePath || !receipt.core?.executablePath) {
    return { ok: false, reason: "exe-path" };
  }
  return { ok: true, reason: "ok" };
}

export function launchReadyValid(report, evidence) {
  const ready = report?.launchReadyReceipt;
  const file = evidence?.launchReadyFile;
  const storedRows = evidence?.database?.launchReadyReceipts;
  if (!ready || typeof ready !== "object" || Array.isArray(ready)) return { ok: false, reason: "missing" };
  if (!file?.value || !Array.isArray(storedRows)) return { ok: false, reason: "evidence-missing" };
  if (storedRows.length !== 1) return { ok: false, reason: `count:${storedRows.length}` };
  const stored = storedRows[0]?.payload;
  const values = [ready, file.value, stored];
  const expectedEpoch = String(report.startupReceipt?.coreEpochId || "");
  const expectedStartupId = String(report.startupReceipt?.startupReceiptId || "");
  const expectedReadyId = String(report.startupReceipt?.launchReadyReceiptId || "");
  for (const value of values) {
    if (!value || value.kind !== "launch-ready" || value.readyState !== "READY_COMMITTED") return { ok: false, reason: "state" };
    if (String(value.readyReceiptId || "") !== expectedReadyId
      || String(value.startupReceiptId || "") !== expectedStartupId) return { ok: false, reason: "receipt-id" };
    if (String(value.launchNonce || "") !== String(report.launchNonce || "")
      || String(value.coreEpochId || "") !== expectedEpoch) return { ok: false, reason: "epoch" };
    if (String(value.runSlug || "") !== String(report.runSlug || "")) return { ok: false, reason: "runSlug" };
    if (pipeBareName(value.pipeIdentity) !== pipeBareName(report.pipeBare || report.pipe)) return { ok: false, reason: "pipe" };
    if (normPath(value.databaseIdentity) !== normPath(report.dbPath || report.database)) return { ok: false, reason: "database" };
    if (!sameFullProcessIdentity(value.core, report.startupReceipt?.core)
      || !sameFullProcessIdentity(value.core, evidence?.core)) return { ok: false, reason: "core-identity" };
    if (String(value.core?.executableSha256 || "").toLowerCase() !== String(evidence?.coreFileSha256 || "").toLowerCase()) {
      return { ok: false, reason: "core-sha256" };
    }
    if (!sameFullProcessIdentity(value.launcher, report.startupReceipt?.launcher)) return { ok: false, reason: "launcher-identity" };
    const launcherPath = value.launcher?.executablePath;
    if (!launcherPath
      || String(evidence?.launcherFileSha256 || "").toLowerCase() !== FREEZE_SHA.launcher
      || String(value.launcher?.executableSha256 || "").toLowerCase() !== FREEZE_SHA.launcher) {
      return { ok: false, reason: "launcher-sha256" };
    }
    const coreCreated = parseCimDateMs(value.core?.creationDate);
    const startupAt = parseUtcInstant(value.timestamps?.startupReceiptPersistedAtUtc);
    const readyAt = parseUtcInstant(value.timestamps?.readyAtUtc);
    const launchRequested = parseUtcInstant(value.timestamps?.launchRequestedAtUtc);
    if (![coreCreated, startupAt, readyAt, launchRequested].every(Number.isFinite)
      || launchRequested > startupAt || coreCreated > readyAt || startupAt > readyAt) {
      return { ok: false, reason: "timestamps" };
    }
  }
  const fileReadyAt = parseUtcInstant(file.value.timestamps?.readyAtUtc);
  const fileModified = parseUtcInstant(file.modifiedAtUtc);
  if (!Number.isFinite(fileModified) || fileModified < fileReadyAt) return { ok: false, reason: "file-freshness" };
  return { ok: true, reason: "ok" };
}

export function continueReceiptValid(report) {
  const core = report.continueReceiptCore;
  if (!core || typeof core !== "object" || Array.isArray(core)) return { ok: false, reason: "core-missing" };
  if (String(core.choice) !== "continue-background") return { ok: false, reason: "core-choice" };
  if (!core.receiptId || !core.requestId) return { ok: false, reason: "receiptId" };
  const raw = report.continueReceiptRaw;
  if (raw != null) {
    if (!continueBackgroundFromProductPayload(raw)) return { ok: false, reason: "return-payload" };
    if (String(raw.receiptId) !== String(core.receiptId)) return { ok: false, reason: "receiptId-mismatch" };
    if (String(raw.requestId) !== String(core.requestId)) return { ok: false, reason: "requestId-mismatch" };
  }
  if (report.attemptId && core.attemptId && String(core.attemptId) !== String(report.attemptId)) {
    return { ok: false, reason: "attemptId" };
  }
  const click = report.continueClickIssuedAtUtc;
  const main = core.mainReceivedAtUtc || report.mainReceivedAtUtc;
  const persisted = core.coreReceiptPersistedAtUtc || core.recordedAtUtc;
  const renderer = report.continueReceiptAtUtc;
  const host = report.hostExitedAtUtc;
  if (!click || !main || !persisted || !host) return { ok: false, reason: "timestamps" };
  const times = [click, main, persisted, host, ...(renderer ? [renderer] : [])].map(parseUtcInstant);
  if (times.some((value) => !Number.isFinite(value))) return { ok: false, reason: "timestamp-format" };
  const [clickMs, mainMs, persistedMs, hostMs] = times;
  const rendererMs = renderer ? parseUtcInstant(renderer) : null;
  if (mainMs < clickMs) return { ok: false, reason: "order-main" };
  if (persistedMs < mainMs) return { ok: false, reason: "order-core" };
  if (rendererMs != null && rendererMs < persistedMs) return { ok: false, reason: "order-renderer" };
  if (hostMs < persistedMs) return { ok: false, reason: "order-host" };
  if (rendererMs != null && hostMs < rendererMs) return { ok: false, reason: "order-host-renderer" };
  return { ok: true, reason: "ok" };
}

export function hostChainFromSights(sights, { exePath, freezeLauncherPath, freezeCorePath } = {}) {
  const goalPort = sights?.goalPort || null;
  const launcher = sights?.launcher || null;
  const core = sights?.core || null;
  let reason = "missing-chain";
  if (launcher?.inferred === true) reason = "launcher-inferred";
  else if (launcher?.firstSightLive !== true) reason = "launcher-not-live-at-first-sight";
  else if (!launcher?.pid || !launcher?.creationDate || !launcher?.firstSeenAtUtc) reason = "launcher-first-sight-incomplete";
  else if (!goalPort?.pid || !goalPort?.creationDate) reason = "missing-goalport";
  else if (Number(launcher.parentPid) !== Number(goalPort.pid)) reason = "launcher-parent-not-goalport";
  else if (freezeLauncherPath && launcher.executablePath && normPath(launcher.executablePath) !== normPath(freezeLauncherPath)) reason = "launcher-path";
  else if (!String(launcher.executablePath || "").toLowerCase().endsWith("goalport-core-launcher.exe")) reason = "launcher-path";
  else if (!core?.pid || !core?.creationDate) reason = "missing-core";
  else if (Number(core.parentPid) !== Number(launcher.pid)) reason = "core-parent-not-launcher";
  else if (freezeCorePath && core.executablePath && normPath(core.executablePath) !== normPath(freezeCorePath)) reason = "core-path";
  else if (exePath && goalPort.executablePath && normPath(goalPort.executablePath) !== normPath(exePath)) reason = "goalport-path";
  else if (forbiddenHarnessParent(launcher.name)) reason = "harness-parent";
  else {
    const coreMs = parseCimDateMs(core.creationDate);
    const gpMs = parseCimDateMs(goalPort.creationDate);
    if (Number.isFinite(coreMs) && Number.isFinite(gpMs) && coreMs < gpMs) reason = "core-before-goalport";
    else {
      return {
        goalPort,
        launcher: { ...launcher, inferred: false },
        core,
        unattributable: false,
        inferredLauncher: false,
        reason: "live-launcher-chain"
      };
    }
  }
  return { goalPort, launcher, core, unattributable: true, inferredLauncher: Boolean(launcher?.inferred), reason };
}

export function attributeHostChain({
  processes,
  launchedRootPids,
  exePath,
  freezeCorePath,
  freezeLauncherPath,
  pipeBare,
  dbPath,
  last = {}
}) {
  const tree = descendantIds(processes, launchedRootPids);
  const launched = new Set((launchedRootPids || []).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid)));
  const goalPorts = (processes || []).filter((row) => {
    const pid = Number(row.ProcessId);
    if (String(row.Name || "").toLowerCase() !== "goalport.exe") return false;
    if (normPath(row.ExecutablePath) !== normPath(exePath)) return false;
    return tree.has(pid) || launched.has(pid) || launched.has(Number(row.ParentProcessId));
  });
  const launchers = (processes || []).filter((row) => {
    const path = normPath(row.ExecutablePath);
    if (!path.endsWith("goalport-core-launcher.exe")) return false;
    if (freezeLauncherPath && path !== normPath(freezeLauncherPath)) return false;
    const pid = Number(row.ProcessId);
    const parent = Number(row.ParentProcessId);
    return tree.has(pid) || tree.has(parent) || goalPorts.some((item) => Number(item.ProcessId) === parent);
  });
  const cores = coreOnPipeOrDb(processes, pipeBare, dbPath).filter((row) => {
    const path = normPath(row.ExecutablePath);
    if (!path.endsWith("goalport-core.exe")) return false;
    if (freezeCorePath && path !== normPath(freezeCorePath)) return false;
    return true;
  });
  const nowUtc = new Date().toISOString();
  const markLive = (identity, extra = {}) => identity
    ? { ...identity, firstSightLive: true, firstSeenAtUtc: identity.firstSeenAtUtc || extra.firstSeenAtUtc || nowUtc, inferred: false }
    : null;
  const goalPort = goalPorts[0] ? markLive(processIdentity(goalPorts[0]), last.goalPort || {}) : last.goalPort || null;
  const liveLauncher = launchers[0] ? markLive(processIdentity(launchers[0]), last.launcher || {}) : null;
  const launcher = liveLauncher || (last.launcher?.firstSightLive === true && last.launcher?.inferred !== true ? last.launcher : null);
  const core = cores[0] ? markLive(processIdentity(cores[0]), last.core || {}) : last.core || null;
  if (liveLauncher && last.launcher?.inferred) {
    last = { ...last, launcher: liveLauncher };
  }
  return hostChainFromSights({ goalPort, launcher, core }, { exePath, freezeLauncherPath, freezeCorePath });
}

export function collectVerifierEvidence(report) {
  const evidence = {
    source: "live-os-and-sqlite",
    collectedAtUtc: new Date().toISOString(),
    errors: [],
    core: null,
    coreFileSha256: null,
    launcherFileSha256: null,
    runtimes: [],
    database: null,
    launchReadyFile: null
  };
  try {
    const processes = cimProcesses();
    const coreRows = processes.filter((row) => Number(row.ProcessId) === Number(report?.coreBefore?.pid));
    if (coreRows.length === 1) {
      evidence.core = processIdentity(coreRows[0]);
      if (evidence.core.executablePath && existsSync(evidence.core.executablePath)) {
        evidence.coreFileSha256 = sha256File(evidence.core.executablePath);
      } else {
        evidence.errors.push("live Core executable path is missing or unreadable");
      }
    } else {
      evidence.errors.push(`live Core PID observation count=${coreRows.length}`);
    }
    evidence.runtimes = processes
      .filter((row) => String(row.Name || "").toLowerCase() === "codex.exe"
        && Number(row.ParentProcessId) === Number(report?.coreBefore?.pid))
      .map(processIdentity)
      .map((identity) => ({
        ...identity,
        executableSha256: identity.executablePath && existsSync(identity.executablePath)
          ? sha256File(identity.executablePath)
          : null
      }));
    const launcherPath = report?.startupReceipt?.launcher?.executablePath;
    if (launcherPath && existsSync(launcherPath)) {
      evidence.launcherFileSha256 = sha256File(launcherPath);
    } else {
      evidence.errors.push("launcher executable path is missing or unreadable");
    }
  } catch (error) {
    evidence.errors.push(`live process observation failed: ${String(error?.message || error)}`);
  }
  const dbPath = report?.dbPath || report?.database;
  if (!dbPath || !existsSync(dbPath)) {
    evidence.errors.push("referenced SQLite is missing");
    return evidence;
  }
  try {
    const readyPath = `${dbPath}.launch-ready`;
    if (existsSync(readyPath)) {
      const value = JSON.parse(readFileSync(readyPath, "utf8"));
      evidence.launchReadyFile = {
        path: resolve(readyPath),
        bytes: statSync(readyPath).size,
        modifiedAtUtc: statSync(readyPath).mtime.toISOString(),
        value
      };
    } else {
      evidence.errors.push("launch-ready sidecar is missing");
    }
    const db = openEventsDb(dbPath);
    try {
      const attempts = db.prepare(
        "SELECT a.id, a.task_id AS taskId, a.provider, a.provider_session AS providerSession, a.state, t.campaign_id AS campaignId FROM attempts a LEFT JOIN tasks t ON t.id=a.task_id WHERE a.task_id=? ORDER BY a.id"
      ).all(report?.taskId || "");
      const recovery = db.prepare(
        "SELECT attempt_id AS attemptId, provider, session_hash AS sessionHash, process_epoch AS processEpoch, pid, last_seq AS lastSeq, pending_permission_ids AS pendingPermissionIds, outbox_ids AS outboxIds, lease_workspace_key AS leaseWorkspaceKey, recovery_class AS recoveryClass, prompt_replay AS promptReplay, updated_at AS updatedAt FROM attempt_recovery WHERE attempt_id=?"
      ).all(report?.attemptId || "");
      const runtimeBindings = db.prepare(
        "SELECT attempt_id AS attemptId, campaign_id AS campaignId, task_id AS taskId, provider, session_hash AS sessionHash, process_epoch AS processEpoch, runtime_pid AS runtimePid, runtime_creation_date AS runtimeCreationDate, runtime_executable_path AS runtimeExecutablePath, runtime_executable_sha256 AS runtimeExecutableSha256, core_epoch_id AS coreEpochId, created_at AS createdAt FROM runtime_epoch_bindings WHERE attempt_id=? ORDER BY created_at, process_epoch"
      ).all(report?.attemptId || "");
      const events = db.prepare(
        "SELECT id, kind, created_at AS atUtc, payload_ref, payload_json, state_after AS stateAfter, attempt_id AS attemptId, seq FROM events WHERE attempt_id=? ORDER BY seq"
      ).all(report?.attemptId || "").map((row) => ({ ...row, atMs: eventTimeMs(row.atUtc), attempt_id: row.attemptId }));
      const startupReceipts = db.prepare(
        "SELECT id, launch_nonce AS launchNonce, payload_json AS payloadJson, created_at AS createdAt FROM product_receipts WHERE kind='startup' ORDER BY created_at, rowid"
      ).all().map((row) => ({ ...row, payload: JSON.parse(row.payloadJson) }));
      const launchReadyReceipts = db.prepare(
        "SELECT id, launch_nonce AS launchNonce, receipt_id AS receiptId, payload_json AS payloadJson, created_at AS createdAt FROM product_receipts WHERE kind='launch-ready' ORDER BY created_at, rowid"
      ).all().map((row) => ({ ...row, payload: JSON.parse(row.payloadJson) }));
      let coreEpochs = [];
      try {
        coreEpochs = db.prepare(
          "SELECT epoch_id AS epochId, launch_nonce AS launchNonce, core_pid AS corePid, core_creation_date AS coreCreationDate, core_executable_path AS coreExecutablePath, core_executable_sha256 AS coreExecutableSha256, previous_epoch_id AS previousEpochId, state, reconciliation_json AS reconciliationJson, created_at AS createdAt, activated_at AS activatedAt FROM core_launch_epochs ORDER BY rowid"
        ).all();
      } catch {
        coreEpochs = [];
      }
      evidence.database = { dbPath: resolve(dbPath), attempts, recovery, runtimeBindings, events, startupReceipts, launchReadyReceipts, coreEpochs };
    } finally {
      db.close();
    }
  } catch (error) {
    evidence.errors.push(`SQLite verification failed: ${String(error?.message || error)}`);
  }
  return evidence;
}

export function verifierEvidenceWitness(evidence) {
  const database = evidence?.database;
  return {
    source: evidence?.source || null,
    collectedAtUtc: evidence?.collectedAtUtc || null,
    errors: [...(evidence?.errors || [])],
    core: evidence?.core || null,
    coreFileSha256: evidence?.coreFileSha256 || null,
    launcherFileSha256: evidence?.launcherFileSha256 || null,
    runtimes: [...(evidence?.runtimes || [])],
    launchReadyFile: evidence?.launchReadyFile || null,
    database: database ? {
      dbPath: database.dbPath,
      attempts: (database.attempts || []).map((row) => ({
        id: row.id,
        taskId: row.taskId,
        campaignId: row.campaignId,
        provider: row.provider,
        providerSessionHash: row.providerSession ? sha256Text(row.providerSession) : null,
        state: row.state
      })),
      recovery: database.recovery || [],
      runtimeBindings: database.runtimeBindings || [],
      events: (database.events || []).map((row) => ({
        id: row.id,
        kind: row.kind,
        atUtc: row.atUtc,
        stateAfter: row.stateAfter,
        attemptId: row.attemptId,
        seq: row.seq,
        payloadRef: row.payload_ref || null
      })),
      startupReceipts: (database.startupReceipts || []).map((row) => ({
        id: row.id,
        launchNonce: row.launchNonce,
        createdAt: row.createdAt,
        coreEpochId: row.payload?.coreEpochId || null,
        epochState: row.payload?.epochState || null,
        reconciliation: row.payload?.reconciliation || null,
        core: row.payload?.core || null
      })),
      launchReadyReceipts: (database.launchReadyReceipts || []).map((row) => ({
        id: row.id,
        launchNonce: row.launchNonce,
        receiptId: row.receiptId,
        createdAt: row.createdAt,
        payload: row.payload
      })),
      coreEpochs: database.coreEpochs || []
    } : null
  };
}

export function evaluateReport(report, { mode, requireFreeze } = {}) {
  const evidence = collectVerifierEvidence(report);
  const judged = evaluateReportAgainstEvidence(report, {
    mode,
    requireFreeze,
    evidence
  });
  return { ...judged, evidence: verifierEvidenceWitness(evidence) };
}

export function evaluateReportAgainstEvidence(report, { mode, requireFreeze, evidence } = {}) {
  const reasons = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { status: "UNMET", reasons: ["report missing"] };
  }
  if (!evidence || evidence.source !== "live-os-and-sqlite") reasons.push("verifier-evidence-source");
  for (const error of evidence?.errors || []) reasons.push(`verifier-evidence:${error}`);
  for (const key of LIVE_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(report, key) || report[key] === undefined || report[key] === null) {
      reasons.push(`missing key ${key}`);
    }
  }
  if (report.error) reasons.push("driver-error");
  if (report.sqliteError) reasons.push("sqlite-error");
  if (report.timeout === true || report.timedOut === true) reasons.push("driver-timeout");
  if (report.aborted === true) reasons.push("driver-aborted");
  if (report.incomplete === true) reasons.push("driver-incomplete");
  if (report.driverOutcome?.status !== "completed" || !report.driverOutcome?.finishedAtUtc) {
    reasons.push("driver-outcome-incomplete");
  }
  if (report.userEntry !== "gui-cdp") reasons.push("userEntry must be gui-cdp");
  if (!hex64(report.exeSha256) || !hex64(report.coreSha256) || !hex64(report.asarSha256) || !hex64(report.originalPromptSha256)) {
    reasons.push("sha256 hex64");
  }
  if (requireFreeze === true) {
    if (String(report.coreSha256).toLowerCase() !== FREEZE_SHA.core) reasons.push("freeze-core");
    if (String(report.exeSha256).toLowerCase() !== FREEZE_SHA.exe) reasons.push("freeze-exe");
    if (String(report.asarSha256).toLowerCase() !== FREEZE_SHA.asar) reasons.push("freeze-asar");
  }
  const observedCore = evidence?.core;
  if (!sameFullProcessIdentity(observedCore, report.coreBefore)) reasons.push("live-core-identity");
  if (!sameFullProcessIdentity(observedCore, report.coreAfter)) reasons.push("live-core-after-identity");
  if (!sameFullProcessIdentity(observedCore, report.coreAtReopen)) reasons.push("live-core-reopen-identity");
  if (!hex64(evidence?.coreFileSha256)) reasons.push("live-core-file-sha256-missing");
  if (requireFreeze === true && String(evidence?.coreFileSha256 || "").toLowerCase() !== FREEZE_SHA.core) {
    reasons.push("live-core-file-freeze");
  }
  const observedCoreCommand = String(observedCore?.commandLine || "").toLowerCase();
  if (String(observedCore?.name || "").toLowerCase() !== "goalport-core.exe"
    || !observedCoreCommand.includes(" serve ")
    || !observedCoreCommand.includes(String(report.pipeBare || report.pipe || "").toLowerCase())
    || !normPath(observedCoreCommand).includes(normPath(report.dbPath || report.database))) {
    reasons.push("live-core-command-binding");
  }
  if (!isActiveState(report.attemptStateAtAction)) reasons.push("attemptStateAtAction not active");
  if (report.hostExited !== true) reasons.push("hostExited");
  if (report.coreAlive !== true) reasons.push("coreAlive");
  if (report.nativeAlive !== true) reasons.push("nativeAlive");
  if (report.corePrespawn !== false) reasons.push("corePrespawn");
  if (report.coreRespawn !== false) reasons.push("coreRespawn");
  if (report.spawnFreezeCoreCalled !== false) reasons.push("spawnFreezeCoreCalled");
  if (report.pipePreexisting !== false) reasons.push("pipePreexisting");
  const steps = Array.isArray(report.steps) ? report.steps : [];
  if (steps.some((step) => step?.message === "core-prespawn" || step?.message === "core-respawn-after-host-exit")) {
    reasons.push("prespawn-or-respawn-step");
  }
  const startup = startupReceiptValid(report);
  if (!startup.ok) reasons.push(`startup-receipt:${startup.reason}`);
  const launchReady = launchReadyValid(report, evidence);
  if (!launchReady.ok) reasons.push(`launch-ready:${launchReady.reason}`);
  if (startup.ok) {
    if (!sameFullProcessIdentity(observedCore, {
      pid: report.startupReceipt.core?.pid,
      creationDate: report.startupReceipt.core?.creationDate,
      executablePath: report.startupReceipt.core?.executablePath
    })) reasons.push("startup-receipt-live-core-identity");
    if (String(report.startupReceipt.core?.executableSha256 || "").toLowerCase()
      !== String(evidence?.coreFileSha256 || "").toLowerCase()) {
      reasons.push("startup-receipt-live-core-sha256");
    }
  }
  const startupReceipts = Array.isArray(report.startupReceipts) ? report.startupReceipts : (report.startupReceipt ? [report.startupReceipt] : []);
  if (startupReceipts.length !== 1) reasons.push(`startup-receipt-count:${startupReceipts.length}`);
  if (startupReceipts.length > 1) {
    const nonces = new Set(startupReceipts.map((row) => String(row?.launchNonce || "")));
    if (nonces.size > 1) reasons.push("startup-receipt-second-nonce");
    const pids = new Set(startupReceipts.map((row) => Number(row?.core?.pid)));
    if (pids.size > 1) reasons.push("startup-receipt-second-core");
  }
  const storedStartups = evidence?.database?.startupReceipts;
  if (!Array.isArray(storedStartups)) reasons.push("sqlite-startup-receipts-missing");
  else {
    if (storedStartups.length !== 1) reasons.push(`sqlite-startup-receipt-count:${storedStartups.length}`);
    const stored = storedStartups[0]?.payload;
    if (!stored || String(stored.launchNonce || "") !== String(report.launchNonce || "")) {
      reasons.push("sqlite-startup-receipt-nonce");
    }
    if (stored && String(stored.coreEpochId || "") !== String(report.startupReceipt?.coreEpochId || "")) {
      reasons.push("sqlite-startup-receipt-epoch");
    }
    if (stored && (!sameFullProcessIdentity(observedCore, {
      pid: stored.core?.pid,
      creationDate: stored.core?.creationDate,
      executablePath: stored.core?.executablePath
    }) || String(stored.core?.executableSha256 || "").toLowerCase() !== String(evidence?.coreFileSha256 || "").toLowerCase())) {
      reasons.push("sqlite-startup-receipt-core-identity");
    }
  }
  const storedEpochs = evidence?.database?.coreEpochs;
  if (!Array.isArray(storedEpochs) || storedEpochs.length !== 1) reasons.push("sqlite-core-epoch-count");
  else {
    const epoch = storedEpochs[0];
    if (String(epoch.state) !== "READY_COMMITTED") reasons.push("sqlite-core-epoch-state");
    if (String(epoch.epochId) !== String(report.startupReceipt?.coreEpochId || "")) reasons.push("sqlite-core-epoch-id");
    if (Number(epoch.corePid) !== Number(observedCore?.pid)
      || String(epoch.coreCreationDate) !== String(observedCore?.creationDate)
      || normPath(epoch.coreExecutablePath) !== normPath(observedCore?.executablePath)
      || String(epoch.coreExecutableSha256 || "").toLowerCase() !== String(evidence?.coreFileSha256 || "").toLowerCase()) {
      reasons.push("sqlite-core-epoch-identity");
    }
    let epochReconciliation = null;
    try { epochReconciliation = JSON.parse(epoch.reconciliationJson || "null"); } catch {}
    if (String(epochReconciliation?.status) !== "completed" || !epoch.activatedAt) {
      reasons.push("sqlite-core-epoch-reconciliation");
    }
  }
  if (report.hostChain?.inferredLauncher === true || report.hostChain?.launcher?.inferred === true) {
    reasons.push("launcher-inferred");
  }
  if (!sameProcessIdentity(report.coreBefore, report.coreAfter)) reasons.push("core-identity");
  if (!sameProcessIdentity(report.runtimeBefore, report.runtimeAfter)) reasons.push("runtime-identity");
  if (report.coreAtReopen && !sameProcessIdentity(report.coreBefore, report.coreAtReopen)) reasons.push("core-identity-reopen");
  if (Number(report.runtimeBefore?.parentPid) !== Number(report.coreBefore?.pid)) reasons.push("runtime-parent-not-core");
  const observedRuntimes = Array.isArray(evidence?.runtimes) ? evidence.runtimes : [];
  if (observedRuntimes.length !== 1) reasons.push(`live-runtime-count:${observedRuntimes.length}`);
  else {
    if (!sameFullProcessIdentity(observedRuntimes[0], report.runtimeBefore)) reasons.push("live-runtime-before-identity");
    if (!sameFullProcessIdentity(observedRuntimes[0], report.runtimeAfter)) reasons.push("live-runtime-after-identity");
  }
  const launched = new Set((report.launchedGoalPortPids || []).map((pid) => Number(pid)));
  if (launched.size === 0) reasons.push("launchedGoalPortPids");
  const attemptCounts = [
    report.attemptCountAtSubmit,
    report.attemptCountAtUiExit,
    report.attemptCountAtReopen,
    report.attemptCountAfterFollowUp
  ];
  if (attemptCounts.some((n) => n !== 1)) reasons.push("attemptCount");
  const attemptIds = [
    report.attemptIdAtSubmit,
    report.attemptIdAtUiExit,
    report.attemptIdAtReopen,
    report.attemptIdAfterFollowUp
  ];
  if (attemptIds.some((id) => !id) || new Set(attemptIds.map(String)).size !== 1) reasons.push("attemptId-continuity");
  if (report.attemptId && attemptIds[0] && String(report.attemptId) !== String(attemptIds[0])) {
    reasons.push("attemptId-mismatch");
  }
  if (report.attemptCountUnchanged !== true) reasons.push("attemptCountUnchanged");
  const storedAttempts = evidence?.database?.attempts;
  if (!Array.isArray(storedAttempts) || storedAttempts.length !== 1) reasons.push("sqlite-attempt-count");
  else {
    const attempt = storedAttempts[0];
    if (String(attempt.id) !== String(report.attemptId)
      || String(attempt.taskId) !== String(report.taskId)
      || String(attempt.campaignId) !== String(report.campaignId)
      || String(attempt.provider).toLowerCase() !== "codex") {
      reasons.push("sqlite-attempt-binding");
    }
    if (!attempt.providerSession || sha256Text(attempt.providerSession) !== String(report.providerSessionHash || "")) {
      reasons.push("sqlite-provider-session-binding");
    }
  }
  const recoveries = evidence?.database?.recovery;
  if (!Array.isArray(recoveries) || recoveries.length !== 1) reasons.push("sqlite-runtime-recovery-count");
  else {
    const recovery = recoveries[0];
    if (String(recovery.attemptId) !== String(report.attemptId)
      || String(recovery.provider).toLowerCase() !== "codex"
      || String(recovery.sessionHash || "") !== String(report.providerSessionHash || "")
      || Number(recovery.pid) !== Number(report.runtimeBefore?.pid)
      || !String(recovery.processEpoch || "").trim()
      || Number(recovery.promptReplay) !== 0) {
      reasons.push("sqlite-runtime-attempt-binding");
    }
  }
  const runtimeBindings = evidence?.database?.runtimeBindings;
  if (!Array.isArray(runtimeBindings) || runtimeBindings.length !== 1) {
    reasons.push(`sqlite-runtime-binding-count:${Array.isArray(runtimeBindings) ? runtimeBindings.length : "missing"}`);
  } else {
    const binding = runtimeBindings[0];
    const reported = report.runtimeBinding;
    const observedRuntime = observedRuntimes[0];
    const canonicalBindingChecks = {
      reported: Boolean(reported),
      reportEpoch: String(report.runtimeProcessEpoch || "") === String(binding.processEpoch || ""),
      recoveryEpoch: String(recoveries?.[0]?.processEpoch || "") === String(binding.processEpoch || ""),
      bindingEpoch: String(reported?.processEpoch || "") === String(binding.processEpoch || ""),
      attempt: String(binding.attemptId) === String(report.attemptId),
      campaign: String(binding.campaignId) === String(report.campaignId),
      task: String(binding.taskId) === String(report.taskId),
      provider: String(binding.provider).toLowerCase() === "codex",
      session: String(binding.sessionHash || "") === String(report.providerSessionHash || ""),
      runtimePid: Number(binding.runtimePid) === Number(observedRuntime?.pid),
      runtimeCreationDate: String(binding.runtimeCreationDate || "") === String(observedRuntime?.creationDate || ""),
      runtimePath: normPath(binding.runtimeExecutablePath) === normPath(observedRuntime?.executablePath),
      runtimeHash: String(binding.runtimeExecutableSha256 || "").toLowerCase() === String(observedRuntime?.executableSha256 || "").toLowerCase(),
      coreEpoch: String(binding.coreEpochId || "") === String(report.startupReceipt?.coreEpochId || "")
    };
    for (const [field, ok] of Object.entries(canonicalBindingChecks)) {
      if (!ok) reasons.push(`sqlite-runtime-canonical-binding:${field}`);
    }
    const reportedFields = [
      "attemptId", "campaignId", "taskId", "provider", "sessionHash", "processEpoch",
      "runtimePid", "runtimeCreationDate", "runtimeExecutablePath", "runtimeExecutableSha256", "coreEpochId"
    ];
    if (reported && reportedFields.some((field) => String(reported[field] ?? "") !== String(binding[field] ?? ""))) {
      reasons.push("report-runtime-binding");
    }
  }
  if (report.promptReplay !== false) reasons.push("promptReplay");
  if (report.promptReplayObserved !== true) reasons.push("promptReplay-unobserved");
  if (report.originalPromptUserMessageCount !== 1) reasons.push("originalPromptUserMessageCount");
  if (report.reopenAttemptId !== report.attemptId) reasons.push("reopenAttemptId");
  const events = Array.isArray(report.absenceEvents) ? report.absenceEvents : [];
  const persistedEvents = Array.isArray(evidence?.database?.events) ? evidence.database.events : [];
  const uiExitUtc = report.uiExitUtc;
  if (!uiExitUtc) reasons.push("uiExitUtc");
  const absenceOk = Boolean(uiExitUtc) && events.some((row) => {
    if (!kindAllowed(row?.kind) || !row?.atUtc || !row?.id) return false;
    if (!row.attemptId || row.attemptId !== report.attemptId) return false;
    if (String(row.atUtc) < String(uiExitUtc)) return false;
    return true;
  });
  if (!absenceOk) reasons.push("absenceEvents");
  const persistedAbsenceEvent = persistedEvents.find((row) => kindAllowed(row?.kind)
    && row?.id
    && String(row.attemptId) === String(report.attemptId)
    && eventTimeMs(row.atUtc) >= eventTimeMs(uiExitUtc));
  if (!persistedAbsenceEvent) reasons.push("sqlite-absence-events");
  else if (!eventMatchesRuntimeBinding(persistedAbsenceEvent, runtimeBindings?.[0])) {
    reasons.push("sqlite-absence-runtime-epoch");
  }
  for (const row of events) {
    if (!persistedEvents.some((stored) => stored.id === row.id
      && stored.kind === row.kind
      && String(stored.attemptId) === String(row.attemptId)
      && eventTimeMs(stored.atUtc) === eventTimeMs(row.atUtc))) {
      reasons.push(`absence-event-not-in-sqlite:${row?.id || "missing"}`);
    }
  }
  if (report.closeOrKill === "graceful") {
    const continued = continueReceiptValid(report);
    const receiptOk = report.continueReceiptPayload === "continue-background"
      && continued.ok
      && Boolean(report.closeDialogShownAtUtc)
      && Boolean(report.continueClickIssuedAtUtc)
      && Boolean(report.hostExitedAtUtc)
      && Number(report.targetUiPid) > 0
      && launched.has(Number(report.targetUiPid));
    if (!receiptOk) reasons.push(continued.ok ? "continue-receipt" : `continue-receipt:${continued.reason}`);
    if (report.allowQuitLatch === true && !receiptOk) reasons.push("fabricated-latch");
    if (report.allowQuitLatch !== true) reasons.push("allowQuitLatch");
    if (report.dialogPresented !== true) reasons.push("dialogPresented");
  }
  const reconnect = report.reconnectWhileActive;
  if (!reconnect || typeof reconnect !== "object" || !reconnect.attempt || reconnect.attempt.state === undefined) {
    reasons.push("reconnectWhileActive");
  } else {
    if (!isActiveState(reconnect.attempt.state)) reasons.push("reconnect-state-not-active");
    if (String(reconnect.connection).toLowerCase() !== "connected") reasons.push("reconnect-not-connected");
    if (String(reconnect.attempt.id) !== String(report.attemptId)
      || String(reconnect.campaignId) !== String(report.campaignId)
      || String(reconnect.taskId) !== String(report.taskId)) reasons.push("reconnect-identity-binding");
    if (!reconnect.atUtc || eventTimeMs(reconnect.atUtc) < eventTimeMs(uiExitUtc)) reasons.push("reconnect-time-order");
  }
  const terminal = report.originalStepTerminal;
  if (!terminal || typeof terminal !== "object" || !terminal.attempt || terminal.attempt.state === undefined) {
    reasons.push("originalStepTerminal");
  } else {
    if (!isEff01TerminalState(terminal.attempt.state)) reasons.push("original-terminal-state");
    if (String(terminal.attempt.id) !== String(report.attemptId)) reasons.push("original-terminal-attempt");
    if (!terminal.atUtc || eventTimeMs(terminal.atUtc) < eventTimeMs(reconnect?.atUtc)) reasons.push("original-terminal-time-order");
  }
  const replayJudgment = judgePromptReplay(persistedEvents, report.attemptId);
  if (replayJudgment.promptReplay !== false || replayJudgment.promptReplayObserved !== true) {
    reasons.push("sqlite-promptReplay");
  }
  const reconnectEvent = persistedEvents.find((row) => row.kind === "ui.reconnected"
    && String(row.attemptId) === String(report.attemptId)
    && eventTimeMs(row.atUtc) >= eventTimeMs(uiExitUtc));
  if (!reconnectEvent || eventTimeMs(reconnectEvent.atUtc) > eventTimeMs(reconnect?.atUtc)) {
    reasons.push("sqlite-reconnect-order");
  }
  const originalTerminalEvent = persistedEvents.find((row) => row.kind === "runtime.turn.completed"
    && eventTimeMs(row.atUtc) >= eventTimeMs(reconnectEvent?.atUtc)
    && eventTimeMs(row.atUtc) <= eventTimeMs(terminal?.atUtc));
  if (!originalTerminalEvent) reasons.push("sqlite-original-terminal-event");
  const originalUsers = persistedEvents.filter((row) => row.kind === "message.user"
    && userTextHash(row, report.originalPromptSha256) === report.originalPromptSha256);
  if (originalUsers.length !== 1) reasons.push(`sqlite-original-prompt-count:${originalUsers.length}`);
  const runtimeSessions = persistedEvents.filter((row) => row.kind === "runtime.session.created");
  if (runtimeSessions.length !== 1) reasons.push(`sqlite-runtime-session-count:${runtimeSessions.length}`);
  const followUp = report.followUp;
  if (!followUp || typeof followUp !== "object") reasons.push("followUp");
  else {
    if (followUp.status !== "PASS") reasons.push(`followUp.status=${followUp.status || "missing"}`);
    if (followUp.followUpUser !== true) reasons.push("followUp.followUpUser");
    if (followUp.sameAttemptTurn !== true) reasons.push("followUp.sameAttemptTurn");
    if (!followUp.nonce) reasons.push("followUp.nonce");
    if (!followUp.guiSendAtUtc) reasons.push("followUp.guiSendAtUtc");
    if (!followUp.userAtUtc) reasons.push("followUp.userAtUtc");
    if (!followUp.turnStartedAtUtc) reasons.push("followUp.turnStartedAtUtc");
    if (followUp.guiSendAtUtc && followUp.userAtUtc && String(followUp.userAtUtc) < String(followUp.guiSendAtUtc)) {
      reasons.push("followUp.user-before-send");
    }
    if (followUp.userAtUtc && followUp.turnStartedAtUtc && String(followUp.turnStartedAtUtc) < String(followUp.userAtUtc)) {
      reasons.push("followUp.turn-before-user");
    }
    if (!followUp.replyAtUtc) reasons.push("followUp.replyAtUtc");
    if (followUp.turnStartedAtUtc && followUp.replyAtUtc && eventTimeMs(followUp.replyAtUtc) < eventTimeMs(followUp.turnStartedAtUtc)) {
      reasons.push("followUp.reply-before-turn");
    }
    if (terminal?.atUtc && followUp.guiSendAtUtc && eventTimeMs(followUp.guiSendAtUtc) < eventTimeMs(terminal.atUtc)) {
      reasons.push("followUp.send-before-terminal");
    }
    if (report.attemptId && followUp.originalTurnHash && followUp.originalTurnHash === sha256Text(report.attemptId)) {
      reasons.push("originalTurnHash-is-attempt-id");
    }
    const persistedFollowUp = judgeFollowUp({
      events: persistedEvents,
      attemptId: report.attemptId,
      followUpTextSha: followUp.textSha256,
      beforeTurnIds: [] ,
      notBeforeUtc: followUp.guiSendAtUtc
    });
    if (persistedFollowUp.status !== "PASS") reasons.push(`sqlite-followUp:${persistedFollowUp.reason}`);
    else if (String(persistedFollowUp.followUpUserId) !== String(followUp.followUpUserId)
      || String(persistedFollowUp.nativeTurnId) !== String(followUp.nativeTurnId)
      || String(persistedFollowUp.replyId) !== String(followUp.replyId)) {
      reasons.push("sqlite-followUp-event-binding");
    }
    if (persistedFollowUp.status === "PASS") {
      const userRow = persistedEvents.find((row) => row.id === persistedFollowUp.followUpUserId);
      const turnRow = persistedEvents.find((row) => row.id === persistedFollowUp.nativeTurnId);
      const replyRow = persistedEvents.find((row) => row.id === persistedFollowUp.replyId);
      if (!eventMatchesRuntimeBinding(userRow, runtimeBindings?.[0])
        || !eventMatchesRuntimeBinding(turnRow, runtimeBindings?.[0])
        || !eventMatchesRuntimeBinding(replyRow, runtimeBindings?.[0])
        || String(followUp.processEpoch || "") !== String(report.runtimeProcessEpoch || "")) {
        reasons.push("sqlite-followUp-runtime-epoch");
      }
    }
    const sendStep = steps.find((step) => step?.message === "follow-up-send"
      && String(step.nonce) === String(followUp.nonce)
      && eventTimeMs(step.guiSendAtUtc) === eventTimeMs(followUp.guiSendAtUtc));
    if (!sendStep) reasons.push("gui-followUp-send-step");
  }
  const causalTimes = [
    ["runStartedAtUtc", parseUtcInstant(report.runStartedAtUtc)],
    ["coreCreatedAt", parseCimDateMs(report.coreBefore?.creationDate)],
    ["launchReadyAt", parseUtcInstant(report.launchReadyReceipt?.timestamps?.readyAtUtc)],
    ["taskSubmittedAtUtc", parseUtcInstant(report.taskSubmittedAtUtc)],
    ["uiExitedAt", parseUtcInstant(report.uiExitUtc)],
    ["absentRuntimeEventAt", parseUtcInstant(persistedAbsenceEvent?.atUtc)],
    ["uiReopenedAt", parseUtcInstant(reconnect?.atUtc)],
    ["originalTerminalAt", parseUtcInstant(terminal?.atUtc)],
    ["followUpGuiSendAt", parseUtcInstant(followUp?.guiSendAtUtc)],
    ["followUpUserEventAt", parseUtcInstant(followUp?.userAtUtc)],
    ["followUpTurnStartedAt", parseUtcInstant(followUp?.turnStartedAtUtc)],
    ["followUpReplyAt", parseUtcInstant(followUp?.replyAtUtc)],
    ["runFinishedAtUtc", parseUtcInstant(report.runFinishedAtUtc)]
  ];
  if (causalTimes.some(([, value]) => !Number.isFinite(value))) {
    for (const [label, value] of causalTimes) {
      if (!Number.isFinite(value)) reasons.push(`invalid-causal-time:${label}`);
    }
  } else {
    for (let index = 1; index < causalTimes.length; index += 1) {
      if (causalTimes[index][1] < causalTimes[index - 1][1]) {
        reasons.push(`causal-order:${causalTimes[index - 1][0]}->${causalTimes[index][0]}`);
      }
    }
  }
  if (String(report.driverOutcome?.finishedAtUtc || "") !== String(report.runFinishedAtUtc || "")) {
    reasons.push("driver-finish-boundary");
  }
  const runStartMs = parseUtcInstant(report.runStartedAtUtc);
  const runFinishMs = parseUtcInstant(report.runFinishedAtUtc);
  const runtimeCreatedMs = parseCimDateMs(runtimeBindings?.[0]?.runtimeCreationDate);
  if (!Number.isFinite(runtimeCreatedMs)
    || !Number.isFinite(runStartMs)
    || !Number.isFinite(runFinishMs)
    || runtimeCreatedMs < runStartMs
    || runtimeCreatedMs > runFinishMs) {
    reasons.push("runtime-creation-time-out-of-run");
  }
  for (const row of persistedEvents) {
    const at = parseUtcInstant(row.atUtc);
    if (!Number.isFinite(at)
      || !Number.isFinite(runStartMs)
      || !Number.isFinite(runFinishMs)
      || at < runStartMs
      || at > runFinishMs) {
      reasons.push(`event-time-out-of-run:${row?.id || "missing"}`);
    }
  }
  for (const [index, step] of steps.entries()) {
    const at = parseUtcInstant(step?.atUtc);
    if (!Number.isFinite(at)
      || !Number.isFinite(runStartMs)
      || !Number.isFinite(runFinishMs)
      || at < runStartMs
      || at > runFinishMs) {
      reasons.push(`step-time-out-of-run:${index}`);
    }
  }
  const expectedClose = mode === "kill" ? "kill" : mode === "graceful" ? "graceful" : report.closeOrKill;
  if (expectedClose && report.closeOrKill !== expectedClose) reasons.push("closeOrKill");
  if (report.closeOrKill === "kill") {
    if (!Array.isArray(report.killedPids) || report.killedPids.length === 0) reasons.push("killedPids");
    if (report.taskkillUsedT === true) reasons.push("taskkill /T");
    for (const row of report.killedPids || []) {
      if (!launched.has(Number(row.pid))) reasons.push(`killed-unlaunched:${row.pid}`);
      const args = row.args || [];
      if (args.includes("/T") || args.some((part) => String(part).toUpperCase() === "/T")) reasons.push("taskkill /T");
      if (args.length !== 3 || args[0] !== "/F" || args[1] !== "/PID") reasons.push(`kill-args:${row.pid}`);
    }
  }
  if (report.closeOrKill === "graceful") {
    for (const pid of report.closeMainWindowPids || []) {
      if (!launched.has(Number(pid))) reasons.push(`close-unlaunched:${pid}`);
    }
  }
  if (reasons.length > 0) return { status: "UNMET", reasons };
  return { status: "PASS", reasons: [] };
}

export function descendantIds(processes, rootPids) {
  const tree = new Set((rootPids || []).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of processes) {
      const pid = Number(row.ProcessId);
      const parent = Number(row.ParentProcessId);
      if (tree.has(parent) && !tree.has(pid)) {
        tree.add(pid);
        changed = true;
      }
    }
  }
  return tree;
}

export function selectKillTargets({ launchedPids, processes, exePath }) {
  const want = normPath(exePath);
  const tree = descendantIds(processes, launchedPids);
  return (processes || []).filter((row) => {
    if (String(row.Name || "").toLowerCase() !== "goalport.exe") return false;
    if (normPath(row.ExecutablePath) !== want) return false;
    return tree.has(Number(row.ProcessId));
  });
}

export function validateKillTargets(processes, exePath, { launchedPids, allProcesses } = {}) {
  const want = normPath(exePath);
  const errors = [];
  const tree = launchedPids ? descendantIds(allProcesses || processes, launchedPids) : null;
  for (const row of processes) {
    if (String(row.Name || "").toLowerCase() !== "goalport.exe") errors.push(`name:${row.ProcessId}`);
    if (normPath(row.ExecutablePath) !== want) errors.push(`path:${row.ProcessId}`);
    const cmd = String(row.CommandLine || "").toLowerCase();
    const exe = normPath(row.ExecutablePath);
    if (exe.includes("goalport-core.exe") || cmd.includes("goalport-core.exe")) errors.push(`core:${row.ProcessId}`);
    if (String(row.Name || "").toLowerCase() === "codex.exe" || cmd.includes("codex")) errors.push(`codex:${row.ProcessId}`);
    if (tree && !tree.has(Number(row.ProcessId))) errors.push(`unlaunched:${row.ProcessId}`);
  }
  return errors;
}

export function taskkillArgsForPid(pid) {
  return ["/F", "/PID", String(pid)];
}

function normPath(value) {
  return String(value || "").replaceAll("/", "\\").toLowerCase();
}

function parseCimJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function cimProcesses() {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress -Depth 2";
  const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });
  return parseCimJson(text);
}

function cimNamedProcesses(names) {
  const filter = (names || [])
    .map((name) => `Name = '${String(name).replace(/'/g, "''")}'`)
    .join(" OR ");
  if (!filter) return [];
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress -Depth 2`;
  const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000
  });
  return parseCimJson(text);
}

function goalPortAt(processes, exePath) {
  const want = normPath(exePath);
  return processes.filter((row) => String(row.Name || "").toLowerCase() === "goalport.exe" && normPath(row.ExecutablePath) === want);
}

function coreOnPipeOrDb(processes, pipeBare, dbPath) {
  const pipeNeedle = String(pipeBare || "").toLowerCase();
  const dbNeedle = normPath(dbPath);
  return processes.filter((row) => {
    const name = String(row.Name || "").toLowerCase();
    const exe = normPath(row.ExecutablePath);
    const cmd = String(row.CommandLine || "").toLowerCase();
    if (name !== "goalport-core.exe" && !exe.endsWith("goalport-core.exe")) return false;
    return cmd.includes(pipeNeedle) || normPath(cmd).includes(dbNeedle);
  });
}

function pipeAlive(pipeBare) {
  const script = `
$n = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${String(pipeBare).replace(/'/g, "''")}', [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::None);
try { $n.Connect(400); 'yes' } catch { 'no' } finally { $n.Dispose() }
`;
  const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000
  });
  return text.trim() === "yes";
}

function killPid(pid) {
  const args = taskkillArgsForPid(pid);
  if (args.includes("/T") || args.some((part) => String(part).toUpperCase() === "/T")) {
    throw new Error("taskkill /T is forbidden");
  }
  const result = spawnSync("taskkill.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return { pid, status: result.status, stdout: result.stdout, stderr: result.stderr, args };
}

function stopThisRunCore(pipeBare, dbPath) {
  const killed = [];
  for (const row of coreOnPipeOrDb(cimProcesses(), pipeBare, dbPath)) {
    killed.push(killPid(row.ProcessId));
  }
  return killed;
}

function stopThisRunGoalPort(exePath, launchedPids) {
  const killed = [];
  const targets = launchedPids && launchedPids.length
    ? selectKillTargets({ launchedPids, processes: cimProcesses(), exePath })
    : [];
  for (const row of targets) {
    killed.push(killPid(row.ProcessId));
  }
  return killed;
}

function processIdentity(row) {
  if (!row) return null;
  return {
    pid: Number(row.ProcessId ?? row.pid),
    parentPid: Number(row.ParentProcessId ?? row.parentPid),
    name: String(row.Name || row.name || ""),
    executablePath: String(row.ExecutablePath || row.executablePath || ""),
    commandLine: String(row.CommandLine || row.commandLine || ""),
    creationDate: String(row.CreationDate || row.creationDate || "")
  };
}

function identityStillLive(recorded) {
  if (!recorded?.pid || !recorded?.creationDate) return false;
  return cimProcesses().some((row) => {
    const identity = processIdentity(row);
    return sameProcessIdentity(identity, recorded);
  });
}

function closeMainWindows(exePath, allowedPids) {
  const allowed = (allowedPids || []).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid) && pid > 0);
  if (allowed.length === 0) return [];
  const want = String(exePath).replace(/'/g, "''");
  const idList = allowed.join(",");
  const script = `
$want = '${want}'
$allowed = @(${idList})
$sent = @()
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'GoalPort.exe' -and $_.ExecutablePath } | ForEach-Object {
  if ($allowed -notcontains $_.ProcessId) { return }
  $exe = ([string]$_.ExecutablePath).Replace('/','\\').ToLower()
  $target = $want.Replace('/','\\').ToLower()
  if ($exe -eq $target) {
    $gp = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) {
      [void]$gp.CloseMainWindow()
      $sent += $_.ProcessId
    }
  }
}
if ($sent.Count -eq 0) { 'none' } else { ($sent -join ',') }
`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000
  }).trim();
}

function openEventsDb(dbPath) {
  return new DatabaseSync(dbPath, { timeout: 8000, readOnly: true });
}

export function eventTimeMs(value) {
  return parseUtcInstant(value);
}

export function userTextHash(row, fallbackSha) {
  if (row?.payload_ref && fallbackSha && row.payload_ref === fallbackSha) return row.payload_ref;
  if (row?.payload_json) {
    try {
      const payload = JSON.parse(row.payload_json);
      if (payload?.text) return sha256Text(payload.text);
    } catch {}
  }
  return row?.payload_ref || null;
}

export function eventRuntimeBinding(row) {
  try {
    const payload = JSON.parse(row?.payload_json || "{}");
    const binding = payload?.goalportRuntime;
    return binding && typeof binding === "object" && !Array.isArray(binding) ? binding : null;
  } catch {
    return null;
  }
}

export function eventMatchesRuntimeBinding(row, binding) {
  const eventBinding = eventRuntimeBinding(row);
  if (!eventBinding || !binding) return false;
  return String(eventBinding.processEpoch || "") === String(binding.processEpoch || "")
    && String(eventBinding.campaignId || "") === String(binding.campaignId || "")
    && String(eventBinding.taskId || "") === String(binding.taskId || "")
    && String(eventBinding.attemptId || "") === String(binding.attemptId || "")
    && String(eventBinding.provider || "").toLowerCase() === String(binding.provider || "").toLowerCase()
    && String(eventBinding.providerSessionHash || "") === String(binding.sessionHash || "")
    && Number(eventBinding.runtimePid) === Number(binding.runtimePid)
    && String(eventBinding.runtimeCreationDate || "") === String(binding.runtimeCreationDate || "")
    && normPath(eventBinding.runtimeExecutablePath) === normPath(binding.runtimeExecutablePath)
    && String(eventBinding.runtimeExecutableSha256 || "").toLowerCase() === String(binding.runtimeExecutableSha256 || "").toLowerCase()
    && String(eventBinding.coreEpochId || "") === String(binding.coreEpochId || "")
    && Number.isFinite(parseUtcInstant(eventBinding.occurredAtEpochMs))
    && Number.isFinite(parseUtcInstant(eventBinding.receivedAtEpochMs));
}

export function queryProductReceipts(dbPath, kind) {
  if (!existsSync(dbPath)) return [];
  const db = openEventsDb(dbPath);
  try {
    const rows = db.prepare("SELECT payload_json FROM product_receipts WHERE kind = ? ORDER BY created_at").all(kind);
    return rows.map((row) => {
      try { return JSON.parse(row.payload_json); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function queryProductReceipt(dbPath, { kind, launchNonce, receiptId } = {}) {
  if (!existsSync(dbPath)) return null;
  const db = openEventsDb(dbPath);
  try {
    let row = null;
    if (receiptId) {
      row = db.prepare("SELECT payload_json FROM product_receipts WHERE receipt_id = ? LIMIT 1").get(receiptId);
    } else if (kind && launchNonce) {
      row = db.prepare("SELECT payload_json FROM product_receipts WHERE kind = ? AND launch_nonce = ? ORDER BY created_at DESC LIMIT 1").get(kind, launchNonce);
    } else if (kind) {
      row = db.prepare("SELECT payload_json FROM product_receipts WHERE kind = ? ORDER BY created_at DESC LIMIT 1").get(kind);
    }
    return row?.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function queryEvents(dbPath, attemptId) {
  if (!existsSync(dbPath)) return [];
  const db = openEventsDb(dbPath);
  try {
    const sql = "SELECT id, kind, created_at AS atUtc, payload_ref, payload_json, attempt_id FROM events WHERE (? IS NULL OR attempt_id = ?) ORDER BY created_at, seq";
    const rows = db.prepare(sql).all(attemptId ?? null, attemptId ?? null);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      atUtc: row.atUtc,
      atMs: eventTimeMs(row.atUtc),
      payload_ref: row.payload_ref,
      payload_json: row.payload_json,
      attempt_id: row.attempt_id,
      attemptId: row.attempt_id
    }));
  } finally {
    db.close();
  }
}

export function judgePromptReplay(events, attemptId) {
  const reconnect = (events || []).filter((row) => row.kind === "ui.reconnected" && (!attemptId || row.attempt_id === attemptId || row.attemptId === attemptId));
  if (reconnect.length === 0) return { promptReplay: null, promptReplayObserved: false };
  let replay = false;
  let observed = true;
  for (const row of reconnect) {
    try {
      const payload = JSON.parse(row.payload_json || "{}");
      if (typeof payload.promptReplay !== "boolean") observed = false;
      else if (payload.promptReplay === true) replay = true;
    } catch { observed = false; }
  }
  return { promptReplay: observed ? replay : null, promptReplayObserved: observed };
}

export function judgeFollowUp({ events, attemptId, followUpTextSha, beforeTurnIds, notBeforeUtc }) {
  const mine = (events || []).filter((row) => !attemptId || row.attempt_id === attemptId || row.attemptId === attemptId);
  const notBeforeMs = eventTimeMs(notBeforeUtc);
  if (notBeforeUtc && !Number.isFinite(notBeforeMs)) {
    return { status: "UNMET", reason: "invalid-gui-send-time", followUpUser: false, sameAttemptTurn: false };
  }
  const newUser = mine.find((row) => row.kind === "message.user"
    && userTextHash(row, followUpTextSha) === followUpTextSha
    && Number.isFinite(eventTimeMs(row.atUtc))
    && (!notBeforeUtc || eventTimeMs(row.atUtc) >= notBeforeMs));
  if (!newUser) return { status: "UNMET", reason: "no-follow-up-user", followUpUser: false, sameAttemptTurn: false };
  const userMs = eventTimeMs(newUser.atUtc);
  const turn = mine.find((row) => (
    row.kind === "runtime.turn.started"
    && !(beforeTurnIds || []).includes(row.id)
    && Number.isFinite(eventTimeMs(row.atUtc))
    && eventTimeMs(row.atUtc) >= userMs
  ));
  if (!turn) return { status: "UNMET", reason: "no-same-attempt-turn-after-follow-up", followUpUser: true, sameAttemptTurn: false };
  const turnMs = eventTimeMs(turn.atUtc);
  const reply = mine.find((row) => row.kind === "runtime.reply.delta"
    && Number.isFinite(eventTimeMs(row.atUtc))
    && eventTimeMs(row.atUtc) >= turnMs);
  if (!reply) return { status: "UNMET", reason: "no-same-attempt-reply-after-follow-up-turn", followUpUser: true, sameAttemptTurn: true };
  const userAtUtc = newUser.atMs ? new Date(newUser.atMs).toISOString() : String(newUser.atUtc || "");
  const turnStartedAtUtc = turn.atMs ? new Date(turn.atMs).toISOString() : String(turn.atUtc || "");
  const replyAtUtc = reply.atMs ? new Date(reply.atMs).toISOString() : String(reply.atUtc || "");
  return {
    status: "PASS",
    reason: "follow-up-user-and-same-attempt-turn",
    followUpUser: true,
    sameAttemptTurn: true,
    nativeTurnId: turn.id,
    followUpUserId: newUser.id,
    replyId: reply.id,
    userAtUtc,
    turnStartedAtUtc,
    replyAtUtc
  };
}

function countAttemptsForTask(dbPath, taskId) {
  if (!existsSync(dbPath) || !taskId) return 0;
  const db = openEventsDb(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?").get(taskId);
    return Number(row?.n || 0);
  } finally {
    db.close();
  }
}

export function queryRuntimeBindings(dbPath, attemptId) {
  if (!existsSync(dbPath) || !attemptId) return [];
  const db = openEventsDb(dbPath);
  try {
    return db.prepare(
      "SELECT attempt_id AS attemptId, campaign_id AS campaignId, task_id AS taskId, provider, session_hash AS sessionHash, process_epoch AS processEpoch, runtime_pid AS runtimePid, runtime_creation_date AS runtimeCreationDate, runtime_executable_path AS runtimeExecutablePath, runtime_executable_sha256 AS runtimeExecutableSha256, core_epoch_id AS coreEpochId, created_at AS createdAt FROM runtime_epoch_bindings WHERE attempt_id=? ORDER BY created_at, process_epoch"
    ).all(attemptId);
  } finally {
    db.close();
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function packagePaths(exe) {
  const root = dirname(exe);
  return {
    exe,
    core: resolve(root, "resources/goalport-core.exe"),
    launcher: resolve(root, "resources/goalport-core-launcher.exe"),
    asar: resolve(root, "resources/app.asar")
  };
}

async function clickNamedButton(evaluate, name) {
  return evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(name)}||x.innerText.trim()===${JSON.stringify(name)});if(!button||button.disabled)return false;button.click();return true;})()`);
}

async function clickNamedButtonMouse(session, name) {
  const box = await session.evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(name)}||x.innerText.trim()===${JSON.stringify(name)});if(!button||button.disabled)return null;const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,label:button.innerText.trim()};})()`);
  if (!box) return false;
  await session.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await session.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await session.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return box;
}

async function fillComposer(evaluate, text) {
  return evaluate(`(()=>{const input=document.querySelector('textarea[aria-label="Message composer"]')||document.querySelector('textarea[placeholder*="active Runtime"]');if(!input)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));return input.value===${JSON.stringify(text)};})()`);
}

async function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs))
  ]);
}

async function snapshotOf(evaluate, timeoutMs = 8_000) {
  const expression = `window.goalportCore.snapshot().then(s=>({connection:s.connection,activeCampaignId:s.activeCampaignId,activeTask:{id:s.activeTask&&s.activeTask.id},attempt:{id:s.attempt&&s.attempt.id,state:s.attempt&&s.attempt.state,provider:s.attempt&&s.attempt.provider,sessionHash:s.attempt&&s.attempt.sessionHash,eventCount:s.attempt&&s.attempt.eventCount},pending:(s.decisions||[]).filter(d=>d.state==='pending').length}))`;
  return withTimeout(evaluate(expression, true), timeoutMs, "snapshot");
}

async function waitDom(evaluate, expression, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await withTimeout(evaluate(expression, false), 3_000, "dom")) return true;
    } catch {
      // renderer/CDP may be busy
    }
    await sleep(200);
  }
  return false;
}

const DIALOG_CONTINUE_EXPR = `(()=>{const dialog=document.querySelector('[role="dialog"][aria-label="Continue running in the background?"]');if(!dialog)return null;const button=[...dialog.querySelectorAll('button')].find(x=>x.innerText.trim()==='Continue in background'||x.getAttribute('aria-label')==='Continue in background');if(!button)return {presented:true,button:false};const r=button.getBoundingClientRect();return {presented:true,button:true,x:r.x+r.width/2,y:r.y+r.height/2,label:button.innerText.trim()};})()`;

async function waitDialogContinue(evaluate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await withTimeout(evaluate(DIALOG_CONTINUE_EXPR, false), 1_500, "dialog-info");
      if (info?.presented) return info;
    } catch {
      // renderer/CDP may be busy while the dialog mounts
    }
    await sleep(200);
  }
  return null;
}

function fireAndForget(session, method, params) {
  try {
    const pending = session.cdp(method, params);
    if (pending && typeof pending.then === "function") pending.then(() => {}).catch(() => {});
  } catch {
    // renderer may already be tearing down
  }
}

function launchExe({ exe, port, env }) {
  const child = spawn(exe, [], {
    cwd: FIX,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env
  });
  return child;
}

export function spawnFreezeCore() {
  throw new Error("spawnFreezeCore is forbidden on the collect-b proving path");
}

function nativeAliveRecorded(recorded) {
  return identityStillLive(recorded);
}

export function readWatcherSights(outPath) {
  if (!outPath || !existsSync(outPath)) return [];
  const rows = [];
  for (const line of readFileSync(outPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row?.kind && row.kind !== "ready") rows.push(row);
    } catch {
      // skip malformed watcher lines
    }
  }
  return rows;
}

export function pickLiveChain(rows, { launchedRootPid, exePath, freezeLauncherPath, freezeCorePath } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const launchers = list.filter((row) => row.kind === "launcher" && row.firstSightLive === true && row.inferred !== true);
  const cores = list.filter((row) => row.kind === "core");
  const goalPorts = list.filter((row) => row.kind === "goalPort");
  for (const launcher of launchers) {
    const goalPort = goalPorts.find((row) => Number(row.pid) === Number(launcher.parentPid))
      || goalPorts.find((row) => launchedRootPid && Number(row.pid) === Number(launchedRootPid))
      || goalPorts.find((row) => exePath && row.executablePath && normPath(row.executablePath) === normPath(exePath));
    const core = cores.find((row) => Number(row.parentPid) === Number(launcher.pid));
    const judged = hostChainFromSights({ goalPort, launcher, core }, { exePath, freezeLauncherPath, freezeCorePath });
    if (judged.unattributable !== true) return judged;
  }
  return hostChainFromSights({
    goalPort: goalPorts.find((row) => launchedRootPid && Number(row.pid) === Number(launchedRootPid)) || goalPorts[0] || null,
    launcher: launchers[0] || null,
    core: cores[0] || null
  }, { exePath, freezeLauncherPath, freezeCorePath });
}

function startLiveChainWatcher({ outPath, freezeLauncherPath, freezeCorePath, exePath, timeoutMs = 25_000 }) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, "", "utf8");
  const q = (value) => String(value || "").replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$out = '${q(outPath)}'
$exeWant = '${q(normPath(exePath))}'
$launcherWant = '${q(normPath(freezeLauncherPath))}'
$coreWant = '${q(normPath(freezeCorePath))}'
try {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class GpProcInfo {
  [StructLayout(LayoutKind.Sequential)]
  public struct PBI {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int s, out int r);
  const int QUERY = 0x1000;
  public static int Parent(int pid) {
    var h = OpenProcess(QUERY, false, pid);
    if (h == IntPtr.Zero) return 0;
    try {
      var pbi = new PBI();
      int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return 0;
      return unchecked((int)pbi.InheritedFromUniqueProcessId.ToInt64());
    } finally { CloseHandle(h); }
  }
  public static string Path(int pid) {
    var h = OpenProcess(QUERY, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      var sb = new StringBuilder(1024);
      int size = sb.Capacity;
      if (!QueryFullProcessImageName(h, 0, sb, ref size)) return "";
      return sb.ToString();
    } finally { CloseHandle(h); }
  }
}
"@
} catch {}
function To-DateStamp($dt) {
  $ms = [DateTimeOffset]::new($dt).ToUnixTimeMilliseconds()
  return "/Date($ms)/"
}
function Emit-Kind($kind, $proc, $cim) {
  $procId = [int]$proc.Id
  $parent = 0
  $path = ""
  $created = To-DateStamp $proc.StartTime
  for ($i = 0; $i -lt 80; $i++) {
    try { $parent = [GpProcInfo]::Parent($procId) } catch {}
    try { if (-not $path) { $path = [string][GpProcInfo]::Path($procId) } } catch {}
    $alive = $null
    try { $alive = Get-Process -Id $procId -ErrorAction SilentlyContinue } catch {}
    if ($alive) {
      if (-not $path) { $path = [string]$alive.Path }
      try { $created = To-DateStamp $alive.StartTime } catch {}
    }
    if ($parent -gt 0 -and $path) { break }
  }
  $cmd = ""
  if ($cim) {
    if (-not $path) { $path = [string]$cim.ExecutablePath }
    $cmd = [string]$cim.CommandLine
    if ($cim.CreationDate) { $created = "/Date($([DateTimeOffset]::new($cim.CreationDate).ToUnixTimeMilliseconds()))/" }
    if ($cim.ParentProcessId) { $parent = [int]$cim.ParentProcessId }
  }
  if ($kind -eq "launcher" -and ($parent -le 0 -or -not $path)) { return }
  $obj = [ordered]@{
    kind = $kind
    pid = $procId
    parentPid = $parent
    name = [string]$proc.ProcessName + ".exe"
    executablePath = $path
    commandLine = $cmd
    creationDate = $created
    firstSeenAtUtc = [DateTime]::UtcNow.ToString("o")
    firstSightLive = $true
    inferred = $false
  }
  Add-Content -LiteralPath $out -Value ($obj | ConvertTo-Json -Compress)
}
'{"kind":"ready"}' | Set-Content -LiteralPath $out
$deadline = (Get-Date).AddMilliseconds(${Number(timeoutMs)})
$emitted = @{}
$gotLauncher = $false
$gotCore = $false
$gotGoalPort = $false
$spinDeadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $spinDeadline -and -not $gotLauncher) {
  foreach ($proc in @(Get-Process -Name goalport-core-launcher -ErrorAction SilentlyContinue)) {
    $procId = [int]$proc.Id
    $parent = 0
    $path = ""
    try { $parent = [GpProcInfo]::Parent($procId) } catch {}
    try { $path = [string][GpProcInfo]::Path($procId) } catch {}
    if (-not $path) { $path = [string]$proc.Path }
    if ($parent -le 0 -or -not $path) { continue }
    if ($launcherWant -and $path.Replace('/','\\').ToLower() -ne $launcherWant) { continue }
    Emit-Kind "launcher" $proc $null
    $gotLauncher = $true
    break
  }
}
while ((Get-Date) -lt $deadline) {
  foreach ($pair in @(
    @{ name = "goalport-core"; kind = "core"; want = $coreWant },
    @{ name = "GoalPort"; kind = "goalPort"; want = $exeWant }
  )) {
    foreach ($proc in @(Get-Process -Name $pair.name -ErrorAction SilentlyContinue)) {
      $key = "$($pair.kind)-$($proc.Id)"
      if ($emitted.ContainsKey($key)) { continue }
      $path = ([string]$proc.Path).Replace('/','\\').ToLower()
      if (-not $path) { try { $path = ([string]$proc.MainModule.FileName).Replace('/','\\').ToLower() } catch {} }
      if ($path -and $pair.want -and $path -ne $pair.want) { continue }
      Emit-Kind $pair.kind $proc $null
      $emitted[$key] = $true
      if ($pair.kind -eq "core") { $gotCore = $true }
      if ($pair.kind -eq "goalPort") { $gotGoalPort = $true }
    }
  }
  if ($gotLauncher -and $gotCore -and $gotGoalPort) { break }
  Start-Sleep -Milliseconds 1
}
`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "ignore",
    windowsHide: true
  });
  return { child, outPath };
}

async function waitForHostChain({ launchedRootPids, exePath, freezeCorePath, freezeLauncherPath, watcherPath, timeoutMs = 20_000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = { goalPort: null, launcher: null, core: null, unattributable: true, inferredLauncher: false, reason: "pending" };
  while (Date.now() < deadline) {
    const rows = readWatcherSights(watcherPath);
    last = pickLiveChain(rows, {
      launchedRootPid: launchedRootPids?.[0],
      exePath,
      freezeLauncherPath,
      freezeCorePath
    });
    if (last.unattributable !== true) return last;
    await sleep(5);
  }
  return last;
}

function spawnedCoreSha(pipeBare, dbPath) {
  const rows = coreOnPipeOrDb(cimProcesses(), pipeBare, dbPath);
  const row = rows.find((item) => normPath(item.ExecutablePath).endsWith("goalport-core.exe")) || rows[0];
  if (!row?.ExecutablePath || !existsSync(row.ExecutablePath)) {
    return { path: row?.ExecutablePath || null, sha256: null, pid: row?.ProcessId || null, parent: row?.ParentProcessId || null };
  }
  return {
    path: row.ExecutablePath,
    sha256: sha256File(row.ExecutablePath),
    pid: row.ProcessId || null,
    parent: row.ParentProcessId || null
  };
}

export async function runResumeChain(options) {
  const runStartedAtUtc = new Date().toISOString();
  const mode = options.mode === "kill" ? "kill" : "graceful";
  const exe = resolve(options.exe);
  const reportPath = resolve(options.report);
  const port = Number(options.port);
  const reopenPort = Number(options.reopenPort || port + 1);
  const pipeBare = options.pipe;
  const dbPath = resolve(options.db);
  const prompt = options.prompt || ORIGINAL_PROMPT;
  const followUpNonce = options.followUpNonce || `FOLLOW-UP-OK-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const followUpText = options.followUpText || `Append a single line ${followUpNonce} to DONE.txt. Do not use the network. Stay inside this folder.`;
  const originalPromptSha256 = sha256Text(prompt);
  const steps = [];
  const log = (message, extra = {}) => {
    steps.push({ atUtc: new Date().toISOString(), message, ...extra });
    console.error(`[resume-chain] ${message}`);
  };

  refusePriorMutation(reportPath);
  refusePriorMutation(dbPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });

  const skipSubmit = options.skipSubmit === true;
  if (skipSubmit) {
    throw new Error("skip-submit is forbidden on the collect-b proving path");
  }
  if (pipeAlive(pipeBare)) {
    throw new Error(`pre-existing Core on this-run pipe: ${pipeBare}`);
  }
  const preexistingCore = coreOnPipeOrDb(cimProcesses(), pipeBare, dbPath);
  if (preexistingCore.length > 0) {
    throw new Error(`pre-existing Core on this-run pipe/db pids=${preexistingCore.map((row) => row.ProcessId).join(",")}`);
  }
  const strangers = goalPortAt(cimProcesses(), exe);
  if (strangers.length > 0) {
    throw new Error(`unexpected GoalPort.exe already at freeze path pids=${strangers.map((row) => row.ProcessId).join(",")}`);
  }

  const paths = packagePaths(exe);
  const exeSha256 = sha256File(paths.exe);
  const coreSha256 = existsSync(paths.core) ? sha256File(paths.core) : null;
  const asarSha256 = existsSync(paths.asar) ? sha256File(paths.asar) : null;

  process.env.GOALPORT_REQUIRE_ISOLATED = "1";
  process.env.GOALPORT_CORE_PIPE = pipeBare;
  process.env.GOALPORT_CORE_DB = dbPath;
  process.env.GOALPORT_SYNTHETIC_ROOT = FIX;
  const env = isolatedChildEnv({
    GOALPORT_CDP_PORT: String(port)
  });
  delete env.GOALPORT_LAUNCH_NONCE;
  const watcherPath = resolve(dirname(reportPath), `host-chain-watch-${mode}-${Date.now()}.ndjson`);
  const watcher = startLiveChainWatcher({
    outPath: watcherPath,
    freezeLauncherPath: paths.launcher,
    freezeCorePath: paths.core,
    exePath: exe,
    timeoutMs: 30_000
  });
  const watcherReadyDeadline = Date.now() + 4_000;
  while (Date.now() < watcherReadyDeadline) {
    try {
      if (existsSync(watcherPath) && readFileSync(watcherPath, "utf8").includes('"kind":"ready"')) break;
    } catch {
      // watcher may still be opening the file
    }
    await sleep(50);
  }
  const child = launchExe({ exe, port, env });
  const launchedRootPids = [child.pid].filter(Boolean);
  const launchedGoalPortPids = [];
  const recordLaunchedGoalPort = () => {
    const rows = selectKillTargets({ launchedPids: launchedRootPids, processes: cimProcesses(), exePath: exe });
    for (const row of rows) {
      const pid = Number(row.ProcessId);
      if (!launchedGoalPortPids.includes(pid)) launchedGoalPortPids.push(pid);
    }
    return rows;
  };
  log("launch", { pid: child.pid, port, pipe: pipeBare, watcherPath });
  recordLaunchedGoalPort();
  let hostChain = await waitForHostChain({
    launchedRootPids,
    exePath: exe,
    pipeBare,
    dbPath,
    freezeCorePath: paths.core,
    freezeLauncherPath: paths.launcher,
    watcherPath,
    timeoutMs: 3_000
  });
  log("host-chain-wmi", hostChain);
  let startupReceipt = null;
  let launchReadyReceipt = null;
  let startupReceipts = [];
  let launchNonce = null;
  let spawnedCore = hostChain.core
    ? { path: hostChain.core.executablePath, sha256: coreSha256, pid: hostChain.core.pid, parent: hostChain.core.parentPid, creationDate: hostChain.core.creationDate }
    : spawnedCoreSha(pipeBare, dbPath);
  let coreBefore = hostChain.core;
  let runtimeBefore = null;
  let runtimeAfter = null;
  let coreAfter = null;
  let coreAtReopen = null;
  let corePrespawn = false;
  let coreRespawn = false;
  let closeMainWindowPids = [];

  let session;
  let firstSnap = null;
  let attemptStateAtAction = null;
  let closeSurface = null;
  let allowQuitLatch = false;
  let hostExited = false;
  let uiExitUtc = null;
  let killedPids = [];
  let taskkillUsedT = false;
  let reconnectWhileActive = null;
  let originalStepTerminal = null;
  let followUp = { status: "UNMET", reason: "not-attempted" };
  let reopenAttemptId = null;
  let promptReplay = true;
  let originalPromptUserMessageCount = 0;
  let attemptCountAtSubmit = 0;
  let attemptCountAtUiExit = 0;
  let attemptCountAtReopen = 0;
  let attemptCountAfterFollowUp = 0;
  let attemptIdAtSubmit = null;
  let attemptIdAtUiExit = null;
  let attemptIdAtReopen = null;
  let attemptIdAfterFollowUp = null;
  let spawnFreezeCoreCalled = false;
  let pipePreexisting = false;
  let closeDialogShownAtUtc = null;
  let continueClickIssuedAtUtc = null;
  let continueReceiptAtUtc = null;
  let continueReceiptPayload = null;
  let continueReceiptRaw = null;
  let targetUiPid = null;
  let hostExitedAtUtc = null;
  let coreAlive = false;
  let nativeWasAlive = false;
  let providerSessionHash = null;
  let runtimeProcessEpoch = null;
  let runtimeBinding = null;
  let taskSubmittedAtUtc = null;
  let continueClick = false;
  let dialogGone = false;
  let confirmCloseChoice = null;
  let continueMouse = null;
  let dialogPresented = false;
  let confirmCloseChoiceIssued = false;
  let promptReplayObserved = false;
  let continueReceiptCore = null;
  let continueReceiptId = null;
  let mainReceivedAtUtc = null;
  let coreReceiptPersistedAtUtc = null;
  let runSlug = RUN_SLUG;

  const finish = (error) => {
    try { coreAlive = Boolean(coreAfter && sameProcessIdentity(coreBefore, coreAfter) && identityStillLive(coreAfter)); } catch {}
    try { nativeWasAlive = Boolean(runtimeAfter && sameProcessIdentity(runtimeBefore, runtimeAfter) && identityStillLive(runtimeAfter)); } catch {}
    const report = {
      schemaVersion: 1,
      kind: "resume-chain",
      mode,
      host: "electron-packaged",
      exe,
      exeSha256,
      coreSha256,
      asarSha256,
      spawnedCore,
      campaignId: firstSnap?.activeCampaignId ?? null,
      taskId: firstSnap?.activeTask?.id ?? null,
      attemptId: firstSnap?.attempt?.id ?? null,
      providerSessionHash,
      runtimeProcessEpoch,
      runtimeBinding,
      originalPromptSha256,
      userEntry: "gui-cdp",
      closeOrKill: mode,
      closeSurface,
      allowQuitLatch,
      attemptStateAtAction,
      hostExited,
      uiExitUtc,
      coreAlive,
      nativeAlive: nativeWasAlive,
      absenceEvents: [],
      reopenAttemptId,
      originalPromptUserMessageCount,
      promptReplay,
      reconnectWhileActive,
      originalStepTerminal,
      followUp,
      attemptCountAtSubmit,
      attemptCountAtUiExit,
      attemptCountAtReopen,
      attemptCountAfterFollowUp,
      attemptCountUnchanged: attemptCountAtSubmit === 1 && attemptCountAtSubmit === attemptCountAtUiExit && attemptCountAtUiExit === attemptCountAtReopen && attemptCountAtReopen === attemptCountAfterFollowUp,
      attemptIdAtSubmit,
      attemptIdAtUiExit,
      attemptIdAtReopen,
      attemptIdAfterFollowUp,
      spawnFreezeCoreCalled,
      pipePreexisting,
      closeDialogShownAtUtc,
      continueClickIssuedAtUtc,
      continueReceiptAtUtc,
      continueReceiptPayload,
      continueReceiptRaw,
      targetUiPid,
      hostExitedAtUtc,
      killedPids,
      launchedGoalPortPids,
      closeMainWindowPids,
      corePrespawn,
      coreRespawn,
      coreBefore,
      coreAfter,
      coreAtReopen,
      runtimeBefore,
      runtimeAfter,
      hostChain,
      launchNonce,
      startupReceipt,
      launchReadyReceipt,
      startupReceipts: Array.isArray(startupReceipts) ? startupReceipts : (startupReceipt ? [startupReceipt] : []),
      runSlug,
      pipeBare,
      dbPath,
      continueReceiptCore,
      continueReceiptId,
      mainReceivedAtUtc,
      coreReceiptPersistedAtUtc,
      continueClick,
      dialogGone,
      confirmCloseChoice,
      continueMouse,
      dialogPresented,
      confirmCloseChoiceIssued,
      promptReplayObserved,
      taskkillUsedT,
      steps,
      runStartedAtUtc,
      runFinishedAtUtc: null,
      taskSubmittedAtUtc,
      error: error ? String(error.stack || error.message || error) : null,
      driverOutcome: {
        status: error ? "error" : "completed",
        finishedAtUtc: null,
        errorType: error ? String(error.name || "Error") : null
      }
    };
    try {
      const attemptId = report.attemptId;
      const events = queryEvents(dbPath, attemptId);
      const exitMs = eventTimeMs(uiExitUtc);
      report.absenceEvents = events
        .filter((row) => kindAllowed(row.kind) && exitMs && row.atMs >= exitMs && row.attempt_id === attemptId)
        .map((row) => ({
          atUtc: new Date(row.atMs).toISOString(),
          kind: row.kind,
          id: row.id,
          attemptId: row.attempt_id
        }));
      const userMatches = events.filter((row) => row.kind === "message.user" && userTextHash(row, originalPromptSha256) === originalPromptSha256);
      report.originalPromptUserMessageCount = userMatches.length;
      const replay = judgePromptReplay(events, attemptId);
      report.promptReplay = replay.promptReplay;
      report.promptReplayObserved = replay.promptReplayObserved;
      originalPromptUserMessageCount = report.originalPromptUserMessageCount;
      promptReplay = report.promptReplay;
      promptReplayObserved = replay.promptReplayObserved;
    } catch (queryError) {
      report.sqliteError = String(queryError.message || queryError);
    }
    try {
      report.startupReceipts = queryProductReceipts(dbPath, "startup");
      if (!report.startupReceipt && report.startupReceipts.length) {
        report.startupReceipt = report.startupReceipts[0];
      }
      const readyReceipts = queryProductReceipts(dbPath, "launch-ready");
      report.launchReadyReceipt = readyReceipts.length === 1 ? readyReceipts[0] : null;
      launchReadyReceipt = report.launchReadyReceipt;
      const runtimeBindings = queryRuntimeBindings(dbPath, report.attemptId);
      report.runtimeBinding = runtimeBindings.length === 1 ? runtimeBindings[0] : null;
      report.runtimeProcessEpoch = report.runtimeBinding?.processEpoch || null;
      runtimeBinding = report.runtimeBinding;
      runtimeProcessEpoch = report.runtimeProcessEpoch;
    } catch (queryError) {
      report.sqliteError = `${report.sqliteError || ""} ${queryError.message || queryError}`.trim();
    }
    report.runFinishedAtUtc = new Date().toISOString();
    report.driverOutcome.finishedAtUtc = report.runFinishedAtUtc;
    const judged = evaluateReport(report, { mode, requireFreeze: true });
    report.status = judged.status;
    report.unmetReasons = judged.reasons;
    report.verifierEvidence = judged.evidence;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  };

  try {
    session = await attachGoalPort(port);
    const { evaluate } = session;
    if (!(await waitFor(evaluate, `document.body.innerText.includes('Core connected')`, 40_000))) {
      throw new Error("packaged GUI never displayed Core connected");
    }
    await sleep(400);
    recordLaunchedGoalPort();
    const receiptDeadline = Date.now() + 15_000;
    while (Date.now() < receiptDeadline) {
      startupReceipt = queryProductReceipt(dbPath, { kind: "startup" });
      if (startupReceipt?.launchNonce) break;
      await sleep(50);
    }
    if (!startupReceipt?.launchNonce) {
      throw new Error("product-observability-gap: Core startup receipt was not persisted");
    }
    launchNonce = String(startupReceipt.launchNonce);
    startupReceipts = queryProductReceipts(dbPath, "startup");
    if (startupReceipts.length !== 1) {
      throw new Error(`product-observability-gap: expected one startup receipt, got ${startupReceipts.length}`);
    }
    launchReadyReceipt = queryProductReceipt(dbPath, { kind: "launch-ready", launchNonce });
    if (!launchReadyReceipt || launchReadyReceipt.readyState !== "READY_COMMITTED") {
      throw new Error("product-observability-gap: committed launch-ready receipt was not persisted");
    }
    const receiptCorePid = Number(startupReceipt.core?.pid);
    const receiptLiveCore = coreOnPipeOrDb(cimProcesses(), pipeBare, dbPath).find((row) => Number(row.ProcessId) === receiptCorePid)
      || coreOnPipeOrDb(cimProcesses(), pipeBare, dbPath)[0];
    if (receiptLiveCore) coreBefore = processIdentity(receiptLiveCore);
    hostChain = {
      goalPort: hostChain.goalPort || (startupReceipt.electron ? {
        pid: startupReceipt.electron.pid,
        parentPid: startupReceipt.electron.parentPid,
        creationDate: startupReceipt.electron.creationDate,
        executablePath: startupReceipt.electron.executablePath,
        firstSightLive: Boolean(hostChain.goalPort?.firstSightLive),
        firstSeenAtUtc: hostChain.goalPort?.firstSeenAtUtc || startupReceipt.timestamps?.launchRequestedAtUtc,
        inferred: false
      } : hostChain.goalPort),
      launcher: {
        pid: startupReceipt.launcher?.pid,
        parentPid: startupReceipt.launcher?.observedParentPid ?? startupReceipt.launcher?.parentPid,
        creationDate: startupReceipt.launcher?.creationDate,
        executablePath: startupReceipt.launcher?.executablePath,
        name: "goalport-core-launcher.exe",
        firstSightLive: hostChain.launcher?.firstSightLive === true,
        firstSeenAtUtc: hostChain.launcher?.firstSeenAtUtc || startupReceipt.timestamps?.launcherStartedAtUtc,
        inferred: false,
        productObserved: true
      },
      core: coreBefore,
      unattributable: false,
      inferredLauncher: false,
      reason: "product-startup-receipt"
    };
    spawnedCore = coreBefore
      ? { path: coreBefore.executablePath, sha256: coreSha256, pid: coreBefore.pid, parent: coreBefore.parentPid, creationDate: coreBefore.creationDate }
      : spawnedCore;
    log("startup-receipt", { launchNonce, corePid: coreBefore?.pid, launcherPid: startupReceipt.launcher?.pid });
    log("launch-ready-receipt", { readyReceiptId: launchReadyReceipt.readyReceiptId, readyAtUtc: launchReadyReceipt.timestamps?.readyAtUtc });
    if (!coreBefore?.pid || !coreBefore?.creationDate) {
      throw new Error("startup receipt Core identity was not live on this-run pipe/db");
    }
    if (hostChain.launcher?.inferred === true) {
      throw new Error("inferred launcher is forbidden");
    }
    const opened = await clickNamedButton(evaluate, "New campaign") || await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('New campaign'));if(!button)return false;button.click();return true;})()`);
    if (!opened || !(await waitFor(evaluate, `Boolean(document.querySelector('#project-folder'))`, 8_000))) {
      throw new Error("new campaign dialog unavailable");
    }
    const goal = `Resume-chain ${mode}: bounded writes under this fixture ending in DONE.txt`;
    await evaluate(`(()=>{const set=(selector,value)=>{const input=document.querySelector(selector);if(!input)return false;const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));return true;};return set('#project-folder',${JSON.stringify(FIX)})&&set('#campaign-goal',${JSON.stringify(goal)});})()`);
    const submitted = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('Begin preview'));if(!button||button.disabled)return false;button.click();return true;})()`);
    if (!submitted || !(await waitFor(evaluate, `!document.querySelector('#campaign-goal') && document.body.innerText.includes(${JSON.stringify(goal)})`, 25_000))) {
      throw new Error("campaign/task creation did not reach the GUI");
    }
    log("create-campaign", { goal });
    const selectedCodex = await evaluate(`(()=>{const summary=[...document.querySelectorAll('summary')].find(x=>x.innerText.includes('Codex'));if(!summary)return false;summary.closest('details').open=true;const button=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Select Codex');if(!button||button.disabled)return false;button.click();return true;})()`);
    if (!selectedCodex || !(await waitFor(evaluate, `window.goalportCore.snapshot().then(x=>String(x.attempt?.provider||'').toLowerCase()==='codex')`, 45_000))) {
      throw new Error("Codex Runtime was not selected through the GUI");
    }
    log("select-codex");
    if (!(await fillComposer(evaluate, prompt))) throw new Error("composer input failed");
    if (!(await clickNamedButton(evaluate, "Send message"))) throw new Error("GUI Send button did not dispatch");
    taskSubmittedAtUtc = new Date().toISOString();
    log("send-native-prompt", { userEntry: "gui-cdp", originalPromptSha256, taskSubmittedAtUtc });

    const activityDeadline = Date.now() + 90_000;
    while (Date.now() < activityDeadline) {
      try { await clickNamedButton(evaluate, "Allow once"); } catch {}
      try {
        firstSnap = await snapshotOf(evaluate, 6_000);
        providerSessionHash = firstSnap?.attempt?.sessionHash ?? providerSessionHash;
        const kinds = (firstSnap?.timeline || []).map((item) => item.kind);
        const active = isActiveState(firstSnap?.attempt?.state);
        const activity = Number(firstSnap?.attempt?.eventCount || 0) > 0 || kinds.some((kind) => kind === "tool" || kind === "message" || kind === "permission");
        log("activity-poll", { state: firstSnap?.attempt?.state, eventCount: firstSnap?.attempt?.eventCount, active, activity });
        if (active && activity) break;
      } catch (error) {
        log("activity-poll-error", { error: String(error.message || error) });
      }
      await sleep(400);
    }
    if (!firstSnap) firstSnap = await snapshotOf(evaluate, 10_000);
    attemptStateAtAction = firstSnap?.attempt?.state || null;
    attemptIdAtSubmit = firstSnap?.attempt?.id || null;
    attemptCountAtSubmit = countAttemptsForTask(dbPath, firstSnap?.activeTask?.id);
    if (!isActiveState(attemptStateAtAction)) {
      throw new Error(`attempt was not Active at close/kill: ${attemptStateAtAction}`);
    }
    const pinned = pinUniqueCodexChild(cimProcesses(), coreBefore?.pid);
    if (pinned.count !== 1) {
      throw new Error(`runtime pin expected unique codex.exe child of core ${coreBefore?.pid}, got ${pinned.count}`);
    }
    runtimeBefore = processIdentity(pinned.row);
    log("runtime-pin", { ...runtimeBefore, attemptId: firstSnap.attempt?.id, count: pinned.count });
    log("pre-action-snapshot", {
      campaignId: firstSnap.activeCampaignId,
      taskId: firstSnap.activeTask?.id,
      attemptId: firstSnap.attempt?.id,
      attemptStateAtAction
    });

    if (mode === "graceful") {
      const fresh = session.evaluate;
      targetUiPid = Number(hostChain?.goalPort?.pid || launchedRootPids[0] || 0);
      const wrapExpr = `(()=>{const api=window.goalportCore;if(!api||typeof api.confirmCloseChoice!=='function')return 'missing-api';if(api.__goalportReceiptWrapped===true)return 'already-wrapped';const orig=api.confirmCloseChoice.bind(api);api.confirmCloseChoice=function(choice){const pending=Promise.resolve(orig(choice));pending.then((result)=>{window.__goalportContinueReceipt={atUtc:new Date().toISOString(),choice:String(choice||''),payload:result};}).catch(()=>{});return pending;};api.__goalportReceiptWrapped=true;return 'wrapped';})()`;
      const wrapResult = await withTimeout(fresh(wrapExpr, false), 3_000, "wrap-confirm-close");
      log("wrap-confirm-close", { wrapResult });
      if (wrapResult !== "wrapped" && wrapResult !== "already-wrapped") {
        throw new Error(`product-observability-gap: confirmCloseChoice cannot be observed (${wrapResult})`);
      }
      let clickedClose = false;
      try {
        clickedClose = await withTimeout(clickNamedButton(fresh, "Close window"), 4_000, "close-window");
      } catch (error) {
        log("close-window-error", { error: String(error.message || error) });
      }
      log("click-close-window", { clickedClose });
      let dialogInfo = await waitDialogContinue(fresh, 5_000);
      if (!dialogInfo?.presented) {
        const sent = closeMainWindows(exe, launchedGoalPortPids);
        if (sent && sent !== "none") {
          closeMainWindowPids = sent.split(",").map((part) => Number(part)).filter((pid) => pid > 0);
        }
        log("close-main-window", { closeMainWindowPids, targetUiPid });
        dialogInfo = await waitDialogContinue(fresh, 5_000);
      }
      dialogPresented = dialogInfo?.presented === true;
      if (!dialogPresented) {
        throw new Error("close-choice dialog was not presented");
      }
      closeDialogShownAtUtc = new Date().toISOString();
      const buttonDeadline = Date.now() + 5_000;
      while ((!dialogInfo?.button || dialogInfo.label !== "Continue in background") && Date.now() < buttonDeadline) {
        const again = await waitDialogContinue(fresh, 800);
        if (again?.presented) dialogInfo = again;
      }
      if (!dialogInfo?.button || dialogInfo.label !== "Continue in background") {
        throw new Error("Continue in background button was not present in the close-choice dialog");
      }
      continueMouse = { x: dialogInfo.x, y: dialogInfo.y, label: dialogInfo.label };
      const wrapAgain = await withTimeout(fresh(wrapExpr, false), 2_000, "wrap-confirm-close-again");
      log("wrap-confirm-close-again", { wrapAgain });
      const clickExpr = `(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Continue in background'||x.innerText.trim()==='Continue in background');if(!button||button.disabled)return false;button.click();return true;})()`;
      const receiptPoll = (async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            const receipt = await withTimeout(fresh("window.__goalportContinueReceipt||null", false), 250, "continue-receipt");
            if (receipt?.payload) return receipt;
          } catch {
            // renderer may be tearing down
          }
          await sleep(30);
        }
        return null;
      })();
      continueClickIssuedAtUtc = new Date().toISOString();
      fireAndForget(session, "Input.dispatchMouseEvent", { type: "mouseMoved", x: continueMouse.x, y: continueMouse.y });
      fireAndForget(session, "Input.dispatchMouseEvent", { type: "mousePressed", x: continueMouse.x, y: continueMouse.y, button: "left", clickCount: 1 });
      fireAndForget(session, "Input.dispatchMouseEvent", { type: "mouseReleased", x: continueMouse.x, y: continueMouse.y, button: "left", clickCount: 1 });
      try {
        continueClick = await withTimeout(fresh(clickExpr, false), 2_000, "continue-click") === true;
      } catch (error) {
        log("continue-click-error", { error: String(error.message || error) });
      }
      log("continue-click-issued", { continueClickIssuedAtUtc, continueClick, targetUiPid, continueMouse });
      const receipt = await receiptPoll;
      log("core-liveness-after-continue", {
        pipeAlive: pipeAlive(pipeBare),
        coreStillLive: identityStillLive(coreBefore),
        runtimeStillLive: identityStillLive(runtimeBefore),
        corePids: cimNamedProcesses(["goalport-core.exe"]).map((row) => Number(row.ProcessId)),
        launcherPids: cimNamedProcesses(["goalport-core-launcher.exe"]).map((row) => Number(row.ProcessId))
      });
      if (receipt?.payload) {
        continueReceiptRaw = receipt.payload;
        continueReceiptAtUtc = receipt.atUtc || new Date().toISOString();
        confirmCloseChoice = receipt.payload;
        if (continueBackgroundFromProductPayload(receipt.payload)) {
          continueReceiptPayload = "continue-background";
          allowQuitLatch = true;
          closeSurface = "renderer-dialog";
        }
        log("continue-receipt", { continueReceiptAtUtc, continueReceiptPayload, continueReceiptRaw });
      }
      if (continueReceiptPayload !== "continue-background") {
        log("continue-receipt-cdp-missed", { continueReceiptRaw, continueClick });
      }
      log("continue-in-background", { continueClick, dialogPresented, continueReceiptPayload, allowQuitLatch, targetUiPid });
    } else {
      closeSurface = "taskkill-pid";
      recordLaunchedGoalPort();
      const processes = cimProcesses();
      const targets = selectKillTargets({ launchedPids: launchedRootPids, processes, exePath: exe });
      const errors = validateKillTargets(targets, exe, { launchedPids: launchedRootPids, processes });
      if (errors.length > 0) throw new Error(`kill list refused: ${errors.join(",")}`);
      if (targets.length === 0) throw new Error("kill list empty: no launched GoalPort.exe at this-run path");
      const liveNow = cimProcesses();
      for (const row of targets) {
        const still = liveNow.find((item) => Number(item.ProcessId) === Number(row.ProcessId));
        if (!still) continue;
        if (normPath(still.ExecutablePath) !== normPath(row.ExecutablePath)) {
          throw new Error(`kill TOCTOU path mismatch pid=${row.ProcessId}`);
        }
        if (String(still.CreationDate || "") !== String(row.CreationDate || "")) {
          throw new Error(`kill TOCTOU creationDate mismatch pid=${row.ProcessId}`);
        }
        const result = killPid(row.ProcessId);
        killedPids.push({ pid: result.pid, executablePath: row.ExecutablePath, args: result.args, status: result.status });
        if (result.args.includes("/T")) taskkillUsedT = true;
      }
    }

    const exitDeadline = Date.now() + 30_000;
    while (Date.now() < exitDeadline) {
      const live = new Set(cimProcesses().map((row) => Number(row.ProcessId)));
      if (launchedRootPids.every((pid) => !live.has(Number(pid)))) {
        hostExited = true;
        break;
      }
      await sleep(250);
    }
    try { session?.close(); } catch {}
    session = null;
    uiExitUtc = new Date().toISOString();
    if (hostExited) hostExitedAtUtc = uiExitUtc;
    attemptIdAtUiExit = firstSnap?.attempt?.id || attemptIdAtSubmit;
    attemptCountAtUiExit = countAttemptsForTask(dbPath, firstSnap?.activeTask?.id);
    if (mode === "graceful") {
      continueReceiptCore = queryProductReceipt(dbPath, { kind: "close-choice" });
      if (continueReceiptCore?.receiptId) {
        continueReceiptId = String(continueReceiptCore.receiptId);
        mainReceivedAtUtc = continueReceiptCore.mainReceivedAtUtc || mainReceivedAtUtc;
        coreReceiptPersistedAtUtc = continueReceiptCore.coreReceiptPersistedAtUtc || continueReceiptCore.recordedAtUtc;
        if (String(continueReceiptCore.choice) === "continue-background") {
          continueReceiptPayload = "continue-background";
          allowQuitLatch = true;
          closeSurface = closeSurface || "renderer-dialog";
        }
      }
      if (continueReceiptPayload !== "continue-background" || !continueReceiptCore) {
        throw new Error("Continue in background was not observed (Core close-choice receipt missing)");
      }
      if (continueReceiptRaw && !continueBackgroundFromProductPayload(continueReceiptRaw)) {
        throw new Error("Continue renderer return did not match Core continue receipt");
      }
      if (!hostExitedAtUtc || String(hostExitedAtUtc) < String(coreReceiptPersistedAtUtc || continueReceiptAtUtc || "")) {
        throw new Error("host did not exit after Continue receipt");
      }
    }
    log("host-exit", { hostExited, uiExitUtc, hostExitedAtUtc, allowQuitLatch, continueReceiptPayload });
    if (!hostExited) throw new Error("host did not exit after close/kill");

    const liveCore = spawnedCoreSha(pipeBare, dbPath);
    const liveCoreRow = coreOnPipeOrDb(cimProcesses(), pipeBare, dbPath).find((row) => Number(row.ProcessId) === Number(liveCore.pid));
    if (identityStillLive(coreBefore)) {
      coreAfter = coreBefore;
    } else {
      coreAfter = liveCoreRow ? processIdentity(liveCoreRow) : (liveCore.pid ? { pid: liveCore.pid, parentPid: liveCore.parent, executablePath: liveCore.path, creationDate: "", name: "goalport-core.exe" } : null);
    }
    log("core-liveness-after-host-exit", {
      pipeAlive: pipeAlive(pipeBare),
      coreStillLive: identityStillLive(coreBefore),
      runtimeStillLive: identityStillLive(runtimeBefore),
      liveCore,
      coreAfterPid: coreAfter?.pid || null
    });
    if (!sameProcessIdentity(coreBefore, coreAfter)) {
      coreRespawn = true;
      log("core-identity-mismatch", { coreBefore, coreAfter });
    }
    runtimeAfter = identityStillLive(runtimeBefore) ? runtimeBefore : null;
    nativeWasAlive = Boolean(runtimeAfter);
    coreAlive = Boolean(coreAfter && sameProcessIdentity(coreBefore, coreAfter));
    log("absence-pre-reopen", { coreAlive, nativeAlive: nativeWasAlive, coreRespawn, coreAfter, runtimeAfter });
    if (!coreAlive || coreRespawn) throw new Error("original Core PID/CreationDate did not survive UI absence");
    if (!nativeWasAlive) throw new Error("pinned Runtime PID/CreationDate did not survive UI absence");

    const absenceDeadline = Date.now() + 180_000;
    let absenceBeforeReopen = null;
    while (Date.now() < absenceDeadline) {
      absenceBeforeReopen = queryEvents(dbPath, firstSnap?.attempt?.id).find((row) =>
        kindAllowed(row?.kind)
        && String(row?.attemptId || "") === String(firstSnap?.attempt?.id || "")
        && Number.isFinite(eventTimeMs(row?.atUtc))
        && eventTimeMs(row.atUtc) >= eventTimeMs(uiExitUtc));
      if (absenceBeforeReopen) break;
      await sleep(250);
    }
    if (!absenceBeforeReopen) {
      throw new Error("no persisted Runtime/message increment was observed while the GUI was absent");
    }
    log("absence-runtime-event", {
      id: absenceBeforeReopen.id,
      kind: absenceBeforeReopen.kind,
      atUtc: absenceBeforeReopen.atUtc
    });

    const reopenEnv = isolatedChildEnv({
      GOALPORT_CDP_PORT: String(reopenPort)
    });
    delete reopenEnv.GOALPORT_LAUNCH_NONCE;
    const reopenChild = launchExe({ exe, port: reopenPort, env: reopenEnv });
    if (reopenChild?.pid) launchedRootPids.push(reopenChild.pid);
    log("reopen-launch", { pid: reopenChild?.pid, port: reopenPort });
    await sleep(400);
    recordLaunchedGoalPort();
    const reopen = await attachGoalPort(reopenPort);
    session = reopen;
    if (!(await waitFor(reopen.evaluate, `document.body.innerText.includes('Core connected')`, 30_000))) {
      throw new Error("reopen GUI never displayed Core connected");
    }
    startupReceipts = queryProductReceipts(dbPath, "startup");
    if (startupReceipts.length !== 1 || String(startupReceipts[0]?.launchNonce) !== String(launchNonce)) {
      throw new Error(`reopen spawned a second Core startups=${startupReceipts.length} nonce=${startupReceipts.map((row) => row.launchNonce).join(",")}`);
    }
    const reconnectSnap = await snapshotOf(reopen.evaluate);
    reconnectWhileActive = {
      atUtc: new Date().toISOString(),
      attempt: { id: reconnectSnap?.attempt?.id || null, state: reconnectSnap?.attempt?.state || null },
      campaignId: reconnectSnap?.activeCampaignId || null,
      taskId: reconnectSnap?.activeTask?.id || null,
      connection: reconnectSnap?.connection || null
    };
    reopenAttemptId = reconnectSnap?.attempt?.id || null;
    attemptIdAtReopen = reopenAttemptId;
    attemptCountAtReopen = countAttemptsForTask(dbPath, reconnectSnap?.activeTask?.id);
    log("reconnectWhileActive", reconnectWhileActive);
    const reopenCoreRow = coreOnPipeOrDb(cimProcesses(), pipeBare, dbPath).find((row) => normPath(row.ExecutablePath).endsWith("goalport-core.exe"));
    coreAtReopen = reopenCoreRow ? processIdentity(reopenCoreRow) : null;
    if (!sameProcessIdentity(coreBefore, coreAtReopen)) {
      coreRespawn = true;
      log("core-identity-reopen-mismatch", { coreBefore, coreAtReopen });
    }

    const capMs = 12 * 60 * 1000;
    const waitStart = Date.parse(uiExitUtc);
    while (Date.now() - waitStart < capMs) {
      await clickNamedButton(reopen.evaluate, "Allow once");
      const snap = await snapshotOf(reopen.evaluate);
      originalStepTerminal = {
        atUtc: new Date().toISOString(),
        attempt: { id: snap?.attempt?.id || null, state: snap?.attempt?.state || null }
      };
      if (!isActiveState(snap?.attempt?.state)) break;
      await sleep(1500);
    }
    if (!originalStepTerminal) {
      const snap = await snapshotOf(reopen.evaluate);
      originalStepTerminal = {
        atUtc: new Date().toISOString(),
        attempt: { id: snap?.attempt?.id || null, state: snap?.attempt?.state || null }
      };
    }
    log("originalStepTerminal", originalStepTerminal);

    if (isActiveState(originalStepTerminal.attempt.state)) {
      followUp = { status: "UNMET", reason: "still-active-at-timeout", sent: false, followUpUser: false, sameAttemptTurn: false };
    } else {
      const attemptId = firstSnap?.attempt?.id;
      const beforeEvents = queryEvents(dbPath, attemptId);
      const beforeTurns = beforeEvents.filter((row) => row.kind === "runtime.turn.started").map((row) => row.id);
      const lastPriorTurn = beforeTurns.length ? beforeTurns[beforeTurns.length - 1] : null;
      const originalTurnHash = lastPriorTurn ? sha256Text(lastPriorTurn) : null;
      const followUpTextSha = sha256Text(followUpText);
      if (!(await fillComposer(reopen.evaluate, followUpText))) throw new Error("follow-up composer input failed");
      log("follow-up-fill", { nonce: followUpNonce });
      if (!(await clickNamedButton(reopen.evaluate, "Send message"))) throw new Error("follow-up Send did not dispatch");
      const guiSendAtUtc = new Date().toISOString();
      log("follow-up-send", { nonce: followUpNonce, guiSendAtUtc });
      const followDeadline = Date.now() + 180_000;
      let judged = { status: "UNMET", reason: "no-follow-up-user", followUpUser: false, sameAttemptTurn: false };
      while (Date.now() < followDeadline) {
        await clickNamedButton(reopen.evaluate, "Allow once");
        judged = judgeFollowUp({
          events: queryEvents(dbPath, attemptId),
          attemptId,
          followUpTextSha,
          beforeTurnIds: beforeTurns
        });
        if (judged.status === "PASS") break;
        await sleep(800);
      }
      followUp = {
        status: judged.status,
        sent: true,
        nonce: followUpNonce,
        guiSendAtUtc,
        userAtUtc: judged.userAtUtc || null,
        turnStartedAtUtc: judged.turnStartedAtUtc || null,
        replyAtUtc: judged.replyAtUtc || null,
        textSha256: followUpTextSha,
        nativeTurnHash: judged.nativeTurnId ? sha256Text(judged.nativeTurnId) : null,
        originalTurnHash,
        nativeTurnId: judged.nativeTurnId || null,
        followUpUserId: judged.followUpUserId || null,
        replyId: judged.replyId || null,
        processEpoch: queryRuntimeBindings(dbPath, attemptId)[0]?.processEpoch || null,
        followUpUser: judged.followUpUser === true,
        sameAttemptTurn: judged.sameAttemptTurn === true,
        reason: judged.reason
      };
      if (followUp.nativeTurnHash && followUp.originalTurnHash && followUp.nativeTurnHash === followUp.originalTurnHash) {
        followUp.status = "UNMET";
        followUp.reason = "native-turn-hash-not-distinct";
      }
    }
    try {
      const afterSnap = await snapshotOf(session.evaluate);
      attemptIdAfterFollowUp = afterSnap?.attempt?.id || followUp.attemptId || attemptIdAtReopen;
    } catch {
      attemptIdAfterFollowUp = attemptIdAtReopen;
    }
    attemptCountAfterFollowUp = countAttemptsForTask(dbPath, firstSnap?.activeTask?.id);
    try { session.close(); } catch {}
    session = null;
    return finish(null);
  } catch (error) {
    try { session?.close(); } catch {}
    try {
      if (!attemptIdAfterFollowUp) attemptIdAfterFollowUp = attemptIdAtReopen || attemptIdAtSubmit;
      if (!attemptCountAfterFollowUp) attemptCountAfterFollowUp = countAttemptsForTask(dbPath, firstSnap?.activeTask?.id);
    } catch {}
    return finish(error);
  } finally {
    try { watcher?.child?.kill(); } catch {}
    const hygienePids = launchedGoalPortPids.length ? launchedGoalPortPids : launchedRootPids;
    try { stopThisRunGoalPort(exe, hygienePids); } catch {}
    try {
      if (runtimeBefore?.pid && Number(runtimeBefore.parentPid) === Number(coreBefore?.pid) && identityStillLive(runtimeBefore)) {
        killPid(runtimeBefore.pid);
      }
    } catch {}
    try { stopThisRunCore(pipeBare, dbPath); } catch {}
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const keepAlive = setInterval(() => {}, 15_000);
  try {
    const argv = process.argv.slice(2);
    const mode = flag(argv, "--mode", "graceful");
    const exe = flag(argv, "--exe", resolve(EVID, "electron-package-obs-b/GoalPort-win32-x64/GoalPort.exe"));
    if (!existsSync(exe)) {
      console.error(`packaged Electron missing: ${exe}`);
      process.exitCode = 2;
    } else {
      assertIsolatedEnv({ argv });
      const report = flag(argv, "--report", resolve(EVID, `resume-chain-${mode}.json`));
      const pipe = flag(argv, "--pipe", process.env.GOALPORT_CORE_PIPE);
      const db = flag(argv, "--db", process.env.GOALPORT_CORE_DB);
      const port = Number(flag(argv, "--port", mode === "kill" ? "19442" : "19441"));
      const skipSubmit = argv.includes("--skip-submit");
      console.error(`[resume-chain] starting mode=${mode} port=${port} skipSubmit=${skipSubmit}`);
      const result = await runResumeChain({
        mode,
        exe,
        report,
        pipe,
        db,
        port,
        reopenPort: port + 1,
        skipSubmit
      });
      console.log(JSON.stringify({ status: result.status, path: report, unmetReasons: result.unmetReasons }, null, 2));
      process.exitCode = result.status === "PASS" ? 0 : 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearInterval(keepAlive);
  }
}
