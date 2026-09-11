import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVID_REL } from "./v1-isolated-env.mjs";

const argv = process.argv.slice(2);
const value = (n, fallback) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fallback;
};
const root = resolve(import.meta.dirname, "../..");
const electronPid = Number(value("--electron-pid"));
const corePid = Number(value("--core-pid"));
const runtimePid = Number(value("--runtime-pid"));
const reportPath = resolve(root, value("--report", `${EVID_REL}/final-process-tree.json`));
const operationId = value("--operation-id", `process-tree-${process.pid}`);
const coreBuildId = value("--core-build-id", "");

const ps = (script) => {
  const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  const parsed = text.trim() ? JSON.parse(text) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
};
const processes = ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress");
const perf = ps("Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,PercentProcessorTime,WorkingSet | ConvertTo-Json -Compress");
const byPerf = new Map(perf.map((x) => [Number(x.IDProcess), x]));
const descendants = (pid) => {
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of processes) {
      if (ids.has(Number(p.ParentProcessId)) && !ids.has(Number(p.ProcessId))) {
        ids.add(Number(p.ProcessId));
        changed = true;
      }
    }
  }
  return ids;
};
const eIds = Number.isFinite(electronPid) ? descendants(electronPid) : new Set();
const cIds = Number.isFinite(corePid) ? descendants(corePid) : new Set();
const row = (p, role) => {
  const m = byPerf.get(Number(p.ProcessId)) || {};
  return {
    pid: Number(p.ProcessId),
    parentPid: Number(p.ParentProcessId),
    name: p.Name,
    role,
    rssBytes: Number(m.WorkingSet || 0),
    cpuPercent: Number(m.PercentProcessorTime || 0)
  };
};
const electron = processes
  .filter((p) => eIds.has(Number(p.ProcessId)) && String(p.Name).toLowerCase() === "goalport.exe")
  .map((p) => row(p, Number(p.ProcessId) === electronPid ? "electron-main" : String(p.CommandLine || "").includes("--type=renderer") ? "electron-renderer" : String(p.CommandLine || "").includes("--type=gpu") ? "electron-gpu" : "electron-utility"));
const coreProcess = processes.find((p) => Number(p.ProcessId) === corePid);
const runtimeProcess = processes.find((p) => Number(p.ProcessId) === runtimePid);
const core = coreProcess ? row(coreProcess, "shared-core") : null;
const nativeCli = runtimeProcess && cIds.has(runtimePid) ? [row(runtimeProcess, "native-cli")] : [];
const sum = (rows) => rows.reduce((n, x) => n + x.rssBytes, 0);
const sha = (p) => {
  const file = resolve(root, p);
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
};
const report = {
  schemaVersion: 2,
  kind: "final-electron-process-tree",
  operationId,
  capturedAtUtc: new Date().toISOString(),
  coreBuildId,
  artifacts: {
    electronExe: sha(`${EVID_REL}/electron-package/GoalPort-win32-x64/GoalPort.exe`),
    electronAsar: sha(`${EVID_REL}/electron-package/GoalPort-win32-x64/resources/app.asar`),
    coreExe: sha("target/release/goalport-core.exe")
  },
  electron: { processes: electron, rssBytes: sum(electron) },
  sharedCore: core,
  nativeCli,
  nativeCliRssBytes: sum(nativeCli),
  status: electron.length >= 1 && core && (runtimePid ? nativeCli.length === 1 : true) ? "PASS" : "UNMET"
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
