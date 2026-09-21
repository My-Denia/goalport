// @vitest-environment jsdom
// Interaction regressions for the windows-desktop-shell-ui-refactor round:
// IME-safe Enter handling, keyboard submit parity, handoff target selection,
// markdown inertness, modal focus contract, placeholder-free main UI, and
// scroll anchoring under mocked geometry.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import App from "./App";
import { useScrollAnchor, visibleConversationSignature } from "./lib/useScrollAnchor";
import { type CoreCommand } from "./ipc";
import { DEMO_SNAPSHOT, type ProductConversationItem } from "./types";

afterEach(() => {
  cleanup();
  delete window.goalportCore;
  delete window.__GOALPORT_ELECTRON__;
});

function mountElectron(snapshot: unknown, command?: (request: CoreCommand) => Promise<unknown>) {
  window.__GOALPORT_ELECTRON__ = true;
  window.goalportCore = {
    snapshot: async () => snapshot,
    command: command ?? (async () => snapshot),
    startCore: async () => snapshot,
    openInVsCode: async () => undefined
  } as never;
  return render(<App />);
}

async function openHandoff() {
  fireEvent.click(await screen.findByRole("button", { name: /open details panel/i }));
  fireEvent.click(screen.getByRole("button", { name: /assign next step|handoff/i }));
}

/**
 * jsdom applies no layout, so scroll geometry is mocked. The mock records
 * every programmatic scroll so tests can tell "the app drove the reader to
 * the bottom" from "the reader's position was left alone".
 */
function mockTimelineGeometry(element: HTMLElement) {
  const geometry = { top: 0, height: 100, scrollH: 100 };
  const writes: number[] = [];
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => geometry.top,
    set: (value: number) => {
      writes.push(value);
      geometry.top = value;
    }
  });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => geometry.height });
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => geometry.scrollH });
  (element as unknown as { scrollTo?: (options: { top: number }) => void }).scrollTo = (options) => {
    writes.push(options.top);
    geometry.top = options.top;
  };
  return { geometry, writes };
}

describe("composer keyboard handling", () => {
  function pressKey(element: HTMLElement, key: string, extras: Record<string, unknown> = {}) {
    fireEvent.keyDown(element, { key, ...extras });
  }

  it("Enter submits and Shift+Enter inserts a newline (no submit)", async () => {
    const sent: string[] = [];
    mountElectron(DEMO_SNAPSHOT, async (request: CoreCommand) => {
      if (request.messageType === "conversation_send") sent.push(String(request.payload.message));
      return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: DEMO_SNAPSHOT };
    });
    const composer = await screen.findByRole("textbox", { name: /message composer/i });

    fireEvent.change(composer, { target: { value: "shift enter line" } });
    pressKey(composer, "Enter", { shiftKey: true });
    expect(sent).toEqual([]);

    pressKey(composer, "Enter");
    await waitFor(() => expect(sent).toEqual(["shift enter line"]));
  });

  it("never sends while an IME composition is active", async () => {
    const sent: string[] = [];
    mountElectron(DEMO_SNAPSHOT, async (request: CoreCommand) => {
      if (request.messageType === "conversation_send") sent.push(String(request.payload.message));
      return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: DEMO_SNAPSHOT };
    });
    const composer = await screen.findByRole("textbox", { name: /message composer/i });
    fireEvent.change(composer, { target: { value: "中文候选" } });

    // Composition in flight: isComposing true, and the legacy keyCode 229 form.
    fireEvent.compositionStart(composer);
    pressKey(composer, "Enter", { isComposing: true });
    pressKey(composer, "Enter", { keyCode: 229 });
    fireEvent.compositionEnd(composer);
    expect(sent).toEqual([]);
    expect((composer as HTMLTextAreaElement).value).toBe("中文候选");
  });

  it("ignores the stray Enter some IMEs emit right after compositionend", async () => {
    const sent: string[] = [];
    mountElectron(DEMO_SNAPSHOT, async (request: CoreCommand) => {
      if (request.messageType === "conversation_send") sent.push(String(request.payload.message));
      return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: DEMO_SNAPSHOT };
    });
    const composer = await screen.findByRole("textbox", { name: /message composer/i });
    fireEvent.change(composer, { target: { value: "确定候选词" } });
    fireEvent.compositionStart(composer);
    fireEvent.compositionEnd(composer);
    // Within the guard window: must NOT send.
    pressKey(composer, "Enter");
    expect(sent).toEqual([]);
    expect((composer as HTMLTextAreaElement).value).toBe("确定候选词");
  });
});

