import { PROVIDER_FAILURE_CODES, type ProductTurn, type ProviderFailureCode, type TurnStateReasonCode } from "../types";

const PROVIDER_COPY: Record<ProviderFailureCode, string> = {
  "provider-quota": "This Runtime has reached its usage limit. Your draft stays here.",
  "provider-auth-required": "Sign in to this Runtime before sending another message.",
  "provider-not-installed": "This Runtime is not installed. Choose another Runtime or install it.",
  "provider-version": "This Runtime needs an update before it can continue.",
  "provider-request-invalid": "The Runtime rejected this request. Open details to see what needs changing.",
  "provider-startup": "This Runtime could not start. Choose another Runtime or open details.",
  "provider-context-full": "This conversation is too long for the Runtime. Start a new goal or choose another Runtime.",
  "provider-overloaded": "This Runtime is busy right now. Your draft stays here; try again later.",
  "provider-transport": "The Runtime connection was lost. Reconnect before sending.",
  "provider-permission": "The Runtime could not continue because permission was denied.",
  "provider-failed": "The Runtime could not finish this turn. Open details for the reported reason.",
  "delivery-unknown": "The last message may have been delivered. Check its status before sending again.",
  "resume-spawn-failed": "The last resume failed to start or did not verify the stored session id. Resume to try again; earlier messages will not be sent again.",
  "resume-verification-failed": "The last resume failed to start or did not verify the stored session id. Resume to try again; earlier messages will not be sent again.",
  "provider-exited": "The Runtime process ended. Close this session before starting new work; its history remains here."
};

type TurnCopyCode = Extract<TurnStateReasonCode, "permission-pending" | "recovery-required" | "turn-starting" | "stop-pending" | "authorization-revoked">;

const TURN_COPY: Record<TurnCopyCode, string> = {
  "permission-pending": "Answer the permission request above to continue.",
  "recovery-required": "This session needs recovery before another message can be sent.",
  "turn-starting": "The Runtime is starting. Wait for it to confirm this turn.",
  "stop-pending": "The Runtime is stopping. Wait for its response before sending.",
  "authorization-revoked": "Authorization was revoked. Review the next permission request before continuing."
};

function isProviderFailureCode(code: string): code is ProviderFailureCode {
  return (PROVIDER_FAILURE_CODES as readonly string[]).includes(code);
}

function isTurnCopyCode(code: string): code is TurnCopyCode {
  return Object.prototype.hasOwnProperty.call(TURN_COPY, code);
}

export function turnErrorCopy(turn: ProductTurn): string | undefined {
  const code = turn.reasonCode;
  if (!code) return turn.reason;
  if (isProviderFailureCode(code)) return PROVIDER_COPY[code] ?? turn.reason;
  if (isTurnCopyCode(code)) return TURN_COPY[code] ?? turn.reason;
  return turn.reason;
}
