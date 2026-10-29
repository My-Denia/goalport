"""Wire-level checks for the thin Linux operator client; no vendor process."""
import contextlib
import http.client
from http.server import ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("unix_client", Path(__file__).with_name("unix-client.py"))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)

workbench_spec = importlib.util.spec_from_file_location(
    "linux_workbench", Path(__file__).with_name("linux-workbench.py")
)
workbench = importlib.util.module_from_spec(workbench_spec)
workbench_spec.loader.exec_module(workbench)


class CommandRoutingTests(unittest.TestCase):
    def test_first_live_goal_identity_survives_return_before_any_saved_result(self):
        with tempfile.TemporaryDirectory(prefix="gp-first-live-") as temp:
            root = Path(temp)
            job = root / "coordination-jobs" / "jobs" / "first-job"
            job.mkdir(parents=True)
            (root / "coordination-jobs" / "active-admission.json").write_text(json.dumps({"jobId": "first-job"}), encoding="utf-8")
            (job / "progress.json").write_text(json.dumps({"state": "running", "display": {"activity": "Codex is planning…"}}), encoding="utf-8")
            (job / "admission.json").write_text(json.dumps({"input": {"goal": "Append pong", "workspacePath": "/work", "priorPlan": "not a result"}}), encoding="utf-8")
            result = workbench.latest_coordination_record(root)
            self.assertIsNone(result["record"])
            self.assertEqual(result["currentGoal"], {"goal": "Append pong", "workspacePath": "/work"})
            self.assertNotIn("priorPlan", result["currentGoal"])

    def test_stopped_continue_retains_only_its_parent_workspace_result(self):
        with tempfile.TemporaryDirectory(prefix="gp-stop-retain-") as temp:
            root = Path(temp)
            job = root / "coordination-jobs" / "jobs" / "stop-job"
            job.mkdir(parents=True)
            parent = {"requestId": "parent", "workspacePath": "/work", "planText": "parent plan", "auditText": "parent audit", "executionEvidence": {"afterDiff": "+pong2"}, "savedAt": "2026-10-28T01:00:00Z"}
            stopped = {"requestId": "stop", "workspacePath": "/work", "goal": "Read-only follow-up", "verdict": "failed", "stopReason": "Access stopped; the current turn may finish, but no further turn was sent.", "savedAt": "2026-10-28T02:00:00Z"}
            (root / "coordination-jobs" / "active-admission.json").write_text(json.dumps({"jobId": "stop-job"}), encoding="utf-8")
            current = {"requestId": "stop", "workspacePath": "/work", "executionFeedback": {"previousPlan": "parent plan", "previousExecutionAudit": "parent audit"}}
            (job / "admission.json").write_text(json.dumps({"input": current}), encoding="utf-8")
            (job / "progress.json").write_text(json.dumps({"state": "stopped", "outcome": {"status": "stopped"}}), encoding="utf-8")
            (root / "coordination-records.json").write_text(json.dumps([stopped, parent]), encoding="utf-8")
            result = workbench.latest_coordination_record(root)["record"]
            self.assertEqual(result["requestId"], "stop")
            self.assertEqual(result["goal"], "Read-only follow-up")
            self.assertEqual(result["retainedFromRequestId"], "parent")
            self.assertEqual(result["executionEvidence"]["afterDiff"], "+pong2")
            (root / "coordination-jobs" / "active-admission.json").unlink()
            self.assertEqual(workbench.latest_coordination_record(root)["record"]["executionEvidence"]["afterDiff"], "+pong2")
            parent["workspacePath"] = "/other"
            (root / "coordination-records.json").write_text(json.dumps([stopped, parent]), encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["executionEvidence"])

    def test_remembered_intent_ordinary_completed_write_true_without_private_tokens(self):
        with tempfile.TemporaryDirectory(prefix="gp-intent-write-") as temp:
            root = Path(temp)
            job = root / "coordination-jobs" / "jobs" / "job-1"
            job.mkdir(parents=True)
            admission = {
                "input": {
                    "requestId": "req-completed",
                    "workspacePath": "/work/project",
                    "goal": "Implement feature",
                    "backgroundConsent": True,
                    "writeAuthorization": {
                        "instances": ["codex"],
                        "workspaceRoot": "/work/project",
                        "maxTurns": 2,
                    },
                    "privateControlToken": "SECRET_TOKEN_DO_NOT_LEAK",
                    "remainingTurns": 7,
                    "scopeGeneration": 4,
                }
            }
            (job / "admission.json").write_text(json.dumps(admission), encoding="utf-8")
            record = {
                "requestId": "req-completed",
                "workspacePath": "/work/project",
                "goal": "Implement feature",
                "verdict": "verified",
                "outcome": "Done",
                "savedAt": "2026-10-28T02:00:00Z",
            }
            (root / "coordination-records.json").write_text(json.dumps([record]), encoding="utf-8")
            res = workbench.latest_coordination_record(root)
            self.assertTrue(res["ok"])
            rec = res["record"]
            self.assertEqual(rec["rememberedIntent"], {"background": True, "write": True})
            record_dump = json.dumps(rec)
            self.assertNotIn("SECRET_TOKEN_DO_NOT_LEAK", record_dump)
            self.assertNotIn("remainingTurns", record_dump)
            self.assertNotIn("scopeGeneration", record_dump)
            self.assertNotIn("privateControlToken", record_dump)

    def test_remembered_intent_readonly_stop_child_with_writer_parent(self):
        with tempfile.TemporaryDirectory(prefix="gp-intent-readonly-") as temp:
            root = Path(temp)
            parent_job = root / "coordination-jobs" / "jobs" / "parent-job"
            parent_job.mkdir(parents=True)
            parent_adm = {
                "input": {
                    "requestId": "parent-req",
                    "workspacePath": "/work/project",
                    "backgroundConsent": True,
                    "writeAuthorization": {"instances": ["codex"], "workspaceRoot": "/work/project", "maxTurns": 2},
                }
            }
            (parent_job / "admission.json").write_text(json.dumps(parent_adm), encoding="utf-8")

            child_job = root / "coordination-jobs" / "jobs" / "child-job"
            child_job.mkdir(parents=True)
            child_adm = {
                "input": {
                    "requestId": "child-req",
                    "workspacePath": "/work/project",
                    "backgroundConsent": True,
                    "writeAuthorization": None,
                    "executionFeedback": {"previousPlan": "plan 1", "previousExecutionAudit": "audit 1"},
                }
            }
            (child_job / "admission.json").write_text(json.dumps(child_adm), encoding="utf-8")
            (child_job / "progress.json").write_text(json.dumps({"state": "stopped", "outcome": {"status": "stopped"}}), encoding="utf-8")

            parent_rec = {
                "requestId": "parent-req", "workspacePath": "/work/project",
                "planText": "plan 1", "auditText": "audit 1",
                "executionEvidence": {"afterDiff": "+write"}, "savedAt": "2026-10-28T01:00:00Z"
            }
            child_rec = {
                "requestId": "child-req", "workspacePath": "/work/project",
                "goal": "Readonly follow-up", "verdict": "stopped",
                "stopReason": "Access stopped; the current turn may finish, but no further turn was sent.",
                "savedAt": "2026-10-28T02:00:00Z"
            }
            (root / "coordination-records.json").write_text(json.dumps([child_rec, parent_rec]), encoding="utf-8")

            res = workbench.latest_coordination_record(root)
            rec = res["record"]
            self.assertEqual(rec["requestId"], "child-req")
            self.assertEqual(rec["retainedFromRequestId"], "parent-req")
            self.assertEqual(rec["executionEvidence"]["afterDiff"], "+write")
            # Child's own admission had writeAuthorization: None, so write must be False!
            self.assertEqual(rec["rememberedIntent"], {"background": True, "write": False})

    def test_remembered_intent_missing_duplicate_malformed_workspace_mismatch(self):
        with tempfile.TemporaryDirectory(prefix="gp-intent-safe-") as temp:
            root = Path(temp)
            # Case 1: missing admission
            record = {"requestId": "missing-req", "workspacePath": "/work/project", "verdict": "verified", "savedAt": "2026-10-28T01:00:00Z"}
            (root / "coordination-records.json").write_text(json.dumps([record]), encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["rememberedIntent"])

            # Case 2: workspace mismatch
            job = root / "coordination-jobs" / "jobs" / "job-mismatch"
            job.mkdir(parents=True)
            (job / "admission.json").write_text(json.dumps({
                "input": {"requestId": "missing-req", "workspacePath": "/different/workspace", "backgroundConsent": True}
            }), encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["rememberedIntent"])

            # Case 3: duplicate admissions
            job2 = root / "coordination-jobs" / "jobs" / "job-dup"
            job2.mkdir(parents=True)
            (job / "admission.json").write_text(json.dumps({
                "input": {"requestId": "missing-req", "workspacePath": "/work/project", "backgroundConsent": True}
            }), encoding="utf-8")
            (job2 / "admission.json").write_text(json.dumps({
                "input": {"requestId": "missing-req", "workspacePath": "/work/project", "backgroundConsent": True}
            }), encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["rememberedIntent"])

            # Case 4: malformed admission JSON
            __import__("shutil").rmtree(job2)
            (job / "admission.json").write_text("NOT_VALID_JSON{{{", encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["rememberedIntent"])

    def test_remembered_intent_unsupported_writer_and_malformed_write_auth(self):
        with tempfile.TemporaryDirectory(prefix="gp-intent-unsupported-") as temp:
            root = Path(temp)
            job = root / "coordination-jobs" / "jobs" / "job-writer"
            job.mkdir(parents=True)
            record = {"requestId": "req-writer", "workspacePath": "/work/project", "verdict": "verified", "savedAt": "2026-10-28T01:00:00Z"}
            (root / "coordination-records.json").write_text(json.dumps([record]), encoding="utf-8")

            # Unsupported writer: Pi only (read-only)
            (job / "admission.json").write_text(json.dumps({
                "input": {"requestId": "req-writer", "workspacePath": "/work/project", "backgroundConsent": True,
                          "writeAuthorization": {"instances": ["pi"], "workspaceRoot": "/work/project", "maxTurns": 2}}
            }), encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["rememberedIntent"])

            # Non-boolean background
            (job / "admission.json").write_text(json.dumps({
                "input": {"requestId": "req-writer", "workspacePath": "/work/project", "backgroundConsent": "true",
                          "writeAuthorization": {"instances": ["codex"], "workspaceRoot": "/work/project", "maxTurns": 2}}
            }), encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["rememberedIntent"])

            # Invalid maxTurns (string)
            (job / "admission.json").write_text(json.dumps({
                "input": {"requestId": "req-writer", "workspacePath": "/work/project", "backgroundConsent": True,
                          "writeAuthorization": {"instances": ["codex"], "workspaceRoot": "/work/project", "maxTurns": "2"}}
            }), encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["rememberedIntent"])

            # Invalid maxTurns (out of bounds > 8)
            (job / "admission.json").write_text(json.dumps({
                "input": {"requestId": "req-writer", "workspacePath": "/work/project", "backgroundConsent": True,
                          "writeAuthorization": {"instances": ["codex"], "workspaceRoot": "/work/project", "maxTurns": 99}}
            }), encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["rememberedIntent"])

            # Mismatched write root
            (job / "admission.json").write_text(json.dumps({
                "input": {"requestId": "req-writer", "workspacePath": "/work/project", "backgroundConsent": True,
                          "writeAuthorization": {"instances": ["codex"], "workspaceRoot": "/other/path", "maxTurns": 2}}
            }), encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["rememberedIntent"])

    def test_repeated_stopped_continues_keep_the_evidence_but_restore_only_the_current_choices(self):
        with tempfile.TemporaryDirectory(prefix="gp-return-chain-") as temp:
            root = Path(temp)
            base = {"requestId": "base", "workspacePath": "/work", "planText": "base plan", "auditText": "base audit", "executionEvidence": {"afterDiff": "+pong2"}, "savedAt": "2026-10-28T00:00:00Z"}
            middle = {"requestId": "middle", "workspacePath": "/work", "goal": "Stopped follow-up", "planText": "middle plan", "auditText": None, "verdict": "failed", "savedAt": "2026-10-28T01:00:00Z"}
            latest = {"requestId": "latest", "workspacePath": "/work", "goal": "Continue then Stop again", "verdict": "failed", "stopReason": "No further turn was sent.", "savedAt": "2026-10-28T02:00:00Z"}
            (root / "coordination-records.json").write_text(json.dumps([latest, middle, base]), encoding="utf-8")
            for name, parent in (("middle", base), ("latest", middle)):
                job = root / "coordination-jobs" / "jobs" / name
                job.mkdir(parents=True)
                admission = {"requestId": name, "workspacePath": "/work", "backgroundConsent": True, "writeAuthorization": None, "executionFeedback": {"previousPlan": parent["planText"], "previousExecutionAudit": parent["auditText"]}}
                (job / "admission.json").write_text(json.dumps({"input": admission}), encoding="utf-8")
                (job / "progress.json").write_text(json.dumps({"state": "stopped", "pendingCommand": None}), encoding="utf-8")
            projected = workbench.latest_coordination_record(root)["record"]
            self.assertEqual(projected["requestId"], "latest")
            self.assertEqual(projected["retainedFromRequestId"], "base")
            self.assertEqual(projected["executionEvidence"]["afterDiff"], "+pong2")
            self.assertEqual(projected["rememberedIntent"], {"background": True, "write": False})
            # A missing end of the chain must not borrow arbitrary evidence.
            base.pop("executionEvidence")
            (root / "coordination-records.json").write_text(json.dumps([latest, middle, base]), encoding="utf-8")
            self.assertIsNone(workbench.latest_coordination_record(root)["record"]["executionEvidence"])

    def test_independent_check_details_keep_the_actual_conclusion_beyond_the_summary(self):
        audit = "Evidence limitations\n" + "checked captured material\n" * 40 + "VERDICT: verified"
        self.assertEqual(workbench.check_detail({"auditText": audit}, None), audit)
        self.assertIn("truncated for display", workbench.check_detail({"auditText": "x" * 25000}, None))

    def test_overview_and_detail_do_not_select(self):
        overview = client.command_for(client.parser().parse_args(["overview"]))
        detail = client.command_for(client.parser().parse_args(["detail", "--campaign", "campaign-b"]))
        self.assertEqual(overview, ("goal_overview", {}))
        self.assertEqual(detail, ("goal_detail", {"campaignId": "campaign-b"}))

    def test_bridge_rejects_another_pages_post_and_keeps_static_files_inside_dist(self):
        import http.client
        import threading
        from http.server import ThreadingHTTPServer

        class FakeUnix:
            MAX_FRAME_BYTES = 1024 * 1024

            class ClientError(Exception):
                pass

            def __init__(self):
                self.calls = []

            def call(self, _endpoint, message_type, _payload=None, timeout=30, request_id=None):
                self.calls.append(message_type)
                return {"ok": True, "requestId": request_id, "entityVersion": 1,
                        "protocolVersion": "goalport.ipc.v2", "payload": {}}

        dist = Path(tempfile.mkdtemp(prefix="gp-bridge-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(dist, ignore_errors=True))
        (dist / "index.html").write_text("<head><title>GoalPort</title></head>", encoding="utf-8")
        (dist / "app.js").write_text("console.log('goalport')", encoding="utf-8")
        outside = dist.parent / f"{dist.name}-secret.txt"
        outside.write_text("secret", encoding="utf-8")
        self.addCleanup(outside.unlink)
        fake = FakeUnix()
        handler = workbench.make_handler("/tmp/core.sock", dist, fake, 5)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def exchange(method, path, body=None, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            payload = response.read()
            status = response.status
            header_text = str(response.headers)
            connection.close()
            return status, payload, header_text

        host = {"Host": f"127.0.0.1:{port}"}
        status, page, _headers = exchange("GET", "/", headers=host)
        self.assertEqual(status, 200)
        self.assertIn(b"__GOALPORT_LINUX_CORE__", page)
        status, goal_page, _headers = exchange("GET", "/goals/campaign-b", headers=host)
        self.assertEqual(status, 200)
        self.assertIn(b"__GOALPORT_LINUX_CORE__", goal_page)
        rewritten = workbench.inject_linux_flag('<head><script src="./assets/app.js"></script>')
        self.assertIn('src="/assets/app.js"', rewritten)
        self.assertNotIn('src="./assets/app.js"', rewritten)
        status, script, _headers = exchange("GET", "/app.js", headers=host)
        self.assertEqual(status, 200)
        self.assertEqual(script, b"console.log('goalport')")
        self.assertIsNone(workbench.safe_file(dist, "/../secret.txt"))
        self.assertIsNone(workbench.safe_file(dist, "/%2e%2e/secret.txt"))
        status, _escaped, _headers = exchange("GET", "/../secret.txt", headers=host)
        self.assertEqual(status, 404)

        body = json.dumps({"messageType": "goal_overview", "payload": {}}).encode()
        status, allowed, allowed_headers = exchange("POST", "/goalport/ipc", body=body, headers={
            **host, "Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}",
        })
        self.assertEqual(status, 200, allowed)
        self.assertNotIn("Access-Control-Allow-Origin", allowed_headers)
        self.assertEqual(fake.calls, ["goal_overview"])
        status, cross, cross_headers = exchange("POST", "/goalport/ipc", body=body, headers={
            **host, "Content-Type": "text/plain", "Origin": "http://evil.example",
        })
        self.assertEqual(status, 403, cross)
        self.assertNotIn("Access-Control-Allow-Origin", cross_headers)
        self.assertEqual(fake.calls, ["goal_overview"])
        status, rebound, _headers = exchange("POST", "/goalport/ipc", body=body, headers={
            "Host": f"evil.example:{port}", "Content-Type": "application/json",
        })
        self.assertEqual(status, 403, rebound)

    def test_latest_coordination_record_is_the_saved_verdict_without_a_plan_body(self):
        directory = Path(tempfile.mkdtemp(prefix="gp-coord-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        (directory / "coordination-records.json").write_text(json.dumps([
            {"requestId": "old", "verdict": "revise", "planText": "secret plan"},
            {
                "requestId": "coordinate-verified",
                "verdict": "verified",
                "stopReason": "The independent harness verified the changes, so this stopped.",
                "result": "note.txt now has before and pong.",
                "reviewText": "Pi checked the file and found only that added line.",
                "auditText": "Pi verified the added line and no other file changed.",
                "executionText": "Codex added pong under before.",
                "planningHarness": "Codex",
                "reviewHarness": "Pi",
                "messageDispatched": True,
                "goal": "Add pong",
                "workspacePath": "/work/pong",
                "planText": "do not send this body",
                "auditInputEvidenceText": "exact audit evidence subset",
            },
        ]), encoding="utf-8")
        missing = workbench.latest_coordination_record(None)
        self.assertIsNone(missing["record"])
        self.assertEqual(missing["reason"], "no coordination profile configured")
        found = workbench.latest_coordination_record(directory)
        self.assertEqual(found["record"]["verdict"], "verified")
        self.assertEqual(found["record"]["planningHarness"], "Codex")
        self.assertEqual(found["record"]["reviewHarness"], "Pi")
        self.assertNotIn("planText", found["record"])
        self.assertEqual(found["record"]["outcome"], "note.txt now has before and pong.")
        self.assertEqual(found["record"]["statusLabel"], "Changes verified")
        self.assertEqual(next(item for item in found["roots"] if item["requestId"] == found["record"]["requestId"])["statusLabel"], "Changes verified")
        self.assertEqual(found["record"]["detail"], "Pi verified the added line and no other file changed.")
        self.assertEqual(found["record"]["change"], "Codex added pong under before.")
        self.assertEqual(found["record"]["auditInputEvidenceText"], "exact audit evidence subset")
        self.assertNotIn("planText", found["record"])
        stopped_dir = directory / "stopped-newest"
        stopped_dir.mkdir()
        (stopped_dir / "coordination-records.json").write_text(json.dumps([
            {
                "requestId": "coordinate-stopped",
                "verdict": "failed",
                "savedAt": "2026-10-25T08:21:43.982Z",
                "stopReason": "Access stopped; the current turn may finish, but no further turn was sent.",
                "goal": "Name files",
            },
            {
                "requestId": "coordinate-verified",
                "verdict": "verified",
                "savedAt": "2026-10-25T07:37:53.926Z",
                "stopReason": "older",
                "goal": "Add pong",
            },
        ]), encoding="utf-8")
        stopped = workbench.latest_coordination_record(stopped_dir)
        self.assertEqual(stopped["record"]["requestId"], "coordinate-stopped")
        self.assertEqual(stopped["record"]["outcome"], "Access stopped; the current turn may finish, but no further turn was sent.")
        self.assertEqual(workbench.subscription_harnesses("provider codex: authenticated (chatgpt)\nprovider pi: authenticated (subscription)\n"), ["codex", "pi"])
        blocked = "provider codex: authenticated (chatgpt)\nprovider pi: authenticated (subscription)\n  environment blocked since 2026-10-23T00:00:00Z: sandbox missing\n"
        self.assertEqual(workbench.subscription_harnesses(blocked), ["codex"])
        self.assertIn("nothing will be sent", workbench.subscription_harness_sentence(blocked))
        self.assertIsNone(workbench.subscription_harness_sentence("provider codex: authenticated (chatgpt)\nprovider pi: authenticated (subscription)\n"))
        self.assertIsNone(workbench.subscription_harness_sentence("provider codex: authenticated (subscription)\nprovider pi: authenticated (subscription)\n"))
        one = workbench.subscription_harness_sentence("provider codex: authenticated (subscription)\n")
        self.assertIn("nothing will be sent", one)
        self.assertNotIn("Stopped", one)
        none = workbench.subscription_harness_sentence("provider pi: authenticated (unknown)\n")
        self.assertIn("nothing will be sent", none)
        self.assertNotIn("Stopped", none)
        self.assertTrue(workbench.consent_missing("consent: not granted\n"))
        self.assertFalse(workbench.consent_missing("consent: granted (2026-10-23T17:15:59.514Z)\n"))
        grant_argv, grant_error = workbench.coordination_grant_command(directory, Path("/repo"), "/tmp/core.sock", "/usr/bin/goalport-core")
        self.assertIsNone(grant_error)
        self.assertEqual(grant_argv[-1], "grant-access")
        job = "31f7caad-52d2-4219-9935-bffeea962876"
        jobs = directory / "coordination-jobs" / "jobs" / job
        jobs.mkdir(parents=True)
        (directory / "coordination-jobs" / "active-admission.json").write_text(json.dumps({"jobId": job, "requestId": "live"}), encoding="utf-8")
        (jobs / "progress.json").write_text(json.dumps({"state": "running", "pendingCommand": {"commandId": "plan"}, "display": {"activity": "Codex is planning…"}}), encoding="utf-8")
        leave_argv, leave_error = workbench.coordination_acknowledge_command(directory, Path("/repo"), "/tmp/core.sock", "/usr/bin/goalport-core")
        self.assertIsNone(leave_error)
        self.assertEqual(leave_argv[-2:], ["--job", job])
        live = workbench.latest_coordination_record(directory)
        admitted_dir = directory / "admitted"
        (admitted_dir / "coordination-jobs").mkdir(parents=True)
        (admitted_dir / "coordination-jobs" / "active-admission.json").write_text(json.dumps({"jobId": job, "requestId": "live"}), encoding="utf-8")
        admitted = workbench.latest_coordination_record(admitted_dir)
        self.assertEqual(admitted["line"], "The goal was admitted.")
        self.assertEqual(admitted["jobId"], job)
        gone_dir = directory / "gone"
        (gone_dir / "coordination-jobs" / "jobs" / job).mkdir(parents=True)
        (gone_dir / "coordination-jobs" / "active-admission.json").write_text(json.dumps({"jobId": job}), encoding="utf-8")
        (gone_dir / "coordination-jobs" / "jobs" / job / "startup-claim.json").write_text(json.dumps({"pid": 99}), encoding="utf-8")
        previous_alive = workbench.worker_alive
        workbench.worker_alive = lambda _pid: False
        try:
            gone = workbench.current_job(gone_dir)
        finally:
            workbench.worker_alive = previous_alive
        self.assertEqual(gone["line"], "The worker is gone. Its exit is not confirmed, so another goal cannot start yet.")
        left_dir = directory / "left"
        left_job = left_dir / "coordination-jobs" / "jobs" / job
        left_job.mkdir(parents=True)
        (left_job / "stuck-ack.json").write_text("{}", encoding="utf-8")
        (left_job / "admission.json").write_text(json.dumps({"input": {"requestId": "coordinate-left"}}), encoding="utf-8")
        self.assertEqual(workbench.latest_coordination_record(left_dir)["leftRequestIds"], ["coordinate-left"])
        (left_dir / "coordination-records.json").write_text("{", encoding="utf-8")
        self.assertEqual(workbench.latest_coordination_record(left_dir)["leftRequestIds"], ["coordinate-left"])
        (left_dir / "coordination-jobs" / "active-admission.json").write_text(json.dumps({"jobId": job}), encoding="utf-8")
        self.assertIsNone(workbench.current_job(left_dir))
        (left_job / "progress.json").write_text(json.dumps({"state": "unconfirmed"}), encoding="utf-8")
        self.assertTrue(workbench.latest_coordination_record(left_dir)["unconfirmedGoal"])
        (left_job / "progress.json").write_text(json.dumps({"state": "running", "pendingCommand": {"state": "unconfirmed"}}), encoding="utf-8")
        self.assertFalse(workbench.latest_coordination_record(left_dir)["unconfirmedGoal"])
        other = left_dir / "coordination-jobs" / "jobs" / "other-job"
        other.mkdir()
        (other / "progress.json").write_text(json.dumps({"state": "unconfirmed"}), encoding="utf-8")
        self.assertFalse(workbench.latest_coordination_record(left_dir)["unconfirmedGoal"])
        (left_job / "progress.json").write_text(json.dumps({"state": "unconfirmed"}), encoding="utf-8")
        (left_dir / "coordination-records.json").write_text(json.dumps([{"requestId": "coordinate-other", "verdict": "verified", "goal": "Other"}]), encoding="utf-8")
        self.assertTrue(workbench.latest_coordination_record(left_dir)["unconfirmedGoal"])
        self.assertEqual(workbench.leftover_left_job(left_dir), job)
        self.assertTrue(workbench.latest_coordination_record(left_dir)["leftoverHeld"])
        (left_dir / "coordination-records.json").write_text(json.dumps([{"requestId": "coordinate-left", "goal": "Left"}]), encoding="utf-8")
        continued, continue_error = workbench.coordination_continue_command(left_dir, Path("/tmp"), endpoint="/tmp/core.sock", core_binary="/tmp/goalport-core", background=True, from_request_id="coordinate-left")
        self.assertIsNone(continued)
        self.assertEqual(continue_error, "The interrupted job stays unreplayed; the same request id cannot be admitted again.")
        argv, error = workbench.coordination_acknowledge_command(left_dir, Path("/tmp"), "/tmp/core.sock", "/tmp/goalport-core")
        self.assertIsNone(error)
        self.assertIn(job, argv or [])
        self.assertEqual(live["line"], "Codex is planning…")
        self.assertEqual(workbench.activity_line({"state": "running", "display": {"activity": "Codex is planning…"}}, 99, lambda _pid: False), "The worker is gone. Its exit is not confirmed, so another goal cannot start yet.")
        self.assertEqual(workbench.activity_line({"state": "running", "display": {"activity": "Codex is planning…"}}, 99, lambda _pid: True), "Codex is planning…")
        self.assertEqual(workbench.activity_line({"state": "unconfirmed", "display": {"activity": "Codex is planning…"}}, 99, lambda _pid: True), "This goal's exit is not confirmed, so another goal cannot start yet.")
        self.assertEqual(workbench.activity_line({"state": "running", "pendingCommand": {"commandId": "cmd-1"}}, 99, lambda _pid: True, is_revoked=True), "Access stopped; the current turn may finish, but no further turn was sent.")
        self.assertEqual(workbench.activity_line({"state": "stopped", "outcome": {"status": "stopped"}}, 99, lambda _pid: True, is_revoked=True), "Stopped. No further turn was sent. Existing workspace edits remain.")
        self.assertEqual(workbench.activity_line({"state": "running"}, 99, lambda _pid: True, is_revoked=True), "Access stopped; no further turn was sent.")
        self.assertEqual(live["jobId"], job)
        self.assertEqual(live["record"]["verdict"], "verified")
        stop_argv, stop_error = workbench.coordination_stop_command(directory, Path("/repo"), "/tmp/core.sock", "/usr/bin/goalport-core")
        self.assertIsNone(stop_error)
        self.assertIn("stop", stop_argv)
        self.assertIn(job, stop_argv)
        idle, idle_error = workbench.coordination_stop_command(directory / "empty", Path("/repo"), "/tmp/core.sock", "/usr/bin/goalport-core")
        self.assertIsNone(idle)
        self.assertEqual(idle_error, "No running coordinated goal to stop.")
        first = workbench.latest_coordination_record(directory / "empty")
        self.assertIsNone(first["record"])
        locked, locked_error = workbench.coordination_continue_command(directory, Path("/repo"), "/tmp/core.sock", "/usr/bin/goalport-core", background=True, from_request_id="coordinate-verified")
        self.assertIsNone(locked)
        self.assertIn("not settled", locked_error)
        (jobs / "progress.json").write_text(json.dumps({"state": "completed", "outcome": {"status": "completed"}}), encoding="utf-8")
        argv, error = workbench.coordination_continue_command(directory, Path("/repo"), "/tmp/core.sock", "/usr/bin/goalport-core", background=True, from_request_id="coordinate-verified")
        self.assertIsNone(error)
        self.assertNotIn("--goal", argv)
        self.assertIn("coordinate-verified", argv)
        self.assertIn("--pipe", argv)
        self.assertIn("--core-binary", argv)
        self.assertIn("--background", argv)
        followed, follow_error = workbench.coordination_continue_command(directory, Path("/repo"), "/tmp/core.sock", "/usr/bin/goalport-core", "Check the second file too", background=True, from_request_id="coordinate-verified")
        self.assertIsNone(follow_error)
        self.assertEqual(followed[followed.index("--goal") + 1], "Check the second file too")
        self.assertNotIn("--write-instances", followed)
        writing_follow, writing_error = workbench.coordination_continue_command(directory, Path("/repo"), "/tmp/core.sock", "/usr/bin/goalport-core", "Add the line", True, background=True, from_request_id="coordinate-verified")
        self.assertIsNone(writing_error)
        self.assertEqual(writing_follow[writing_follow.index("--write-instances") + 1], "codex")
        self.assertNotIn("pi", writing_follow)
        self.assertIsNone(workbench.coordination_continue_command(None, Path("/repo"), "/tmp/core.sock", "/usr/bin/goalport-core")[0])
        started, start_error = workbench.coordination_start_command(directory, Path("/repo"), "Plan the check", "/home/you/project", False, "/tmp/core.sock", "/usr/bin/goalport-core", background=True)
        quiet, quiet_error = workbench.coordination_start_command(directory, Path("/repo"), "Plan the check", "/home/you/project", False, "/tmp/core.sock", "/usr/bin/goalport-core")
        self.assertIsNone(quiet)
        self.assertEqual(quiet_error, "Keep working after closing must be explicitly selected.")
        self.assertIsNone(start_error)
        self.assertIn("run", started)
        self.assertIn("--background", started)
        named, named_error = workbench.coordination_start_command(directory, Path("/repo"), "Plan the check", "/home/you/project", False, "/tmp/core.sock", "/usr/bin/goalport-core", background=True, instances="codex,pi")
        self.assertIsNone(named_error)
        self.assertEqual(named[named.index("--instances") + 1], "codex,pi")
        invalid, invalid_error = workbench.coordination_start_command(directory, Path("/repo"), "Plan the check", "/home/you/project", False, "/tmp/core.sock", "/usr/bin/goalport-core", background=True, instances="codex pi")
        self.assertIsNone(invalid)
        self.assertIn("invalid", invalid_error)
        self.assertNotIn("--write-instances", started)
        writing, _write_error = workbench.coordination_start_command(directory, Path("/repo"), "Add pong", "/home/you/project", True, "/tmp/core.sock", "/usr/bin/goalport-core", background=True)
        self.assertEqual(writing[writing.index("--write-instances") + 1], "codex")
        self.assertNotIn("pi", writing)
        missing_core, missing_error = workbench.coordination_start_command(directory, Path("/repo"), "Plan the check", "/home/you/project", False, "/tmp/core.sock", None, background=True)
        self.assertIsNone(missing_core)
        self.assertIn("--core-binary", missing_error)
        env = workbench.coordination_child_env({"PATH": "/opt/pi/bin"})
        self.assertIn("/opt/pi/bin", env["PATH"])
        local_bin = Path.home() / ".local" / "bin"
        if local_bin.is_dir():
            self.assertIn(str(local_bin), env["PATH"])
        home_start, home_error = workbench.coordination_start_command(directory, Path("/repo"), "Plan the check", "~/project", False, "/tmp/core.sock", "/usr/bin/goalport-core", background=True)
        self.assertIsNone(home_error)
        self.assertIn(str(Path.home() / "project"), home_start)
        refused, refuse_error = workbench.coordination_start_command(directory, Path("/repo"), "Plan the check", "relative")
        self.assertIsNone(refused)
        self.assertIn("absolute", refuse_error)

    def test_bridge_disconnect_is_not_a_preview_snapshot(self):
        body = json.loads(workbench.disconnected_body("Linux Core is not connected"))
        self.assertFalse(body["ok"])
        self.assertEqual(body["connection"], "disconnected")
        self.assertNotIn("snapshot", body)
        self.assertNotIn("preview", body)
        html = workbench.inject_linux_flag("<head><title>GoalPort</title></head>")
        self.assertIn("__GOALPORT_LINUX_CORE__", html)


class SavedTargetTests(unittest.TestCase):
    def test_real_http_projection_and_continue_preserve_exact_selection(self):
        class NeverCore:
            MAX_FRAME_BYTES = 1024 * 1024
            def call(self, *args, **kwargs):
                raise AssertionError("Saved-target requests must not invoke Core")
        with tempfile.TemporaryDirectory(prefix="gp-saved-http-") as temp:
            root = Path(temp)
            records = [{"requestId": "a", "goal": "Original A", "workspacePath": "/a", "savedAt": "01", "verdict": "verified"},
                       {"requestId": "b", "goal": "Original B", "workspacePath": "/b", "savedAt": "02", "verdict": "verified"}]
            file = root / "coordination-records.json"
            file.write_text(json.dumps(records), encoding="utf-8")
            before = file.read_bytes()
            commands = []
            def runner(argv):
                commands.append(argv)
                return 0, "The goal was admitted with request id new-child; its worker runs detached.", ""
            handler = workbench.make_handler("/tmp/sock", root, NeverCore(), 2, root, runner, "/usr/bin/core")
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def post(kind, payload):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=3)
                connection.request("POST", "/goalport/ipc", json.dumps({"messageType": kind, "payload": payload}), {"Content-Type": "application/json"})
                result = connection.getresponse()
                body = json.loads(result.read())
                connection.close()
                return body
            try:
                detail = post("coordination_detail", {"requestId": "a"})
                self.assertEqual(detail["payload"]["record"]["goal"], "Original A")
                self.assertEqual(post("coordination_latest", {"requestId": "a"})["payload"]["record"], detail["payload"]["record"])
                self.assertEqual(len(post("coordination_list", {})["payload"]["roots"]), 2)
                self.assertIsNone(post("coordination_detail", {"requestId": "missing"})["payload"]["record"])
                self.assertEqual(commands, [])
                self.assertEqual(file.read_bytes(), before)
                self.assertFalse(post("coordination_detail", {})["ok"])
                self.assertFalse(post("coordination_latest", {"requestId": None})["ok"])
                self.assertFalse(post("coordination_detail", "wrong shape")["ok"])
                self.assertFalse(post("coordination_continue", {"background": True, "followUp": "must not latest-fallback"})["ok"])
                self.assertEqual(commands, [])
                admitted = post("coordination_continue", {"fromRequestId": "a", "followUp": "Current instruction", "background": True, "write": False, "workspaceRoot": "/untrusted", "rootRequestId": "b"})
                self.assertTrue(admitted["ok"])
                self.assertEqual(len(commands), 1)
                self.assertEqual(commands[0][commands[0].index("--from") + 1], "a")
                self.assertEqual(commands[0][commands[0].index("--workspace") + 1], "/a")
                self.assertEqual(commands[0][commands[0].index("--goal") + 1], "Current instruction")
                self.assertNotIn("--write-instances", commands[0])
                self.assertEqual(file.read_bytes(), before)
                records.append({**records[0], "requestId": "a2", "savedAt": "03", "continuation": {"parentRequestId": "a", "rootRequestId": "a", "originalGoal": "Original A", "followUp": "Current instruction"}})
                file.write_text(json.dumps(records), encoding="utf-8")
                self.assertFalse(post("coordination_continue", {"fromRequestId": "a", "background": True})["ok"])
                self.assertEqual(len(commands), 1)
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=3)

    def test_matching_raw_relation_fixtures_and_no_rewrite(self):
        fixtures = json.loads((Path(__file__).parent / "fixtures" / "saved-targets.json").read_text(encoding="utf-8"))
        for fixture in fixtures:
            with self.subTest(fixture["name"]):
                before = json.dumps(fixture["records"])
                targets = workbench.SavedTargets(fixture["records"])
                actual = [[e["record"]["requestId"], e["relationStatus"], e["rootRequestId"], targets.head(e["rootRequestId"]) if e["rootRequestId"] else None] for e in targets.entries]
                self.assertEqual(actual, fixture["expected"])
                self.assertEqual(json.dumps(fixture["records"]), before)

    def test_explicit_detail_selection_and_continue_argv_not_profile_latest(self):
        with tempfile.TemporaryDirectory(prefix="gp-saved-target-") as temp:
            root = Path(temp)
            records = [{"requestId": "a", "goal": "Original A", "workspacePath": "/work/a", "savedAt": "01", "verdict": "checked"},
                       {"requestId": "b", "goal": "Original B", "workspacePath": "/work/b", "savedAt": "02", "verdict": "checked"}]
            file = root / "coordination-records.json"
            file.write_text(json.dumps(records), encoding="utf-8")
            before = file.read_bytes()
            selected = workbench.latest_coordination_record(root, "a")
            self.assertEqual(selected["record"]["goal"], "Original A")
            self.assertEqual(selected["profileLatestId"], "b")
            self.assertEqual(len(selected["roots"]), 2)
            self.assertIsNone(workbench.latest_coordination_record(root, "missing")["record"])
            argv, error = workbench.coordination_continue_command(root, Path("/repo"), "/tmp/core.sock", "/usr/bin/core", "Current 中文", False, True, "codex,pi", from_request_id="a")
            self.assertIsNone(error)
            self.assertEqual(argv[argv.index("--from") + 1], "a")
            self.assertEqual(argv[argv.index("--workspace") + 1], "/work/a")
            self.assertEqual(argv[argv.index("--goal") + 1], "Current 中文")
            empty, error = workbench.coordination_continue_command(root, Path("/repo"), "/tmp/core.sock", "/usr/bin/core", "", False, True, from_request_id="a")
            self.assertIsNone(error)
            self.assertNotIn("--goal", empty)
            self.assertIsNone(workbench.coordination_continue_command(root, Path("/repo"), background=True)[0])
            self.assertEqual(file.read_bytes(), before)

    def test_saved_a_and_current_b_unknown_held_stay_separate(self):
        with tempfile.TemporaryDirectory(prefix="gp-saved-job-") as temp:
            root = Path(temp)
            file = root / "coordination-records.json"
            file.write_text(json.dumps([{"requestId": "a", "goal": "A", "workspacePath": "/a", "verdict": "verified"}]), encoding="utf-8")
            job = root / "coordination-jobs" / "jobs" / "job-b"
            job.mkdir(parents=True)
            (job.parent.parent / "active-admission.json").write_text(json.dumps({"jobId": "job-b"}), encoding="utf-8")
            (job / "admission.json").write_text(json.dumps({"input": {"requestId": "b", "goal": "B", "workspacePath": "/b", "privateControlToken": "PRIVATE", "scopeGeneration": 99}}), encoding="utf-8")
            for state in ("running", "revoked", "unconfirmed"):
                (job / "progress.json").write_text(json.dumps({"state": state, "pendingCommand": {"commandId": "pending"}}), encoding="utf-8")
                projected = workbench.latest_coordination_record(root, "a")
                self.assertEqual(projected["record"]["goal"], "A")
                self.assertEqual(projected["currentJob"]["goal"], "B")
                self.assertEqual(projected["currentJob"]["requestId"], "b")
                self.assertNotIn("PRIVATE", json.dumps(projected))
                self.assertNotIn("scopeGeneration", json.dumps(projected))
                self.assertIsNone(workbench.coordination_stop_command(root, Path("/repo"), "/tmp/sock", "/usr/bin/core", expected_job_id="not-job-b")[0])
                stop, stop_error = workbench.coordination_stop_command(root, Path("/repo"), "/tmp/sock", "/usr/bin/core", expected_job_id="job-b")
                self.assertIsNone(stop_error)
                self.assertEqual(stop[-2:], ["--job", "job-b"])
                self.assertIsNone(workbench.coordination_continue_command(root, Path("/repo"), "/tmp/sock", "/usr/bin/core", background=True, from_request_id="a")[0])
            (job / "admission.json").unlink()
            self.assertFalse(workbench.latest_coordination_record(root, "a")["currentJob"]["identityConfirmed"])
            (job / "admission.json").write_text(json.dumps({"input": {"requestId": "b", "goal": "B", "workspacePath": "/b"}}), encoding="utf-8")
            (job / "stuck-ack.json").write_text("{}", encoding="utf-8")
            held = workbench.latest_coordination_record(root, "a")
            self.assertEqual(held["currentJob"]["goal"], "B")
            self.assertIsNone(held["line"])
            self.assertIsNone(workbench.coordination_acknowledge_command(root, Path("/repo"), "/tmp/sock", "/usr/bin/core", expected_job_id="not-job-b")[0])
            self.assertTrue(workbench.latest_coordination_record(root, "a")["leftoverHeld"])
            self.assertEqual(workbench.latest_coordination_record(root, "a")["record"]["goal"], "A")


