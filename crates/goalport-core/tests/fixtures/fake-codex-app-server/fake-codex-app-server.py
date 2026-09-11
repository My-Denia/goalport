"""Synthetic Codex app-server twin in Python, for increment 6 of run `runtime-registration-safety`.

Why a Python twin next to the node fixture (`fake-codex-app-server.mjs`): on Windows a node process cannot release
its own stdout while it stays alive (libuv keeps the pipe; `process.stdout.end()`/`.destroy()`/`_handle.close()`/
`fs.closeSync(1)` all fail to deliver EOF to a piped parent until the process is about to exit — probed in
`goal-runs/runtime-registration-safety/evidence/increment-6/node-stdout-end-probe.txt`). The "process alive but
stdout closed" shape — the exact defect increment 6 fixes — therefore needs a runtime that can `os.close(1)` and keep
running (`.../python-close-probe.txt`). This file speaks the same minimal JSON-RPC-over-stdio subset the node fixture
speaks and writes the same per-pid files, so the increment-5/6 test helpers read it unchanged:

  initialize (id)    -> {id, result: {}}
  thread/start (id)  -> {id, result: {thread: {id: "fake-thread-1"}}}    (then per scenario)
  thread/resume (id) -> {id, result: {}}                                  (then per scenario)
  turn/start (id)    -> {id, result: {turn: {id: "fake-turn-1"}}}
                        + item/agentMessage/delta (`echo:<text>`) + turn/completed   (or per scenario)

Scenarios travel in `.fake-codex-scenario` in the cwd (one workspace per test case); default `linger`:
  linger                              answers everything, stays alive until the stop marker / watchdog
  stdout_closed_before_thread_start   on thread/start: close stdout (os.close(1)) WITHOUT answering; stay alive
  stdout_closed_after_thread_start    answer thread/start, then close stdout; stay alive
  stdout_closed_before_resume         on thread/resume: close stdout WITHOUT answering; stay alive
  stdout_closed_after_resume          answer thread/resume, then close stdout; stay alive
  oversized_after_turn_start          answer turn/start, then write ONE line of 16 MiB + 1 byte (never read by a
                                      bounded reader), then the echo + turn/completed (no-ops once the pipe dropped);
                                      stay alive

Files written in the cwd (the per-case workspace): `.fake-codex-app-server.json` and `.<pid>.json` (argv, cwd, ppid,
pid, execPath, scenario, startedAt, runtime), `.fake-codex-exited.marker` and `.<pid>.marker` ({reason, pid,
elapsedMs}), `.fake-codex-turns.<pid>.json` ({count, inputs}, rewritten before every turn/start is answered). Every
instance exits 0 after 45 s at the latest (watchdog) and as soon as `.fake-codex-stop.marker` appears. Stdin closing
is not an exit signal. Nothing is written anywhere else. No network. `send()` swallows the OSError a closed stdout
raises, so a write into a broken pipe never crashes the process (the node fixture's uncaught-EPIPE hazard cannot occur
here).
"""
import json
import os
import sys
import threading
import time

STARTED_AT = time.time()
CWD = os.getcwd()
PID = os.getpid()
WATCHDOG_S = 45.0
OVERSIZED_BYTES = 16 * 1024 * 1024 + 1
LOCK = threading.Lock()
STDOUT_CLOSED = False
TURNS = {"count": 0, "inputs": []}


def scenario_name():
    try:
        with open(os.path.join(CWD, ".fake-codex-scenario"), "r", encoding="utf-8") as handle:
            return handle.read().strip() or "linger"
    except OSError:
        return "linger"


SCENARIO = scenario_name()


def write_file(name, text):
    try:
        with open(os.path.join(CWD, name), "w", encoding="utf-8") as handle:
            handle.write(text)
    except OSError:
        pass


