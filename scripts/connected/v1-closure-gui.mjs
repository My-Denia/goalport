import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EVID, FIX, isolatedChildEnv } from "./v1-isolated-env.mjs";
import { attachGoalPort, waitFor } from "./v1-cdp.mjs";

export function packagedExe() {
  return resolve(EVID, "electron-package/GoalPort-win32-x64/GoalPort.exe");
}

export async function command(evaluate, type, payload) {
  const requestId = `gui-${type}-${Math.random().toString(16).slice(2)}`;
  return evaluate(`window.goalportCore.command({protocolVersion:'goalport.ipc.v2',requestId:${JSON.stringify(requestId)},entityVersion:0,messageType:${JSON.stringify(type)},payload:${JSON.stringify(payload)}})`, true);
}

export async function withPackagedGui(port, fn) {
  const exe = packagedExe();
  if (!existsSync(exe)) throw new Error(`missing ${exe}`);
  const child = spawn(exe, [], {
    cwd: FIX,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: isolatedChildEnv({ GOALPORT_CDP_PORT: String(port) })
  });
  child.unref();
  let session;
  try {
    session = await attachGoalPort(port);
    await waitFor(session.evaluate, "window.goalportCore && true", 20000);
    return await fn(session, child);
  } finally {
    try { session?.close(); } catch {}
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", timeout: 10000, windowsHide: true }); } catch {}
  }
}
