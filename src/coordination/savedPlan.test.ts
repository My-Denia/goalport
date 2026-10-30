import { describe, expect, it } from "vitest";
import type { SavedPlan, SavedTargetContinuation, SavedTargetRelationStatus } from "./savedPlan";
import type { CoordinationRecord } from "../ipc";

describe("SavedPlan and CoordinationRecord typed projections", () => {
  const continuation: SavedTargetContinuation = {
    parentRequestId: "req-parent-1",
    rootRequestId: "req-root-1",
    originalGoal: "Primary coordination goal.",
    followUp: "Follow-up coordination instruction.",
  };

  it("carries optional continuation descriptor and relation status on SavedPlan", () => {
    const planWithContinuation: SavedPlan = {
      requestId: "req-child-1",
      goal: "Primary coordination goal.",
      workspacePath: "/work/repo",
      planningHarness: "Codex",
      reviewHarness: "Claude",
      planText: "Plan text.",
      reviewText: "Review text.\nVERDICT: carry-out",
      result: "Review text.\nVERDICT: carry-out",
      verdict: "checked",
      stopReason: "Review completed.",
      planningQuota: "available",
      reviewQuota: "available",
      continuation,
      relationStatus: "valid",
    };

    expect(planWithContinuation.continuation).toEqual(continuation);
    expect(planWithContinuation.relationStatus).toBe("valid");
    expect(planWithContinuation.goal).toBe("Primary coordination goal.");
  });

  it("carries optional continuation descriptor and relation status on CoordinationRecord", () => {
    const record: CoordinationRecord = {
      requestId: "req-child-2",
      goal: "Primary coordination goal.",
      workspacePath: "/work/repo",
      planningHarness: "Codex",
      reviewHarness: "Claude",
      planText: "Plan text.",
      reviewText: "Review text.\nVERDICT: carry-out",
      result: "Review text.\nVERDICT: carry-out",
      verdict: "checked",
      stopReason: "Review completed.",
      planningQuota: "available",
      reviewQuota: "available",
      continuation,
      relationStatus: "valid",
    };

    expect(record.continuation).toEqual(continuation);
    expect(record.relationStatus).toBe("valid");
  });

  it("allows legacy record without continuation or relation status", () => {
    const legacyPlan: SavedPlan = {
      requestId: "req-legacy-1",
      goal: "Legacy standalone goal.",
      workspacePath: "/work/repo",
      planningHarness: "Codex",
      reviewHarness: "Claude",
      planText: "Plan text.",
      reviewText: "Review text.\nVERDICT: carry-out",
      result: "Review text.\nVERDICT: carry-out",
      verdict: "checked",
      stopReason: "Review completed.",
      planningQuota: "available",
      reviewQuota: "available",
    };

    expect(legacyPlan.continuation).toBeUndefined();
    expect(legacyPlan.relationStatus).toBeUndefined();
  });

  it("supports invalid and ambiguous relation status types with optional reason", () => {
    const invalidPlan: SavedPlan = {
      requestId: "req-broken-1",
      goal: "Goal with broken ancestry.",
      workspacePath: "/work/repo",
      planningHarness: "Codex",
      reviewHarness: "Claude",
      planText: "Plan text.",
      reviewText: "Review text.",
      result: "Result text.",
      verdict: "failed",
      stopReason: "Failed.",
      planningQuota: "available",
      reviewQuota: "available",
      relationStatus: "invalid",
      relationUnavailableReason: "Parent record missing.",
    };

    expect(invalidPlan.relationStatus).toBe("invalid");
    expect(invalidPlan.relationUnavailableReason).toBe("Parent record missing.");
  });
});
