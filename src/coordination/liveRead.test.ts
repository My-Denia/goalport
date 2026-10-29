import { expect, it } from "vitest";
import { liveAcceptedRequest, matchingAcknowledgedLiveReady, parseLiveRead } from "./liveRead";
import type { CoordinatedCurrentJob, SavedTargetResult } from "./savedTargetView";
const pair = { provider: "Fixture", model: "alpha", useExistingCapacity: true as const };
const ack = { mode: "live-read-once" as const, ready: true, initialRequestId: "initial", fromRequestId: "initial", rootRequestId: "root", remainingReads: 2, readonly: true, pending: false, revoked: false, childRequestId: null, expiresAt: "2026-01-01T00:15:00Z", reason: null };
const job: CoordinatedCurrentJob = { jobId: "job", requestId: "initial", rootRequestId: "root", workspacePath: "/work", identityConfirmed: true, line: "Ready", followUpMode: "live-read-once", liveRead: ack };
const selected: SavedTargetResult = { requestId: "initial", rootRequestId: "root", rootLatestId: "initial", goal: "Goal", workspacePath: "/work", verdict: "checked", outcome: "Plan checked", relationStatus: "valid", relationUnavailableReason: null, piCapacity: pair, rememberedIntent: { background: true, write: false, piCapacity: pair } };
it("parses a CLOSED RAM acknowledgement, rejects malformed, pending, wrong/older/root/pair readiness", () => {
 expect(parseLiveRead(ack)).toEqual(ack);
 for (const value of [{ ...ack, extra: 1 }, { ...ack, pending: true }, { ...ack, remainingReads: null }, { ...ack, readonly: false }, { ...ack, childRequestId: "child" }, { ...ack, expiresAt: null }]) expect(parseLiveRead(value)).toBeNull();
 expect(matchingAcknowledgedLiveReady(job, selected, pair)).toBe(true);
 for (const record of [{ ...selected, requestId: "other" }, { ...selected, rootLatestId: "child" }, { ...selected, rootRequestId: "other" }, { ...selected, workspacePath: "/other" }, { ...selected, piCapacity: { ...pair, model: "beta" } }]) expect(matchingAcknowledgedLiveReady(job, record, pair)).toBe(false);
 expect(matchingAcknowledgedLiveReady({ ...job, liveRead: undefined }, selected, pair)).toBe(false);
});
it("raw CLI acceptance is matched to BOTH original job and initial result, not HTTP success or another child", () => {
 const body = { ok: true, payload: { stdout: "job: job\nrequest: initial\nlive accepted request: child\n" } };
 expect(liveAcceptedRequest(body, "job", "initial")).toBe("child");
 expect(liveAcceptedRequest(body, "other", "initial")).toBeNull();
 expect(liveAcceptedRequest(body, "job", "other")).toBeNull();
 expect(liveAcceptedRequest({ ok: true }, "job", "initial")).toBeNull();
});
