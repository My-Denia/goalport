import { ReactNode, useEffect, useRef, useState } from "react";
import { Select } from "@base-ui/react/select";
import type { RuntimeProfile } from "../types";

export interface RuntimeChoice {
  id: string;
  name: string;
  subtitle: string;
  /** Heading shown above the first row of each run of choices that share it. */
  group?: string;
  /** Visible as a row, never selectable; `subtitle` is the plain reason. */
  disabled?: boolean;
  /** One character for the row's round badge when the first letter of the name says nothing. */
  avatar?: string;
}

interface RuntimePickerMenuProps {
  runtimes: RuntimeProfile[];
  /** UI-only mode choices; not invented Core Runtime profiles. */
  choices?: RuntimeChoice[];
  /** Selected provider id; empty when nothing is chosen yet. */
  selectedId: string;
  /** Content of the trigger button (avatar, labels, chevron). */
  triggerContent: ReactNode;
  triggerClassName?: string;
  /** Set when the menu opens from inside a modal, so it stacks above the modal. */
  positionerClassName?: string;
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
  choices,
  selectedId,
  triggerContent,
  triggerClassName,
  positionerClassName,
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
  const items = choices ?? runtimes;
  const selectedItem = items.find((runtime) => runtime.id.toLowerCase() === selectedId.trim().toLowerCase());
  // A disabled row is never "the current choice"; otherwise the menu would open focused on a row that cannot be used.
  const selectedValue = selectedItem && !("disabled" in selectedItem && selectedItem.disabled) ? selectedItem.id : null;

  useEffect(() => {
    if (!focusSignal || focusSignal <= 0) return;
    setOpen(true);
    triggerRef.current?.focus();
  }, [focusSignal]);

  const sections: { label?: string; items: (RuntimeProfile | RuntimeChoice)[] }[] = [];
  for (const item of items) {
    const label = "group" in item ? item.group : undefined;
    const last = sections[sections.length - 1];
    if (last && last.label === label) last.items.push(item); else sections.push({ label, items: [item] });
  }
  const renderRow = (candidate: RuntimeProfile | RuntimeChoice) => {
    const runtime = runtimes.find(item => item.id === candidate.id);
    // Only rows from `choices` carry UI copy; a Runtime profile's own subtitle is Core-internal text.
    const choice = choices?.find(item => item.id === candidate.id);
    const choiceDisabled = choice !== undefined && "disabled" in choice && choice.disabled === true;
    const disabled = choiceDisabled || (runtime && isItemDisabled ? isItemDisabled(runtime) : false);
    const modeOnly = choice !== undefined && !runtime;
    return (
      <Select.Item
        key={candidate.id}
        value={candidate.id}
        label={candidate.name}
        className="runtime-picker-item"
        disabled={disabled}
        style={disabled ? { opacity: choiceDisabled ? 0.7 : 0.45, cursor: "not-allowed", pointerEvents: "none" } : undefined}
      >
        <span className={`provider-avatar ${modeOnly ? "provider-unassigned" : `provider-${candidate.id}`}`} aria-hidden="true">{choice?.avatar ?? candidate.name[0]}</span>
        <span className="runtime-picker-copy">
          <strong>{candidate.id === "scenario" ? "Demo run" : candidate.name}</strong>
          {runtime?.support === "unsupported" ? <small>Not available on this computer</small> : null}
          {candidate.id === "scenario" ? <small>No AI, changes nothing</small> : choice?.subtitle ? <small className={choiceDisabled ? "runtime-picker-reason" : undefined}>{choice.subtitle}</small> : null}
        </span>
      </Select.Item>
    );
  };

  return (
    <Select.Root value={selectedValue} open={open} onOpenChange={setOpen}
      onValueChange={(value) => {
        if (value === null) return;
        if (choices?.find((choice) => choice.id === value)?.disabled) return;
        onSelect(value);
      }}>
      <Select.Trigger
        ref={triggerRef}
        className={triggerClassName}
        aria-label={triggerAriaLabel}
        title={triggerTitle}
      >
        {triggerContent}
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className={positionerClassName} sideOffset={6} collisionPadding={10} alignItemWithTrigger={false}>
          <Select.Popup className="runtime-picker-list">
            <Select.List aria-label="Runtimes" style={{ display: "grid", gap: 2 }}>
              {sections.map((section, index) => {
                const rows = section.items.map((candidate) => renderRow(candidate));
                return section.label
                  ? <Select.Group key={`${section.label}-${index}`} style={{ display: "grid", gap: 2 }}>
                      <Select.GroupLabel className="runtime-picker-group">{section.label}</Select.GroupLabel>
                      {rows}
                    </Select.Group>
                  : rows;
              })}
            </Select.List>
            {!items.some(item => runtimes.some(runtime => runtime.id === item.id)) ? <p className="runtime-picker-empty">{emptyText}</p> : null}
            {blockedHint ? <p className="runtime-picker-hint">{blockedHint}</p> : null}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
