// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getCoreClient, resetCoreClientForTests } from "./ipc";
import { DEMO_SNAPSHOT, type CoreSnapshot } from "./types";
import { settleNativeSendIntent, startConversationIntent } from "./lib/sendIntent";

afterEach(() => {
  cleanup();
  resetCoreClientForTests();
  delete window.__GOALPORT_LINUX_CORE__;
  try { sessionStorage.clear(); } catch { /* ignore */ }
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function goal(id: string, title: string): CoreSnapshot {
  return {
    ...DEMO_SNAPSHOT,
    preview: false,
    connection: "connected",
    activeCampaignId: id,
    campaigns: [{ ...DEMO_SNAPSHOT.campaigns[0], id, title }],
    productConversation: { ...DEMO_SNAPSHOT.productConversation!, title },
    notices: []
  };
}

describe("Linux Core bridge", () => {
  it("stays disconnected and does not show the sample preview when Core is down", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "Linux Core is not connected" }, 502)));
    const client = getCoreClient();
    const snapshot = await client.snapshot();
    expect(client.mode).toBe("linux-core");
    expect(snapshot.preview).toBe(false);
    expect(snapshot.connection).toBe("disconnected");
    expect(snapshot.campaigns).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("Build a durable preview");
  });

  it("opens another goal by id and keeps the draft of the goal on screen", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    const goalA = goal("campaign-a", "Goal A");
    const goalB = goal("campaign-b", "Goal B");
    goalB.decisions = [{
      id: "decision-b",
      title: "Codex wants your approval",
      kind: "permission",
      facts: ["Write README"],
      recommendation: "",
      defaultBehavior: "Keep waiting",
      state: "pending",
      actionKnown: true
    }];
    const calls: Array<{ messageType: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string; payload: Record<string, unknown> };
      calls.push(body);
      if (body.messageType === "goal_overview") {
        return jsonResponse({
          ok: true,
          payload: {
            overview: {
              revision: "overview-1",
              truncated: false,
              goals: [
                { campaignId: "campaign-a", projectId: "project-a", workspaceRoot: "/work/a", title: "Goal A", attention: "idle", attemptId: "attempt-a", provider: "codex" },
                { campaignId: "campaign-b", projectId: "project-b", workspaceRoot: "/work/b", title: "Goal B", attention: "awaiting_approval", attemptId: "attempt-b", provider: "codex" }
              ],
              pending: [{ decisionId: "decision-b", campaignId: "campaign-b", attemptId: "attempt-b", title: "Codex wants your approval", kind: "permission" }]
            }
          }
        });
      }
      if (body.messageType === "resolve_decision") {
        return jsonResponse({
          ok: true,
          payload: {
            snapshot: {
              ...goalB,
              decisions: goalB.decisions.map((decision) => ({ ...decision, state: "resolved" as const }))
            }
          }
        });
      }
      if (body.messageType === "goal_detail") {
        const snapshot = body.payload.campaignId === "campaign-b" ? goalB : goalA;
        return jsonResponse({ ok: true, payload: { revision: "detail", snapshot } });
      }
      const requested = body.payload.campaignId;
      return jsonResponse({
        ok: true,
        payload: { unchanged: false, revision: "snap-1", snapshot: requested === "campaign-b" ? goalB : goalA }
      });
    }));

    render(<App />);
    const composer = await screen.findByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
    expect(screen.getByRole("button", { name: /goal b/i })).toBeTruthy();
    expect(screen.getAllByText("Needs your OK")[0]).toBeTruthy();
    fireEvent.change(composer, { target: { value: "Draft stays with A" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe("campaign-b"));
    expect(calls.some((call) => call.messageType === "select_campaign")).toBe(false);
    expect(calls.some((call) => call.messageType === "goal_detail" && call.payload.campaignId === "campaign-b")).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(calls.some((call) => call.messageType === "resolve_decision" && call.payload.decisionId === "decision-b" && call.payload.allow === true)).toBe(true));
    expect(calls.some((call) => call.messageType === "select_campaign")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /goal a/i }));
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe("campaign-a"));
    expect(composer.value).toBe("Draft stays with A");
    expect(window.location.pathname).toBe("/goals/campaign-a");
  });

  it("reopens the goal named in the page address, not Core's shared selection", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    window.history.replaceState(null, "", "/goals/campaign-b");
    const calls: Array<{ messageType: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string; payload: Record<string, unknown> };
      calls.push(body);
      if (body.messageType === "goal_overview") {
        return jsonResponse({ ok: true, payload: { overview: { revision: "overview-1", truncated: false, goals: [], pending: [] } } });
      }
      return jsonResponse({
        ok: true,
        payload: { unchanged: false, revision: "snap-b", snapshot: goal(String(body.payload.campaignId || "campaign-a"), body.payload.campaignId === "campaign-b" ? "Goal B" : "Goal A") }
      });
    }));
    render(<App />);
    await waitFor(() => expect(document.querySelector(".goalport-shell")?.getAttribute("data-campaign-id")).toBe("campaign-b"));
    expect(calls.some((call) => call.messageType === "snapshot_if_changed" && call.payload.campaignId === "campaign-b")).toBe(true);
    expect(window.location.pathname).toBe("/goals/campaign-b");
  });

  it("drops an older snapshot that arrives after a newer one", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    let releaseOlder: (response: Response) => void = () => {};
    const older = new Promise<Response>((resolve) => { releaseOlder = resolve; });
    let snapshots = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string; payload: Record<string, unknown> };
      if (body.messageType === "goal_overview") {
        return jsonResponse({ ok: true, payload: { overview: { revision: "overview-1", truncated: false, goals: [], pending: [] } } });
      }
      snapshots += 1;
      if (snapshots === 1) return older;
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "new", snapshot: goal("campaign-b", "Goal B") } });
    }));
    const client = getCoreClient();
    const first = client.snapshot();
    const second = client.snapshot();
    const newer = await second;
    releaseOlder(jsonResponse({ ok: true, payload: { unchanged: false, revision: "old", snapshot: goal("campaign-a", "Goal A") } }));
    const stale = await first;
    expect(newer.activeCampaignId).toBe("campaign-b");
    expect(stale.activeCampaignId).toBe("campaign-b");
    expect((await client.snapshot()).activeCampaignId).toBe("campaign-b");
  });

  it("points an empty Linux draft at the coordinated CLI and does not invent a coordination bridge", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    const empty = {
      ...DEMO_SNAPSHOT,
      preview: false,
      connection: "connected" as const,
      activeCampaignId: "",
      campaigns: [],
      notices: [],
    };
    let missingHarness = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string };
      if (body.messageType === "coordination_discover") {
        return jsonResponse({ ok: true, payload: { sentence: missingHarness ? "An independent check needs a second logged-in harness, so nothing will be sent." : null, harnesses: missingHarness ? ["codex"] : ["codex", "pi"] } });
      }
      if (body.messageType === "coordination_latest") {
        return jsonResponse({ ok: true, payload: { roots: [{ requestId: "coordinate-verified", rootRequestId: "coordinate-verified", title: "Name the two files", workspacePath: "/home/you/project", outcome: "Verified" }], record: { requestId: "coordinate-verified", rootRequestId: "coordinate-verified", rootLatestId: "coordinate-verified", relationStatus: "legacy-root", verdict: "verified", planningHarness: "Codex", reviewHarness: "Pi", goal: "Name the two files", workspacePath: "/home/you/project", outcome: "The two files are named and nothing was edited.", detail: "Pi checked the file and found only that added line.", change: "Codex added pong under before.", rememberedIntent: { background: true, write: false } }, reason: null } });
      }
      if (body.messageType === "goal_overview") {
        return jsonResponse({ ok: true, payload: { overview: { revision: "overview-1", truncated: false, goals: [], pending: [] } } });
      }
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snap-1", snapshot: empty } });
    }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Name the two files" })).toBeTruthy();
    expect(screen.getByLabelText("Project folder")).toHaveProperty("disabled", true);
    expect(screen.queryByText("Project folder")).toBeNull();
    expect(screen.getByLabelText("Project folder")).toHaveProperty("readOnly", true);
    expect(screen.getByLabelText("Project folder").getAttribute("title")).toBe("/home/you/project");
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(screen.queryByText("Choose a Runtime before sending.")).toBeNull();
    expect(screen.queryByText("Choose a Runtime")).toBeNull();
    expect(screen.queryByRole("button", { name: "Select Runtime" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: /message/i }), { target: { value: "Plan the check" } });
    expect(await screen.findByText("The two files are named and nothing was edited.")).toBeTruthy();
    expect(screen.getByText("What was checked")).toBeTruthy();
    expect(screen.getByText("Executor report")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("Project folder")).toHaveProperty("value", "/home/you/project"));
    expect(screen.getByRole("checkbox", { name: "Allow Codex to change files in this workspace" })).toHaveProperty("checked", false);
    expect(screen.getByRole("checkbox", { name: "Keep working after closing" })).toHaveProperty("checked", true);
    expect(screen.getByText("Last used options restored")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Continue this goal" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Clear follow-up" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Name the two files" })).toBeTruthy();
    expect(screen.queryByText("Send starts a coordinated goal. File changes stay off unless you check the box below.")).toBeNull();
    expect(screen.getAllByRole("region", { name: "Name the two files" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Start a goal" })).toBeNull();
    expect(document.title).toBe("Name the two files");
    expect(screen.queryByText("No goals yet. Start one from the top bar.")).toBeNull();
    expect(document.querySelector(".titlebar-workspace")?.getAttribute("title")).toBe("/home/you/project");
    // This navigation/discovery fixture admits no work. Unknown-admission behavior is tested separately below.
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[1]?.body).includes('"messageType":"coordination_continue"'))).toBe(false);
    missingHarness = true;
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    expect(screen.getByRole("heading", { name: "Start a goal" })).toBeTruthy();
    expect(screen.queryByText("Send starts a coordinated goal. File changes stay off unless you check the box below.")).toBeNull();
    expect(screen.getByText("Use a full path. A leading ~ is your home folder.")).toBeTruthy();
    expect(await screen.findByText("An independent check needs a second logged-in harness, so nothing will be sent.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /message/i }), { target: { value: "Try anyway" } });
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
    missingHarness = false;
    await waitFor(() => expect(screen.queryByText("An independent check needs a second logged-in harness, so nothing will be sent.")).toBeNull(), { timeout: 4000 });
    expect(screen.getByText("Signed in: Codex, Pi.")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Keep working after closing" })).toHaveProperty("checked", false);
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep working after closing" }));
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("Project folder")).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("Project folder")).toHaveProperty("value", "/home/you/project");
    expect(screen.getByRole("button", { name: /Name the two files/ }).className).not.toContain("campaign-active");
    fireEvent.click(screen.getByRole("button", { name: /Name the two files/ }));
    expect(await screen.findByRole("heading", { name: "Name the two files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue this goal" }).closest(".dialog-actions")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Name the two files" }).closest(".timeline-scroll")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Name the two files" }).closest(".draft-composer")).toBeNull();
    expect(window.goalportCore?.coordinateDiscover).toBeUndefined();
    expect(window.goalportCore?.coordinateLaunch).toBeUndefined();
    expect(screen.getByRole("heading", { name: "Name the two files" }).closest(".draft-composer")).toBeNull();
    expect(window.goalportCore?.coordinateDiscover).toBeUndefined();
    expect(window.goalportCore?.coordinateLaunch).toBeUndefined();
  });

  it("keeps Core connected when a request is refused", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string };
      if (body.messageType === "goal_overview") {
        return jsonResponse({ ok: true, payload: { overview: { revision: "overview-1", truncated: false, goals: [], pending: [] } } });
      }
      if (body.messageType === "rename_conversation") {
        return jsonResponse({ ok: false, error: "That title is not allowed" });
      }
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snap-1", snapshot: goal("campaign-a", "Goal A") } });
    }));
    const client = getCoreClient();
    const connected = await client.snapshot();
    expect(connected.connection).toBe("connected");
    const refused = await client.renameConversation!("campaign-a", "nope");
    expect(refused.connection).toBe("connected");
    expect(refused.commandOutcome?.kind).toBe("refused");
    expect(refused.notices[0]).toMatch(/^Core refused:/);
  });

  it("restores the first active goal on return before there is any saved result", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    window.history.replaceState(null, "", "/");
    const empty = { ...DEMO_SNAPSHOT, preview: false, connection: "connected", activeCampaignId: "", campaigns: [], notices: [] };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.messageType === "coordination_latest") return jsonResponse({ ok: true, payload: {
        record: null, line: "Codex is making changes…", jobId: "first-live",
        currentGoal: { goal: "Append pong", workspacePath: "/work" }, currentBase: { kind: "saved-current-base", admittedRequestId: "first-request", rootRequestId: "first-request", jobId: "first-live", goal: "Append pong", workspacePath: "/work", identityConfirmed: true, followUpMode: null, state: "running", phase: "planning", pending: "present", revoked: false, workerGone: false, unconfirmed: false, active: true, allowanceEnd: null, observedAcceptedChildId: null, globalSlot: { kind: "occupied", jobId: "first-live", admittedRequestId: "first-request" }, profileUnconfirmed: false, leftoverHeld: false }, reason: "no coordinated result saved",
      } });
      if (body.messageType === "coordination_discover") return jsonResponse({ ok: true, payload: { sentence: null, harnesses: ["codex", "pi"] } });
      if (body.messageType === "goal_overview") return jsonResponse({ ok: true, payload: { overview: { revision: "overview", truncated: false, goals: [], pending: [] } } });
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snapshot", snapshot: empty } });
    }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Append pong" })).toBeTruthy();
    expect(screen.getByLabelText("Project folder")).toHaveProperty("value", "/work");
    expect(screen.getByRole("button", { name: "Stop Append pong" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Start a goal" })).toBeNull();
  });

  it("restores retained goal/result/evidence through live Stop polls and terminal or unconfirmed remounts", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    window.history.replaceState(null, "", "/");
    const empty: CoreSnapshot = {
      ...DEMO_SNAPSHOT, preview: false, connection: "connected", activeCampaignId: "", campaigns: [], notices: [],
    };
    const record = {
      requestId: "prior", rootRequestId: "prior", rootLatestId: "prior", relationStatus: "legacy-root",
      goal: "Retain previous pong",
      workspacePath: "/work",
      verdict: "verified",
      planningHarness: "Codex",
      reviewHarness: "Pi",
      executionEvidence: {
        status: "available", complete: true, changed: true,
        beforeDiff: "CAPTURED_BEFORE_PONG_TOKEN",
        afterDiff: "CAPTURED_PRIOR_PONG_TOKEN",
        beforeUntrackedFiles: [],
        untrackedFiles: [{ path: "pong.txt", size: 25, content: "CAPTURED_NEW_FILE_PONG_TOKEN", binary: false }],
      },
      auditInputEvidenceCoverage: { totalEvidenceBytes: 100, includedEvidenceBytes: 100, cropped: false, promptBytes: 1000 },
      auditInputEvidenceText: "EXACT_PRIOR_AUDIT_INPUT_TOKEN",
      change: "executor prior report",
      detail: "prior audit",
      outcome: "prior verified result",
    };
    let projection: "live" | "terminal" | "unconfirmed" = "live";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string };
      if (body.messageType === "coordination_latest") {
        const live = projection === "live" ? {
          line: "Access stopped; the current turn may finish, but no further turn was sent.", jobId: "job-current", record,
        } : projection === "terminal" ? {
          line: null, jobId: null, record: { ...record, verdict: "stopped", outcome: "Stopped. No further turn was sent. Existing workspace edits remain." },
        } : {
          line: "This goal's exit is not confirmed, so another goal cannot start yet.", jobId: "job-current",
          record: { ...record, verdict: "unconfirmed", outcome: "previous unconfirmed result" },
        };
        return jsonResponse({ ok: true, payload: { ...live, reason: null } });
      }
      if (body.messageType === "coordination_discover") return jsonResponse({ ok: true, payload: { sentence: null, harnesses: ["codex", "pi"] } });
      if (body.messageType === "goal_overview") return jsonResponse({ ok: true, payload: { overview: { revision: "overview", truncated: false, goals: [], pending: [] } } });
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snapshot", snapshot: empty } });
    }));

    const first = render(<App />);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter((call) => String(call[1]?.body).includes("coordination_latest")).length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByRole("heading", { name: "Retain previous pong" })).toBeTruthy();
    expect(screen.getByLabelText("Project folder")).toHaveProperty("value", "/work");
    expect(screen.getByText("CAPTURED_PRIOR_PONG_TOKEN")).toBeTruthy();
    expect(screen.getByText("CAPTURED_NEW_FILE_PONG_TOKEN")).toBeTruthy();
    expect(screen.getByText("EXACT_PRIOR_AUDIT_INPUT_TOKEN")).toBeTruthy();
    expect(screen.getByText("Saved result")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Current work" }).textContent).toContain("not confirmed");
    expect(screen.queryByRole("heading", { name: "Start a goal" })).toBeNull();
    expect(document.querySelector(".titlebar-workspace")?.getAttribute("title")).toBe("/work");
    expect(screen.queryByRole("checkbox", { name: "Keep working after closing" })).toBeNull();
    expect(screen.queryByLabelText("Allow Codex to change files in this workspace")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue this goal" })).toHaveProperty("disabled", true);

    first.unmount();
    projection = "terminal";
    const terminal = render(<App />);
    expect(await screen.findByRole("heading", { name: "Retain previous pong" })).toBeTruthy();
    expect(screen.getByText("CAPTURED_PRIOR_PONG_TOKEN")).toBeTruthy();
    expect(screen.getByText(/Stopped\. No further turn was sent\. Existing workspace edits remain\./)).toBeTruthy();
    terminal.unmount();

    projection = "unconfirmed";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Retain previous pong" })).toBeTruthy();
    expect(screen.getByText("CAPTURED_PRIOR_PONG_TOKEN")).toBeTruthy();
    expect(screen.getByText("CAPTURED_NEW_FILE_PONG_TOKEN")).toBeTruthy();
    expect(screen.getByText(/This goal's exit is not confirmed/)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Keep working after closing" })).toBeNull();
    expect(screen.queryByLabelText("Allow Codex to change files in this workspace")).toBeNull();
  });

  it("R1: parses IPC type, count and payload for primary click, nonempty Enter, empty explicit Continue, empty Enter and New goal", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    const empty = { ...DEMO_SNAPSHOT, preview: false, connection: "connected" as const, activeCampaignId: "", campaigns: [], notices: [] };
    const calls: Array<{ messageType: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string; payload: Record<string, unknown> };
      calls.push(body);
      if (body.messageType === "coordination_discover") {
        return jsonResponse({ ok: true, payload: { sentence: null, harnesses: ["codex", "pi"] } });
      }
      if (body.messageType === "coordination_latest") {
        return jsonResponse({
          ok: true,
          payload: {
            record: {
              requestId: "req-r1", rootRequestId: "req-r1", rootLatestId: "req-r1", relationStatus: "legacy-root",
              verdict: "verified",
              planningHarness: "Codex",
              reviewHarness: "Pi",
              goal: "Perform task A",
              workspacePath: "/home/you/work",
              outcome: "Verified clean",
              rememberedIntent: { background: true, write: true },
            },
            reason: null,
          },
        });
      }
      if (body.messageType === "coordination_continue") {
        return jsonResponse({ ok: true, payload: { stdout: "The goal was admitted with request id req-cont; its worker runs detached.\n" } });
      }
      if (body.messageType === "coordination_start") {
        return jsonResponse({ ok: true, payload: { stdout: "The goal was admitted with request id req-start; its worker runs detached.\n" } });
      }
      if (body.messageType === "goal_overview") {
        return jsonResponse({ ok: true, payload: { overview: { revision: "overview-1", truncated: false, goals: [], pending: [] } } });
      }
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snap-1", snapshot: empty } });
    }));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Perform task A" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    const continueBtn = screen.getByRole("button", { name: "Continue this goal" });
    expect(continueBtn).toBeTruthy();
    expect(continueBtn).toHaveProperty("disabled", false);
    expect(screen.getByRole("checkbox", { name: "Keep working after closing" })).toHaveProperty("checked", true);
    expect(screen.getByRole("checkbox", { name: "Allow Codex to change files in this workspace" })).toHaveProperty("checked", true);
    expect(screen.getByText("Last used options restored")).toBeTruthy();

    const textarea = screen.getByRole("textbox", { name: /message composer/i });
    expect(textarea).toHaveProperty("placeholder", "Add a follow-up (optional)");

    // 1. Empty Enter emits no dispatch
    const continueCountBefore = calls.filter((c) => c.messageType === "coordination_continue").length;
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(calls.filter((c) => c.messageType === "coordination_continue").length).toBe(continueCountBefore);
    expect(calls.filter((c) => c.messageType === "coordination_start").length).toBe(0);

    // 2. Empty explicit Continue button click dispatches coordination_continue with followUp: ""
    fireEvent.click(continueBtn);
    await waitFor(() => expect(calls.filter((c) => c.messageType === "coordination_continue").length).toBe(continueCountBefore + 1));
    const firstContinue = calls.filter((c) => c.messageType === "coordination_continue")[0];
    expect(firstContinue.payload).toEqual({
      requestId: expect.any(String),
      fromRequestId: "req-r1",
      followUp: "",
      write: true,
      background: true,
      instances: "codex,pi",
    });
    expect(calls.filter((c) => c.messageType === "coordination_start").length).toBe(0);
  });

  it("R1: blocked Continue is disabled and never falls back to coordination_start", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    const empty = { ...DEMO_SNAPSHOT, preview: false, connection: "connected" as const, activeCampaignId: "", campaigns: [], notices: [] };
    const calls: Array<{ messageType: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string; payload: Record<string, unknown> };
      calls.push(body);
      if (body.messageType === "coordination_discover") {
        return jsonResponse({ ok: true, payload: { sentence: null, harnesses: ["codex", "pi"] } });
      }
      if (body.messageType === "coordination_latest") {
        return jsonResponse({
          ok: true,
          payload: {
            record: {
              requestId: "req-blocked", rootRequestId: "req-blocked", rootLatestId: "req-blocked", relationStatus: "legacy-root",
              verdict: "verified",
              planningHarness: "Codex",
              reviewHarness: "Pi",
              goal: "Blocked check",
              workspacePath: "/home/you/work",
              outcome: "Verified clean",
              rememberedIntent: { background: false, write: false },
            },
            reason: null,
          },
        });
      }
      if (body.messageType === "goal_overview") {
        return jsonResponse({ ok: true, payload: { overview: { revision: "overview-1", truncated: false, goals: [], pending: [] } } });
      }
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snap-1", snapshot: empty } });
    }));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Blocked check" })).toBeTruthy();
    // Continue button exists, but is disabled because backgroundConsent is false
    const continueBtn = screen.getByRole("button", { name: "Continue this goal" });
    expect(continueBtn).toHaveProperty("disabled", true);
    // Send button must NOT exist
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.getByText("Keep working after closing must be explicitly selected.")).toBeTruthy();

    const textarea = screen.getByRole("textbox", { name: /message composer/i });
    fireEvent.change(textarea, { target: { value: "Try sending anyway" } });
    // Nonempty Enter while blocked: must NOT dispatch continue or start!
    fireEvent.keyDown(textarea, { key: "Enter" });
    // Clicking disabled Continue: must NOT dispatch continue or start!
    fireEvent.click(continueBtn);
    expect(calls.filter((c) => c.messageType === "coordination_continue").length).toBe(0);
    expect(calls.filter((c) => c.messageType === "coordination_start").length).toBe(0);

    // Checking Keep working after closing enables Continue
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep working after closing" }));
    expect(continueBtn).toHaveProperty("disabled", false);
    // Nonempty Enter now submits via guarded Continue path!
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.messageType === "coordination_continue")).toBe(true));
    const call = calls.find((c) => c.messageType === "coordination_continue")!;
    expect(call.payload.followUp).toBe("Try sending anyway");
    expect(calls.filter((c) => c.messageType === "coordination_start").length).toBe(0);
  });

  it("R2/R3: polls and resident navigation preserve dirty options; New goal starts false",  async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    const empty = { ...DEMO_SNAPSHOT, preview: false, connection: "connected" as const, activeCampaignId: "", campaigns: [], notices: [] };
    let pollCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string };
      if (body.messageType === "coordination_discover") {
        return jsonResponse({ ok: true, payload: { sentence: null, harnesses: ["codex", "pi"] } });
      }
      if (body.messageType === "coordination_latest") {
        pollCount += 1;
        return jsonResponse({
          ok: true,
          payload: {
            roots: [{ requestId: "req-lifecycle", rootRequestId: "req-lifecycle", title: "Lifecycle goal", workspacePath: "/home/you/work", outcome: "Verified" }],
            record: {
              requestId: "req-lifecycle", rootRequestId: "req-lifecycle", rootLatestId: "req-lifecycle", relationStatus: "legacy-root",
              verdict: "verified",
              planningHarness: "Codex",
              reviewHarness: "Pi",
              goal: "Lifecycle goal",
              workspacePath: "/home/you/work",
              outcome: "Verified",
              rememberedIntent: { background: true, write: false },
            },
            reason: null,
          },
        });
      }
      if (body.messageType === "goal_overview") {
        return jsonResponse({ ok: true, payload: { overview: { revision: "overview-1", truncated: false, goals: [], pending: [] } } });
      }
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snap-1", snapshot: empty } });
    }));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Lifecycle goal" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Keep working after closing" })).toHaveProperty("checked", true);
    expect(screen.getByText("Last used options restored")).toBeTruthy();

    // 1. User unchecks option -> Last used options restored note is removed
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep working after closing" }));
    expect(screen.getByRole("checkbox", { name: "Keep working after closing" })).toHaveProperty("checked", false);
    expect(screen.queryByText("Last used options restored")).toBeNull();

    // 2. New goal resets both options to false and displays Start a goal
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    expect(screen.getByRole("heading", { name: "Start a goal" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Keep working after closing" })).toHaveProperty("checked", false);
    expect(screen.getByRole("checkbox", { name: "Allow Codex to change files in this workspace" })).toHaveProperty("checked", false);
    expect(screen.queryByText("Last used options restored")).toBeNull();

    // 3. Resident return preserves the user's dirty choices, not the admission baseline
    fireEvent.click(screen.getByRole("button", { name: /Lifecycle goal/ }));
    expect(await screen.findByRole("heading", { name: "Lifecycle goal" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Keep working after closing" })).toHaveProperty("checked", false);
    expect(screen.getByRole("checkbox", { name: "Allow Codex to change files in this workspace" })).toHaveProperty("checked", false);
    expect(screen.queryByText("Last used options restored")).toBeNull();
  });

  it("keeps an unknown Continue draft without stale restore or Start controls", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    const empty = { ...DEMO_SNAPSHOT, preview: false, connection: "connected" as const, activeCampaignId: "", campaigns: [], notices: [] };
    const calls: Array<{ messageType: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string; payload: Record<string, unknown> };
      calls.push(body);
      if (body.messageType === "coordination_discover") {
        return jsonResponse({ ok: true, payload: { sentence: null, harnesses: ["codex", "pi"] } });
      }
      if (body.messageType === "coordination_latest") {
        return jsonResponse({ ok: true, payload: { record: {
          requestId: "saved-before-unknown", rootRequestId: "saved-before-unknown", rootLatestId: "saved-before-unknown", relationStatus: "legacy-root",
          verdict: "verified",
          planningHarness: "Codex",
          reviewHarness: "Pi",
          goal: "Saved goal with uncertain continuation",
          workspacePath: "/home/you/work",
          outcome: "Verified",
          rememberedIntent: { background: true, write: true },
        }, reason: null } });
      }
      if (body.messageType === "coordination_continue") {
        // Transport/JSON succeeded but did not establish admission.
        return jsonResponse({ ok: true, payload: { stdout: "" } });
      }
      if (body.messageType === "goal_overview") {
        return jsonResponse({ ok: true, payload: { overview: { revision: "overview-1", truncated: false, goals: [], pending: [] } } });
      }
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snap-1", snapshot: empty } });
    }));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Saved goal with uncertain continuation" })).toBeTruthy();
    expect(screen.getByText("Last used options restored")).toBeTruthy();
    const textarea = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(textarea, { target: { value: "Retain this exact follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue this goal" }));

    await waitFor(() => expect(screen.getAllByText(/Continue returned without saying the goal was admitted\./).length).toBeGreaterThan(0));
    expect(textarea).toHaveProperty("value", "Retain this exact follow-up");
    expect(screen.queryByRole("checkbox", { name: "Keep working after closing" })).toBeNull();
    expect(screen.queryByLabelText("Allow Codex to change files in this workspace")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(calls.filter((call) => call.messageType === "coordination_continue")).toHaveLength(1);
    expect(calls.filter((call) => call.messageType === "coordination_start")).toHaveLength(0);

    // Unknown delivery keeps the draft but cannot advertise settled options.
    expect(screen.queryByText("Last used options restored")).toBeNull();
  });


  it("puts the fresh goal input before permission, without inventing discovery or subscription claims", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    const empty = { ...DEMO_SNAPSHOT, preview: false, connection: "connected" as const, activeCampaignId: "", campaigns: [], notices: [] };
    let harnesses: string[] = [];
    const mutations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (["coordination_start", "coordination_continue", "coordination_grant"].includes(body.messageType)) mutations.push(body.messageType);
      if (body.messageType === "coordination_discover") return jsonResponse({ ok: true, payload: { harnesses, consentMissing: true } });
      if (body.messageType === "coordination_latest") return jsonResponse({ ok: true, payload: { record: null } });
      if (body.messageType === "goal_overview") return jsonResponse({ ok: true, payload: { overview: { revision: "o", truncated: false, goals: [], pending: [] } } });
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "s", snapshot: empty } });
    }));
    const unknown = render(<App />);
    expect(await screen.findByRole("button", { name: "Allow background work" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Start a goal" })).toBeTruthy();
    expect(screen.queryByText(/Uses your existing subscriptions/)).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Allow Codex to change files in this workspace" })).toBeNull();
    unknown.unmount();
    harnesses = ["codex", "pi"];
    render(<App />);
    const allow = await screen.findByRole("button", { name: "Allow Codex and Pi to work" });
    const editor = screen.getByRole("textbox", { name: "Message composer" });
    expect(editor).toHaveProperty("placeholder", "What would you like to accomplish?");
    expect(editor.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Start a goal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
    expect(mutations).toEqual([]);
  });

  it("R4: discovers eligible names, hides neutral Linux pill, displays short title with full title attribute", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    const empty = { ...DEMO_SNAPSHOT, preview: false, connection: "connected" as const, activeCampaignId: "", campaigns: [], notices: [] };
    const longGoal = "This is a very long goal description that should be displayed in a compact format in headings and titlebar";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messageType: string };
      if (body.messageType === "coordination_discover") {
        return jsonResponse({ ok: true, payload: { sentence: null, harnesses: ["codex", "pi"] } });
      }
      if (body.messageType === "coordination_latest") {
        return jsonResponse({
          ok: true,
          payload: {
            record: {
              requestId: "req-r4", rootRequestId: "req-r4", rootLatestId: "req-r4", relationStatus: "legacy-root",
              verdict: "verified",
              planningHarness: "Codex",
              reviewHarness: "Pi",
              goal: longGoal,
              workspacePath: "/home/you/work",
              outcome: "Verified",
              rememberedIntent: { background: true, write: false },
            },
            reason: null,
          },
        });
      }
      if (body.messageType === "goal_overview") {
        return jsonResponse({ ok: true, payload: { overview: { revision: "overview-1", truncated: false, goals: [], pending: [] } } });
      }
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snap-1", snapshot: empty } });
    }));

    render(<App />);
    // Heading displays short title (< 48 chars with ...), full goal is in title and aria-label
    const heading = await screen.findByRole("heading", { name: longGoal });
    expect(heading).toBeTruthy();
    expect(heading.getAttribute("title")).toBe(longGoal);
    expect(heading.textContent).toContain("This is a very long goal description that sho...");

    // Linux neutral connection pill is hidden when connected
    expect(screen.queryByText("This status is not the workbench connection")).toBeNull();
    expect(document.querySelector(".connection-neutral")).toBeNull();

    // TitleBar campaign text is short title, title tooltip is full goal
    const titlebarCampaign = document.querySelector(".titlebar-campaign");
    expect(titlebarCampaign).not.toBeNull();
    expect(titlebarCampaign?.getAttribute("title")).toBe(longGoal);
    expect(titlebarCampaign?.textContent).toBe("This is a very long goal description that sho...");
  });
});

