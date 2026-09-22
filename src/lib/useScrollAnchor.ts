import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProductConversationItem } from "../types";

/**
 * Stable identity of the conversation content the reader can actually see.
 *
 * The owner compares this signature between snapshots instead of
 * `items.length`: a streaming assistant message grows its `body` while the
 * array length stays the same, and only a visible change may follow the
 * reader to the bottom or raise the unseen indicator. An identical poll (new
 * array identity, equal content) yields an equal signature and never
 * notifies.
 *
 * Only fields the normal surface renders participate: id, kind, body, actor
 * and the rendered commit timestamp. `actions` is never rendered by the
 * normal UI and `technicalDetails` sits behind a collapsed disclosure, so
 * changes to either are hidden metadata and must not count as new content.
 */
export function visibleConversationSignature(items: readonly ProductConversationItem[] | undefined): string {
  if (!items || items.length === 0) return "";
  let signature = String(items.length);
  for (const item of items) {
    signature += `\u001e${item.id}\u001f${item.kind}\u001f${item.body}\u001f${item.actor ?? ""}\u001f${item.timestamp ?? ""}`;
  }
  return signature;
}

/**
 * Measure-restore scroll anchoring for the conversation timeline.
 *
 * The container auto-scrolls to the latest content only while the reader is
 * pinned to (near) the bottom. When they have scrolled up, streaming updates
 * leave scrollTop untouched and a jump affordance counts what they have not
 * seen. `resetKey` (e.g. the active campaign) re-pins to the bottom on view
 * switch; the matching `contentSignature` baseline is adopted at the same
 * moment, so the switched-to view is never announced as new content.
 *
 * CSS overflow-anchor alone is unreliable across full React list re-renders,
 * so the pin state is measured explicitly on every scroll event.
 */
export function useScrollAnchor(resetKey: string, contentSignature?: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const pendingPrependRef = useRef<{ height: number; top: number; pinned: boolean } | null>(null);
  // What the reader has already been offered, together with the view it
  // belonged to. Null until the first snapshot after mount.
  const seenContentRef = useRef<{ resetKey: string; signature: string | undefined } | null>(null);

  const measurePinned = useCallback(() => {
    const element = ref.current;
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }, []);

  const handleScroll = useCallback(() => {
    const pinned = measurePinned();
    pinnedRef.current = pinned;
    if (pinned) setUnseenCount(0);
  }, [measurePinned]);

  const scrollToBottom = useCallback((smooth = true) => {
    const element = ref.current;
    if (!element) return;
    if (typeof element.scrollTo === "function") {
      element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    } else {
      element.scrollTop = element.scrollHeight;
    }
    pinnedRef.current = true;
    setUnseenCount(0);
  }, []);

  /** Capture geometry immediately before an older history page is prepended. */
  const prepareForPrepend = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    pendingPrependRef.current = {
      height: element.scrollHeight,
      top: element.scrollTop,
      pinned: pinnedRef.current
    };
  }, []);

  /** Called by the owner whenever new content may have arrived. */
  const notifyContentChanged = useCallback(() => {
    // pinnedRef reflects the reader's intent measured at the last scroll
    // event; re-measuring here after the content grew would misread a large
    // single growth as "scrolled away" and drop the follow.
    if (pinnedRef.current) {
      const element = ref.current;
      if (element) element.scrollTop = element.scrollHeight;
      setUnseenCount(0);
    } else {
      setUnseenCount((count) => count + 1);
    }
  }, []);

  // Re-pin on view switch (after the new content renders).
  useEffect(() => {
    pinnedRef.current = true;
    setUnseenCount(0);
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [resetKey]);

  // Streaming watcher: compares the visible-content signature and notifies on
  // real change. A layout effect runs after the DOM commits but before paint,
  // so a pinned reader is driven to the new bottom without a flicker at the
  // stale one, and the unseen indicator appears with the content atomically.
  useLayoutEffect(() => {
    const seen = seenContentRef.current;
    seenContentRef.current = { resetKey, signature: contentSignature };
    const prepend = pendingPrependRef.current;
    if (prepend) {
      pendingPrependRef.current = null;
      const element = ref.current;
      if (element) element.scrollTop = prepend.top + Math.max(0, element.scrollHeight - prepend.height);
      pinnedRef.current = prepend.pinned;
      return;
    }
    if (seen === null || seen.resetKey !== resetKey) {
      // First snapshot after mount, or a deliberate view (campaign) switch:
      // adopt what is on screen as the baseline. This content is not "new" —
      // the reader navigated to it — and must never raise the indicator.
      return;
    }
    if (seen.signature === contentSignature) {
      // Identical content (unchanged poll, unrelated re-render): silent.
      return;
    }
    notifyContentChanged();
  }, [resetKey, contentSignature, notifyContentChanged]);

  return { ref, unseenCount, handleScroll, scrollToBottom, notifyContentChanged, prepareForPrepend };
}
