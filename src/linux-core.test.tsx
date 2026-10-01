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
});