@unittest.skipUnless(hasattr(socket, "AF_UNIX") and os.name == "posix", "Linux Unix client")
class WireTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="gp-client-")
        self.addCleanup(self.directory.cleanup)
        self.path = str(Path(self.directory.name) / "core.sock")
        self.requests = []
        self.errors = []

    def peer(self, reply):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(self.path)
        listener.listen()
        listener.settimeout(2)

        def serve():
            try:
                with listener:
                    conn, _ = listener.accept()
                    with conn:
                        conn.settimeout(2)
                        length = struct.unpack("<I", client.recv_exact(conn, 4))[0]
                        request = json.loads(client.recv_exact(conn, length))
                        self.requests.append(request)
                        reply(conn, request)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                self.errors.append(error)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        self.addCleanup(lambda: thread.join(timeout=3))
        return thread

    @staticmethod
    def answer(request, **changes):
        response = {"protocolVersion": client.PROTOCOL_VERSION, "requestId": request["requestId"],
                    "entityVersion": 1, "ok": True, "payload": {"snapshot": {"cursor": 7}}}
        response.update(changes)
        body = json.dumps(response).encode()
        return struct.pack("<I", len(body)) + body

    def test_partial_frames_correlate_real_production_envelope(self):
        def reply(conn, request):
            packet = self.answer(request)
            for part in (packet[:2], packet[2:5], packet[5:]):
                conn.sendall(part)
        thread = self.peer(reply)
        response = client.call(self.path, "conversation_send", {"campaignId": "goal", "message": "你好"})
        thread.join(2)
        self.assertEqual(client.snapshot_from(response)["cursor"], 7)
        self.assertEqual(self.requests[0]["payload"]["message"], "你好")
        self.assertNotEqual(self.requests[0]["requestId"], "client-1")
        self.assertFalse(self.errors)

    def test_mutation_with_lost_response_is_unknown_and_never_replayed(self):
        thread = self.peer(lambda conn, request: None)
        with self.assertRaises(client.ClientError) as caught:
            client.call(self.path, "start_conversation", {"message": "once"}, request_id="stable-id")
        thread.join(2)
        self.assertEqual(caught.exception.delivery_state, "UNKNOWN")
        self.assertEqual(caught.exception.request_id, "stable-id")
        self.assertFalse(caught.exception.as_dict()["automaticallyRetried"])
        self.assertEqual(len(self.requests), 1)

    def test_connect_failure_proves_only_not_sent(self):
        with self.assertRaises(client.ClientError) as caught:
            client.call(self.path, "interrupt", {"attemptId": "a"})
        self.assertEqual(caught.exception.delivery_state, "NOT_SENT")

    def test_oversized_frame_rejected_before_body_read(self):
        self.peer(lambda conn, request: conn.sendall(struct.pack("<I", client.MAX_FRAME_BYTES + 1)))
        with self.assertRaisesRegex(client.ClientError, "frame bounds") as caught:
            client.call(self.path)
        self.assertEqual(caught.exception.delivery_state, "READ_FAILED")

    def test_response_for_other_request_cannot_acknowledge_mutation(self):
        self.peer(lambda conn, request: conn.sendall(self.answer(request, requestId="other")))
        with self.assertRaisesRegex(client.ClientError, "different request") as caught:
            client.call(self.path, "interrupt", {"attemptId": "a"})
        self.assertEqual(caught.exception.delivery_state, "UNKNOWN")

    def test_deadline_covers_trickled_response_not_each_recv(self):
        def reply(conn, request):
            for byte in self.answer(request):
                conn.sendall(bytes([byte]))
                time.sleep(0.02)
        self.peer(reply)
        started = time.monotonic()
        with self.assertRaises(client.ClientError):
            client.call(self.path, timeout=0.08)
        self.assertLess(time.monotonic() - started, 0.5)

    def test_core_refusal_exits_nonzero_and_preserves_reason(self):
        self.peer(lambda conn, request: conn.sendall(self.answer(request, ok=False, error="quota exhausted")))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = client.main(["--endpoint", self.path, "send", "--campaign", "g", "-m", "next"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output.getvalue())["error"], "quota exhausted")


