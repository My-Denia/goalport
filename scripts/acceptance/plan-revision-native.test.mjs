import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseArgs, validatePlanRevisionReport, NOT_VERIFIED } from './plan-revision-native.mjs';
import { PLAN_REVISION_SCENARIOS, planRevisionAssertions, snapshotFixture, baselineChecks, WIDTHS, PLAN_REVISION_GOAL } from './lib/plan-revision-scenarios.mjs';
import { createExecutionFixture, EXECUTION_FIXTURE_FLAWED_PLAN, EXECUTION_FIXTURE_REVISED_PLAN } from './lib/execution-fixture.mjs';
import { STUB_BEHAVIORS } from './stub-harness.mjs';

test('plan-revision queues pin the closed critique story with the writer only after approval', () => {
  assert.deepEqual(PLAN_REVISION_SCENARIOS.pr1.behavior.turns.codex, ['codex-fixture-flawed-plan', 'codex-fixture-revised-plan-delayed', 'codex-fixture-writer']);
  assert.deepEqual(PLAN_REVISION_SCENARIOS.pr1.behavior.turns.claude, ['claude-fixture-plan-critique-checker-delayed', 'claude-carry-out', 'claude-fixture-auditor']);
  assert.deepEqual(PLAN_REVISION_SCENARIOS.pr2.behavior.turns.codex, ['codex-fixture-flawed-plan']);
  assert.deepEqual(PLAN_REVISION_SCENARIOS.pr3.behavior.turns.claude, ['claude-fixture-plan-critique-checker-delayed', 'claude-review-success']);
  assert.equal(PLAN_REVISION_SCENARIOS.pr1.preset, 'c4-plan-revision');
  assert.equal(PLAN_REVISION_SCENARIOS.pr1.totalTurns, 6);
  assert.equal(PLAN_REVISION_SCENARIOS.pr1.readTurns, 5);
  assert.equal(PLAN_REVISION_SCENARIOS.pr1.writeTurns, 1);
  assert.equal(PLAN_REVISION_SCENARIOS.pr2.readTurns, 4, 'pr2 keeps the unchanged default budget');
  assert.equal(PLAN_REVISION_SCENARIOS.pr2.totalTurns, 2);
  assert.equal(PLAN_REVISION_SCENARIOS.pr3.totalTurns, 4);
  assert.equal(PLAN_REVISION_SCENARIOS.pr4.background, true);
  assert.deepEqual(WIDTHS, [860, 1020, 1440]);
  for (const scenario of Object.values(PLAN_REVISION_SCENARIOS)) for (const [identity, queue] of Object.entries(scenario.behavior.turns)) for (const id of queue) {
    assert.equal(STUB_BEHAVIORS[id].kind, 'turn');
    assert.ok(id.startsWith(identity + '-'));
  }
});

test('plan-revision progress delays are fixed, bounded, offline-only variants', () => {
  for (const id of ['claude-fixture-plan-critique-checker-delayed', 'codex-fixture-revised-plan-delayed']) {
    assert.equal(STUB_BEHAVIORS[id].delayMs, 12000);
    assert.ok(STUB_BEHAVIORS[id].fixtureOperation);
  }
  assert.equal(STUB_BEHAVIORS['claude-fixture-plan-critique-checker'].delayMs, undefined, 'peer fixture behavior unchanged');
});

