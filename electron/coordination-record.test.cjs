const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readRecords, saveRecord } = require("./coordination-record.cjs");

function record(overrides = {}) {
  return {
    requestId: "request-1",
    workspacePath: "/work/goal",
    goal: "Explain the failure.",
    planningHarness: "Codex",
    reviewHarness: "Claude",
    planText: "Bounded plan.",
    reviewText: "Needs a smaller step.\nVERDICT: revise",
    result: "Needs a smaller step.\nVERDICT: revise",
    verdict: "revise",
    stopReason: "The independent check says the plan needs revision, so this stopped.",
    planningQuota: "available",
    reviewQuota: "unknown",
    ...overrides,
  };
}

function firstRoundFact(overrides = {}) {
  return {
    planningHarness: "Codex",
    reviewHarness: "Claude",
    planText: "First bounded plan.",
    reviewText: "Plan accepted.\nVERDICT: carry-out",
    executionText: "Changed the helper, but its check failed.",
    auditText: "The requested behavior is incomplete.\nVERDICT: revise",
    executionHarness: "Codex",
    auditHarness: "Claude",
    result: "The requested behavior is incomplete.\nVERDICT: revise",
    verdict: "revise",
    stopReason: "The independent audit requested a correction.",
    messageDispatched: true,
    roundEvents: [],
    commandIds: ["coordinate-plan-send-1", "coordinate-review-send-1", "coordinate-execute-send-1", "coordinate-audit-send-1"],
    ...overrides,
  };
}

