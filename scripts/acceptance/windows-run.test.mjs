// Pure Linux source/API tests, never Windows execution or fake IPC/UI acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertWindowsHost, assertNodeVersion, parseArgs, planWindowsRun, resolveWindowsTool, preparePackage, validateWindowsReport, WINDOWS_KIND, WINDOWS_NOT_VERIFIED } from './windows-run.mjs';
import { SCENARIOS } from './lib/scenarios.mjs';
import { SLUG, ROOT, socketName } from './lib/launch.mjs';
import { scenarioShotRequirements, aggregateCleanup, zeroQuotaProof } from './report.mjs';
import { persistValidatedReport } from './run-local.mjs';
import { buildPowerShellInvocation, WINDOWS_WINDOW_METHOD, serializeResizeRequest } from './lib/windows-window.mjs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const plan = () => planWindowsRun({}, { root: 'C:\\checkout', token: 'fresh-123' });
const hash = 'a'.repeat(64);
const cleanup = () => ({ coreStopped: true, socketAbsent: true, electronExit: { code: 0, signal: null }, forcedElectron: false, ownedTempRemoved: true, blockedCleanup: false });
// Report-validator fixtures only; never passed to a running app or IPC.
function shot(state, width) {
  const frameInsets = { left: 8, top: 30, right: 8, bottom: 8 };
  const size = w => ({ windowRect: { x: 45, y: 70, width: w + 16, height: 938 }, clientRect: { width: w, height: 900 }, frameInsets });
  const request = { electronPid: 4100, width, height: 900, currentViewport: { width: 1020, height: 900 }, devicePixelRatio: 1 };
  return { state, path: `C:\\evidence\\${state}-${width}.png`, bytes: 50000, sha256: hash, requested: { width, height: 900 }, pngWidth: width, pngHeight: 900,
    geometry: { text: 'report-validator fixture only' }, method: WINDOWS_WINDOW_METHOD,
    viewport: { width, height: 900, devicePixelRatio: 1 }, layout: { root: width, grid: width },
    native: { schemaVersion: 1, status: 'resized', method: WINDOWS_WINDOW_METHOD, windowId: '0x4A1', windowPid: 4101, ownership: { rootPid: 4100, windowPid: 4101, processChain: [4101, 4100] }, identity: { title: 'GoalPort 1.0.0-rc.1', className: 'Chrome_WidgetWin_1' }, request, dpi: { before: 96, after: 96 }, before: size(1020), target: size(width), observed: size(width), attempts: 1 },
  };
}
function reportFixture() {
  const scenarios = Object.fromEntries(Object.keys(SCENARIOS).map(id => [id, {
    id, status: 'ready', assertions: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`fixture-${i}`, true])),
    artifacts: { files: [{ path: 'fixture.json', bytes: 0, sha256: hash }], invocations: [], ledger: {} },
    artifactsFinal: { files: [{ path: 'fixture.json', bytes: 0, sha256: hash }], invocations: [], ledger: {} },
    preflight: { bothNamesShadowed: true, resolutions: {} }, screenshots: scenarioShotRequirements(id).map(([state, width]) => shot(state, width)),
    launch: { pid: 4100 }, cleanup: cleanup(), ...(id === 'a5' ? { cleanupRound: cleanup(), relaunch: { pid: 4100 } } : {}),
  }]));
  return { schemaVersion: 1, kind: WINDOWS_KIND, runSlug: SLUG, head: 'b'.repeat(40), cwd: process.cwd(), startedAt: '2026-10-11T00:00:00Z', endedAt: '2026-10-11T00:05:00Z', host: { platform: 'win32', arch: 'x64', release: 'test-fixture', distribution: 'test-fixture' }, honestyLabels: ['packaged', 'CDP', 'stubs', 'native bounds'], notVerified: WINDOWS_NOT_VERIFIED, scenarios, zeroQuota: zeroQuotaProof(scenarios), cleanup: aggregateCleanup(scenarios), status: 'ready', windowsExecutionStatus: 'ready', failure: null, package: { mode: 'existing-verified', verified: { status: 'PASS', sourceRevision: 'c'.repeat(40), sourceTreeSha256: hash } }, fixtureInitial: { exists: false, files: [] }, fixtureFinal: { exists: true, files: [] } };
}

