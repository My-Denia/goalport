import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { validateLaunchReady } from "./v1-core-restart.mjs";

const script = resolve("scripts/connected/v1-core-restart.mjs");

test("Core restart driver requires all isolated paths", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--core, --db, --pipe, and --report are required/);
});

test("Core restart driver refuses a missing Core binary before mutation", () => {
  const result = spawnSync(process.execPath, [
    script,
    "--core", "goal-runs/goalport-evidence-verifier-core-restart/evidence/missing-core.exe",
    "--db", "goal-runs/goalport-evidence-verifier-core-restart/evidence/missing.sqlite",
    "--pipe", "goalport-evidence-verifier-core-restart-missing",
    "--report", "goal-runs/goalport-evidence-verifier-core-restart/evidence/missing.json"
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Core binary missing/);
});

test("launch-ready validation binds nonce, isolated identities, live Core, and strict time", () => {
  const expected = {
    nonce: "11111111-2222-4333-8444-555555555555",
    runSlug: "goalport-evidence-verifier-core-restart",
    pipe: "isolated-pipe",
    dbPath: "C:\\isolated\\restart.sqlite",
    launcherPid: 20,
    launcherPath: "C:\\pkg\\goalport-core-launcher.exe",
    launcherSha256: "a".repeat(64),
    corePath: "C:\\pkg\\goalport-core.exe",
    coreSha256: "b".repeat(64),
    launchedAtUtc: "2026-09-02T00:00:00.000Z"
  };
  const observedCore = {
    pid: 30,
    creationDate: "/Date(1788307200100)/",
    executablePath: expected.corePath,
    executableSha256: expected.coreSha256
  };
  const ready = {
    kind: "launch-ready",
    readyState: "READY_COMMITTED",
    launchNonce: expected.nonce,
    coreEpochId: `core-epoch:${expected.nonce}`,
    runSlug: expected.runSlug,
    pipeIdentity: expected.pipe,
    databaseIdentity: expected.dbPath,
    startupReceiptId: `startup:${expected.nonce}`,
    launcher: {
      pid: expected.launcherPid,
      creationDate: "/Date(1788307200001)/",
      executablePath: expected.launcherPath,
      executableSha256: expected.launcherSha256
    },
    core: structuredClone(observedCore),
    timestamps: {
      launchRequestedAtUtc: "2026-09-02T00:00:00.010Z",
      startupReceiptPersistedAtUtc: "2026-09-02T00:00:00.200Z",
      readyAtUtc: "2026-09-02T00:00:00.300Z"
    }
  };
  assert.equal(validateLaunchReady(ready, expected, observedCore).ok, true);
  for (const mutate of [
    (value) => { value.launchNonce = "old-nonce"; },
    (value) => { value.readyState = "STARTUP_PENDING"; },
    (value) => { value.core.pid = 31; },
    (value) => { value.core.executableSha256 = "c".repeat(64); },
    (value) => { value.launcher.executablePath = "C:\\stale\\launcher.exe"; },
    (value) => { value.timestamps.readyAtUtc = "invalid"; },
    (value) => { value.timestamps.readyAtUtc = "2026-09-01T23:59:59.000Z"; }
  ]) {
    const candidate = structuredClone(ready);
    mutate(candidate);
    assert.equal(validateLaunchReady(candidate, expected, observedCore).ok, false);
  }
});
