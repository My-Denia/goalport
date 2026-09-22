import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import launchConfig from "../../electron/launch-config.cjs";
import { buildMarkerV2 } from "../../electron/profile-manager.cjs";
import { cleanupOwnedCore } from "./owned-core-cleanup.mjs";

function fixture(t, { alias = false, markerVersion = 1 } = {}) {
  const base = mkdtempSync(resolve(tmpdir(), "goalport-cleanup-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const real = resolve(base, "real");
  mkdirSync(real);
  let root = real;
  if (alias) { root = resolve(base, "alias"); symlinkSync(real, root, "junction"); }
  const packageRoot = resolve(root, "application"), profileDirectory = resolve(root, "profile");
  mkdirSync(resolve(packageRoot, "resources"), { recursive: true }); mkdirSync(profileDirectory);
  const canonicalRoot = realpathSync.native(real);
  const executablePath = resolve(canonicalRoot, "application/resources/goalport-core.exe");
  writeFileSync(executablePath, "inert executable identity fixture; never executed");
  const coreSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
  const key = createHash("sha256").update(launchConfig.normalizedPath(resolve(canonicalRoot, "profile"))).digest("hex").slice(0, 20);
  const created = Date.now(), creationDate = `/Date(${created})/`;
  const core = { pid: 424242, creationDate, createdMs: created, executablePath, executableSha256: coreSha256 };
  const ready = { kind: "launch-ready", readyState: "READY_COMMITTED", launchNonce: "fixture-nonce", coreEpochId: "core-epoch:fixture-nonce", startupReceiptId: "startup:fixture-nonce", databaseIdentity: resolve(canonicalRoot, "profile/goalport.sqlite"), pipeIdentity: `\\\\.\\pipe\\goalport-rc-${key}-${coreSha256.slice(0, 20)}`, core };
  const markerPath = resolve(profileDirectory, "goalport-profile.json");
  if (markerVersion === 2) {
    // The same writer the product uses for packaged profiles (markerSchemaVersion 2).
    // Builder provenance deliberately does NOT match this fixture build: it must
    // never be cleanup authority for v2 markers.
    const foreignProvenance = { version: "0.0.0-other-builder", coreSha256: "f".repeat(64), distribution: "release" };
    writeFileSync(markerPath, JSON.stringify(buildMarkerV2({
      profileKey: key, mode: "synthetic-test", channel: null,
      createdBy: foreignProvenance,
      lastOpenedBy: { ...foreignProvenance, at: new Date(created).toISOString() },
      formatVersion: null
    })));
  } else {
    writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, identityVersion: 2, profileKey: key, product: "GoalPort", mode: "synthetic-test", coreSha256, version: "1.0.0-rc.1" }));
  }
  writeFileSync(ready.databaseIdentity, "inert DB bytes");
  const readyPath = resolve(profileDirectory, "goalport.sqlite.launch-ready");
  writeFileSync(readyPath, JSON.stringify(ready));
  let live = true; const stops = [], observations = [];
  const liveObservation = () => ({ state: "live", ProcessId: core.pid, ExecutablePath: executablePath, CreationDate: creationDate });
  const options = {
    profileDirectory, packageRoot, coreSha256, version: "1.0.0-rc.1", mode: "synthetic-test", startedAt: new Date(created - 1000).toISOString(), waitMs: 20, observeMs: 50, exitWaitMs: 50,
    observe: () => { observations.push(live); return live ? liveObservation() : { state: "absent" }; },
    stop: (pid) => { stops.push(pid); live = false; }
  };
  return { options, ready, readyPath, markerPath, key, base, stops, core, observations, liveObservation, setLive: (value) => { live = value; } };
}
const unknown = (reason = "fixture observer timeout") => ({ state: "unknown", reason, errorCode: "ETIMEDOUT", status: null, elapsedMs: 5000 });

test("independent launch-ready identity cleans Core before a renderer receipt exists", async (t) => {
  const f = fixture(t); const result = await cleanupOwnedCore(f.options);
  assert.equal(result.source, "launch-ready"); assert.equal(result.verifiedCoreStopped, true);
  assert.deepEqual(f.stops, [f.core.pid]);
});

