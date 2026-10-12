import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, claimOutput, assembleEnv, socketName, uniqueToken, freePort, preflight, launchApp, sleep } from './lib/launch.mjs';
import { materializeStubBin } from './lib/stubbin.mjs';
import { attachApp } from './lib/cdp-app.mjs';
import { createExecutionFixture } from './lib/execution-fixture.mjs';
import { snapshotFixture, baselineChecks } from './lib/feedback-scenarios.mjs';
import { collectArtifacts } from './lib/scenarios.mjs';
import { BACKGROUND_SCENARIOS, prepareBackground, shots, closeThroughMenu, backgroundAssertions, retainJobFacts, observeOwnedRenderers, validateBackgroundReport } from './lib/background-scenarios.mjs';
export function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1]) throw Error('usage: background-native.mjs --out <fresh evidence directory>');
  return argv[1];
}
export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'linux') throw Error('Linux offline only; Windows not accepted');
  const out = claimOutput(parseArgs(argv));
  const report = { kind: 'c2-real-app-offline-background', status: 'blocked', head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(), startedAt: new Date().toISOString(),
    honestyLabels: ['Actual Electron/Core and sentinel-shadowed offline CLIs; CDP DOM input, not native OS input.', 'One app-independent job, at most one C1 repair; full GAH is not complete.'],
    notVerified: ['Real vendor CLI/model and independent-model judgment.', 'Windows packaged/job-object survival.', 'Worker/system crash restart or execution resume; interruption retains an unconfirmed non-retryable admission.', 'Packaged default rollout and full GAH.'], scenarios: {} };
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  let launched, app, active;
  try {
    for (const [id, scenario] of Object.entries(BACKGROUND_SCENARIOS)) {
      const root = path.join(out, id); fs.mkdirSync(root);
      const r = report.scenarios[id] = { status: 'blocked', screenshots: [], walkthrough: [], assertions: {} }; active = r;
      const stub = materializeStubBin(path.join(root, 'stub-bin'));
      const env = assembleEnv({ caseRoot: root, pipe: socketName(uniqueToken()), port: await freePort(), stub });
      preflight(env, stub.stubDir);
      launched = await launchApp(env, root);
      r.launch = { command: launched.command, env: launched.selectedEnv, pid: launched.child.pid };
      app = await attachApp(Number(env.GOALPORT_CDP_PORT), { electronPid: launched.child.pid });
      const prior = process.env.TMPDIR; let fixture;
      try { process.env.TMPDIR = env.TMPDIR; fixture = createExecutionFixture(scenario.preset); materializeStubBin(stub.stubDir, { sentinel: stub.sentinel, behavior: scenario.behavior, executionFixture: fixture.config }); }
      finally { if (prior === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prior; }
      r.preflight = preflight(env, stub.stubDir); r.fixtureRoot = fixture.root;
      r.before = snapshotFixture(fixture, root, 'before'); r.baseline = baselineChecks(fixture, root);
      await prepareBackground(app, fixture, root, r); save();
      const finishRendererObservation = observeOwnedRenderers(launched.child.pid);
      if (id === 'BG3') {
        const pid = r.beforeClose.workerPid;
        const argvBytes = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!argvBytes.includes(path.join(ROOT, 'electron/coordination-worker.cjs')) || !argvBytes.includes(r.beforeClose.jobId)) throw Error('acceptance-owned worker identity mismatch');
        r.interrupt = { pid, commandId: r.beforeClose.pendingCommand.commandId, at: new Date().toISOString(), signal: 'SIGTERM' };
        process.kill(pid, 'SIGTERM'); // only the exact owned worker, not Core/UI/tools
      }
      await closeThroughMenu(app);
      r.close = await launched.closeUi(app); r.rendererExit = finishRendererObservation(); app = null;
      const previousLaunch = launched;
      const reopenRoot = path.join(root, 'reopen'); fs.mkdirSync(reopenRoot);
      launched = await previousLaunch.reopenUi(reopenRoot);
      r.reopen = { pid: launched.child.pid, command: launched.command, cdpPort: launched.selectedEnv.GOALPORT_CDP_PORT, sameOwnedCore: r.close.corePids };
      app = await attachApp(Number(launched.selectedEnv.GOALPORT_CDP_PORT), { electronPid: launched.child.pid });
      await app.until("!!document.querySelector('[aria-label=\"Background goal\"]')", 30000);
      r.returned = await app.evaluate('window.goalportCore.backgroundStatus()', true);
      r.returnedMainScope = await app.evaluate('window.goalportCore.coordinationScope()', true);
      await shots(app, root, r, id === 'BG3' ? 'interrupted' : 'live-return');
      r.walkthrough.push(`Close: actual menu Close and unforced exit 0, before any writer. Reopen: same owned Core/temp and same job ${r.returned.jobId}, worker ${r.returned.workerPid}; no resend and no main authorization.`);
      if (id === 'BG1') {
        await app.until("window.goalportCore.backgroundStatus().then(j => j?.state === 'completed')", 120000);
        await app.until("document.body.innerText.includes('Changes verified') && document.body.innerText.includes('Before automatic repair')", 20000);
        await shots(app, root, r, 'verified');
        r.walkthrough.push('Verified return: the incomplete edit genuinely failed unchanged checks, one repair used the original remaining access, and the final check passed; the first pass remains readable.');
      } else if (id === 'BG2') {
        await app.until("window.goalportCore.backgroundStatus().then(j => j?.pendingCommand && j.completedCommands.length >= 2)", 20000);
        await app.click('[aria-label="Background goal"] button');
        r.revoked = await app.evaluate('window.goalportCore.backgroundStatus()', true);
        r.expectedSettledTurns = r.revoked.completedCommands.length + (r.revoked.pendingCommand ? 1 : 0);
        await app.until("window.goalportCore.backgroundStatus().then(j => j?.state === 'stopped')", 60000);
        await app.until("document.body.innerText.includes('Observed remaining access')", 10000);
        await shots(app, root, r, 'revoked');
        r.walkthrough.push('Stop allowing after return: the current admitted turn settles and its report is kept. No later writer starts, no budget is replaced; edits are not undone and tools are not declared quiescent.');
      } else {
        await app.until("document.body.innerText.includes('outcome is unconfirmed')", 10000);
        r.walkthrough.push('Interrupted owner: only the acceptance-owned worker was terminated during its admitted review. The pending command/startup claim stay retained and the reopened app neither replaces the worker nor replays the command.');
      }
      // Let a dead worker's already-spawned offline turn settle too. Product
      // uncertainty remains; observing teardown is not a tool-stop promise.
      await sleep(id === 'BG3' ? 8000 : 1500);
      r.settledTurnCount = collectArtifacts(root).invocations.filter(i => i.invocationType === 'turn').length;
      r.finalJob = await app.evaluate('window.goalportCore.backgroundStatus()', true);
      r.after = snapshotFixture(fixture, root, 'after');
      r.artifactsFinal = collectArtifacts(root);
      r.operations = fs.existsSync(path.join(root, 'stub-bin/execution-operations.jsonl')) ? fs.readFileSync(path.join(root, 'stub-bin/execution-operations.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      retainJobFacts(root, r);
      r.assertions = backgroundAssertions(id, r);
      if (Object.values(r.assertions).some(v => v !== true)) throw Error(`${id} failed: ${JSON.stringify(r.assertions)}`);
      await closeThroughMenu(app);
      r.cleanup = await launched.cleanup(app); launched = null; app = null;
      r.status = 'ready'; save();
    }
    report.status = 'ready'; validateBackgroundReport(report);
  } catch (error) {
    report.failure = error.stack ?? String(error);
    if (app) { try { active.failureDom = await app.evaluate('document.body.innerText'); } catch {} }
  } finally {
    if (launched) active.cleanup = await launched.cleanup(app);
    report.endedAt = new Date().toISOString(); save();
    fs.writeFileSync(path.join(out, 'walkthrough.md'), Object.entries(report.scenarios).map(([id, r]) => `## ${id}: ${r.status}\n${r.walkthrough.map(s => '- ' + s).join('\n')}`).join('\n\n'));
  }
  console.log(`C2_STATUS: ${report.status}; ${out}`);
  if (report.failure) console.error(report.failure);
  return report.status === 'ready' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