test('pr1 report requires the rejected pass retained, fresh identities and send-wide non-retryability', () => {
  const ledgerKeys = Array.from({ length: 6 }, (_, n) => `coordinate-${['plan', 'review', 'plan', 'review', 'execute', 'audit'][n]}-${n}`);
  const r = {
    fixtureRoot: '/tmp/fixture',
    before: { files: [{ relative: 'src/add.mjs', sha256: 'orig' }, { relative: 'test/add.test.mjs', sha256: 'tests' }] },
    after: { files: [{ relative: 'src/add.mjs', sha256: 'repaired' }, { relative: 'test/add.test.mjs', sha256: 'tests' }] },
    operations: [
      { operation: 'flawed-plan', exitCode: 0, report: EXECUTION_FIXTURE_FLAWED_PLAN, evidence: { sourceSha256: 'orig', changed: false, missingRequirement: 'negative-case-coverage-and-named-checks' } },
      { operation: 'plan-critique-checker', verdict: 'revise', evidence: { cliTurnCompleted: true, checker: { checkerKind: 'separate-read-only-node-process', pid: 2, noIndependentModelClaim: true }, negativeCasePresent: true, observedRequirement: true, parentPid: 1, testSha256: 'tests' } },
      { operation: 'revised-plan', evidence: { sourceSha256: 'orig', changed: false, answersCritique: 'negative-case-coverage-and-named-checks' }, report: EXECUTION_FIXTURE_REVISED_PLAN },
      { operation: 'writer', status: 'completed', verified: false, evidence: { edit: { actualFileChanged: true, afterSha256: 'repaired' }, checks: { testsPassed: true }, testBytesUnchanged: true } },
      { operation: 'auditor', verified: true, evidence: { auditor: { auditorKind: 'separate-read-only-node-process', pid: 3, noIndependentModelClaim: true, testsPassed: true, originalTests: { matchesPinnedBytes: true } }, auditorProcess: { exitCode: 0 }, parentPid: 4 } },
    ],
    finalScope: { remaining: 0, maxTurns: 5, write: { remaining: 0, maxTurns: 1, workspaceRoot: '/tmp/fixture' } },
    screenshots: ['write-consent', 'critique', 'revision-progress', 'verified'].flatMap(state => WIDTHS.map(width => ({
      state, viewport: { width }, pngWidth: width, pngHeight: 900, bytes: 20000, geometry: {
        horizontalOverflow: false, drawerOpen: false,
        text: state === 'verified' ? 'Changes verified Before plan revision wrote one revised plan' : state === 'revision-progress' ? 'one revised plan is now being written and checked' : state === 'write-consent' ? 'rejects the plan itself write one revised plan finds unfinished work' : 'working',
      },
    }))),
    settledInvocations: [],
    artifacts: {
      ledger: Object.fromEntries(ledgerKeys.map(key => [key, { messageDispatched: true }])),
      claims: ledgerKeys.map(key => `claim-${key}`),
      unconsumedGrants: [],
      invocations: [
        ...Array.from({ length: 6 }, (_, n) => ({ invocationType: 'turn', identity: n % 2 === 0 ? 'codex' : 'claude', behaviorId: PLAN_REVISION_SCENARIOS.pr1.behavior.turns[n % 2 === 0 ? 'codex' : 'claude'][Math.floor(n / 2)], consumesQueue: true, cwd: '/tmp/fixture', argv: n % 2 === 0 ? ['--sandbox', n === 4 ? 'workspace-write' : 'read-only', '--cd', '/tmp/fixture'] : ['--permission-mode', 'plan'] })),
        ...Array.from({ length: 6 }, (_, n) => ({ invocationType: 'probe', identity: n % 2 === 0 ? 'codex' : 'claude', behaviorId: 'probe', consumesQueue: false })),
      ],
      records: [{
        verdict: 'verified', executionHarness: 'Codex', auditHarness: 'Claude',
        auditText: 'x\nVERDICT: verified', messageDispatched: true,
        planRevisionHistory: [{ verdict: 'revise', reviewText: 'y\nVERDICT: revise', executionText: null, executionHarness: null, messageDispatched: true, commandIds: ledgerKeys.slice(0, 2) }],
      }],
    },
  };
  const a = planRevisionAssertions('pr1', r);
  assert.equal(a.exactlyExpectedTurnsAndClaims, true);
  assert.equal(a.freshRoleFamilies, true);
  assert.equal(a.retainedRejectedPassFacts, true);
  assert.equal(a.honestVerifiedRecord, true);
  assert.equal(a.revisedPlanAnsweredBeforeAnyWriter, true);
  assert.equal(a.actualRepairAndPassingUnchangedChecks, true);
  assert.equal(a.scopeDualCounters, true);
  assert.equal(a.critiqueIsSeparateCompletedProcess, true);
  r.artifacts.records[0].messageDispatched = false;
  assert.equal(planRevisionAssertions('pr1', r).honestVerifiedRecord, false);
  r.artifacts.records[0].messageDispatched = true;
  r.finalScope.remaining = 1;
  assert.equal(planRevisionAssertions('pr1', r).scopeDualCounters, false);
});

