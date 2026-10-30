// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { resetCoreClientForTests } from "./ipc";
import { DEMO_SNAPSHOT } from "./types";
import type { SavedPlan } from "./coordination/savedPlan";
import type { BackgroundStatus } from "./coordination/backgroundStatus";
import type { BackgroundJobStartInput } from "./coordination/backgroundJob";

afterEach(() => {
  cleanup(); resetCoreClientForTests(); delete window.goalportCore;
  delete window.__GOALPORT_ELECTRON__; delete window.__GOALPORT_LINUX_CORE__;
  sessionStorage.clear(); window.history.replaceState(null, "", "/"); vi.restoreAllMocks();
});
const pair = { provider: "Fixture", model: "alpha", useExistingCapacity: true as const };
function fixture(child = false) {
  window.__GOALPORT_ELECTRON__ = true;
  const snapshot = { ...DEMO_SNAPSHOT, preview: false };
  const record: SavedPlan = {
    requestId: child ? "child-result" : "initial-result", goal: "Inspect this code", workspacePath: "/fixture/workspace",
    planningHarness: "Codex", reviewHarness: "Pi", planText: "Saved plan to preserve", reviewText: "Saved independent check",
    result: "Plan checked", verdict: "checked", stopReason: "Checked", planningQuota: "unknown", reviewQuota: "unknown", piCapacity: pair,
    ...(child ? { continuation: { parentRequestId: "initial-result", rootRequestId: "historical-root", originalGoal: "Inspect this code", followUp: "Earlier follow-up" } } : {}),
  };
  const terminal: BackgroundStatus = { jobId: "old-job", requestId: "initial-result", goal: record.goal, workspacePath: record.workspacePath,
    followUpMode: "live-read-once", ...(child ? { acceptedRequestId: record.requestId } : {}), piCapacity: pair,
    state: "completed", active: false, live: false, revoked: false, workerPid: null, readMaxTurns: 4, writeMaxTurns: null,
    counters: { readTurnsLeft: child ? 0 : 2 }, pendingCommand: null, completedCommands: [], progress: null, outcome: { status: "completed", report: record } };
  let current = terminal;
  const list = vi.fn(async () => [record]);
  const start = vi.fn(async (input: BackgroundJobStartInput): Promise<BackgroundStatus> => {
    current = { ...terminal, jobId: "new-job", requestId: input.requestId, acceptedRequestId: undefined, state: "running", active: true, live: true, outcome: null };
    return current;
  });
  const liveContinue = vi.fn();
  window.goalportCore = { snapshot: async () => snapshot, command: vi.fn(), startCore: async () => snapshot,
    coordinationRecords: list, backgroundStatus: async () => current, backgroundStart: start, backgroundContinue: liveContinue,
    appInfo: async () => ({ version: "test", coordinationConfigured: true }) } as never;
  return { record, terminal, list, start, liveContinue };
}
it("a running workspace check stays beside its goal and never takes over the desktop view", async () => {
  const f = fixture();
  const target = { campaignId: "campaign-desktop", attemptId: "attempt-desktop", turnRequestId: "turn-desktop" };
  const snapshot = { ...DEMO_SNAPSHOT, preview: false, connection: "connected", activeCampaignId: target.campaignId, attempt: { ...DEMO_SNAPSHOT.attempt, id: target.attemptId, provider: "codex", state: "waiting" }, turnResults: [{ requestId: target.turnRequestId, replyState: "completed", baselineRecorded: true, before: [], during: [], unattributed: [], commands: [] }] };
  const job = { ...f.terminal, jobId: "check-job", requestId: "check-request", recordKind: "native-workspace-check", nativeCheckTarget: target, state: "running", active: true, live: true, outcome: null, followUpMode: undefined, progress: { activity: "Pi is checking" } };
  const nativeCheck = vi.fn(async () => ({ ok: true, payload: { checks: [] } }));
  window.goalportCore = { ...window.goalportCore, snapshot: async () => snapshot, startCore: async () => snapshot, backgroundStatus: async () => job, nativeCheck } as never;
  window.history.replaceState(null, "", "/goals/campaign-desktop");
  render(<App />);
  await screen.findByRole("region", { name: "Pi review" });
  expect(screen.queryByRole("region", { name: "Background goal" })).toBeNull();
  expect(screen.getByRole("button", { name: "Stop review" })).toBeTruthy();
  // A long command log must not squeeze the conversation and this button out of view.
  expect(screen.getByText("Workspace results").closest("details")?.open).toBe(false);
});

