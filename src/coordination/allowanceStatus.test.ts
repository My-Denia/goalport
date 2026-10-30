import { expect, it } from "vitest";
import type { BackgroundStatus } from "./backgroundStatus";
import type { SavedAllowanceView, SavedCurrentBase, SubmissionCandidate } from "./savedTargetView";
import { acknowledgedCurrentJob, confirmedAssociation, confirmedIdleEnd, matchesBase, parseAllowanceStatus, readyBase, sameReadyBase, STATUS_UNAVAILABLE, validJobId } from "./allowanceStatus";
import { matchingAcknowledgedLiveReady } from "./liveRead";
const jobId = "abcdefab-1111-4111-8111-111111111111";
const ack = { mode: "live-read-once" as const, ready: true, initialRequestId: "initial", fromRequestId: "initial", rootRequestId: "initial", remainingReads: 2, readonly: true, pending: false, revoked: false, childRequestId: null, expiresAt: "2099-01-01T00:15:00Z", reason: null };
const job: BackgroundStatus = { jobId, requestId: "initial", goal: "Synthetic goal", workspacePath: "/fixture/work", followUpMode: "live-read-once", state: "running", active: true, live: true, revoked: false, workerPid: 1, readMaxTurns: 4, writeMaxTurns: null, counters: null, pendingCommand: null, completedCommands: [], progress: null, outcome: null, phase: "awaiting-followup", liveRead: ack };
const base: SavedCurrentBase = { kind: "saved-current-base", jobId, admittedRequestId: "initial", rootRequestId: "initial", goal: job.goal, workspacePath: job.workspacePath!, followUpMode: "live-read-once", identityConfirmed: true, state: "running", phase: "awaiting-followup", pending: "none", revoked: false, workerGone: false, unconfirmed: false, allowanceEnd: null, active: true, observedAcceptedChildId: null, globalSlot: { kind: "occupied", jobId, admittedRequestId: "initial" }, profileUnconfirmed: false, leftoverHeld: false };
const candidate: SubmissionCandidate = { kind: "submission-candidate", jobId, admittedRequestId: "initial", rootRequestId: "initial", goal: job.goal, workspacePath: job.workspacePath!, identityConfirmed: true, active: true };
it("requires exact UUID-v4 job spelling, a closed source union and typed host projection", () => {
  expect(validJobId(jobId.toUpperCase())).toBe(true);
  for (const id of ["request:valid", "job-a", "../job", jobId.replace("4111", "3111")]) expect(validJobId(id)).toBe(false);
  const reply = { source: "host-status", job, jobId };
  expect(parseAllowanceStatus(reply, jobId)).toEqual(reply);
  expect(parseAllowanceStatus({ ...reply, job: { ...job, readMaxTurns: 32, counters: { readTurnsLeft: 32 } } }, jobId)?.source).toBe("host-status");
  for (const value of [{ ...reply, source: "saved" }, { ...reply, extra: true }, { ...reply, job: { ...job, jobId: jobId.toUpperCase() } }, { ...reply, job: { ...job, active: "true" } }, { ...reply, job: { ...job, liveRead: { ...ack, privateScope: "no" } } }, { ...reply, job: { ...job, pendingCommand: {} } }, { ...reply, job: { ...job, counters: { readTurnsLeft: -1 } } }, { ...reply, job: { ...job, outcome: {} } }, { ...reply, job: { ...job, readMaxTurns: null } }]) expect(parseAllowanceStatus(value, jobId)).toBeNull();
  expect(parseAllowanceStatus({ source: "unavailable", job: null, jobId, reason: STATUS_UNAVAILABLE }, jobId)?.source).toBe("unavailable");
  expect(parseAllowanceStatus({ source: "unavailable", job, jobId, reason: STATUS_UNAVAILABLE }, jobId)).toBeNull();
  expect(parseAllowanceStatus({ source: "unavailable", job: null, jobId, reason: "private stderr" }, jobId)).toBeNull();
});
it("saved labels and fabricated saved/unavailable status never reach Ready, including runtime casts", () => {
  const saved: SavedAllowanceView = { kind: "saved-allowance", jobId, initialRequestId: "initial", rootRequestId: "initial", state: "running", phase: "awaiting-followup", allowanceEnd: null };
  for (const value of [{ source: "host-status", job: saved, jobId }, { source: "host-status", job: { ...job, kind: "saved-allowance" }, jobId }, { source: "unavailable", job, jobId, reason: STATUS_UNAVAILABLE }]) {
    expect(parseAllowanceStatus(value, jobId)).toBeNull();
    expect(acknowledgedCurrentJob(value as Parameters<typeof acknowledgedCurrentJob>[0])).toBeNull();
  }
  expect(matchingAcknowledgedLiveReady(base as unknown as Parameters<typeof matchingAcknowledgedLiveReady>[0], null)).toBe(false);
  expect(acknowledgedCurrentJob({ source: "host-status", job, jobId })?.source).toBe("host-status");
});
it("negative/unknown base and changed exact identity cannot retain a Ready observation", () => {
  expect(readyBase(base)).toBe(true); expect(sameReadyBase(base, { ...base })).toBe(true);
  for (const changed of [{ revoked: true }, { pending: "present" }, { workerGone: true }, { workerGone: "unknown" }, { unconfirmed: true }, { allowanceEnd: "expired" }, { state: "unknown" }, { globalSlot: { kind: "unknown" } }, { globalSlot: { kind: "empty" } }, { globalSlot: { kind: "occupied", jobId: "other", admittedRequestId: "other" } }, { observedAcceptedChildId: "child" }, { leftoverHeld: true }, { profileUnconfirmed: true }, { phase: "unknown" }]) expect(readyBase({ ...base, ...changed } as SavedCurrentBase)).toBe(false);
  expect(sameReadyBase(base, { ...base, rootRequestId: "foreign" })).toBe(false);
  expect(matchesBase(job, base)).toBe(true);
  expect(matchesBase({ ...job, requestId: "foreign" }, base)).toBe(false);
});
it("settles only a known submitted canonical identity, not text, disk accepted-child observation or pending status", () => {
  const held = { requestId: "initial", goal: job.goal, workspace: job.workspacePath!, root: null };
  expect(confirmedAssociation(job, candidate, held)).toBe(true);
  for (const different of [{ ...held, requestId: "same-text-other-id" }, { ...held, workspace: "~/work" }, { ...held, workspace: "/fixture/work/../work" }, { ...held, root: "foreign" }]) expect(confirmedAssociation(job, candidate, different)).toBe(false);
  for (const different of [{ ...job, requestId: "other" }, { ...job, state: "unconfirmed" as const }, { ...job, live: false }, { ...job, pendingCommand: { commandId: "pending", state: "unconfirmed" } }]) expect(confirmedAssociation(different, candidate, held)).toBe(false);
  const ended: BackgroundStatus = { ...job, liveRead: undefined, active: false, live: false, state: "stopped", outcome: { status: "stopped" } };
  expect(confirmedAssociation(ended, candidate, held)).toBe(true);
  expect(confirmedIdleEnd(ended, { jobId, requestId: "initial", root: "initial" })).toBe(true);
  expect(confirmedIdleEnd({ ...ended, live: true }, { jobId, requestId: "initial", root: "initial" })).toBe(false);
  expect(confirmedIdleEnd({ ...ended, pendingCommand: { commandId: "pending", state: "unconfirmed" } }, { jobId, requestId: "initial", root: "initial" })).toBe(false);
});
