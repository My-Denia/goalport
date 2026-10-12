import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseArgs, validateFeedbackReport, NOT_VERIFIED } from './feedback-native.mjs';
import { FEEDBACK_SCENARIOS, feedbackAssertions, snapshotFixture, baselineChecks, WIDTHS, INCOMPLETE_SOURCE_HASH, REPAIRED_SOURCE_HASH } from './lib/feedback-scenarios.mjs';
import { createExecutionFixture, EXECUTION_FIXTURE_INCOMPLETE_SOURCE } from './lib/execution-fixture.mjs';
import { STUB_BEHAVIORS } from './stub-harness.mjs';

test('continuation queues pin the closed critique story with independent review before any writer', () => {
  assert.deepEqual(FEEDBACK_SCENARIOS.c1.behavior.turns.codex, ['codex-fixture-plan', 'codex-fixture-incomplete-writer-delayed', 'codex-fixture-corrective-plan-delayed', 'codex-fixture-corrective-writer']);
  assert.deepEqual(FEEDBACK_SCENARIOS.c1.behavior.turns.claude, ['claude-carry-out', 'claude-fixture-critique-checker-delayed', 'claude-carry-out', 'claude-fixture-auditor']);
  assert.deepEqual(FEEDBACK_SCENARIOS.c2.behavior.turns.codex, ['codex-fixture-plan', 'codex-fixture-incomplete-writer-delayed']);
  assert.deepEqual(FEEDBACK_SCENARIOS.c2.behavior.turns.claude, ['claude-carry-out', 'claude-fixture-critique-checker-delayed']);
  assert.equal(FEEDBACK_SCENARIOS.c1.preset, 'c1-feedback-repair');
  assert.equal(FEEDBACK_SCENARIOS.c1.totalTurns, 8);
  assert.equal(FEEDBACK_SCENARIOS.c2.totalTurns, 4);
  assert.equal(FEEDBACK_SCENARIOS.c2.readTurns, 4, 'c2 keeps the unchanged default budget');
  assert.deepEqual(WIDTHS, [860, 1020, 1440]);
  for (const scenario of Object.values(FEEDBACK_SCENARIOS)) for (const [identity, queue] of Object.entries(scenario.behavior.turns)) for (const id of queue) {
    assert.equal(STUB_BEHAVIORS[id].kind, 'turn');
    assert.ok(id.startsWith(identity + '-'));
  }
});

test('continuation progress delays are fixed, bounded, offline-only variants', () => {
  for (const id of ['codex-fixture-incomplete-writer-delayed', 'claude-fixture-critique-checker-delayed', 'codex-fixture-corrective-plan-delayed']) {
    assert.equal(STUB_BEHAVIORS[id].delayMs, 12000);
    assert.ok(STUB_BEHAVIORS[id].fixtureOperation);
  }
  assert.equal(STUB_BEHAVIORS['codex-fixture-incomplete-writer'].delayMs, undefined, 'peer fixture behavior unchanged');
});

test('c1 report requires two passes, retained first-round facts and send-wide non-retryability', () => {
  const ledgerKeys = Array.from({ length: 8 }, (_, n) => `coordinate-${['plan', 'review', 'execute', 'audit'][n % 4]}-${n}`);
  const r = {
    fixtureRoot: '/tmp/fixture', before: { files: [{ relative: 'a', sha256: '1' }] }, intermediate: { files: [] }, after: { files: [] },
    operations: [], finalScope: { remaining: 0, maxTurns: 6, write: { remaining: 0, maxTurns: 2, workspaceRoot: '/tmp/fixture' } },
    screenshots: [], settledInvocations: [],
    artifacts: {
      ledger: Object.fromEntries(ledgerKeys.map(key => [key, { messageDispatched: true }])),
      claims: ledgerKeys.map(key => `claim-${key}`),
      unconsumedGrants: [],
      invocations: [
        ...Array.from({ length: 8 }, (_, n) => ({ invocationType: 'turn', identity: n % 2 === 0 ? 'codex' : 'claude', behaviorId: n % 2 === 0 ? FEEDBACK_SCENARIOS.c1.behavior.turns.codex[n / 2] : FEEDBACK_SCENARIOS.c1.behavior.turns.claude[(n - 1) / 2], consumesQueue: true, cwd: '/tmp/fixture', argv: n % 2 === 0 ? ['--sandbox', n === 2 || n === 6 ? 'workspace-write' : 'read-only', '--cd', '/tmp/fixture'] : ['--permission-mode', 'plan'] })),
        ...Array.from({ length: 6 }, (_, n) => ({ invocationType: 'probe', identity: n % 2 === 0 ? 'codex' : 'claude', behaviorId: 'probe', consumesQueue: false })),
      ],
      records: [{
        verdict: 'verified', executionHarness: 'Codex', auditHarness: 'Claude',
        auditText: 'x\nVERDICT: verified', messageDispatched: true,
        executionText: 'Corrective executor CLI turn completed',
        feedbackHistory: [{ verdict: 'revise', auditText: 'y\nVERDICT: revise', messageDispatched: true, executionText: 'First executor CLI turn completed', commandIds: ledgerKeys.slice(0, 4) }],
      }],
    },
  };
  const a = feedbackAssertions('c1', r);
  assert.equal(a.exactlyExpectedTurnsAndClaims, true);
  assert.equal(a.roleFamilyPerPass, true);
  assert.equal(a.independentPairsPerPass, true);
  assert.equal(a.honestVerifiedRecord, true);
  assert.equal(a.retainedFirstRoundFacts, true);
  assert.equal(a.scopeDualCounters, true);
  r.artifacts.records[0].messageDispatched = false;
  assert.equal(feedbackAssertions('c1', r).honestVerifiedRecord, false);
  r.artifacts.records[0].messageDispatched = true;
  r.finalScope.write.remaining = 1;
  assert.equal(feedbackAssertions('c1', r).scopeDualCounters, false);
});

