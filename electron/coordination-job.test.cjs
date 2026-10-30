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
  REVOCATION_FILE,
  REVOCATION_SCHEMA,
  STUCK_ACK_FILE,
  STUCK_ACK_SCHEMA,
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

test("a stale-snapshot progress replacement cannot erase a durable revocation", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  // The worker read its snapshot BEFORE the stop lands (writeAtomic only
  // serializes one replacement; a cross-process read-modify-write has no
  // transaction). This is the exact lost-update interleaving.
  const stale = JSON.parse(fs.readFileSync(pathFor(profile, admitted.jobId, "progress.json"), "utf8"));
  assert.equal(stale.revoked, false);
  const revoked = store.revoke(admitted.jobId);
  assert.equal(revoked.revoked, true);
  assert.equal(JSON.parse(fs.readFileSync(pathFor(profile, admitted.jobId, REVOCATION_FILE), "utf8")).schema, REVOCATION_SCHEMA);
  // The worker's atomic replace lands from the stale snapshot, overwriting
  // the revoked progress projection exactly as the race allows.
  fs.writeFileSync(pathFor(profile, admitted.jobId, "progress.json"), `${JSON.stringify({ ...stale, phase: "running" }, null, 2)}\n`);
  // Every read merges the write-once marker back in: the stop fact survives.
  const after = store.getStatus(admitted.jobId);
  assert.equal(after.revoked, true);
  assert.equal(after.revokeRequestedAt, "2026-10-12T13:14:15.000Z");
  assert.throws(() => store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-9" }, ownerToken), { code: "access-revoked" });
  // A worker write through the store also carries the merged stop forward.
  store.updateProgress(admitted.jobId, { detail: "late display update" }, ownerToken);
  assert.equal(store.getStatus(admitted.jobId).revoked, true);
  assert.equal(JSON.parse(fs.readFileSync(pathFor(profile, admitted.jobId, "progress.json"), "utf8")).revoked, true);
  // Re-revoking stays idempotent, and a corrupt marker refuses fail-closed.
  assert.equal(store.revoke(admitted.jobId).revoked, true);
  fs.writeFileSync(pathFor(profile, admitted.jobId, REVOCATION_FILE), "{not json");
  assert.throws(() => store.getStatus(admitted.jobId), { code: "malformed-state" });
});

test("a stop landing between the admission read and its write settles the command as never sent", (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-job-stop-race-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const mainStore = createCoordinationJobStore(profile, { bootstrapReady: true, clock: () => "2026-10-12T13:14:15.000Z" });
  let raceOnProgressWrite = false;
  const fsApi = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") return (from, to) => {
        // The user's Stop becomes durable AFTER the worker read its snapshot
        // but BEFORE the pending-command replacement commits: the exact
        // admission/revoke interleaving from the PR audit.
        if (raceOnProgressWrite && String(to).endsWith("progress.json")) {
          raceOnProgressWrite = false;
          mainStore.revoke(jobId);
        }
        return target.renameSync(from, to);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const workerStore = createCoordinationJobStore(profile, {
    bootstrapReady: true,
    fsApi,
    idFactory: () => FIXED_JOB_ID,
    tokenFactory: () => FIXED_TOKEN,
    clock: () => "2026-10-12T13:14:15.000Z",
  });
  const admitted = workerStore.startAdmission(admission());
  const jobId = admitted.jobId;
  const { ownerToken } = workerStore.claimWorker(jobId);
  raceOnProgressWrite = true;
  assert.throws(() => workerStore.recordPendingCommand(jobId, { commandId: "coordinate-plan-send-1", role: "planning" }, ownerToken), { code: "access-revoked" });
  // The launch was refused AND the recorded command was durably settled as
  // never sent: the ledger keeps the fact and no unconfirmed command remains.
  const status = mainStore.getStatus(jobId);
  assert.equal(status.revoked, true);
  assert.equal(status.state, "revoked");
  assert.equal(status.pendingCommand, null);
  assert.equal(status.completedCommands.length, 1);
  assert.equal(status.completedCommands[0].commandId, "coordinate-plan-send-1");
  assert.equal(status.completedCommands[0].facts.launched, false);
  assert.equal(status.completedCommands[0].facts.dispatched, false);
  const disk = JSON.parse(fs.readFileSync(pathFor(profile, jobId, "progress.json"), "utf8"));
  assert.equal(disk.pendingCommand, null);
  assert.equal(disk.revoked, true);
  assert.equal(disk.state, "revoked");
  // The settled id is never re-admissible, and the slot is not deadlocked:
  // an honest terminal outcome still releases the profile.
  assert.throws(() => workerStore.recordPendingCommand(jobId, { commandId: "coordinate-plan-send-1" }, ownerToken), { code: "access-revoked" });
  workerStore.recordOutcome(jobId, { status: "stopped", reason: "stopped while admitting" }, ownerToken);
  workerStore.releaseAdmission(jobId, ownerToken);
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), false);
});

