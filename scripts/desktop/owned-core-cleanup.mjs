import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileHash } from "./package.mjs";
import { creationTime } from "./process-observer.mjs";

export { creationTime };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const MAX_ATTEMPTS = 20;
const TRANSIENT_FILE_CODES = new Set(["ENOENT", "EBUSY", "EPERM", "EACCES"]);
const STATES = new Set(["live", "absent", "unknown"]);

export class TransientIdentityError extends Error {
  constructor(message, code) { super(message); this.name = "TransientIdentityError"; this.code = code; }
}

const stripVerbatim = (value) => String(value).replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replaceAll("/", "\\");

// Same spelling as launch-config normalizedPath after a successful realpath, but an
// unresolvable path is never compared through a partially resolved fallback.
export function canonicalIdentityPath(value, realpath = realpathSync.native) {
  let real;
  try { real = realpath(resolve(stripVerbatim(value))); } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error(`identity path does not exist: ${value}`);
    throw new TransientIdentityError(`identity path could not be canonicalized (${error.code || error.message})`, error.code);
  }
  return stripVerbatim(real);
}

function recordAttempt(attempts, observation) {
  if (attempts.length >= MAX_ATTEMPTS) return;
  const { state, reason, errorCode = null, status = null, elapsedMs = null } = observation;
  attempts.push({ state, reason, errorCode, status, elapsedMs });
}

// Unknown observations (including a transient identity canonicalization) are retried
// until the deadline; live and absent return at once and mismatches are thrown by check.
export async function observeKnown(observe, pid, deadline, attempts = [], check) {
  while (true) {
    const started = Date.now();
    const observation = observe(pid);
    if (!observation || typeof observation !== "object" || !STATES.has(observation.state)) throw new Error("observer contract violation: expected a live, absent or unknown observation");
    // A live observation must carry the full identity; missing fields must never read as "exited".
    if (observation.state === "live" && (Number(observation.ProcessId) !== pid || typeof observation.ExecutablePath !== "string" || !observation.ExecutablePath || !Number.isFinite(creationTime(observation.CreationDate)))) {
      throw new Error("observer contract violation: live observation lacks pid, executable or creation identity");
    }
    let unknown = observation.state === "unknown" ? observation : null;
    if (observation.state === "live" && check) {
      try { check(observation); } catch (error) {
        if (!(error instanceof TransientIdentityError)) throw error;
        unknown = { state: "unknown", reason: error.message, errorCode: error.code ?? null, elapsedMs: Date.now() - started };
      }
    }
    if (!unknown) return observation;
    recordAttempt(attempts, unknown);
    if (Date.now() >= deadline) throw new Error(`process observation stayed unknown until its deadline: ${unknown.reason}`);
    await sleep(250);
    if (Date.now() >= deadline) throw new Error(`process observation stayed unknown until its deadline: ${unknown.reason}`);
  }
}

