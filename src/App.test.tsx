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
});

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
});
