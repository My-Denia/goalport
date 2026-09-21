import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Measure-restore scroll anchoring for the conversation timeline.
 *
 * The container auto-scrolls to the latest event only while the reader is
 * pinned to (near) the bottom. When they have scrolled up, new events leave
 * scrollTop untouched and a jump affordance counts what they have not seen.
 * `resetKey` (e.g. the active campaign) re-pins to the bottom on view switch.
 *
 * CSS overflow-anchor alone is unreliable across full React list re-renders,
 * so the pin state is measured explicitly on every scroll event.
 */
export function useScrollAnchor(resetKey: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [unseenCount, setUnseenCount] = useState(0);

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

  /** Called by the owner whenever new content may have arrived. */
  const notifyContentChanged = useCallback(() => {
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

  return { ref, unseenCount, handleScroll, scrollToBottom, notifyContentChanged };
}
