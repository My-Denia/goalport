import { ReactNode, useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import type { RuntimeProfile } from "../types";
import { supportStatusLabel } from "../lib/display";

interface RuntimePickerMenuProps {
  runtimes: RuntimeProfile[];
  /** Selected provider id; empty when nothing is chosen yet. */
  selectedId: string;
  /** Content of the trigger button (avatar, labels, chevron). */
  triggerContent: ReactNode;
  triggerClassName?: string;
  triggerAriaLabel: string;
  triggerTitle?: string;
  emptyText: string;
  /** Optional hint row rendered at the bottom of the open menu. */
  blockedHint?: string | null;
  isItemDisabled?: (runtime: RuntimeProfile) => boolean;
  onSelect: (provider: string) => void;
  /** Bumped by the app to open the menu and focus the trigger (Session details → Change Runtime). */
  focusSignal?: number;
}

/**
 * The one and only Runtime picker menu (AGENTS.md §4: one component, one
 * place). The draft composer and the conversation composer previously each
 * maintained a hand-rolled copy of this floating layer — open state, document
 * mousedown listeners, Escape listeners. All of that now comes from Base UI:
 * collision-aware positioning (no more popup misplaced at window edges),
 * outside-press and Escape close, and focus handling.
 *
 * The popup is portaled to document.body by Base UI. The packaged-GUI smoke
 * driver therefore looks options up document-wide (`.runtime-picker-list
 * .runtime-picker-item`), not relative to the trigger root.
 */
export function RuntimePickerMenu({
  runtimes,
  selectedId,
  triggerContent,
  triggerClassName,
  triggerAriaLabel,
  triggerTitle,
  emptyText,
  blockedHint = null,
  isItemDisabled,
  onSelect,
  focusSignal
}: RuntimePickerMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!focusSignal || focusSignal <= 0) return;
    setOpen(true);
    triggerRef.current?.focus();
  }, [focusSignal]);

  return (
    <Popover.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <Popover.Trigger
        ref={triggerRef}
        className={triggerClassName}
        aria-label={triggerAriaLabel}
        title={triggerTitle}
      >
        {triggerContent}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} collisionPadding={10}>
          <Popover.Popup className="runtime-picker-list" role="listbox" aria-label="Runtimes">
          {runtimes.length === 0 ? <p className="runtime-picker-empty">{emptyText}</p> : null}
          {runtimes.map((candidate) => (
            <button
              key={candidate.id}
              className="runtime-picker-item"
              type="button"
              role="option"
              aria-selected={selectedId.trim().toLowerCase() === candidate.id.toLowerCase()}
              disabled={isItemDisabled ? isItemDisabled(candidate) : false}
              onClick={() => {
                setOpen(false);
                onSelect(candidate.id);
              }}
            >
              <span className={`provider-avatar provider-${candidate.id}`} aria-hidden="true">{candidate.name[0]}</span>
              <span className="runtime-picker-copy">
                <strong>{candidate.name}</strong>
                <small>{candidate.subtitle}</small>
              </span>
              <span className={`support-chip support-${candidate.support}`}>
                {supportStatusLabel(candidate)}
              </span>
            </button>
          ))}
          {blockedHint ? <p className="runtime-picker-hint">{blockedHint}</p> : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