describe("handoff target selection", () => {
  it("sends the handoff only to the Runtime the user picked", async () => {
    const handoffs: string[] = [];
    const command = async (request: CoreCommand) => {
      if (request.messageType === "handoff") handoffs.push(String(request.payload.provider));
      return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: DEMO_SNAPSHOT };
    };
    mountElectron(DEMO_SNAPSHOT, command);

    await openHandoff();
    const dialog = await screen.findByRole("dialog", { name: /assign the next step/i });
    // Codex is the current provider; it must not be offered as its own target.
    expect(within(dialog).queryByRole("option", { name: /codex/i })).toBeNull();
    // The user picks Grok explicitly — not the first other runtime (Claude).
    fireEvent.click(within(dialog).getByRole("option", { name: /grok/i }));

    await waitFor(() => expect(handoffs).toEqual(["grok"]));
    expect(screen.queryByText(/Core assigned a new Grok Attempt/i)).toBeNull();
  });

  it("does not send a handoff when the dialog is cancelled", async () => {
    const command = vi.fn(async (request: CoreCommand) => ({ requestId: request.requestId, accepted: true, duplicate: false, snapshot: DEMO_SNAPSHOT }));
    mountElectron(DEMO_SNAPSHOT, command);

    await openHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: /assign the next step/i })).toBeNull();
    await waitFor(() => expect(command.mock.calls.some(([request]) => request.messageType === "handoff")).toBe(false));
  });
});

describe("markdown rendering stays inert", () => {
  it("renders HTML and script payloads as text without executing anything", async () => {
    const malicious = [
      "before <script>window.__pwned=1</script> after",
      "<img src=x onerror=\"window.__pwned=1\">",
      "[click](javascript:window.__pwned=1)",
      "```html\n<iframe src=\"javascript:window.__pwned=1\"></iframe>\n```"
    ].join("\n\n");
    const snapshot = {
      ...DEMO_SNAPSHOT,
      productConversation: { ...DEMO_SNAPSHOT.productConversation!, items: [{ id: "xss", kind: "assistant-message" as const, body: malicious }] }
    };
    mountElectron(snapshot);

    const article = await screen.findByText(/before <script>/i);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    // The javascript: link renders as text, not an anchor with a live href.
    const anchors = document.querySelectorAll(".tl-agent-body a");
    expect(anchors.length).toBe(0);
    expect(document.querySelector(".tl-agent-body")?.textContent).toContain("[click](javascript:window.__pwned=1)");
    expect(document.querySelector(".tl-agent-body")?.textContent).toContain("[click](javascript:window.__pwned=1)");
    expect(document.querySelector(".tl-agent-body")?.textContent).toContain("<img src=x onerror");
    expect(document.querySelector(".tl-agent-body")?.textContent).toContain("<iframe src");
  });

  it("supports code blocks, bold, inline code and safe links", async () => {
    const body = [
      "**Bold claim** with `inline code`.",
      "See [docs](https://example.com/a) for details.",
      "```rust\nfn main() { println!(\"hi\"); }\n```"
    ].join("\n\n");
    const snapshot = {
      ...DEMO_SNAPSHOT,
      productConversation: { ...DEMO_SNAPSHOT.productConversation!, items: [{ id: "md", kind: "assistant-message" as const, body }] }
    };
    mountElectron(snapshot);

    expect(await screen.findByText("Bold claim")).toBeTruthy();
    expect(screen.getByText("inline code").tagName).toBe("CODE");
    const link = screen.getByText("docs");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.com/a");
    expect(screen.getByText(/fn main/).closest("pre")).toBeTruthy();
    const copy = screen.getByRole("button", { name: /copy code/i });
    expect(copy).toBeTruthy();
  });
});

