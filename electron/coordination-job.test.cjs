"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { endpointSocketLeafName } = require("./launch-config.cjs");
const {
  createCoordinationJobStore,
  controlEndpointFor,
  normalizeAdmissionInput,
  requestControl,
  ADMISSION_SCHEMA,
} = require("./coordination-job.cjs");

const FIXED_JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const FIXED_TOKEN = "a".repeat(64);

function admission(overrides = {}) {
  return {
    requestId: "send-background-1",
    goal: "Explain why the unchanged check fails and repair it once.",
    workspacePath: path.resolve("/tmp/goalport-job-workspace"),
    priorPlan: null,
    priorReview: null,
    avoidInstances: [],
    allowedInstances: ["reader-a", "reader-b"],
    maxTurns: 6,
    writeAuthorization: null,
    backgroundConsent: true,
    ...overrides,
  };
}

function fixture(t, options = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-coordination-job-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const store = createCoordinationJobStore(profile, {
    bootstrapReady: true,
    idFactory: () => FIXED_JOB_ID,
    tokenFactory: () => FIXED_TOKEN,
    clock: () => "2026-10-12T13:14:15.000Z",
    ...options,
  });
  return { profile, store };
}

function start(store, overrides = {}) {
  return store.startAdmission(admission(overrides));
}

function pathFor(profile, jobId, leaf) {
  return path.join(profile, "coordination-jobs", "jobs", jobId, leaf);
}

function failureProxy(options = {}) {
  const descriptors = new Map();
  const current = (key) => typeof options[key] === "function" ? options[key]() : options[key];
  return new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") return (file, ...args) => {
        const descriptor = target.openSync(file, ...args);
        descriptors.set(descriptor, String(file));
        return descriptor;
      };
      if (property === "writeFileSync") return (file, ...args) => {
        const name = typeof file === "number" ? descriptors.get(file) : String(file);
        const failWriteFor = current("failWriteFor");
        if (failWriteFor && name?.endsWith(failWriteFor)) throw Object.assign(new Error("injected write failure"), { code: "EIO" });
        return target.writeFileSync(file, ...args);
      };
      if (property === "renameSync") return (from, to) => {
        const failRenameFor = current("failRenameFor");
        if (failRenameFor && String(to).endsWith(failRenameFor)) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
        return target.renameSync(from, to);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("profile bootstrap gate refuses every write before durable initialization", (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-job-bootstrap-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const store = createCoordinationJobStore(profile, { bootstrapReady: false });
  assert.equal(store.getActiveStatus(), null);
  assert.throws(() => store.startAdmission(admission()), { code: "profile-bootstrap-required" });
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs")), false);
});

test("explicit admission is durable, single-slot and idempotent without creating a second owner", (t) => {
  const { profile, store } = fixture(t);
  const first = start(store);
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.status.state, "admitted");
  assert.equal(first.status.admission.backgroundConsent, true);
  assert.equal(first.status.admission.writeAuthorization, null);

  const stored = JSON.parse(fs.readFileSync(pathFor(profile, first.jobId, "admission.json"), "utf8"));
  assert.equal(stored.schema, ADMISSION_SCHEMA);
  assert.equal(stored.input.requestId, "send-background-1");
  assert.deepEqual(fs.readdirSync(path.join(profile, "coordination-jobs")).sort(), ["active-admission.json", "jobs"]);

  const duplicate = start(store);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.jobId, first.jobId);
  const conflict = start(store, { goal: "A changed goal with the same stable send id." });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "request-conflict");
  const other = store.startAdmission(admission({ requestId: "send-background-2" }));
  assert.equal(other.ok, false);
  assert.equal(other.reason, "active-job-exists");
  assert.equal(other.existingJobId, first.jobId);
});

test("read and write admissions stay distinct and malformed limits are refused", (t) => {
  const { store } = fixture(t);
  const writeAuthorization = { instances: ["writer"], workspaceRoot: admission().workspacePath, maxTurns: 2 };
  const result = start(store, { writeAuthorization });
  assert.deepEqual(result.status.admission.writeAuthorization, writeAuthorization);
  assert.deepEqual(result.status.admission.allowedInstances, ["reader-a", "reader-b"]);

  assert.throws(() => store.startAdmission(admission({ requestId: "bad-cap", maxTurns: 1 })), { code: "invalid-admission" });
  assert.throws(() => store.startAdmission(admission({ requestId: "bad-write-root", writeAuthorization: {
    instances: ["writer"], workspaceRoot: path.resolve("/tmp/other"), maxTurns: 2,
  } })), { code: "invalid-admission" });
});

