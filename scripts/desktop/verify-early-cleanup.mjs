import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argsFor, ROOT, fileHash } from "./package.mjs";
import { cleanupOwnedCore, ownedCoreIdentity, creationTime, observeKnown } from "./owned-core-cleanup.mjs";
import { observeProcess } from "./process-observer.mjs";
import { sanitizeDiagnostic } from "./diagnostics.mjs";
import launchConfig from "../../electron/launch-config.cjs";

export async function verifyEarlyCleanup(packageInput, outInput, hooks = {}) {
  const out = resolve(outInput), packageRoot = resolve(packageInput);
  assert.equal(existsSync(out), false, "new evidence destination required"); mkdirSync(out, { recursive: true });
  const smokeOut = resolve(out, "smoke"), profile = resolve(out, "owned-profile"), driver = resolve(ROOT, "scripts/desktop/smoke.mjs");
  const argv = [driver, "--package", packageRoot, "--out", smokeOut, "--test-profile", profile, "--fail-before-receipt"];
  const report = { status: "RUNNING", boundaryStates: ["error-path"], command: process.execPath, arguments: argv, cwd: process.cwd(), driverSha256: fileHash(driver), startedAt: new Date().toISOString(), realSubscriptionAdmission: false };
  const runDriver = hooks.runDriver || spawnSync, observe = hooks.observe || ((pid) => observeProcess(pid));
  const rescue = hooks.rescue || cleanupOwnedCore, identify = hooks.identify || ownedCoreIdentity, observeMs = hooks.observeMs ?? 20000;
  let identityOptions, smoke;
  const loadOwnedReport = () => {
    const value = JSON.parse(readFileSync(resolve(smokeOut, "report.json"), "utf8"));
    assert.equal(launchConfig.normalizedPath(value.originalPackage), launchConfig.normalizedPath(packageRoot), "foreign package report");
    assert.equal(launchConfig.normalizedPath(value.profile), launchConfig.normalizedPath(profile), "foreign profile report");
    assert.equal(launchConfig.normalizedPath(value.packageRoot), launchConfig.normalizedPath(resolve(value.scratch, "application")), "invalid copied package location");
    assert.ok(Number.isFinite(Date.parse(value.startedAt)) && Date.parse(value.startedAt) >= Date.parse(report.startedAt), "stale smoke report");
    const coreSha256 = value.identity?.artifacts?.find((item) => item.path === "resources/goalport-core.exe")?.sha256;
    assert.ok(/^[a-f0-9]{64}$/.test(coreSha256), "missing Core hash in owned report");
    identityOptions = { profileDirectory: profile, packageRoot: value.packageRoot, coreSha256, version: value.identity.version, mode: "synthetic-test", startedAt: report.startedAt, observe, stop: (pid) => process.kill(pid) };
    return value;
  };
  try {
    const child = runDriver(process.execPath, argv, { encoding: "utf8", windowsHide: true, timeout: 90000 });
    report.childExitCode = child.status;
    writeFileSync(resolve(out, "driver.log"), (child.stdout || "") + (child.stderr || ""));
    // Recovery must be bound before judging timeout or unexpected exit status.
    smoke = loadOwnedReport();
    assert.equal(child.status, 1, "the injected failure must be visible as exit1");
    assert.equal(smoke.status, "FAIL"); assert.equal(smoke.diagnostics.stage, "forced-before-startup-receipt");
    assert.equal(smoke.coreIdentity, undefined, "injection occurred before renderer receipt assignment");
    const core = await identify(identityOptions);
    report.observationAttempts = [];
    let current;
    try { current = await observeKnown(observe, core.pid, Date.now() + observeMs, report.observationAttempts); } catch (error) {
      throw new Error(`unverifiable exit observation: ${error.message}`);
    }
    const stillOwned = current.state === "live" && creationTime(current.CreationDate) === creationTime(core.creationDate);
    report.core = core; report.ownedCoreStillRunning = stillOwned;
    assert.equal(stillOwned, false, "early smoke failure leaked its owned Core");
    assert.ok(smoke.cleanup.some((item) => item.process === core.pid && item.verifiedCoreStopped === true), "driver must record verified cleanup");
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL"; report.error = error.stack || String(error);
    if (!identityOptions) {
      try { smoke = loadOwnedReport(); } catch (readError) { report.rescue = { retained: true, error: String(readError.message) }; }
    }
    if (identityOptions) {
      try { report.rescue = await rescue(identityOptions); } catch (cleanupError) { report.rescue = { retained: true, phase: cleanupError.phase, error: String(cleanupError.message) }; }
    }
  } finally {
    report.completedAt = new Date().toISOString(); writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2));
    if (report.status !== "PASS") {
      const privatePaths = [out, packageRoot, profile, smoke?.scratch, process.env.USERPROFILE, process.env.HOME, tmpdir()];
      const summary = { schemaVersion: 1, status: report.status, error: report.error, childExitCode: report.childExitCode, ownedCoreStillRunning: report.ownedCoreStillRunning, observationAttempts: report.observationAttempts, rescue: report.rescue };
      try { writeFileSync(resolve(out, "failure-summary.json"), `${sanitizeDiagnostic(JSON.stringify(summary, null, 2), privatePaths)}\n`); } catch (writeError) {
        console.error(`failure-summary.json could not be written: ${sanitizeDiagnostic(writeError.message, privatePaths)}`);
      }
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = argsFor(process.argv.slice(2), ["--package", "--out"]);
  assert.ok(args["--package"] && args["--out"], "--package and --out are required");
  const report = await verifyEarlyCleanup(args["--package"], args["--out"]);
  if (report.status !== "PASS") process.exitCode = 1;
  console.log(JSON.stringify({ status: report.status, expectedChildExitCode: 1, observedChildExitCode: report.childExitCode, ownedCoreStillRunning: report.ownedCoreStillRunning }));
}
