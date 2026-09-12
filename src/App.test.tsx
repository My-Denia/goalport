// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { type CoreCommand } from "./ipc";
import { DEMO_SNAPSHOT } from "./types";

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

describe("GoalPort preview", () => {
  it("renders the three-column conversation workspace with campaign continuity", () => {
    render(<App />);

    expect(screen.getByRole("banner").textContent).toContain("GoalPort");
    expect(screen.getByRole("complementary", { name: /projects and campaigns/i })).toBeTruthy();
    expect(screen.getByRole("main", { name: /campaign conversation/i })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: /runtime context/i })).toBeTruthy();
    expect(screen.getByText("Campaign → Task → Attempt")).toBeTruthy();
    expect(screen.getAllByText("Preview").length).toBeGreaterThan(0);
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
  });

  it("sends a composer message into the structured timeline", () => {
    render(<App />);

    const composer = screen.getByRole("textbox", { name: /message composer/i });
    fireEvent.change(composer, { target: { value: "Continue the evidence check" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(screen.getByText("Continue the evidence check")).toBeTruthy();
    expect(screen.getByText("Message queued for the active Attempt")).toBeTruthy();
    expect((composer as HTMLTextAreaElement).value).toBe("");
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

    expect(screen.getByText("Permission denied")).toBeTruthy();
    expect(screen.getAllByText(/No write action was sent/i).length).toBeGreaterThan(0);
  });

  it("sends a one-time allow with the selected Decision identity", () => {
    render(<App />);

    const inbox = screen.getByRole("region", { name: /decision inbox/i });
    fireEvent.click(within(inbox).getByRole("button", { name: /allow once/i }));

    expect(screen.getByText("Permission allowed once")).toBeTruthy();
    expect(screen.queryByText("Permission denied")).toBeNull();
  });

  it("shows the reconnect boundary and keeps the no-resend promise explicit", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /simulate offline/i }));
    expect(screen.getAllByText("Core disconnected").length).toBeGreaterThan(0);
    expect(screen.getByText(/No prompt will be replayed/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /reconnect core/i }));
    expect(screen.getAllByText("Core connected").length).toBeGreaterThan(0);
  });

  it("opens Continue in background close-choice from Close window", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    const dialog = screen.getByRole("dialog", { name: "Continue running in the background?" });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Continue in background" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Stop background work and quit" })).toBeTruthy();
  });

  it("Continue in background dismisses the renderer close-choice dialog", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop background work and quit" }));
    expect(await screen.findByRole("dialog", { name: "Continue running in the background?" })).toBeTruthy();
    expect(await screen.findByText(/Stop was not durably acknowledged by Core/i)).toBeTruthy();
    expect(confirmCloseChoice).toHaveBeenCalledOnce();
  });

  it("opens a first-run campaign form and creates a local preview campaign", () => {
    render(<App />);

    fireEvent.click(screen.getAllByRole("button", { name: /new campaign/i })[0]);
    expect(screen.getByRole("dialog", { name: /start your first campaign/i })).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: /project folder/i }), {
      target: { value: "C:\\workspace\\demo" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: /campaign goal/i }), {
      target: { value: "Ship a safe preview" }
    });
    fireEvent.click(screen.getByRole("button", { name: /begin preview/i }));

    expect(screen.getAllByText("Ship a safe preview").length).toBeGreaterThan(0);
    expect(screen.getByText("C:\\workspace\\demo")).toBeTruthy();
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
    expect((screen.getByRole("button", { name: /assign next step/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /select claude code/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Stop native turn/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Stop on a terminal selection without a workspace hold", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const snapshot={...DEMO_SNAPSHOT,preview:false,attempt:{...DEMO_SNAPSHOT.attempt,state:"completed"},stopResponsibility:null} as const;
    window.goalportCore={snapshot:async()=>snapshot,command:async()=>snapshot,startCore:async()=>({}),openInVsCode:async()=>undefined};
    render(<App />);
    expect((await screen.findByRole("button",{name:/No active turn/i}) as HTMLButtonElement).disabled).toBe(true);
  });

  it("labels close Stop for the active selected provider under a foreign Claude hold", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const snapshot={...DEMO_SNAPSHOT,preview:false,attempt:{...DEMO_SNAPSHOT.attempt,provider:"codex",state:"active"},stopResponsibility:{attemptId:"older-claude",operationId:"older-stop",provider:"claude",nativeTurnState:"unconfirmed",residualExecutionState:"unknown",writeResponsibility:"held",inputUuid:"input",sessionHash:"hash",turnEpoch:1,processEpoch:"epoch",source:"ui.stop"}} as const;
    window.goalportCore={snapshot:async()=>snapshot,command:async()=>snapshot,startCore:async()=>({}),openInVsCode:async()=>undefined};
    render(<App />);
    await screen.findByRole("region",{name:/stop responsibility/i});
    fireEvent.click(screen.getByRole("button",{name:"Close window"}));
    const dialog=screen.getByRole("dialog",{name:"Continue running in the background?"});
    expect(within(dialog).getByRole("button",{name:"Stop background work and quit"})).toBeTruthy();
    expect(within(dialog).queryByRole("button",{name:"Stop Claude turn and quit"})).toBeNull();
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
    fireEvent.click(await screen.findByRole("button", { name: "Close window" }));
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
    fireEvent.click(await screen.findByRole("button", { name: /select claude code/i }));
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
    fireEvent.click(await screen.findByRole("button", { name: /select claude code/i }));
    await waitFor(() => {
      expect(command.mock.calls.some(([request]) => request.messageType === "select_runtime")).toBe(true);
    });
    const selectCalls = command.mock.calls.filter(([request]) => request.messageType === "select_runtime");
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0][0].payload.attemptId).toBe("attempt-codex-executor-1");
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
    fireEvent.click(await screen.findByRole("button", { name: /select claude code/i }));
    await waitFor(() => {
      expect(command.mock.calls.some(([request]) => request.messageType === "select_runtime")).toBe(true);
    });
    const selectCalls = command.mock.calls.filter(([request]) => request.messageType === "select_runtime");
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0][0].payload.attemptId).toBe("attempt-codex-executor-1");
  });

  it("keeps the footer notice when a reselect fails to reach Core", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const base = { ...DEMO_SNAPSHOT, preview: false } as const;
    let selects = 0;
    const command = vi.fn(async (request: CoreCommand) => {
      if (request.messageType !== "select_runtime") return base;
      selects += 1;
      if (selects === 1) {
        return { goalportRejected: true, requestId: request.requestId, error: "already bound" };
      }
      if (selects === 2) {
        throw new Error("ECONNRESET");
      }
      return { requestId: request.requestId, accepted: true, duplicate: false, snapshot: { ...base, connection: "connected" as const, notices: [] } };
    });
    window.goalportCore = {
      snapshot: async () => base,
      command,
      startCore: async () => base,
      openInVsCode: async () => undefined
    };

    render(<App />);
    const select = await screen.findByRole("button", { name: /select claude code/i });
    fireEvent.click(select);
    expect(await screen.findByText("Core refused: already bound")).toBeTruthy();
    fireEvent.click(select);
    expect(await screen.findByText("Core request failed: ECONNRESET")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /reconnect core/i }));
    const reconnectedSelect = await screen.findByRole("button", { name: /select claude code/i });
    await waitFor(() => expect((reconnectedSelect as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(reconnectedSelect);
    await waitFor(() => {
      expect(screen.getByText("Core owns continuity · UI owns presentation")).toBeTruthy();
    });
  });

  it("opens a normal empty RC without demo data, a prompt, or a routable Attempt", async () => {
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
      notices: []
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

    expect((await screen.findAllByText("No Runtime selected")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog", { name: /start your first campaign/i })).toBeNull();
    expect(screen.queryByText("Build a durable preview")).toBeNull();
    expect(screen.queryByText("Workspace write permission")).toBeNull();
    expect((screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /select claude code/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(command).not.toHaveBeenCalled();
    expect((await screen.findAllByText(/STABLE V1 RC 1\.0\.0-rc\.1/)).length).toBeGreaterThan(0);
  });

  it("keeps uncertain Runtime identity visible and blocks sending", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const uncertain = {
      ...DEMO_SNAPSHOT,
      preview: false,
      attempt: { ...DEMO_SNAPSHOT.attempt, state: "uncertain" as const, sessionLabel: "projection mismatch" }
    };
    window.goalportCore = {
      snapshot: async () => uncertain,
      command: async () => uncertain,
      startCore: async () => uncertain,
      openInVsCode: async () => undefined
    };

    render(<App />);

    expect((await screen.findAllByText("Runtime identity uncertain")).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the native workspace picker and preserves the form on create refusal", async () => {
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
    fireEvent.click((await screen.findAllByRole("button", { name: /new campaign/i }))[0]);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    const workspace = screen.getByRole("textbox", { name: /project folder/i }) as HTMLInputElement;
    await waitFor(() => expect(workspace.value).toBe("C:\\work\\chosen"));
    const goal = screen.getByRole("textbox", { name: /campaign goal/i }) as HTMLTextAreaElement;
    fireEvent.change(goal, { target: { value: "Keep this exact goal" } });
    fireEvent.click(screen.getByRole("button", { name: /create campaign/i }));

    expect((await screen.findByRole("alert")).textContent).toContain("Core refused: workspace is already held");
    expect(workspace.value).toBe("C:\\work\\chosen");
    expect(goal.value).toBe("Keep this exact goal");
    const request = command.mock.calls.at(-1)?.[0];
    expect(request).toBeDefined();
    expect(request!.payload).toEqual(expect.objectContaining({ workspaceRoot: "C:\\work\\chosen", goal: "Keep this exact goal" }));
    expect(request!.payload.projectId).toBeUndefined();
  });

  it("creates a normal campaign without sending its goal and leaves Runtime unassigned", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const base = { ...DEMO_SNAPSHOT, preview: false };
    const created = {
      ...base,
      campaigns: [{ ...base.campaigns[0], id: "campaign-new", title: "Fresh campaign", goal: "Fresh campaign" }],
      activeCampaignId: "campaign-new",
      activeTask: { id: "task-new", title: "Fresh campaign", acceptance: "", state: "in-progress" as const },
      attempt: { id: "attempt-unassigned", taskId: "task-new", provider: "unassigned", role: "executor" as const, state: "waiting" as const, sessionLabel: "No Runtime selected", eventCount: 0 },
      timeline: [], decisions: [], evidence: [], notices: []
    };
    const command = vi.fn(async (request: CoreCommand) => ({
      requestId: request.requestId,
      accepted: true,
      duplicate: false,
      snapshot: created
    }));
    window.goalportCore = { snapshot: async () => base, command, startCore: async () => base, openInVsCode: async () => undefined };
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Unsent draft from the previous campaign" } });
    fireEvent.click((await screen.findAllByRole("button", { name: /new campaign/i }))[0]);
    fireEvent.change(screen.getByRole("textbox", { name: /project folder/i }), { target: { value: "C:\\work\\fresh" } });
    fireEvent.change(screen.getByRole("textbox", { name: /campaign goal/i }), { target: { value: "Fresh campaign" } });
    fireEvent.click(screen.getByRole("button", { name: /create campaign/i }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /start your first campaign/i })).toBeNull());
    expect(composer.value).toBe("");
    expect((screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Campaign created. Select a Runtime before sending work.")).toBeTruthy();
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0][0].messageType).toBe("create_campaign");
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

    expect(await screen.findByText("Core refused: delivery unknown; it was not sent again")).toBeTruthy();
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
    expect(request.payload).toEqual(expect.objectContaining({
      campaignId: base.activeCampaignId,
      taskId: base.activeTask.id,
      attemptId: base.attempt.id,
      message: "First input"
    }));
    expect(await screen.findByText(new RegExp(`Message recorded for task ${base.activeTask.id}`))).toBeTruthy();
  });

  it("keeps a delayed refused send and its draft with the original campaign", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const campaignA = { ...DEMO_SNAPSHOT, preview: false };
    const campaignB = {
      ...campaignA,
      activeCampaignId: "campaign-evidence-loop",
      activeTask: { id: "task-b", title: "Task B", acceptance: "B", state: "in-progress" as const },
      attempt: { ...campaignA.attempt, id: "attempt-b", taskId: "task-b" },
      timeline: [], notices: []
    };
    const pendingSend = deferred<unknown>();
    const command = vi.fn((request: CoreCommand) => {
      if (request.messageType === "send_message") return pendingSend.promise;
      const selected = request.payload.campaignId === campaignB.activeCampaignId ? campaignB : campaignA;
      return Promise.resolve({ requestId: request.requestId, accepted: true, duplicate: false, snapshot: selected });
    });
    window.goalportCore = { snapshot: async () => campaignA, command, startCore: async () => campaignA, openInVsCode: async () => undefined };
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    await screen.findByText("Task B");
    fireEvent.change(composer, { target: { value: "Campaign B draft" } });
    fireEvent.click(screen.getByRole("button", { name: /build a durable preview/i }));
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe(campaignA.activeCampaignId));
    fireEvent.change(composer, { target: { value: "Campaign A input" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(command.mock.calls.some(([request]) => request.messageType === "send_message")).toBe(true));
    const sendRequest = command.mock.calls.find(([request]) => request.messageType === "send_message")![0];
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    pendingSend.resolve({ goalportRejected: true, requestId: sendRequest.requestId, error: "A delivery remains unknown" });

    await screen.findByText("Task B");
    expect(composer.value).toBe("Campaign B draft");
    expect(screen.queryByText("Core refused: A delivery remains unknown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /build a durable preview/i }));
    expect(await screen.findByText("Core refused: A delivery remains unknown")).toBeTruthy();
    expect(composer.value).toBe("Campaign A input");
  });

  it("clears only the accepted campaign draft when another campaign has identical text", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const campaignA = { ...DEMO_SNAPSHOT, preview: false };
    const campaignB = {
      ...campaignA,
      activeCampaignId: "campaign-evidence-loop",
      activeTask: { id: "task-b", title: "Task B", acceptance: "B", state: "in-progress" as const },
      attempt: { ...campaignA.attempt, id: "attempt-b", taskId: "task-b" },
      timeline: [], notices: []
    };
    const pendingSend = deferred<unknown>();
    const command = vi.fn((request: CoreCommand) => {
      if (request.messageType === "send_message") return pendingSend.promise;
      const selected = request.payload.campaignId === campaignB.activeCampaignId ? campaignB : campaignA;
      return Promise.resolve({ requestId: request.requestId, accepted: true, duplicate: false, snapshot: selected });
    });
    window.goalportCore = { snapshot: async () => campaignA, command, startCore: async () => campaignA, openInVsCode: async () => undefined };
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    await screen.findByText("Task B");
    fireEvent.change(composer, { target: { value: "Identical draft" } });
    fireEvent.click(screen.getByRole("button", { name: /build a durable preview/i }));
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe(campaignA.activeCampaignId));
    fireEvent.change(composer, { target: { value: "Identical draft" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(command.mock.calls.some(([request]) => request.messageType === "send_message")).toBe(true));
    const sendRequest = command.mock.calls.find(([request]) => request.messageType === "send_message")![0];
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    pendingSend.resolve({ requestId: sendRequest.requestId, accepted: true, duplicate: false, snapshot: campaignA });

    await screen.findByText("Task B");
    expect(composer.value).toBe("Identical draft");
    expect(sendRequest.payload).toEqual(expect.objectContaining({
      campaignId: campaignA.activeCampaignId,
      taskId: campaignA.activeTask.id,
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
    const campaignB = {
      ...campaignA,
      activeCampaignId: "campaign-evidence-loop",
      activeTask: { id: "task-b", title: "Task B", acceptance: "B", state: "in-progress" as const },
      attempt: { ...campaignA.attempt, id: "attempt-b", taskId: "task-b" },
      timeline: [], notices: []
    };
    const pendingSelect = deferred<unknown>();
    const command = vi.fn((request: CoreCommand) => request.payload.campaignId === campaignB.activeCampaignId
      ? pendingSelect.promise
      : Promise.resolve({ requestId: request.requestId, accepted: true, duplicate: false, snapshot: campaignA }));
    window.goalportCore = { snapshot: async () => campaignA, command, startCore: async () => campaignA, openInVsCode: async () => undefined };
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "A before selection" } });
    fireEvent.click(screen.getByRole("button", { name: /evidence loop/i }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    const selectRequest = command.mock.calls[0][0];
    fireEvent.change(composer, { target: { value: "Typed while Campaign A remains visible" } });
    expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe(campaignA.activeCampaignId);
    pendingSelect.resolve({ requestId: selectRequest.requestId, accepted: true, duplicate: false, snapshot: campaignB });

    await screen.findByText("Task B");
    expect(composer.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /build a durable preview/i }));
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe(campaignA.activeCampaignId));
    expect(composer.value).toBe("Typed while Campaign A remains visible");
  });

  it("presents Scenario Runtime activity and Stop as explicitly synthetic", async () => {
    window.__GOALPORT_ELECTRON__ = true;
    const nativeActor = "Native Runtime · session";
    const nativeSession = "native session · adapter-local";
    const scenario = {
      ...DEMO_SNAPSHOT,
      preview: true,
      attempt: { ...DEMO_SNAPSHOT.attempt, provider: "scenario", state: "active" as const, sessionLabel: nativeSession },
      timeline: [{ ...DEMO_SNAPSHOT.timeline[0], id: "scenario-event", actor: nativeActor }]
    };
    window.goalportCore = { snapshot: async () => scenario, command: async () => scenario, startCore: async () => scenario, openInVsCode: async () => undefined };
    render(<App />);

    expect(await screen.findByText("Synthetic Scenario Runtime · session")).toBeTruthy();
    expect(screen.queryByText(nativeActor)).toBeNull();
    expect(screen.getByText("Synthetic Scenario · synthetic session · adapter-local")).toBeTruthy();
    expect(screen.getByRole("button", { name: /stop synthetic scenario turn/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(screen.getByRole("button", { name: /stop synthetic scenario and quit/i })).toBeTruthy();
    expect(scenario.timeline[0].actor).toBe(nativeActor);
    expect(scenario.attempt.sessionLabel).toBe(nativeSession);
  });
});
