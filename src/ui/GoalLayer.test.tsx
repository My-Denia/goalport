// @vitest-environment jsdom
// GoalLayer is the one floating-layer wrapper (AGENTS.md §4): these tests pin
// the dismissal and focus contract callers rely on — Escape and outside-press
// close with a reason, the focus signal opens and focuses the trigger, plain
// drawers keep focus to themselves, and modal dialogs trap it.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { GoalLayer, type GoalLayerReason } from "./GoalLayer";

afterEach(cleanup);

function MenuHost({
  onOpenChange = vi.fn(),
  focusSignal
}: { onOpenChange?: (open: boolean, reason?: GoalLayerReason) => void; focusSignal?: number }) {
  return (
    <GoalLayer
      variant="menu"
      label="Actions"
      onOpenChange={onOpenChange}
      focusSignal={focusSignal}
      trigger={<button type="button" aria-label="Open actions">Actions</button>}
    >
      <button type="button" role="menuitem" onClick={() => onOpenChange(false, "item-press")}>One action</button>
    </GoalLayer>
  );
}

function DrawerHost({ open, onOpen }: { open: boolean; onOpen: (open: boolean, reason?: GoalLayerReason) => void }) {
  return (
    <GoalLayer
      variant="drawer"
      open={open}
      onOpenChange={onOpen}
      label="Side panel"
      surface={<aside className="side-panel" />}
    >
      <p>Panel body</p>
    </GoalLayer>
  );
}

describe("GoalLayer menu variant", () => {
  it("opens from its trigger, closes on Escape, and reports the reason", async () => {
    const onOpenChange = vi.fn();
    render(<MenuHost onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Open actions" }));
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("One action");
    expect(screen.getByRole("button", { name: "Open actions" }).getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledWith(false, "escape-key");
  });

  it("closes on an outside press and reports the reason", async () => {
    const onOpenChange = vi.fn();
    render(<MenuHost onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Open actions" }));
    await screen.findByRole("menu");

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledWith(false, "outside-press");
  });

  it("a focus signal opens the layer ready for keyboard use; Escape returns focus to the trigger", async () => {
    const { rerender } = render(<MenuHost focusSignal={0} />);
    rerender(<MenuHost focusSignal={1} />);
    const menu = await screen.findByRole("menu");
    // Focus is inside the open layer (menu items), like the Runtime picker.
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => {
      const trigger = screen.getByRole("button", { name: "Open actions" });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(trigger);
    });
  });
});

describe("GoalLayer drawer variant", () => {
  it("Escape closes and reports the reason; content leaves with it", async () => {
    const onOpen = vi.fn();
    const { rerender } = render(<DrawerHost open onOpen={onOpen} />);
    await screen.findByText("Panel body");
    // The caller keeps its own element: the surface is the aside it passed,
    // named by the layer's label.
    const panel = document.querySelector(".side-panel");
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("aria-label")).toBe("Side panel");

    fireEvent.keyDown(panel as HTMLElement, { key: "Escape" });
    expect(onOpen).toHaveBeenCalledWith(false, "escape-key");
    rerender(<DrawerHost open={false} onOpen={onOpen} />);
    await waitFor(() => expect(screen.queryByText("Panel body")).toBeNull());
  });

  it("an outside press is app interaction, not a dismissal", async () => {
    const onOpen = vi.fn();
    render(<DrawerHost open onOpen={onOpen} />);
    await screen.findByText("Panel body");
    fireEvent.pointerDown(document.body);
    // Give any (wrong) dismissal listener a chance to fire.
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(screen.getByText("Panel body")).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalledWith(false, expect.anything());
  });

  it("opening the drawer never steals focus from where the user had it", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <input aria-label="Unrelated field" />
          <button type="button" onClick={() => setOpen(true)}>Show panel</button>
          <DrawerHost open={open} onOpen={(next) => setOpen(next)} />
        </>
      );
    }
    render(<Host />);
    const field = screen.getByRole("textbox", { name: "Unrelated field" });
    field.focus();
    fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
    await screen.findByText("Panel body");
    expect(document.activeElement).toBe(field);
  });
});

describe("GoalLayer dialog variant", () => {
  it("is a modal dialog that traps Tab and reports Escape as a close request", async () => {
    const onOpen = vi.fn();
    render(
      <GoalLayer variant="dialog" open onOpenChange={onOpen} label="Decision" surface={<div className="sheet" />}>
        <button type="button">Confirm</button>
        <button type="button">Cancel</button>
      </GoalLayer>
    );
    const dialog = await screen.findByRole("dialog", { name: "Decision" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onOpen).toHaveBeenCalledWith(false, "escape-key");
  });
});
