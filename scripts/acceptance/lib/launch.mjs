import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const SLUG = 'goalport-execute-and-native-acceptance';
export const EVIDENCE = path.join(ROOT, 'goal-runs', SLUG, 'evidence');
export const SYNTHETIC = path.join(ROOT, 'goal-runs', SLUG, 'fixtures/synthetic-workspace');
const require = createRequire(import.meta.url);
const { launchSpec } = require('../../../electron/cli-coordinate.cjs');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const inside = (child, parent) => { const rel = path.relative(parent, child); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); };

export function claimOutput(value) {
  if (!value) throw new Error('explicit fresh --out required');
  const out = path.resolve(value);
  if (!inside(out, EVIDENCE)) throw new Error('--out must be inside this run evidence');
  // Reject symlink ancestors, including nonexistent destinations reached through a link.
  for (let p = out; p !== path.dirname(p); p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('symlink output ancestor refused');
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(out); // EEXIST is intentional: never overwrite prior evidence.
  return out;
}

export function socketName(token, platform = process.platform) {
  if (!/^[a-z0-9-]{1,24}$/.test(token)) throw new Error('invalid socket token');
  const result = platform === 'win32' ? `\\\\.\\pipe\\${SLUG}-${token}` : `/tmp/${SLUG}-${token}.sock`;
  if (platform !== 'win32' && Buffer.byteLength(result) > 107) throw new Error('socket exceeds sun_path');
  return result;
}
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); });
  });
}

export function assembleEnv({ caseRoot, pipe, port, stub, inherited = process.env }) {
  if (!inside(path.resolve(caseRoot), EVIDENCE)) throw new Error('case root outside run evidence');
  if (!pipe.includes(SLUG) || (process.platform !== 'win32' && (Buffer.byteLength(pipe) > 107 || !pipe.startsWith(`/tmp/${SLUG}-`) || !pipe.endsWith('.sock') || pipe.slice(5).includes('/')))) throw new Error('invalid isolated pipe');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  const home = path.join(caseRoot, 'home');
  // Allowlist, not a subtractive list: inherited profiles, runtimes, NODE_OPTIONS,
  // loader hooks, vendor credentials and remote backends cannot escape isolation.
  const env = {};
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (inherited[key]) env[key] = inherited[key];
  }
  Object.assign(env, {
    PATH: `${stub.stubDir}${path.delimiter}${inherited.PATH || '/usr/bin:/bin'}`,
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    TMPDIR: `${pipe.slice(0, -5)}-tmp`, TMP: `${pipe.slice(0, -5)}-tmp`, TEMP: `${pipe.slice(0, -5)}-tmp`,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    GOALPORT_RUN_SLUG: SLUG, GOALPORT_REQUIRE_ISOLATED: '1', GOALPORT_CORE_PIPE: pipe,
    GOALPORT_CORE_DB: path.join(caseRoot, 'core.sqlite'), GOALPORT_SYNTHETIC_ROOT: SYNTHETIC,
    GOALPORT_HARNESS_STATE_DIR: path.join(caseRoot, 'harness-state'), GOALPORT_CDP_PORT: String(port),
    GOALPORT_COORDINATE_SEND: '1', GOALPORT_STUB_DIR: stub.stubDir, GOALPORT_STUB_SENTINEL: stub.sentinel,
  });
  return env;
}

export async function guardedEnv(env) {
  const keys = ['GOALPORT_RUN_SLUG', 'GOALPORT_REQUIRE_ISOLATED', 'GOALPORT_CORE_PIPE', 'GOALPORT_CORE_DB', 'GOALPORT_SYNTHETIC_ROOT'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const key of keys) process.env[key] = env[key];
    const guards = await import('../../connected/v1-isolated-env.mjs');
    if (guards.RUN_SLUG !== SLUG) throw new Error('isolation guard loaded for another run');
    guards.assertIsolatedEnv({ argv: [] });
    return guards.isolatedChildEnv(env);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
}

export function preflight(env, stubDir) {
  const resolutions = {};
  for (const identity of ['codex', 'claude']) {
    const spec = launchSpec(identity, [], env, process.platform);
    if (process.platform === 'win32') throw new Error('local preflight is POSIX only; Windows execution not claimed');
    const resolved = spawnSync('/bin/sh', ['-c', `command -v ${identity}`], { env, encoding: 'utf8' });
    const filename = resolved.stdout.trim();
    const expected = path.join(stubDir, identity);
    if (resolved.status !== 0 || filename !== expected || fs.realpathSync(filename) !== expected || spec.file !== identity) throw new Error(`${identity} escaped stub PATH`);
    fs.accessSync(filename, fs.constants.X_OK);
    resolutions[identity] = { resolved: filename, launchSpec: spec, host: 'present locations resolved without execution', shadowedLocations: env.PATH.split(path.delimiter).slice(1).map(p => path.join(p, identity)).filter(p => fs.existsSync(p)) };
  }
  return { resolutions, bothNamesShadowed: true };
}

