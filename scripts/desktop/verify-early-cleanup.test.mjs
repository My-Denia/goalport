import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