_started = json.dumps({
    "argv": sys.argv[1:], "cwd": CWD, "ppid": os.getppid(), "pid": PID, "execPath": sys.executable,
    "scenario": SCENARIO, "startedAt": int(STARTED_AT * 1000), "runtime": "python",
}, indent=2) + "\n"
write_file(".fake-codex-app-server.json", _started)
write_file(f".fake-codex-app-server.{PID}.json", _started)


def send(obj):
    """One JSON line on stdout; a no-op once stdout was closed (a real app-server that lost its pipe)."""
    global STDOUT_CLOSED
    if STDOUT_CLOSED:
        return
    try:
        os.write(1, (json.dumps(obj) + "\n").encode("utf-8"))
    except OSError:
        STDOUT_CLOSED = True


def send_raw_line(data):
    global STDOUT_CLOSED
    if STDOUT_CLOSED:
        return
    view = memoryview(data)
    try:
        while len(view):
            written = os.write(1, view)
            view = view[written:]
    except OSError:
        STDOUT_CLOSED = True


def close_stdout():
    """The shape node cannot produce on Windows: the write end is released while this process lives."""
    global STDOUT_CLOSED
    STDOUT_CLOSED = True
    try:
        os.close(1)
    except OSError:
        pass


def exit_now(reason):
    marker = json.dumps({"reason": reason, "pid": PID, "elapsedMs": int((time.time() - STARTED_AT) * 1000)}) + "\n"
    write_file(".fake-codex-exited.marker", marker)
    write_file(f".fake-codex-exited.{PID}.marker", marker)
    os._exit(0)


def timers():
    while True:
        time.sleep(0.1)
        if os.path.exists(os.path.join(CWD, ".fake-codex-stop.marker")):
            exit_now("stop_marker")
        if time.time() - STARTED_AT >= WATCHDOG_S:
            exit_now("watchdog")


def handle(message):
    method = message.get("method")
    mid = message.get("id")
    if method == "initialize" and mid is not None:
        send({"id": mid, "result": {}})
        return
    if method == "thread/start" and mid is not None:
        if SCENARIO == "stdout_closed_before_thread_start":
            close_stdout()
            return
        send({"id": mid, "result": {"thread": {"id": "fake-thread-1"}}})
        if SCENARIO == "stdout_closed_after_thread_start":
            close_stdout()
        return
    if method == "thread/resume" and mid is not None:
        if SCENARIO == "stdout_closed_before_resume":
            close_stdout()
            return
        send({"id": mid, "result": {}})
        if SCENARIO == "stdout_closed_after_resume":
            close_stdout()
        return
    if method == "turn/start" and mid is not None:
        text = "".join(
            item.get("text", "") for item in (message.get("params") or {}).get("input", [])
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        )
        with LOCK:
            TURNS["count"] += 1
            TURNS["inputs"].append(text)
            write_file(f".fake-codex-turns.{PID}.json", json.dumps(TURNS) + "\n")
        send({"id": mid, "result": {"turn": {"id": "fake-turn-1"}}})
        if SCENARIO == "oversized_after_turn_start":
            line = (
                b'{"method":"item/agentMessage/delta","params":{"threadId":"fake-thread-1",'
                b'"turnId":"fake-turn-1","delta":"' + (b"x" * OVERSIZED_BYTES) + b'"}}\n'
            )
            send_raw_line(line)
        send({"method": "item/agentMessage/delta",
              "params": {"threadId": "fake-thread-1", "turnId": "fake-turn-1", "delta": f"echo:{text}"}})
        send({"method": "turn/completed", "params": {"threadId": "fake-thread-1", "turnId": "fake-turn-1"}})
        return
    # anything else (the `initialized` notification, unknown methods): ignored


def main():
    threading.Thread(target=timers, daemon=True).start()
    stdin = os.fdopen(0, "rb", buffering=0)
    buffer = b""
    while True:
        chunk = stdin.read(65536)
        if not chunk:
            # stdin closing is not an exit signal here (see the header): the timers decide
            while True:
                time.sleep(1.0)
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            try:
                message = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(message, dict):
                handle(message)


if __name__ == "__main__":
    main()
