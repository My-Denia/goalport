// @vitest-environment jsdom
// Session details migrated from an Escape-only hand-rolled drawer to the
// shared GoalLayer drawer: the panel keeps its element, classes and facts,
// Escape still closes it, and an outside click still leaves it open.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDetails } from "./SessionDetails";
import { DEMO_SNAPSHOT } from "../types";

afterEach(cleanup);

function mountDetails(open: boolean, onClose = vi.fn()) {
  render(
    <SessionDetails
      open={open}
      onClose={onClose}
      snapshot={DEMO_SNAPSHOT}
      product={DEMO_SNAPSHOT.productConversation}
      onChangeRuntime={vi.fn()}
      onOpenHandoff={vi.fn()}
      onCloseSession={vi.fn()}
      onResumeSession={vi.fn()}
      onOpenWorkspaceFolder={vi.fn()}
    />
  );
  return { onClose };
}

describe("Session details drawer", () => {
  it("Escape closes it", async () => {
    const { onClose } = mountDetails(true);
    const panel = document.querySelector(".inspector");
    expect(panel).not.toBeNull();
    fireEvent.keyDown(panel as HTMLElement, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an outside click is normal app interaction, not a dismissal", async () => {
    const { onClose } = mountDetails(true);
    fireEvent.pointerDown(document.body);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".inspector")).not.toBeNull();
  });

  it("keeps its element, open class and smoke-driver marker while open", () => {
    mountDetails(true);
    const panel = document.querySelector(".inspector");
    expect(panel?.classList.contains("inspector-open")).toBe(true);
    expect(panel?.getAttribute("data-open")).toBe("true");
    expect(panel?.getAttribute("aria-label")).toBe("Session details");
    expect(screen.getByRole("heading", { name: "Session details" })).toBeTruthy();
    expect(screen.getByText("Workspace")).toBeTruthy();
  });

  it("leaves the DOM when closed", async () => {
    const { rerender } = render(
      <SessionDetails
        open
        onClose={vi.fn()}
        snapshot={DEMO_SNAPSHOT}
        product={null}
        onChangeRuntime={vi.fn()}
        onOpenHandoff={vi.fn()}
        onCloseSession={vi.fn()}
        onResumeSession={vi.fn()}
        onOpenWorkspaceFolder={vi.fn()}
      />
    );
    expect(document.querySelector(".inspector")).not.toBeNull();
    rerender(
      <SessionDetails
        open={false}
        onClose={vi.fn()}
        snapshot={DEMO_SNAPSHOT}
        product={null}
        onChangeRuntime={vi.fn()}
        onOpenHandoff={vi.fn()}
        onCloseSession={vi.fn()}
        onResumeSession={vi.fn()}
        onOpenWorkspaceFolder={vi.fn()}
      />
    );
    await waitFor(() => expect(document.querySelector(".inspector")).toBeNull());
  });
});
