// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { RuntimePickerMenu } from "./ui/RuntimePickerMenu";
import { DEMO_SNAPSHOT } from "./types";

afterEach(cleanup);

function Picker({ onSelect = vi.fn(), disabledId, initialSelected = "" }: { onSelect?: (id: string) => void; disabledId?: string; initialSelected?: string }) {
  const [selected, setSelected] = useState(initialSelected);
  return <RuntimePickerMenu
    runtimes={DEMO_SNAPSHOT.runtimes}
    selectedId={selected}
    triggerContent={selected || "Choose a Runtime"}
    triggerAriaLabel="Select Runtime"
    emptyText="No Runtimes"
    isItemDisabled={(runtime) => runtime.id === disabledId}
    onSelect={(id) => { setSelected(id); onSelect(id); }}
  />;
}

describe("shared Runtime picker keyboard contract", () => {
  it("retains selection when Core spells the provider with different case", async () => {
    render(<Picker initialSelected="CODEX" />);
    fireEvent.click(screen.getByRole("combobox", { name: "Select Runtime" }));
    const codex = await screen.findByRole("option", { name: /Codex/ });
    expect(codex.getAttribute("aria-selected")).toBe("true");
  });

  it("moves with arrows and Home/End, commits with Enter, and returns focus to its trigger", async () => {
    const selected = vi.fn();
    render(<Picker onSelect={selected} />);
    const trigger = screen.getByRole("combobox", { name: "Select Runtime" });
    fireEvent.click(trigger);
    const listbox = await screen.findByRole("listbox", { name: "Runtimes" });
    const claude = screen.getByRole("option", { name: /Claude Code/ });
    const codex = screen.getByRole("option", { name: /Codex/ });
    const grok = screen.getByRole("option", { name: /Grok/ });
    expect(listbox.contains(claude)).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(claude));
    fireEvent.keyDown(claude, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(codex));
    fireEvent.keyDown(codex, { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(grok));
    fireEvent.keyDown(grok, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(claude));
    fireEvent.keyDown(claude, { key: "ArrowDown" });
    fireEvent.keyDown(codex, { key: "Enter" });
    await waitFor(() => expect(selected).toHaveBeenCalledWith("codex"));
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("does not commit a disabled choice and Escape dismisses without selecting", async () => {
    const selected = vi.fn();
    render(<Picker onSelect={selected} disabledId="codex" />);
    const trigger = screen.getByRole("combobox", { name: "Select Runtime" });
    fireEvent.click(trigger);
    const claude = await screen.findByRole("option", { name: /Claude Code/ });
    const codex = screen.getByRole("option", { name: /Codex/ });
    const grok = screen.getByRole("option", { name: /Grok/ });
    await waitFor(() => expect(document.activeElement).toBe(claude));
    fireEvent.keyDown(claude, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(codex));
    expect(codex.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(codex, { key: "Enter" });
    expect(selected).not.toHaveBeenCalled();
    fireEvent.keyDown(codex, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(grok));
    fireEvent.keyDown(grok, { key: "Escape" });
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(selected).not.toHaveBeenCalled();
  });
});
