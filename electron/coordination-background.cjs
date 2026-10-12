"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createCoordinationJobStore, requestControl, normalizeAdmissionInput } = require("./coordination-job.cjs");
const { coreRefusal } = require("./coordination-core-guard.cjs");
const { harnessLaunchConfigured } = require("./harness-runtime.cjs");

const HOST_REFUSAL_CODES = new Set([
  "background-unavailable",
  "background-consent-required",
  "background-start-in-progress",
  "background-scope-conflict",
  "background-core-refused",
  "background-preflight-failed",
  "background-invalid-admission",
  "background-job-conflict",
  "background-admission-unknown",
]);
const PREFLIGHT_MESSAGE = "Background Send could not be prepared, so nothing was admitted.";
const UNKNOWN_MESSAGE = "GoalPort could not confirm this background start.";

function codedRefusal(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
function preflightRefusal(cause) {
  return codedRefusal("background-preflight-failed", PREFLIGHT_MESSAGE, cause);
}
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
  const store = (directory = options.directory()) => createCoordinationJobStore(directory, { bootstrapReady: options.ready() });
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
  async function status(jobId, controlEndpoint) {
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
    try { return projection(withControlAck(facts, await requestControl(controlEndpoint ?? options.endpoint(), s.readControlCredential(facts.jobId), "status", { timeoutMs: 800 })), true); }
    catch { return projection(facts); }
  }
  async function start(input) {
    let ready;
    try { ready = options.ready(); }
    catch (error) { throw preflightRefusal(error); }
    if (!ready || !harnessLaunchConfigured(options.env, options.consent) || options.env.GOALPORT_HARNESS_CHECKOUT || options.env.GOALPORT_HARNESS_SERVER_CWD) {
      throw codedRefusal("background-unavailable", "Background Send is not ready in this GoalPort window yet.");
    }
    if (input?.backgroundConsent !== true) throw codedRefusal("background-consent-required", "Keep working after closing must be explicitly selected.");
    if (starting) throw codedRefusal("background-start-in-progress", "A background start is already in progress. Try again in a moment.");
    starting = true;
    try {
      try {
        if (options.ordinaryScope()) throw codedRefusal("background-scope-conflict", "Stop this window's harness access before starting a goal that keeps working after closing.");
        const problem = coreRefusal(await options.snapshot());
        if (problem) throw codedRefusal("background-core-refused", problem);
      } catch (error) {
        if (error?.code === "background-scope-conflict" || error?.code === "background-core-refused") throw error;
        throw preflightRefusal(error);
      }

      let profileDirectory;
      let s;
      let admissionInput;
      let controlEndpoint;
      let workerConfigBase;
      try {
        const durableInput = {
          requestId: input.requestId,
          goal: input.goal,
          workspacePath: input.workspaceRoot,
          allowedInstances: input.readInstances,
          maxTurns: input.readMaxTurns,
          writeAuthorization: input.write ?? null,
          priorPlan: input.priorPlan,
          priorReview: input.priorReview,
          avoidInstances: input.avoidInstances,
          backgroundConsent: input.backgroundConsent,
          executionFeedback: input.executionFeedback,
        };
        try { admissionInput = normalizeAdmissionInput(durableInput); }
        catch (error) {
          if (error?.code === "invalid-admission") throw codedRefusal("background-invalid-admission", error.message, error);
          throw error;
        }
        profileDirectory = options.directory();
        s = store(profileDirectory);
        controlEndpoint = options.endpoint();
        if (typeof controlEndpoint !== "string" || controlEndpoint.length === 0) throw new Error("The background control endpoint is unavailable.");
        workerConfigBase = options.config();
        const preflightConfig = { ...workerConfigBase, jobId: "preflight-job-id", directory: profileDirectory, controlEndpoint };
        const serialized = JSON.stringify(preflightConfig);
        if (typeof serialized !== "string") throw new Error("The background worker configuration is not serializable.");
      } catch (error) {
        if (error?.code === "background-invalid-admission") throw error;
        throw preflightRefusal(error);
      }

      let admitted;
      try { admitted = s.startAdmission(admissionInput); }
      catch (error) { throw codedRefusal("background-admission-unknown", error?.message || UNKNOWN_MESSAGE, error); }
      if (!admitted.ok) throw codedRefusal("background-job-conflict", "A background goal is already running. Return to it or stop allowing its access; nothing new was started.");

      try {
        lastJobId = admitted.jobId;
        if (admitted.created) {
          const config = { ...workerConfigBase, jobId: admitted.jobId, directory: profileDirectory, controlEndpoint };
          const child = (options.spawn ?? spawn)(process.execPath, [options.workerPath, JSON.stringify(config)], { env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: "ignore", windowsHide: true });
          child.on("error", () => {}); // The immutable admission remains unconfirmed; never respawn.
          child.unref();
        }
        const deadline = Date.now() + (options.startTimeoutMs ?? 15000);
        do {
          const result = await status(admitted.jobId, controlEndpoint);
          if (result.live || !result.active) return result;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        return status(admitted.jobId, controlEndpoint); // honest unconfirmed projection, not independently running
      } catch (error) {
        throw codedRefusal("background-admission-unknown", error?.message || UNKNOWN_MESSAGE, error);
      }
    } finally { starting = false; }
  }
  async function revoke(jobId) {
    const s = store();
    const facts = s.getStatus(jobId);
    if (!facts.active) return projection(facts);
    try { return projection(withControlAck(facts, await requestControl(options.endpoint(), s.readControlCredential(jobId), "revoke")), true); }
    catch {
      // Durable revoke denies future admission if the same owner is still
      // alive. Missing control is NOT proof that tools stopped.
      s.revoke(jobId);
      return projection(s.getStatus(jobId));
    }
  }
  return { start, status, revoke, outstanding };
}
function withControlAck(facts, ack) {
  if (!ack || ack.jobId !== facts.jobId || ack.requestId !== facts.requestId) {
    throw Object.assign(new Error("The job control acknowledgement does not match this admission."), { code: "control-identity-mismatch" });
  }
  const counters = facts.counters ? { ...facts.counters } : null;
  if (counters && ack.readTurnsRemaining != null) counters.readTurnsRemaining = ack.readTurnsRemaining;
  if (counters && ack.writeTurnsRemaining != null) counters.writeTurnsRemaining = ack.writeTurnsRemaining;
  return {
    ...facts,
    state: ack.state,
    active: ack.active === true,
    revoked: ack.revoked === true,
    pendingCommand: ack.pendingCommandId
      ? { ...(facts.pendingCommand?.commandId === ack.pendingCommandId ? facts.pendingCommand : { state: "unconfirmed" }), commandId: ack.pendingCommandId }
      : null,
    counters,
    startupClaim: ack.claimed ? { ...(facts.startupClaim ?? {}), pid: ack.workerPid ?? facts.startupClaim?.pid ?? null } : facts.startupClaim,
  };
}
async function backgroundStartReply(host, input) {
  try { return await host.start(input); }
  catch (error) {
    let reportedCode;
    let message = UNKNOWN_MESSAGE;
    try { reportedCode = error?.code; } catch { /* malformed thrown values are unknown */ }
    try { if (typeof error?.message === "string") message = error.message; } catch { /* retain the safe fallback */ }
    const code = HOST_REFUSAL_CODES.has(reportedCode) ? reportedCode : "background-admission-unknown";
    return { backgroundStartRefused: true, code, message };
  }
}

module.exports = { createBackgroundHost, projection, withControlAck, backgroundStartReply };