test('c2 report stops on budget without a fifth turn and without verified claims', () => {
  const c2Keys = Array.from({ length: 4 }, (_, n) => `coordinate-${['plan', 'review', 'execute', 'audit'][n]}-${n}`);
  const r = {
    fixtureRoot: '/tmp/fixture', before: { files: [] }, intermediate: { files: [] }, after: { files: [] },
    operations: [], finalScope: { remaining: 1, maxTurns: 4, write: { remaining: 1, maxTurns: 2, workspaceRoot: '/tmp/fixture' } },
    screenshots: ['write-consent', 'making-changes', 'budget-stop'].flatMap(state => WIDTHS.map(width => ({ state, geometry: { text: state === 'budget-stop' ? 'Needs revision VERDICT: revise not enough access left for one more checked repair 1 of 4 authorized model turns left' : 'working', horizontalOverflow: false, drawerOpen: false }, viewport: { width }, pngWidth: width, pngHeight: 900, bytes: 20000 }))),
    settledInvocations: Array.from({ length: 4 }, (_, n) => ({ invocationType: 'turn' })),
    artifacts: {
      ledger: Object.fromEntries(c2Keys.map(key => [key, { messageDispatched: true }])), claims: c2Keys.map(key => `claim-${key}`), unconsumedGrants: [],
      invocations: [
        ...Array.from({ length: 4 }, (_, n) => ({ invocationType: 'turn', identity: n % 2 === 0 ? 'codex' : 'claude', behaviorId: n % 2 === 0 ? FEEDBACK_SCENARIOS.c2.behavior.turns.codex[n / 2] : FEEDBACK_SCENARIOS.c2.behavior.turns.claude[(n - 1) / 2], consumesQueue: true, cwd: '/tmp/fixture', argv: n % 2 === 0 ? ['--sandbox', n === 2 ? 'workspace-write' : 'read-only', '--cd', '/tmp/fixture'] : ['--permission-mode', 'plan'] })),
        ...Array.from({ length: 6 }, (_, n) => ({ invocationType: 'probe', identity: n % 2 === 0 ? 'codex' : 'claude', behaviorId: 'probe', consumesQueue: false })),
      ],
      records: [{ verdict: 'revise', messageDispatched: true, stopReason: 'There is not enough access left for one more checked repair, which needs three model turns and one write turn. GoalPort did not add turns.' }],
    },
  };
  const a = feedbackAssertions('c2', r);
  assert.equal(a.budgetStopWithoutRepair, true);
  assert.equal(a.noRepairTurnsLaunched, true);
  assert.equal(a.noVerifiedClaim, true);
  assert.equal(a.domShowsCritique, true);
  assert.equal(a.allNativeShots, true);
  r.settledInvocations.push({ invocationType: 'turn' });
  assert.equal(feedbackAssertions('c2', r).budgetStopWithoutRepair, false);
});

test('continuation report never accepts absent evidence and preserves blocked attempts', () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.equal(parseArgs(['--out', '/tmp/x']), '/tmp/x');
  const report = { schemaVersion: 1, kind: 'c1-real-app-offline-continuation', status: 'blocked', notVerified: NOT_VERIFIED, failure: 'real failed attempt', scenarios: {} };
  assert.doesNotThrow(() => validateFeedbackReport(report));
  assert.throws(() => validateFeedbackReport({ ...report, status: 'ready', failure: null }), /Incomplete native scenario/);
  assert.throws(() => validateFeedbackReport({ ...report, status: 'ready' }), /retains failure/);
});

test('the continuation fixture keeps the intermediate edit distinguishable from broken and repaired', async t => {
  const fixture = createExecutionFixture('c1-feedback-repair');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'goalport-c1-native-test-'));
  t.after(() => { fixture.dispose(); fs.rmSync(out, { recursive: true, force: true }); });
  const before = snapshotFixture(fixture, out, 'before');
  const baseline = baselineChecks(fixture, out);
  assert.equal(baseline.exitCode, 1);
  assert.match(baseline.stdout, /# fail 2/);
  // The three fixture states must stay distinct so the archived progression is decidable.
  assert.notEqual(before.files.find(f => f.relative === 'src/add.mjs').sha256, INCOMPLETE_SOURCE_HASH);
  assert.notEqual(INCOMPLETE_SOURCE_HASH, REPAIRED_SOURCE_HASH);
  assert.match(EXECUTION_FIXTURE_INCOMPLETE_SOURCE, /if \(a >= 0\) return a \+ b; return a - b;/);
  assert.throws(() => snapshotFixture(fixture, out, 'before'), /EEXIST/);
});
