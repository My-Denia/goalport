"""Local app-server wire peer for Linux tests. It never opens a vendor account."""

import json
import os
import pathlib
import subprocess
import sys
import time

workspace = pathlib.Path.cwd()
turns = 0
pending_permission_turn = None
pending_callbacks = []
scenario_file = workspace / "peer-scenario"
scenario = scenario_file.read_text().strip() if scenario_file.exists() else "quota-then-success"
with (workspace / "process-starts").open("a") as started:
    started.write(f"{os.getpid()}\n")


def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


shim_init = workspace / "shim-initialize.json"
if shim_init.exists():
    initial_request = json.loads(shim_init.read_text())
    send({"id": initial_request["id"], "result": {}})


for line in sys.stdin:
    try:
        message = json.loads(line)
    except json.JSONDecodeError:
        continue
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize" and request_id is not None:
        if scenario == "stall-initialize":
            (workspace / "initialize-entered").write_text("ready")
            while not (workspace / "release-initialize").exists():
                time.sleep(0.01)
        send({"id": request_id, "result": {}})
    elif method == "thread/start" and request_id is not None:
        if scenario == "auth-required":
            send({"id": request_id, "error": {"code": -32000, "message": "fixture sign-in required", "data": {"codexErrorInfo": "unauthorized"}}})
            continue
        if scenario == "exit-parent-stdout-open":
            holder_script = (
                "import pathlib,sys,time\n"
                "marker=pathlib.Path(sys.argv[1])\n"
                "deadline=time.monotonic()+10\n"
                "while not marker.exists() and time.monotonic()<deadline:\n"
                "    time.sleep(0.02)\n"
            )
            holder = subprocess.Popen(
                [sys.executable, "-c", holder_script, str(workspace / "release-stdout-holder")],
                stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=subprocess.DEVNULL,
            )
            (workspace / "stdout-holder-pid").write_text(str(holder.pid))
        thread_id = "T" if scenario == "permission-identity" else "local-thread"
        send({"id": request_id, "result": {"thread": {"id": thread_id}}})
        if scenario == "exit-parent-stdout-open":
            (workspace / "parent-ready-to-exit").write_text("ready")
            while not (workspace / "release-parent-exit").exists():
                time.sleep(0.01)
            sys.exit(0)
    elif method == "thread/resume" and request_id is not None:
        thread_id = message.get("params", {}).get("threadId")
        (workspace / "resume-requested-thread").write_text(str(thread_id))
        if scenario == "resume-error":
            send({"id": request_id, "error": {"code": -32000, "message": "fixture refused resume"}})
        elif scenario == "resume-missing-id":
            send({"id": request_id, "result": {"thread": {}}})
        elif scenario == "resume-wrong-id":
            send({"id": request_id, "result": {"thread": {"id": "other-thread"}}})
        else:
            send({"id": request_id, "result": {"thread": {"id": "local-thread"}}})
    elif method == "turn/start" and request_id is not None:
        turns += 1
        (workspace / "turn-count").write_text(str(turns))
        with (workspace / "turn-starts").open("a") as starts:
            starts.write(f"{os.getpid()}\n")
        turn_id = "U" if scenario == "permission-identity" else f"local-turn-{turns}"
        send({"id": request_id, "result": {"turn": {"id": turn_id}}})
        started_thread = "T" if scenario == "permission-identity" else "local-thread"
        send({"method": "turn/started", "params": {"threadId": started_thread, "turnId": turn_id}})
        if scenario == "stall-turn" or scenario.startswith("stop-cache-"):
            continue
        elif scenario == "permission-deny":
            pending_permission_turn = turn_id
            send({"id": "local-approval", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "command": "echo fixture"}})
        elif scenario == "permission-drain":
            pending_permission_turn = turn_id
            send({"id": "local-approval", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "command": "echo fixture"}})
            send({"method": "item/agentMessage/delta", "params": {"threadId": "local-thread", "turnId": turn_id, "delta": "drained-while-pending"}})
        elif scenario == "permission-stop":
            pending_permission_turn = turn_id
            send({"id": "local-approval", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "command": "echo fixture"}})
        elif scenario == "permission-after-terminal":
            send({"method": "turn/completed", "params": {"threadId": "local-thread", "turn": {"id": turn_id, "status": "completed"}}})
            (workspace / "terminal-visible").write_text("ready")
            while not (workspace / "release-late-approval").exists():
                time.sleep(0.01)
            pending_permission_turn = turn_id
            send({"id": "local-approval", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "command": "echo fixture"}})
        elif scenario == "permission-drop":
            pending_permission_turn = turn_id
            send({"id": "rpc-A", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "itemId": "rpc-A", "command": "echo fixture"}})
        elif scenario == "permission-eof":
            send({"id": "local-approval", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "command": "echo fixture"}})
            sys.stdout.flush()
            os.close(1)
            raise SystemExit(0)
        elif scenario == "permission-terminal-error":
            pending_permission_turn = turn_id
            send({"id": "rpc-A", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "itemId": "rpc-A", "command": "echo fixture"}})
            while not (workspace / "release-terminal-error").exists():
                time.sleep(0.01)
            send({"method": "error", "params": {"threadId": "local-thread", "turnId": turn_id, "willRetry": False, "error": {"message": "failed"}}})
            time.sleep(0.05)
            (workspace / "error-visible").write_text("ready")
        elif scenario == "permission-reader-oversize":
            pending_permission_turn = turn_id
            send({"id": "rpc-A", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "itemId": "rpc-A", "command": "echo fixture"}})
            while not (workspace / "release-oversize").exists():
                time.sleep(0.01)
            sys.stdout.buffer.write(b"x" * (16 * 1024 * 1024 + 1) + b"\n")
            sys.stdout.flush()
            time.sleep(0.05)
            (workspace / "oversize-visible").write_text("ready")
        elif scenario == "permission-identity":
            pending_permission_turn = turn_id
            send({"id": "rpc-A", "method": "item/commandExecution/requestApproval", "params": {"threadId": "T", "turnId": turn_id, "itemId": "I", "requestId": "other", "command": "echo fixture"}})
        elif scenario in ("permission-two", "permission-two-stop"):
            pending_permission_turn = turn_id
            pending_callbacks = ["rpc-A", "rpc-B"]
            for callback_id in pending_callbacks:
                send({"id": callback_id, "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "itemId": callback_id, "command": "echo fixture"}})
        elif scenario == "permission-batch":
            pending_permission_turn = turn_id
            send({"id": "rpc-A", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "itemId": "rpc-A", "command": "echo fixture"}})
            send({"method": "turn/completed", "params": {"threadId": "local-thread", "turn": {"id": turn_id, "status": "completed"}}})
            send({"id": "rpc-B", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "itemId": "rpc-B", "command": "echo fixture"}})
        elif scenario == "permission-reuse":
            pending_permission_turn = turn_id
            send({"id": "rpc-A", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "itemId": "rpc-A", "command": "echo fixture"}})
        elif turns == 1 and scenario != "complete-first":
            error = {"message": "fixture limit reached", "codexErrorInfo": "usageLimitExceeded"}
            send({"method": "error", "params": {"threadId": "local-thread", "turnId": turn_id, "error": error, "willRetry": True}})
            send({"method": "turn/completed", "params": {"threadId": "local-thread", "turn": {"id": turn_id, "status": "failed", "error": error}}})
        else:
            send({"method": "item/agentMessage/delta", "params": {"threadId": "local-thread", "turnId": turn_id, "delta": "I will inspect the code."}})
            send({"method": "item/commandExecution/started", "params": {"threadId": "local-thread", "turnId": turn_id, "item": {"type": "commandExecution"}}})
            send({"method": "item/agentMessage/completed", "params": {"threadId": "local-thread", "turnId": turn_id, "item": {"type": "agentMessage", "text": "local peer completed"}}})
            send({"method": "turn/completed", "params": {"threadId": "local-thread", "turn": {"id": turn_id, "status": "completed"}}})
    elif method == "turn/interrupt" and scenario in ("permission-stop", "permission-two-stop") and request_id is not None:
        send({"id": request_id, "result": {}})
        if pending_permission_turn:
            send({"method": "turn/completed", "params": {"threadId": "local-thread", "turn": {"id": pending_permission_turn, "status": "interrupted"}}})
            pending_permission_turn = None
    elif method == "turn/interrupt" and request_id is not None:
        if scenario.startswith("stop-cache-"):
            counter = workspace / "interrupt-count"
            counter.write_text(str(int(counter.read_text()) + 1 if counter.exists() else 1))
        send({"id": request_id, "result": {}})
        if scenario.startswith("stop-cache-") and turns == 1:
            # A valid completion wins the race with Stop. Core may continue
            # this same session after its ordinary review checkpoint.
            send({"method": "turn/completed", "params": {"threadId": "local-thread", "turn": {"id": "local-turn-1", "status": "completed"}}})
            if scenario != "stop-cache-success":
                os.close(0 if scenario == "stop-cache-unknown" else 1)
                (workspace / "pipe-closed").write_text("ready")
                deadline = time.monotonic() + 10
                while not (workspace / "release-stop-peer").exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                sys.exit(0)
    elif method is None and request_id is not None and scenario == "permission-two" and pending_permission_turn:
        decision = (message.get("result") or {}).get("decision", "unknown")
        record = workspace / "permission-decision"
        previous = record.read_text() if record.exists() else ""
        record.write_text(previous + f"{request_id} {decision}\n")
        if request_id in pending_callbacks:
            pending_callbacks.remove(request_id)
        if pending_callbacks:
            continue
        send({"method": "item/agentMessage/completed", "params": {"threadId": "local-thread", "turnId": pending_permission_turn, "item": {"type": "agentMessage", "text": "Permission decision received"}}})
        send({"method": "turn/completed", "params": {"threadId": "local-thread", "turn": {"id": pending_permission_turn, "status": "completed"}}})
        pending_permission_turn = None
    elif method is None and request_id is not None and scenario == "permission-batch" and pending_permission_turn:
        decision = (message.get("result") or {}).get("decision", "unknown")
        record = workspace / "permission-decision"
        previous = record.read_text() if record.exists() else ""
        record.write_text(previous + f"{request_id} {decision}\n")
    elif method is None and request_id is not None and pending_permission_turn:
        decision = (message.get("result") or {}).get("decision", "unknown")
        record = workspace / "permission-decision"
        if request_id == "local-approval":
            record.write_text(decision)
        else:
            previous = record.read_text() if record.exists() else ""
            record.write_text(previous + f"{request_id} {decision}\n")
        answered_thread = "T" if scenario == "permission-identity" else "local-thread"
        send({"method": "item/agentMessage/completed", "params": {"threadId": answered_thread, "turnId": pending_permission_turn, "item": {"type": "agentMessage", "text": "Permission decision received"}}})
        send({"method": "turn/completed", "params": {"threadId": answered_thread, "turn": {"id": pending_permission_turn, "status": "completed"}}})
        pending_permission_turn = None

if scenario == "permission-drop":
    time.sleep(30)
