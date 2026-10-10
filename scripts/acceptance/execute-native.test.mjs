import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseArgs, validateExecutionReport, NOT_VERIFIED } from './execute-native.mjs';
import { EXECUTION_SCENARIOS, executionAssertions, snapshotFixture, baselineChecks, WIDTHS } from './lib/execution-scenarios.mjs';
import { createExecutionFixture } from './lib/execution-fixture.mjs';
import { STUB_BEHAVIORS } from './stub-harness.mjs';

test('native app queues include REVIEW independently before auditor, or honest stop', () => {
  assert.deepEqual(EXECUTION_SCENARIOS.b1.behavior.turns.claude, ['claude-carry-out', 'claude-fixture-auditor-delayed']);
  assert.deepEqual(EXECUTION_SCENARIOS.b2.behavior.turns.codex, ['codex-fixture-plan']);
  assert.deepEqual(EXECUTION_SCENARIOS.b2.behavior.turns.claude, ['claude-carry-out']);
  assert.deepEqual(EXECUTION_SCENARIOS.b3.behavior.turns.claude, ['claude-carry-out']);
  assert.equal(EXECUTION_SCENARIOS.b2.write, false);
  assert.deepEqual(Object.values(EXECUTION_SCENARIOS).map(s => s.turns), [4, 2, 3]);
  assert.deepEqual(WIDTHS, [860, 1020, 1440]);
  for (const s of Object.values(EXECUTION_SCENARIOS)) for (const [identity,queue] of Object.entries(s.behavior.turns)) for (const id of queue) {
    assert.equal(STUB_BEHAVIORS[id].kind, 'turn'); assert.ok(id.startsWith(identity + '-'));
  }
});
test('b2 report separates persisted check stop from visible no-edit explanation and refuses write/audit facts', () => {
  // Pure report-schema input, not an app invocation or seeded app state.
  const r = { fixtureRoot: '/tmp/fixture', before: { files: [] }, after: { files: [] }, operations: [], finalScope: { maxTurns: 6, remaining: 4 },
    artifacts: { ledger: {}, claims: [], invocations: [], unconsumedGrants: [], records: [{ planningHarness: 'Codex', reviewHarness: 'Claude', reviewText: 'VERDICT: carry-out', verdict: 'checked', messageDispatched: true, stopReason: 'The independent check finished, so this stopped.' }] },
    screenshots: [{ state: 'no-write', geometry: { text: EXECUTION_SCENARIOS.b2.terminal } }] };
  assert.equal(executionAssertions('b2', r).honestResult, true);
  assert.equal(executionAssertions('b2', r).scopeDualCounters, true);
  r.finalScope.write = { remaining: 2 };
  assert.equal(executionAssertions('b2', r).scopeDualCounters, false);
  r.artifacts.records[0].executionText = 'unexpected writer';
  assert.equal(executionAssertions('b2', r).honestResult, false);
  r.artifacts.ledger['coordinate-audit-unexpected'] = { messageDispatched: true };
  assert.equal(executionAssertions('b2', r).auditOrHonestAbsence, false);
});
test('native progress delays are fixed, bounded, offline-only variants', () => {
  for (const id of ['codex-fixture-writer-delayed', 'codex-fixture-partial-writer-delayed', 'claude-fixture-auditor-delayed']) assert.equal(STUB_BEHAVIORS[id].delayMs, 18000);
  assert.equal(STUB_BEHAVIORS['codex-fixture-writer'].delayMs, undefined, 'original peer test behavior unchanged');
});
test('native report never accepts absent evidence and explicitly preserves blocked attempts', () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--out', '/tmp/x', '--scenario', 'b1']), /usage/);
  assert.equal(parseArgs(['--out', '/tmp/x']), '/tmp/x');
  const report = { schemaVersion: 1, kind: 'm9-real-app-offline-execution', status: 'blocked', notVerified: NOT_VERIFIED, failure: 'real failed attempt', scenarios: {} };
  assert.doesNotThrow(() => validateExecutionReport(report));
  assert.throws(() => validateExecutionReport({ ...report, status: 'ready', failure: null }), /Incomplete native scenario/);
  assert.throws(() => validateExecutionReport({ ...report, status: 'ready' }), /retains failure/);
});
test('native archives immutable before/after bytes and real failing baseline without changing original tests', t => {
  const fixture = createExecutionFixture('b1-full-chain');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'goalport-m9-native-test-'));
  t.after(() => { fixture.dispose(); fs.rmSync(out, { recursive: true, force: true }); });
  const before = snapshotFixture(fixture, out, 'before');
  const baseline = baselineChecks(fixture, out);
  assert.equal(baseline.exitCode, 1);
  assert.match(baseline.stdout, /# fail 2/);
  assert.equal(before.files.length, 3);
  assert.throws(() => snapshotFixture(fixture, out, 'before'), /EEXIST/);
  const originalTest = fs.readFileSync(fixture.testPath);
  fs.writeFileSync(fixture.sourcePath, 'observed later bytes');
  const after = snapshotFixture(fixture, out, 'after');
  assert.notEqual(before.files.find(f => f.relative === 'src/add.mjs').sha256, after.files.find(f => f.relative === 'src/add.mjs').sha256);
  assert.deepEqual(fs.readFileSync(fixture.testPath), originalTest);
  assert.match(fs.readFileSync(before.files.find(f => f.relative === 'src/add.mjs').retained, 'utf8'), /return a - b/);
});
