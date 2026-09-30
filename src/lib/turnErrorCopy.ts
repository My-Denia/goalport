import type { ProductTurn } from "../types";

const COPY: Record<string, string> = {
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
  "permission-pending": "Answer the permission request above to continue.",
  "recovery-required": "This session needs recovery before another message can be sent.",
  "turn-starting": "The Runtime is starting. Wait for it to confirm this turn.",
  "stop-pending": "The Runtime is stopping. Wait for its response before sending.",
  "authorization-revoked": "Authorization was revoked. Review the next permission request before continuing."
};

export function turnErrorCopy(turn: ProductTurn): string | undefined {
  return turn.reasonCode ? COPY[turn.reasonCode] ?? turn.reason : turn.reason;
}
