// @vitest-environment jsdom
// Interaction regressions for the windows-desktop-shell-ui-refactor round:
// IME-safe Enter handling, keyboard submit parity, handoff target selection,
// markdown inertness, modal focus contract, placeholder-free main UI, and
// scroll anchoring under mocked geometry.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import App, { coordinationGeneration } from "./App";
import { BackgroundCoordinationStatus, CoordinationStatus } from "./conversation/CoordinationStatus";
import { useScrollAnchor, visibleConversationSignature } from "./lib/useScrollAnchor";
import { type CoreCommand } from "./ipc";
import { DEMO_SNAPSHOT, EMPTY_PREVIEW_SNAPSHOT, type ProductConversationItem } from "./types";

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
      "[file](file:///private/data)",
      "[data](data:text/html,hello)",
      "[shell](shell:run)",
      "[custom](goalport:command)",
      "[credential](https://user:secret@evil.example/)",
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
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
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
  it("opens a narrow first-use form without the navigation covering it", async () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 560 });
    try {
      const empty = { ...DEMO_SNAPSHOT, campaigns: [], activeCampaignId: "", productConversation: null };
      mountElectron(empty);
      expect(await screen.findByRole("textbox", { name: /project folder/i })).toBeTruthy();
      expect(document.querySelector(".workspace-grid")?.classList.contains("nav-collapsed")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: /expand navigation/i }));
      fireEvent.click(screen.getByRole("button", { name: /close navigation/i }));
      expect(document.querySelector(".workspace-grid")?.classList.contains("nav-collapsed")).toBe(true);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

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

describe("goal draft and focus lifecycle", () => {
  it("keeps each goal's text and caret through polling and focuses a newly selected goal", async () => {
    let live = { ...DEMO_SNAPSHOT, preview: false };
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => ({ ...live, campaigns: [...live.campaigns] }),
      command: async (request: CoreCommand) => {
        if (request.messageType === "select_campaign") live = { ...live, activeCampaignId: String(request.payload.campaignId) };
        return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: live };
      },
      startCore: async () => live,
      openInVsCode: async () => undefined
    } as never;
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "draft A" } });
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe("campaign-evidence-loop"));
    expect(document.activeElement).toBe(composer);
    fireEvent.change(composer, { target: { value: "draft B" } });
    composer.setSelectionRange(3, 3);
    await new Promise((done) => setTimeout(done, 850));
    expect(composer.value).toBe("draft B");
    expect(composer.selectionStart).toBe(3);
    expect(document.activeElement).toBe(composer);
    fireEvent.click(screen.getByRole("button", { name: /build a durable preview/i }));
    await waitFor(() => expect(composer.value).toBe("draft A"));
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    await waitFor(() => expect(composer.value).toBe("draft B"));
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

describe("new goal during a selected-runtime send", () => {
  it("keeps Send busy and leaves the replacement draft free of the old refusal", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const starts: string[] = [];
    mountElectron(EMPTY_PREVIEW_SNAPSHOT, async (request: CoreCommand) => {
      if (request.messageType !== "start_conversation") {
        return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: EMPTY_PREVIEW_SNAPSHOT };
      }
      starts.push(String(request.payload.message));
      await gate;
      return {
        goalportRejected: true,
        requestId: request.requestId,
        error: "runtime start refused",
        snapshot: EMPTY_PREVIEW_SNAPSHOT
      };
    });

    const message = await screen.findByRole("textbox", { name: "Message composer" });
    fireEvent.change(message, { target: { value: "inspect the helper" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Select Runtime" }));
    const claude = await screen.findByRole("option", { name: /Claude Code/ });
    await waitFor(() => expect(document.activeElement).toBe(claude));
    fireEvent.keyDown(claude, { key: "ArrowDown" });
    const codex = screen.getByRole("option", { name: /Codex/ });
    await waitFor(() => expect(document.activeElement).toBe(codex));
    fireEvent.keyDown(codex, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" }).textContent).toContain("Starting…"));
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(send.textContent).toContain("Starting…");
    expect((screen.getByRole("textbox", { name: "Message composer" }) as HTMLTextAreaElement).value).toBe("");

    release(undefined);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" }).textContent).not.toContain("Starting…"));
    expect(screen.queryByText("GoalPort could not complete that action.")).toBeNull();
    expect((screen.getByRole("textbox", { name: "Message composer" }) as HTMLTextAreaElement).value).toBe("");
    expect(starts).toEqual(["inspect the helper"]);
  });

  it("keeps the replacement draft when the replaced send creates a goal", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let published: unknown = EMPTY_PREVIEW_SNAPSHOT;
    const created = {
      ...EMPTY_PREVIEW_SNAPSHOT,
      activeCampaignId: "campaign-created",
      campaigns: [{
        ...DEMO_SNAPSHOT.campaigns[0]!,
        id: "campaign-created",
        title: "Created during send",
      }],
    };
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => published,
      command: async (request: CoreCommand) => {
        if (request.messageType !== "start_conversation") {
          return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: published };
        }
        await gate;
        published = created;
        return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: created };
      },
      startCore: async () => published,
      openInVsCode: async () => undefined,
    } as never;
    render(<App />);

    const message = await screen.findByRole("textbox", { name: "Message composer" });
    fireEvent.change(message, { target: { value: "inspect the helper" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Select Runtime" }));
    const claude = await screen.findByRole("option", { name: /Claude Code/ });
    await waitFor(() => expect(document.activeElement).toBe(claude));
    fireEvent.keyDown(claude, { key: "ArrowDown" });
    const codex = screen.getByRole("option", { name: /Codex/ });
    await waitFor(() => expect(document.activeElement).toBe(codex));
    fireEvent.keyDown(codex, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" }).textContent).toContain("Starting…"));
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    release(undefined);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Start a goal" })).toBeTruthy();
      expect(screen.getAllByText("Created during send").length).toBeGreaterThan(0);
    }, { timeout: 2500 });
    expect((screen.getByRole("textbox", { name: "Message composer" }) as HTMLTextAreaElement).value).toBe("");
  });
});