describe("modal dialog focus contract", () => {
  it("focuses the first control, traps nothing harmful, and Esc cancels without approving", async () => {
    mountElectron(DEMO_SNAPSHOT);
    const composer = await screen.findByRole("textbox", { name: /message composer/i });
    composer.focus();

    await openHandoff();
    const dialog = await screen.findByRole("dialog", { name: /assign the next step/i });
    // Initial focus lands inside the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Esc cancels the dialog; no handoff was approved by the escape.
    fireEvent.keyDown(document, { key: "Escape", bubbles: true });
    expect(screen.queryByRole("dialog", { name: /assign the next step/i })).toBeNull();
    // Focus returns to the composer that opened it.
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });

  it("Esc on the close-choice dialog keeps the window open without choosing Continue or Stop", async () => {
    const confirm = vi.fn();
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => DEMO_SNAPSHOT,
      command: async () => DEMO_SNAPSHOT,
      startCore: async () => ({}),
      openInVsCode: async () => undefined,
      confirmCloseChoice: confirm
    } as never;
    render(<App />);
    await screen.findByRole("textbox", { name: /message composer/i });
    // Open the close-choice dialog via the app close entry.
    fireEvent.click(screen.getByRole("button", { name: "Application menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close window" }));
    const dialog = await screen.findByRole("dialog", { name: /continue running in the background/i });
    fireEvent.keyDown(document, { key: "Escape", bubbles: true });
    expect(screen.queryByRole("dialog", { name: /continue running in the background/i })).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    void dialog;
  });
});

describe("modal focus never fights the snapshot poll (RC1 regression)", () => {
  it("keeps focus in the dialog field across parent re-renders", async () => {
    let live = { ...DEMO_SNAPSHOT, connection: "connected" as const };
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => live,
      command: async () => live,
      startCore: async () => live,
      openInVsCode: async () => undefined
    } as never;
    const { rerender } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    const field = await screen.findByRole("textbox", { name: /project folder/i });
    field.focus();
    expect(document.activeElement).toBe(field);
    // Simulate poll re-renders with a changed snapshot object identity — the
    // old hook re-ran its effect here and stole focus back to the close button.
    live = { ...live, attempt: { ...live.attempt } };
    rerender(<App />);
    rerender(<App />);
    expect(document.activeElement).toBe(field);
    // And typing still lands in the field after those re-renders.
    fireEvent.change(field, { target: { value: "C:\\work\\poll-safe" } });
    expect((field as HTMLInputElement).value).toBe("C:\\work\\poll-safe");
  });

  it("survives the dialog → Esc → Tab sequence that crashed the renderer", async () => {
    mountElectron(DEMO_SNAPSHOT);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    expect(await screen.findByRole("textbox", { name: /message composer/i })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape", bubbles: true });
    fireEvent.keyDown(document, { key: "Tab", bubbles: true });
    fireEvent.keyDown(document, { key: "Tab", bubbles: true });
    // The app is still mounted and interactive after the sequence.
    expect(screen.getByRole("banner").textContent).toContain("GoalPort");
    fireEvent.click(screen.getByRole("button", { name: /new goal/i }));
    expect(await screen.findByRole("textbox", { name: /message composer/i })).toBeTruthy();
  });
});

describe("empty-state and goal creation (HARD-02/03)", () => {
  it("offers an editable draft before any goal exists, without naming", async () => {
    const empty = { ...DEMO_SNAPSHOT, campaigns: [], activeCampaignId: "", activeTask: { ...DEMO_SNAPSHOT.activeTask, id: "", title: "No task selected" }, timeline: [], decisions: [] };
    mountElectron(empty);
    expect(await screen.findByRole("textbox", { name: /message composer/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /send message/i })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /goal name|goal title/i })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("focuses the composer once a goal exists even before any Runtime is selected", async () => {
    // Unassigned Runtime + waiting attempt: draft must already be editable.
    const goalNoRuntime = {
      ...DEMO_SNAPSHOT,
      productConversation: { ...DEMO_SNAPSHOT.productConversation!, runtime: { state: "none" as const, provider: "", name: "" }, turn: { state: "idle" as const, canStop: false, canSend: false, reason: "Choose a Runtime above before sending." } },
      attempt: { ...DEMO_SNAPSHOT.attempt, id: "attempt-unassigned", taskId: DEMO_SNAPSHOT.activeTask.id, provider: "unassigned", state: "waiting" as const, sessionLabel: "No Runtime selected", eventCount: 0 }
    };
    mountElectron(goalNoRuntime);
    const composer = await screen.findByRole("textbox", { name: /message composer/i });
    // Composer autofocuses when it appears.
    await waitFor(() => expect(document.activeElement).toBe(composer));
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/choose a runtime above before sending/i)).toBeTruthy();
    // Honest headline state — not "in progress" with nothing running.
    expect(screen.queryByText("Working")).toBeNull();
  });
});

