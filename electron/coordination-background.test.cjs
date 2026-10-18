const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createBackgroundHost } = require('./coordination-background.cjs');
const { createCoordinationJobStore } = require('./coordination-job.cjs');
function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goalport-host-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // One stable control endpoint per fixture. Windows cannot bind a Unix-domain
  // socket at a filesystem path (CI saw EACCES from listen() on job.sock — a
  // test-harness error, not a Windows product failure), so the alive-owner
  // hang there uses a private named pipe instead.
  const controlEndpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\goalport-coord-${process.pid}-${Math.random().toString(16).slice(2)}`
    : path.join(directory, 'job.sock');
  const launches = [];
  const options = { directory: () => directory, ready: () => true, ordinaryScope: () => null,
    env: { GOALPORT_COORDINATE_SEND: '1' }, snapshot: async () => ({ bounds: { projectionUnavailable: false }, attempt: { state: 'completed' } }),
    endpoint: () => controlEndpoint, workerPath: '/app/coordination-worker.cjs', config: () => ({ enginePath: '/app/dist/coordination-engine.cjs' }), startTimeoutMs: 0,
    spawn: (...args) => { launches.push(args); return { on() {}, unref() {} }; }, ...overrides };
  const host = createBackgroundHost(options);
  const input = { requestId: 'one-send', goal: 'Plan this fixture', workspaceRoot: directory, readInstances: ['codex', 'claude'], readMaxTurns: 4, backgroundConsent: true };
  return { directory, options, input, launches, host };
}
test('background gate truth table preserves per-goal and checkout refusals', async t => {
  for (const envSet of [false, true]) for (const allowed of [false, true]) {
    for (const backgroundConsent of [false, true]) for (const checkout of [false, true]) for (const serverCwd of [false, true]) {
      const env = { GOALPORT_COORDINATE_SEND: envSet ? '1' : '0',
        ...(checkout ? { GOALPORT_HARNESS_CHECKOUT: '/pinned' } : {}),
        ...(serverCwd ? { GOALPORT_HARNESS_SERVER_CWD: '/pinned/server' } : {}) };
      const r = setup(t, { env, consent: () => ({ allowed }) });
      const capability = (envSet || allowed) && !checkout && !serverCwd;
      if (capability && backgroundConsent) {
        await r.host.start({ ...r.input, backgroundConsent });
        assert.equal(r.launches.length, 1);
      } else {
        await assert.rejects(() => r.host.start({ ...r.input, backgroundConsent }),
          error => error.code === (capability ? 'background-consent-required' : 'background-unavailable'));
        assert.equal(r.launches.length, 0);
        assert.equal(fs.existsSync(path.join(r.directory, 'coordination-jobs')), false);
      }
    }
  }
});
test('separate consent gates and bootstrap/refused Core launch nothing', async t => {
  for (const overrides of [{ ready: () => false }, { env: {} }, { env: { GOALPORT_COORDINATE_SEND: '1', GOALPORT_HARNESS_CHECKOUT: '/pinned' } }, { ordinaryScope: () => ({ generation: 1 }) }, { snapshot: async () => ({ bounds: { projectionUnavailable: true } }) }, { snapshot: async () => ({ bounds: {}, project: { workspaceRoot: '' }, stopResponsibility: { writeResponsibility: 'held' } }) }]) {
    const r = setup(t, overrides); await assert.rejects(() => r.host.start(r.input)); assert.equal(r.launches.length, 0);
  }
  const r = setup(t); await assert.rejects(() => r.host.start({ ...r.input, backgroundConsent: false })); assert.equal(r.launches.length, 0);
});
test('duplicate request and missing endpoint never spawn replacement or authorize history', async t => {
  const r = setup(t);
  fs.writeFileSync(path.join(r.directory, 'coordination-records.json'), JSON.stringify([{ requestId: 'history', backgroundConsent: true }]));
  assert.equal(await r.host.status(), null);
  const first = await r.host.start(r.input);
  assert.equal(first.live, false); assert.equal(first.state, 'unconfirmed'); assert.equal(r.host.outstanding(), true);
  const duplicate = await r.host.start(r.input);
  assert.equal(duplicate.jobId, first.jobId); assert.equal(r.launches.length, 1);
  assert.deepEqual(r.launches[0][2].stdio, 'ignore'); assert.equal(r.launches[0][2].detached, true); assert.equal(r.launches[0][2].env.ELECTRON_RUN_AS_NODE, '1');
  await assert.rejects(() => r.host.start({ ...r.input, requestId: 'second' })); assert.equal(r.launches.length, 1);
  const stopped = await r.host.revoke(first.jobId);
  assert.equal(stopped.revoked, true); assert.equal(stopped.live, false); assert.equal(stopped.state, 'unconfirmed'); assert.equal(r.host.outstanding(), true);
  const retained = createCoordinationJobStore(r.directory, { bootstrapReady: true }).getStatus(first.jobId);
  assert.equal(retained.revoked, true); assert.equal(retained.active, true);
});
test('read-only start does not add write admission, and reopening is read-only', async t => {
  const r = setup(t); const first = await r.host.start(r.input);
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  assert.equal(store.getStatus(first.jobId).admission.writeAuthorization, null);
  const reopened = createBackgroundHost(r.options); assert.equal((await reopened.status()).jobId, first.jobId); assert.equal(r.launches.length, 1);
  assert.equal('admission' in first, false); assert.equal('ownerToken' in first, false);
});

test('Start forwards complete execution feedback into immutable durable admission', async t => {
  const r = setup(t);
  const executionFeedback = {
    previousPlan: 'previous plan',
    previousPlanReview: 'previous review',
    previousExecutionReport: 'previous execution report',
    previousExecutionAudit: 'previous execution audit',
    previousCommandIds: ['prior-command-1'],
  };
  const first = await r.host.start({ ...r.input, executionFeedback });
  const admission = createCoordinationJobStore(r.directory, { bootstrapReady: true }).getStatus(first.jobId).admission;
  assert.deepEqual(admission.executionFeedback, executionFeedback);
});

test('a long accepted goal does not hide the live stop control', { skip: process.platform !== 'linux' }, async t => {
  const r = setup(t);
  const goal = 'g'.repeat(9000);
  const started = await r.host.start({ ...r.input, goal });
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  const claim = store.claimWorker(started.jobId);
  store.updateProgress(started.jobId, { display: { activity: 'r'.repeat(20_000), failures: [] } }, claim.ownerToken);
  const server = await store.startControlServer({ jobId: started.jobId, endpoint: r.options.endpoint() });
  t.after(() => server.close());
  const live = await r.host.status(started.jobId);
  assert.equal(live.live, true);
  assert.equal(live.state, 'running');
  assert.equal(live.goal, goal);
  assert.equal(live.revoked, false);
  assert.equal('admission' in live, false);
});

test('a missing admission pointer does not admit competing ordinary or native execution', async t => {
  const r = setup(t); const job = await r.host.start(r.input);
  fs.unlinkSync(path.join(r.directory, 'coordination-jobs/active-admission.json'));
  assert.equal(r.host.outstanding(), true);
  assert.equal((await r.host.status()).state, 'unconfirmed');
  await assert.rejects(() => r.host.start({ ...r.input, requestId: 'replacement' }));
  assert.equal(r.launches.length, 1); assert.equal((await r.host.status()).jobId, job.jobId);
});

test('host refusal codes distinguish definite guards and leave a fresh profile untouched', async t => {
  const cases = [
    [{ ready: () => false }, {}, 'background-unavailable'],
    [{ env: {} }, {}, 'background-unavailable'],
    [{ env: { GOALPORT_COORDINATE_SEND: '1', GOALPORT_HARNESS_SERVER_CWD: '/pinned' } }, {}, 'background-unavailable'],
    [{ ordinaryScope: () => ({ generation: 1 }) }, {}, 'background-scope-conflict'],
    [{ snapshot: async () => ({ bounds: { projectionUnavailable: true } }) }, {}, 'background-core-refused'],
    [{}, { backgroundConsent: false }, 'background-consent-required'],
    [{}, { goal: '' }, 'background-invalid-admission'],
  ];
  for (const [overrides, inputOverrides, code] of cases) {
    const r = setup(t, overrides);
    await assert.rejects(() => r.host.start({ ...r.input, ...inputOverrides }), error => error.code === code);
    assert.equal(r.launches.length, 0);
    assert.equal(fs.existsSync(path.join(r.directory, 'coordination-jobs')), false);
    assert.equal(createCoordinationJobStore(r.directory, { bootstrapReady: true }).getActiveStatus(), null);
  }
});

test('endpoint, worker config, serialization and snapshot failures are preflight refusals before any admission', async t => {
  const circular = {}; circular.self = circular;
  const cases = [
    { endpoint: () => { throw new Error('endpoint unavailable'); } },
    { config: () => { throw new Error('config unavailable'); } },
    { config: () => ({ circular }) },
    { snapshot: async () => { throw new Error('snapshot unavailable'); } },
  ];
  for (const overrides of cases) {
    const r = setup(t, overrides);
    await assert.rejects(() => r.host.start(r.input), error => error.code === 'background-preflight-failed' && error.message === 'Background Send could not be prepared, so nothing was admitted.');
    assert.equal(r.launches.length, 0);
    assert.equal(fs.existsSync(path.join(r.directory, 'coordination-jobs')), false);
  }
});

test('a concurrent Start is explicitly refused without releasing the first Start lock', async t => {
  let releaseSnapshot;
  const snapshotPending = new Promise(resolve => { releaseSnapshot = resolve; });
  const r = setup(t, { snapshot: () => snapshotPending });
  const first = r.host.start(r.input);
  await assert.rejects(() => r.host.start({ ...r.input, requestId: 'second' }), { code: 'background-start-in-progress' });
  releaseSnapshot({ bounds: { projectionUnavailable: false }, attempt: { state: 'completed' } });
  const started = await first;
  assert.equal(started.requestId, r.input.requestId);
  assert.equal(r.launches.length, 1);
});

test('a competing admission returns job-conflict and retains the original slot unchanged', async t => {
  const r = setup(t);
  const first = await r.host.start(r.input);
  await assert.rejects(() => r.host.start({ ...r.input, requestId: 'different-request' }), { code: 'background-job-conflict' });
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  assert.equal(store.getActiveStatus().jobId, first.jobId);
  assert.equal(store.getActiveStatus().requestId, r.input.requestId);
  assert.equal(r.launches.length, 1);
});

test('post-admission spawn failure is an unknown result and retains the durable slot', async t => {
  const r = setup(t, { spawn: () => { throw new Error('spawn failed'); } });
  await assert.rejects(() => r.host.start(r.input), { code: 'background-admission-unknown' });
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  assert.ok(store.getActiveStatus());
  assert.equal(r.host.outstanding(), true);
});

function listenSilently(endpoint, t) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.unref();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      t.after(() => new Promise(done => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }));
      resolve(server);
    });
  });
}
async function leaveAndRefuseSameFolder(t, r, jobId) {
  const left = await r.host.acknowledge(jobId);
  assert.equal(left.live, false);
  assert.notEqual(left.state, 'completed');
  assert.notEqual(left.state, 'stopped');
  assert.notEqual(left.state, 'failed');
  await assert.rejects(() => r.host.start({ ...r.input, requestId: 'next-send' }), error => error.code === 'background-job-conflict' && /unfinished background goal/.test(error.message));
  assert.equal(r.host.outstanding(r.input.workspaceRoot), true);
  assert.equal(r.host.outstanding(path.resolve('/tmp/goalport-other-folder')), false);
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  assert.equal(store.getStatus(jobId).outcome, null);
}
test('an alive owner that does not answer status still holds the same folder', async t => {
  const r = setup(t);
  const started = await r.host.start(r.input);
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  const claim = store.claimWorker(started.jobId);
  store.recordPendingCommand(started.jobId, { commandId: 'coordinate-plan-send-unknown', role: 'planning' }, claim.ownerToken);
  await listenSilently(r.options.endpoint(), t);
  await leaveAndRefuseSameFolder(t, r, started.jobId);
  assert.equal(store.getStatus(started.jobId).pendingCommand.commandId, 'coordinate-plan-send-unknown');
});
test('a dead owner with unknown descendants still holds the same folder', async t => {
  const r = setup(t);
  const started = await r.host.start(r.input);
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  store.claimWorker(started.jobId);
  await leaveAndRefuseSameFolder(t, r, started.jobId);
});
test('a never-dispatched admission still holds the same folder after it is left', async t => {
  const r = setup(t, { spawn: () => { throw new Error('spawn failed'); } });
  await assert.rejects(() => r.host.start(r.input), { code: 'background-admission-unknown' });
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  const held = store.getActiveStatus();
  assert.equal(held.startupClaim, null);
  await leaveAndRefuseSameFolder(t, r, held.jobId);
});
test('a confirmed terminal outcome admits the next send in the same folder', async t => {
  const r = setup(t);
  const started = await r.host.start(r.input);
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  const claim = store.claimWorker(started.jobId);
  store.recordOutcome(started.jobId, { status: 'completed', summary: 'finished' }, claim.ownerToken);
  store.releaseAdmission(started.jobId, claim.ownerToken);
  const next = await r.host.start({ ...r.input, requestId: 'next-send' });
  assert.equal(next.requestId, 'next-send');
  assert.notEqual(next.jobId, started.jobId);
  assert.equal(r.host.outstanding(r.input.workspaceRoot), true);
});
test('a long derivable Linux endpoint is bounded in worker config before admission', { skip: process.platform !== 'linux' }, async t => {
  const { controlEndpointFor } = require('./coordination-job.cjs');
  const r = setup(t);
  const profileEndpoint = path.join(r.directory, `control-${'x'.repeat(120)}`);
  let endpointCalls = 0;
  r.options.endpoint = () => { endpointCalls++; return controlEndpointFor(profileEndpoint, { platform: 'linux', env: { HOME: r.directory } }); };
  const started = await r.host.start(r.input);
  const workerConfig = JSON.parse(r.launches[0][1][1]);
  assert.equal(Buffer.byteLength(workerConfig.controlEndpoint, 'utf8') <= 107, true);
  assert.equal(path.dirname(workerConfig.controlEndpoint), r.directory);
  assert.equal(workerConfig.controlEndpoint, r.options.endpoint());
  assert.equal(endpointCalls, 2); // One preparation plus this explicit assertion.
  assert.equal(started.live, false);
});

test('an acknowledged job holds the same Windows folder across casing on the win32 identity only', async t => {
  // Regression: the folder lookup compared path.resolve results exactly, so a
  // Windows path arriving with different casing (or a trailing separator, or
  // forward slashes) did not stay held. The identity function is selected per
  // platform here; production passes the host platform.
  const windowsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'goalport-host-identity-'));
  t.after(() => fs.rmSync(windowsDirectory, { recursive: true, force: true }));
  const windowsStore = createCoordinationJobStore(windowsDirectory, { bootstrapReady: true, platform: 'win32' });
  const windowsInput = { requestId: 'one-send', goal: 'Plan this fixture', workspacePath: 'C:\\Users\\Agent\\Work\\Goal',
    allowedInstances: ['codex'], maxTurns: 4, backgroundConsent: true };
  const admitted = windowsStore.startAdmission(windowsInput);
  assert.equal(admitted.ok, true);
  windowsStore.acknowledgeStuck(admitted.jobId);
  const windowsHost = createBackgroundHost({ directory: () => windowsDirectory, ready: () => true, platform: 'win32' });
  assert.equal(windowsHost.outstanding('c:\\users\\agent\\work\\goal'), true);
  assert.equal(windowsHost.outstanding('C:/USERS/AGENT/WORK/GOAL/'), true);
  assert.equal(windowsHost.outstanding('C:\\Users\\Agent\\Work\\Other'), false);
  const recased = windowsStore.startAdmission({ ...windowsInput, requestId: 'next-send', workspacePath: 'c:\\users\\agent\\work\\goal' });
  assert.equal(recased.ok, false);
  assert.equal(recased.reason, 'workspace-held');
  const different = windowsStore.startAdmission({ ...windowsInput, requestId: 'next-send', workspacePath: 'C:\\Users\\Agent\\Work\\Other' });
  assert.equal(different.ok, true);

  // The posix identity compares exactly: a case-different path is a different
  // folder and must not stay held.
  const posixDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'goalport-host-identity-'));
  t.after(() => fs.rmSync(posixDirectory, { recursive: true, force: true }));
  const posixStore = createCoordinationJobStore(posixDirectory, { bootstrapReady: true, platform: 'linux' });
  const posixInput = { requestId: 'one-send', goal: 'Plan this fixture', workspacePath: '/work/Goal',
    allowedInstances: ['codex'], maxTurns: 4, backgroundConsent: true };
  const posixAdmitted = posixStore.startAdmission(posixInput);
  assert.equal(posixAdmitted.ok, true);
  posixStore.acknowledgeStuck(posixAdmitted.jobId);
  const posixHost = createBackgroundHost({ directory: () => posixDirectory, ready: () => true, platform: 'linux' });
  assert.equal(posixHost.outstanding('/work/Goal'), true);
  assert.equal(posixHost.outstanding('/work/goal'), false);
});

test('an acknowledged job still holds its folder and reports the acknowledgement after a worker replaces progress from a stale snapshot', async t => {
  const r = setup(t);
  const started = await r.host.start(r.input);
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  const claim = store.claimWorker(started.jobId);
  store.recordPendingCommand(started.jobId, { commandId: 'coordinate-plan-send-unknown', role: 'planning' }, claim.ownerToken);
  store.recordOutcome(started.jobId, { status: 'unconfirmed', reason: 'Worker outcome was not observed.' }, claim.ownerToken);
  const progressPath = path.join(r.directory, 'coordination-jobs', 'jobs', started.jobId, 'progress.json');
  const stale = fs.readFileSync(progressPath, 'utf8');
  const left = await r.host.acknowledge(started.jobId);
  assert.equal(typeof left.acknowledgedStuckAt, 'string');
  // The live worker's atomic replacement lands from a snapshot taken before
  // the acknowledgement; the marker must survive it.
  fs.writeFileSync(progressPath, stale);
  assert.equal(r.host.outstanding(r.input.workspaceRoot), true);
  assert.equal(r.host.outstanding(path.resolve('/tmp/goalport-other-folder')), false);
  const after = await r.host.status(started.jobId);
  assert.equal(after.acknowledgedStuckAt, left.acknowledgedStuckAt);
  assert.equal(after.state, 'unconfirmed');
  assert.equal(after.pendingCommand.commandId, 'coordinate-plan-send-unknown');
  await assert.rejects(() => r.host.start({ ...r.input, requestId: 'next-send' }), { code: 'background-job-conflict' });
  assert.equal(r.launches.length, 1);
});
