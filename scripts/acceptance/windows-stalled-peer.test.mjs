// Unit and fixture-contract tests for scripts/acceptance/windows-stalled-peer.mjs (MY-116 round 5).
//
// No real Core, no package and no provider are touched here. The launch-wiring tests copy bytes in
// a temp directory to prove Core's pre-spawn resolution guard; the fixture tests spawn node against
// the synthetic app-server to prove `stall_initialize` withholds initialize until the release marker
// while the default scenarios are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BASELINE_SCENARIO,
  EXPECTED_FIXTURE_ARGV,
  OBSERVATION_WINDOW_MS,
  STALL_SCENARIO,
  appDataCandidates,
  assertFakeCodexResolution,
  attemptIdForStartRequest,
  buildCoreEnv,
  classifyStopEffectiveness,
  computeVerdict,
  isInside,
  isolatedAppDataProblems,
  parseArgs,
  planProbe,
  resolveCoreCodex,
  responsiveAcceptanceProblems,
  scoreControlSample,
  validateFixtureInstances,
} from './windows-stalled-peer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  HERE,
  '../../crates/goalport-core/tests/fixtures/fake-codex-app-server/fake-codex-app-server.mjs',
);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SNAPSHOT_OK = { ok: true, payload: { snapshot: { attempt: { id: 'attempt-x' } } } };
const STOP_OK = { ok: true, payload: { receipt: { attemptId: 'attempt-x', confirmed: true } } };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSample({
  messageType = 'snapshot',
  issued = 1000,
  connected = 1001,
  written = 1002,
  responded = 1100,
  timedOut = false,
  connectError = null,
  writeError = null,
  connectionClosed = false,
  response = SNAPSHOT_OK,
  parseError = null,
} = {}) {
  return {
    messageType,
    requestId: 'request-1',
    payload: {},
    issuedAt: issued,
    connectedAt: connected,
    writtenAt: written,
    respondedAt: responded,
    connectError,
    writeError,
    connectionClosed,
    timedOut,
    parseError,
    response,
  };
}

test('CLI requires one --core and one --out and rejects anything else', () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--core', 'core.exe']), /usage/);
  assert.throws(() => parseArgs(['--out', 'dir']), /usage/);
  assert.throws(() => parseArgs(['--core', 'core.exe', '--out']), /requires a value/);
  assert.throws(() => parseArgs(['--core', 'core.exe', '--out', '--nope']), /requires a value/);
  assert.throws(() => parseArgs(['--core', 'a.exe', '--out', 'dir', '--force']), /unknown argument/);
  assert.throws(() => parseArgs(['--core', 'a.exe', '--core', 'b.exe', '--out', 'dir']), /more than once/);
  assert.deepEqual(parseArgs(['--out', 'dir', '--core', 'core.exe']), { core: 'core.exe', out: 'dir' });
});

test('CLI identifies fix acceptance separately and rejects duplicate mode flags', () => {
  assert.deepEqual(parseArgs(['--expect-responsive', '--core', 'core.exe', '--out', 'dir']),
    { core: 'core.exe', out: 'dir', expectResponsive: true });
  assert.throws(() => parseArgs(['--core','core.exe','--out','dir','--expect-responsive','--expect-responsive']), /more than once/);
});

