import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { ROOT, EVIDENCE, SYNTHETIC, SLUG, assembleEnv, guardedEnv, claimOutput, socketName, freePort, preflight } from './lib/launch.mjs';
import { materializeStubBin } from './lib/stubbin.mjs';
import { SCENARIOS, validateScenario, validateReport, artifactAssertions } from './lib/scenarios.mjs';
import { TRACK_A_KIND, NOT_VERIFIED, zeroQuotaProof, aggregateCleanup, scenarioShotRequirements } from './report.mjs';
import { parseArgs, withCaseDeadline, persistValidatedReport } from './run-local.mjs';

function ownedFixture(t) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const root = fs.mkdtempSync(path.join(EVIDENCE, 'm2-helper-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('explicit fresh output refuses overwrite, outside paths and symlink ancestors', t => {
  const root = ownedFixture(t), out = path.join(root, 'new');
  assert.equal(claimOutput(out), out);
  fs.writeFileSync(path.join(out, 'previous'), 'preserve');
  assert.throws(() => claimOutput(out), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(out, 'previous'), 'utf8'), 'preserve');
  assert.throws(() => claimOutput(ROOT), /inside/);
  assert.throws(() => claimOutput(), /explicit/);
  fs.symlinkSync(out, path.join(root, 'link'));
  assert.throws(() => claimOutput(path.join(root, 'link', 'new')), /symlink/);
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--out', out, '--unexpected']), /usage/);
  assert.throws(() => parseArgs([]), /usage/);
  assert.deepEqual(parseArgs(['--out', out]), { out, scenarios: ['a1'] });
});

test('allowlisted child env is hermetic and the actual isolation guards reject escape', async t => {
  const root = ownedFixture(t);
  const stub = materializeStubBin(path.join(root, 'stub-bin'));
  const env = assembleEnv({ caseRoot: root, pipe: socketName('m2-test'), port: 9222, stub, inherited: {
    PATH: '/usr/bin:/bin', DISPLAY: ':0', HOME: '/host', USERPROFILE: '/host', CODEX_HOME: '/host', CLAUDE_CONFIG_DIR: '/host',
    GOALPORT_HARNESS_CHECKOUT: '/host', GOALPORT_HARNESS_SERVER_CWD: '/host', GOALPORT_PROFILE: '/host', GOALPORT_CORE_BIN: '/host', GOALPORT_RUN_SLUG: 'other',
    ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require /host', OPENAI_API_KEY: 'not-a-secret', GOALPORT_RUNTIME_MODE: 'host',
  } });
  for (const key of ['GOALPORT_HARNESS_CHECKOUT','GOALPORT_HARNESS_SERVER_CWD','GOALPORT_PROFILE','GOALPORT_CORE_BIN','ELECTRON_RUN_AS_NODE','NODE_OPTIONS','OPENAI_API_KEY','GOALPORT_RUNTIME_MODE']) assert.equal(env[key], undefined);
  assert.equal(env.GOALPORT_RUN_SLUG, SLUG);
  for (const key of ['HOME','USERPROFILE','CODEX_HOME','CLAUDE_CONFIG_DIR','GOALPORT_HARNESS_STATE_DIR']) assert.ok(env[key].startsWith(root + path.sep));
  assert.equal(env.GOALPORT_SYNTHETIC_ROOT, SYNTHETIC);
  assert.equal(env.PATH.split(path.delimiter)[0], stub.stubDir);
  const original = process.env.GOALPORT_CORE_PIPE;
  await guardedEnv(env);
  assert.equal(process.env.GOALPORT_CORE_PIPE, original);
  await assert.rejects(guardedEnv({...env, GOALPORT_CORE_DB:'/tmp/escape.sqlite'}), /must be under/);
  await assert.rejects(guardedEnv({...env, GOALPORT_SYNTHETIC_ROOT:'/tmp/escape'}), /must be this-run/);
  await assert.rejects(guardedEnv({...env, GOALPORT_CORE_PIPE:'/tmp/escape.sock'}), /must contain/);
  assert.throws(() => assembleEnv({caseRoot:'/tmp/outside', pipe:socketName('test'), port:1, stub}), /outside/);
  assert.throws(() => assembleEnv({caseRoot:root, pipe:socketName('test'), port:0, stub}), /invalid port/);
});

test('both real launchSpec and OS PATH resolution must point at stubs, never execute vendor CLIs', t => {
  if (process.platform === 'win32') {
    t.skip('POSIX preflight refuses Windows; scripts/acceptance/lib/windows-host.test.mjs owns the .cmd resolution contract');
    return;
  }
  const root = ownedFixture(t);
  const stub = materializeStubBin(path.join(root, 'stub-bin'));
  const env = assembleEnv({caseRoot:root, pipe:socketName('test'), port:1234, stub});
  assert.equal(preflight(env, stub.stubDir).bothNamesShadowed, true);
  assert.equal(fs.readFileSync(path.join(stub.stubDir, 'invocations.jsonl'), 'utf8'), '', 'resolution is not a probe');
  assert.throws(() => preflight({...env, PATH:'/nonexistent'}, stub.stubDir), /escaped/);
});

