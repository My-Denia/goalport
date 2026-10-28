// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getCoreClient, resetCoreClientForTests } from "./ipc";
import { DEMO_SNAPSHOT, type CoreSnapshot } from "./types";

afterEach(() => {
  cleanup();
  resetCoreClientForTests();
  delete window.__GOALPORT_LINUX_CORE__;
  vi.unstubAllGlobals();
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
    expect(screen.getByText("Waiting for your approval")).toBeTruthy();
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
        return jsonResponse({ ok: true, payload: { record: { requestId: "coordinate-verified", verdict: "verified", planningHarness: "Codex", reviewHarness: "Pi", goal: "Name the two files", workspacePath: "/home/you/project", outcome: "The two files are named and nothing was edited.", detail: "Pi checked the file and found only that added line.", change: "Codex added pong under before." }, reason: null } });
      }
      if (body.messageType === "goal_overview") {
        return jsonResponse({ ok: true, payload: { overview: { revision: "overview-1", truncated: false, goals: [], pending: [] } } });
      }
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snap-1", snapshot: empty } });
    }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Name the two files" })).toBeTruthy();
    expect(screen.getByText("A new send stays in this folder. New goal can use another.")).toBeTruthy();
    expect(screen.getByLabelText("Project folder")).toHaveProperty("disabled", true);
    expect(screen.getByText("Project folder")).toBeTruthy();
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(screen.queryByText("Choose a Runtime before sending.")).toBeNull();
    expect(screen.queryByText("Choose a Runtime")).toBeNull();
    expect(screen.queryByRole("button", { name: "Select Runtime" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: /message/i }), { target: { value: "Plan the check" } });
    expect(await screen.findByText("verified. The two files are named and nothing was edited.")).toBeTruthy();
    expect(screen.getByText("What was checked")).toBeTruthy();
    expect(screen.getByText("Executor report")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("Project folder")).toHaveProperty("value", "/home/you/project"));
    expect(screen.getByRole("checkbox", { name: "Allow Codex to change files in this workspace" })).toHaveProperty("checked", false);
    expect(screen.getByRole("checkbox", { name: "Keep working after closing" })).toHaveProperty("checked", false);
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Keep working after closing must be explicitly selected.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear follow-up" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Name the two files" })).toBeTruthy();
    expect(screen.queryByText("Send starts a coordinated goal. File changes stay off unless you check the box below.")).toBeNull();
    expect(screen.getAllByRole("region", { name: "Name the two files" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Start a goal" })).toBeNull();
    expect(document.title).toBe("Name the two files");
    expect(screen.queryByText("No goals yet. Start one from the top bar.")).toBeNull();
    expect(document.querySelector(".titlebar-workspace")?.getAttribute("title")).toBe("/home/you/project");
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep working after closing" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((call) => String(call[1]?.body).includes("coordination_start"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Continue this goal" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((call) => String(call[1]?.body).includes("coordination_continue"))).toBe(true));
    missingHarness = true;
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    expect(screen.getByRole("heading", { name: "Start a goal" })).toBeTruthy();
    expect(screen.getByText("Send starts a coordinated goal. File changes stay off unless you check the box below.")).toBeTruthy();
    expect(screen.getByText("Use a full path. A leading ~ is your home folder.")).toBeTruthy();
    expect(await screen.findByText("An independent check needs a second logged-in harness, so nothing will be sent.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /message/i }), { target: { value: "Try anyway" } });
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
    missingHarness = false;
    await waitFor(() => expect(screen.queryByText("An independent check needs a second logged-in harness, so nothing will be sent.")).toBeNull(), { timeout: 4000 });
    expect(screen.getByText("Signed in: Codex, Pi.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("Project folder")).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("Project folder")).toHaveProperty("value", "/home/you/project");
    expect(screen.getByRole("button", { name: /Name the two files/ }).className).not.toContain("campaign-active");
    fireEvent.click(screen.getByRole("button", { name: /Name the two files/ }));
    expect(screen.getByRole("heading", { name: "Name the two files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue this goal" }).closest(".dialog-actions")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Name the two files" }).closest(".timeline-scroll")).toBeTruthy();
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
        currentGoal: { goal: "Append pong", workspacePath: "/work" }, reason: "no coordinated result saved",
      } });
      if (body.messageType === "coordination_discover") return jsonResponse({ ok: true, payload: { sentence: null, harnesses: ["codex", "pi"] } });
      if (body.messageType === "goal_overview") return jsonResponse({ ok: true, payload: { overview: { revision: "overview", truncated: false, goals: [], pending: [] } } });
      return jsonResponse({ ok: true, payload: { unchanged: false, revision: "snapshot", snapshot: empty } });
    }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Append pong" })).toBeTruthy();
    expect(screen.getByLabelText("Project folder")).toHaveProperty("value", "/work");
    expect(screen.getByRole("button", { name: "Stop this goal" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Start a goal" })).toBeNull();
  });

  it("restores retained goal/result/evidence through live Stop polls and terminal or unconfirmed remounts", async () => {
    window.__GOALPORT_LINUX_CORE__ = true;
    window.history.replaceState(null, "", "/");
    const empty: CoreSnapshot = {
      ...DEMO_SNAPSHOT, preview: false, connection: "connected", activeCampaignId: "", campaigns: [], notices: [],
    };
    const record = {
      requestId: "prior",
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
    expect(screen.getByText(/Previous saved result; the stop message above describes the current job/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Start a goal" })).toBeNull();
    expect(document.querySelector(".titlebar-workspace")?.getAttribute("title")).toBe("/work");

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
  });
});