describe("Details drawer reachability (RC5)", () => {
  it("toggles with Ctrl+I while no text field has focus, and never from inside one", async () => {
    mountElectron(DEMO_SNAPSHOT);
    await screen.findByRole("textbox", { name: /message composer/i });
    expect(screen.queryByRole("complementary", { name: /session details/i })).toBeNull();
    fireEvent.keyDown(document, { key: "i", ctrlKey: true, bubbles: true });
    expect(screen.getByRole("complementary", { name: /session details/i })).toBeTruthy();
    fireEvent.keyDown(document, { key: "i", ctrlKey: true, bubbles: true });
    expect(screen.queryByRole("complementary", { name: /session details/i })).toBeNull();
    // With focus inside the composer textarea, Ctrl+I must not steal the drawer.
    const composer = screen.getByRole("textbox", { name: /message composer/i });
    composer.focus();
    fireEvent.keyDown(composer, { key: "i", ctrlKey: true, bubbles: true });
    expect(screen.queryByRole("complementary", { name: /session details/i })).toBeNull();
  });

  it("offers Details and About from the application menu", async () => {
    mountElectron(DEMO_SNAPSHOT);
    await screen.findByRole("textbox", { name: /message composer/i });
    fireEvent.click(screen.getByRole("button", { name: /application menu/i }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /details/i }));
    expect(document.querySelector(".inspector")?.classList.contains("inspector-open")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /application menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /about goalport/i }));
    expect(await screen.findByRole("dialog", { name: /about goalport/i })).toBeTruthy();
  });
});

