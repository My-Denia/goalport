"use strict";

const MAX_CONTINUATION_CHARS = 100_000;
const MAX_CONTINUATION_PROMPT_BYTES = 100_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidContinuationDescriptor(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !keys.every((key) => ["parentRequestId", "rootRequestId", "originalGoal", "followUp"].includes(key))) return false;
  if (typeof value.parentRequestId !== "string" || typeof value.rootRequestId !== "string") return false;
  const parentRequestId = value.parentRequestId.trim();
  const rootRequestId = value.rootRequestId.trim();
  if (!parentRequestId || !rootRequestId) return false;
  if (!REQUEST_ID_PATTERN.test(parentRequestId) || !REQUEST_ID_PATTERN.test(rootRequestId)) return false;
  if (parentRequestId.length > 256 || rootRequestId.length > 256) return false;
  if (typeof value.originalGoal !== "string" || typeof value.followUp !== "string") return false;
  const originalGoal = value.originalGoal.trim();
  if (originalGoal.length === 0) return false;
  const followUp = value.followUp.trim();
  if (originalGoal.length > MAX_CONTINUATION_CHARS || followUp.length > MAX_CONTINUATION_CHARS) return false;
  if (originalGoal.length + followUp.length > MAX_CONTINUATION_CHARS) return false;
  return true;
}

function normalizeContinuationDescriptor(value) {
  if (!isValidContinuationDescriptor(value)) return null;
  return {
    parentRequestId: value.parentRequestId.trim(),
    rootRequestId: value.rootRequestId.trim(),
    originalGoal: value.originalGoal.trim(),
    followUp: value.followUp.trim(),
  };
}

function validatedContinuationOf(record) {
  if (!record || typeof record !== "object") return undefined;
  if (record.continuation === undefined || record.continuation === null) return undefined;
  return normalizeContinuationDescriptor(record.continuation) ?? undefined;
}

module.exports = {
  MAX_CONTINUATION_CHARS,
  MAX_CONTINUATION_PROMPT_BYTES,
  REQUEST_ID_PATTERN,
  isPlainObject,
  isValidContinuationDescriptor,
  normalizeContinuationDescriptor,
  validatedContinuationOf,
};