function localRefusal(id = "synthetic-stable", method = "start_conversation"): Record<string, unknown> {
  const reason = "The conversation folder could not be confirmed. Choose an existing accessible absolute folder.";
  return { protocolVersion: "goalport.ipc.v2", requestId: id, ok: false, error: reason,
    payload: { requestId: id, accepted: false, messageType: method, refusalSource: "workbench-native-preflight",
      rejection: { code: "native-preflight-refused", message: reason, deliveryState: "FAILED",
        nativeDispatchState: "NOT_STARTED", retryMode: "NEW_REQUEST", reservation: null } } };
}

function refusalBridge(response: () => Response | Promise<Response>, notices: string[] = []) {
  window.__GOALPORT_LINUX_CORE__ = true;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body));
    if (["start_conversation", "conversation_send", "rename_conversation"].includes(command.messageType)) return response();
    return jsonResponse({ ok: true, payload: command.messageType === "goal_overview"
      ? { overview: { revision: "fixture", truncated: false, goals: [], pending: [] } }
      : { snapshot: { ...goal("campaign-a", "Goal A"), notices }, revision: "fixture", unchanged: false } });
  }));
  return getCoreClient();
}

describe("strict Linux invocation-local refusal parsing", () => {
  it.each(["start_conversation", "conversation_send"])("preserves connected snapshot/no global Core label for validated %s", async method => {
    const raw = localRefusal("synthetic-stable", method);
    (raw.payload as Record<string, unknown>).technical = "Synthetic bounded diagnostic";
    const client = refusalBridge(() => jsonResponse(raw), ["Existing Core warning"]);
    const before = await client.snapshot();
    const after = method === "start_conversation"
      ? await client.startConversation!("/fixture/missing", "codex", "draft", "synthetic-stable", true)
      : await client.conversationSend!("follow", "campaign-a", "attempt-a", "synthetic-stable");
    expect(after.connection).toBe(before.connection);
    expect(after.activeCampaignId).toBe(before.activeCampaignId);
    expect(after.notices).toEqual(before.notices);
    expect(after.commandOutcome).toEqual({ kind: "refused", requestId: "synthetic-stable", messageType: method,
      error: raw.error, refusalSource: "workbench-native-preflight", rejection: (raw.payload as Record<string, unknown>).rejection,
      technical: "Synthetic bounded diagnostic" });
  });

  const changes: Array<[string, (packet: Record<string, unknown>) => void]> = [
    ["wrong protocol", p => { p.protocolVersion = "goalport.ipc.v1"; }],
    ["missing protocol", p => { delete p.protocolVersion; }],
    ["wrong outer id", p => { p.requestId = "other"; }],
    ["missing outer id", p => { delete p.requestId; }],
    ["wrong inner id", p => { (p.payload as Record<string, unknown>).requestId = "other"; }],
    ["missing inner id", p => { delete (p.payload as Record<string, unknown>).requestId; }],
    ["wrong method", p => { (p.payload as Record<string, unknown>).messageType = "conversation_send"; }],
    ["missing method", p => { delete (p.payload as Record<string, unknown>).messageType; }],
    ["missing accepted", p => { delete (p.payload as Record<string, unknown>).accepted; }],
    ["missing ok", p => { delete p.ok; }],
    ["missing payload", p => { delete p.payload; }],
    ["array payload", p => { p.payload = []; }],
    ["missing rejection", p => { delete (p.payload as Record<string, unknown>).rejection; }],
    ["array rejection", p => { (p.payload as Record<string, unknown>).rejection = []; }],
    ["inconsistent reason", p => { p.error = "Another reason"; }],
    ["wrong source", p => { (p.payload as Record<string, unknown>).refusalSource = "Core"; }],
    ["missing source", p => { delete (p.payload as Record<string, unknown>).refusalSource; }],
    ["accepted true", p => { (p.payload as Record<string, unknown>).accepted = true; }],
    ["accepted number", p => { (p.payload as Record<string, unknown>).accepted = 0; }],
    ["ok true", p => { p.ok = true; }],
    ["ok number", p => { p.ok = 0; }],
    ["connection claim", p => { p.connection = "disconnected"; }],
    ["fake snapshot", p => { (p.payload as Record<string, unknown>).snapshot = {}; }],
    ["raw technical controls", p => { (p.payload as Record<string, unknown>).technical = "a\nb"; }],
    ["oversize technical utf8", p => { (p.payload as Record<string, unknown>).technical = "界".repeat(683); }],
    ["non-string technical", p => { (p.payload as Record<string, unknown>).technical = {}; }],
    ...(["code", "message", "deliveryState", "nativeDispatchState", "retryMode", "reservation"] as const).flatMap(key => [
      [`missing rejection ${key}`, (p: Record<string, unknown>) => { delete ((p.payload as Record<string, unknown>).rejection as Record<string, unknown>)[key]; }],
      [`wrong rejection ${key}`, (p: Record<string, unknown>) => { ((p.payload as Record<string, unknown>).rejection as Record<string, unknown>)[key] = key === "reservation" ? {} : "wrong"; }]
    ] as Array<[string, (p: Record<string, unknown>) => void]>)
  ];
  it.each(changes)("does not promote %s to host proof", async (_label, change) => {
    const raw = localRefusal(); change(raw);
    const client = refusalBridge(() => jsonResponse(raw));
    await client.snapshot();
    const after = await client.startConversation!("/fixture", "codex", "draft", "synthetic-stable", true);
    expect(after.commandOutcome?.refusalSource).toBeUndefined();
    expect(after.commandOutcome?.rejection).toBeUndefined();
    const intent = startConversationIntent("synthetic-stable", "/fixture", "codex", "draft");
    expect(settleNativeSendIntent(intent, after.commandOutcome)).toEqual({ ...intent, state: "reconcile" });
  });

  it.each([
    ["legacy prose", () => jsonResponse({ ok: false, error: "Nothing was sent." })],
    ["HTTP error despite packet", () => jsonResponse(localRefusal(), 502)],
    ["malformed JSON", () => new Response("not json")],
    ["network failure", () => Promise.reject(Error("synthetic lost response"))]
  ] as const)("keeps %s conservative", async (_label, response) => {
    const client = refusalBridge(response);
    await client.snapshot();
    const after = await client.startConversation!("/fixture", "codex", "draft", "synthetic-stable", true);
    expect(after.commandOutcome?.kind).not.toBe("accepted");
    expect(after.commandOutcome?.refusalSource).toBeUndefined();
    expect(after.commandOutcome?.rejection).toBeUndefined();
  });

  it("does not trust a valid-looking host packet for a non-send command", async () => {
    const client = refusalBridge(() => jsonResponse(localRefusal("synthetic-stable", "rename_conversation")));
    await client.snapshot();
    const after = await client.renameConversation!("campaign-a", "title");
    expect(after.commandOutcome?.refusalSource).toBeUndefined();
    expect(after.notices[0]).toMatch(/^Core refused:/);
  });

  it("cannot publish a late host refusal into a newly pinned view", async () => {
    let resolve!: (response: Response) => void;
    const pendingResponse = new Promise<Response>(done => { resolve = done; });
    const client = refusalBridge(() => pendingResponse);
    await client.snapshot();
    const pending = client.startConversation!("/fixture", "codex", "draft", "synthetic-stable", true);
    client.pinView?.("campaign-other");
    resolve(jsonResponse(localRefusal()));
    const after = await pending;
    expect(after.commandOutcome?.refusalSource).toBeUndefined();
    expect(after.notices).toEqual([]);
  });
});
