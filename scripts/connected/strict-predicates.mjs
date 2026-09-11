const SHA256 = /^[0-9a-f]{64}$/i;

export function isSha256(value) {
  return typeof value === "string" && SHA256.test(value);
}

export function handoffCorePass(predicates) {
  const required = [
    "distinctAttempt",
    "distinctNativeSession",
    "nativeResponseObserved",
    "terminalObserved",
    "packetObserved",
    "instructionObserved",
    "primaryTerminalObserved",
    "noManualCopy"
  ];
  return required.every((key) => predicates?.[key] === true);
}

export function packagedHandoffGuiPass({ evidence, hosts, operationId, oldAttemptId, newAttemptId, newSessionHash }) {
  const entries = Array.isArray(evidence?.hosts) ? evidence.hosts : [];
  const expected = new Set(hosts || []);
  const seen = new Set(entries.map((entry) => entry?.host));
  return Boolean(
    evidence?.kind === "packaged-handoff-gui"
      && entries.length === expected.size
      && entries.every((entry) => expected.has(entry?.host)
        && entry.operationId === operationId
        && entry.oldAttemptId === oldAttemptId
        && entry.newAttemptId === newAttemptId
        && entry.newSessionHash === newSessionHash
        && isSha256(entry.screenshotSha256)
        && isSha256(entry.operationSha256)
        && entry.connected === true
        && entry.nativeResponseObserved === true
        && entry.terminalObserved === true)
      && seen.size === expected.size
  );
}

export function soakBucketPass(bucket) {
  return Boolean(bucket
    && bucket.accepted === true
    && Number(bucket.eventCount) > 0
    && bucket.nativeTerminalObserved === true
    && bucket.activeReentered === true
    && bucket.nativeSubmissionCount === 1
    && bucket.nativeIdentityObserved === true
    && isSha256(bucket.providerSessionHash));
}

export function soakPass({
  elapsedSeconds,
  seconds,
  activityBucketMinutes,
  buckets,
  turns,
  forceKill,
  hostKilled,
  hostExited,
  coreAlive,
  nativeAlive,
  dbBefore,
  dbAfter,
  samplesComplete,
  evidenceValidation
}) {
  const requiredBuckets = [0, 2, 4, 6, 8];
  return Boolean(
    elapsedSeconds >= seconds
      && requiredBuckets.every((minute) => activityBucketMinutes.includes(minute))
      && buckets.length === turns
      && new Set(buckets.map((bucket) => bucket.requestId)).size === turns
      && buckets.every(soakBucketPass)
      && forceKill === true
      && hostKilled === true
      && hostExited === true
      && coreAlive === true
      && nativeAlive === true
      && Number.isFinite(dbBefore)
      && Number.isFinite(dbAfter)
      && dbAfter > dbBefore
      && samplesComplete === true
      && Object.values(evidenceValidation || {}).every(Boolean)
  );
}
