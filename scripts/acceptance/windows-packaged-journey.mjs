import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachApp } from './lib/cdp-app.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const WIDTHS = [860, 1020, 1440];
export const REQUIRED_STAGES = ['draftAccess', 'liveA', 'closeReopen', 'stopA', 'resendA', 'stopResendA', 'sendB', 'stopB', 'interruptLive', 'interrupted', 'heldFolder', 'continueB', 'stopContinueB'];
export const REQUIRED_SCREENSHOTS = ['draft-access', 'live', 'reopened', 'stopped', 'interrupted-held', 'b-start'];
export const FORBIDDEN_ENV = ['GOALPORT_COORDINATE_SEND', 'GOALPORT_HARNESS_CHECKOUT', 'GOALPORT_HARNESS_SERVER_CWD', 'GOALPORT_STUB_DIR'];
const terminal = s => ['completed', 'failed', 'stopped'].includes(s?.state);
const invariant = (condition, message) => { if (!condition) throw new Error(message); };
const blocked = message => Object.assign(new Error(message), { blocked: true });
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJson = (filename, value) => fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
const workspaceIdentity = value => typeof value === 'string' && path.win32.isAbsolute(value) ? path.win32.resolve(value).replace(/[\\/]+$/, '').toLowerCase() : null;
const sameWorkspace = (a, b) => workspaceIdentity(a) !== null && workspaceIdentity(a) === workspaceIdentity(b);
const dispatched = s => (s?.completedCommands ?? []).filter(c => c.facts?.dispatched === true);
const settled = s => s?.revoked === true && s.state === 'stopped' && s.outcome?.status === 'stopped' && s.live === false && s.active === false && s.pendingCommand === null;
const sameJob = (a, b) => !!a && !!b && a.jobId === b.jobId && a.requestId === b.requestId && a.goal === b.goal && sameWorkspace(a.workspacePath, b.workspacePath);

/** Pure decision functions: no Electron, filesystem or environment access. */
export function exitCodeForStatus(status) { return status === 'passed' ? 0 : 1; }
/** A process whose command line names this profile and whose image is the
 * package or the node runtime belongs to the run even after its parent app
 * has exited (Windows keeps the dead parent pid, so the parent chain no
 * longer links it). */