function readOwnedIdentity({ profileDirectory, packageRoot, coreSha256, version, mode, startedAt, readText, realpath }) {
  const canonical = (value) => canonicalIdentityPath(value, realpath);
  const marker = JSON.parse(readText(resolve(profileDirectory, "goalport-profile.json")));
  const ready = JSON.parse(readText(resolve(profileDirectory, "goalport.sqlite.launch-ready")));
  // Marker schema v1 (rc.1-era {schemaVersion: 1}) or v2 (packaged
  // {markerSchemaVersion: 2}); same field precedence as the product's
  // parseMarkerText. Anything else is unknown and refuses cleanup.
  const markerSchema = marker.markerSchemaVersion ?? marker.schemaVersion;
  assert.equal(marker.product, "GoalPort");
  assert.ok(markerSchema === 1 || markerSchema === 2, `unknown profile marker schema ${JSON.stringify(markerSchema)}`);
  assert.equal(marker.mode, mode);
  assert.ok(marker.identityVersion === undefined || marker.identityVersion === 2, "unknown profile identity format");
  if (markerSchema === 1) {
    assert.equal(marker.coreSha256, coreSha256); assert.equal(marker.version, version);
  } else {
    // v2 builder provenance (createdBy/lastOpenedBy, and any inline version or
    // coreSha256) is never cleanup authority: build identity stays bound to the
    // committed ready record and the expected executable path + file hash below.
    assert.equal(marker.identityVersion, 2, "marker v2 must carry identityVersion 2");
  }
  // Legacy receipt support is only for cleaning owned test processes, never for
  // profile adoption. Database comparison below always preserves canonical case.
  const directoryKey = marker.identityVersion === 2 ? canonical(profileDirectory) : canonical(profileDirectory).toLowerCase();
  const key = createHash("sha256").update(directoryKey).digest("hex").slice(0, 20);
  if (marker.identityVersion === 2) assert.equal(marker.profileKey, key);
  assert.equal(ready.kind, "launch-ready"); assert.equal(ready.readyState, "READY_COMMITTED");
  assert.ok(typeof ready.launchNonce === "string" && ready.launchNonce.length > 0);
  assert.equal(ready.coreEpochId, `core-epoch:${ready.launchNonce}`);
  assert.equal(ready.startupReceiptId, `startup:${ready.launchNonce}`);
  assert.equal(canonical(ready.databaseIdentity), canonical(resolve(profileDirectory, "goalport.sqlite")));
  assert.equal(String(ready.pipeIdentity).toLowerCase(), `\\\\.\\pipe\\goalport-rc-${key}-${coreSha256.slice(0, 20)}`.toLowerCase());
  const core = ready.core;
  assert.ok(Number.isSafeInteger(core?.pid) && core.pid > 0, "valid Core PID required");
  assert.equal(core.executableSha256, coreSha256);
  const expected = resolve(packageRoot, "resources/goalport-core.exe");
  assert.equal(canonical(core.executablePath), canonical(expected)); assert.equal(fileHash(expected), coreSha256);
  const created = creationTime(core.creationDate), start = Date.parse(startedAt);
  assert.ok(Number.isFinite(created) && Number.isFinite(start) && created >= start, "Core predates owned smoke run or creation identity is unavailable");
  if (core.createdMs !== undefined) assert.equal(core.createdMs, created);
  return { ...core, source: "launch-ready" };
}

export async function ownedCoreIdentity({ waitMs = 2000, readText = (file) => readFileSync(file, "utf8"), realpath = realpathSync.native, ...options }) {
  assert.ok(Number.isFinite(waitMs) && waitMs >= 0 && waitMs <= 10000, "bounded identity wait required");
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      return readOwnedIdentity({ ...options, readText, realpath });
    } catch (error) {
      const transient = error instanceof SyntaxError || error instanceof TransientIdentityError || TRANSIENT_FILE_CODES.has(error.code);
      if (!transient || Date.now() >= deadline) throw error;
      await sleep(50);
    }
  }
}

export async function cleanupOwnedCore(options) {
  const { observe, stop, realpath = realpathSync.native, observeMs = 20000, exitWaitMs = 10000 } = options;
  assert.equal(typeof observe, "function"); assert.equal(typeof stop, "function");
  for (const value of [observeMs, exitWaitMs]) assert.ok(Number.isFinite(value) && value >= 0 && value <= 60000, "bounded observation deadline required");
  const attempts = [];
  const inPhase = async (phase, work) => {
    try { return await work(); } catch (error) { throw Object.assign(error, { phase, attempts }); }
  };
  const core = await inPhase("identity", () => ownedCoreIdentity(options));
  const summary = { process: core.pid, creationDate: core.creationDate, source: core.source, attempts };
  const current = await inPhase("observe-before-stop", () => observeKnown(observe, core.pid, Date.now() + observeMs, attempts, (live) => {
    assert.equal(Number(live.ProcessId), core.pid);
    assert.equal(canonicalIdentityPath(live.ExecutablePath, realpath), canonicalIdentityPath(core.executablePath, realpath));
    assert.equal(fileHash(live.ExecutablePath), core.executableSha256);
    assert.ok(Number.isFinite(creationTime(live.CreationDate)), "observed creation time is unavailable");
    assert.equal(creationTime(live.CreationDate), creationTime(core.creationDate), "PID was reused; cleanup refused");
  }));
  if (current.state === "absent") return { ...summary, verifiedCoreStopped: true, action: "verified owned Core already exited" };
  await inPhase("stop", () => {
    try { stop(core.pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  const deadline = Date.now() + exitWaitMs;
  await inPhase("observe-after-stop", async () => {
    while (true) {
      const after = await observeKnown(observe, core.pid, deadline, attempts);
      if (after.state === "absent" || creationTime(after.CreationDate) !== creationTime(core.creationDate)) return;
      assert.ok(Date.now() < deadline, "owned Core did not exit after termination");
      await sleep(50);
      assert.ok(Date.now() < deadline, "owned Core did not exit after termination");
    }
  });
  return { ...summary, executable: core.executablePath, executableSha256: core.executableSha256, verifiedCoreStopped: true, action: "stopped owned Core after full independent identity check" };
}
