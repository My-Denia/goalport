import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildWindowsEnv, preflightWindows, selectWindowsPackage, assertWindowsCoreIdentity, cleanupWindowsCore, launchWindowsApp, windowsOwnedHost } from './windows-host.mjs';
import { stubWrapperSource } from './stubbin.mjs';
import { SLUG } from './launch.mjs';

// Every Windows process/filesystem adapter below is injected. These are pure
// Linux contract tests, NOT Windows operations or mocked app/IPC/UI acceptance.
const p = path.win32;
const caseRoot = `C:\\checkout\\goal-runs\\${SLUG}\\evidence\\windows-1\\a1`;
const packageRoot = 'C:\\checkout\\artifacts\\electron-rc\\fresh\\GoalPort-win32-x64';
const scriptPath = 'C:\\checkout\\scripts\\acceptance\\stub-harness.mjs';
const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
const stubDir = p.join(caseRoot, 'stub-bin');
const pipe = `\\\\.\\pipe\\${SLUG}-fresh-a1`;
const inherited = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', Path: 'C:\\real-cli;C:\\Windows\\System32', ComSpec: 'C:\\evil\\cmd.exe', PATHEXT: '.EXE;.CMD' };
function envInput(extra = {}) { return { caseRoot, packageRoot, pipe, port: 4567, stub: { stubDir, sentinel: 'fresh-offline-sentinel' }, inherited, ...extra }; }
function fakeFs() {
  const files = new Map(), dirs = new Set(), links = new Set(), fds = new Set();
  const key = value => String(value).toLowerCase();
  const filesystem = {
    files, dirs, links, fds,
    existsSync: file => files.has(key(file)) || dirs.has(key(file)) || links.has(key(file)),
    lstatSync: file => ({ isSymbolicLink: () => links.has(key(file)) }),
    statSync: file => { if (!filesystem.existsSync(file)) throw Object.assign(new Error(`missing ${file}`), { code: 'ENOENT' }); return { isFile: () => files.has(key(file)), isDirectory: () => dirs.has(key(file)) }; },
    realpathSync: { native: value => value },
    readFileSync: file => { if (!files.has(key(file))) throw new Error(`missing ${file}`); return files.get(key(file)); },
    mkdirSync: (dir, options) => { if (filesystem.existsSync(dir) && !options?.recursive) throw new Error('EEXIST'); dirs.add(key(dir)); },
    openSync: (file, flags) => { assert.equal(flags, 'wx'); if (filesystem.existsSync(file)) throw new Error('EEXIST'); files.set(key(file), ''); const fd = 100 + fds.size; fds.add(fd); return fd; },
    closeSync: fd => { assert.ok(fds.delete(fd)); },
    rmdirSync: dir => { assert.ok(dirs.delete(key(dir))); },
    rmSync: (dir, options) => { assert.deepEqual(options, { recursive: true, force: false }); assert.ok(dirs.delete(key(dir))); },
    write: (file, value) => files.set(key(file), value),
  };
  return filesystem;
}
function stubFs(env) {
  const filesystem = fakeFs();
  filesystem.write(nodePath, 'node fixture'); filesystem.write(scriptPath, 'checked-in stub fixture');
  for (const name of ['codex', 'claude']) filesystem.write(p.join(stubDir, `${name}.cmd`), stubWrapperSource.windows(name, nodePath, scriptPath));
  filesystem.write(p.join(stubDir, 'behavior.json'), JSON.stringify({ schemaVersion: 1, sentinel: env.GOALPORT_STUB_SENTINEL }));
  return filesystem;
}
function actualResolver(filesystem) {
  // Run the unchanged production CJS source with only its OS path/filesystem
  // adapters replaced, so Windows PATH casing/separators are tested on Linux.
  const filename = fileURLToPath(new URL('../../../electron/cli-coordinate.cjs', import.meta.url));
  const nativeRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, Buffer, setTimeout, clearTimeout,
    require: name => name === 'node:path' ? p : name === 'node:fs' ? filesystem : nativeRequire(name),
  }, { filename });
  return module.exports.launchSpec;
}
function fixturePreflight(env, filesystem) {
  return preflightWindows(env, stubDir, { filesystem, pathApi: p, scriptPath, nodeExecutable: nodePath, resolveSpec: actualResolver(filesystem) });
}
const expected = { core: p.join(packageRoot, 'resources', 'goalport-core.exe'), pipe, db: p.join(caseRoot, 'core.sqlite'), startedAt: '2026-01-01T00:00:00.000Z' };
const owned = { state: 'live', ProcessId: 123, ExecutablePath: expected.core, Pipe: pipe, Database: expected.db, CreationDate: '2026-01-01T00:00:01.000Z', CreationIdentity: '639028224010000000' };

