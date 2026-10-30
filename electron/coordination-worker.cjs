"use strict";
const path = require("node:path");
const net = require("node:net");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createCoordinationJobStore } = require("./coordination-job.cjs");
const { createBackgroundSendConsentStore } = require("./background-send-consent.cjs");
const { createCoreConnection } = require("./core-client.cjs");
const { assertPipePeer, assertCoreIdentity, pipePeerBusy } = require("./launch-config.cjs");
const { createHarnessRuntime } = require("./harness-runtime.cjs");
const { discoverCliProviders } = require("./cli-coordinate.cjs");
const { authorizeCoordination, authorizeMembershipError, discoverCoordination, launchOne } = require("./coordinate-service.cjs");
const { saveRecord } = require("./coordination-record.cjs");
const liveRead = require("./live-read-once.cjs");

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
  let runtime;
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
  // The packaged app has no GOALPORT_COORDINATE_SEND override: discovery and
  // every launch must consult the durable profile consent the user granted.
  // The reader is created after the pre-start return so a job stopped before
  // it ever started still contacts nothing; each call re-reads, so a revoke
  // between discovery and launch refuses that launch.
  const consentStore = deps.consentStore ?? createBackgroundSendConsentStore(config.directory);
  const consentReader = deps.consentReader ?? (() => consentStore.read());
  const admitted = claim.status.admission;
  runtime = deps.runtime ?? createHarnessRuntime({ stateDir: config.stateDir, cliProbe: { cwd: admitted.workspacePath, routeAwarePi: process.platform === "linux" || !!admitted.piCapacity }, ...(admitted.piCapacity ? { piCapacity: admitted.piCapacity } : {}) });
  let input = { requestId: admitted.requestId, goal: admitted.goal, workspaceRoot: admitted.workspacePath,
    readInstances: admitted.allowedInstances, readMaxTurns: admitted.maxTurns,
    ...(admitted.writeAuthorization ? { write: admitted.writeAuthorization } : {}), priorPlan: admitted.priorPlan,
    priorReview: admitted.priorReview, avoidInstances: admitted.avoidInstances,
    ...(admitted.executionFeedback ? { executionFeedback: admitted.executionFeedback } : {}), backgroundConsent: true,
    ...(admitted.continuation ? { continuation: admitted.continuation } : {}),
    ...(admitted.piCapacity ? { piCapacity: admitted.piCapacity } : {}),
    ...(admitted.nativeCheckTarget ? { nativeCheckTarget: admitted.nativeCheckTarget, nativeCheckMaterial: admitted.nativeCheckMaterial } : {}) };
  const owner = claim.ownerToken;
  let control, storageFailed = false, heldUnconfirmed = false, liveResult = null;
  const nowMs = deps.nowMs ?? (() => performance.now());
  const wallNowMs = deps.wallNowMs ?? Date.now;
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelScheduled = deps.cancelScheduled ?? clearTimeout;
  const mode = claim.status.followUpMode === liveRead.MODE && liveRead.eligible(admitted);
  let authorization, stage = "initial", initialResult = null, accepted = null, acceptedPrepared = null, idleDeadline = null, expiresAt = null, idleTimer = null;
  let wake;
  const waiter = new Promise(resolve => { wake = resolve; });
  const clearIdle = () => { if (idleTimer !== null) cancelScheduled(idleTimer); idleTimer = null; };
  const signal = (kind, data) => { clearIdle(); wake({ kind, data }); };
  const localFacts = () => {
    const facts = store.getStatus(config.jobId);
    store.assertWorkerOwner(config.jobId, owner);
    if (!facts.active || !facts.startupClaim || facts.acknowledgedStuckAt) throw Error("The original worker no longer owns this allowance.");
    return facts;
  };
  function getLiveReadStatus(base) {
    if (!mode) return null;
    let current = null, facts = base, reason = null;
    try { facts = localFacts(); current = scope.current(); } catch { reason = "unconfirmed"; }
    const same = current && authorization && current.generation === authorization.generation;
    if (!reason) reason = storageFailed ? "unconfirmed" : facts.revoked ? "revoked" : !same ? "no-live-scope"
      : idleDeadline !== null && nowMs() >= idleDeadline && !accepted ? "expired"
      : facts.pendingCommand || stage !== "ready" || accepted ? "busy"
      : !initialResult || current.write || (!accepted && Object.hasOwn(facts, "liveFollowUp")) ? "context-unavailable" : current.remaining < 2 ? "not-enough-reads" : null;
    return { mode: liveRead.MODE, ready: reason === null, initialRequestId: admitted.requestId, fromRequestId: admitted.requestId,
      rootRequestId: admitted.continuation?.rootRequestId ?? admitted.requestId, remainingReads: same ? current.remaining : null,
      readonly: !!same && !current.write, pending: !!facts?.pendingCommand, revoked: facts?.revoked === true,
      childRequestId: accepted?.requestId ?? null, expiresAt, reason };
  }
  function beforeGuardedRevoke(payload) {
    if (payload.onlyIfReadyFromRequestId !== admitted.requestId || !getLiveReadStatus(localFacts())?.ready) throw Error("The allowance is no longer idle; the current work was not stopped.");
  }
  function onRevoke({ storageError }) {
    if (storageError) storageFailed = true;
    if (stage === "ready" || stage === "validating") {
      stage = storageError ? "unconfirmed" : "ending";
      signal(storageError ? "storage-error" : "revoke");
    }
  }
  async function onContinue(payload) {
    payload = liveRead.controlPayload("continue", payload);
    if (!mode || payload.fromRequestId !== admitted.requestId) throw Error("This is not the open initial result.");
    if (accepted) {
      if (payload.requestId === accepted.requestId && payload.followUp === accepted.followUp) return;
      throw Error("This allowance already accepted a different follow-up.");
    }
    if (!getLiveReadStatus(localFacts())?.ready) throw Error("The live allowance is not ready.");
    stage = "validating";
    const operationDeadline = nowMs() + 10000;
    let timeout;
    const checks = (async () => {
      await gate();
      const fresh = await (deps.discover ?? discoverCliProviders)({ stateDir: runtime.stateDir, cwd: admitted.workspacePath, routeAwarePi: true });
      const context = require("./pi-capacity-admission.cjs").piAdmissionContext({ ...admitted, continuation: undefined }, config.directory, fresh);
      const membership = authorizeMembershipError(fresh, admitted.allowedInstances, context);
      if (membership) throw Error(membership);
      const discovery = await discoverCoordination(env, { ...runtime, discover: async () => fresh }, admitted.requestId, consentReader);
      if (!discovery.connected || !discovery.sendAuthorized) throw Error(discovery.stopReason || "Background Send is not enabled.");
      const originalGoal = admitted.continuation?.originalGoal ?? admitted.goal;
      const child = { ...input, requestId: payload.requestId, goal: originalGoal, priorPlan: initialResult.planText, priorReview: initialResult.reviewText,
        continuation: { parentRequestId: admitted.requestId, rootRequestId: admitted.continuation?.rootRequestId ?? admitted.requestId, originalGoal, followUp: payload.followUp } };
      delete child.executionFeedback;
      // No saved result ID may be claimed as a new child, even outside this job.
      const records = require("./coordination-record.cjs").readRecords(config.directory);
      if (records.some(r => r.requestId === payload.requestId)
        || require("./pi-capacity-admission.cjs").ownAdmissionForRequest(config.directory, payload.requestId)) throw Error("That follow-up identity already exists.");
      if (typeof engine.preflightBackgroundContinuation !== "function") throw Error("Live continuation assembly is unavailable.");
      engine.preflightBackgroundContinuation(child, discovery.providers);
      return { child, discovery, context };
    })();
    try {
      const prepared = await Promise.race([checks, new Promise((_, reject) => { timeout = schedule(() => reject(Error("The live checks timed out; nothing was accepted.")), 10000); })]);
      // Checks can finish after Stop/expiry/operation timeout. Never let their
      // completion resurrect readiness or write accepted input.
      const facts = localFacts(), current = scope.current();
      if (stage !== "validating" || storageFailed || facts.revoked || facts.pendingCommand || accepted || nowMs() >= operationDeadline
        || idleDeadline === null || nowMs() >= idleDeadline || !current || current.generation !== authorization.generation || current.write || current.remaining < 2) throw Error("The allowance changed or expired; nothing was accepted.");
      const c = prepared.child.continuation;
      const context = { requestId: payload.requestId, fromRequestId: admitted.requestId, rootRequestId: c.rootRequestId, originalGoal: c.originalGoal,
        followUp: payload.followUp, workspacePath: admitted.workspacePath, piCapacity: admitted.piCapacity, backgroundConsent: true, write: false,
        initialPlan: initialResult.planText, initialReview: initialResult.reviewText, acceptedAt: new Date(wallNowMs()).toISOString(), phase: "accepted" };
      try { store.recordLiveFollowUpAccepted(config.jobId, context, owner); }
      catch (error) {
        if (["live-unavailable", "live-conflict", "invalid-live-context"].includes(error?.code)) {
          if (localFacts().revoked) { stage = "ending"; signal("revoke"); }
          throw error;
        }
        storageFailed = true; stage = "unconfirmed"; signal("storage-error"); throw error;
      }
      accepted = context;
      acceptedPrepared = prepared;
      stage = "accepted";
      signal("continue-accepted", prepared);
    } catch (error) {
      if (stage === "validating") stage = "ready"; // deadline never extended
      throw error;
    } finally { if (timeout !== undefined) cancelScheduled(timeout); }
  }
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
    const freshDiscovery = await (deps.discover ?? discoverCliProviders)({ stateDir: runtime.stateDir, cwd: admitted.workspacePath, routeAwarePi: process.platform === "linux" || !!admitted.piCapacity });
    const piContext = (process.platform === "linux" || admitted.piCapacity) && admitted.allowedInstances.includes("pi")
      ? require("./pi-capacity-admission.cjs").piAdmissionContext(admitted, config.directory, freshDiscovery)
      : undefined;
    authorization = await authorizeCoordination({ instances: input.readInstances, maxTurns: input.readMaxTurns, ...(input.write ? { write: input.write } : {}) }, scope, () => freshDiscovery, piContext);
    if (!authorization.ok) throw new Error(authorization.errorText);
    const discovery = await discoverCoordination(env, { ...runtime, discover: async () => freshDiscovery }, input.requestId, consentReader);
    if (!discovery.connected || !discovery.sendAuthorized) throw new Error(discovery.stopReason || "Background Send is not enabled.");
    persist({ phase: "running", counters: counters(), display: { activity: "Organizing this goal…", failures: [] } });
    control = await store.startControlServer({ jobId: config.jobId, endpoint: config.controlEndpoint,
      getLiveReadStatus, onContinue, beforeGuardedRevoke, onRevoke });
    const failures = [];
    const launchCheck = async command => {
      try { await gate(); } catch (error) { return { launched: false, dispatched: false, text: "", errorText: error.message }; }
      try { store.recordPendingCommand(config.jobId, { commandId: command.commandId, role: command.commandId.includes("execute") ? "execution" : command.commandId.includes("audit") ? "audit" : command.commandId.includes("review") ? "review" : "planning" }, owner); } catch (error) {
        if (error?.code === "access-revoked" || error?.code === "stuck-acknowledged") {
          // The store proved the durable stop won the admission race and
          // already settled the recorded command as never sent. That is a
          // clean refusal, not a storage failure: mark the launch proven
          // not-sent and let the run settle an honest terminal outcome
          // instead of retaining an unconfirmed admission forever.
          const msg = error.code === "access-revoked"
            ? "Access was stopped; this command was not sent."
            : "This goal was left unreplayed; this command was not sent.";
          return { launched: false, dispatched: false, text: "", errorText: msg };
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
      } }, command, admitted.requestId, { scope, scopeGeneration: authorization.generation }, consentReader);
      // Live evidence remains in memory even when the completion write fails.
      liveResult = result;
      try {
        if (result.dispatched === null) persist({ detail: "Command outcome unconfirmed; this admission will not be replayed.", display: { ...(store.getStatus(config.jobId).progress ?? {}), partialResult: result }, counters: counters() });
        else store.completeCommand(config.jobId, { commandId: command.commandId, facts: result, counters: counters() }, owner);
      } catch { storageFailed = true; }
      return result;
    };
    const runOrdinaryRound = async (roundDiscovery, roundPiContext) => engine.requestCoordination({
      ...engine.backgroundEngineInput(input),
      ...(roundPiContext?.legacyPiContinuation ? { legacyPiContinuation: true } : {}),
      // Host capability, not persisted admission/renderer authority. The CLI
      // independently checks the actual platform and final audit command.
      ...(process.platform === "linux" ? { auditPromptTransport: "linux-pi-stdin" } : {}),
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
    }, roundDiscovery, { launch: launchCheck
    }, () => true);
    const runRound = async (roundDiscovery, roundPiContext) => {
      if (!input.nativeCheckTarget) return runOrdinaryRound(roundDiscovery, roundPiContext);
      await gate();
      const purpose = require('./native-workspace-check.cjs');
      const resolved = await purpose.resolveTarget(core, await core.invoke({ protocolVersion: 'goalport.ipc.v2', requestId: 'native-check-worker-' + randomUUID(), entityVersion: 0, messageType: 'snapshot', payload: {} }), input.nativeCheckTarget);
      if (resolved.workspace !== admitted.workspacePath) throw Error(purpose.STALE);
      await (deps.recheckNativeMaterial ?? purpose.recheckMaterial)(resolved, input.nativeCheckMaterial, engine);
      const latest = await purpose.resolveTarget(core, await core.invoke({ protocolVersion: 'goalport.ipc.v2', requestId: 'native-check-worker-final-' + randomUUID(), entityVersion: 0, messageType: 'snapshot', payload: {} }), input.nativeCheckTarget);
      if (latest.workspace !== resolved.workspace || latest.taskId !== resolved.taskId || JSON.stringify(latest.context) !== JSON.stringify(resolved.context)) throw Error(purpose.STALE);
      const command = engine.buildNativeWorkspaceCheckCommand(input);
      persist({ display: { activity: 'Pi is checking the shared workspace snapshot…', failures } });
      const result = await launchCheck(command);
      const returned = result.launched && result.dispatched === true && !result.errorText && !!result.text;
      return { recordKind: 'native-workspace-check', nativeCheckTarget: input.nativeCheckTarget, nativeCheckMaterial: input.nativeCheckMaterial,
        planningHarness: null, reviewHarness: null, planText: null, reviewText: null, executionHarness: null, executionText: null,
        auditHarness: 'Pi', auditText: returned ? result.text : null, result: returned ? result.text : null,
        verdict: result.dispatched === null ? 'unconfirmed' : returned ? 'checked' : 'stopped',
        stopReason: returned ? 'Independent workspace check returned. This is a dated workspace snapshot, not native verification.' : result.errorText || 'Pi did not return a workspace check.',
        planningQuota: null, reviewQuota: null, messageDispatched: result.dispatched, environmentBlocked: false,
        auditInputEvidenceText: input.nativeCheckMaterial.deliveredEvidence };
    };
    liveResult = await runRound(discovery, piContext);
    const saveResult = () => (deps.saveRecord ?? saveRecord)(config.directory, {
      ...liveResult, requestId: input.requestId, workspacePath: input.workspaceRoot, goal: input.goal,
      savedAt: new Date(wallNowMs()).toISOString(), ...(input.continuation ? { continuation: input.continuation } : {}),
      ...(input.piCapacity ? { piCapacity: input.piCapacity } : {}) });
    let initialSaved = false, initialSaveFailed = false, allowanceEnd;
    if (mode && !storageFailed && liveResult.verdict === "checked" && liveResult.planText && liveResult.reviewText) {
      const facts = localFacts(), current = scope.current();
      if (!facts.pendingCommand && !facts.revoked && current && current.generation === authorization.generation && !current.write && current.remaining >= 2) {
        try {
          const saved = saveResult();
          initialSaved = true;
          if (saved?.requestId === admitted.requestId && saved.verdict === "checked" && saved.planText && saved.reviewText) initialResult = saved;
          else initialSaveFailed = true;
        } catch { initialSaveFailed = true; }
        if (initialSaved && initialResult) {
          idleDeadline = nowMs() + 900000;
          expiresAt = new Date(wallNowMs() + 900000).toISOString();
          persist({ phase: "awaiting-followup", counters: counters(), display: { activity: "Ready for one follow-up. No model is running.", failures } });
          stage = "ready";
          idleTimer = schedule(() => {
            if (!["ready", "validating"].includes(stage) || accepted || storageFailed || nowMs() < idleDeadline) return;
            try {
              const facts = localFacts(), current = scope.current();
              if (facts.pendingCommand || !current || current.generation !== authorization.generation) {
                heldUnconfirmed = true; stage = "unconfirmed"; signal("storage-error"); return;
              }
              stage = "ending"; signal(facts.revoked ? "revoke" : "idle-expired");
            } catch { storageFailed = true; stage = "unconfirmed"; signal("storage-error"); }
          }, 900000);
          if (localFacts().revoked) onRevoke({ storageError: false });
          const event = await waiter;
          if (event.kind === "storage-error") throw Error("The allowance end could not be confirmed; its admission remains held.");
          if (acceptedPrepared) {
            input = acceptedPrepared.child;
            stage = "running";
            store.updateLiveFollowUpPhase(config.jobId, "running", owner);
            persist({ phase: "followup-running", display: { activity: "Organizing the follow-up…", failures } });
            liveResult = await runRound(acceptedPrepared.discovery, acceptedPrepared.context);
          } else {
            allowanceEnd = event.kind === "idle-expired" ? "expired" : "idle-stopped";
          }
        }
      }
    }
    stage = "ending";
    if (storageFailed) throw new Error("Job storage failed after a turn; admission and pending facts are retained, not retryable.");
    const pending = store.getStatus(config.jobId).pendingCommand;
    const currentStatus = store.getStatus(config.jobId);
    const status = pending || liveResult.verdict === "unconfirmed"
      ? "unconfirmed"
      : currentStatus.revoked || currentStatus.acknowledgedStuckAt
        ? "stopped"
        : ["verified", "checked", "revise"].includes(liveResult.verdict)
          ? "completed"
          : "failed";
    // The plan record (history/Plans) and the job's own terminal outcome
    // are separate durable facts. A record-save failure must not prevent
    // the honest terminal outcome, the scope revoke, or the admission
    // release — otherwise one failed history write wedges the profile slot
    // forever and no later goal can start. The outcome carries an honest
    // note instead; the success path keeps the audited record-before-
    // outcome order unchanged.
    let recordSaveFailed = initialSaveFailed;
    try { if ((!initialSaved && !initialSaveFailed) || accepted) saveResult(); } catch { recordSaveFailed = true; }
    if (accepted) store.updateLiveFollowUpPhase(config.jobId, status === "unconfirmed" ? "unconfirmed" : "completed", owner);
    store.recordOutcome(config.jobId, {
      status,
      report: liveResult,
      ...(allowanceEnd ? { allowanceEnd } : {}),
      ...(recordSaveFailed ? { error: "The saved plan record could not be written; the retained result below is this job's own record." } : {}),
    }, owner);
    if (status !== "unconfirmed") store.releaseAdmission(config.jobId, owner);
    return { status, report: liveResult, ...(recordSaveFailed ? { recordSaveFailed: true } : {}) };
  } catch (error) {
    if (!storageFailed && !heldUnconfirmed) {
      try {
        const s = store.getStatus(config.jobId);
        const status = s.pendingCommand ? "unconfirmed" : "failed";
        store.recordOutcome(config.jobId, { status, error: error.message, partialResult: liveResult }, owner);
        if (status !== "unconfirmed") store.releaseAdmission(config.jobId, owner);
      } catch { storageFailed = true; }
    }
    return { status: "unconfirmed", error: error.message, partialResult: liveResult, storageFailed, ...(heldUnconfirmed ? { unconfirmedHeld: true } : {}) };
  } finally {
    stage = "closed";
    clearIdle();
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