test("revoke is marker-only: it never replaces progress.json and cannot roll a settled completion back", (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-job-marker-only-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  let stopWroteProgress = false;
  const mainFs = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") return (from, to) => {
        if (String(to).endsWith("progress.json")) stopWroteProgress = true;
        return target.renameSync(from, to);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const mainStore = createCoordinationJobStore(profile, {
    bootstrapReady: true, fsApi: mainFs, idFactory: () => FIXED_JOB_ID, tokenFactory: () => FIXED_TOKEN, clock: () => "2026-10-12T13:14:15.000Z",
  });
  const workerStore = createCoordinationJobStore(profile, {
    bootstrapReady: true, idFactory: () => FIXED_JOB_ID, tokenFactory: () => FIXED_TOKEN, clock: () => "2026-10-12T13:14:15.000Z",
  });
  const admitted = workerStore.startAdmission(admission());
  const { ownerToken } = workerStore.claimWorker(admitted.jobId);
  workerStore.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-1", role: "planning" }, ownerToken);
  const progressPath = pathFor(profile, admitted.jobId, "progress.json");
  const before = fs.readFileSync(progressPath, "utf8");
  const revoked = mainStore.revoke(admitted.jobId);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.state, "revoked");
  // The stop replaced no progress bytes: the worker process stays the only
  // progress.json writer, so no cross-process lost update exists at all.
  assert.equal(stopWroteProgress, false);
  assert.equal(fs.readFileSync(progressPath, "utf8"), before);
  // A completion racing the stop still lands in full, and the merged read
  // shows both durable facts without any rollback to pending.
  const settled = workerStore.completeCommand(admitted.jobId, { commandId: "coordinate-plan-send-1", facts: { text: "The turn settled." } }, ownerToken);
  assert.equal(settled.revoked, true);
  assert.equal(settled.pendingCommand, null);
  assert.equal(settled.completedCommands.length, 1);
  assert.equal(settled.completedCommands[0].facts.text, "The turn settled.");
  const after = mainStore.getStatus(admitted.jobId);
  assert.equal(after.revoked, true);
  assert.equal(after.pendingCommand, null);
  assert.equal(after.completedCommands.length, 1);
  workerStore.recordOutcome(admitted.jobId, { status: "stopped", reason: "stopped after settle" }, ownerToken);
  workerStore.releaseAdmission(admitted.jobId, ownerToken);
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), false);
});

