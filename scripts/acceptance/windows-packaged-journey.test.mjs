import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import {
  REQUIRED_STAGES, REQUIRED_SCREENSHOTS, FORBIDDEN_ENV, validateJourney,
  liveEvidenceIsValid, stopIsUsable, exitCodeForStatus, parseCli, profileProcessMatch,
  journeyEnvironment, validatePrerequisites,
} from './windows-packaged-journey.mjs';

const A = 'C:\\owned\\workspace-a', B = 'C:\\owned\\workspace-b';
const marker = 'journey-11111111-1111-4111-8111-111111111111';
function live(id, workspacePath) {
  const facts = {
    jobId: `job-${id}`, requestId: `request-${id}`, goal: `Review project ${marker}`,
    workspacePath, workerPid: 100 + id, active: true, live: true, state: 'running', revoked: false,
    readMaxTurns: 8, counters: { readTurnsLeft: 6 }, pendingCommand: { commandId: `review-${id}`, state: 'unconfirmed', recordedAt: '2026-10-19T00:00:00Z' },
    completedCommands: [{ commandId: `plan-${id}`, facts: { dispatched: true, text: 'An actual harness plan' } }],
    progress: { activity: 'Claude is checking…' }, outcome: null,
  };
  return {
    status: 'passed', sent: true, statusFacts: facts,
    admission: { jobId: facts.jobId, input: { requestId: facts.requestId, goal: facts.goal, workspacePath } },
    rendered: { jobId: facts.jobId, goal: facts.goal, progressMatched: true, commandMatched: true },
  };
}
function stopped(live) {
  return { status: 'passed', control: { visible: true, enabled: true, hitTestable: true }, clicked: true,
    statusFacts: { ...structuredClone(live.statusFacts), state: 'stopped', revoked: true, live: false, active: false, pendingCommand: null, outcome: { status: 'stopped' } }, noLaterDispatch: true, workerExited: true };
}
function healthy() {
  const s = Object.fromEntries(REQUIRED_STAGES.map(name => [name, { status: 'passed' }]));
  s.draftAccess.realHarnesses = [{ id: 'codex' }, { id: 'claude' }];
  s.liveA = live(1, A); s.resendA = live(2, A); s.sendB = live(3, B); s.interruptLive = live(4, A); s.continueB = live(5, B);
  s.closeReopen = { status: 'passed', normalClose: true, forced: false, backgroundWorkContinued: true, admissionsUnchanged: true,
    statusFacts: structuredClone(s.liveA.statusFacts), rendered: structuredClone(s.liveA.rendered), retainedCommandIds: ['plan-1'] };
  s.stopA = stopped(s.liveA); s.stopResendA = stopped(s.resendA); s.stopB = stopped(s.sendB); s.stopContinueB = stopped(s.continueB);
  const interrupted = { ...structuredClone(s.interruptLive.statusFacts), state: 'unconfirmed', live: false };
  s.interrupted = { status: 'passed', killedPid: interrupted.workerPid, onlyWorkerKilled: true, statusFacts: interrupted };
  s.heldFolder = { status: 'passed', emptyAfterContinue: true, holdNoteVisible: true, sendDisabled: true,
    refusal: { backgroundStartRefused: true, code: 'background-job-conflict' }, admissionsUnchanged: true, oldJobUnreplayed: true,
    oldStatus: { ...structuredClone(interrupted), active: false, acknowledgedStuckAt: '2026-10-19T00:00:00Z' } };
  const screenshots = REQUIRED_SCREENSHOTS.flatMap(state => [860, 1020, 1440].map(width => ({ state, requested: { width }, viewport: { width }, geometry: { horizontalOverflow: false }, path: `C:\\evidence\\${state}-${width}.png`, sha256: `${state}-${width}-exact-image-hash` })));
  return {
    stages: s, packageIdentity: { source: { revision: 'a'.repeat(40), dirty: false } }, runnerIdentity: { revision: 'b'.repeat(40), scriptSha256: 'c'.repeat(64) },
    launchEnvironment: { absent: Object.fromEntries(FORBIDDEN_ENV.map(k => [k, true])), pathUnmodified: true, testProfile: false },
    cleanup: { ok: true, profilesRetained: true, remainingOwnedPids: [] }, errors: [], screenshots,
    visualReview: { reviewer: 'Independent image inspection session', inspections: screenshots.map(p => ({ path: p.path, sha256: p.sha256, acceptable: true, observation: 'I opened this PNG. The goal and next action are readable.' })) },
  };
}
function rejected(change, pattern) {
  const report = healthy(); change(report);
  const result = validateJourney(report);
  assert.notEqual(result.status, 'passed');
  assert.equal(exitCodeForStatus(result.status), 1);
  if (pattern) assert.match(result.failures.join('\n'), pattern);
}

