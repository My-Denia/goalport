"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createCoordinationJobStore, requestControl } = require("./coordination-job.cjs");
const { coreRefusal } = require("./coordination-core-guard.cjs");
function projection(status, live = false) {
  if (!status) return null;
  const confirmedTerminal = ["completed", "failed", "stopped"].includes(status.state);
  return { jobId: status.jobId, requestId: status.requestId, goal: status.admission.goal, active: status.active,
    state: !confirmedTerminal && !live ? "unconfirmed" : status.state, live,
    revoked: status.revoked, pendingCommand: status.pendingCommand, completedCommands: status.completedCommands,
    counters: status.counters ? { readTurnsLeft: status.counters.readTurnsRemaining, writeTurnsLeft: status.counters.writeTurnsRemaining } : null, progress: status.progress, outcome: status.outcome,
    readMaxTurns: status.admission.maxTurns, writeMaxTurns: status.admission.writeAuthorization?.maxTurns ?? null,
    workerPid: status.startupClaim?.pid ?? null };
}
function createBackgroundHost(options) {
  const store = () => createCoordinationJobStore(options.directory(), { bootstrapReady: options.ready() });
  let starting = false;
  let lastJobId = null;
  function jobIds() {
    const root = path.join(options.directory(), "coordination-jobs", "jobs");
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(id => /^[0-9a-f-]{36}$/.test(id))
      .sort((a, b) => fs.statSync(path.join(root, b)).mtimeMs - fs.statSync(path.join(root, a)).mtimeMs);
  }
  function outstanding() {
    const s = store();
    if (starting || s.getActiveStatus()) return true;
    // A missing pointer is not proof that an earlier owner/tools stopped.
    // Retained nonterminal or pending job facts still block ordinary/native
    // admission; only confirmed terminal facts permit normal competition.
    return jobIds().some(id => { const facts = s.getStatus(id); return !["completed", "failed", "stopped"].includes(facts.state) || !!facts.pendingCommand; });
  }
  async function status(jobId) {
    const s = store();
    let facts = jobId ? s.getStatus(jobId) : s.getActiveStatus();
    if (!facts && lastJobId) facts = s.getStatus(lastJobId);
    if (!facts) {
      // Terminal records are display-only, never a launch input or permission.
      const ids = jobIds();
      if (ids[0]) facts = s.getStatus(ids[0]);
    }
    if (!facts) return null;
    lastJobId = facts.jobId;
    if (!facts.active) return projection(facts);
    try { return projection(await requestControl(options.endpoint(), s.readControlCredential(facts.jobId), "status", { timeoutMs: 800 }), true); }
    catch { return projection(facts); }
  }
  async function start(input) {
    if (!options.ready() || options.env.GOALPORT_COORDINATE_SEND !== "1" || options.env.GOALPORT_HARNESS_CHECKOUT || options.env.GOALPORT_HARNESS_SERVER_CWD) throw new Error("Background Send is unavailable until bootstrap and the local CLI admission are ready.");
    if (input?.backgroundConsent !== true) throw new Error("Keep working after closing must be explicitly selected.");
    if (starting) throw new Error("A background admission is already in progress.");
    starting = true;
    try {
      if (options.ordinaryScope()) throw new Error("Stop current window access before starting an independent job.");
      const problem = coreRefusal(await options.snapshot());
      if (problem) throw new Error(problem);
      const s = store();
      const admitted = s.startAdmission({ requestId: input.requestId, goal: input.goal, workspacePath: input.workspaceRoot,
        allowedInstances: input.readInstances, maxTurns: input.readMaxTurns, writeAuthorization: input.write ?? null,
        priorPlan: input.priorPlan, priorReview: input.priorReview, avoidInstances: input.avoidInstances, backgroundConsent: input.backgroundConsent });
      if (!admitted.ok) throw new Error("Another background job governs this profile; no replacement was started.");
      lastJobId = admitted.jobId;
      if (admitted.created) {
        const config = { ...options.config(), jobId: admitted.jobId, directory: options.directory(), controlEndpoint: options.endpoint() };
        const child = (options.spawn ?? spawn)(process.execPath, [options.workerPath, JSON.stringify(config)], { env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => {}); // The immutable admission remains unconfirmed; never respawn.
        child.unref();
      }
      const deadline = Date.now() + (options.startTimeoutMs ?? 15000);
      do {
        const result = await status(admitted.jobId);
        if (result.live || !result.active) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      return status(admitted.jobId); // honest unconfirmed projection, not independently running
    } finally { starting = false; }
  }
  async function revoke(jobId) {
    const s = store();
    const facts = s.getStatus(jobId);
    if (!facts.active) return projection(facts);
    try { return projection(await requestControl(options.endpoint(), s.readControlCredential(jobId), "revoke"), true); }
    catch {
      // Durable revoke denies future admission if the same owner is still
      // alive. Missing control is NOT proof that tools stopped.
      s.revoke(jobId);
      return projection(s.getStatus(jobId));
    }
  }
  return { start, status, revoke, outstanding };
}
module.exports = { createBackgroundHost, projection };