test("a revocation before any worker claim is settled by the spawning worker and releases the admission", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  // Stop allowing lands in the window after the admission was persisted
  // but before the spawned worker claims — no claim file exists yet.
  const revoked = store.revoke(admitted.jobId);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.state, "revoked");
  assert.equal(fs.existsSync(pathFor(profile, admitted.jobId, "claim.json")), false);
  // The spawning worker claims: nothing was ever admitted to launch (no
  // prior claim means no command could be recorded), so the claim settles
  // terminal stopped and releases the profile-wide slot in the same step.
  const claim = store.claimWorker(admitted.jobId);
  assert.equal(claim.settledPreStartRevocation, true);
  assert.equal(claim.status.state, "stopped");
  assert.equal(claim.status.active, false);
  assert.equal(claim.status.revoked, true);
  assert.equal(claim.status.outcome.reason, "revoked-before-start");
  assert.equal(claim.status.pendingCommand, null);
  assert.equal(claim.status.completedCommands.length, 0);
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), false);
  const diskSettled = JSON.parse(fs.readFileSync(pathFor(profile, admitted.jobId, "progress.json"), "utf8"));
  assert.equal(diskSettled.state, "stopped");
  assert.equal(diskSettled.outcome.reason, "revoked-before-start");
  // No second worker may claim or restart the settled job: with the slot
  // released, the claim refuses at the admission boundary (the terminal
  // progress facts back it up behind the same refusal chain).
  assert.throws(() => store.claimWorker(admitted.jobId), { code: "admission-not-active" });
  // The profile admits a NEW goal again — the P1 deadlock is gone.
  const reopened = createCoordinationJobStore(profile, {
    bootstrapReady: true,
    idFactory: () => "123e4567-e89b-42d3-a456-426614174999",
    tokenFactory: () => "b".repeat(64),
    clock: () => "2026-10-12T13:14:15.000Z",
  });
  const second = reopened.startAdmission(admission({ requestId: "send-background-2" }));
  assert.equal(second.ok, true);
  assert.equal(second.created, true);
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
  assert.equal(Object.hasOwn(legacy, "continuation"), false);
  const admitted = start(store);
  const reopened = createCoordinationJobStore(profile, { bootstrapReady: true });
  const status = reopened.getStatus(admitted.jobId);
  assert.deepEqual(status.admission, legacy);
  assert.equal(Object.hasOwn(status.admission, "executionFeedback"), false);
  assert.equal(Object.hasOwn(status.admission, "continuation"), false);
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

const continuation = {
  parentRequestId: "parent-req-001",
  rootRequestId: "root-req-001",
  originalGoal: "Build a cross-platform coordination service.",
  followUp: "Add Windows and Linux support.",
};

test("continuation descriptor is closed, durable, and round-trips through reopened status", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store, { continuation });
  const persisted = JSON.parse(fs.readFileSync(pathFor(profile, admitted.jobId, "admission.json"), "utf8"));
  assert.deepEqual(persisted.input.continuation, continuation);
  const reopened = createCoordinationJobStore(profile, { bootstrapReady: true });
  assert.deepEqual(reopened.getStatus(admitted.jobId).admission.continuation, continuation);
});

test("continuation admission preserves exact canonical keys and separates new keys from legacy", (t) => {
  const { profile, store } = fixture(t);
  const normalized = normalizeAdmissionInput(admission({ continuation }));
  assert.deepEqual(Object.keys(normalized), [
    "requestId", "goal", "workspacePath", "priorPlan", "priorReview",
    "avoidInstances", "allowedInstances", "maxTurns", "writeAuthorization",
    "backgroundConsent", "continuation",
  ]);
  assert.deepEqual(Object.keys(normalized.continuation), [
    "parentRequestId", "rootRequestId", "originalGoal", "followUp",
  ]);
  const admitted = start(store, { continuation });
  const reopened = createCoordinationJobStore(profile, { bootstrapReady: true });
  const status = reopened.getStatus(admitted.jobId);
  assert.deepEqual(status.admission, normalized);
  assert.equal(reopened.claimWorker(admitted.jobId).status.jobId, admitted.jobId);
});

test("continuation omission stays absent; null/extra fields refuse, equal duplicate is idempotent and changed descriptor conflicts", (t) => {
  const { store } = fixture(t);
  assert.throws(() => normalizeAdmissionInput(admission({ continuation: null })), { code: "invalid-admission" });
  assert.throws(() => normalizeAdmissionInput(admission({ continuation: { ...continuation, ignored: true } })), { code: "invalid-admission" });
  assert.deepEqual(normalizeAdmissionInput(admission()), normalizeAdmissionInput(admission({ continuation: undefined })));
  const first = start(store, { continuation });
  const duplicate = start(store, { continuation: { ...continuation } });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.jobId, first.jobId);
  const conflict = start(store, { continuation: { ...continuation, followUp: "different follow-up" } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "request-conflict");
});