test("wrong database, pipe, hash, nonce or stale PID is retained without termination", async (t) => {
  for (const kind of ["database", "pipe", "hash", "nonce", "pid-reuse"]) {
    const f = fixture(t);
    if (kind === "database") f.ready.databaseIdentity += "-other";
    if (kind === "pipe") f.ready.pipeIdentity += "-other";
    if (kind === "hash") f.ready.core.executableSha256 = "0".repeat(64);
    if (kind === "nonce") f.ready.coreEpochId = "core-epoch:stale";
    if (kind === "pid-reuse") f.options.observe = () => ({ ...f.liveObservation(), CreationDate: "/Date(1)/" });
    writeFileSync(f.readyPath, JSON.stringify(f.ready));
    await assert.rejects(cleanupOwnedCore(f.options)); assert.deepEqual(f.stops, []);
  }
});

test("missing committed identity and failed termination cannot be called cleaned", async (t) => {
  const missing = fixture(t); rmSync(missing.readyPath);
  await assert.rejects(cleanupOwnedCore(missing.options)); assert.deepEqual(missing.stops, []);
  const stuck = fixture(t); stuck.options.stop = (pid) => stuck.stops.push(pid);
  await assert.rejects(cleanupOwnedCore(stuck.options), (error) => /did not exit/.test(error.message) && error.phase === "observe-after-stop"); assert.deepEqual(stuck.stops, [stuck.core.pid]);
});

test("unknown observations are retried within the phase deadline before one verified stop", async (t) => {
  const f = fixture(t); const sequence = [unknown(), unknown()];
  const observe = f.options.observe;
  f.options.observeMs = 5000;
  f.options.observe = (pid) => sequence.shift() ?? observe(pid);
  const result = await cleanupOwnedCore(f.options);
  assert.equal(result.verifiedCoreStopped, true); assert.deepEqual(f.stops, [f.core.pid]);
  assert.equal(result.attempts.length, 2); assert.equal(result.attempts[0].errorCode, "ETIMEDOUT");
});

test("persistent unknown, contract violations and mismatches after unknown never stop", async (t) => {
  const persistent = fixture(t); persistent.options.observe = () => unknown();
  const started = Date.now();
  await assert.rejects(cleanupOwnedCore(persistent.options), (error) => error.phase === "observe-before-stop" && error.attempts.length > 0 && /stayed unknown/.test(error.message));
  assert.ok(Date.now() - started < persistent.options.observeMs + 1000); assert.deepEqual(persistent.stops, []);
  const legacy = fixture(t); legacy.options.observe = () => null;
  await assert.rejects(cleanupOwnedCore(legacy.options), /observer contract violation/); assert.deepEqual(legacy.stops, []);
  const incomplete = fixture(t); incomplete.options.observe = () => ({ state: "live", ProcessId: incomplete.core.pid, ExecutablePath: incomplete.core.executablePath });
  await assert.rejects(cleanupOwnedCore(incomplete.options), /observer contract violation/); assert.deepEqual(incomplete.stops, []);
  const incompleteAfterStop = fixture(t); let stopped = false;
  incompleteAfterStop.options.stop = (pid) => { incompleteAfterStop.stops.push(pid); stopped = true; };
  incompleteAfterStop.options.observe = () => stopped ? { state: "live" } : incompleteAfterStop.liveObservation();
  await assert.rejects(cleanupOwnedCore(incompleteAfterStop.options), (error) => /observer contract violation/.test(error.message) && error.phase === "observe-after-stop");
  const mismatch = fixture(t); const sequence = [unknown()];
  mismatch.options.observeMs = 5000;
  mismatch.options.observe = () => sequence.shift() ?? { ...mismatch.liveObservation(), CreationDate: "/Date(1)/" };
  await assert.rejects(cleanupOwnedCore(mismatch.options), /PID was reused/); assert.deepEqual(mismatch.stops, []);
});

