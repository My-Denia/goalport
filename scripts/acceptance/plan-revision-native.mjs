import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, claimOutput, assembleEnv, socketName, uniqueToken, freePort, preflight, launchApp, sleep } from './lib/launch.mjs';
import { materializeStubBin } from './lib/stubbin.mjs';
import { attachApp } from './lib/cdp-app.mjs';
import { createExecutionFixture } from './lib/execution-fixture.mjs';
import { collectArtifacts } from './lib/scenarios.mjs';
import { shots as backgroundShots } from './lib/background-scenarios.mjs';
import {
  PLAN_REVISION_SCENARIOS,
  planRevisionAssertions,
  snapshotFixture,
  baselineChecks,
  runPlanRevisionScenario,
  runPlanRevisionReopen,
  runPlanRevisionBackground,
  closeThroughMenu,
  observeOwnedRenderers,
  retainJobFacts,
  hash,
} from './lib/plan-revision-scenarios.mjs';
import { withCaseDeadline } from './run-local.mjs';

export const NOT_VERIFIED = Object.freeze([
  'Native Windows packaged EXE, OS keyboard/mouse, IME and close behavior were not run.',
  'Real vendor CLI/model/help/auth/probes, model judgment, live model flags and physical sandbox confinement were not run.',
  'The plan critique, the revised review approval and the final auditor are fixed offline fixture behaviors and separate read-only Node processes over a closed fixture, not independent-model judgment.',
  'The one revision runs only inside its original Send: read-only automatic revision, general convergence loops, resource-restoration resume, crash restart and history-driven execution remain unimplemented.',
  'A second plan-review revise, an unknown dispatch and cancellation stay terminal; the unchanged one later repair keeps its own ceiling.',
  'Known desktop baseline failures and platform skips remain; full goal acceptance is not claimed.',
]);

export function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1]) throw Error('usage: node scripts/acceptance/plan-revision-native.mjs --out <fresh run evidence directory>');
  return argv[1];
}

