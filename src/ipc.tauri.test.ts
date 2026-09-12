// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_SNAPSHOT } from "./types";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { getCoreClient, resetCoreClientForTests, type CoreCommand } from "./ipc";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function lastCoreCommandRequest(): CoreCommand {
  const calls = invokeMock.mock.calls.filter(([command]) => command === "core_command");
  const args = calls.at(-1)?.[1] as { request?: CoreCommand } | undefined;
  if (!args?.request) throw new Error("expected a core_command invoke");
  return args.request;
}

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
    delete window.__GOALPORT_ISOLATED;
    delete window.__goalportCommandTrace;
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

  it("omits the display placeholder Attempt id from select_runtime", async () => {
    const client = getCoreClient();
    expect(client.selectRuntime).toBeTypeOf("function");
    await client.snapshot();
    await client.selectRuntime!("scenario", "campaign-a", "task-a", "attempt-unassigned");

    const request = lastCoreCommandRequest();
    expect(request).toEqual(expect.objectContaining({
      messageType: "select_runtime",
      payload: { provider: "scenario", campaignId: "campaign-a", taskId: "task-a" }
    }));
    expect(request.payload.attemptId).toBeUndefined();
  });

  it("forwards a persisted Attempt id on select_runtime", async () => {
    const client = getCoreClient();
    expect(client.selectRuntime).toBeTypeOf("function");
    await client.snapshot();
    await client.selectRuntime!("scenario", "campaign-a", "task-a", "attempt-codex-executor-1");

    expect(lastCoreCommandRequest().payload).toEqual({
      provider: "scenario",
      campaignId: "campaign-a",
      taskId: "task-a",
      attemptId: "attempt-codex-executor-1"
    });
  });

  it("keeps the current snapshot and connection when Core refuses select_runtime", async () => {
    const client = getCoreClient();
    expect(client.selectRuntime).toBeTypeOf("function");
    const before = await client.snapshot();

    invokeMock.mockResolvedValueOnce({
      goalportRejected: true,
      error: "attempt attempt-codex-executor-1 is already bound to a different Runtime binding; the existing Runtime is kept and the request is refused"
    });
    const after = await client.selectRuntime!("claude", before.activeCampaignId, before.activeTask.id, before.attempt.id);

    expect(after.connection).toBe(before.connection);
    expect(after.attempt.id).toBe(before.attempt.id);
    expect(after.notices[0]).toMatch(/^Core refused:/);
  });

  it("attaches the exact accepted command identity from a raw UiCommandResult", async () => {
    const client = getCoreClient();
    await client.snapshot();
    invokeMock.mockImplementationOnce(async (_command, args: { request: CoreCommand }) => ({
      requestId: args.request.requestId,
      duplicate: false,
      accepted: true,
      snapshot: { ...DEMO_SNAPSHOT, buildId: "ack-build" }
    }));

    const after = await client.sendMessage("one", DEMO_SNAPSHOT.activeCampaignId, DEMO_SNAPSHOT.attempt.id, DEMO_SNAPSHOT.activeTask.id);

    expect(after.buildId).toBe("ack-build");
    expect(after.commandOutcome).toEqual(expect.objectContaining({
      kind: "accepted",
      messageType: "send_message",
      duplicate: false
    }));
    expect(after.commandOutcome?.requestId).toBe(lastCoreCommandRequest().requestId);
  });

  it("fails closed when a command response carries a different request identity", async () => {
    const client = getCoreClient();
    await client.snapshot();
    invokeMock.mockResolvedValueOnce({
      requestId: "some-other-request",
      duplicate: false,
      accepted: true,
      snapshot: DEMO_SNAPSHOT
    });

    const after = await client.selectCampaign!(DEMO_SNAPSHOT.activeCampaignId);

    expect(after.connection).toBe("disconnected");
    expect(after.commandOutcome).toEqual(expect.objectContaining({
      kind: "transport-error",
      messageType: "select_campaign",
      error: expect.stringMatching(/identity did not match/)
    }));
  });

  it("does not let a snapshot started before a mutation overwrite its command result", async () => {
    const client = getCoreClient();
    await client.snapshot();
    const stale = deferred<unknown>();
    const selected = {
      ...DEMO_SNAPSHOT,
      activeCampaignId: "campaign-selected",
      campaigns: [
        ...DEMO_SNAPSHOT.campaigns,
        { ...DEMO_SNAPSHOT.campaigns[0], id: "campaign-selected", title: "Selected later" }
      ]
    };
    invokeMock.mockImplementationOnce(() => stale.promise);
    const stalePoll = client.snapshot();
    invokeMock.mockImplementationOnce(async (_command, args: { request: CoreCommand }) => ({
      requestId: args.request.requestId,
      duplicate: false,
      accepted: true,
      snapshot: selected
    }));
    const select = client.selectCampaign!("campaign-selected");
    const selectedResult = await select;
    stale.resolve(DEMO_SNAPSHOT);
    const staleResult = await stalePoll;

    expect(selectedResult.activeCampaignId).toBe("campaign-selected");
    expect(staleResult.activeCampaignId).toBe("campaign-selected");
  });

  it("does not start a poll while a command is pending", async () => {
    const client = getCoreClient();
    await client.snapshot();
    const pending = deferred<unknown>();
    invokeMock.mockImplementationOnce(() => pending.promise);
    const command = client.selectCampaign!(DEMO_SNAPSHOT.activeCampaignId);
    await Promise.resolve();
    const callsBeforePoll = invokeMock.mock.calls.length;

    const during = client.snapshot();

    expect(invokeMock.mock.calls.length).toBe(callsBeforePoll);
    const request = lastCoreCommandRequest();
    pending.resolve({ requestId: request.requestId, duplicate: false, accepted: true, snapshot: DEMO_SNAPSHOT });
    await command;
    expect((await during).activeCampaignId).toBe(DEMO_SNAPSHOT.activeCampaignId);
  });

  it("serializes successive selection mutations in user-issued order", async () => {
    window.__GOALPORT_ISOLATED = 1;
    const client = getCoreClient();
    await client.snapshot();
    const first = deferred<unknown>();
    const campaignA = { ...DEMO_SNAPSHOT, activeCampaignId: "campaign-a" };
    const campaignB = { ...DEMO_SNAPSHOT, activeCampaignId: "campaign-b" };
    invokeMock.mockImplementationOnce(() => first.promise);
    invokeMock.mockImplementationOnce(async (_command, args: { request: CoreCommand }) => ({
      requestId: args.request.requestId,
      duplicate: false,
      accepted: true,
      snapshot: campaignB
    }));

    const selectA = client.selectCampaign!("campaign-a");
    const selectB = client.selectCampaign!("campaign-b");
    await Promise.resolve();
    expect(invokeMock.mock.calls.filter(([command]) => command === "core_command")).toHaveLength(1);
    expect(window.__goalportCommandTrace?.map((entry) => [entry.phase, entry.messageType])).toEqual([
      ["issued", "select_campaign"],
      ["issued", "select_campaign"]
    ]);
    const firstRequest = lastCoreCommandRequest();
    first.resolve({ requestId: firstRequest.requestId, duplicate: false, accepted: true, snapshot: campaignA });
    await selectA;
    const resultB = await selectB;

    expect(resultB.activeCampaignId).toBe("campaign-b");
    const requests = invokeMock.mock.calls
      .filter(([command]) => command === "core_command")
      .map(([, args]) => (args as { request: CoreCommand }).request.payload.campaignId);
    expect(requests).toEqual(["campaign-a", "campaign-b"]);
    expect(window.__goalportCommandTrace?.map((entry) => entry.phase)).toEqual([
      "issued", "issued", "settled", "settled"
    ]);
  });

  it("keeps the isolated command trace capped and excludes message text", async () => {
    window.__GOALPORT_ISOLATED = 1;
    window.__goalportCommandTrace = Array.from({ length: 64 }, (_, index) => ({
      phase: "settled" as const,
      requestId: `old-${index}`,
      messageType: "snapshot",
      kind: "accepted" as const
    }));
    const client = getCoreClient();
    await client.snapshot();
    await client.sendMessage("secret prompt text", DEMO_SNAPSHOT.activeCampaignId, DEMO_SNAPSHOT.attempt.id, DEMO_SNAPSHOT.activeTask.id);

    expect(window.__goalportCommandTrace).toHaveLength(64);
    expect(window.__goalportCommandTrace?.at(-2)).toEqual(expect.objectContaining({
      phase: "issued",
      messageType: "send_message",
      campaignId: DEMO_SNAPSHOT.activeCampaignId,
      taskId: DEMO_SNAPSHOT.activeTask.id,
      attemptId: DEMO_SNAPSHOT.attempt.id
    }));
    expect(window.__goalportCommandTrace?.[0].requestId).toBe("old-2");
    expect(JSON.stringify(window.__goalportCommandTrace)).not.toContain("secret prompt text");
  });

  it("preserves the existing timeline when reconnect returns only events after the cursor", async () => {
    const client = getCoreClient();
    const before = await client.snapshot();
    const delta = {
      ...before,
      timeline: [{
        id: "timeline-reconnect-new",
        kind: "recovery",
        actor: "Core",
        title: "UI reconnected",
        body: "No prompt replay",
        timestamp: "now"
      }],
      cursor: before.cursor + 1
    };
    invokeMock.mockImplementationOnce(async (_command, args: { request: CoreCommand }) => ({
      requestId: args.request.requestId,
      duplicate: false,
      accepted: true,
      snapshot: delta
    }));

    const after = await client.reconnect();

    expect(after.timeline.map((item) => item.id)).toEqual([
      ...before.timeline.map((item) => item.id),
      "timeline-reconnect-new"
    ]);
    expect(after.cursor).toBe(before.cursor + 1);
  });
});
