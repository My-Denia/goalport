// Deterministic fake Claude stream-json CLI for ClaudeStreamProcess contract tests.
// Speaks the live 2.1.259 host-permission frames from
// goal-runs/goalport-claude-native-control-admission/evidence/phase0/stream-json-probe-stdio.
import { createInterface } from "node:readline";
import { writeFileSync, readFileSync, mkdirSync, renameSync, closeSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

function scenarioName() {
  try {
    return readFileSync(resolve(process.cwd(), ".fake-claude-scenario"), "utf8").trim() || "end_turn";
  } catch {
    return process.env.GOALPORT_FAKE_CLAUDE_SCENARIO || "end_turn";
  }
}

const scenario = scenarioName();
const argv = process.argv.slice(2);
function resumeArg() {
  const index = argv.indexOf("--resume");
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("-") ? value : null;
}
const requestedResume = resumeArg();
// Frame the fixture emits when a console control event reaches its handler.
// It is fixture output on the provider stream, not a broker acknowledgement:
// the broker's channel is a separate private pipe this process cannot reach.
const STOP_ACK_FRAME = "_goalport/fixture_stop_ack";
let sessionId = requestedResume || "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
if ((scenario === "resume_mismatch" || scenario === "resume_mismatch_with_child") && requestedResume) {
  sessionId = "bbbbbbbb-bbbb-4ccc-8ddd-ffffffffffff";
}
const nativePermissionId = "11111111-2222-4333-8444-555555555555";
const toolUseId = "toolu_fake_edit_1";
const writeTarget = resolve(process.cwd(), "notes/fixture-allow.txt");
const stdinLog = [];
let initializeSeen = false;
let userCount = 0;
let permissionAnswered = false;
let interruptSeen = false;
let waitingPermission = false;
let waitingInterrupt = false;
let currentInputUuid = null;
let nativePermissionSeq = 0;
let currentNativePermissionId = nativePermissionId;

function hostPid() {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const line = status.split("\n").find((row) => row.startsWith("NSpid:"));
    const host = line && line.split(/\s+/)[1];
    if (host) return Number(host);
  } catch {
    // Non-Linux fixtures keep the process pid.
  }
  return process.pid;
}

writeFileSync(
  resolve(process.cwd(), ".fake-claude-argv.json"),
  `${JSON.stringify({ argv, scenario, cwd: process.cwd(), pid: hostPid() }, null, 2)}\n`
);

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitInit() {
  writeFileSync(resolve(process.cwd(), ".fake-claude-session-id"), sessionId);
  send({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    apiKeySource: "none",
    claude_code_version: "2.1.259",
    permissionMode: "default",
    cwd: process.cwd(),
    tools: ["Read", "Edit", "Write", "Bash"],
    capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"]
  });
}

function emitText(text) {
  send({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }]
    }
  });
}

function emitToolUse(name, id, input) {
  send({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }]
    }
  });
}

function emitToolResult(id, content, extra = {}) {
  const block = { type: "tool_result", tool_use_id: id, content };
  if (extra.is_error) block.is_error = true;
  if (Number.isInteger(extra.exitCode)) block.exitCode = extra.exitCode;
  send({
    type: "user",
    message: {
      role: "user",
      content: [block]
    }
  });
}

function emitResult(stopReason, extra = {}) {
  send({
    type: "result",
    subtype: extra.subtype || (extra.is_error ? "error" : "success"),
    is_error: Boolean(extra.is_error),
    stop_reason: stopReason,
    session_id: sessionId,
    uuid: randomUUID(),
    user_message_uuid: currentInputUuid,
    user_message_uuids: [currentInputUuid],
    result: extra.result || ""
  });
}

function nextNativePermissionId() {
  nativePermissionSeq += 1;
  currentNativePermissionId =
    nativePermissionSeq === 1
      ? nativePermissionId
      : `22222222-2222-4333-8444-${String(nativePermissionSeq).padStart(12, "0")}`;
  return currentNativePermissionId;
}

function emitCanUseTool(toolName = "Edit", input = {
  file_path: writeTarget,
  old_string: "",
  new_string: "PROBE_WRITE_OK\n"
}) {
  waitingPermission = true;
  permissionAnswered = false;
  const requestId = nextNativePermissionId();
  send({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      tool_use_id: nativePermissionSeq === 1 ? toolUseId : `${toolUseId}_${nativePermissionSeq}`,
      input
    }
  });
}

