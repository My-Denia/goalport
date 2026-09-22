// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeHistoryPageIntoSnapshot, mergeSnapshotHistory, type HistoryPage } from "./ipc";
import { ProductConversationView, coalesceVisibleFragments } from "./conversation/ProductConversationView";
import { useScrollAnchor, visibleConversationSignature } from "./lib/useScrollAnchor";
import { HISTORY_WINDOW_ADVANCED_NOTICE, DEMO_SNAPSHOT, type CoreSnapshot, type ProductConversationItem } from "./types";

afterEach(cleanup);

function snapshot(items: ProductConversationItem[], olderCursor: string | null = "older-2"): CoreSnapshot {
  return {
    ...DEMO_SNAPSHOT,
    productConversation: {
      ...DEMO_SNAPSHOT.productConversation!,
      items,
      pageInfo: {
        olderCursor,
        newerCursor: "newest-1",
        hasOlder: true,
        hasNewer: false,
        contentBytes: 100,
        itemCount: items.length
      }
    }
  };
}

describe("bounded history pages", () => {
  it("prepends an exclusive older page without duplicating the cursor boundary", () => {
    const current = snapshot([
      { id: "fragment-2", logicalItemId: "answer", fragmentIndex: 1, continuesBefore: true, kind: "assistant-message", body: "world" },
      { id: "error-1", kind: "actionable-error", body: "closed" }
    ]);
    const page: HistoryPage = {
      scope: "conversation",
      ownerId: current.activeCampaignId,
      conversationItems: [
        { id: "fragment-1", logicalItemId: "answer", fragmentIndex: 0, continuesAfter: true, kind: "assistant-message", body: "hello " },
        { id: "fragment-2", logicalItemId: "answer", fragmentIndex: 1, continuesBefore: true, kind: "assistant-message", body: "stale duplicate" }
      ],
      pageInfo: { olderCursor: null, newerCursor: "fragment-2", hasOlder: false, hasNewer: true, contentBytes: 90, itemCount: 2 }
    };
    const merged = mergeHistoryPageIntoSnapshot(current, page);
    expect(merged.productConversation?.items.map((item) => item.id)).toEqual(["fragment-1", "fragment-2", "error-1"]);
    expect(merged.productConversation?.items[1].body).toBe("world");
    expect(merged.productConversation?.pageInfo?.hasOlder).toBe(false);
  });

  it("keeps loaded history while accepting a newer polling fragment", () => {
    const loaded = snapshot([
      { id: "old", kind: "user-message", body: "old" },
      { id: "live", kind: "assistant-message", body: "partial" }
    ], null);
    loaded.loadedHistory = { conversationOwnerId: loaded.activeCampaignId };
    const polled = snapshot([
      { id: "live", kind: "assistant-message", body: "partial + tail" },
      { id: "new", kind: "actionable-error", body: "closed" }
    ]);
    const merged = mergeSnapshotHistory(loaded, polled);
    expect(merged.productConversation?.items.map((item) => [item.id, item.body])).toEqual([
      ["old", "old"],
      ["live", "partial + tail"],
      ["new", "closed"]
    ]);
  });

  it("resets to the authoritative recent page when the loaded and polled ranges are disjoint", () => {
    const loaded = snapshot([
      { id: "old-1", kind: "user-message", body: "old" },
      { id: "old-2", kind: "assistant-message", body: "old answer" }
    ], "old-anchor");
    loaded.loadedHistory = { conversationOwnerId: loaded.activeCampaignId };
    const advanced = snapshot([
      { id: "new-1", kind: "user-message", body: "new" },
      { id: "new-2", kind: "assistant-message", body: "new answer" }
    ], "new-anchor");
    const merged = mergeSnapshotHistory(loaded, advanced);
    expect(merged.productConversation?.items.map((item) => item.id)).toEqual(["new-1", "new-2"]);
    expect(merged.productConversation?.pageInfo?.olderCursor).toBe("new-anchor");
    expect(merged.loadedHistory?.conversationOwnerId).toBeUndefined();
    expect(merged.notices).toContain(HISTORY_WINDOW_ADVANCED_NOTICE);
  });

  it("does not accumulate evicted recent pages that the reader never loaded", () => {
    const prior = snapshot([{ id: "evicted", kind: "user-message", body: "old tail" }]);
    const next = snapshot([{ id: "current", kind: "assistant-message", body: "current tail" }]);
    expect(mergeSnapshotHistory(prior, next).productConversation?.items.map((item) => item.id)).toEqual(["current"]);
  });

  it("coalesces adjacent UTF-8 fragments for display and exposes Load earlier", () => {
    const items: ProductConversationItem[] = [
      { id: "f0", logicalItemId: "m1", fragmentIndex: 0, continuesAfter: true, kind: "assistant-message", body: "你好 " },
      { id: "f1", logicalItemId: "m1", fragmentIndex: 1, continuesBefore: true, kind: "assistant-message", body: "🌏" }
    ];
    expect(coalesceVisibleFragments(items)).toEqual([
      expect.objectContaining({ logicalItemId: "m1", body: "你好 🌏" })
    ]);
    const onLoad = vi.fn();
    render(<ProductConversationView product={snapshot(items).productConversation!} onLoadEarlier={onLoad} />);
    expect(screen.getByText("你好 🌏")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("does not concatenate a logical message across a missing physical fragment", () => {
    const visible = coalesceVisibleFragments([
      { id: "f0", logicalItemId: "m1", fragmentIndex: 0, continuesAfter: true, kind: "assistant-message", body: "begin" },
      { id: "f2", logicalItemId: "m1", fragmentIndex: 2, continuesBefore: true, kind: "assistant-message", body: "end" }
    ]);
    expect(visible.map((item) => [item.id, item.body])).toEqual([
      ["f0", "begin"],
      ["f2", "end"]
    ]);
  });

  it("discards an in-flight older page when its requested anchor is stale", () => {
    const advanced = snapshot([{ id: "new", kind: "user-message", body: "new" }], "new-anchor");
    const stalePage: HistoryPage = {
      scope: "conversation",
      ownerId: advanced.activeCampaignId,
      conversationItems: [{ id: "stale-old", kind: "user-message", body: "stale old" }],
      pageInfo: { olderCursor: "older", newerCursor: "old-anchor", hasOlder: true, hasNewer: true, contentBytes: 80, itemCount: 1 }
    };
    const discarded = mergeHistoryPageIntoSnapshot(advanced, stalePage, "old-anchor");
    expect(discarded.productConversation?.items.map((item) => item.id)).toEqual(["new"]);
    expect(discarded.productConversation?.pageInfo?.olderCursor).toBe("new-anchor");
    expect(discarded.notices).toContain(HISTORY_WINDOW_ADVANCED_NOTICE);
  });

  it("loads from the replacement anchor exactly once after a disjoint-window reset", () => {
    const recent = snapshot([{ id: "new", kind: "assistant-message", body: "new" }], "replacement-anchor");
    recent.notices = [HISTORY_WINDOW_ADVANCED_NOTICE, ...recent.notices];
    const page: HistoryPage = {
      scope: "conversation",
      ownerId: recent.activeCampaignId,
      conversationItems: [
        { id: "middle", kind: "assistant-message", body: "middle" },
        { id: "new", kind: "assistant-message", body: "stale boundary" }
      ],
      pageInfo: { olderCursor: "older-anchor", newerCursor: "replacement-anchor", hasOlder: true, hasNewer: true, contentBytes: 100, itemCount: 2 }
    };
    const loaded = mergeHistoryPageIntoSnapshot(recent, page, "replacement-anchor");
    expect(loaded.productConversation?.items.map((item) => [item.id, item.body])).toEqual([
      ["middle", "middle"],
      ["new", "new"]
    ]);
    expect(new Set(loaded.productConversation?.items.map((item) => item.id)).size).toBe(2);
    expect(loaded.loadedHistory?.conversationOwnerId).toBe(recent.activeCampaignId);
    expect(loaded.notices).not.toContain(HISTORY_WINDOW_ADVANCED_NOTICE);
  });

  it("preserves the visible scroll anchor when an older page is prepended", () => {
    function Probe({ items }: { items: ProductConversationItem[] }) {
      const anchor = useScrollAnchor("campaign", visibleConversationSignature(items));
      return (
        <div ref={anchor.ref} onScroll={anchor.handleScroll} data-testid="scroll">
          <button type="button" onClick={anchor.prepareForPrepend}>prepare</button>
          {items.map((item) => <div key={item.id}>{item.body}</div>)}
        </div>
      );
    }
    const recent = [{ id: "new", kind: "user-message" as const, body: "new" }];
    const rendered = render(<Probe items={recent} />);
    const scroller = screen.getByTestId("scroll") as HTMLElement;
    let height = 100;
    let top = 20;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 50 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    fireEvent.click(screen.getByRole("button", { name: "prepare" }));
    height = 300;
    rendered.rerender(<Probe items={[{ id: "old", kind: "user-message", body: "old" }, ...recent]} />);
    expect(top).toBe(220);
  });

  it("ignores a page for a stale owner", () => {
    const current = snapshot([{ id: "new", kind: "user-message", body: "new" }]);
    const stale: HistoryPage = {
      scope: "conversation",
      ownerId: "another-campaign",
      conversationItems: [{ id: "old", kind: "user-message", body: "old" }],
      pageInfo: { olderCursor: null, newerCursor: null, hasOlder: false, hasNewer: false, contentBytes: 2, itemCount: 1 }
    };
    expect(mergeHistoryPageIntoSnapshot(current, stale)).toBe(current);
  });
});
