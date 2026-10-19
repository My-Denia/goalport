// Synthetic Codex app-server for recovery-classification contract tests (increment 3 of
// goal-runs/runtime-registration-safety), admission-failure tests (increment 4) and
// registration-generation tests (increment 5). No subscription, no network, no model.
//
// Speaks just enough of the app-server JSON-RPC handshake for `CodexProcess::create_session`
// and `resume_session`:
//   initialize (id)      -> {id, result: {}}
//   initialized          -> ignored (notification)
//   thread/start (id)    -> {id, result: {thread: {id: "fake-thread-1"}}}
//   thread/resume (id)   -> {id, result: {thread: {id: "fake-thread-1"}}} (scenario resume_ok)
//                        -> {id, error: {...}}          (scenario resume_rejected)
// The scenario travels in `.fake-codex-scenario` in the cwd (one workspace per test case):
//   exit_after_thread_start  (default) exit 0 300 ms after answering thread/start
//   linger                   stay alive after answering
//   thread_start_without_id  answer thread/start with {id, result: {}} (no thread id) and stay alive
//   resume_ok                like linger; thread/resume is accepted
//   resume_rejected          like linger; thread/resume is answered with an error
//   stall_initialize         like linger, but the initialize request is RECORDED in
//                            `.fake-codex-initialized.marker` and its reply is WITHHELD until a test
//                            writes `.fake-codex-release` in the cwd (polled every 100 ms).
//                            `.fake-codex-initialize-released.marker` is written when the withheld
//                            reply is finally sent. The default initialize reply, every other
//                            scenario, the 90 s watchdog and the stop-marker cleanup are unchanged.
// Every scenario exits 0 after 90 s at the latest (unconditional watchdog), so no node process
// outlives a test binary, and every scenario also ends as soon as `.fake-codex-stop.marker` appears
// in the cwd (polled every 100 ms) so a test can end a lingering fixture without any product kill
// path. `.fake-codex-app-server.json` records argv/cwd/ppid/execPath at start (overwritten by a
// second instance in the same cwd) and `.fake-codex-exited.marker` is written immediately before
// exiting. Exiting is never driven by stdin EOF: Core's reader thread holds a clone of the stdin pipe.
// Increment 5 launches this file through a copy of node.exe named codex.exe (resolved by Core's
// default executable lookup) and a cwd-local ESM loader file `app-server`; the `--listen stdio://`
// arguments then arrive as script arguments and are ignored.
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function scenarioName() {
  try {
    return readFileSync(resolve(process.cwd(), ".fake-codex-scenario"), "utf8").trim() || "exit_after_thread_start";
  } catch {
    return "exit_after_thread_start";
  }
}

const scenario = scenarioName();
const startedAt = Date.now();
// The fixed-name json is what the increment-3/4 tests read; the per-pid copy tells two instances
// sharing one workspace apart (increment 5).
const started = `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), ppid: process.ppid, pid: process.pid, execPath: process.execPath, scenario, startedAt }, null, 2)}\n`;
writeFileSync(resolve(process.cwd(), ".fake-codex-app-server.json"), started);
writeFileSync(resolve(process.cwd(), `.fake-codex-app-server.${process.pid}.json`), started);

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function writeMarker(names, payload) {
  const record = `${JSON.stringify(payload, null, 2)}\n`;
  for (const name of names) {
    try {
      writeFileSync(resolve(process.cwd(), name), record);
    } catch {
      // markers are diagnostic; the protocol behaviour is what matters
    }
  }
}

// stall_initialize: record that initialize arrived, then withhold its (otherwise unchanged) reply
// until the test writes the release marker. Returns true when the caller must not answer now.
function withholdInitialize(message) {
  writeMarker(
    [".fake-codex-initialized.marker", `.fake-codex-initialized.${process.pid}.marker`],
    {
      kind: "initialize.received",
      requestId: message.id,
      pid: process.pid,
      cwd: process.cwd(),
      scenario,
      elapsedMs: Date.now() - startedAt,
      released: false,
    },
  );
  let releasePoll = null;
  const reply = () => {
    if (!existsSync(resolve(process.cwd(), ".fake-codex-release"))) {
      return;
    }
    if (releasePoll !== null) clearInterval(releasePoll);
    writeMarker(
      [".fake-codex-initialize-released.marker", `.fake-codex-initialize-released.${process.pid}.marker`],
      {
        kind: "initialize.released",
        requestId: message.id,
        pid: process.pid,
        elapsedMs: Date.now() - startedAt,
      },
    );
    // The default initialize reply, exactly as the non-stall scenarios send it.
    send({ id: message.id, result: {} });
  };
  releasePoll = setInterval(reply, 100);
  reply();
  return true;
}

function exitNow(reason) {
  const marker = `${JSON.stringify({ reason, pid: process.pid, elapsedMs: Date.now() - startedAt })}\n`;
  try {
    writeFileSync(resolve(process.cwd(), ".fake-codex-exited.marker"), marker);
    writeFileSync(resolve(process.cwd(), `.fake-codex-exited.${process.pid}.marker`), marker);
  } catch {
    // the marker is diagnostic; exiting is what matters
  }
  process.exit(0);
}

// Unconditional watchdog: the timer keeps the event loop alive and always fires.
setTimeout(() => exitNow("watchdog"), 90_000);

// Stop marker: a test that must end a lingering fixture writes this file; nothing in Core does.
setInterval(() => {
  if (existsSync(resolve(process.cwd(), ".fake-codex-stop.marker"))) {
    exitNow("stop_marker");
  }
}, 100);

const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize" && message.id !== undefined) {
    if (scenario === "stall_initialize" && withholdInitialize(message)) {
      return;
    }
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    // Increment 5 (ruling B): a turn echoes its input back as an agent message so a test can
    // prove the event-reading path after a resume delivers events tied to that input.
    const text = ((message.params && message.params.input) || [])
      .map((item) => (item && typeof item.text === "string" ? item.text : ""))
      .join("");
    send({ id: message.id, result: { turn: { id: "fake-turn-1" } } });
    send({ method: "item/agentMessage/delta", params: { threadId: "fake-thread-1", turnId: "fake-turn-1", delta: `echo:${text}` } });
    send({ method: "turn/completed", params: { threadId: "fake-thread-1", turnId: "fake-turn-1" } });
    return;
  }
  if (message.method === "thread/resume" && message.id !== undefined) {
    if (scenario === "resume_rejected") {
      send({ id: message.id, error: { code: -1, message: "fake app-server rejects thread/resume" } });
    } else {
      send({ id: message.id, result: { thread: { id: "fake-thread-1" } } });
    }
    return;
  }
  if (message.method === "thread/start" && message.id !== undefined) {
    if (scenario === "thread_start_without_id") {
      // A response without a thread id: Core's create_session fails after the process was
      // started, and this process stays alive (until the stop marker or the watchdog).
      send({ id: message.id, result: {} });
      return;
    }
    send({ id: message.id, result: { thread: { id: "fake-thread-1" } } });
    if (scenario === "exit_after_thread_start") {
      setTimeout(() => exitNow("exit_after_thread_start"), 300);
    }
  }
});
reader.on("close", () => {
  // Stdin closing is not an exit signal here (see the header); the timers decide.
});
