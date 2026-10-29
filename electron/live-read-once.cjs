"use strict";
// Additive lifecycle/context codecs, not a budget authority. Only the original
// worker's captured scope may decide readiness or spend a reservation.
const { normalizePiCapacity, samePiPair } = require("./pi-capacity.mjs");
const MODE = "live-read-once";
const CONTROL_SCHEMA = "goalport.coordination-job-control.v1";
const MAX_CONTROL_BYTES = 8192;
const id = value => typeof value === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).sort().join(",") === names.slice().sort().join(",");
function eligible(input) {
  return !!input && !!normalizePiCapacity(input.piCapacity) && input.backgroundConsent === true
    && input.maxTurns === 4 && !input.writeAuthorization
    && JSON.stringify(input.allowedInstances) === '["codex","pi"]';
}
function controlPayload(operation, payload) {
  if (operation === "status" || (operation === "revoke" && payload === undefined)) {
    if (payload !== undefined) throw Error("invalid-request");
    return undefined;
  }
  if (operation === "revoke" && keys(payload, ["onlyIfReadyFromRequestId"]) && id(payload.onlyIfReadyFromRequestId)) return { ...payload };
  if (operation === "continue" && keys(payload, ["requestId", "fromRequestId", "followUp"])
    && id(payload.requestId) && id(payload.fromRequestId) && payload.requestId !== payload.fromRequestId && typeof payload.followUp === "string") {
    return { requestId: payload.requestId, fromRequestId: payload.fromRequestId, followUp: payload.followUp.trim() };
  }
  throw Error(operation === "continue" || operation === "revoke" ? "invalid-request" : "unsupported-operation");
}
function controlFrame(token, operation, payload) {
  const normalized = controlPayload(operation, payload);
  const frame = JSON.stringify({ schema: CONTROL_SCHEMA, token, operation, ...(normalized === undefined ? {} : { payload: normalized }) }) + "\n";
  if (Buffer.byteLength(frame, "utf8") > MAX_CONTROL_BYTES) throw Object.assign(Error("This follow-up is too long for the open allowance. Shorten it; nothing was sent."), { code: "control-too-long" });
  return frame;
}
const CONTEXT_KEYS = ["requestId", "fromRequestId", "rootRequestId", "originalGoal", "followUp", "workspacePath", "piCapacity", "backgroundConsent", "write", "initialPlan", "initialReview", "acceptedAt", "phase"];
function ownedContext(input, mode, value, records) {
  if (mode !== MODE || !eligible(input) || !keys(value, CONTEXT_KEYS)
    || !id(value.requestId) || value.requestId === input.requestId || value.fromRequestId !== input.requestId
    || value.rootRequestId !== (input.continuation?.rootRequestId ?? input.requestId)
    || value.originalGoal !== (input.continuation?.originalGoal ?? input.goal)
    || value.workspacePath !== input.workspacePath || !samePiPair(value.piCapacity, input.piCapacity)
    || !keys(value.piCapacity, ["provider", "model", "useExistingCapacity"]) || !normalizePiCapacity(value.piCapacity)
    || value.backgroundConsent !== true || value.write !== false
    || typeof value.followUp !== "string" || value.followUp !== value.followUp.trim()
    || value.originalGoal.length + value.followUp.length > 100000
    || typeof value.initialPlan !== "string" || !value.initialPlan.trim() || typeof value.initialReview !== "string" || !value.initialReview.trim()
    || typeof value.acceptedAt !== "string" || Number.isNaN(Date.parse(value.acceptedAt))
    || !["accepted", "running", "completed", "unconfirmed"].includes(value.phase)) return null;
  if (records !== undefined) {
    if (!Array.isArray(records) || records.some(record => !object(record))) return null;
    const initial = records.filter(r => r.requestId === input.requestId);
    const children = records.filter(r => r.requestId === value.requestId);
    const targets = require("./saved-targets.cjs").resolveSavedTargets(records);
    if (targets.selected(input.requestId)?.rootRequestId !== value.rootRequestId
      || (children.length && targets.selected(value.requestId)?.rootRequestId !== value.rootRequestId)) return null;
    if (initial.length !== 1 || initial[0].verdict !== "checked" || initial[0].planText !== value.initialPlan || initial[0].reviewText !== value.initialReview
      || initial[0].workspacePath !== input.workspacePath || !samePiPair(initial[0].piCapacity, input.piCapacity) || children.length > 1) return null;
    if (children.length && (children[0].workspacePath !== input.workspacePath || children[0].goal !== value.originalGoal
      || !samePiPair(children[0].piCapacity, input.piCapacity)
      || !keys(children[0].continuation, ["parentRequestId", "rootRequestId", "originalGoal", "followUp"])
      || children[0].continuation.parentRequestId !== input.requestId || children[0].continuation.rootRequestId !== value.rootRequestId
      || children[0].continuation.originalGoal !== value.originalGoal || children[0].continuation.followUp !== value.followUp)) return null;
  }
  return { ...value, piCapacity: { ...value.piCapacity } };
}
const LIVE_KEYS = ["mode", "ready", "initialRequestId", "fromRequestId", "rootRequestId", "remainingReads", "readonly", "pending", "revoked", "childRequestId", "expiresAt", "reason"];
function liveStatus(value) {
  if (!keys(value, LIVE_KEYS) || value.mode !== MODE || !id(value.initialRequestId) || value.fromRequestId !== value.initialRequestId || !id(value.rootRequestId)
    || !["ready", "readonly", "pending", "revoked"].every(k => typeof value[k] === "boolean")
    || !(value.remainingReads === null || (Number.isInteger(value.remainingReads) && value.remainingReads >= 0 && value.remainingReads <= 4))
    || !(value.childRequestId === null || (id(value.childRequestId) && value.childRequestId !== value.initialRequestId))
    || !(value.expiresAt === null || (typeof value.expiresAt === "string" && !Number.isNaN(Date.parse(value.expiresAt))))
    || ![null, "busy", "revoked", "expired", "no-live-scope", "not-enough-reads", "unconfirmed", "context-unavailable"].includes(value.reason)
    || (value.ready && (!value.readonly || value.pending || value.revoked || value.childRequestId !== null || value.remainingReads < 2 || !value.expiresAt || value.reason !== null))) return null;
  return { ...value };
}
module.exports = { MODE, CONTROL_SCHEMA, MAX_CONTROL_BYTES, eligible, id, controlPayload, controlFrame, ownedContext, liveStatus };
