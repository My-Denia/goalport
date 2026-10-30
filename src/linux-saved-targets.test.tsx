// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { resetCoreClientForTests } from "./ipc";
import { DEMO_SNAPSHOT } from "./types";
import { CampaignNav } from "./nav/CampaignNav";
import { BackgroundCoordinationStatus } from "./conversation/CoordinationStatus";
import type { CoordinatedCurrentJob, SavedTargetResult } from "./coordination/savedTargetView";
import { coordinatedRouteFromLocation, setCoordinatedRoute, replaceGoalRoute } from "./lib/goalRoute";

afterEach(() => {
  cleanup(); resetCoreClientForTests(); delete window.__GOALPORT_LINUX_CORE__;
  sessionStorage.clear(); window.history.replaceState(null, "", "/");
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
function fixture(hash = "#coordinated/result/a") {
  window.__GOALPORT_LINUX_CORE__ = true;
  window.history.replaceState(null, "", "/" + hash);
  const empty = { ...DEMO_SNAPSHOT, preview: false, connection: "connected", activeCampaignId: "", campaigns: [], notices: [] };
  const root = (id: string): SavedTargetResult => ({ requestId: id, rootRequestId: id, rootLatestId: id, goal: `Goal ${id.toUpperCase()}`, workspacePath: `/work/${id}`, verdict: "verified", outcome: `Actual saved ${id.toUpperCase()}`, relationStatus: "legacy-root", relationUnavailableReason: null, rememberedIntent: { background: true, write: id === "a" }, detail: `Independent check ${id}`, change: `Executor report ${id}` });
  const records: Record<string, SavedTargetResult> = { a: root("a"), b: root("b") };
  let current: CoordinatedCurrentJob | null = null;
  let allowanceJob: import("./coordination/backgroundStatus").BackgroundStatus | null = null;
  let stopEffect: (() => void) | undefined;
  let statusBarrier: Promise<void> | undefined;
  let statusOverride: unknown;
  let statusHook: ((payload: Record<string, unknown>) => Promise<unknown>) | undefined;
  let baseOverride: Partial<import("./coordination/savedTargetView").SavedCurrentBase> = {};
  let slotOverride: import("./coordination/savedTargetView").GlobalSlot | undefined;
  let submissionCandidate: import("./coordination/savedTargetView").SubmissionCandidate | null = null;
  let pi: import("./coordination/catalogFromProviders").ProviderSnapshot | undefined;
  let harnesses: string[] | undefined;
  let expandedWorkspace: string | null | undefined;
  let held = false;
  let offline = false;
  let coreEnabled = false;
  let admitted: unknown = { ok: false, error: "Fixture refusal" };
  let admissionEffect: (() => void) | undefined;
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
        currentBase: current ? { kind: "saved-current-base", jobId: current.jobId, admittedRequestId: current.requestId ?? null, rootRequestId: current.rootRequestId ?? null,
          goal: current.goal ?? null, workspacePath: current.workspacePath ?? null, identityConfirmed: current.identityConfirmed, followUpMode: current.followUpMode ?? null,
          state: "running", phase: current.followUpMode ? "awaiting-followup" : "planning", pending: "none", revoked: false, workerGone: false,
          unconfirmed: current.line.includes("not confirmed"), active: true, allowanceEnd: null, observedAcceptedChildId: null,
          globalSlot: slotOverride ?? { kind: "occupied", jobId: current.jobId, admittedRequestId: current.requestId ?? "unknown" }, profileUnconfirmed: false, leftoverHeld: held, ...baseOverride } : null,
        savedAllowanceView: allowanceJob ? { kind: "saved-allowance", jobId: allowanceJob.jobId, initialRequestId: allowanceJob.requestId, rootRequestId: allowanceJob.requestId,
          state: allowanceJob.state, phase: allowanceJob.phase ?? null, allowanceEnd: allowanceJob.outcome?.allowanceEnd ?? null } : null,
        globalSlot: slotOverride ?? (current ? { kind: "occupied", jobId: current.jobId, admittedRequestId: current.requestId ?? "unknown" } : { kind: "empty" }),
        submissionCandidate, line: held ? null : current?.followUpMode ? "Checking the open allowance. Your saved result is kept." : current?.line,
        jobId: held ? null : current?.jobId, unconfirmedGoal: current?.line.includes("not confirmed") ?? false, leftoverHeld: held } });
    }
    if (body.messageType === "coordination_status") {
      if (statusHook) return response({ ok: true, payload: await statusHook(body.payload) });
      await statusBarrier;
      if (statusOverride !== undefined) return response({ ok: true, payload: statusOverride });
      const status = allowanceJob ?? (current ? { jobId: current.jobId, requestId: current.requestId, goal: current.goal, workspacePath: current.workspacePath,
        state: "running", active: true, live: true, revoked: false, workerPid: 1, readMaxTurns: 4, writeMaxTurns: null, counters: null, pendingCommand: null,
        completedCommands: [], progress: { activity: current.line }, outcome: null, followUpMode: current.followUpMode, liveRead: current.liveRead, phase: "awaiting-followup" } : null);
      return response({ ok: true, payload: status ? { source: "host-status", job: status, jobId: body.payload.jobId } : { source: "unavailable", job: null, jobId: body.payload.jobId, reason: "The open allowance could not be confirmed." } });
    }
    if (body.messageType === "coordination_discover") return response({ ok: true, payload: { sentence: null, harnesses: harnesses ?? (pi ? ["codex"] : ["codex", "pi"]), workspaceRoot: expandedWorkspace === undefined ? body.payload.workspaceRoot : expandedWorkspace, pi: pi ? { ...pi, piCapacity: { ...pi.piCapacity, workspacePath: body.payload.workspaceRoot } } : undefined, consentMissing: false } });
    if (body.messageType === "coordination_continue" || body.messageType === "coordination_start") {
      if (admitted instanceof Error) throw admitted;
      admissionEffect?.();
      return response(admitted);
    }
    if (body.messageType === "coordination_acknowledge") { held = false; current = null; return response({ ok: true, payload: { stdout: "The interrupted job stays unreplayed; the same request id cannot be admitted again." } }); }
    if (body.messageType === "coordination_stop") { stopEffect?.(); return response({ ok: true, payload: { stdout: "revoked: true\npending command: still-running\n" } }); }
    if (body.messageType === "goal_overview") return response({ ok: true, payload: { overview: { revision: "fixture", truncated: false, goals: coreEnabled ? [{ campaignId: "campaign-core", projectId: "project-core", workspaceRoot: "/core", title: "Core goal", attention: "idle" }] : [], pending: [] } } });
    const snapshot = coreEnabled ? { ...empty, activeCampaignId: "campaign-core", campaigns: [{ ...DEMO_SNAPSHOT.campaigns[0], id: "campaign-core", title: "Core goal" }], productConversation: { ...DEMO_SNAPSHOT.productConversation!, title: "Core goal" } } : empty;
    return response({ ok: true, payload: { revision: "fixture", unchanged: false, snapshot } });
  }));
  const tick = async () => { await act(async () => { for (const poll of polls) poll(); await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const child = () => {
    records.a.rootLatestId = "a2";
    records.a2 = { ...records.a, requestId: "a2", outcome: "Actual child A", relationStatus: "valid", continuation: { parentRequestId: "a", rootRequestId: "a", originalGoal: "Goal A", followUp: "New instruction" }, rememberedIntent: { background: true, write: false } };
  };
  return { calls, records, tick, child, expansion(value: string | null) { expandedWorkspace = value; },
    deferredStatus(value?: Promise<void>) { statusBarrier = value; }, statusRead(value: typeof statusHook) { statusHook = value; }, status(value: unknown) { statusOverride = value; }, base(value: typeof baseOverride) { baseOverride = value; }, slot(value: typeof slotOverride) { slotOverride = value; }, candidate(value: typeof submissionCandidate) { submissionCandidate = value; },
    allowance(value: typeof allowanceJob) { allowanceJob = value; }, stop(effect: () => void) { stopEffect = effect; }, harnesses(value: string[]) { harnesses = value; }, pi(value: typeof pi) { pi = value; }, core(value: boolean) { coreEnabled = value; }, job(value: CoordinatedCurrentJob | null) { current = value; }, held(value: boolean) { held = value; }, offline(value: boolean) { offline = value; }, reply(value: unknown, onRequest?: () => void) { admitted = value; admissionEffect = onRequest; } };
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
  expect(f.calls.find(c => c.messageType === "coordination_continue")?.payload).toEqual({ requestId: expect.any(String), fromRequestId: "a", followUp: "Exact follow-up 中文", write: true, background: true, instances: "codex,pi" });
  expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  expect(screen.getByRole("button", { name: /^New goal(?:\.|$)/ })).toHaveProperty("disabled", true);
});

it("admitted reply binds its new ID; only its eventual saved child advances locally; B completion never steals A", async () => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue("a2" as ReturnType<typeof crypto.randomUUID>);
  const f = fixture(); f.reply({ ok: true, payload: { stdout: "job: job-a2\nrequest: a2\nThe goal was admitted with request id a2; its worker runs detached.\n" } }, () => f.job({ jobId: "job-a2", requestId: "a2", rootRequestId: "a", goal: "Goal A", workspacePath: "/work/a", identityConfirmed: true, line: "Codex is planning…" }));
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  fireEvent.change(text(), { target: { value: "New instruction" } });
  fireEvent.click(continuation());
  await waitFor(() => expect(text().value).toBe(""));
  await waitFor(() => expect(screen.getByText("Current work — Goal A")).toBeTruthy());
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
  vi.spyOn(crypto, "randomUUID").mockReturnValue("a2" as ReturnType<typeof crypto.randomUUID>);
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

const requestedPi = { provider: "Fixture", model: "alpha", useExistingCapacity: true as const };
const configuredPi = { instanceId: "pi", installed: true, enabled: true, availability: "available", auth: { status: "unknown", type: "apiKey" }, piCapacity: { offer: { ...requestedPi, model: "beta" }, catalog: [{ provider: "Fixture", model: "alpha" }, { provider: "Fixture", model: "beta" }] } };

it("restores apiKey-classified OWN requested route despite changed defaults; polls preserve dirty draft and do not reread native metadata", async () => {
  const f = fixture(); f.pi(configuredPi);
  f.records.a.piCapacity = requestedPi;
  f.records.a.rememberedIntent = { background: true, write: false, piCapacity: requestedPi };
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  const choice = await screen.findByRole("checkbox", { name: "Use Pi's configured capacity for this goal" });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  expect(choice).toHaveProperty("checked", true);
  expect(screen.getByText(/Requested: Fixture\/alpha/)).toBeTruthy();
  expect(screen.queryByText(/Requested: Fixture\/beta/)).toBeNull();
  fireEvent.change(text(), { target: { value: "Keep own draft" } });
  const before = f.calls.filter(c => c.messageType === "coordination_discover").length;
  await f.tick(); expect(text().value).toBe("Keep own draft");
  expect(f.calls.filter(c => c.messageType === "coordination_discover").length).toBe(before);
  fireEvent.click(screen.getByRole("button", { name: "Goal B, /work/b" }));
  await screen.findByRole("heading", { name: "Goal B" });
  fireEvent.click(screen.getByRole("button", { name: "Goal A, /work/a" }));
  await screen.findByRole("heading", { name: "Goal A" });
  expect(text().value).toBe("Keep own draft");
  expect(screen.getByRole("checkbox", { name: "Use Pi's configured capacity for this goal" })).toHaveProperty("checked", true);
  fireEvent.click(continuation());
  await waitFor(() => expect(f.calls.filter(c => c.messageType === "coordination_continue")).toHaveLength(1));
  expect(f.calls.find(c => c.messageType === "coordination_continue")?.payload.fromRequestId).toBe("a");
  expect(f.calls.some(c => c.messageType === "coordination_start")).toBe(false);
});
it("saved unavailable or malformed requested Pi route preserves actual result but disables Continue without falling back", async () => {
  const f = fixture(); f.pi({ ...configuredPi, availability: "unavailable" });
  f.records.a.piCapacity = requestedPi; f.records.a.rememberedIntent = { background: true, write: false, piCapacity: requestedPi };
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  await screen.findByRole("checkbox", { name: "Use Pi's configured capacity for this goal" });
  expect(screen.getByText("Actual saved A")).toBeTruthy();
  expect(continuation()).toHaveProperty("disabled", true);
  expect(screen.getByRole("checkbox", { name: "Use Pi's configured capacity for this goal" })).toHaveProperty("checked", true);
  fireEvent.change(text(), { target: { value: "Unsent" } }); fireEvent.keyDown(text(), { key: "Enter" });
  expect(text().value).toBe("Unsent"); expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});
it("New goal starts Pi intent off and selects only the current configured offer", async () => {
  const f = fixture("#coordinated/new"); f.pi(configuredPi);
  render(<App />);
  const choice = await screen.findByRole("checkbox", { name: "Use Pi's configured capacity for this goal" });
  expect(choice).toHaveProperty("checked", false);
  expect(screen.getByText(/Requested: Fixture\/beta/)).toBeTruthy();
  fireEvent.click(choice); expect(choice).toHaveProperty("checked", true);
  await f.tick(); expect(choice).toHaveProperty("checked", true);
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});

it("a selected Pi goal sends only Codex and Pi even with Claude signed in", async () => {
  const f = fixture(); f.pi(configuredPi); f.harnesses(["claude", "codex"]);
  f.records.a.piCapacity = requestedPi;
  f.records.a.rememberedIntent = { background: true, write: false, piCapacity: requestedPi };
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  expect(screen.getByText(/Selected roles: Codex plans · Pi independently checks/)).toBeTruthy();
  fireEvent.click(continuation());
  await waitFor(() => expect(f.calls.filter(c => c.messageType === "coordination_continue")).toHaveLength(1));
  expect(f.calls.find(c => c.messageType === "coordination_continue")?.payload.instances).toBe("codex,pi");
});
it("a selected Pi goal without Codex stays unsent and explains the missing planner", async () => {
  const f = fixture(); f.pi(configuredPi); f.harnesses(["claude"]);
  f.records.a.piCapacity = requestedPi;
  f.records.a.rememberedIntent = { background: true, write: false, piCapacity: requestedPi };
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  await screen.findByRole("checkbox", { name: "Use Pi's configured capacity for this goal" });
  expect(continuation()).toHaveProperty("disabled", true);
  expect(screen.queryByText(/Selected roles: Codex plans/)).toBeNull();
  expect(screen.getAllByText(/Codex is needed/).length).toBeGreaterThan(0);
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toEqual([]);
});

function liveFixture(hash = "#coordinated/result/a") {
  const f = fixture(hash);
  const pair = { provider: "Fixture", model: "alpha", useExistingCapacity: true as const };
  f.pi({ instanceId: "pi", displayName: "Pi", driver: "pi", enabled: true, installed: true, availability: "available", status: "ready", auth: { status: "unknown", type: "apiKey" }, models: [], piCapacity: { offer: pair, catalog: [{ provider: "Fixture", model: "alpha" }] } });
  f.records.a.piCapacity = pair; f.records.a.verdict = "checked"; f.records.a.statusLabel = "Plan checked";
  f.records.a.rememberedIntent = { background: true, write: false, piCapacity: pair };
  const liveRead = { mode: "live-read-once" as const, ready: true, initialRequestId: "a", fromRequestId: "a", rootRequestId: "a", remainingReads: 2, readonly: true, pending: false, revoked: false, childRequestId: null, expiresAt: new Date(Date.now() + 900000).toISOString(), reason: null };
  const job: CoordinatedCurrentJob = { jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "a", rootRequestId: "a", goal: "Goal A", workspacePath: "/work/a", identityConfirmed: true, followUpMode: "live-read-once", liveRead, line: "Ready for one follow-up. No model is running." };
  f.job(job);
  return { ...f, jobValue: job, liveRead };
}

it("live Ready has one composer Continue, empty Enter does not send, explicit empty Continue keeps caller ID through lost ACK and matching status", async () => {
  const f = liveFixture(); render(<App />);
  await screen.findByRole("heading", { name: "Goal A" });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  expect(screen.getAllByRole("button", { name: /Continue this goal/ })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /New send for this goal/ })).toBeNull();
  fireEvent.keyDown(text(), { key: "Enter" });
  expect(f.calls.filter(c => c.messageType === "coordination_continue")).toHaveLength(0);
  f.reply(new Error("lost fixture ack"));
  f.job({ ...f.jobValue, liveRead: { ...f.liveRead, ready: false, reason: "unconfirmed" } });
  fireEvent.change(text(), { target: { value: "Keep this exact draft" } });
  fireEvent.click(continuation());
  await screen.findByText(/follow-up and request id are kept/);
  const call = f.calls.find(c => c.messageType === "coordination_continue")!;
  expect(call.payload).toMatchObject({ fromRequestId: "a", followUp: "Keep this exact draft", write: false, background: true, instances: "codex,pi" });
  expect(typeof call.payload.liveRequestId).toBe("string");
  expect(text().value).toBe("Keep this exact draft"); expect(text()).toHaveProperty("disabled", true);
  f.job({ ...f.jobValue, liveRead: { ...f.liveRead, ready: false, childRequestId: String(call.payload.liveRequestId), reason: "busy" } });
  await f.tick(); await waitFor(() => expect(text().value).toBe(""));
  expect(f.calls.filter(c => c.messageType === "coordination_start")).toHaveLength(0);
  expect(f.calls.filter(c => c.messageType === "coordination_continue")).toHaveLength(1);
});