test('owned sockets have bounded Linux paths and future Windows named-pipe shape', () => {
  assert.ok(Buffer.byteLength(socketName('m2-123456789abc')) <= 107);
  assert.equal(socketName('a1', 'win32'), `\\\\.\\pipe\\${SLUG}-a1`);
  assert.throws(() => socketName('../escape'), /invalid/);
  assert.throws(() => socketName('x'.repeat(100)), /invalid/);
});

test('port allocator uses loopback and releases its reservation', async () => {
  const port = await freePort();
  assert.ok(port > 0 && port <= 65535);
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
});

test('pinned scenario configs only; report cannot claim ready without evidence', () => {
  for (const scenario of Object.values(SCENARIOS)) assert.equal(validateScenario(scenario), scenario);
  assert.throws(() => validateScenario({ ...SCENARIOS.a1, id: 'aX' }), /pinned/);
  assert.throws(() => validateScenario({ ...SCENARIOS.a1, budget: 32 }), /pinned/);
  assert.throws(() => validateScenario({ ...SCENARIOS.a1, behavior: {} }), /pinned/);
  // a3 must keep the banned-shape pins: both names shadowed, unavailability via probe response only.
  assert.equal(SCENARIOS.a3.behavior.probes.claude, 'claude-probe-unavailable');
  assert.deepEqual(SCENARIOS.a3.behavior.turns, { codex: [], claude: [] });
  // a2/a5 pin the env-blocked corpus and exactly-one-shot requirements; a5 owns two phases.
  assert.equal(SCENARIOS.a2.behavior.turns, SCENARIOS.a5.behavior.turns);
  assert.deepEqual(scenarioShotRequirements('a2').map(([state, width]) => [state, width]), [['terminal', 860], ['terminal', 1020], ['terminal', 1440], ['use-again', 1020]]);
  assert.deepEqual(scenarioShotRequirements('a3'), [['refusal', 1020]]);
  assert.deepEqual(scenarioShotRequirements('a5'), [['blocked-panel', 1020]]);
  assert.throws(() => scenarioShotRequirements('aX'), /pinned/);
  assert.equal(SCENARIOS.a5.phases, 2);
  const report = { schemaVersion: 1, kind: 'goalport-m2-real-app', head: crypto.randomBytes(20).toString('hex'), caseRoot: '/test', a1: { assertions: {} }, cleanup: {}, status: 'blocked' };
  assert.equal(validateReport(report), report);
  assert.throws(() => validateReport({ ...report, status: 'ready' }), /lacks/);
  assert.throws(() => validateReport({ ...report, schemaVersion: 2 }), /invalid/);
});

test('run-local selects fresh per-scenario evidence dirs and refuses unknown or duplicate scenarios', () => {
  assert.deepEqual(parseArgs(['--out', '/tmp/x']), { out: '/tmp/x', scenarios: ['a1'] });
  assert.deepEqual(parseArgs(['--out', '/tmp/x', '--scenario', 'a2']), { out: '/tmp/x', scenarios: ['a2'] });
  assert.deepEqual(parseArgs(['--out', '/tmp/x', '--scenario', 'a2', '--scenario', 'a3', '--scenario', 'a4', '--scenario', 'a5']), { out: '/tmp/x', scenarios: ['a2', 'a3', 'a4', 'a5'] });
  assert.throws(() => parseArgs(['--out', '/tmp/x', '--scenario', 'aX']), /unknown/);
  assert.throws(() => parseArgs(['--out', '/tmp/x', '--scenario', 'a2', '--scenario', 'a2']), /duplicate/);
  assert.throws(() => parseArgs(['--out', '/tmp/x', '--unexpected']), /usage/);
  assert.throws(() => parseArgs([]), /usage/);
});

