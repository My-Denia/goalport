import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseCimDateMs, parseUtcInstant } from "./v1-resume-chain.mjs";

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readyPath(dbPath) {
  return `${dbPath}.launch-ready`;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normPath(value) {
  return String(value || "").replaceAll("/", "\\").replace(/^\\\\\?\\/, "").toLowerCase();
}

function observeProcess(pid) {
  try {
    const command = `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`;
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8", windowsHide: true, timeout: 10_000
    }).trim();
    if (!text) return null;
    const row = JSON.parse(text);
    const path = String(row.ExecutablePath || "");
    return {
      pid: Number(row.ProcessId),
      parentPid: Number(row.ParentProcessId),
      name: String(row.Name || ""),
      executablePath: path,
      executableSha256: path && existsSync(path) ? sha256File(path) : null,
      commandLine: String(row.CommandLine || ""),
      creationDate: String(row.CreationDate || "")
    };
  } catch {
    return null;
  }
}

export function validateLaunchReady(ready, expected, observedCore) {
  const reasons = [];
  if (!ready || ready.kind !== "launch-ready" || ready.readyState !== "READY_COMMITTED") reasons.push("state");
  if (String(ready?.launchNonce || "") !== String(expected.nonce)) reasons.push("nonce");
  if (String(ready?.coreEpochId || "") !== `core-epoch:${expected.nonce}`) reasons.push("epoch");
  if (String(ready?.runSlug || "") !== String(expected.runSlug)) reasons.push("runSlug");
  if (normPath(ready?.pipeIdentity) !== normPath(expected.pipe)) reasons.push("pipe");
  if (normPath(ready?.databaseIdentity) !== normPath(expected.dbPath)) reasons.push("database");
  if (String(ready?.startupReceiptId || "") !== `startup:${expected.nonce}`) reasons.push("startup-receipt-id");
  if (Number(ready?.launcher?.pid) !== Number(expected.launcherPid)
    || normPath(ready?.launcher?.executablePath) !== normPath(expected.launcherPath)
    || String(ready?.launcher?.executableSha256 || "").toLowerCase() !== String(expected.launcherSha256).toLowerCase()) {
    reasons.push("launcher-identity");
  }
  if (!observedCore
    || Number(ready?.core?.pid) !== Number(observedCore.pid)
    || String(ready?.core?.creationDate || "") !== String(observedCore.creationDate)
    || normPath(ready?.core?.executablePath) !== normPath(observedCore.executablePath)
    || String(ready?.core?.executableSha256 || "").toLowerCase() !== String(observedCore.executableSha256 || "").toLowerCase()
    || normPath(observedCore.executablePath) !== normPath(expected.corePath)
    || String(observedCore.executableSha256 || "").toLowerCase() !== String(expected.coreSha256).toLowerCase()) {
    reasons.push("core-identity");
  }
  const launch = parseUtcInstant(ready?.timestamps?.launchRequestedAtUtc);
  const startup = parseUtcInstant(ready?.timestamps?.startupReceiptPersistedAtUtc);
  const readyAt = parseUtcInstant(ready?.timestamps?.readyAtUtc);
  const launchedAt = parseUtcInstant(expected.launchedAtUtc);
  const coreCreated = parseCimDateMs(observedCore?.creationDate);
  if (![launch, startup, readyAt, launchedAt, coreCreated].every(Number.isFinite)
    || launchedAt > launch || launch > startup || coreCreated > readyAt || startup > readyAt) reasons.push("timestamps");
  return { ok: reasons.length === 0, reasons };
}

