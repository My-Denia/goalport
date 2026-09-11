import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cmd, startIsolatedCore } from "./v1-core-cmd.mjs";
import { EVID, FIX } from "./v1-isolated-env.mjs";
import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";

const operationId = requireOperationId();

function processAlive(pid) {
  if (!pid) return false;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return Number(output.trim()) === Number(pid);
  } catch {
    return false;
  }
}

function descendants(corePid, name) {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress";
  const parsed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true }) || "[]");
  const all = Array.isArray(parsed) ? parsed : [parsed];
  const ids = new Set([Number(corePid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of all) {
      if (ids.has(Number(row.ParentProcessId)) && !ids.has(Number(row.ProcessId))) {
        ids.add(Number(row.ProcessId));
        changed = true;
      }
    }
  }
  return all.filter((row) => ids.has(Number(row.ProcessId)) && String(row.Name || "").toLowerCase() === name).map((row) => Number(row.ProcessId));
}

function findCorePid(pipe) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'goalport-core.exe' -and $_.CommandLine -match '${String(pipe).replaceAll("\\", "\\\\")}' } | Select-Object -ExpandProperty ProcessId`;
  try {
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true }).trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
}

const marker = resolve(FIX, ".goalport/native-marker.txt");
const before = existsSync(marker) ? statSync(marker) : null;
const started = await startIsolatedCore("dur-02");
let snapshot = await cmd(started.pipe, "dur02-snap", "snapshot");
snapshot = await cmd(started.pipe, "dur02-runtime", "select_runtime", {
  projectId: snapshot.selectedProjectId || snapshot.project.id,
  campaignId: snapshot.activeCampaignId,
  taskId: snapshot.activeTask.id,
  provider: "codex"
});
const attemptId = snapshot.attempt.id;
const corePid = findCorePid(started.pipe);
await cmd(started.pipe, `dur02-write-${operationId}`, "send_message", {
  campaignId: snapshot.activeCampaignId,
  taskId: snapshot.activeTask.id,
  attemptId,
  message: "Create or overwrite .goalport/dur-02-write.txt in this workspace with the text GOALPORT_DUR02_WRITE. Then stop."
}, 180_000);
const written = resolve(FIX, ".goalport/dur-02-write.txt");
const deadline = Date.now() + 120_000;
while (Date.now() < deadline && !existsSync(written)) {
  await cmd(started.pipe, `dur02-poll-${operationId}`, "snapshot");
  await new Promise((r) => setTimeout(r, 500));
}
const fileChanged = existsSync(written) || (existsSync(marker) && before && statSync(marker).mtimeMs !== before.mtimeMs);
const runtimePids = corePid ? descendants(corePid, "codex.exe") : [];
function emit(semantic) {
  const { report } = writeBearer({
    evid: EVID,
    evidenceClass: "dur-02",
    bearerBasename: "dur-02-runtime-exit.json",
    semantic,
    operationId,
    extraIdentity: { host: "electron-packaged" }
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : 1;
}
if (runtimePids.length === 0) {
  emit({
    schemaVersion: 1,
    kind: "dur-02-runtime-exit",
    status: "UNMET",
    reason: fileChanged
      ? "native Runtime write was not attributable to a live Codex child PID"
      : "Codex did not produce .goalport/dur-02-write.txt (or observed mtime) before timeout",
    fileChanged,
    corePid,
    capability: fileChanged ? "attribution" : "runtime-write"
  });
  process.exit(1);
}
if (!fileChanged) {
  emit({
    schemaVersion: 1,
    kind: "dur-02-runtime-exit",
    status: "UNMET",
    reason: "real .goalport/dur-02-write.txt (or marker mtime) was not observed before killing Codex child",
    fileChanged: false,
    corePid,
    runtimePids,
    capability: "runtime-write"
  });
  process.exit(1);
}
for (const pid of runtimePids) {
  execFileSync("taskkill.exe", ["/PID", String(pid), "/F"], { encoding: "utf8", timeout: 10000, windowsHide: true });
}
await cmd(started.pipe, "dur02-mark", "mark_runtime_exit", { attemptId });
let secondBlocked = false;
try {
  await cmd(started.pipe, "dur02-second", "select_runtime", {
    projectId: snapshot.selectedProjectId || snapshot.project.id,
    campaignId: snapshot.activeCampaignId,
    taskId: snapshot.activeTask.id,
    provider: "codex",
    attemptId: `attempt-dur02-takeover-${operationId}`
  });
} catch (error) {
  secondBlocked = /lease|UNCERTAIN|conflict|blocked/i.test(String(error.message || error));
}
emit({
  schemaVersion: 1,
  kind: "dur-02-runtime-exit",
  attemptId,
  fileChanged,
  writtenPath: existsSync(written) ? written : null,
  runtimePids,
  runtimePidGone: runtimePids.every((pid) => !processAlive(pid)),
  corePid,
  coreAlive: processAlive(corePid),
  lease: "UNCERTAIN",
  secondMutatingAcquireFailed: secondBlocked,
  status: fileChanged && runtimePids.every((pid) => !processAlive(pid)) && processAlive(corePid) && secondBlocked ? "PASS" : "UNMET"
});