export function profileProcessMatch(proc, profilePath, packageRoot, nodeExe) {
  if (!proc || typeof profilePath !== 'string' || !profilePath) return false;
  const cmd = String(proc.CommandLine || '').toLowerCase();
  if (!cmd.includes(profilePath.toLowerCase())) return false;
  const exe = String(proc.ExecutablePath || '').toLowerCase();
  if (!exe) return false;
  const root = String(packageRoot || '').toLowerCase().replace(/[\/]+$/, '');
  const node = String(nodeExe || '').toLowerCase();
  return (root.length > 0 && (exe === root || exe.startsWith(root + '\\') || exe.startsWith(root + '/'))) || (node.length > 0 && exe === node);
}
export function stopIsUsable(control) { return control?.visible === true && control.enabled === true && control.hitTestable === true; }
export function liveEvidenceIsValid(e) {
  const s = e?.statusFacts, a = e?.admission, d = e?.dispatch;
  // A pending reservation alone is NOT dispatch. It needs the actual owned
  // worker's CLI descendant with this goal's unique prompt marker, plus the
  // runtime ledger and charged counter. Alternatively use completed facts.
  const pendingDispatch = !!s?.pendingCommand && d?.commandId === s.pendingCommand.commandId && d.workerPid === s.workerPid
    && Number.isInteger(d.pid) && d.pid > 1 && d.pid !== s.workerPid && d.fromOwnedWorker === true
    && d.ledgerMessageDispatched === true && Date.parse(d.createdAt) >= Date.parse(s.pendingCommand.recordedAt) - 1000
    && typeof d.executablePath === 'string' && !!d.executablePath
    && /^[a-f0-9]{64}$/.test(d.commandLineSha256 ?? '') && typeof d.promptMarker === 'string' && d.promptMarker.length >= 16
    && s.goal?.includes(d.promptMarker) && Number.isInteger(s.counters?.readTurnsLeft) && s.counters.readTurnsLeft < s.readMaxTurns;
  return !!s && !!a && s.live === true && s.active === true && s.state === 'running' && !s.revoked && !s.outcome
    && Number.isInteger(s.workerPid) && s.workerPid > 1 && s.jobId === a.jobId && s.requestId === a.input?.requestId
    && s.goal === a.input?.goal && sameWorkspace(s.workspacePath, a.input?.workspacePath)
    && (dispatched(s).length > 0 || pendingDispatch) && e.rendered?.jobId === s.jobId && e.rendered.goal === s.goal
    && e.rendered.progressMatched === true && e.rendered.commandMatched === true && e.sent === true;
}
export function validateJourney(report = {}) {
  const failures = [...(report.errors ?? []), ...(report.blocked ? [`blocked: ${report.blocked}`] : [])];
  const require = (ok, reason) => { if (!ok) failures.push(reason); };
  const s = report.stages ?? {};
  for (const name of REQUIRED_STAGES) require(s[name]?.status === 'passed', `required stage missing or failed: ${name}`);
  require(/^[a-f0-9]{40}$/i.test(report.packageIdentity?.source?.revision ?? '') && report.packageIdentity?.source?.dirty === false, 'clean full package revision missing');
  require(/^[a-f0-9]{40}$/i.test(report.runnerIdentity?.revision ?? '') && !!report.runnerIdentity?.scriptSha256, 'runner identity missing');
  require(FORBIDDEN_ENV.every(key => report.launchEnvironment?.absent?.[key] === true)
    && report.launchEnvironment?.pathUnmodified === true && report.launchEnvironment?.testProfile === false, 'launch environment bypass/stub absence unproved');
  require(s.draftAccess?.realHarnesses?.length >= 2, 'two real harnesses not available');
  for (const name of ['liveA', 'resendA', 'sendB', 'interruptLive', 'continueB']) require(liveEvidenceIsValid(s[name]), `${name}: admission/live/dispatch/render evidence missing`);
  const r = s.closeReopen;
  require(sameJob(s.liveA?.statusFacts, r?.statusFacts) && r?.statusFacts?.live === true && r.statusFacts.active === true && !terminal(r.statusFacts)
    && r.rendered?.goal === r.statusFacts.goal && r?.normalClose === true && r.forced === false && r.backgroundWorkContinued === true
    && r.admissionsUnchanged === true
    && (r.retainedCommandIds?.length > 0 || r.statusFacts?.pendingCommand?.commandId === s.liveA?.dispatch?.commandId)
    && r.retainedCommandIds.every(id => (r.statusFacts?.completedCommands ?? []).some(c => c.commandId === id))
    && r.rendered?.jobId === r.statusFacts?.jobId && r.rendered?.progressMatched === true && r.rendered?.commandMatched === true, 'close/reopen did not retain the same live job and progress without duplicate admission');
  for (const [name, live] of [['stopA', 'liveA'], ['stopResendA', 'resendA'], ['stopB', 'sendB'], ['stopContinueB', 'continueB']]) {
    const stop = s[name];
    require(stopIsUsable(stop?.control) && stop?.clicked === true && settled(stop?.statusFacts) && sameJob(stop?.statusFacts, s[live]?.statusFacts)
      && stop.noLaterDispatch === true && stop.workerExited === true, `${name}: Stop absent/unusable or revocation/settlement unproved`);
  }
  require(sameWorkspace(s.resendA?.statusFacts?.workspacePath, s.liveA?.statusFacts?.workspacePath)
    && s.resendA?.statusFacts?.jobId !== s.liveA?.statusFacts?.jobId && s.resendA?.statusFacts?.requestId !== s.liveA?.statusFacts?.requestId, 'released A was not actually sent again with fresh identity');
  for (const [b, a] of [['sendB', 'resendA'], ['continueB', 'interruptLive']]) require(s[b]?.statusFacts?.jobId !== s[a]?.statusFacts?.jobId
    && s[b]?.statusFacts?.requestId !== s[a]?.statusFacts?.requestId && !!workspaceIdentity(s[b]?.statusFacts?.workspacePath)
    && !sameWorkspace(s[b]?.statusFacts?.workspacePath, s[a]?.statusFacts?.workspacePath), `${b}: different-folder Send missing or identity reused`);
  require(sameWorkspace(s.sendB?.statusFacts?.workspacePath, s.continueB?.statusFacts?.workspacePath), 'continuation did not send in B');
  require(s.interrupted?.killedPid === s.interruptLive?.statusFacts?.workerPid && s.interrupted?.onlyWorkerKilled === true
    && s.interrupted?.statusFacts?.state === 'unconfirmed' && s.interrupted?.statusFacts?.live === false
    && !s.interrupted?.statusFacts?.outcome && sameJob(s.interrupted?.statusFacts, s.interruptLive?.statusFacts), 'worker interruption/unconfirmed identity unproved');
  const h = s.heldFolder;
  require(h?.emptyAfterContinue === true && h.holdNoteVisible === true && h.sendDisabled === true
    && h.refusal?.backgroundStartRefused === true && h.refusal?.code === 'background-job-conflict'
    && h.admissionsUnchanged === true && h.oldJobUnreplayed === true && h.oldStatus?.acknowledgedStuckAt
    && !terminal(h.oldStatus) && h.oldStatus?.live === false && sameJob(h.oldStatus, s.interruptLive?.statusFacts), 'held folder was offered/admitted or its hold/replay state unproved');
  require(report.cleanup?.ok === true && report.cleanup?.profilesRetained === true && report.cleanup?.remainingOwnedPids?.length === 0, 'cleanup failed or unproved');
  const review = report.visualReview;
  for (const state of REQUIRED_SCREENSHOTS) for (const width of WIDTHS) {
    const shot = report.screenshots?.find(p => p.state === state && p.requested?.width === width);
    const inspected = review?.inspections?.find(p => p.sha256 === shot?.sha256 && p.path === shot?.path);
    require(!!shot && shot.viewport?.width === width && shot.geometry?.horizontalOverflow === false, `screenshot missing/clipped: ${state}/${width}`);
    require(!!inspected && inspected.acceptable === true && typeof inspected.observation === 'string' && inspected.observation.trim().length > 0
      && typeof review?.reviewer === 'string' && review.reviewer.trim().length > 0, `PNG not personally reviewed: ${state}/${width}`);
  }
  return { status: failures.length ? (report.blocked && !(report.errors?.length) ? 'blocked' : 'failed') : 'passed', failures: [...new Set(failures)] };
}