test("old coordination history and a fresh non-consenting draft do not recreate background permission", (t) => {
  const { profile, store } = fixture(t);
  fs.writeFileSync(path.join(profile, "coordination-records.json"), JSON.stringify([{
    requestId: "send-background-1",
    goal: "A previously saved goal.",
    backgroundConsent: true,
    allowedInstances: ["reader-a"],
    messageDispatched: false,
  }]));
  assert.equal(store.getActiveStatus(), null);
  assert.throws(() => store.startAdmission(admission({ backgroundConsent: false })), { code: "background-consent-required" });
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs")), false);
  assert.equal(store.getActiveStatus(), null);
});

test("a startup claim is exclusive and an interrupted owner remains non-retryable", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  const claimed = store.claimWorker(admitted.jobId);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.status.state, "running");
  assert.equal(claimed.status.startupClaim.pid, process.pid);
  assert.equal(JSON.stringify(claimed.status).includes(claimed.ownerToken), false);
  assert.throws(() => store.claimWorker(admitted.jobId), { code: "worker-already-claimed" });

  store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-1", role: "planning" }, claimed.ownerToken);
  const reopened = createCoordinationJobStore(profile, { bootstrapReady: true });
  const afterLoss = reopened.getStatus(admitted.jobId);
  assert.equal(afterLoss.pendingCommand.commandId, "coordinate-plan-send-1");
  assert.equal(afterLoss.pendingCommand.state, "unconfirmed");
  assert.equal(afterLoss.active, true);
  assert.throws(() => reopened.claimWorker(admitted.jobId), { code: "pending-command" });
  const duplicate = reopened.startAdmission(admission());
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.jobId, admitted.jobId);
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), true);
});

test("command ids are marked unconfirmed before launch and completion is durable before advancing", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  const pending = store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-1", role: "planning" }, ownerToken);
  assert.deepEqual(pending.pendingCommand, {
    commandId: "coordinate-plan-send-1",
    role: "planning",
    state: "unconfirmed",
    recordedAt: "2026-10-12T13:14:15.000Z",
  });
  const diskPending = JSON.parse(fs.readFileSync(pathFor(profile, admitted.jobId, "progress.json"), "utf8"));
  assert.equal(diskPending.pendingCommand.commandId, "coordinate-plan-send-1");
  assert.equal(diskPending.pendingCommand.state, "unconfirmed");
  assert.throws(() => store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-review-send-1" }, ownerToken), { code: "pending-command" });

  const completed = store.completeCommand(admitted.jobId, {
    commandId: "coordinate-plan-send-1",
    facts: { text: "The plan completed.", messageDispatched: true },
    counters: { readTurnsRemaining: 5, writeTurnsRemaining: 2 },
  }, ownerToken);
  assert.equal(completed.pendingCommand, null);
  assert.equal(completed.completedCommands[0].facts.text, "The plan completed.");
  assert.deepEqual(completed.counters, { readTurnsRemaining: 5, writeTurnsRemaining: 2 });
  const diskCompleted = JSON.parse(fs.readFileSync(pathFor(profile, admitted.jobId, "progress.json"), "utf8"));
  assert.equal(diskCompleted.completedCommands[0].commandId, "coordinate-plan-send-1");
  assert.equal(diskCompleted.pendingCommand, null);
  assert.throws(() => store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-1" }, ownerToken), { code: "duplicate-command-id" });
  assert.throws(() => store.updateProgress(admitted.jobId, { counters: { budget: 99 } }, ownerToken), { code: "invalid-state" });
});

test("revocation is durable control state, retains an in-flight outcome and blocks subsequent turns", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-execute-send-1", role: "execution" }, ownerToken);
  const revoked = store.revoke(admitted.jobId);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.pendingCommand.commandId, "coordinate-execute-send-1");
  assert.throws(() => store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-audit-send-1" }, ownerToken), { code: "access-revoked" });
  const settled = store.completeCommand(admitted.jobId, {
    commandId: "coordinate-execute-send-1",
    facts: { text: "The already admitted turn settled." },
  }, ownerToken);
  assert.equal(settled.revoked, true);
  assert.equal(settled.completedCommands[0].facts.text, "The already admitted turn settled.");
  assert.equal(settled.startupClaim.pid, process.pid);
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), true);
  assert.equal(JSON.parse(fs.readFileSync(pathFor(profile, admitted.jobId, "progress.json"), "utf8")).revoked, true);
});

