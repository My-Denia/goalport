import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { EVID, FIX, isolatedChildEnv } from "./v1-isolated-env.mjs";

const seconds = Number(process.env.GOALPORT_SOAK_SECONDS || 1800);
const port = Number(process.env.GOALPORT_SOAK_PORT || 19222);
const exe = resolve(EVID, "electron-package/GoalPort-win32-x64/GoalPort.exe");
const heartbeat = resolve(EVID, "soak-heartbeat.log");
const reportPath = resolve(EVID, "soak-1800s.json");
mkdirSync(EVID, { recursive: true });
if (!existsSync(exe)) throw new Error(`packaged Electron missing: ${exe}`);

function beat(line) {
  appendFileSync(heartbeat, `${new Date().toISOString()} ${line}\n`);
}

const env = isolatedChildEnv({
  GOALPORT_CORE_PIPE: process.env.GOALPORT_CORE_PIPE,
  GOALPORT_CORE_DB: process.env.GOALPORT_CORE_DB,
  GOALPORT_SYNTHETIC_ROOT: FIX
});
const child = spawn(exe, [], {
  cwd: FIX,
  detached: true,
  stdio: "ignore",
  windowsHide: false,
  env: { ...env, GOALPORT_CDP_PORT: String(port) }
});
child.unref();
beat(`launched pid=${child.pid} port=${port} seconds=${seconds}`);

const soak = spawn(process.execPath, [
  resolve(import.meta.dirname, "verify-soak.mjs"),
  "--seconds", String(seconds),
  "--live",
  "--runtime", "codex",
  "--host", "electron",
  "--real-turns", "6",
  "--activity-buckets", "0,2,4,6,8",
  "--force-kill-host-at-active-turn",
  "--host-pid", String(child.pid),
  "--host-pids", String(child.pid),
  "--report", reportPath
], {
  cwd: resolve(import.meta.dirname, "../.."),
  env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
soak.stdout.on("data", (chunk) => beat(`stdout ${String(chunk).slice(0, 200)}`));
soak.stderr.on("data", (chunk) => beat(`stderr ${String(chunk).slice(0, 200)}`));
soak.unref();
beat(`verify-soak pid=${soak.pid}`);
writeFileSync(resolve(EVID, "soak-launch.json"), `${JSON.stringify({
  schemaVersion: 1,
  kind: "soak-launch",
  hostPid: child.pid,
  soakPid: soak.pid,
  port,
  seconds,
  heartbeat,
  reportPath,
  startedAtUtc: new Date().toISOString()
}, null, 2)}\n`);
console.log(JSON.stringify({ hostPid: child.pid, soakPid: soak.pid, heartbeat, reportPath }, null, 2));
