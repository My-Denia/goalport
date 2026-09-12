import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import launchConfig from "../../electron/launch-config.cjs";
import { fileHash } from "./package.mjs";

const normalize = launchConfig.normalizedPath;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export function creationTime(value) {
  const match = String(value).match(/Date\((\d+)\)/);
  return match ? Number(match[1]) : Date.parse(value);
}

export async function ownedCoreIdentity({ profileDirectory, packageRoot, coreSha256, version, mode, startedAt, waitMs = 2000 }) {
  assert.ok(Number.isFinite(waitMs) && waitMs >= 0 && waitMs <= 10000, "bounded identity wait required");
  const deadline = Date.now() + waitMs;
  let marker, ready;
  while (true) {
    try {
      marker = JSON.parse(readFileSync(resolve(profileDirectory, "goalport-profile.json"), "utf8"));
      ready = JSON.parse(readFileSync(resolve(profileDirectory, "goalport.sqlite.launch-ready"), "utf8"));
      break;
    } catch (error) {
      if (!(error.code === "ENOENT" || error instanceof SyntaxError) || Date.now() >= deadline) throw error;
      await sleep(50);
    }
  }
  assert.equal(marker.product, "GoalPort"); assert.equal(marker.schemaVersion, 1);
  assert.equal(marker.coreSha256, coreSha256); assert.equal(marker.version, version); assert.equal(marker.mode, mode);
  assert.ok(marker.identityVersion === undefined || marker.identityVersion === 2, "unknown profile identity format");
  // Legacy receipt support is only for cleaning owned test processes, never for
  // profile adoption. Database comparison below always preserves canonical case.
  const directoryKey = marker.identityVersion === 2 ? normalize(profileDirectory) : normalize(profileDirectory).toLowerCase();
  const key = createHash("sha256").update(directoryKey).digest("hex").slice(0, 20);
  if (marker.identityVersion === 2) assert.equal(marker.profileKey, key);
  assert.equal(ready.kind, "launch-ready"); assert.equal(ready.readyState, "READY_COMMITTED");
  assert.ok(typeof ready.launchNonce === "string" && ready.launchNonce.length > 0);
  assert.equal(ready.coreEpochId, `core-epoch:${ready.launchNonce}`);
  assert.equal(ready.startupReceiptId, `startup:${ready.launchNonce}`);
  assert.equal(normalize(ready.databaseIdentity), normalize(resolve(profileDirectory, "goalport.sqlite")));
  assert.equal(String(ready.pipeIdentity).toLowerCase(), `\\\\.\\pipe\\goalport-rc-${key}-${coreSha256.slice(0, 20)}`.toLowerCase());
  const core = ready.core;
  assert.ok(Number.isSafeInteger(core?.pid) && core.pid > 0, "valid Core PID required");
  assert.equal(core.executableSha256, coreSha256);
  const expected = resolve(packageRoot, "resources/goalport-core.exe");
  assert.equal(normalize(core.executablePath), normalize(expected)); assert.equal(fileHash(expected), coreSha256);
  const created = creationTime(core.creationDate), start = Date.parse(startedAt);
  assert.ok(Number.isFinite(created) && Number.isFinite(start) && created >= start, "Core predates owned smoke run or creation identity is unavailable");
  if (core.createdMs !== undefined) assert.equal(core.createdMs, created);
  return { ...core, source: "launch-ready" };
}

export async function cleanupOwnedCore(options) {
  const { observe, stop } = options;
  assert.equal(typeof observe, "function"); assert.equal(typeof stop, "function");
  const core = await ownedCoreIdentity(options);
  const current = observe(core.pid);
  if (!current) return { process: core.pid, creationDate: core.creationDate, source: core.source, verifiedCoreStopped: true, action: "verified owned Core already exited" };
  assert.equal(Number(current.ProcessId), core.pid);
  assert.equal(normalize(current.ExecutablePath), normalize(core.executablePath));
  assert.equal(fileHash(current.ExecutablePath), core.executableSha256);
  assert.ok(Number.isFinite(creationTime(current.CreationDate)), "observed creation time is unavailable");
  assert.equal(creationTime(current.CreationDate), creationTime(core.creationDate), "PID was reused; cleanup refused");
  stop(core.pid);
  const deadline = Date.now() + (options.waitMs ?? 2000);
  while (true) {
    const after = observe(core.pid);
    if (!after) break;
    assert.equal(Number(after.ProcessId), core.pid);
    assert.ok(Number.isFinite(creationTime(after.CreationDate)), "exit observation has no creation identity");
    if (creationTime(after.CreationDate) !== creationTime(core.creationDate)) break;
    assert.ok(Date.now() < deadline, "owned Core did not exit after termination");
    await sleep(50);
  }
  return { process: core.pid, creationDate: core.creationDate, source: core.source, executable: core.executablePath, executableSha256: core.executableSha256, verifiedCoreStopped: true, action: "stopped owned Core after full independent identity check" };
}
