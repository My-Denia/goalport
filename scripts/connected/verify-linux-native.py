#!/usr/bin/env python3
"""Opt-in native Codex acceptance in a disposable, narrowly scoped repository.

Uses the existing CLI login and normal GoalPort commands. Does not approve
permissions automatically. While it waits, use unix-client.py decision to answer
the printed request after inspecting it. No fixture can stand in for a native run.
"""
import argparse
import difflib
from datetime import datetime, timezone
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("unix_client", Path(__file__).with_name("unix-client.py"))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
ROOT = Path(__file__).resolve().parents[2]


def group_members(group_id):
    """Live members of the session created by this verifier's start_new_session."""
    members = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            stat = (entry / "stat").read_text()
            fields = stat[stat.rfind(")") + 2:].split()
            if int(fields[2]) == group_id and int(fields[3]) == group_id and fields[0] not in {"Z", "X"}:
                members.append((int(entry.name), fields[19]))
        except (OSError, ValueError, IndexError):
            continue
    return members


def stop_owned_group(group_id, timeout=5):
    # Membership is anchored to the dedicated session, not executable names or
    # a global process search. Recheck the observed members before signalling.
    initial = set(group_members(group_id))
    if not initial:
        return {"terminated": True, "escalated": False, "remainingLivePids": []}
    if not initial.intersection(group_members(group_id)):
        return {"terminated": True, "escalated": False, "remainingLivePids": []}
    try:
        os.killpg(group_id, signal.SIGTERM)
    except ProcessLookupError:
        return {"terminated": True, "escalated": False, "remainingLivePids": []}
    deadline = time.monotonic() + timeout
    remaining = group_members(group_id)
    while remaining and time.monotonic() < deadline:
        time.sleep(0.05)
        remaining = group_members(group_id)
    escalated = bool(remaining)
    if remaining:
        # At least one original (pid,start-time) must still own the session.
        # A recycled group identifier is not authority to kill another task.
        if not initial.intersection(remaining):
            return {"terminated": False, "escalated": False,
                    "remainingLivePids": [pid for pid, _ in remaining], "reason": "session ownership changed"}
        try:
            os.killpg(group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + timeout
        while group_members(group_id) and time.monotonic() < deadline:
            time.sleep(0.05)
        remaining = group_members(group_id)
    return {"terminated": not remaining, "escalated": escalated,
            "remainingLivePids": [pid for pid, _ in remaining]}


def recheck(out):
    """Re-evaluate retained native evidence after an assertion-only correction.

    This never invokes a provider or changes the original run report.
    """
    report = json.loads((out / "result.json").read_text())
    starts, sends, last_response = [], [], None
    with (out / "exchanges.jsonl").open() as handle:
        for line in handle:
            entry = json.loads(line)
            if entry["command"] == "start_conversation":
                starts.append(entry)
            if entry["command"] == "conversation_send":
                sends.append(entry)
            last_response = entry.get("response", last_response)
    assert len(starts) == 1 and len(sends) == 1, "expected exactly one native first send and one second send"
    assert starts[0]["response"]["ok"] and sends[0]["response"]["ok"], "native command refused"
    snapshot = client.snapshot_from(last_response)
    conversation = snapshot["productConversation"]
    replies = "".join(item["body"] for item in conversation["items"] if item["kind"] == "assistant-message")
    assert report["native"] and report["runtime"] == "codex", "not a native run"
    assert conversation["runtime"]["provider"] == "codex", "wrong Runtime"
    assert report["launcherExit"] == 0 and report["testExit"] == 0, "launcher or original tests failed"
    assert (out / "arithmetic-before.py").read_text() != (out / "arithmetic-after.py").read_text(), "no code change"
    assert "GOALPORT_SECOND_TURN_OK" in replies, "no second-turn response"
    assert conversation["turn"]["canSend"], "conversation cannot continue"
    result = {"pass": True, "native": True, "source": "retained native exchanges and test outputs",
              "originalRunPass": report.get("pass"), "correction": "join streaming assistant fragments before matching second-turn marker",
              "launcherExit": report["launcherExit"], "testExit": report["testExit"],
              "finalTurn": conversation["turn"], "campaignId": snapshot["activeCampaignId"]}
    (out / "acceptance-recheck.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--out", type=Path)
    destination.add_argument("--recheck", type=Path, help="validate retained native evidence without another Runtime call")
    parser.add_argument("--allow-live", action="store_true", help="explicitly run the installed Codex using its existing login")
    parser.add_argument("--resume-check", action="store_true", help="also restart Core after a settled turn, resume the saved session, and send one read-only follow-up")
    parser.add_argument("--timeout", type=float, default=240, help="deadline for each native turn")
    parser.add_argument("--core", type=Path, default=ROOT / "target/debug/goalport-core")
    parser.add_argument("--launcher", type=Path, default=ROOT / "target/debug/goalport-core-launcher")
    args = parser.parse_args()
    if args.recheck:
        return recheck(args.recheck.resolve())
    if not args.allow_live:
        parser.error("native acceptance needs --allow-live; it consumes the configured Runtime's normal allowance")
    out = args.out.resolve()
    if out.exists():
        parser.error("output directory already exists; choose a fresh run to retain prior evidence")
    if not math.isfinite(args.timeout) or args.timeout <= 0 or not args.core.is_file() or not args.launcher.is_file():
        parser.error("positive timeout and built Core/launcher binaries required")
    out.mkdir(parents=True)
    run_id = uuid.uuid4().hex[:12]
    scratch = Path(tempfile.mkdtemp(prefix=f"goalport-native-{run_id}-"))
    # Keep the endpoint short even when the evidence directory is deeply nested.
    endpoint = str(scratch / "core.sock")
    launcher = None
    log = None
    events = None
    report = {"native": True, "runtime": "codex", "pass": False, "runId": run_id,
              "endpoint": endpoint, "scratchKeptForInspection": str(scratch)}
    try:
        workspace = scratch / "workspace"
        workspace.mkdir()
        original = "def add(left, right):\n    return left - right\n"
        test = """import json
import os
from pathlib import Path
import unittest
from arithmetic import add

def record_pass(name):
    with Path('test-runs.jsonl').open('a') as output:
        output.write(json.dumps({'test': name, 'pid': os.getpid()}) + '\\n')

class AdditionTests(unittest.TestCase):
    def test_positive(self): self.assertEqual(add(2, 3), 5); record_pass('positive')
    def test_negative(self): self.assertEqual(add(-2, 5), 3); record_pass('negative')
    def test_zero(self): self.assertEqual(add(4, 0), 4); record_pass('zero')

if __name__ == '__main__': unittest.main()
"""
        compile(test, "test_arithmetic.py", "exec")
        (workspace / "arithmetic.py").write_text(original)
        (workspace / "test_arithmetic.py").write_text(test)
        (workspace / "AGENTS.md").write_text(
            "This is a disposable GoalPort acceptance repository. Only read these fixture files, "
            "edit arithmetic.py and run python3 -m unittest -v. Do not modify tests or configuration, "
            "access unrelated files, use the network, commit, or delegate to other agents.\n")
        # A real repository boundary prevents parent project instructions from
        # accidentally turning this tiny fixture into unrelated project work.
        subprocess.run(["git", "init", "--initial-branch=main", str(workspace)], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        before = subprocess.run([sys.executable, "-B", "-m", "unittest", "-v"], cwd=workspace,
                                capture_output=True, text=True)
        (out / "tests-before.txt").write_text(before.stdout + before.stderr)
        if before.returncode != 1 or "Ran 3 tests" not in before.stderr or "FAILED (failures=2)" not in before.stderr:
            raise RuntimeError("fixture must run all 3 tests and fail the two addition cases before the native task")
        baseline_test_runs = len((workspace / "test-runs.jsonl").read_text().splitlines())
        env = dict(os.environ, GOALPORT_LAUNCH_NONCE=run_id, GOALPORT_RUN_SLUG=f"native-{run_id}",
                   GOALPORT_LAUNCH_REQUESTED_AT=datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
        # Never inherit a test-only synthetic selector from the calling shell.
        if env.get("GOALPORT_TEST_SYNTHETIC_ONLY") == "1":
            raise RuntimeError("native verification refuses a synthetic-only environment")
        log = (out / "launcher.txt").open("w")
        launcher = subprocess.Popen([str(args.launcher.resolve()), str(args.core.resolve()),
                                     "serve", "--pipe", endpoint, "--db", str(scratch / "core.sqlite")],
                                    env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        report = {"native": True, "runtime": "codex", "workspace": str(workspace),
                  "endpoint": endpoint, "pass": False, "runId": run_id}
        events = (out / "exchanges.jsonl").open("w")
    except Exception as error:
        report["error"] = str(error)
        if launcher is not None:
            report["cleanup"] = stop_owned_group(launcher.pid)
            launcher.poll()
        for handle in (events, log):
            if handle is not None:
                handle.close()
        (out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({"pass": False, "error": str(error), "evidence": str(out)}), flush=True)
        return 1
    previous_snapshot_payload = None

    def exchange(kind, payload=None, timeout=30):
        nonlocal previous_snapshot_payload
        start = time.monotonic()
        response = client.call(endpoint, kind, payload, timeout=timeout)
        row = {"command": kind, "elapsedMs": round((time.monotonic() - start) * 1000, 2)}
        if kind == "snapshot" and response["ok"] and response.get("payload") == previous_snapshot_payload:
            row["sameAsPreviousSnapshot"] = True
        else:
            row["response"] = response
            if kind == "snapshot":
                previous_snapshot_payload = response.get("payload")
        events.write(json.dumps(row, ensure_ascii=False) + "\n")
        events.flush()
        if not response["ok"]:
            raise RuntimeError(response.get("error", "Core refused the command"))
        return response

    def wait_turn(label, user_count, marker=None):
        deadline = time.monotonic() + args.timeout
        printed = set()
        while time.monotonic() < deadline:
            response = exchange("snapshot", timeout=min(30, max(0.001, deadline - time.monotonic())))
            snapshot = client.snapshot_from(response)
            diagnostic = client.diagnostics(response)
            (out / f"{label}-diagnostics.json").write_text(json.dumps(diagnostic, ensure_ascii=False, indent=2))
            for decision in diagnostic.get("pendingDecisions", []):
                if decision["id"] not in printed:
                    print(json.dumps({"permissionRequired": decision, "endpoint": endpoint}, ensure_ascii=False), flush=True)
                    printed.add(decision["id"])
            conversation = snapshot.get("productConversation") or {}
            items = conversation.get("items", [])
            replies = [item.get("body", "") for item in items if item.get("kind") == "assistant-message"]
            submitted = [item for item in items if item.get("kind") == "user-message"]
            turn = conversation.get("turn") or {}
            errors = [item for item in items if item.get("kind") == "actionable-error"]
            if turn.get("state") in {"failed", "uncertain"}:
                raise RuntimeError(json.dumps({"turn": turn, "errors": errors}, ensure_ascii=False))
            if len(submitted) >= user_count and turn.get("canSend") and replies:
                if marker is None or marker in "".join(replies):
                    return snapshot
            time.sleep(0.2)
        raise TimeoutError(f"{label} did not complete; inspect saved diagnostics and pending permissions")

    try:
        ready_deadline = time.monotonic() + 20
        while time.monotonic() < ready_deadline:
            if launcher.poll() not in (None, 0):
                raise RuntimeError(f"launcher failed with exit {launcher.returncode}")
            try:
                exchange("snapshot", timeout=1)
                break
            except client.ClientError as error:
                if error.delivery_state != "READ_FAILED":
                    raise
                time.sleep(0.1)
        else:
            raise TimeoutError("launcher did not provide a reachable Core")
        report["launcherExit"] = launcher.wait(timeout=20)
        if report["launcherExit"] != 0:
            raise RuntimeError("launcher READY verification failed")
        exchange("snapshot")  # Core survives the launcher exiting.
        print(json.dumps({"started": True, "endpoint": endpoint, "workspace": str(workspace)}), flush=True)
        prompt = ("Read arithmetic.py and test_arithmetic.py. Fix only arithmetic.py so addition is correct, "
                  "run python3 -m unittest -v, and report the result. Do not change tests or other files; "
                  "do not commit. This is an authorized scratch task.")
        initial = exchange("start_conversation", {"workspaceRoot": str(workspace), "provider": "codex", "message": prompt},
                           timeout=min(args.timeout, 120))
        initial_snapshot = client.snapshot_from(initial)
        campaign = initial_snapshot["activeCampaignId"]
        first = wait_turn("first-turn", 1)
        current = (workspace / "arithmetic.py").read_text()
        (out / "arithmetic-before.py").write_text(original)
        (out / "arithmetic-after.py").write_text(current)
        (out / "change.diff").write_text("".join(difflib.unified_diff(original.splitlines(True), current.splitlines(True),
                                                                          fromfile="a/arithmetic.py", tofile="b/arithmetic.py")))
        if current == original or (workspace / "test_arithmetic.py").read_text() != test:
            raise RuntimeError("native task did not fix the implementation without changing tests")
        # The fixture records only successful test bodies. Read this before
        # the verifier's own GREEN run to establish that the Runtime ran them.
        native_test_runs = [json.loads(line) for line in (workspace / "test-runs.jsonl").read_text().splitlines()[baseline_test_runs:]]
        if {entry["test"] for entry in native_test_runs} != {"positive", "negative", "zero"}:
            raise RuntimeError("Runtime did not execute all original tests successfully")
        (out / "native-test-runs.json").write_text(json.dumps(native_test_runs, indent=2))
        report["nativeTestsPassed"] = ["negative", "positive", "zero"]
        after = subprocess.run([sys.executable, "-B", "-m", "unittest", "-v"], cwd=workspace,
                               capture_output=True, text=True)
        (out / "tests-after.txt").write_text(after.stdout + after.stderr)
        report["testExit"] = after.returncode
        if after.returncode:
            raise RuntimeError("native implementation still fails the original tests")
        exchange("conversation_send", {"campaignId": campaign, "attemptId": first["attempt"]["id"],
                                       "message": "Without modifying any file, explain the function you changed and the test command/result from your previous turn. End with GOALPORT_SECOND_TURN_OK."})
        second = wait_turn("second-turn", 2, "GOALPORT_SECOND_TURN_OK")
        (out / "final-snapshot.json").write_text(json.dumps(second, ensure_ascii=False, indent=2))
        if args.resume_check:
            before_restart_runs = (workspace / "test-runs.jsonl").read_text()
            report["restartCleanup"] = stop_owned_group(launcher.pid)
            if not report["restartCleanup"]["terminated"]:
                raise RuntimeError("the prior owned Core group did not stop before restart")
            launcher.poll()
            restart_nonce = uuid.uuid4().hex[:12]
            report["restartNonce"] = restart_nonce
            env.update(GOALPORT_LAUNCH_NONCE=restart_nonce,
                       GOALPORT_LAUNCH_REQUESTED_AT=datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
            launcher = subprocess.Popen([str(args.launcher.resolve()), str(args.core.resolve()),
                                         "serve", "--pipe", endpoint, "--db", str(scratch / "core.sqlite")],
                                        env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            if launcher.wait(timeout=25) != 0:
                raise RuntimeError("restarted launcher did not confirm Core readiness")
            restored = client.snapshot_from(exchange("snapshot"))
            (out / "after-restart.json").write_text(json.dumps(restored, ensure_ascii=False, indent=2))
            if "resume-session" not in restored["productConversation"]["turn"].get("actions", []):
                raise RuntimeError("settled saved session has no actionable Resume after Core restart")
            resumed = client.snapshot_from(exchange("resume_native_session", {"attemptId": second["attempt"]["id"]}))
            if resumed["productConversation"]["session"]["state"] != "attached":
                raise RuntimeError("saved native session was not actually attached")
            if (workspace / "test-runs.jsonl").read_text() != before_restart_runs:
                raise RuntimeError("old task ran again during restart/resume without a new send")
            users = [item for item in resumed["productConversation"]["items"] if item["kind"] == "user-message"]
            if len(users) != 2:
                raise RuntimeError("restart/resume changed the recorded user-message count")
            exchange("conversation_send", {"campaignId": campaign, "attemptId": second["attempt"]["id"],
                                           "message": "Without using tools or changing files, recall the addition fix and the original test result from this conversation. End with GOALPORT_RESUME_OK."})
            second = wait_turn("resumed-turn", 3, "GOALPORT_RESUME_OK")
            (out / "resumed-snapshot.json").write_text(json.dumps(second, ensure_ascii=False, indent=2))
            report["resumedAfterCoreRestart"] = True
        refresh = exchange("snapshot_if_changed")
        full_bytes = len(json.dumps(refresh).encode())
        refresh_samples = []
        for _ in range(5):
            refresh = exchange("snapshot_if_changed", {"revision": refresh["payload"]["revision"]})
            refresh_samples.append({"unchanged": refresh["payload"]["unchanged"],
                                    "bytes": len(json.dumps(refresh).encode())})
        if not any(sample["unchanged"] for sample in refresh_samples):
            raise RuntimeError("stable native conversation never produced an unchanged refresh")
        report["refresh"] = {"fullBytes": full_bytes, "samples": refresh_samples}
        closed = client.snapshot_from(exchange("close_session", {"attemptId": second["attempt"]["id"]}))
        if closed["productConversation"]["session"]["state"] != "closed":
            raise RuntimeError("explicit close did not produce a closed Runtime session")
        report["closedSession"] = closed["productConversation"]["session"]
        report.update({"pass": True, "campaignId": campaign, "attemptId": second["attempt"]["id"],
                       "title": second["productConversation"]["title"],
                       "firstTurnState": first["productConversation"]["turn"],
                       "secondTurnState": second["productConversation"]["turn"]})
    except Exception as error:
        report["error"] = str(error)
        print(json.dumps({"pass": False, "error": str(error), "evidence": str(out)}, ensure_ascii=False), flush=True)
    finally:
        # All members of this process group were launched for this fixture. It
        # is never a user's existing Core or provider session.
        report["cleanup"] = stop_owned_group(launcher.pid)
        launcher.poll()
        if not report["cleanup"]["terminated"]:
            report.update({"pass": False, "error": "owned native processes did not stop; inspect cleanup evidence"})
        events.close()
        log.close()
        report["scratchKeptForInspection"] = str(scratch)
        (out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        core_log = scratch / "core.sqlite.core.log"
        if core_log.is_file():
            (out / "core.txt").write_bytes(core_log.read_bytes())
    print(json.dumps({"pass": report["pass"], "evidence": str(out), "cleanup": report["cleanup"]}), flush=True)
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