test("an atomic progress persistence failure prevents caller launch and preserves prior durable facts", (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-job-persist-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  let failProgress = false;
  const fsApi = failureProxy({ get failRenameFor() { return failProgress ? "progress.json" : null; } });
  const store = createCoordinationJobStore(profile, {
    bootstrapReady: true,
    fsApi,
    idFactory: () => FIXED_JOB_ID,
    tokenFactory: () => FIXED_TOKEN,
    clock: () => "2026-10-12T13:14:15.000Z",
  });
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  const before = fs.readFileSync(pathFor(profile, admitted.jobId, "progress.json"), "utf8");
  failProgress = true;
  let launched = false;
  assert.throws(() => {
    store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-1", role: "planning" }, ownerToken);
    launched = true;
  }, { code: "EIO" });
  assert.equal(launched, false);
  assert.equal(fs.readFileSync(pathFor(profile, admitted.jobId, "progress.json"), "utf8"), before);
  failProgress = false;
  assert.equal(store.getStatus(admitted.jobId).pendingCommand, null);
  store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-1", role: "planning" }, ownerToken);
  const pendingBytes = fs.readFileSync(pathFor(profile, admitted.jobId, "progress.json"), "utf8");
  failProgress = true;
  let advanced = false;
  assert.throws(() => {
    store.completeCommand(admitted.jobId, { commandId: "coordinate-plan-send-1", facts: { text: "known result" } }, ownerToken);
    advanced = true;
  }, { code: "EIO" });
  assert.equal(advanced, false);
  assert.equal(fs.readFileSync(pathFor(profile, admitted.jobId, "progress.json"), "utf8"), pendingBytes);
  failProgress = false;
  assert.equal(store.getStatus(admitted.jobId).pendingCommand.commandId, "coordinate-plan-send-1");
  assert.equal(store.getStatus(admitted.jobId).completedCommands.length, 0);
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), true);
});

test("a partially persisted exclusive startup claim remains a refusal, never a replacement owner", (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-job-claim-failure-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  let failClaim = false;
  const fsApi = failureProxy({ get failWriteFor() { return failClaim ? "startup-claim.json" : null; } });
  const store = createCoordinationJobStore(profile, {
    bootstrapReady: true,
    fsApi,
    idFactory: () => FIXED_JOB_ID,
    tokenFactory: () => FIXED_TOKEN,
    clock: () => "2026-10-12T13:14:15.000Z",
  });
  const admitted = start(store);
  failClaim = true;
  assert.throws(() => store.claimWorker(admitted.jobId), { code: "EIO" });
  failClaim = false;
  assert.equal(fs.existsSync(pathFor(profile, admitted.jobId, "startup-claim.json")), true);
  assert.throws(() => store.claimWorker(admitted.jobId), { code: "malformed-state" });
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), true);
});

test("terminal outcome is persisted before slot release and cannot be restarted from old admission", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-1", role: "planning" }, ownerToken);
  assert.throws(() => store.releaseAdmission(admitted.jobId, ownerToken), { code: "job-not-terminal" });
  store.completeCommand(admitted.jobId, { commandId: "coordinate-plan-send-1", facts: { ok: true } }, ownerToken);
  assert.throws(() => store.releaseAdmission(admitted.jobId, ownerToken), { code: "job-not-terminal" });
  const terminal = store.recordOutcome(admitted.jobId, { status: "completed", verdict: "verified" }, ownerToken);
  assert.equal(terminal.state, "completed");
  assert.equal(terminal.outcome.verdict, "verified");
  store.releaseAdmission(admitted.jobId, ownerToken);
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), false);
  assert.equal(store.getStatus(admitted.jobId).active, false);
  const duplicate = start(store);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.jobId, admitted.jobId);
  assert.equal(duplicate.status.state, "completed");
  assert.equal(fs.existsSync(pathFor(profile, admitted.jobId, "startup-claim.json")), true);
});