function responsiveFixture() {
  const stop = makeSample({ messageType: 'safe_stop', response: {
    ok: true, requestId: 'stop', payload: { receipt: { attemptId: 'attempt-x', startupCancel: 'confirmed', nativePromptSent: false } },
  } });
  return {
    preControl: { timely: true, runtimeState: 'starting', attemptId: 'attempt-x', startOutstanding: true, fixtureAlive: true, replyWithheld: true },
    fixture: { initializePid: 123 },
    start: { requestId: 'start', expectedAttemptId: 'attempt-x', response: { ok: false, requestId: 'start' }, error: null, timedOut: false },
    controlWindow: { startOutstandingWhenIssued: true, fixtureAliveAtIssue: true, coreAliveAtIssue: true,
      startOutstandingAtWindowEnd: false, fixtureAliveAtWindowEnd: false, coreAliveAtWindowEnd: true,
      releaseObserved: false, releaseWrittenAt: null, initializeReplyStillWithheld: true, noPromptAtWindowEnd: true },
    control: { safeStop: stop, snapshot: makeSample(), requests: { safeStop: { requestId: 'stop' } } },
    terminal: { ok: true, attemptId: 'attempt-x', noLongerStarting: true, cancelledEvent: true, noPrompt: true },
    explicitRecovery: { ok: true, newAttempt: true, requestId: 'next', responseRequestId: 'next', promptPid: 456,
      matchingPrompt: true, originalPeerNoPrompt: true, releaseStillAbsent: true },
  };
}

test('fix acceptance requires live stall, matching cancellation, exit, no release/prompt, terminal and explicit next send', () => {
  assert.deepEqual(responsiveAcceptanceProblems(responsiveFixture()), []);
  const negatives = [
    value => { value.preControl.runtimeState = 'ready'; },
    value => { value.preControl.startOutstanding = false; },
    value => { value.preControl.fixtureAlive = false; },
    value => { value.controlWindow.fixtureAliveAtIssue = false; },
    value => { value.controlWindow.startOutstandingAtWindowEnd = true; },
    value => { value.controlWindow.fixtureAliveAtWindowEnd = true; },
    value => { value.controlWindow.coreAliveAtWindowEnd = false; },
    value => { value.controlWindow.releaseObserved = true; },
    value => { value.controlWindow.initializeReplyStillWithheld = false; },
    value => { value.controlWindow.noPromptAtWindowEnd = false; },
    value => { value.control.safeStop.response.payload.receipt.startupCancel = 'pending'; },
    value => { value.control.safeStop.response.payload.receipt.attemptId = 'wrong-target'; },
    value => { value.control.safeStop.response.payload.receipt.nativePromptSent = true; },
    value => { value.control.safeStop.response.requestId = 'wrong-request'; },
    value => { value.control.safeStop.respondedAt = 4001; },
    value => { value.control.snapshot.respondedAt = 4001; },
    value => { value.start.response.ok = true; },
    value => { value.start.error = 'disconnect'; },
    value => { value.terminal.cancelledEvent = false; },
    value => { value.terminal.noPrompt = false; },
    value => { value.explicitRecovery.ok = false; },
    value => { value.explicitRecovery.originalPeerNoPrompt = false; },
    value => { value.explicitRecovery.releaseStillAbsent = false; },
    value => { value.explicitRecovery.requestId = 'start'; },
  ];
  for (const mutate of negatives) {
    const value = responsiveFixture(); mutate(value);
    assert.notDeepEqual(responsiveAcceptanceProblems(value), [], String(mutate));
  }
});

test('attemptId is "attempt-" plus the lowercase sha256 of the raw request id (UTF-8)', () => {
  assert.equal(
    attemptIdForStartRequest('my116-start-1'),
    'attempt-397cf9b6759809e00843642f9cc4fed43624146ccd4ff86ba659b018dacb8527',
  );
  assert.equal(
    attemptIdForStartRequest('café-start'),
    'attempt-636995a7cdde26eef8feb1b3eb82925777c20f2585e12af2aa45e935a95da9e2',
  );
  assert.throws(() => attemptIdForStartRequest(''), /required/);
  assert.throws(() => attemptIdForStartRequest(undefined), /required/);
});