function spawnCore(core, dbPath, pipe, nonce, extraEnv = {}) {
  const launcher = resolve(dirname(core), "goalport-core-launcher.exe");
  if (!existsSync(launcher)) throw new Error(`Core launcher missing: ${launcher}`);
  const launchedAtUtc = new Date().toISOString();
  const child = spawn(launcher, [core, "serve", "--pipe", pipe, "--db", dbPath], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      GOALPORT_LAUNCHER_REEXEC: "1",
      GOALPORT_LAUNCH_READY_TIMEOUT_MS: "2000",
      GOALPORT_REQUIRE_ISOLATED: "1",
      GOALPORT_LAUNCH_NONCE: nonce,
      GOALPORT_RUN_SLUG: "goalport-evidence-verifier-core-restart",
      GOALPORT_ELECTRON_PID: String(process.pid),
      GOALPORT_ELECTRON_CREATED_MS: "1",
      GOALPORT_ELECTRON_EXE: process.execPath,
      GOALPORT_ELECTRON_SHA256: "core-restart-driver",
      GOALPORT_LAUNCHER_PID: String(process.pid),
      GOALPORT_LAUNCHER_CREATED_MS: "1",
      GOALPORT_LAUNCHER_EXE: process.execPath,
      GOALPORT_LAUNCHER_SHA256: "core-restart-driver",
      GOALPORT_LAUNCHER_PARENT_PID: String(process.pid),
      GOALPORT_LAUNCH_REQUESTED_AT: launchedAtUtc,
      GOALPORT_LAUNCHER_STARTED_AT: new Date().toISOString(),
      GOALPORT_CORE_SPAWNED_AT: new Date().toISOString(),
      ...extraEnv
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise((resolveClosed) => child.once("close", (code) => resolveClosed(code)));
  return {
    child,
    nonce,
    corePid: null,
    launcherPath: launcher,
    launcherSha256: sha256File(launcher),
    corePath: core,
    coreSha256: sha256File(core),
    dbPath,
    pipe,
    runSlug: "goalport-evidence-verifier-core-restart",
    launchedAtUtc,
    stderr: () => stderr,
    closed
  };
}

async function waitReady(record, dbPath, nonce) {
  await waitUntil(() => {
    if (!existsSync(readyPath(dbPath))) return false;
    let ready;
    try { ready = JSON.parse(readFileSync(readyPath(dbPath), "utf8")); } catch { return false; }
    const observedCore = observeProcess(Number(ready?.core?.pid));
    const judged = validateLaunchReady(ready, {
      ...record,
      launcherPid: record.child.pid,
      nonce
    }, observedCore);
    if (judged.ok) return true;
    if (record.child.exitCode !== null) {
      throw new Error(`launcher exited ${record.child.exitCode} before ready: ${record.stderr()}`);
    }
    return false;
  }, 15_000, `launch-ready ${nonce}`);
  const ready = JSON.parse(readFileSync(readyPath(dbPath), "utf8"));
  const observedCore = observeProcess(Number(ready?.core?.pid));
  const judged = validateLaunchReady(ready, { ...record, launcherPid: record.child.pid, nonce }, observedCore);
  if (!judged.ok) {
    throw new Error(`launch-ready identity mismatch for ${nonce}`);
  }
  record.corePid = Number(ready.core.pid);
  await waitUntil(() => record.child.exitCode !== null, 10_000, `launcher exit for ${nonce}`);
  if (record.child.exitCode !== 0) throw new Error(`launcher failed after ready: ${record.stderr()}`);
}

async function waitRejected(record, label) {
  await waitUntil(() => record.child.exitCode !== null, 15_000, `${label} rejection`);
  if (record.child.exitCode === 0) throw new Error(`${label} exited successfully instead of rejecting`);
  return { exitCode: record.child.exitCode, stderr: record.stderr() };
}

function killOwned(record) {
  if (!record?.corePid || !pidLive(record.corePid)) return null;
  const args = ["/F", "/PID", String(record.corePid)];
  const result = execFileSync("taskkill.exe", args, { encoding: "utf8", windowsHide: true });
  return { pid: record.corePid, args, output: String(result).trim() };
}

function pidLive(pid) {
  try {
    const script = `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`;
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    }).trim() === "yes";
  } catch {
    return false;
  }
}

async function waitExited(record) {
  await waitUntil(() => !pidLive(record.corePid), 10_000, `Core pid ${record.corePid} exit`);
}

