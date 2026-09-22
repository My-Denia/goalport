// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { BootstrapScreen } from "./dialog/BootstrapScreen";
import type { CoreCommand } from "./ipc";
import { DEMO_SNAPSHOT, EMPTY_SNAPSHOT, type CoreSnapshot } from "./types";

afterEach(() => {
  cleanup();
  delete window.goalportCore;
  delete window.__GOALPORT_ELECTRON__;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function emptyDesktop(): CoreSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    connection: "connected",
    preview: false,
    projects: [DEMO_SNAPSHOT.project],
    selectedProjectId: DEMO_SNAPSHOT.project.id,
    project: DEMO_SNAPSHOT.project,
    runtimes: DEMO_SNAPSHOT.runtimes
  };
}

function mountElectron(snapshot: CoreSnapshot, command: (request: CoreCommand) => Promise<unknown>, extras: Record<string, unknown> = {}) {
  window.__GOALPORT_ELECTRON__ = true;
  window.goalportCore = {
    snapshot: async () => snapshot,
    command,
    startCore: async () => snapshot,
    openInVsCode: async () => undefined,
    ...extras
  } as never;
  return render(<App />);
}

async function fillFirstSend() {
  fireEvent.change(await screen.findByRole("textbox", { name: /project folder/i }), { target: { value: "C:\\work" } });
  fireEvent.change(screen.getByRole("textbox", { name: /message composer/i }), { target: { value: "inspect once" } });
  fireEvent.click(screen.getByRole("button", { name: /select runtime/i }));
  fireEvent.click(await screen.findByRole("option", { name: /codex/i }));
}

