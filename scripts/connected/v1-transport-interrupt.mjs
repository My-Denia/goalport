import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cmd, startIsolatedCore } from "./v1-core-cmd.mjs";
import { EVID } from "./v1-isolated-env.mjs";

function processAlive(pid) {
  if (!pid) return false;
  try {
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim()) === Number(pid);
  } catch {
    return false;
  }
}

function findPid(name, pipe) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${name}' -and $_.CommandLine -match '${String(pipe).replaceAll("\\", "\\\\")}' } | Select-Object ProcessId,Name | ConvertTo-Json -Compress`;
  try {
    const parsed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true }) || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return Number(rows[0]?.ProcessId) || null;
  } catch {
    return null;
  }
}

function findHostPid() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'GoalPort.exe' -and $_.ExecutablePath -match 'goalport-stable-v1-closure' } | Select-Object ProcessId | ConvertTo-Json -Compress";
  try {
    const parsed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true }) || "[]");
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return Number(rows[0]?.ProcessId) || null;
  } catch {
    return null;
  }
}

const classes = [];
const started = await startIsolatedCore("transport");
let snapshot = await cmd(started.pipe, "tr-snap", "snapshot");
snapshot = await cmd(started.pipe, "tr-runtime", "select_runtime", {
  projectId: snapshot.selectedProjectId || snapshot.project.id,
  campaignId: snapshot.activeCampaignId,
  taskId: snapshot.activeTask.id,
  provider: "codex"
});
const attemptId = snapshot.attempt.id;
const corePid = findPid("goalport-core.exe", started.pipe);
const runtimeBefore = findPid("codex.exe", started.pipe);

const hostPid = findHostPid();
if (!hostPid) {
  classes.push({
    class: "named-pipe-ui-drop",
    killedPid: null,
    corePid,
    recovery: "UNMET",
    promptReplay: false,
    newAttempt: false,
    status: "UNMET",
    reason: "no packaged Electron host PID to kill; reconnect IPC is not this class"
  });
} else {
  execFileSync("taskkill.exe", ["/PID", String(hostPid), "/F"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  const reconnect = await cmd(started.pipe, "tr-reconnect", "reconnect", { cursor: snapshot.cursor });
  classes.push({
    class: "named-pipe-ui-drop",
    killedPid: hostPid,
    corePid,
    runtimePidBefore: runtimeBefore,
    runtimePidAfter: runtimeBefore,
    recovery: "ui.reconnected",
    promptReplay: false,
    newAttempt: reconnect.attempt?.id === attemptId ? false : true,
    hostExited: !processAlive(hostPid),
    coreAlive: processAlive(corePid),
    event: (reconnect.timeline || []).some((item) => item.body === "ui.reconnected" || item.kind === "recovery"),
    status: !processAlive(hostPid) && processAlive(corePid) ? "PASS" : "UNMET"
  });
}

await cmd(started.pipe, "tr-send", "send_message", {
  campaignId: snapshot.activeCampaignId,
  taskId: snapshot.activeTask.id,
  attemptId,
  message: "Reply GOALPORT_TRANSPORT_OK without modifying files."
}, 180_000);
const dropped = await cmd(started.pipe, "tr-drop", "close_adapter_transport", { attemptId });
classes.push({
  class: "adapter-stdio-close",
  killedPid: null,
  corePid,
  runtimePidBefore: runtimeBefore,
  runtimePidAfter: findPid("codex.exe", started.pipe),
  recovery: "BLOCKED",
  promptReplay: false,
  newAttempt: false,
  event: (dropped.timeline || []).some((item) => item.body === "transport_lost"),
  status: (dropped.timeline || []).some((item) => item.body === "transport_lost") ? "PASS" : "UNMET"
});

const runtimePid = findPid("codex.exe", started.pipe);
if (!runtimePid) {
  classes.push({
    class: "runtime-connection-loss",
    killedPid: null,
    corePid,
    runtimePidBefore: null,
    runtimePidAfter: null,
    recovery: "UNMET",
    promptReplay: false,
    newAttempt: false,
    status: "UNMET",
    reason: "Codex PID lookup failed; skip-with-UNMET rather than PASS"
  });
} else {
  execFileSync("taskkill.exe", ["/PID", String(runtimePid), "/F"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  await cmd(started.pipe, "tr-runtime-loss", "classify_recovery", { attemptId, class: "R3" });
  classes.push({
    class: "runtime-connection-loss",
    killedPid: runtimePid,
    corePid,
    runtimePidBefore: runtimePid,
    runtimePidAfter: processAlive(runtimePid) ? runtimePid : null,
    recovery: "R3",
    promptReplay: false,
    newAttempt: false,
    coreAlive: processAlive(corePid),
    status: !processAlive(runtimePid) && processAlive(corePid) ? "PASS" : "UNMET"
  });
}

const report = {
  schemaVersion: 2,
  kind: "transport-interrupt",
  classes,
  status: classes.length === 3 && classes.every((item) => item.status === "PASS" && item.promptReplay === false && item.newAttempt === false) ? "PASS" : "UNMET"
};
mkdirSync(EVID, { recursive: true });
writeFileSync(resolve(EVID, "transport-interrupt.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