test("malformed continuation descriptor refuses admission before launch with invalid-admission", (t) => {
  const { store } = fixture(t);
  const invalid = [
    "not an object",
    { ...continuation, parentRequestId: "" },
    { ...continuation, rootRequestId: "invalid id with spaces" },
    { ...continuation, originalGoal: "" },
    { ...continuation, originalGoal: 123 },
    { ...continuation, followUp: 456 },
    { ...continuation, originalGoal: "a".repeat(50_001), followUp: "b".repeat(50_000) },
  ];
  for (const value of invalid) {
    assert.throws(() => store.startAdmission(admission({ continuation: value })), { code: "invalid-admission" });
  }
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

test("leaving a stuck job keeps the unconfirmed command, holds the same folder, and admits a different folder", (t) => {
  let n = 0;
  const ids = [FIXED_JOB_ID, "223e4567-e89b-42d3-a456-426614174001", "323e4567-e89b-42d3-a456-426614174002"];
  const { profile, store } = fixture(t, { idFactory: () => ids[n++] });
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-unknown", role: "planning" }, ownerToken);
  store.recordOutcome(admitted.jobId, { status: "unconfirmed", reason: "Worker outcome was not observed." }, ownerToken);
  const left = store.acknowledgeStuck(admitted.jobId);
  assert.equal(left.active, false);
  assert.equal(left.state, "unconfirmed");
  assert.equal(left.pendingCommand.commandId, "coordinate-plan-send-unknown");
  assert.equal(typeof left.acknowledgedStuckAt, "string");
  assert.equal(left.outcome?.status, "unconfirmed");
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), false);
  assert.throws(() => start(store), { code: "stuck-acknowledged", message: "The interrupted job stays unreplayed; the same request id cannot be admitted again." });
  const sameFolder = store.startAdmission(admission({ requestId: "send-background-2" }));
  assert.equal(sameFolder.ok, false);
  assert.equal(sameFolder.reason, "workspace-held");
  assert.equal(sameFolder.existingJobId, admitted.jobId);
  const otherFolder = store.startAdmission(admission({ requestId: "send-background-3", workspacePath: path.resolve("/tmp/goalport-other-workspace") }));
  assert.equal(otherFolder.ok, true);
  assert.equal(otherFolder.created, true);
  assert.notEqual(otherFolder.jobId, admitted.jobId);
  assert.equal(store.getStatus(admitted.jobId).pendingCommand.commandId, "coordinate-plan-send-unknown");
  assert.equal(store.getStatus(admitted.jobId).state, "unconfirmed");
});

test("a worker-style progress replacement cannot erase the durable stuck acknowledgement", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-unknown", role: "planning" }, ownerToken);
  store.recordOutcome(admitted.jobId, { status: "unconfirmed", reason: "Worker outcome was not observed." }, ownerToken);
  const progressPath = pathFor(profile, admitted.jobId, "progress.json");
  // The live worker's in-memory snapshot predates the acknowledgement; its
  // atomic replacement below lands from this snapshot exactly as the race
  // allows (writeAtomic serializes one replacement, not a transaction).
  const stale = fs.readFileSync(progressPath, "utf8");
  assert.equal(JSON.parse(stale).acknowledgedStuckAt ?? null, null);

  const left = store.acknowledgeStuck(admitted.jobId);
  assert.equal(left.acknowledgedStuckAt, "2026-10-12T13:14:15.000Z");
  // The acknowledgement is its own write-once marker: it never rewrites
  // worker-owned progress.json (so it cannot erase a newer outcome), and the
  // marker survives every progress replacement (so it cannot be erased).
  assert.equal(fs.readFileSync(progressPath, "utf8"), stale);
  assert.equal(JSON.parse(fs.readFileSync(pathFor(profile, admitted.jobId, STUCK_ACK_FILE), "utf8")).schema, STUCK_ACK_SCHEMA);
  fs.writeFileSync(progressPath, stale);

  const after = store.getStatus(admitted.jobId);
  assert.equal(after.acknowledgedStuckAt, "2026-10-12T13:14:15.000Z");
  assert.equal(after.state, "unconfirmed");
  assert.equal(after.pendingCommand.commandId, "coordinate-plan-send-unknown");
  assert.equal(after.outcome.reason, "Worker outcome was not observed.");
  assert.equal(after.active, false);

  // Admission still sees the acknowledgement: the same send is unreplayed and
  // a later same-folder start stays refused.
  assert.throws(() => start(store), { code: "stuck-acknowledged" });
  const sameFolder = store.startAdmission(admission({ requestId: "send-background-2" }));
  assert.equal(sameFolder.ok, false);
  assert.equal(sameFolder.reason, "workspace-held");
  assert.equal(sameFolder.existingJobId, admitted.jobId);

  // Re-acknowledging stays idempotent and still writes no progress bytes.
  assert.equal(store.acknowledgeStuck(admitted.jobId).acknowledgedStuckAt, "2026-10-12T13:14:15.000Z");
  assert.equal(fs.readFileSync(progressPath, "utf8"), stale);

  // A malformed marker refuses fail-closed rather than reading unacknowledged.
  fs.writeFileSync(pathFor(profile, admitted.jobId, STUCK_ACK_FILE), "{not json");
  assert.throws(() => store.getStatus(admitted.jobId), { code: "malformed-state" });
});

