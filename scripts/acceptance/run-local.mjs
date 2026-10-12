import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimOutput, ROOT, SLUG, freePort, assembleEnv, socketName, uniqueToken, preflight, launchApp } from './lib/launch.mjs';
import { materializeStubBin } from './lib/stubbin.mjs';
import { attachApp } from './lib/cdp-app.mjs';
import { SCENARIOS, runA1, runA2, runA3, runA4, runA5Round, runA5Relaunch, validateReport, collectArtifacts } from './lib/scenarios.mjs';
import { TRACK_A_KIND, LEGACY_M2_KIND, validateTrackAReport, zeroQuotaProof, aggregateCleanup, NOT_VERIFIED } from './report.mjs';

export function parseArgs(argv) {
  if (argv.length < 2 || argv[0] !== '--out' || !argv[1]) {
    throw new Error('usage: node scripts/acceptance/run-local.mjs --out <fresh run evidence directory> [--scenario aN]...');
  }
  const scenarios = [];
  for (let i = 2; i < argv.length; i += 2) {
    if (argv[i] !== '--scenario' || !argv[i + 1]) throw new Error('usage: --scenario <aN> (repeatable, each fresh state)');
    if (!SCENARIOS[argv[i + 1]]) throw new Error(`unknown scenario: ${argv[i + 1]}`);
    if (scenarios.includes(argv[i + 1])) throw new Error(`duplicate scenario: ${argv[i + 1]}`);
    scenarios.push(argv[i + 1]);
  }
  return { out: argv[1], scenarios: scenarios.length > 0 ? scenarios : ['a1'] };
}

