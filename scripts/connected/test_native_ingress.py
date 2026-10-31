"""Synthetic native ingress table over ephemeral HTTP; no real Core/profile/provider."""
import copy
import http.client
from http.server import ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_workbench", Path(__file__).with_name("linux-workbench.py"))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


def preflight(workspace=None, **changes):
    inventory = {"holds": [], "complete": True, "globalBlock": False}
    packet = {"mode": "global" if workspace is None else "workspace", "outstanding": False, "inventory": inventory}
    if workspace is not None:
        packet["workspace"] = workspace
        inventory.update(candidate=workspace, candidateBlocked=False)
    packet.update(changes)
    return ("native preflight: " + json.dumps(packet) + "\n").encode()


class NativeIngressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gp-native-ingress-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = str(self.root)
        self.calls, self.captures = [], []
        self.clear, self.clean = True, True
        self.snapshot = {"activeCampaignId": "campaign-a", "project": {"workspaceRoot": self.workspace}, "activeTask": {"id": "task-a"}, "attempt": {"id": "attempt-a"}}
        self.bad_reply = False
        self.call_error = None
        owner = self
        class FakeCore:
            MAX_FRAME_BYTES = 1024 * 1024
            class ClientError(Exception): pass
            def call(self, endpoint, kind, payload, timeout, request_id=None):
                owner.calls.append((kind, copy.deepcopy(payload), request_id))
                if owner.call_error:
                    error = owner.call_error(kind)
                    if error:
                        raise error
                return {"protocolVersion": "goalport.ipc.v2", "requestId": "wrong" if owner.bad_reply else request_id, "ok": True,
                        "payload": {"accepted": True, "requestId": request_id, "snapshot": copy.deepcopy(owner.snapshot)}}
        class Capture:
            def __init__(self, argv, env, cwd, deadline):
                owner.captures.append(argv)
                self.argv = argv
            def run(self):
                root = self.argv[self.argv.index("--workspace") + 1] if "--workspace" in self.argv else None
                return (preflight(root) if owner.clear else b"native preflight: malformed\n"), owner.clean
            def cleanup(self, **kw): return owner.clean
            def kill_once(self): pass
        self.fake = FakeCore()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), w.make_handler("/tmp/synthetic.sock", self.root, self.fake, 1,
            self.root, None, "/fixture/never-executed-core", "/fixture/never-read.sqlite", native_capture=Capture))
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=3)

    def post(self, kind, payload, wrapper=None, request_id="caller-stable"):
        packet = {"messageType": kind, "requestId": request_id, "payload": payload}
        if wrapper is not None: packet["nativeTarget"] = wrapper
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=4)
        try:
            conn.request("POST", "/goalport/ipc", json.dumps(packet), {"Content-Type": "application/json"})
            response = conn.getresponse()
            self.last_status = response.status
            return json.loads(response.read())
        finally: conn.close()

    def rows(self):
        return [
            ("start_conversation", {"workspaceRoot": self.workspace, "provider": "codex", "message": "new", "requireNativeSession": True}, None, self.workspace),
            ("conversation_send", {"campaignId": "campaign-a", "attemptId": "attempt-a", "message": "second"}, None, self.workspace),
            ("send_message", {"campaignId": "campaign-a", "taskId": "task-a", "attemptId": "attempt-a", "message": "second"}, None, self.workspace),
            ("select_runtime", {"campaignId": "campaign-a", "provider": "codex"}, None, self.workspace),
            ("select_attempt", {"campaignId": "campaign-a", "taskId": "task-a", "attemptId": "attempt-a", "provider": "codex"}, None, self.workspace),
            ("resume_native_session", {"attemptId": "attempt-a"}, {"campaignId": "campaign-a"}, self.workspace),
            ("handoff", {"oldAttemptId": "attempt-a", "provider": "codex", "instruction": "bounded"}, {"campaignId": "campaign-a"}, self.workspace),
            ("reassign", {"oldAttemptId": "attempt-a", "provider": "codex", "instruction": "bounded"}, {"campaignId": "campaign-a"}, self.workspace),
            ("continue_in_isolated_workspace", {"attemptId": "Core-owned-source", "targetWorkspace": self.workspace}, None, self.workspace),
            ("create_campaign", {"projectId": "Core-owned-project", "goal": "legacy"}, None, None),
            ("create_campaign_with_task", {"workspaceRoot": "Core-owned-resolution", "goal": "legacy"}, None, None),
            ("queue_override", {"queueId": "Core-owned-queue"}, None, None),
            ("request_owner_action", {"action": "Core-authorized", "planApproved": True, "auditPassed": True}, None, None),
        ]

    def test_entire_table_aliases_global_modes_wrapper_strip_and_same_payload(self):
        for kind, payload, wrapper, root in self.rows():
            with self.subTest(kind=kind):
                before = len(self.captures)
                reply = self.post(kind, payload, wrapper)
                self.assertTrue(reply["ok"], reply)
                self.assertEqual(len(self.captures), before + 1)
                argv = self.captures[-1]
                self.assertIn("native-preflight", argv)
                if root is None: self.assertEqual(argv[-1], "--global")
                else: self.assertEqual(argv[-2:], ["--workspace", root])
                self.assertEqual(self.calls[-1], (kind, payload, "caller-stable"))
                self.assertNotIn("nativeTarget", self.calls[-1][1])
        # select_runtime without attempt preserves Core's NEW-attempt policy.
        selected = [p for k, p, _ in self.calls if k == "select_runtime"][-1]
        self.assertNotIn("attemptId", selected)

    def test_refusal_before_mutation_for_every_row_and_unclean_helper_is_not_replaced(self):
        self.clear = False
        for kind, payload, wrapper, _ in self.rows():
            reply = self.post(kind, payload, wrapper)
            self.assertFalse(reply["ok"], kind)
            self.assertNotIn(kind, [k for k, _, _ in self.calls])
        self.clear, self.clean = True, False
        self.assertFalse(self.post("queue_override", {"queueId": "queue"})["ok"])
        before = len(self.captures)
        self.assertFalse(self.post("queue_override", {"queueId": "queue"})["ok"])
        self.assertEqual(len(self.captures), before)

    def test_historical_missing_foreign_campaign_task_attempt_and_bad_envelope_refuse(self):
        bad = [
            ("conversation_send", {"campaignId": "campaign-a", "message": "second"}, None),
            ("conversation_send", {"campaignId": "campaign-a", "attemptId": "historical"}, None),
            ("send_message", {"campaignId": "campaign-a", "taskId": "task-b", "attemptId": "attempt-a"}, None),
            ("select_runtime", {"campaignId": "campaign-a", "attemptId": "historical"}, None),
            ("resume_native_session", {"attemptId": "attempt-a"}, None),
            ("resume_native_session", {"attemptId": "historical"}, {"campaignId": "campaign-a"}),
            ("handoff", {"oldAttemptId": "historical"}, {"campaignId": "campaign-a"}),
            ("reassign", {"oldAttemptId": "historical"}, {"campaignId": "campaign-a"}),
            ("conversation_send", {"campaignId": "campaign-b", "attemptId": "attempt-a"}, None),
            ("send_message", {"campaignId": "campaign-a", "attemptId": "attempt-a"}, {"campaignId": "campaign-b"}),
        ]
        for kind, payload, wrapper in bad:
            with self.subTest(kind=kind, payload=payload): self.assertFalse(self.post(kind, payload, wrapper)["ok"])
        self.bad_reply = True
        self.assertFalse(self.post("conversation_send", {"campaignId":"campaign-a", "attemptId":"attempt-a"})["ok"])
        self.assertEqual(self.captures, [])
        self.assertTrue(all(k == "goal_detail" for k, _, _ in self.calls))

    def test_absolute_only_before_preflight_or_core_and_explicit_target_not_source(self):
        for root in ("", "~", "~/project", "relative", str(self.root / "missing")):
            self.assertFalse(self.post("start_conversation", {"workspaceRoot": root, "provider":"codex", "message":"x", "requireNativeSession":True})["ok"])
        self.assertEqual(self.calls, []); self.assertEqual(self.captures, [])
        target = self.root / "target"; target.mkdir()
        self.assertTrue(self.post("continue_in_isolated_workspace", {"attemptId":"Core-owned-history", "targetWorkspace":str(target)})["ok"])
        self.assertEqual(self.captures[-1][-2:], ["--workspace", str(target)])
        self.assertEqual([k for k, _, _ in self.calls], ["continue_in_isolated_workspace"])

    def assert_send_refusal(self, reply, kind, stage):
        reason = w.NATIVE_PREFLIGHT_REASONS[stage]
        self.assertEqual(self.last_status, 200)
        self.assertEqual(reply, {
            "protocolVersion": "goalport.ipc.v2", "requestId": "caller-stable", "ok": False, "error": reason,
            "payload": {"requestId": "caller-stable", "accepted": False, "messageType": kind,
                        "refusalSource": "workbench-native-preflight",
                        "rejection": {"code": "native-preflight-refused", "message": reason, "deliveryState": "FAILED",
                                      "nativeDispatchState": "NOT_STARTED", "retryMode": "NEW_REQUEST", "reservation": None}},
        })
        self.assertNotIn("connection", reply)
        self.assertNotIn("snapshot", reply["payload"])
        self.assertNotIn("Errno", reply["error"])
        self.assertNotIn(self.workspace, reply["error"])

    def test_two_send_folder_target_and_policy_refusals_have_only_correlated_local_proof(self):
        start = {"workspaceRoot": str(self.root / "known-missing"), "provider": "codex", "message": "draft"}
        self.assert_send_refusal(self.post("start_conversation", start), "start_conversation", "folder")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.captures, [])
        follow = {"campaignId": "campaign-a", "attemptId": "attempt-a", "message": "follow"}
        for error_type in (self.fake.ClientError, OSError):
            with self.subTest(error=error_type.__name__):
                self.call_error = lambda kind: error_type("synthetic lookup failure")
                self.assert_send_refusal(self.post("conversation_send", follow), "conversation_send", "target")
                self.assertTrue(all(kind == "goal_detail" for kind, _, _ in self.calls))
        self.call_error = None
        for kind, payload in (("start_conversation", {**start, "workspaceRoot": self.workspace}), ("conversation_send", follow)):
            with self.subTest(kind=kind):
                self.clear = False
                self.assert_send_refusal(self.post(kind, payload), kind, "reservations")
                self.assertNotIn(kind, [k for k, _, _ in self.calls])
        self.clear = True
        with patch.object(w, "coordination_cli_prefix", return_value=(None, "synthetic unavailable prefix")):
            self.assert_send_refusal(self.post("start_conversation", {**start, "workspaceRoot": self.workspace}), "start_conversation", "reservations")

    def test_preflight_oserror_human_mapping_and_bad_correlation_never_claims_no_forward(self):
        for kind, stage in (("start_conversation", "folder"), ("conversation_send", "target")):
            for error_type in (FileNotFoundError, PermissionError, ValueError):
                with self.subTest(kind=kind, error=error_type.__name__), patch.object(w, "native_ingress_workspace", side_effect=error_type("raw /private/fixture not headline")):
                    self.assert_send_refusal(self.post(kind, {}), kind, stage)
        self.assertEqual(self.calls, [])
        for bad_id in (None, "", "has space", "x" * 257, 123, {"wrong": True}):
            reply = self.post("start_conversation", {"workspaceRoot": str(self.root / "missing")}, request_id=bad_id)
            self.assertNotIn("payload", reply)
            self.assertNotIn("refusalSource", reply)

    def test_post_forward_errors_keep_old_unknown_path_for_both_sends(self):
        for kind, payload, wrapper, _ in self.rows()[:2]:
            for error_type in (self.fake.ClientError, OSError, ValueError):
                with self.subTest(kind=kind, error=error_type.__name__):
                    self.call_error = lambda current: error_type("synthetic mutation error") if current == kind else None
                    reply = self.post(kind, payload, wrapper)
                    self.assertEqual(self.last_status, 502)
                    self.assertFalse(reply["ok"])
                    self.assertNotIn("payload", reply)
                    self.assertIn(kind, [k for k, _, _ in self.calls])

    def test_other_native_commands_keep_legacy_refusal_body_and_status(self):
        self.clear = False
        for kind, payload, wrapper, _ in self.rows()[2:]:
            with self.subTest(kind=kind):
                reply = self.post(kind, payload, wrapper)
                self.assertEqual(self.last_status, 200)
                self.assertFalse(reply["ok"])
                self.assertNotIn("payload", reply)
                self.assertEqual(reply["connection"], "disconnected")
                self.assertNotIn(kind, [k for k, _, _ in self.calls])

    def test_excluded_reads_stop_permission_close_recheck_revoke_recovery_remain_reachable(self):
        self.clear = False
        for kind in ("snapshot", "snapshot_if_changed", "goal_overview", "goal_detail", "history_page", "interrupt", "safe_stop", "cancel", "resolve_decision", "permission_response", "close_session", "recheck_stop_responsibility", "revoke_authorization"):
            for allow in (False, True) if kind == "resolve_decision" else (False,):
                reply = self.post(kind, {"attemptId":"attempt-a", "allow":allow})
                self.assertTrue(reply["ok"], kind)
        self.assertEqual(self.captures, [])