test('pr2 report stops on the default budget without a third turn and without verified claims', () => {
  const keys = ['coordinate-plan-0', 'coordinate-review-1'];
  const r = {
    fixtureRoot: '/tmp/fixture',
    before: { files: [{ relative: 'src/add.mjs', sha256: 'orig' }, { relative: 'test/add.test.mjs', sha256: 'tests' }] },
    after: { files: [{ relative: 'src/add.mjs', sha256: 'orig' }, { relative: 'test/add.test.mjs', sha256: 'tests' }] },
    operations: [
      { operation: 'flawed-plan', exitCode: 0, report: EXECUTION_FIXTURE_FLAWED_PLAN, evidence: { sourceSha256: 'orig', changed: false, missingRequirement: 'negative-case-coverage-and-named-checks' } },
      { operation: 'plan-critique-checker', verdict: 'revise', evidence: { cliTurnCompleted: true, checker: { checkerKind: 'separate-read-only-node-process', pid: 2, noIndependentModelClaim: true }, negativeCasePresent: true, observedRequirement: true, parentPid: 1, testSha256: 'tests' } },
    ],
    finalScope: { remaining: 2, maxTurns: 4, write: { remaining: 1, maxTurns: 1, workspaceRoot: '/tmp/fixture' } },
    screenshots: ['write-consent', 'critique', 'budget-stop'].flatMap(state => WIDTHS.map(width => ({ state, geometry: { text: state === 'budget-stop' ? 'Needs revision VERDICT: revise not enough access left for one more checked plan revision 2 of 4 turns left' : state === 'write-consent' ? 'rejects the plan itself write one revised plan finds unfinished work' : 'working', horizontalOverflow: false, drawerOpen: false }, viewport: { width }, pngWidth: width, pngHeight: 900, bytes: 20000 }))),
    settledInvocations: Array.from({ length: 2 }, () => ({ invocationType: 'turn' })),
    artifacts: {
      ledger: Object.fromEntries(keys.map(key => [key, { messageDispatched: true }])), claims: keys.map(key => `claim-${key}`), unconsumedGrants: [],
      invocations: [
        ...Array.from({ length: 2 }, (_, n) => ({ invocationType: 'turn', identity: n % 2 === 0 ? 'codex' : 'claude', behaviorId: PLAN_REVISION_SCENARIOS.pr2.behavior.turns[n % 2 === 0 ? 'codex' : 'claude'][n], consumesQueue: true, cwd: '/tmp/fixture', argv: n % 2 === 0 ? ['--sandbox', 'read-only', '--cd', '/tmp/fixture'] : ['--permission-mode', 'plan'] })),
        ...Array.from({ length: 6 }, (_, n) => ({ invocationType: 'probe', identity: n % 2 === 0 ? 'codex' : 'claude', behaviorId: 'probe', consumesQueue: false })),
      ],
      records: [{ verdict: 'revise', messageDispatched: true, stopReason: 'There is not enough access left for one more checked plan revision, which needs three model turns and one write turn. GoalPort did not add turns.' }],
    },
  };
  const a = planRevisionAssertions('pr2', r);
  assert.equal(a.budgetStopWithoutRevision, true);
  assert.equal(a.noRevisionTurnsLaunched, true);
  assert.equal(a.fixtureBytesUnchanged, true);
  assert.equal(a.noVerifiedClaim, true);
  r.settledInvocations.push({ invocationType: 'turn' });
  assert.equal(planRevisionAssertions('pr2', r).budgetStopWithoutRevision, false);
});

