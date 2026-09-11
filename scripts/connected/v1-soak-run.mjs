import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EVID, FIX, ROOT, RUN_SLUG, isolatedChildEnv } from "./v1-isolated-env.mjs";

const seconds = Number(process.env.GOALPORT_SOAK_SECONDS || 1800);
const port = Number(process.env.GOALPORT_SOAK_PORT || 19223);
const exe = resolve(EVID, "electron-package/GoalPort-win32-x64/GoalPort.exe");
const heartbeat = resolve(EVID, "soak-heartbeat.log");
mkdirSync(EVID, { recursive: true });
if (!existsSync(exe)) throw new Error(`missing ${exe}`);

function beat(line) {
  appendFileSync(heartbeat, `${new Date().toISOString()} ${line}\n`);
}

function pidsNamed(name, match) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${name}' -and ($_.ExecutablePath -match '${match}' -or $_.CommandLine -match '${match}') } | Select-Object ProcessId | ConvertTo-Json -Compress`;
  try {
    const parsed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true }) || "[]");
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return rows.map((row) => Number(row.ProcessId)).filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

function cimForPid(pid) {
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const parsed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true }) || "{}");
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  return {
    ProcessId: Number(row?.ProcessId || pid),
    ExecutablePath: String(row?.ExecutablePath || ""),
    CommandLine: String(row?.CommandLine || "")
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const env = isolatedChildEnv({ GOALPORT_CDP_PORT: String(port) });
const electron = spawn(exe, [], { cwd: FIX, detached: true, stdio: "ignore", windowsHide: false, env });
electron.unref();

const deadline = Date.now() + 30_000;
let hostPids = [];
while (Date.now() < deadline) {
  hostPids = pidsNamed("GoalPort.exe", RUN_SLUG);
  if (hostPids.length > 0) break;
  await new Promise((r) => setTimeout(r, 250));
}
if (hostPids.length === 0) {
  process.exit(2);
}
const firstHostPid = hostPids[0];
const cimCapture = cimForPid(firstHostPid);
const unixMs = Date.now();
const operationId = "closure-" + firstHostPid + "-" + unixMs;

writeFileSync(heartbeat, `--operation-id ${operationId}\n`, { encoding: "utf8", flag: "w" });

const rawDir = resolve(EVID, "raw-run", "soak");
mkdirSync(rawDir, { recursive: true });
const stagingPath = resolve(rawDir, `${operationId}.staging.json`);
const lifecycleStaging = resolve(rawDir, `${operationId}.lifecycle.staging.json`);
const reopenStaging = resolve(rawDir, `${operationId}.reopen.staging.json`);
const processStaging = resolve(rawDir, `${operationId}.process.staging.json`);

const corePids = pidsNamed("goalport-core.exe", RUN_SLUG);
const runtimePids = pidsNamed("codex.exe", "codex");
beat(`minted ${operationId} host=${firstHostPid}`);

const args = [
  resolve(ROOT, "scripts/connected/verify-soak.mjs"),
  "--seconds", String(seconds),
  "--live",
  "--runtime", "codex",
  "--host", "electron-packaged",
  "--real-turns", "6",
  "--activity-buckets", "0,2,4,6,8",
  "--force-kill-host-at-active-turn",
  "--operation-id", operationId,
  "--host-pid", String(firstHostPid),
  "--host-pids", hostPids.join(","),
  "--report", stagingPath,
  "--lifecycle-evidence", lifecycleStaging,
  "--reopen-evidence", reopenStaging,
  "--process-evidence", processStaging,
  "--packaged-exe", exe,
  "--cdp-port", String(port)
];
if (corePids[0]) args.push("--core-pid", String(corePids[0]));
if (runtimePids.length) args.push("--runtime-pids", runtimePids.join(","));

const hb = setInterval(() => {
  beat(`alive stagingExists=${existsSync(stagingPath)} hosts=${pidsNamed("GoalPort.exe", RUN_SLUG).join(",")}`);
}, 10000);

const result = spawnSync(process.execPath, args, {
  cwd: ROOT,
  env,
  encoding: "utf8",
  windowsHide: true,
  timeout: (seconds + 180) * 1000,
  maxBuffer: 16 * 1024 * 1024
});
clearInterval(hb);
beat(`verify-soak exit=${result.status}`);
if (result.stdout) writeFileSync(resolve(EVID, "soak-stdout.log"), result.stdout);
if (result.stderr) writeFileSync(resolve(EVID, "soak-stderr.log"), result.stderr);
if (!existsSync(stagingPath)) process.exit(result.status ?? 1);

const stdoutSha256 = sha256File(stagingPath);
const heartbeatSha256 = sha256File(heartbeat);
const sidecar = {
  evidenceClass: "soak",
  operationId,
  argv: [process.execPath, ...args],
  stdoutPath: stagingPath,
  stdoutSha256,
  closedAtUtc: new Date().toISOString(),
  sidecarClosed: true,
  cimCapture,
  heartbeatPath: heartbeat,
  heartbeatSha256,
  firstHostPid,
  unixMs,
  artifacts: {
    "soak-1800s.json": stagingPath,
    "lifecycle.json": lifecycleStaging,
    "reopen.json": reopenStaging,
    "process.json": processStaging
  }
};
const sidecarPath = resolve(rawDir, `${operationId}.json`);
writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
const sidecarSha256 = sha256File(sidecarPath);

function firstWriteFromStaging(staging, destName) {
  if (!existsSync(staging)) return;
  const body = JSON.parse(readFileSync(staging, "utf8"));
  body.operationId = operationId;
  body.sidecarSha256 = sidecarSha256;
  writeFileSync(resolve(EVID, destName), `${JSON.stringify(body, null, 2)}\n`);
}

firstWriteFromStaging(stagingPath, "soak-1800s.json");
firstWriteFromStaging(lifecycleStaging, "lifecycle.json");
firstWriteFromStaging(reopenStaging, "reopen.json");
firstWriteFromStaging(processStaging, "process.json");
process.exit(result.status ?? 1);