test("an unconfirmed terminal projection retains the admission slot and cannot authorize another job", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-unknown", role: "planning" }, ownerToken);
  store.recordOutcome(admitted.jobId, { status: "unconfirmed", reason: "Worker outcome was not observed." }, ownerToken);
  assert.throws(() => store.releaseAdmission(admitted.jobId, ownerToken), { code: "job-not-terminal" });
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), true);
  const replacement = store.startAdmission(admission({ requestId: "must-not-replace-unconfirmed" }));
  assert.equal(replacement.ok, false);
  assert.equal(replacement.reason, "active-job-exists");
});

test("a missing/stale slot or malformed admission never authorizes a replacement", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  const claim = store.claimWorker(admitted.jobId);
  fs.unlinkSync(path.join(profile, "coordination-jobs", "active-admission.json"));
  assert.throws(() => store.startAdmission(admission({ requestId: "replacement-after-slot-loss" })), { code: "stale-job-state" });
  assert.throws(() => store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-1" }, claim.ownerToken), { code: "admission-not-active" });
  assert.equal(fs.existsSync(pathFor(profile, admitted.jobId, "startup-claim.json")), true);

  fs.writeFileSync(path.join(profile, "coordination-jobs", "active-admission.json"), "{broken");
  assert.throws(() => store.startAdmission(admission({ requestId: "replacement-after-bad-slot" })), { code: "malformed-state" });
  assert.equal(fs.readFileSync(path.join(profile, "coordination-jobs", "active-admission.json"), "utf8"), "{broken");
});

test("a malformed immutable admission blocks worker start and replacement without clearing the slot", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  fs.writeFileSync(pathFor(profile, admitted.jobId, "admission.json"), JSON.stringify({
    schema: ADMISSION_SCHEMA,
    jobId: admitted.jobId,
    createdAt: "2026-10-12T13:14:15.000Z",
    input: { requestId: "send-background-1", backgroundConsent: false },
  }));
  assert.throws(() => store.claimWorker(admitted.jobId), { code: "malformed-admission" });
  assert.throws(() => store.startAdmission(admission({ requestId: "replacement-after-bad-admission" })), { code: "malformed-admission" });
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), true);
});

test("the local authenticated endpoint permits only status/revoke and missing control never clears claims", { skip: process.platform !== "linux" }, async (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  store.claimWorker(admitted.jobId);
  const endpoint = controlEndpointFor("goalport-job-store-test", { platform: "linux", env: { HOME: profile } });
  assert.equal(endpoint.startsWith(path.join(profile, ".goalport", "runtime")), true);
  const server = await store.startControlServer({ jobId: admitted.jobId, endpoint });
  const token = store.readControlCredential(admitted.jobId);
  const status = await requestControl(endpoint, token, "status");
  assert.equal(status.jobId, admitted.jobId);
  assert.equal(status.state, "running");
  await assert.rejects(requestControl(endpoint, "b".repeat(64), "status"), { code: "control-refused" });
  await assert.rejects(requestControl(endpoint, token, "launch"), { code: "unsupported-operation" });

  // Exercise the server-side allowlist, not just the client guard.
  const unsupported = await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let text = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => { text += chunk.toString("utf8"); });
    socket.on("end", () => resolve(JSON.parse(text.trim())));
    socket.on("connect", () => socket.write(`${JSON.stringify({ schema: "goalport.coordination-job-control.v1", token, operation: "launch" })}\n`));
  });
  assert.deepEqual(unsupported, { ok: false, error: "unsupported-operation" });

  const revoked = await requestControl(endpoint, token, "revoke");
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.claimed, true);
  assert.equal(revoked.goal, undefined);
  await server.close();
  await assert.rejects(requestControl(endpoint, token, "status"), { code: "control-unavailable" });
  assert.equal(fs.existsSync(pathFor(profile, admitted.jobId, "startup-claim.json")), true);
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), true);
});