test('a profile-named Core is adopted even after its parent app exits', () => {
  const pkg = 'C:/owned/package';
  const node = 'C:/Program Files/nodejs/node.exe';
  const profile = 'C:/profiles/p1';
  assert.equal(profileProcessMatch({ CommandLine: `${pkg}/resources/goalport-core.exe serve --db ${profile}/goalport.sqlite`, ExecutablePath: `${pkg}/resources/goalport-core.exe` }, profile, pkg, node), true);
  assert.equal(profileProcessMatch({ CommandLine: `node worker ${profile}`, ExecutablePath: node }, profile, pkg, node), true);
  assert.equal(profileProcessMatch({ CommandLine: `${pkg}/resources/goalport-core.exe serve --db C:/profiles/other/goalport.sqlite`, ExecutablePath: `${pkg}/resources/goalport-core.exe` }, profile, pkg, node), false);
  assert.equal(profileProcessMatch({ CommandLine: 'codex exec --cd C:/workspace', ExecutablePath: 'C:/codex.exe' }, profile, pkg, node), false);
});

test('a complete healthy real stage set passes; only pass maps to exit zero', () => {
  assert.deepEqual(validateJourney(healthy()), { status: 'passed', failures: [] });
  assert.equal(exitCodeForStatus('passed'), 0);
  for (const status of ['failed', 'blocked', 'completed', undefined, 'not-visible']) assert.equal(exitCodeForStatus(status), 1);
});
test('absent/disabled/covered Stop cannot be successful, even with stopped body copy', () => {
  for (const control of [undefined, { visible: false, enabled: true, hitTestable: true }, { visible: true, enabled: false, hitTestable: true }, { visible: true, enabled: true, hitTestable: false }]) {
    assert.equal(stopIsUsable(control), false);
    rejected(r => { r.stages.stopA.control = control; r.stages.stopA.bodyText = 'Stopped'; }, /Stop absent/);
  }
});
test('instant failure, no live job or no real dispatched command/progress fails', () => {
  for (const change of [
    r => { r.stages.liveA.statusFacts.state = 'failed'; r.stages.liveA.statusFacts.outcome = { status: 'failed', error: 'Background Send is not enabled.' }; },
    r => { r.stages.liveA.statusFacts.live = false; },
    r => { r.stages.liveA.statusFacts.completedCommands = []; },
    r => { r.stages.liveA.statusFacts.completedCommands[0].facts.dispatched = false; },
    r => { r.stages.liveA.rendered.progressMatched = false; },
    r => { r.stages.liveA.rendered.commandMatched = false; },
  ]) rejected(change, /liveA: admission\/live\/dispatch\/render/);
});
test('pending is not dispatch unless charged, ledger-confirmed and observed in the actual worker process tree', () => {
  const evidence = live(1, A);
  evidence.statusFacts.completedCommands = [];
  assert.equal(liveEvidenceIsValid(evidence), false);
  evidence.dispatch = { commandId: 'review-1', workerPid: 101, pid: 222, fromOwnedWorker: true, executablePath: 'C:\\node.exe',
    commandLineSha256: 'a'.repeat(64), createdAt: '2026-10-19T00:00:01Z', promptMarker: marker, ledgerMessageDispatched: true };
  assert.equal(liveEvidenceIsValid(evidence), true);
  for (const [key, value] of [['commandId', 'wrong'], ['workerPid', 999], ['fromOwnedWorker', false], ['ledgerMessageDispatched', false], ['promptMarker', 'not-the-matching-marker']]) {
    const bad = structuredClone(evidence); bad.dispatch[key] = value; assert.equal(liveEvidenceIsValid(bad), false, key);
  }
  const uncharged = structuredClone(evidence); uncharged.statusFacts.counters.readTurnsLeft = 8; assert.equal(liveEvidenceIsValid(uncharged), false);
});
test('status identity must agree with immutable admission and rendered job', () => {
  for (const field of ['requestId', 'jobId', 'goal', 'workspacePath']) rejected(r => { r.stages.liveA.statusFacts[field] = 'wrong'; }, /liveA: admission/);
  rejected(r => { r.stages.liveA.rendered.jobId = 'another'; }, /liveA: admission/);
});
test('wrong reopened job/request/goal/workspace or duplicate admission fails', () => {
  for (const field of ['jobId', 'requestId', 'goal', 'workspacePath']) rejected(r => { r.stages.closeReopen.statusFacts[field] = 'different'; }, /close\/reopen/);
  for (const field of ['normalClose', 'backgroundWorkContinued', 'admissionsUnchanged']) rejected(r => { r.stages.closeReopen[field] = false; }, /close\/reopen/);
  rejected(r => { r.stages.closeReopen.forced = true; }, /close\/reopen/);
  rejected(r => { r.stages.closeReopen.retainedCommandIds = ['missing-command']; }, /close\/reopen/);
});
test('Stop needs revocation, actual stopped outcome, no live/pending work and no later dispatch', () => {
  for (const change of [
    r => { r.stages.stopA.statusFacts.revoked = false; },
    r => { r.stages.stopA.statusFacts.outcome.status = 'failed'; },
    r => { r.stages.stopA.statusFacts.live = true; },
    r => { r.stages.stopA.statusFacts.pendingCommand = { commandId: 'still-running' }; },
    r => { r.stages.stopA.noLaterDispatch = false; },
    r => { r.stages.stopA.clicked = false; },
    r => { r.stages.stopA.workerExited = false; },
  ]) rejected(change, /revocation\/settlement/);
});
test('B enabled-only and missing explicit sends fail in normal and interrupted profiles', () => {
  for (const name of ['sendB', 'continueB']) {
    rejected(r => { delete r.stages[name]; }, /required stage/);
    rejected(r => { r.stages[name].sent = false; r.stages[name].sendEnabled = true; }, /dispatch\/render/);
    rejected(r => { r.stages[name].statusFacts.workspacePath = A; }, /different-folder/);
  }
});
test('same-folder confirmed terminal resend requires a fresh admission and real start', () => {
  rejected(r => { r.stages.resendA = structuredClone(r.stages.liveA); }, /released A/);
  rejected(r => { r.stages.resendA.sent = false; }, /resendA: admission/);
});
test('held folder must be empty after Continue, visibly held, disabled and refused at admission; no replay', () => {
  for (const field of ['emptyAfterContinue', 'holdNoteVisible', 'sendDisabled', 'admissionsUnchanged', 'oldJobUnreplayed']) rejected(r => { r.stages.heldFolder[field] = false; }, /held folder/);
  rejected(r => { r.stages.heldFolder.refusal = { jobId: 'illegally-admitted' }; }, /held folder/);
  rejected(r => { r.stages.heldFolder.oldStatus.state = 'stopped'; }, /held folder/);
  rejected(r => { r.stages.heldFolder.oldStatus.live = true; }, /held folder/);
  rejected(r => { r.stages.interrupted.killedPid = 999; }, /worker interruption/);
});
test('each required missing stage and failed cleanup makes the report non-successful', () => {
  for (const name of REQUIRED_STAGES) rejected(r => { delete r.stages[name]; }, /required stage/);
  for (const cleanup of [undefined, { ok: false }, { ok: true, profilesRetained: false, remainingOwnedPids: [] }, { ok: true, profilesRetained: true, remainingOwnedPids: [123] }]) rejected(r => { r.cleanup = cleanup; }, /cleanup failed/);
});
test('dirty package, missing environment premises and uninspected/clipped PNGs fail closed', () => {
  rejected(r => { r.packageIdentity.source.dirty = true; }, /clean full package/);
  rejected(r => { r.packageIdentity.source.revision = '59dfa4f'; }, /clean full package/);
  rejected(r => { r.runnerIdentity = {}; }, /runner identity/);
  for (const key of FORBIDDEN_ENV) rejected(r => { r.launchEnvironment.absent[key] = false; }, /environment/);
  rejected(r => { r.launchEnvironment.pathUnmodified = false; }, /environment/);
  rejected(r => { r.launchEnvironment.testProfile = true; }, /environment/);
  rejected(r => { r.stages.draftAccess.realHarnesses = []; }, /two real harnesses/);
  rejected(r => { r.screenshots.pop(); }, /screenshot missing/);
  rejected(r => { r.screenshots[0].geometry.horizontalOverflow = true; }, /screenshot missing\/clipped/);
  rejected(r => { delete r.visualReview; }, /not personally reviewed/);
  rejected(r => { r.visualReview.inspections[0].observation = ''; }, /not personally reviewed/);
  rejected(r => { r.visualReview.inspections[0].sha256 = 'other-bytes'; }, /not personally reviewed/);
});
test('missing runtime premises are blocked, not green; failures remain nonzero', () => {
  const report = healthy(); report.blocked = 'Only one real harness available';
  assert.equal(validateJourney(report).status, 'blocked');
  delete report.stages.continueB;
  assert.equal(validateJourney(report).status, 'blocked');
  report.errors.push('A real assertion also failed'); assert.equal(validateJourney(report).status, 'failed');
  assert.equal(validateJourney({}).status, 'failed');
});
test('workspace identity comparison follows Windows casing and trailing-separator semantics', () => {
  const r = healthy(); r.stages.resendA.statusFacts.workspacePath = 'c:/OWNED/workspace-a/'; r.stages.resendA.admission.input.workspacePath = 'c:/owned/workspace-a';
  assert.equal(validateJourney(r).status, 'passed');
  rejected(r => { r.stages.continueB.statusFacts.workspacePath = 'relative-folder'; }, /different-folder/);
});
test('CLI requires three explicit unique values and rejects invalid args without Electron launch', () => {
  for (const argv of [[], ['--package'], ['--wat', 'x'], ['--package', 'x', '--out', 'y'], ['--package', '--out'], ['--package', 'x', '--package', 'z', '--pwsh', 'pwsh']]) assert.throws(() => parseCli(argv));
  const args = parseCli(['--package', 'candidate', '--out', 'fresh-output', '--pwsh', 'pwsh.exe']);
  assert.ok(args.packageRoot && args.outDir && args.pwshPath);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./windows-packaged-journey.mjs', import.meta.url))], { encoding: 'utf8', timeout: 10000 });
  assert.equal(cli.status, 1); assert.equal(JSON.parse(cli.stdout).status, 'failed'); assert.match(cli.stdout, /Explicit --package/);
});
test('non-Windows and missing executable preconditions reject before output creation', () => {
  assert.throws(() => validatePrerequisites({ packageRoot: '.', outDir: 'unused', pwshPath: 'missing' }, 'linux'), /native Windows/);
  assert.throws(() => validatePrerequisites({ packageRoot: 'nonexistent-candidate', outDir: 'unused', pwshPath: 'missing' }, 'win32'), /Missing GoalPort.exe/);
});
test('static renderer expressions parse after host-string escaping, without running a renderer', () => {
  const source = readFileSync(new URL('./windows-packaged-journey.mjs', import.meta.url), 'utf8');
  const calls = /(?:evaluate|until)\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/g;
  let checked = 0;
  for (const match of source.matchAll(calls)) {
    if (match[1].includes('${')) continue;
    const expression = new Script(match[1]).runInNewContext();
    assert.doesNotThrow(() => new Script(expression), expression);
    checked++;
  }
  assert.ok(checked >= 15, `expected renderer expressions, checked ${checked}`);
});
test('launch deletes consent/checkouts/stubs and inherited test plumbing without changing installed PATH/login', () => {
  const inherited = { PATH: 'C:\\real-harnesses', USERPROFILE: 'C:\\real-user', API_KEY: 'retained-real-login', NODE_OPTIONS: '--require hook', ELECTRON_RUN_AS_NODE: '1', goalport_coordinate_send: '1', GOALPORT_REQUIRE_ISOLATED: '1', ...Object.fromEntries(FORBIDDEN_ENV.map(k => [k, 'unsafe'])) };
  const env = journeyEnvironment(inherited);
  assert.equal(env.PATH, inherited.PATH); assert.equal(env.USERPROFILE, inherited.USERPROFILE); assert.equal(env.API_KEY, inherited.API_KEY);
  assert.equal(Object.keys(env).some(k => /GOALPORT_|NODE_OPTIONS|ELECTRON_RUN_AS_NODE/i.test(k)), false);
  assert.equal(inherited.GOALPORT_COORDINATE_SEND, 'unsafe');
});
