import type { ReactNode } from "react";
import { GoalLayer } from "./GoalLayer";

interface GoalDialogProps {
  label: string;
  className: string;
  onDismiss: () => void;
  children: ReactNode;
}

/** Modal card on the one dialog primitive. Does not own a second Dialog.Root. */
export function GoalDialog({ label, className, onDismiss, children }: GoalDialogProps) {
  return (
    <GoalLayer
      variant="dialog"
      open
      modalCard
      label={label}
      popupClassName={className}
      onOpenChange={(open) => { if (!open) onDismiss(); }}
    >
      {children}
    </GoalLayer>
  );
}