test("an accepted long goal and retained report still fit in the live control acknowledgement", { skip: process.platform !== "linux" }, async (t) => {
  const { profile, store } = fixture(t);
  const goal = "g".repeat(9000);
  const admitted = start(store, { goal });
  const claim = store.claimWorker(admitted.jobId);
  store.updateProgress(admitted.jobId, { display: { activity: "r".repeat(20_000), failures: [] } }, claim.ownerToken);
  const endpoint = controlEndpointFor("goalport-job-store-large", { platform: "linux", env: { HOME: profile } });
  const server = await store.startControlServer({ jobId: admitted.jobId, endpoint });
  const token = store.readControlCredential(admitted.jobId);
  const ack = await requestControl(endpoint, token, "status");
  assert.equal(Buffer.byteLength(`${JSON.stringify({ ok: true, status: ack })}\n`) <= 8192, true);
  assert.equal(ack.jobId, admitted.jobId);
  assert.equal(ack.active, true);
  assert.equal(ack.claimed, true);
  assert.equal(ack.goal, undefined);
  assert.equal(ack.progress, undefined);
  assert.equal(store.getStatus(admitted.jobId).admission.goal, goal);
  await server.close();
});

const executionFeedback = {
  previousPlan: "previous plan",
  previousPlanReview: null,
  previousExecutionReport: "execution report",
  previousExecutionAudit: "execution audit",
  previousCommandIds: ["coord-plan-1", "coord-audit-2"],
};

test("execution feedback is closed, durable, and round-trips through reopened status", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store, { executionFeedback: { ...executionFeedback, ignored: "not durable" } });
  const persisted = JSON.parse(fs.readFileSync(pathFor(profile, admitted.jobId, "admission.json"), "utf8"));
  assert.deepEqual(persisted.input.executionFeedback, executionFeedback);
  const reopened = createCoordinationJobStore(profile, { bootstrapReady: true });
  assert.deepEqual(reopened.getStatus(admitted.jobId).admission.executionFeedback, executionFeedback);
});

test("legacy admissions preserve their exact canonical shape and remain readable/claimable", (t) => {
  const { profile, store } = fixture(t);
  const legacy = normalizeAdmissionInput(admission());
  assert.deepEqual(Object.keys(legacy), ["requestId", "goal", "workspacePath", "priorPlan", "priorReview", "avoidInstances", "allowedInstances", "maxTurns", "writeAuthorization", "backgroundConsent"]);
  assert.equal(Object.hasOwn(legacy, "executionFeedback"), false);
  const admitted = start(store);
  const reopened = createCoordinationJobStore(profile, { bootstrapReady: true });
  const status = reopened.getStatus(admitted.jobId);
  assert.deepEqual(status.admission, legacy);
  assert.equal(Object.hasOwn(status.admission, "executionFeedback"), false);
  assert.equal(reopened.claimWorker(admitted.jobId).status.jobId, admitted.jobId);
  assert.equal(reopened.startAdmission(admission()).jobId, admitted.jobId);
});

test("feedback omission and explicit null are canonical-equivalent; equal duplicate is idempotent and changed feedback conflicts", (t) => {
  const { store } = fixture(t);
  assert.deepEqual(normalizeAdmissionInput(admission()), normalizeAdmissionInput(admission({ executionFeedback: null })));
  const first = start(store, { executionFeedback });
  const duplicate = start(store, { executionFeedback: { ...executionFeedback, ignored: true } });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.jobId, first.jobId);
  const conflict = start(store, { executionFeedback: { ...executionFeedback, previousExecutionAudit: "different" } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "request-conflict");
});

test("malformed feedback refuses admission using the existing invalid-admission code", (t) => {
  const { store } = fixture(t);
  const invalid = [
    "not an object",
    { ...executionFeedback, previousPlan: 4 },
    { ...executionFeedback, previousExecutionAudit: "x".repeat(100_001) },
    { ...executionFeedback, previousCommandIds: Array(257).fill("id") },
    { ...executionFeedback, previousCommandIds: ["bad id"] },
    { ...executionFeedback, previousCommandIds: ["x".repeat(257)] },
    { ...executionFeedback, previousCommandIds: null },
  ];
  for (const value of invalid) assert.throws(() => store.startAdmission(admission({ executionFeedback: value })), { code: "invalid-admission" });
});

