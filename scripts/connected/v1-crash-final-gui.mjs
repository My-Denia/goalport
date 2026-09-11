import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVID, RUN_SLUG } from "./v1-isolated-env.mjs";
import { attachGoalPort } from "./v1-cdp.mjs";
import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";

const operationId = requireOperationId();
const port = Number(process.env.GOALPORT_GUI_PORT || 19222);
const artifact = JSON.parse(readFileSync(resolve(EVID, "electron-artifact.json"), "utf8"));
const bundledCore = resolve(EVID, "electron-package/GoalPort-win32-x64/resources/goalport-core.exe");
const coreSha256 = createHash("sha256").update(readFileSync(bundledCore)).digest("hex");

function corePids() {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'goalport-core.exe' -and ($_.ExecutablePath -match '${RUN_SLUG}' -or $_.CommandLine -match '${RUN_SLUG}') } | Select-Object ProcessId | ConvertTo-Json -Compress`;
  try {
    const parsed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true }) || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => Number(row.ProcessId)).filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

function alive(pid) {
  try {
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim()) === pid;
  } catch {
    return false;
  }
}

const { evaluate, close } = await attachGoalPort(port);
const before = await evaluate("window.goalportCore.snapshot()", true);
await evaluate(`window.goalportCore.command({protocolVersion:'goalport.ipc.v2',requestId:'crash-runtime-${operationId}',entityVersion:0,messageType:'select_runtime',payload:{projectId:${JSON.stringify(before.selectedProjectId || before.project?.id)},campaignId:${JSON.stringify(before.activeCampaignId)},taskId:${JSON.stringify(before.activeTask?.id)},provider:'codex'}})`, true);
const afterSelect = await evaluate("window.goalportCore.snapshot()", true);
await evaluate(`window.goalportCore.command({protocolVersion:'goalport.ipc.v2',requestId:'crash-send-${operationId}',entityVersion:0,messageType:'send_message',payload:{campaignId:${JSON.stringify(afterSelect.activeCampaignId)},taskId:${JSON.stringify(afterSelect.activeTask?.id)},attemptId:${JSON.stringify(afterSelect.attempt?.id)},message:'Read .goalport/native-marker.txt without modifying files. Reply GOALPORT_CRASH_TURN.'}})`, true);
await new Promise((r) => setTimeout(r, 3000));
const pre = await evaluate("window.goalportCore.snapshot()", true);
const pids = corePids();
for (const pid of pids) {
  execFileSync("taskkill.exe", ["/PID", String(pid), "/F"], { encoding: "utf8", timeout: 10000, windowsHide: true });
}
const dead = pids.every((pid) => !alive(pid));
let recovered = null;
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    recovered = await evaluate("window.goalportCore.startCore().then(()=>window.goalportCore.snapshot())", true);
    if (recovered?.connection === "connected") break;
  } catch {
    recovered = null;
  }
}
let classified = recovered;
try {
  classified = await evaluate(`window.goalportCore.command({protocolVersion:'goalport.ipc.v2',requestId:'crash-class-${operationId}',entityVersion:0,messageType:'classify_recovery',payload:{attemptId:${JSON.stringify(afterSelect.attempt?.id)},class:'R1'}})`, true);
} catch {
  classified = recovered;
}
close();
const promptReplay = (classified?.timeline || []).filter((item) => String(item.body || "").includes("GOALPORT_CRASH_TURN")).length > 1;
const semantic = {
  schemaVersion: 1,
  kind: "core-crash-final",
  packagedExePresent: existsSync(resolve(EVID, "electron-package/GoalPort-win32-x64/GoalPort.exe")),
  attemptId: afterSelect.attempt?.id,
  coreDead: dead,
  restarted: recovered?.connection === "connected",
  preTerminal: (pre?.timeline || []).length > (before?.timeline || []).length,
  promptReplay: Boolean(promptReplay),
  recoveryClass: pids.length > 0 && recovered?.connection === "connected" && pids.some((pid) => alive(pid)) ? "R1" : "R1_UNSUPPORTED",
  r1RequiresPidAndTransport: true,
  status: dead && recovered?.connection === "connected" && !promptReplay && coreSha256 === artifact.coreSha256 ? "PASS" : "UNMET"
};
const { report } = writeBearer({
  evid: EVID,
  evidenceClass: "dur-03",
  bearerBasename: "core-crash-final.json",
  semantic,
  operationId,
  extraIdentity: {
    host: "electron-packaged",
    coreSha256,
    artifactCoreSha256: artifact.coreSha256,
    exeSha256: artifact.exeSha256,
    corePidsBefore: pids
  }
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