function openDb(path) {
  return new DatabaseSync(path, { timeout: 8_000 });
}

function seedUncertainState(dbPath) {
  const db = openDb(dbPath);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("INSERT INTO attempts(id,task_id,provider,provider_session,state,last_event_seq,capability_version) VALUES(?,?,?,?,?,?,?)")
      .run("attempt-restart-driver", "task-restart-driver", "scenario", "old-provider-session", "ACTIVE", 0, "cap-v1");
    db.prepare("INSERT INTO commands(id,attempt_id,kind,payload_hash,state,created_at) VALUES(?,?,?,?,?,?)")
      .run("command-restart-driver", "attempt-restart-driver", "external-write", "payload", "EXECUTING", String(Date.now()));
    db.prepare("INSERT INTO outbox(id,command_id,effect_kind,target,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run("outbox-restart-driver", "command-restart-driver", "external-write", "synthetic", "DISPATCHING", String(Date.now()), String(Date.now()));
    db.prepare("INSERT INTO workspace_leases(workspace_key,attempt_id,access_mode,state,acquired_at,last_heartbeat) VALUES(?,?,?,?,?,?)")
      .run("synthetic-restart-workspace", "attempt-restart-driver", "MUTATING", "ACTIVE", String(Date.now()), String(Date.now()));
    db.prepare("INSERT INTO decisions(id,attempt_id,kind,state) VALUES(?,?,?,?)")
      .run("permission-restart-driver", "attempt-restart-driver", "permission", "PENDING");
    db.prepare("INSERT INTO attempt_recovery(attempt_id,provider,session_hash,process_epoch,pid,last_seq,pending_permission_ids,outbox_ids,lease_workspace_key,recovery_class,prompt_replay,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("attempt-restart-driver", "scenario", "old-session-hash", "old-runtime-epoch", 9999, 0, '["permission-restart-driver"]', '["outbox-restart-driver"]', "synthetic-restart-workspace", "R1", 0, String(Date.now()));
  } finally {
    db.close();
  }
}

function snapshot(dbPath) {
  const db = openDb(dbPath);
  try {
    const epochs = db.prepare("SELECT epoch_id AS epochId,launch_nonce AS launchNonce,core_pid AS corePid,core_creation_date AS coreCreationDate,core_executable_path AS coreExecutablePath,core_executable_sha256 AS coreExecutableSha256,previous_epoch_id AS previousEpochId,state,reconciliation_json AS reconciliationJson,created_at AS createdAt,activated_at AS activatedAt FROM core_launch_epochs ORDER BY rowid").all();
    const receipts = db.prepare("SELECT id,launch_nonce AS launchNonce,payload_json AS payloadJson,created_at AS createdAt FROM product_receipts WHERE kind='startup' ORDER BY created_at,rowid").all().map((row) => ({ ...row, payload: JSON.parse(row.payloadJson) }));
    const readyReceipts = db.prepare("SELECT id,launch_nonce AS launchNonce,receipt_id AS receiptId,payload_json AS payloadJson,created_at AS createdAt FROM product_receipts WHERE kind='launch-ready' ORDER BY created_at,rowid").all().map((row) => ({ ...row, payload: JSON.parse(row.payloadJson) }));
    const command = db.prepare("SELECT state FROM commands WHERE id='command-restart-driver'").get();
    const outbox = db.prepare("SELECT state,last_error AS lastError FROM outbox WHERE id='outbox-restart-driver'").get();
    const lease = db.prepare("SELECT state FROM workspace_leases WHERE attempt_id='attempt-restart-driver'").get();
    const decision = db.prepare("SELECT state FROM decisions WHERE id='permission-restart-driver'").get();
    const recovery = db.prepare("SELECT session_hash AS sessionHash,process_epoch AS processEpoch,pid,recovery_class AS recoveryClass,prompt_replay AS promptReplay,pending_permission_ids AS pendingPermissionIds,outbox_ids AS outboxIds FROM attempt_recovery WHERE attempt_id='attempt-restart-driver'").get();
    const attemptCount = Number(db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE id='attempt-restart-driver'").get()?.n || 0);
    const eventCount = Number(db.prepare("SELECT COUNT(*) AS n FROM events WHERE attempt_id='attempt-restart-driver'").get()?.n || 0);
    return { epochs, receipts, readyReceipts, command, outbox, lease, decision, recovery, attemptCount, eventCount };
  } finally {
    db.close();
  }
}

async function runRace(core, evidenceDir) {
  const dbPath = resolve(evidenceDir, `core-race-${randomUUID()}.sqlite`);
  const pipe = `goalport-evidence-verifier-core-restart-race-${randomUUID()}`;
  const nonceA = randomUUID();
  const nonceB = randomUUID();
  const children = [spawnCore(core, dbPath, pipe, nonceA), spawnCore(core, dbPath, pipe, nonceB)];
  try {
    await waitUntil(() => existsSync(readyPath(dbPath)), 15_000, "race launch-ready");
    await waitUntil(() => children.every((row) => row.child.exitCode !== null), 20_000, "race launchers exit");
    const db = openDb(dbPath);
    let counts;
    try {
      counts = {
        epochs: Number(db.prepare("SELECT COUNT(*) AS n FROM core_launch_epochs").get().n),
        receipts: Number(db.prepare("SELECT COUNT(*) AS n FROM product_receipts WHERE kind='startup' AND json_extract(payload_json,'$.startupState')='READY_COMMITTED'").get().n),
        readyReceipts: Number(db.prepare("SELECT COUNT(*) AS n FROM product_receipts WHERE kind='launch-ready' AND json_extract(payload_json,'$.readyState')='READY_COMMITTED'").get().n)
      };
    } finally { db.close(); }
    const accepted = children.filter((row) => row.child.exitCode === 0);
    const rejected = children.filter((row) => row.child.exitCode !== 0);
    const ready = JSON.parse(readFileSync(readyPath(dbPath), "utf8"));
    if (accepted.length === 1) accepted[0].corePid = Number(ready?.core?.pid);
    if (accepted.length !== 1 || rejected.length !== 1 || !pidLive(accepted[0].corePid) || counts.epochs !== 1 || counts.receipts !== 1 || counts.readyReceipts !== 1) {
      throw new Error(`race invariant failed accepted=${accepted.length} rejected=${rejected.length} epochs=${counts.epochs} receipts=${counts.receipts} ready=${counts.readyReceipts}`);
    }
    return { dbPath, pipe, nonceA, nonceB, rejected: rejected[0].nonce, accepted: accepted[0].nonce, counts };
  } finally {
    for (const child of children) {
      try { killOwned(child); } catch {}
    }
    await Promise.all(children.map(async (child) => { if (child.corePid) try { await waitExited(child); } catch {} }));
  }
}

async function runFaultMatrix(core, evidenceDir) {
  const stages = [
    "before-startup",
    "after-startup-before-ready",
    "ready-write",
    "ready-sync",
    "after-ready-before-confirm",
    "after-confirm-before-ready",
    "ready-confirm-write",
    "ready-confirm-read",
    "ready-confirm-rename"
  ];
  const results = [];
  for (const [index, stage] of stages.entries()) {
    const dbPath = resolve(evidenceDir, `core-fault-${index}-${randomUUID()}.sqlite`);
    const pipe = `goalport-evidence-verifier-core-restart-fault-${index}-${randomUUID()}`;
    const failedNonce = randomUUID();
    const failed = spawnCore(core, dbPath, pipe, failedNonce, { GOALPORT_TEST_STARTUP_FAILURE: stage });
    const rejected = await waitRejected(failed, `fault ${stage}`);
    const failedState = snapshot(dbPath);
    const failedClosed = rejected.exitCode !== 0
      && failedState.epochs.length === 1
      && failedState.epochs[0].state === "ABORTED"
      && failedState.receipts.every((row) => row.payload?.startupState !== "READY_COMMITTED")
      && failedState.readyReceipts.every((row) => row.payload?.readyState !== "READY_COMMITTED");
    const recoveredNonce = randomUUID();
    let recovered = null;
    for (let attempt = 0; attempt < 5 && !recovered; attempt += 1) {
      const candidate = spawnCore(core, dbPath, pipe, recoveredNonce);
      try {
        await waitReady(candidate, dbPath, recoveredNonce);
        recovered = candidate;
      } catch {
        // A just-exited failed Core can remain unqueryable for a short Windows
        // process-object interval. Each retry still runs the real admission gate.
      }
    }
    if (!recovered) throw new Error(`fault ${stage} did not permit a reconciled restart`);
    const recoveredState = snapshot(dbPath);
    const restartAccepted = recoveredState.epochs.at(-1)?.launchNonce === recoveredNonce
      && recoveredState.epochs.at(-1)?.state === "READY_COMMITTED"
      && recoveredState.receipts.some((row) => row.launchNonce === recoveredNonce && row.payload?.startupState === "READY_COMMITTED")
      && recoveredState.readyReceipts.some((row) => row.launchNonce === recoveredNonce && row.payload?.readyState === "READY_COMMITTED");
    results.push({ stage, dbPath, pipe, failedNonce, recoveredNonce, failedClosed, restartAccepted, failedState, recoveredState });
    try { killOwned(recovered); } catch {}
    try { await waitExited(recovered); } catch {}
  }
  return { cases: results, status: results.every((row) => row.failedClosed && row.restartAccepted) ? "PASS" : "UNMET" };
}

export async function runCoreRestart({ core, dbPath, pipe, reportPath }) {
  const firstNonce = randomUUID();
  const secondNonce = randomUUID();
  const active = [];
  try {
    const first = spawnCore(core, dbPath, pipe, firstNonce);
    active.push(first);
    console.error(`[core-restart] first launch nonce=${firstNonce}`);
    await waitReady(first, dbPath, firstNonce);
    console.error(`[core-restart] first active pid=${first.corePid}`);
    const duplicate = spawnCore(core, dbPath, pipe, firstNonce);
    active.push(duplicate);
    const duplicateResult = await waitRejected(duplicate, "same-epoch duplicate");
    const afterDuplicate = snapshot(dbPath);
    console.error("[core-restart] duplicate rejected");
    const whileLive = spawnCore(core, dbPath, pipe, secondNonce);
    active.push(whileLive);
    const whileLiveResult = await waitRejected(whileLive, "second Core while prior live");
    const afterWhileLive = snapshot(dbPath);
    console.error("[core-restart] prior-live competitor rejected");
    seedUncertainState(dbPath);
    const killedFirst = killOwned(first);
    await waitExited(first);
    console.error(`[core-restart] first ended pid=${first.corePid}`);
    let second = null;
    const endedObservationRetries = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const candidate = spawnCore(core, dbPath, pipe, secondNonce);
      active.push(candidate);
      try {
        await waitReady(candidate, dbPath, secondNonce);
        second = candidate;
        break;
      } catch (error) {
        endedObservationRetries.push({ attempt, error: String(error?.message || error), stderr: candidate.stderr() });
      }
    }
    if (!second) throw new Error("new Core never obtained a decisive prior-ended observation");
    console.error(`[core-restart] second active pid=${second.corePid}`);
    const replay = spawnCore(core, dbPath, pipe, firstNonce);
    active.push(replay);
    const replayResult = await waitRejected(replay, "historical epoch replay");
    const afterReplay = snapshot(dbPath);
    console.error("[core-restart] historical epoch replay rejected");
    const state = snapshot(dbPath);
    const race = await runRace(core, dirname(reportPath));
    console.error("[core-restart] separate-process race serialized");
    const faultMatrix = await runFaultMatrix(core, dirname(reportPath));
    console.error("[core-restart] startup/ready fault matrix complete");
    const checks = {
      duplicateRejected: duplicateResult.exitCode !== 0
        && afterDuplicate.epochs.length === 1
        && afterDuplicate.receipts.length === 1
        && afterDuplicate.readyReceipts.length === 1
        && afterDuplicate.epochs[0].launchNonce === firstNonce,
      priorLiveRejected: whileLiveResult.exitCode !== 0
        && afterWhileLive.epochs.length === 1
        && afterWhileLive.receipts.length === 1
        && afterWhileLive.readyReceipts.length === 1
        && afterWhileLive.epochs[0].launchNonce === firstNonce,
      restartAccepted: state.epochs.length === 2 && state.receipts.length === 2 && state.readyReceipts.length === 2 && state.epochs[0].state === "ENDED" && state.epochs[1].state === "READY_COMMITTED",
      distinctIdentity: state.epochs.length === 2
        && state.epochs[0].epochId !== state.epochs[1].epochId
        && state.epochs[0].launchNonce !== state.epochs[1].launchNonce
        && state.epochs[0].corePid !== state.epochs[1].corePid
        && state.epochs[0].coreCreationDate !== state.epochs[1].coreCreationDate,
      historyRetained: state.receipts.some((row) => row.launchNonce === firstNonce) && state.receipts.some((row) => row.launchNonce === secondNonce),
      replayRejected: replayResult.exitCode !== 0
        && afterReplay.epochs.length === 2
        && afterReplay.receipts.length === 2
        && afterReplay.readyReceipts.length === 2,
      uncertaintyPreserved: state.command?.state === "UNKNOWN"
        && state.outbox?.state === "UNKNOWN"
        && state.lease?.state === "UNCERTAIN"
        && state.decision?.state === "PENDING"
        && state.recovery?.recoveryClass === "R1_UNSUPPORTED"
        && state.recovery?.pid == null
        && state.recovery?.processEpoch == null
        && state.recovery?.sessionHash === "old-session-hash"
        && Number(state.recovery?.promptReplay) === 0,
      noDuplicateResponsibility: state.attemptCount === 1 && state.eventCount === 0,
      concurrentClaimSerialized: race.counts.epochs === 1 && race.counts.receipts === 1 && race.counts.readyReceipts === 1,
      startupReadyFaultWindows: faultMatrix.status === "PASS"
    };
    const result = {
      schemaVersion: 1,
      kind: "legitimate-core-restart",
      core,
      dbPath,
      pipe,
      firstNonce,
      secondNonce,
      killedFirst,
      duplicateResult,
      afterDuplicate: { epochs: afterDuplicate.epochs, receipts: afterDuplicate.receipts, readyReceipts: afterDuplicate.readyReceipts },
      whileLiveResult,
      afterWhileLive: { epochs: afterWhileLive.epochs, receipts: afterWhileLive.receipts, readyReceipts: afterWhileLive.readyReceipts },
      endedObservationRetries,
      replayResult,
      afterReplay: { epochs: afterReplay.epochs, receipts: afterReplay.receipts, readyReceipts: afterReplay.readyReceipts },
      state,
      race,
      faultMatrix,
      checks,
      status: Object.values(checks).every(Boolean) ? "PASS" : "UNMET"
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } finally {
    for (const child of active) {
      try { killOwned(child); } catch {}
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const argv = process.argv.slice(2);
    const core = resolve(flag(argv, "--core") || "");
    const dbPath = resolve(flag(argv, "--db") || "");
    const pipe = flag(argv, "--pipe");
    const reportPath = resolve(flag(argv, "--report") || "");
    if (!flag(argv, "--core") || !flag(argv, "--db") || !pipe || !flag(argv, "--report")) {
      throw new Error("--core, --db, --pipe, and --report are required");
    }
    if (!existsSync(core)) throw new Error(`Core binary missing: ${core}`);
    const result = await runCoreRestart({ core, dbPath, pipe, reportPath });
    console.log(JSON.stringify({ status: result.status, reportPath, checks: result.checks }, null, 2));
    process.exitCode = result.status === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 2;
  }
}