export function parseCli(argv) {
  const result = {};
  const names = { '--package': 'packageRoot', '--out': 'outDir', '--pwsh': 'pwshPath' };
  for (let i = 0; i < argv.length; i += 2) {
    const name = names[argv[i]];
    invariant(name && !result[name] && argv[i + 1] && !argv[i + 1].startsWith('--'), 'Usage: node windows-packaged-journey.mjs --package <dir> --out <fresh-dir> --pwsh <exe>');
    result[name] = path.resolve(argv[i + 1]);
  }
  invariant(Object.keys(result).length === 3, 'Explicit --package, --out and --pwsh are required');
  return result;
}

export function journeyEnvironment(inherited = process.env) {
  const env = { ...inherited };
  // Preserve the installed real harnesses, their PATH and existing login. No
  // test profile, consent override, harness checkout, stub bin or loader hook.
  for (const key of Object.keys(env)) if (/^GOALPORT_/i.test(key) || /^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/i.test(key)) delete env[key];
  return env;
}

function readRunnerIdentity() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  let gitDir = path.join(root, '.git');
  if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(root, fs.readFileSync(gitDir, 'utf8').trim().replace(/^gitdir:\s*/, ''));
  const common = fs.existsSync(path.join(gitDir, 'commondir')) ? path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()) : gitDir;
  let revision = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  if (revision.startsWith('ref: ')) {
    const ref = revision.slice(5);
    const loose = [path.join(gitDir, ref), path.join(common, ref)].find(p => fs.existsSync(p));
    revision = loose ? fs.readFileSync(loose, 'utf8').trim() : fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split(/\r?\n/).find(line => line.endsWith(` ${ref}`))?.split(' ')[0];
  }
  invariant(/^[a-f0-9]{40}$/i.test(revision ?? ''), 'Cannot read runner full revision without invoking git');
  return { revision, scriptSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), revisionSource: 'read-only HEAD/ref files; script hash identifies local edits' };
}

export function validatePrerequisites({ packageRoot, outDir, pwshPath }, platform = process.platform) {
  invariant(platform === 'win32', 'Packaged journey requires native Windows');
  for (const [filename, label] of [[path.join(packageRoot, 'GoalPort.exe'), 'GoalPort.exe'], [pwshPath, 'pwsh']]) invariant(fs.existsSync(filename) && fs.statSync(filename).isFile(), `Missing ${label}: ${filename}`);
  const probe = spawnSync(pwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 10000 });
  invariant(probe.status === 0 && Number(probe.stdout.trim()) >= 7, 'Working PowerShell 7 --pwsh executable required');
  const manifestPath = path.join(packageRoot, 'package-manifest.json');
  const manifest = json(manifestPath);
  invariant(/^[a-f0-9]{40}$/i.test(manifest.source?.revision ?? '') && manifest.source?.dirty === false, 'Package must identify a full clean built source revision (source.dirty:false)');
  // Reject even an empty existing directory: profiles/evidence are never reused.
  invariant(!fs.existsSync(outDir), 'Output already exists; use a fresh --out, never reuse a profile/evidence directory');
  for (let p = outDir; p !== path.dirname(p); p = path.dirname(p)) invariant(!fs.existsSync(p) || !fs.lstatSync(p).isSymbolicLink(), 'Symlink output ancestors are refused');
  const relativeOutput = path.relative(packageRoot, outDir);
  invariant(relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput), 'Output cannot be inside the candidate package');
  return { manifest, manifestPath, manifestSha256: sha(fs.readFileSync(manifestPath)), exeSha256: sha(fs.readFileSync(path.join(packageRoot, 'GoalPort.exe'))) };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
async function waitFor(read, accept, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  do { last = await read(); if (await accept(last)) return last; await sleep(250); } while (Date.now() < deadline);
  throw new Error(`${label} timed out; last facts: ${JSON.stringify(last)}`);
}
function progressKey(p) { return JSON.stringify({ completed: p.completedCommands, pending: p.pendingCommand, counters: p.counters, display: p.display }); }