export function validatePlanRevisionReport(report, { final = false } = {}) {
  if (report.schemaVersion !== 1 || report.kind !== 'c4-real-app-offline-plan-revision' || !['ready', 'blocked'].includes(report.status) || !Array.isArray(report.notVerified) || report.notVerified.length < 5) throw Error('Invalid C4 report header');
  if (report.status === 'blocked') return;
  if (report.failure !== null) throw Error('Ready report retains failure');
  for (const id of Object.keys(PLAN_REVISION_SCENARIOS)) {
    const r = report.scenarios[id];
    if (r?.status !== 'ready' || !Object.keys(r.assertions).length || Object.values(r.assertions).some(v => v !== true) || r.preflight?.bothNamesShadowed !== true || !r.domCloseClicked || !r.cleanup?.coreStopped || !r.cleanup?.socketAbsent || r.cleanup?.electronExit?.code !== 0 || r.cleanup?.forcedElectron || !r.cleanup?.ownedTempRemoved) throw Error(`Incomplete native scenario ${id}`);
    if (id === 'pr1' && (!r.cleanupRound?.coreStopped || !r.cleanupRound?.socketAbsent || r.cleanupRound?.electronExit?.code !== 0 || r.cleanupRound?.forcedElectron || !r.cleanupRound?.ownedTempRemoved || !r.domCloseClicked)) throw Error('Incomplete pr1 relaunch');
    if (r.baseline?.exitCode !== 1 || !r.before?.files?.length || !r.after?.files?.length || !r.artifactsFinal || !r.operations) throw Error(`Missing filesystem evidence ${id}`);
    if (Object.values(planRevisionAssertions(id, { ...r, artifacts: r.artifactsFinal }, { final })).some(v => v !== true)) throw Error(`Final evidence invariants failed: ${id}`);
    for (const shot of r.screenshots) if (!fs.existsSync(shot.path) || hash(fs.readFileSync(shot.path)) !== shot.sha256) throw Error(`Screenshot bytes missing/changed: ${shot.path}`);
    for (const f of [...r.before.files, ...r.after.files]) if (!fs.existsSync(f.retained) || hash(fs.readFileSync(f.retained)) !== f.sha256) throw Error(`Fixture bytes missing/changed: ${f.retained}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'linux') throw Error('This driver exercises Linux real app only; Windows acceptance not claimed');
  const out = claimOutput(parseArgs(argv));
  const report = { schemaVersion: 1, kind: 'c4-real-app-offline-plan-revision', status: 'blocked', failure: null, cwd: ROOT,
    head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(), startedAt: new Date().toISOString(),
    host: { platform: os.platform(), release: os.release() },
    honestyLabels: ['Real dev-mode Electron main/preload + built renderer + Core; sentinel-controlled offline stub processes.', 'CDP DOM/prototype setters and CDP mouse events, not OS input.', 'Actual native owned-window resizing; no CSS patch, fake IPC or viewport substitute.', 'Actual one pre-write plan revision inside one Send (window and explicitly admitted background job); no real vendor/model judgment, no second revision, no full-GAH claim.'],
    notVerified: NOT_VERIFIED, scenarios: Object.fromEntries(Object.keys(PLAN_REVISION_SCENARIOS).map(id => [id, { id, status: 'not-run', assertions: {} }])) };
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  let launched, app, activeRoot, activeResult, fixture;
  const seedFixture = (env, stub, scenario) => {
    const previous = process.env.TMPDIR;
    try {
      process.env.TMPDIR = env.TMPDIR;
      const created = createExecutionFixture(scenario.preset);
      materializeStubBin(stub.stubDir, { sentinel: stub.sentinel, behavior: scenario.behavior, executionFixture: created.config });
      return created;
    } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  };
  try {
    for (const [id, scenario] of Object.entries(PLAN_REVISION_SCENARIOS)) {
      const caseRoot = path.join(out, id);
      fs.mkdirSync(caseRoot); activeRoot = caseRoot;
      const result = report.scenarios[id]; activeResult = result; result.status = 'blocked';
      const stub = materializeStubBin(path.join(caseRoot, 'stub-bin'));
      const env = assembleEnv({ caseRoot, pipe: socketName(uniqueToken()), port: await freePort(), stub });
      result.preflightInitial = preflight(env, stub.stubDir);
      launched = await launchApp(env, caseRoot);
      result.launch = { command: launched.command, cwd: launched.cwd, env: launched.selectedEnv, pid: launched.child.pid };
      save();
      app = await attachApp(Number(env.GOALPORT_CDP_PORT), { electronPid: launched.child.pid });
      fixture = seedFixture(env, stub, scenario);
      result.fixtureRoot = fixture.root;
      result.preflight = preflight(env, stub.stubDir);
      result.before = snapshotFixture(fixture, caseRoot, 'before');
      result.baseline = baselineChecks(fixture, caseRoot);
      save();
      if (id === 'pr4') {
        const check = await withCaseDeadline(runPlanRevisionBackground(app, caseRoot, fixture, scenario, result), 'pr4 admission', 180000);
        save();
        // Actual first-user CLOSE while the initial critique is still in
        // flight: the revised planner has not launched yet.
        const finishRendererObservation = observeOwnedRenderers(launched.child.pid);
        await withCaseDeadline(closeThroughMenu(app), 'pr4 close', 60000);
        result.close = await launched.closeUi(app);
        result.rendererExit = finishRendererObservation();
        app = null;
        const previousLaunch = launched;
        const reopenRoot = path.join(caseRoot, 'reopen'); fs.mkdirSync(reopenRoot);
        launched = await previousLaunch.reopenUi(reopenRoot);
        result.reopen = { pid: launched.child.pid, command: launched.command, cdpPort: launched.selectedEnv.GOALPORT_CDP_PORT, sameOwnedCore: result.close.corePids };
        app = await attachApp(Number(launched.selectedEnv.GOALPORT_CDP_PORT), { electronPid: launched.child.pid });
        await app.until("!!document.querySelector('[aria-label=\"Background goal\"]')", 30000);
        result.returned = await app.evaluate('window.goalportCore.backgroundStatus()', true);
        result.returnedMainScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
        await withCaseDeadline(backgroundShots(app, caseRoot, result, 'live-return'), 'pr4 return shots', 120000);
        result.walkthrough.push('Close: actual menu Close and unforced exit 0, while the initial critique turn was still in flight — before the revised planner launched. Reopen: same owned Core/temp and same job; no resend and no main authorization.');
        await app.until("window.goalportCore.backgroundStatus().then(j => j?.state === 'completed')", 180000);
        await app.until("document.body.innerText.includes('Changes verified') && document.body.innerText.includes('Before plan revision')", 20000);
        await withCaseDeadline(backgroundShots(app, caseRoot, result, 'verified'), 'pr4 verified shots', 120000);
        result.walkthrough.push('Verified return: the same worker ran the revised plan, its fresh check, the one real repair and the separate read-only auditor after the desktop exited, all inside the original five-read/one-write admission.');
        await sleep(1500);
        result.settledInvocations = collectArtifacts(caseRoot).invocations;
        result.finalJob = await app.evaluate('window.goalportCore.backgroundStatus()', true);
        result.finalScope = { remaining: result.finalJob.counters.readTurnsLeft, maxTurns: result.finalJob.readMaxTurns, write: { remaining: result.finalJob.counters.writeTurnsLeft, maxTurns: result.finalJob.writeMaxTurns, workspaceRoot: result.fixtureRoot } };
        // The revised planner and the writer really launched after the exit.
        const exitAt = Math.max(Date.parse(result.close.electronExit.observedAt), Date.parse(result.rendererExit.endedAt));
        result.afterExitTurns = collectArtifacts(caseRoot).invocations.filter(i => i.invocationType === 'turn' && Date.parse(i.ts) > exitAt).map(i => i.behaviorId);
        check('revisedPlannerAfterDesktopExit', result.afterExitTurns.includes('codex-fixture-revised-plan-delayed'));
        check('writerAfterDesktopExit', result.afterExitTurns.includes('codex-fixture-writer'));
        check('sameLiveOwnerOnReturn', result.beforeClose.jobId === result.returned.jobId && result.beforeClose.workerPid === result.returned.workerPid && result.returnedMainScope === null);
        check('completedReleased', result.finalJob.state === 'completed' && !result.finalJob.active);
        result.after = snapshotFixture(fixture, caseRoot, 'after');
        result.artifacts = collectArtifacts(caseRoot);
        result.operations = readOps(caseRoot);
        retainJobFacts(caseRoot, result);
        result.admissions = result.admissions ?? [];
        for (const [name, value] of Object.entries(planRevisionAssertions(id, result))) check(name, value);
        await withCaseDeadline(closeThroughMenu(app), 'pr4 final close', 60000);
        result.domCloseClicked = true;
        result.cleanup = await launched.cleanup(app);
        launched = null; app = null; fixture = null;
        result.artifactsFinal = collectArtifacts(caseRoot);
        result.status = result.cleanup.coreStopped && result.cleanup.socketAbsent && result.cleanup.electronExit?.code === 0 && !result.cleanup.forcedElectron && result.cleanup.ownedTempRemoved ? 'ready' : 'blocked';
        save();
        continue;
      }
      await withCaseDeadline(runPlanRevisionScenario(id, app, caseRoot, fixture, result), `${id} native`, 300000);
      if (id === 'pr1') {
        result.cleanup = await launched.cleanup(app);
        launched = null; app = null;
        // Relaunch stub keeps the sentinel and exhausted queues: any attempted
        // extra turn would be loudly queue-exhausted instead of silent.
        materializeStubBin(stub.stubDir, { sentinel: stub.sentinel, behavior: { probes: scenario.behavior.probes, turns: { codex: [], claude: [] } } });
        const relaunchRoot = path.join(caseRoot, 'relaunch');
        fs.mkdirSync(relaunchRoot);
        const relaunchEnv = assembleEnv({ caseRoot, pipe: socketName(uniqueToken()), port: await freePort(), stub });
        launched = await launchApp(relaunchEnv, relaunchRoot);
        result.relaunch = { command: launched.command, cwd: launched.cwd, env: launched.selectedEnv, pid: launched.child.pid,
          note: 'same case dirs (records/ledger/stub queues), fresh process/socket/temp' };
        app = await attachApp(Number(relaunchEnv.GOALPORT_CDP_PORT), { electronPid: launched.child.pid });
        await withCaseDeadline(runPlanRevisionReopen(app, caseRoot, result), 'pr1 relaunch', 180000);
        result.cleanupRound = await launched.cleanup(app);
        launched = null; app = null; fixture = null;
        const cleanRound = result.cleanupRound.coreStopped && result.cleanupRound.socketAbsent && result.cleanupRound.electronExit?.code === 0 && !result.cleanupRound.forcedElectron && result.cleanupRound.ownedTempRemoved && result.domCloseClicked;
        result.artifactsFinal = collectArtifacts(caseRoot);
        result.status = result.cleanup.coreStopped && result.cleanup.socketAbsent && result.cleanup.electronExit?.code === 0 && !result.cleanup.forcedElectron && result.cleanup.ownedTempRemoved && cleanRound ? 'ready' : 'blocked';
        save();
        continue;
      }
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
    try { validatePlanRevisionReport(report, { final: true }); } catch (e) { report.status = 'blocked'; report.validationFailure = e.message; }
    save();
    fs.writeFileSync(path.join(out, 'screenshot-manifest.json'), JSON.stringify(Object.values(report.scenarios).flatMap(r => [...(r.screenshots ?? []), ...(r.failureScreenshot ? [r.failureScreenshot] : [])]), null, 2));
    fs.writeFileSync(path.join(out, 'walkthrough.md'), Object.entries(report.scenarios).map(([id, r]) => `## ${id}: ${r.status}\n${(r.walkthrough ?? []).map(n => '- ' + n).join('\n')}`).join('\n\n'));
  }
  console.log(`C4_STATUS: ${report.status}; ${path.join(out, 'report.json')}`);
  if (report.failure) console.error(report.failure);
  return report.status === 'ready' ? 0 : 1;
}

function readOps(caseRoot) {
  const file = path.join(caseRoot, 'stub-bin/execution-operations.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); } catch (e) { console.error(e.stack ?? e); process.exitCode = 2; }
}
