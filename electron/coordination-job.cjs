"use strict";

// Minimal durable state for the explicit, one-goal background admission.
// This is deliberately NOT a budget authority: live turn reservations remain
// owned by coordination-scope.cjs in the worker process. Disk counters below
// are display/recovery facts only.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { coreConnectEndpoint, endpointSocketLeafName } = require("./launch-config.cjs");

const STORE_DIRECTORY = "coordination-jobs";
const JOBS_DIRECTORY = "jobs";
const ACTIVE_FILE = "active-admission.json";
const ADMISSION_FILE = "admission.json";
const PROGRESS_FILE = "progress.json";
const CLAIM_FILE = "startup-claim.json";
const REVOCATION_FILE = "revocation.json";
const TOKEN_FILE = "control-token";
const ADMISSION_SCHEMA = "goalport.coordination-job-admission.v1";
const PROGRESS_SCHEMA = "goalport.coordination-job-progress.v1";
const CLAIM_SCHEMA = "goalport.coordination-job-claim.v1";
const REVOCATION_SCHEMA = "goalport.coordination-job-revocation.v1";
const ACTIVE_SCHEMA = "goalport.coordination-job-active.v1";
const CONTROL_SCHEMA = "goalport.coordination-job-control.v1";
const OUTCOME_STATES = new Set(["completed", "failed", "stopped", "unconfirmed"]);
const RELEASE_STATES = new Set(["completed", "failed", "stopped"]);
const ROLES = new Set(["planning", "review", "execution", "audit"]);
const COUNTER_KEYS = new Set(["readTurnsRemaining", "writeTurnsRemaining"]);
const MAX_CONTROL_BYTES = 8192;
const MAX_PROGRESS_BYTES = 4 * 1024 * 1024;

function refusal(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requiredText(value, name, maxLength = 100_000) {
  if (typeof value !== "string") throw refusal("invalid-admission", `${name} must be text.`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw refusal("invalid-admission", `${name} is missing or too long.`);
  return text;
}

function optionalText(value, name, maxLength = 100_000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw refusal("invalid-admission", `${name} must be text or null.`);
  }
  return value;
}

function absolutePath(value, name) {
  const text = requiredText(value, name, 32_768);
  if (!path.isAbsolute(text)) throw refusal("invalid-admission", `${name} must be an absolute path.`);
  return path.resolve(text);
}

function instancesOf(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw refusal("invalid-admission", `${name} must contain at least one selected harness.`);
  }
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const instance = requiredText(item, name, 256);
    if (!/^[A-Za-z0-9._-]+$/.test(instance)) throw refusal("invalid-admission", `${name} contains an invalid harness id.`);
    if (!seen.has(instance)) {
      seen.add(instance);
      result.push(instance);
    }
  }
  return result;
}

