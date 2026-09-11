// Deterministic fake ACP agent for GrokAcpProcess contract tests.
//
// It speaks the same Agent Client Protocol shapes the live `grok agent stdio`
// probe recorded in goal-runs/goalport-grok-native-admission/evidence/phase0-acp-probe:
// JSON-RPC over stdio, `session/update` notifications, agent->client
// `session/request_permission` whose JSON-RPC ids start at 0 for every process,
// vendor `_x.ai/*` notifications that a client must drop, and an
// `available_commands_update` that is published BEFORE the `session/new` response.
//
// No model, no network, no credentials. The scenario is read from
// `<cwd>/.fake-acp-scenario` (falling back to GOALPORT_FAKE_ACP_SCENARIO, then
// "end_turn") so parallel tests can pick different behaviour without racing on a
// process-wide environment variable.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function scenarioName() {
  try {
    return readFileSync(resolve(process.cwd(), ".fake-acp-scenario"), "utf8").trim() || "end_turn";
  } catch {
    return process.env.GOALPORT_FAKE_ACP_SCENARIO || "end_turn";
  }
}

const scenario = scenarioName();
const sessionId = process.env.GOALPORT_FAKE_ACP_SESSION || `fake-session-${process.pid}`;
let nextAgentRequestId = 0; // agent -> client ids start at 0 per process, as the real agent does
let inFlightPrompt = null;
let promptCount = 0;
const agentPending = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const vendor = (method, params) => send({ jsonrpc: "2.0", method, params });

const agentRequest = (method, params) => new Promise((resolveRequest) => {
  const id = nextAgentRequestId;
  nextAgentRequestId += 1;
  agentPending.set(id, resolveRequest);
  send({ jsonrpc: "2.0", id, method, params });
});

const COMMANDS = [
  { name: "compact", description: "Compact the conversation" },
  { name: "always-approve", description: "Toggle always-approve mode (skip all permission prompts)", input: { hint: "on|off" } },
  { name: "model", description: "Pick a model" }
];

const PERMISSION_OPTIONS = [
  { optionId: "allow-edits-session", name: "Yes, allow all edits during this session", kind: "allow_always" },
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
  { optionId: "reject-always", name: "No, and don't ask again", kind: "reject_always" }
];

function emitToolActivity() {
  notify({
    sessionUpdate: "tool_call",
    toolCallId: "fake-call-1",
    title: "read_file",
    rawInput: { target_file: "fixture.txt" },
    _meta: { "x.ai/tool": { name: "read_file", kind: "read", read_only: true } }
  });
  notify({
    sessionUpdate: "tool_call_update",
    toolCallId: "fake-call-1",
    kind: "read",
    title: "Read `fixture.txt`",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "fixture" } }]
  });
}

function emitDroppedFrames() {
  // Everything below must never reach the Core event journal.
  vendor("_x.ai/session_notification", { sessionId, kind: "pending_interaction" });
  notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "echoed user text" } });
  notify({ sessionUpdate: "plan", entries: [{ content: "step", status: "pending" }] });
}