it.each(["unconfirmed", "running"] as const)("desktop interrupted live-read allowance (%s) can be left without replaying or releasing its held folder", async state => {
  const f = fixture();
  let current: BackgroundStatus = { ...f.terminal, state, active:true, live:false, outcome:null,
    pendingCommand: state === "unconfirmed" ? {commandId:"coordinate-plan",idempotencyKey:"pending-original"} : null } as BackgroundStatus;
  const pending = current.pendingCommand;
  const acknowledge = vi.fn(async (jobId: string) => {
    expect(jobId).toBe(current.jobId);
    current = { ...current, active:false, acknowledgedStuckAt:"2026-01-01T00:00:00Z" };
    return current;
  });
  const command = vi.fn();
  window.goalportCore = { ...window.goalportCore, command, backgroundStatus:async()=>current, backgroundAcknowledge:acknowledge } as never;
  render(<App />);
  await screen.findByRole("button", {name:"Continue in a new send"});
  expect(screen.getByRole("button", {name:"Continue this goal"}).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", {name:"Continue in a new send"}));
  await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));
  const folder = await screen.findByRole("textbox", {name:/project folder/i}) as HTMLInputElement;
  expect(folder.value).toBe("");
  expect((screen.getByRole("textbox", {name:"Message composer"}) as HTMLTextAreaElement).value).toBe(f.record.goal);
  expect(screen.getByText(/stays reserved until its exit is confirmed/)).toBeTruthy();
  expect(current.state).toBe(state); expect(current.pendingCommand).toBe(pending);
  expect(current.counters).toEqual(f.terminal.counters);
  expect(f.start).not.toHaveBeenCalled(); expect(f.liveContinue).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
});

async function openBackground() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Return to background goal" }));
  return await screen.findByRole("textbox", { name: "Message composer" }) as HTMLTextAreaElement;
}
it.each([false, true])("desktop terminal Continue carries the saved %s result and typed follow-up into one new readonly allowance", async child => {
  const f = fixture(child), text = await openBackground();
  fireEvent.change(text, { target: { value: "Keep this follow-up" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue this goal" }));
  await waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
  const input = f.start.mock.calls[0][0];
  expect(input.requestId).not.toBe(f.record.requestId);
  expect(input).toMatchObject({ goal: f.record.goal, workspaceRoot: f.record.workspacePath, piCapacity: pair,
    readInstances: ["codex", "pi"], readMaxTurns: 4, backgroundConsent: true,
    priorPlan: f.record.planText, priorReview: f.record.reviewText,
    continuation: { parentRequestId: f.record.requestId, rootRequestId: child ? "historical-root" : f.record.requestId,
      originalGoal: f.record.goal, followUp: "Keep this follow-up" } });
  expect(input.write).toBeUndefined();
  expect(input.executionFeedback).toBeUndefined();
  expect(f.liveContinue).not.toHaveBeenCalled();
  await waitFor(() => expect(text.value).toBe(""));
});
it("desktop unknown fresh allowance keeps text locked and never sends a second Start", async () => {
  const f = fixture(); f.start.mockRejectedValue(new Error("Lost admission reply"));
  const text = await openBackground(); fireEvent.change(text, { target: { value: "Do not lose me" } });
  const button = screen.getByRole("button", { name: "Continue this goal" }); fireEvent.click(button);
  await screen.findByText("Lost admission reply");
  expect(text.value).toBe("Do not lose me"); expect(text.disabled).toBe(true);
  fireEvent.click(button); expect(f.start).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /New goal/i }));
  expect(text.value).toBe("Do not lose me"); expect(f.start).toHaveBeenCalledTimes(1);
});
it("desktop missing saved continuation context retains the follow-up without any admission", async () => {
  const f = fixture(); f.list.mockResolvedValue([]);
  const text = await openBackground(); fireEvent.change(text, { target: { value: "Keep missing-context draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue this goal" }));
  await screen.findByText(/saved result could not be confirmed/);
  expect(text.value).toBe("Keep missing-context draft"); expect(f.start).not.toHaveBeenCalled(); expect(f.liveContinue).not.toHaveBeenCalled();
});