function integerCap(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw refusal("invalid-admission", `${name} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function normalizeExecutionFeedback(value) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw refusal("invalid-admission", "executionFeedback must be an object.");
  const previousCommandIds = value.previousCommandIds;
  if (!Array.isArray(previousCommandIds) || previousCommandIds.length > 256 || !previousCommandIds.every(isCommandId)) {
    throw refusal("invalid-admission", "executionFeedback.previousCommandIds must contain at most 256 valid command ids.");
  }
  return {
    previousPlan: optionalText(value.previousPlan, "executionFeedback.previousPlan"),
    previousPlanReview: optionalText(value.previousPlanReview, "executionFeedback.previousPlanReview"),
    previousExecutionReport: optionalText(value.previousExecutionReport, "executionFeedback.previousExecutionReport"),
    previousExecutionAudit: optionalText(value.previousExecutionAudit, "executionFeedback.previousExecutionAudit"),
    previousCommandIds: [...previousCommandIds],
  };
}

// This whitelist is the immutable caller-provided admission. It is not a live
// scope and is never reconstructed from coordination-records.json or history.
function normalizeAdmissionInput(input) {
  if (!isPlainObject(input)) throw refusal("invalid-admission", "A background job needs an explicit admission object.");
  if (input.backgroundConsent !== true) {
    throw refusal("background-consent-required", "This goal was not explicitly allowed to continue after closing GoalPort.");
  }
  const requestId = requiredText(input.requestId, "requestId", 256);
  if (!/^[A-Za-z0-9._-]+$/.test(requestId)) throw refusal("invalid-admission", "requestId contains invalid characters.");
  const goal = requiredText(input.goal, "goal", 100_000);
  const workspacePath = absolutePath(input.workspacePath, "workspacePath");
  const allowedInstances = instancesOf(input.allowedInstances, "allowedInstances");
  const maxTurns = integerCap(input.maxTurns, 2, 32, "maxTurns");
  const avoidInstances = input.avoidInstances === undefined
    ? []
    : (Array.isArray(input.avoidInstances) ? [...new Set(input.avoidInstances.map((item) => requiredText(item, "avoidInstances", 256)))] : null);
  if (!avoidInstances || avoidInstances.length > 64 || avoidInstances.some((item) => !/^[A-Za-z0-9._-]+$/.test(item))) {
    throw refusal("invalid-admission", "avoidInstances must be a list of valid harness ids.");
  }
  const priorPlan = optionalText(input.priorPlan, "priorPlan");
  const priorReview = optionalText(input.priorReview, "priorReview");
  let writeAuthorization = null;
  if (input.writeAuthorization !== undefined && input.writeAuthorization !== null) {
    const write = input.writeAuthorization;
    if (!isPlainObject(write)) throw refusal("invalid-admission", "Workspace-change consent must be a complete explicit selection.");
    const instances = instancesOf(write.instances, "writeAuthorization.instances");
    const workspaceRoot = absolutePath(write.workspaceRoot, "writeAuthorization.workspaceRoot");
    if (path.resolve(workspaceRoot) !== workspacePath) {
      throw refusal("invalid-admission", "Workspace-change consent must be bound to the selected workspace.");
    }
    const writeMaxTurns = integerCap(write.maxTurns, 1, 8, "writeAuthorization.maxTurns");
    writeAuthorization = { instances, workspaceRoot, maxTurns: writeMaxTurns };
  }
  const normalized = {
    requestId,
    goal,
    workspacePath,
    priorPlan,
    priorReview,
    avoidInstances,
    allowedInstances,
    maxTurns,
    writeAuthorization,
    backgroundConsent: true,
  };
  const executionFeedback = normalizeExecutionFeedback(input.executionFeedback);
  if (executionFeedback !== undefined) normalized.executionFeedback = executionFeedback;
  return normalized;
}

function stableJson(value) {
  return JSON.stringify(value);
}

function cloneJson(value, label, maxBytes = MAX_PROGRESS_BYTES) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw refusal("invalid-state", `${label} is not serializable.`); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > maxBytes) {
    throw refusal("invalid-state", `${label} is too large to persist.`);
  }
  try { return JSON.parse(encoded); } catch { throw refusal("invalid-state", `${label} is not valid JSON data.`); }
}

function isJobId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isCommandId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(value);
}

function equalSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkCounters(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw refusal("invalid-state", "Counter snapshots must be an object.");
  const result = {};
  for (const [key, count] of Object.entries(value)) {
    if (!COUNTER_KEYS.has(key) || !(count === null || (Number.isInteger(count) && count >= 0))) {
      throw refusal("invalid-state", "Counter snapshots must contain only non-negative display facts.");
    }
    result[key] = count;
  }
  return result;
}

function controlEndpointFor(profileEndpoint, { platform = process.platform, env = process.env } = {}) {
  const endpoint = typeof profileEndpoint === "string" ? profileEndpoint.trim() : "";
  if (!endpoint) throw refusal("invalid-endpoint", "The profile control endpoint is unavailable.");
  const candidate = `${endpoint}-coordination-job-control`;
  if (platform === "linux" && path.posix.isAbsolute(candidate) && Buffer.byteLength(candidate, "utf8") > 107) {
    const parent = path.posix.dirname(candidate);
    const leaf = endpointSocketLeafName(candidate, parent);
    return coreConnectEndpoint(platform, path.posix.join(parent, leaf), env);
  }
  return coreConnectEndpoint(platform, candidate, env);
}

function createCoordinationJobStore(profileDirectory, {
  bootstrapReady = false,
  fsApi = fs,
  clock = () => new Date().toISOString(),
  idFactory = randomUUID,
  tokenFactory = () => randomBytes(32).toString("hex"),
} = {}) {
  if (typeof profileDirectory !== "string" || !path.isAbsolute(profileDirectory)) {
    throw refusal("invalid-profile", "The durable profile directory must be an absolute path.");
  }
  const profileRoot = path.resolve(profileDirectory);
  const storeRoot = path.join(profileRoot, STORE_DIRECTORY);
  const jobsRoot = path.join(storeRoot, JOBS_DIRECTORY);

  function now() {
    const value = clock();
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw refusal("invalid-clock", "The job store clock returned an invalid timestamp.");
    }
    return value;
  }

  function requireWritable() {
    if (bootstrapReady !== true) {
      throw refusal("profile-bootstrap-required", "Background job storage is unavailable until profile bootstrap permits writes.");
    }
  }

  function mkdirStore() {
    fsApi.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
    fsApi.mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
  }

  function jobDirectory(jobId) {
    if (!isJobId(jobId)) throw refusal("invalid-job-id", "The job id is invalid.");
    return path.join(jobsRoot, jobId);
  }

  function fileFor(jobId, leaf) {
    return path.join(jobDirectory(jobId), leaf);
  }

  function syncDirectory(directory) {
    let descriptor;
    try {
      descriptor = fsApi.openSync(directory, "r");
      fsApi.fsyncSync(descriptor);
    } catch {
      // Directory fsync is not available on every supported filesystem / OS.
      // The file fsync and atomic rename remain required and authoritative.
    } finally {
      if (descriptor !== undefined) {
        try { fsApi.closeSync(descriptor); } catch { /* best effort */ }
      }
    }
  }

  function writeAtomic(file, value, mode = 0o600) {
    const parent = path.dirname(file);
    fsApi.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fsApi.openSync(temporary, "wx", mode);
      fsApi.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fsApi.fsyncSync(descriptor);
      fsApi.closeSync(descriptor);
      descriptor = undefined;
      fsApi.renameSync(temporary, file);
      syncDirectory(parent);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fsApi.closeSync(descriptor); } catch { /* retain original failure */ }
      }
      try { fsApi.rmSync(temporary, { force: true, recursive: true }); } catch { /* retain original failure */ }
      throw error;
    }
  }

  function writeExclusive(file, value, mode = 0o600) {
    const parent = path.dirname(file);
    fsApi.mkdirSync(parent, { recursive: true, mode: 0o700 });
    let descriptor;
    try {
      // The final pathname is the exclusive claim. If a process dies while
      // writing it, the malformed/truncated file is a refusal, never a reason
      // to clear the claim or start a replacement owner.
      descriptor = fsApi.openSync(file, "wx", mode);
      fsApi.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fsApi.fsyncSync(descriptor);
      fsApi.closeSync(descriptor);
      descriptor = undefined;
      syncDirectory(parent);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fsApi.closeSync(descriptor); } catch { /* retain original failure */ }
      }
      throw error;
    }
  }

  function readJson(file, label) {
    let text;
    try { text = fsApi.readFileSync(file, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw refusal("state-unavailable", `${label} could not be read; admission remains held.`, { cause: error });
    }
    try {
      const parsed = JSON.parse(text);
      if (!isPlainObject(parsed)) throw new Error("not an object");
      return parsed;
    } catch {
      throw refusal("malformed-state", `${label} is malformed; admission and claims are retained.`);
    }
  }

  function readActive() {
    const active = readJson(path.join(storeRoot, ACTIVE_FILE), "The profile admission slot");
    if (active === null) return null;
    if (active.schema !== ACTIVE_SCHEMA || !isJobId(active.jobId) || typeof active.requestId !== "string" || !active.requestId) {
      throw refusal("malformed-active-slot", "The profile admission slot is stale or malformed; it was not cleared.");
    }
    return active;
  }

  function readAdmission(jobId) {
    const value = readJson(fileFor(jobId, ADMISSION_FILE), "The immutable job admission");
    if (!value || value.schema !== ADMISSION_SCHEMA || value.jobId !== jobId || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
      throw refusal("malformed-admission", "The job admission is missing or malformed; it cannot authorize a worker.");
    }
    let input;
    try { input = normalizeAdmissionInput(value.input); } catch {
      throw refusal("malformed-admission", "The job admission is invalid; it cannot authorize a worker.");
    }
    if (stableJson(input) !== stableJson(value.input)) {
      throw refusal("malformed-admission", "The job admission is not in its canonical immutable form.");
    }
    return value;
  }

  function readProgress(jobId) {
    const value = readJson(fileFor(jobId, PROGRESS_FILE), "The job progress");
    if (!value || value.schema !== PROGRESS_SCHEMA || value.jobId !== jobId
      || !["admitted", "running", "revoked", ...OUTCOME_STATES].includes(value.state)
      || !Array.isArray(value.completedCommands)
      || !(value.pendingCommand === null || isPlainObject(value.pendingCommand))) {
      throw refusal("malformed-progress", "The job progress is stale or malformed; the admission slot remains held.");
    }
    if (value.pendingCommand && (!isCommandId(value.pendingCommand.commandId) || value.pendingCommand.state !== "unconfirmed"
      || !(value.pendingCommand.role === null || ROLES.has(value.pendingCommand.role)))) {
      throw refusal("malformed-progress", "The pending command fact is malformed; the admission slot remains held.");
    }
    if (value.revoked !== true && value.revoked !== false) {
      throw refusal("malformed-progress", "The access-control fact is malformed; the admission slot remains held.");
    }
    if (value.state === "revoked" && !value.revoked) {
      throw refusal("malformed-progress", "Revocation state is inconsistent; the admission slot remains held.");
    }
    if (!Array.isArray(value.completedCommands) || value.completedCommands.some((item) => (
      !isPlainObject(item) || !isCommandId(item.commandId) || !item.completedAt || Number.isNaN(Date.parse(item.completedAt))
    ))) {
      throw refusal("malformed-progress", "Completed command facts are malformed; the admission slot remains held.");
    }
    const completedIds = value.completedCommands.map((item) => item.commandId);
    if (new Set(completedIds).size !== completedIds.length || (value.pendingCommand && completedIds.includes(value.pendingCommand.commandId))) {
      throw refusal("malformed-progress", "Command identity facts conflict; the admission slot remains held.");
    }
    if (OUTCOME_STATES.has(value.state) && (!isPlainObject(value.outcome) || value.outcome.status !== value.state)) {
      throw refusal("malformed-progress", "The terminal job outcome is malformed; the admission slot remains held.");
    }
    try {
      if (value.counters !== null && value.counters !== undefined) checkCounters(value.counters);
      if (value.display !== null && value.display !== undefined) cloneJson(value.display, "Progress display");
    } catch {
      throw refusal("malformed-progress", "The progress projection is malformed; the admission slot remains held.");
    }
    // Cross-process lost-update guard: merge the write-once revocation fact
    // into every read, so an atomic progress replacement written from a
    // pre-revoke snapshot can never make the durable stop disappear. The
    // non-terminal "revoked" projection is DERIVED here exactly as the
    // revoking process used to persist it — revoke() now creates only the
    // marker, so progress.json keeps exactly one writer (the worker
    // process) and no cross-process read-modify-write of this file exists.
    // A terminal outcome the worker recorded always wins over the
    // projection.
    const marker = readRevocationMarker(jobId);
    if (marker) {
      const merged = {
        ...value,
        revoked: true,
        revokeRequestedAt: value.revokeRequestedAt ?? marker.revokedAt,
      };
      if (OUTCOME_STATES.has(value.state)) return merged;
      return { ...merged, state: "revoked", phase: "revoked" };
    }
    return value;
  }

  function readClaim(jobId) {
    const claim = readJson(fileFor(jobId, CLAIM_FILE), "The worker startup claim");
    if (claim === null) return null;
    if (claim.schema !== CLAIM_SCHEMA || claim.jobId !== jobId || typeof claim.ownerToken !== "string"
      || !/^[a-f0-9]{64}$/.test(claim.ownerToken) || typeof claim.claimedAt !== "string") {
      throw refusal("malformed-startup-claim", "The startup claim is stale or malformed; it was not cleared.");
    }
    return claim;
  }

  // The durable revocation fact. revoke() creates this file exclusively and
  // NOTHING ever overwrites or deletes it: progress.json is a
  // read-modify-write projection that a racing worker process can atomically
  // replace from a stale snapshot (writeAtomic serializes one replacement,
  // not a cross-process transaction), but the marker survives every such
  // replacement and readProgress merges it back into every read. A malformed
  // marker refuses fail-closed instead of reading as "not revoked".
  function readRevocationMarker(jobId) {
    const marker = readJson(fileFor(jobId, REVOCATION_FILE), "The durable revocation fact");
    if (marker === null) return null;
    if (marker.schema !== REVOCATION_SCHEMA || marker.jobId !== jobId
      || typeof marker.revokedAt !== "string" || Number.isNaN(Date.parse(marker.revokedAt))) {
      throw refusal("malformed-revocation", "The durable revocation fact is malformed; the stop stays in force and the admission remains held.");
    }
    return marker;
  }

  function assertActive(jobId) {
    const active = readActive();
    if (!active || active.jobId !== jobId) {
      throw refusal("admission-not-active", "This job does not own the profile admission slot; no replacement was started.");
    }
    const admission = readAdmission(jobId);
    if (active.requestId !== admission.input.requestId) {
      throw refusal("admission-mismatch", "The active slot does not match the immutable admission; the slot was not cleared.");
    }
    return admission;
  }

  function statusFor(jobId) {
    const admission = readAdmission(jobId);
    const progress = readProgress(jobId);
    const claim = readClaim(jobId);
    const active = readActive();
    if (active?.jobId === jobId && active.requestId !== admission.input.requestId) {
      throw refusal("admission-mismatch", "The profile admission slot does not match this job; it was not cleared.");
    }
    return {
      jobId,
      requestId: admission.input.requestId,
      admission: admission.input,
      state: progress.state,
      revoked: progress.revoked,
      revokeRequestedAt: progress.revokeRequestedAt ?? null,
      pendingCommand: progress.pendingCommand,
      completedCommands: progress.completedCommands,
      counters: progress.counters ?? null,
      phase: progress.phase ?? null,
      detail: progress.detail ?? null,
      progress: progress.display ?? null,
      outcome: progress.outcome ?? null,
      startupClaim: claim ? { claimedAt: claim.claimedAt, pid: claim.pid ?? null } : null,
      workerState: claim ? "claimed-owner-unconfirmed" : (active?.jobId === jobId ? "awaiting-startup-claim" : "not-active"),
      active: active?.jobId === jobId,
      // `active`, `revoked`, workerState, and disk counters are facts, not
      // proof that a process is alive, a tool is quiescent, or a budget authority exists.
    };
  }

  function findAdmissionsByRequestId(requestId) {
    let entries;
    try { entries = fsApi.readdirSync(jobsRoot, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw refusal("state-unavailable", "Prior job admissions could not be inspected; no replacement was authorized.");
    }
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isJobId(entry.name)) continue;
      const admission = readJson(fileFor(entry.name, ADMISSION_FILE), "A prior immutable job admission");
      if (admission === null || admission.schema !== ADMISSION_SCHEMA || admission.jobId !== entry.name) {
        throw refusal("malformed-admission", "A prior job admission is incomplete or malformed; no replacement was authorized.");
      }
      let normalized;
      try { normalized = normalizeAdmissionInput(admission.input); } catch {
        throw refusal("malformed-admission", "A prior job admission is invalid; no replacement was authorized.");
      }
      if (stableJson(normalized) !== stableJson(admission.input)) {
        throw refusal("malformed-admission", "A prior job admission is noncanonical; no replacement was authorized.");
      }
      const progress = readProgress(entry.name);
      readClaim(entry.name);
      const safelyReleased = RELEASE_STATES.has(progress.state) && !!progress.outcome && !progress.pendingCommand;
      if (!safelyReleased) {
        // A missing profile slot cannot be interpreted as a dead worker or a
        // completed job. Stale/incomplete owners block replacement forever.
        throw refusal("stale-job-state", "A prior job has no confirmed terminal outcome; no replacement was authorized.");
      }
      if (normalized.requestId === requestId) found.push({ jobId: entry.name, admission });
    }
    return found;
  }

  function compareDuplicate(existing, normalized) {
    if (stableJson(existing.admission.input) !== stableJson(normalized)) {
      return { ok: false, reason: "request-conflict", existingJobId: existing.jobId };
    }
    const status = statusFor(existing.jobId);
    if (!status.active && !OUTCOME_STATES.has(status.state)) {
      return { ok: false, reason: "stale-job", existingJobId: existing.jobId, status };
    }
    return { ok: true, created: false, existing: true, jobId: existing.jobId, status };
  }

  function startAdmission(input) {
    requireWritable();
    const normalized = normalizeAdmissionInput(input);
    mkdirStore();
    const active = readActive();
    if (active) {
      const admission = assertActive(active.jobId);
      if (admission.input.requestId === normalized.requestId) {
        return compareDuplicate({ jobId: active.jobId, admission }, normalized);
      }
      return { ok: false, reason: "active-job-exists", existingJobId: active.jobId, status: statusFor(active.jobId) };
    }

    const previous = findAdmissionsByRequestId(normalized.requestId);
    if (previous.length > 1) throw refusal("duplicate-job-history", "More than one job has this request id; no replacement was authorized.");
    if (previous.length === 1) return compareDuplicate(previous[0], normalized);

    const jobId = idFactory();
    if (!isJobId(jobId)) throw refusal("invalid-job-id", "The job id generator returned an invalid id.");
    const jobDir = jobDirectory(jobId);
    const createdAt = now();
    const token = tokenFactory();
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      throw refusal("invalid-control-token", "The local control credential could not be created.");
    }
    fsApi.mkdirSync(jobDir, { recursive: false, mode: 0o700 });
    const admission = { schema: ADMISSION_SCHEMA, jobId, createdAt, input: normalized };
    const initialProgress = {
      schema: PROGRESS_SCHEMA,
      jobId,
      state: "admitted",
      revoked: false,
      pendingCommand: null,
      completedCommands: [],
      counters: null,
      phase: "admitted",
      detail: null,
      display: null,
      outcome: null,
      updatedAt: createdAt,
    };
    try {
      writeExclusive(path.join(jobDir, ADMISSION_FILE), admission);
      writeExclusive(path.join(jobDir, TOKEN_FILE), { token }, 0o600);
      writeAtomic(path.join(jobDir, PROGRESS_FILE), initialProgress);
      // This no-clobber file is the sole profile-wide admission slot. It is
      // created only after all job records are durable. A losing concurrent
      // Start never deletes or replaces another job's slot.
      writeExclusive(path.join(storeRoot, ACTIVE_FILE), {
        schema: ACTIVE_SCHEMA,
        jobId,
        requestId: normalized.requestId,
        admittedAt: createdAt,
      });
    } catch (error) {
      if (error?.code === "EEXIST") {
        const occupied = readActive();
        try { fsApi.rmSync(jobDir, { recursive: true, force: true }); } catch { /* orphan remains a refusal fact */ }
        if (occupied) {
          if (occupied.requestId === normalized.requestId) {
            return compareDuplicate({ jobId: occupied.jobId, admission: readAdmission(occupied.jobId) }, normalized);
          }
          return { ok: false, reason: "active-job-exists", existingJobId: occupied.jobId, status: statusFor(occupied.jobId) };
        }
      }
      // If the slot was opened and then a write/fsync failed, do not remove it:
      // an incomplete exclusive claim must block rather than authorize retry.
      throw error;
    }
    return { ok: true, created: true, existing: false, jobId, status: statusFor(jobId) };
  }

  function claimWorker(jobId) {
    requireWritable();
    const admission = assertActive(jobId);
    const progress = readProgress(jobId);
    if (OUTCOME_STATES.has(progress.state)) throw refusal("job-terminal", "This job is already terminal and cannot be restarted.");
    if (progress.pendingCommand) throw refusal("pending-command", "A previous command has an unconfirmed launch outcome; this worker cannot resume it.");
    const existing = readClaim(jobId);
    if (existing) throw refusal("worker-already-claimed", "This job already has a startup claim; a second worker will not be started.");
    const ownerToken = tokenFactory();
    if (typeof ownerToken !== "string" || !/^[a-f0-9]{64}$/.test(ownerToken)) {
      throw refusal("invalid-owner-token", "The worker owner token could not be created.");
    }
    writeExclusive(fileFor(jobId, CLAIM_FILE), {
      schema: CLAIM_SCHEMA,
      jobId,
      claimedAt: now(),
      pid: process.pid,
      ownerToken,
      requestId: admission.input.requestId,
    });
    if (progress.revoked) {
      // The admission was revoked BEFORE any worker claimed it. No startup
      // claim existed until the lines above, and recording a command requires
      // a claimed worker's owner token, so the empty pendingCommand and
      // completedCommands facts prove no tool call was ever admitted. The
      // spawning worker claims ownership ONLY to settle that proof. The
      // claim, the terminal stopped outcome and the admission release are
      // three SEQUENTIAL durable writes, not one cross-file transaction: a
      // crash between them leaves the fail-closed blocked state (slot held,
      // nothing authorized), never an authorized or running one. Nothing
      // launches on this path.
      const at = now();
      writeAtomic(fileFor(jobId, PROGRESS_FILE), {
        ...progress,
        state: "stopped",
        phase: "stopped",
        outcome: { status: "stopped", reason: "revoked-before-start", recordedAt: at },
        updatedAt: at,
      });
      releaseAdmission(jobId, ownerToken);
      return { ok: true, jobId, ownerToken, settledPreStartRevocation: true, status: statusFor(jobId) };
    }
    const next = { ...progress, state: "running", phase: "starting", updatedAt: now() };
    writeAtomic(fileFor(jobId, PROGRESS_FILE), next);
    return { ok: true, jobId, ownerToken, status: statusFor(jobId) };
  }

  function assertOwner(jobId, ownerToken) {
    assertActive(jobId);
    const claim = readClaim(jobId);
    if (!claim || !equalSecret(claim.ownerToken, ownerToken)) {
      throw refusal("not-worker-owner", "Only the claimed worker may update job progress.");
    }
    return claim;
  }

  function updateProgress(jobId, patch, ownerToken) {
    requireWritable();
    assertOwner(jobId, ownerToken);
    if (!isPlainObject(patch)) throw refusal("invalid-progress", "Progress updates must be an object.");
    const allowed = new Set(["phase", "detail", "display", "counters"]);
    if (Object.keys(patch).some((key) => !allowed.has(key))) {
      throw refusal("invalid-progress", "Progress updates cannot change admission, access, commands, outcomes, or claims.");
    }
    const current = readProgress(jobId);
    if (OUTCOME_STATES.has(current.state)) throw refusal("job-terminal", "Terminal job progress is immutable.");
    const next = { ...current, updatedAt: now() };
    if (Object.hasOwn(patch, "phase")) next.phase = optionalText(patch.phase, "phase", 512);
    if (Object.hasOwn(patch, "detail")) next.detail = optionalText(patch.detail, "detail", 20_000);
    if (Object.hasOwn(patch, "display")) next.display = patch.display === null ? null : cloneJson(patch.display, "Progress display");
    if (Object.hasOwn(patch, "counters")) next.counters = patch.counters === null ? null : checkCounters(patch.counters);
    writeAtomic(fileFor(jobId, PROGRESS_FILE), next);
    return statusFor(jobId);
  }

  function recordPendingCommand(jobId, { commandId, role = null }, ownerToken) {
    requireWritable();
    assertOwner(jobId, ownerToken);
    if (!isCommandId(commandId)) throw refusal("invalid-command-id", "The command id is invalid; no launch was recorded.");
    if (role !== null && !ROLES.has(role)) throw refusal("invalid-role", "The command role is invalid; no launch was recorded.");
    const current = readProgress(jobId);
    if (current.revoked) throw refusal("access-revoked", "Access was stopped; no subsequent command may be admitted.");
    if (OUTCOME_STATES.has(current.state)) throw refusal("job-terminal", "The job is terminal; no command may be admitted.");
    if (current.pendingCommand) throw refusal("pending-command", "A previous command is still unconfirmed; no next command may be admitted.");
    if (current.completedCommands.some((item) => item.commandId === commandId)) {
      throw refusal("duplicate-command-id", "This command id already has a durable result; it cannot be replayed.");
    }
    const pendingCommand = { commandId, role, state: "unconfirmed", recordedAt: now() };
    const next = { ...current, pendingCommand, phase: role || "running", updatedAt: now() };
    // This atomic replacement is the durable "about to launch" fact, and
    // the marker re-read below happens strictly after it. That turns the
    // old check-then-write TOCTOU into a proven order: if the write-once
    // stop marker is ABSENT at that read, its exclusive create completes
    // entirely after the read, hence after this admission — the command
    // provably precedes the stop and is an in-flight turn that may settle.
    // If the marker is PRESENT, the stop is already durable and nothing
    // has launched yet: the just-recorded command is settled as never sent
    // (so the ledger and release semantics stay consistent) and the caller
    // must not launch. The caller must not invoke a turn unless this
    // function returns.
    writeAtomic(fileFor(jobId, PROGRESS_FILE), next);
    if (readRevocationMarker(jobId)) {
      const after = readProgress(jobId);
      if (after.pendingCommand?.commandId === commandId) {
        completeCommand(jobId, {
          commandId,
          facts: {
            launched: false,
            dispatched: false,
            text: "",
            errorText: "Access was stopped before this command was sent.",
          },
        }, ownerToken);
      }
      throw refusal("access-revoked", "Access was stopped; the recorded command was settled as never sent and was not launched.");
    }
    return statusFor(jobId);
  }

  function completeCommand(jobId, { commandId, facts, counters }, ownerToken) {
    requireWritable();
    assertOwner(jobId, ownerToken);
    const current = readProgress(jobId);
    if (!current.pendingCommand || current.pendingCommand.commandId !== commandId) {
      throw refusal("pending-command-mismatch", "Only the matching pending command can be completed.");
    }
    const safeFacts = cloneJson(facts, "Completed command facts");
    if (counters !== undefined && counters !== null) checkCounters(counters);
    const completed = {
      commandId,
      role: current.pendingCommand.role,
      launchRecordedAt: current.pendingCommand.recordedAt,
      completedAt: now(),
      facts: safeFacts,
    };
    const next = {
      ...current,
      pendingCommand: null,
      completedCommands: [...current.completedCommands, completed],
      counters: counters === undefined ? current.counters : (counters === null ? null : checkCounters(counters)),
      phase: current.revoked ? "revoked" : "running",
      updatedAt: now(),
    };
    // A completion and its counter snapshot are one atomic fact before the
    // worker can persist/launch the next role. Counter snapshots do not spend
    // or refill either in-memory authority budget.
    writeAtomic(fileFor(jobId, PROGRESS_FILE), next);
    return statusFor(jobId);
  }

  function revoke(jobId) {
    requireWritable();
    const admission = assertActive(jobId);
    const current = readProgress(jobId);
    if (OUTCOME_STATES.has(current.state)) return statusFor(jobId);
    if (current.revoked) return statusFor(jobId);
    const at = now();
    // The stop is ONLY the write-once fact file: the exclusive create
    // either wins or proves a concurrent revoke already did. revoke()
    // deliberately never writes progress.json — the worker process is that
    // file's sole writer, so a stop can never read-modify-write over a
    // concurrent completion and roll a settled ledger back to pending
    // (the slot-deadlocking lost update). The revoked projection is
    // derived by readProgress from this marker on every read, and worker
    // writes spread the merged facts, so the projection persists itself.
    // Revocation still does not remove the startup claim, clear a pending
    // command, prove process/tool quiescence, or authorize a replacement.
    try {
      writeExclusive(fileFor(jobId, REVOCATION_FILE), { schema: REVOCATION_SCHEMA, jobId, revokedAt: at });
    } catch (error) {
      if (error?.code === "EEXIST") return statusFor(jobId);
      throw error;
    }
    return { ...statusFor(jobId), requestId: admission.input.requestId };
  }

  function recordOutcome(jobId, outcome, ownerToken) {
    requireWritable();
    assertOwner(jobId, ownerToken);
    if (!isPlainObject(outcome) || !OUTCOME_STATES.has(outcome.status)) {
      throw refusal("invalid-outcome", "The job outcome must be completed, failed, stopped, or unconfirmed.");
    }
    const current = readProgress(jobId);
    if (OUTCOME_STATES.has(current.state)) throw refusal("job-terminal", "A terminal outcome is immutable.");
    if (current.pendingCommand && outcome.status !== "unconfirmed") {
      throw refusal("pending-command", "An unconfirmed command prevents a known terminal outcome.");
    }
    const safeOutcome = cloneJson(outcome, "Job outcome");
    const next = {
      ...current,
      state: safeOutcome.status,
      phase: safeOutcome.status,
      outcome: { ...safeOutcome, recordedAt: now() },
      updatedAt: now(),
    };
    writeAtomic(fileFor(jobId, PROGRESS_FILE), next);
    return statusFor(jobId);
  }

  function releaseAdmission(jobId, ownerToken) {
    requireWritable();
    assertOwner(jobId, ownerToken);
    const progress = readProgress(jobId);
    if (!RELEASE_STATES.has(progress.state) || !progress.outcome) {
      throw refusal("job-not-terminal", "The active admission cannot be released before a confirmed terminal outcome.");
    }
    if (progress.pendingCommand) {
      throw refusal("pending-command", "The active admission cannot be released while a command remains unconfirmed.");
    }
    const active = readActive();
    if (!active || active.jobId !== jobId) {
      throw refusal("admission-not-active", "The profile admission slot is missing or stale; it was not replaced.");
    }
    // The outcome was atomically persisted above this step. Removing the one
    // pointer is the only normal release path; the immutable admission and
    // startup claim remain as history and are never recycled.
    fsApi.unlinkSync(path.join(storeRoot, ACTIVE_FILE));
    syncDirectory(storeRoot);
    return statusFor(jobId);
  }

  function readControlCredential(jobId) {
    readAdmission(jobId);
    const credential = readJson(fileFor(jobId, TOKEN_FILE), "The local control credential");
    if (!credential || typeof credential.token !== "string" || !/^[a-f0-9]{64}$/.test(credential.token)) {
      throw refusal("control-unavailable", "The local control credential is unavailable; the job claim remains held.");
    }
    return credential.token;
  }

  function getStatus(jobId) {
    return statusFor(jobId);
  }

  function getActiveStatus() {
    const active = readActive();
    return active ? statusFor(active.jobId) : null;
  }

  function endpointFor(profileEndpoint, options) {
    return controlEndpointFor(profileEndpoint, options);
  }

  function startControlServer({ jobId, endpoint, token } = {}) {
    requireWritable();
    assertActive(jobId);
    if (!readClaim(jobId)) throw refusal("worker-not-claimed", "The job control endpoint belongs to its claimed worker only.");
    const secret = token ?? readControlCredential(jobId);
    if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) {
      throw refusal("control-unavailable", "The local control credential is unavailable.");
    }
    if (typeof endpoint !== "string" || !endpoint.trim()) throw refusal("invalid-endpoint", "The profile control endpoint is unavailable.");
    if (endpoint.startsWith("\\\\.\\pipe\\")) {
      // Named pipe creation is delegated to Node; never unlink a pipe name that
      // may belong to another profile owner.
    } else {
      fsApi.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    }

    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let replied = false;
      const reply = (value) => {
        if (replied) return;
        replied = true;
        try { socket.end(`${JSON.stringify(value)}\n`); } catch { socket.destroy(); }
      };
      socket.setTimeout(5000, () => reply({ ok: false, error: "control-timeout" }));
      socket.on("error", () => { if (!replied) socket.destroy(); });
      socket.on("data", (chunk) => {
        if (replied) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_CONTROL_BYTES) return reply({ ok: false, error: "invalid-request" });
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        if (newline !== buffer.length - 1) return reply({ ok: false, error: "invalid-request" });
        let request;
        try { request = JSON.parse(buffer.subarray(0, newline).toString("utf8")); } catch { return reply({ ok: false, error: "invalid-request" }); }
        const keys = isPlainObject(request) ? Object.keys(request).sort().join(",") : "";
        if (keys !== "operation,schema,token" || request.schema !== CONTROL_SCHEMA || !equalSecret(request.token, secret)) {
          return reply({ ok: false, error: "unauthorized" });
        }
        if (request.operation !== "status" && request.operation !== "revoke") {
          return reply({ ok: false, error: "unsupported-operation" });
        }
        try {
          const full = request.operation === "status" ? statusFor(jobId) : revoke(jobId);
          // Live identity and revocation must fit even when the accepted goal
          // or retained reports do not. Never put statusFor() on this socket.
          reply({ ok: true, status: controlAcknowledgement(full) });
        } catch {
          reply({ ok: false, error: "state-unavailable" });
        }
      });
    });

    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        let socketIdentity = null;
        if (!endpoint.startsWith("\\\\.\\pipe\\")) {
          try {
            fsApi.chmodSync(endpoint, 0o600);
            const stat = fsApi.lstatSync(endpoint);
            socketIdentity = { dev: stat.dev, ino: stat.ino };
          } catch (error) {
            server.close(() => {});
            reject(error);
            return;
          }
        }
        let closed = false;
        resolve({
          endpoint,
          close: () => new Promise((done, fail) => {
            if (closed) return done();
            closed = true;
            server.close((error) => {
              if (error) return fail(error);
              if (socketIdentity) {
                try {
                  const current = fsApi.lstatSync(endpoint);
                  if (current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) fsApi.unlinkSync(endpoint);
                } catch (unlinkError) {
                  if (unlinkError?.code !== "ENOENT") return fail(unlinkError);
                }
              }
              done();
            });
          }),
        });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpoint);
    });
  }

  return Object.freeze({
    startAdmission,
    getStatus,
    getActiveStatus,
    claimWorker,
    updateProgress,
    recordPendingCommand,
    completeCommand,
    revoke,
    recordOutcome,
    releaseAdmission,
    readControlCredential,
    controlEndpointFor: endpointFor,
    startControlServer,
  });
}

function controlAcknowledgement(status) {
  const ack = {
    jobId: status.jobId,
    requestId: status.requestId,
    state: status.state,
    active: status.active === true,
    revoked: status.revoked === true,
    pendingCommandId: status.pendingCommand?.commandId ?? null,
    readTurnsRemaining: status.counters?.readTurnsRemaining ?? null,
    writeTurnsRemaining: status.counters?.writeTurnsRemaining ?? null,
    workerPid: status.startupClaim?.pid ?? null,
    claimed: status.startupClaim !== null,
  };
  if (Buffer.byteLength(`${JSON.stringify({ ok: true, status: ack })}\n`) > MAX_CONTROL_BYTES) {
    throw refusal("invalid-control-response", "The job control acknowledgement does not fit; no claim was cleared.");
  }
  return ack;
}

function requestControl(endpoint, token, operation, { timeoutMs = 5000 } = {}) {
  if (typeof endpoint !== "string" || !endpoint.trim()) return Promise.reject(refusal("invalid-endpoint", "The profile control endpoint is unavailable."));
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return Promise.reject(refusal("invalid-control-token", "The local control credential is unavailable."));
  if (operation !== "status" && operation !== "revoke") return Promise.reject(refusal("unsupported-operation", "Only status and revoke control requests are supported."));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(refusal("control-unavailable", "The job control endpoint did not respond; no claim was cleared.")), timeoutMs);
    socket.once("error", (error) => finish(refusal("control-unavailable", `The job control endpoint is unavailable; no claim was cleared (${error.code || "connection failure"}).`)));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_CONTROL_BYTES) return finish(refusal("invalid-control-response", "The job control response is too large."));
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) return finish(refusal("invalid-control-response", "The job control response is malformed."));
      let response;
      try { response = JSON.parse(buffer.subarray(0, newline).toString("utf8")); } catch {
        return finish(refusal("invalid-control-response", "The job control response is malformed."));
      }
      if (!isPlainObject(response) || response.ok !== true || !isPlainObject(response.status)) {
        return finish(refusal("control-refused", "The job control request was refused; no claim was cleared."));
      }
      finish(null, response.status);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ schema: CONTROL_SCHEMA, token, operation })}\n`);
    });
  });
}

module.exports = {
  createCoordinationJobStore,
  normalizeAdmissionInput,
  controlEndpointFor,
  requestControl,
  controlAcknowledgement,
  ADMISSION_SCHEMA,
  PROGRESS_SCHEMA,
  CONTROL_SCHEMA,
  REVOCATION_FILE,
  REVOCATION_SCHEMA,
};
