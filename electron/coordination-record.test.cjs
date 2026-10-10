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
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