describe("send without a Runtime", () => {
  function mountCoordination(configured: boolean) {
    let discoverCalls = 0;
    let appInfoSeen = false;
    const generations: string[] = [];
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => EMPTY_PREVIEW_SNAPSHOT,
      command: async () => EMPTY_PREVIEW_SNAPSHOT,
      startCore: async () => EMPTY_PREVIEW_SNAPSHOT,
      openInVsCode: async () => undefined,
      appInfo: async () => {
        appInfoSeen = true;
        return {
          version: "test",
          channel: "test",
          testMode: false,
          dataPath: "profile",
          coordinationConfigured: configured,
        };
      },
      coordinateDiscover: async (generation?: string) => {
        discoverCalls += 1;
        generations.push(String(generation ?? ""));
        return {
          connected: false,
          sendAuthorized: false,
          providers: [],
          stopReason: "No model turn was sent.",
        };
      },
      coordinateLaunch: async () => ({ text: "", errorText: "" }),
    } as never;
    render(<App />);
    return {
      discoverCalls: () => discoverCalls,
      appInfoSeen: () => appInfoSeen,
      generations: () => generations,
    };
  }

  async function openDraft(message: string) {
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
      target: { value: message },
    });
  }

  it("asks for a Runtime when this build has no coordination service", async () => {
    const bridge = mountCoordination(false);
    await openDraft("plan the helper");
    await waitFor(() => expect(bridge.appInfoSeen()).toBe(true));
    expect(screen.queryByText("Send without picking, or pick the single-harness path.")).toBeNull();
    expect(screen.getByText("Choose a Runtime before sending.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Start a goal" }));
    expect(bridge.discoverCalls()).toBe(0);
    expect(screen.getByRole("alert").textContent).toContain("Choose a Runtime before sending.");
  });

  it("allows send without a Runtime once the checkout is configured", async () => {
    const bridge = mountCoordination(true);
    await openDraft("plan the helper");
    await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(bridge.discoverCalls()).toBe(1));
    expect(await screen.findByText("No model turn was sent.")).toBeTruthy();
  });

  it("reopens a saved plan without discovering or launching again", async () => {
    let discoverCalls = 0;
    let launches = 0;
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
      coordinateDiscover: async () => {
        discoverCalls += 1;
        return { connected: false, sendAuthorized: false, providers: [], stopReason: "No model turn was sent." };
      },
      coordinateLaunch: async () => {
        launches += 1;
        return { text: "", errorText: "" };
      },
      coordinationRecords: async () => [{
        requestId: "saved-plan",
        workspacePath: "/work/goal",
        goal: "Explain the failure.",
        planningHarness: "Codex",
        reviewHarness: "Claude",
        planText: "Bounded plan.",
        reviewText: "Needs a smaller step.\nVERDICT: revise",
        result: "Needs a smaller step.\nVERDICT: revise",
        verdict: "revise",
        stopReason: "The independent check says the plan needs revision, so this stopped.",
        planningQuota: "available",
        reviewQuota: "available",
        savedAt: "2026-10-08T06:10:00.000Z",
      }],
    } as never;
    render(<App />);
    expect(await screen.findByText("Needs revision")).toBeTruthy();
    expect(screen.getByText("Bounded plan.")).toBeTruthy();
    expect(screen.getByText(/needs revision, so this stopped/)).toBeTruthy();
    expect(document.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-08T06:10:00.000Z");
    expect(screen.getByRole("button", { name: /Needs revision · / })).toBeTruthy();
    expect(discoverCalls).toBe(0);
    expect(launches).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    const composer = await screen.findByRole("textbox", { name: "Message composer" }) as HTMLTextAreaElement;
    expect(composer.value).toBe("Explain the failure.");
    expect(screen.getByText(/Nothing is sent until you press Send/)).toBeTruthy();
    expect(screen.getByText(/The check said:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Explain the failure/ })).toBeTruthy();
    expect(discoverCalls).toBe(0);
    expect(launches).toBe(0);
  });

  it("reopens a failed plan and a stopped plan without launching again", async () => {
    let discoverCalls = 0;
    let launches = 0;
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
      coordinateDiscover: async () => {
        discoverCalls += 1;
        return { connected: true, sendAuthorized: true, providers: [], stopReason: null };
      },
      coordinateLaunch: async () => {
        launches += 1;
        return { text: "", errorText: "" };
      },
      coordinationRecords: async () => [
        {
          requestId: "failed-plan",
          workspacePath: "/work/goal",
          goal: "The send failed.",
          planningHarness: "Codex",
          reviewHarness: "Claude",
          planText: null,
          reviewText: null,
          result: null,
          verdict: "failed",
          stopReason: "The harness did not finish, so this stopped.",
          planningQuota: "unknown",
          reviewQuota: "unknown",
        },
        {
          requestId: "stopped-plan",
          workspacePath: "/work/goal",
          goal: "The check said stop.",
          planningHarness: "Codex",
          reviewHarness: "Claude",
          planText: "Bounded plan.",
          reviewText: "VERDICT: stop",
          result: "VERDICT: stop",
          verdict: "stopped",
          stopReason: "The independent check says to stop, so this stopped.",
          planningQuota: "unknown",
          reviewQuota: "unknown",
        },
      ],
    } as never;
    render(<App />);
    expect(await screen.findByText("Failed", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/did not finish, so this stopped/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /The check said stop/ }));
    expect(await screen.findByText("Stopped", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("Bounded plan.")).toBeTruthy();
    expect(discoverCalls).toBe(0);
    expect(launches).toBe(0);
  });

  it("saves a real send before the harness returns and keeps the failure", async () => {
    let release: (value?: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const order: string[] = [];
    let launches = 0;
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
      coordinateDiscover: async () => ({
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
            auth: { status: "authenticated", type: "chatgpt" },
            models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true }],
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
            models: [{ slug: "opus", name: "opus", isDefault: true }],
            usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
          },
        ],
      }),
      coordinateLaunch: async () => {
        launches += 1;
        order.push("launch");
        if (launches === 1) await gate;
        return { text: "", errorText: "The harness did not finish, so this stopped." };
      },
      coordinationSave: async (record: { verdict: string }) => {
        order.push(`save:${record.verdict}`);
        return record;
      },
      coordinationRecords: async () => [],
    } as never;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
      target: { value: "plan the helper" },
    });
    await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(order).toContain("launch"));
    expect(order[0]).toBe("save:unconfirmed");
    expect(order.filter((item) => item === "launch")).toHaveLength(1);
    release();
    expect(await screen.findByText("Failed", { selector: "dd" })).toBeTruthy();
    await waitFor(() => expect(order).toContain("save:failed"));
    expect(launches).toBe(1);
  });

  it("sends the same words again as a new round, not a replay of the first", async () => {
    const commandIds: string[] = [];
    const stored: Array<{ requestId?: string }> = [];
    const plans = ["Bounded plan from the first send.", "Bounded plan from the second send."];
    let launches = 0;
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
      coordinateDiscover: async () => ({
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
            auth: { status: "authenticated", type: "chatgpt" },
            models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true }],
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
            models: [{ slug: "opus", name: "opus", isDefault: true }],
            usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
          },
        ],
      }),
      coordinateLaunch: async (command: { commandId: string }) => {
        launches += 1;
        commandIds.push(command.commandId);
        // Odd launches are the planner turn of each round.
        const plan = plans[Math.floor((launches - 1) / 2)] ?? "";
        return launches % 2 === 1
          ? { text: plan, errorText: "" }
          : { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "" };
      },
      coordinationSave: async (record: { requestId?: string }) => {
        const index = stored.findIndex((item) => item.requestId === record.requestId);
        if (index >= 0) stored[index] = record;
        else stored.unshift(record);
        return record;
      },
      coordinationRecords: async () => stored,
    } as never;
    render(<App />);

    const sendOnce = async () => {
      fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
      fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
        target: { value: "the same words" },
      });
      await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    };

    await sendOnce();
    expect(await screen.findByText("Bounded plan from the first send.")).toBeTruthy();
    expect(await screen.findByText("Can be carried out", { selector: "dd" })).toBeTruthy();

    await sendOnce();
    expect(await screen.findByText("Bounded plan from the second send.")).toBeTruthy();
    await waitFor(() => expect(launches).toBe(4));
    expect(new Set(commandIds).size).toBe(4);
    expect(screen.getAllByRole("button", { name: /the same words/ }).length).toBe(2);
  });

  it("does not launch a turn the app could not record on disk", async () => {
    let launches = 0;
    let saves = 0;
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
      coordinateDiscover: async () => ({
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
            auth: { status: "authenticated", type: "chatgpt" },
            models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true }],
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
            models: [{ slug: "opus", name: "opus", isDefault: true }],
            usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
          },
        ],
      }),
      coordinateLaunch: async () => {
        launches += 1;
        return { text: "Never reached.", errorText: "" };
      },
      coordinationSave: async () => {
        saves += 1;
        throw new Error("disk unavailable");
      },
      coordinationRecords: async () => [],
    } as never;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
      target: { value: "plan the helper" },
    });
    await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(/could not be recorded, so nothing was sent/i)).toBeTruthy();
    expect(launches).toBe(0);
    expect(saves).toBeGreaterThan(0);
    // The unrecordable send must not enter the Plans list: that list mirrors
    // the persisted records, and its count keys the next send's identity.
    expect(screen.queryAllByRole("button", { name: /plan the helper/ })).toHaveLength(0);
  });

  it("retries for real after a discovery failure that dispatched nothing", async () => {
    let discoverCalls = 0;
    let launches = 0;
    const providers = [
      {
        instanceId: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        availability: "available",
        status: "ready",
        auth: { status: "authenticated", type: "chatgpt" },
        models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true }],
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
        models: [{ slug: "opus", name: "opus", isDefault: true }],
        usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
      },
    ];
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
      coordinateDiscover: async () => {
        discoverCalls += 1;
        if (discoverCalls === 1) throw new Error("The harness list could not be read.");
        return { connected: true, sendAuthorized: true, stopReason: null, providers };
      },
      coordinateLaunch: async () => {
        launches += 1;
        return launches % 2 === 1
          ? { text: "Bounded plan.", errorText: "", dispatched: true }
          : { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "", dispatched: true };
      },
      coordinationSave: async (record: { requestId?: string }) => record,
      coordinationRecords: async () => [],
    } as never;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
      target: { value: "plan the helper" },
    });
    await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    // The catch path leaves the draft mounted with the failure on it.
    expect(await screen.findByText(/harness list could not be read/i)).toBeTruthy();
    expect(launches).toBe(0);

    // The outage clears: an explicit second press must rediscover and run the
    // round instead of echoing the failed record.
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(launches).toBe(2));
    expect(await screen.findByText(/independent check finished, so this stopped/i)).toBeTruthy();
    expect(discoverCalls).toBe(2);
    expect(screen.getAllByRole("button", { name: /Plan: plan the helper/ }).length).toBe(1);
  });

  it("blocks the send while the saved plans cannot be read, then runs once they can", async () => {
    let recordsBroken = true;
    let launches = 0;
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
      coordinateDiscover: async () => ({
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
            auth: { status: "authenticated", type: "chatgpt" },
            models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true }],
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
            models: [{ slug: "opus", name: "opus", isDefault: true }],
            usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
          },
        ],
      }),
      coordinateLaunch: async () => {
        launches += 1;
        return launches % 2 === 1
          ? { text: "Bounded plan.", errorText: "", dispatched: true }
          : { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "", dispatched: true };
      },
      coordinationSave: async (record: { requestId?: string }) => record,
      coordinationRecords: async () => {
        if (recordsBroken) throw new Error("records unreadable");
        return [];
      },
    } as never;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
      target: { value: "plan the helper" },
    });
    await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    // No launch may happen while the record count — which keys the command
    // identity — cannot be read from disk.
    expect(await screen.findByText(/saved plans could not be read/i)).toBeTruthy();
    expect(launches).toBe(0);

    recordsBroken = false;
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(launches).toBe(2));
    expect(await screen.findByText(/independent check finished, so this stopped/i)).toBeTruthy();
  });

  it("shows a mid-turn failure again without resending it", async () => {
    let launches = 0;
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
      coordinateDiscover: async () => ({
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
            auth: { status: "authenticated", type: "chatgpt" },
            models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true }],
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
            models: [{ slug: "opus", name: "opus", isDefault: true }],
            usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
          },
        ],
      }),
      coordinateLaunch: async () => {
        launches += 1;
        // The transport dies mid-turn: the outcome is unknown, so the failure
        // must be shown, never resent.
        throw new Error("The coordination service stopped.");
      },
      coordinationSave: async (record: { requestId?: string }) => record,
      coordinationRecords: async () => [],
    } as never;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
      target: { value: "plan the helper" },
    });
    await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/coordination service stopped/i)).toBeTruthy();
    expect(launches).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByText(/coordination service stopped/i)).toBeTruthy());
    expect(launches).toBe(1);
    expect(screen.getAllByRole("button", { name: /Plan: plan the helper/ }).length).toBe(1);
  });


  it("closes the planning draft when the user returns to the active goal", async () => {
    let launches = 0;
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => DEMO_SNAPSHOT,
      command: async (request: CoreCommand) => ({
        requestId: request.requestId,
        accepted: true,
        duplicate: false,
        snapshot: DEMO_SNAPSHOT,
      }),
      startCore: async () => DEMO_SNAPSHOT,
      openInVsCode: async () => undefined,
      appInfo: async () => ({
        version: "test",
        channel: "test",
        testMode: false,
        dataPath: "profile",
        coordinationConfigured: true,
      }),
      coordinateDiscover: async () => ({
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
            auth: { status: "authenticated", type: "chatgpt" },
            models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true }],
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
            models: [{ slug: "opus", name: "opus", isDefault: true }],
            usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
          },
        ],
      }),
      coordinateLaunch: async () => {
        launches += 1;
        return launches % 2 === 1
          ? { text: "Bounded plan.", errorText: "" }
          : { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "" };
      },
      coordinationSave: async (record: { requestId?: string }) => record,
      coordinationRecords: async () => [],
    } as never;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
      target: { value: "plan the helper" },
    });
    await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Bounded plan.")).toBeTruthy();

    // The active goal is already selected; clicking it again used to leave the
    // planning draft mounted over the conversation.
    fireEvent.click(screen.getByRole("button", { name: "Build a durable preview" }));
    await waitFor(() => expect(screen.queryByText("Bounded plan.")).toBeNull());
    expect(screen.queryByRole("form", { name: "Start a goal" })).toBeNull();
    // The conversation's own composer is what remains in the main pane.
    expect(screen.getByRole("textbox", { name: "Message composer" })).toBeTruthy();
  });

  it("labels every saved plan for keyboard and collapsed-rail use", async () => {
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
      coordinateDiscover: async () => ({ connected: false, sendAuthorized: false, providers: [], stopReason: "No model turn was sent." }),
      coordinateLaunch: async () => ({ text: "", errorText: "" }),
      coordinationRecords: async () => [{
        requestId: "saved-plan",
        workspacePath: "/work/goal",
        goal: "Explain the failure.",
        planningHarness: "Codex",
        reviewHarness: "Claude",
        planText: "Bounded plan.",
        reviewText: "Needs a smaller step.\nVERDICT: revise",
        result: "Needs a smaller step.\nVERDICT: revise",
        verdict: "revise",
        stopReason: "The independent check says the plan needs revision, so this stopped.",
        planningQuota: "available",
        reviewQuota: "available",
        savedAt: "2026-10-08T06:10:00.000Z",
      }],
    } as never;
    render(<App />);
    const button = await screen.findByRole("button", { name: /^Plan: Explain the failure., Needs revision/ });
    expect(button.getAttribute("title")).toMatch(/Needs revision/);
  });

  it("uses a fresh generation after the window reloads", async () => {
    expect(coordinationGeneration("window-a", 6)).toBe("window-a-6");
    expect(coordinationGeneration("window-a", 6)).not.toBe(coordinationGeneration("window-b", 6));

    const first = mountCoordination(true);
    await openDraft("plan the helper");
    await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(first.discoverCalls()).toBe(1));

    cleanup();
    delete window.goalportCore;
    delete window.__GOALPORT_ELECTRON__;

    const second = mountCoordination(true);
    await openDraft("plan the helper again");
    await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(second.discoverCalls()).toBe(1));

    const firstGeneration = first.generations()[0] ?? "";
    const secondGeneration = second.generations()[0] ?? "";
    expect(firstGeneration).not.toMatch(/^\d+$/);
    expect(secondGeneration).not.toMatch(/^\d+$/);
    expect(firstGeneration.split("-").at(-1)).toBe(secondGeneration.split("-").at(-1));
    expect(firstGeneration).not.toBe(secondGeneration);
  });
});

