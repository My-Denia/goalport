"""Transient exact-job display reads. No admission, control client or status cache.

The HTTP leader owns the direct, childless status CLI and two finite pipe readers.
An OS cleanup that cannot finish in the budget remains owned and blocks replacement.
"""
import json
import re
import subprocess
import threading
import time

JOB_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
REASON = "The open allowance could not be confirmed."
TOTAL_SECONDS = 3.0
CLEANUP_SECONDS = 0.5
STDOUT_CAP = 4 * 1024 * 1024
STDERR_CAP = 16 * 1024
STATES = {"admitted", "running", "revoked", "completed", "failed", "stopped", "unconfirmed"}
REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,256}$")
LIVE_FIELDS = {"mode", "ready", "initialRequestId", "fromRequestId", "rootRequestId", "remainingReads", "readonly", "pending", "revoked", "childRequestId", "expiresAt", "reason"}


def valid_job_id(value):
    return isinstance(value, str) and JOB_ID.fullmatch(value) is not None


def request_id(value):
    return isinstance(value, str) and REQUEST_ID.fullmatch(value) is not None


def unavailable(job_id):
    return {"source": "unavailable", "job": None, "jobId": job_id, "reason": REASON}


def valid_live(value):
    if not isinstance(value, dict) or set(value) != LIVE_FIELDS:
        return False
    from datetime import datetime
    expires = value["expiresAt"]
    if expires is not None:
        try:
            if not isinstance(expires, str):
                return False
            datetime.fromisoformat(expires.replace("Z", "+00:00"))
        except ValueError:
            return False
    remaining = value["remainingReads"]
    child = value["childRequestId"]
    return (value["mode"] == "live-read-once" and request_id(value["initialRequestId"])
            and value["fromRequestId"] == value["initialRequestId"] and request_id(value["rootRequestId"])
            and all(type(value[k]) is bool for k in ("ready", "readonly", "pending", "revoked"))
            and (remaining is None or (type(remaining) is int and 0 <= remaining <= 4))
            and (child is None or (request_id(child) and child != value["initialRequestId"]))
            and value["reason"] in (None, "busy", "revoked", "expired", "no-live-scope", "not-enough-reads", "unconfirmed", "context-unavailable")
            and (not value["ready"] or (value["readonly"] and not value["pending"] and not value["revoked"]
                 and child is None and remaining is not None and remaining >= 2 and expires is not None and value["reason"] is None)))


def valid_projection(job, job_id):
    """Wire shape only; the existing Node host remains the store/ACK authority."""
    if not isinstance(job, dict) or "kind" in job or job.get("jobId") != job_id or not request_id(job.get("requestId")):
        return False
    if not all(isinstance(job.get(k), str) for k in ("goal", "workspacePath")) or job.get("state") not in STATES:
        return False
    if not all(type(job.get(k)) is bool for k in ("active", "live", "revoked")):
        return False
    if not (job.get("workerPid") is None or (type(job["workerPid"]) is int and job["workerPid"] > 0)):
        return False
    if not all(k in job for k in ("workerPid", "counters", "pendingCommand", "completedCommands", "progress", "outcome", "readMaxTurns", "writeMaxTurns")):
        return False
    if type(job["readMaxTurns"]) is not int or not 2 <= job["readMaxTurns"] <= 32:
        return False
    if job["writeMaxTurns"] is not None and (type(job["writeMaxTurns"]) is not int or not 1 <= job["writeMaxTurns"] <= 8):
        return False
    counters = job["counters"]
    if counters is not None and (not isinstance(counters, dict) or set(counters) - {"readTurnsLeft", "writeTurnsLeft"}
            or any(v is not None and (type(v) is not int or not 0 <= v <= (32 if k == "readTurnsLeft" else 8)) for k, v in counters.items())):
        return False
    pending = job["pendingCommand"]
    if pending is not None and (not isinstance(pending, dict) or not all(isinstance(pending.get(k), str) for k in ("commandId", "state"))):
        return False
    if not isinstance(job["completedCommands"], list) or any(not isinstance(c, dict) or not isinstance(c.get("commandId"), str) or not isinstance(c.get("facts"), dict) for c in job["completedCommands"]):
        return False
    if job["progress"] is not None and not isinstance(job["progress"], dict):
        return False
    if job["outcome"] is not None and (not isinstance(job["outcome"], dict) or not isinstance(job["outcome"].get("status"), str)):
        return False
    if "phase" in job and job["phase"] is not None and not isinstance(job["phase"], str):
        return False
    if "followUpMode" in job and job["followUpMode"] != "live-read-once":
        return False
    if "acceptedRequestId" in job and not request_id(job["acceptedRequestId"]):
        return False
    if "liveRead" in job and (job.get("followUpMode") != "live-read-once" or not job["live"] or not valid_live(job["liveRead"])
            or job["liveRead"]["initialRequestId"] != job["requestId"]):
        return False
    live = job.get("liveRead")
    if live and live["ready"] and (not job["active"] or job["state"] != "running" or job["revoked"] or job["pendingCommand"] is not None or job.get("phase") != "awaiting-followup"):
        return False
    return True