// Atomic: write a sibling temp file, then rename over the target. `writeFileSync`
// truncates first, so a reader that lands inside the window sees an empty or partial
// file -- which is exactly how `initialize_precedes_first_user_message` failed ~4% of
// the time with `EOF while parsing a value`. `renameSync` replaces atomically on
// Windows (MoveFileEx with MOVEFILE_REPLACE_EXISTING) as well as on POSIX, so a reader
// sees either the previous complete file or the new complete file, never a torn one.
function atomicWrite(path, contents) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, path);
}

function persistStdin() {
  atomicWrite(
    resolve(process.cwd(), ".fake-claude-stdin.jsonl"),
    stdinLog.map((row) => JSON.stringify(row)).join("\n") + (stdinLog.length ? "\n" : "")
  );
  atomicWrite(
    resolve(process.cwd(), ".fake-claude-stdin-types.json"),
    `${JSON.stringify(stdinLog.map((row) => ({
      type: row.type,
      subtype: row.request?.subtype || row.response?.subtype || null,
      request_id: row.request_id || row.response?.request_id || null
    })))}\n`
  );
}

function handlePermissionResponse(obj) {
  const response = obj.response || {};
  const requestId = response.request_id;
  const body = response.response || {};
  writeFileSync(
    resolve(process.cwd(), ".fake-claude-last-permission-response.json"),
    `${JSON.stringify({ request_id: requestId, body, raw: obj }, null, 2)}\n`
  );
  if (requestId !== currentNativePermissionId) {
    return;
  }
  waitingPermission = false;
  permissionAnswered = true;
  if (body.behavior === "allow") {
    if (scenario === "native_stop_after_allow") {
      emitToolResult(toolUseId, "probe output");
      emitText("WORKING_AFTER_ALLOW");
      waitingInterrupt = true;
      return;
    }
    if (scenario === "allow_then_unconfirmed_stop" && userCount === 1) {
      emitToolResult(toolUseId, "probe output");
      emitText("ALLOWED_ONCE");
      emitResult("end_turn", { result: "ALLOWED_ONCE" });
      return;
    }
    if (scenario === "two_permissions" && nativePermissionSeq === 1) {
      emitText("BETWEEN_PERMISSIONS");
      emitCanUseTool("Read", { file_path: "README.md" });
      return;
    }
    if (body.updatedInput == null) {
      emitText("FAIL_NULL_UPDATED_INPUT");
      emitResult("error", { is_error: true, result: "updatedInput was null" });
      return;
    }
    if (body.updatedPermissions || body.behavior === "allow_always") {
      emitText("FAIL_PERSISTED_PERMISSION");
      emitResult("error", { is_error: true });
      return;
    }
    mkdirSync(resolve(process.cwd(), "notes"), { recursive: true });
    writeFileSync(writeTarget, "PROBE_WRITE_OK\n");
    emitToolResult(toolUseId, "edited");
    emitText("ALLOWED");
    emitResult("end_turn", { result: "ALLOWED" });
    return;
  }
  if (scenario === "deny_tool_result") {
    emitToolResult(toolUseId, "User rejected Write permission", { is_error: true });
    emitText("DENIED");
    emitResult("end_turn", { result: "DENIED" });
    return;
  }
  if (scenario === "deny_still_writes") {
    mkdirSync(resolve(process.cwd(), "notes"), { recursive: true });
    writeFileSync(writeTarget, "DENIED_BUT_WROTE\n");
    emitToolResult(toolUseId, "edited despite deny");
    emitText("DENIED_BUT_WROTE");
    emitResult("end_turn", { result: "DENIED_BUT_WROTE" });
    return;
  }
  if (scenario === "interrupt_mutating") {
    emitToolResult(toolUseId, "Write denied by interrupt", { is_error: true });
    return;
  }
  if (scenario === "native_stop_pending_permission"
    || scenario === "native_stop_denial_no_id"
    || scenario === "native_stop_denial_subset"
    || scenario === "native_stop_denial_silent") {
    // The Stop's deny lands while the decision is pending; the denied tool
    // never runs. Real Claude still answers the rejection with a tool_result
    // for the rejected tool before the interrupt result ends the turn.
    emitToolResult(toolUseId, "Permission denied by stop", { is_error: true });
    return;
  }
  if (scenario === "unknown_path") {
    emitToolResult(toolUseId, "User rejected Bash permission", { is_error: true });
    emitText("DENIED");
    emitResult("end_turn", { result: "DENIED_UNKNOWN_PATH" });
    return;
  }
  if (scenario === "deny_bash_no_path") {
    emitToolResult(toolUseId, "User rejected Bash permission", { is_error: true });
    emitText("DENIED");
    emitResult("end_turn", { result: "DENIED_BASH_NO_PATH" });
    return;
  }
  if (scenario === "deny_bash_writes") {
    mkdirSync(resolve(process.cwd(), "notes"), { recursive: true });
    writeFileSync(resolve(process.cwd(), "notes/denied-write.txt"), "DENIED_BUT_WROTE\n");
    emitToolResult(toolUseId, "wrote after deny");
    emitText("DENIED_BUT_WROTE");
    emitResult("end_turn", { result: "DENIED_BUT_WROTE" });
    return;
  }
  emitText("DENIED");
  emitResult("end_turn", { result: "DENIED" });
}

