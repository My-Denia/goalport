// Issue #70 packaged-EXE acceptance (Windows, offline, no model spend).
//   node scripts/acceptance/issue70-feedback-windows.mjs --package <dir> --out <fresh dir> [--scenario a|b|both]
//        [--pwsh <pwsh.exe>] [--decision-text <sentence>]
// (a) a workflow with feedback.planRevision = 'ask': a plan check that says
//     VERDICT: revise stops with decision {automatic-off, plan}; the revision
//     chain never launches.
// (b) Recommended (no feedback module): exactly one revision chain runs.
// The app is launched as `GoalPort.exe --data-dir <fresh> --remote-debugging-port=<p>`
// (space form) with offline codex/claude stubs first on PATH. The user's real
// profile (%APPDATA%\GoalPort\*) is never opened: the Core --db path is checked
// to sit inside the fresh data dir before Send.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { attachApp } from './lib/cdp-app.mjs';
import { materializeStubBin } from './lib/stubbin.mjs';
import { createExecutionFixture, EXECUTION_PRESETS } from './lib/execution-fixture.mjs';

const { launchSpec } = createRequire(import.meta.url)('../../electron/cli-coordinate.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHIM = fileURLToPath(new URL('./lib/issue70-stub-shim.mjs', import.meta.url));
const WIDTHS = [860, 1020, 1440];
const GOAL = 'Plan the add(a,b) repair in this disposable offline fixture and only make changes the independent checks approve.';
const CHECKS = { planReview: 'on', reviewerNeeds: { readWorkspace: 'preferred' }, requirementCitation: 'quote-when-reviewer-cannot-read' };
const DEFAULT_PWSH = process.env.GOALPORT_ACCEPTANCE_PWSH || path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'Microsoft.PowerShell_8wekyb3d8bbwe', 'pwsh.exe');

const PRESET = EXECUTION_PRESETS['c4-plan-revision'];
const SCENARIOS = {
  a: {
    label: 'ask-first', workflowName: 'Ask first', feedback: { planRevision: 'ask', repair: 'automatic' },
    readTurns: 5, writeTurns: 1,
    // Only the first plan and its check may ever run; a third turn would exhaust the queue (exit 43).
    behavior: { codex: PRESET.codex.slice(0, 1), claude: PRESET.claude.slice(0, 1) },
    expectTurns: { codex: 1, claude: 1 },
  },
  b: {
    label: 'recommended', workflowName: 'Recommended workflow', feedback: null,
    readTurns: 5, writeTurns: 1,
    // plan, check:revise, revised plan, check:carry-out, execute, audit:verified
    behavior: { codex: PRESET.codex, claude: PRESET.claude },
    expectTurns: { codex: 3, claude: 3 },
  },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!['--package', '--out', '--scenario', '--pwsh', '--decision-text'].includes(k) || argv[i + 1] === undefined) throw new Error(`bad argument ${k}`);
    out[k.slice(2)] = argv[i + 1];
  }
  if (!out.package || !out.out) throw new Error('--package and --out are required');
  return { package: path.resolve(out.package), out: path.resolve(out.out), scenario: out.scenario ?? 'both', pwsh: out.pwsh ?? DEFAULT_PWSH, decisionText: out['decision-text'] ?? null };
}

const writeJson = (f, v) => fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
const readLines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) : [];
const norm = p => String(p).replaceAll('/', '\\').toLowerCase();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}

