import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { observeKnown } from "./owned-core-cleanup.mjs";
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

// A single CIM probe may time out on a loaded runner; that is `unknown`, which cleanup
// retries. Judge the real observer the way cleanup does: definite within the same bound.
const CLEANUP_OBSERVE_MS = 20000;
// Loaded CI runners can burn the entire production bound in timed-out probes: when every
// powershell spawn exceeds the 5s probe timeout, the 20s deadline expires before any probe
// lands (observed as main run #88's flake). The production bound stays 20000; the
// real-observation test needs a deadline that fits enough attempts for one probe to land.
const PROBE_TIMEOUT_MS = 5000;
const OBSERVE_DEADLINE_MS = Math.max(CLEANUP_OBSERVE_MS, PROBE_TIMEOUT_MS * 6);
test("real Windows observation reaches definite live and absent despite loaded-runner probe timeouts", { skip: process.platform !== "win32" }, async () => {
  const selfAttempts = [];
  const self = await observeKnown((pid) => observeProcess(pid), process.pid, Date.now() + OBSERVE_DEADLINE_MS, selfAttempts);
  assert.equal(self.state, "live", JSON.stringify({ self, selfAttempts }));
  assert.equal(realpathSync.native(self.ExecutablePath).toLowerCase(), realpathSync.native(process.execPath).toLowerCase());
  assert.ok(Number.isFinite(creationTime(self.CreationDate)));
  assert.ok(selfAttempts.every((attempt) => attempt.state === "unknown"), "only unknown observations are retried");
  // On a busy runner a scanned-free PID can be reused before the probe lands; a "live"
  // answer there is the reuse race, not observer drift. Pick a fresh candidate and probe
  // again instead of failing the whole run on a race the observer cannot prevent.
  const scanUnused = () => {
    let candidate = 999_999;
    while (true) {
      try { process.kill(candidate, 0); candidate += 4; }
      catch (error) { if (error.code === "ESRCH") return candidate; candidate += 4; }
    }
  };
  const absentAttempts = [];
  let absent = null;
  for (let round = 0; round < 6; round += 1) {
    const candidate = scanUnused();
    absent = await observeKnown((pid) => observeProcess(pid), candidate, Date.now() + OBSERVE_DEADLINE_MS, absentAttempts);
    if (absent.state !== "live") break;
  }
  assert.equal(absent.state, "absent", JSON.stringify({ absent, absentAttempts }));
});
