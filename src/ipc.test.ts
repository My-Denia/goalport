// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getCoreClient, persistedAttemptId, resetCoreClientForTests } from "./ipc";
import { resolveCoreSnapshot } from "./types";

afterEach(() => resetCoreClientForTests());

describe("Core client preview transport", () => {
  it("treats the display placeholder Attempt id as absent", () => {
    expect(persistedAttemptId("attempt-unassigned")).toBeUndefined();
    expect(persistedAttemptId("  attempt-unassigned  ")).toBeUndefined();
    expect(persistedAttemptId("")).toBeUndefined();
    expect(persistedAttemptId(undefined)).toBeUndefined();
    expect(persistedAttemptId("attempt-codex-executor-1")).toBe("attempt-codex-executor-1");
  });

  it("exposes the versioned projection without pretending browser preview is a Runtime", async () => {
    const client = getCoreClient();
    const snapshot = await client.snapshot();

    expect(client.mode).toBe("browser-preview");
    expect(snapshot.protocolVersion).toBe("goalport.ipc.v1");
    expect(snapshot.preview).toBe(true);
    expect(snapshot.runtimes.find((runtime) => runtime.id === "grok")?.support).toBe("partial");
  });

  it("keeps a sent command in the projection and reconnect does not resend it", async () => {
    const client = getCoreClient();
    const before = await client.snapshot();
    const afterSend = await client.sendMessage("Inspect the current evidence", before.activeCampaignId, before.attempt.id);
    const afterReconnect = await client.reconnect();

    expect(afterSend.timeline.filter((item) => item.body === "Inspect the current evidence")).toHaveLength(1);
    expect(afterReconnect.timeline.filter((item) => item.body === "Inspect the current evidence")).toHaveLength(1);
    expect(afterReconnect.attempt.eventCount).toBe(afterSend.attempt.eventCount);
  });

  it("returns an explicit disconnected state for the offline boundary", async () => {
    const client = getCoreClient();
    const snapshot = await client.setConnection("disconnected");

    expect(snapshot.connection).toBe("disconnected");
    expect(snapshot.notices.some((notice) => notice.includes("Preview"))).toBe(true);
  });

  it("normalizes the Core wire projection when Rust serializes domain fields as snake_case", () => {
    const snapshot = resolveCoreSnapshot({
      protocol_version: "goalport.ipc.v1",
      build_id: "core-build-1",
      connection: "CONNECTED",
      project: { id: "p-1", name: "Synthetic project", workspace_root: "C:\\workspace\\synthetic", color: "blue" },
      campaigns: [{ id: "c-1", project_id: "p-1", title: "Core campaign", goal: "Use the Core projection", state: "ACTIVE", task_count: 1, active_task_title: "Core task", updated_label: "just now" }],
      active_campaign_id: "c-1",
      active_task: { id: "t-1", title: "Core task", acceptance: "ordered events", state: "IN_PROGRESS" },
      attempt: { id: "a-1", task_id: "t-1", provider: "Codex", role: "executor", state: "ACTIVE", session_label: "native", event_count: 2 },
      timeline: [{ id: "e-1", kind: "MESSAGE", actor: "Core", title: "Hello", body: "Projection loaded", timestamp: "now" }],
      runtimes: [],
      decisions: [],
      evidence: [],
      preview: false,
      notices: []
    });

    expect(snapshot?.project.workspaceRoot).toBe("C:\\workspace\\synthetic");
    expect(snapshot?.campaigns[0].projectId).toBe("p-1");
    expect(snapshot?.activeTask.state).toBe("in-progress");
    expect(snapshot?.timeline[0].kind).toBe("message");
  });

  it("normalizes only explicit durable Stop state and never infers it from historical text", () => {
    const base = {
      protocol_version: "goalport.ipc.v2",
      build_id: "core-build-stop",
      connection: "CONNECTED",
      project: { id: "p-1", name: "Project", workspace_root: "C:\\workspace\\stop", color: "blue" },
      campaigns: [],
      active_campaign_id: "",
      active_task: { id: "t-1", title: "Task", acceptance: "held", state: "IN_PROGRESS" },
      attempt: { id: "a-other", task_id: "t-1", provider: "Codex", role: "executor", state: "FAILED", session_label: "native", event_count: 1 },
      timeline: [{ id: "old", kind: "ATTEMPT", actor: "Core", title: "Historical", body: "native_turn_cancel=true", timestamp: "then" }],
      runtimes: [], decisions: [], evidence: [], preview: false, notices: []
    };
    const historicalOnly = resolveCoreSnapshot(base);
    expect(historicalOnly?.stopResponsibility).toBeNull();
    expect(historicalOnly?.timeline[0].body).toBe("native_turn_cancel=true");

    const explicit = resolveCoreSnapshot({
      ...base,
      stop_responsibility: {
        attempt_id: "a-claude",
        operation_id: "op-ui-1",
        provider: "claude",
        native_turn_state: "INTERRUPTED",
        residual_execution_state: "UNKNOWN",
        write_responsibility: "HELD",
        input_uuid: "input-1",
        session_hash: "session-hash",
        turn_epoch: 3,
        process_epoch: "process-2",
        source: "claude.native.result"
      }
    });
    expect(explicit?.stopResponsibility).toEqual(expect.objectContaining({
      attemptId: "a-claude",
      operationId: "op-ui-1",
      nativeTurnState: "interrupted",
      residualExecutionState: "unknown",
      writeResponsibility: "held"
    }));
  });
});