function processes(pwsh) {
  const r = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)'], { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`process list failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=acceptance', '-c', 'user.email=acceptance@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function childEnv(caseHome, stubDir, sentinel) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GOALPORT_/i.test(k) || /^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/i.test(k)) delete env[k];
  const hostPathRaw = env.PATH ?? env.Path;
  const removed = [];
  const hostPath = hostPathRaw.split(';').filter(Boolean).filter(dir => {
    const real = ['codex', 'claude'].some(n => ['.exe', '.cmd', '.bat', '.ps1', ''].some(e => { try { return fs.statSync(path.join(dir, n + e)).isFile(); } catch { return false; } }));
    if (real) removed.push(dir);
    return !real;
  }).join(';');
  childEnv.removedPathDirs = removed;
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  Object.assign(env, {
    PATH: `${stubDir};${hostPath}`, PATHEXT: '.CMD;.EXE;.COM',
    HOME: caseHome, USERPROFILE: caseHome, APPDATA: path.join(caseHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(caseHome, 'AppData', 'Local'),
    CODEX_HOME: path.join(caseHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(caseHome, '.claude'),
    GOALPORT_STUB_DIR: stubDir, GOALPORT_STUB_SENTINEL: sentinel,
  });
  for (const d of [env.APPDATA, env.LOCALAPPDATA, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(d, { recursive: true });
  return env;
}

async function runScenario(id, opts) {
  const sc = SCENARIOS[id];
  const root = path.join(opts.out, `${id}-${sc.label}`);
  const dirs = { home: path.join(root, 'home'), stub: path.join(root, 'stub'), repo: null, data: path.join(root, 'data profile'), shots: path.join(root, 'screenshots') };
  for (const d of Object.values(dirs)) if (d && d !== dirs.data) fs.mkdirSync(d, { recursive: true });
  const fixture = createExecutionFixture('c4-plan-revision');
  dirs.repo = fixture.root;

  const probes = { codex: 'codex-probe-authenticated', claude: 'claude-probe-authenticated' };
  const stub = materializeStubBin(dirs.stub, { scriptPath: SHIM, behavior: { probes, turns: sc.behavior }, executionFixture: fixture.config });
  const env = childEnv(dirs.home, dirs.stub, stub.sentinel);

  const result = { scenario: id, label: sc.label, dirs, checks: {}, notes: [], removedPathDirs: childEnv.removedPathDirs };
  const check = (name, ok, detail) => { result.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; };
  const port = await freePort();
  const exe = path.join(opts.package, 'GoalPort.exe');
  const argv = ['--data-dir', dirs.data, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--disable-features=CalculateNativeWinOcclusion'];
  result.launch = { exe, argv };
  const stdoutFd = fs.openSync(path.join(root, 'electron.stdout.log'), 'w'), stderrFd = fs.openSync(path.join(root, 'electron.stderr.log'), 'w');
  const child = spawn(exe, argv, { cwd: opts.package, env, stdio: ['ignore', stdoutFd, stderrFd] });
  let exit = null;
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  let app = null;
  try {
    app = await attachApp(port, { electronPid: child.pid, pwshPath: opts.pwsh });
    await app.cdp('Page.bringToFront');
    await app.until('(async () => !!window.goalportCore && (await window.goalportCore.bootstrapCurrent()).phase === "done")()', 60000);
    const info = await app.evaluate('window.goalportCore.appInfo()', true);
    result.appInfo = { dataPath: info.dataPath, version: info.version };
    check('dataPathIsFreshDataDir', norm(info.dataPath) === norm(dirs.data), info.dataPath);
    const dataPath = info.dataPath;

    // The workflow: saved through the app's own IPC (the editor path is covered by the UI worker's tests).
    let workflowId = null;
    if (sc.feedback) {
      const saved = await app.evaluate(`window.goalportCore.workflowsSave(${JSON.stringify({ name: sc.workflowName, modules: { checks: CHECKS, feedback: sc.feedback } })})`, true);
      result.workflowSave = saved;
      workflowId = saved?.saved?.id ?? saved?.value?.saved?.id ?? saved?.data?.saved?.id ?? null;
      check('workflowSaved', !!workflowId, JSON.stringify(saved).slice(0, 300));
      // The renderer reads the saved list when it loads; reload so the picker shows the new workflow.
      await app.cdp('Page.reload');
      await sleep(1500);
      await app.until('(async () => !!window.goalportCore && (await window.goalportCore.bootstrapCurrent()).phase === "done")()', 60000);
    }

    // New goal -> workspace, goal, workflow.
    await app.click('button[aria-label="New goal"]');
    await app.until('!!document.querySelector("#draft-workspace")', 15000);
    await app.input('#draft-workspace', dirs.repo);
    await app.input('#draft-message', GOAL);
    await app.click('.draft-runtime-picker [aria-label="Select agent"]');
    await app.until(`[...document.querySelectorAll('[role="option"]')].some(e => e.querySelector('strong')?.textContent.trim() === ${JSON.stringify(sc.workflowName)})`, 15000);
    const point = await app.evaluate(`(() => { const e=[...document.querySelectorAll('[role="option"]')].find(e=>e.querySelector('strong')?.textContent.trim()===${JSON.stringify(sc.workflowName)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`, true);
    for (const type of ['mousePressed', 'mouseReleased']) await app.cdp('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await sleep(400);
    result.pickerAfterChoice = (await app.evaluate('document.body.innerText', true)).slice(0, 3000);

    // Durable consent for agent turns on this profile, then the two agents.
    if (await app.evaluate(`!![...document.querySelectorAll('.authorization-panel button')].find(b=>b.textContent.trim()==='Allow GoalPort to run agent turns on this profile')`)) {
      const p2 = await app.evaluate(`(() => { const b=[...document.querySelectorAll('.authorization-panel button')].find(b=>b.textContent.trim()==='Allow GoalPort to run agent turns on this profile'); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`, true);
      for (const type of ['mousePressed', 'mouseReleased']) await app.cdp('Input.dispatchMouseEvent', { type, ...p2, button: 'left', clickCount: 1 });
      await sleep(500);
    }
    await app.until('!!document.querySelector(\'input[aria-label="Select Codex"]:not(:disabled)\') && !!document.querySelector(\'input[aria-label="Select Claude"]:not(:disabled)\')', 30000);
    for (const name of ['Codex', 'Claude']) {
      const sel = `input[aria-label="Select ${name}"]`;
      if (!await app.evaluate(`document.querySelector(${JSON.stringify(sel)}).checked`)) await app.click(sel);
    }
    await app.input('#authorization-turns', String(sc.readTurns));
    for (const name of ['Codex', 'Claude']) await app.click(`input[aria-label="Allow changes through ${name}"]`);
    await app.input('#authorization-write-turns', String(sc.writeTurns));
    result.draftText = await app.evaluate('document.body.innerText', true);
    result.screenshots = [];
    result.screenshots.push(await app.screenshot(dirs.shots, 'draft', 1020));

    // Prove the Core is this fresh profile's before Send.
    const procs = processes(opts.pwsh);
    const cores = procs.filter(p => /goalport-core\.exe$/i.test(p.ExecutablePath ?? '') && norm(p.ExecutablePath).startsWith(norm(opts.package)));
    const ours = cores.filter(p => norm(p.CommandLine ?? '').includes(norm(dirs.data)));
    result.coreProof = ours.map(p => ({ pid: p.ProcessId, commandLine: p.CommandLine }));
    const dbArg = ours[0]?.CommandLine?.match(/--db\s+"?([^"]+?)"?(\s+--|\s*$)/)?.[1];
    result.coreDbArg = dbArg ?? null;
    check('coreDbInsideFreshDataDir', !!dbArg && norm(dbArg).startsWith(norm(dirs.data) + '\\'), dbArg);
    check('noOtherCoreOnRealProfile', !cores.some(p => /\\goalport\\(dev|rc)\\/i.test(p.CommandLine ?? '')), cores.map(p => p.ProcessId).join(','));
    if (!result.checks.coreDbInsideFreshDataDir.ok) throw new Error('Core --db is not inside the fresh data dir; refusing to Send');

    // No-spend gate: discovery must resolve to the stubs and have probed them, never a real CLI.
    const callsFile = path.join(dirs.stub, 'issue70-calls.jsonl');
    const spec = name => JSON.stringify(launchSpec(name, [], env, 'win32'));
    for (const idn of ['codex', 'claude']) {
      check(`${idn}ResolvesToStub`, spec(idn) === spec(path.join(dirs.stub, `${idn}.CMD`)), JSON.stringify(launchSpec(idn, [], env, 'win32')).slice(0, 200));
    }
    const probeDeadline = Date.now() + 20000;
    let probes0 = [];
    while (Date.now() < probeDeadline) {
      probes0 = readLines(path.join(dirs.stub, 'invocations.jsonl')).filter(i => i.invocationType === 'probe');
      if (['codex', 'claude'].every(idn => probes0.some(p => p.identity === idn))) break;
      await sleep(300);
    }
    check('stubsProbedBeforeSend', ['codex', 'claude'].every(idn => probes0.some(p => p.identity === idn)) && probes0.every(p => p.behaviorId !== 'sentinel-refused'), probes0.map(p => `${p.identity}:${p.behaviorId}`).join(','));
    if (!Object.values(result.checks).every(c => c.ok)) throw new Error('No-spend gate failed; refusing to Send');

    const turnsNow = () => readLines(callsFile).filter(c => c.invocationType === 'turn');
    const beforeSend = turnsNow().length;
    await app.click('button[aria-label="Send message"]');

    // Wait for the run to settle: a saved record, and no new turn for a quiet stretch.
    const recordsFile = path.join(dataPath, 'coordination-records.json');
    const expected = sc.expectTurns.codex + sc.expectTurns.claude;
    const deadline = Date.now() + 180000;
    let quietSince = null, lastCount = -1;
    while (Date.now() < deadline) {
      const n = turnsNow().length;
      if (n !== lastCount) { lastCount = n; quietSince = Date.now(); }
      const hasRecord = fs.existsSync(recordsFile) && JSON.parse(fs.readFileSync(recordsFile, 'utf8')).length > 0;
      if (hasRecord && n >= expected && Date.now() - quietSince > 8000) break;
      await sleep(500);
    }
    // Extra quiet window: any stray revision chain would have launched by now.
    await sleep(5000);
    result.pageText = await app.evaluate('document.body.innerText', true);
    for (const w of WIDTHS) result.screenshots.push(await app.screenshot(dirs.shots, 'result', w));

    const calls = readLines(callsFile);
    const turns = calls.filter(c => c.invocationType === 'turn');
    const harnessLines = readLines(path.join(dirs.stub, 'invocations.jsonl'));
    result.calls = calls;
    check('noSentinelRefusedOrExhausted', harnessLines.every(i => !['sentinel-refused', 'turn-queue-exhausted'].includes(i.behaviorId)));
    check('turnCountsExact', ['codex', 'claude'].every(idn => turns.filter(t => t.identity === idn).length === sc.expectTurns[idn]), turns.map(t => `${t.identity}#${t.queueIndex}:${t.behaviorId}:q=${t.queueIndex}`));
    check('plan-revise-1NotObservableInArgv', turns.every(t => t.mentionsPlanRevise1 === false), 'plan-revise-1 is hashed into command ids and cmd.exe cuts prompts at the first newline, so the stub cannot see it; revision evidence comes from turn order plus the saved record');
    const roles = rec => (rec?.turnsRan ?? []).map(t => t.role).join();
    const checks = rec => (rec?.checksRan ?? []).map(c => `${c.kind}:${c.verdict}`).join();
    const records = fs.existsSync(recordsFile) ? JSON.parse(fs.readFileSync(recordsFile, 'utf8')) : [];
    result.records = records;
    const rec = records[0];
    if (id === 'a') {
      check('recordHasDecisionAutomaticOffPlan', JSON.stringify(rec?.decision) === JSON.stringify({ kind: 'automatic-off', stage: 'plan' }), JSON.stringify(rec?.decision));
      check('noRevisionChainLaunched', turns.length === 2 && roles(rec) === 'plan,review' && checks(rec) === 'plan-check:revise' && !(rec?.planRevisionHistory?.length) && !rec?.executionText && !rec?.auditText, `${roles(rec)} | ${checks(rec)}`);
      if (opts.decisionText) check('pageShowsDecisionSentence', result.pageText.includes(opts.decisionText), opts.decisionText);
      else result.notes.push('No --decision-text given; the page text is archived for manual comparison.');
    } else {
      check('recordHasNoAskDecision', rec?.decision?.kind !== 'automatic-off', JSON.stringify(rec?.decision));
      check('exactlyOneRevisionChain', rec?.planRevisionHistory?.length === 1 && rec.planRevisionHistory[0].verdict === 'revise' && roles(rec) === 'plan,review,plan,review,execute,audit' && checks(rec) === 'plan-check:revise,plan-check:checked,audit:verified', `${rec?.planRevisionHistory?.length} | ${roles(rec)} | ${checks(rec)}`);
      check('sixTurnsInOrder', turns.map(t => t.identity).join() === 'codex,claude,codex,claude,codex,claude', turns.map(t => `${t.identity}:${t.behaviorId}`));
      check('pageSaysChangesVerified', /Changes verified/.test(result.pageText));
    }
    check('turnsAddedByThisSend', turns.length - beforeSend === expected);
  } catch (error) {
    result.error = String(error?.stack ?? error);
    try { if (app) result.errorPageText = (await app.evaluate('document.body.innerText', true)).slice(0, 4000); } catch { /* page gone */ }
  } finally {
    // Close like a user, then stop only the Core whose command line names this fresh profile.
    try { await app?.evaluate('window.close()', true); } catch { /* window may vanish before reply */ }
    for (let i = 0; i < 60 && !exit; i++) {
      try {
        if (app && await app.evaluate(`(() => { const b=[...document.querySelectorAll('.close-choice-dialog button')].find(b=>b.textContent.trim()==='Continue in background'); if(!b) return false; b.click(); return true; })()`, true)) { /* choice made */ }
      } catch { /* closing */ }
      await sleep(250);
    }
    try { app?.close(); } catch { /* ignore */ }
    result.electronExit = exit;
    for (const fd of [stdoutFd, stderrFd]) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    if (!exit) { result.notes.push('Electron did not exit within the close wait; leaving it for manual cleanup (not force-killed).'); }
    await sleep(1000);
    try {
      const mine = processes(opts.pwsh).filter(p => /goalport-core(-launcher)?\.exe$/i.test(p.ExecutablePath ?? '') && norm(p.CommandLine ?? '').includes(norm(dirs.data)));
      result.coreStoppedPids = [];
      for (const p of mine) {
        spawnSync(opts.pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${p.ProcessId} -ErrorAction SilentlyContinue`], { encoding: 'utf8' });
        result.coreStoppedPids.push(p.ProcessId);
      }
    } catch (error) { result.notes.push(`core cleanup: ${error.message}`); }
    result.passed = !result.error && Object.values(result.checks).every(c => c.ok);
    writeJson(path.join(root, 'result.json'), result);
  }
  return result;
}

const opts = parseArgs(process.argv.slice(2));
if (fs.existsSync(opts.out)) throw new Error('--out already exists; use a fresh directory');
fs.mkdirSync(opts.out, { recursive: true });
// The execution fixture must live under the OS temp dir; keep that inside this run's evidence folder.
fs.mkdirSync(path.join(opts.out, 'tmp'));
process.env.TEMP = process.env.TMP = path.join(opts.out, 'tmp');
const ids = opts.scenario === 'both' ? ['a', 'b'] : [opts.scenario];
const results = [];
for (const id of ids) {
  const r = await runScenario(id, opts);
  results.push(r);
  console.log(`scenario ${id}: ${r.passed ? 'PASSED' : 'FAILED'}${r.error ? ` (${r.error.split('\n')[0]})` : ''}`);
  for (const [name, c] of Object.entries(r.checks)) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${name}${c.detail ? ` -- ${typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)}` : ''}`);
}
writeJson(path.join(opts.out, 'summary.json'), results.map(r => ({ scenario: r.scenario, passed: r.passed, error: r.error ?? null, checks: r.checks })));
process.exitCode = results.every(r => r.passed) ? 0 : 1;