function beginTurn() {
  userCount += 1;
  if (userCount === 1 && scenario === "resume_mismatch_with_child") {
    // Spawn before the mismatch init frame so the post-send snapshot, taken
    // while this process is still alive, includes the descendant.
    // Host pid, not the pid-namespace local pid. /proc on the host is what
    // Core's snapshot walks; getpid() inside the namespace is not that number.
    const child = spawn("python3", ["-c", "import time\nstatus=open('/proc/self/status').read()\nhost=[line.split()[1] for line in status.splitlines() if line.startswith('NSpid:')][0]\nopen('.fake-claude-descendant.pid','w').write(host)\ntime.sleep(300)"], { cwd: process.cwd(), stdio: "ignore" });
    child.unref();
    const marker = resolve(process.cwd(), ".fake-claude-descendant.pid");
    for (let i = 0; i < 50 && !existsSync(marker); i += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  if (userCount === 1) {
    emitInit();
  }
  if (scenario.startsWith("native_stop_")
    && scenario !== "native_stop_pending_permission"
    && scenario !== "native_stop_denial_no_id"
    && scenario !== "native_stop_denial_subset"
    && scenario !== "native_stop_denial_silent"
    && scenario !== "native_stop_after_allow") {
    emitToolUse("Read", "toolu_native_stop_read", {file_path: "README.md"});
    emitToolResult("toolu_native_stop_read", "before Stop");
    emitText("working");
    waitingInterrupt = true;
    return;
  }
  switch (scenario) {
    case "two_permissions":
      emitText("BEFORE_FIRST_PERMISSION");
      emitCanUseTool();
      return;
    case "permission_close_stdin":
      emitText("BEFORE_CLOSED_STDIN");
      emitCanUseTool();
      closeSync(0);
      return;
    case "permission_then_exit":
      emitText("BEFORE_EOF");
      emitCanUseTool();
      persistStdin();
      process.exit(0);
      return;
    case "permission":
    case "allow_once":
    case "deny":
    case "deny_tool_result":
    case "mismatch":
      emitToolUse("Edit", toolUseId, {
        file_path: writeTarget,
        old_string: "",
        new_string: "PROBE_WRITE_OK\n"
      });
      emitCanUseTool();
      return;
    case "deny_still_writes":
      mkdirSync(resolve(process.cwd(), "notes"), { recursive: true });
      writeFileSync(writeTarget, "BASELINE\n");
      emitToolUse("Write", toolUseId, {
        file_path: writeTarget,
        contents: "PROBE_WRITE_OK\n"
      });
      emitCanUseTool("Write", {
        file_path: writeTarget,
        contents: "PROBE_WRITE_OK\n"
      });
      return;
    case "unknown_path":
      emitToolUse("Bash", toolUseId, { command: "echo GOALPORT_UNKNOWN_PATH" });
      emitCanUseTool("Bash", { command: "echo GOALPORT_UNKNOWN_PATH" });
      return;
    case "deny_bash_no_path":
      emitToolUse("Bash", toolUseId, { command: "ls" });
      emitCanUseTool("Bash", { command: "ls" });
      return;
    case "deny_bash_writes":
      emitToolUse("Bash", toolUseId, { command: "printf mutated" });
      emitCanUseTool("Bash", { command: "printf mutated" });
      return;
    case "approved_bash":
      emitToolUse("Bash", toolUseId, { command: "pytest -q", cwd: process.cwd() });
      emitCanUseTool("Bash", { command: "pytest -q", cwd: process.cwd() });
      return;
    case "readonly_bash":
      emitToolUse("Bash", toolUseId, { command: "ls notes", cwd: process.cwd() });
      emitToolResult(toolUseId, "notes\n");
      emitText("LISTED");
      emitResult("end_turn", { result: "LISTED" });
      return;
    case "bash_exit_fact":
      emitToolUse("Bash", toolUseId, { command: "pytest -q", cwd: process.cwd() });
      emitToolResult(toolUseId, "1 passed\n", { exitCode: 0 });
      emitResult("end_turn", { result: "1 passed" });
      return;
    case "bash_rewrites_binary": {
      emitToolUse("Bash", toolUseId, { command: "printf binary" });
      const marker = resolve(process.cwd(), ".fake-claude-continue");
      const deadline = Date.now() + 5000;
      while (!existsSync(marker)) {
        if (Date.now() > deadline) {
          emitResult("error", { is_error: true, result: "continue marker missing" });
          return;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      writeFileSync(resolve(process.cwd(), "cache.bin"), Buffer.from([0, 1, 2, 3]));
      emitToolResult(toolUseId, "rewrote cache");
      emitResult("end_turn", { result: "REWROTE" });
      return;
    }
    case "bash_writes_without_permission": {
      emitToolUse("Bash", toolUseId, { command: "printf mutated" });
      const marker = resolve(process.cwd(), ".fake-claude-continue");
      const deadline = Date.now() + 5000;
      while (!existsSync(marker)) {
        if (Date.now() > deadline) {
          emitResult("error", { is_error: true, result: "continue marker missing" });
          return;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      mkdirSync(resolve(process.cwd(), "notes"), { recursive: true });
      writeFileSync(resolve(process.cwd(), "notes/mutated.txt"), "mutated\n");
      emitToolResult(toolUseId, "wrote mutated");
      emitResult("end_turn", { result: "WROTE" });
      return;
    }
    case "interrupt":
    case "interrupt_eof":
    case "interrupt_error":
    case "interrupt_error_during_execution":
    case "interrupt_no_receipt":
      emitToolUse("Read", "toolu_fake_read_1", { file_path: "README.md" });
      emitToolResult("toolu_fake_read_1", "fixture");
      emitText("working");
      waitingInterrupt = true;
      return;
    // Real claude 2.1.288 (live-fix-9): a Stop landing on a pending
    // can_use_tool gets the permission denied by GoalPort, then the turn ends
    // aborted_tools with that tool reported in permission_denials.
    case "native_stop_pending_permission":
    // Same shape, but the result reports a denial entry with NO tool_use_id:
    // it must not match the stop-time denied set and must fail closed.
    case "native_stop_denial_no_id":
      emitToolUse("Bash", toolUseId, {
        command: "bash -c 'while true; do date >> tick.txt; sleep 0.5; done'",
        timeout: 600000
      });
      emitCanUseTool("Bash", {
        command: "bash -c 'while true; do date >> tick.txt; sleep 0.5; done'",
        timeout: 600000
      });
      waitingInterrupt = true;
      return;
    case "interrupt_mutating":
      emitToolUse("Write", toolUseId, {
        file_path: writeTarget,
        contents: "PROBE_WRITE_OK\n"
      });
      emitCanUseTool("Write", {
        file_path: writeTarget,
        contents: "PROBE_WRITE_OK\n"
      });
      waitingInterrupt = true;
      return;
    // Turn 1: a Bash permission is ALLOWED by the host and runs; the turn
    // stays in flight until a Stop arrives, which the fixture answers with
    // the confirmed native_stop shape and NO denials (the allowed tool is
    // not a denial). Models: Allow, then active-tool Stop.
    // Merge-review P1 (denial-set equality): a Stop that denies TWO pending
    // permissions while the result reports only one (subset), or denies one
    // while the result reports none (silent), must NOT confirm.
    case "native_stop_denial_subset":
      emitToolUse("Write", toolUseId, {
        file_path: writeTarget,
        contents: "PROBE_WRITE_OK\n"
      });
      emitCanUseTool("Write", {
        file_path: writeTarget,
        contents: "PROBE_WRITE_OK\n"
      });
      emitToolUse("Bash", `${toolUseId}_bash`, { command: "echo probe" });
      emitCanUseTool("Bash", { command: "echo probe" });
      waitingInterrupt = true;
      return;
    case "native_stop_denial_silent":
      emitToolUse("Write", toolUseId, {
        file_path: writeTarget,
        contents: "PROBE_WRITE_OK\n"
      });
      emitCanUseTool("Write", {
        file_path: writeTarget,
        contents: "PROBE_WRITE_OK\n"
      });
      waitingInterrupt = true;
      return;
    // Merge-review P1 (descendant leg): the CLI leaves behind a child that
    // turns itself non-dumpable (its /proc cwd becomes unreadable), with the
    // workspace as its cwd, surviving the Stop. The stop-time snapshot must
    // record it (parent links are readable regardless) and the release must
    // hold until it is gone.
    case "two_tool_frame": {
      send({
        type: "assistant",
        message: { role: "assistant", content: [
          { type: "tool_use", id: "toolu_frame_bash", name: "Bash", input: { command: "echo probe" } },
          { type: "tool_use", id: "toolu_frame_write", name: "Write", input: { file_path: writeTarget, contents: "X\n" } }
        ] }
      });
      emitText("working");
      waitingInterrupt = true;
      return;
    }
    case "stop_descendant": {
      emitToolUse("Read", "toolu_native_stop_read", { file_path: "README.md" });
      emitToolResult("toolu_native_stop_read", "before Stop");
      emitText("working");
      const child = spawn("python3", ["-c", "import ctypes,time;ctypes.CDLL(None).prctl(4,0);status=open('/proc/self/status').read();host=[line.split()[1] for line in status.splitlines() if line.startswith('NSpid:')][0];open('.fake-claude-descendant.pid','w').write(host);time.sleep(300)"], { cwd: process.cwd(), stdio: "ignore" });
      child.unref();
      waitingInterrupt = true;
      return;
    }
    case "native_stop_after_allow":
      if (userCount === 1) {
        emitText("ASKING_FOR_BASH");
        emitCanUseTool("Bash", { command: "echo probe", cwd: process.cwd() });
        return;
      }
      emitText("GOALPORT_FAKE_CLAUDE_OK");
      emitResult("end_turn", { result: "GOALPORT_FAKE_CLAUDE_OK" });
      return;
    // Turn 1: an allowed Bash runs and the turn completes (the sticky
    // admission latch is set). Turn 2: activity, and the Stop makes the
    // process EXIT with no receipt and no result: an unconfirmed Stop with
    // execution that WAS admitted earlier in the process binding.
    case "allow_then_unconfirmed_stop":
      if (userCount === 1) {
        emitText("ASKING_FOR_BASH");
        emitCanUseTool("Bash", { command: "echo probe", cwd: process.cwd() });
        return;
      }
      emitToolUse("Read", "toolu_fake_read_1", { file_path: "README.md" });
      emitToolResult("toolu_fake_read_1", "fixture");
      emitText("working");
      waitingInterrupt = true;
      return;
    // AC6c console-topology target. The turn stays genuinely in flight with no
    // result frame, so the only thing that can end it is a delivered console
    // control event.
    case "broker_stop":
    case "broker_stop_ignores_signal":
      emitToolUse("Read", "toolu_fake_read_1", { file_path: "README.md" });
      emitToolResult("toolu_fake_read_1", "fixture");
      emitText("working");
      waitingInterrupt = true;
      return;
    // Same, plus an owned descendant that writes to the workspace after a delay.
    // Containment has to account for it; a stop that leaves it running is not a
    // stop.
    case "broker_stop_descendant": {
      emitToolUse("Read", "toolu_fake_read_1", { file_path: "README.md" });
      emitToolResult("toolu_fake_read_1", "fixture");
      mkdirSync(resolve(process.cwd(), "notes"), { recursive: true });
      // Both descendants outlive the bounded stop fallback, so whatever is
      // still running when the signal lands really is a survivor.
      const writer = (marker) =>
        `process.on("SIGBREAK", () => {}); process.on("SIGINT", () => {});` +
        ` setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "DESCENDANT_WROTE_AFTER_STOP\\n"); }, 12000);`;
      // Ordinary child: shares the console and the process group, and ignores
      // the console control event. This is what a tool subprocess looks like.
      const owned = spawn(
        process.execPath,
        ["-e", writer(resolve(process.cwd(), "notes/descendant-write.txt"))],
        { stdio: "ignore", windowsHide: true }
      );
      owned.unref();
      // Detached child: explicitly asks to leave the console group. Recorded
      // separately so containment can be reported per descendant kind.
      const detached = spawn(
        process.execPath,
        ["-e", writer(resolve(process.cwd(), "notes/detached-write.txt"))],
        { stdio: "ignore", detached: true, windowsHide: true }
      );
      detached.unref();
      send({
        type: "_goalport/fixture_descendant",
        owned_pid: owned.pid,
        detached_pid: detached.pid
      });
      emitText("working");
      waitingInterrupt = true;
      return;
    }
    // The untrusted provider stream tries to pass itself off as the broker's
    // acknowledgement channel. It must not reach or contaminate it.
    case "broker_stop_forged_ack":
      emitToolUse("Read", "toolu_fake_read_1", { file_path: "README.md" });
      emitToolResult("toolu_fake_read_1", "fixture");
      send({
        v: 1,
        protocol: "goalport.claude.stop-broker.v1",
        type: "stop_ack",
        accepted: true,
        identityMatch: true,
        signal: { attempted: true, returned: true, lastError: 0 },
        forgedBy: "provider-stdout"
      });
      emitText("working");
      waitingInterrupt = true;
      return;
    case "eof_mid_turn":
      emitToolUse("Edit", toolUseId, { file_path: writeTarget });
      persistStdin();
      process.exit(0);
      return;
    case "token_stream":
      for (const ch of "HELLO") {
        emitText(ch);
      }
      emitResult("end_turn", { result: "HELLO" });
      return;
    case "duplicate_text":
      emitText("SAME_REPLY");
      emitText("SAME_REPLY");
      emitResult("end_turn", { result: "SAME_REPLY" });
      return;
    case "fail_open":
      emitToolUse("Edit", toolUseId, {
        file_path: writeTarget,
        new_string: "PROBE_WRITE_OK\n"
      });
      mkdirSync(resolve(process.cwd(), "notes"), { recursive: true });
      writeFileSync(writeTarget, "PROBE_WRITE_OK\n");
      emitToolResult(toolUseId, "edited without host decision");
      emitResult("end_turn", { result: "FAIL_OPEN" });
      return;
    default:
      emitText("GOALPORT_FAKE_CLAUDE_OK");
      emitResult("end_turn", { result: "GOALPORT_FAKE_CLAUDE_OK" });
  }
}

// AC6c determinism: record and honour a GoalPort process stop. If the console
// control event actually reaches this process group, the exact child leaves a
// signed marker and exits, so a test can tell "effect observed" apart from
// "signal accepted by the OS but never delivered".
for (const signal of ["SIGBREAK", "SIGINT", "SIGTERM"]) {
  try {
    process.on(signal, () => {
      try {
        // Acknowledge in the ordered provider stream first, so a reader that
        // drains to EOF can prove the handler ran before the process left.
        send({
          type: STOP_ACK_FRAME,
          signal,
          pid: process.pid,
          scenario,
          handler_registered: true
        });
        writeFileSync(
          resolve(process.cwd(), ".fake-claude-stop-signal.json"),
          `${JSON.stringify({ signal, pid: process.pid, scenario })}\n`
        );
        persistStdin();
      } catch {
        // exiting is the contract; a failed marker write must not block it
      }
      // A scenario that deliberately ignores the event proves the difference
      // between "the handler ran" and "the process actually stopped".
      if (scenario === "broker_stop_ignores_signal") return;
      process.exit(0);
    });
  } catch {
    // not every signal name is bindable on every host
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return;
  }
  stdinLog.push(obj);
  persistStdin();
    if (obj.type === "control_request" && obj.request?.subtype === "initialize") {
      initializeSeen = true;
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: obj.request_id,
          response: { commands: [], pid: process.pid }
        }
      });
      // Real claude 2.1.288 emits system/init only after the first user
      // message, on fresh starts and on --resume alike (probes A/C in
      // goal-runs/claude-native-session/evidence/resume-probe/). beginTurn's
      // first-user-message emitInit models that for every path.
      return;
    }
  if (obj.type === "control_request" && obj.request?.subtype === "interrupt") {
    interruptSeen = true;
    waitingInterrupt = false;
    if (scenario.startsWith("native_stop_")) {
      const receipt = {type:"control_response", response:{subtype:"success", request_id:obj.request_id, response:{still_queued:[]}}};
      const result = {type:"result",uuid:randomUUID(),session_id:sessionId,
        user_message_uuid:currentInputUuid,user_message_uuids:[currentInputUuid],
        terminal_reason:"aborted_tools",subtype:"error_during_execution",is_error:true,permission_denials:[]};
      if (scenario === "native_stop_foreign") result.user_message_uuids=[randomUUID()];
      if (scenario === "native_stop_missing") delete result.user_message_uuid;
      if (scenario === "native_stop_denial") result.permission_denials=[{tool_use_id:"other-denied-tool"}];
      if (scenario === "native_stop_pending_permission") result.permission_denials=[{tool_name:"Bash", tool_use_id:toolUseId, tool_input:{command:"tick"}}];
      if (scenario === "native_stop_denial_subset") result.permission_denials=[{tool_name:"Write", tool_use_id:toolUseId, tool_input:{}}];
      if (scenario === "native_stop_denial_silent") result.permission_denials=[];
      if (scenario === "native_stop_denial_no_id") result.permission_denials=[{tool_name:"Bash", tool_input:{command:"tick"}}];
      if (scenario === "native_stop_error") {result.terminal_reason="api_error";result.subtype="success";result.api_error_status=404;}
      if (scenario === "native_stop_normal") {result.terminal_reason="completed";result.subtype="success";result.is_error=false;}
      if (scenario === "native_stop_origin") result.origin={kind:"background_task"};
      if (scenario === "native_stop_receipt_error") receipt.response.subtype="error";
      if (scenario === "native_stop_reordered") {send(result);setTimeout(()=>send(receipt),50);}
      else {if(scenario !== "native_stop_no_receipt") send(receipt);send(result);}
      if (scenario === "native_stop_positive") {
        setTimeout(()=>{
          writeFileSync(resolve(process.cwd(),"post-result.txt"),"actual fixture write after native result\n");
          emitToolResult("toolu_native_stop_read","late delivery; generation unknown");
          send(result);
        },100);
      }
      return;
    }
    if (scenario === "two_tool_frame" || scenario === "stop_descendant") {
      send({type:"control_response",response:{subtype:"success",request_id:obj.request_id,response:{still_queued:[]}}});
      send({type:"result",uuid:randomUUID(),session_id:sessionId,
        user_message_uuid:currentInputUuid,user_message_uuids:[currentInputUuid],
        terminal_reason:"aborted_tools",subtype:"error_during_execution",is_error:true,permission_denials:[]});
      return;
    }
    if (scenario === "interrupt_eof" || scenario === "allow_then_unconfirmed_stop") {
      persistStdin();
      process.exit(0);
      return;
    }
    if (scenario === "interrupt_error") {
      emitResult("tool_use", { is_error: true, result: "INTERRUPTED_ERROR" });
      return;
    }
    // Console-topology scenarios deliberately never answer the structured
    // interrupt, so the Stop reaches the bounded process-stop fallback and the
    // topology, not the provider, is what gets measured.
    if (scenario.startsWith("broker_stop")) {
      return;
    }
    if (scenario === "interrupt_no_receipt") {
      emitText("INTERRUPTED");
      emitResult("interrupted", { result: "INTERRUPTED" });
      return;
    }
    if (scenario === "interrupt_error_during_execution") {
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: obj.request_id,
          response: { still_queued: [] }
        }
      });
      emitResult("tool_use", {
        subtype: "error_during_execution",
        is_error: true,
        result: "INTERRUPTED"
      });
      return;
    }
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: obj.request_id,
        response: { still_queued: [] }
      }
    });
    emitText("INTERRUPTED");
    emitResult("interrupted", { result: "INTERRUPTED" });
    return;
  }
  if (obj.type === "control_response") {
    handlePermissionResponse(obj);
    return;
  }
  if (obj.type === "user") {
    currentInputUuid = obj.uuid;
    if (!initializeSeen) {
      writeFileSync(
        resolve(process.cwd(), ".fake-claude-order-error.json"),
        `${JSON.stringify({ error: "user before initialize", stdinLog })}\n`
      );
    }
    beginTurn();
  }
});

setTimeout(() => {
  persistStdin();
}, 50);
