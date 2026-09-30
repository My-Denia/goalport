"""Wire-level checks for the thin Linux operator client; no vendor process."""
import contextlib
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
