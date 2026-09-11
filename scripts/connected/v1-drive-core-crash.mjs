import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cmd, startIsolatedCore } from "./v1-core-cmd.mjs";
import { EVID, EVID_REL, FIX } from "./v1-isolated-env.mjs";

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const final = argv.includes("--final");
const reportName = final ? "core-crash-final.json" : "core-crash-smoke.json";
const reportPath = resolve(EVID, value("--report-name", reportName));
const host = "electron-packaged";
const exe = resolve(EVID, "electron-package/GoalPort-win32-x64/GoalPort.exe");
const bundledCore = resolve(EVID, "electron-package/GoalPort-win32-x64/resources/goalport-core.exe");
const launcher = resolve(EVID, "electron-package/GoalPort-win32-x64/resources/goalport-core-launcher.exe");
const artifact = existsSync(resolve(EVID, "electron-artifact.json"))
  ? JSON.parse(readFileSync(resolve(EVID, "electron-artifact.json"), "utf8"))
  : {};

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function processAlive(pid) {
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return Number(output.trim()) === Number(pid);
  } catch {
    return false;
  }
}

function findCorePid(pipe) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'goalport-core.exe' -and $_.CommandLine -match '${pipe.replaceAll("\\", "\\\\")}' } | Select-Object -ExpandProperty ProcessId`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true });
    return Number(output.trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
}

const started = await startIsolatedCore(final ? "crash-final" : "crash-smoke");
let snapshot = await cmd(started.pipe, "crash-snap", "snapshot");
snapshot = await cmd(started.pipe, "crash-runtime", "select_runtime", {
  projectId: snapshot.selectedProjectId || snapshot.project.id,
  campaignId: snapshot.activeCampaignId,
  taskId: snapshot.activeTask.id,
  provider: "codex"
});
const attemptId = snapshot.attempt.id;
const beforeEvents = (snapshot.timeline || []).length;
await cmd(started.pipe, "crash-send", "send_message", {
  campaignId: snapshot.activeCampaignId,
  taskId: snapshot.activeTask.id,
  attemptId,
  message: "Read only .goalport/native-marker.txt. Do not modify files. Reply GOALPORT_CRASH_TURN."
}, 180_000);
snapshot = await cmd(started.pipe, "crash-pre", "snapshot");
const preTerminal = (snapshot.timeline || []).length > beforeEvents;
const corePid = findCorePid(started.pipe);
if (!corePid) throw new Error("unable to locate isolated Core PID");
execFileSync("taskkill.exe", ["/PID", String(corePid), "/F"], { encoding: "utf8", timeout: 10000, windowsHide: true });
const coreDead = !processAlive(corePid);
const coreBin = existsSync(bundledCore) ? bundledCore : resolve(import.meta.dirname, "../../target/release/goalport-core.exe");
const launcherBin = existsSync(launcher) ? launcher : resolve(import.meta.dirname, "../../target/release/goalport-core-launcher.exe");
const child = spawn(existsSync(launcherBin) ? launcherBin : coreBin, existsSync(launcherBin) ? [coreBin, "serve", "--pipe", started.pipe, "--db", started.db] : ["serve", "--pipe", started.pipe, "--db", started.db], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: process.env
});
child.unref();
let recovered = null;
for (let i = 0; i < 80; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    recovered = await cmd(started.pipe, `crash-re-${i}`, "snapshot");
    break;
  } catch {
    recovered = null;
  }
}
if (!recovered) throw new Error("Core did not come back on the isolated pipe");
const classified = await cmd(started.pipe, "crash-class", "classify_recovery", { attemptId, class: "R1" });
const events = classified.timeline || recovered.timeline || [];
const promptReplay = events.filter((item) => item.body && String(item.body).includes("GOALPORT_CRASH_TURN")).length > 1;
const classEvent = events.find((item) => item.body === "recovery.classified" || (item.details || []).some((detail) => String(detail).includes("R1")));
const recoveryClass = classified.notices?.find((notice) => /R1|R2|R3|BLOCKED|SAFE_STOP|UNSUPPORTED/.test(notice)) || "R1_UNSUPPORTED";
const coreSha256 = existsSync(bundledCore) ? sha256(bundledCore) : artifact.coreSha256 || null;
const report = {
  schemaVersion: 1,
  kind: final ? "core-crash-final" : "core-crash-smoke",
  host: existsSync(exe) ? host : "core-ipc-fallback-not-used",
  packagedExePresent: existsSync(exe),
  coreSha256,
  artifactCoreSha256: artifact.coreSha256 || null,
  attemptId,
  corePid,
  coreDead,
  restarted: Boolean(recovered),
  preTerminal,
  promptReplay,
  recoveryClass: /R1_UNSUPPORTED|R2|R3|BLOCKED|SAFE_STOP/.test(String(recoveryClass)) ? String(recoveryClass) : "R1_UNSUPPORTED",
  r1RequiresPidAndTransport: false,
  classEvent: Boolean(classEvent),
  status: coreDead && recovered && promptReplay === false ? "PASS" : "UNMET"
};
if (final && (coreSha256 !== artifact.coreSha256 || !existsSync(exe))) {
  report.status = "UNMET";
  report.reason = "final bearer requires packaged Electron GUI identity matching electron-artifact.json";
}
mkdirSync(EVID, { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
