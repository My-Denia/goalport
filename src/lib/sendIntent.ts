import type { ConversationReservation, CoreCommandOutcome } from "../types";

export type SendIntentMethod = "start_conversation" | "conversation_send";
export type SendIntentState = "sending" | "same-request" | "reconcile";

/** One submitted user intent. Its request ID survives every ambiguous round trip. */
export interface SendIntent {
  requestId: string;
  method: SendIntentMethod;
  message: string;
  state: SendIntentState;
  workspaceRoot?: string;
  provider?: string;
  campaignId?: string;
  attemptId?: string;
  reservation?: ConversationReservation;
}

export function startConversationIntent(
  requestId: string,
  workspaceRoot: string,
  provider: string,
  message: string
): SendIntent {
  return { requestId, method: "start_conversation", workspaceRoot, provider, message, state: "sending" };
}

export function conversationSendIntent(
  requestId: string,
  campaignId: string,
  attemptId: string | undefined,
  message: string
): SendIntent {
  return { requestId, method: "conversation_send", campaignId, attemptId, message, state: "sending" };
}

export function isSameIntent(intent: SendIntent | undefined, candidate: Omit<SendIntent, "state" | "reservation">): boolean {
  return Boolean(intent
    && intent.requestId === candidate.requestId
    && intent.method === candidate.method
    && intent.message === candidate.message
    && intent.workspaceRoot === candidate.workspaceRoot
    && intent.provider === candidate.provider
    && intent.campaignId === candidate.campaignId
    && intent.attemptId === candidate.attemptId);
}

export function canExplicitlyRetry(intent: SendIntent | undefined): boolean {
  return intent?.state === "same-request" || intent?.state === "reconcile";
}

/**
 * Settles one round trip without inventing certainty. Legacy refusals and
 * transport failures are ambiguous and therefore retain the same identity for
 * a non-dispatching reconciliation request.
 */
export function settleSendIntent(intent: SendIntent, outcome: CoreCommandOutcome | undefined): SendIntent | null {
  if (outcome?.kind === "accepted") return null;
  const rejection = outcome?.rejection;
  if (rejection?.retryMode === "NEW_REQUEST"
    && rejection.reservation === null
    && rejection.deliveryState === "FAILED"
    && rejection.nativeDispatchState === "NOT_STARTED") return null;
  if (rejection?.retryMode === "SAME_REQUEST") {
    return { ...intent, state: "same-request", ...(rejection.reservation ? { reservation: rejection.reservation } : {}) };
  }
  return {
    ...intent,
    state: "reconcile",
    ...(rejection?.reservation ? { reservation: rejection.reservation } : {})
  };
}

export function retryLabel(intent: SendIntent | undefined): string | undefined {
  if (intent?.state === "same-request") return "Retry";
  if (intent?.state === "reconcile") return "Check result";
  return undefined;
}