describe("review debt frontend contracts", () => {
  it("installs a reserved first-send snapshot before retrying the same start id", async () => {
    const initial = emptyDesktop();
    const reserved: CoreSnapshot = {
      ...DEMO_SNAPSHOT,
      preview: false,
      activeCampaignId: "campaign-reserved",
      campaigns: [{ ...DEMO_SNAPSHOT.campaigns[0], id: "campaign-reserved" }],
      activeTask: { ...DEMO_SNAPSHOT.activeTask, id: "task-reserved" },
      attempt: { ...DEMO_SNAPSHOT.attempt, id: "attempt-reserved", taskId: "task-reserved", state: "waiting" },
      productConversation: {
        ...DEMO_SNAPSHOT.productConversation!,
        items: [{ id: "reserved-message", kind: "user-message", body: "inspect once" }],
        turn: { state: "idle", canStop: false, canSend: false, reason: "Reserved before Runtime admission." }
      }
    };
    const requests: CoreCommand[] = [];
    const command = vi.fn(async (request: CoreCommand) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          goalportRejected: true,
          requestId: request.requestId,
          accepted: false,
          error: "Runtime admission failed",
          snapshot: reserved,
          rejection: {
            code: "admission-failed",
            message: "Runtime admission failed",
            deliveryState: "FAILED",
            nativeDispatchState: "NOT_STARTED",
            retryMode: "SAME_REQUEST",
            reservation: {
              kind: "first-send",
              requestId: request.requestId,
              campaignId: "campaign-reserved",
              taskId: "task-reserved",
              attemptId: "attempt-reserved",
              messageReserved: true
            }
          }
        };
      }
      return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: reserved };
    });
    mountElectron(initial, command);
    await fillFirstSend();
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByRole("heading", { name: /start a goal/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe("campaign-reserved");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.map((request) => request.messageType)).toEqual(["start_conversation", "start_conversation"]);
    expect(requests[1].requestId).toBe(requests[0].requestId);
    expect(requests[1].payload).toEqual(requests[0].payload);
  });

  it("keeps UNKNOWN reconciliation enabled with the same id through a capacity view", async () => {
    const base: CoreSnapshot = { ...DEMO_SNAPSHOT, preview: false };
    const capacity: CoreSnapshot = {
      ...base,
      campaigns: [],
      bounds: { truncated: true, projectionUnavailable: true, omittedCounts: { conversationItems: 10 } },
      productConversation: {
        ...base.productConversation!,
        turn: { state: "uncertain", canStop: false, canSend: false, reason: "Delivery remains unknown." }
      }
    };
    const requests: CoreCommand[] = [];
    const command = vi.fn(async (request: CoreCommand) => {
      requests.push(request);
      if (requests.length === 1) return {
        goalportRejected: true,
        requestId: request.requestId,
        accepted: false,
        error: "delivery remains unknown",
        snapshot: capacity,
        rejection: {
          code: "delivery-unknown",
          message: "delivery remains unknown",
          deliveryState: "UNKNOWN",
          nativeDispatchState: "UNKNOWN",
          retryMode: "RECONCILE",
          reservation: null
        }
      };
      return { requestId: request.requestId, accepted: true, duplicate: true, snapshot: capacity };
    });
    mountElectron(base, command);
    const composer = await screen.findByRole("textbox", { name: /message composer/i });
    fireEvent.change(composer, { target: { value: "only once" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    expect(await screen.findByRole("button", { name: "Check result" })).toBeTruthy();
    expect(screen.getByText(/Conversation controls are temporarily unavailable/i)).toBeTruthy();
    expect(screen.getByText(/Goal list unavailable until Core returns a full control snapshot/i)).toBeTruthy();
    expect(screen.queryByText(/No goals yet/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: /start a goal/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check result" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].requestId).toBe(requests[0].requestId);
    expect(requests[1].messageType).toBe("conversation_send");
  });

  it("does not reinterpret a capacity view with no trustworthy campaign id as a fresh profile", async () => {
    const capacity: CoreSnapshot = {
      ...emptyDesktop(),
      activeCampaignId: "",
      campaigns: [],
      bounds: { truncated: true, projectionUnavailable: true, omittedCounts: { campaigns: 4 } }
    };
    mountElectron(capacity, async (request) => ({ requestId: request.requestId, accepted: true, snapshot: capacity }));
    expect(await screen.findByText(/Conversation controls are temporarily unavailable/i)).toBeTruthy();
    expect(screen.getByText(/Goal list unavailable until Core returns a full control snapshot/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /start a goal/i })).toBeNull();
    expect(screen.queryByText(/No goals yet/i)).toBeNull();
  });

  it("keeps the ordinary empty profile first-use composer and navigation copy", async () => {
    const empty = emptyDesktop();
    mountElectron(empty, async (request) => ({ requestId: request.requestId, accepted: true, snapshot: empty }));
    expect(await screen.findByRole("heading", { name: /start a goal/i })).toBeTruthy();
    expect(screen.getByText(/No goals yet/i)).toBeTruthy();
    expect(screen.queryByText(/Goal list unavailable/i)).toBeNull();
  });

  it("discards an older-page response whose requested anchor was outrun by polling", async () => {
    const base: CoreSnapshot = {
      ...DEMO_SNAPSHOT,
      preview: false,
      productConversation: {
        ...DEMO_SNAPSHOT.productConversation!,
        items: [{ id: "base-recent", kind: "assistant-message", body: "base recent" }],
        pageInfo: { olderCursor: "old-anchor", newerCursor: "base-newest", hasOlder: true, hasNewer: false, contentBytes: 80, itemCount: 1 }
      }
    };
    const advanced: CoreSnapshot = {
      ...base,
      productConversation: {
        ...base.productConversation!,
        items: [{ id: "advanced-recent", kind: "assistant-message", body: "advanced recent" }],
        pageInfo: { olderCursor: "replacement-anchor", newerCursor: "advanced-newest", hasOlder: true, hasNewer: false, contentBytes: 90, itemCount: 1 }
      }
    };
    let current = base;
    const page = deferred<unknown>();
    const command = vi.fn((request: CoreCommand) => request.messageType === "history_page"
      ? page.promise
      : Promise.resolve({ requestId: request.requestId, accepted: true, snapshot: current }));
    mountElectron(base, command, { snapshot: async () => current });
    fireEvent.click(await screen.findByRole("button", { name: /load earlier/i }));
    await waitFor(() => expect(command.mock.calls.some(([request]) => request.messageType === "history_page")).toBe(true));
    const historyRequest = command.mock.calls.find(([request]) => request.messageType === "history_page")![0];
    current = advanced;
    expect(await screen.findByText("advanced recent", {}, { timeout: 2_000 })).toBeTruthy();
    page.resolve({
      requestId: historyRequest.requestId,
      accepted: true,
      historyPage: {
        scope: "conversation",
        ownerId: base.activeCampaignId,
        conversationItems: [{ id: "stale-older", kind: "assistant-message", body: "stale older" }],
        pageInfo: { olderCursor: "older", newerCursor: "old-anchor", hasOlder: true, hasNewer: true, contentBytes: 80, itemCount: 1 }
      }
    });
    expect(await screen.findByText(/Conversation history advanced beyond the loaded window/i)).toBeTruthy();
    expect(screen.queryByText("stale older")).toBeNull();
    expect(screen.getByText("advanced recent")).toBeTruthy();
  });

  it("refuses permission Allow when the capacity view omits authoritative facts", async () => {
    const capacity: CoreSnapshot = {
      ...DEMO_SNAPSHOT,
      preview: false,
      bounds: { truncated: true, projectionUnavailable: true, omittedCounts: { decisions: 3 } }
    };
    const command = vi.fn(async (request: CoreCommand) => ({
      requestId: request.requestId,
      accepted: true,
      duplicate: false,
      snapshot: capacity
    }));
    mountElectron(capacity, command);
    fireEvent.click(await screen.findByRole("button", { name: /allow once/i }));
    expect(command).not.toHaveBeenCalled();
    expect(await screen.findByText(/Permission Allow requires the full request facts/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /decline permission/i })).toBeTruthy();
  });

  it("keeps ordinary permission Allow working with a full control projection", async () => {
    const base: CoreSnapshot = { ...DEMO_SNAPSHOT, preview: false, bounds: undefined };
    const command = vi.fn(async (request: CoreCommand) => ({
      requestId: request.requestId,
      accepted: true,
      duplicate: false,
      snapshot: base
    }));
    mountElectron(base, command);
    fireEvent.click(await screen.findByRole("button", { name: /allow once/i }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command.mock.calls[0][0]).toEqual(expect.objectContaining({
      messageType: "resolve_decision",
      payload: expect.objectContaining({ decisionId: "decision-permission-1", allow: true })
    }));
  });

  it("retries a reserved Stop successor with the same id and source payload", async () => {
    const source: CoreSnapshot = {
      ...DEMO_SNAPSHOT,
      preview: false,
      attempt: { ...DEMO_SNAPSHOT.attempt, id: "attempt-stopped", state: "completed" },
      productConversation: {
        ...DEMO_SNAPSHOT.productConversation!,
        turn: { state: "stopped", canStop: false, canSend: true }
      }
    };
    const reserved: CoreSnapshot = {
      ...source,
      attempt: { ...source.attempt, id: "attempt-successor", state: "waiting" },
      productConversation: {
        ...source.productConversation!,
        turn: { state: "idle", canStop: false, canSend: false, reason: "Successor admission failed." }
      }
    };
    const requests: CoreCommand[] = [];
    const command = vi.fn(async (request: CoreCommand) => {
      requests.push(request);
      if (requests.length === 1) return {
        goalportRejected: true,
        requestId: request.requestId,
        accepted: false,
        error: "successor admission failed",
        snapshot: reserved,
        rejection: {
          code: "successor-admission-failed",
          message: "successor admission failed",
          deliveryState: "FAILED",
          nativeDispatchState: "NOT_STARTED",
          retryMode: "SAME_REQUEST",
          reservation: {
            kind: "stop-successor",
            requestId: request.requestId,
            campaignId: source.activeCampaignId,
            taskId: source.activeTask.id,
            attemptId: "attempt-successor",
            sourceAttemptId: "attempt-stopped",
            messageReserved: false
          }
        }
      };
      return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: reserved };
    });
    mountElectron(source, command);
    const composer = await screen.findByRole("textbox", { name: /message composer/i });
    fireEvent.change(composer, { target: { value: "continue once" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].requestId).toBe(requests[0].requestId);
    expect(requests[1].payload).toEqual(requests[0].payload);
    expect(requests[0].payload.attemptId).toBe("attempt-stopped");
  });

  it("initializes the null draft when Browse is the first empty-profile action", async () => {
    const chooseWorkspace = vi.fn(async () => "C:\\chosen-first");
    mountElectron(emptyDesktop(), async (request) => ({ requestId: request.requestId, accepted: true, snapshot: emptyDesktop() }), { chooseWorkspace });
    fireEvent.click(await screen.findByRole("button", { name: /browse/i }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: /project folder/i }) as HTMLInputElement).value).toBe("C:\\chosen-first"));
  });

  it("submits recovery consent only with the current operation and proof token", () => {
    const bootstrapAction = vi.fn(async () => undefined);
    window.goalportCore = { bootstrapAction } as never;
    render(<BootstrapScreen state={{
      phase: "import-offer",
      facts: {
        sourcePath: "C:\\old",
        createdBy: null,
        markerSchema: 2,
        counts: null,
        schemaVersion: 9,
        bytes: 10,
        needsRecovery: true,
        liveSource: false,
        recoveryDisposition: "POSITIVELY_IDENTIFIED_RECOVERABLE",
        recoveryMethod: "DETACHED_WAL_COPY_PROBE_V1",
        recoveryProofToken: "proof-current",
        operationId: "operation-current",
        sourceMutationOnAccept: "NONE"
      }
    }} />);
    expect(screen.getByText(/original database and journal files remain unchanged/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /use my existing data/i }));
    expect(bootstrapAction).toHaveBeenCalledWith({
      type: "import-accept",
      operationId: "operation-current",
      recoveryProofToken: "proof-current"
    });
  });

  it("does not offer import for an unproven recovery-shaped source", () => {
    window.goalportCore = { bootstrapAction: vi.fn(async () => undefined) } as never;
    render(<BootstrapScreen state={{
      phase: "import-offer",
      facts: {
        sourcePath: "C:\\old",
        createdBy: null,
        markerSchema: 2,
        counts: null,
        schemaVersion: 9,
        bytes: 10,
        needsRecovery: true,
        liveSource: false
      }
    }} />);
    expect(screen.queryByRole("button", { name: /use my existing data/i })).toBeNull();
    expect(screen.getByText(/no verified detached recovery proof/i)).toBeTruthy();
  });
});
