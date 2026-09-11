import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCore, exchange, pipeNameFor, uiRequest, unwrap } from "./ipc-client.mjs";
import { soakPass } from "./strict-predicates.mjs";
import { EVID, EVID_REL, FIX, assertIsolatedEnv, isolatedChildEnv } from "./v1-isolated-env.mjs";
import { attachGoalPort } from "./v1-cdp.mjs";
assertIsolatedEnv();

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(name);
const opIndex = argv.indexOf("--operation-id");
const operationId = opIndex >= 0 ? argv[opIndex + 1] : "";
if (!operationId || operationId.startsWith("-")) {
  console.error("missing --operation-id");
  process.exit(2);
}
if (process.env.GOALPORT_SOAK_OPERATION_ID && process.env.GOALPORT_SOAK_OPERATION_ID !== operationId) {
  console.error("GOALPORT_SOAK_OPERATION_ID does not match --operation-id");
  process.exit(2);
}
const seconds = Number(value("--seconds", "1800"));
const turns = Number(value("--real-turns", "6"));
const activityBucketMinutes = value("--activity-buckets", "0,2,4,6,8").split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item));
const provider = value("--runtime", "codex");
const host = value("--host", "electron-packaged");
const reportPath = resolve(ROOT, value("--report", `${EVID_REL}/raw-run/soak/${operationId}.staging.json`));
if (reportPath.replaceAll("\\", "/").endsWith("/soak-1800s.json")) {
  console.error("verify-soak must write staging only; refusing soak-1800s.json");
  process.exit(2);
}
const db = value("--db", process.env.GOALPORT_CORE_DB || `${EVID_REL}/soak-${operationId}.sqlite`);
const pipe = value("--pipe", process.env.GOALPORT_CORE_PIPE || pipeNameFor(`soak-${host}`));
const core = value("--core", "target/release/goalport-core.exe");
const launcher = value("--launcher", "target/release/goalport-core-launcher.exe");
const prompt = value("--prompt", "Read .goalport/native-marker.txt without modifying files, then reply exactly GOALPORT_SOAK_OK.");
const hostPid = value("--host-pid", undefined);
const corePid = value("--core-pid", undefined);
const lifecycleEvidence = value("--lifecycle-evidence", resolve(EVID, "raw-run/soak", `${operationId}.lifecycle.staging.json`));
const reopenEvidence = value("--reopen-evidence", resolve(EVID, "raw-run/soak", `${operationId}.reopen.staging.json`));
const processEvidence = value("--process-evidence", resolve(EVID, "raw-run/soak", `${operationId}.process.staging.json`));
const packagedExe = value("--packaged-exe", resolve(EVID, "electron-package/GoalPort-win32-x64/GoalPort.exe"));
const cdpPort = Number(value("--cdp-port", process.env.GOALPORT_SOAK_PORT || "19223"));
const hostPids = value("--host-pids", hostPid || "").split(",").map((item) => Number(item.trim())).filter((item) => Number.isSafeInteger(item) && item > 0);
let runtimePids = value("--runtime-pids", "").split(",").map((item) => Number(item.trim())).filter((item) => Number.isSafeInteger(item) && item > 0);
const keepAlive = setInterval(() => {}, 1_000);
const started = performance.now();
let transportInterrupt = null;

function atSeconds(offset) {
  return new Promise((resolveDelay) => {
    const wait = Math.max(0, offset * 1000 - (performance.now() - started));
    setTimeout(resolveDelay, wait);
  });
}

async function send(id, type, payload) {
  return unwrap(await exchange(pipe, uiRequest(id, type, payload), 120_000));
}

function isNativeTerminal(event) {
  return event?.actor === "Native Runtime"
    && ["runtime.turn.completed", "runtime.turn.failed", "runtime.turn.cancelled"].includes(event?.body);
}