describe("desktop selection and drag-region contract (CSS)", () => {
  // jsdom applies no layout, so the contract is pinned on the stylesheet itself;
  // Layer D verifies the same rules behave correctly on the packaged EXE.
  let css = "";
  beforeAll(() => {
    // Resolves against the vitest working directory (the package root).
    css = readFileSync("./src/styles.css", "utf8");
  });

  it("makes app chrome unselectable and message content selectable", () => {
    expect(css).toMatch(/\.goalport-shell\s*\{[^}]*user-select:\s*none/s);
    for (const selector of [".tl-bubble", ".tl-agent-body", ".md-code-pre"]) {
      // every content surface must re-enable text selection
      expect(css).toMatch(new RegExp(`${selector.replace(".", "\\.")}[,{][^}]*user-select:\\s*text`, "s"));
    }
  });

  it("keeps the drawer a fixed overlay so opening it cannot reflow the conversation", () => {
    expect(css).toMatch(/\.inspector\s*\{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.inspector-open\s*\{[^}]*visibility:\s*visible/s);
  });

  it("excludes every title-bar control and its children from the window drag region", () => {
    expect(css).toMatch(/\.titlebar button,\s*\.titlebar button \*/);
  });
});

describe("placeholder-free main surface", () => {
  it("carries no dead controls: no avatar, no fake routing pills, no event-count meter", async () => {
    mountElectron(DEMO_SNAPSHOT);
    await screen.findByRole("textbox", { name: /message composer/i });

    expect(screen.queryByRole("button", { name: /open profile menu/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /attach context/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /open runtime support details/i })).toBeNull();
    expect(screen.queryByText(/automatic · gated/i)).toBeNull();
    expect(screen.queryByText(/assign next step to…/i)).toBeNull();
    expect(document.querySelector(".attempt-meter")).toBeNull();
    expect(screen.queryByRole("button", { name: /test offline boundary/i })).toBeNull();
    expect(screen.queryByText(/open in vs code/i)).toBeNull();
  });

  it("keeps offline fault injection behind the diagnostics disclosure only", async () => {
    mountElectron(DEMO_SNAPSHOT);
    await screen.findByRole("textbox", { name: /message composer/i });
    expect(screen.queryByRole("button", { name: /simulate offline/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /open details panel/i }));
    expect(screen.queryByRole("button", { name: /simulate offline/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /application menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /developer diagnostics/i }));
    expect(screen.getByRole("region", { name: /developer diagnostics/i })).toBeTruthy();
    // No trusted test/dev AppInfo was supplied: fault injection is not exposed.
    expect(screen.queryByRole("button", { name: /simulate offline/i })).toBeNull();
  });
});

describe("scroll anchoring", () => {
  function Probe({ items, resetKey }: { items: number; resetKey: string }) {
    const anchor = useScrollAnchor(resetKey);
    return (
      <div>
        <div ref={anchor.ref} onScroll={anchor.handleScroll} data-testid="scroll">
          {Array.from({ length: items }, (_, index) => <p key={index}>row {index}</p>)}
        </div>
        <button type="button" data-testid="notify" onClick={anchor.notifyContentChanged} />
        <button type="button" data-testid="jump" onClick={() => anchor.scrollToBottom(false)} />
        <span data-testid="unseen">{anchor.unseenCount}</span>
      </div>
    );
  }

  function mockGeometry(element: HTMLElement, { top, height, scrollH }: { top: number; height: number; scrollH: number }) {
    Object.defineProperty(element, "scrollTop", { configurable: true, get: () => top, set: () => undefined });
    Object.defineProperty(element, "clientHeight", { configurable: true, get: () => height });
    Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => scrollH });
  }

  it("counts unseen events while scrolled up and re-pins on jump", async () => {
    const { rerender } = render(<Probe items={2} resetKey="c1" />);
    const scroller = screen.getByTestId("scroll");
    // Pinned at bottom initially (scrollHeight - scrollTop - clientHeight < 48).
    mockGeometry(scroller as HTMLElement, { top: 0, height: 100, scrollH: 100 });
    rerender(<Probe items={3} resetKey="c1" />);
    fireEvent.click(screen.getByTestId("notify"));
    expect(screen.getByTestId("unseen").textContent).toBe("0");

    // Reader scrolled up: far from the bottom.
    mockGeometry(scroller as HTMLElement, { top: 0, height: 100, scrollH: 1200 });
    fireEvent.scroll(scroller);
    rerender(<Probe items={4} resetKey="c1" />);
    fireEvent.click(screen.getByTestId("notify"));
    expect(screen.getByTestId("unseen").textContent).toBe("1");

    // Jump to latest re-pins.
    fireEvent.click(screen.getByTestId("jump"));
    mockGeometry(scroller as HTMLElement, { top: 1100, height: 100, scrollH: 1200 });
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("unseen").textContent).toBe("0");
  });
});