test('pr3 report keeps the second rejection terminal with the rejected pass retained', () => {
  const keys = ['coordinate-plan-0', 'coordinate-review-1', 'coordinate-plan-2', 'coordinate-review-3'];
  const r = {
    fixtureRoot: '/tmp/fixture',
    before: { files: [{ relative: 'src/add.mjs', sha256: 'orig' }, { relative: 'test/add.test.mjs', sha256: 'tests' }] },
    after: { files: [{ relative: 'src/add.mjs', sha256: 'orig' }, { relative: 'test/add.test.mjs', sha256: 'tests' }] },
    operations: [
      { operation: 'flawed-plan', exitCode: 0, report: EXECUTION_FIXTURE_FLAWED_PLAN, evidence: { sourceSha256: 'orig', changed: false, missingRequirement: 'negative-case-coverage-and-named-checks' } },
      { operation: 'plan-critique-checker', verdict: 'revise', evidence: { cliTurnCompleted: true, checker: { checkerKind: 'separate-read-only-node-process', pid: 2, noIndependentModelClaim: true }, negativeCasePresent: true, observedRequirement: true, parentPid: 1, testSha256: 'tests' } },
      { operation: 'revised-plan', evidence: { sourceSha256: 'orig', changed: false, answersCritique: 'negative-case-coverage-and-named-checks' }, report: EXECUTION_FIXTURE_REVISED_PLAN },
    ],
    finalScope: { remaining: 1, maxTurns: 5, write: { remaining: 1, maxTurns: 1, workspaceRoot: '/tmp/fixture' } },
    screenshots: ['write-consent', 'critique', 'revision-progress', 'second-rejection'].flatMap(state => WIDTHS.map(width => ({ state, geometry: { text: state === 'second-rejection' ? 'Needs revision This send already used its one automatic plan revision Before plan revision' : state === 'revision-progress' ? 'one revised plan is now being written and checked' : state === 'write-consent' ? 'rejects the plan itself write one revised plan finds unfinished work' : 'working', horizontalOverflow: false, drawerOpen: false }, viewport: { width }, pngWidth: width, pngHeight: 900, bytes: 20000 }))),
    settledInvocations: Array.from({ length: 4 }, () => ({ invocationType: 'turn' })),
    artifacts: {
      ledger: Object.fromEntries(keys.map(key => [key, { messageDispatched: true }])), claims: keys.map(key => `claim-${key}`), unconsumedGrants: [],
      invocations: [
        ...Array.from({ length: 4 }, (_, n) => ({ invocationType: 'turn', identity: n % 2 === 0 ? 'codex' : 'claude', behaviorId: PLAN_REVISION_SCENARIOS.pr3.behavior.turns[n % 2 === 0 ? 'codex' : 'claude'][Math.floor(n / 2)], consumesQueue: true, cwd: '/tmp/fixture', argv: n % 2 === 0 ? ['--sandbox', 'read-only', '--cd', '/tmp/fixture'] : ['--permission-mode', 'plan'] })),
        ...Array.from({ length: 6 }, (_, n) => ({ invocationType: 'probe', identity: n % 2 === 0 ? 'codex' : 'claude', behaviorId: 'probe', consumesQueue: false })),
      ],
      records: [{ verdict: 'revise', messageDispatched: true, stopReason: 'The independent check says the plan needs revision, so this stopped. This send already used its one automatic plan revision.', planRevisionHistory: [{ verdict: 'revise', reviewText: 'y\nVERDICT: revise', messageDispatched: true, commandIds: keys.slice(0, 2) }] }],
    },
  };
  const a = planRevisionAssertions('pr3', r);
  assert.equal(a.secondRejectionTerminal, true);
  assert.equal(a.zeroWrites, true);
  assert.equal(a.noThirdPlanningPass, true);
  assert.equal(a.domShowsSecondRejection, true);
  r.artifacts.records[0].stopReason = r.artifacts.records[0].stopReason.replace('This send already used its one automatic plan revision.', '');
  assert.equal(planRevisionAssertions('pr3', r).secondRejectionTerminal, false);
});

test('plan-revision report never accepts absent evidence and preserves blocked attempts', () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.equal(parseArgs(['--out', '/tmp/x']), '/tmp/x');
  const report = { schemaVersion: 1, kind: 'c4-real-app-offline-plan-revision', status: 'blocked', notVerified: NOT_VERIFIED, failure: 'real failed attempt', scenarios: {} };
  assert.doesNotThrow(() => validatePlanRevisionReport(report));
  assert.throws(() => validatePlanRevisionReport({ ...report, status: 'ready', failure: null }), /Incomplete native scenario/);
  assert.throws(() => validatePlanRevisionReport({ ...report, status: 'ready' }), /retains failure/);
});

test('the plan-revision fixture keeps the flawed and revised plans distinct and pinned', async t => {
  const fixture = createExecutionFixture('c4-plan-revision');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'goalport-c4-native-test-'));
  t.after(() => { fixture.dispose(); fs.rmSync(out, { recursive: true, force: true }); });
  const before = snapshotFixture(fixture, out, 'before');
  const baseline = baselineChecks(fixture, out);
  assert.equal(baseline.exitCode, 1);
  assert.match(baseline.stdout, /(?:#|ℹ|info) +fail 2(?![0-9])/u);
  assert.notEqual(EXECUTION_FIXTURE_FLAWED_PLAN, EXECUTION_FIXTURE_REVISED_PLAN);
  assert.match(EXECUTION_FIXTURE_FLAWED_PLAN, /positive inputs/);
  assert.match(EXECUTION_FIXTURE_REVISED_PLAN, /negative-value case/);
  assert.match(EXECUTION_FIXTURE_REVISED_PLAN, /unchanged pinned node --test checks/);
  assert.ok(PLAN_REVISION_GOAL.length > 0);
  assert.throws(() => snapshotFixture(fixture, out, 'before'), /EEXIST/);
});
