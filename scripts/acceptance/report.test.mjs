import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { TRACK_A_KIND, NOT_VERIFIED, zeroQuotaProof, aggregateCleanup, validateTrackAReport } from './report.mjs';

const SHA = (value = 'x') => crypto.createHash('sha256').update(value).digest('hex');
const file = (name = 'sent-turns.json') => ({ path: `/evidence/${name}`, bytes: 120, sha256: SHA(name) });
const shot = (state, width, overrides = {}) => ({
  path: `/evidence/${state}-${width}.png`, state, bytes: 50000, sha256: SHA(`${state}${width}`),
  requested: { width, height: 900 }, pngWidth: width, pngHeight: 900,
  geometry: { text: `terminal state ${state}` }, method: 'Browser.setWindowBounds', ...overrides,
});
const CLEAN = { requestCloseRequested: true, requestClose: false, closeError: 'CDP WebSocket closed', forcedElectron: false, coreMatchedPids: [], socketRemoved: true, coreStopped: true, socketAbsent: true, electronExit: { code: 0, signal: null }, ownedTempRemoved: true };
const INVOCATIONS = (turns, probes = 6) => [
  ...Array.from({ length: turns }, (_, i) => ({ identity: i % 2 ? 'claude' : 'codex', invocationType: 'turn', behaviorId: 'codex-environment-blocked' })),
  ...Array.from({ length: probes }, (_, i) => ({ identity: i % 2 ? 'claude' : 'codex', invocationType: 'probe', behaviorId: i % 2 ? 'claude-probe-authenticated' : 'codex-probe-authenticated' })),
];

function readyScenario(overrides = {}) {
  return {
    id: 'a2', status: 'ready',
    assertions: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`assertion-${i}`, true])),
    artifacts: { files: [file()], invocations: INVOCATIONS(1), ledger: { 'coordinate-plan-abc': { ok: false } } },
    artifactsFinal: { files: [file('final.json')], invocations: INVOCATIONS(1), ledger: { 'coordinate-plan-abc': { ok: false } } },
    screenshots: [shot('terminal', 860), shot('terminal', 1020), shot('terminal', 1440), shot('use-again', 1020)],
    preflight: { bothNamesShadowed: true, resolutions: {} },
    cleanup: { ...CLEAN },
    walkthrough: ['step'],
    ...overrides,
  };
}

function readyReport(overrides = {}) {
  return {
    schemaVersion: 1, kind: TRACK_A_KIND, runSlug: 'goalport-execute-and-native-acceptance',
    head: crypto.randomBytes(20).toString('hex'), cwd: process.cwd(),
    startedAt: '2026-10-11T00:00:00Z', endedAt: '2026-10-11T00:05:00Z',
    host: { platform: os.platform(), release: os.release(), distribution: 'PRETTY_NAME="Test"' },
    honestyLabels: ['a', 'b', 'c', 'd'],
    scenarios: { a2: readyScenario() },
    zeroQuota: zeroQuotaProof({ a2: readyScenario() }),
    notVerified: NOT_VERIFIED,
    cleanup: aggregateCleanup({ a2: readyScenario() }),
    status: 'ready', failure: null,
    ...overrides,
  };
}

test('zero-quota proof fails closed on sentinel refusals, queue exhaustion or missing preflight', () => {
  const good = { a2: readyScenario() };
  const proof = zeroQuotaProof(good);
  assert.equal(proof.stubOnly, true);
  assert.equal(proof.perScenario.a2.turns, 1);
  assert.equal(proof.perScenario.a2.probes, 6);
  assert.equal(proof.perScenario.a2.ledgerEntries, 1);
  assert.equal(zeroQuotaProof({ a2: readyScenario({ artifacts: { ...readyScenario().artifacts, invocations: INVOCATIONS(0, 1).concat([{ identity: 'codex', invocationType: 'turn', behaviorId: 'sentinel-refused' }]) }, artifactsFinal: { ...readyScenario().artifactsFinal, invocations: INVOCATIONS(0, 1).concat([{ identity: 'codex', invocationType: 'turn', behaviorId: 'sentinel-refused' }]) } }) }).stubOnly, false);
  assert.equal(zeroQuotaProof({ a2: readyScenario({ preflight: { bothNamesShadowed: false } }) }).stubOnly, false);
  assert.equal(zeroQuotaProof({}).stubOnly, false);
});

