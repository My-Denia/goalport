// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getCoreClient, persistedAttemptId, reusableAttemptId, resetCoreClientForTests } from "./ipc";
import { DEMO_SNAPSHOT, resolveCoreSnapshot } from "./types";

afterEach(() => resetCoreClientForTests());

describe("Core client preview transport", () => {
  it("treats the display placeholder Attempt id as absent", () => {
    expect(persistedAttemptId("attempt-unassigned")).toBeUndefined();
    expect(persistedAttemptId("  attempt-unassigned  ")).toBeUndefined();
    expect(persistedAttemptId("")).toBeUndefined();
    expect(persistedAttemptId(undefined)).toBeUndefined();
    expect(persistedAttemptId("attempt-codex-executor-1")).toBe("attempt-codex-executor-1");
  });

  it("forwards persisted Attempt ids except the display placeholder and uncertain snapshots", () => {
    expect(reusableAttemptId({ id: "attempt-live", state: "active" })).toBe("attempt-live");
    expect(reusableAttemptId({ id: "attempt-wait", state: "waiting" })).toBe("attempt-wait");
    expect(reusableAttemptId({ id: "attempt-done", state: "completed" })).toBe("attempt-done");
    expect(reusableAttemptId({ id: "attempt-dead", state: "failed" })).toBe("attempt-dead");
    expect(reusableAttemptId({ id: "attempt-unassigned", state: "active" })).toBeUndefined();
    expect(reusableAttemptId({ id: "attempt-live", state: "uncertain" })).toBeUndefined();
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

  it("normalizes bounded page, fragment and capacity metadata", () => {
    const snapshot = resolveCoreSnapshot({
      ...DEMO_SNAPSHOT,
      timeline: [{
        ...DEMO_SNAPSHOT.timeline[0],
        id: "timeline-fragment",
        logical_item_id: "timeline-logical",
        fragment_index: 1,
        continues_before: true
      }],
      timeline_page_info: { older_cursor: "older", newer_cursor: "newer", has_older: true, has_newer: false, content_bytes: 99, item_count: 1 },
      bounds: { truncated: true, projection_unavailable: true, omitted_counts: { conversation_items: 7 } },
      productConversation: {
        ...DEMO_SNAPSHOT.productConversation,
        items: [{ id: "product-fragment", kind: "assistant-message", body: "tail", logical_item_id: "answer", fragment_index: 2, continues_before: true }],
        page_info: { older_cursor: null, newer_cursor: "latest", has_older: false, has_newer: false, content_bytes: 55, item_count: 1 }
      }
    });
    expect(snapshot?.timeline[0]).toEqual(expect.objectContaining({ logicalItemId: "timeline-logical", fragmentIndex: 1, continuesBefore: true }));
    expect(snapshot?.timelinePageInfo).toEqual(expect.objectContaining({ olderCursor: "older", contentBytes: 99 }));
    expect(snapshot?.productConversation?.items[0]).toEqual(expect.objectContaining({ logicalItemId: "answer", fragmentIndex: 2 }));
    expect(snapshot?.bounds).toEqual(expect.objectContaining({ projectionUnavailable: true, omittedCounts: { conversationItems: 7 } }));
  });

  it("keeps a normal empty projection empty instead of inheriting demo identities", () => {
    const snapshot = resolveCoreSnapshot({
      protocolVersion: "goalport.ipc.v2",
      buildId: "core-empty",
      connection: "connected",
      projects: [],
      selectedProjectId: "",
      project: { id: "", name: "No workspace selected", workspaceRoot: "", color: "slate" },
      campaigns: [],
      activeCampaignId: "",
      activeTask: { id: "", title: "No task selected", acceptance: "", state: "waiting" },
      attempt: { id: "attempt-unassigned", taskId: "", provider: "unassigned", role: "executor", state: "waiting", sessionLabel: "No Runtime selected", eventCount: 0 },
      timeline: [],
      cursor: 0,
      runtimes: [],
      decisions: [],
      evidence: [],
      stopResponsibility: null,
      relatedHolds: [],
      preview: false,
      notices: []
    });

    expect(snapshot).toEqual(expect.objectContaining({
      projects: [], campaigns: [], activeCampaignId: "", timeline: [], decisions: [], evidence: [], preview: false
    }));
    expect(snapshot?.activeTask.id).toBe("");
    expect(snapshot?.activeTask.state).toBe("waiting");
    expect(snapshot?.attempt).toEqual(expect.objectContaining({ id: "attempt-unassigned", provider: "unassigned", state: "waiting" }));
    expect(snapshot?.attempt.id).not.toBe("attempt-codex-executor-1");
  });

  it("drops records with missing identities and preserves an unknown Runtime id", () => {
    const snapshot = resolveCoreSnapshot({
      protocolVersion: "goalport.ipc.v2",
      buildId: "core-identity",
      connection: "connected",
      projects: [{ name: "missing id" }],
      selectedProjectId: "",
      project: { id: "", name: "No workspace selected", workspaceRoot: "", color: "slate" },
      campaigns: [{ title: "missing id" }],
      activeCampaignId: "",
      activeTask: {},
      attempt: {},
      timeline: [{ body: "missing id" }],
      runtimes: [{ id: "future-runtime", name: "Future Runtime", support: "unknown", capabilities: {} }],
      decisions: [{ title: "missing id" }],
      evidence: [{ claim: "missing id" }],
      preview: false,
      notices: []
    });

    expect(snapshot?.projects).toEqual([]);
    expect(snapshot?.campaigns).toEqual([]);
    expect(snapshot?.timeline).toEqual([]);
    expect(snapshot?.decisions).toEqual([]);
    expect(snapshot?.evidence).toEqual([]);
    expect(snapshot?.runtimes[0].id).toBe("future-runtime");
    expect(snapshot?.attempt).toEqual(expect.objectContaining({ id: "attempt-unassigned", provider: "unassigned", state: "uncertain" }));
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
