// @vitest-environment jsdom
// Windows draft: whenever Send is off and nothing is starting, the user can read why.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DraftGoalComposer, type SendBlockers } from "./DraftGoalComposer";

afterEach(cleanup);

const base = {
  runtimes: [], busy: false, error: null, canBrowse: true, onBrowse: () => {}, onChange: () => {}, onSubmit: () => {}, onDiscard: () => {},
};

function mount(over: { connected: boolean; waitingOn: string | null; blocked: boolean; blockers?: SendBlockers; workspace: string; message: string; available: boolean; retry?: string; sendBlockers?: false }) {
  render(
    <DraftGoalComposer
      {...base}
      draft={{ workspace: over.workspace, provider: "", message: over.message }}
      connected={over.connected} waitingOn={over.waitingOn} blockedFromSending={over.blocked} retryLabel={over.retry}
      coordinationAvailable={over.available} coordinationEntryAvailable
      sendBlockers={over.sendBlockers === false ? undefined : over.blockers}
    />,
  );
  return document.querySelector("button[type=submit]") as HTMLButtonElement;
}

describe("Send reason beside a disabled Send", () => {
  it("never leaves a disabled Send unexplained, and is quiet when Send is on", () => {
    const flags = [false, true];
    const holds = [null, "A background goal is still active."];
    let disabledCases = 0;
    for (const connected of flags) for (const waiting of [null, "Checking which agents can work on this goal…"])
      for (const blocked of flags) for (const hold of holds) for (const grantMissing of flags)
        for (const workspace of ["", "C:\\work"]) for (const message of ["", "plan it"]) for (const available of flags) for (const retry of [undefined, "Check result"]) {
          const send = mount({ connected, waitingOn: waiting, blocked, workspace, message, available, retry, blockers: { holdSentence: hold, grantMissing, grantControlVisible: true } });
          const reason = document.getElementById("send-disabled-reason");
          if (send.disabled) {
            disabledCases += 1;
            // The picker's own "Choose how to work before sending." is the other place a reason may live.
            const pickerSays = screen.queryByText("Choose how to work before sending.") !== null;
            expect(Boolean(reason) || pickerSays, JSON.stringify({ connected, waiting, blocked, hold, grantMissing, workspace, message, available, retry })).toBe(true);
            if (reason) expect(send.getAttribute("aria-describedby")).toBe("send-disabled-reason");
          } else {
            expect(reason).toBeNull();
          }
          cleanup();
        }
    expect(disabledCases).toBeGreaterThan(100);
  });

  it("is absent without sendBlockers, so Linux and native composers render as before", () => {
    const send = mount({ connected: false, waitingOn: "Checking…", blocked: true, workspace: "", message: "", available: false, sendBlockers: false });
    expect(send.disabled).toBe(true);
    expect(document.getElementById("send-disabled-reason")).toBeNull();
    expect(screen.getByText("Checking…").className).toBe("composer-wait");
  });

  it("says the loading sentence once, in the reason, not also as a waiting line", () => {
    mount({ connected: true, waitingOn: "Checking which agents can work on this goal…", blocked: false, workspace: "C:\\w", message: "x", available: true, blockers: { holdSentence: null, grantMissing: false, grantControlVisible: true } });
    expect(screen.getAllByText("Checking which agents can work on this goal…")).toHaveLength(1);
    expect(document.querySelector(".composer-wait")).toBeNull();
  });
});
