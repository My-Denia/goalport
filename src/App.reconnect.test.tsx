// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ipc", async () => {
  const { DEMO_SNAPSHOT } = await import("./types");
  const disconnected = { ...DEMO_SNAPSHOT, connection: "disconnected" as const };
  return {
    getCoreClient: () => ({
      mode: "tauri" as const,
      snapshot: async () => disconnected,
      createCampaign: async () => disconnected,
      sendMessage: async () => disconnected,
      resolveDecision: async () => disconnected,
      reconnect: async () => disconnected,
      startCore: async () => disconnected,
      setConnection: async () => disconnected,
      openInVsCode: async () => undefined
    })
  };
});

import App from "./App";

describe("GoalPort reconnect evidence", () => {
  it("does not claim reconnection when the Core returns no usable projection", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /reconnect core/i }));

    expect(await screen.findByText(/Core connection remains unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/Reconnected from the Core projection/i)).toBeNull();
  });
});