test("an outcome that lands while acknowledging is not erased by the acknowledgement", (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-job-ack-race-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const progressPath = pathFor(profile, FIXED_JOB_ID, "progress.json");
  let armed = false;
  let injected = false;
  let injectedFrom = null;
  const injectNewerOutcome = () => {
    if (!armed || injected) return;
    injected = true;
    const newer = {
      ...JSON.parse(fs.readFileSync(progressPath, "utf8")),
      phase: "unconfirmed",
      outcome: { status: "unconfirmed", reason: "a newer worker outcome", recordedAt: "2026-10-12T13:14:16.000Z" },
      updatedAt: "2026-10-12T13:14:16.000Z",
    };
    fs.writeFileSync(progressPath, `${JSON.stringify(newer, null, 2)}\n`);
  };
  // Either commit point triggers the worker's newer outcome once: the legacy
  // progress rename (before the fix) or the marker create (the fix).
  const fsApi = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") return (from, to) => {
        if (String(to).endsWith("progress.json")) { injectedFrom = "progress"; injectNewerOutcome(); }
        return target.renameSync(from, to);
      };
      if (property === "openSync") return (file, ...args) => {
        if (String(file).endsWith(STUCK_ACK_FILE)) { injectedFrom = "marker"; injectNewerOutcome(); }
        return target.openSync(file, ...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const store = createCoordinationJobStore(profile, {
    bootstrapReady: true,
    fsApi,
    idFactory: () => FIXED_JOB_ID,
    tokenFactory: () => FIXED_TOKEN,
    clock: () => "2026-10-12T13:14:15.000Z",
  });
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  store.recordPendingCommand(admitted.jobId, { commandId: "coordinate-plan-send-unknown", role: "planning" }, ownerToken);
  store.recordOutcome(admitted.jobId, { status: "unconfirmed", reason: "Worker outcome was not observed." }, ownerToken);
  armed = true;
  const left = store.acknowledgeStuck(admitted.jobId);
  assert.equal(injected, true);
  assert.equal(injectedFrom, "marker");
  assert.equal(left.acknowledgedStuckAt, "2026-10-12T13:14:15.000Z");
  assert.equal(left.outcome.reason, "a newer worker outcome");
  assert.equal(left.state, "unconfirmed");
  assert.equal(store.getStatus(admitted.jobId).outcome.recordedAt, "2026-10-12T13:14:16.000Z");
  assert.equal(store.startAdmission(admission({ requestId: "send-background-2" })).reason, "workspace-held");
});
const { workspaceIdentity } = require('./coordination-job.cjs');
test("POSIX trailing backslashes identify a different folder without releasing the original hold", { skip: process.platform === "win32" }, t => {
  let next = 0;
  const { profile, store } = fixture(t, { idFactory: () => next++ === 0 ? FIXED_JOB_ID : "223e4567-e89b-42d3-a456-426614174000" });
  const held = path.join(profile, "repo"), different = held + "\\";
  fs.mkdirSync(held); fs.mkdirSync(different);
  assert.notEqual(fs.statSync(held).ino, fs.statSync(different).ino);
  assert.notEqual(workspaceIdentity(held, "linux"), workspaceIdentity(different, "linux"));
  assert.equal(workspaceIdentity(different, "linux"), different);
  assert.equal(workspaceIdentity(different + "/", "linux"), different);
  assert.equal(workspaceIdentity(path.join(profile, "missing") + "\\", "linux").endsWith("\\"), true);
  const first = start(store, { workspacePath: held });
  const priorState = store.getStatus(first.jobId).state;
  const admissionFile = pathFor(profile, first.jobId, "admission.json"), before = fs.readFileSync(admissionFile);
  store.acknowledgeStuck(first.jobId);
  assert.equal(start(store, { requestId: "same-folder", workspacePath: held }).reason, "workspace-held");
  const replacement = start(store, { requestId: "different-folder", workspacePath: different });
  assert.equal(replacement.jobId, "223e4567-e89b-42d3-a456-426614174000");
  assert.equal(store.getStatus(replacement.jobId).admission.workspacePath, different);
  assert.equal(store.getStatus(first.jobId).state, priorState);
  assert.equal(store.getStatus(first.jobId).acknowledgedStuckAt, "2026-10-12T13:14:15.000Z");
  assert.deepEqual(fs.readFileSync(admissionFile), before);
});
const { skipAliasKind } = require('./test-symlink-support.cjs');
for (const kind of ['junction', 'symlink']) test(`native ${kind} identity and alias/.. retain acknowledged holds`, { skip: skipAliasKind(kind) }, async t => {
  const { profile, store } = fixture(t);
  const held = path.join(profile, 'physical', 'held');
  const child = path.join(held, 'child');
  const aliasParent = path.join(profile, 'separate-alias-parent');
  fs.mkdirSync(child, { recursive: true }); fs.mkdirSync(aliasParent);
  const alias = path.join(aliasParent, 'alias');
  try { fs.symlinkSync(child, alias, kind === 'junction' ? 'junction' : 'dir'); }
  catch (error) { assert.fail(`MISSING COVERAGE: ${kind} creation failed: ${error.code}`); }
  t.diagnostic(`${kind} actually created on ${process.platform}`);
  const traversal = alias + path.sep + '..'; // Never path.join: it erases the regression.
  assert.equal(workspaceIdentity(traversal), workspaceIdentity(held));
  assert.notEqual(workspaceIdentity(traversal), workspaceIdentity(aliasParent));
  const directAlias = path.join(aliasParent, 'held-alias');
  fs.symlinkSync(held, directAlias, kind === 'junction' ? 'junction' : 'dir');
  assert.equal(workspaceIdentity(directAlias), workspaceIdentity(held));
  assert.equal(workspaceIdentity(directAlias + path.sep), workspaceIdentity(held));
  const first = start(store, { workspacePath: held }); store.acknowledgeStuck(first.jobId);
  assert.equal(start(store, { requestId: 'alias-replacement', workspacePath: traversal }).reason, 'workspace-held');
  assert.equal(start(store, { requestId: 'direct-alias-replacement', workspacePath: directAlias }).reason, 'workspace-held');
  const missing = alias + path.sep + 'new' + path.sep + 'leaf';
  assert.equal(workspaceIdentity(missing), workspaceIdentity(path.join(child, 'new', 'leaf')));
  const broken = path.join(aliasParent, 'broken');
  fs.symlinkSync(path.join(profile, 'absent-target'), broken, kind === 'junction' ? 'junction' : 'dir');
  assert.equal(workspaceIdentity(broken), null);
  assert.equal(workspaceIdentity(broken + path.sep + 'missing'), null);
  assert.equal(start(store, { requestId: 'broken-replacement', workspacePath: broken }).reason, 'workspace-held');
  assert.throws(() => normalizeAdmissionInput(admission({ workspacePath: broken, writeAuthorization: { workspaceRoot: broken, instances: ['reader-a'], maxTurns: 1 } })), { code: 'invalid-admission' });
  assert.equal(workspaceIdentity('relative'), null);
  assert.equal(workspaceIdentity(held + '\u0000'), null);
  const file = path.join(profile, 'file'); fs.writeFileSync(file, 'x');
  assert.equal(workspaceIdentity(file + path.sep + 'child'), null);
  assert.equal(workspaceIdentity(file + path.sep + '..'), null);
  const loop = path.join(aliasParent, 'loop');
  fs.symlinkSync(loop, loop, kind === 'junction' ? 'junction' : 'dir');
  assert.equal(workspaceIdentity(loop), null);
  assert.equal(store.getStatus(first.jobId).admission.workspacePath, held);
  // Existing serialized admissions stay byte-for-byte immutable on re-read.
  const admissionFile = pathFor(profile, first.jobId, 'admission.json');
  const before = fs.readFileSync(admissionFile, 'utf8');
  const reopened = createCoordinationJobStore(profile, { bootstrapReady: true });
  assert.equal(reopened.getStatus(first.jobId).admission.workspacePath, held);
  assert.equal(fs.readFileSync(admissionFile, 'utf8'), before);
});
test('identity rejects filesystem permission and loop errors without a lexical or cwd fallback', () => {
  const original = fs.realpathSync.native;
  try {
    for (const code of ['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP', 'EIO']) {
      fs.realpathSync.native = () => { throw Object.assign(new Error('injected native error'), { code }); };
      assert.equal(workspaceIdentity(path.resolve('unresolvable-workspace')), null, code);
    }
  } finally { fs.realpathSync.native = original; }
  if (process.platform === 'win32') {
    assert.equal(workspaceIdentity('\\rooted-without-drive'), null);
    assert.equal(workspaceIdentity('/rooted-without-drive'), null);
  }
});

test("an acknowledged job allows its claimed worker to complete and record outcome without reclaiming slot", (t) => {
  let n = 0;
  const ids = [FIXED_JOB_ID, "223e4567-e89b-42d3-a456-426614174001", "323e4567-e89b-42d3-a456-426614174002"];
  const { profile, store } = fixture(t, { idFactory: () => ids[n++] });
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  store.recordPendingCommand(admitted.jobId, { commandId: "cmd-1", role: "planning" }, ownerToken);
  
  const left = store.acknowledgeStuck(admitted.jobId);
  assert.equal(left.active, false);
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), false);
  
  // Wrong token is still rejected
  assert.throws(() => store.completeCommand(admitted.jobId, { commandId: "cmd-1", facts: { done: true } }, "0".repeat(64)), { code: "not-worker-owner" });
  
  // Real owner token succeeds to complete command
  const completedStatus = store.completeCommand(admitted.jobId, { commandId: "cmd-1", facts: { done: true } }, ownerToken);
  assert.equal(completedStatus.pendingCommand, null);
  assert.equal(completedStatus.completedCommands.length, 1);
  assert.equal(completedStatus.active, false);
  
  // Settle-only: cannot admit new commands
  assert.throws(() => store.recordPendingCommand(admitted.jobId, { commandId: "cmd-2", role: "execution" }, ownerToken), { code: "stuck-acknowledged" });
  
  // Record outcome succeeds and reaches terminal
  const outcomeStatus = store.recordOutcome(admitted.jobId, { status: "completed", reason: "Done" }, ownerToken);
  assert.equal(outcomeStatus.state, "completed");
  assert.equal(outcomeStatus.active, false);
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), false);
  
  // releaseAdmission is an idempotent no-op
  const releaseStatus = store.releaseAdmission(admitted.jobId, ownerToken);
  assert.equal(releaseStatus.state, "completed");
  assert.equal(fs.existsSync(path.join(profile, "coordination-jobs", "active-admission.json")), false);
  
  // Hold is now freed on the same folder
  const nextSameFolder = store.startAdmission(admission({ requestId: "send-next" }));
  assert.equal(nextSameFolder.ok, true);
  assert.equal(nextSameFolder.created, true);
});