test("transient identity reads and canonicalization are bounded retries, not mismatches", async (t) => {
  const busyRead = fixture(t); let reads = 0;
  busyRead.options.readText = (file) => { if (++reads === 1) throw Object.assign(new Error("busy"), { code: "EACCES" }); return readFileSync(file, "utf8"); };
  busyRead.options.waitMs = 2000;
  assert.equal((await cleanupOwnedCore(busyRead.options)).verifiedCoreStopped, true); assert.deepEqual(busyRead.stops, [busyRead.core.pid]);
  const busyPath = fixture(t); let failures = 2;
  busyPath.options.realpath = (value) => { if (failures-- > 0) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return realpathSync.native(value); };
  busyPath.options.waitMs = 2000;
  assert.equal((await cleanupOwnedCore(busyPath.options)).verifiedCoreStopped, true); assert.deepEqual(busyPath.stops, [busyPath.core.pid]);
  const stuckPath = fixture(t); let identityDone = false;
  const identityObserve = stuckPath.options.observe;
  stuckPath.options.observe = (pid) => { identityDone = true; return identityObserve(pid); };
  stuckPath.options.realpath = (value) => { if (identityDone) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return realpathSync.native(value); };
  await assert.rejects(cleanupOwnedCore(stuckPath.options), (error) => error.phase === "observe-before-stop" && error.attempts[0].errorCode === "EBUSY"); assert.deepEqual(stuckPath.stops, []);
});

test("stop errors are phase-attributed and an already exited Core is verified", async (t) => {
  const denied = fixture(t); denied.options.stop = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };
  await assert.rejects(cleanupOwnedCore(denied.options), (error) => error.phase === "stop" && error.code === "EPERM");
  const exited = fixture(t); exited.options.stop = (pid) => { exited.stops.push(pid); exited.setLive(false); throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
  assert.equal((await cleanupOwnedCore(exited.options)).verifiedCoreStopped, true);
});

test("slow post-stop observations cannot extend the exit deadline", async (t) => {
  const slow = fixture(t);
  const observe = slow.options.observe; let stopped = false;
  slow.options.stop = (pid) => { slow.stops.push(pid); stopped = true; };
  slow.options.observe = (pid) => { if (stopped) { const until = Date.now() + 80; while (Date.now() < until); } return observe(pid); };
  const started = Date.now();
  await assert.rejects(cleanupOwnedCore(slow.options), /did not exit/);
  assert.ok(Date.now() - started < slow.options.exitWaitMs + 80 + 500);
});

test("an aliased package and profile spelling resolves to the same owned Core", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t, { alias: true });
  const result = await cleanupOwnedCore(f.options);
  assert.equal(result.verifiedCoreStopped, true); assert.deepEqual(f.stops, [f.core.pid]);
});

// ---------- marker schema v2 (packaged profiles: markerSchemaVersion 2) ----------

test("marker v2 packaged shape cleans its owned Core while builder provenance stays non-authoritative", async (t) => {
  const f = fixture(t, { markerVersion: 2 });
  const result = await cleanupOwnedCore(f.options);
  assert.equal(result.source, "launch-ready"); assert.equal(result.verifiedCoreStopped, true);
  assert.deepEqual(f.stops, [f.core.pid]);
});

test("marker v2 with an aliased directory spelling still binds the exact canonical profileKey", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t, { alias: true, markerVersion: 2 });
  assert.equal((await cleanupOwnedCore(f.options)).verifiedCoreStopped, true);
  assert.deepEqual(f.stops, [f.core.pid]);
});

