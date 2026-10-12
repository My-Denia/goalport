import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main as packageMain, sourceIdentity } from '../desktop/package.mjs';
import { verifyPackage } from '../desktop/verify-package.mjs';
import { ROOT, SLUG, SYNTHETIC, claimOutput, socketName, uniqueToken, freePort } from './lib/launch.mjs';
import { materializeStubBin } from './lib/stubbin.mjs';
import { buildWindowsEnv, preflightWindows, launchWindowsApp } from './lib/windows-host.mjs';
import { attachApp } from './lib/cdp-app.mjs';
import { SCENARIOS, runA1, runA2, runA3, runA4, runA5Round, runA5Relaunch, collectArtifacts } from './lib/scenarios.mjs';
import { aggregateCleanup, zeroQuotaProof, validateTrackAReport } from './report.mjs';
import { withCaseDeadline, persistValidatedReport } from './run-local.mjs';
import { WINDOWS_WINDOW_METHOD, validateNativeWindowResponse } from './lib/windows-window.mjs';

export const WINDOWS_KIND = 'goalport-m4-windows-packaged';
export const WINDOWS_NOT_VERIFIED = Object.freeze([
  'Native OS mouse/keyboard input: interactions use CDP DOM/prototype setters and CDP mouse events; Win32 is used only for owned window bounds.',
  'Real CLI behavior: real codex/claude binaries were never executed, not even for probes or --help; offline sentinel stubs leave wire format, flags, models, quota and login unverified.',
  'Actual takeover/replacement launch: with two providers the chain-completeness pre-check stops before replacement; takeover remains synthetic coverage.',
  'Real model judgment: replies are offline protocol fixtures, not model output.',
  'Owner human screenshot review: automated geometry and hashes do not substitute for inspecting every PNG.',
]);
const RUNNERS = Object.freeze({ a1: runA1, a2: runA2, a3: runA3, a4: runA4 });
const clean = c => c?.coreStopped === true && c.socketAbsent === true && c.electronExit?.code === 0 && !c.electronExit?.signal && c.forcedElectron === false && !c.blockedCleanup && c.ownedTempRemoved === true;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function assertWindowsHost(platform = process.platform, arch = process.arch) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('Windows x64 required; Windows runtime not-run on WSL/Linux, no interop or fallback');
}
export function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!(major === 22 && minor >= 19) && !(major >= 24)) throw new Error('existing Node >=22.19 (22.x) or >=24 required; no install');
}
export function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--out', '--package', '--pwsh'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--') || result[flag]) throw new Error('usage: node scripts/acceptance/windows-run.mjs [--out <fresh evidence directory>] [--package <verified portable directory>] [--pwsh <existing PowerShell7 executable>]');
    result[flag] = argv[i + 1];
  }
  return result;
}
function drivePath(p, value, label) {
  if (typeof value !== 'string' || !/^[a-z]:\\/i.test(value) || p.normalize(value) !== value || /[\r\n"%]/.test(value)) throw new Error(`${label} must be a normalized absolute Windows drive path without cmd expansion`);
  return value;
}
function inside(p, child, parent) {
  const r = p.relative(parent, child);
  return r !== '' && !p.isAbsolute(r) && !r.split(/[\\/]/).includes('..');
}
/** Pure path plan: package output is never a historical evidence destination. */
export function planWindowsRun(args, { root = ROOT, token = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`, pathApi = path.win32 } = {}) {
  const p = pathApi;
  drivePath(p, root, 'checkout');
  if (!/^[a-z0-9-]+$/.test(token)) throw new Error('unsafe fresh token');
  const evidence = p.join(root, 'goal-runs', SLUG, 'evidence');
  const out = args['--out'] ? p.resolve(root, args['--out']) : p.join(evidence, `windows-${token}`);
  drivePath(p, out, 'evidence');
  if (!inside(p, out, evidence)) throw new Error('output must be inside this-run evidence, not a preserve slug');
  const buildOut = p.join(root, 'artifacts', 'electron-rc', `${SLUG}-win-${token}`);
  if (/(^|[\\/])(goal-runs|\.goal-runs)([\\/]|$)/i.test(buildOut)) throw new Error('package build output must be outside goal-runs');
  const packageRoot = args['--package'] ? drivePath(p, args['--package'], 'package') : p.join(buildOut, 'GoalPort-win32-x64');
  return { out, buildOut, packageRoot, packageMode: args['--package'] ? 'existing-verified' : 'fresh-build' };
}
function envValue(env, key) {
  const matches = Object.entries(env).filter(([name]) => name.toLowerCase() === key.toLowerCase());
  if (matches.length > 1) throw new Error(`ambiguous Windows environment ${key}`);
  return matches[0]?.[1];
}
/** Resolve existing files only. Never probes a provider or installs a tool. */
export function resolveWindowsTool(name, { explicit, env = process.env, filesystem = fs, pathApi = path.win32 } = {}) {
  const candidates = explicit ? [drivePath(pathApi, explicit, name)] : String(envValue(env, 'PATH') || '').split(';').filter(Boolean).map(dir => pathApi.join(dir.replace(/^"|"$/g, ''), `${name}.exe`));
  for (const value of candidates) {
    if (!pathApi.isAbsolute(value)) continue;
    try {
      if (filesystem.statSync(value).isFile()) return drivePath(pathApi, value, name);
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error(`existing ${name}.exe unavailable; blocked, no install or policy bypass`);
}
function refuseLinks(value) {
  for (let dir = value; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('symlink/reparse ancestor refused');
  }
}
export async function preparePackage(plan, { build = packageMain, verify = verifyPackage } = {}) {
  if (plan.packageMode === 'fresh-build') await build(['--out', plan.buildOut]); // main returns void, not an invented package object.
  const verified = verify(plan.packageRoot); // Explicit even though packaging verifies internally.
  if (verified?.status !== 'PASS') throw new Error('explicit package verification failed');
  return { mode: plan.packageMode, root: plan.packageRoot, buildOut: plan.packageMode === 'fresh-build' ? plan.buildOut : null, verified };
}
function observeFixture() {
  refuseLinks(SYNTHETIC);
  if (!fs.existsSync(SYNTHETIC)) return { path: SYNTHETIC, exists: false, files: [] };
  if (!fs.statSync(SYNTHETIC).isDirectory()) throw new Error('synthetic workspace must be a directory');
  const files = fs.readdirSync(SYNTHETIC).map(name => {
    const filename = path.join(SYNTHETIC, name);
    if (!fs.lstatSync(filename).isFile()) throw new Error('synthetic workspace contains non-file/link state');
    const bytes = fs.readFileSync(filename);
    return { path: filename, bytes: bytes.length, sha256: sha(bytes) };
  });
  return { path: SYNTHETIC, exists: true, files };
}
export function validateWindowsReport(report) {
  if (!report || report.schemaVersion !== 1 || report.kind !== WINDOWS_KIND || report.runSlug !== SLUG || report.cwd !== process.cwd() || !/^[a-f0-9]{40}$/.test(report.head || '')) throw new Error('invalid Windows report identity/CWD/schema');
  if (report.host?.platform !== 'win32' || report.host.arch !== 'x64' || typeof report.host.distribution !== 'string' || typeof report.host.release !== 'string') throw new Error('Windows host facts missing');
  if (!['ready', 'blocked'].includes(report.status) || !['not-run', 'running', 'blocked', 'ready'].includes(report.windowsExecutionStatus)) throw new Error('invalid Windows execution status');
  if (JSON.stringify(Object.keys(report.scenarios ?? {})) !== JSON.stringify(Object.keys(SCENARIOS))) throw new Error('same complete a1-a5 matrix required');
  if (JSON.stringify(report.notVerified) !== JSON.stringify(WINDOWS_NOT_VERIFIED) || report.honestyLabels?.some(s => /Linux dev|local Linux|Windows not-run/.test(s))) throw new Error('Windows runtime honesty ledger incorrect');
  for (const result of Object.values(report.scenarios)) if (!['ready', 'blocked', 'not-run'].includes(result.status)) throw new Error('invalid scenario status');
  if (report.status === 'ready') {
    if (report.windowsExecutionStatus !== 'ready' || !report.package?.verified || report.package.verified.status !== 'PASS' || !/^[a-f0-9]{40}$/.test(report.package.verified.sourceRevision || '') || !/^[a-f0-9]{64}$/.test(report.package.verified.sourceTreeSha256 || '')) throw new Error('verified package/source identity missing');
    validateTrackAReport(report, { expectedKind: WINDOWS_KIND });
    if (!Array.isArray(report.fixtureInitial?.files) || !Array.isArray(report.fixtureFinal?.files) || typeof report.fixtureInitial.exists !== 'boolean' || report.fixtureFinal.exists !== true) throw new Error('initial/final fixture observations missing');
    if (JSON.stringify(report.fixtureInitial.files) !== JSON.stringify(report.fixtureFinal.files)) throw new Error('synthetic workspace changed');
    for (const [id, result] of Object.entries(report.scenarios)) {
      if (!clean(result.cleanup) || (id === 'a5' && !clean(result.cleanupRound))) throw new Error('Windows owned cleanup/relaunch not verified');
      for (const shot of result.screenshots) {
        if (shot.method !== WINDOWS_WINDOW_METHOD || !shot.native) throw new Error('native HWND evidence missing; emulation is not acceptance');
        if (shot.native.request?.width !== shot.requested.width || shot.native.request.height !== 900 || shot.native.request.electronPid !== (result.relaunch && shot.state !== 'terminal' ? result.relaunch.pid : result.launch?.pid)) throw new Error('native request does not match launch/shot identity');
        validateNativeWindowResponse(shot.native, shot.native.request);
        if (shot.viewport?.width !== shot.requested.width || shot.viewport.height !== 900 || Math.abs(shot.viewport.devicePixelRatio - shot.native.dpi.after / 96) > 0.015 || Math.abs(shot.layout?.root - shot.requested.width) > 1 || !(shot.layout?.grid <= shot.requested.width + 1)) throw new Error('post-native CDP geometry/DPI missing');
      }
    }
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  assertWindowsHost(); // First: no parsing, filesystem, package, pwsh, ports or launches on WSL.
  assertNodeVersion();
  if (process.cwd() !== ROOT) throw new Error('run from checkout root; report CWD must match source');
  const args = parseArgs(argv);
  const plan = planWindowsRun(args);
  drivePath(path.win32, process.execPath, 'Node executable');
  for (const key of ['SystemRoot', 'TEMP']) {
    const directory = drivePath(path.win32, envValue(process.env, key) || (key === 'TEMP' ? envValue(process.env, 'TMP') : undefined), key);
    refuseLinks(directory);
    if (!fs.statSync(directory).isDirectory()) throw new Error(`${key} directory unavailable`);
  }
  for (const value of [plan.out, plan.buildOut, plan.packageRoot, SYNTHETIC, process.execPath]) refuseLinks(value);
  if (fs.existsSync(plan.out) || (plan.packageMode === 'fresh-build' && fs.existsSync(plan.buildOut))) throw new Error('fresh evidence/build output required; existing paths refused');
  const pwshPath = resolveWindowsTool('pwsh', { explicit: args['--pwsh'] });
  const version = spawnSync(pwshPath, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (version.status !== 0 || !/^PowerShell 7\./.test(version.stdout?.trim() ?? '')) throw new Error('existing PowerShell7 required; missing/restricted tools are blocked');
  const tools = Object.fromEntries(['git', ...(plan.packageMode === 'fresh-build' ? ['cargo', 'rustc'] : [])].map(name => [name, resolveWindowsTool(name)]));
  if (plan.packageMode === 'fresh-build') {
    // A rustup shim on PATH is not proof that the pinned toolchain exists.
    // Disable automatic toolchain installation for this read-only prerequisite probe.
    const rust = spawnSync(tools.rustc, ['--version'], { cwd: ROOT, env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' }, encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (rust.status !== 0 || !rust.stdout?.startsWith('rustc 1.96.1 ')) throw new Error('existing Rust 1.96.1 toolchain unavailable; blocked without install');
    tools.rustc = { path: tools.rustc, version: rust.stdout.trim(), exit: rust.status };
  }
  const source = sourceIdentity(ROOT);
  const out = claimOutput(plan.out);
  const report = {
    schemaVersion: 1, kind: WINDOWS_KIND, runSlug: SLUG, cwd: ROOT, head: source.revision, source,
    startedAt: new Date().toISOString(), endedAt: null,
    host: { platform: os.platform(), arch: os.arch(), release: os.release(), distribution: `${os.type()} ${os.release()}` },
    tools: { ...tools, node: { executable: process.execPath, version: process.version }, pwsh: { path: pwshPath, version: version.stdout.trim(), exit: version.status } },
    packageAttempt: { mode: plan.packageMode, root: plan.packageRoot, buildOut: plan.packageMode === 'fresh-build' ? plan.buildOut : null },
    driverExitContract: { ready: 0, blocked: 1, earlyRefusal: 2 },
    honestyLabels: ['Windows x64 portable packaged GoalPort.exe and bundled Core, explicitly verified; package source identity is separate from driver HEAD.', 'CDP input, not native OS keyboard/mouse input.', 'Offline sentinel stubs only; zero real CLI/model calls.', 'Owned Win32 HWND bounds and measured DPI, followed by fresh CDP viewport/root/grid observations; no emulation/CSS layout substitution.'],
    notVerified: WINDOWS_NOT_VERIFIED, status: 'blocked', windowsExecutionStatus: 'not-run', failure: null,
    scenarios: Object.fromEntries(Object.keys(SCENARIOS).map(id => [id, { id, status: 'not-run', assertions: {} }])), cleanup: {},
  };
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  let launched, app, currentId, caseRoot;
  save();
  try {
    report.package = await preparePackage(plan);
    report.package.manifest = { path: path.join(plan.packageRoot, 'package-manifest.json'), sha256: sha(fs.readFileSync(path.join(plan.packageRoot, 'package-manifest.json'))) };
    if (plan.packageMode === 'fresh-build') {
      const commandsPath = path.join(plan.buildOut, 'build-commands.json');
      report.package.buildCommands = { path: commandsPath, sha256: sha(fs.readFileSync(commandsPath)), commands: JSON.parse(fs.readFileSync(commandsPath, 'utf8')) };
    }
    report.fixtureInitial = observeFixture();
    if (report.fixtureInitial.files.length) throw new Error('empty throwaway synthetic workspace required; existing content preserved and refused');
    fs.mkdirSync(SYNTHETIC, { recursive: true }); // The Track A fixture is intentionally empty; no user workspace is copied.
    for (const [id, scenario] of Object.entries(SCENARIOS)) {
      currentId = id;
      const result = report.scenarios[id];
      result.status = 'blocked';
      caseRoot = path.join(out, id);
      fs.mkdirSync(caseRoot);
      const stub = materializeStubBin(path.join(caseRoot, 'stub-bin'), { platform: 'win32', nodeExecutable: process.execPath, behavior: scenario.behavior });
      const env = buildWindowsEnv({ caseRoot, pipe: socketName(uniqueToken(), 'win32'), port: await freePort(), stub, packageRoot: plan.packageRoot });
      result.preflight = preflightWindows(env, stub.stubDir);
      launched = await launchWindowsApp(env, caseRoot, { packageRoot: plan.packageRoot, pwshPath });
      report.windowsExecutionStatus = 'running';
      result.launch = { command: launched.command, cwd: launched.cwd, selectedEnv: launched.selectedEnv, pid: launched.child.pid };
      save();
      app = await attachApp(Number(env.GOALPORT_CDP_PORT), { electronPid: launched.child.pid, pwshPath });
      if (RUNNERS[id]) await withCaseDeadline(RUNNERS[id](app, caseRoot, result), id, scenario.timeoutMs ?? 120000);
      else {
        await withCaseDeadline(runA5Round(app, caseRoot, result), 'a5 round', scenario.timeoutMs);
        result.cleanupRound = await launched.cleanup(app);
        launched = null; app = null;
        if (!clean(result.cleanupRound)) throw new Error('a5 cleanup blocked; same-state relaunch refused');
        const relaunchRoot = path.join(caseRoot, 'relaunch');
        fs.mkdirSync(relaunchRoot);
        // Retain the adapter-owned immutable object (WeakMap identity), pipe and
        // state. Cleanup must have removed temp and proved the pipe absent first.
        launched = await launchWindowsApp(env, relaunchRoot, { packageRoot: plan.packageRoot, pwshPath });
        result.relaunch = { command: launched.command, cwd: launched.cwd, selectedEnv: launched.selectedEnv, pid: launched.child.pid };
        save();
        app = await attachApp(Number(env.GOALPORT_CDP_PORT), { electronPid: launched.child.pid, pwshPath });
        await withCaseDeadline(runA5Relaunch(app, caseRoot, result), 'a5 relaunch', 120000);
      }
      result.cleanup = await launched.cleanup(app);
      launched = null; app = null;
      result.artifactsFinal = collectArtifacts(caseRoot); // After owned probe processes/app close; no fabricated disk evidence.
      if (!clean(result.cleanup)) throw new Error(`${id} cleanup blocked; subsequent launches refused`);
      result.status = 'ready';
      save();
    }
    report.fixtureFinal = observeFixture();
    report.zeroQuota = zeroQuotaProof(report.scenarios);
    report.cleanup = aggregateCleanup(report.scenarios);
    if (!report.zeroQuota.stubOnly) throw new Error('stub-only proof failed');
    report.status = 'ready'; report.windowsExecutionStatus = 'ready';
  } catch (error) {
    report.failure = error.stack || String(error);
    report.status = 'blocked';
    if (report.windowsExecutionStatus !== 'not-run') report.windowsExecutionStatus = 'blocked';
    if (app) {
      try { report.failureScreenshot = await app.screenshot(caseRoot, 'blocked', 1020); } catch (captureError) { report.captureFailure = captureError.message; }
      try { report.failureDom = await app.evaluate('document.body.innerText'); } catch { /* Closed renderer; retain existing evidence. */ }
    }
  } finally {
    if (launched) {
      report.scenarios[currentId].cleanup = await launched.cleanup(app);
      report.scenarios[currentId].status = 'blocked';
    }
    report.zeroQuota ??= zeroQuotaProof(report.scenarios);
    report.cleanup = aggregateCleanup(report.scenarios);
    report.endedAt = new Date().toISOString();
    const shots = Object.values(report.scenarios).flatMap(r => r.screenshots ?? []);
    fs.writeFileSync(path.join(out, 'screenshot-manifest.json'), `${JSON.stringify(shots, null, 2)}\n`);
    fs.writeFileSync(path.join(out, 'walkthrough.md'), `# Windows packaged real-window walkthrough\n\n${Object.entries(report.scenarios).map(([id, r]) => `## ${id} (${r.status})\n\n${(r.walkthrough ?? []).map(n => `- ${n}`).join('\n')}`).join('\n\n')}\n\n${report.honestyLabels.join('\n')}\n\n${report.notVerified.join('\n')}\n`);
    try { persistValidatedReport(report, save, validateWindowsReport); }
    catch (error) { report.windowsExecutionStatus = report.windowsExecutionStatus === 'not-run' ? 'not-run' : 'blocked'; report.validationFailure = error.message; save(); }
  }
  console.log(`M4_WINDOWS_STATUS: ${report.status}; report ${path.join(out, 'report.json')}`);
  return report.status === 'ready' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(`M4_WINDOWS_STATUS: blocked; ${error.message}`); process.exitCode = 2; }
}