export async function runPackagedJourney(options) {
  const { packageRoot, outDir, pwshPath } = options;
  const identity = validatePrerequisites(options);
  const runnerIdentity = readRunnerIdentity();
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.mkdirSync(outDir);
  const shotsDir = path.join(outDir, 'screenshots'); fs.mkdirSync(shotsDir);
  const env = journeyEnvironment();
  const report = {
    schemaVersion: 2, startedAt: new Date().toISOString(), packageRoot,
    evidenceKind: 'packaged CDP UI input + real installed harnesses; not native mouse/keyboard acceptance',
    packageIdentity: { source: identity.manifest.source, version: identity.manifest.version, builtAtUtc: identity.manifest.builtAtUtc, manifestPath: identity.manifestPath, manifestSha256: identity.manifestSha256, exeSha256: identity.exeSha256 }, runnerIdentity,
    launchEnvironment: { absent: Object.fromEntries(FORBIDDEN_ENV.map(key => [key, !Object.keys(env).some(k => k.toUpperCase() === key)])), pathUnmodified: env.PATH === process.env.PATH, testProfile: false },
    stages: {}, screenshots: [], errors: [], processActions: [], profiles: [], cleanup: { ok: false },
    nativeWalkthrough: { status: 'not-performed', note: 'Parent must perform and label complementary native mouse/keyboard walkthrough separately.' },
  };
  const save = () => {
    writeJson(path.join(outDir, 'journey-report.json'), report);
    writeJson(path.join(outDir, 'screenshot-manifest.json'), { revision: identity.manifest.source.revision, source: identity.manifest.source, runnerIdentity, packageIdentity: report.packageIdentity, screenshots: report.screenshots });
  };
  const ps = command => {
    const result = spawnSync(pwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    invariant(result.status === 0, `PowerShell failed: ${result.stderr || result.error?.message}`);
    return result.stdout.trim();
  };
  const processes = () => JSON.parse(ps('ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name="CreationDate";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}},ExecutablePath,CommandLine)'));
  const fingerprint = p => `${p.ProcessId}/${p.CreationDate}/${p.ExecutablePath}`;
  const owned = new Map();
  const sessions = [];
  let session;
  function inventory() {
    const all = processes();
    // Only adopt descendants of still-identical owned parents, not reused PIDs.
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of all) {
        const parent = all.find(a => a.ProcessId === p.ParentProcessId);
        if (!owned.has(fingerprint(p)) && parent && owned.has(fingerprint(parent))) { owned.set(fingerprint(p), p); changed = true; }
      }
    }
    return all.filter(p => owned.has(fingerprint(p)));
  }
  function adoptProfileProcesses() {
    for (const s of sessions) {
      if (!s.dataPath) continue;
      for (const p of processes()) {
        if (!owned.has(fingerprint(p)) && profileProcessMatch(p, s.dataPath, packageRoot, process.execPath)) owned.set(fingerprint(p), p);
      }
    }
  }
  function killIdentified(p, reason) {
    const current = processes().find(c => fingerprint(c) === fingerprint(p));
    if (!current) return;
    invariant(owned.has(fingerprint(current)), 'Refusing to kill a process not proven owned');
    // Recheck creation time inside PowerShell immediately before Stop-Process.
    const stamp = String(p.CreationDate).replace(/'/g, "''");
    ps(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${p.ProcessId}'; if ($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '${stamp}') { Stop-Process -Id ${p.ProcessId} -Force -ErrorAction Stop } elseif ($p) { throw 'PID creation time changed; refused' }`);
    report.processActions.push({ pid: p.ProcessId, creationDate: p.CreationDate, executablePath: p.ExecutablePath, reason, onlyThisPid: true });
  }
  const infoFor = async () => session.app.evaluate('window.goalportCore.appInfo()', true);
  function admissions(s = session) {
    const dir = path.join(s.dataPath, 'coordination-jobs', 'jobs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(id => /^[a-f0-9-]{36}$/i.test(id)).sort().map(id => {
      const filename = path.join(dir, id, 'admission.json'); const bytes = fs.readFileSync(filename);
      return { ...JSON.parse(bytes), sha256: sha(bytes) };
    });
  }
  function progress(jobId, s = session) { return json(path.join(s.dataPath, 'coordination-jobs', 'jobs', jobId, 'progress.json')); }
  const status = async jobId => session.app.evaluate(`window.goalportCore.backgroundStatus(${JSON.stringify(jobId)})`, true);
  async function rendered(facts) {
    return session.app.evaluate(`(() => {
      const root = document.querySelector('.background-job');
      const visible = e => { if (!e) return false; const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(e).visibility !== 'hidden'; };
      const s = ${JSON.stringify(facts)};
      const activity = root?.querySelector('.coordination-progress-activity');
      const results = [...(root?.querySelectorAll('.coordination-result') ?? [])].filter(visible).map(e => e.innerText);
      return {jobId:root?.getAttribute('data-job-id'), goal:root?.querySelector('h2')?.textContent,
        progressMatched:visible(activity) && !!s.progress?.activity && activity.textContent === s.progress.activity,
        commandMatched:s.completedCommands.some(c => c.facts?.dispatched === true && c.facts.text?.trim() && results.some(text => text.includes(c.facts.text)))
          || (visible(activity) && !!s.pendingCommand?.commandId && [...root.querySelectorAll('.technical-details p')].some(p=>p.textContent.includes(s.pendingCommand.commandId))),
        activity:activity?.textContent, resultCount:results.length,
        consentError:root?.innerText.includes('Background Send is not enabled') || false};
    })()`);
  }
  async function clickText(text, scope = 'body') {
    // Exact text locates the real control; a temporary selector attribute is
    // unnecessary. Pass its center through CDP after the same hit-test checks.
    const point = await session.app.evaluate(`(() => {
      const b=[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')||e.textContent.trim())===${JSON.stringify(text)});
      if(!b||b.disabled)throw Error('control absent/disabled'); b.scrollIntoView({block:'center'});
      const r=b.getBoundingClientRect(), x=r.x+r.width/2,y=r.y+r.height/2,t=document.elementFromPoint(x,y);
      if(!r.width||!r.height||!(t===b||b.contains(t)))throw Error('control not hit-testable'); return {x,y};
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await session.app.cdp('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await sleep(150);
  }
  async function launch(profileDir, label) {
    const port = await freePort();
    const child = spawn(path.join(packageRoot, 'GoalPort.exe'), ['--data-dir', profileDir, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: packageRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const s = { child, profileDir, label, app: null, exit: null, dataPath: null };
    sessions.push(s); session = s;
    child.on('error', error => { s.exit = { error: error.message }; });
    child.on('exit', (code, signal) => { s.exit = { code, signal, observedAt: new Date().toISOString() }; });
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', data => fs.appendFileSync(path.join(outDir, `${label}-${name}.log`), data));
    const root = await waitFor(() => processes().find(p => p.ProcessId === child.pid), p => p && sameWorkspace(p.ExecutablePath, path.join(packageRoot, 'GoalPort.exe')), 'spawned GoalPort process identity', 10000);
    owned.set(fingerprint(root), root); inventory();
    s.app = await attachApp(port, { electronPid: child.pid, pwshPath });
    // bootstrapCurrent is asynchronous. Await the result, never Boolean(Promise).
    await s.app.until('(async () => !!window.goalportCore && (await window.goalportCore.bootstrapCurrent()).phase === "done")()', 45000);
    const info = await infoFor();
    invariant(sameWorkspace(info.dataPath, profileDir), `App opened a different durable profile: ${info.dataPath}`);
    s.dataPath = info.dataPath;
    if (!report.profiles.includes(profileDir)) report.profiles.push(profileDir);
    inventory(); save();
    return s;
  }
  async function closeNormally(s = session) {
    invariant(s.app && !s.exit, 'Cannot close an absent/exited app'); inventory();
    // The real user closes the window; the main process decides from its
    // cached attempt facts and prompts if a foreground attempt is active.
    // requestClose() refreshes that cache from Core first, which can block
    // behind a harness turn (the MY-116 risk); the window control does not.
    try { await s.app.evaluate('window.close()', true); }
    catch { /* the target may disappear before the CDP reply; exit decides */ }
    const deadline = Date.now() + 15000;
    let continued = false;
    while (!s.exit && Date.now() < deadline) {
      try {
        const shown = await s.app.evaluate(`!![...document.querySelectorAll('.close-choice-dialog button')].find(b=>b.textContent.trim()==='Continue in background')`);
        if (shown && !continued) {
          try { await clickText('Continue in background', '.close-choice-dialog'); continued = true; }
          catch { /* the dialog may vanish as the window exits */ }
        }
      } catch { /* the target may vanish while the window closes; exit check below decides */ }
      await sleep(150);
    }
    invariant(s.exit?.code === 0 && !s.exit?.signal && !s.exit?.error, `Normal window close failed; forced kill is not a close: ${JSON.stringify(s.exit)}`);
    s.app.close(); s.app = null;
    return { normalClose: true, forced: false, continued, exit: s.exit };
  }
  async function capture(state, jobId) {
    for (const width of WIDTHS) {
      if (jobId) { const s = await status(jobId); invariant(s?.live && !terminal(s), `Job terminated before required ${state} screenshot`); }
      const shot = await session.app.screenshot(shotsDir, state, width); report.screenshots.push(shot); save();
      invariant(!shot.geometry.horizontalOverflow, `Horizontal clipping in ${state}/${width}`);
    }
  }
  async function newDraft() {
    await clickText('New goal');
    await session.app.until('!!document.querySelector("#draft-workspace")', 10000);
  }
  async function prepareDraft(workspace, goal, takeShots = false) {
    await session.app.until('!!document.querySelector("#draft-workspace")', 10000);
    await session.app.input('#draft-workspace', workspace);
    await session.app.input('#draft-message', goal);
    await session.app.until('!!document.querySelector(".draft-background-consent input")', 10000);
    if (!await session.app.evaluate('document.querySelector(".draft-background-consent input").checked')) await session.app.click('.draft-background-consent input');
    await session.app.until('!!document.querySelector(".authorization-panel")', 15000);
    if (await session.app.evaluate(`!![...document.querySelectorAll('.authorization-panel button')].find(b=>b.textContent.trim()==='Allow GoalPort to run harness turns on this profile')`)) await clickText('Allow GoalPort to run harness turns on this profile', '.authorization-panel');
    await waitFor(() => infoFor(), info => info.coordinationConfigured === true, 'durable profile consent', 10000);
    const discovery = await session.app.evaluate(`window.goalportCore.coordinateDiscover(${JSON.stringify(`journey-discovery-${crypto.randomUUID()}`)})`, true);
    report.lastDiscovery = discovery;
    const harnesses = await session.app.evaluate(`Array.from(document.querySelectorAll('.authorization-row[data-instance]')).filter(e => e.querySelector('input[aria-label^="Select "]:not(:disabled)')).map(e=>({id:e.getAttribute('data-instance'),name:e.querySelector('label')?.innerText.trim()}))`);
    const real = harnesses.filter(h => !/scenario|synthetic|stub|fake/i.test(`${h.id} ${h.name}`));
    if (real.length < 2) throw blocked(`At least two real selectable harnesses required; found ${JSON.stringify(real)}`);
    for (const h of real) {
      const selector = `.authorization-row[data-instance=${JSON.stringify(h.id)}] input[aria-label^="Select "]`;
      if (!await session.app.evaluate(`document.querySelector(${JSON.stringify(selector)}).checked`)) await session.app.click(selector);
    }
    await session.app.input('#authorization-turns', '8');
    invariant(await session.app.evaluate(`![...document.querySelectorAll('input[aria-label^="Allow changes through "]')].some(e=>e.checked)`), 'Journey must not silently grant file changes');
    await session.app.until('!!document.querySelector(".draft-composer-form button[type=submit]") && !document.querySelector(".draft-composer-form button[type=submit]").disabled', 10000);
    if (takeShots) await capture('draft-access');
    return real;
  }
  async function send(workspace, goal) {
    const before = admissions(); const beforeIds = before.map(a => a.jobId);
    const sentAt = Date.now();
    await session.app.click('.draft-composer-form button[type=submit]');
    let lastProcessCheck = 0, lastDispatch = null;
    const evidence = await waitFor(async () => {
      const all = admissions(); const fresh = all.filter(a => !beforeIds.includes(a.jobId));
      invariant(fresh.length <= 1, 'One Send created multiple admissions');
      const admission = fresh[0]; if (!admission) return { admission: null };
      invariant(admission.input.goal === goal && sameWorkspace(admission.input.workspacePath, workspace), 'Send admission goal/workspace mismatch');
      invariant(Date.parse(admission.createdAt) >= sentAt - 1000, 'Send reused an old admission');
      const facts = await status(admission.jobId);
      invariant(!terminal(facts) && !facts?.outcome, `Job terminated before required live actions: ${JSON.stringify(facts)}`);
      const view = facts ? await rendered(facts) : null;
      invariant(!view?.consentError, 'Background Send is not enabled');
      if (facts?.pendingCommand && Date.now() - lastProcessCheck > 1000) {
        lastProcessCheck = Date.now(); lastDispatch = null;
        const all = inventory();
        const marker = goal.match(/journey-[a-f0-9-]{36}/)?.[0];
        const descendants = new Set([facts.workerPid]);
        let added = true;
        while (added) { added = false; for (const p of all) if (!descendants.has(p.ProcessId) && descendants.has(p.ParentProcessId)) { descendants.add(p.ProcessId); added = true; } }
        const cli = all.find(p => p.ProcessId !== facts.workerPid && descendants.has(p.ProcessId) && marker && p.CommandLine?.includes(marker)
          && Date.parse(p.CreationDate) >= Date.parse(facts.pendingCommand.recordedAt) - 1000);
        const ledgerPath = path.join(session.dataPath, 'harness-state', 'sent-turns.json');
        const ledger = fs.existsSync(ledgerPath) ? json(ledgerPath) : {};
        if (cli) lastDispatch = { commandId: facts.pendingCommand.commandId, workerPid: facts.workerPid, pid: cli.ProcessId, executablePath: cli.ExecutablePath,
          createdAt: cli.CreationDate, fromOwnedWorker: true, promptMarker: marker, commandLineSha256: sha(cli.CommandLine), ledgerMessageDispatched: ledger[facts.pendingCommand.commandId]?.messageDispatched === true };
      }
      return { status: 'passed', admission, statusFacts: facts, rendered: view, dispatch: lastDispatch, sent: true, sentAt: new Date(sentAt).toISOString() };
    }, liveEvidenceIsValid, 'matching live admission + real dispatched command + rendered progress', 180000);
    const after = admissions();
    invariant(before.every(a => after.some(b => b.jobId === a.jobId && b.sha256 === a.sha256)), 'New Send changed a previous immutable admission');
    inventory(); return evidence;
  }
  async function stopJob(live) {
    const selector = '.background-job button[aria-label="Stop"]';
    const control = await session.app.evaluate(`(() => { const b=document.querySelector(${JSON.stringify(selector)}); if(!b)return {visible:false,enabled:false,hitTestable:false}; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(), t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return {visible:r.width>0&&r.height>0&&getComputedStyle(b).visibility!=='hidden',enabled:!b.disabled,hitTestable:t===b||b.contains(t)}; })()`);
    invariant(stopIsUsable(control), `Stop absent, disabled or not hit-testable: ${JSON.stringify(control)}`);
    const before = await status(live.statusFacts.jobId); invariant(before.live && !terminal(before), 'Job terminated before Stop');
    await session.app.click(selector);
    const final = await waitFor(() => status(live.statusFacts.jobId), settled, 'revoked and settled stopped outcome; no active/pending/live worker', 300000);
    const commandIds = final.completedCommands.map(c => c.commandId);
    await sleep(1500);
    const later = await status(live.statusFacts.jobId);
    invariant(settled(later) && JSON.stringify(commandIds) === JSON.stringify(later.completedCommands.map(c => c.commandId)), 'Dispatch occurred after Stop settlement');
    await waitFor(() => inventory().some(p => p.ProcessId === live.statusFacts.workerPid), exists => !exists, 'stopped worker process exit', 10000);
    return { control, clicked: true, statusFacts: later, noLaterDispatch: true, workerExited: true };
  }

  const workspaceA = path.join(outDir, 'workspace-a'), workspaceB = path.join(outDir, 'workspace-b');
  const goal = `Inspect the supplied project notes thoroughly, then prepare a detailed implementation plan and an independent check. Consider at least ten concrete edge cases. Do not change files. This is a real background continuation acceptance goal (journey-${crypto.randomUUID()}).`;
  try {
    for (const dir of [workspaceA, workspaceB]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'project-notes.txt'), 'A small offline notes app: create, edit, search, archive and restore notes. Plan accessibility, persistence, recovery, empty states, keyboard access, tests and migration. No code changes are authorized.\n', { flag: 'wx' });
    }
    const profile = path.join(outDir, 'normal-profile');
    await launch(profile, 'normal');
    const realHarnesses = await prepareDraft(workspaceA, goal, true);
    report.stages.draftAccess = { status: 'passed', realHarnesses, consent: await session.app.evaluate('window.goalportCore.backgroundSendConsent("read")', true) };
    report.stages.liveA = { ...await send(workspaceA, goal), stage: 'liveA' };
    const liveA = report.stages.liveA;
    await capture('live', liveA.statusFacts.jobId);
    const beforeClose = progress(liveA.statusFacts.jobId);
    const admissionSet = admissions();
    const closed = await closeNormally();
    // The window is gone; the admitted worker and its CLI descendant must
    // still be doing the goal's work. A completed turn is stronger evidence
    // but timing-dependent, so a live pending CLI process is the required
    // fact; a completed dispatched command is also accepted.
    const closedProgress = await waitFor(() => {
      const p = progress(liveA.statusFacts.jobId);
      invariant(!terminal(p) && !p.outcome, 'Job terminated while closed before reopen/Stop');
      const dispatchAlive = Boolean(liveA.dispatch?.pid) && inventory().some(proc => proc.ProcessId === liveA.dispatch.pid && proc.CreationDate === liveA.dispatch.createdAt);
      return { p, dispatchAlive, completed: dispatched(p).length, key: progressKey(p) };
    }, v => v.dispatchAlive || v.completed > 0, 'background harness work continued while the window was closed', 30000);
    await launch(profile, 'reopened');
    if (!await session.app.evaluate('!!document.querySelector(".background-job")')) await clickText('Return to background goal');
    const reopened = await waitFor(() => status(liveA.statusFacts.jobId), s => s?.live === true, 'reopened live control acknowledgement', 10000);
    invariant(sameJob(liveA.statusFacts, reopened), 'Reopen returned a different goal/job/request/workspace');
    const view = await waitFor(() => rendered(reopened), r => r.progressMatched && r.commandMatched, 'reopened rendered retained progress', 10000);
    invariant(JSON.stringify(admissionSet) === JSON.stringify(admissions()), 'Reopen duplicated or changed an admission');
    report.stages.closeReopen = { status: 'passed', ...closed, statusFacts: reopened, rendered: view, admissionsUnchanged: true,
      backgroundWorkContinued: closedProgress.dispatchAlive || closedProgress.completed > 0,
      completedWhileClosed: closedProgress.completed > 0,
      retainedCommandIds: (closedProgress.p.completedCommands ?? []).filter(c => c.facts?.dispatched === true).map(c => c.commandId),
      pendingAtClose: closedProgress.p.pendingCommand?.commandId ?? null,
      beforeClose, closedProgress: closedProgress.p };
    await capture('reopened', reopened.jobId);
    report.stages.stopA = { status: 'passed', ...await stopJob(liveA) };
    await capture('stopped');
    await clickText('New send for this goal', '.background-job');
    await session.app.until('!!document.querySelector("#draft-workspace")', 10000);
    invariant(sameWorkspace(await session.app.evaluate('document.querySelector("#draft-workspace").value'), workspaceA), 'Confirmed terminal release did not prefill released A');
    await prepareDraft(workspaceA, goal);
    report.stages.resendA = await send(workspaceA, goal);
    report.stages.stopResendA = { status: 'passed', ...await stopJob(report.stages.resendA) };
    await newDraft(); await prepareDraft(workspaceB, `${goal} Workspace B.`);
    report.stages.sendB = await send(workspaceB, `${goal} Workspace B.`);
    report.stages.stopB = { status: 'passed', ...await stopJob(report.stages.sendB) };
    await closeNormally();

    await launch(path.join(outDir, 'interrupted-profile'), 'interrupted');
    await prepareDraft(workspaceA, goal);
    report.stages.interruptLive = await send(workspaceA, goal);
    const interruptedLive = report.stages.interruptLive;
    const worker = inventory().find(p => p.ProcessId === interruptedLive.statusFacts.workerPid);
    invariant(worker && worker.CommandLine?.includes(interruptedLive.statusFacts.jobId) && worker.CommandLine?.includes('coordination-worker'), 'Worker PID is not proven to belong to this admission');
    const oldCommands = progress(interruptedLive.statusFacts.jobId).completedCommands;
    killIdentified(worker, 'intentional interruption of status.workerPid after proven dispatch; not a normal close');
    const interrupted = await waitFor(() => status(interruptedLive.statusFacts.jobId), s => s?.state === 'unconfirmed' && !s.live, 'honest unconfirmed worker interruption', 15000);
    invariant(!interrupted.outcome, 'Interruption was falsely made terminal');
    report.stages.interrupted = { status: 'passed', killedPid: worker.ProcessId, onlyWorkerKilled: true, statusFacts: interrupted };
    await waitFor(() => session.app.evaluate(`!![...document.querySelectorAll('.background-job button')].find(b=>b.textContent.trim()==='Continue in a new send')`), Boolean, 'interrupted Continue affordance', 10000);
    await clickText('Continue in a new send', '.background-job');
    await session.app.until('!!document.querySelector("#draft-workspace")', 10000);
    const emptyAfterContinue = await session.app.evaluate('document.querySelector("#draft-workspace").value === ""');
    const note = await session.app.evaluate(`Array.from(document.querySelectorAll('.dialog-note, [role="note"], .revision-note')).map(e=>e.innerText).join(String.fromCharCode(10))`);
    invariant(emptyAfterContinue && /folder/i.test(note) && /held|unfinished|another|different/i.test(note), 'Interrupted continuation must leave folder empty with an honest hold note');
    await session.app.input('#draft-workspace', workspaceA);
    await sleep(500);
    const sendDisabled = await session.app.evaluate('document.querySelector(".draft-composer-form button[type=submit]")?.disabled === true');
    invariant(sendDisabled, 'Held folder is offered as sendable');
    const beforeHeld = admissions();
    // Exercise the real existing admission boundary independently of disabled UI.
    // This is a NEW request, not a retry/replay of the interrupted request.
    const refusal = await session.app.evaluate(`window.goalportCore.backgroundStart(${JSON.stringify({ requestId: `journey-held-${crypto.randomUUID()}`, goal, workspaceRoot: workspaceA, readInstances: interruptedLive.admission.input.allowedInstances, readMaxTurns: 8, backgroundConsent: true })})`, true);
    invariant(refusal?.backgroundStartRefused === true && refusal.code === 'background-job-conflict', `Held-folder admission was not refused: ${JSON.stringify(refusal)}`);
    invariant(JSON.stringify(beforeHeld) === JSON.stringify(admissions()), 'Held-folder refusal created/changed an admission');
    const oldStatus = await status(interruptedLive.statusFacts.jobId);
    invariant(oldStatus.acknowledgedStuckAt && !oldStatus.live && !terminal(oldStatus) && JSON.stringify(progress(interruptedLive.statusFacts.jobId).completedCommands) === JSON.stringify(oldCommands), 'Interrupted job was replayed/released');
    report.stages.heldFolder = { status: 'passed', emptyAfterContinue, holdNoteVisible: /folder/i.test(note), holdNote: note, sendDisabled, refusal, admissionsUnchanged: true, oldJobUnreplayed: true, oldStatus };
    await capture('interrupted-held');
    await prepareDraft(workspaceB, goal);
    report.stages.continueB = await send(workspaceB, goal);
    await capture('b-start', report.stages.continueB.statusFacts.jobId);
    report.stages.stopContinueB = { status: 'passed', ...await stopJob(report.stages.continueB) };
    const stillHeld = await status(interruptedLive.statusFacts.jobId);
    invariant(!stillHeld.live && !terminal(stillHeld) && stillHeld.acknowledgedStuckAt, 'Old interrupted folder was falsely released after B send');
  } catch (error) {
    if (error.blocked) { report.blocked = error.message; } else report.errors.push(error.stack || error.message);
  } finally {
    const cleanupErrors = [];
    try {
      for (const s of sessions.filter(s => s.app && !s.exit)) {
        session = s;
        // On failure revoke any live admission through the existing bridge;
        // never write terminal state, delete a profile or replay a command.
        for (const a of admissions(s)) {
          const facts = await status(a.jobId);
          if (facts?.live && !terminal(facts)) {
            await s.app.evaluate(`window.goalportCore.backgroundRevoke(${JSON.stringify(a.jobId)})`, true);
            await waitFor(() => status(a.jobId), s => !s?.live && !s?.pendingCommand, 'cleanup live settlement', 30000);
          }
        }
        await closeNormally(s);
      }
    } catch (error) { cleanupErrors.push(error.message); }
    try {
      // Owned residual tools/Core may remain after the deliberately killed
      // worker. End ONLY previously fingerprinted descendants, no name kills.
      // The app that parented Core may already be gone; adopt by the profile
      // path recorded in the process command line before deciding nothing is left.
      adoptProfileProcesses();
      const remaining = inventory();
      for (const p of remaining.reverse()) killIdentified(p, 'owned final cleanup; profile and unconfirmed facts retained');
      await sleep(1000);
      const remainingOwned = inventory();
      report.cleanup = { ok: cleanupErrors.length === 0 && remainingOwned.length === 0, profilesRetained: report.profiles.every(p => fs.existsSync(p)), remainingOwnedPids: remainingOwned.map(p => p.ProcessId), errors: cleanupErrors };
    } catch (error) { cleanupErrors.push(error.message); report.cleanup = { ok: false, errors: cleanupErrors, profilesRetained: true }; }
    for (const s of sessions) {
      s.app?.close();
      // An owned-cleanup failure must still produce a bounded nonzero CLI,
      // not leave Node waiting forever on a failed child's inherited pipes.
      s.child.stdout?.destroy(); s.child.stderr?.destroy(); s.child.unref();
    }
    report.endedAt = new Date().toISOString();
    save();
  }
  // A script cannot personally inspect pixels. Require an explicit external
  // inspection of each PNG, keyed by exact bytes, rather than inventing notes.
  // Parent can read PNGs concurrently and supply this file during the bounded
  // review window. Never auto-open windows or call geometry a visual review.
  if (!report.errors.length && !report.blocked && report.cleanup.ok) {
    report.visualReviewPending = { file: path.join(outDir, 'visual-review.json'), timeoutMs: 120000, schema: { reviewer: 'name/session', inspections: [{ path: 'absolute screenshot path', sha256: 'exact PNG hash', acceptable: true, observation: 'first-user observation after personally opening this PNG' }] } };
    save(); console.error(`[journey] Inspect every PNG; write ${report.visualReviewPending.file} within 120 seconds. Native walkthrough remains separate.`);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (fs.existsSync(report.visualReviewPending.file)) {
        try { report.visualReview = json(report.visualReviewPending.file); break; } catch { /* allow atomic external write to complete */ }
      }
      await sleep(500);
    }
    if (!report.visualReview) report.blocked = 'PNG inspection not supplied within the bounded visual-review window';
  }
  const validation = validateJourney(report);
  report.status = validation.status; report.validation = validation; save();
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const report = await runPackagedJourney(parseCli(argv));
    console.log(JSON.stringify({ status: report.status, outDir: path.resolve(parseCli(argv).outDir), failures: report.validation.failures, blocked: report.blocked ?? null }, null, 2));
    return exitCodeForStatus(report.status);
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', errors: [error.message] }, null, 2));
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
