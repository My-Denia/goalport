import { Dialog } from "@base-ui/react/dialog";
import { useLayoutEffect, useRef, type ReactNode } from "react";

interface GoalDialogProps {
  label: string;
  className: string;
  onDismiss: () => void;
  children: ReactNode;
}

/** One modal shell owns focus trapping, Escape, outside press and restoration. */
export function GoalDialog({ label, className, onDismiss, children }: GoalDialogProps) {
  const restoreRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useLayoutEffect(() => () => {
    const previous = restoreRef.current;
    if (previous?.isConnected) queueMicrotask(() => previous.focus());
  }, []);
  const focusWhenMounted = (popup: HTMLDivElement | null) => {
    if (!popup || popup.contains(document.activeElement)) return;
    (popup.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), button:not([disabled])") ?? popup).focus();
  };
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-scrim" />
        <Dialog.Viewport className="dialog-backdrop">
          <Dialog.Popup ref={focusWhenMounted} finalFocus={() => restoreRef.current} className={`first-run-dialog ${className}`} aria-label={label}>
            {children}
            <Dialog.Close className="dialog-sr-close" aria-label="Dismiss dialog">Dismiss</Dialog.Close>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
