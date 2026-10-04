// @vitest-environment jsdom
// The title-bar application menu migrated from a hand-rolled popover to the
// shared GoalLayer menu: same labels, same actions, and dismissal (Escape,
// outside press) now owned by Base UI. These tests pin that contract.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleBar } from "./TitleBar";
import { DEMO_SNAPSHOT } from "../types";

afterEach(cleanup);

function mountTitleBar(overrides: Partial<Parameters<typeof TitleBar>[0]> = {}) {
  const spies = {
    onToggleNav: vi.fn(),
    onToggleDetails: vi.fn(),
    onOpenDiagnostics: vi.fn(),
    onNewGoal: vi.fn(),
    onOpenAbout: vi.fn(),
    onReconnect: vi.fn(),
    onCloseWindow: vi.fn()
  };
  render(
    <TitleBar
      snapshot={DEMO_SNAPSHOT}
      campaignTitle={null}
      appInfo={null}
      navCollapsed={false}
      detailsOpen={false}
      {...spies}
      {...overrides}
    />
  );
  return spies;
}

function menuButton() {
  return screen.getByRole("button", { name: "Application menu" });
}

async function openMenu() {
  fireEvent.click(menuButton());
  return screen.findByRole("menu");
}

describe("TitleBar application menu", () => {
  it("opens with every item labeled exactly as before", async () => {
    mountTitleBar();
    const menu = await openMenu();
    expect(menu.textContent).toContain("Details (Ctrl+I)");
    expect(menu.textContent).toContain("Developer diagnostics");
    expect(menu.textContent).toContain("About GoalPort");
    expect(menu.textContent).toContain("Close window");
  });

  it("Escape closes the menu", async () => {
    mountTitleBar();
    const menu = await openMenu();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("a click outside closes the menu", async () => {
    mountTitleBar();
    await openMenu();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("an item runs its action and closes the menu", async () => {
    const spies = mountTitleBar();
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "About GoalPort" }));
    expect(spies.onOpenAbout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("the Details item mirrors and toggles the panel state", async () => {
    const spies = mountTitleBar({ detailsOpen: true });
    await openMenu();
    const detailsItem = screen.getByRole("menuitemcheckbox", { name: /Details \(Ctrl\+I\)/ });
    expect(detailsItem.getAttribute("aria-checked")).toBe("true");
    expect(detailsItem.textContent).toBe("✓ Details (Ctrl+I)");
    fireEvent.click(detailsItem);
    expect(spies.onToggleDetails).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("Close window stays an explicit action, never accidental", async () => {
    const spies = mountTitleBar();
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close window" }));
    expect(spies.onCloseWindow).toHaveBeenCalledTimes(1);
  });

  it("renders every menu item as a button (packaged smoke contract)", () => {
    mountTitleBar();
    fireEvent.click(screen.getByRole("button", { name: "Application menu" }));
    const menu = document.querySelector("div[role='menu']");
    expect(menu).not.toBeNull();
    const close = menu!.querySelector("button[aria-label='Close window']");
    expect(close).not.toBeNull();
    for (const item of menu!.querySelectorAll(".app-menu-item")) {
      expect(item.tagName.toLowerCase()).toBe("button");
    }
  });
});

// Windows-packaged smoke regression (CI at f47ed95): menu items must remain
// <button> elements — the app's menus were always buttons and the packaged
// smoke drives div[role='menu'] button[aria-label='Close window']; Base UI's
// default menuitem div broke that contract silently on every query.
