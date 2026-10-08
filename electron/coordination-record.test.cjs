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
    const again = saveRecord(directory, record({ planText: "Revised plan." }));
    const records = readRecords(directory);
    assert.equal(records.length, 1);
    assert.equal(records[0].requestId, again.requestId);
    assert.equal(records[0].planText, "Revised plan.");
    assert.equal(records[0].verdict, "revise");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a replaced request and an unknown outcome are not stored", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-"));
  try {
    assert.throws(() => saveRecord(directory, record({ stopReason: "The coordination request was replaced, so nothing was sent." })));
    assert.throws(() => saveRecord(directory, record({ verdict: "passed" })));
    assert.deepEqual(readRecords(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