test("a saved plan reopens as the same record and a repeat request does not append", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-"));
  try {
    assert.deepEqual(readRecords(directory), []);
    const saved = saveRecord(directory, record());
    assert.equal(saved.verdict, "revise");
    assert.equal(saved.planText, "Bounded plan.");
    assert.equal(Object.hasOwn(saved, "roundEvents"), false);
    const again = saveRecord(directory, record({ planText: "Revised plan." }));
    const records = readRecords(directory);
    assert.equal(records.length, 1);
    assert.equal(records[0].requestId, again.requestId);
    assert.equal(records[0].planText, "Revised plan.");
    assert.equal(records[0].verdict, "revise");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("saving a later plan keeps the earlier plan's saved time", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-"));
  const times = ["2026-10-08T06:10:00.000Z", "2026-10-08T07:20:00.000Z"];
  let index = 0;
  const clock = () => {
    const next = times[index];
    index += 1;
    if (!next) throw new Error("clock exhausted");
    return next;
  };
  try {
    saveRecord(directory, record({ requestId: "earlier", goal: "First goal." }), clock);
    saveRecord(directory, record({ requestId: "later", goal: "Second goal." }), clock);
    const file = path.join(directory, "coordination-records.json");
    const stored = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(stored);
    assert.equal(parsed.find((item) => item.requestId === "earlier").savedAt, "2026-10-08T06:10:00.000Z");
    assert.equal(parsed.find((item) => item.requestId === "later").savedAt, "2026-10-08T07:20:00.000Z");
    assert.equal(parsed.find((item) => item.requestId === "earlier").goal, "First goal.");
    assert.deepEqual(readRecords(directory).map((item) => item.savedAt), [
      "2026-10-08T07:20:00.000Z",
      "2026-10-08T06:10:00.000Z",
    ]);
    assert.equal(fs.readFileSync(file, "utf8"), stored);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a replaced request and an unknown outcome are not stored", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-"));
  try {
    assert.throws(() => saveRecord(directory, record({ stopReason: "The coordination request was replaced, so nothing was sent." })));
    assert.throws(() => saveRecord(directory, record({ verdict: "passed" })));
    assert.deepEqual(readRecords(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("the dispatched tri-state survives a save and a reload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-"));
  try {
    saveRecord(directory, record({ requestId: "sent-1", messageDispatched: true }));
    saveRecord(directory, record({ requestId: "refused-1", messageDispatched: false }));
    saveRecord(directory, record({ requestId: "old-1" }));
    saveRecord(directory, record({ requestId: "garbage-1", messageDispatched: "yes" }));
    const states = Object.fromEntries(readRecords(directory).map((item) => [item.requestId, item.messageDispatched]));
    assert.equal(states["sent-1"], true);
    assert.equal(states["refused-1"], false);
    assert.equal(states["old-1"], null);
    assert.equal(states["garbage-1"], null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, retryDelay: 100 });
  }
});

test("an environment block survives a save and a reload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-env-"));
  try {
    const saved = saveRecord(directory, record({
      verdict: "failed",
      stopReason: "The harness could not finish the turn, so this stopped.",
      environmentBlocked: {
        role: "planning",
        instanceId: "codex",
        harness: "Codex",
        detail: "Failed to create unified exec process: helper_unknown_error: setup refresh had errors",
      },
    }));
    assert.deepEqual(saved.environmentBlocked, {
      role: "planning",
      instanceId: "codex",
      harness: "Codex",
      detail: "Failed to create unified exec process: helper_unknown_error: setup refresh had errors",
    });
    const records = readRecords(directory);
    assert.equal(records[0].environmentBlocked.role, "planning");
    assert.equal(records[0].environmentBlocked.instanceId, "codex");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a malformed environment block degrades to null instead of rejecting the plan", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-env-bad-"));
  try {
    const saved = saveRecord(directory, record({ verdict: "failed", environmentBlocked: { role: "planner", instanceId: "" } }));
    assert.equal(saved.environmentBlocked, null);
    assert.equal(readRecords(directory)[0].environmentBlocked, null);
    const stringBlock = saveRecord(directory, record({ requestId: "request-2", verdict: "failed", environmentBlocked: "sandbox failed" }));
    assert.equal(stringBlock.environmentBlocked, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("completed round events survive save and reload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-events-"));
  const roundEvents = [
    {
      kind: "failed",
      role: "planning",
      instanceId: "codex",
      harness: "Codex",
      sentence: "Codex could not run its tools on this machine, so this stopped for it.",
      detail: "helper_unknown_error",
    },
    {
      kind: "continued",
      role: "planning",
      instanceId: "claude",
      harness: "Claude",
      sentence: "Claude is planning instead.",
    },
  ];
  try {
    const saved = saveRecord(directory, record({ roundEvents }));
    assert.deepEqual(saved.roundEvents, roundEvents);
    assert.deepEqual(readRecords(directory)[0].roundEvents, roundEvents);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("malformed round-event entries are dropped without rejecting a record", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-events-bad-"));
  const valid = {
    kind: "failed",
    role: "review",
    instanceId: "claude",
    harness: null,
    sentence: "The check failed.",
  };
  try {
    const saved = saveRecord(directory, record({ roundEvents: [
      valid,
      null,
      { ...valid, kind: "started" },
      { ...valid, role: "planner" },
      { ...valid, instanceId: " " },
      { ...valid, harness: {} },
      { ...valid, sentence: " " },
      { ...valid, detail: 42 },
    ] }));
    assert.deepEqual(saved.roundEvents, [valid]);
    assert.deepEqual(readRecords(directory)[0].roundEvents, [valid]);
    const oldStyle = saveRecord(directory, record({ requestId: "old-round-events", roundEvents: "broken" }));
    assert.equal(Object.hasOwn(oldStyle, "roundEvents"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("verified execution and audit records round-trip their text, harnesses, and completed events", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-verified-"));
  const roundEvents = [
    {
      kind: "continued",
      role: "execution",
      instanceId: "codex",
      harness: "Codex",
      sentence: "Codex finished the authorized changes.",
    },
    {
      kind: "continued",
      role: "audit",
      instanceId: "claude",
      harness: "Claude",
      sentence: "Claude independently verified the changes.",
    },
  ];
  try {
    const saved = saveRecord(directory, record({
      verdict: "verified",
      stopReason: "The independent audit verified the changes.",
      executionText: "Updated the requested file and ran its check.",
      auditText: "Reviewed the diff and check output; VERDICT: verified",
      executionHarness: "Codex",
      auditHarness: "Claude",
      roundEvents,
    }));
    assert.equal(saved.verdict, "verified");
    assert.equal(saved.executionText, "Updated the requested file and ran its check.");
    assert.equal(saved.auditText, "Reviewed the diff and check output; VERDICT: verified");
    assert.equal(saved.executionHarness, "Codex");
    assert.equal(saved.auditHarness, "Claude");
    assert.deepEqual(saved.roundEvents, roundEvents);
    assert.deepEqual(readRecords(directory)[0], saved);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("execution and audit failures keep partial execution text and accept both new blocked roles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-role-failures-"));
  try {
    const executionFailure = saveRecord(directory, record({
      requestId: "execution-failure",
      verdict: "failed",
      stopReason: "The execution turn failed after making partial changes.",
      executionText: "Changed the first file before the command failed.",
      executionHarness: "Codex",
      environmentBlocked: { role: "execution", instanceId: "codex", harness: "Codex", detail: "transport closed" },
    }));
    assert.equal(executionFailure.executionText, "Changed the first file before the command failed.");
    assert.equal(executionFailure.executionHarness, "Codex");
    assert.equal(executionFailure.auditText, null);
    assert.equal(executionFailure.auditHarness, null);
    assert.equal(executionFailure.environmentBlocked.role, "execution");

    const auditFailure = saveRecord(directory, record({
      requestId: "audit-failure",
      verdict: "failed",
      stopReason: "The audit turn failed after execution completed.",
      executionText: "The execution report is retained.",
      executionHarness: "Codex",
      auditHarness: "Claude",
      environmentBlocked: { role: "audit", instanceId: "claude", harness: "Claude", detail: "transport closed" },
    }));
    assert.equal(auditFailure.executionText, "The execution report is retained.");
    assert.equal(auditFailure.auditHarness, "Claude");
    assert.equal(auditFailure.auditText, null);
    assert.equal(auditFailure.environmentBlocked.role, "audit");
    assert.deepEqual(readRecords(directory).map((item) => item.environmentBlocked.role), ["audit", "execution"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("malformed new fields degrade to null and malformed or transient new-role events are dropped", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-new-fields-bad-"));
  const validExecutionEvent = {
    kind: "continued",
    role: "execution",
    instanceId: "codex",
    harness: "Codex",
    sentence: "The completed execution turn returned.",
  };
  const validAuditEvent = {
    kind: "failed",
    role: "audit",
    instanceId: "claude",
    harness: null,
    sentence: "The audit turn failed.",
  };
  try {
    const saved = saveRecord(directory, record({
      executionText: 42,
      auditText: {},
      executionHarness: false,
      auditHarness: ["Claude"],
      environmentBlocked: { role: "auditing", instanceId: "claude", harness: "Claude" },
      roundEvents: [
        validExecutionEvent,
        validAuditEvent,
        { ...validAuditEvent, kind: "started" },
        { ...validExecutionEvent, role: "planner" },
      ],
    }));
    assert.equal(saved.executionText, null);
    assert.equal(saved.auditText, null);
    assert.equal(saved.executionHarness, null);
    assert.equal(saved.auditHarness, null);
    assert.equal(saved.environmentBlocked, null);
    assert.deepEqual(saved.roundEvents, [validExecutionEvent, validAuditEvent]);
    assert.deepEqual(readRecords(directory)[0].roundEvents, [validExecutionEvent, validAuditEvent]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("pre-M7 records remain readable with null execution and audit fields", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-old-record-"));
  const oldRecord = record({ messageDispatched: true });
  try {
    fs.writeFileSync(path.join(directory, "coordination-records.json"), JSON.stringify([oldRecord]));
    const [loaded] = readRecords(directory);
    assert.equal(loaded.requestId, oldRecord.requestId);
    assert.equal(loaded.verdict, "revise");
    assert.equal(loaded.messageDispatched, true);
    assert.equal(loaded.executionText, null);
    assert.equal(loaded.auditText, null);
    assert.equal(loaded.executionHarness, null);
    assert.equal(loaded.auditHarness, null);
    assert.equal(Object.hasOwn(loaded, "feedbackHistory"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("completed first-round feedback facts round-trip beside the latest pass", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-feedback-"));
  const first = firstRoundFact();
  try {
    const saved = saveRecord(directory, record({
      planText: "Corrective plan.",
      reviewText: "The corrective plan is acceptable.",
      executionText: "Repaired the helper and its test.",
      auditText: "The repaired behavior now passes.\nVERDICT: verified",
      executionHarness: "Codex",
      auditHarness: "Claude",
      result: "The repaired behavior now passes.\nVERDICT: verified",
      verdict: "verified",
      stopReason: "The independent corrective audit verified the repair.",
      messageDispatched: true,
      feedbackHistory: [first],
    }));
    assert.equal(saved.verdict, "verified");
    assert.equal(saved.planText, "Corrective plan.");
    assert.equal(saved.messageDispatched, true);
    assert.deepEqual(saved.feedbackHistory, [first]);
    assert.deepEqual(readRecords(directory)[0], saved);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("malformed optional feedback history is dropped without rejecting an otherwise valid record", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-feedback-bad-"));
  try {
    const malformedShape = saveRecord(directory, record({ feedbackHistory: { verdict: "revise" } }));
    assert.equal(malformedShape.verdict, "revise");
    assert.equal(Object.hasOwn(malformedShape, "feedbackHistory"), false);

    const malformedFact = saveRecord(directory, record({
      requestId: "malformed-fact",
      feedbackHistory: [firstRoundFact({ commandIds: "not-an-array" })],
    }));
    assert.equal(malformedFact.verdict, "revise");
    assert.deepEqual(malformedFact.feedbackHistory, []);

    const firstOnly = saveRecord(directory, record({
      requestId: "first-only",
      feedbackHistory: [firstRoundFact(), firstRoundFact({ verdict: "verified", commandIds: ["coordinate-audit-repair-1"] })],
    }));
    assert.deepEqual(firstOnly.feedbackHistory, [firstRoundFact()]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("send-wide dispatch stays non-retryable after a corrective pass is refused, unknown, or cancelled before writing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-feedback-dispatch-"));
  const cases = [
    { requestId: "repair-refused", dispatch: false, stopReason: "Corrective planning was refused before dispatch.", verdict: "failed" },
    { requestId: "repair-unknown", dispatch: null, stopReason: "Corrective planning dispatch is unknown.", verdict: "unconfirmed" },
    { requestId: "repair-cancelled", dispatch: true, stopReason: "The corrective pass was cancelled before its writer.", verdict: "stopped" },
  ];
  try {
    for (const item of cases) {
      const saved = saveRecord(directory, record({
        requestId: item.requestId,
        result: item.stopReason,
        verdict: item.verdict,
        stopReason: item.stopReason,
        messageDispatched: item.dispatch,
        feedbackHistory: [firstRoundFact({ messageDispatched: true })],
      }));
      assert.equal(saved.messageDispatched, true, `${item.requestId} must remain sent at the original-Send level`);
      assert.deepEqual(saved.feedbackHistory, [firstRoundFact({ messageDispatched: true })]);
      assert.equal(readRecords(directory).find((entry) => entry.requestId === item.requestId).messageDispatched, true);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("feedback history restores evidence only, never budgets, scope, or permission", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-feedback-authority-"));
  const fact = firstRoundFact({
    authorizedTurnsLeft: 99,
    authorizedWriteTurnsLeft: 99,
    scopeGeneration: 7,
    allowedInstances: ["codex", "claude"],
    writeAuthorization: { instances: ["codex"] },
    liveActivity: "execution",
  });
  try {
    const saved = saveRecord(directory, record({
      feedbackHistory: [fact],
      authorizedTurnsLeft: 99,
      authorizedWriteTurnsLeft: 99,
      scopeGeneration: 7,
      allowedInstances: ["codex", "claude"],
      writeAuthorization: { instances: ["codex"] },
      liveActivity: "execution",
    }));
    for (const key of ["authorizedTurnsLeft", "authorizedWriteTurnsLeft", "scopeGeneration", "allowedInstances", "writeAuthorization", "liveActivity"]) {
      assert.equal(Object.hasOwn(saved, key), false, `record must not contain ${key}`);
      assert.equal(Object.hasOwn(saved.feedbackHistory[0], key), false, `round facts must not contain ${key}`);
    }
    assert.deepEqual(saved.feedbackHistory, [firstRoundFact()]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

// The one pre-write plan revision (C4): the original plan-rejected pass is
// retained beside the latest pass, capped at one entry, permission-free, and
// folded into the same send-wide dispatch truth as the repair history.
function planRejectedFact(overrides = {}) {
  return {
    planningHarness: "Codex",
    reviewHarness: "Claude",
    planText: "Flawed bounded plan.",
    reviewText: "The plan ignores the negative-value case.\nVERDICT: revise",
    executionText: null,
    auditText: null,
    executionHarness: null,
    auditHarness: null,
    result: "The plan ignores the negative-value case.\nVERDICT: revise",
    verdict: "revise",
    stopReason: "The independent check says the plan needs revision, so this stopped.",
    messageDispatched: true,
    roundEvents: [],
    commandIds: ["coordinate-plan-send-1", "coordinate-review-send-1"],
    ...overrides,
  };
}

test("plan-revision facts round-trip beside the latest pass and stay distinct from repair history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-plan-revision-"));
  try {
    const saved = saveRecord(directory, record({
      planText: "Revised plan that answers the critique.",
      reviewText: "The plan can be carried out.\nVERDICT: carry-out",
      executionText: "Repaired the fixture; the unchanged checks pass.",
      auditText: "Independently verified.\nVERDICT: verified",
      executionHarness: "Codex",
      auditHarness: "Claude",
      result: "Independently verified.\nVERDICT: verified",
      verdict: "verified",
      stopReason: "The independent harness verified the changes, so this stopped.",
      messageDispatched: true,
      planRevisionHistory: [planRejectedFact()],
    }));
    assert.equal(saved.verdict, "verified");
    assert.deepEqual(saved.planRevisionHistory, [planRejectedFact()]);
    assert.equal(Object.hasOwn(saved, "feedbackHistory"), false);
    assert.deepEqual(readRecords(directory)[0], saved);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("malformed optional plan-revision history is dropped without rejecting an otherwise valid record", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-plan-revision-bad-"));
  try {
    const malformedShape = saveRecord(directory, record({ planRevisionHistory: { verdict: "revise" } }));
    assert.equal(malformedShape.verdict, "revise");
    assert.equal(Object.hasOwn(malformedShape, "planRevisionHistory"), false);

    const malformedFact = saveRecord(directory, record({
      requestId: "plan-revision-malformed-fact",
      planRevisionHistory: [planRejectedFact({ commandIds: "not-an-array" })],
    }));
    assert.equal(malformedFact.verdict, "revise");
    assert.deepEqual(malformedFact.planRevisionHistory, []);

    const firstOnly = saveRecord(directory, record({
      requestId: "plan-revision-first-only",
      planRevisionHistory: [planRejectedFact(), planRejectedFact({ verdict: "checked" })],
    }));
    assert.deepEqual(firstOnly.planRevisionHistory, [planRejectedFact()]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("send-wide dispatch includes the retained plan-rejected pass", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-plan-revision-dispatch-"));
  try {
    const sentOriginal = saveRecord(directory, record({
      requestId: "revision-refused",
      verdict: "failed",
      stopReason: "The revised chain failed before dispatch.",
      messageDispatched: false,
      planRevisionHistory: [planRejectedFact({ messageDispatched: true })],
    }));
    assert.equal(sentOriginal.messageDispatched, true, "the plan-rejected pass keeps the Send non-retryable");

    const unknownOriginal = saveRecord(directory, record({
      requestId: "revision-unknown",
      verdict: "unconfirmed",
      stopReason: "The revised launch dispatch is unknown.",
      messageDispatched: null,
      planRevisionHistory: [planRejectedFact({ messageDispatched: null })],
    }));
    assert.equal(unknownOriginal.messageDispatched, null, "unknown stays unknown across both histories");

    const combined = saveRecord(directory, record({
      requestId: "revision-then-repair",
      verdict: "verified",
      stopReason: "The independent harness verified the changes, so this stopped.",
      messageDispatched: true,
      planRevisionHistory: [planRejectedFact({ messageDispatched: true })],
      feedbackHistory: [firstRoundFact({ messageDispatched: false })],
    }));
    assert.equal(combined.messageDispatched, true, "any sent pass keeps the whole Send non-retryable");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("plan-revision history restores evidence only, never budgets, scope, or permission", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-plan-revision-authority-"));
  try {
    const saved = saveRecord(directory, record({
      planRevisionHistory: [planRejectedFact({
        authorizedTurnsLeft: 99,
        authorizedWriteTurnsLeft: 99,
        scopeGeneration: 7,
        allowedInstances: ["codex", "claude"],
        writeAuthorization: { instances: ["codex"] },
      })],
    }));
    assert.equal(Object.hasOwn(saved.planRevisionHistory[0], "authorizedTurnsLeft"), false);
    assert.equal(Object.hasOwn(saved.planRevisionHistory[0], "writeAuthorization"), false);
    assert.deepEqual(saved.planRevisionHistory, [planRejectedFact()]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("full capture, exact delivered audit subset and coverage round-trip while legacy records remain valid", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-evidence-record-"));
  try {
    const evidence = {
      status: "available",
      complete: true,
      changed: true,
      beforeDiff: "--- a/pre.txt\n+++ b/pre.txt\n@@ -1 +1 @@\n-a\n+b\n",
      afterDiff: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
      beforeUntrackedFiles: [{ path: "before.txt", size: 7, content: "before\n", binary: false }],
      untrackedFiles: [{ path: "test.txt", size: 12, content: "actual new text", binary: false }],
      beforeUntrackedFilesOmitted: 1,
      untrackedFilesOmitted: 2,
      comparisonBaseline: { headCommit: "2dbea545040c2bb3bdc66b95602975adc951d5a0", capturedAt: "2026-10-28T00:00:00.000Z" },
      reason: "Changes observed",
      label: "Workspace observation",
    };
    const coverage = {
      totalEvidenceBytes: 5000,
      includedEvidenceBytes: 4000,
      cropped: true,
      promptBytes: 8000,
      promptBudgetBytes: 8192,
      windowsCmdWorstCaseChars: 12000,
      croppedSections: ["Workspace AFTER tracked diff"],
    };
    const auditInputEvidenceText = "  exact delivered subset  \n[cropped]\n";
    const saved = saveRecord(directory, record({
      requestId: "evidence-roundtrip",
      executionEvidence: evidence,
      auditInputEvidenceCoverage: coverage,
      auditInputEvidenceText,
    }));
    assert.deepEqual(saved.executionEvidence, evidence);
    assert.deepEqual(saved.auditInputEvidenceCoverage, coverage);
    assert.equal(saved.auditInputEvidenceText, auditInputEvidenceText);

    const reloaded = readRecords(directory).find((r) => r.requestId === "evidence-roundtrip");
    assert.deepEqual(reloaded.executionEvidence, evidence);
    assert.deepEqual(reloaded.auditInputEvidenceCoverage, coverage);
    assert.equal(reloaded.auditInputEvidenceText, auditInputEvidenceText);

    // Verify record without evidence stays valid
    const legacy = saveRecord(directory, record({ requestId: "legacy-no-evidence" }));
    assert.equal(legacy.executionEvidence, undefined);
    assert.equal(legacy.auditInputEvidenceCoverage, undefined);
    assert.equal(legacy.auditInputEvidenceText, undefined);
    const reloadedLegacy = readRecords(directory).find((r) => r.requestId === "legacy-no-evidence");
    assert.equal(reloadedLegacy.executionEvidence, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