test('planProbe keeps every pipe/DB/workspace/APPDATA/shim path under the fresh output directory', () => {
  const plan = planProbe(path.join('C:\\evidence', 'my116'), { token: 't1' });
  assert.equal(plan.reportPath, path.resolve('C:\\evidence\\my116\\my116-report.json'));
  for (const phase of [plan.baseline, plan.stall]) {
    for (const target of [phase.workspace, phase.appData, phase.shim, phase.db]) {
      assert.equal(isInside(plan.root, target), true, `${target} must be inside ${plan.root}`);
    }
    assert.ok(phase.pipe.startsWith('\\\\.\\pipe\\goalport-my116-'));
    assert.equal(isInside(plan.root, phase.pipe), false);
  }
  assert.notEqual(plan.baseline.pipe, plan.stall.pipe);
  assert.notEqual(plan.baseline.workspace, plan.stall.workspace);
  assert.notEqual(plan.baseline.appData, plan.stall.appData);
  assert.notEqual(plan.baseline.shim, plan.stall.shim);
});

test('pre-spawn resolution follows APPDATA x64, APPDATA arm64, then PATH', t => {
  const root = tempDir('my116-wiring-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'appdata');
  const shim = path.join(root, 'shim');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(shim, { recursive: true });
  const [x64Candidate, arm64Candidate] = appDataCandidates(appData);
  const pathCodex = path.join(shim, 'codex.exe');
  fs.writeFileSync(pathCodex, 'node-copy-bytes');

  let resolution = resolveCoreCodex({ appData, pathValue: `${shim};C:\\other` });
  assert.equal(resolution.source, 'path');
  assert.equal(resolution.resolvedPath, pathCodex);

  fs.mkdirSync(path.dirname(arm64Candidate), { recursive: true });
  fs.writeFileSync(arm64Candidate, 'real-arm64');
  resolution = resolveCoreCodex({ appData, pathValue: `${shim};C:\\other` });
  assert.equal(resolution.source, 'appdata-arm64');
  assert.equal(resolution.resolvedPath, arm64Candidate);

  fs.mkdirSync(path.dirname(x64Candidate), { recursive: true });
  fs.writeFileSync(x64Candidate, 'real-x64');
  resolution = resolveCoreCodex({ appData, pathValue: `${shim};C:\\other` });
  assert.equal(resolution.source, 'appdata-x64');
  assert.equal(resolution.resolvedPath, x64Candidate);

  // A PATH without codex does not silently resolve to the copied node.
  const missing = resolveCoreCodex({ appData: path.join(root, 'empty-appdata'), pathValue: 'C:\\nothing' });
  assert.equal(missing.source, 'unresolved');
  assert.equal(missing.resolvedPath, null);
});

test('the launch guard aborts unless Core would execute the copied node.exe', t => {
  const root = tempDir('my116-guard-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shim = path.join(root, 'shim');
  fs.mkdirSync(shim, { recursive: true });
  const expectedPath = path.join(shim, 'codex.exe');
  fs.writeFileSync(expectedPath, 'copy');
  const expectedSha256 = 'aaaa';

  const good = assertFakeCodexResolution({
    resolution: { source: 'path', resolvedPath: expectedPath },
    expectedPath,
    expectedSha256,
    resolvedSha256: 'aaaa',
    shimDir: shim,
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.problems, []);

  const real = assertFakeCodexResolution({
    resolution: { source: 'appdata-x64', resolvedPath: path.join(root, 'real-codex.exe') },
    expectedPath,
    expectedSha256,
    resolvedSha256: 'bbbb',
    shimDir: shim,
  });
  assert.equal(real.ok, false);
  assert.ok(real.problems.some(problem => /not the copied node/.test(problem)));

  const unresolved = assertFakeCodexResolution({
    resolution: { source: 'unresolved', resolvedPath: null },
    expectedPath,
    expectedSha256,
    resolvedSha256: null,
    shimDir: shim,
  });
  assert.equal(unresolved.ok, false);
  assert.ok(unresolved.problems.some(problem => /refusing to fall through/.test(problem)));

  const outside = assertFakeCodexResolution({
    resolution: { source: 'path', resolvedPath: path.join(root, 'elsewhere', 'codex.exe') },
    expectedPath,
    expectedSha256,
    resolvedSha256: 'aaaa',
    shimDir: shim,
  });
  assert.equal(outside.ok, false);
  assert.ok(outside.problems.some(problem => /outside the test shim/.test(problem)));

  const bytes = assertFakeCodexResolution({
    resolution: { source: 'path', resolvedPath: expectedPath },
    expectedPath,
    expectedSha256,
    resolvedSha256: 'ffff',
    shimDir: shim,
  });
  assert.equal(bytes.ok, false);
  assert.ok(bytes.problems.some(problem => /do not match the copied node/.test(problem)));
});

test('isolated APPDATA must not contain any real Codex candidate', t => {
  const root = tempDir('my116-appdata-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'appdata');
  fs.mkdirSync(appData, { recursive: true });
  assert.deepEqual(isolatedAppDataProblems({ appData }), []);
  const [x64Candidate] = appDataCandidates(appData);
  fs.mkdirSync(path.dirname(x64Candidate), { recursive: true });
  fs.writeFileSync(x64Candidate, 'real');
  const problems = isolatedAppDataProblems({ appData });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /contains a Codex candidate/);
});

test('Core gets a child-only shim-first PATH and isolated APPDATA with no inherited GOALPORT switches', () => {
  const env = buildCoreEnv({
    baseEnv: {
      PATH: 'C:\\Windows\\System32',
      Path: 'C:\\duplicate-path',
      APPDATA: 'C:\\Users\\real\\AppData\\Roaming',
      USERPROFILE: 'C:\\Users\\real',
      GOALPORT_CODEX_TRANSPORT: 'exec',
      GOALPORT_CODEX_APPROVAL_POLICY: 'untrusted',
      GOALPORT_SOMETHING: '1',
    },
    shimDir: 'C:\\evidence\\shim',
    appData: 'C:\\evidence\\appdata',
    nonce: 'nonce-1',
  });
  assert.equal(env.PATH, 'C:\\evidence\\shim;C:\\Windows\\System32');
  assert.equal(env.APPDATA, 'C:\\evidence\\appdata');
  assert.equal(env.USERPROFILE, 'C:\\Users\\real');
  assert.equal(env.GOALPORT_LAUNCH_NONCE, 'nonce-1');
  assert.equal(env.GOALPORT_REQUIRE_ISOLATED, '1');
  assert.equal(env.GOALPORT_CODEX_TRANSPORT, undefined);
  assert.equal(env.GOALPORT_CODEX_APPROVAL_POLICY, undefined);
  assert.equal(env.GOALPORT_SOMETHING, undefined);
  assert.equal(env.Path, undefined);
});

test('the stall window scores timely, blocked, connect-timeout, late and invalid samples honestly', () => {
  const timely = scoreControlSample(makeSample(), { windowMs: OBSERVATION_WINDOW_MS });
  assert.equal(timely.timely, true);
  assert.equal(timely.blocked, false);
  assert.equal(timely.responseValid, true);
  assert.deepEqual(timely.invalid, []);

  const boundary = scoreControlSample(makeSample({ responded: 1000 + OBSERVATION_WINDOW_MS }), {
    windowMs: OBSERVATION_WINDOW_MS,
  });
  assert.equal(boundary.timely, true, 'a response exactly on the bound is inside it');

  const blocked = scoreControlSample(makeSample({ responded: null, timedOut: true }), {
    windowMs: OBSERVATION_WINDOW_MS,
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.timely, false);
  assert.deepEqual(blocked.reasons, ['no_response_within_window']);

  const connectTimedOut = scoreControlSample(
    makeSample({ connected: null, written: null, responded: null, timedOut: true }),
    { windowMs: OBSERVATION_WINDOW_MS },
  );
  assert.equal(connectTimedOut.blocked, true, 'a connection that never completes is a blocked control request');
  assert.equal(connectTimedOut.connectTimedOut, true);
  assert.deepEqual(connectTimedOut.invalid, []);

  const late = scoreControlSample(makeSample({ responded: 1000 + OBSERVATION_WINDOW_MS + 1 }), {
    windowMs: OBSERVATION_WINDOW_MS,
  });
  assert.equal(late.timely, false, 'a response after the observation bound is not timely');
  assert.equal(late.lateResponse, true);
  assert.equal(late.blocked, true);

  const afterRelease = scoreControlSample(makeSample({ responded: 1200 }), {
    windowMs: OBSERVATION_WINDOW_MS,
    releaseAt: 1150,
  });
  assert.equal(afterRelease.timely, false);
  assert.equal(afterRelease.afterRelease, true);
  assert.ok(afterRelease.reasons.includes('response_after_release'));

  const connectError = scoreControlSample(
    makeSample({ connected: null, written: null, responded: null, connectError: 'ENOENT: no pipe' }),
    { windowMs: OBSERVATION_WINDOW_MS },
  );
  assert.equal(connectError.blocked, false);
  assert.deepEqual(connectError.invalid, ['connect_error']);

  const notWritten = scoreControlSample(makeSample({ written: null }), { windowMs: OBSERVATION_WINDOW_MS });
  assert.deepEqual(notWritten.invalid, ['request_not_written']);

  const empty = scoreControlSample(null);
  assert.deepEqual(empty.invalid, ['sample_missing']);
});

test('verdict rules: baseline/stall gating, all-blocked reproduction, timely non-reproduction, mixed=inconclusive', () => {
  const ok = { valid: true };
  const proven = { proven: true };
  const blockedSample = type => makeSample({ messageType: type, responded: null, timedOut: true });
  const timelySnapshot = makeSample({ messageType: 'snapshot', response: SNAPSHOT_OK });
  const timelyStop = makeSample({ messageType: 'safe_stop', response: STOP_OK });

  const invalidBaseline = computeVerdict({
    baseline: { valid: false },
    stall: proven,
    snapshot: blockedSample('snapshot'),
    safeStop: blockedSample('safe_stop'),
  });
  assert.equal(invalidBaseline.verdict, 'inconclusive');
  assert.ok(invalidBaseline.reasons.includes('baseline_invalid'));

  const unprovedStall = computeVerdict({
    baseline: ok,
    stall: { proven: false },
    snapshot: blockedSample('snapshot'),
    safeStop: blockedSample('safe_stop'),
  });
  assert.equal(unprovedStall.verdict, 'inconclusive');
  assert.ok(unprovedStall.reasons.includes('stall_unproven'));

  const reproduced = computeVerdict({
    baseline: ok,
    stall: proven,
    snapshot: blockedSample('snapshot'),
    safeStop: blockedSample('safe_stop'),
  });
  assert.equal(reproduced.verdict, 'reproduced');
  assert.deepEqual(reproduced.reasons, []);
  assert.equal(reproduced.snapshot.blocked, true);
  assert.equal(reproduced.safeStop.blocked, true);

  const notReproduced = computeVerdict({
    baseline: ok,
    stall: proven,
    snapshot: timelySnapshot,
    safeStop: timelyStop,
  });
  assert.equal(notReproduced.verdict, 'not_reproduced');

  const partial = computeVerdict({
    baseline: ok,
    stall: proven,
    snapshot: timelySnapshot,
    safeStop: blockedSample('safe_stop'),
  });
  assert.equal(partial.verdict, 'inconclusive');
  assert.ok(partial.reasons.includes('mixed_control_responses'));

  const invalidControl = computeVerdict({
    baseline: ok,
    stall: proven,
    snapshot: makeSample({ messageType: 'snapshot', connected: null, written: null, responded: null, connectError: 'EPIPE' }),
    safeStop: blockedSample('safe_stop'),
  });
  assert.equal(invalidControl.verdict, 'inconclusive');
  assert.ok(invalidControl.reasons.includes('control_sample_invalid'));

  const lateResponses = computeVerdict({
    baseline: ok,
    stall: proven,
    snapshot: makeSample({ messageType: 'snapshot', responded: 1000 + OBSERVATION_WINDOW_MS + 5 }),
    safeStop: makeSample({ messageType: 'safe_stop', responded: 1000 + OBSERVATION_WINDOW_MS + 6 }),
  });
  assert.equal(lateResponses.verdict, 'reproduced', 'late responses are not timely responses');
  assert.equal(lateResponses.snapshot.lateResponse, true);

  const stopWithoutProvenTurn = computeVerdict({
    baseline: ok,
    stall: proven,
    snapshot: timelySnapshot,
    safeStop: makeSample({
      messageType: 'safe_stop',
      response: {
        ok: false,
        error:
          'attempt attempt-x has no proven cancellable live turn: the Codex turn start has not been acknowledged (or its transport is closed); Stop is not offered',
      },
    }),
  });
  assert.equal(stopWithoutProvenTurn.verdict, 'not_reproduced');
  assert.equal(stopWithoutProvenTurn.safeStop.responseValid, true, 'the error body still counts as responsive');
});

test('stop effectiveness is scored separately from responsiveness', () => {
  const confirmed = classifyStopEffectiveness({
    timely: true,
    sample: { response: STOP_OK },
  });
  assert.equal(confirmed.effective, true);
  assert.equal(confirmed.classification, 'confirmed');

  const noProvenTurn = classifyStopEffectiveness({
    timely: true,
    sample: { response: { ok: false, error: 'attempt attempt-x has no proven cancellable live turn: ...' } },
  });
  assert.equal(noProvenTurn.responsiveInWindow, true);
  assert.equal(noProvenTurn.effective, false);
  assert.equal(noProvenTurn.classification, 'no_proven_cancellable_live_turn');

  const unconfirmed = classifyStopEffectiveness({
    timely: true,
    sample: { response: { ok: true, payload: { receipt: { attemptId: 'attempt-x', confirmed: false } } } },
  });
  assert.equal(unconfirmed.responsiveInWindow, true);
  assert.equal(unconfirmed.effective, false);
  assert.equal(unconfirmed.classification, 'unconfirmed');

  const blocked = classifyStopEffectiveness({ timely: false, blocked: true, invalid: [], reasons: [] });
  assert.equal(blocked.responsiveInWindow, false);
  assert.equal(blocked.effective, false);
  assert.equal(blocked.classification, 'blocked');
});

test('fixture markers must show the copied node, the probe workspace, the scenario and Core argv', () => {
  const workspace = 'C:\\evidence\\baseline\\workspace';
  const codexExe = 'C:\\evidence\\baseline\\shim\\codex.exe';
  const instance = {
    pid: 123,
    cwd: workspace,
    execPath: codexExe,
    scenario: BASELINE_SCENARIO,
    argv: [...EXPECTED_FIXTURE_ARGV],
    markerFile: 'm',
  };
  assert.equal(validateFixtureInstances([instance], { workspace, codexExe, scenario: BASELINE_SCENARIO }).valid, true);
  // Windows path comparison is case-insensitive and tolerates the extended-length prefix.
  assert.equal(
    validateFixtureInstances([{ ...instance, cwd: `\\\\?\\${workspace.toLowerCase()}` }], {
      workspace,
      codexExe,
      scenario: BASELINE_SCENARIO,
    }).valid,
    true,
  );
  assert.equal(validateFixtureInstances([], { workspace, codexExe, scenario: BASELINE_SCENARIO }).valid, false);
  for (const broken of [
    { ...instance, cwd: 'C:\\somewhere-else' },
    { ...instance, execPath: path.join('C:\\real', 'codex.exe') },
    { ...instance, scenario: STALL_SCENARIO },
    { ...instance, argv: ['app-server', '--listen', 'stdio://'] },
    { ...instance, pid: '123' },
  ]) {
    assert.equal(
      validateFixtureInstances([broken], { workspace, codexExe, scenario: BASELINE_SCENARIO }).valid,
      false,
      `broken marker must be refused: ${JSON.stringify(broken)}`,
    );
  }
});

async function startFixture(workspace, scenario) {
  fs.writeFileSync(path.join(workspace, '.fake-codex-scenario'), `${scenario}\n`);
  fs.writeFileSync(path.join(workspace, 'app-server'), `import("${pathToFileURL(FIXTURE).href}");\n`);
  const child = spawn(process.execPath, ['app-server', '--listen', 'stdio://'], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => {
    state.stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    state.stderr += chunk;
  });
  return { child, state };
}

async function waitUntil(predicate, timeoutMs, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

async function stopFixture(child, workspace) {
  fs.writeFileSync(path.join(workspace, '.fake-codex-stop.marker'), '1\n');
  const exited = await Promise.race([once(child, 'exit').then(() => true), sleep(5000).then(() => false)]);
  if (!exited) {
    child.kill();
    await Promise.race([once(child, 'exit'), sleep(2000)]);
  }
  return exited;
}

test('stall_initialize records initialize, withholds the reply and releases it on the marker', async t => {
  const workspace = tempDir('my116-fixture-stall-');
  const { child, state } = await startFixture(workspace, STALL_SCENARIO);
  t.after(async () => {
    try {
      child.kill();
    } catch {
      // already gone
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  child.stdin.write(`${JSON.stringify({ id: 7, method: 'initialize', params: {} })}\n`);
  const initializedMarker = path.join(workspace, '.fake-codex-initialized.marker');
  assert.equal(await waitUntil(() => fs.existsSync(initializedMarker), 5000), true, 'initialize receipt marker');
  const record = JSON.parse(fs.readFileSync(initializedMarker, 'utf8'));
  assert.equal(record.kind, 'initialize.received');
  assert.equal(record.requestId, 7);
  assert.equal(record.scenario, STALL_SCENARIO);
  assert.equal(record.pid, child.pid);
  assert.equal(fs.existsSync(path.join(workspace, '.fake-codex-release')), false);

  await sleep(400);
  assert.equal(state.stdout.includes('"id":7'), false, 'the initialize reply is withheld before release');

  fs.writeFileSync(path.join(workspace, '.fake-codex-release'), '1\n');
  assert.equal(await waitUntil(() => state.stdout.includes('"id":7'), 5000), true, 'reply after release');
  const reply = JSON.parse(state.stdout.trim().split('\n').filter(Boolean).at(-1));
  assert.deepEqual(reply, { id: 7, result: {} }, 'the default initialize reply is unchanged');
  assert.equal(fs.existsSync(path.join(workspace, '.fake-codex-initialize-released.marker')), true);
  assert.equal(await stopFixture(child, workspace), true, 'the stop marker still ends the fixture');
});

test('existing scenarios keep the immediate default initialize reply', async t => {
  const workspace = tempDir('my116-fixture-linger-');
  const { child, state } = await startFixture(workspace, BASELINE_SCENARIO);
  t.after(async () => {
    try {
      child.kill();
    } catch {
      // already gone
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  child.stdin.write(`${JSON.stringify({ id: 11, method: 'initialize', params: {} })}\n`);
  assert.equal(await waitUntil(() => state.stdout.includes('"id":11'), 5000), true);
  assert.deepEqual(JSON.parse(state.stdout.trim().split('\n').filter(Boolean).at(-1)), { id: 11, result: {} });
  assert.equal(fs.existsSync(path.join(workspace, '.fake-codex-initialized.marker')), false);
  assert.equal(await stopFixture(child, workspace), true);
});