function ownedCore(pipe, db) {
  return fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(n => {
    try {
      const argv = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0');
      return argv.includes('--pipe') && argv[argv.indexOf('--pipe') + 1] === pipe && argv.includes('--db') && argv[argv.indexOf('--db') + 1] === db ? [Number(n)] : [];
    } catch { return []; }
  });
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function launchApp(env, caseRoot) {
  const safe = await guardedEnv(env);
  // isolatedChildEnv is deliberately passthrough; intersect with our allowlist.
  for (const key of Object.keys(safe)) if (!(key in env)) delete safe[key];
  if (fs.existsSync(env.GOALPORT_CORE_PIPE)) throw new Error('socket already exists; refusing reuse');
  const binary = path.join(ROOT, 'node_modules/electron/dist/electron');
  fs.accessSync(binary, fs.constants.X_OK);
  fs.accessSync(path.join(ROOT, 'target/debug/goalport-core'), fs.constants.X_OK);
  fs.accessSync(path.join(ROOT, 'dist/index.html'));
  // Chromium's SingletonSocket also has a Unix length bound: deep evidence
  // TMPDIR would fail before a window exists. Claim a fresh short owned temp.
  if (fs.existsSync(env.TMPDIR)) throw new Error('temporary directory already exists; refusing reuse');
  fs.mkdirSync(env.TMPDIR);
  for (const directory of [env.HOME, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.GOALPORT_HARNESS_STATE_DIR, SYNTHETIC]) fs.mkdirSync(directory, { recursive: true });
  const stdout = fs.createWriteStream(path.join(caseRoot, 'electron.stdout.log'), { flags: 'wx' });
  const stderr = fs.createWriteStream(path.join(caseRoot, 'electron.stderr.log'), { flags: 'wx' });
  const child = spawn(binary, ['.'], { cwd: ROOT, env: safe, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  let exit = null;
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); });
    child.once('error', error => { exit = { error: error.message }; resolve(exit); });
  });
  return {
    child, command: [binary, '.'], cwd: ROOT,
    selectedEnv: Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'GOALPORT_STUB_SENTINEL' && k !== 'DBUS_SESSION_BUS_ADDRESS' && k !== 'XAUTHORITY')),
    async cleanup(app) {
      const result = { requestClose: false, forcedElectron: false, coreMatchedPids: [], socketRemoved: false };
      if (app && !exit) { result.requestCloseRequested = true; try { await app.evaluate('window.goalportCore.requestClose()', true); result.requestClose = true; } catch (error) { result.closeError = error.message; } }
      if (!exit) await Promise.race([exited, sleep(5000)]);
      if (!exit && child.pid) {
        result.forcedElectron = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        await Promise.race([exited, sleep(3000)]);
        if (!exit) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await Promise.race([exited, sleep(3000)]); }
      }
      result.electronExit = exit;
      app?.close();
      const matches = ownedCore(env.GOALPORT_CORE_PIPE, env.GOALPORT_CORE_DB);
      result.coreMatchedPids = matches;
      for (const pid of matches) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      for (let i = 0; i < 30 && matches.some(alive); i++) await sleep(100);
      // Re-match exact argv before escalation; never kill reused PIDs.
      for (const pid of ownedCore(env.GOALPORT_CORE_PIPE, env.GOALPORT_CORE_DB)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await sleep(200);
      result.coreStopped = ownedCore(env.GOALPORT_CORE_PIPE, env.GOALPORT_CORE_DB).length === 0 && matches.every(pid => !alive(pid));
      if (result.coreStopped && fs.existsSync(env.GOALPORT_CORE_PIPE)) { fs.unlinkSync(env.GOALPORT_CORE_PIPE); result.socketRemoved = true; }
      result.socketAbsent = !fs.existsSync(env.GOALPORT_CORE_PIPE);
      if (exit && result.coreStopped) { fs.rmSync(env.TMPDIR, { recursive: true, force: true }); result.ownedTempRemoved = true; }
      stdout.end(); stderr.end();
      return result;
    },
  };
}
export const uniqueToken = () => `m2-${crypto.randomBytes(6).toString('hex')}`;