test('pure Windows env is hermetic and normalizes case-sensitive host keys without credentials', () => {
  const env = buildWindowsEnv(envInput({ inherited: { ...inherited, NODE_OPTIONS: '--loader evil', ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', CODEX_HOME: 'C:\\user', GOALPORT_PROFILE: 'user', GOALPORT_CORE_BIN: 'evil', GOALPORT_HARNESS_CHECKOUT: 'evil', GOALPORT_HARNESS_SERVER_CWD: 'evil' } }));
  assert.equal(env.PATH, `${stubDir};${inherited.Path}`); assert.equal(env.Path, undefined); assert.equal(env.PATHEXT, '.CMD');
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOALPORT_PROFILE', 'GOALPORT_CORE_BIN', 'GOALPORT_HARNESS_CHECKOUT', 'GOALPORT_HARNESS_SERVER_CWD']) assert.equal(env[key], undefined, key);
  assert.equal(env.HOME, env.USERPROFILE); assert.equal(env.CODEX_HOME, p.join(env.HOME, '.codex'));
  assert.equal(env.APPDATA, p.join(env.HOME, 'AppData', 'Roaming'));
  assert.equal(env.GOALPORT_CORE_DB, expected.db); assert.equal(env.GOALPORT_HARNESS_STATE_DIR, p.join(caseRoot, 'harness-state'));
  assert.equal(env.GOALPORT_SYNTHETIC_ROOT, `C:\\checkout\\goal-runs\\${SLUG}\\fixtures\\synthetic-workspace`);
  assert.match(env.TEMP, /^C:\\Temp\\gp-[a-f0-9]{12}$/); assert.equal(env.TEMP, env.TMPDIR);
  assert.notEqual(env.TEMP, buildWindowsEnv(envInput()).TEMP); assert.ok(Object.isFrozen(env));
});
test('invalid pipe/path/port/SystemRoot/case aliases fail rather than host fallback', () => {
  for (const extra of [
    { pipe: 'goalport-core-v1' }, { pipe: `${pipe}\\suffix` }, { caseRoot: 'C:\\user-profile' },
    { caseRoot: caseRoot.replace('a1', '..\\a1') }, { port: 0 }, { stub: { stubDir: 'C:\\real-cli', sentinel: 'fresh-offline-sentinel' } },
    { inherited: { ...inherited, PATH: 'duplicate' } }, { inherited: { TEMP: 'C:\\Temp' } },
    { packageRoot: 'C:\\bad%expansion' },
  ]) assert.throws(() => buildWindowsEnv(envInput(extra)));
});
test('both .cmd names resolve through unchanged production launchSpec with Windows OS adapters', () => {
  const env = buildWindowsEnv(envInput()), filesystem = stubFs(env);
  // Real CLI files are never executed; resolution must stop at BOTH stubs.
  filesystem.write('C:\\real-cli\\codex.cmd', 'host'); filesystem.write('C:\\real-cli\\claude.cmd', 'host');
  const result = fixturePreflight(env, filesystem);
  assert.equal(result.bothNamesShadowed, true);
  for (const name of ['codex', 'claude']) {
    assert.equal(result.resolutions[name].resolved, p.join(stubDir, `${name}.cmd`));
    assert.equal(result.resolutions[name].launchSpec.file, env.ComSpec);
    assert.equal(result.resolutions[name].launchSpec.verbatim, true);
    assert.deepEqual(Array.from(result.resolutions[name].launchSpec.args.slice(0, 3)), ['/d', '/s', '/c']);
  }
});
test('missing/tampered/linked second wrapper, wrong sentinel or missing absolute Node all refuse', () => {
  for (const mutate of [
    f => f.files.delete(p.join(stubDir, 'claude.cmd').toLowerCase()),
    f => f.write(p.join(stubDir, 'claude.cmd'), '@echo off\r\nclaude %*'),
    f => f.links.add(p.join(stubDir, 'claude.cmd').toLowerCase()),
    f => f.write(p.join(stubDir, 'behavior.json'), JSON.stringify({ schemaVersion: 1, sentinel: 'wrong' })),
    f => f.files.delete(nodePath.toLowerCase()),
  ]) { const env = buildWindowsEnv(envInput()), f = stubFs(env); mutate(f); assert.throws(() => fixturePreflight(env, f)); }
});
test('PATH order, PATHEXT and ComSpec resolution never silently fall through', () => {
  const env = buildWindowsEnv(envInput()), f = stubFs(env);
  assert.throws(() => fixturePreflight({ ...env, PATH: `C:\\real-cli;${stubDir}` }, f));
  assert.throws(() => fixturePreflight({ ...env, PATHEXT: '.EXE;.CMD' }, f));
  assert.throws(() => fixturePreflight({ ...env, Path: env.PATH }, f));
  assert.throws(() => preflightWindows(env, stubDir, { filesystem: f, pathApi: p, scriptPath, nodeExecutable: nodePath, resolveSpec: () => ({ file: 'codex.exe', args: [], verbatim: false }) }));
});
function packageFs() {
  const f = fakeFs(); f.dirs.add(packageRoot.toLowerCase());
  f.write(p.join(packageRoot, 'GoalPort.exe'), 'packaged app'); f.write(expected.core, 'packaged core');
  return f;
}
test('target selection freshly verifies exact portable folder and never dev Electron', () => {
  const f = packageFs(); let calls = 0;
  const result = selectWindowsPackage(packageRoot, { filesystem: f, pathApi: p, verify: root => { assert.equal(root, packageRoot); calls++; return { status: 'PASS' }; } });
  assert.equal(result.binary, p.join(packageRoot, 'GoalPort.exe')); assert.equal(result.core, expected.core); assert.equal(calls, 1);
  assert.throws(() => selectWindowsPackage(packageRoot, { filesystem: f, pathApi: p, verify: () => ({ status: 'FAIL' }) }));
  f.links.add(packageRoot.toLowerCase()); assert.throws(() => selectWindowsPackage(packageRoot, { filesystem: f, pathApi: p, verify: () => ({ status: 'PASS' }) }));
});
test('exact executable/pipe/DB/PID/start identity refuses all partial ownership', () => {
  assert.equal(assertWindowsCoreIdentity(owned, expected), owned);
  for (const row of [
    { ...owned, ExecutablePath: 'C:\\user\\goalport-core.exe' }, { ...owned, Pipe: `${pipe}-other` },
    { ...owned, Database: `${expected.db}.other` }, { ...owned, CreationDate: '2025-01-01T00:00:00Z' },
    { ...owned, ProcessId: 0 }, { ...owned, CreationIdentity: undefined }, { ...owned, CreationIdentity: '639028225010000000' }, { state: 'unknown' },
  ]) assert.throws(() => assertWindowsCoreIdentity(row, expected));
  assert.throws(() => assertWindowsCoreIdentity({ ...owned, CreationIdentity: '639028224010000010' }, expected, owned), /changed/);
});
function coreHost({ before = owned, after = { state: 'absent' }, scan = { state: 'known', rows: [owned] }, stop = { state: 'known', stopped: true } } = {}) {
  let observations = 0, stops = 0;
  return { scan: () => scan, observe: () => ++observations === 1 ? before : after, stop: row => { assert.equal(row, owned); stops++; return stop; }, stops: () => stops };
}
test('cleanup re-observes full identity before stop and verifies absent afterward', async () => {
  const host = coreHost(), result = await cleanupWindowsCore(expected, host, { remembered: owned, wait: async () => {} });
  assert.equal(result.coreStopped, true); assert.deepEqual(result.coreMatchedPids, [123]); assert.equal(host.stops(), 1);
});
test('PID reuse/creation mismatch/unknown/permission failures never authorize stop or clean', async () => {
  for (const before of [{ ...owned, CreationIdentity: '639028224010000010' }, { state: 'unknown', reason: 'permission denied' }, { ...owned, ExecutablePath: 'C:\\unrelated.exe' }]) {
    const host = coreHost({ before }), result = await cleanupWindowsCore(expected, host, { remembered: owned });
    assert.equal(result.coreStopped, false); assert.equal(result.blockedCleanup, true); assert.equal(host.stops(), 0);
  }
  for (const scan of [{ state: 'unknown' }, { state: 'known', rows: [owned, owned] }, { state: 'known', rows: [{ ...owned, ProcessId: 999 }] }]) {
    const host = coreHost({ scan }), result = await cleanupWindowsCore(expected, host, { remembered: owned });
    assert.equal(result.coreStopped, false); assert.equal(host.stops(), 0);
  }
});
test('absent owned Core is clean, but failed stop/unknown after-stop/live deadline stay blocked', async () => {
  for (const options of [{ stop: { state: 'unknown' } }, { after: { state: 'unknown' } }, { after: owned }, { after: { ...owned, CreationIdentity: '639028224010000010' } }]) {
    const result = await cleanupWindowsCore(expected, coreHost(options), { wait: async () => {}, attempts: 2 });
    assert.equal(result.coreStopped, false); assert.equal(result.blockedCleanup, true);
  }
  const host = coreHost({ before: { state: 'absent' } });
  assert.equal((await cleanupWindowsCore(expected, host, { remembered: owned })).coreStopped, true); assert.equal(host.stops(), 0);
  assert.equal((await cleanupWindowsCore(expected, coreHost({ scan: { state: 'known', rows: [] } }))).coreStopped, true);
});
function launchFixture({ preexistingPipe = false, exitCode = 0, staysLive = false, pipeUnknown = false } = {}) {
  const env = buildWindowsEnv(envInput()), f = packageFs();
  f.dirs.add(caseRoot.toLowerCase()); f.dirs.add(env.GOALPORT_SYNTHETIC_ROOT.toLowerCase());
  let scans = 0, launched = 0, verifies = 0, pipes = 0;
  const child = new EventEmitter(); child.pid = 987;
  let unrefs = 0;
  child.unref = () => { unrefs++; };
  const runtime = {
    platform: 'win32', arch: 'x64', filesystem: f, pathApi: p, closeWaitMs: 10, wait: async () => {},
    guardEnv: async value => ({ ...value, OPENAI_API_KEY: 'must be re-intersected away' }), preflight: () => ({ bothNamesShadowed: true }),
    verify: () => { verifies++; return { status: 'PASS' }; },
    host: { scan: () => { scans++; return { state: 'known', rows: [] }; }, pipe: () => ++pipes === 1 ? { state: preexistingPipe ? 'live' : 'absent' } : { state: pipeUnknown ? 'unknown' : 'absent' } },
    spawn: (file, args, options) => { launched++; assert.equal(file, p.join(packageRoot, 'GoalPort.exe')); assert.deepEqual(args, []); assert.equal(options.cwd, packageRoot); assert.equal(options.env.OPENAI_API_KEY, undefined); return child; },
  };
  // Tests only the closure calling the official close expression; this is NOT
  // a fake IPC success assertion. Real CDP/GoalPort calls remain owner-only.
  const app = { evaluate: async (expression, awaitPromise) => { assert.equal(expression, 'window.goalportCore.requestClose()'); assert.equal(awaitPromise, true); if (!staysLive) child.emit('exit', exitCode, null); throw new Error('CDP WebSocket closed'); }, close: () => {} };
  return { env, f, runtime, child, app, launched: () => launched, verifies: () => verifies, scans: () => scans, unrefs: () => unrefs };
}
test('non-Windows/x64 guard fires before any side effect, including PowerShell', async () => {
  if (process.platform === 'win32') return; // Source-only Linux gate.
  const fixture = launchFixture();
  await assert.rejects(launchWindowsApp(fixture.env, caseRoot, { packageRoot }), /Windows x64/);
  assert.throws(() => windowsOwnedHost(fixture.env, expected.core, expected.startedAt), /no WSL/);
  assert.equal(fixture.launched(), 0); assert.equal(fixture.verifies(), 0);
});
test('launch contract preserves command/cwd/selectedEnv; IPC-close + observed exit0 is honest cleanup', async () => {
  const fixture = launchFixture();
  const launch = await launchWindowsApp(fixture.env, caseRoot, { packageRoot, runtime: fixture.runtime });
  assert.deepEqual(launch.command, [p.join(packageRoot, 'GoalPort.exe')]); assert.equal(launch.child, fixture.child);
  assert.equal(launch.cwd, packageRoot); assert.equal(launch.selectedEnv.GOALPORT_STUB_SENTINEL, undefined);
  assert.equal(fixture.f.fds.size, 0);
  const result = await launch.cleanup(fixture.app);
  assert.equal(result.requestCloseRequested, true); assert.equal(result.requestClose, false); assert.equal(result.ipcCloseWithExit0, true);
  assert.deepEqual(result.electronExit, { code: 0, signal: null }); assert.equal(result.forcedElectron, false);
  assert.equal(result.coreStopped, true); assert.equal(result.socketAbsent, true); assert.equal(result.socketRemoved, false);
  assert.equal(result.ownedTempRemoved, true); assert.equal(result.blockedCleanup, undefined);
  assert.equal(await launch.cleanup(fixture.app), result); // idempotent, no second close/kill.
  assert.ok(fixture.f.files.has(p.join(caseRoot, 'electron.stdout.log').toLowerCase()));
});
test('unknown pipe, nonzero exit or still-live app are blocked without forced kills/temp deletion', async () => {
  for (const options of [{ exitCode: 1 }, { staysLive: true }, { pipeUnknown: true }]) {
    const fixture = launchFixture(options), launch = await launchWindowsApp(fixture.env, caseRoot, { packageRoot, runtime: fixture.runtime });
    const result = await launch.cleanup(fixture.app);
    assert.equal(result.blockedCleanup, true); assert.equal(result.forcedElectron, false); assert.equal(result.ownedTempRemoved, undefined);
    assert.ok(fixture.f.dirs.has(fixture.env.TEMP.toLowerCase()));
    assert.equal(fixture.unrefs(), options.staysLive ? 1 : 0, 'only release a still-live app event-loop reference; never kill or call it clean');
    assert.equal(result.appUnreferencedForDriverExit, options.staysLive ? true : undefined);
  }
});
test('preexisting pipe/state/logs and active or nonowned env refuse before app spawn', async () => {
  const a = launchFixture({ preexistingPipe: true });
  await assert.rejects(launchWindowsApp(a.env, caseRoot, { packageRoot, runtime: a.runtime }), /preexisting/); assert.equal(a.launched(), 0);
  for (const preexisting of ['home', 'core.sqlite', 'electron-userData']) {
    const f = launchFixture(); f.f.write(p.join(caseRoot, preexisting), 'preserve');
    await assert.rejects(launchWindowsApp(f.env, caseRoot, { packageRoot, runtime: f.runtime }), /preexisting/); assert.equal(f.launched(), 0);
  }
  const b = launchFixture(); b.f.write(p.join(caseRoot, 'electron.stderr.log'), 'preserve');
  await assert.rejects(launchWindowsApp(b.env, caseRoot, { packageRoot, runtime: b.runtime }), /EEXIST/); assert.equal(b.launched(), 0); assert.equal(b.f.fds.size, 0);
  const c = launchFixture(); const live = await launchWindowsApp(c.env, caseRoot, { packageRoot, runtime: c.runtime });
  await assert.rejects(launchWindowsApp(c.env, caseRoot, { packageRoot, runtime: c.runtime }), /adapter-owned/);
  await live.cleanup(c.app);
  await assert.rejects(launchWindowsApp({ ...c.env }, caseRoot, { packageRoot, runtime: c.runtime }), /adapter-owned/);
});
test('same owned state can relaunch only after clean cleanup with fresh logs and package verification', async () => {
  const f = launchFixture(); const first = await launchWindowsApp(f.env, caseRoot, { packageRoot, runtime: f.runtime }); await first.cleanup(f.app);
  const relaunch = p.join(caseRoot, 'relaunch'); f.f.dirs.add(relaunch.toLowerCase());
  const secondChild = new EventEmitter(); f.runtime.spawn = () => secondChild;
  const second = await launchWindowsApp(f.env, relaunch, { packageRoot, runtime: f.runtime });
  secondChild.emit('exit', 0, null); await second.cleanup(); assert.equal(f.verifies(), 2);
  assert.ok(f.f.files.has(p.join(relaunch, 'electron.stdout.log').toLowerCase()));
});
test('capture unknown is blocked and a remembered Core is re-observed, never stop-on-scan alone', async () => {
  const blocked = launchFixture(); let scans = 0;
  blocked.runtime.host.scan = () => ++scans === 1 ? { state: 'known', rows: [] } : { state: 'unknown', reason: 'permission' };
  const launch = await launchWindowsApp(blocked.env, caseRoot, { packageRoot, runtime: blocked.runtime });
  const result = await launch.cleanup(blocked.app);
  assert.equal(result.coreStopped, false); assert.equal(result.blockedCleanup, true);
  const fixture = launchFixture(); let calls = 0, stops = 0;
  const date = new Date(Date.now() + 1000).toISOString();
  const row = { ...owned, CreationDate: date, CreationIdentity: (BigInt(Date.parse(date)) * 10000n + 621355968000000000n).toString() };
  fixture.runtime.host.scan = () => ({ state: 'known', rows: ++calls === 1 ? [] : [row] });
  fixture.runtime.host.observe = () => ({ ...row, CreationIdentity: (BigInt(row.CreationIdentity) + 10n).toString() });
  fixture.runtime.host.stop = () => { stops++; return { state: 'known' }; };
  const second = await launchWindowsApp(fixture.env, caseRoot, { packageRoot, runtime: fixture.runtime });
  const mismatch = await second.cleanup(fixture.app);
  assert.equal(mismatch.coreStopped, false); assert.equal(mismatch.blockedCleanup, true); assert.equal(stops, 0);
});
test('Core-state reparse paths and reusing old log directory are refused on relaunch', async () => {
  for (const linked of ['core.sqlite', 'electron-userData']) {
    const fixture = launchFixture(); const launch = await launchWindowsApp(fixture.env, caseRoot, { packageRoot, runtime: fixture.runtime }); await launch.cleanup(fixture.app);
    fixture.f.links.add(p.join(caseRoot, linked).toLowerCase());
    const relaunch = p.join(caseRoot, 'relaunch'); fixture.f.dirs.add(relaunch.toLowerCase());
    await assert.rejects(launchWindowsApp(fixture.env, relaunch, { packageRoot, runtime: fixture.runtime }), /symlink/);
    assert.equal(fixture.launched(), 1);
  }
  const fixture = launchFixture(); const launch = await launchWindowsApp(fixture.env, caseRoot, { packageRoot, runtime: fixture.runtime }); await launch.cleanup(fixture.app);
  await assert.rejects(launchWindowsApp(fixture.env, caseRoot, { packageRoot, runtime: fixture.runtime }), /existing launch logs/);
  assert.equal(fixture.launched(), 1);
});
test('PowerShell helper source is file-only and exact identity bounded, not name/title/tree termination', () => {
  const source = fs.readFileSync(new URL('./windows-owned-core.ps1', import.meta.url), 'utf8');
  assert.match(source, /CommandLineToArgvW/); assert.match(source, /\$argv.Count -ne 6/);
  assert.match(source, /CreationIdentity/); assert.match(source, /\$handle.Kill\(\)/); assert.match(source, /state = 'unknown'/);
  assert.doesNotMatch(source, /^\s*(Stop-Process|taskkill|Set-ExecutionPolicy)\b|ExecutionPolicy\s+Bypass|Get-ChildItem\s+Env:/im);
  const adapter = fs.readFileSync(new URL('./windows-host.mjs', import.meta.url), 'utf8');
  assert.match(adapter, /'-NoProfile', '-NonInteractive', '-File'/);
  assert.doesNotMatch(adapter, /'-Command'|powershell\.exe|taskkill|process\.kill/);
});