it("Ready B cannot spend A's result or end B when inspecting A; New goal on matching idle result waits for terminal release", async () => {
  const f = liveFixture("#coordinated/result/b"); render(<App />);
  await screen.findByRole("heading", { name: "Goal B" });
  expect(continuation()).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: /^New goal(?:\.|$)/ })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Goal A, /work/a" }));
  await screen.findByRole("heading", { name: "Goal A" });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  f.stop(() => {
    f.job(null);
    f.allowance({ jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "a", goal: "Goal A", workspacePath: "/work/a", state: "stopped", active: false, live: false, revoked: true, workerPid: null, pendingCommand: null, completedCommands: [], counters: null, progress: null, readMaxTurns: 4, writeMaxTurns: null, followUpMode: "live-read-once", outcome: { status: "stopped", allowanceEnd: "idle-stopped" } });
  });
  fireEvent.click(screen.getByRole("button", { name: /^New goal(?:\.|$)/ }));
  await waitFor(() => expect(window.location.hash).toBe("#coordinated/new"));
  expect(f.calls.find(c => c.messageType === "coordination_stop")?.payload).toEqual({ jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", onlyIfReadyFromRequestId: "a" });
  expect(f.calls.filter(c => c.messageType === "coordination_start" || c.messageType === "coordination_continue")).toHaveLength(0);
  expect(text().value).toBe("");
});

