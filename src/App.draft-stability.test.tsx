// @vitest-environment jsdom
// Lifecycle separation (AGENTS.md §3 prerequisite 2): the new-goal draft
// surface must stay mounted — and keep the user's focus — across
// capacity-limited snapshot polls. Only a real transition (Core creating or
// moving to a conversation) replaces the draft.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { type CoreCommand } from "./ipc";
import { DEMO_SNAPSHOT, EMPTY_PREVIEW_SNAPSHOT, type CoreSnapshot } from "./types";

vi.mock("./lib/goalDefaults", () => ({ readGoalDefaults: () => ({ workspace: "", provider: "", known: true }), rememberGoalDefaults: () => {} }));

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
  it("a draft-open discovery resolving mid-typing does not overwrite the message", async () => {
    let resolveDiscover: ((value: unknown) => void) | null = null;
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => EMPTY_PREVIEW_SNAPSHOT,
      command: async () => EMPTY_PREVIEW_SNAPSHOT,
      startCore: async () => EMPTY_PREVIEW_SNAPSHOT,
      openInVsCode: async () => undefined,
      appInfo: async () => ({
        version: "test",
        channel: "test",
        testMode: false,
        dataPath: "profile",
        coordinationConfigured: true,
      }),
      // The draft-open discovery stays pending until the test resolves it,
      // mid-typing.
      coordinateDiscover: () => new Promise((resolve) => { resolveDiscover = resolve; }),
      coordinateLaunch: async () => ({ text: "", errorText: "" }),
      coordinationAuthorize: async () => ({ ok: true, generation: 1, remaining: 4 }),
      coordinationScope: async () => null,
      coordinationRevoke: async () => ({ ok: true }),
      coordinationUnblock: async () => ({ ok: true }),
    } as never;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    const draft = await waitFor(() => draftBox());
    fireEvent.change(draft, { target: { value: "typed while discovering" } });
    expect(draft.value).toBe("typed while discovering");
    // The draft-open discovery starts (a scope read, then discover) even
    // though the words were typed first; it must stay pending until resolved.
    await waitFor(() => expect(resolveDiscover).not.toBeNull());
    resolveDiscover!({
      connected: true,
      sendAuthorized: true,
      stopReason: null,
      providers: [
        {
          instanceId: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          availability: "available",
          status: "ready",
          auth: { status: "authenticated", type: "subscription" },
          models: [{ slug: "codex-model", name: "codex-model", isDefault: true }],
          usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
        },
        {
          instanceId: "claude",
          displayName: "Claude",
          enabled: true,
          installed: true,
          availability: "available",
          status: "ready",
          auth: { status: "authenticated", type: "subscription" },
          models: [{ slug: "claude-model", name: "claude-model", isDefault: true }],
          usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
        },
      ],
    });
    // The panel arrives from the late discovery; the draft and its text stay.
    await waitFor(() => expect(screen.getByText(/Codex and Claude will plan and check this goal./)).toBeTruthy());
    const composer = screen.getByRole("textbox", { name: "Message composer" }) as HTMLTextAreaElement;
    expect(composer.value).toBe("typed while discovering");
    expect(document.querySelector(".draft-composer")).not.toBeNull();
  });

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