test('aggregate cleanup requires every scenario (and a5 round) to be clean', () => {
  const forced = { ...CLEAN, forcedElectron: true };
  assert.equal(aggregateCleanup({ a2: readyScenario() }).noForcedElectron, true);
  assert.equal(aggregateCleanup({ a2: readyScenario(), a5: readyScenario({ cleanupRound: forced }) }).noForcedElectron, false);
  assert.equal(aggregateCleanup({ a2: readyScenario(), a3: readyScenario({ cleanup: { ...CLEAN, socketAbsent: false } }) }).socketAbsent, false);
  assert.equal(aggregateCleanup({}).coreStopped, false);
});

test('track-a report validates only complete evidence and refuses every shortcut', () => {
  const base = readyReport();
  assert.equal(validateTrackAReport(base), base);
  const expectRefuse = (overrides, message, mutate) => {
    const report = readyReport(overrides);
    if (mutate) mutate(report);
    assert.throws(() => validateTrackAReport(report), message);
  };
  expectRefuse({ kind: 'other' }, /envelope/);
  expectRefuse({ status: 'ready', failure: 'boom' }, /failure/);
  expectRefuse({ scenarios: {} }, /no scenarios/);
  expectRefuse({ zeroQuota: { stubOnly: false, perScenario: {} } }, /zero-quota/);
  expectRefuse({ notVerified: ['only one'] }, /not-verified/);
  expectRefuse({ cleanup: { ...aggregateCleanup({ a2: readyScenario() }), coreStopped: false } }, /aggregate cleanup/);
  expectRefuse({}, /lacks evidence/, report => { report.scenarios.a2.assertions['assertion-3'] = false; });
  expectRefuse({}, /lacks evidence/, report => { report.scenarios.a2.screenshots = report.scenarios.a2.screenshots.filter(shot => !(shot.state === 'use-again' && shot.requested.width === 1020)); });
  expectRefuse({}, /invalid screenshot/, report => { report.scenarios.a2.screenshots[0].pngWidth = 999; });
  expectRefuse({}, /invalid hashes/, report => { report.scenarios.a2.artifacts.files[0].sha256 = 'deadbeef'; });
  // Zero-byte claim marker files are legitimate evidence, not a hash failure.
  const withEmptyClaim = readyReport();
  withEmptyClaim.scenarios.a2.artifacts.files.push({ path: '/evidence/claim-x', bytes: 0, sha256: SHA('') });
  assert.equal(validateTrackAReport(withEmptyClaim), withEmptyClaim);
  expectRefuse({}, /final cleanup not clean/, report => { report.scenarios.a2.cleanup = { ...CLEAN, coreStopped: false }; });
  expectRefuse({}, /round cleanup not clean/, report => { report.scenarios.a2.cleanupRound = { ...CLEAN, forcedElectron: true }; });
  expectRefuse({}, /preflight missing/, report => { report.scenarios.a2.preflight = {}; });
  expectRefuse({}, /invalid status/, report => { report.scenarios.a2.status = 'pending'; });
  // A blocked report is a valid outcome and needs no per-scenario evidence.
  const blocked = readyReport({ status: 'blocked' });
  blocked.scenarios.a2.status = 'blocked';
  assert.equal(validateTrackAReport(blocked), blocked);
  // not-run scenarios may exist only in a non-ready report.
  const notRun = readyReport({ status: 'blocked' });
  notRun.scenarios.a3 = { id: 'a3', status: 'not-run', assertions: {} };
  assert.equal(validateTrackAReport(notRun), notRun);
  const notRunReady = readyReport();
  notRunReady.scenarios.a3 = { id: 'a3', status: 'not-run', assertions: {} };
  assert.throws(() => validateTrackAReport(notRunReady), /non-ready scenarios/);
});

test('not-verified list keeps the honesty ledger pinned', () => {
  const text = NOT_VERIFIED.join('\n');
  assert.ok(text.includes('Windows packaged'), 'must disclaim the packaged Windows run');
  assert.ok(text.includes('Native OS mouse/keyboard'), 'must disclaim native input');
  assert.ok(text.includes('never executed'), 'must disclaim real CLI execution');
  assert.ok(text.includes('takeover'), 'must disclaim takeover');
  assert.ok(text.includes('offline protocol fixtures'), 'must disclaim real model judgment');
  assert.ok(Object.isFrozen(NOT_VERIFIED));
});

test('screenshot manifests written by the driver stay parseable evidence files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-report-test-'));
  try {
    const manifest = readyScenario().screenshots;
    fs.writeFileSync(path.join(dir, 'screenshot-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'screenshot-manifest.json'), 'utf8'));
    assert.equal(parsed.length, 4);
    assert.ok(parsed.every(shot => /^[0-9a-f]{64}$/.test(shot.sha256)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
