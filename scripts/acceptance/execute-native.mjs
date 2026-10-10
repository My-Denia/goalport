import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, claimOutput, assembleEnv, socketName, uniqueToken, freePort, preflight, launchApp } from './lib/launch.mjs';
import { materializeStubBin } from './lib/stubbin.mjs';
import { attachApp } from './lib/cdp-app.mjs';
import { createExecutionFixture } from './lib/execution-fixture.mjs';
import { collectArtifacts } from './lib/scenarios.mjs';
import { EXECUTION_SCENARIOS, baselineChecks, snapshotFixture, runExecutionScenario, executionAssertions, hash } from './lib/execution-scenarios.mjs';
import { withCaseDeadline } from './run-local.mjs';

export const NOT_VERIFIED = Object.freeze([
  'Native Windows packaged EXE, OS keyboard/mouse, IME and close behavior were not run.',
  'Real vendor CLI/model/help/auth/probes, model judgment, live model flags and physical sandbox confinement were not run.',
  'A separate readonly Node checker is actual process/test evidence, not independent-model judgment; GoalPort itself does not generally rerun tests.',
  'Closed-window durable goal coordination/background continuation and budget-bound feedback/revise loop remain unimplemented for this four-role path.',
  'Use again clears health but does not open a ready blank draft; real resource readiness/budget behavior remains unverified.',
  'Known nine desktop baseline failures and platform skips remain; full goal acceptance is not claimed.',
]);
export function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1]) throw Error('usage: node scripts/acceptance/execute-native.mjs --out <fresh run evidence directory>');
  return argv[1];
}
export function validateExecutionReport(report) {
  if (report.schemaVersion !== 1 || report.kind !== 'm9-real-app-offline-execution' || !['ready', 'blocked'].includes(report.status) || !Array.isArray(report.notVerified) || report.notVerified.length < 6) throw Error('Invalid M9 report header');
  if (report.status === 'blocked') return;
  if (report.failure !== null) throw Error('Ready report retains failure');
  for (const id of Object.keys(EXECUTION_SCENARIOS)) {
    const r = report.scenarios[id];
    if (r?.status !== 'ready' || !Object.keys(r.assertions).length || Object.values(r.assertions).some(v => v !== true) || r.preflight?.bothNamesShadowed !== true || !r.domCloseClicked || !r.cleanup?.coreStopped || !r.cleanup?.socketAbsent || r.cleanup?.electronExit?.code !== 0 || r.cleanup?.forcedElectron || !r.cleanup?.ownedTempRemoved) throw Error(`Incomplete native scenario ${id}`);
    if (r.baseline?.exitCode !== 1 || !r.before?.files?.length || !r.after?.files?.length || !r.artifactsFinal || !r.operations) throw Error(`Missing filesystem evidence ${id}`);
    if (Object.values(executionAssertions(id, { ...r, artifacts: r.artifactsFinal })).some(v => v !== true)) throw Error(`Final evidence invariants failed: ${id}`);
    for (const shot of r.screenshots) if (!fs.existsSync(shot.path) || hash(fs.readFileSync(shot.path)) !== shot.sha256) throw Error(`Screenshot bytes missing/changed: ${shot.path}`);
    for (const f of [...r.before.files, ...r.after.files]) if (!fs.existsSync(f.retained) || hash(fs.readFileSync(f.retained)) !== f.sha256) throw Error(`Fixture bytes missing/changed: ${f.retained}`);
  }
}
export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'linux') throw Error('This driver exercises Linux real app only; Windows acceptance not claimed');
  const out = claimOutput(parseArgs(argv));
  const report = { schemaVersion: 1, kind: 'm9-real-app-offline-execution', status: 'blocked', failure: null, cwd: ROOT,
    head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(), startedAt: new Date().toISOString(),
    host: { platform: os.platform(), release: os.release() },
    honestyLabels: ['Real dev-mode Electron main/preload + built renderer + Core; both sentinel-controlled offline stub processes.', 'CDP DOM/prototype setters and CDP mouse events, not OS input.', 'Actual native owned-window resizing; no CSS patch, fake IPC or viewport substitute.', 'Actual closed fixture repair and unchanged tests; no real vendor/model judgment or full-goal acceptance.'],
    notVerified: NOT_VERIFIED, scenarios: Object.fromEntries(Object.keys(EXECUTION_SCENARIOS).map(id => [id, { id, status: 'not-run', assertions: {} }])) };
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  let launched, app, activeRoot, activeResult, fixture;
  try {
    for (const [id, scenario] of Object.entries(EXECUTION_SCENARIOS)) {
      const caseRoot = path.join(out, id);
      fs.mkdirSync(caseRoot); activeRoot = caseRoot;
      const result = report.scenarios[id]; activeResult = result; result.status = 'blocked';
      // Launch/probe initially with empty queues. Only after launchApp owns its
      // short TMPDIR is the fixed fixture materialized below that same root.
      const stub = materializeStubBin(path.join(caseRoot, 'stub-bin'));
      const env = assembleEnv({ caseRoot, pipe: socketName(uniqueToken()), port: await freePort(), stub });
      result.preflightInitial = preflight(env, stub.stubDir);
      launched = await launchApp(env, caseRoot);
      result.launch = { command: launched.command, cwd: launched.cwd, env: launched.selectedEnv, pid: launched.child.pid };
      save();
      app = await attachApp(Number(env.GOALPORT_CDP_PORT), { electronPid: launched.child.pid });
      const previous = process.env.TMPDIR;
      try {
        process.env.TMPDIR = env.TMPDIR;
        fixture = createExecutionFixture(scenario.preset);
        // Keep existing append-only probe log and sentinel; fresh closed queues.
        materializeStubBin(stub.stubDir, { sentinel: stub.sentinel, behavior: scenario.behavior, executionFixture: fixture.config });
      } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
      result.fixtureRoot = fixture.root;
      result.preflight = preflight(env, stub.stubDir);
      result.before = snapshotFixture(fixture, caseRoot, 'before');
      result.baseline = baselineChecks(fixture, caseRoot);
      save();
      await withCaseDeadline(runExecutionScenario(id, app, caseRoot, fixture, result), `${id} native`, 180000);
      // Decisive source/test/op/log bytes already archived before temp cleanup.
      result.cleanup = await launched.cleanup(app);
      launched = null; app = null; fixture = null;
      result.artifactsFinal = collectArtifacts(caseRoot);
      result.status = result.cleanup.coreStopped && result.cleanup.socketAbsent && result.cleanup.electronExit?.code === 0 && !result.cleanup.forcedElectron && result.cleanup.ownedTempRemoved ? 'ready' : 'blocked';
      save();
    }
    report.status = Object.values(report.scenarios).every(r => r.status === 'ready') ? 'ready' : 'blocked';
  } catch (error) {
    report.failure = error.stack ?? String(error);
    if (app && activeRoot) {
      try { activeResult.failureDom = await app.evaluate('document.body.innerText'); } catch {}
      try { activeResult.failureScreenshot = await app.screenshot(activeRoot, 'blocked', 1020); } catch (e) { activeResult.captureFailure = e.message; }
    }
    if (fixture && activeRoot && !activeResult.after) {
      try { activeResult.after = snapshotFixture(fixture, activeRoot, 'failure-after'); } catch (e) { activeResult.snapshotFailure = e.message; }
    }
  } finally {
    if (launched) activeResult.cleanup = await launched.cleanup(app);
    if (activeRoot) { try { activeResult.artifactsFinal = collectArtifacts(activeRoot); } catch (e) { activeResult.artifactFailure = e.message; } }
    report.endedAt = new Date().toISOString();
    try { validateExecutionReport(report); } catch (e) { report.status = 'blocked'; report.validationFailure = e.message; }
    save();
    fs.writeFileSync(path.join(out, 'screenshot-manifest.json'), JSON.stringify(Object.values(report.scenarios).flatMap(r => [...(r.screenshots ?? []), ...(r.failureScreenshot ? [r.failureScreenshot] : [])]), null, 2));
    fs.writeFileSync(path.join(out, 'walkthrough.md'), Object.entries(report.scenarios).map(([id,r]) => `## ${id}: ${r.status}\n${(r.walkthrough ?? []).map(n => '- ' + n).join('\n')}`).join('\n\n'));
  }
  console.log(`M9_STATUS: ${report.status}; ${path.join(out, 'report.json')}`);
  if (report.failure) console.error(report.failure);
  return report.status === 'ready' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); } catch (e) { console.error(e.stack ?? e); process.exitCode = 2; }
}