describe("leaving a draft during coordination", () => {
  it("cancels the assignment when another goal is opened", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const generations: string[] = [];
    const cancels: string[] = [];
    let launches = 0;
    let discoverSettled = false;
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: async () => DEMO_SNAPSHOT,
      command: async (request: CoreCommand) => ({
        requestId: request.requestId,
        accepted: true,
        duplicate: false,
        snapshot: request.messageType === "select_campaign"
          ? { ...DEMO_SNAPSHOT, activeCampaignId: String(request.payload.campaignId) }
          : DEMO_SNAPSHOT,
      }),
      startCore: async () => DEMO_SNAPSHOT,
      openInVsCode: async () => undefined,
      appInfo: async () => ({
        version: "test",
        channel: "test",
        testMode: false,
        dataPath: "profile",
        coordinationConfigured: true,
      }),
      coordinateDiscover: async (generation?: string) => {
        generations.push(String(generation ?? ""));
        await gate;
        discoverSettled = true;
        return { connected: true, sendAuthorized: false, providers: [], stopReason: null };
      },
      coordinateLaunch: async () => {
        launches += 1;
        return { text: "", errorText: "" };
      },
      coordinateCancel: async (generation: string) => {
        cancels.push(generation);
      },
    } as never;
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
      target: { value: "plan the helper" },
    });
    await waitFor(() => expect(screen.getByText("Send without picking, or pick the single-harness path.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(generations).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Evidence loop" }));
    await waitFor(() => expect(cancels.at(-1)).toBe(generations[0]));
    expect(screen.queryByRole("heading", { name: "Start a goal" })).toBeNull();

    release(undefined);
    await waitFor(() => expect(discoverSettled).toBe(true));
    expect(launches).toBe(0);
    expect(screen.queryByRole("heading", { name: "Start a goal" })).toBeNull();
    expect(screen.queryByText("Two different harnesses are assigned. No model turn has been sent.")).toBeNull();
  });
});

