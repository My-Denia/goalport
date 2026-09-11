import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffCorePass, packagedHandoffGuiPass, soakPass } from "./strict-predicates.mjs";

const hash = "a".repeat(64);

test("handoff requires every Core predicate and accepts complete packaged host evidence", () => {
  const predicates = {
    distinctAttempt: true,
    distinctNativeSession: true,
    nativeResponseObserved: true,
    terminalObserved: true,
    packetObserved: true,
    instructionObserved: true,
    primaryTerminalObserved: true,
    noManualCopy: true
  };
  assert.equal(handoffCorePass(predicates), true);
  for (const key of Object.keys(predicates)) {
    assert.equal(handoffCorePass({ ...predicates, [key]: false }), false, `missing ${key} must fail`);
  }
  const gui = {
    kind: "packaged-handoff-gui",
    hosts: [
      { host: "electron", operationId: "op-1", oldAttemptId: "old", newAttemptId: "new", newSessionHash: hash, screenshotSha256: hash, operationSha256: hash, connected: true, nativeResponseObserved: true, terminalObserved: true },
      { host: "tauri", operationId: "op-1", oldAttemptId: "old", newAttemptId: "new", newSessionHash: hash, screenshotSha256: hash, operationSha256: hash, connected: true, nativeResponseObserved: true, terminalObserved: true }
    ]
  };
  assert.equal(packagedHandoffGuiPass({ evidence: gui, hosts: ["electron", "tauri"], operationId: "op-1", oldAttemptId: "old", newAttemptId: "new", newSessionHash: hash }), true);
  assert.equal(packagedHandoffGuiPass({ evidence: gui, hosts: ["electron", "tauri"], operationId: "op-1", oldAttemptId: "old", newAttemptId: "new", newSessionHash: "b".repeat(64) }), false);
});

test("soak requires terminal, single submission, native identity, force kill and cross evidence", () => {
  const makeBucket = (index) => ({ requestId: `request-${index}`, accepted: true, eventCount: 4, nativeTerminalObserved: true, activeReentered: true, nativeSubmissionCount: 1, nativeIdentityObserved: true, providerSessionHash: hash });
  const base = {
    elapsedSeconds: 600,
    seconds: 600,
    activityBucketMinutes: [0, 2, 4, 6, 8],
    buckets: Array.from({ length: 6 }, (_, index) => makeBucket(index)),
    turns: 6,
    forceKill: true,
    hostKilled: true,
    hostExited: true,
    coreAlive: true,
    nativeAlive: true,
    dbBefore: 4096,
    dbAfter: 8192,
    samplesComplete: true,
    evidenceValidation: { lifecycle: true, reopen: true, process: true }
  };
  assert.equal(soakPass(base), true);
  for (const key of ["hostExited", "coreAlive", "nativeAlive", "samplesComplete"]) {
    assert.equal(soakPass({ ...base, [key]: false }), false, `missing ${key} must fail`);
  }
  for (const key of ["nativeTerminalObserved", "activeReentered", "nativeIdentityObserved"]) {
    assert.equal(soakPass({ ...base, buckets: base.buckets.map((bucket, index) => index === 0 ? { ...bucket, [key]: false } : bucket) }), false, `missing bucket ${key} must fail`);
  }
  assert.equal(soakPass({ ...base, evidenceValidation: { lifecycle: false, reopen: true, process: true } }), false);
});
