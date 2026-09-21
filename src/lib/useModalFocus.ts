import { useEffect, useRef } from "react";

const FIELD_SELECTOR = "input:not([disabled]), textarea:not([disabled]), select:not([disabled])";
const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])"
].join(",");

/**
 * Modal dialog focus contract (WAI-ARIA dialog pattern):
 * - initial focus lands on the first text field when the dialog has one
 *   (otherwise the first focusable control) — never the close "×" button;
 * - Tab / Shift+Tab stay inside the dialog;
 * - Escape requests the cancel path (the component decides what cancel means —
 *   it never approves or submits anything);
 * - focus returns to the element that had it before the dialog opened.
 *
 * The listener attaches once per activation. `onCancel` is read through a ref
 * so parent re-renders (e.g. the snapshot poll) can never re-run this effect:
 * re-running it re-focused the first control on every poll cycle, which stole
 * focus from the field the user was typing in and ate keystrokes.
 */
export function useModalFocus(onCancel: () => void, active = true) {
  const ref = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!active) return undefined;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    if (dialog) {
      const field = dialog.querySelector<HTMLElement>(FIELD_SELECTOR);
      const first = field ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialog).focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const current = ref.current;
      if (!current) return;
      const items = Array.from(current.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus?.();
    };
  }, [active]);

  return ref;
}
