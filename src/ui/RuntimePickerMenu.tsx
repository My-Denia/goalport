import { ReactNode, useEffect, useRef, useState } from "react";
import { Select } from "@base-ui/react/select";
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
 * maintained a hand-rolled copy of this floating layer. Base UI Select owns
 * listbox focus, arrow/Home/End navigation, activation, dismissal, and popup
 * positioning. The chosen Runtime remains controlled by the caller.
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
  const selectedValue = runtimes.find((runtime) => runtime.id.toLowerCase() === selectedId.trim().toLowerCase())?.id ?? null;

  useEffect(() => {
    if (!focusSignal || focusSignal <= 0) return;
    setOpen(true);
    triggerRef.current?.focus();
  }, [focusSignal]);

  return (
    <Select.Root value={selectedValue} open={open} onOpenChange={setOpen}
      onValueChange={(value) => { if (value) onSelect(value); }}>
      <Select.Trigger
        ref={triggerRef}
        className={triggerClassName}
        aria-label={triggerAriaLabel}
        title={triggerTitle}
      >
        {triggerContent}
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} collisionPadding={10} alignItemWithTrigger={false}>
          <Select.Popup className="runtime-picker-list">
            <Select.List aria-label="Runtimes" style={{ display: "grid", gap: 2 }}>
              {runtimes.map((candidate) => {
                const disabled = isItemDisabled ? isItemDisabled(candidate) : false;
                return (
                  <Select.Item
                    key={candidate.id}
                    value={candidate.id}
                    label={candidate.name}
                    className="runtime-picker-item"
                    disabled={disabled}
                    style={disabled ? { opacity: 0.45, cursor: "not-allowed", pointerEvents: "none" } : undefined}
                  >
                    <span className={`provider-avatar provider-${candidate.id}`} aria-hidden="true">{candidate.name[0]}</span>
                    <span className="runtime-picker-copy">
                      <strong>{candidate.name}</strong>
                      <small>{candidate.subtitle}</small>
                    </span>
                    <span className={`support-chip support-${candidate.support}`}>
                      {supportStatusLabel(candidate)}
                    </span>
                  </Select.Item>
                );
              })}
            </Select.List>
            {runtimes.length === 0 ? <p className="runtime-picker-empty">{emptyText}</p> : null}
            {blockedHint ? <p className="runtime-picker-hint">{blockedHint}</p> : null}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
