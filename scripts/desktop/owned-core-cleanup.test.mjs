import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import launchConfig from "../../electron/launch-config.cjs";
import { cleanupOwnedCore } from "./owned-core-cleanup.mjs";

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-cleanup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = resolve(root, "application"), profileDirectory = resolve(root, "profile");
  mkdirSync(resolve(packageRoot, "resources"), { recursive: true }); mkdirSync(profileDirectory);
  const executablePath = resolve(packageRoot, "resources/goalport-core.exe");
  writeFileSync(executablePath, "inert executable identity fixture; never executed");
  const coreSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
  const key = createHash("sha256").update(launchConfig.normalizedPath(profileDirectory)).digest("hex").slice(0, 20);
  const created = Date.now(), creationDate = `/Date(${created})/`;
  const core = { pid: 424242, creationDate, createdMs: created, executablePath, executableSha256: coreSha256 };
  const ready = { kind: "launch-ready", readyState: "READY_COMMITTED", launchNonce: "fixture-nonce", coreEpochId: "core-epoch:fixture-nonce", startupReceiptId: "startup:fixture-nonce", databaseIdentity: resolve(profileDirectory, "goalport.sqlite"), pipeIdentity: `\\\\.\\pipe\\goalport-rc-${key}-${coreSha256.slice(0, 20)}`, core };
  writeFileSync(resolve(profileDirectory, "goalport-profile.json"), JSON.stringify({ schemaVersion: 1, identityVersion: 2, profileKey: key, product: "GoalPort", mode: "synthetic-test", coreSha256, version: "1.0.0-rc.1" }));
  writeFileSync(ready.databaseIdentity, "inert DB bytes");
  const readyPath = resolve(profileDirectory, "goalport.sqlite.launch-ready");
  writeFileSync(readyPath, JSON.stringify(ready));
  let live = true; const stops = [];
  const options = { profileDirectory, packageRoot, coreSha256, version: "1.0.0-rc.1", mode: "synthetic-test", startedAt: new Date(created - 1000).toISOString(), waitMs: 20, observe: () => live ? { ProcessId: core.pid, ExecutablePath: executablePath, CreationDate: creationDate } : null, stop: (pid) => { stops.push(pid); live = false; } };
  return { options, ready, readyPath, stops, core };
}

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
    if (kind === "pid-reuse") f.options.observe = () => ({ ProcessId: f.core.pid, ExecutablePath: f.core.executablePath, CreationDate: "/Date(1)/" });
    writeFileSync(f.readyPath, JSON.stringify(f.ready));
    await assert.rejects(cleanupOwnedCore(f.options)); assert.deepEqual(f.stops, []);
  }
});

test("missing committed identity and failed termination cannot be called cleaned", async (t) => {
  const missing = fixture(t); rmSync(missing.readyPath);
  await assert.rejects(cleanupOwnedCore(missing.options)); assert.deepEqual(missing.stops, []);
  const stuck = fixture(t); stuck.options.stop = (pid) => stuck.stops.push(pid);
  await assert.rejects(cleanupOwnedCore(stuck.options), /did not exit/); assert.deepEqual(stuck.stops, [stuck.core.pid]);
});