test('pure artifact assertions fail closed on unledgered turns, probe shortfall, unfinished or fabricated grants', () => {
  // Pure helper fixture only; never supplied to real app or integration report.
  const a = {
    ledger:{'coordinate-plan-a':{ok:true,messageDispatched:true,text:'Bounded plan.'},'coordinate-review-b':{ok:true,messageDispatched:true,text:'The plan can be carried out.\nVERDICT: carry-out'}},
    invocations:[{identity:'codex',invocationType:'turn',behaviorId:'codex-tool-success'},{identity:'claude',invocationType:'turn',behaviorId:'claude-carry-out-delayed'}, ...['codex','claude'].flatMap(identity => Array.from({length:3}, () => ({identity,invocationType:'probe',behaviorId:`${identity}-probe-authenticated`})))],
    claims:['claim-coordinate-plan-a','claim-coordinate-review-b'], unconsumedGrants:[], health:null,
    records:[{verdict:'checked',planText:'Bounded plan.',reviewText:'The plan can be carried out.\nVERDICT: carry-out',planningHarness:'Codex',reviewHarness:'Claude'}],
  };
  assert.ok(Object.values(artifactAssertions(a)).every(Boolean));
  assert.equal(artifactAssertions({...a, invocations:a.invocations.slice(0,2)}).probesSeparateAndAtLeastSix, false);
  assert.equal(artifactAssertions({...a, invocations:[...a.invocations,a.invocations[0]]}).ledgerTurnBijection, false);
  assert.equal(artifactAssertions({...a, unconsumedGrants:['fabricated']}).twoClaimsAndConsumedGrants, false);
  assert.equal(artifactAssertions({...a, ledger:{}}).exactlyTwoSuccessfulLedgerTurns, false);
  assert.equal(artifactAssertions({...a, records:[{...a.records[0], planningHarness:'Claude'}]}).independentHarnesses, false);
});

test('native X11 helper rejects unrelated, absent and ambiguous identities before mutation', async () => {
  const { spawnSync } = await import('node:child_process');
  const { nativeResize } = await import('./lib/cdp-app.mjs');
  for (const args of [[0,860,900],[123,999,900],[123,860,1],[123,860,900,{width:100,height:0}]]) assert.throws(() => nativeResize(...args), /invalid owned/);
  const helper = path.join(ROOT, 'scripts/acceptance/lib/native-window.py');
  const source = `
import importlib.util
spec=importlib.util.spec_from_file_location('owned', ${JSON.stringify(helper)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
parents={10:1,11:10,12:11,99:1}
parent=lambda pid: parents.get(pid,0)
own={'id':1,'pid':10,'title':'GoalPort','class':'goalport goalport'}
other={'id':2,'pid':99,'title':'GoalPort','class':'goalport goalport'}
child={'id':3,'pid':12,'title':'GoalPort 1.0','class':'electron Electron'}
assert m.select_owned_window([own,other],10,parent)==own
assert m.select_owned_window([child,other],10,parent)==child
assert not m.is_descendant(99,10,parent)
assert not m.is_descendant(100,10,lambda pid:pid)
for candidates in [[],[other],[own,child],[dict(own,title='unrelated')],[dict(own,**{'class':'unrelated'})]]:
 try: m.select_owned_window(candidates,10,parent)
 except ValueError: pass
 else: raise AssertionError('unsafe identity admitted')
for request in [(0,860,900),(10,999,900),(10,860,500),(True,860,900)]:
 try: m.validate_request(*request)
 except ValueError: pass
 else: raise AssertionError('unsafe bounds admitted')
m.validate_request(10,860,900)
print('native ownership and bounds policy passed without loading Xlib')
`;
  if (process.platform === 'win32') return; // X11 helper is not the Windows ownership path; the argument checks above still run.
  const result = spawnSync('/usr/bin/python3', ['-B','-c',source], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /policy passed/);
});

test('completed a5 phases cancel their deadlines and let the driver exit promptly', async () => {
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = new URL('./run-local.mjs', import.meta.url).href;
  const script = `import { withCaseDeadline } from ${JSON.stringify(moduleUrl)};
await withCaseDeadline(Promise.resolve('round'), 'a5 round', 60000);
await withCaseDeadline(Promise.resolve('relaunch'), 'a5 relaunch', 60000);
console.log('both phases finished');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 2000 });
  assert.equal(result.error, undefined, 'successful phases must not leave a live 60-second timer');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /both phases finished/);
  await assert.rejects(withCaseDeadline(new Promise(() => {}), 'blocked phase', 5), /bounded 5ms deadline expired/);
});

test('default a1 envelope remains valid and keeps its actual case root', () => {
  // Pure report fixture only, never supplied to the real app.
  const report = {
    schemaVersion: 1, kind: 'goalport-m2-real-app', head: 'a'.repeat(40), caseRoot: '/isolated/a1',
    status: 'ready', a1: { assertions: { ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`check-${i}`, true])), nativeLayoutAndControlsFit: true }, artifacts: {}, screenshots: Array.from({ length: 7 }, () => ({})) },
    cleanup: { coreStopped: true, socketAbsent: true, electronExit: { code: 0 } },
  };
  const saved = [];
  persistValidatedReport(report, () => saved.push(structuredClone(report)));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'ready');
  assert.equal(saved[0].caseRoot, '/isolated/a1');
});

test('report validation failure is persisted as blocked, not a ready report with exit 2', () => {
  const report = { schemaVersion: 1, kind: 'goalport-m2-real-app', head: 'a'.repeat(40), status: 'ready', a1: { assertions: {} }, cleanup: {} };
  const saved = [];
  assert.throws(() => persistValidatedReport(report, () => saved.push(structuredClone(report))), /invalid report envelope/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'blocked');
  assert.match(saved[0].validationFailure, /invalid report envelope/);
});