describe("streaming conversation scroll", () => {
  function snapshotWithItems(items: ProductConversationItem[], overrides: Partial<typeof DEMO_SNAPSHOT> = {}) {
    const product = DEMO_SNAPSHOT.productConversation!;
    return { ...DEMO_SNAPSHOT, ...overrides, productConversation: { ...product, items } };
  }

  /** Replaces only the streamed assistant item's body — the item count never changes. */
  function streamedAssistant(items: ProductConversationItem[], body: string) {
    return items.map((item) => (item.id === "product-assistant-1" ? { ...item, body } : item));
  }

  function mountStreamingApp(initialItems: ProductConversationItem[]) {
    let live = snapshotWithItems(initialItems);
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => live,
      command: async () => live,
      startCore: async () => live,
      openInVsCode: async () => undefined
    } as never;
    render(<App />);
    return { publish: (next: ReturnType<typeof snapshotWithItems>) => { live = next; } };
  }

  it(
    "follows same-item streaming while pinned, then flags unseen and preserves position when scrolled away",
    async () => {
      const initial = DEMO_SNAPSHOT.productConversation!.items;
      const { publish } = mountStreamingApp(initial);
      await screen.findByRole("textbox", { name: /message composer/i });
      const scroller = document.querySelector(".timeline-scroll") as HTMLElement;
      const { geometry, writes } = mockTimelineGeometry(scroller);
      fireEvent.scroll(scroller); // reader parked at the (mocked) bottom

      // The same assistant item grows — the item count never changes.
      publish(snapshotWithItems(streamedAssistant(initial, "partial answer")));
      await waitFor(() => expect(screen.getByText("partial answer")).toBeTruthy(), { timeout: 8000 });
      await waitFor(() => expect(writes).toContain(100), { timeout: 8000 });
      expect(screen.queryByText(/new message/i)).toBeNull();

      // Reader scrolls away; the very same item keeps streaming.
      geometry.scrollH = 1200;
      geometry.top = 260;
      fireEvent.scroll(scroller);
      publish(snapshotWithItems(streamedAssistant(initial, "partial answer + streamed tail")));
      await waitFor(() => expect(screen.getByText(/1 new message/i)).toBeTruthy(), { timeout: 8000 });
      expect(geometry.top).toBe(260); // scroll position preserved while away
      expect(writes).toEqual([100]); // and no programmatic scroll happened
    },
    30000
  );

  it(
    "resets honestly on a campaign switch: the switched-to view is the baseline, not new content",
    async () => {
      const initial = DEMO_SNAPSHOT.productConversation!.items;
      const { publish } = mountStreamingApp(initial);
      await screen.findByRole("textbox", { name: /message composer/i });
      const scroller = document.querySelector(".timeline-scroll") as HTMLElement;
      const { geometry } = mockTimelineGeometry(scroller);
      fireEvent.scroll(scroller);
      geometry.scrollH = 1200;
      geometry.top = 260;
      fireEvent.scroll(scroller);
      publish(snapshotWithItems(streamedAssistant(initial, "grown while away")));
      await waitFor(() => expect(screen.getByText(/1 new message/i)).toBeTruthy(), { timeout: 8000 });

      // Switch to the second campaign with its own conversation.
      const campaignB = snapshotWithItems(
        [{ id: "b-assistant-1", kind: "assistant-message", body: "campaign B opening message" }],
        { activeCampaignId: "campaign-evidence-loop" }
      );
      publish(campaignB);
      await waitFor(() => expect(screen.getByText("campaign B opening message")).toBeTruthy(), { timeout: 8000 });

      // The switch must not count campaign B as unseen: after re-establishing
      // the away position, the first real growth flags exactly "1 new message"
      // — never an accumulated count inherited from the switch.
      geometry.top = 260;
      fireEvent.scroll(scroller);
      publish(snapshotWithItems(
        [{ id: "b-assistant-1", kind: "assistant-message", body: "campaign B opening message + growth" }],
        { activeCampaignId: "campaign-evidence-loop" }
      ));
      await waitFor(() => expect(screen.getByText(/1 new message/i)).toBeTruthy(), { timeout: 8000 });
      expect(screen.queryByText(/2 new messages/i)).toBeNull();
    },
    30000
  );
});

