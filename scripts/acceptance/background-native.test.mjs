import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from './background-native.mjs';
import { BACKGROUND_SCENARIOS, backgroundAssertions, validateBackgroundReport } from './lib/background-scenarios.mjs';
import { STUB_BEHAVIORS } from './stub-harness.mjs';

test('driver requires fresh explicit output and bounded BG1-BG3 offline queues', () => {
  assert.throws(() => parseArgs([])); assert.throws(() => parseArgs(['--out', 'x', '--force']));
  assert.equal(parseArgs(['--out', 'x']), 'x');
  assert.deepEqual(Object.keys(BACKGROUND_SCENARIOS), ['BG1', 'BG2', 'BG3']);
  for (const s of Object.values(BACKGROUND_SCENARIOS)) {
    assert.equal(s.behavior.turns.claude[0], 'claude-carry-out-delayed');
    for (const id of [...s.behavior.turns.codex, ...s.behavior.turns.claude]) assert.ok(STUB_BEHAVIORS[id]);
  }
});
test('acceptance rejects blocked prose-only reports and synthetic UI substitutions', () => {
  assert.throws(() => validateBackgroundReport({ kind: 'c2-real-app-offline-background', status: 'blocked' }));
  const source = readFileSync(new URL('./background-native.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('previousLaunch.reopenUi'));
  assert.ok(source.includes("process.kill(pid, 'SIGTERM')"));
  assert.ok(source.includes('argvBytes.includes(r.beforeClose.jobId)'));
  assert.equal(source.includes('Emulation.setDeviceMetricsOverride'), false);
  assert.equal(source.includes('window.goalportCore.backgroundStart('), false); // real DOM Send, not IPC launch injection
});
function facts() {
  return { freshDefaults: { backgroundOff: true, writeOff: true, reads: '4' }, sendClicks: 1,
    beforeClose: { jobId: 'original', workerPid: 22, requestId: 'one', pendingCommand: { commandId: 'pending' } }, returned: { jobId: 'original', workerPid: 22, live: true, active: true }, mainScopeBeforeClose: null, returnedMainScope: null,
    admissions: [{}], claims: [{}], launch: { pid: 1 }, reopen: { pid: 2 }, close: { electronExit: { code: 0, signal: null, observedAt: '2026-01-01T00:00:00Z' }, tempRetained: true, corePids: [3] },
    before: { files: [{ relative: 'test/add.test.mjs', sha256: 'same' }, { relative: '.goalport-offline-fixture.json', sha256: 'same' }] }, after: { files: [{ relative: 'test/add.test.mjs', sha256: 'same' }, { relative: '.goalport-offline-fixture.json', sha256: 'same' }] },
    rendererExit: { endedAt: '2026-01-01T00:00:00Z' }, screenshots: [], finalJob: { requestId: 'one', counters: { readTurnsLeft: 0, writeTurnsLeft: 0 }, state: 'completed', active: false }, operations: [],
    artifactsFinal: { invocations: [], ledger: {}, claims: [], records: [] },
  };
}
test('process exit, identity, history and interrupted evidence are load-bearing predicates', () => {
  const f = facts();
  assert.equal(backgroundAssertions('BG1', f).oneSendOneOwner, true);
  f.returned.workerPid = 99; assert.equal(backgroundAssertions('BG1', f).oneSendOneOwner, false);
  f.close.electronExit.signal = 'SIGKILL'; assert.equal(backgroundAssertions('BG1', f).actualNormalDesktopExit, false);
  f.artifactsFinal.records = [{ authorizedTurnsLeft: 4 }]; assert.equal(backgroundAssertions('BG1', f).historyPermissionFree, false);
  assert.equal(backgroundAssertions('BG3', f).interruptedHonest, false);
});
