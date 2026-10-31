import { describe, expect, it } from "vitest";
import { turnResultsWorthShowing } from "./panels/TurnResults";
import type { CoreCommandOutcome, TurnResult } from "./types";
import {
  canExplicitlyRetry,
  conversationSendIntent,
  retryLabel,
  settleSendIntent,
  settleNativeSendIntent,
  startConversationIntent,
  type SendIntent
} from "./lib/sendIntent";

function hostRefusal(intent: SendIntent): CoreCommandOutcome {
  return { kind: "refused", requestId: intent.requestId, messageType: intent.method,
    refusalSource: "workbench-native-preflight", error: "Controlled reason.",
    rejection: { code: "native-preflight-refused", message: "Controlled reason.", deliveryState: "FAILED",
      nativeDispatchState: "NOT_STARTED", retryMode: "NEW_REQUEST", reservation: null } };
}

describe("native invocation-local refusal", () => {
  const intents = [startConversationIntent("start", "/fixture", "codex", "first"), conversationSendIntent("send", "campaign", "attempt", "follow")];
  it.each(intents)("clears only the first unretained $method", intent => {
    expect(settleNativeSendIntent(intent, hostRefusal(intent))).toBeNull();
    for (const state of ["same-request", "reconcile"] as const) {
      const prior = Object.freeze({ ...intent, state, reservation: { kind: "first-send" as const, requestId: intent.requestId,
        campaignId: "reserved", taskId: "task", attemptId: "attempt", messageReserved: true } });
      const sent = { ...prior, state: "sending" as const };
      expect(settleNativeSendIntent(sent, hostRefusal(sent), prior)).toBe(prior);
      expect(prior.state).toBe(state);
      expect(sent.state).toBe("sending");
    }
  });
  it.each(intents)("safely reconciles defensive sending and malformed/stale $method proof", intent => {
    expect(settleNativeSendIntent(intent, hostRefusal(intent), intent)).toEqual({ ...intent, state: "reconcile" });
    for (const change of [{ requestId: "other" }, { messageType: "rename_conversation" }, { rejection: undefined }, { kind: "accepted" as const }]) {
      expect(settleNativeSendIntent(intent, { ...hostRefusal(intent), ...change })).toEqual({ ...intent, state: "reconcile" });
      const prior = { ...intent, state: "same-request" as const };
      expect(settleNativeSendIntent(intent, { ...hostRefusal(intent), ...change }, prior)).toBe(prior);
    }
  });
  it("does not clear a different retained identity from a stale host result", () => {
    const sent = intents[0];
    const current = { ...sent, requestId: "newer", workspaceRoot: "/different", state: "reconcile" as const };
    expect(settleNativeSendIntent(sent, hostRefusal(sent), current)).toBe(current);
  });
  it.each(intents)("delegates EVERY untagged $method outcome exactly, regardless of prior history", intent => {
    const host = hostRefusal(intent);
    const authoritative = { ...host, refusalSource: undefined };
    const cases: Array<CoreCommandOutcome | undefined> = [undefined, authoritative,
      { ...authoritative, kind: "accepted" }, { ...authoritative, rejection: undefined },
      { ...authoritative, kind: "transport-error", rejection: undefined },
      { ...authoritative, rejection: { ...authoritative.rejection!, retryMode: "SAME_REQUEST",
        reservation: { kind: "first-send", requestId: intent.requestId, campaignId: "reserved", taskId: "task", attemptId: "attempt", messageReserved: true } } }];
    for (const outcome of cases) for (const prior of [undefined, { ...intent, state: "reconcile" as const }, { ...intent, state: "same-request" as const }]) {
      expect(settleNativeSendIntent(intent, outcome, prior)).toEqual(settleSendIntent(intent, outcome));
    }
    expect(settleNativeSendIntent(intent, authoritative, { ...intent, state: "reconcile" })).toBeNull();
  });
});