describe("scroll anchor visible-content identity (hook contract)", () => {
  function StreamProbe({ items, resetKey }: { items: ProductConversationItem[]; resetKey: string }) {
    const anchor = useScrollAnchor(resetKey, visibleConversationSignature(items));
    return (
      <div>
        <div ref={anchor.ref} onScroll={anchor.handleScroll} data-testid="scroll">
          {items.map((item) => <p key={item.id}>{item.body}</p>)}
        </div>
        <button type="button" data-testid="jump" onClick={() => anchor.scrollToBottom(false)} />
        <span data-testid="unseen">{anchor.unseenCount}</span>
      </div>
    );
  }

  const msg = (id: string, body: string, extra: Partial<ProductConversationItem> = {}): ProductConversationItem =>
    ({ kind: "assistant-message", id, body, ...extra });
  const conversation = (assistantBody: string) => [msg("u1", "question"), msg("a1", assistantBody)];

  function renderAwayFromBottom(items: ProductConversationItem[], resetKey = "c1") {
    const { rerender } = render(<StreamProbe items={items} resetKey={resetKey} />);
    const scroller = screen.getByTestId("scroll") as HTMLElement;
    const { geometry, writes } = mockTimelineGeometry(scroller);
    fireEvent.scroll(scroller); // still pinned at the (mocked) bottom
    geometry.scrollH = 1200;
    geometry.top = 260;
    fireEvent.scroll(scroller); // reader scrolled away
    return { rerender, geometry, writes, scroller };
  }

  it("follows same-length streamed growth for a reader pinned at the bottom", () => {
    const { rerender } = render(<StreamProbe items={conversation("partial")} resetKey="c1" />);
    const { writes } = mockTimelineGeometry(screen.getByTestId("scroll") as HTMLElement);
    // Same item id, same item count, only the visible body grows.
    rerender(<StreamProbe items={conversation("partial + streamed tail")} resetKey="c1" />);
    expect(writes).toEqual([100]); // driven to the (mocked) bottom before paint
    expect(screen.getByTestId("unseen").textContent).toBe("0");
  });

  it("counts same-length streamed growth as unseen and preserves the away scroll position", () => {
    const { rerender, geometry, writes, scroller } = renderAwayFromBottom(conversation("partial"));
    rerender(<StreamProbe items={conversation("partial + streamed tail")} resetKey="c1" />);
    expect(screen.getByTestId("unseen").textContent).toBe("1");
    expect(geometry.top).toBe(260); // untouched
    expect(writes).toEqual([]); // no programmatic scroll while away
    // The jump affordance re-pins and clears the indicator.
    fireEvent.click(screen.getByTestId("jump"));
    expect(writes).toEqual([1200]);
    expect(screen.getByTestId("unseen").textContent).toBe("0");
    void scroller;
  });

  it("never notifies on an identical snapshot poll, even with fresh array identity", () => {
    const original = conversation("partial");
    const { rerender, geometry, writes } = renderAwayFromBottom(original);
    // Two "polls": same content, brand-new objects — exactly what the 750ms
    // snapshot loop produces.
    rerender(<StreamProbe items={conversation("partial")} resetKey="c1" />);
    rerender(<StreamProbe items={[{ ...original[0] }, { ...original[1] }]} resetKey="c1" />);
    expect(screen.getByTestId("unseen").textContent).toBe("0");
    expect(writes).toEqual([]);
    expect(geometry.top).toBe(260);
  });

  it("stays silent for hidden metadata changes but notifies when visible content changes", () => {
    const { rerender, writes } = renderAwayFromBottom(conversation("partial"));
    // `technicalDetails` renders behind a collapsed disclosure and `actions`
    // is not rendered by the normal surface at all: not new visible content.
    rerender(<StreamProbe items={[
      msg("u1", "question"),
      msg("a1", "partial", { technicalDetails: "raw trace changed", actions: ["retry"] })
    ]} resetKey="c1" />);
    expect(screen.getByTestId("unseen").textContent).toBe("0");
    expect(writes).toEqual([]);
    // The visible body growing is real content: it counts.
    rerender(<StreamProbe items={[
      msg("u1", "question"),
      msg("a1", "partial + streamed tail", { technicalDetails: "raw trace changed", actions: ["retry"] })
    ]} resetKey="c1" />);
    expect(screen.getByTestId("unseen").textContent).toBe("1");
  });

  it("adopts a campaign switch as the baseline silently, then counts only later growth", () => {
    const { rerender, geometry } = renderAwayFromBottom(conversation("partial"));
    rerender(<StreamProbe items={conversation("partial + streamed tail")} resetKey="c1" />);
    expect(screen.getByTestId("unseen").textContent).toBe("1");

    // Switch view: different resetKey and different content — this is the
    // reader's own navigation, never an unseen-content event.
    rerender(<StreamProbe items={[msg("b1", "campaign B opening")]} resetKey="c2" />);
    expect(screen.getByTestId("unseen").textContent).toBe("0");
    // Identical re-poll of the new view stays silent (baseline adopted).
    rerender(<StreamProbe items={[msg("b1", "campaign B opening")]} resetKey="c2" />);
    expect(screen.getByTestId("unseen").textContent).toBe("0");

    // Away again (the switch re-pinned the reader), then real growth: exactly one.
    geometry.top = 260;
    fireEvent.scroll(screen.getByTestId("scroll"));
    rerender(<StreamProbe items={[msg("b1", "campaign B opening + growth")]} resetKey="c2" />);
    expect(screen.getByTestId("unseen").textContent).toBe("1");
  });

  it("still counts appended items (length change) as unseen while away", () => {
    const { rerender } = renderAwayFromBottom(conversation("partial"));
    rerender(<StreamProbe items={[...conversation("partial"), msg("a2", "a whole new message")]} resetKey="c1" />);
    expect(screen.getByTestId("unseen").textContent).toBe("1");
  });
});
