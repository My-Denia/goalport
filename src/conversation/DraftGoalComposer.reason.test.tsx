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
  // One test per state combination (512), so a failure names its case and no single test carries the whole matrix's render time.
  const flags = [false, true];
  const cases = [];
  for (const connected of flags) for (const waiting of [null, "Checking which agents can work on this goal…"])
    for (const blocked of flags) for (const hold of [null, "A background goal is still active."]) for (const grantMissing of flags)
      for (const workspace of ["", "C:\work"]) for (const message of ["", "plan it"]) for (const available of flags) for (const retry of [undefined, "Check result"])
        cases.push({ connected, waiting, blocked, hold, grantMissing, workspace, message, available, retry });

  it.each(cases.map((c) => [JSON.stringify(c), c] as const))("a disabled Send is explained, an enabled one is quiet: %s", (_name, c) => {
    const send = mount({ connected: c.connected, waitingOn: c.waiting, blocked: c.blocked, workspace: c.workspace, message: c.message, available: c.available, retry: c.retry, blockers: { holdSentence: c.hold, grantMissing: c.grantMissing, grantControlVisible: true } });
    const reason = document.getElementById("send-disabled-reason");
    if (send.disabled) {
      // The picker's own "Choose how to work before sending." is the other place a reason may live.
      const pickerSays = screen.queryByText("Choose how to work before sending.") !== null;
      expect(Boolean(reason) || pickerSays).toBe(true);
      if (reason) expect(send.getAttribute("aria-describedby")).toBe("send-disabled-reason");
    } else {
      expect(reason).toBeNull();
    }
  });

  it("keeps the hold sentence visible during a retry, where Send stays on", () => {
    const send = mount({ connected: true, waitingOn: null, blocked: true, workspace: "C:\w", message: "x", available: true, retry: "Retry", blockers: { holdSentence: "A background goal is still active.", grantMissing: false, grantControlVisible: true } });
    expect(send.disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe("A background goal is still active.");
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
