// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_SNAPSHOT } from "./types";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { getCoreClient, resetCoreClientForTests } from "./ipc";

describe("connected Tauri Core command payloads", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(DEMO_SNAPSHOT);
    resetCoreClientForTests();
  });

  afterEach(() => {
    resetCoreClientForTests();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("sends an explicit one-time allow for the exact Decision id", async () => {
    const client = getCoreClient();
    await client.resolveDecision("native-request-7", true);

    expect(invokeMock).toHaveBeenCalledWith("core_command", {
      request: expect.objectContaining({
        messageType: "resolve_decision",
        payload: { decisionId: "native-request-7", allow: true }
      })
    });
  });

  it("keeps sequential Decision ids distinct across responses", async () => {
    const client = getCoreClient();
    await client.resolveDecision("native-request-7", false);
    await client.resolveDecision("native-request-8", true);

    const requests = invokeMock.mock.calls
      .filter(([command]) => command === "core_command")
      .map(([, args]) => args.request);
    expect(requests.map((request) => [request.payload.decisionId, request.payload.allow])).toEqual([
      ["native-request-7", false],
      ["native-request-8", true]
    ]);
  });

  it("surfaces a Core-side terminal-attempt refusal without forcing disconnected", async () => {
    const client = getCoreClient();
    const before = await client.snapshot();
    const connectionBefore = before.connection;

    invokeMock.mockResolvedValueOnce({
      goalportRejected: true,
      error: "attempt is terminal (CANCELLED); select a Runtime to start a new Attempt"
    });
    const after = await client.resolveDecision("native-request-9", true);

    expect(after.notices[0]).toMatch(/^Core refused:/);
    expect(after.connection).toBe(connectionBefore);
  });

  it("never reports a Core rejection itself as a disconnection, even right after a transport failure", async () => {
    // electron/main.cjs::invokeCore retries once on a genuine transport failure and, if that
    // retry surfaces a tagged Core rejection, must still return { goalportRejected, error } rather
    // than letting the rejection propagate as a thrown error. This renderer-side client cannot
    // observe that internal retry directly (TauriCoreClient.dispatch calls invoke() exactly once
    // per command), but the contract it depends on is: whichever call is the one that finally
    // surfaces a goalportRejected payload, that call must never itself be treated as a new
    // disconnection. We pin that by forcing a real transport failure first (which does flip
    // connection to "disconnected"), then delivering the tagged rejection on the very next call
    // and asserting it leaves connection exactly as it already was.
    const client = getCoreClient();
    await client.snapshot();

    invokeMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const afterTransportFailure = await client.resolveDecision("native-request-10", true);
    expect(afterTransportFailure.connection).toBe("disconnected");
    expect(afterTransportFailure.notices[0]).toMatch(/^Core request failed:/);

    const connectionBeforeRejection = afterTransportFailure.connection;
    invokeMock.mockResolvedValueOnce({
      goalportRejected: true,
      error: "attempt is terminal (CANCELLED); select a Runtime to start a new Attempt"
    });
    const afterRejection = await client.resolveDecision("native-request-11", true);

    expect(afterRejection.notices[0]).toMatch(/^Core refused:/);
    expect(afterRejection.connection).toBe(connectionBeforeRejection);
  });
});
