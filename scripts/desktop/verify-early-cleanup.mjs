import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argsFor, ROOT, fileHash } from "./package.mjs";
import { cleanupOwnedCore, ownedCoreIdentity, creationTime } from "./owned-core-cleanup.mjs";
import launchConfig from "../../electron/launch-config.cjs";

function observeProcess(pid) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}'; if($p){$p|Select-Object ProcessId,ExecutablePath,CreationDate|ConvertTo-Json -Compress}`], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, "independent process observation failed");
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

export async function verifyEarlyCleanup(packageInput, outInput, hooks = {}) {
  const out = resolve(outInput), packageRoot = resolve(packageInput);
  assert.equal(existsSync(out), false, "new evidence destination required"); mkdirSync(out, { recursive: true });
  const smokeOut = resolve(out, "smoke"), profile = resolve(out, "owned-profile"), driver = resolve(ROOT, "scripts/desktop/smoke.mjs");
  const argv = [driver, "--package", packageRoot, "--out", smokeOut, "--test-profile", profile, "--fail-before-receipt"];
  const report = { status: "RUNNING", boundaryStates: ["error-path"], command: process.execPath, arguments: argv, cwd: process.cwd(), driverSha256: fileHash(driver), startedAt: new Date().toISOString(), realSubscriptionAdmission: false };
  const runDriver = hooks.runDriver || spawnSync, observe = hooks.observe || observeProcess;
  const rescue = hooks.rescue || cleanupOwnedCore, identify = hooks.identify || ownedCoreIdentity;
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
    const core = await identify(identityOptions), current = observe(core.pid);
    if (current) assert.ok(Number.isFinite(creationTime(current.CreationDate)), "unverifiable exit observation");
    const stillOwned = current && creationTime(current.CreationDate) === creationTime(core.creationDate);
    report.core = core; report.ownedCoreStillRunning = Boolean(stillOwned);
    assert.equal(Boolean(stillOwned), false, "early smoke failure leaked its owned Core");
    assert.ok(smoke.cleanup.some((item) => item.process === core.pid && item.verifiedCoreStopped === true), "driver must record verified cleanup");
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL"; report.error = error.stack || String(error);
    if (!identityOptions) {
      try { smoke = loadOwnedReport(); } catch (readError) { report.rescue = { retained: true, error: String(readError.message) }; }
    }
    if (identityOptions) {
      try { report.rescue = await rescue(identityOptions); } catch (cleanupError) { report.rescue = { retained: true, error: String(cleanupError.message) }; }
    }
  } finally {
    report.completedAt = new Date().toISOString(); writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2));
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
