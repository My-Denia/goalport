"use strict";

const fs = require("node:fs");
const path = require("node:path");

const VERDICTS = new Set(["checked", "revise", "stopped", "failed", "unconfirmed"]);
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
  return {
    requestId,
    workspacePath,
    goal,
    planningHarness,
    reviewHarness,
    planText,
    reviewText,
    result,
    verdict,
    stopReason,
    planningQuota,
    reviewQuota,
    messageDispatched: dispatched(input.messageDispatched),
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

module.exports = { readRecords, saveRecord };