test('non-win32 refusal precedes even args/output parsing and all side effects', () => {
  assert.throws(() => assertWindowsHost('linux', 'x64'), /not-run.*no interop/);
  assert.throws(() => assertWindowsHost('win32', 'arm64'), /Windows x64/);
  assert.doesNotThrow(() => assertWindowsHost('win32', 'x64'));
  if (process.platform === 'win32') return; // Native runtime is not this pure check.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-no-effects-'));
  try {
    const out = path.join(tmp, 'not-created');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./windows-run.mjs', import.meta.url)), '--out', out], { cwd: tmp, encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Windows runtime not-run/);
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally { fs.rmSync(tmp, { recursive: true }); }
});

test('one-command defaults pin fresh package outside goal-runs and same a1-a5 matrix', () => {
  assert.deepEqual(parseArgs([]), {});
  for (const version of ['22.19.0', '22.22.0', '24.0.0', '26.0.0']) assert.doesNotThrow(() => assertNodeVersion(version));
  for (const version of ['20.0.0', '22.18.0', '23.0.0', 'invalid']) assert.throws(() => assertNodeVersion(version), /Node/);
  for (const args of [['--scenario', 'a1'], ['--out'], ['--out', 'a', '--out', 'b'], ['--pwsh', '--package']]) assert.throws(() => parseArgs(args), /usage/);
  const p = plan();
  assert.equal(p.buildOut, `C:\\checkout\\artifacts\\electron-rc\\${SLUG}-win-fresh-123`);
  assert.equal(p.packageRoot, path.win32.join(p.buildOut, 'GoalPort-win32-x64'));
  assert.ok(p.out.startsWith(`C:\\checkout\\goal-runs\\${SLUG}\\evidence\\`));
  for (const value of ['C:\\elsewhere', `C:\\checkout\\goal-runs\\preserved\\evidence\\fresh`, '..\\old']) assert.throws(() => planWindowsRun({ '--out': value }, { root: 'C:\\checkout' }), /output must/);
  assert.throws(() => planWindowsRun({}, { root: 'C:\\goal-runs\\old' }), /outside goal-runs/);
  assert.throws(() => planWindowsRun({ '--package': 'relative\\package' }, { root: 'C:\\checkout' }), /absolute Windows/);
  assert.deepEqual(Object.keys(SCENARIOS), ['a1', 'a2', 'a3', 'a4', 'a5']);
  const local = read('./run-local.mjs'), windows = read('./windows-run.mjs');
  for (const source of [local, windows]) assert.match(source, /import \{ SCENARIOS, runA1, runA2, runA3, runA4, runA5Round, runA5Relaunch,/);
  assert.match(windows, /Object\.entries\(SCENARIOS\)/);
  assert.match(windows, /RUNNERS\[id\]\(app, caseRoot, result\)/);
  assert.ok(socketName('fresh-a1', 'win32').startsWith(`\\\\.\\pipe\\${SLUG}-`));
});

test('package.main void return is ignored; explicit correct directory verification and existing mode', async () => {
  const calls = [];
  const p = plan();
  const result = await preparePackage(p, { build: async argv => { calls.push(['build', argv]); }, verify: dir => { calls.push(['verify', dir]); return { status: 'PASS', sourceRevision: 'old-source' }; } });
  assert.deepEqual(calls, [['build', ['--out', p.buildOut]], ['verify', p.packageRoot]]);
  assert.equal(result.verified.sourceRevision, 'old-source');
  calls.length = 0;
  const existing = planWindowsRun({ '--package': 'C:\\delivered\\GoalPort-win32-x64' }, { root: 'C:\\checkout' });
  await preparePackage(existing, { build: () => assert.fail('existing package must not rebuild'), verify: dir => { calls.push(dir); return { status: 'PASS' }; } });
  assert.deepEqual(calls, [existing.packageRoot]);
  await assert.rejects(preparePackage(existing, { verify: () => ({ status: 'FAIL' }) }), /verification failed/);
  await assert.rejects(preparePackage(p, { build: () => { throw new Error('build infrastructure failed'); }, verify: () => assert.fail('must not silently fall back') }), /infrastructure/);
});

test('PowerShell7 is resolved via actual PATH file or explicit path; no fixed-location fallback', () => {
  const files = new Set(['C:\\Tools With Spaces\\pwsh.exe', 'D:\\Custom\\pwsh.exe']);
  const filesystem = { statSync: value => { if (!files.has(value)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { isFile: () => true }; } };
  assert.equal(resolveWindowsTool('pwsh', { env: { Path: 'C:\\absent;C:\\Tools With Spaces' }, filesystem }), 'C:\\Tools With Spaces\\pwsh.exe');
  assert.equal(resolveWindowsTool('pwsh', { explicit: 'D:\\Custom\\pwsh.exe', env: {}, filesystem }), 'D:\\Custom\\pwsh.exe');
  assert.throws(() => resolveWindowsTool('pwsh', { env: {}, filesystem }), /blocked, no install/);
  assert.throws(() => resolveWindowsTool('pwsh', { explicit: 'C:\\absent.exe', env: { PATH: 'D:\\Custom' }, filesystem }), /unavailable/);
  assert.throws(() => resolveWindowsTool('pwsh', { env: { Path: 'a', PATH: 'b' }, filesystem }), /ambiguous/);
  const invocation = buildPowerShellInvocation('C:\\Request Path\\r.json', 'C:\\Response Path\\r.json', 'C:\\Script Path\\native-window.ps1', 'D:\\Custom\\pwsh.exe');
  assert.equal(invocation.command, 'D:\\Custom\\pwsh.exe');
  assert.deepEqual(invocation.args, ['-NoProfile', '-NonInteractive', '-File', 'C:\\Script Path\\native-window.ps1', '-RequestPath', 'C:\\Request Path\\r.json', '-ResponsePath', 'C:\\Response Path\\r.json']);
  assert.equal(JSON.parse(serializeResizeRequest(shot('terminal', 1020).native.request)).width, 1020);
});

test('adapter wiring retains a5 exact env identity after cleanup and uses same resolved pwsh path', () => {
  const windows = read('./windows-run.mjs'), cdp = read('./lib/cdp-app.mjs'), host = read('./lib/windows-host.mjs'), native = read('./lib/windows-window.mjs');
  assert.match(windows, /if \(!clean\(result\.cleanupRound\)\) throw/);
  assert.match(windows, /launchWindowsApp\(env, relaunchRoot, \{ packageRoot: plan\.packageRoot, pwshPath \}\)/);
  assert.match(host, /windowsOwnedHost\(env, target\.core, startedAt, \{ pwshPath \}\)/);
  assert.match(cdp, /if \(process\.platform === 'win32'\)/);
  assert.match(cdp, /resizeOwnedWindowsWindow\([\s\S]*?\{ pwshPath \}\)/);
  assert.match(cdp, /nativeResize\(electronPid, width, height, insets\)/);
  assert.match(cdp, /post-resize CDP DPI/);
  assert.match(native, /buildPowerShellInvocation\(requestPath, responsePath, HELPER_PATH, pwshPath\)/);
  assert.doesNotMatch(windows, /Emulation\.setDeviceMetricsOverride|style\.|powershell\.exe|ExecutionPolicy|GOALPORT_CORE_BIN|electron\/dist/);
});

test('actual shared report APIs validate a1-a5, CWD/schema, native geometry and honest source identity', () => {
  const base = reportFixture();
  assert.equal(validateWindowsReport(base), base);
  assert.notEqual(base.head, base.package.verified.sourceRevision, 'existing package identity is separate, not rewritten to driver HEAD');
  const refuse = (mutate, pattern) => { const report = reportFixture(); mutate(report); assert.throws(() => validateWindowsReport(report), pattern); };
  refuse(r => { r.cwd = 'different'; }, /CWD/);
  refuse(r => { r.schemaVersion = 2; }, /schema/);
  refuse(r => { delete r.scenarios.a1; }, /matrix/);
  refuse(r => { r.package.verified.status = 'FAIL'; }, /package/);
  refuse(r => { r.notVerified = ['Linux dev, Windows not-run']; }, /honesty/);
  refuse(r => { r.scenarios.a1.screenshots.pop(); }, /missing required shot/);
  refuse(r => { r.scenarios.a2.screenshots[0].method = 'Emulation.setDeviceMetricsOverride'; }, /HWND/);
  refuse(r => { r.scenarios.a2.screenshots[0].native.dpi.after = 144; }, /DPI/);
  refuse(r => { r.scenarios.a2.screenshots[0].native.request.width = 1440; }, /request/);
  refuse(r => { r.scenarios.a2.launch.pid = 8000; }, /identity/);
  refuse(r => { delete r.fixtureInitial; }, /observations/);
  refuse(r => { r.scenarios.a2.screenshots[0].viewport.width = 900; }, /geometry/);
  refuse(r => { r.scenarios.a2.screenshots[0].layout.grid = 2000; }, /geometry/);
  refuse(r => { r.scenarios.a5.cleanupRound.blockedCleanup = true; }, /cleanup/);
  refuse(r => { r.fixtureFinal.files = [{ path: 'unexpected.txt' }]; }, /workspace changed/);
  const saved = [];
  const invalid = reportFixture(); invalid.scenarios.a3.assertions['fixture-0'] = false;
  assert.throws(() => persistValidatedReport(invalid, () => saved.push(structuredClone(invalid)), validateWindowsReport), /lacks evidence/);
  assert.equal(saved[0].status, 'blocked');
  const blocked = reportFixture(); blocked.status = 'blocked'; blocked.windowsExecutionStatus = 'not-run'; blocked.failure = 'build blocked'; blocked.package = null;
  blocked.scenarios = Object.fromEntries(Object.keys(SCENARIOS).map(id => [id, { id, status: 'not-run', assertions: {} }]));
  assert.equal(validateWindowsReport(blocked), blocked);
});

test('component and integration tests and owner command are registered in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['acceptance:windows'], 'node scripts/acceptance/windows-run.mjs');
  for (const filename of ['scripts/acceptance/lib/windows-host.test.mjs', 'scripts/acceptance/windows-window.test.mjs', 'scripts/acceptance/windows-run.test.mjs']) assert.ok(pkg.scripts['test:desktop'].includes(filename));
  assert.match(read('../../docs/acceptance-windows.md'), /pnpm acceptance:windows/);
});
