import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { EVID, FIX, isolatedChildEnv } from "./v1-isolated-env.mjs";

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const port = Number(value("--port", "19222"));
const exe = resolve(value("--exe", resolve(EVID, "electron-package/GoalPort-win32-x64/GoalPort.exe")));
if (!existsSync(exe)) {
  console.error(`packaged Electron missing: ${exe}`);
  process.exit(2);
}
mkdirSync(EVID, { recursive: true });
const child = spawn(exe, [], {
  cwd: FIX,
  detached: true,
  stdio: "ignore",
  windowsHide: false,
  env: isolatedChildEnv({
    GOALPORT_CDP_PORT: String(port)
  })
});
child.unref();
const report = {
  schemaVersion: 1,
  kind: "electron-launch",
  pid: child.pid,
  port,
  exe,
  syntheticRoot: FIX,
  startedAtUtc: new Date().toISOString()
};
console.log(JSON.stringify(report, null, 2));
