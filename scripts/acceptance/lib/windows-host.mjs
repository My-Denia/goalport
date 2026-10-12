import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SLUG, EVIDENCE, guardedEnv, sleep } from './launch.mjs';
import { stubWrapperSource } from './stubbin.mjs';
import { verifyPackage } from '../../desktop/verify-package.mjs';
import { creationTime } from '../../desktop/process-observer.mjs';

const { launchSpec } = createRequire(import.meta.url)('../../../electron/cli-coordinate.cjs');
const HELPER = fileURLToPath(new URL('./windows-owned-core.ps1', import.meta.url));
const HARNESS = fileURLToPath(new URL('../stub-harness.mjs', import.meta.url));
const layouts = new WeakMap();
const inside = (p, child, parent) => { const r = p.relative(parent, child); return r !== '' && !p.isAbsolute(r) && !r.split(/[\\/]/).includes('..'); };
const same = (a, b) => String(a).replaceAll('/', '\\').toLowerCase() === String(b).replaceAll('/', '\\').toLowerCase();
function absoluteWindows(value, label) {
  if (typeof value !== 'string' || !/^[a-z]:\\/i.test(value) || /[\r\n"%]/.test(value) || path.win32.normalize(value) !== value) throw new Error(`${label} must be a normalized absolute Windows drive path without cmd expansion`);
  return value;
}
function inheritedValue(env, key) {
  const entries = Object.entries(env).filter(([k]) => k.toLowerCase() === key.toLowerCase());
  if (entries.length > 1) throw new Error(`ambiguous Windows environment key: ${key}`);
  return entries[0]?.[1];
}

/** Pure assembly; does not claim any directory or execute anything. */
export function buildWindowsEnv({ caseRoot, pipe, port, stub, packageRoot, inherited = process.env }) {
  const p = path.win32;
  for (const [label, value] of Object.entries({ caseRoot, packageRoot, stubDir: stub?.stubDir })) absoluteWindows(value, label);
  // Native Windows ROOT is used in production. Linux tests supply Windows-shaped
  // paths containing the same run layout; launch re-applies the existing guard.
  const parts = caseRoot.split('\\');
  const index = parts.indexOf('goal-runs');
  if (index < 1 || parts[index + 1] !== SLUG || parts[index + 2] !== 'evidence' || parts.length < index + 5) throw new Error('case root outside this-run evidence');
  const checkout = parts.slice(0, index).join('\\');
  if (!inside(p, stub.stubDir, caseRoot)) throw new Error('stub directory must belong to the case root');
  if (!/^\\\\\.\\pipe\\[a-z0-9-]+$/.test(pipe) || !pipe.startsWith(`\\\\.\\pipe\\${SLUG}-`) || pipe.length > 160) throw new Error('fresh this-run named pipe required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid CDP port');
  if (typeof stub.sentinel !== 'string' || stub.sentinel.length < 16 || /[\r\n]/.test(stub.sentinel)) throw new Error('stub sentinel required');
  const systemRoot = absoluteWindows(inheritedValue(inherited, 'SystemRoot'), 'SystemRoot');
  const tempParent = absoluteWindows(inheritedValue(inherited, 'TEMP') || inheritedValue(inherited, 'TMP'), 'TEMP parent');
  const temp = p.join(tempParent, `gp-${crypto.randomBytes(6).toString('hex')}`);
  if (temp.length > 180) throw new Error('short owned Windows temp unavailable');
  const hostPath = inheritedValue(inherited, 'PATH') || p.join(systemRoot, 'System32');
  if (typeof hostPath !== 'string' || /[\r\n]/.test(hostPath)) throw new Error('invalid Windows PATH');
  const home = p.join(caseRoot, 'home');
  const env = {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    ComSpec: p.join(systemRoot, 'System32', 'cmd.exe'),
    // Exactly one canonical PATH spelling, stub-first. .CMD only prevents an
    // executable or .BAT in the stub directory taking precedence over our shim.
    PATH: `${stub.stubDir};${hostPath}`, PATHEXT: '.CMD',
    HOME: home, USERPROFILE: home, HOMEDRIVE: p.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2),
    APPDATA: p.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: p.join(home, 'AppData', 'Local'),
    CODEX_HOME: p.join(home, '.codex'), CLAUDE_CONFIG_DIR: p.join(home, '.claude'),
    XDG_CONFIG_HOME: p.join(home, '.config'), XDG_DATA_HOME: p.join(home, '.local', 'share'), XDG_CACHE_HOME: p.join(home, '.cache'),
    TEMP: temp, TMP: temp, TMPDIR: temp,
    GOALPORT_RUN_SLUG: SLUG, GOALPORT_REQUIRE_ISOLATED: '1', GOALPORT_CORE_PIPE: pipe,
    GOALPORT_CORE_DB: p.join(caseRoot, 'core.sqlite'),
    GOALPORT_SYNTHETIC_ROOT: p.join(checkout, 'goal-runs', SLUG, 'fixtures', 'synthetic-workspace'),
    GOALPORT_HARNESS_STATE_DIR: p.join(caseRoot, 'harness-state'), GOALPORT_CDP_PORT: String(port),
    GOALPORT_COORDINATE_SEND: '1', GOALPORT_STUB_DIR: stub.stubDir, GOALPORT_STUB_SENTINEL: stub.sentinel,
  };
  // No inherited profile, backend, Core override, run-as-node, loader or API key.
  layouts.set(env, { caseRoot, packageRoot, claimed: false, active: false, reusable: false });
  return Object.freeze(env);
}

/** Source/filesystem preflight only: uses the production launchSpec, never probes a CLI. */
export function preflightWindows(env, stubDir, { filesystem = fs, pathApi = path, resolveSpec = launchSpec, scriptPath = HARNESS, nodeExecutable = process.execPath } = {}) {
  if (env.PATHEXT !== '.CMD' || env.PATH?.split(';')[0] !== stubDir || Object.keys(env).some(k => k.toLowerCase() === 'path' && k !== 'PATH')) throw new Error('Windows stub-first PATH/.CMD contract required');
  const resolutions = {};
  for (const identity of ['codex', 'claude']) {
    const wrapper = pathApi.join(stubDir, `${identity}.cmd`);
    if (!filesystem.statSync(wrapper).isFile() || filesystem.lstatSync(wrapper).isSymbolicLink() || !same(filesystem.realpathSync.native(wrapper), wrapper)) throw new Error(`${identity} wrapper identity refused`);
    const source = filesystem.readFileSync(wrapper, 'utf8');
    const line = source.split('\r\n')[3];
    const match = line?.match(/^"([^"]+)" "([^"]+)" (codex|claude) %\*$/);
    if (!match || match[3] !== identity) throw new Error(`${identity} wrapper is not the generated offline stub`);
    absoluteWindows(match[1], 'stub Node executable');
    if (!same(match[1], nodeExecutable)) throw new Error('wrapper must use this absolute Node runtime');
    if (!same(match[2], scriptPath) || source !== stubWrapperSource.windows(identity, match[1], scriptPath)) throw new Error(`${identity} wrapper program mismatch`);
    if (!filesystem.statSync(match[1]).isFile() || !filesystem.statSync(scriptPath).isFile()) throw new Error('absolute Node/stub program missing');
    const spec = resolveSpec(identity, [], env, 'win32');
    // Production resolution retains PATHEXT's uppercase spelling even when
    // the generated filename is lowercase on Windows' case-insensitive FS.
    const expected = resolveSpec(pathApi.join(stubDir, `${identity}.CMD`), [], env, 'win32');
    if (!spec.verbatim || spec.file !== env.ComSpec || JSON.stringify(spec) !== JSON.stringify(expected)) throw new Error(`${identity} escaped stub PATH`);
    resolutions[identity] = { resolved: wrapper, launchSpec: spec, shadowedLocations: env.PATH.split(';').slice(1).map(dir => pathApi.join(dir, `${identity}.cmd`)).filter(file => filesystem.existsSync(file)) };
  }
  const config = JSON.parse(filesystem.readFileSync(pathApi.join(stubDir, 'behavior.json'), 'utf8'));
  if (config.schemaVersion !== 1 || config.sentinel !== env.GOALPORT_STUB_SENTINEL) throw new Error('stub sentinel/config mismatch');
  return { bothNamesShadowed: true, resolutions, method: 'production-launchSpec-source-only-no-CLI-execution' };
}

function refuseLinks(filesystem, p, value) {
  for (let dir = value; dir !== p.dirname(dir); dir = p.dirname(dir)) {
    if (filesystem.existsSync(dir) && filesystem.lstatSync(dir).isSymbolicLink()) throw new Error('symlink/reparse ancestor refused');
  }
}
export function selectWindowsPackage(packageRoot, { filesystem = fs, pathApi = path, verify = verifyPackage } = {}) {
  if (!packageRoot || !pathApi.isAbsolute(packageRoot)) throw new Error('explicit absolute packageRoot required');
  refuseLinks(filesystem, pathApi, packageRoot);
  const verified = verify(packageRoot); // Re-verify exact package immediately before each launch.
  if (verified?.status !== 'PASS') throw new Error('package verification did not pass');
  const binary = pathApi.join(packageRoot, 'GoalPort.exe');
  const core = pathApi.join(packageRoot, 'resources', 'goalport-core.exe');
  for (const filename of [binary, core]) {
    refuseLinks(filesystem, pathApi, filename);
    if (!filesystem.statSync(filename).isFile()) throw new Error('packaged executable missing');
  }
  return { binary, core, verified };
}

function nativeWindows() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 host required; no WSL/PowerShell interop');
}
export function windowsOwnedHost(env, core, startedAt, { pwshPath = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' } = {}) {
  nativeWindows();
  absoluteWindows(pwshPath, 'pwshPath');
  fs.accessSync(pwshPath);
  const call = (action, row) => {
    nativeWindows();
    const args = ['-NoProfile', '-NonInteractive', '-File', HELPER, '-Action', action, '-Executable', core, '-Pipe', env.GOALPORT_CORE_PIPE, '-Database', env.GOALPORT_CORE_DB, '-StartedAt', startedAt];
    if (row) args.push('-OwnedPid', String(row.ProcessId), '-CreationIdentity', row.CreationIdentity);
    const result = spawnSync(pwshPath, args, { env, encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true });
    if (result.error || result.status !== 0) return { state: 'unknown', reason: `owned helper failed (${result.error?.code || result.status})` };
    try {
      const value = JSON.parse(result.stdout);
      if (!value || !['known', 'live', 'absent', 'unknown'].includes(value.state)) throw new Error('invalid state');
      return value;
    } catch { return { state: 'unknown', reason: 'owned helper invalid structured output' }; }
  };
  return { scan: () => call('scan'), observe: row => call('observe', row), stop: row => call('stop', row), pipe: () => call('pipe') };
}

/** Pure identity gate shared by capture and re-observation. Unknown never means absent. */
export function assertWindowsCoreIdentity(row, expected, previous = null) {
  if (!Number.isFinite(Date.parse(expected.startedAt)) || row?.state !== 'live' || !Number.isSafeInteger(row.ProcessId) || row.ProcessId <= 0 || !same(row.ExecutablePath, expected.core) || row.Pipe !== expected.pipe || !same(row.Database, expected.db) || !Number.isFinite(creationTime(row.CreationDate)) || creationTime(row.CreationDate) < Date.parse(expected.startedAt) || !/^\d{15,20}$/.test(row.CreationIdentity || '')) throw new Error('owned Core identity unavailable or mismatched');
  if (Number((BigInt(row.CreationIdentity) - 621355968000000000n) / 10000n) !== creationTime(row.CreationDate)) throw new Error('Core creation date/ticks disagree');
  if (previous && (row.ProcessId !== previous.ProcessId || row.CreationIdentity !== previous.CreationIdentity || creationTime(row.CreationDate) !== creationTime(previous.CreationDate))) throw new Error('owned Core PID/start identity changed; stop refused');
  return row;
}
export async function cleanupWindowsCore(expected, host, { remembered = null, wait = sleep, attempts = 20 } = {}) {
  const result = { coreStopped: false, coreMatchedPids: [], ownershipMethod: 'exact-bundled-exe-pipe-db-pid-creation', observations: [] };
  try {
    const scan = await host.scan();
    if (scan?.state !== 'known' || !Array.isArray(scan.rows) || scan.rows.length > 1) throw new Error('owned Core scan unknown or ambiguous');
    const current = scan.rows.map(row => assertWindowsCoreIdentity(row, expected));
    if (remembered && current.length && (current[0].ProcessId !== remembered.ProcessId || current[0].CreationIdentity !== remembered.CreationIdentity)) throw new Error('owned Core changed since capture');
    const row = remembered || current[0];
    if (!row) { result.coreStopped = true; return result; } // Complete known scan proves no owned Core.
    result.coreMatchedPids = [row.ProcessId];
    const before = await host.observe(row);
    result.observations.push({ phase: 'before-stop', state: before?.state });
    if (before?.state === 'absent') { result.coreStopped = true; return result; }
    assertWindowsCoreIdentity(before, expected, row);
    const stopped = await host.stop(row); // Helper independently re-observes before handle-based stop.
    if (!['absent', 'known'].includes(stopped?.state)) throw new Error('owned Core stop blocked');
    for (let i = 0; i < attempts; i++) {
      const after = await host.observe(row);
      if (after?.state === 'absent') { result.coreStopped = true; return result; }
      assertWindowsCoreIdentity(after, expected, row);
      await wait(100);
    }
    throw new Error('owned Core exit not verified');
  } catch (error) { result.blockedCleanup = true; result.cleanupError = error.message.slice(0, 300); return result; }
}

/** Runtime injection is for Linux contract tests, never IPC/UI/harness success. */
export async function launchWindowsApp(env, caseRoot, { packageRoot, pwshPath, runtime = {} } = {}) {
  const platform = runtime.platform ?? process.platform, arch = runtime.arch ?? process.arch;
  if (platform !== 'win32' || arch !== 'x64') throw new Error('Windows x64 host required; no WSL/PowerShell interop');
  const layout = layouts.get(env);
  if (!layout || !same(layout.packageRoot, packageRoot) || layout.active || (layout.claimed && !layout.reusable)) throw new Error('adapter-owned fresh/reusable environment required');
  const filesystem = runtime.filesystem ?? fs, p = runtime.pathApi ?? path;
  if (!inside(p, caseRoot, EVIDENCE) && !runtime.guardEnv) throw new Error('launch root outside this-run evidence');
  refuseLinks(filesystem, p, caseRoot);
  const safe = await (runtime.guardEnv ?? guardedEnv)(env);
  // The existing guard is passthrough: strictly re-intersect our immutable env.
  for (const key of Object.keys(safe)) if (!(key in env)) delete safe[key];
  (runtime.preflight ?? preflightWindows)(env, env.GOALPORT_STUB_DIR);
  const target = selectWindowsPackage(packageRoot, { filesystem, pathApi: p, verify: runtime.verify ?? verifyPackage });
  const startedAt = new Date().toISOString();
  const expected = { core: target.core, pipe: env.GOALPORT_CORE_PIPE, db: env.GOALPORT_CORE_DB, startedAt };
  const dirs = [env.HOME, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.GOALPORT_HARNESS_STATE_DIR];
  const userData = p.join(p.dirname(env.GOALPORT_CORE_DB), 'electron-userData');
  for (const value of [...dirs, env.TEMP, env.GOALPORT_CORE_DB, userData, env.GOALPORT_SYNTHETIC_ROOT]) refuseLinks(filesystem, p, value);
  if (filesystem.existsSync(env.TEMP) || (!layout.claimed && [env.HOME, env.GOALPORT_HARNESS_STATE_DIR, env.GOALPORT_CORE_DB, userData].some(value => filesystem.existsSync(value)))) throw new Error('preexisting fixture/state/temp refused');
  if (!filesystem.statSync(caseRoot).isDirectory()) throw new Error('launch log directory missing');
  if (['electron.stdout.log', 'electron.stderr.log'].some(name => filesystem.existsSync(p.join(caseRoot, name)))) throw new Error('EEXIST: existing launch logs refused');
  // Synthetic fixture must already have been prepared by the integration driver.
  if (!filesystem.statSync(env.GOALPORT_SYNTHETIC_ROOT).isDirectory()) throw new Error('synthetic fixture missing');
  filesystem.mkdirSync(env.TEMP); // PowerShell also needs a fresh, existing temp.
  const fds = [];
  let child, host;
  try {
    host = runtime.host ?? windowsOwnedHost(env, target.core, startedAt, { pwshPath });
    const initial = await host.scan(), initialPipe = await host.pipe();
    if (initial?.state !== 'known' || !Array.isArray(initial.rows) || initial.rows.length || initialPipe?.state !== 'absent') throw new Error('preexisting/unknown Core or named pipe; refusing launch');
    for (const dir of dirs) filesystem.mkdirSync(dir, { recursive: true });
    fds.push(filesystem.openSync(p.join(caseRoot, 'electron.stdout.log'), 'wx'));
    fds.push(filesystem.openSync(p.join(caseRoot, 'electron.stderr.log'), 'wx'));
    if (!runtime.spawn) nativeWindows();
    child = (runtime.spawn ?? spawn)(target.binary, [], { cwd: packageRoot, env: safe, stdio: ['ignore', ...fds], windowsHide: false });
  } catch (error) {
    layout.claimed = true; layout.reusable = false;
    // No child existed; leave all claimed evidence intact. Only remove our new empty temp.
    filesystem.rmdirSync(env.TEMP);
    throw error;
  } finally { for (const fd of fds) filesystem.closeSync(fd); }
  layout.claimed = true; layout.active = true; layout.reusable = false;
  let exit = null, remembered = null, captureError = null;
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); });
    child.once('error', error => { exit = { error: error.message }; resolve(exit); });
  });
  // Capture the first observed PID/start before product close. Cleanup repeats
  // exact scan and observation; this timer cannot keep the driver alive.
  let capturePromise;
  const capture = () => {
    if (capturePromise) return capturePromise;
    if (remembered || captureError) return Promise.resolve();
    capturePromise = (async () => {
      try {
        const scan = await host.scan();
        if (scan?.state !== 'known' || !Array.isArray(scan.rows) || scan.rows.length > 1) throw new Error('owned Core capture unknown/ambiguous');
        if (scan.rows.length) remembered = assertWindowsCoreIdentity(scan.rows[0], expected);
      } catch (error) { captureError = error.message; }
      finally { capturePromise = null; }
    })();
    return capturePromise;
  };
  const timer = setInterval(capture, 200); timer.unref();
  let cleanupPromise;
  return {
    child, command: [target.binary], cwd: packageRoot,
    selectedEnv: Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'GOALPORT_STUB_SENTINEL')),
    async cleanup(app) {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        clearInterval(timer);
        await capture();
        const result = { requestClose: false, requestCloseRequested: false, forcedElectron: false, socketRemoved: false, platform: 'win32', method: 'packaged-windows-owned-host' };
        if (app && !exit) {
          result.requestCloseRequested = true;
          // Bound the official close promise: Electron often exits before CDP acknowledges.
          let deadline;
          try {
            await Promise.race([app.evaluate('window.goalportCore.requestClose()', true), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('requestClose deadline')), runtime.closeWaitMs ?? 5000); })]);
            result.requestClose = true;
          } catch (error) { result.closeError = error.message.slice(0, 300); }
          finally { clearTimeout(deadline); }
        }
        if (!exit) {
          let deadline;
          await Promise.race([exited, new Promise(resolve => { deadline = setTimeout(resolve, runtime.closeWaitMs ?? 5000); })]);
          clearTimeout(deadline);
        }
        result.electronExit = exit;
        // No forced app/tree kill: unproven child/descendant ownership is blocked.
        try { app?.close(); } catch (error) { result.closeError ||= error.message.slice(0, 300); }
        Object.assign(result, captureError ? { coreStopped: false, coreMatchedPids: [], blockedCleanup: true, cleanupError: captureError } : await cleanupWindowsCore(expected, host, { remembered, wait: runtime.wait ?? sleep }));
        try { result.socketAbsent = (await host.pipe())?.state === 'absent'; }
        catch (error) { result.socketAbsent = false; result.cleanupError ||= error.message.slice(0, 300); }
        if (!result.coreStopped || !result.socketAbsent || !exit || exit.error || exit.code !== 0 || exit.signal) result.blockedCleanup = true;
        // An IPC close error is honest success only with independently observed exit0.
        result.ipcCloseWithExit0 = result.requestCloseRequested && !result.requestClose && exit?.code === 0 && !exit?.signal;
        if (!result.blockedCleanup) {
          try {
            refuseLinks(filesystem, p, env.TEMP);
            filesystem.rmSync(env.TEMP, { recursive: true, force: false }); result.ownedTempRemoved = true;
            layout.active = false; layout.reusable = true;
          } catch (error) { result.blockedCleanup = true; result.cleanupError = error.message.slice(0, 300); }
        }
        // A deliberately unproved live app is NOT force-killed. Release only
        // Node's event-loop reference so the blocked owner command can exit.
        if (result.blockedCleanup && !exit) {
          child.unref(); result.appUnreferencedForDriverExit = true;
        }
        return result;
      })();
      return cleanupPromise;
    },
  };
}