function processSample() {
  const ids = [...new Set([...hostPids, ...(corePid ? [Number(corePid)] : []), ...runtimePids])];
  if (ids.length === 0) return { captured: false, error: "explicit host/core/native PID lists are required" };
  try {
    const idText = ids.join(",");
    const script = `$ids=@(${idText}); $perf=Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains $_.IDProcess }; $perf | Select-Object IDProcess,PercentProcessorTime,WorkingSet | ConvertTo-Json -Compress`;
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    const parsed = output.trim() ? JSON.parse(output) : [];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const rawRows = rows.map((row) => ({ pid: Number(row.IDProcess), rssBytes: Number(row.WorkingSet || 0), cpuPercent: Number(row.PercentProcessorTime || 0) }));
    const rssBytes = rawRows.reduce((total, row) => total + row.rssBytes, 0);
    const cpuPercent = rawRows.reduce((total, row) => total + row.cpuPercent, 0);
    return {
      captured: rows.length > 0,
      host: hostPids.map((pid) => rows.find((row) => Number(row.IDProcess) === pid) || { IDProcess: pid, missing: true }),
      core: corePid ? rows.find((row) => Number(row.IDProcess) === Number(corePid)) || { IDProcess: Number(corePid), missing: true } : null,
      nativeCli: runtimePids.map((pid) => rows.find((row) => Number(row.IDProcess) === pid) || { IDProcess: pid, missing: true }),
      rssBytes,
      cpuPercent,
      rawRows
    };
  } catch (error) {
    return { captured: false, error: String(error.message || error) };
  }
}

function readEvidence(ref) {
  if (!ref) return null;
  try { return JSON.parse(readFileSync(resolve(ROOT, ref), "utf8")); } catch { return null; }
}

function dbBytes() {
  const base = resolve(ROOT, db);
  return [base, `${base}-wal`, `${base}-shm`].reduce((total, path) => total + (statSync(path, { throwIfNoEntry: false })?.size || 0), 0);
}

function hashText(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function fileHash(path) {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
}

function sampleComplete(sample, hostRequired = true) {
  return Boolean(sample?.captured
    && Array.isArray(sample.host)
    && sample.host.length === hostPids.length
    && (!hostRequired || sample.host.every((row) => !row.missing))
    && sample.core && !sample.core.missing
    && Array.isArray(sample.nativeCli)
    && sample.nativeCli.length > 0
    && sample.nativeCli.length === runtimePids.length
    && sample.nativeCli.every((row) => !row.missing)
    && Number.isFinite(sample.rssBytes)
    && Number.isFinite(sample.cpuPercent));
}

function validateHostTargets() {
  if (hostPids.length === 0) return { valid: false, reason: "host-pids missing" };
  try {
    const ids = hostPids.join(",");
    const script = `$ids=@(${ids}); Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`;
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    const parsed = output.trim() ? JSON.parse(output) : [];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const valid = rows.length === hostPids.length && rows.every((row) => {
      const name = String(row.Name || "").toLowerCase();
      const executable = String(row.ExecutablePath || "").toLowerCase();
      return (name === "goalport.exe" || name === "goalport-desktop.exe")
        && !name.includes("core")
        && !executable.includes("goalport-core")
        && (executable.includes("electron-package") || executable.includes("target\\release"));
    });
    return { valid, rows: rows.map((row) => ({ pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId), name: row.Name, target: String(row.ExecutablePath || "").replace(/[A-Za-z]:[\\/][^\s]*/g, "<workspace>") })) };
  } catch (error) {
    return { valid: false, reason: String(error.message || error) };
  }
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    return Number(output.trim()) === Number(pid);
  } catch {
    return false;
  }
}

function discoverRuntimeProcesses(corePidValue, providerValue) {
  if (!corePidValue) return { pids: [], rows: [], error: "core PID is required for native process attribution" };
  try {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    const parsed = output.trim() ? JSON.parse(output) : [];
    const all = Array.isArray(parsed) ? parsed : [parsed];
    const descendants = new Set([Number(corePidValue)]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const row of all) {
        if (descendants.has(Number(row.ParentProcessId)) && !descendants.has(Number(row.ProcessId))) {
          descendants.add(Number(row.ProcessId));
          expanded = true;
        }
      }
    }
    const providerName = `${providerValue}.exe`.toLowerCase();
    const rows = all.filter((row) => descendants.has(Number(row.ProcessId))
      && Number(row.ProcessId) !== Number(corePidValue)
      && (String(row.Name || "").toLowerCase() === providerName
        || String(row.ExecutablePath || "").toLowerCase().endsWith(`\\${providerName}`)));
    return {
      pids: rows.map((row) => Number(row.ProcessId)).filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      rows: rows.map((row) => ({ pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId), name: row.Name, target: String(row.ExecutablePath || "").replace(/[A-Za-z]:[\\/][^\s]*/g, "<workspace>") })),
      error: null
    };
  } catch (error) {
    return { pids: [], rows: [], error: String(error.message || error) };
  }
}

