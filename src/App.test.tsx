// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { type CoreCommand } from "./ipc";
import { DEMO_SNAPSHOT, type CoreSnapshot } from "./types";

afterEach(() => {
  cleanup();
  delete window.goalportCore;
  delete window.__GOALPORT_ELECTRON__;
  window.history.replaceState(null, "", "/");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function mountElectron(snapshot: unknown, command?: (request: CoreCommand) => Promise<unknown>) {
  window.__GOALPORT_ELECTRON__ = true;
  window.goalportCore = {
    snapshot: async () => snapshot,
    command: command ?? (async () => snapshot),
    startCore: async () => snapshot,
    openInVsCode: async () => undefined
  } as never;
  return render(<App />);
}

function accept(request: CoreCommand, snapshot: unknown) {
  return Promise.resolve({ requestId: request.requestId, accepted: true, duplicate: false, snapshot });
}

/** Open the composer Runtime chooser (aria-label "Select Runtime"), waiting for boot. */
async function openRuntimePicker() {
  fireEvent.click(await screen.findByRole("button", { name: /select runtime/i }));
}

/** The app close entry lives in the title-bar application menu (the native X
 *  is the other close path); open the menu, then click the entry. */
function clickCloseWindow() {
  fireEvent.click(screen.getByRole("button", { name: "Application menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Close window" }));
}

/** The Send path for an existing conversation now dispatches conversation_send. */
const SEND_TYPE = "conversation_send";

// Real-clock settling (no fake timers): each case sleeps past full polling
// cycles, so the zero-call assertions cannot pass on an unscheduled timer.
const settlePastCycles = () => new Promise((done) => setTimeout(done, 1700));

function mountGatedElectron(snapshot: unknown) {
  const snapshotMock = vi.fn(async () => snapshot);
  const startCore = vi.fn(async () => snapshot);
  let pushState: ((state: unknown) => void) | null = null;
  window.__GOALPORT_ELECTRON__ = true;
  window.goalportCore = {
    snapshot: snapshotMock,
    command: async () => snapshot,
    startCore,
    openInVsCode: async () => undefined,
    bootstrapCurrent: async () => ({ phase: "checking" }),
    onBootstrapState: (callback: (state: unknown) => void) => {
      pushState = callback;
      return () => { pushState = null; };
    }
  } as never;
  const rendered = render(<App />);
  return { snapshotMock, startCore, push: (state: unknown) => pushState?.(state), rendered };
}

describe("bootstrap gating of Core polling", () => {
  it("does not poll Core or auto-start while the bootstrap is not done", async () => {
    const base = { ...DEMO_SNAPSHOT, preview: false } as const;
    const gated = mountGatedElectron(base);
    gated.push({ phase: "checking" });
    await settlePastCycles();
    expect(gated.snapshotMock).not.toHaveBeenCalled();
    expect(gated.startCore).not.toHaveBeenCalled();

    gated.push({ phase: "import-offer", facts: { sourcePath: null, createdBy: null, markerSchema: 1, counts: null, schemaVersion: 1, bytes: null, needsRecovery: false, liveSource: false } });
    await settlePastCycles();
    expect(gated.snapshotMock).not.toHaveBeenCalled();
    expect(gated.startCore).not.toHaveBeenCalled();
  });

  it.each(["importing", "backing-up", "coordination"])("does not poll during %s", async (phase) => {
    const gated = mountGatedElectron({ ...DEMO_SNAPSHOT, preview: false });
    gated.push({ phase });
    await settlePastCycles();
    expect(gated.snapshotMock).not.toHaveBeenCalled();
    expect(gated.startCore).not.toHaveBeenCalled();
  });

  it("starts polling immediately when the bootstrap reaches done, and keeps the interval", async () => {
    const base = { ...DEMO_SNAPSHOT, preview: false } as const;
    const gated = mountGatedElectron(base);
    gated.push({ phase: "checking" });
    await settlePastCycles();
    expect(gated.snapshotMock).not.toHaveBeenCalled();
    gated.push({ phase: "done" });
    await waitFor(() => expect(gated.snapshotMock.mock.calls.length).toBeGreaterThanOrEqual(1));
    const afterFirst = gated.snapshotMock.mock.calls.length;
    await new Promise((done) => setTimeout(done, 850));
    expect(gated.snapshotMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("stays silent on a bootstrap error with no gated-exception polling loop", async () => {
    const base = { ...DEMO_SNAPSHOT, preview: false } as const;
    const gated = mountGatedElectron(base);
    gated.push({ phase: "error", kind: "not-a-profile", headline: "This data directory is not an empty or existing GoalPort profile.", message: "refused", canChooseDir: true, dataPath: null });
    await settlePastCycles();
    expect(gated.snapshotMock).not.toHaveBeenCalled();
    expect(gated.startCore).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: /goalport data profile/i });
    expect(within(dialog).getByText(/not an empty or existing GoalPort profile/i)).toBeTruthy();
  });

  it("an electron mount without a bootstrap channel is ready immediately and polls at once", async () => {
    const base = { ...DEMO_SNAPSHOT, preview: false } as const;
    const snapshotMock = vi.fn(async () => base);
    window.__GOALPORT_ELECTRON__ = true;
    window.goalportCore = {
      snapshot: snapshotMock,
      command: async () => base,
      startCore: async () => base,
      openInVsCode: async () => undefined
    } as never;
    render(<App />);
    await waitFor(() => expect(snapshotMock.mock.calls.length).toBeGreaterThanOrEqual(1));
    expect(screen.getByRole("banner").textContent).toContain("GoalPort");
    expect(screen.getByText(/Summarize the workspace/i)).toBeTruthy();
  });
});

describe("GoalPort preview", () => {
  it("renders the three-column conversation workspace with campaign continuity", async () => {
    render(<App />);

    expect(screen.getByRole("banner").textContent).toContain("GoalPort");
    expect(screen.getByRole("navigation", { name: /workspace and goals/i })).toBeTruthy();
    expect(screen.getByRole("main", { name: /goal conversation/i })).toBeTruthy();
    // Session details is an overlay opened on demand.
    fireEvent.click(screen.getByRole("button", { name: /open details panel/i }));
    expect(screen.getByRole("complementary", { name: /session details/i })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /close details panel/i })[0]);
    // The conversation is the product conversation: user message + grouped
    // activity + runtime reply. No raw lifecycle events.
    expect(screen.getByText("Summarize the workspace and list the open risks.")).toBeTruthy();
    expect(screen.getByText(/activity updates/i)).toBeTruthy();
    expect(screen.queryByText(/Attempt updated/i)).toBeNull();
    expect(screen.queryByText(/Plan accepted/i)).toBeNull();
    // Runtime catalog lives behind the composer chooser, not on the surface.
    await openRuntimePicker();
    expect(screen.getAllByText("Limited").length).toBeGreaterThan(0);
    expect(screen.getByRole("option", { name: /claude code/i })).toBeTruthy();
    // Developer diagnostics is menu-only.
    expect(document.querySelector(".diagnostics-drawer")).toBeNull();
  });

  it("sends a composer message into the product conversation", async () => {
    render(<App />);

    const composer = screen.getByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Continue the evidence check" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    // Honest preview note, never a fake native reply.
    expect(await screen.findByText(/Browser preview: recorded locally/i)).toBeTruthy();
    expect(screen.getByText("Continue the evidence check")).toBeTruthy();
    expect(composer.value).toBe("");
  });

  it("does not display native-cancel copy on a stop card", () => {
    render(<App />);
    expect(screen.queryByText(/native interrupt/i)).toBeNull();
    expect(screen.queryByText(/native cancel/i)).toBeNull();
  });

  it("surfaces a denied permission in Decision Inbox without hiding the facts", () => {
    render(<App />);

    const inbox = screen.getByRole("region", { name: /decision inbox/i });
    expect(within(inbox).getByText(/Workspace write permission/i)).toBeTruthy();
    fireEvent.click(within(inbox).getByRole("button", { name: /decline permission/i }));

    expect(screen.getAllByText(/Permission denied/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No write action was sent/i).length).toBeGreaterThan(0);
  });

  it("sends a one-time allow with the selected Decision identity", () => {
    render(<App />);

    const inbox = screen.getByRole("region", { name: /decision inbox/i });
    fireEvent.click(within(inbox).getByRole("button", { name: /allow once/i }));

    expect(screen.getAllByText(/Permission allowed once/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Permission denied/i)).toBeNull();
  });

  it("shows the reconnect boundary and keeps the no-resend promise explicit", async () => {
    render(<App />);

    // Fault injection lives in Developer diagnostics (this preview reports a
    // development distribution, so the controls are available there).
    fireEvent.click(screen.getByRole("button", { name: /application menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /developer diagnostics/i }));
    fireEvent.click(await screen.findByRole("button", { name: /simulate offline/i }));
    expect(screen.getAllByText("Core disconnected").length).toBeGreaterThan(0);
    expect(screen.getByText(/No prompt will be replayed/i)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /reconnect core/i })[0]);
    await waitFor(() => expect(screen.getAllByText("Core connected").length).toBeGreaterThan(0));
  });

  it("opens Continue in background close-choice from Close window", () => {
    render(<App />);

    clickCloseWindow();
    const dialog = screen.getByRole("dialog", { name: "Continue running in the background?" });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Continue in background" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Stop background work and quit" })).toBeTruthy();
  });

  it("Continue in background dismisses the renderer close-choice dialog", () => {
    render(<App />);

    clickCloseWindow();
    fireEvent.click(screen.getByRole("button", { name: "Continue in background" }));
    expect(screen.queryByRole("dialog", { name: "Continue running in the background?" })).toBeNull();
  });

  it("keeps the close-choice dialog open when Continue receipt is not acknowledged", async () => {
    const confirmCloseChoice = vi.fn(async () => ({
      ok: false,
      choice: "continue",
      allowQuitLatch: false,
      coreAcknowledged: false
    }));
    window.goalportCore = {
      snapshot: async () => ({}),
      command: async () => ({}),
      startCore: async () => ({}),
      openInVsCode: async () => undefined,
      confirmCloseChoice
    };
    render(<App />);
    clickCloseWindow();
    fireEvent.click(screen.getByRole("button", { name: "Continue in background" }));
    expect(await screen.findByRole("dialog", { name: "Continue running in the background?" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/Continue in background was not recorded/i)).toBeTruthy();
    });
    expect(confirmCloseChoice).toHaveBeenCalled();
    delete window.goalportCore;
  });

  it("Stop background work and quit dismisses the renderer close-choice dialog", () => {
    render(<App />);

    clickCloseWindow();
    fireEvent.click(screen.getByRole("button", { name: "Stop background work and quit" }));
    expect(screen.queryByRole("dialog", { name: "Continue running in the background?" })).toBeNull();
  });

  it("keeps the close-choice dialog open until Stop has a durable Core acknowledgement", async () => {
    const confirmCloseChoice = vi.fn(async () => ({
      ok: false,
      choice: "stop",
      allowQuitLatch: false,
      coreAcknowledged: false
    }));
    window.goalportCore = {
      snapshot: async () => ({}),
      command: async () => ({}),
      startCore: async () => ({}),
      openInVsCode: async () => undefined,
      confirmCloseChoice
    };
    render(<App />);
    clickCloseWindow();
    fireEvent.click(screen.getByRole("button", { name: "Stop background work and quit" }));
    expect(await screen.findByRole("dialog", { name: "Continue running in the background?" })).toBeTruthy();
    expect(await screen.findByText(/Stop was not durably acknowledged by Core/i)).toBeTruthy();
    expect(confirmCloseChoice).toHaveBeenCalledOnce();
  });

  it("starts a goal from a local draft with one first send (no dialog)", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /new goal/i }));
    // A local draft composer opens inline — no modal, no title question.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: /project folder/i })).toBeTruthy();
    const composer = screen.getByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    // Typing is possible before a Runtime is chosen.
    fireEvent.change(composer, { target: { value: "Ship a safe preview" } });

    fireEvent.click(screen.getByRole("button", { name: /discard draft/i }));
    expect(screen.getAllByText(/Summarize the workspace/i).length).toBeGreaterThan(0);
    void composer;
  });

  it("shows native and residual Stop state independently and disables conflicting work", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const heldSnapshot = {
      ...DEMO_SNAPSHOT,
      preview: false,
      attempt: { ...DEMO_SNAPSHOT.attempt, id: "attempt-viewed", provider: "claude", state: "active" },
      stopResponsibility: {
        attemptId: "attempt-claude-held",
        operationId: "operation-ui-stop-1",
        provider: "claude",
        nativeTurnState: "interrupted",
        residualExecutionState: "unknown",
        writeResponsibility: "held",
        inputUuid: "input-7",
        sessionHash: "session-hash",
        turnEpoch: 4,
        processEpoch: "process-3",
        source: "claude.native.result"
      }
    } as const;
    window.goalportCore = {
      snapshot: async () => heldSnapshot,
      command: async () => heldSnapshot,
      startCore: async () => ({}),
      openInVsCode: async () => undefined
    };

    render(<App />);
    const stopRegion = await screen.findByRole("region", { name: /stop responsibility/i });
    expect(within(stopRegion).getByText(/Native turn: interrupted/i)).toBeTruthy();
    expect(within(stopRegion).getByText(/Residual execution: unknown/i)).toBeTruthy();
    expect(within(stopRegion).getByText(/Write responsibility: held/i)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /allow once/i }) as HTMLButtonElement).disabled).toBe(true);
    // No Stop is offered: the product turn is not a live cancellable turn.
    expect(screen.queryByRole("button", { name: /stop the running runtime turn/i })).toBeNull();
    // Runtime selection stays blocked under the hold.
    await openRuntimePicker();
    const claudeOption = await screen.findByRole("option", { name: /claude code/i });
    expect((claudeOption as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers no Stop on a terminal selection and keeps the provider visible", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const snapshot = {
      ...DEMO_SNAPSHOT,
      preview: false,
      attempt: { ...DEMO_SNAPSHOT.attempt, state: "completed" },
      productConversation: {
        ...DEMO_SNAPSHOT.productConversation,
        turn: { state: "stopped", canStop: false, canSend: true }
      },
      stopResponsibility: null
    } as const;
    window.goalportCore = { snapshot: async () => snapshot, command: async () => snapshot, startCore: async () => ({}), openInVsCode: async () => undefined };
    render(<App />);
    // Idle/terminal: Send (per canSend), never an idle Stop button.
    expect(await screen.findByRole("button", { name: /send message/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop the running runtime turn/i })).toBeNull();
    expect(screen.getByText("Stopped")).toBeTruthy();
  });
  it("labels close Stop for the active selected provider under a foreign Claude hold", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const snapshot = { ...DEMO_SNAPSHOT, preview: false, attempt: { ...DEMO_SNAPSHOT.attempt, provider: "codex", state: "active" }, stopResponsibility: { attemptId: "older-claude", operationId: "older-stop", provider: "claude", nativeTurnState: "unconfirmed", residualExecutionState: "unknown", writeResponsibility: "held", inputUuid: "input", sessionHash: "hash", turnEpoch: 1, processEpoch: "epoch", source: "ui.stop" } } as const;
    window.goalportCore = { snapshot: async () => snapshot, command: async () => snapshot, startCore: async () => ({}), openInVsCode: async () => undefined };
    render(<App />);
    await screen.findByRole("region", { name: /stop responsibility/i });
    clickCloseWindow();
    const dialog = screen.getByRole("dialog", { name: "Continue running in the background?" });
    expect(within(dialog).getByRole("button", { name: "Stop background work and quit" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Stop Claude turn and quit" })).toBeNull();
  });

  it("discloses a workspace hold on close even when the viewed Attempt is terminal", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const heldSnapshot = {
      ...DEMO_SNAPSHOT,
      preview: false,
      attempt: { ...DEMO_SNAPSHOT.attempt, state: "completed" },
      stopResponsibility: {
        attemptId: "attempt-claude-held",
        operationId: "operation-ui-stop-1",
        provider: "claude",
        nativeTurnState: "unconfirmed",
        residualExecutionState: "unknown",
        writeResponsibility: "held",
        inputUuid: "input-7",
        sessionHash: "session-hash",
        turnEpoch: 4,
        processEpoch: "process-3",
        source: "ui.stop"
      }
    } as const;
    window.goalportCore = {
      snapshot: async () => heldSnapshot,
      command: async () => heldSnapshot,
      startCore: async () => ({}),
      openInVsCode: async () => undefined
    };
    render(<App />);
    await screen.findByRole("region", { name: /stop responsibility/i });
    clickCloseWindow();
    const dialog = screen.getByRole("dialog", { name: "Continue running in the background?" });
    expect(within(dialog).getByText(/residual execution remains unknown/i)).toBeTruthy();
    expect(within(dialog).getByText(/Core keeps write responsibility held/i)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Stop Claude turn and quit" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Stop background work and quit" })).toBeNull();
  });

  it("omits the display placeholder when first selecting a Runtime", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const snapshot = {
      ...DEMO_SNAPSHOT,
      preview: false,
      attempt: { ...DEMO_SNAPSHOT.attempt, id: "attempt-unassigned" }
    } as const;
    const command = vi.fn(async (_request: CoreCommand) => snapshot);
    window.goalportCore = {
      snapshot: async () => snapshot,
      command,
      startCore: async () => snapshot,
      openInVsCode: async () => undefined
    };

    render(<App />);
    await openRuntimePicker();
    fireEvent.click(await screen.findByRole("option", { name: /claude code/i }));
    await waitFor(() => {
      expect(command.mock.calls.some(([request]) => request.messageType === "select_runtime")).toBe(true);
    });
    const selectCalls = command.mock.calls.filter(([request]) => request.messageType === "select_runtime");
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0][0].payload.attemptId).toBeUndefined();
  });

  it("keeps a persisted Attempt identity when re-selecting a Runtime", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const snapshot = { ...DEMO_SNAPSHOT, preview: false } as const;
    const command = vi.fn(async (_request: CoreCommand) => snapshot);
    window.goalportCore = {
      snapshot: async () => snapshot,
      command,
      startCore: async () => snapshot,
      openInVsCode: async () => undefined
    };

    render(<App />);
    await openRuntimePicker();
    fireEvent.click(await screen.findByRole("option", { name: /claude code/i }));
    await waitFor(() => {
      expect(command.mock.calls.some(([request]) => request.messageType === "select_runtime")).toBe(true);
    });
    const selectCalls = command.mock.calls.filter(([request]) => request.messageType === "select_runtime");
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0][0].payload.attemptId).toBe("attempt-codex-executor-1");
  });

  it("passes an opaque Core Runtime id through selection unchanged", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const opaqueId = "Provider_V2 Beta";
    const snapshot = {
      ...DEMO_SNAPSHOT,
      preview: false,
      runtimes: [{
        ...DEMO_SNAPSHOT.runtimes[0],
        id: opaqueId,
        name: "Opaque Runtime",
        support: "unknown" as const
      }]
    };
    const command = vi.fn(async (request: CoreCommand) => accept(request, snapshot));
    window.goalportCore = {
      snapshot: async () => snapshot,
      command,
      startCore: async () => snapshot,
      openInVsCode: async () => undefined
    };

    render(<App />);
    await openRuntimePicker();
    fireEvent.click(await screen.findByRole("option", { name: /opaque runtime/i }));
    await waitFor(() => expect(command.mock.calls.some(([request]) => request.messageType === "select_runtime")).toBe(true));

    const request = command.mock.calls.find(([candidate]) => candidate.messageType === "select_runtime")![0];
    expect(request.payload.provider).toBe(opaqueId);
  });

  it("forwards a terminal Attempt identity so Core can mint a replacement", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const snapshot = {
      ...DEMO_SNAPSHOT,
      preview: false,
      attempt: { ...DEMO_SNAPSHOT.attempt, state: "completed" as const }
    } as const;
    const command = vi.fn(async (_request: CoreCommand) => snapshot);
    window.goalportCore = {
      snapshot: async () => snapshot,
      command,
      startCore: async () => snapshot,
      openInVsCode: async () => undefined
    };

    render(<App />);
    await openRuntimePicker();
    fireEvent.click(await screen.findByRole("option", { name: /claude code/i }));
    await waitFor(() => {
      expect(command.mock.calls.some(([request]) => request.messageType === "select_runtime")).toBe(true);
    });
    const selectCalls = command.mock.calls.filter(([request]) => request.messageType === "select_runtime");
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0][0].payload.attemptId).toBe("attempt-codex-executor-1");
  });

  it("surfaces a failed reselect honestly without a success banner", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const base = { ...DEMO_SNAPSHOT, preview: false } as const;
    let selects = 0;
    const command = vi.fn(async (request: CoreCommand) => {
      if (request.messageType !== "select_runtime") return accept(request, base);
      selects += 1;
      if (selects === 1) {
        return { goalportRejected: true, requestId: request.requestId, error: "already bound" };
      }
      if (selects === 2) {
        throw new Error("ECONNRESET");
      }
      return accept(request, { ...base, connection: "connected" as const, notices: [] });
    });
    window.goalportCore = {
      snapshot: async () => base,
      command,
      startCore: async () => base,
      openInVsCode: async () => undefined
    };

    render(<App />);
    await openRuntimePicker();
    const claudeOption = await screen.findByRole("option", { name: /claude code/i });
    fireEvent.click(claudeOption);
    // The exact raw refusal stays visible inside Technical details.
    expect(await screen.findByText("already bound")).toBeTruthy();
    expect(screen.queryByText(/successfully selected/i)).toBeNull();
    await openRuntimePicker();
    const retryOption = await screen.findByRole("option", { name: /claude code/i });
    await waitFor(() => expect((retryOption as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retryOption);
    await waitFor(() => expect(screen.getAllByText(/core connected/i).length).toBeGreaterThan(0));
  });

  it("opens a normal empty RC straight into the draft composer, without demo data", async () => {
    window.history.replaceState(null, "", "/?firstRun=1");
    window.__GOALPORT_ELECTRON__ = true;
    const empty = {
      ...DEMO_SNAPSHOT,
      connection: "connected" as const,
      preview: false,
      projects: [],
      selectedProjectId: "",
      project: { id: "", name: "No workspace selected", workspaceRoot: "", color: "slate" },
      campaigns: [],
      activeCampaignId: "",
      activeTask: { id: "", title: "No task selected", acceptance: "", state: "waiting" as const },
      attempt: { id: "attempt-unassigned", taskId: "", provider: "unassigned", role: "executor" as const, state: "waiting" as const, sessionLabel: "No Runtime selected", eventCount: 0 },
      timeline: [],
      decisions: [],
      evidence: [],
      notices: [],
      productConversation: null
    };
    const command = vi.fn(async () => empty);
    window.goalportCore = {
      snapshot: async () => empty,
      command,
      startCore: async () => empty,
      openInVsCode: async () => undefined,
      appInfo: async () => ({ version: "1.0.0-rc.1", channel: "Stable V1 RC", testMode: false, dataPath: "C:\\GoalPortRC" })
    };

    render(<App />);

    // First use: the local draft composer is immediately present and focused;
    // no dialog, no demo goal, no permission.
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(composer));
    expect(screen.queryByRole("dialog", { name: /start a goal/i })).toBeNull();
    expect(screen.queryByText("Build a durable preview")).toBeNull();
    expect(screen.queryByText("Workspace write permission")).toBeNull();
    expect(screen.getByRole("heading", { name: /start a goal/i })).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
    // About carries version only — no protocol/hash/data-path ledger.
    fireEvent.click(screen.getByRole("button", { name: /application menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /about goalport/i }));
    const about = screen.getByRole("dialog", { name: /about goalport/i });
    expect(within(about).getByText(/stable v1 rc/i)).toBeTruthy();
    expect(within(about).getByText(/1\.0\.0-rc\.1/i)).toBeTruthy();
    expect(within(about).queryByText(/protocol/i)).toBeNull();
    expect(within(about).queryByText(/data path/i)).toBeNull();
  });

  it("blocks sending when the product turn does not allow it (uncertain)", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const uncertain = {
      ...DEMO_SNAPSHOT,
      preview: false,
      productConversation: {
        ...DEMO_SNAPSHOT.productConversation,
        turn: { state: "uncertain", canStop: false, canSend: false, reason: "the previous send could not be confirmed delivered" }
      }
    };
    window.goalportCore = {
      snapshot: async () => uncertain,
      command: async () => uncertain,
      startCore: async () => uncertain,
      openInVsCode: async () => undefined
    };

    render(<App />);

    expect(await screen.findAllByText("Blocked").then((nodes) => nodes.length)).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the native workspace picker and preserves the draft on a refused first send", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const base = { ...DEMO_SNAPSHOT, preview: false };
    const command = vi.fn(async (request: CoreCommand) => ({
      goalportRejected: true,
      requestId: request.requestId,
      error: "workspace is already held"
    }));
    window.goalportCore = {
      snapshot: async () => base,
      command,
      startCore: async () => base,
      openInVsCode: async () => undefined,
      chooseWorkspace: async () => "C:\\work\\chosen"
    };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new goal/i }));
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    const workspace = screen.getByRole("textbox", { name: /project folder/i }) as HTMLInputElement;
    await waitFor(() => expect(workspace.value).toBe("C:\\work\\chosen"));
    const goal = screen.getByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.change(goal, { target: { value: "Keep this exact goal" } });
    fireEvent.click(screen.getByRole("button", { name: "Select Runtime" }));
    fireEvent.click(await screen.findByRole("option", { name: /claude code/i }));
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect((await screen.findByRole("alert")).textContent).toContain("could not complete that action");
    expect(document.body.textContent).toContain("workspace is already held");
    expect(workspace.value).toBe("C:\\work\\chosen");
    expect(goal.value).toBe("Keep this exact goal");
    const request = command.mock.calls.at(-1)?.[0];
    expect(request).toBeDefined();
    expect(request!.messageType).toBe("start_conversation");
    expect(request!.payload).toEqual(expect.objectContaining({ workspaceRoot: "C:\\work\\chosen", provider: "claude", message: "Keep this exact goal" }));
    expect(request!.payload.projectId).toBeUndefined();
  });

  it("preserves a failed send and reports the exact refusal", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const base = { ...DEMO_SNAPSHOT, preview: false };
    const command = vi.fn(async (request: CoreCommand) => ({ goalportRejected: true, requestId: request.requestId, error: "delivery unknown; it was not sent again" }));
    window.goalportCore = { snapshot: async () => base, command, startCore: async () => base, openInVsCode: async () => undefined };
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Do not lose this input" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText(/could not complete that action/i)).toBeTruthy();
    expect(document.body.textContent).toContain("delivery unknown; it was not sent again");
    expect(composer.value).toBe("Do not lose this input");
  });

  it("binds a send to captured ids and does not clear a later draft", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const base = { ...DEMO_SNAPSHOT, preview: false };
    const pending = deferred<unknown>();
    const command = vi.fn((_request: CoreCommand) => pending.promise);
    window.goalportCore = { snapshot: async () => base, command, startCore: async () => base, openInVsCode: async () => undefined };
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "First input" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    const request = command.mock.calls[0][0];
    fireEvent.change(composer, { target: { value: "Second input drafted while waiting" } });
    pending.resolve({ requestId: request.requestId, accepted: true, duplicate: false, snapshot: base });

    await waitFor(() => expect(composer.value).toBe("Second input drafted while waiting"));
    expect(request.messageType).toBe(SEND_TYPE);
    expect(request.payload).toEqual(expect.objectContaining({
      campaignId: base.activeCampaignId,
      attemptId: base.attempt.id,
      message: "First input"
    }));
  });

  it("keeps a delayed refused send and its draft with the original campaign", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const campaignA = { ...DEMO_SNAPSHOT, preview: false };
    const campaignB: CoreSnapshot = {
      ...campaignA,
      productConversation: { ...campaignA.productConversation!, title: "Task B" },
      activeCampaignId: "campaign-evidence-loop",
      activeTask: { id: "task-b", title: "Task B", acceptance: "B", state: "in-progress" },
      attempt: { ...campaignA.attempt, id: "attempt-b", taskId: "task-b" },
      timeline: [], notices: []
    };
    const pendingSend = deferred<unknown>();
    const command = vi.fn((request: CoreCommand) => {
      if (request.messageType === SEND_TYPE) return pendingSend.promise;
      const selected = request.payload.campaignId === campaignB.activeCampaignId ? campaignB : campaignA;
      return accept(request, selected);
    });
    window.goalportCore = { snapshot: async () => campaignA, command, startCore: async () => campaignA, openInVsCode: async () => undefined };
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    await screen.findByRole("heading", { name: "Task B" });
    fireEvent.change(composer, { target: { value: "Campaign B draft" } });
    fireEvent.click(screen.getByRole("button", { name: /build a durable preview/i }));
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe(campaignA.activeCampaignId));
    fireEvent.change(composer, { target: { value: "Campaign A input" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(command.mock.calls.some(([request]) => request.messageType === SEND_TYPE)).toBe(true));
    const sendRequest = command.mock.calls.find(([request]) => request.messageType === SEND_TYPE)![0];
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    pendingSend.resolve({ goalportRejected: true, requestId: sendRequest.requestId, error: "A delivery remains unknown" });

    await screen.findByRole("heading", { name: "Task B" });
    expect(composer.value).toBe("Campaign B draft");
    expect(screen.queryByText("A delivery remains unknown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /build a durable preview/i }));
    expect(await screen.findByText("A delivery remains unknown")).toBeTruthy();
    expect(composer.value).toBe("Campaign A input");
  });

  it("clears only the accepted campaign draft when another campaign has identical text", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const campaignA = { ...DEMO_SNAPSHOT, preview: false };
    const campaignB: CoreSnapshot = {
      ...campaignA,
      productConversation: { ...campaignA.productConversation!, title: "Task B" },
      activeCampaignId: "campaign-evidence-loop",
      activeTask: { id: "task-b", title: "Task B", acceptance: "B", state: "in-progress" },
      attempt: { ...campaignA.attempt, id: "attempt-b", taskId: "task-b" },
      timeline: [], notices: []
    };
    const pendingSend = deferred<unknown>();
    const command = vi.fn((request: CoreCommand) => {
      if (request.messageType === SEND_TYPE) return pendingSend.promise;
      const selected = request.payload.campaignId === campaignB.activeCampaignId ? campaignB : campaignA;
      return accept(request, selected);
    });
    window.goalportCore = { snapshot: async () => campaignA, command, startCore: async () => campaignA, openInVsCode: async () => undefined };
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    await screen.findByRole("heading", { name: "Task B" });
    fireEvent.change(composer, { target: { value: "Identical draft" } });
    fireEvent.click(screen.getByRole("button", { name: /build a durable preview/i }));
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe(campaignA.activeCampaignId));
    fireEvent.change(composer, { target: { value: "Identical draft" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(command.mock.calls.some(([request]) => request.messageType === SEND_TYPE)).toBe(true));
    const sendRequest = command.mock.calls.find(([request]) => request.messageType === SEND_TYPE)![0];
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    pendingSend.resolve({ requestId: sendRequest.requestId, accepted: true, duplicate: false, snapshot: campaignA });

    await screen.findByRole("heading", { name: "Task B" });
    expect(composer.value).toBe("Identical draft");
    expect(sendRequest.payload).toEqual(expect.objectContaining({
      campaignId: campaignA.activeCampaignId,
      attemptId: campaignA.attempt.id,
      message: "Identical draft"
    }));
    fireEvent.click(screen.getByRole("button", { name: /build a durable preview/i }));
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe(campaignA.activeCampaignId));
    expect(composer.value).toBe("");
  });

  it("binds typing during a pending selection to the campaign still shown", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const campaignA = { ...DEMO_SNAPSHOT, preview: false };
    const campaignB: CoreSnapshot = {
      ...campaignA,
      productConversation: { ...campaignA.productConversation!, title: "Task B" },
      activeCampaignId: "campaign-evidence-loop",
      activeTask: { id: "task-b", title: "Task B", acceptance: "B", state: "in-progress" },
      attempt: { ...campaignA.attempt, id: "attempt-b", taskId: "task-b" },
      timeline: [], notices: []
    };
    const pendingSelect = deferred<unknown>();
    const command = vi.fn((request: CoreCommand) => request.payload.campaignId === campaignB.activeCampaignId
      ? pendingSelect.promise
      : accept(request, campaignA));
    window.goalportCore = { snapshot: async () => campaignA, command, startCore: async () => campaignA, openInVsCode: async () => undefined };
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "A before selection" } });
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    const selectRequest = command.mock.calls[0][0];
    fireEvent.change(composer, { target: { value: "Typed while Campaign A remains visible" } });
    expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe(campaignA.activeCampaignId);
    expect(selectRequest.messageType).toBe("select_campaign");
    expect(selectRequest.payload.campaignId).toBe(campaignB.activeCampaignId);
    pendingSelect.resolve({ requestId: selectRequest.requestId, accepted: true, duplicate: false, snapshot: campaignB });

    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe(campaignB.activeCampaignId));
    expect(screen.getByRole("heading", { name: "Task B" })).toBeTruthy();
    expect(composer.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /build a durable preview/i }));
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe(campaignA.activeCampaignId));
    expect(composer.value).toBe("Typed while Campaign A remains visible");
  });
});