def parse_projection(raw, job_id):
    try:
        lines = [line for line in raw.decode("utf-8", errors="strict").splitlines() if line.strip()]
        if len(lines) != 1 or not lines[0].startswith("job projection: "):
            return None
        job = json.loads(lines[0][len("job projection: "):])
        return job if valid_projection(job, job_id) else None
    except (UnicodeError, ValueError, TypeError):
        return None


def parse_native_preflight(raw, workspace):
    """Separate fixed projection, not the UUID job/status wire contract."""
    try:
        lines = [line for line in raw.decode("utf-8", errors="strict").splitlines() if line.strip()]
        prefix = "native preflight: "
        if len(lines) != 1 or not lines[0].startswith(prefix):
            return False
        value = json.loads(lines[0][len(prefix):])
        global_mode = workspace is None
        if not isinstance(value, dict) or set(value) != ({"mode", "outstanding", "inventory"} if global_mode else {"mode", "workspace", "outstanding", "inventory"}):
            return False
        if value["mode"] != ("global" if global_mode else "workspace") or value["outstanding"] is not False:
            return False
        inventory = value["inventory"]
        if not isinstance(inventory, dict) or inventory.get("complete") is not True or inventory.get("globalBlock") is not False or not isinstance(inventory.get("holds"), list):
            return False
        if global_mode:
            return set(inventory) == {"holds", "complete", "globalBlock"} and inventory["holds"] == []
        return (set(inventory) == {"holds", "complete", "globalBlock", "candidate", "candidateBlocked"}
                and value["workspace"] == workspace and inventory["candidate"] == workspace
                and inventory["candidateBlocked"] is False
                and all(isinstance(hold, dict) and set(hold) == {"jobId", "workspacePath"}
                        and valid_job_id(hold["jobId"]) and isinstance(hold["workspacePath"], str)
                        and hold["workspacePath"].startswith("/") for hold in inventory["holds"]))
    except (UnicodeError, ValueError, TypeError, KeyError):
        return False


class StatusCapture:
    def __init__(self, argv, env, cwd, deadline, *, popen=subprocess.Popen, clock=time.monotonic):
        self.argv, self.env, self.cwd, self.deadline = argv, env, cwd, deadline
        self.popen, self.clock = popen, clock
        self.process = None
        self.threads = []
        self.buffers = [bytearray(), bytearray()]
        self.eof = [False, False]
        self.failed = threading.Event()
        self.kill_lock = threading.Lock()
        self.kill_attempted = False
        self.reaped = False

    def kill_once(self):
        self.failed.set()
        with self.kill_lock:
            if not self.kill_attempted and self.process is not None:
                self.kill_attempted = True
                try:
                    if self.process.poll() is None:
                        self.process.kill()  # Only the direct owned, childless status helper.
                except OSError:
                    pass

    def drain(self, index, pipe, cap):
        try:
            while True:
                # Unbuffered Popen pipes: read returns available bytes, <=64KiB.
                chunk = pipe.read(64 * 1024)
                if not chunk:
                    self.eof[index] = True
                    break
                remaining = cap - len(self.buffers[index])
                self.buffers[index].extend(chunk[:remaining])
                if len(chunk) > remaining:
                    self.kill_once()
                # After overflow keep draining/discarding, without growing storage.
        except (OSError, ValueError):
            self.kill_once()
        finally:
            try:
                pipe.close()
            except OSError:
                self.failed.set()

    def cleanup(self, *, nonblocking=False):
        """No autonomous reaper. Later explicit reads may check retained ownership."""
        if self.process is None:
            return True
        remaining = max(0.0, self.deadline - self.clock()) if not nonblocking else 0.0
        try:
            self.process.wait(timeout=remaining)
            self.reaped = True
        except (subprocess.TimeoutExpired, OSError):
            pass
        for thread in self.threads:
            if thread.ident is not None:
                thread.join(timeout=max(0.0, self.deadline - self.clock()) if not nonblocking else 0.0)
        # Reader closes its own pipe; never block a leader closing a locked read.
        return (self.reaped and all(not t.is_alive() for t in self.threads)
                and all(p is None or p.closed for p in (self.process.stdout, self.process.stderr)))

    def run(self):
        cutoff = self.deadline - CLEANUP_SECONDS
        if self.clock() >= cutoff:
            self.failed.set()
            return None, True
        try:
            self.process = self.popen(self.argv, shell=False, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                      env=self.env, cwd=self.cwd)
            for i, (pipe, cap) in enumerate(((self.process.stdout, STDOUT_CAP), (self.process.stderr, STDERR_CAP))):
                thread = threading.Thread(target=self.drain, args=(i, pipe, cap), name=f"workbench-status-pipe-{i}", daemon=False)
                self.threads.append(thread)
                thread.start()
            self.process.wait(timeout=max(0.0, cutoff - self.clock()))
            self.reaped = True
            if self.process.returncode != 0:
                self.kill_once()
            for thread in self.threads:
                thread.join(timeout=max(0.0, cutoff - self.clock()))
            if self.clock() >= cutoff or any(t.is_alive() for t in self.threads):
                self.kill_once()
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            self.kill_once()
            # A thread-start failure must still close pipes not owned by readers.
            if self.process is not None:
                for i, pipe in enumerate((self.process.stdout, self.process.stderr)):
                    if i >= len(self.threads) or self.threads[i].ident is None:
                        if pipe is not None:
                            pipe.close()
        clean = self.cleanup()
        success = clean and self.clock() <= self.deadline and not self.failed.is_set() and all(self.eof)
        return (self.buffers[0] if success else None), clean


