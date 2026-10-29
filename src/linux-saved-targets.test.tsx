// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { resetCoreClientForTests } from "./ipc";
import { DEMO_SNAPSHOT } from "./types";
import { CampaignNav } from "./nav/CampaignNav";
import type { CoordinatedCurrentJob, SavedTargetResult } from "./coordination/savedTargetView";
import { coordinatedRouteFromLocation, setCoordinatedRoute, replaceGoalRoute } from "./lib/goalRoute";

afterEach(() => {
  cleanup(); resetCoreClientForTests(); delete window.__GOALPORT_LINUX_CORE__;
  sessionStorage.clear(); window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
function fixture(hash = "#coordinated/result/a") {
  window.__GOALPORT_LINUX_CORE__ = true;
  window.history.replaceState(null, "", "/" + hash);
  const empty = { ...DEMO_SNAPSHOT, preview: false, connection: "connected", activeCampaignId: "", campaigns: [], notices: [] };
  const root = (id: string): SavedTargetResult => ({ requestId: id, rootRequestId: id, rootLatestId: id, goal: `Goal ${id.toUpperCase()}`, workspacePath: `/work/${id}`, verdict: "verified", outcome: `Actual saved ${id.toUpperCase()}`, relationStatus: "legacy-root", relationUnavailableReason: null, rememberedIntent: { background: true, write: id === "a" }, detail: `Independent check ${id}`, change: `Executor report ${id}` });
  const records: Record<string, SavedTargetResult> = { a: root("a"), b: root("b") };
  let current: CoordinatedCurrentJob | null = null;
  let held = false;
  let offline = false;
  let coreEnabled = false;
  let admitted: unknown = { ok: false, error: "Fixture refusal" };
  const calls: { messageType: string; payload: Record<string, unknown> }[] = [];
  const polls: (() => void)[] = [];
  vi.spyOn(window, "setInterval").mockImplementation((handler, ms) => {
    if (typeof handler === "function" && (ms === 2000 || ms === 8000)) polls.push(handler as () => void);
    return 1 as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls.push(body);
    if (["coordination_latest", "coordination_detail", "coordination_list"].includes(body.messageType)) {
      if (offline) throw Error("fixture offline");
      const selected = records[String(body.payload.requestId ?? "b")] ?? null;
      const roots = ["a", "b"].map(id => ({ requestId: records[id].rootLatestId ?? id, reason: records[id].rootLatestId ? null : "The latest result cannot be identified.", rootRequestId: id, title: records[id].goal, workspacePath: records[id].workspacePath, outcome: `Summary ${id.toUpperCase()}` }));
      return response({ ok: true, payload: { ok: true, roots, profileLatestId: "b", record: selected,
        history: Object.values(records).filter(r => r.rootRequestId === selected?.rootRequestId).map(r => ({ requestId: r.requestId, savedAt: r.requestId === "a" ? "2026-01-01" : "2026-01-02", outcome: r.outcome })),
        currentJob: current, line: held ? null : current?.line, jobId: held ? null : current?.jobId, unconfirmedGoal: current?.line.includes("not confirmed"), leftoverHeld: held } });
    }
    if (body.messageType === "coordination_discover") return response({ ok: true, payload: { sentence: null, harnesses: ["codex", "pi"], consentMissing: false } });
    if (body.messageType === "coordination_continue" || body.messageType === "coordination_start") {
      if (admitted instanceof Error) throw admitted;
      return response(admitted);
    }
    if (body.messageType === "coordination_acknowledge") { held = false; current = null; return response({ ok: true, payload: { stdout: "The interrupted job stays unreplayed; the same request id cannot be admitted again." } }); }
    if (body.messageType === "coordination_stop") return response({ ok: true, payload: { stdout: "revoked: true\npending command: still-running\n" } });
    if (body.messageType === "goal_overview") return response({ ok: true, payload: { overview: { revision: "fixture", truncated: false, goals: coreEnabled ? [{ campaignId: "campaign-core", projectId: "project-core", workspaceRoot: "/core", title: "Core goal", attention: "idle" }] : [], pending: [] } } });
    const snapshot = coreEnabled ? { ...empty, activeCampaignId: "campaign-core", campaigns: [{ ...DEMO_SNAPSHOT.campaigns[0], id: "campaign-core", title: "Core goal" }], productConversation: { ...DEMO_SNAPSHOT.productConversation!, title: "Core goal" } } : empty;
    return response({ ok: true, payload: { revision: "fixture", unchanged: false, snapshot } });
  }));
  const tick = async () => { await act(async () => { for (const poll of polls) poll(); await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const child = () => {
    records.a.rootLatestId = "a2";
    records.a2 = { ...records.a, requestId: "a2", outcome: "Actual child A", relationStatus: "valid", continuation: { parentRequestId: "a", rootRequestId: "a", originalGoal: "Goal A", followUp: "New instruction" }, rememberedIntent: { background: true, write: false } };
  };
  return { calls, records, tick, child, core(value: boolean) { coreEnabled = value; }, job(value: CoordinatedCurrentJob | null) { current = value; }, held(value: boolean) { held = value; }, offline(value: boolean) { offline = value; }, reply(value: unknown) { admitted = value; } };
}
const text = () => screen.getByRole("textbox", { name: /message composer/i }) as HTMLTextAreaElement;
const continuation = () => screen.getByRole("button", { name: "Continue this goal" });
const mutationTypes = new Set(["coordination_start", "coordination_continue", "coordination_stop", "coordination_grant", "coordination_acknowledge", "start_conversation", "conversation_send"]);

it("keeps saved-target navigation to a short title, folder name, and typed status", () => {
  const full = "Saved goal\n" + "Detailed request. ".repeat(30), folder = "/a/very/long/project/path/workspace";
  render(<CampaignNav snapshot={{ ...DEMO_SNAPSHOT, campaigns: [], goalOverview: undefined }} collapsed={false} savedTargets={[{ requestId: "a", title: full, workspacePath: folder, outcome: "### RAW REPORT should stay in details", statusLabel: "Changes verified", active: true }]} onSelectCampaign={() => {}} onSelectProject={() => {}} onRenameCampaign={() => {}} />);
  const item = screen.getByRole("button", { name: /^Saved goal/ });
  expect(item.querySelector("strong")?.textContent).toBe("Saved goal");
  expect([...item.querySelectorAll("small")].map(x => x.textContent)).toEqual(["workspace", "Changes verified"]);
  expect(item.getAttribute("title")).toBe(`${full} — ${folder}`);
  expect(screen.queryByText(/RAW REPORT/)).toBeNull();
});

it("selects exact A while profile latest is B; A→B→A and reload preserve selection without mutation", async () => {
  const f = fixture();
  const view = render(<App />);
  await screen.findByRole("heading", { name: "Goal A" });
  expect(screen.getByText("Actual saved A")).toBeTruthy();
  fireEvent.change(text(), { target: { value: "Unsent A" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Allow Codex/ }));
  fireEvent.click(screen.getByRole("button", { name: "Goal B, /work/b" }));
  await screen.findByRole("heading", { name: "Goal B" });
  fireEvent.change(text(), { target: { value: "Unsent B" } });
  fireEvent.click(screen.getByRole("button", { name: "Goal A, /work/a" }));
  await screen.findByRole("heading", { name: "Goal A" });
  expect(text().value).toBe("Unsent A");
  expect(screen.getByRole("checkbox", { name: /Allow Codex/ })).toHaveProperty("checked", false);
  expect(window.location.hash).toBe("#coordinated/result/a");
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
  view.unmount(); render(<App />);
  await screen.findByRole("heading", { name: "Goal A" });
  expect(text().value).toBe(""); // Selection persists; resident drafts do not promise restart persistence.
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});

it("keeps current-work and Stop readable for a multi-line goal while preserving full identity", async () => {
  const f = fixture();
  const full = "Goal B\n" + "Detailed instruction. ".repeat(40);
  f.job({ jobId: "long-b", requestId: "live-b", rootRequestId: "b", goal: full, workspacePath: "/work/b", identityConfirmed: true, line: "Codex is planning…" });
  render(<App />);
  await screen.findByRole("heading", { name: "Goal A" });
  const stop = screen.getByRole("button", { name: /^Stop Goal B/ });
  expect(stop.textContent).toBe("Stop Goal B");
  expect(stop.getAttribute("title")).toBe(`Stop ${full}`);
  expect(screen.getByText("Current work — Goal B").getAttribute("title")).toBe(full);
});

it.each(["running", "revoked", "unknown", "held"])("keeps saved A readable with current B %s; locks Continue/New and Stop only targets B", async state => {
  const f = fixture();
  const line = state === "unknown" ? "B's exit is not confirmed." : state === "revoked" ? "Access stopped; the current turn may finish, but no further turn was sent." : "Pi is planning B…";
  if (state === "held") f.held(true);
  f.job({ jobId: "job-b", requestId: "live-b", rootRequestId: "b", goal: "Goal B", workspacePath: "/work/b", identityConfirmed: true, line });
  render(<App />);
  await screen.findByRole("heading", { name: "Goal A" });
  expect(screen.getByText("Saved result", { selector: "p.workspace-evidence-label" })).toBeTruthy();
  expect(screen.getByText("Actual saved A")).toBeTruthy();
  expect(continuation()).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: /^New goal(?:\.|$)/ })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("checkbox", { name: /Allow Codex/ })).toBeNull();
  expect(screen.queryByText("Last used options restored")).toBeNull();
  fireEvent.change(text(), { target: { value: "A follow-up" } });
  fireEvent.keyDown(text(), { key: "Enter" }); fireEvent.click(continuation());
  fireEvent.click(screen.getByRole("button", { name: "Goal B, /work/b" }));
  await screen.findByRole("heading", { name: "Goal B" });
  expect(screen.getByText("Previous result")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Goal A, /work/a" }));
  await screen.findByRole("heading", { name: "Goal A" });
  expect(text().value).toBe("A follow-up");
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
  if (state !== "held") {
    const button = screen.getByRole("button", { name: state === "unknown" ? "Record stop for Goal B" : "Stop Goal B" });
    fireEvent.click(button);
    await waitFor(() => expect(f.calls.filter(c => c.messageType === "coordination_stop")).toHaveLength(1));
    expect(f.calls.find(c => c.messageType === "coordination_stop")?.payload).toEqual({ jobId: "job-b" });
    expect(screen.getByRole("heading", { name: "Goal A" })).toBeTruthy();
  } else {
    fireEvent.click(screen.getByRole("button", { name: "Leave it unreplayed" }));
    await waitFor(() => expect(f.calls.filter(c => c.messageType === "coordination_acknowledge")).toHaveLength(1));
    expect(f.calls.find(c => c.messageType === "coordination_acknowledge")?.payload).toEqual({ jobId: "job-b" });
    expect(text().value).toBe("A follow-up");
    expect(screen.getByRole("heading", { name: "Goal A" })).toBeTruthy();
  }
});

it("does not invent a Stop identity when current work identity is unknown", async () => {
  const f = fixture(); f.job({ jobId: "job-unknown", identityConfirmed: false, line: "This goal's exit is not confirmed." });
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  expect(screen.getByText("Current work — not confirmed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Record stop|Stop Goal/ })).toBeNull();
  expect(continuation()).toHaveProperty("disabled", true);
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});

it.each(["#coordinated/result/missing", "#coordinated/result/%E0%A4%A", "#coordinated/result/a%2Fb"])("keeps explicit unavailable route %s empty; never falls back to B or Start", async hash => {
  const f = fixture(hash); render(<App />);
  await screen.findByRole("heading", { name: "Saved goal unavailable" });
  await waitFor(() => expect(screen.getByText("That saved goal is no longer available or cannot be identified.")).toBeTruthy());
  expect(continuation()).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  expect(screen.queryByText("Actual saved B")).toBeNull();
  expect(window.location.hash).toBe(hash);
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});

it("pinned A gets only a newer notice, then explicitly opens child; earlier results share A's draft", async () => {
  const f = fixture(); render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  fireEvent.change(text(), { target: { value: "Keep this draft" } });
  f.child(); await f.tick();
  expect(screen.getByText("Actual saved A")).toBeTruthy();
  expect(window.location.hash).toBe("#coordinated/result/a");
  expect(continuation()).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Newer result available" }));
  await screen.findByText("Actual child A");
  expect(window.location.hash).toBe("#coordinated/result/a2");
  expect(text().value).toBe("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: /2026-01-01/ }));
  await screen.findByText("Actual saved A");
  expect(text().value).toBe("Keep this draft");
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});

it.each(["refusal", "network", "unknown"])("%s keeps text and choices and never becomes Start", async kind => {
  const f = fixture();
  f.reply(kind === "network" ? Error("offline admission") : kind === "unknown" ? { ok: true, payload: { stdout: "No confirmation" } } : { ok: false, error: "Fixture refusal" });
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  fireEvent.change(text(), { target: { value: "Exact follow-up 中文" } });
  fireEvent.keyDown(text(), { key: "Enter" });
  await waitFor(() => expect(f.calls.filter(c => c.messageType === "coordination_continue")).toHaveLength(1));
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", true));
  expect(text().value).toBe("Exact follow-up 中文");
  expect(f.calls.find(c => c.messageType === "coordination_continue")?.payload).toEqual({ fromRequestId: "a", followUp: "Exact follow-up 中文", write: true, background: true, instances: "codex,pi" });
  expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  expect(screen.getByRole("button", { name: /^New goal(?:\.|$)/ })).toHaveProperty("disabled", true);
});

it("admitted reply binds its new ID; only its eventual saved child advances locally; B completion never steals A", async () => {
  const f = fixture(); f.reply({ ok: true, payload: { stdout: "job: job-a2\nrequest: a2\nThe goal was admitted with request id a2; its worker runs detached.\n" } });
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  fireEvent.change(text(), { target: { value: "New instruction" } });
  fireEvent.click(continuation());
  await waitFor(() => expect(text().value).toBe(""));
  expect(screen.getByText("Current work — Goal A")).toBeTruthy();
  f.job({ jobId: "job-a2", requestId: "a2", rootRequestId: "a", goal: "Goal A", workspacePath: "/work/a", identityConfirmed: true, line: "Codex is planning…" });
  await f.tick();
  expect(window.location.hash).toBe("#coordinated/result/a");
  f.child(); f.job(null); await f.tick();
  await waitFor(() => expect(window.location.hash).toBe("#coordinated/result/a2"));
  await screen.findByText("Actual child A");
  expect(f.calls.filter(c => c.messageType === "coordination_continue")).toHaveLength(1);
  expect(f.calls.filter(c => c.messageType === "coordination_start")).toHaveLength(0);
  f.job({ jobId: "other-b", requestId: "live-b", rootRequestId: "b", goal: "Goal B", identityConfirmed: true, line: "Planning B" }); await f.tick();
  fireEvent.change(text(), { target: { value: "Stay on A" } });
  f.job(null); await f.tick();
  expect(window.location.hash).toBe("#coordinated/result/a2"); expect(text().value).toBe("Stay on A");
});

it("deliberate history navigation cancels local admission auto-follow before returning to an older parent", async () => {
  const f = fixture();
  f.reply({ ok: true, payload: { stdout: "job: job-a2\nrequest: a2\nThe goal was admitted with request id a2; its worker runs detached.\n" } });
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  fireEvent.change(text(), { target: { value: "New instruction" } }); fireEvent.click(continuation());
  await waitFor(() => expect(text().value).toBe(""));
  f.job({ jobId: "job-a2", requestId: "a2", rootRequestId: "a", goal: "Goal A", workspacePath: "/work/a", identityConfirmed: true, line: "Codex is planning…" });
  await f.tick();
  fireEvent.click(screen.getByRole("button", { name: "Goal B, /work/b" }));
  await screen.findByRole("heading", { name: "Goal B" });
  f.child(); f.job(null); await f.tick();
  window.history.pushState(null, "", "/#coordinated/result/a"); fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", { name: "Goal A" }); await f.tick();
  expect(window.location.hash).toBe("#coordinated/result/a");
  expect(screen.getByRole("button", { name: "Newer result available" })).toBeTruthy();
  expect(continuation()).toHaveProperty("disabled", true);
  expect(f.calls.filter(c => c.messageType === "coordination_continue")).toHaveLength(1);
});

it("hash/pop navigation is authoritative, offline keeps exact selection, New starts safe", async () => {
  const f = fixture(); render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  window.history.pushState(null, "", "/#coordinated/result/b"); fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", { name: "Goal B" });
  window.history.replaceState(null, "", "/#coordinated/result/a"); fireEvent(window, new PopStateEvent("popstate"));
  await screen.findByRole("heading", { name: "Goal A" });
  f.offline(true); await f.tick();
  expect(screen.getByRole("heading", { name: "Goal A" })).toBeTruthy();
  expect(continuation()).toHaveProperty("disabled", true);
  expect(window.location.hash).toBe("#coordinated/result/a");
  fireEvent.click(screen.getByRole("button", { name: "New goal" }));
  expect(window.location.hash).toBe("#coordinated/new");
  expect(screen.getByRole("checkbox", { name: /Allow Codex/ })).toHaveProperty("checked", false);
  expect(screen.getByRole("checkbox", { name: "Keep working after closing" })).toHaveProperty("checked", false);
});

it("an unrouted initial entry chooses profile latest once, not Core's shared campaign", async () => {
  const f = fixture(""); f.core(true); render(<App />);
  await screen.findByRole("heading", { name: "Goal B" });
  expect(window.location.hash).toBe("#coordinated/result/b");
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});

it("Core polling cannot erase a coordinated route; deliberate Core click leaves it, back returns A's draft", async () => {
  const f = fixture(); f.core(true); render(<App />);
  await screen.findByRole("heading", { name: "Goal A" });
  fireEvent.change(text(), { target: { value: "A draft across Core" } });
  await f.tick(); expect(window.location.hash).toBe("#coordinated/result/a");
  fireEvent.click(screen.getByRole("button", { name: /Core goal/ }));
  await waitFor(() => expect(window.location.hash).toBe(""));
  expect(window.location.pathname).toBe("/goals/campaign-core");
  window.history.replaceState(null, "", "/#coordinated/result/a"); fireEvent(window, new PopStateEvent("popstate"));
  await screen.findByRole("heading", { name: "Goal A" });
  expect(text().value).toBe("A draft across Core");
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});

it("a pristine read-only child initializes from its OWN admission, never the root writer's choices", async () => {
  const f = fixture(); render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  expect(screen.getByRole("checkbox", { name: /Allow Codex/ })).toHaveProperty("checked", true);
  f.child(); await f.tick();
  fireEvent.click(screen.getByRole("button", { name: "Newer result available" }));
  await screen.findByText("Actual child A");
  expect(screen.getByRole("checkbox", { name: /Allow Codex/ })).toHaveProperty("checked", false);
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});

it.each(["invalid", "head-tie"])("%s preserves the saved result but refuses continuation", async state => {
  const f = fixture();
  f.records.a.rootLatestId = null;
  if (state === "invalid") { f.records.a.rootRequestId = null; f.records.a.relationStatus = "invalid"; f.records.a.relationUnavailableReason = "The saved goal relationship is unavailable."; }
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  expect(screen.getByText("Actual saved A")).toBeTruthy();
  expect(continuation()).toHaveProperty("disabled", true);
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});

it("goal route helper keeps coordinated selection separate from Core replacement and rejects malformed routes", () => {
  window.history.replaceState(null, "", "/goals/campaign-a#coordinated/result/saved-a");
  expect(coordinatedRouteFromLocation()).toEqual({ kind: "result", requestId: "saved-a" });
  replaceGoalRoute("campaign-b"); expect(window.location.hash).toBe("#coordinated/result/saved-a");
  setCoordinatedRoute({ kind: "new" }); expect(window.location.hash).toBe("#coordinated/new");
  expect(coordinatedRouteFromLocation({ hash: "#coordinated/result/%" })).toEqual({ kind: "unavailable" });
});
