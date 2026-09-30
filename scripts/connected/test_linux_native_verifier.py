"""Tests for verifier assertions and cleanup; never start a vendor Runtime."""
import importlib.util
from pathlib import Path
import signal
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("native_verifier", Path(__file__).with_name("verify-linux-native.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


@unittest.skipUnless(sys.platform == "linux", "Linux process groups")
class CleanupTests(unittest.TestCase):
    def test_child_that_outlives_launcher_and_ignores_term_is_reaped(self):
        child_code = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(30)"
        launcher_code = (
            "import subprocess,sys; "
            f"child=subprocess.Popen([sys.executable,'-c',{child_code!r}],stdout=subprocess.PIPE,text=True); "
            "child.stdout.readline(); print(child.pid,flush=True)"
        )
        launcher = subprocess.Popen([sys.executable, "-c", launcher_code],
                                    stdout=subprocess.PIPE, text=True, start_new_session=True)
        self.addCleanup(lambda: verifier.stop_owned_group(launcher.pid, timeout=0.1))
        child_pid = int(launcher.stdout.readline())
        launcher.wait(timeout=3)
        launcher.stdout.close()
        self.assertIn(child_pid, [pid for pid, _ in verifier.group_members(launcher.pid)])
        result = verifier.stop_owned_group(launcher.pid, timeout=0.15)
        self.assertTrue(result["terminated"], result)
        self.assertTrue(result["escalated"], result)
        self.assertEqual(result["remainingLivePids"], [])


if __name__ == "__main__":
    unittest.main()