test("marker v2 wrong product, mode, schema or identityVersion stops zero processes", async (t) => {
  const cases = [
    ["product", (marker) => { marker.product = "GoalPort Desktop"; }],
    ["mode", (marker) => { marker.mode = "normal"; }],
    ["schema-unknown", (marker) => { marker.markerSchemaVersion = 3; }],
    ["schema-missing", (marker) => { delete marker.markerSchemaVersion; }],
    ["identity-version-1", (marker) => { marker.identityVersion = 1; }],
    ["identity-version-3", (marker) => { marker.identityVersion = 3; }]
  ];
  for (const [kind, mutate] of cases) {
    const f = fixture(t, { markerVersion: 2 });
    const marker = buildMarkerV2({ profileKey: f.key, mode: "synthetic-test" });
    mutate(marker);
    writeFileSync(f.markerPath, JSON.stringify(marker));
    await assert.rejects(cleanupOwnedCore(f.options), (error) => error.phase === "identity", `${kind} must refuse cleanup`);
    assert.deepEqual(f.stops, []);
  }
});

test("marker v2 profileKey must equal the exact canonical directory identity", async (t) => {
  const nextHex = { "0": "1", "1": "2", "2": "3", "3": "4", "4": "5", "5": "6", "6": "7", "7": "8", "8": "9", "9": "a", "a": "b", "b": "c", "c": "d", "d": "e", "e": "f", "f": "0" };
  for (const kind of ["foreign-directory", "near-miss-key"]) {
    const f = fixture(t, { markerVersion: 2 });
    const key = kind === "foreign-directory"
      ? createHash("sha256").update(launchConfig.normalizedPath(resolve(tmpdir(), "foreign-goalport-profile"))).digest("hex").slice(0, 20)
      : nextHex[f.key[0]] + f.key.slice(1);
    writeFileSync(f.markerPath, JSON.stringify(buildMarkerV2({ profileKey: key, mode: "synthetic-test" })));
    await assert.rejects(cleanupOwnedCore(f.options), (error) => error.phase === "identity", `${kind} must refuse cleanup`);
    assert.deepEqual(f.stops, []);
  }
});

test("marker v2 with forged, stale or mismatched committed-ready identity stops zero processes", async (t) => {
  for (const kind of ["pending-state", "receipt-id", "epoch-nonce", "core-hash", "core-path", "pid-reuse", "missing-ready"]) {
    const f = fixture(t, { markerVersion: 2 });
    if (kind === "pending-state") f.ready.readyState = "STARTUP_PENDING";
    if (kind === "receipt-id") f.ready.startupReceiptId = "startup:stale";
    if (kind === "epoch-nonce") f.ready.coreEpochId = "core-epoch:stale";
    if (kind === "core-hash") f.ready.core.executableSha256 = "0".repeat(64);
    if (kind === "core-path") f.ready.core.executablePath += "-other";
    if (kind === "pid-reuse") f.options.observe = () => ({ ...f.liveObservation(), CreationDate: "/Date(1)/" });
    if (kind === "missing-ready") rmSync(f.readyPath);
    else writeFileSync(f.readyPath, JSON.stringify(f.ready));
    await assert.rejects(cleanupOwnedCore(f.options), undefined, `${kind} must refuse cleanup`);
    assert.deepEqual(f.stops, []);
  }
});

test("builder provenance matching this build never authorizes cleanup of a foreign profile", async (t) => {
  const f = fixture(t);
  const provenance = { version: f.options.version, coreSha256: f.options.coreSha256, distribution: "dev-candidate" };
  const foreignKey = createHash("sha256").update(launchConfig.normalizedPath(resolve(f.base, "other-profile"))).digest("hex").slice(0, 20);
  writeFileSync(f.markerPath, JSON.stringify(buildMarkerV2({
    profileKey: foreignKey, mode: "synthetic-test", channel: null,
    createdBy: provenance, lastOpenedBy: { ...provenance, at: new Date().toISOString() }, formatVersion: null
  })));
  await assert.rejects(cleanupOwnedCore(f.options), (error) => error.phase === "identity");
  assert.deepEqual(f.stops, []);
});

test("a profile directory without a marker authorizes nothing (missing-marker shape)", async (t) => {
  for (const markerVersion of [1, 2]) {
    const f = fixture(t, { markerVersion });
    rmSync(f.markerPath);
    await assert.rejects(cleanupOwnedCore(f.options), (error) => error.phase === "identity");
    assert.deepEqual(f.stops, []);
  }
});