describe("stable send intent", () => {
  it("retains one id through transport ambiguity and explicit reconciliation", () => {
    const issued = conversationSendIntent("stable-1", "campaign-1", "attempt-1", "hello");
    const uncertain = settleSendIntent(issued, {
      kind: "transport-error",
      requestId: "stable-1",
      messageType: "conversation_send",
      error: "acknowledgement lost"
    });
    expect(uncertain).toEqual(expect.objectContaining({ requestId: "stable-1", state: "reconcile" }));
    expect(canExplicitlyRetry(uncertain ?? undefined)).toBe(true);
    expect(retryLabel(uncertain ?? undefined)).toBe("Check result");
  });

  it("adopts a first-send reservation and retries the original start identity", () => {
    const issued = startConversationIntent("stable-start", "C:\\work", "codex", "inspect it");
    const retained = settleSendIntent(issued, {
      kind: "refused",
      requestId: "stable-start",
      messageType: "start_conversation",
      rejection: {
        code: "admission-failed",
        message: "Runtime did not start",
        deliveryState: "FAILED",
        nativeDispatchState: "NOT_STARTED",
        retryMode: "SAME_REQUEST",
        reservation: {
          kind: "first-send",
          requestId: "stable-start",
          campaignId: "campaign-reserved",
          taskId: "task-reserved",
          attemptId: "attempt-reserved",
          messageReserved: true
        }
      }
    });
    expect(retained).toEqual(expect.objectContaining({
      requestId: "stable-start",
      method: "start_conversation",
      workspaceRoot: "C:\\work",
      provider: "codex",
      message: "inspect it",
      state: "same-request",
      reservation: expect.objectContaining({ campaignId: "campaign-reserved" })
    }));
    expect(retryLabel(retained ?? undefined)).toBe("Retry");
  });

  it("permits a new identity only for an explicit unreserved NEW_REQUEST result", () => {
    const issued = conversationSendIntent("old", "campaign-1", "attempt-1", "hello");
    expect(settleSendIntent(issued, {
      kind: "refused",
      requestId: "old",
      messageType: "conversation_send",
      rejection: {
        code: "validation",
        message: "Nothing was reserved",
        deliveryState: "FAILED",
        nativeDispatchState: "NOT_STARTED",
        retryMode: "NEW_REQUEST",
        reservation: null
      }
    })).toBeNull();
  });

  it("keeps the id when NEW_REQUEST contradicts delivery certainty", () => {
    const issued = conversationSendIntent("kept", "campaign-1", "attempt-1", "hello");
    const retained = settleSendIntent(issued, {
      kind: "refused",
      requestId: "kept",
      messageType: "conversation_send",
      rejection: {
        code: "contradictory",
        message: "uncertain",
        deliveryState: "UNKNOWN",
        nativeDispatchState: "UNKNOWN",
        retryMode: "NEW_REQUEST",
        reservation: null
      }
    });
    expect(retained).toEqual(expect.objectContaining({ requestId: "kept", state: "reconcile" }));
  });
});

describe("a folder that does not exist", () => {
  it('releases the draft so the path can be corrected', () => {
    const intent = startConversationIntent('request', 'C:/nope', 'codex', 'hello');
    const outcome = { requestId: 'request', messageType: 'start_conversation', kind: 'refused', error: 'missing',
      rejection: { code: 'workspace-missing', message: 'missing', deliveryState: 'FAILED', nativeDispatchState: 'NOT_STARTED', retryMode: 'NEW_REQUEST', reservation: null } } as CoreCommandOutcome;
    expect(settleSendIntent(intent, outcome)).toBeNull();
  });
});

describe("turn results worth showing", () => {
  const quiet = { requestId: "a", replyState: "completed", baselineRecorded: false, comparisonUnavailable: true, during: [], unattributed: [], before: [], commands: [] } as unknown as TurnResult;
  it("drops a finished turn that could only say it was not compared", () => {
    expect(turnResultsWorthShowing([quiet])).toEqual([]);
  });
  it("keeps a turn that ran commands or did not finish", () => {
    const ran = { ...quiet, commands: [{}] } as unknown as TurnResult;
    const stopped = { ...quiet, replyState: "stopped" } as unknown as TurnResult;
    expect(turnResultsWorthShowing([ran, stopped])).toEqual([ran, stopped]);
  });
});
