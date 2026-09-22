import { describe, expect, it } from "vitest";
import {
  canExplicitlyRetry,
  conversationSendIntent,
  retryLabel,
  settleSendIntent,
  startConversationIntent
} from "./lib/sendIntent";

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
