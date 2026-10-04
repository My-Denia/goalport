import { useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Drawer } from "@base-ui/react/drawer";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";

/**
 * The one floating-layer wrapper (AGENTS.md §4: one component, one copy).
 * Base UI owns every layer behavior this app previously hand-rolled per call
 * site: open/close state with a reason, Escape dismissal, outside-press
 * dismissal, focus trapping, focus restoration and popup positioning. Callers
 * render content and triggers only.
 *
 * - "menu" / "popover": anchored to a trigger, portaled to document.body,
 *   non-modal by default (click-outside closes; the page keeps working).
 * - "dialog": modal by default (focus trap + scroll lock; scrim only when a
 *   Dialog.Backdrop is rendered inside the children).
 * - "drawer": a plain always-anchored panel, non-modal by default. Outside
 *   presses do NOT close it and focus is never moved (matching the side
 *   panels' contract: Escape or their explicit close button); pass
 *   `modal` to opt into trap-focus behavior.
 */

export type GoalLayerVariant = "menu" | "popover" | "dialog" | "drawer";

/** Why the layer changed its open state. Base UI's close reasons, verbatim, plus this wrapper's own open reason. */
export type GoalLayerReason =
  | "trigger-press"
  | "outside-press"
  | "escape-key"
  | "close-press"
  | "focus-out"
  | "item-press"
  | "imperative-action"
  | "focus-signal"
  | "none";

export interface GoalLayerPlacement {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Gap between trigger and surface, in px. */
  sideOffset?: number;
  /** Viewport padding kept when the surface would collide, in px. */
  collisionPadding?: number;
}

export interface GoalLayerProps {
  variant: GoalLayerVariant;
  /**
   * Controlled open state. Omit to let the layer manage its own state
   * (opened by its trigger, closed by Base UI dismissal rules).
   */
  open?: boolean;
  onOpenChange?: (open: boolean, reason?: GoalLayerReason) => void;
  /** Accessible name of the floating surface. */
  label: string;
  /**
   * Trigger element for menu/popover layers. The layer merges toggle
   * behavior and aria state into it (Base UI `render` prop semantics);
   * pass presentation only — never an onClick or aria-expanded of your own.
   */
  trigger?: ReactElement;
  /** menu/popover placement around the trigger. Defaults below, end-aligned, 6px away. */
  placement?: GoalLayerPlacement;
  /**
   * dialog/drawer: scrim + focus trap + scroll lock when true, plain panel
   * when false. Defaults true for "dialog", false for everything else.
   */
  modal?: boolean;
  /**
   * dialog/drawer: element the popup renders as, so a caller keeps its own
   * element type and classes (e.g. the inspector `<aside>`).
   */
  surface?: ReactElement;
  /** dialog/drawer: where focus lands on open. `false` never moves focus. */
  initialFocus?: boolean | RefObject<HTMLElement | null>;
  /** Bumped by the app to open the layer and focus its trigger (menu/popover). */
  focusSignal?: number;
  /** menu/popover: class for the positioned box (our CSS convention styles the positioner). */
  positionerClassName?: string;
  children: ReactNode;
}

interface BaseUIOpenChangeDetails {
  reason?: string;
}

function useResolvedOpen(open: boolean | undefined) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  return { isOpen, setInternalOpen };
}

export function GoalLayer({
  variant,
  open,
  onOpenChange,
  label,
  trigger,
  placement,
  modal,
  surface,
  initialFocus,
  focusSignal,
  positionerClassName,
  children
}: GoalLayerProps) {
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const isControlledRef = useRef(open !== undefined);
  isControlledRef.current = open !== undefined;
  const { isOpen, setInternalOpen } = useResolvedOpen(open);

  useEffect(() => {
    if (!focusSignal || focusSignal <= 0) return;
    if (!isControlledRef.current) setInternalOpen(true);
    // The focus-signal open arrives out-of-band (no Base UI event), so it is
    // reported directly to the caller. The layer opens ready for keyboard
    // use: Base UI moves focus into the popup (menu items) and returns it to
    // the trigger on close — the same contract as the Runtime picker.
    onOpenChangeRef.current?.(true, "focus-signal");
  }, [focusSignal, setInternalOpen]);

  const handleOpenChange = (next: boolean, details: BaseUIOpenChangeDetails) => {
    if (!isControlledRef.current) setInternalOpen(next);
    onOpenChangeRef.current?.(next, details.reason as GoalLayerReason | undefined);
  };

  const openChangeProps = { open: isOpen, onOpenChange: handleOpenChange };

  if (variant === "menu" || variant === "popover") {
    const Root = variant === "menu" ? Menu.Root : Popover.Root;
    const Trigger = variant === "menu" ? Menu.Trigger : Popover.Trigger;
    const Portal = variant === "menu" ? Menu.Portal : Popover.Portal;
    const Positioner = variant === "menu" ? Menu.Positioner : Popover.Positioner;
    const Popup = variant === "menu" ? Menu.Popup : Popover.Popup;
    // `right: auto` keeps Floating UI's inline `left` from stretching the box:
    // the app's positioner classes also carry a legacy `right: 0` rule.
    const positionerStyle = { right: "auto" };
    return (
      <Root {...openChangeProps} modal={modal ?? false}>
        {trigger ? <Trigger render={trigger} /> : null}
        <Portal>
          <Positioner
            side={placement?.side ?? "bottom"}
            align={placement?.align ?? "end"}
            sideOffset={placement?.sideOffset ?? 6}
            collisionPadding={placement?.collisionPadding ?? 8}
            className={positionerClassName}
            style={positionerStyle}
          >
            <Popup aria-label={label}>{children}</Popup>
          </Positioner>
        </Portal>
      </Root>
    );
  }

  if (variant === "dialog") {
    return (
      <Dialog.Root {...openChangeProps} modal={modal ?? true}>
        {/* The portal fills the viewport so full-screen surfaces (the
            bootstrap sheet) size themselves with plain `height: 100%`. */}
        <Dialog.Portal style={{ height: "100%" }}>
          <Dialog.Popup
            aria-label={label}
            initialFocus={initialFocus}
            render={surface}
          >
            {children}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <Drawer.Root
      {...openChangeProps}
      modal={modal ?? false}
      // Plain drawers close on Escape and their explicit close button only —
      // an outside click is normal app interaction, not a dismissal.
      disablePointerDismissal={modal ? false : true}
    >
      <Drawer.Portal>
        <Drawer.Viewport>
          <Drawer.Popup
            aria-label={label}
            initialFocus={initialFocus ?? false}
            finalFocus={false}
            render={surface}
          >
            {children}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