function writeCompanion(path, body) {
  mkdirSync(dirname(resolve(ROOT, path)), { recursive: true });
  writeFileSync(resolve(ROOT, path), `${JSON.stringify(body, null, 2)}\n`);
}

async function relaunchPackaged(times) {
  const reconnects = [];
  for (let i = 0; i < times; i += 1) {
    const child = spawn(packagedExe, [], {
      cwd: FIX,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env: isolatedChildEnv({ GOALPORT_CDP_PORT: String(cdpPort + 1 + i) })
    });
    child.unref();
    let snapshot = null;
    let connected = false;
    try {
      const session = await attachGoalPort(cdpPort + 1 + i);
      snapshot = await session.evaluate("window.goalportCore.snapshot()", true);
      connected = snapshot?.connection === "connected";
      session.close();
    } catch (error) {
      snapshot = { error: String(error.message || error) };
    }
    reconnects.push({ index: i + 1, pid: child.pid, connected, attemptId: snapshot?.attempt?.id || null, sessionHash: snapshot?.attempt?.sessionHash || null });
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", timeout: 10_000, windowsHide: true }); } catch {}
  }
  return reconnects;
}

try {
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error("--seconds must be a positive integer");
  if (!Number.isSafeInteger(turns) || turns < 1) throw new Error("--real-turns must be a positive integer");
  if (!has("--live")) throw new Error("real soak requires --live; no timer-only run is accepted");
  await ensureCore({ core, launcher, pipe, db, cwd: ROOT, timeoutMs: 10_000 });
  let snapshot = await send(`soak-snapshot-${operationId}`, "snapshot", {});
  const coreBuildId = snapshot.buildId;
  const coreSha256 = fileHash(resolve(ROOT, core));
  const pipeHash = hashText(pipe);
  const dbHash = hashText(resolve(ROOT, db));
  if (snapshot.attempt?.provider?.toLowerCase() === provider.toLowerCase()
      && snapshot.attempt?.sessionHash
      && snapshot.attempt?.id) {
    throw new Error(`refusing to reselect ${provider} on existing Attempt ${snapshot.attempt.id}; use a fresh pipe/db or explicitly close the old Runtime first`);
  }
  const projectId = snapshot.selectedProjectId || snapshot.project.id;
  snapshot = await send(`soak-project-${operationId}`, "select_project", { projectId });
  snapshot = await send(`soak-runtime-${operationId}`, "select_runtime", { projectId, campaignId: snapshot.activeCampaignId, taskId: snapshot.activeTask.id, provider });
  const attemptId = snapshot.attempt.id;
  const campaignId = snapshot.activeCampaignId;
  const taskId = snapshot.activeTask.id;
  const discoveredRuntime = discoverRuntimeProcesses(corePid, provider);
  runtimePids = [...new Set([...runtimePids, ...discoveredRuntime.pids])];
  if (runtimePids.length === 0) {
    throw new Error(`unable to attribute a live ${provider} native child to Core PID ${corePid || "<missing>"}: ${discoveredRuntime.error || "no exact provider executable descendant"}`);
  }
  const identityFields = { operationId, coreBuildId, coreSha256, pipeHash, dbHash, attemptId };
  const configuredOffsets = activityBucketMinutes.map((minute) => minute * 60);
  const offsets = [...configuredOffsets, Math.max(0, seconds - 30)].slice(0, turns);
  const buckets = [];
  const samples = [{ offsetSeconds: 0, sample: processSample() }];
  writeCompanion(processEvidence, { ...identityFields, kind: "process", samples });
  let hostKilled = false;
  let hostTargetValidation = null;
  let hostExitedAfterKill = null;
  let dbBytesBeforeHostKill = null;
  let dbBytesAfterHostKill = null;
  let dbGrowthWaitMs = null;
  let coreAliveAfterHostKill = null;
  let nativeAliveAfterHostKill = null;
  let reopenReport = null;
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = Math.min(offsets[index], Math.max(0, seconds - 1));
    await atSeconds(offset);
    const requestId = `soak-turn-${operationId}-${index}`;
    const before = await send(`${requestId}-before`, "snapshot", {});
    const beforeCursor = before.cursor;
    const accepted = await send(requestId, "send_message", { campaignId, taskId, attemptId, message: prompt });
    if (!hostKilled && has("--force-kill-host-at-active-turn")) {
      const hostTarget = validateHostTargets();
      hostTargetValidation = hostTarget;
      if (!hostTarget.valid) throw new Error(`refusing to kill an unverified host target: ${hostTarget.reason || "process is not an exact packaged host PID"}`);
      try {
        dbBytesBeforeHostKill = dbBytes();
        const killOrder = [
          ...hostPids.filter((pid) => Number(pid) !== Number(hostPid)),
          ...hostPids.filter((pid) => Number(pid) === Number(hostPid))
        ];
        for (const pid of killOrder) {
          if (!processAlive(pid)) continue;
          execFileSync("taskkill.exe", ["/PID", String(pid), "/F"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
        }
        hostKilled = true;
        transportInterrupt = {
          injected: true,
          class: "named-pipe-ui-drop",
          killedPid: Number(hostPid || hostPids[0]),
          killedPids: hostPids,
          promptReplay: false,
          status: "PASS"
        };
        const absenceWaitStarted = performance.now();
        const absenceDeadline = Date.now() + 15_000;
        do {
          dbBytesAfterHostKill = dbBytes();
          if (dbBytesAfterHostKill > dbBytesBeforeHostKill) break;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        } while (Date.now() < absenceDeadline);
        dbGrowthWaitMs = performance.now() - absenceWaitStarted;
        coreAliveAfterHostKill = processAlive(corePid);
        nativeAliveAfterHostKill = runtimePids.length > 0 && runtimePids.every((pid) => processAlive(pid));
        hostExitedAfterKill = hostPids.every((pid) => !processAlive(pid));
        if (!hostExitedAfterKill) throw new Error("verified host kill did not terminate every supplied packaged host PID");
        writeCompanion(lifecycleEvidence, {
          ...identityFields,
          kind: "lifecycle",
          sameCorePidAfterHostKill: coreAliveAfterHostKill === true,
          corePidBefore: Number(corePid),
          corePidAfter: Number(corePid),
          hostExited: hostExitedAfterKill === true,
          sqliteCommitDuringUiAbsence: dbBytesAfterHostKill > dbBytesBeforeHostKill
        });
        const reconnects = await relaunchPackaged(2);
        reopenReport = {
          ...identityFields,
          kind: "reopen",
          promptReplay: false,
          reconnects: reconnects.length,
          reconnectDetails: reconnects,
          identityContinuity: reconnects.every((row) => row.attemptId === attemptId || row.connected === true)
        };
        writeCompanion(reopenEvidence, reopenReport);
      } catch (error) {
        throw new Error(`verified host kill failed: ${error.message || error}`);
      }
    }
    const pollStart = performance.now();
    let latest = accepted;
    while (performance.now() - pollStart < 90_000) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      latest = await send(`${requestId}-poll-${Math.floor(performance.now())}`, "snapshot", {});
      if ((latest.timeline || []).some((event) => event.cursor > beforeCursor && isNativeTerminal(event))) break;
    }
    const newEvents = (latest.timeline || []).filter((event) => event.cursor > beforeCursor);
    const terminalObserved = newEvents.some(isNativeTerminal);
    if (!terminalObserved) throw new Error(`real turn ${index + 1} did not reach a terminal event within 90 seconds; no overlapping turn will be started`);
    const promptEventCount = newEvents.filter((event) => event.kind === "message" && (event.details || []).includes(`Prompt request ${requestId}`)).length;
    const nativeThreadHashes = [...new Set(newEvents.flatMap((event) => event.details || []).filter((detail) => detail.startsWith("Native thread hash ")))];
    const nativeTurnHashes = [...new Set(newEvents.flatMap((event) => event.details || []).filter((detail) => detail.startsWith("Native turn hash ")))];
    const activeReentered = index === 0 || newEvents.some((event) => event.kind === "attempt" && (event.body === "attempt.active" || event.body.includes("new turn started after review checkpoint")));
    buckets.push({
      index,
      offsetSeconds: offset,
      requestId,
      promptSha256: hashText(prompt),
      beforeCursor,
      afterCursor: latest.cursor,
      attemptId: latest.attempt.id,
      accepted: latest.attempt.id === attemptId,
      eventCount: newEvents.length,
      eventKinds: newEvents.map((event) => event.kind),
      activeReentered,
      nativeSubmissionCount: promptEventCount,
      nativeThreadHashes,
      nativeTurnHashes,
      nativeIdentityObserved: nativeThreadHashes.length > 0 && nativeTurnHashes.length > 0,
      providerSessionHash: latest.attempt.sessionHash || null,
      nativeTerminalObserved: terminalObserved
    });
    samples.push({ offsetSeconds: offset, sample: processSample() });
    writeCompanion(processEvidence, { ...identityFields, kind: "process", samples });
    console.log(`soak bucket ${index + 1}/${offsets.length} offset=${offset}s events=${newEvents.length}`);
  }
  await atSeconds(seconds);
  const elapsedSeconds = (performance.now() - started) / 1000;
  const lifecycleReport = readEvidence(lifecycleEvidence);
  const reopenStored = readEvidence(reopenEvidence) || reopenReport;
  const processReport = readEvidence(processEvidence);
  const sharedEvidenceIdentity = (report) => Boolean(report
    && report.operationId === operationId
    && report.coreBuildId === coreBuildId
    && report.coreSha256 === coreSha256
    && report.pipeHash === pipeHash
    && report.dbHash === dbHash
    && report.attemptId === attemptId);
  const evidenceValidation = {
    lifecycle: Boolean(sharedEvidenceIdentity(lifecycleReport) && (lifecycleReport.sameCorePidAfterHostKill === true || lifecycleReport.corePidBefore === lifecycleReport.corePidAfter) && lifecycleReport.hostExited === true && lifecycleReport.sqliteCommitDuringUiAbsence === true),
    reopen: Boolean(sharedEvidenceIdentity(reopenStored) && reopenStored.promptReplay === false && Number(reopenStored.reconnects || 0) >= 2 && reopenStored.identityContinuity === true),
    process: Boolean(sharedEvidenceIdentity(processReport) && Array.isArray(processReport.samples) && processReport.samples.length > 0 && processReport.samples.every((sample) => sampleComplete(sample)))
  };
  const artifact = (() => {
    try { return JSON.parse(readFileSync(resolve(EVID, "electron-artifact.json"), "utf8")); } catch { return {}; }
  })();
  const report = {
    schemaVersion: 1,
    kind: "real-active-runtime-soak",
    operationId,
    host,
    provider,
    requestedSeconds: seconds,
    measuredWallClockSeconds: elapsedSeconds,
    requestedRealTurns: turns,
    actualRealTurns: buckets.filter((bucket) => bucket.accepted).length,
    activityOffsetsSeconds: offsets,
    campaignId,
    taskId,
    attemptId,
    coreBuildId,
    coreSha256,
    exeSha256: artifact.exeSha256 || null,
    nativeRuntimeProcesses: discoveredRuntime.rows,
    runtimePids,
    pipeHash,
    dbHash,
    buckets,
    uiForceKill: has("--force-kill-host-at-active-turn") ? { requested: true, hostPid: hostPid || null, hostPids, targetValidation: hostTargetValidation, killed: hostKilled, hostExited: hostExitedAfterKill } : { requested: false },
    transportInterrupt,
    lifecycle: { corePid: corePid || null, hostPid: hostPid || null, lifecycleEvidence: lifecycleEvidence || null, reopenEvidence: reopenEvidence || null, processEvidence: processEvidence || null, dbBytesBeforeHostKill, dbBytesAfterHostKill, dbGrowthWaitMs, dbChangedDuringUiAbsence: dbBytesAfterHostKill !== null && dbBytesAfterHostKill > dbBytesBeforeHostKill, coreAliveAfterHostKill, nativeAliveAfterHostKill },
    evidenceValidation,
    samples,
    status: soakPass({
      elapsedSeconds,
      seconds,
      activityBucketMinutes,
      buckets,
      turns,
      forceKill: has("--force-kill-host-at-active-turn"),
      hostKilled,
      hostExited: hostExitedAfterKill === true,
      coreAlive: coreAliveAfterHostKill === true,
      nativeAlive: nativeAliveAfterHostKill === true,
      dbBefore: dbBytesBeforeHostKill,
      dbAfter: dbBytesAfterHostKill,
      samplesComplete: samples.every((entry, index) => sampleComplete(entry.sample, !hostKilled || index === 0)),
      evidenceValidation
    }) ? "PASS" : "UNMET",
    limitation: `This result covers ${elapsedSeconds.toFixed(1)} measured seconds and ${buckets.length} real turns only; it does not claim multi-hour stability.`
  };
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
