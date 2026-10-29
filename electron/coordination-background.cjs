"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createCoordinationJobStore, requestControl, normalizeAdmissionInput, workspaceIdentity, jobControlEndpoint } = require("./coordination-job.cjs");
const { coreRefusal } = require("./coordination-core-guard.cjs");
const { harnessLaunchConfigured } = require("./harness-runtime.cjs");
const { discoverCliProviders } = require("./cli-coordinate.cjs");
const { piAdmissionContext } = require("./pi-capacity-admission.cjs");

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
  "background-still-live",
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
function pidGone(pid) {
  if (process.platform === "win32" || typeof pid !== "number" || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}
function durableTerminal(facts) {
  return ["completed", "failed", "stopped"].includes(facts?.state) && !facts?.pendingCommand && !!facts?.outcome;
}
function projection(status, live = false) {
  if (!status) return null;
  const confirmedTerminal = ["completed", "failed", "stopped"].includes(status.state);
  let progress = status.progress;
  if (durableTerminal(status) && progress && typeof progress.activity === "string" && progress.activity.includes("may finish")) {
    progress = { ...progress, activity: "Stopped. No further turn was sent." };
  }
  return { jobId: status.jobId, requestId: status.requestId, goal: status.admission.goal, active: status.active,
    state: !confirmedTerminal && !live ? "unconfirmed" : status.state, live,
    revoked: status.revoked, pendingCommand: status.pendingCommand, completedCommands: status.completedCommands,
    counters: status.counters ? { readTurnsLeft: status.counters.readTurnsRemaining, writeTurnsLeft: status.counters.writeTurnsRemaining } : null, progress, outcome: status.outcome,
    readMaxTurns: status.admission.maxTurns, writeMaxTurns: status.admission.writeAuthorization?.maxTurns ?? null,
    workspacePath: status.admission.workspacePath, acknowledgedStuckAt: status.acknowledgedStuckAt ?? null,
    workerPid: status.startupClaim?.pid ?? null,
    ...(status.admission.continuation ? { continuation: status.admission.continuation } : {}),
    ...(status.admission.piCapacity ? { piCapacity: status.admission.piCapacity } : {}) };
}
function createBackgroundHost(options) {
  // The host admits and compares folders on ONE platform identity (the host's
  // own by default; tests may pin another). Never resolves against
  // process.cwd(): a workspace that is missing or not absolute on this
  // platform has no identity and stays fail-closed.
  const platform = options.platform ?? process.platform;
  const store = (directory = options.directory()) => createCoordinationJobStore(directory, { bootstrapReady: options.ready(), platform });
  let starting = false;
  let lastJobId = null;
  function jobIds() {
    const root = path.join(options.directory(), "coordination-jobs", "jobs");
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(id => /^[0-9a-f-]{36}$/.test(id))
      .sort((a, b) => fs.statSync(path.join(root, b)).mtimeMs - fs.statSync(path.join(root, a)).mtimeMs);
  }
  function confirmedTerminal(facts) {
    return ["completed", "failed", "stopped"].includes(facts.state) && !!facts.outcome && !facts.pendingCommand;
  }
  function outstanding(workspaceRoot) {
    const s = store();
    if (starting || s.getActiveStatus()) return true;
    // A missing pointer is not proof that an earlier owner/tools stopped.
    // Leaving an unconfirmed job frees the slot pointer only. The same folder
    // stays held. An unknown caller folder fails closed.
    const caller = workspaceIdentity(workspaceRoot, platform);
    for (const id of jobIds()) {
      const facts = s.getStatus(id);
      if (confirmedTerminal(facts)) continue;
      if (!facts.acknowledgedStuckAt) return true;
      const held = workspaceIdentity(facts.admission?.workspacePath, platform);
      if (caller === null || held === null || held === caller) return true;
    }
    return false;
  }
  // Read-only presentation facts from the existing store, not an admission
  // authority. Never silently drop a malformed entry or truncate a reservation.
  function heldWorkspaces(candidate) {
    const holds = [];
    let complete = true;
    let globalBlock = starting;
    try {
      const s = store();
      if (s.getActiveStatus()) globalBlock = true;
      const root = path.join(options.directory(), "coordination-jobs", "jobs");
      const entries = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) { complete = false; continue; }
        try {
          const facts = s.getStatus(entry.name);
          if (confirmedTerminal(facts)) continue;
          if (!facts.acknowledgedStuckAt) { globalBlock = true; continue; }
          const workspacePath = facts.admission?.workspacePath;
          if (!workspaceIdentity(workspacePath, platform)) { complete = false; continue; }
          if (holds.length === 256) { complete = false; continue; }
          holds.push({ jobId: facts.jobId, workspacePath });
        } catch { complete = false; }
      }
    } catch { complete = false; }
    const inventory = { holds, complete, globalBlock: globalBlock || !complete };
    if (candidate === undefined) return inventory; // Preserve the inventory-only wire shape.
    const identity = workspaceIdentity(candidate, platform);
    return { ...inventory, candidate, candidateBlocked: inventory.globalBlock || identity === null
      || holds.some(hold => {
        const held = workspaceIdentity(hold.workspacePath, platform);
        return held === null || held === identity;
      }) };
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
    if (!facts.active || durableTerminal(facts)) return projection(facts);
    try { return projection(withControlAck(facts, await requestControl(controlEndpoint ?? jobControlEndpoint(options.endpoint(), facts.jobId), s.readControlCredential(facts.jobId), "status", { timeoutMs: 800 })), true); }
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
          ...(input.continuation !== undefined && input.continuation !== null ? { continuation: input.continuation } : {}),
          ...(Object.hasOwn(input, "piCapacity") ? { piCapacity: input.piCapacity } : {}),
        };
        try { admissionInput = normalizeAdmissionInput(durableInput, platform); }
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

      if ((platform === "linux" || admissionInput.piCapacity) && admissionInput.allowedInstances.includes("pi")) {
        try {
          const discovered = await (options.discover ?? discoverCliProviders)({ cwd: admissionInput.workspacePath, routeAwarePi: true, env: options.env });
          const context = piAdmissionContext(admissionInput, profileDirectory, discovered, platform);
          if (context.piCapacity) admissionInput.piCapacity = context.piCapacity;
        } catch (error) { throw codedRefusal("background-invalid-admission", error.message, error); }
      }
      let admitted;
      try { admitted = s.startAdmission(admissionInput); }
      catch (error) { throw codedRefusal("background-admission-unknown", error?.message || UNKNOWN_MESSAGE, error); }
      if (!admitted.ok) {
        const message = admitted.reason === "workspace-held"
          ? "This folder still has an unfinished background goal, so nothing new was started."
          : "A background goal is already running. Return to it or stop allowing its access; nothing new was started.";
        throw codedRefusal("background-job-conflict", message);
      }

      try {
        lastJobId = admitted.jobId;
        if (admitted.created) {
          const config = { ...workerConfigBase, jobId: admitted.jobId, directory: profileDirectory, controlEndpoint: jobControlEndpoint(controlEndpoint, admitted.jobId) };
          const child = (options.spawn ?? spawn)(process.execPath, [options.workerPath, JSON.stringify(config)], { env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: "ignore", windowsHide: true });
          child.on("error", () => {}); // The immutable admission remains unconfirmed; never respawn.
          child.unref();
        }
        const deadline = Date.now() + (options.startTimeoutMs ?? 15000);
        do {
          const result = await status(admitted.jobId, jobControlEndpoint(controlEndpoint, admitted.jobId));
          if (result.live || !result.active) return result;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        return status(admitted.jobId, jobControlEndpoint(controlEndpoint, admitted.jobId)); // honest unconfirmed projection, not independently running
      } catch (error) {
        throw codedRefusal("background-admission-unknown", error?.message || UNKNOWN_MESSAGE, error);
      }
    } finally { starting = false; }
  }
  async function releaseConfirmedTerminal(jobId) {
    let current;
    try { current = await status(jobId); }
    catch (error) { throw codedRefusal("background-admission-unknown", error?.message || UNKNOWN_MESSAGE, error); }
    if (!current) throw codedRefusal("background-admission-unknown", "That background job is not on this profile.");
    if (!current.active) return current;
    if (current.live) throw codedRefusal("background-still-live", "This goal is still running, so its place was not released.");
    if (!confirmedTerminal(current)) throw codedRefusal("background-still-live", "This goal is not finished, so its place was not released.");
    try { store().releaseConfirmedTerminal(jobId); }
    catch (error) { throw codedRefusal("background-admission-unknown", error?.message || UNKNOWN_MESSAGE, error); }
    return status(jobId);
  }
  async function acknowledge(jobId) {
    const current = await status(jobId);
    if (!current) throw codedRefusal("background-admission-unknown", "That background job is not on this profile.");
    if (current.live && !pidGone(current.workerPid)) throw codedRefusal("background-still-live", "This goal is still running, so it was not left.");
    try { store().acknowledgeStuck(jobId); }
    catch (error) { throw codedRefusal("background-admission-unknown", error?.message || UNKNOWN_MESSAGE, error); }
    return status(jobId);
  }
  async function revoke(jobId) {
    const s = store();
    const facts = s.getStatus(jobId);
    if (!facts.active) return projection(facts);
    try { return projection(withControlAck(facts, await requestControl(jobControlEndpoint(options.endpoint(), jobId), s.readControlCredential(jobId), "revoke")), true); }
    catch {
      // Durable revoke denies future admission if the same owner is still
      // alive. Missing control is NOT proof that tools stopped.
      s.revoke(jobId);
      return projection(s.getStatus(jobId));
    }
  }
  return { start, status, revoke, acknowledge, releaseConfirmedTerminal, outstanding, heldWorkspaces };
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

module.exports = { createBackgroundHost, projection, withControlAck, backgroundStartReply, durableTerminal, pidGone };