test("an acknowledged job settling does not touch or clear another job's re-occupied slot", (t) => {
  let n = 0;
  const ids = ["423e4567-e89b-42d3-a456-426614174001", "523e4567-e89b-42d3-a456-426614174002", "623e4567-e89b-42d3-a456-426614174003"];
  const { profile, store } = fixture(t, { idFactory: () => ids[n++] });
  const jobA = store.startAdmission(admission({ requestId: "req-A", workspacePath: path.resolve("/tmp/ws-A") }));
  const { ownerToken: tokenA } = store.claimWorker(jobA.jobId);
  store.recordPendingCommand(jobA.jobId, { commandId: "cmd-A1", role: "planning" }, tokenA);
  
  store.acknowledgeStuck(jobA.jobId);
  
  // Job B starts on another workspace, re-occupying the active slot
  const jobB = store.startAdmission(admission({ requestId: "req-B", workspacePath: path.resolve("/tmp/ws-B") }));
  assert.equal(jobB.ok, true);
  assert.equal(store.getActiveStatus().jobId, jobB.jobId);
  
  // Job A's worker settles in the background
  store.completeCommand(jobA.jobId, { commandId: "cmd-A1", facts: { done: true } }, tokenA);
  store.recordOutcome(jobA.jobId, { status: "completed", reason: "Done A" }, tokenA);
  store.releaseAdmission(jobA.jobId, tokenA);
  
  // Job A is terminal
  assert.equal(store.getStatus(jobA.jobId).state, "completed");
  
  // Job B's active slot is completely untouched!
  assert.equal(store.getActiveStatus().jobId, jobB.jobId);
});

