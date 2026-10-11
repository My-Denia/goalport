const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackgroundHost } = require('./coordination-background.cjs');
const { createCoordinationJobStore } = require('./coordination-job.cjs');
function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goalport-host-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launches = [];
  const options = { directory: () => directory, ready: () => true, ordinaryScope: () => null,
    env: { GOALPORT_COORDINATE_SEND: '1' }, snapshot: async () => ({ bounds: { projectionUnavailable: false }, attempt: { state: 'completed' } }),
    endpoint: () => path.join(directory, 'job.sock'), workerPath: '/app/coordination-worker.cjs', config: () => ({ enginePath: '/app/dist/coordination-engine.cjs' }), startTimeoutMs: 0,
    spawn: (...args) => { launches.push(args); return { on() {}, unref() {} }; }, ...overrides };
  const host = createBackgroundHost(options);
  const input = { requestId: 'one-send', goal: 'Plan this fixture', workspaceRoot: directory, readInstances: ['codex', 'claude'], readMaxTurns: 4, backgroundConsent: true };
  return { directory, options, input, launches, host };
}
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
});
test('read-only start does not add write admission, and reopening is read-only', async t => {
  const r = setup(t); const first = await r.host.start(r.input);
  const store = createCoordinationJobStore(r.directory, { bootstrapReady: true });
  assert.equal(store.getStatus(first.jobId).admission.writeAuthorization, null);
  const reopened = createBackgroundHost(r.options); assert.equal((await reopened.status()).jobId, first.jobId); assert.equal(r.launches.length, 1);
  assert.equal('admission' in first, false); assert.equal('ownerToken' in first, false);
});

test('a long accepted goal does not hide the live stop control', async t => {
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