// Execute the actual integrated M7 normalizer, not a permissive imitation.
// All storage is isolated temporary test storage; no user profile is touched.
const recordApi = createRequire(import.meta.url)("../electron/coordination-record.cjs") as {
  saveRecord: (dir: string, input: Record<string, unknown>) => Record<string, unknown>;
  readRecords: (dir: string) => Array<Record<string, unknown>>;
};
function normalizeCoordinationRecordForTest(input: Record<string, unknown>): Record<string, unknown> | null {
  const dir = mkdtempSync(join(tmpdir(), "goalport-m8-record-"));
  try {
    recordApi.saveRecord(dir, input);
    return recordApi.readRecords(dir)[0] ?? null;
  } catch { return null; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function saveCoordinationRecordForTest(
  saved: Array<Record<string, unknown>>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const record = normalizeCoordinationRecordForTest(input);
  if (!record) throw new Error("The plan could not be saved.");
  const stamped: Record<string, unknown> = { ...record, savedAt: new Date().toISOString() };
  const index = saved.findIndex((item) => item.requestId === stamped.requestId);
  if (index >= 0) saved[index] = stamped;
  else saved.unshift(stamped);
  return stamped;
}

describe("environment-blocked harness", () => {
  function providerBridge(options: {
    providers: Array<{ instanceId: string; displayName: string }>;
    launch: (command: { commandId: string; modelSelection: { instanceId: string } }, call: number) => Promise<{ text: string; errorText: string; dispatched?: boolean; environmentBlocked?: boolean; environmentDetail?: string }>;
    records?: () => Promise<unknown[]>;
  }) {
    let calls = 0;
    const launched: Array<{ commandId: string; instanceId: string }> = [];
    const saved: Array<Record<string, unknown>> = [];
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
      coordinateDiscover: async () => ({
        connected: true,
        sendAuthorized: true,
        stopReason: null,
        providers: options.providers.map((provider) => ({
          instanceId: provider.instanceId,
          displayName: provider.displayName,
          enabled: true,
          installed: true,
          availability: "available",
          status: "ready",
          auth: { status: "authenticated", type: "subscription" },
          models: [{ slug: `${provider.instanceId}-model`, name: `${provider.instanceId}-model`, isDefault: true }],
          usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
        })),
      }),
      coordinateLaunch: async (command: { commandId: string; modelSelection: { instanceId: string } }) => {
        calls += 1;
        launched.push({ commandId: command.commandId, instanceId: command.modelSelection.instanceId });
        return options.launch(command, calls);
      },
      coordinationSave: async (record: Record<string, unknown>) => saveCoordinationRecordForTest(saved, record),
      coordinationRecords: options.records ?? (async () => saved),
      coordinationScope: async () => null,
      coordinationUnblock: async () => ({ ok: true }),
    } as never;
    return { launched, saved, launchCount: () => calls };
  }

  it("stops after the environment-blocked planner, names the machine, and never sends the check", async () => {
    const bridge = providerBridge({
      providers: [
        { instanceId: "codex", displayName: "Codex" },
        { instanceId: "claude", displayName: "Claude" },
      ],
      launch: async () => ({
        text: "I couldn't read the file because the sandbox failed to initialize.",
        errorText: "This harness cannot run its tools on this machine, so this stopped.",
        dispatched: true,
        environmentBlocked: true,
        environmentDetail: "Failed to create unified exec process: helper_unknown_error: setup refresh had errors",
      }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
      target: { value: "plan the helper" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/Codex cannot run its tools on this machine right now/)).toBeTruthy();
    expect(screen.getByText(/machine problem, not a plan problem/)).toBeTruthy();
    expect(screen.getByText(/Only 1 other usable harness is signed in/)).toBeTruthy();
    // The check turn was never sent: one launch, and it was the codex planner.
    expect(bridge.launchCount()).toBe(1);
    expect(bridge.launched[0]?.instanceId).toBe("codex");
    // The folded raw evidence is there and stays folded until opened.
    const summary = screen.getByText("Technical details");
    fireEvent.click(summary);
    expect(await screen.findByText(/helper_unknown_error/)).toBeTruthy();
    // No button to send again: with one other harness a round is impossible.
    expect(screen.queryByRole("button", { name: /send again without codex/i })).toBeNull();
    await waitFor(() => expect(bridge.saved.some((record) => record.verdict === "failed")).toBe(true));
  });

  it("Send again without the blocked harness drafts a new round that assigns it no role", async () => {
    const bridge = providerBridge({
      providers: [
        { instanceId: "codex", displayName: "Codex" },
        { instanceId: "claude", displayName: "Claude" },
        { instanceId: "grok", displayName: "Grok" },
      ],
      launch: async (command) => {
        if (command.modelSelection.instanceId === "codex") {
          return {
            text: "I couldn't read the file because the sandbox failed to initialize.",
            errorText: "This harness cannot run its tools on this machine, so this stopped.",
            dispatched: true,
            environmentBlocked: true,
            environmentDetail: "windows sandbox failed: helper_unknown_error: setup refresh had errors",
          };
        }
        return command.commandId.includes("plan")
          ? { text: "Bounded plan.", errorText: "" }
          : { text: "The plan can be carried out.\nVERDICT: carry-out", errorText: "" };
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message composer" }), {
      target: { value: "plan the helper" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const again = await screen.findByRole("button", { name: /send again without codex/i });
    // The failed round is the only launch so far.
    expect(bridge.launchCount()).toBe(1);
    fireEvent.click(again);
    // The new draft says up front who it will not use, and nothing was sent.
    expect(await screen.findByText(/This send will not use Codex/)).toBeTruthy();
    expect(screen.getByText(/Nothing is sent until you press Send/)).toBeTruthy();
    expect(bridge.launchCount()).toBe(1);
    // Sending the draft starts a new round whose planner is not codex.
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(bridge.launchCount()).toBe(3));
    expect(bridge.launched.slice(1).map((item) => item.instanceId)).toEqual(["claude", "grok"]);
    expect(await screen.findByText("Can be carried out", { selector: "dd" })).toBeTruthy();
  });
});

describe("harness access panel and scoped rounds", () => {
  function usableHarness(instanceId: string, displayName: string): Record<string, unknown> {
    return {
      instanceId,
      displayName,
      enabled: true,
      installed: true,
      availability: "available",
      status: "ready",
      auth: { status: "authenticated", type: "subscription" },
      models: [{ slug: `${instanceId}-model`, name: `${instanceId}-model`, isDefault: true }],
      usageLimits: { windows: [{ id: "five_hour", usedPercent: 1 }] },
    };
  }

  const PLAN_TEXT = "Bounded plan.";
  const CHECK_TEXT = "The plan can be carried out.\nVERDICT: carry-out";

  function planOrReview(command: { commandId: string }): { text: string; errorText: string } {
    return command.commandId.includes("plan")
      ? { text: PLAN_TEXT, errorText: "" }
      : { text: CHECK_TEXT, errorText: "" };
  }

  type AccessPayload = { instances: string[]; maxTurns: number; write?: { instances: string[]; maxTurns: number; workspaceRoot: string } };
  function scopedBridge(options: {
    providers: Array<Record<string, unknown>>;
    scope?: Record<string, unknown> | null;
    onUnblock?: (instanceId: string) => void;
    authorize?: (payload: AccessPayload) => Promise<unknown>;
    readScope?: (scope: Record<string, unknown> | null, call: number) => Record<string, unknown> | null;
    save?: (record: Record<string, unknown>, call: number) => Record<string, unknown>;
    launch: (command: { commandId: string; modelSelection: { instanceId: string } }, call: number) => Promise<Record<string, unknown>>;
    records?: Array<Record<string, unknown>> | (() => Promise<Array<Record<string, unknown>>>);
  }) {
    const order: string[] = [];
    const authorizations: AccessPayload[] = [];
    let currentScope = options.scope ?? null;
    let scopeCalls = 0;
    let saveCalls = 0;
    const saved: Array<Record<string, unknown>> = [];
    const launched: Array<{ commandId: string; instanceId: string }> = [];
    const launchArgs: unknown[][] = [];
    let currentProviders = options.providers;
    let calls = 0;
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
      coordinateDiscover: async () => {
        order.push("discover");
        return { connected: true, sendAuthorized: true, stopReason: null, providers: currentProviders };
      },
      coordinateLaunch: async (...args: unknown[]) => {
        order.push("launch");
        calls += 1;
        const command = args[0] as { commandId: string; modelSelection: { instanceId: string } };
        launched.push({ commandId: command.commandId, instanceId: command.modelSelection.instanceId });
        launchArgs.push(args);
        return options.launch(command, calls);
      },
      coordinationAuthorize: async (payload: AccessPayload) => {
        order.push("authorize");
        authorizations.push(payload);
        const result = options.authorize ? await options.authorize(payload) : { ok: true, generation: 1, remaining: payload.maxTurns };
        if (result && typeof result === "object" && "ok" in result && result.ok === true) {
          currentScope = { instances: payload.instances, maxTurns: payload.maxTurns, remaining: payload.maxTurns, generation: 1,
            ...(payload.write ? { write: { ...payload.write, remaining: payload.write.maxTurns } } : {}) };
        }
        return result;
      },
      coordinationScope: async () => {
        scopeCalls += 1;
        return options.readScope ? options.readScope(currentScope, scopeCalls) : currentScope;
      },
      coordinationRevoke: async () => { currentScope = null; return { ok: true }; },
      coordinationUnblock: async (instanceId: string) => {
        order.push(`unblock:${instanceId}`);
        options.onUnblock?.(instanceId);
        return { ok: true };
      },
      coordinationSave: async (record: Record<string, unknown>) => {
        saveCalls += 1;
        return options.save ? options.save(record, saveCalls) : saveCoordinationRecordForTest(saved, record);
      },
      coordinationRecords: async () => (typeof options.records === "function" ? options.records() : (options.records ?? saved)),
    } as never;
    return {
      order,
      saved,
      launched,
      launchArgs,
      authorizations,
      launchCount: () => calls,
      setProviders: (providers: Array<Record<string, unknown>>) => { currentProviders = providers; },
    };
  }

  async function openDraftWithPanel() {
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    const lead = await screen.findByText(/Nothing is sent until you press Send\./);
    expect(lead).toBeTruthy();
    return lead;
  }

  function typeMessage(message: string) {
    fireEvent.change(screen.getByRole("textbox", { name: "Message composer" }), {
      target: { value: message },
    });
  }

  function sendMessage() {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  }

  it("never lands a paid-api scope member in the checked set when echoing a scope", async () => {
    // An impossible-but-defensive case: a scope that somehow names the
    // apiKey login. The checked set stays a subset of subscription logins;
    // the summary sentence never claims GoalPort may use the paid-API one.
    scopedBridge({
      providers: [
        usableHarness("codex", "Codex"),
        usableHarness("claude", "Claude"),
        { ...usableHarness("grok", "Grok"), auth: { status: "authenticated", type: "apiKey" } },
      ],
      scope: { instances: ["codex", "claude", "grok"], maxTurns: 4, remaining: 2, generation: 1 },
      launch: async () => ({ text: "", errorText: "" }),
    });
    render(<App />);
    await openDraftWithPanel();
    expect(await screen.findByText("2 of 4 authorized model turns left.")).toBeTruthy();
    expect(screen.getByText(/GoalPort may use Codex and Claude for plan and check turns\./)).toBeTruthy();
    // The paid-api row is displayed (its unselectable reason) but never gets
    // a checkbox, and the summary never claims GoalPort may use it.
    expect(screen.queryByRole("checkbox", { name: "Select Grok" })).toBeNull();
    expect(screen.getByText(/bills through its own API key/)).toBeTruthy();
  });

  it("renders the three panel row states: usable, blocked with Use again, and paid-api", async () => {
    scopedBridge({
      providers: [
        usableHarness("codex", "Codex"),
        {
          ...usableHarness("claude", "Claude"),
          environmentHealth: { since: "2026-10-01T09:30:00.000Z", detail: "windows sandbox failed: helper missing" },
        },
        { ...usableHarness("grok", "Grok"), auth: { status: "authenticated", type: "apiKey" } },
      ],
      launch: async () => ({ text: "", errorText: "" }),
    });
    render(<App />);
    await openDraftWithPanel();
    // Usable row: a selectable checkbox; only Codex is selected by default.
    expect(screen.getByText("GoalPort may use Codex for plan and check turns. Nothing is sent until you press Send.")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select Codex" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Select Claude" })).toBeNull();
    // Blocked row: since-line, Use again, collapsed Technical details.
    expect(screen.getByText(/Blocked on this machine since/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use again Claude" })).toBeTruthy();
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details.hasAttribute("open")).toBe(false);
    fireEvent.click(screen.getByText("Technical details"));
    expect(details.hasAttribute("open")).toBe(true);
    // Paid-api row: unselectable, one-line reason, no checkbox.
    expect(screen.getByText(/bills through its own API key, so it cannot be selected\./)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Select Grok" })).toBeNull();
    // Turn-count input defaults to 4 within [2, 32].
    const turns = screen.getByRole("spinbutton", { name: "Model turns to allow" }) as HTMLInputElement;
    expect(turns.value).toBe("4");
    expect(turns.min).toBe("2");
    expect(turns.max).toBe("32");
  });

  it("intercepts a send with fewer than two selected harnesses and authorizes nothing", async () => {
    const bridge = scopedBridge({
      providers: [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")],
      launch: async () => ({ text: "", errorText: "" }),
    });
    render(<App />);
    await openDraftWithPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Codex" }));
    typeMessage("plan the helper");
    sendMessage();
    expect(await screen.findByText(/An independent check needs two harnesses that can run, so select at least two\./)).toBeTruthy();
    expect(bridge.order).not.toContain("authorize");
    expect(bridge.order.filter((item) => item === "launch")).toHaveLength(0);
  });

  it("authorizes before the first discover and launch on the first send", async () => {
    const bridge = scopedBridge({
      providers: [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")],
      launch: async (command) => planOrReview(command),
    });
    render(<App />);
    await openDraftWithPanel();
    typeMessage("plan the helper");
    sendMessage();
    await waitFor(() => expect(bridge.launchCount()).toBe(2));
    expect(await screen.findByText("Can be carried out", { selector: "dd" })).toBeTruthy();
    const order = bridge.order;
    expect(order.indexOf("authorize")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("authorize")).toBeLessThan(order.lastIndexOf("discover"));
    expect(order.lastIndexOf("discover")).toBeLessThan(order.indexOf("launch"));
    // Every launch carries the command, the request generation, and the scope generation.
    expect(bridge.launchArgs[0]).toHaveLength(3);
    expect(bridge.launchArgs[0]?.[2]).toBe(1);
  });

  it("Use again clears the harness on this machine and then re-discovers", async () => {
    const bridge = scopedBridge({
      providers: [
        usableHarness("codex", "Codex"),
        {
          ...usableHarness("claude", "Claude"),
          environmentHealth: { since: "2026-10-01T09:30:00.000Z", detail: "helper crashed" },
        },
      ],
      onUnblock: () => bridge.setProviders([usableHarness("codex", "Codex"), usableHarness("claude", "Claude")]),
      launch: async (command) => planOrReview(command),
    });
    render(<App />);
    await openDraftWithPanel();
    fireEvent.click(screen.getByRole("button", { name: "Use again Claude" }));
    await waitFor(() => expect(bridge.order).toContain("unblock:claude"));
    // Unblock ran before the re-discovery, and the row became selectable.
    const unblockIndex = bridge.order.indexOf("unblock:claude");
    expect(bridge.order.slice(unblockIndex + 1)).toContain("discover");
    expect(await screen.findByRole("checkbox", { name: "Select Claude" })).toBeTruthy();
    expect(screen.getByText(/GoalPort may use Codex and Claude for plan and check turns\./)).toBeTruthy();
  });

  it("runs an environment failure through a takeover to the terminal view", async () => {
    const bridge = scopedBridge({
      providers: [usableHarness("codex", "Codex"), usableHarness("claude", "Claude"), usableHarness("grok", "Grok")],
      launch: async (command, call) => {
        if (call === 1) {
          return {
            text: "",
            errorText: "This harness cannot run its tools on this machine, so this stopped.",
            dispatched: true,
            environmentBlocked: true,
            environmentDetail: "helper exploded",
          };
        }
        return planOrReview(command);
      },
    });
    render(<App />);
    await openDraftWithPanel();
    typeMessage("plan the helper");
    sendMessage();
    // Codex failed, Claude took over the plan, Grok checked.
    await waitFor(() => expect(bridge.launchCount()).toBe(3));
    expect(bridge.launched.map((item) => item.instanceId)).toEqual(["codex", "claude", "grok"]);
    expect(await screen.findByText("Can be carried out", { selector: "dd" })).toBeTruthy();
    // Each round event is one card: the failure and the takeover.
    expect(screen.getByText(/Codex could not run its tools on this machine, so this stopped for it\./)).toBeTruthy();
    expect(screen.getByText(/Claude is planning instead\./)).toBeTruthy();
    // The top line names the harnesses that finished the round.
    expect(screen.getByText(/Claude planned and Grok checked — the harnesses you authorized that can run\./)).toBeTruthy();
    // The environment card offers Use again for the blocked harness.
    expect(screen.getByRole("button", { name: "Use again Codex" })).toBeTruthy();
    expect(screen.getByText(/It stays unused until you choose Use again\./)).toBeTruthy();
  });

  it("shows the remaining authorized turns following each launch", async () => {
    let releaseFirst: (value?: unknown) => void = () => {};
    let releaseSecond: (value?: unknown) => void = () => {};
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
    const bridge = scopedBridge({
      providers: [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")],
      launch: async (command, call) => {
        if (call === 1) {
          await firstGate;
          return { text: PLAN_TEXT, errorText: "", turnsRemaining: 3 };
        }
        await secondGate;
        return { text: CHECK_TEXT, errorText: "", turnsRemaining: 2 };
      },
    });
    render(<App />);
    await openDraftWithPanel();
    typeMessage("plan the helper");
    sendMessage();
    releaseFirst();
    // The in-flight line followed the first launch's return, while the check
    // turn is still waiting behind its own gate.
    await waitFor(() => expect(screen.getByText("3 of 4 authorized model turns left.")).toBeTruthy());
    releaseSecond();
    // …and the terminal line shows the last launch's count.
    await waitFor(() => expect(screen.getByText("2 of 4 authorized model turns left.")).toBeTruthy());
    expect(await screen.findByText("Can be carried out", { selector: "dd" })).toBeTruthy();
  });

  it("shows the exhaustion stop sentence and Allow more turns when the scope runs out", async () => {
    const bridge = scopedBridge({
      providers: [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")],
      launch: async (command, call) => {
        if (call === 1) return { text: PLAN_TEXT, errorText: "", turnsRemaining: 1 };
        return { text: "", errorText: "", stopCode: "scope-exhausted", scopeExhausted: true, turnsRemaining: 0 };
      },
    });
    render(<App />);
    await openDraftWithPanel();
    typeMessage("plan the helper");
    sendMessage();
    expect(await screen.findByText("All authorized model turns were used, so this stopped.", { selector: "dd" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow more turns" })).toBeTruthy();
  });

  it("Allow more turns on a just-finished round opens the change-mode draft instead of a hidden no-op", async () => {
    const bridge = scopedBridge({
      providers: [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")],
      launch: async (_command, call) => {
        if (call === 1) return { text: PLAN_TEXT, errorText: "", turnsRemaining: 1 };
        return { text: "", errorText: "", stopCode: "scope-exhausted", scopeExhausted: true, turnsRemaining: 0 };
      },
    });
    render(<App />);
    await openDraftWithPanel();
    typeMessage("plan the helper");
    sendMessage();
    expect(await screen.findByText("All authorized model turns were used, so this stopped.", { selector: "dd" })).toBeTruthy();
    // The finished round's remnant draft is still mounted; clicking Allow more
    // turns on the terminal card must open the panel in change mode on a fresh
    // draft of the same goal — not silently flip a hidden panel.
    fireEvent.click(screen.getByRole("button", { name: "Allow more turns" }));
    expect(await screen.findByRole("button", { name: "Save harness access" })).toBeTruthy();
    expect((screen.getByLabelText("Message composer") as HTMLTextAreaElement).value).toBe("plan the helper");
    // Nothing was re-authorized or sent by opening change mode.
    expect(bridge.order.filter((step) => step === "authorize").length).toBe(1);
    expect(bridge.launched.length).toBe(2);
  });

  it("keeps the exhaustion controls after save and reselect via the realistic normalizer", async () => {
    const bridge = scopedBridge({
      providers: [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")],
      launch: async (_command, call) => {
        if (call === 1) return { text: PLAN_TEXT, errorText: "", turnsRemaining: 1 };
        return { text: "", errorText: "", stopCode: "scope-exhausted", scopeExhausted: true, turnsRemaining: 0 };
      },
    });
    render(<App />);
    await openDraftWithPanel();
    typeMessage("plan the helper");
    sendMessage();
    expect(await screen.findByText("All authorized model turns were used, so this stopped.", { selector: "dd" })).toBeTruthy();
    // The normalizer dropped the transient fields from the persisted record…
    await waitFor(() => expect(bridge.saved.length).toBeGreaterThan(0));
    const record = bridge.saved[0];
    expect(record).toBeTruthy();
    expect("scopeExhausted" in record).toBe(false);
    expect("authorizedTurnsLeft" in record).toBe(false);
    // …yet the current round still shows its overlay after save + auto-select.
    expect(screen.getByRole("button", { name: "Allow more turns" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop allowing" })).toBeTruthy();
  });

  it("shows no authorization controls on a reloaded historical record", async () => {
    const historical = {
      ...normalizeCoordinationRecordForTest({
        requestId: "round-1",
        workspacePath: "/work/goal",
        goal: "Ship the preview.",
        planningHarness: "Claude",
        reviewHarness: "Grok",
        planText: PLAN_TEXT,
        reviewText: null,
        result: null,
        verdict: "failed",
        stopReason: "All authorized model turns were used, so this stopped.",
        planningQuota: "available",
        reviewQuota: "available",
        messageDispatched: true,
        environmentBlocked: null,
        roundEvents: [
          {
            kind: "failed",
            role: "planning",
            instanceId: "codex",
            harness: "Codex",
            sentence: "Codex could not run its tools on this machine, so this stopped for it.",
            detail: "helper exploded",
          },
        ],
      }),
      savedAt: "2026-10-09T10:00:00.000Z",
    };
    scopedBridge({
      providers: [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")],
      launch: async (command) => planOrReview(command),
      records: [historical],
    });
    render(<App />);
    // The reloaded record auto-selects and renders its persistent facts…
    expect(await screen.findByText("All authorized model turns were used, so this stopped.", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/Codex could not run its tools on this machine, so this stopped for it\./)).toBeTruthy();
    expect(screen.getByText("Step not completed")).toBeTruthy();
    expect(screen.queryByText("A harness failed")).toBeNull();
    // …without any transient authorization state.
    expect(screen.queryByRole("button", { name: "Allow more turns" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop allowing" })).toBeNull();
    expect(screen.queryByText(/authorized model turns left/)).toBeNull();
  });

  it("keeps Send again without working alongside the panel", async () => {
    const bridge = scopedBridge({
      providers: [usableHarness("codex", "Codex"), usableHarness("claude", "Claude"), usableHarness("grok", "Grok")],
      launch: async (command, call) => {
        const id = command.modelSelection.instanceId;
        const envFailure = {
          text: "",
          errorText: "This harness cannot run its tools on this machine, so this stopped.",
          dispatched: true,
          environmentBlocked: true,
          environmentDetail: "helper exploded",
        };
        if ((id === "codex" && call === 1) || (id === "claude" && call === 2)) return envFailure;
        return planOrReview(command);
      },
    });
    render(<App />);
    await openDraftWithPanel();
    typeMessage("plan the helper");
    sendMessage();
    // Both planners failed; the round stops without a third launch.
    await waitFor(() => expect(bridge.launchCount()).toBe(2));
    expect(await screen.findByText(/an independent check needs two harnesses that can run\./)).toBeTruthy();
    const again = await screen.findByRole("button", { name: /send again without claude/i });
    fireEvent.click(again);
    expect(await screen.findByText(/This send will not use Claude/)).toBeTruthy();
    sendMessage();
    await waitFor(() => expect(bridge.launchCount()).toBe(4));
    expect(bridge.launched.slice(2).map((item) => item.instanceId)).toEqual(["codex", "grok"]);
    expect(await screen.findByText("Can be carried out", { selector: "dd" })).toBeTruthy();
  });

  function consentToChanges() {
    fireEvent.change(screen.getByRole("textbox", { name: "Project folder" }), { target: { value: "/work/goal" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow changes through Codex" }));
    typeMessage("Fix the helper and check the changes.");
  }
  const writeProviders = () => [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")];
  function writeRound(command: { commandId: string }, call: number): Record<string, unknown> {
    const text = command.commandId.includes("-execute-") ? "Changed helper.ts and its test."
      : command.commandId.includes("-audit-") ? "Checked helper.ts independently.\nVERDICT: verified"
      : command.commandId.includes("-plan-") ? PLAN_TEXT : CHECK_TEXT;
    return { text, errorText: "", dispatched: true, turnsRemaining: 4 - (call >= 3 ? call - 1 : call), writeTurnsRemaining: call >= 3 ? 1 : 2 };
  }

  it("starts write consent off and sends exactly the legacy read authorization when off", async () => {
    const bridge = scopedBridge({ providers: writeProviders(), launch: async (command) => planOrReview(command) });
    render(<App />); await openDraftWithPanel();
    expect((screen.getByRole("checkbox", { name: "Allow changes through Codex" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("spinbutton", { name: "Write turns to allow" }) as HTMLInputElement).value).toBe("2");
    typeMessage("Only plan."); sendMessage();
    await screen.findByText("Can be carried out", { selector: "dd" });
    expect(bridge.authorizations).toEqual([{ instances: ["codex", "claude"], maxTurns: 4 }]);
    expect(bridge.launchCount()).toBe(2);
    expect(screen.getByText(/No harness is allowed to change files/)).toBeTruthy();
  });

  it("requires a workspace and explains unavailable write members without selecting them", async () => {
    scopedBridge({ providers: [usableHarness("codex", "Codex"), { ...usableHarness("claude", "Claude"), auth: { status: "authenticated", type: "apiKey" } }], launch: async () => ({ text: "", errorText: "" }) });
    render(<App />); await openDraftWithPanel();
    fireEvent.change(screen.getByRole("textbox", { name: "Project folder" }), { target: { value: "" } });
    expect((screen.getByRole("checkbox", { name: "Allow changes through Codex" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Allow changes through Claude" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Choose a project folder before allowing/)).toBeTruthy();
  });

  it("passes the bound actual scope and both literal counters through a full engine/normalizer round", async () => {
    const bridge = scopedBridge({ providers: writeProviders(), launch: async (command, call) => writeRound(command, call) });
    render(<App />); await openDraftWithPanel(); consentToChanges(); sendMessage();
    await screen.findByText("Changes verified", { selector: "dd" });
    expect(bridge.authorizations).toEqual([{ instances: ["codex", "claude"], maxTurns: 4, write: { instances: ["codex"], maxTurns: 2, workspaceRoot: "/work/goal" } }]);
    expect(bridge.launchArgs).toHaveLength(4);
    expect(bridge.launchArgs.every((args) => args.length === 3 && args[2] === 1)).toBe(true);
    expect(bridge.launched.map((item) => item.commandId.split("-")[1])).toEqual(["plan", "review", "execute", "audit"]);
    expect(bridge.launched[2].instanceId).not.toBe(bridge.launched[3].instanceId);
    expect(bridge.saved[0]).toMatchObject({ verdict: "verified", executionText: "Changed helper.ts and its test.", auditText: "Checked helper.ts independently.\nVERDICT: verified", messageDispatched: true });
    expect(bridge.saved[0]).not.toHaveProperty("authorizedWriteTurnsLeft");
    expect(screen.getByText("1 of 2 write turns left.")).toBeTruthy();
    expect(screen.getByRole("article", { name: "Independent verification result" })).toBeTruthy();
  });

  it.each(["missing", "generation", "root", "members", "budget"])("refuses a %s actual write scope before any transport", async (kind) => {
    const bridge = scopedBridge({ providers: writeProviders(), launch: async (command, call) => writeRound(command, call), readScope: (scope, call) => {
      if (call === 1) return null;
      if (kind === "missing") return null;
      const write = scope!.write as Record<string, unknown>;
      return { ...scope, ...(kind === "generation" ? { generation: 88 } : {}), write: { ...write,
        ...(kind === "root" ? { workspaceRoot: "/different" } : {}),
        ...(kind === "members" ? { instances: ["claude"] } : {}),
        ...(kind === "budget" ? { remaining: 0 } : {}),
      } };
    } });
    render(<App />); await openDraftWithPanel(); consentToChanges(); sendMessage();
    await screen.findByText(/Workspace-change access changed or was stopped/);
    expect(bridge.launchCount()).toBe(0); expect(bridge.saved).toHaveLength(0);
  });

  it("clears write consent on root changes and never silently expands an invalid budget", async () => {
    const bridge = scopedBridge({ providers: writeProviders(), launch: async (command) => planOrReview(command) });
    render(<App />); await openDraftWithPanel(); consentToChanges();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Write turns to allow" }), { target: { value: "0" } });
    sendMessage(); await waitFor(() => expect(bridge.authorizations).toHaveLength(0));
    expect((screen.getByRole("spinbutton", { name: "Write turns to allow" }) as HTMLInputElement).value).toBe("0");
    fireEvent.change(screen.getByRole("textbox", { name: "Project folder" }), { target: { value: "/another/root" } });
    expect((screen.getByRole("checkbox", { name: "Allow changes through Codex" }) as HTMLInputElement).checked).toBe(false);
  });

  it("retains partial write failure without replay and without claiming verification", async () => {
    const bridge = scopedBridge({ providers: writeProviders(), launch: async (command, call) => call === 3
      ? { text: "Changed helper.ts; test unfinished.", errorText: "Write stopped midway.", dispatched: true, turnsRemaining: 2, writeTurnsRemaining: 1 }
      : writeRound(command, call) });
    render(<App />); await openDraftWithPanel(); consentToChanges(); sendMessage();
    await screen.findByText("Failed", { selector: "dd" });
    expect(screen.getByText("Changed helper.ts; test unfinished.")).toBeTruthy();
    expect(screen.getByText(/inspect any partial changes before sending again/)).toBeTruthy();
    expect(bridge.launchCount()).toBe(3); expect(bridge.saved[0]).toMatchObject({ verdict: "failed", executionText: "Changed helper.ts; test unfinished.", messageDispatched: true, auditText: null });
    expect(screen.queryByText("Changes verified")).toBeNull();
  });

  it("keeps actual execution and verification on screen when final save fails, never unsent", async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const bridge = scopedBridge({ providers: writeProviders(), launch: async (command, call) => writeRound(command, call), save: (record, call) => {
      if (call === 2) throw new Error("disk full");
      return saveCoordinationRecordForTest(persisted, record);
    }, records: () => Promise.resolve(persisted) });
    render(<App />); await openDraftWithPanel(); consentToChanges(); sendMessage();
    await screen.findByText(/could not be saved for the next time/);
    expect(screen.getByText("Changes verified", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("Changed helper.ts and its test.")).toBeTruthy();
    expect(screen.getByText(/Checked helper.ts independently/)).toBeTruthy();
    expect(persisted[0]).toMatchObject({ verdict: "unconfirmed", messageDispatched: true });
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    expect(bridge.launchCount()).toBe(4);
  });

  it("stops a write-authorized read-budget-2 round before edits with write budget untouched", async () => {
    const bridge = scopedBridge({ providers: writeProviders(), launch: async (command, call) => ({ ...writeRound(command, call), turnsRemaining: 2 - call, writeTurnsRemaining: 2 }) });
    render(<App />); await openDraftWithPanel(); consentToChanges();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Model turns to allow" }), { target: { value: "2" } });
    sendMessage(); await screen.findByText("Stopped", { selector: "dd" });
    expect(bridge.launchCount()).toBe(2); expect(bridge.saved[0].executionText).toBeNull();
    expect(screen.queryByText(/Files may have changed/)).toBeNull();
    expect(screen.queryByRole("article", { name: "Workspace changes result" })).toBeNull();
    expect(screen.getByText("2 of 2 write turns left.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  });

  it.each([null, "false", undefined])("does not reinterpret unknown dispatch %s or null budgets on write failure", async (dispatch) => {
    const bridge = scopedBridge({ providers: writeProviders(), launch: async (command, call) => call === 3
      ? { text: "Partial changes.", errorText: "Unknown outcome.", dispatched: dispatch, turnsRemaining: null, writeTurnsRemaining: null }
      : writeRound(command, call) });
    render(<App />); await openDraftWithPanel(); consentToChanges(); sendMessage();
    await screen.findByText("Failed", { selector: "dd" });
    expect(bridge.launchCount()).toBe(3);
    expect(screen.getByText("Unknown of 2 write turns left.")).toBeTruthy();
    expect(bridge.saved[0].messageDispatched).not.toBe(false);
  });

  it("reloads verified optional fields through actual normalization without transient access controls", async () => {
    const record = normalizeCoordinationRecordForTest({ requestId: "historic-verified", workspacePath: "/work/goal", goal: "Fix helper.", planningHarness: "Codex", reviewHarness: "Claude", planText: PLAN_TEXT, reviewText: CHECK_TEXT, executionHarness: "Codex", auditHarness: "Claude", executionText: "Fixed helper.", auditText: "Checked independently.", result: "Checked independently.", verdict: "verified", stopReason: "Independent verification finished.", planningQuota: "available", reviewQuota: "available", messageDispatched: true, authorizedWriteTurnsLeft: 1 });
    scopedBridge({ providers: writeProviders(), launch: async () => ({ text: "", errorText: "" }), records: [record!] });
    render(<App />); await screen.findByText("Changes verified", { selector: "dd" });
    expect(screen.getByText("Fixed helper.")).toBeTruthy();
    for (const name of ["Change", "Stop allowing", "Allow more turns"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByText(/write turns left/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /new goal/i })); await screen.findByRole("checkbox", { name: "Allow changes through Codex" });
    expect((screen.getByRole("checkbox", { name: "Allow changes through Codex" }) as HTMLInputElement).checked).toBe(false);
  });

  it("discards a replaced in-flight write result without saving a verified history or automatically retrying", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bridge = scopedBridge({ providers: writeProviders(), launch: async (command, call) => {
      if (call === 3) await gate;
      return writeRound(command, call);
    } });
    render(<App />); await openDraftWithPanel(); consentToChanges(); sendMessage();
    await screen.findByText("Codex is making changes…");
    fireEvent.click(screen.getByRole("button", { name: /new goal/i }));
    await screen.findByRole("checkbox", { name: "Allow changes through Codex" });
    release();
    await waitFor(() => expect(bridge.launchCount()).toBe(3));
    expect(bridge.saved).toHaveLength(1);
    expect(bridge.saved[0]).toMatchObject({ verdict: "unconfirmed", messageDispatched: true });
    expect(screen.queryByText("Changes verified")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "Allow changes through Codex" }) as HTMLInputElement).checked).toBe(false);
  });

  it("revoke clears both dimensions and a new draft never inherits previous write consent", async () => {
    const bridge = scopedBridge({ providers: writeProviders(), launch: async (command, call) => writeRound(command, call) });
    render(<App />); await openDraftWithPanel(); consentToChanges(); sendMessage();
    await screen.findByText("Changes verified", { selector: "dd" });
    fireEvent.click(screen.getByRole("button", { name: "Stop allowing" }));
    await waitFor(() => expect(screen.queryByText(/write turns left/)).toBeNull());
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    await openDraftWithPanel();
    expect((screen.getByRole("checkbox", { name: "Allow changes through Codex" }) as HTMLInputElement).checked).toBe(false);
    typeMessage("Only plan again."); sendMessage();
    await waitFor(() => expect(bridge.authorizations).toHaveLength(2));
    expect(bridge.authorizations[1]).toEqual({ instances: ["codex", "claude"], maxTurns: 4 });
  });

// The one in-window corrective pass (C1): one authorization and one Send may
// run a second four-role chain after a completed revise; refusal, revocation,
// cancellation and save failures keep the first round honest.
describe("one in-window repair", () => {
  const repairProviders = () => [usableHarness("codex", "Codex"), usableHarness("claude", "Claude")];
  const FIRST_EXECUTION = "First executor: incomplete edit; the unchanged checks fail.";
  const CRITIQUE = "Read-only critique: the unchanged checks still fail.\nVERDICT: revise";
  const REPAIR_EXECUTION = "Corrective executor: repaired helper.ts; the unchanged checks pass.";
  const REPAIR_AUDIT = "Checked the repaired helper independently.\nVERDICT: verified";
  function repairRound(command: { commandId: string }, call: number): Record<string, unknown> {
    const corrective = call >= 5;
    const text = command.commandId.includes("-execute-")
      ? corrective ? REPAIR_EXECUTION : FIRST_EXECUTION
      : command.commandId.includes("-audit-")
        ? corrective ? REPAIR_AUDIT : CRITIQUE
        : command.commandId.includes("-plan-")
          ? corrective ? "Corrective plan for the observed failure." : PLAN_TEXT
          : CHECK_TEXT;
    // Six read turns and two write turns fund both chains exactly.
    return {
      text, errorText: "", dispatched: true,
      turnsRemaining: [5, 4, 4, 3, 2, 1, 1, 0][call - 1] ?? 0,
      writeTurnsRemaining: [2, 2, 1, 1, 1, 1, 0, 0][call - 1] ?? 0,
    };
  }
  function consentToRepairChanges() {
    fireEvent.change(screen.getByRole("textbox", { name: "Project folder" }), { target: { value: "/work/goal" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow changes through Codex" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow changes through Claude" }));
    typeMessage("Fix the helper and check the changes.");
  }

  it("runs both four-role chains from one authorization and one Send, retaining first-round facts", async () => {
    const saves: Array<{ record: Record<string, unknown>; atLaunches: number }> = [];
    const bridge = scopedBridge({
      providers: repairProviders(),
      launch: async (command, call) => repairRound(command, call),
      save: (record) => {
        saves.push({ record, atLaunches: bridge.launchCount() });
        return saveCoordinationRecordForTest(bridge.saved, record);
      },
    });
    render(<App />);
    await openDraftWithPanel();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Model turns to allow" }), { target: { value: "6" } });
    consentToRepairChanges();
    sendMessage();
    expect(await screen.findByText("Changes verified", { selector: "dd" })).toBeTruthy();
    // Exactly one authorization, exactly one Send, eight distinct turns.
    expect(bridge.authorizations).toHaveLength(1);
    expect(bridge.launchCount()).toBe(8);
    expect(bridge.launched.map((item) => item.commandId.split("-")[1])).toEqual([
      "plan", "review", "execute", "audit", "plan", "review", "execute", "audit",
    ]);
    expect(new Set(bridge.launched.map((item) => item.commandId)).size).toBe(8);
    // The first round was checkpointed with an honest unconfirmed repair intent
    // BEFORE the first corrective launch; the final save replaces it.
    expect(saves).toHaveLength(3);
    expect(saves[1]?.atLaunches).toBe(4);
    expect(saves[1]?.record).toMatchObject({ verdict: "revise", messageDispatched: true });
    expect(String(saves[1]?.record.stopReason)).toContain("being organized");
    expect(saves[2]?.atLaunches).toBe(8);
    expect(saves[2]?.record).toMatchObject({ verdict: "verified", messageDispatched: true });
    expect((saves[2]?.record.feedbackHistory as Array<Record<string, unknown>> | undefined)?.[0]).toMatchObject({ verdict: "revise" });
    // Both passes stay readable: the newest result once, the first pass folded.
    expect(screen.getByText(/organized one checked repair with the remaining access/)).toBeTruthy();
    expect(screen.getByText(REPAIR_EXECUTION)).toBeTruthy();
    const retained = screen.getByText("Before automatic repair").closest("details") as HTMLDetailsElement;
    expect(retained.hasAttribute("open")).toBe(false);
    fireEvent.click(screen.getByText("Before automatic repair"));
    expect(retained.hasAttribute("open")).toBe(true);
    expect(screen.getByText(FIRST_EXECUTION)).toBeTruthy();
    expect(screen.getByText(/Read-only critique: the unchanged checks still fail\./)).toBeTruthy();
    expect(screen.getByText("0 of 6 authorized model turns left.")).toBeTruthy();
    expect(screen.getByText("0 of 2 write turns left.")).toBeTruthy();
  });

  it("a failed checkpoint sends no corrective turn and keeps the round non-retryable", async () => {
    const bridge = scopedBridge({
      providers: repairProviders(),
      launch: async (command, call) => repairRound(command, call),
      save: (record) => {
        if (String(record.stopReason).includes("being organized")) throw new Error("disk full");
        return saveCoordinationRecordForTest(bridge.saved, record);
      },
    });
    render(<App />);
    await openDraftWithPanel();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Model turns to allow" }), { target: { value: "6" } });
    consentToRepairChanges();
    sendMessage();
    await waitFor(() => expect(bridge.launchCount()).toBe(4));
    expect(await screen.findByText(/could not be saved/)).toBeTruthy();
    expect(await screen.findByText("Needs revision", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/could not confirm this window for the automatic repair/)).toBeTruthy();
    expect(screen.queryByText("Before automatic repair")).toBeNull();
    expect(bridge.saved.at(-1)).toMatchObject({ verdict: "revise", messageDispatched: true });
    // The completed-and-saved round replaces the draft: there is no send surface to retry from.
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("a scope that ended between the passes keeps the completed round and sends no repair", async () => {
    const bridge = scopedBridge({
      providers: repairProviders(),
      launch: async (command, call) => repairRound(command, call),
      readScope: (scope, call) => (call >= 3 ? null : scope),
    });
    render(<App />);
    await openDraftWithPanel();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Model turns to allow" }), { target: { value: "6" } });
    consentToRepairChanges();
    sendMessage();
    await waitFor(() => expect(bridge.launchCount()).toBe(4));
    expect(await screen.findByText("Needs revision", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/could not confirm this window for the automatic repair/)).toBeTruthy();
    expect(screen.getByText(/Read-only critique: the unchanged checks still fail\./)).toBeTruthy();
    expect(bridge.saved.at(-1)).toMatchObject({ verdict: "revise", messageDispatched: true });
  });

  it("leaving the draft during the repair keeps the checkpointed first round and sends no corrective writer", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bridge = scopedBridge({
      providers: repairProviders(),
      launch: async (command, call) => {
        if (call === 5) await gate;
        return repairRound(command, call);
      },
    });
    render(<App />);
    await openDraftWithPanel();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Model turns to allow" }), { target: { value: "6" } });
    consentToRepairChanges();
    sendMessage();
    // The checkpoint (verdict revise + repair intent) is on disk before the
    // first corrective launch; leaving the draft then cancels the repair.
    await waitFor(() => expect(bridge.saved.some((record) => String(record.stopReason).includes("being organized"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /new goal/i }));
    release();
    await waitFor(() => expect(bridge.launchCount()).toBe(5));
    // The replaced corrective outcome is not recorded; the checkpoint record
    // is the goal-level record and stays non-retryable.
    await waitFor(() => expect(bridge.saved.filter((record) => record.verdict !== "unconfirmed")).toHaveLength(1));
    expect(bridge.saved.at(-1)).toMatchObject({ verdict: "revise", messageDispatched: true });
    expect(screen.queryByText("Changes verified")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "Allow changes through Codex" }) as HTMLInputElement).checked).toBe(false);
  });

  it("a final-save failure keeps both passes visible and the goal non-retryable", async () => {
    const bridge = scopedBridge({
      providers: repairProviders(),
      launch: async (command, call) => repairRound(command, call),
      save: (record) => {
        if (record.verdict === "verified") throw new Error("disk full");
        return saveCoordinationRecordForTest(bridge.saved, record);
      },
    });
    render(<App />);
    await openDraftWithPanel();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Model turns to allow" }), { target: { value: "6" } });
    consentToRepairChanges();
    sendMessage();
    expect(await screen.findByText(/could not be saved for the next time/)).toBeTruthy();
    expect(screen.getByText("Changes verified", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(REPAIR_EXECUTION)).toBeTruthy();
    expect(screen.getByText("Before automatic repair")).toBeTruthy();
    expect(bridge.launchCount()).toBe(8);
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reloads a repaired record as facts only: retained first pass, no live controls, write consent off", async () => {
    const record = normalizeCoordinationRecordForTest({
      requestId: "historic-repair", workspacePath: "/work/goal", goal: "Fix the helper.",
      planningHarness: "Codex", reviewHarness: "Claude", planText: "Corrective plan.", reviewText: CHECK_TEXT,
      executionHarness: "Codex", auditHarness: "Claude", executionText: REPAIR_EXECUTION, auditText: REPAIR_AUDIT,
      result: REPAIR_AUDIT, verdict: "verified", stopReason: "The independent harness verified the changes, so this stopped.",
      planningQuota: "available", reviewQuota: "available", messageDispatched: true,
      feedbackHistory: [{
        planningHarness: "Codex", reviewHarness: "Claude", planText: PLAN_TEXT, reviewText: CHECK_TEXT,
        executionText: FIRST_EXECUTION, auditText: CRITIQUE, executionHarness: "Codex", auditHarness: "Claude",
        result: CRITIQUE, verdict: "revise", stopReason: "The independent verification says the changes need revision, so this stopped.",
        messageDispatched: true, roundEvents: [], commandIds: ["coordinate-plan-a", "coordinate-review-b", "coordinate-execute-c", "coordinate-audit-d"],
      }],
    });
    scopedBridge({ providers: repairProviders(), launch: async () => ({ text: "", errorText: "" }), records: [record!] });
    render(<App />);
    expect(await screen.findByText("Changes verified", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/organized one checked repair with the remaining access/)).toBeTruthy();
    expect(screen.getByText("Before automatic repair")).toBeTruthy();
    for (const name of ["Change", "Stop allowing", "Allow more turns"]) expect(screen.queryByRole("button", { name })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /new goal/i }));
    await screen.findByRole("checkbox", { name: "Allow changes through Codex" });
    expect((screen.getByRole("checkbox", { name: "Allow changes through Codex" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("spinbutton", { name: "Model turns to allow" }) as HTMLInputElement).value).toBe("4");
  });

  it("carries a terminal execution-audit revision into a fresh draft without sending or write consent", async () => {
    // The completed C2-style record: revise verdict from the execution audit
    // with no repair (budget), so Revise must carry execution feedback.
    const record = normalizeCoordinationRecordForTest({
      requestId: "budget-stopped", workspacePath: "/work/goal", goal: "Fix the helper.",
      planningHarness: "Codex", reviewHarness: "Claude", planText: PLAN_TEXT, reviewText: CHECK_TEXT,
      executionHarness: "Codex", auditHarness: "Claude", executionText: FIRST_EXECUTION, auditText: CRITIQUE,
      result: CRITIQUE, verdict: "revise",
      stopReason: "The independent verification says the changes need revision, so this stopped. There is not enough access left for one more checked repair, which needs three model turns and one write turn. GoalPort did not add turns.",
      planningQuota: "available", reviewQuota: "available", messageDispatched: true,
    });
    scopedBridge({ providers: repairProviders(), launch: async (command) => planOrReview(command), records: [record!] });
    render(<App />);
    expect(await screen.findByText("Needs revision", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/not enough access left for one more checked repair/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    expect(await screen.findByText(/Continuing from a completed execution round/)).toBeTruthy();
    expect(screen.getByText(/The independent audit said:/)).toBeTruthy();
    expect(screen.getByText(/file changes need separate consent again/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Allow changes through Codex" }) as HTMLInputElement).checked).toBe(false);
  });
  describe("C2 explicit background integration", () => {
    const liveJob = {
      jobId: "same-job", requestId: "same-send", goal: "One independent goal", state: "running" as const,
      live: true, active: true, revoked: false, workerPid: 42, readMaxTurns: 4, writeMaxTurns: null,
      counters: { readTurnsLeft: 3, writeTurnsLeft: null }, completedCommands: [], pendingCommand: null,
      progress: { activity: "Claude is checking…", failures: [] }, outcome: null,
    };
    it("default off Send routes one explicit read-only Start without main authorization or renderer launch", async () => {
      const bridge = scopedBridge({ providers: repairProviders(), launch: async command => planOrReview(command) });
      let status: typeof liveJob | null = null;
      const start = vi.fn(async (_input: import("./coordination/backgroundJob").BackgroundJobStartInput) => { status = liveJob; return liveJob; });
      window.goalportCore!.backgroundStart = start;
      window.goalportCore!.backgroundStatus = async () => status;
      render(<App />); await openDraftWithPanel();
      const background = screen.getByRole("checkbox", { name: "Keep working after closing" });
      expect((background as HTMLInputElement).checked).toBe(false);
      typeMessage("Plan this helper"); fireEvent.click(background); sendMessage();
      await screen.findByRole("region", { name: "Background goal" });
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[0].backgroundConsent).toBe(true);
      expect(start.mock.calls[0]?.[0].write).toBeUndefined();
      expect(bridge.authorizations).toHaveLength(0); expect(bridge.launchCount()).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "Leave job view" }));
      expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: /new goal/i }));
      await screen.findByRole("checkbox", { name: "Keep working after closing" });
      expect((screen.getByRole("checkbox", { name: "Keep working after closing" }) as HTMLInputElement).checked).toBe(false);
      expect((screen.getByRole("checkbox", { name: "Allow changes through Codex" }) as HTMLInputElement).checked).toBe(false);
      expect(start).toHaveBeenCalledTimes(1);
    });
    it("a lost background Start reply writes no competing ordinary record and is not retryable", async () => {
      const bridge = scopedBridge({ providers: repairProviders(), launch: async command => planOrReview(command) });
      window.goalportCore!.backgroundStart = async () => { throw new Error("Background admission could not be confirmed."); };
      window.goalportCore!.backgroundStatus = async () => null;
      render(<App />); await openDraftWithPanel(); typeMessage("One Send only");
      fireEvent.click(screen.getByRole("checkbox", { name: "Keep working after closing" })); sendMessage();
      await screen.findByText("Background admission could not be confirmed.");
      expect(bridge.saved).toHaveLength(0); expect(bridge.authorizations).toHaveLength(0); expect(bridge.launchCount()).toBe(0);
      expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    });
    it("reattaches and navigates without dispatch, draft mutation or restoring history access", async () => {
      const bridge = scopedBridge({ providers: repairProviders(), launch: async command => planOrReview(command) });
      const start = vi.fn();
      window.goalportCore!.backgroundStart = start;
      window.goalportCore!.backgroundStatus = async () => liveJob;
      render(<App />);
      await screen.findByRole("region", { name: "Background goal" });
      expect(screen.getByText(/running on its own/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /new goal/i }));
      await screen.findByRole("checkbox", { name: "Keep working after closing" });
      typeMessage("my untouched draft");
      const composer = screen.getByRole("textbox", { name: "Message composer" }); composer.focus();
      await new Promise(resolve => setTimeout(resolve, 800));
      expect((composer as HTMLTextAreaElement).value).toBe("my untouched draft"); expect(document.activeElement).toBe(composer);
      fireEvent.click(screen.getByRole("button", { name: "Return to background goal" }));
      expect(await screen.findByRole("region", { name: "Background goal" })).toBeTruthy();
      expect(start).not.toHaveBeenCalled(); expect(bridge.authorizations).toHaveLength(0); expect(bridge.launchCount()).toBe(0);
    });
    it("unreachable control is unconfirmed and offers no historical Stop allowing or resend", async () => {
      const bridge = scopedBridge({ providers: repairProviders(), launch: async command => planOrReview(command) });
      window.goalportCore!.backgroundStatus = async () => ({ ...liveJob, live: false, state: "unconfirmed" });
      render(<App />);
      await screen.findByText(/Progress unavailable or interrupted/);
      expect(screen.queryByText(/The harnesses you allowed are working on it now/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Stop allowing" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
      expect(bridge.authorizations).toHaveLength(0); expect(bridge.launchCount()).toBe(0);
    });
    it("Stop allowing uses the acknowledged job connection only and retains current evidence", async () => {
      scopedBridge({ providers: repairProviders(), launch: async command => planOrReview(command) });
      let job = { ...liveJob };
      const revoke = vi.fn(async () => { job = { ...job, revoked: true }; return job; });
      window.goalportCore!.backgroundStatus = async () => job;
      window.goalportCore!.backgroundRevoke = revoke;
      render(<App />); await screen.findByRole("region", { name: "Background goal" });
      fireEvent.click(screen.getByRole("button", { name: "Stop allowing" }));
      expect(await screen.findByText(/Access stopped. The current turn may finish/)).toBeTruthy();
      expect(revoke).toHaveBeenCalledWith("same-job");
    });
  });

});
});

describe("unsuccessful coordination events", () => {
  const base = {
    planningHarness: "Codex",
    reviewHarness: "Claude",
    planText: "Replace the subtraction.",
    reviewText: "The plan can be carried out.",
    verdict: "failed" as const,
    stopReason: "Access stopped; the current turn may finish, but no further turn was sent.",
    planningQuota: "unknown" as const,
    reviewQuota: "unknown" as const,
    result: null,
  };

  it("does not blame a harness when access was stopped", () => {
    render(<CoordinationStatus {...base} roundEvents={[{ kind: "failed", role: "execution", instanceId: "codex", harness: "Codex", sentence: "Access stopped; the current turn may finish, but no further turn was sent.", detail: "revoked before the next launch" }]} />);
    expect(screen.getByText("Step not completed")).toBeTruthy();
    expect(screen.getAllByText("Access stopped; the current turn may finish, but no further turn was sent.").length).toBeGreaterThan(0);
    expect(screen.queryByText("A harness failed")).toBeNull();
    expect(screen.getByText("revoked before the next launch")).toBeTruthy();
  });

  it("keeps a genuine tool failure specific without calling it a harness malfunction", () => {
    render(<CoordinationStatus {...base} stopReason="Codex could not run its tools on this machine, so this stopped for it." roundEvents={[{ kind: "failed", role: "planning", instanceId: "codex", harness: "Codex", sentence: "Codex could not run its tools on this machine, so this stopped for it.", detail: "helper exploded" }]} />);
    expect(screen.getByText("Step not completed")).toBeTruthy();
    expect(screen.getAllByText(/Codex could not run its tools on this machine/).length).toBeGreaterThan(0);
    expect(screen.getByText("helper exploded")).toBeTruthy();
    expect(screen.queryByText("A harness failed")).toBeNull();
  });

  it("keeps takeover separate from an incomplete step", () => {
    render(<CoordinationStatus {...base} roundEvents={[
      { kind: "failed", role: "planning", instanceId: "codex", harness: "Codex", sentence: "Codex could not run its tools on this machine, so this stopped for it." },
      { kind: "continued", role: "planning", instanceId: "claude", harness: "Claude", sentence: "Claude took over the planning step." },
    ]} />);
    expect(screen.getByText("Step not completed")).toBeTruthy();
    expect(screen.getByText("Took over")).toBeTruthy();
    expect(screen.getByText("Claude took over the planning step.")).toBeTruthy();
  });

  it("shows a stopped background result without reconstructing stop or send controls", () => {
    const start = vi.fn();
    render(<BackgroundCoordinationStatus job={{
      jobId: "same-job", requestId: "one-send", goal: "Repair the fixture.", state: "stopped", active: false, live: false, revoked: true,
      workerPid: 42, readMaxTurns: 6, writeMaxTurns: 2, counters: { readTurnsLeft: 4, writeTurnsLeft: 1 }, pendingCommand: null, completedCommands: [],
      progress: null,
      outcome: { status: "stopped", report: { ...base, roundEvents: [{ kind: "failed", role: "execution", instanceId: "codex", harness: "Codex", sentence: "Access stopped; the current turn may finish, but no further turn was sent." }] } },
    }} onStopAllowing={start} />);
    expect(screen.getByText(/Access stopped. The current turn may finish/)).toBeTruthy();
    expect(screen.getByText("Step not completed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop allowing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});
