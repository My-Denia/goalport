"use strict";
const path = require("node:path");
const net = require("node:net");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createCoordinationJobStore } = require("./coordination-job.cjs");
const { createCoreConnection } = require("./core-client.cjs");
const { assertPipePeer, assertCoreIdentity, pipePeerBusy } = require("./launch-config.cjs");
const { createHarnessRuntime } = require("./harness-runtime.cjs");
const { discoverCliProviders } = require("./cli-coordinate.cjs");
const { authorizeCoordination, discoverCoordination, launchOne } = require("./coordinate-service.cjs");
const { saveRecord } = require("./coordination-record.cjs");

const { coreRefusal, guardCoreCoverage } = require("./coordination-core-guard.cjs");
function workerCore(config) {
  return createCoreConnection({
    connectPath: () => config.connectPath,
    connect: target => net.createConnection(target),
    runPeer: () => new Promise(resolve => execFile(config.coreBinary, ["pipe-peer", "--pipe", config.servePipe], { timeout: 5000, windowsHide: true }, (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout: String(stdout ?? "") }))),
    isBusy: pipePeerBusy,
    assertPeer: (stdout, receipt) => { assertPipePeer(stdout, receipt); assertCoreIdentity(receipt, config.identity); },
    // Even isolated profile-less runs receive a main-resolved identity here.
    allowedMessageTypes: ["snapshot", "goal_overview", "goal_detail"],
    ensureCore: async () => { throw new Error("The background worker cannot start or recover Core."); },
  });
}
async function runWorker(config, deps = {}) {
  const store = deps.store ?? createCoordinationJobStore(config.directory, { bootstrapReady: true });
  const scope = deps.scope ?? require("./coordination-scope.cjs");
  const engine = deps.engine ?? require(config.enginePath);
  const runtime = deps.runtime ?? createHarnessRuntime({ stateDir: config.stateDir });
  const core = deps.core ?? workerCore(config);
  const env = deps.env ?? process.env;
  const claim = store.claimWorker(config.jobId);
  if (claim.settledPreStartRevocation) {
    // The admission was stopped before this worker started: the store
    // proved from durable facts (no prior claim, no recorded command) that
    // no tool call was ever admitted, and the claim itself already settled
    // the terminal stopped outcome and released the admission slot.
    // Settling is this run's whole job — no Core, scope, harness or engine
    // is contacted, and no record is saved for a round that never ran.
    return { status: "stopped", settledPreStartRevocation: true };
  }
  const admitted = claim.status.admission;
  const input = { requestId: admitted.requestId, goal: admitted.goal, workspaceRoot: admitted.workspacePath,
    readInstances: admitted.allowedInstances, readMaxTurns: admitted.maxTurns,
    ...(admitted.writeAuthorization ? { write: admitted.writeAuthorization } : {}), priorPlan: admitted.priorPlan,
    priorReview: admitted.priorReview, avoidInstances: admitted.avoidInstances,
    ...(admitted.executionFeedback ? { executionFeedback: admitted.executionFeedback } : {}), backgroundConsent: true };
  const owner = claim.ownerToken;
  let control, storageFailed = false, liveResult = null;
  const counters = () => { const s = scope.current(); return { readTurnsRemaining: s?.remaining ?? null, writeTurnsRemaining: s?.write?.remaining ?? null }; };
  const persist = patch => { try { store.updateProgress(config.jobId, patch, owner); } catch (error) { storageFailed = true; throw error; } };
  async function gate() {
    if (storageFailed) throw new Error("Job progress could not be retained; no further turn was sent.");
    if (store.getStatus(config.jobId).pendingCommand) throw new Error("A previous command remains unconfirmed; no further turn was sent.");
    if (store.getStatus(config.jobId).revoked) { scope.revoke(); throw new Error("Access stopped; the current turn may finish, but no further turn was sent."); }
    const snapshot = await core.invoke({ protocolVersion: "goalport.ipc.v2", requestId: `background-check-${randomUUID()}`, entityVersion: 0, messageType: "snapshot", payload: {} });
    await guardCoreCoverage(core, snapshot);
  }
  try {
    await gate();
    const authorization = await authorizeCoordination({ instances: input.readInstances, maxTurns: input.readMaxTurns, ...(input.write ? { write: input.write } : {}) }, scope, () => (deps.discover ?? discoverCliProviders)({ stateDir: runtime.stateDir }));
    if (!authorization.ok) throw new Error(authorization.errorText);
    const discovery = await discoverCoordination(env, runtime, input.requestId);
    if (!discovery.connected || !discovery.sendAuthorized) throw new Error(discovery.stopReason || "Background Send is not enabled.");
    persist({ phase: "running", counters: counters(), display: { activity: "Organizing this goal…", failures: [] } });
    control = await store.startControlServer({ jobId: config.jobId, endpoint: config.controlEndpoint });
    const failures = [];
    liveResult = await engine.requestCoordination({
      ...engine.backgroundEngineInput(input),
      beforePlanRevision: async checkpoint => {
        await gate();
        const s = scope.current();
        if (!s || s.generation !== authorization.generation || !s.write || s.remaining < 3 || s.write.remaining < 1) return false;
        persist({ phase: "plan-revision", display: { firstRound: checkpoint.firstRound, planRevision: true, activity: "One checked plan revision is being organized…", failures } });
        return true;
      },
      beforeRepair: async checkpoint => {
        await gate();
        const s = scope.current();
        if (!s || s.generation !== authorization.generation || !s.write || s.remaining < 3 || s.write.remaining < 1) return false;
        persist({ phase: "repair", display: { firstRound: checkpoint.firstRound, repair: true, activity: "One checked repair is being organized…", failures } });
        return true;
      },
      onEvent: event => {
        // Events are display facts. Failure stops the next admission without
        // throwing through the engine and erasing an already completed turn.
        try {
          if (event.kind === "failed") failures.push(event.sentence);
          const prior = store.getStatus(config.jobId).progress ?? {};
          persist({ display: { ...prior, failures: [...failures], activity: event.kind === "started" ? `${event.harness || event.instanceId} is ${event.role === "planning" ? "planning" : event.role === "review" ? "checking" : event.role === "execution" ? "making changes" : "verifying"}…` : event.sentence } });
        } catch { storageFailed = true; }
      },
    }, discovery, { launch: async command => {
      try { await gate(); } catch (error) { return { launched: false, dispatched: false, text: "", errorText: error.message }; }
      try { store.recordPendingCommand(config.jobId, { commandId: command.commandId, role: command.commandId.includes("execute") ? "execution" : command.commandId.includes("audit") ? "audit" : command.commandId.includes("review") ? "review" : "planning" }, owner); } catch (error) {
        if (error?.code === "access-revoked") {
          // The store proved the durable stop won the admission race and
          // already settled the recorded command as never sent. That is a
          // clean refusal, not a storage failure: mark the launch proven
          // not-sent and let the run settle an honest terminal outcome
          // instead of retaining an unconfirmed admission forever.
          return { launched: false, dispatched: false, text: "", errorText: "Access was stopped; this command was not sent." };
        }
        storageFailed = true;
        return { launched: false, dispatched: false, text: "", errorText: `The command could not be recorded; nothing was sent. ${error.message}` };
      }
      const result = await launchOne(env, { ...runtime, run: (admittedCommand, generation) => {
        // launchOne has charged the ORIGINAL scope before this synchronous
        // callback. Publish that observed counter before invoking the CLI.
        // A storage failure throws synchronously: the existing service's
        // never-started settlement applies; no runtime call happens.
        persist({ counters: counters() });
        return runtime.run(admittedCommand, generation);
      } }, command, input.requestId, { scope, scopeGeneration: authorization.generation });
      // Live evidence remains in memory even when the completion write fails.
      liveResult = result;
      try {
        if (result.dispatched === null) persist({ detail: "Command outcome unconfirmed; this admission will not be replayed.", display: { ...(store.getStatus(config.jobId).progress ?? {}), partialResult: result }, counters: counters() });
        else store.completeCommand(config.jobId, { commandId: command.commandId, facts: result, counters: counters() }, owner);
      } catch { storageFailed = true; }
      return result;
    } }, () => true);
    if (storageFailed) throw new Error("Job storage failed after a turn; admission and pending facts are retained, not retryable.");
    const pending = store.getStatus(config.jobId).pendingCommand;
    const status = pending || liveResult.verdict === "unconfirmed" ? "unconfirmed" : store.getStatus(config.jobId).revoked ? "stopped" : ["verified", "checked", "revise"].includes(liveResult.verdict) ? "completed" : "failed";
    try {
      (deps.saveRecord ?? saveRecord)(config.directory, { ...liveResult, requestId: input.requestId, workspacePath: input.workspaceRoot, goal: input.goal, savedAt: new Date().toISOString() });
      store.recordOutcome(config.jobId, { status, report: liveResult }, owner);
    } catch (error) { storageFailed = true; throw error; }
    scope.revoke();
    if (status !== "unconfirmed") store.releaseAdmission(config.jobId, owner);
    return { status, report: liveResult };
  } catch (error) {
    scope.revoke();
    if (!storageFailed) {
      try {
        const s = store.getStatus(config.jobId);
        const status = s.pendingCommand ? "unconfirmed" : "failed";
        store.recordOutcome(config.jobId, { status, error: error.message, partialResult: liveResult }, owner);
        if (status !== "unconfirmed") store.releaseAdmission(config.jobId, owner);
      } catch { storageFailed = true; }
    }
    return { status: "unconfirmed", error: error.message, partialResult: liveResult, storageFailed };
  } finally {
    scope.revoke();
    await control?.close();
    runtime.close();
  }
}
module.exports = { runWorker, coreRefusal, workerCore };
if (require.main === module) {
  const config = JSON.parse(process.argv[2]);
  runWorker(config).then(result => { process.exitCode = result.storageFailed ? 1 : 0; }).catch(error => { console.error(error); process.exitCode = 1; });
}
