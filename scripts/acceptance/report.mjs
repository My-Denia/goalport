// M3 Track A machine-checkable report: per-scenario assertions, artifact
// hashes, screenshot manifest coverage, zero-quota proof and the explicit
// not-verified-here list. Fail-closed by construction: a report may only say
// `ready` when every pinned assertion, artifact, shot and cleanup fact exists.
import { SLUG } from './lib/launch.mjs';

export const TRACK_A_KIND = 'goalport-m3-track-a';
export const LEGACY_M2_KIND = 'goalport-m2-real-app';

// What this run does NOT claim. A missing entry here is a honesty bug, not a
// convenience (plan FAC-8); synthetic evidence must never masquerade as real.
export const NOT_VERIFIED = Object.freeze([
  'Windows packaged-EXE acceptance: this run is dev-mode Electron with the built dist on the local Linux host; the packaged product run belongs to the owner-run M4 Windows driver.',
  'Native OS mouse/keyboard input: every interaction is CDP DOM reads, prototype property setters and CDP mouse events; the X11 helper only resizes the driver-owned window bounds.',
  'Real CLI behavior: the real codex/claude binaries on this host were never executed, not even for --help or probes; only sentinel-gated offline stubs answered, so wire format, flags, models, quota and login state stay unverified.',
  'Actual takeover/replacement launch: the audited chain-completeness pre-check stops before any replacement with only two harnesses (plan D-A6), so these scenarios never exercise a takeover; takeover stays covered by the existing synthetic suites.',
  'Real model judgment: stub replies are offline protocol fixtures byte-copied from pinned electron test corpora; no independent model output exists in this run.',
]);

const SHOT_REQUIREMENTS = Object.freeze({
  a2: Object.freeze([Object.freeze(['terminal', 860]), Object.freeze(['terminal', 1020]), Object.freeze(['terminal', 1440]), Object.freeze(['use-again', 1020])]),
  a3: Object.freeze([Object.freeze(['refusal', 1020])]),
  a4: Object.freeze([Object.freeze(['terminal', 860]), Object.freeze(['terminal', 1020]), Object.freeze(['terminal', 1440])]),
  a5: Object.freeze([Object.freeze(['blocked-panel', 1020])]),
});

