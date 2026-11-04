import { describe, expect, it } from "vitest";
import {
  sendDisabledReason, type SendDisabledInputs, RECONNECT_SENTENCE, GRANT_SENTENCE, GRANT_HIDDEN_SENTENCE,
  CHOOSE_WAY_SENTENCE, CHOOSE_FOLDER_SENTENCE, WRITE_GOAL_SENTENCE, WAIT_SENTENCE,
} from "./sendDisabledReason";

const clear: SendDisabledInputs = {
  inFlight: false, connected: true, holdSentence: null, waitingOn: null, grantMissing: false, grantControlVisible: true,
  wayToWorkMissing: false, workspaceMissing: false, messageMissing: false, otherBlocked: false,
};
const everything: SendDisabledInputs = {
  ...clear, connected: false, holdSentence: "held", waitingOn: "loading", grantMissing: true,
  wayToWorkMissing: true, workspaceMissing: true, messageMissing: true, otherBlocked: true,
};

describe("sendDisabledReason", () => {
  it("says nothing when nothing is missing", () => expect(sendDisabledReason(clear)).toBeNull());
  it("stays quiet while a send is starting, whatever else is missing", () => {
    expect(sendDisabledReason({ ...everything, inFlight: true })).toBeNull();
  });
  it("names the highest-priority cause, then the next one as each is fixed", () => {
    const cascade: Array<[keyof SendDisabledInputs, string]> = [
      ["connected", RECONNECT_SENTENCE], ["holdSentence", "held"], ["waitingOn", "loading"], ["grantMissing", GRANT_SENTENCE],
      ["wayToWorkMissing", CHOOSE_WAY_SENTENCE], ["workspaceMissing", CHOOSE_FOLDER_SENTENCE],
      ["messageMissing", WRITE_GOAL_SENTENCE], ["otherBlocked", WAIT_SENTENCE],
    ];
    let remaining = everything;
    for (const [key, expected] of cascade) {
      expect(sendDisabledReason(remaining)).toBe(expected);
      remaining = { ...remaining, [key]: clear[key] };
    }
    expect(sendDisabledReason(remaining)).toBeNull();
  });
  it("does not point at a grant button that is not on screen", () => {
    expect(sendDisabledReason({ ...clear, grantMissing: true, grantControlVisible: false })).toBe(GRANT_HIDDEN_SENTENCE);
  });
  it("points at the visible grant button by its exact label", () => {
    expect(GRANT_SENTENCE).toContain("Allow GoalPort to run agent turns on this profile");
  });
});
