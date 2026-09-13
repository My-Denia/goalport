import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { verifyEarlyCleanup } from "./verify-early-cleanup.mjs";

test("timeout and unexpected driver exits still attempt identity-guarded rescue from the owned report", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-verifier-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const status of [null, 0, 23]) {
    const out = resolve(root, String(status)); let rescued;
    const result = await verifyEarlyCleanup(resolve(root, "package"), out, {
      runDriver: (_command, argv) => {
        const smokeOut = argv[argv.indexOf("--out") + 1], profile = argv[argv.indexOf("--test-profile") + 1], scratch = resolve(root, "scratch");
        mkdirSync(smokeOut, { recursive: true });
        writeFileSync(resolve(smokeOut, "report.json"), JSON.stringify({ originalPackage: resolve(root, "package"), profile, scratch, packageRoot: resolve(scratch, "application"), startedAt: new Date().toISOString(), identity: { version: "1.0.0-rc.1", artifacts: [{ path: "resources/goalport-core.exe", sha256: "a".repeat(64) }] } }));
        return { status, stdout: "", stderr: "synthetic interrupted child" };
      },
      rescue: async (options) => { rescued = options; return { verifiedCoreStopped: true }; },
      identify: () => assert.fail("abnormal exit cannot be called successful verification"), observe: () => assert.fail("real process observation not allowed in model")
    });
    assert.equal(result.status, "FAIL"); assert.equal(result.childExitCode, status);
    assert.equal(rescued.profileDirectory, resolve(out, "owned-profile")); assert.equal(result.rescue.verifiedCoreStopped, true);
  }
});

test("exit judgement requires a definite observation; unknown is unverifiable and live is a leak", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-verifier-observe-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const core = { pid: 424242, creationDate: "/Date(1789297792128)/" };
  const run = (name, observe) => verifyEarlyCleanup(resolve(root, "package"), resolve(root, name), {
    runDriver: (_command, argv) => {
      const smokeOut = argv[argv.indexOf("--out") + 1], profile = argv[argv.indexOf("--test-profile") + 1], scratch = resolve(root, `${name}-scratch`);
      mkdirSync(smokeOut, { recursive: true });
      writeFileSync(resolve(smokeOut, "report.json"), JSON.stringify({ status: "FAIL", diagnostics: { stage: "forced-before-startup-receipt" }, cleanup: [{ process: core.pid, verifiedCoreStopped: true }], originalPackage: resolve(root, "package"), profile, scratch, packageRoot: resolve(scratch, "application"), startedAt: new Date().toISOString(), identity: { version: "1.0.0-rc.1", artifacts: [{ path: "resources/goalport-core.exe", sha256: "a".repeat(64) }] } }));
      return { status: 1, stdout: "", stderr: "" };
    },
    identify: async () => core, observe, observeMs: 300,
    rescue: async () => ({ retained: true, phase: "observe-before-stop" })
  });
  const absent = await run("absent", () => ({ state: "absent" }));
  assert.equal(absent.status, "PASS"); assert.equal(absent.ownedCoreStillRunning, false);
  const leaked = await run("leaked", () => ({ state: "live", ProcessId: core.pid, ExecutablePath: "C:\\fixture.exe", CreationDate: core.creationDate }));
  assert.equal(leaked.status, "FAIL"); assert.match(leaked.error, /leaked its owned Core/);
  const incomplete = await run("incomplete", () => ({ state: "live", ProcessId: core.pid }));
  assert.equal(incomplete.status, "FAIL"); assert.match(incomplete.error, /observer contract violation/); assert.equal(incomplete.ownedCoreStillRunning, undefined);
  const unknown = await run("unknown", () => ({ state: "unknown", reason: "fixture timeout", errorCode: "ETIMEDOUT" }));
  assert.equal(unknown.status, "FAIL"); assert.match(unknown.error, /unverifiable exit observation/);
  assert.ok(unknown.observationAttempts.length > 0); assert.equal(unknown.ownedCoreStillRunning, undefined);
  const summary = JSON.parse(readFileSync(resolve(root, "unknown", "failure-summary.json"), "utf8"));
  assert.equal(summary.status, "FAIL"); assert.ok(!JSON.stringify(summary).includes(root.replaceAll("\\", "\\\\")));
});

test("foreign or missing smoke reports never authorize rescue of an unrelated process", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "goalport-verifier-refusal-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const kind of ["missing", "foreign-profile"]) {
    const result = await verifyEarlyCleanup(resolve(root, "package"), resolve(root, kind), {
      runDriver: (_command, argv) => {
        if (kind === "foreign-profile") {
          const smokeOut = argv[argv.indexOf("--out") + 1]; mkdirSync(smokeOut, { recursive: true });
          writeFileSync(resolve(smokeOut, "report.json"), JSON.stringify({ originalPackage: resolve(root, "package"), profile: resolve(root, "not-owned") }));
        }
        return { status: null, stdout: "", stderr: "fixture timeout" };
      }, rescue: () => assert.fail("unverified report cannot authorize termination")
    });
    assert.equal(result.status, "FAIL"); assert.equal(result.rescue.retained, true);
  }
});