test("Linux endpoint overflow uses a deterministic same-directory hashed absolute path", { skip: process.platform !== "linux" }, () => {
  const parent = path.posix.join("/tmp", `goalport-${"p".repeat(15)}`);
  const firstProfile = path.posix.join(parent, `endpoint-${"a".repeat(90)}`);
  const secondProfile = path.posix.join(parent, `endpoint-${"a".repeat(89)}b`);
  const firstCandidate = `${firstProfile}-coordination-job-control`;
  const first = controlEndpointFor(firstProfile, { platform: "linux", env: { HOME: "/tmp" } });
  const second = controlEndpointFor(secondProfile, { platform: "linux", env: { HOME: "/tmp" } });
  assert.equal(path.posix.isAbsolute(first), true);
  assert.equal(path.posix.dirname(first), parent);
  assert.equal(Buffer.byteLength(first, "utf8") <= 107, true);
  assert.equal(first, controlEndpointFor(firstProfile, { platform: "linux", env: { HOME: "/other-home" } }));
  assert.notEqual(first, second);
  assert.equal(path.posix.basename(first), endpointSocketLeafName(firstCandidate, parent));
});

test("Linux endpoint byte counting supports multibyte parent directories and keeps short paths unchanged", { skip: process.platform !== "linux" }, () => {
  const parent = path.posix.join("/tmp", `p-${"λ".repeat(20)}`);
  const profileEndpoint = path.posix.join(parent, `e-${"x".repeat(80)}`);
  const endpoint = controlEndpointFor(profileEndpoint, { platform: "linux", env: { HOME: "/tmp" } });
  assert.equal(Buffer.byteLength(endpoint, "utf8") <= 107, true);
  assert.equal(path.posix.dirname(endpoint), parent);
  const shortProfileEndpoint = "/tmp/goalport-short-profile";
  assert.equal(controlEndpointFor(shortProfileEndpoint, { platform: "linux", env: { HOME: "/tmp" } }), `${shortProfileEndpoint}-coordination-job-control`);
});

test("Linux endpoint refuses when even the hashed leaf cannot fit in its original directory", { skip: process.platform !== "linux" }, () => {
  const profileEndpoint = `/${"d".repeat(100)}/control`;
  assert.throws(() => controlEndpointFor(profileEndpoint, { platform: "linux", env: { HOME: "/tmp" } }), /sun_path capacity/);
});

test("Windows control endpoint naming remains unchanged", () => {
  const profileEndpoint = "/tmp/goalport-windows-profile";
  assert.equal(controlEndpointFor(profileEndpoint, { platform: "win32", env: { HOME: "/tmp" } }), `\\\\.\\pipe\\${profileEndpoint}-coordination-job-control`);
});

test("a real control server round-trips on the derived long Linux socket path", { skip: process.platform !== "linux" }, async (t) => {
  const longParent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "goalport-long-socket-")), `p-${"x".repeat(20)}`);
  fs.mkdirSync(longParent);
  t.after(() => fs.rmSync(path.dirname(longParent), { recursive: true, force: true }));
  const store = createCoordinationJobStore(longParent, { bootstrapReady: true, idFactory: () => FIXED_JOB_ID, tokenFactory: () => FIXED_TOKEN });
  const admitted = store.startAdmission(admission({ workspacePath: longParent }));
  store.claimWorker(admitted.jobId);
  const profileEndpoint = path.join(longParent, `endpoint-${"x".repeat(90)}`);
  const endpoint = controlEndpointFor(profileEndpoint, { platform: "linux", env: { HOME: "/tmp" } });
  assert.equal(Buffer.byteLength(endpoint, "utf8") <= 107, true);
  assert.equal(path.dirname(endpoint), longParent);
  const server = await store.startControlServer({ jobId: admitted.jobId, endpoint });
  t.after(() => server.close());
  const token = store.readControlCredential(admitted.jobId);
  const ack = await requestControl(endpoint, token, "status");
  assert.equal(ack.jobId, admitted.jobId);
  assert.equal(ack.requestId, admitted.status.requestId);
  const revoked = await requestControl(endpoint, token, "revoke");
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.active, true);
});