export async function withCaseDeadline(work, label, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} bounded ${timeoutMs}ms deadline expired`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function persistValidatedReport(report, persist, validate = report.kind === TRACK_A_KIND ? validateTrackAReport : validateReport) {
  try {
    validate(report);
  } catch (error) {
    report.status = 'blocked';
    report.validationFailure = error.message;
    persist();
    throw error;
  }
  persist();
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'linux') throw new Error('run-local currently requires Linux; Windows is not claimed');
  const { out: value, scenarios } = parseArgs(argv);
  const out = claimOutput(value);
  const trackA = !(scenarios.length === 1 && scenarios[0] === 'a1');
  const report = {
    schemaVersion: 1,
    kind: trackA ? TRACK_A_KIND : LEGACY_M2_KIND,
    runSlug: SLUG,
    head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
    startedAt: new Date().toISOString(), cwd: ROOT,
    host: {
      platform: os.platform(), release: os.release(),
      distribution: fs.readFileSync('/etc/os-release', 'utf8').split('\n').find(line => line.startsWith('PRETTY_NAME=')) ?? 'unknown',
    },
    honestyLabels: ['Dev-mode real Electron/Core with built dist; not Windows packaged acceptance.', 'CDP DOM/prototype setters and CDP mouse events, not native OS input.', 'Offline sentinel stubs only; zero real CLI/model behavior verified.', 'Window sizes are the actual owned window bounds (native X11 resize after the Browser-domain refusal), recorded per shot; no silent viewport substitution.'],
    status: 'blocked', failure: null,
  };
  if (trackA) {
    report.scenarios = Object.fromEntries(scenarios.map(id => [id, { id, status: 'not-run', assertions: {} }]));
    report.zeroQuota = null;
    report.notVerified = NOT_VERIFIED;
  } else {
    report.a1 = { assertions: {} };
  }
  report.cleanup = {};
  let launched = null;
  let app = null;
  let caseRoot = null;
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  try {
    for (const id of scenarios) {
      const result = trackA ? report.scenarios[id] : report.a1;
      if (trackA) result.status = 'blocked';
      caseRoot = path.join(out, id);
      if (!trackA) report.caseRoot = caseRoot;
      fs.mkdirSync(caseRoot);
      const scenario = SCENARIOS[id];
      const stub = materializeStubBin(path.join(caseRoot, 'stub-bin'), { behavior: scenario.behavior });
      const env = assembleEnv({ caseRoot, pipe: socketName(uniqueToken()), port: await freePort(), stub });
      // Child resolution preflight before EVERY scenario; never execute host binaries.
      result.preflight = preflight(env, stub.stubDir);
      launched = await launchApp(env, caseRoot);
      result.launch = { command: launched.command, cwd: launched.cwd, selectedEnv: launched.selectedEnv, pid: launched.child.pid };
      save();
      app = await attachApp(Number(env.GOALPORT_CDP_PORT), { electronPid: launched.child.pid });
      const run = { a1: runA1, a2: runA2, a3: runA3, a4: runA4 }[id];
      if (run) {
          await withCaseDeadline(run(app, caseRoot, result), id, scenario.timeoutMs ?? 120000);
      } else if (id === 'a5') {
          await withCaseDeadline(runA5Round(app, caseRoot, result), `${id} round`, scenario.timeoutMs);
          // Official product close between rounds; exact owned Core/socket cleanup.
          result.cleanupRound = await launched.cleanup(app);
          launched = null; app = null;
          // Same shared state (userData/health/ledger derive from the DB
          // path), but launch logs and the short owned temp live in their own
          // fresh subdirectory so the relaunch never collides with round one.
          const relaunchRoot = path.join(caseRoot, 'relaunch');
          fs.mkdirSync(relaunchRoot);
          const relaunched = await launchApp(assembleEnv({ caseRoot, pipe: socketName(uniqueToken()), port: await freePort(), stub }), relaunchRoot);
          result.relaunch = { command: relaunched.command, cwd: relaunched.cwd, selectedEnv: relaunched.selectedEnv, pid: relaunched.child.pid };
          save();
          launched = relaunched;
          app = await attachApp(Number(launched.selectedEnv.GOALPORT_CDP_PORT), { electronPid: relaunched.child.pid });
          await withCaseDeadline(runA5Relaunch(app, caseRoot, result), `${id} relaunch`, 120000);
      } else throw new Error(`no runner for scenario ${id}`);
      if (trackA) result.status = 'ready'; else report.status = 'ready';
      result.cleanup = await launched.cleanup(app);
      launched = null; app = null;
      // Discovery can append probe lines after Use again. Sample the final
      // files only after the window and its probe processes have stopped.
      if (trackA) result.artifactsFinal = collectArtifacts(caseRoot);
      if (!result.cleanup.coreStopped || !result.cleanup.socketAbsent || result.cleanup.electronExit?.code !== 0 || result.cleanup.forcedElectron) {
        if (trackA) result.status = 'blocked'; else report.status = 'blocked';
      }
      save();
    }
    if (trackA) {
      report.zeroQuota = zeroQuotaProof(report.scenarios);
      report.cleanup = aggregateCleanup(report.scenarios);
      report.status = scenarios.every(id => report.scenarios[id].status === 'ready') && report.zeroQuota.stubOnly
        && report.cleanup.coreStopped && report.cleanup.socketAbsent && report.cleanup.electronExitCodeZero && report.cleanup.noForcedElectron
        ? 'ready' : 'blocked';
    }
  } catch (error) {
    report.failure = error.stack || String(error);
    if (app && caseRoot) {
      try { report.failureScreenshot = await app.screenshot(caseRoot, 'blocked', 1020); } catch (captureError) { report.captureFailure = captureError.message; }
      try { report.failureDom = await app.evaluate('document.body.innerText'); } catch {}
    }
  } finally {
    if (launched) {
      const cleanup = await launched.cleanup(app);
      if (trackA && report.scenarios) {
        const failingId = scenarios.find(id => report.scenarios[id].cleanup === undefined);
        if (failingId) report.scenarios[failingId].cleanup = cleanup;
      } else if (report.a1 && !report.a1.cleanup) report.a1.cleanup = cleanup;
    }
    if (trackA) {
      if (!report.zeroQuota) report.zeroQuota = zeroQuotaProof(report.scenarios);
      const aggregate = aggregateCleanup(report.scenarios);
      for (const key of ['coreStopped', 'socketAbsent', 'electronExitCodeZero', 'noForcedElectron']) {
        if (report.cleanup?.[key] !== true) report.cleanup[key] = aggregate[key];
      }
      if (!report.cleanup.scenarios) report.cleanup.scenarios = aggregate.scenarios;
      if (report.status === 'ready' && report.failure !== null) report.status = 'blocked';
    } else {
      report.cleanup = report.a1?.cleanup ?? {};
      const cleanup = report.cleanup;
      if (!cleanup.coreStopped || !cleanup.socketAbsent || cleanup.electronExit?.code !== 0 || cleanup.forcedElectron) report.status = 'blocked';
    }
    report.endedAt = new Date().toISOString();
    persistValidatedReport(report, save);
    const shots = trackA
      ? Object.values(report.scenarios).flatMap(result => result.screenshots ?? [])
      : report.a1.screenshots ?? [];
    fs.writeFileSync(path.join(out, 'screenshot-manifest.json'), `${JSON.stringify(shots, null, 2)}\n`);
    const notes = trackA
      ? Object.entries(report.scenarios).map(([id, result]) => `## ${id} (${result.status})\n\n${(result.walkthrough ?? []).map(note => `- ${note}`).join('\n')}`).join('\n\n')
      : `## a1\n\n${(report.a1.walkthrough ?? []).map(note => `- ${note}`).join('\n')}`;
    fs.writeFileSync(path.join(out, 'walkthrough.md'), `# ${trackA ? 'M3 Track A' : 'M2 a1'} real-window walkthrough\n\n${notes}\n\n${report.honestyLabels.join('\n')}\n`);
  }
  console.log(`${trackA ? 'M3_STATUS' : 'M2_STATUS'}: ${report.status}; report ${path.join(out, 'report.json')}`);
  return report.status === 'ready' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