it("malformed or stale live acknowledgement refuses Continue with no fresh Start fallback and preserves dirty draft/focus", async () => {
  const f = liveFixture(); f.job({ ...f.jobValue, liveRead: { ...f.liveRead, rootRequestId: "b" } });
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  fireEvent.change(text(), { target: { value: "Do not lose this" } }); text().focus(); await f.tick();
  expect(continuation()).toHaveProperty("disabled", true); fireEvent.click(continuation());
  expect(text().value).toBe("Do not lose this"); expect(document.activeElement).toBe(text());
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toHaveLength(0);
});

it("a waiting new-mode row without fresh RAM Ready never claims a running model or renders a second Continue", () => {
  const job: import("./coordination/backgroundStatus").BackgroundStatus = { jobId: "job", requestId: "a", goal: "Goal A", state: "running", active: true, live: true, revoked: false, workerPid: 1, pendingCommand: null, completedCommands: [], counters: null, readMaxTurns: 4, writeMaxTurns: null, outcome: null, progress: { activity: "Ready for one follow-up. No model is running." }, phase: "awaiting-followup", followUpMode: "live-read-once" };
  render(<BackgroundCoordinationStatus job={job} onStopAllowing={() => {}} onContinue={() => {}} />);
  expect(screen.getByText(/open allowance is not confirmed/)).toBeTruthy();
  expect(screen.queryByText(/running on its own/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Continue|New send/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
});

it("saved content and editable draft paint before a deferred host ACK; only current controls check", async () => {
  const f = liveFixture(); let release!: () => void;
  f.deferredStatus(new Promise<void>(resolve => { release = resolve; }));
  render(<App />);
  await screen.findByRole("heading", { name: "Goal A" });
  await waitFor(() => expect(f.calls.some(c => c.messageType === "coordination_status")).toBe(true));
  expect(screen.getByText("Plan checked", { selector: ".conversation-heading p" })).toBeTruthy();
  expect(screen.getByText("Executor report a")).toBeTruthy();
  expect(continuation()).toHaveProperty("disabled", true);
  fireEvent.change(text(), { target: { value: "Typing before status" } }); text().focus();
  expect(text()).toHaveProperty("disabled", false);
  expect(screen.queryByText("Ready for one follow-up. No model is running.")).toBeNull();
  await act(async () => { release(); });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  expect(text().value).toBe("Typing before status"); expect(document.activeElement).toBe(text());
  expect(f.calls.filter(c => mutationTypes.has(c.messageType))).toHaveLength(0);
});

it("current A status cannot repin saved B, borrow its pair, or replace its focused draft", async () => {
  const f = liveFixture("#coordinated/result/b"); let release!: () => void;
  f.deferredStatus(new Promise<void>(resolve => { release = resolve; }));
  render(<App />); await screen.findByRole("heading", { name: "Goal B" });
  fireEvent.change(text(), { target: { value: "B stays independent" } }); text().focus();
  await act(async () => { release(); });
  await waitFor(() => expect(f.calls.some(c => c.messageType === "coordination_status")).toBe(true));
  expect(window.location.hash).toBe("#coordinated/result/b");
  expect(screen.getByText("Actual saved B")).toBeTruthy();
  expect(text().value).toBe("B stays independent"); expect(document.activeElement).toBe(text());
  expect(continuation()).toHaveProperty("disabled", true);
});

it("a pre-navigation A ACK cannot replace newly confirmed current B or steal B's draft/focus", async () => {
  const f = liveFixture(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const host = (current: CoordinatedCurrentJob) => ({ jobId: current.jobId, requestId: current.requestId, goal: current.goal, workspacePath: current.workspacePath,
    state: "running", active: true, live: true, revoked: false, workerPid: 1, readMaxTurns: 4, writeMaxTurns: null, counters: null,
    pendingCommand: null, completedCommands: [], progress: null, outcome: null, followUpMode: "live-read-once", liveRead: current.liveRead, phase: "awaiting-followup" });
  const b = { ...f.jobValue, jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", requestId: "b", rootRequestId: "b", goal: "Goal B", workspacePath: "/work/b",
    liveRead: { ...f.liveRead, initialRequestId: "b", fromRequestId: "b", rootRequestId: "b" } };
  f.records.b.piCapacity = f.records.a.piCapacity; f.records.b.rememberedIntent = f.records.a.rememberedIntent;
  f.statusRead(async payload => {
    const current = payload.jobId === f.jobValue.jobId ? f.jobValue : b;
    if (current === f.jobValue) await barrier;
    return { source: "host-status", job: host(current), jobId: current.jobId };
  });
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  await waitFor(() => expect(f.calls.some(c => c.messageType === "coordination_status")).toBe(true));
  f.job(b); fireEvent.click(screen.getByRole("button", { name: "Goal B, /work/b" }));
  await screen.findByRole("heading", { name: "Goal B" });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  fireEvent.change(text(), { target: { value: "B draft after navigation" } }); text().focus();
  await act(async () => { release(); });
  expect(screen.getByText("Current work — Goal B")).toBeTruthy();
  expect(window.location.hash).toBe("#coordinated/result/b"); expect(text().value).toBe("B draft after navigation");
  expect(document.activeElement).toBe(text()); expect(continuation()).toHaveProperty("disabled", false);
});

it.each([
  { revoked: true }, { pending: "present" as const }, { allowanceEnd: "expired" as const }, { workerGone: true },
  { workerGone: "unknown" as const }, { state: "unknown" }, { unconfirmed: true },
  { globalSlot: { kind: "unknown" as const } }, { globalSlot: { kind: "occupied" as const, jobId: "foreign", admittedRequestId: "foreign" } },
  { observedAcceptedChildId: "child" }, { profileUnconfirmed: true }, { leftoverHeld: true },
])("a negative/unknown base %j drops Ready before any status call while keeping saved draft", async negative => {
  const f = liveFixture(); render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  fireEvent.change(text(), { target: { value: "Keep exact draft" } });
  const count = f.calls.filter(c => c.messageType === "coordination_status").length;
  f.base(negative); await f.tick();
  expect(continuation()).toHaveProperty("disabled", true);
  expect(screen.getByText("Plan checked", { selector: ".conversation-heading p" })).toBeTruthy(); expect(text().value).toBe("Keep exact draft");
  expect(f.calls.filter(c => c.messageType === "coordination_status")).toHaveLength(count);
});

it("the original worker expiry clears Ready without another status response or receipt-time extension", async () => {
  const f = liveFixture();
  f.job({ ...f.jobValue, liveRead: { ...f.liveRead, expiresAt: new Date(Date.now() + 450).toISOString() } });
  render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  fireEvent.change(text(), { target: { value: "Expiry keeps text" } });
  const before = f.calls.filter(c => c.messageType === "coordination_status").length;
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", true));
  expect(f.calls.filter(c => c.messageType === "coordination_status")).toHaveLength(before);
  expect(text().value).toBe("Expiry keeps text"); expect(screen.getByText("Plan checked", { selector: ".conversation-heading p" })).toBeTruthy();
});

it("settled historical views and a blank New goal never ask status merely to paint", async () => {
  const f = liveFixture("#coordinated/new"); render(<App />);
  await screen.findByRole("textbox", { name: /message composer/i }); await f.tick();
  expect(f.calls.filter(c => c.messageType === "coordination_status")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Goal B, /work/b" }));
  await screen.findByRole("heading", { name: "Goal B" });
  // Actual current mode A now deserves one read; no per-root/row fanout.
  await waitFor(() => expect(f.calls.filter(c => c.messageType === "coordination_status").length).toBeGreaterThan(0));
  expect(f.calls.filter(c => c.messageType === "coordination_status").every(c => c.payload.jobId === f.jobValue.jobId)).toBe(true);
  f.job(null); const before = f.calls.filter(c => c.messageType === "coordination_status").length;
  await f.tick(); expect(f.calls.filter(c => c.messageType === "coordination_status")).toHaveLength(before);
});

it("legacy no-ID uncertainty cannot be cleared by passive live/terminal data or a matching goal string", async () => {
  const f = liveFixture(); sessionStorage.setItem("goalport.linux.admissionUnsaid", "The send returned without saying the goal was admitted.");
  // Use the existing storage key's helper format rather than a fabricated submitted ID.
  render(<App />); await screen.findByRole("heading", { name: "Goal A" }); await f.tick();
  expect(sessionStorage.getItem("goalport.linux.admissionUnsaid")).toBe("The send returned without saying the goal was admitted.");
  expect(continuation()).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: /^New goal(?:\.|$)/ })).toHaveProperty("disabled", true);
  expect(f.calls.filter(c => c.messageType === "coordination_start")).toHaveLength(0);
});

it.each([["/fixture/new", "/fixture/new"], ["~", "/fixture/home"], ["~/proj", "/fixture/home/proj"]])("lost Start from %s holds and sends canonical %s for exact strict association", async (enteredWorkspace, canonicalWorkspace) => {
  const f = fixture("#coordinated/new"); f.expansion(canonicalWorkspace); f.reply(new Error("lost fixture response"));
  render(<App />); await screen.findByRole("textbox", { name: /message composer/i });
  fireEvent.change(screen.getByRole("textbox", { name: "Project folder" }), { target: { value: enteredWorkspace } });
  fireEvent.change(text(), { target: { value: "New exact goal" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep working after closing" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(sessionStorage.getItem("goalport.linux.admissionUnsaid")).not.toBeNull());
  const sent = f.calls.find(c => c.messageType === "coordination_start")!.payload;
  expect(typeof sent.requestId).toBe("string"); expect(sent.workspaceRoot).toBe(canonicalWorkspace); expect(text().value).toBe("New exact goal");
  expect(text()).toHaveProperty("disabled", true);
  const id = String(sent.requestId), jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  f.candidate({ kind: "submission-candidate", jobId, admittedRequestId: "same-text-wrong-id", rootRequestId: id, goal: "New exact goal", workspacePath: canonicalWorkspace, identityConfirmed: true, active: true });
  await f.tick(); expect(f.calls.filter(c => c.messageType === "coordination_status")).toHaveLength(0);
  expect(sessionStorage.getItem("goalport.linux.admissionUnsaid")).not.toBeNull();
  f.candidate({ kind: "submission-candidate", jobId, admittedRequestId: id, rootRequestId: id, goal: "New exact goal", workspacePath: canonicalWorkspace, identityConfirmed: true, active: true });
  const status = { jobId, requestId: "same-text-wrong-id", goal: "New exact goal", workspacePath: canonicalWorkspace, state: "running", active: true, live: true, revoked: false, workerPid: 1, readMaxTurns: 4, writeMaxTurns: null, counters: null, pendingCommand: null, completedCommands: [], progress: null, outcome: null };
  f.status({ source: "host-status", job: status, jobId }); await f.tick();
  expect(sessionStorage.getItem("goalport.linux.admissionUnsaid")).not.toBeNull();
  expect(text().value).toBe("New exact goal");
  f.status({ source: "unavailable", job: null, jobId, reason: "The open allowance could not be confirmed." }); await f.tick();
  expect(sessionStorage.getItem("goalport.linux.admissionUnsaid")).not.toBeNull();
  f.status({ source: "host-status", job: { ...status, requestId: id }, jobId }); await f.tick();
  await waitFor(() => expect(sessionStorage.getItem("goalport.linux.admissionUnsaid")).toBeNull());
  expect(f.calls.filter(c => c.messageType === "coordination_start")).toHaveLength(1);
  expect(f.calls.filter(c => c.messageType === "coordination_status").every(c => c.payload.jobId === jobId)).toBe(true);
  expect(f.calls.filter(c => c.messageType === "coordination_continue")).toHaveLength(0);
});

it("an unresolved home-folder path stays editable and sends no admission", async () => {
  const f = fixture("#coordinated/new"); f.expansion(null);
  render(<App />); await screen.findByRole("textbox", { name: /message composer/i });
  fireEvent.change(screen.getByRole("textbox", { name: "Project folder" }), { target: { value: "~/proj" } });
  fireEvent.change(text(), { target: { value: "Keep unresolved draft" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep working after closing" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("The home-folder path could not be resolved. Recheck the folder before sending.");
  expect(text().value).toBe("Keep unresolved draft"); expect(text().disabled).toBe(false);
  expect(sessionStorage.getItem("goalport.linux.admissionUnsaid")).toBeNull();
  expect(f.calls.filter(c => c.messageType === "coordination_start")).toHaveLength(0);
});

it.each(["foreign", "unknown"])("New goal keeps the view when terminal B has %s global slot evidence", async kind => {
  const f = liveFixture(); render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  fireEvent.change(text(), { target: { value: "Keep while ending" } });
  f.stop(() => {
    f.job(null); f.slot(kind === "foreign" ? { kind: "occupied", jobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", admittedRequestId: "foreign" } : { kind: "unknown" });
    f.allowance({ jobId: f.jobValue.jobId, requestId: "a", goal: "Goal A", workspacePath: "/work/a", followUpMode: "live-read-once", state: "stopped", active: false, live: false, revoked: true, workerPid: null, pendingCommand: null, completedCommands: [], counters: null, progress: null, readMaxTurns: 4, writeMaxTurns: null, outcome: { status: "stopped" } });
  });
  fireEvent.click(screen.getByRole("button", { name: /^New goal(?:\.|$)/ }));
  await screen.findByText(kind === "foreign" ? "Another goal owns the work slot. Your current view is kept." : "The work slot could not be confirmed. Your view is kept.");
  expect(window.location.hash).toBe("#coordinated/result/a"); expect(text().value).toBe("Keep while ending");
  expect(f.calls.filter(c => c.messageType === "coordination_stop")).toHaveLength(1);
});

it("explicit idle Stop retains its close identity: passive done cannot skip strict status/slot confirmation on New goal", async () => {
  const f = liveFixture(); render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  fireEvent.change(text(), { target: { value: "Keep after Stop" } });
  f.stop(() => {
    f.job(null);
    f.allowance({ jobId: f.jobValue.jobId, requestId: "a", goal: "Goal A", workspacePath: "/work/a", followUpMode: "live-read-once", state: "stopped", active: false, live: false, revoked: true, workerPid: null, pendingCommand: null, completedCommands: [], counters: null, progress: null, readMaxTurns: 4, writeMaxTurns: null, outcome: { status: "stopped", allowanceEnd: "idle-stopped" } });
  });
  fireEvent.click(screen.getByRole("button", { name: "Stop Goal A" }));
  await waitFor(() => expect(f.calls.filter(c => c.messageType === "coordination_stop")).toHaveLength(1));
  await f.tick(); expect(window.location.hash).toBe("#coordinated/result/a"); expect(text().value).toBe("Keep after Stop");
  const before = f.calls.filter(c => c.messageType === "coordination_status").length;
  f.slot({ kind: "occupied", jobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", admittedRequestId: "foreign" });
  fireEvent.click(screen.getByRole("button", { name: /^New goal(?:\.|$)/ }));
  await screen.findByText("Another goal owns the work slot. Your current view is kept.");
  expect(f.calls.filter(c => c.messageType === "coordination_status").length).toBeGreaterThan(before);
  expect(window.location.hash).toBe("#coordinated/result/a"); expect(text().value).toBe("Keep after Stop");
  f.slot({ kind: "empty" });
  fireEvent.click(screen.getByRole("button", { name: /^New goal(?:\.|$)/ }));
  await waitFor(() => expect(window.location.hash).toBe("#coordinated/new"));
  expect(f.calls.filter(c => c.messageType === "coordination_stop")).toHaveLength(1);
  expect(f.calls.filter(c => ["coordination_start", "coordination_continue"].includes(c.messageType))).toHaveLength(0);
});

it("New goal drain timeout keeps identity; explicit confirmation retry does not revoke an ended worker again", async () => {
  const f = liveFixture(); render(<App />); await screen.findByRole("heading", { name: "Goal A" });
  await waitFor(() => expect(continuation()).toHaveProperty("disabled", false));
  fireEvent.change(text(), { target: { value: "Retain through drain" } });
  vi.useFakeTimers();
  const started = performance.now(); let freshHelpers = 0;
  const ended = { jobId: f.jobValue.jobId, requestId: "a", goal: "Goal A", workspacePath: "/work/a", followUpMode: "live-read-once", state: "stopped", active: false, live: false, revoked: true, workerPid: null, pendingCommand: null, completedCommands: [], counters: null, progress: null, readMaxTurns: 4, writeMaxTurns: null, outcome: { status: "stopped" } };
  f.stop(() => {
    f.job(null);
    f.statusRead(async () => {
      if (performance.now() - started < 3000) return { source: "unavailable", job: null, jobId: f.jobValue.jobId, reason: "The open allowance could not be confirmed." };
      freshHelpers++;
      await new Promise(resolve => window.setTimeout(resolve, 3000));
      return { source: "host-status", job: ended, jobId: f.jobValue.jobId };
    });
  });
  fireEvent.click(screen.getByRole("button", { name: /^New goal(?:\.|$)/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(window.location.hash).toBe("#coordinated/result/a"); expect(text().value).toBe("Retain through drain");
  expect(screen.getByText(/You can click New goal again to check/)).toBeTruthy();
  expect(freshHelpers).toBe(1); // Three-second drain plus fresh three-second read cannot fit in five.
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect(window.location.hash).toBe("#coordinated/result/a"); // Late completion is abandoned, not draft release.
  f.statusRead(undefined);
  f.status({ source: "host-status", job: ended, jobId: f.jobValue.jobId });
  fireEvent.click(screen.getByRole("button", { name: /^New goal(?:\.|$)/ }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(window.location.hash).toBe("#coordinated/new");
  expect(f.calls.filter(c => c.messageType === "coordination_stop")).toHaveLength(1);
  expect(f.calls.filter(c => ["coordination_start", "coordination_continue"].includes(c.messageType))).toHaveLength(0);
});

it("goal route helper keeps coordinated selection separate from Core replacement and rejects malformed routes", () => {
  window.history.replaceState(null, "", "/goals/campaign-a#coordinated/result/saved-a");
  expect(coordinatedRouteFromLocation()).toEqual({ kind: "result", requestId: "saved-a" });
  replaceGoalRoute("campaign-b"); expect(window.location.hash).toBe("#coordinated/result/saved-a");
  setCoordinatedRoute({ kind: "new" }); expect(window.location.hash).toBe("#coordinated/new");
  expect(coordinatedRouteFromLocation({ hash: "#coordinated/result/%" })).toEqual({ kind: "unavailable" });
});
