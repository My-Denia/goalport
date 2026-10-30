"""Synthetic pipes and owned benign Python children, never Node/Core/vendor/profile."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("status_fixture", Path(__file__).with_name("workbench_status.py"))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
JOB = "abcdefab-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"


def projection(**extra):
    return {"jobId": JOB, "requestId": "fixture-request", "goal": "Synthetic goal", "workspacePath": "/fixture/work",
            "state": "stopped", "active": False, "live": False, "revoked": True, "workerPid": None,
            "readMaxTurns": 4, "writeMaxTurns": None, "counters": None, "pendingCommand": None,
            "completedCommands": [], "progress": None, "outcome": {"status": "stopped"}, **extra}


def wire(**extra):
    return ("job projection: " + json.dumps(projection(**extra), ensure_ascii=False) + "\n").encode()


class FakeProcess:
    def __init__(self, out, err=b"", exit_code=0, timeout=False):
        self.stdout, self.stderr = io.BytesIO(out), io.BytesIO(err)
        self.returncode = None
        self.exit_code, self.timeout = exit_code, timeout
        self.kills = 0
        self.waits = []

    def poll(self):
        return self.returncode

    def kill(self):
        self.kills += 1
        self.returncode = -9

    def wait(self, timeout):
        self.waits.append(timeout)
        if self.timeout and self.returncode is None:
            raise subprocess.TimeoutExpired("fixture", timeout)
        if self.returncode is None:
            self.returncode = self.exit_code
        return self.returncode


class CaptureTests(unittest.TestCase):
    def fake(self, process, **options):
        capture = s.StatusCapture(["fixed-status-helper"], {"PATH": "fixture-only"}, Path.cwd(), time.monotonic() + 3,
                                  popen=lambda *a, **kw: process, **options)
        return capture, capture.run()

    def test_exact_caps_and_one_over_each_and_once_kill(self):
        for index, cap in enumerate((s.STDOUT_CAP, s.STDERR_CAP)):
            for extra in (0, 1):
                with self.subTest(stream=index, extra=extra):
                    p = FakeProcess(b"x" * (cap + extra) if index == 0 else wire(), b"e" * (cap + extra) if index == 1 else b"")
                    c, (raw, clean) = self.fake(p)
                    self.assertTrue(clean)
                    self.assertEqual(len(c.buffers[index]), cap)
                    self.assertEqual(raw is None, extra == 1)
                    self.assertLessEqual(p.kills, 1)
                    self.assertTrue(p.stdout.closed and p.stderr.closed)
                    self.assertTrue(c.reaped)
                    self.assertTrue(all(not t.is_alive() and not t.daemon for t in c.threads))
                    self.assertTrue(all(0 <= t <= 3 for t in p.waits))
        p = FakeProcess(b"x" * (s.STDOUT_CAP + 1), b"e" * (s.STDERR_CAP + 1))
        c, (raw, clean) = self.fake(p)
        self.assertIsNone(raw); self.assertTrue(clean); self.assertLessEqual(p.kills, 1)
        self.assertTrue(c.kill_attempted)

    def test_nonzero_timeout_reader_error_no_partial_success(self):
        for process in (FakeProcess(wire(), exit_code=1), FakeProcess(wire(), timeout=True)):
            c, (raw, clean) = self.fake(process)
            self.assertIsNone(raw); self.assertTrue(clean); self.assertTrue(c.kill_attempted)
        class BadPipe(io.BytesIO):
            def read(self, n):
                raise OSError("synthetic private error not on wire")
        p = FakeProcess(wire()); p.stdout = BadPipe()
        _, (raw, clean) = self.fake(p)
        self.assertIsNone(raw); self.assertTrue(clean)

    def test_real_benign_child_simultaneous_full_pipes_and_split_utf8(self):
        # The tested process is this Python, isolated and without imports of product code.
        code = "import os,threading; a=threading.Thread(target=lambda:os.write(2,b'e'*16384)); a.start(); os.write(1,b'x'*4194304); a.join()"
        c = s.StatusCapture([sys.executable, "-I", "-B", "-c", code], dict(os.environ), Path.cwd(), time.monotonic() + 3)
        raw, clean = c.run()
        self.assertTrue(clean); self.assertEqual(len(raw), s.STDOUT_CAP)
        self.assertEqual(len(c.buffers[1]), s.STDERR_CAP); self.assertTrue(c.reaped)
        self.assertTrue(all(not t.is_alive() for t in c.threads))
        self.assertTrue(c.process.stdout.closed and c.process.stderr.closed)
        encoded = wire(goal="Synthetic €")
        split = encoded.index("€".encode("utf-8")) + 1
        code = "import os; os.write(1," + repr(encoded[:split]) + "); os.write(1," + repr(encoded[split:]) + ")"
        c = s.StatusCapture([sys.executable, "-I", "-B", "-c", code], dict(os.environ), Path.cwd(), time.monotonic() + 3)
        raw, clean = c.run()
        self.assertTrue(clean); self.assertEqual(s.parse_projection(raw, JOB)["goal"], "Synthetic €")

    def test_real_benign_overflow_and_deadline_kill_direct_child_reap(self):
        for code in ("import os; os.write(1,b'x'*4194305)", "import os; os.write(2,b'e'*16385)", "import time; time.sleep(10)"):
            c = s.StatusCapture([sys.executable, "-I", "-B", "-c", code], dict(os.environ), Path.cwd(), time.monotonic() + 3)
            started = time.monotonic(); raw, clean = c.run()
            self.assertIsNone(raw); self.assertTrue(clean); self.assertTrue(c.kill_attempted)
            self.assertLess(time.monotonic() - started, 3)
            self.assertTrue(c.reaped); self.assertTrue(all(not t.is_alive() for t in c.threads))

    def test_split_utf8_stream_is_decoded_only_after_capture(self):
        class BytePipe(io.BytesIO):
            def read(self, n):
                self.assert_chunk = n
                return super().read(min(n, 1))
        p = FakeProcess(wire(goal="Synthetic €")); p.stdout = BytePipe(wire(goal="Synthetic €"))
        c, (raw, clean) = self.fake(p)
        self.assertTrue(clean); self.assertEqual(s.parse_projection(raw, JOB)["goal"], "Synthetic €")
        self.assertLessEqual(p.stdout.assert_chunk, 64 * 1024)
        self.assertIsNone(s.parse_projection(wire(goal="Synthetic €").replace("€".encode(), b"\xff"), JOB))

    def test_abnormal_pipe_cleanup_retains_refs_then_explicit_nonblocking_check(self):
        release = threading.Event()
        class StuckPipe(io.BytesIO):
            def read(self, n):
                release.wait(2)
                return b""
        p = FakeProcess(wire()); p.stdout = StuckPipe()
        c = s.StatusCapture(["fixture"], {}, Path.cwd(), time.monotonic() + .65, popen=lambda *a, **kw: p)
        try:
            raw, clean = c.run()
            self.assertIsNone(raw); self.assertFalse(clean)
            self.assertFalse(c.cleanup(nonblocking=True)); self.assertIs(c.process, p)
        finally:
            release.set()
            for thread in c.threads:
                thread.join(timeout=1)
        self.assertTrue(c.cleanup(nonblocking=True))

    def test_no_spawn_after_execution_cutoff_and_popen_options(self):
        with patch.object(s.subprocess, "Popen") as popen:
            c = s.StatusCapture(["fixed"], {}, Path.cwd(), time.monotonic(), popen=popen)
            self.assertEqual(c.run(), (None, True)); popen.assert_not_called()
        p = FakeProcess(wire())
        def spawn(argv, **kwargs):
            self.assertEqual(argv, ["fixed"]); self.assertFalse(kwargs["shell"])
            self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
            self.assertEqual(kwargs["stdout"], subprocess.PIPE); self.assertEqual(kwargs["stderr"], subprocess.PIPE)
            self.assertEqual(kwargs["env"], {"PATH": "isolated"}); self.assertEqual(kwargs["bufsize"], 0)
            self.assertEqual(kwargs["cwd"], Path.cwd()); return p
        c = s.StatusCapture(["fixed"], {"PATH": "isolated"}, Path.cwd(), time.monotonic() + 3, popen=spawn)
        self.assertIsNotNone(c.run()[0])

    def test_closed_projection_and_job_id_grammar_strict_utf8(self):
        self.assertEqual(s.parse_projection(wire(), JOB), projection())
        self.assertIsNotNone(s.parse_projection(wire(readMaxTurns=32, counters={"readTurnsLeft": 32}), JOB))
        for raw in (b"", b"job projection: {}", wire() + wire(), b"preamble\n" + wire(), wire() + b"\xff", wire(jobId=OTHER), wire(active=1), wire(kind="saved-allowance"), wire(liveRead={"ready": True}), wire()[:-4]):
            self.assertIsNone(s.parse_projection(raw, JOB), raw[:80])
        self.assertFalse(s.valid_job_id("request:valid")); self.assertFalse(s.valid_job_id("fixture-job"))
        self.assertTrue(s.valid_job_id(JOB.upper()))
        self.assertIsNone(s.parse_projection(wire(jobId=JOB.upper()), JOB))
        self.assertEqual(s.unavailable(JOB), {"source": "unavailable", "job": None, "jobId": JOB, "reason": s.REASON})


class InFlightTests(unittest.TestCase):
    def fixture(self, *, clean=True, invalid_base=False):
        started, release = threading.Event(), threading.Event()
        calls, captures = [], []
        base = {"value": "before"}
        class Capture:
            def __init__(self, argv, env, cwd, deadline):
                self.deadline = deadline; self.cleaned = clean
                calls.append(argv); captures.append(self)
            def run(self):
                started.set(); release.wait(2)
                return wire(), self.cleaned
            def cleanup(self, **kw): return self.cleaned
            def kill_once(self): pass
        manager = s.InFlightStatus(lambda job: ["fixed", job], lambda: {}, Path.cwd(), lambda job: None if invalid_base else dict(base), capture=Capture)
        return manager, started, release, calls, captures, base

    def test_same_job_join_different_job_busy_mutation_suppresses_both_then_no_cache(self):
        m, started, release, calls, captures, base = self.fixture()
        results = []
        leader = threading.Thread(target=lambda: results.append(m.read(JOB)))
        leader.start(); self.assertTrue(started.wait(1))
        waiter = threading.Thread(target=lambda: results.append(m.read(JOB)))
        waiter.start()
        self.assertEqual(m.read(OTHER)["source"], "unavailable"); self.assertEqual(len(calls), 1)
        original = m.entry["deadline"]
        self.assertEqual(captures[0].deadline, original)
        m.invalidate()
        self.assertEqual(m.read(JOB)["source"], "unavailable"); self.assertEqual(len(calls), 1)
        release.set(); leader.join(1); waiter.join(1)
        self.assertFalse(leader.is_alive() or waiter.is_alive())
        self.assertEqual([r["source"] for r in results], ["unavailable", "unavailable"])
        self.assertIsNone(m.entry)
        self.assertEqual(m.read(JOB)["source"], "host-status"); self.assertEqual(len(calls), 2)
        self.assertIsNone(m.entry)  # No TTL/last-good result.

    def test_normal_same_job_waiters_get_one_pending_read_not_a_result_cache(self):
        m, started, release, calls, captures, base = self.fixture()
        results = []; waiting = threading.Event()
        leader = threading.Thread(target=lambda: results.append(m.read(JOB))); leader.start(); started.wait(1)
        original_wait = m.entry["done"].wait
        def wait(timeout):
            waiting.set(); return original_wait(timeout)
        m.entry["done"].wait = wait
        waiter = threading.Thread(target=lambda: results.append(m.read(JOB))); waiter.start(); self.assertTrue(waiting.wait(1))
        release.set(); leader.join(1); waiter.join(1)
        self.assertEqual([r["source"] for r in results], ["host-status", "host-status"])
        self.assertEqual(len(calls), 1); self.assertIsNone(m.entry)

    def test_cleanup_pending_blocks_replacement_and_explicit_read_can_finish_cleanup(self):
        m, started, release, calls, captures, base = self.fixture(clean=False)
        release.set()
        self.assertEqual(m.read(JOB)["source"], "unavailable")
        self.assertIsNotNone(m.entry)
        self.assertEqual(m.read(JOB)["source"], "unavailable"); self.assertEqual(m.read(OTHER)["source"], "unavailable")
        self.assertEqual(len(calls), 1)
        captures[0].cleaned = True
        self.assertEqual(m.read(JOB)["source"], "unavailable"); self.assertEqual(len(calls), 2)

    def test_external_base_change_and_exception_cleanup_never_publish_old_ack(self):
        m, started, release, calls, captures, base = self.fixture()
        result = []
        thread = threading.Thread(target=lambda: result.append(m.read(JOB))); thread.start(); started.wait(1)
        base["value"] = "changed"; release.set(); thread.join(1)
        self.assertEqual(result[0]["source"], "unavailable"); self.assertIsNone(m.entry)
        m.base_for = lambda job: (_ for _ in ()).throw(OSError("private fixture"))
        self.assertEqual(m.read(JOB)["source"], "unavailable"); self.assertIsNone(m.entry)
        self.assertEqual(len(calls), 1)

    def test_waiter_uses_original_deadline_does_not_start_replacement(self):
        m, started, release, calls, captures, base = self.fixture()
        result = []
        thread = threading.Thread(target=lambda: result.append(m.read(JOB))); thread.start(); started.wait(1)
        # Controlled clock for deterministic remaining-time behavior, not a shorter production deadline.
        m.clock = lambda: m.entry["deadline"] + 1
        self.assertEqual(m.read(JOB)["source"], "unavailable"); self.assertEqual(len(calls), 1)
        m.clock = time.monotonic; release.set(); thread.join(1)
        self.assertIsNone(m.entry)

    def test_mutation_before_helper_launch_invalidates_without_spawning(self):
        m, _, release, calls, _, _ = self.fixture()
        def base(job):
            m.invalidate(); return {"known": True}
        m.base_for = base
        self.assertEqual(m.read(JOB)["source"], "unavailable")
        self.assertEqual(calls, []); self.assertIsNone(m.entry)

    def test_profiles_do_not_share_and_bad_id_never_calls_runner(self):
        m, _, release, calls, _, _ = self.fixture(); release.set()
        n, _, other_release, other_calls, _, _ = self.fixture(); other_release.set()
        self.assertEqual(m.read("request:valid")["source"], "unavailable"); self.assertEqual(calls, [])
        self.assertEqual(m.read(JOB)["source"], "host-status")
        self.assertEqual(n.read(JOB)["source"], "host-status")
        self.assertEqual(len(calls), 1); self.assertEqual(len(other_calls), 1)


if __name__ == "__main__":
    unittest.main()