class OperatorTests(unittest.TestCase):
    def command(self, *args):
        return client.command_for(client.parser().parse_args(args))

    def test_new_and_second_turn_use_existing_commands(self):
        kind, payload = self.command("new", "--workspace", ".", "--runtime", "codex", "-m", "fix")
        self.assertEqual(kind, "start_conversation")
        self.assertEqual(payload, {"workspaceRoot": os.getcwd(), "provider": "codex", "message": "fix"})
        self.assertEqual(self.command("send", "--campaign", "g", "-m", "next"),
                         ("conversation_send", {"campaignId": "g", "message": "next"}))

    def test_stop_and_close_session_are_distinct(self):
        self.assertEqual(self.command("stop", "--attempt", "a")[0], "interrupt")
        self.assertEqual(self.command("close-session", "--attempt", "a")[0], "close_session")
        self.assertEqual(self.command("resume", "--attempt", "a")[0], "resume_native_session")

    def test_permissions_require_explicit_answer(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.command("decision", "--decision", "d")
        self.assertEqual(self.command("decision", "--decision", "d", "--deny"),
                         ("resolve_decision", {"decisionId": "d", "allow": False}))

    def test_diagnostics_preserve_backend_reason_and_filter_settled_decisions(self):
        turn = {"state": "failed", "canSend": False, "canStop": False,
                "reason": "Usage limit reached", "reasonCode": "quota-exhausted", "actions": ["change-runtime"]}
        response = {"ok": True, "payload": {"snapshot": {
            "attempt": {"id": "a", "state": "active"},
            "productConversation": {"turn": turn, "runtime": {"provider": "codex"}, "items": []},
            "decisions": [{"id": "p", "state": "pending"}, {"id": "d", "state": "denied"}],
        }}}
        result = client.diagnostics(response)
        self.assertEqual(result["turn"], turn)
        self.assertEqual(result["pendingDecisions"], [{"id": "p", "state": "pending"}])
        self.assertEqual(result["session"]["state"], "unknown")

    def test_legacy_endpoint_only_call_still_reads_snapshot(self):
        with patch.object(client, "call", return_value={"ok": True}) as call:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(client.main(["/tmp/example.sock"]), 0)
        self.assertEqual(call.call_args.args[:3], ("/tmp/example.sock", "snapshot", {}))

    def test_diagnostics_join_streamed_reply_words_without_merging_distinct_messages(self):
        items = [
            {"id": "d1", "logicalItemId": "reply-1", "kind": "assistant-message", "body": "All "},
            {"id": "d2", "logicalItemId": "reply-1", "kind": "assistant-message", "body": "3 tests "},
            {"id": "d3", "logicalItemId": "reply-1", "kind": "assistant-message", "body": "passed."},
            {"id": "d4", "logicalItemId": "reply-2", "kind": "assistant-message", "body": "Ready for the next task."},
        ]
        result = client.diagnostics({"ok": True, "payload": {"productConversation": {"items": items}}})
        self.assertEqual([item["body"] for item in result["recentMessages"]],
                         ["All 3 tests passed.", "Ready for the next task."])
        self.assertEqual(items[0]["body"], "All ")

    def test_recent_diagnostics_remain_bounded_and_mark_a_truncated_reply(self):
        items = [{"id": str(i), "kind": "assistant-message", "body": "x" * 5000} for i in range(9)]
        messages = client.diagnostics({"ok": True, "payload": {"productConversation": {"items": items}}})["recentMessages"]
        self.assertEqual(len(messages), 6)
        self.assertTrue(all(len(item["body"]) == 4096 and item["continuesBefore"] for item in messages))

    def test_nonfinite_timeouts_fail_before_connect(self):
        for timeout in (float("inf"), float("nan"), 0, -1):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                client.call("/does/not/exist", timeout=timeout)

    def test_watch_refuses_reusing_an_explicit_mutation_identity(self):
        with patch.object(client, "call") as call, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(client.main(["--request-id", "old-send", "watch", "--count", "2"]), 2)
        call.assert_not_called()

    def test_watch_echoes_revision_and_does_not_render_an_unchanged_response(self):
        responses = [
            {"ok": True, "payload": {"revision": "r1", "unchanged": False,
                                     "snapshot": {"connection": "connected", "cursor": 7}}},
            {"ok": True, "payload": {"revision": "r1", "unchanged": True}},
        ]
        output = io.StringIO()
        with patch.object(client, "call", side_effect=responses) as call, patch.object(client.time, "sleep"):
            with contextlib.redirect_stdout(output):
                self.assertEqual(client.main(["watch", "--count", "2"]), 0)
        self.assertEqual(call.call_args_list[0].args[1:], ("snapshot_if_changed", {}))
        self.assertEqual(call.call_args_list[1].args[1:], ("snapshot_if_changed", {"revision": "r1"}))
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(output.getvalue())["cursor"], 7)


if __name__ == "__main__":
    unittest.main()