class NativeParserTests(unittest.TestCase):
    def test_own_fixed_parser_complete_inventory_outstanding_exact_echo_and_global_left_holds(self):
        self.assertTrue(w._status.parse_native_preflight(preflight("/fixture/work"), "/fixture/work"))
        self.assertTrue(w._status.parse_native_preflight(preflight(), None))
        for global_mode in (True, False):
            root = None if global_mode else "/fixture/work"
            base = json.loads(preflight(root).decode().split(": ", 1)[1])
            bad = []
            for field, value in (("complete", False), ("complete", 1), ("globalBlock", True)):
                packet = copy.deepcopy(base); packet["inventory"][field] = value; bad.append(packet)
            packet = copy.deepcopy(base); packet["outstanding"] = True; bad.append(packet)
            packet = copy.deepcopy(base); packet["outstanding"] = 0; bad.append(packet)
            if global_mode:
                packet = copy.deepcopy(base); packet["inventory"]["holds"] = [{"jobId":"left", "workspacePath":"/other"}]; bad.append(packet)
            else:
                for field, value in (("candidate", "/other"), ("candidateBlocked", True)):
                    packet = copy.deepcopy(base); packet["inventory"][field] = value; bad.append(packet)
            for packet in bad: self.assertFalse(w._status.parse_native_preflight(("native preflight: " + json.dumps(packet)).encode(), root), packet)
        for raw in (b"", b"job projection: {}", preflight() + preflight(), b"native preflight: null", b"native preflight: \xff"):
            self.assertFalse(w._status.parse_native_preflight(raw, None))

    def test_first_run_creates_a_private_profile_and_keeps_an_existing_one(self):
        temp = tempfile.TemporaryDirectory(prefix="gp-native-profile-")
        self.addCleanup(temp.cleanup)
        profile = Path(temp.name) / "fresh" / "linux-coordinate"
        w.ensure_coordination_profile(profile)
        self.assertTrue(profile.is_dir())
        self.assertEqual(profile.stat().st_mode & 0o777, 0o700)
        (profile / "kept").write_text("kept")
        w.ensure_coordination_profile(profile)
        self.assertEqual((profile / "kept").read_text(), "kept")

    def test_unusable_profile_location_stays_a_refusal_not_a_crash(self):
        temp = tempfile.TemporaryDirectory(prefix="gp-native-profile-")
        self.addCleanup(temp.cleanup)
        blocker = Path(temp.name) / "file"
        blocker.write_text("not a directory")
        w.ensure_coordination_profile(blocker / "linux-coordinate")
        self.assertFalse((blocker / "linux-coordinate").exists())


if __name__ == "__main__": unittest.main()