class NativePreflight:
    """One bounded explicit read. Retain only unclean helper ownership, never a permit/cache."""
    def __init__(self, env_for, cwd, *, capture=StatusCapture, clock=time.monotonic):
        self.env_for, self.cwd, self.capture, self.clock = env_for, cwd, capture, clock
        self.lock = threading.Lock()
        self.pending = None

    def read(self, argv, workspace=None):
        if not self.lock.acquire(blocking=False):
            return False
        try:
            if self.pending is not None:
                if not self.pending.cleanup(nonblocking=True):
                    return False
                self.pending = None
            self.pending = self.capture(argv, self.env_for(), self.cwd, self.clock() + TOTAL_SECONDS)
            raw, clean = self.pending.run()
            if clean:
                self.pending = None
            return clean and raw is not None and parse_native_preflight(raw, workspace)
        except (OSError, ValueError, TypeError, RuntimeError, AttributeError):
            if self.pending is not None:
                self.pending.kill_once()
                if self.pending.cleanup():
                    self.pending = None
            return False
        finally:
            self.lock.release()


class InFlightStatus:
    """One instance per bound handler/profile. Pending join only, never a cache."""
    def __init__(self, argv_for, env_for, cwd, base_for, *, capture=StatusCapture, clock=time.monotonic):
        self.argv_for, self.env_for, self.cwd, self.base_for = argv_for, env_for, cwd, base_for
        self.capture, self.clock = capture, clock
        self.lock = threading.Lock()
        self.entry = None

    def invalidate(self):
        with self.lock:
            if self.entry is not None:
                self.entry["invalidated"] = True

    def read(self, job_id):
        if not valid_job_id(job_id):
            return unavailable(job_id)
        with self.lock:
            entry = self.entry
            if entry is not None and entry["done"].is_set() and entry["capture"] is not None and entry["capture"].cleanup(nonblocking=True):
                if self.entry is entry:
                    self.entry = None
                entry = None
            if entry is not None:
                if entry["jobId"] != job_id or entry["invalidated"] or entry["done"].is_set():
                    return unavailable(job_id)
                leader = False
            else:
                entry = {"jobId": job_id, "deadline": self.clock() + TOTAL_SECONDS, "done": threading.Event(),
                         "invalidated": False, "result": unavailable(job_id), "capture": None}
                self.entry = entry
                leader = True
        if not leader:
            entry["done"].wait(timeout=max(0.0, entry["deadline"] - self.clock()))
            with self.lock:
                return entry["result"] if entry["done"].is_set() and not entry["invalidated"] else unavailable(job_id)
        clean = True
        try:
            before = self.base_for(job_id)
            argv = self.argv_for(job_id)
            with self.lock:
                valid_entry = self.entry is entry and not entry["invalidated"]
            if argv is not None and before is not None and valid_entry:
                capture = self.capture(argv, self.env_for(), self.cwd, entry["deadline"])
                entry["capture"] = capture
                raw, clean = capture.run()
                job = parse_projection(raw, job_id) if raw is not None and clean else None
                after = self.base_for(job_id)
                if job is not None and before == after and after is not None and self.clock() <= entry["deadline"]:
                    entry["result"] = {"source": "host-status", "job": job, "jobId": job_id}
        except (OSError, ValueError, TypeError, RuntimeError, AttributeError):
            if entry["capture"] is not None:
                entry["capture"].kill_once()
                clean = entry["capture"].cleanup()
        finally:
            with self.lock:
                if entry["invalidated"]:
                    entry["result"] = unavailable(job_id)
                entry["done"].set()
                if clean and self.entry is entry:
                    self.entry = None
        return entry["result"]
