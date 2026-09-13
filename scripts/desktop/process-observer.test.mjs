import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { creationTime, observeProcess } from "./process-observer.mjs";

const pid = 424242;
const live = JSON.stringify({ ProcessId: pid, ParentProcessId: 1, ExecutablePath: "C:\\fixture\\goalport-core.exe", CreationDate: "/Date(1789297792128)/" });
const fixed = (result) => () => ({ status: 0, signal: null, stdout: "", stderr: "", ...result });

test("observer infrastructure failures and incomplete output are unknown, never absent", () => {
  const timeout = Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
  const cases = {
    timeout: { status: null, signal: "SIGTERM", error: timeout },
    "CIM error": { status: 3, stderr: "Invalid query" },
    "empty output": { stdout: "" },
    "invalid JSON": { stdout: "#< CLIXML" },
    "missing executable": { stdout: JSON.stringify({ ProcessId: pid, ExecutablePath: null, CreationDate: "/Date(1)/" }) },
    "missing creation": { stdout: JSON.stringify({ ProcessId: pid, ExecutablePath: "C:\\x.exe", CreationDate: null }) },
    "other process": { stdout: JSON.stringify({ ProcessId: pid + 1, ExecutablePath: "C:\\x.exe", CreationDate: "/Date(1)/" }) }
  };
  for (const [name, result] of Object.entries(cases)) {
    const observed = observeProcess(pid, { spawn: fixed(result) });
    assert.equal(observed.state, "unknown", name);
    assert.ok(observed.reason, name);
  }
  const timedOut = observeProcess(pid, { spawn: fixed(cases.timeout) });
  assert.equal(timedOut.errorCode, "ETIMEDOUT"); assert.equal(timedOut.status, null); assert.equal(timedOut.signal, "SIGTERM");
  assert.equal(observeProcess(pid, { spawn: fixed(cases["CIM error"]) }).stderr, "Invalid query");
});

test("explicit absence and complete live identity are the only definite observations", () => {
  assert.equal(observeProcess(pid, { spawn: fixed({ stdout: "ABSENT\r\n" }) }).state, "absent");
  const observed = observeProcess(pid, { spawn: fixed({ stdout: `${live}\r\n` }) });
  assert.equal(observed.state, "live"); assert.equal(observed.ProcessId, pid);
  assert.equal(creationTime(observed.CreationDate), 1789297792128);
  assert.throws(() => observeProcess(0), /valid process id/);
});

test("real Windows observation reports this process live and an unused PID absent", { skip: process.platform !== "win32" }, () => {
  const self = observeProcess(process.pid);
  assert.equal(self.state, "live", JSON.stringify(self));
  assert.equal(realpathSync.native(self.ExecutablePath).toLowerCase(), realpathSync.native(process.execPath).toLowerCase());
  assert.ok(Number.isFinite(creationTime(self.CreationDate)));
  let unused = 999_999;
  while (true) {
    try { process.kill(unused, 0); unused += 4; } catch (error) { if (error.code === "ESRCH") break; unused += 4; }
  }
  assert.equal(observeProcess(unused).state, "absent");
});