async function runPrompt(id) {
  inFlightPrompt = id;
  promptCount += 1;
  switch (scenario) {
    case "permission_delayed": {
      // Tool activity first, then a permission request only after a delay. That gives a test a
      // deterministic window in which Safe stop lands BEFORE the request is published.
      emitToolActivity();
      await new Promise((done) => setTimeout(done, 2500));
      const outcome = await agentRequest("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "fake-call-delayed",
          kind: "edit",
          title: "Write `notes/delayed.txt`",
          rawInput: { file_path: "notes/delayed.txt", content: "fixture" },
          _meta: { "x.ai/tool": { name: "write", kind: "write", read_only: false } }
        },
        options: PERMISSION_OPTIONS
      });
      const selected = outcome?.outcome?.optionId ?? outcome?.outcome?.outcome ?? "none";
      if (inFlightPrompt === null) return;
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `SELECTED:${selected}` } });
      inFlightPrompt = null;
      respond(id, { stopReason: selected === "cancelled" ? "cancelled" : "end_turn" });
      return;
    }
    case "permission_then_exit": {
      // Ask for permission and then die without ever answering the prompt: the Core side must
      // release its blocked reader itself and fail the turn closed.
      emitDroppedFrames();
      void agentRequest("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "fake-call-write",
          kind: "edit",
          title: "Write `notes/fixture.txt`",
          rawInput: { file_path: "notes/fixture.txt", content: "fixture" },
          _meta: { "x.ai/tool": { name: "write", kind: "write", read_only: false } }
        },
        options: PERMISSION_OPTIONS
      });
      setTimeout(() => process.exit(0), 700);
      return;
    }
    case "permission_second_turn": {
      // Turn 1 ends immediately with no permission at all; only turn 2 asks. This exposes any
      // cancel queued during turn 1 leaking into turn 2's permission request.
      if (promptCount === 1) {
        notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FIRST_TURN_OK" } });
        inFlightPrompt = null;
        respond(id, { stopReason: "end_turn" });
        return;
      }
      const outcome = await agentRequest("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "fake-call-write-2",
          kind: "edit",
          title: "Write `notes/second.txt`",
          rawInput: { file_path: "notes/second.txt", content: "fixture" },
          _meta: { "x.ai/tool": { name: "write", kind: "write", read_only: false } }
        },
        options: PERMISSION_OPTIONS
      });
      const selected = outcome?.outcome?.optionId ?? outcome?.outcome?.outcome ?? "none";
      if (inFlightPrompt === null) return;
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `SELECTED:${selected}` } });
      inFlightPrompt = null;
      respond(id, { stopReason: selected === "cancelled" ? "cancelled" : "end_turn" });
      return;
    }
    case "max_turn_requests":
      inFlightPrompt = null;
      respond(id, { stopReason: "max_turn_requests" });
      return;
    case "refusal":
      inFlightPrompt = null;
      respond(id, { stopReason: "refusal" });
      return;
    case "rpc_error":
      inFlightPrompt = null;
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: "fake ACP failure" } });
      return;
    case "stream_eof":
      // The stream dies with the turn still in flight; no response is ever sent.
      process.exit(0);
      return;
    case "cancel":
      emitDroppedFrames();
      emitToolActivity();
      // Stay silent until the client sends session/cancel.
      return;
    case "permission": {
      emitDroppedFrames();
      const outcome = await agentRequest("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "fake-call-write",
          kind: "edit",
          title: "Write `notes/fixture.txt`",
          rawInput: { file_path: "notes/fixture.txt", content: "fixture" },
          _meta: { "x.ai/tool": { name: "write", kind: "write", read_only: false } }
        },
        options: PERMISSION_OPTIONS
      });
      const selected = outcome?.outcome?.optionId ?? outcome?.outcome?.outcome ?? "none";
      // A session/cancel that arrived while the permission was pending has already
      // ended this turn; do not answer the prompt twice.
      if (inFlightPrompt === null) return;
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `SELECTED:${selected}` } });
      if (selected === "allow-once") emitToolActivity();
      inFlightPrompt = null;
      respond(id, { stopReason: selected === "cancelled" ? "cancelled" : "end_turn" });
      return;
    }
    default:
      emitDroppedFrames();
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FAKE_OK" } });
      emitToolActivity();
      inFlightPrompt = null;
      respond(id, { stopReason: "end_turn" });
  }
}

const reader = createInterface({ input: process.stdin });
reader.on("close", () => process.exit(0));
reader.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined && message.id !== undefined) {
    const waiter = agentPending.get(message.id);
    if (waiter) {
      agentPending.delete(message.id);
      waiter(message.result ?? { outcome: { outcome: "error" } });
    }
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    vendor("_x.ai/models/update", { currentModelId: "fake-model" });
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true }
      }
    });
    return;
  }
  if (method === "session/new" || method === "session/load") {
    vendor("_x.ai/mcp/init_progress", { total: 0, connected: 0 });
    if (scenario !== "no_command") {
      // Published before the response, exactly as the live agent does.
      notify({ sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
    }
    respond(id, method === "session/new" ? { sessionId } : {});
    return;
  }
  if (method === "session/prompt") {
    const text = params?.prompt?.[0]?.text ?? "";
    if (text === "/always-approve off") {
      // A session command: answered immediately, with no model turn.
      respond(id, { stopReason: "end_turn" });
      return;
    }
    void runPrompt(id);
    return;
  }
  if (method === "session/cancel") {
    // permission_delayed deliberately keeps the turn open so the still-unsent permission request
    // is published AFTER the cancel; the turn then ends through the permission outcome.
    if (scenario === "permission_delayed") return;
    if (inFlightPrompt !== null) {
      const pending = inFlightPrompt;
      inFlightPrompt = null;
      respond(pending, { stopReason: "cancelled" });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `fake agent does not implement ${method}` } });
  }
});
