import { execFileSync } from "node:child_process";
import { requireOperationId, writeBearer } from "./v1-closure-rawrun.mjs";
import { command, withPackagedGui } from "./v1-closure-gui.mjs";
import { EVID } from "./v1-isolated-env.mjs";

const operationId = requireOperationId();
const port = Number(process.env.GOALPORT_GUI_PORT || 19246);

function vscodePid() {
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' } | Select-Object -First 1 -ExpandProperty ProcessId"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const pid = Number(output.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim()) === Number(pid);
  } catch {
    return false;
  }
}

const existingVsCode = vscodePid();
process.env.GOALPORT_RESOURCE_PRESSURE = "1";
const { report } = await withPackagedGui(port, async ({ evaluate }) => {
  let snapshot = await evaluate("window.goalportCore.snapshot()", true);
  const seedAttempt = snapshot.attempt.id;
  snapshot = await command(evaluate, "select_runtime", {
    projectId: snapshot.selectedProjectId || snapshot.project.id,
    campaignId: snapshot.activeCampaignId,
    taskId: snapshot.activeTask.id,
    provider: "scenario",
    attemptId: `attempt-queued-${operationId}`,
    resourcePressure: true
  });
  const queued = (snapshot.notices || []).some((notice) => /queued under resource pressure|Queued under resource pressure/i.test(notice));
  const firstAttempt = seedAttempt;
  const existingRuntimePreserved = snapshot.attempt.id === firstAttempt;
  const queueId = (snapshot.notices || [])
    .map((notice) => String(notice))
    .map((notice) => notice.startsWith("Queued under resource pressure: ") ? notice.slice("Queued under resource pressure: ".length) : null)
    .find(Boolean);
  let admittedAttempt = null;
  if (queueId) {
    snapshot = await command(evaluate, "queue_override", { queueId, reason: "explicit-owner-override" });
    admittedAttempt = snapshot.attempt && snapshot.attempt.id;
  }
  const admitted = admittedAttempt === `attempt-queued-${operationId}`;
  const vscode = existingVsCode ? { pid: existingVsCode, survived: processAlive(existingVsCode) } : { vscode_absent: true };
  const semantic = {
    schemaVersion: 1,
    kind: "resource-queue",
    firstAttempt,
    queued,
    queueId,
    vscode,
    existingRuntimePreserved,
    overrideAuditable: Boolean(queueId),
    admitted,
    admittedAttempt,
    status: queued && existingRuntimePreserved && admitted && (existingVsCode ? processAlive(existingVsCode) : true) ? "PASS" : "UNMET"
  };
  return writeBearer({
    evid: EVID,
    evidenceClass: "res-01",
    bearerBasename: "resource-queue.json",
    semantic,
    operationId,
    extraIdentity: { host: "electron-packaged" }
  });
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