test("revoke writes revocation marker on active unconfirmed job while keeping state unconfirmed and slot held", (t) => {
  const { profile, store } = fixture(t);
  const admitted = start(store);
  const { ownerToken } = store.claimWorker(admitted.jobId);
  store.recordPendingCommand(admitted.jobId, { commandId: "cmd-u1", role: "planning" }, ownerToken);
  store.recordOutcome(admitted.jobId, { status: "unconfirmed", reason: "Unconfirmed outcome" }, ownerToken);

  const beforeRevoke = store.getStatus(admitted.jobId);
  assert.equal(beforeRevoke.state, "unconfirmed");
  assert.equal(beforeRevoke.active, true);
  assert.equal(beforeRevoke.revoked, false);

  const revokedStatus = store.revoke(admitted.jobId);
  assert.equal(revokedStatus.state, "unconfirmed");
  assert.equal(revokedStatus.revoked, true);
  assert.equal(fs.existsSync(pathFor(profile, admitted.jobId, "revocation.json")), true);

  // Profile slot stays held: cannot release an unconfirmed job
  assert.throws(() => store.releaseAdmission(admitted.jobId, ownerToken), { code: "job-not-terminal" });
  assert.equal(store.getActiveStatus().jobId, admitted.jobId);

  // Terminal jobs (completed/failed/stopped) without unconfirmed state still refuse to create new revocation markers while actively admitted
  const termProfile = fs.mkdtempSync(path.join(os.tmpdir(), "goalport-term-revoke-"));
  t.after(() => fs.rmSync(termProfile, { recursive: true, force: true }));
  const termStore = createCoordinationJobStore(termProfile, { bootstrapReady: true });
  for (const terminalStatus of ["completed", "failed", "stopped"]) {
    const job = termStore.startAdmission(admission({ requestId: `req-${terminalStatus}`, workspacePath: path.resolve(`/tmp/ws-${terminalStatus}`) }));
    const { ownerToken: tok } = termStore.claimWorker(job.jobId);
    termStore.recordPendingCommand(job.jobId, { commandId: `cmd-${terminalStatus}`, role: "planning" }, tok);
    termStore.completeCommand(job.jobId, { commandId: `cmd-${terminalStatus}`, facts: { ok: true } }, tok);
    termStore.recordOutcome(job.jobId, { status: terminalStatus, reason: "done" }, tok);

    // Verify while still actively admitted in slot:
    const statusBefore = termStore.getStatus(job.jobId);
    assert.equal(statusBefore.state, terminalStatus);
    const res = termStore.revoke(job.jobId);
    assert.equal(res.state, terminalStatus);
    assert.equal(fs.existsSync(pathFor(termProfile, job.jobId, "revocation.json")), false);

    // Release after check
    termStore.releaseAdmission(job.jobId, tok);
  }
});