export function scenarioShotRequirements(id) {
  const shots = SHOT_REQUIREMENTS[id];
  if (!shots) throw new Error(`no pinned screenshot requirements for scenario ${id}`);
  return shots;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

function validFileEvidence(file) {
  // Claim marker files are legitimately zero bytes; the sha256 still pins content.
  return !!file && typeof file.path === 'string' && typeof file.bytes === 'number' && file.bytes >= 0 && SHA256.test(file.sha256 ?? '');
}

function validScreenshot(shot) {
  return !!shot && typeof shot.path === 'string' && typeof shot.state === 'string' && shot.bytes > 1000
    && SHA256.test(shot.sha256 ?? '') && shot.pngWidth === shot.requested?.width && shot.pngHeight > 0
    && typeof shot.geometry?.text === 'string' && shot.geometry.text.length > 0
    && (shot.method === 'Browser.setWindowBounds' || typeof shot.method === 'string');
}

function validCleanup(cleanup) {
  return !!cleanup && cleanup.coreStopped === true && cleanup.socketAbsent === true
    && cleanup.electronExit?.code === 0 && cleanup.forcedElectron === false;
}

// Zero real quota: every scenario preflight resolved both names onto run-owned
// stub wrappers, the sentinel was never refused, and probe/turn/ledger counts
// are machine-checkable. Probe counts stay separate from turn counts (plan D-A5).
export function zeroQuotaProof(scenarios) {
  const perScenario = {};
  let stubOnly = Object.keys(scenarios).length > 0;
  for (const [id, result] of Object.entries(scenarios)) {
    const invocations = result?.artifactsFinal?.invocations ?? result?.artifacts?.invocations ?? [];
    const preflight = result?.preflight;
    const ledger = result?.artifactsFinal?.ledger ?? result?.artifacts?.ledger ?? {};
    const entry = {
      preflightBothNamesShadowed: preflight?.bothNamesShadowed === true,
      hostLocationsShadowed: preflight?.resolutions
        ? Object.fromEntries(Object.entries(preflight.resolutions).map(([identity, resolution]) => [identity, resolution.shadowedLocations]))
        : {},
      probes: invocations.filter(i => i.invocationType === 'probe').length,
      turns: invocations.filter(i => i.invocationType === 'turn').length,
      sentinelRefusals: invocations.filter(i => i.behaviorId === 'sentinel-refused').length,
      queueExhausted: invocations.filter(i => i.behaviorId === 'turn-queue-exhausted').length,
      ledgerEntries: Object.keys(ledger).length,
      ledgerOk: Object.values(ledger).filter(entry => entry?.ok === true).length,
    };
    entry.stubOnly = entry.preflightBothNamesShadowed && entry.sentinelRefusals === 0 && entry.queueExhausted === 0;
    stubOnly = stubOnly && entry.stubOnly;
    perScenario[id] = entry;
  }
  return { stubOnly, perScenario };
}

export function aggregateCleanup(scenarios) {
  const perScenario = Object.fromEntries(Object.entries(scenarios).map(([id, result]) => [id, {
    cleanup: result?.cleanup ?? null,
    cleanupRound: result?.cleanupRound ?? null,
  }]));
  const all = Object.values(scenarios).flatMap(result => [result?.cleanup, ...(result?.cleanupRound ? [result.cleanupRound] : [])]).filter(Boolean);
  return {
    coreStopped: all.length > 0 && all.every(cleanup => cleanup.coreStopped === true),
    socketAbsent: all.length > 0 && all.every(cleanup => cleanup.socketAbsent === true),
    electronExitCodeZero: all.length > 0 && all.every(cleanup => cleanup.electronExit?.code === 0),
    noForcedElectron: all.length > 0 && all.every(cleanup => cleanup.forcedElectron === false),
    scenarios: perScenario,
  };
}

function scenarioReady(result, id) {
  if (!result || typeof result !== 'object') return 'scenario result missing';
  if (result.status !== 'ready') return `status ${result.status}`;
  const assertions = result.assertions ?? {};
  if (Object.keys(assertions).length < 10 || !Object.values(assertions).every(Boolean)) return 'assertions missing or false';
  for (const key of ['artifacts', 'artifactsFinal']) {
    const artifacts = result[key];
    if (!artifacts || !Array.isArray(artifacts.files) || artifacts.files.length === 0) return `${key} missing`;
    if (!artifacts.files.every(validFileEvidence)) return `${key} has invalid hashes`;
    if (!Array.isArray(artifacts.invocations)) return `${key} invocations missing`;
  }
  const shots = result.screenshots ?? [];
  const required = scenarioShotRequirements(id);
  for (const [state, width] of required) {
    if (!shots.some(shot => shot.state === state && shot.requested?.width === width)) return `missing required shot ${state}@${width}`;
  }
  if (!shots.every(validScreenshot)) return 'invalid screenshot evidence';
  if (result.preflight?.bothNamesShadowed !== true) return 'preflight missing';
  if (!validCleanup(result.cleanup)) return 'final cleanup not clean';
  if (result.cleanupRound && !validCleanup(result.cleanupRound)) return 'round cleanup not clean';
  return null;
}

export function validateTrackAReport(report) {
  if (!report || report.schemaVersion !== 1 || report.kind !== TRACK_A_KIND) throw new Error('invalid track-a report envelope');
  if (typeof report.head !== 'string' || !report.head || report.runSlug !== SLUG || report.cwd !== process.cwd()) throw new Error('invalid track-a report identity');
  if (!report.host || typeof report.host.platform !== 'string' || typeof report.host.release !== 'string' || typeof report.host.distribution !== 'string') throw new Error('host facts missing');
  if (!Array.isArray(report.honestyLabels) || report.honestyLabels.length < 4) throw new Error('honesty labels missing');
  if (!ISO.test(report.startedAt ?? '') || !ISO.test(report.endedAt ?? '')) throw new Error('timestamps missing');
  if (!report.scenarios || typeof report.scenarios !== 'object') throw new Error('scenarios missing');
  const ids = Object.keys(report.scenarios);
  if (ids.length === 0) throw new Error('no scenarios ran');
  for (const id of ids) {
    const result = report.scenarios[id];
    if (!['ready', 'blocked', 'not-run'].includes(result?.status)) throw new Error(`scenario ${id} has invalid status`);
    if (result.status === 'ready') {
      const problem = scenarioReady(result, id);
      if (problem) throw new Error(`ready report lacks evidence (${id}): ${problem}`);
    }
  }
  if (!report.zeroQuota || report.zeroQuota.stubOnly !== true || !report.zeroQuota.perScenario) throw new Error('zero-quota proof missing');
  if (!Array.isArray(report.notVerified) || report.notVerified.length < 5) throw new Error('not-verified list missing');
  const cleanup = report.cleanup ?? {};
  for (const key of ['coreStopped', 'socketAbsent', 'electronExitCodeZero', 'noForcedElectron']) {
    if (cleanup[key] !== true) throw new Error(`aggregate cleanup ${key} missing`);
  }
  if (report.status === 'ready') {
    if (!ids.every(id => report.scenarios[id].status === 'ready')) throw new Error('ready report has non-ready scenarios');
    if (report.failure !== null) throw new Error('ready report carries a failure');
    for (const id of ids) {
      const result = report.scenarios[id];
      const hashes = [...(result.artifacts?.files ?? []), ...(result.artifactsFinal?.files ?? [])];
      if (hashes.length === 0) throw new Error(`ready scenario ${id} has no artifact hashes`);
    }
  }
  return report;
}
