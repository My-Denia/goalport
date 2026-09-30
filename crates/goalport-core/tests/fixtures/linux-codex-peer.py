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
        send({"id": request_id, "result": {"thread": {"id": "local-thread"}}})
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
        turn_id = f"local-turn-{turns}"
        send({"id": request_id, "result": {"turn": {"id": turn_id}}})
        send({"method": "turn/started", "params": {"threadId": "local-thread", "turnId": turn_id}})
        if scenario == "stall-turn":
            continue
        elif scenario == "permission-deny":
            pending_permission_turn = turn_id
            send({"id": "local-approval", "method": "item/commandExecution/requestApproval", "params": {"threadId": "local-thread", "turnId": turn_id, "command": "echo fixture"}})
        elif turns == 1 and scenario != "complete-first":
            error = {"message": "fixture limit reached", "codexErrorInfo": "usageLimitExceeded"}
            send({"method": "error", "params": {"threadId": "local-thread", "turnId": turn_id, "error": error, "willRetry": True}})
            send({"method": "turn/completed", "params": {"threadId": "local-thread", "turn": {"id": turn_id, "status": "failed", "error": error}}})
        else:
            send({"method": "item/agentMessage/delta", "params": {"threadId": "local-thread", "turnId": turn_id, "delta": "I will inspect the code."}})
            send({"method": "item/commandExecution/started", "params": {"threadId": "local-thread", "turnId": turn_id, "item": {"type": "commandExecution"}}})
            send({"method": "item/agentMessage/completed", "params": {"threadId": "local-thread", "turnId": turn_id, "item": {"type": "agentMessage", "text": "local peer completed"}}})
            send({"method": "turn/completed", "params": {"threadId": "local-thread", "turn": {"id": turn_id, "status": "completed"}}})
    elif method == "turn/interrupt" and request_id is not None:
        send({"id": request_id, "result": {}})
    elif method is None and request_id == "local-approval" and pending_permission_turn:
        decision = (message.get("result") or {}).get("decision", "unknown")
        (workspace / "permission-decision").write_text(decision)
        send({"method": "item/agentMessage/completed", "params": {"threadId": "local-thread", "turnId": pending_permission_turn, "item": {"type": "agentMessage", "text": "Permission decision received"}}})
        send({"method": "turn/completed", "params": {"threadId": "local-thread", "turn": {"id": pending_permission_turn, "status": "completed"}}})
        pending_permission_turn = None
