// @vitest-environment jsdom
// Lifecycle separation (AGENTS.md §3 prerequisite 2): the new-goal draft
// surface must stay mounted — and keep the user's focus — across
// capacity-limited snapshot polls. Only a real transition (Core creating or
// moving to a conversation) replaces the draft.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { type CoreCommand } from "./ipc";
import { DEMO_SNAPSHOT, EMPTY_PREVIEW_SNAPSHOT, type CoreSnapshot } from "./types";

afterEach(() => {
  cleanup();
  delete window.goalportCore;
  delete window.__GOALPORT_ELECTRON__;
});

// The snapshot the next poll receives; a poll "flip" is simulated by
// mutating this between the app's 750ms refresh cycles.
let polled: CoreSnapshot;

function mountApp() {
  window.__GOALPORT_ELECTRON__ = true;
  window.goalportCore = {
    snapshot: async () => polled,
    command: async (request: CoreCommand) => polled,
    startCore: async () => polled,
    openInVsCode: async () => undefined
  } as never;
  return render(<App />);
}

function draftBox(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
}

describe("draft composer lifecycle across snapshot polls", () => {
  it("a capacity-limited poll never unmounts the draft or steals its focus", async () => {
    polled = EMPTY_PREVIEW_SNAPSHOT;
    mountApp();
    const draft = await waitFor(() => {
      expect(document.querySelector(".draft-composer")).not.toBeNull();
      return draftBox();
    });
    // The draft opens ready for typing.
    await waitFor(() => expect(document.activeElement).toBe(draft));

    // A capacity acknowledgement arrives: the full projection is missing,
    // but the empty-profile draft the user is sitting in is not a fresh
    // start and must not be yanked away.
    polled = {
      ...EMPTY_PREVIEW_SNAPSHOT,
      bounds: { truncated: true, projectionUnavailable: true, omittedCounts: { campaigns: 1 } }
    };
    await waitFor(() => expect(screen.getByText("Conversation controls are temporarily unavailable")).toBeTruthy(), { timeout: 4000 });
    expect(document.querySelector(".draft-composer")).not.toBeNull();
    expect(document.activeElement).toBe(draft);

    // The full projection returns; still the same element, still focused.
    polled = EMPTY_PREVIEW_SNAPSHOT;
    await waitFor(() => expect(screen.queryByText("Conversation controls are temporarily unavailable")).toBeNull(), { timeout: 4000 });
    expect(document.querySelector(".draft-composer")).not.toBeNull();
    expect(document.activeElement).toBe(draft);
  });

  it("a real transition still replaces the draft with the conversation", async () => {
    polled = EMPTY_PREVIEW_SNAPSHOT;
    mountApp();
    await waitFor(() => expect(document.querySelector(".draft-composer")).not.toBeNull());

    polled = DEMO_SNAPSHOT;
    await waitFor(() => expect(document.querySelector(".draft-composer")).toBeNull(), { timeout: 4000 });
    expect(await screen.findByRole("heading", { name: /build a durable preview/i })).toBeTruthy();
  });
});

// Windows-packaged smoke regression (caught by CI at 1913187): the empty-
// profile latch must key on the AUTHORITATIVE active id, not the campaigns
// list lookup — the list transiently lacks the just-created campaign while
// the id is already set, and latching on that flash re-mounted the draft
// composer over the fresh conversation for a frame.
