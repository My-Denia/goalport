"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isValidContinuationDescriptor, normalizeContinuationDescriptor, validatedContinuationOf } = require("./coordination-continuation.cjs");

const VERDICTS = new Set(["checked", "revise", "stopped", "failed", "unconfirmed", "verified"]);
const ROLES = new Set(["planning", "review", "execution", "audit"]);
const QUOTAS = new Set(["unknown", "available", "exhausted"]);

function recordFile(directory) {
  return path.join(directory, "coordination-records.json");
}

function nullableText(value) {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function quota(value) {
  if (value === null) return null;
  if (typeof value === "string" && QUOTAS.has(value)) return value;
  return undefined;
}

// Tri-state: false = provably nothing dispatched (retryable), true = a turn
// went out (never silently resend), null/absent = unknown, treated as sent.
function dispatched(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function savedAtOf(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text)) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

// A malformed environment block degrades to null (the fact is dropped) rather
// than rejecting the whole plan record: a saved plan must survive even when
// this field predates the format or arrives corrupted.
function environmentBlockedOf(value) {
  if (typeof value !== "object" || value === null) return null;
  const role = ROLES.has(value.role) ? value.role : null;
  const instanceId = typeof value.instanceId === "string" && value.instanceId.trim() ? value.instanceId.trim() : null;
  if (!role || !instanceId) return null;
  return {
    role,
    instanceId,
    harness: nullableText(value.harness) ?? null,
    detail: nullableText(value.detail) ?? null,
  };
}

function roundEventOf(value) {
  if (typeof value !== "object" || value === null) return null;
  const kind = value.kind === "failed" || value.kind === "continued" ? value.kind : null;
  const role = ROLES.has(value.role) ? value.role : null;
  const instanceId = typeof value.instanceId === "string" && value.instanceId.trim() ? value.instanceId.trim() : null;
  const harness = nullableText(value.harness);
  const sentence = nullableText(value.sentence);
  if (!kind || !role || !instanceId || harness === undefined || !sentence) return null;
  const event = { kind, role, instanceId, harness, sentence };
  if (value.detail !== undefined) {
    const detail = nullableText(value.detail);
    if (detail === undefined) return null;
    event.detail = detail;
  }
  return event;
}

function roundEventsOf(value) {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    try {
      const event = roundEventOf(item);
      return event ? [event] : [];
    } catch {
      return [];
    }
  });
}

function executionEvidenceOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const status = typeof value.status === "string" ? value.status : "unavailable";
  const complete = value.complete === true;
  const changed = value.changed === true ? true : value.changed === false ? false : null;
  const beforeDiff = typeof value.beforeDiff === "string" ? value.beforeDiff : null;
  const afterDiff = typeof value.afterDiff === "string" ? value.afterDiff : null;
  const reason = typeof value.reason === "string" ? value.reason : null;
  const label = typeof value.label === "string" ? value.label : undefined;
  const timedOutObservation = value.timedOutObservation === true ? true : undefined;
  const truncated = value.truncated === true ? true : undefined;
  const comparisonBaseline = value.comparisonBaseline && typeof value.comparisonBaseline === "object"
    ? {
        headCommit: typeof value.comparisonBaseline.headCommit === "string" ? value.comparisonBaseline.headCommit : null,
        capturedAt: typeof value.comparisonBaseline.capturedAt === "string" ? value.comparisonBaseline.capturedAt : new Date().toISOString(),
      }
    : null;
  const untrackedOf = (candidate) => Array.isArray(candidate)
    ? candidate.flatMap((item) => {
        if (!item || typeof item !== "object" || typeof item.path !== "string") return [];
        return [{
          path: item.path,
          ...(typeof item.size === "number" ? { size: item.size } : {}),
          ...(typeof item.content === "string" ? { content: item.content } : {}),
          ...(typeof item.binary === "boolean" ? { binary: item.binary } : {}),
          ...(typeof item.skipped === "string" ? { skipped: item.skipped } : {}),
          ...(item.truncated === true ? { truncated: true } : {}),
        }];
      })
    : [];
  const untrackedFiles = untrackedOf(value.untrackedFiles);
  const beforeUntrackedFiles = Array.isArray(value.beforeUntrackedFiles) ? untrackedOf(value.beforeUntrackedFiles) : undefined;

  return {
    status,
    complete,
    changed,
    beforeDiff,
    afterDiff,
    ...(beforeUntrackedFiles === undefined ? {} : { beforeUntrackedFiles }),
    untrackedFiles,
    ...(typeof value.beforeUntrackedFilesOmitted === "number" ? { beforeUntrackedFilesOmitted: value.beforeUntrackedFilesOmitted } : {}),
    ...(typeof value.untrackedFilesOmitted === "number" ? { untrackedFilesOmitted: value.untrackedFilesOmitted } : {}),
    comparisonBaseline,
    ...(reason !== null ? { reason } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(timedOutObservation !== undefined ? { timedOutObservation } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

function auditCoverageOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.totalEvidenceBytes !== "number" || typeof value.includedEvidenceBytes !== "number") return undefined;
  return {
    totalEvidenceBytes: value.totalEvidenceBytes,
    includedEvidenceBytes: value.includedEvidenceBytes,
    cropped: value.cropped === true,
    promptBytes: typeof value.promptBytes === "number" ? value.promptBytes : 0,
    ...(typeof value.promptBudgetBytes === "number" ? { promptBudgetBytes: value.promptBudgetBytes } : {}),
    ...(typeof value.windowsCmdWorstCaseChars === "number" ? { windowsCmdWorstCaseChars: value.windowsCmdWorstCaseChars } : {}),
    ...(Array.isArray(value.croppedSections) ? { croppedSections: value.croppedSections.filter((item) => typeof item === "string") } : {}),
  };
}

// Exact transport material is not trimmed: leading/trailing whitespace and
// every crop marker are part of what the auditor actually received.
function auditInputTextOf(value) {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function coordinationRoundFactOf(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const planningHarness = nullableText(value.planningHarness);
  const reviewHarness = nullableText(value.reviewHarness);
  const planText = nullableText(value.planText);
  const reviewText = nullableText(value.reviewText);
  const executionText = nullableText(value.executionText);
  const auditText = nullableText(value.auditText);
  const executionHarness = nullableText(value.executionHarness);
  const auditHarness = nullableText(value.auditHarness);
  const result = nullableText(value.result);
  const stopReason = nullableText(value.stopReason);
  const verdict = value.verdict === null
    ? null
    : (typeof value.verdict === "string" && VERDICTS.has(value.verdict) ? value.verdict : undefined);
  if (
    planningHarness === undefined
    || reviewHarness === undefined
    || planText === undefined
    || reviewText === undefined
    || executionText === undefined
    || auditText === undefined
    || executionHarness === undefined
    || auditHarness === undefined
    || result === undefined
    || !stopReason
    || verdict === undefined
    || !Array.isArray(value.commandIds)
  ) return null;

  const fact = {
    planningHarness,
    reviewHarness,
    planText,
    reviewText,
    executionText,
    auditText,
    executionHarness,
    auditHarness,
    result,
    verdict,
    stopReason,
    messageDispatched: dispatched(value.messageDispatched),
    commandIds: value.commandIds.flatMap((commandId) => {
      if (typeof commandId !== "string") return [];
      const text = commandId.trim();
      return text ? [text] : [];
    }),
  };
  let executionEvidence;
  try {
    executionEvidence = executionEvidenceOf(value.executionEvidence);
  } catch {
    executionEvidence = undefined;
  }
  let auditInputEvidenceCoverage;
  try {
    auditInputEvidenceCoverage = auditCoverageOf(value.auditInputEvidenceCoverage);
  } catch {
    auditInputEvidenceCoverage = undefined;
  }
  const auditInputEvidenceText = auditInputTextOf(value.auditInputEvidenceText);
  let roundEvents;
  try {
    roundEvents = roundEventsOf(value.roundEvents);
  } catch {
    // Completed-event history is best-effort and never rejects the round fact.
    roundEvents = undefined;
  }
  return {
    ...fact,
    ...(executionEvidence === undefined ? {} : { executionEvidence }),
    ...(auditInputEvidenceCoverage === undefined ? {} : { auditInputEvidenceCoverage }),
    ...(auditInputEvidenceText === undefined ? {} : { auditInputEvidenceText }),
    ...(roundEvents === undefined ? {} : { roundEvents }),
  };
}

function feedbackHistoryOf(value) {
  if (!Array.isArray(value)) return undefined;
  // This slice retains exactly the first completed pass. Later passes are
  // represented by the record's top-level result fields, not nested history.
  const first = coordinationRoundFactOf(value[0]);
  return first ? [first] : [];
}

// The original plan-rejected pass retained by the one revised chain: same
// bounded shape (at most one entry), same permission-free facts.
function planRevisionHistoryOf(value) {
  if (!Array.isArray(value)) return undefined;
  const first = coordinationRoundFactOf(value[0]);
  return first ? [first] : [];
}

// Combine per-pass dispatch with the latest projection into the original
// Send's tri-state. A later pass that proves it sent nothing cannot erase an
// earlier sent (or unknown) pass and make the goal appear retryable.
function sendWideDispatched(value, feedbackHistory, planRevisionHistory) {
  const dispatchStates = [
    dispatched(value),
    ...(feedbackHistory ?? []).map((round) => round.messageDispatched),
    ...(planRevisionHistory ?? []).map((round) => round.messageDispatched),
  ];
  if (dispatchStates.includes(true)) return true;
  if (dispatchStates.includes(null)) return null;
  return false;
}

function normalize(input) {
  if (!input || typeof input !== "object") return null;
  const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
  const workspacePath = typeof input.workspacePath === "string" ? input.workspacePath.trim() : "";
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  const stopReason = typeof input.stopReason === "string" ? input.stopReason.trim() : "";
  const verdict = input.verdict;
  if (!requestId || !workspacePath || !goal || !stopReason || !VERDICTS.has(verdict)) return null;
  if (stopReason.toLowerCase().includes("replaced")) return null;
  const planningHarness = nullableText(input.planningHarness);
  const reviewHarness = nullableText(input.reviewHarness);
  const planText = nullableText(input.planText);
  const reviewText = nullableText(input.reviewText);
  const result = nullableText(input.result);
  const executionText = nullableText(input.executionText) ?? null;
  const auditText = nullableText(input.auditText) ?? null;
  const executionHarness = nullableText(input.executionHarness) ?? null;
  const auditHarness = nullableText(input.auditHarness) ?? null;
  const planningQuota = quota(input.planningQuota);
  const reviewQuota = quota(input.reviewQuota);
  if (
    planningHarness === undefined
    || reviewHarness === undefined
    || planText === undefined
    || reviewText === undefined
    || result === undefined
    || planningQuota === undefined
    || reviewQuota === undefined
  ) return null;
  let roundEvents;
  try {
    roundEvents = roundEventsOf(input.roundEvents);
  } catch {
    // Round-event metadata is best-effort; malformed access never rejects
    // the otherwise valid saved plan.
    roundEvents = undefined;
  }
  let executionEvidence;
  try {
    executionEvidence = executionEvidenceOf(input.executionEvidence);
  } catch {
    executionEvidence = undefined;
  }
  let auditInputEvidenceCoverage;
  try {
    auditInputEvidenceCoverage = auditCoverageOf(input.auditInputEvidenceCoverage);
  } catch {
    auditInputEvidenceCoverage = undefined;
  }
  const auditInputEvidenceText = auditInputTextOf(input.auditInputEvidenceText);
  let feedbackHistory;
  try {
    feedbackHistory = feedbackHistoryOf(input.feedbackHistory);
  } catch {
    // Optional first-pass evidence must never make an otherwise valid record
    // unreadable if its saved shape is malformed.
    feedbackHistory = undefined;
  }
  let planRevisionHistory;
  try {
    planRevisionHistory = planRevisionHistoryOf(input.planRevisionHistory);
  } catch {
    // Optional plan-revision evidence degrades the same way: dropped, never
    // fatal to the rest of the saved record.
    planRevisionHistory = undefined;
  }
  let continuation;
  if (input.continuation !== undefined) {
    if (isValidContinuationDescriptor(input.continuation)) {
      continuation = normalizeContinuationDescriptor(input.continuation);
    } else {
      // Malformed existing optional metadata must not be discarded or cause
      // record rejection; raw field preserved for future read-time relation validator.
      continuation = input.continuation;
    }
  }
  return {
    requestId,
    workspacePath,
    goal,
    planningHarness,
    reviewHarness,
    planText,
    reviewText,
    result,
    executionText,
    auditText,
    executionHarness,
    auditHarness,
    verdict,
    stopReason,
    planningQuota,
    reviewQuota,
    messageDispatched: sendWideDispatched(input.messageDispatched, feedbackHistory, planRevisionHistory),
    environmentBlocked: environmentBlockedOf(input.environmentBlocked),
    ...(executionEvidence === undefined ? {} : { executionEvidence }),
    ...(auditInputEvidenceCoverage === undefined ? {} : { auditInputEvidenceCoverage }),
    ...(auditInputEvidenceText === undefined ? {} : { auditInputEvidenceText }),
    ...(roundEvents === undefined ? {} : { roundEvents }),
    ...(feedbackHistory === undefined ? {} : { feedbackHistory }),
    ...(planRevisionHistory === undefined ? {} : { planRevisionHistory }),
    ...(continuation === undefined ? {} : { continuation }),
    savedAt: savedAtOf(input.savedAt),
  };
}

function readRecords(directory) {
  const file = recordFile(directory);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const record = normalize(item);
      return record ? [record] : [];
    });
  } catch {
    return [];
  }
}

function saveRecord(directory, input, clock = () => new Date().toISOString()) {
  if (input && input.continuation !== undefined) {
    if (!isValidContinuationDescriptor(input.continuation)) {
      throw new Error("The continuation descriptor is malformed.");
    }
  }
  const record = normalize(input);
  if (!record) {
    throw new Error("The plan could not be saved.");
  }
  const stamped = { ...record, savedAt: clock() };
  fs.mkdirSync(directory, { recursive: true });
  const existing = readRecords(directory).filter((item) => item.requestId !== stamped.requestId);
  const records = [stamped, ...existing];
  const file = recordFile(directory);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return stamped;
}

module.exports = {
  normalizeRecord: normalize,
  readRecords,
  saveRecord,
  isValidContinuationDescriptor,
  normalizeContinuationDescriptor,
  validatedContinuationOf,
};
