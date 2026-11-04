import { GRANT_BUTTON_LABEL } from "./AuthorizationPanel";

/**
 * The one plain sentence beside a disabled Send. Each input is its own fact
 * (the app keeps them apart on purpose); this only ranks them, most blocking
 * first, and never decides whether Send is disabled.
 */
export interface SendDisabledInputs {
  /** A send is starting; the button label already says so. */
  inFlight: boolean;
  connected: boolean;
  /** An existing sentence for a folder, profile, reconnect or held-Stop block. */
  holdSentence: string | null;
  /** An existing sentence while agent access is loading or failed. */
  waitingOn: string | null;
  /** The one-time grant is missing. */
  grantMissing: boolean;
  /** The grant button is on screen to point at. */
  grantControlVisible: boolean;
  wayToWorkMissing: boolean;
  workspaceMissing: boolean;
  messageMissing: boolean;
  /** Disabled for a reason that has no sentence of its own. */
  otherBlocked: boolean;
}

export const RECONNECT_SENTENCE = "Reconnect before sending.";
export const GRANT_SENTENCE = `Press “${GRANT_BUTTON_LABEL}” above to send.`;
export const GRANT_HIDDEN_SENTENCE = "Agent turns are not allowed on this profile yet.";
export const CHOOSE_WAY_SENTENCE = "Choose how to work before sending.";
export const CHOOSE_FOLDER_SENTENCE = "Choose a project folder.";
export const WRITE_GOAL_SENTENCE = "Write your goal.";
export const WAIT_SENTENCE = "Wait for this to finish.";

export function sendDisabledReason(input: SendDisabledInputs): string | null {
  if (input.inFlight) return null;
  if (!input.connected) return RECONNECT_SENTENCE;
  if (input.holdSentence) return input.holdSentence;
  if (input.waitingOn) return input.waitingOn;
  if (input.grantMissing) return input.grantControlVisible ? GRANT_SENTENCE : GRANT_HIDDEN_SENTENCE;
  if (input.wayToWorkMissing) return CHOOSE_WAY_SENTENCE;
  if (input.workspaceMissing) return CHOOSE_FOLDER_SENTENCE;
  if (input.messageMissing) return WRITE_GOAL_SENTENCE;
  return input.otherBlocked ? WAIT_SENTENCE : null;
}
