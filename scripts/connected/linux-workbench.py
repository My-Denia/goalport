#!/usr/bin/env python3
"""Serve the existing renderer and forward each request to a Linux Core socket.

The bridge keeps no session, no database, and no second copy of a goal.
It binds to 127.0.0.1 only. If Core cannot be reached, the HTTP response
says so and the page stays disconnected — it does not invent preview data.

  python3 scripts/connected/linux-workbench.py --endpoint /tmp/goalport-dev/core.sock
"""
import argparse
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
FLAG = '<script>window.__GOALPORT_LINUX_CORE__={bridge:"/goalport/ipc"};</script>'


def load_unix_client():
    path = Path(__file__).with_name("unix-client.py")
    spec = importlib.util.spec_from_file_location("goalport_unix_client", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inject_linux_flag(html: str) -> str:
    # The desktop build uses relative asset URLs so file:// still works.
    # This page is served at / and at /goals/<id>, so those URLs must be root-absolute.
    html = html.replace('src="./', 'src="/').replace("src='./", "src='/")
    html = html.replace('href="./', 'href="/').replace("href='./", "href='/")
    if "__GOALPORT_LINUX_CORE__" in html:
        return html
    if "<head>" in html:
        return html.replace("<head>", "<head>" + FLAG, 1)
    return FLAG + html


def disconnected_body(message: str) -> bytes:
    return json.dumps({
        "ok": False,
        "error": message,
        "connection": "disconnected",
    }).encode()


def expected_host(port: int) -> str:
    return "127.0.0.1" if port == 80 else f"127.0.0.1:{port}"


def expected_origin(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def admit_request(headers, port: int, *, mutation: bool) -> str | None:
    """Reject a browser page that is not this workbench.

    application/json is not a CORS-simple content type, but text/plain is.
    A page on another origin can POST text/plain to 127.0.0.1 without a
    preflight, and the bridge would otherwise deliver that body to Core.
    Host blocks a DNS name that merely resolves here. A missing Origin is
    allowed so a local operator client can call the bridge; a browser POST
    always sends Origin.
    """
    host = headers.get("host", "")
    if host != expected_host(port):
        return "Workbench host is not the local page"
    origin = headers.get("origin")
    if origin is not None and origin != expected_origin(port):
        return "Workbench origin is not the local page"
    site = headers.get("sec-fetch-site")
    if site is not None and site not in {"same-origin", "none"}:
        return "Workbench request is not from this page"
    if mutation:
        content_type = headers.get("content-type", "")
        media_type = content_type.split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            return "Workbench requests must use application/json"
    return None


def safe_file(dist: Path, url_path: str) -> Path | None:
    relative = unquote(url_path.split("?", 1)[0]).lstrip("/")
    # /goals/<campaignId> is the page for one goal. Refresh must get the app,
    # not a missing file, so the route can be read back.
    if not relative or relative.startswith("goals/"):
        relative = "index.html"
    candidate = (dist / relative).resolve()
    try:
        candidate.relative_to(dist.resolve())
    except ValueError:
        return None
    if candidate.is_file():
        return candidate
    return None


def coordination_child_env(base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(base or os.environ)
    local_bin = str(Path.home() / ".local" / "bin")
    if Path(local_bin).is_dir():
        current = env.get("PATH", "")
        parts = current.split(":") if current else []
        if local_bin not in parts:
            env["PATH"] = local_bin + (":" + current if current else "")
    return env


def worker_alive(pid: int) -> bool:
    if os.name == "nt" or pid <= 0:
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def activity_line(progress: dict, pid: object, alive=worker_alive) -> str | None:
    if isinstance(pid, int) and pid > 0 and not alive(pid):
        return "The worker is gone. Its exit is not confirmed, so another goal cannot start yet."
    display = progress.get("display") if isinstance(progress.get("display"), dict) else {}
    activity = display.get("activity") if isinstance(display.get("activity"), str) else None
    return activity or (progress.get("state") if isinstance(progress.get("state"), str) else None)


def current_job(data_dir: Path) -> dict | None:
    """The active job, if it has not settled. Older saved records must not cover it."""
    active_path = data_dir / "coordination-jobs" / "active-admission.json"
    if not active_path.is_file():
        return None
    try:
        active = json.loads(active_path.read_text(encoding="utf-8"))
        job_id = active.get("jobId")
        if not isinstance(job_id, str) or not job_id:
            return None
        if (data_dir / "coordination-jobs" / "jobs" / job_id / "stuck-ack.json").is_file():
            return None
        progress_path = data_dir / "coordination-jobs" / "jobs" / job_id / "progress.json"
        if not progress_path.is_file():
            claim_path = data_dir / "coordination-jobs" / "jobs" / job_id / "startup-claim.json"
            pid = None
            try:
                claim = json.loads(claim_path.read_text(encoding="utf-8"))
                if isinstance(claim, dict):
                    pid = claim.get("pid")
            except (OSError, json.JSONDecodeError, TypeError):
                pid = None
            if isinstance(pid, int) and pid > 0 and not worker_alive(pid):
                return {"line": "The worker is gone. Its exit is not confirmed, so another goal cannot start yet.", "jobId": job_id}
            return {"line": "The goal was admitted.", "jobId": job_id}
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return None
    if not isinstance(progress, dict):
        return None
    settled = progress.get("state") in {"completed", "failed", "stopped"} and progress.get("outcome") and not progress.get("pendingCommand")
    if settled:
        return None
    claim_path = data_dir / "coordination-jobs" / "jobs" / job_id / "startup-claim.json"
    pid = None
    try:
        claim = json.loads(claim_path.read_text(encoding="utf-8"))
        if isinstance(claim, dict):
            pid = claim.get("pid")
    except (OSError, json.JSONDecodeError, TypeError):
        pid = None
    line = activity_line(progress, pid)
    if not line:
        return None
    return {"line": line, "jobId": job_id}


def live_fields(data_dir: Path | None) -> dict:
    job = current_job(data_dir) if data_dir is not None else None
    return {"line": job["line"] if job else None, "jobId": job["jobId"] if job else None}


def folded_text(record: dict, key: str, outcome: str | None) -> str | None:
    text = record.get(key)
    if not isinstance(text, str):
        return None
    line = text.strip()
    if not line or line == outcome:
        return None
    return line if len(line) <= 600 else line[:597] + "..."


def check_detail(record: dict, outcome: str | None) -> str | None:
    return folded_text(record, "auditText", outcome) or folded_text(record, "reviewText", outcome)


def short_outcome(record: dict) -> str | None:
    for key in ("result", "reviewText", "stopReason"):
        text = record.get(key)
        if not isinstance(text, str):
            continue
        line = " ".join(text.split())
        if not line:
            continue
        return line if len(line) <= 180 else line[:177] + "..."
    return None


def left_request_ids(data_dir: Path) -> list[str]:
    jobs = data_dir / "coordination-jobs" / "jobs"
    if not jobs.is_dir():
        return []
    found = []
    for job_dir in jobs.iterdir():
        if not job_dir.is_dir() or not (job_dir / "stuck-ack.json").is_file():
            continue
        try:
            admission = json.loads((job_dir / "admission.json").read_text(encoding="utf-8"))
            request_id = admission.get("input", {}).get("requestId") if isinstance(admission, dict) else None
        except (OSError, json.JSONDecodeError, TypeError, AttributeError):
            continue
        if isinstance(request_id, str) and request_id and request_id not in found:
            found.append(request_id)
    return found


def disk_unconfirmed(data_dir: Path | None) -> bool:
    jobs = data_dir / "coordination-jobs" / "jobs" if data_dir is not None else None
    if jobs is None or not jobs.is_dir():
        return False
    for job_dir in jobs.iterdir():
        if not job_dir.is_dir():
            continue
        try:
            progress = json.loads((job_dir / "progress.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(progress, dict):
            continue
        if progress.get("state") == "unconfirmed" or progress.get("outcome") == "unconfirmed" or isinstance(progress.get("pendingCommand"), dict):
            return True
    return False


def latest_coordination_record(data_dir: Path | None) -> dict:
    """Read the last saved coordinated-goal record. No tokens, no plan body."""
    if data_dir is None:
        return {"ok": True, "record": None, "reason": "no coordination profile configured"}
    path = data_dir / "coordination-records.json"
    if not path.is_file():
        return {"ok": True, "record": None, "leftRequestIds": left_request_ids(data_dir), "unconfirmedGoal": disk_unconfirmed(data_dir), **live_fields(data_dir), "reason": "no coordinated result saved"}
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"ok": False, "record": None, "leftRequestIds": left_request_ids(data_dir), "unconfirmedGoal": disk_unconfirmed(data_dir), "reason": "coordinated result could not be read"}
    if not isinstance(records, list) or not records or not isinstance(records[-1], dict):
        return {"ok": True, "record": None, "leftRequestIds": left_request_ids(data_dir), "unconfirmedGoal": disk_unconfirmed(data_dir), **live_fields(data_dir), "reason": "no coordinated result saved"}
    last = records[-1]
    return {
        "ok": True,
        "record": {
            "requestId": last.get("requestId"),
            "verdict": last.get("verdict"),
            "stopReason": last.get("stopReason"),
            "planningHarness": last.get("planningHarness"),
            "reviewHarness": last.get("reviewHarness"),
            "messageDispatched": last.get("messageDispatched"),
            "goal": last.get("goal"),
            "workspacePath": last.get("workspacePath"),
            "outcome": short_outcome(last),
            "detail": check_detail(last, short_outcome(last)),
            "change": folded_text(last, "executionText", short_outcome(last)),
        },
        "reason": None,
        "leftRequestIds": left_request_ids(data_dir),
        "unconfirmedGoal": disk_unconfirmed(data_dir),
        **live_fields(data_dir),
    }


def subscription_harnesses(stdout: str) -> list[str]:
    found = []
    blocked = set()
    current = None
    for line in stdout.splitlines():
        if line.startswith("provider "):
            current = None
            if "authenticated" not in line or ("(subscription)" not in line and "(chatgpt)" not in line):
                continue
            name = line.split(":", 1)[0].removeprefix("provider ").strip()
            if name:
                current = name
                found.append(name)
            continue
        if current and "environment blocked since" in line:
            blocked.add(current)
    return [name for name in found if name not in blocked]


def subscription_harness_sentence(stdout: str) -> str | None:
    found = subscription_harnesses(stdout)
    if len(found) >= 2:
        return None
    if len(found) == 1:
        return "An independent check needs a second logged-in harness, so nothing will be sent."
    return "No installed subscription harness was found on this machine, so nothing will be sent."


def consent_missing(stdout: str) -> bool:
    return "consent: granted" not in stdout


def leftover_left_job(data_dir: Path | None) -> str | None:
    if data_dir is None:
        return None
    try:
        active = json.loads((data_dir / "coordination-jobs" / "active-admission.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    job_id = active.get("jobId") if isinstance(active, dict) else None
    if not isinstance(job_id, str) or not job_id:
        return None
    if not (data_dir / "coordination-jobs" / "jobs" / job_id / "stuck-ack.json").is_file():
        return None
    return job_id


def coordination_acknowledge_command(data_dir: Path | None, repo_root: Path, endpoint: str | None = None, core_binary: str | None = None) -> tuple[list[str] | None, str | None]:
    job = current_job(data_dir) if data_dir is not None else None
    job_id = job.get("jobId") if isinstance(job, dict) else leftover_left_job(data_dir)
    if not isinstance(job_id, str) or not job_id:
        return None, "No coordinated goal to leave."
    if not all(character.isalnum() or character in "._-" for character in job_id):
        return None, "The goal id is invalid, so it was not left."
    prefix, error = coordination_cli_prefix(data_dir, repo_root, endpoint, core_binary)
    if error:
        return None, error
    return [*prefix, "acknowledge", "--job", job_id], None


def coordination_grant_command(data_dir: Path | None, repo_root: Path, endpoint: str | None = None, core_binary: str | None = None) -> tuple[list[str] | None, str | None]:
    prefix, error = coordination_cli_prefix(data_dir, repo_root, endpoint, core_binary)
    if error:
        return None, error
    return [*prefix, "grant-access"], None


def coordination_cli_prefix(data_dir: Path, repo_root: Path, endpoint: str | None, core_binary: str | None) -> tuple[list[str] | None, str | None]:
    if not endpoint:
        return None, "The Core socket is required, so nothing was admitted."
    if not core_binary or not (core_binary.startswith("/") or Path(core_binary).is_absolute()):
        return None, "The Core executable is required: pass --core-binary with an absolute path, so nothing was admitted."
    return [
        "node", str(repo_root / "scripts" / "connected" / "linux-coordinate.mjs"),
        "--data-dir", str(data_dir), "--pipe", endpoint, "--core-binary", core_binary,
    ], None


KEEP_RUNNING_SENTENCE = "Keep working after closing must be explicitly selected."


def checked_instances(instances: object) -> tuple[str | None, str | None]:
    if instances is None or instances == "":
        return None, None
    if not isinstance(instances, str):
        return None, "A harness id is invalid, so nothing was admitted."
    names = [part.strip() for part in instances.split(",") if part.strip()]
    if not names or any(not all(character.isalnum() or character in "._-" for character in name) for name in names):
        return None, "A harness id is invalid, so nothing was admitted."
    return ",".join(names), None


def coordination_continue_command(data_dir: Path | None, repo_root: Path, endpoint: str | None = None, core_binary: str | None = None, follow_up: object = None, write: object = False, background: object = False, instances: object = None) -> tuple[list[str] | None, str | None]:
    if background is not True:
        return None, KEEP_RUNNING_SENTENCE
    found = latest_coordination_record(data_dir)
    record = found.get("record") if isinstance(found, dict) else None
    request_id = record.get("requestId") if isinstance(record, dict) else None
    if data_dir is None or not isinstance(request_id, str) or not request_id:
        return None, "No saved coordinated goal to continue."
    prefix, error = coordination_cli_prefix(data_dir, repo_root, endpoint, core_binary)
    if error:
        return None, error
    saved_goal = record.get("goal") if isinstance(record.get("goal"), str) and record.get("goal") else "Continue the saved goal"
    goal = follow_up.strip() if isinstance(follow_up, str) and follow_up.strip() else saved_goal
    argv = [*prefix, "continue", "--from", request_id, "--goal", goal, "--background"]
    workspace = record.get("workspacePath")
    if isinstance(workspace, str) and workspace:
        argv.extend(["--workspace", workspace])
    if write is True:
        argv.extend(["--write-instances", "codex", "--write-turns", "1"])
    names, names_error = checked_instances(instances)
    if names_error:
        return None, names_error
    if names:
        argv.extend(["--instances", names])
    return argv, None


def expand_workspace(workspace: str) -> str:
    if workspace == "~":
        return str(Path.home())
    if workspace.startswith("~/"):
        return str(Path.home() / workspace[2:])
    return workspace


def coordination_start_command(data_dir: Path | None, repo_root: Path, goal: object, workspace: object, write: object = False, endpoint: str | None = None, core_binary: str | None = None, background: object = False, instances: object = None) -> tuple[list[str] | None, str | None]:
    if data_dir is None:
        return None, "No coordination profile is configured, so nothing was admitted."
    if not isinstance(goal, str) or not goal.strip():
        return None, "A goal is required, so nothing was admitted."
    if not isinstance(workspace, str):
        return None, "The workspace must be an absolute path, so nothing was admitted."
    workspace = expand_workspace(workspace.strip())
    if not (workspace.startswith("/") or Path(workspace).is_absolute()):
        return None, "The workspace must be an absolute path, so nothing was admitted."
    if background is not True:
        return None, KEEP_RUNNING_SENTENCE
    prefix, error = coordination_cli_prefix(data_dir, repo_root, endpoint, core_binary)
    if error:
        return None, error
    argv = [*prefix, "run", "--goal", goal.strip(), "--workspace", workspace, "--background"]
    if write is True:
        argv.extend(["--write-instances", "codex", "--write-turns", "1"])
    names, names_error = checked_instances(instances)
    if names_error:
        return None, names_error
    if names:
        argv.extend(["--instances", names])
    return argv, None


def coordination_stop_command(data_dir: Path | None, repo_root: Path, endpoint: str | None = None, core_binary: str | None = None) -> tuple[list[str] | None, str | None]:
    job = current_job(data_dir) if data_dir is not None else None
    job_id = job.get("jobId") if isinstance(job, dict) else None
    if not isinstance(job_id, str) or not job_id:
        return None, "No running coordinated goal to stop."
    if not all(character.isalnum() or character in "._-" for character in job_id):
        return None, "The running goal id is invalid, so nothing was stopped."
    prefix, error = coordination_cli_prefix(data_dir, repo_root, endpoint, core_binary)
    if error:
        return None, error
    return [*prefix, "stop", "--job", job_id], None


def make_handler(endpoint: str, dist: Path, unix_client, timeout: float, coordination_data: Path | None = None, continue_runner=None, core_binary: str | None = None):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            return

        def _port(self) -> int:
            return int(self.server.server_address[1])

        def do_OPTIONS(self):
            self._send(403, b'{"ok":false,"error":"Workbench does not accept cross-origin preflight"}', "application/json")

        def do_GET(self):
            refusal = admit_request(self.headers, self._port(), mutation=False)
            if refusal:
                self._send(403, disconnected_body(refusal), "application/json")
                return
            if self.path.split("?", 1)[0] == "/goalport/ipc":
                self._send(405, b'{"ok":false,"error":"POST one Core request"}', "application/json")
                return
            target = safe_file(dist, self.path)
            if target is None:
                self._send(404, b"Not found", "text/plain; charset=utf-8")
                return
            body = target.read_bytes()
            content_type = "application/octet-stream"
            if target.suffix == ".html":
                body = inject_linux_flag(body.decode("utf-8")).encode()
                content_type = "text/html; charset=utf-8"
            elif target.suffix == ".js":
                content_type = "text/javascript; charset=utf-8"
            elif target.suffix == ".css":
                content_type = "text/css; charset=utf-8"
            elif target.suffix == ".svg":
                content_type = "image/svg+xml"
            self._send(200, body, content_type)

        def do_POST(self):
            refusal = admit_request(self.headers, self._port(), mutation=True)
            if refusal:
                self._send(403, disconnected_body(refusal), "application/json")
                return
            if self.path.split("?", 1)[0] != "/goalport/ipc":
                self._send(404, disconnected_body("Unknown bridge path"), "application/json")
                return
            length = int(self.headers.get("content-length", "0") or "0")
            if length <= 0 or length > unix_client.MAX_FRAME_BYTES:
                self._send(400, disconnected_body("Core request has an invalid length"), "application/json")
                return
            raw = self.rfile.read(length)
            try:
                request = json.loads(raw)
            except json.JSONDecodeError:
                self._send(400, disconnected_body("Core request is not JSON"), "application/json")
                return
            if not isinstance(request, dict):
                self._send(400, disconnected_body("Core request must be an object"), "application/json")
                return
            message_type = request.get("messageType") or request.get("message_type")
            if message_type == "coordination_discover":
                prefix, error = coordination_cli_prefix(coordination_data, ROOT, endpoint, core_binary)
                if error:
                    self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                    return
                if continue_runner is None:
                    self._send(200, json.dumps({"ok": False, "error": "Discover is not wired on this workbench."}).encode(), "application/json")
                    return
                code, out, err = continue_runner([*prefix, "discover"])
                self._send(200, json.dumps({"ok": code == 0, "payload": {"sentence": subscription_harness_sentence(out), "harnesses": subscription_harnesses(out), "consentMissing": consent_missing(out), "stderr": err}}).encode(), "application/json")
                return
            if message_type == "coordination_acknowledge":
                argv, error = coordination_acknowledge_command(coordination_data, ROOT, endpoint, core_binary)
                if error:
                    self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                    return
                if continue_runner is None:
                    self._send(200, json.dumps({"ok": False, "error": "Leave is not wired on this workbench."}).encode(), "application/json")
                    return
                code, out, err = continue_runner(argv)
                failure = err.strip() if isinstance(err, str) else ""
                self._send(200, json.dumps({"ok": code == 0, "error": None if code == 0 else (failure or "The job could not be left."), "payload": {"stdout": out, "stderr": err}}).encode(), "application/json")
                return
            if message_type == "coordination_grant":
                prefix, error = coordination_grant_command(coordination_data, ROOT, endpoint, core_binary)
                if error:
                    self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                    return
                if continue_runner is None:
                    self._send(200, json.dumps({"ok": False, "error": "Grant is not wired on this workbench."}).encode(), "application/json")
                    return
                code, out, err = continue_runner(prefix)
                failure = err.strip() if isinstance(err, str) else ""
                self._send(200, json.dumps({"ok": code == 0, "error": None if code == 0 else (failure or "Background Send consent could not be saved."), "payload": {"stdout": out, "stderr": err}}).encode(), "application/json")
                return
            if message_type == "coordination_latest":
                self._send(200, json.dumps({
                    "ok": True,
                    "payload": latest_coordination_record(coordination_data),
                }).encode(), "application/json")
                return
            if message_type == "coordination_start":
                payload = request.get("payload") if isinstance(request.get("payload"), dict) else {}
                left_job = leftover_left_job(coordination_data)
                if left_job:
                    prefix, error = coordination_cli_prefix(coordination_data, ROOT, endpoint, core_binary)
                    if error or continue_runner is None:
                        self._send(200, json.dumps({"ok": False, "error": error or "Start is not wired on this workbench."}).encode(), "application/json")
                        return
                    code, _out, err = continue_runner([*prefix, "acknowledge", "--job", left_job])
                    if code != 0:
                        failure = err.strip() if isinstance(err, str) else ""
                        self._send(200, json.dumps({"ok": False, "error": failure or "The left goal could not be released, so nothing was sent."}).encode(), "application/json")
                        return
                argv, error = coordination_start_command(
                    coordination_data, ROOT, payload.get("goal"), payload.get("workspaceRoot"), payload.get("write") is True, endpoint, core_binary, payload.get("background") is True, payload.get("instances"),
                )
                if error:
                    self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                    return
                if continue_runner is None:
                    self._send(200, json.dumps({"ok": False, "error": "Start is not wired on this workbench."}).encode(), "application/json")
                    return
                code, out, err = continue_runner(argv)
                self._send(200, json.dumps({"ok": code == 0, "payload": {"exitCode": code, "stdout": out, "stderr": err}}).encode(), "application/json")
                return
            if message_type == "coordination_stop":
                argv, error = coordination_stop_command(coordination_data, ROOT, endpoint, core_binary)
                if error:
                    self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                    return
                if continue_runner is None:
                    self._send(200, json.dumps({"ok": False, "error": "Stop is not wired on this workbench."}).encode(), "application/json")
                    return
                code, out, err = continue_runner(argv)
                self._send(200, json.dumps({"ok": code == 0, "payload": {"exitCode": code, "stdout": out, "stderr": err}}).encode(), "application/json")
                return
            if message_type == "coordination_continue":
                payload = request.get("payload") if isinstance(request.get("payload"), dict) else {}
                left_job = leftover_left_job(coordination_data)
                if left_job:
                    prefix, error = coordination_cli_prefix(coordination_data, ROOT, endpoint, core_binary)
                    if error or continue_runner is None:
                        self._send(200, json.dumps({"ok": False, "error": error or "Continue is not wired on this workbench."}).encode(), "application/json")
                        return
                    code, _out, err = continue_runner([*prefix, "acknowledge", "--job", left_job])
                    if code != 0:
                        failure = err.strip() if isinstance(err, str) else ""
                        self._send(200, json.dumps({"ok": False, "error": failure or "The left goal could not be released, so nothing was sent."}).encode(), "application/json")
                        return
                argv, error = coordination_continue_command(coordination_data, ROOT, endpoint, core_binary, payload.get("followUp"), payload.get("write") is True, payload.get("background") is True, payload.get("instances"))
                if error:
                    self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                    return
                if continue_runner is None:
                    self._send(200, json.dumps({
                        "ok": False,
                        "error": "Continue is not wired on this workbench.",
                    }).encode(), "application/json")
                    return
                code, out, err = continue_runner(argv)
                self._send(200, json.dumps({
                    "ok": code == 0,
                    "payload": {"exitCode": code, "stdout": out, "stderr": err},
                }).encode(), "application/json")
                return
            payload = request.get("payload") if isinstance(request.get("payload"), dict) else {}
            request_id = request.get("requestId") or request.get("request_id")
            try:
                response = unix_client.call(
                    endpoint, message_type, payload, timeout=timeout, request_id=request_id
                )
            except unix_client.ClientError as error:
                self._send(502, disconnected_body(str(error)), "application/json")
                return
            except (OSError, ValueError) as error:
                self._send(502, disconnected_body(str(error)), "application/json")
                return
            self._send(200, json.dumps(response).encode(), "application/json")

        def _send(self, status: int, body: bytes, content_type: str):
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.send_header("x-content-type-options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", "-e", help="Core Unix socket, same resolution as unix-client.py")
    parser.add_argument("--dist", type=Path, default=ROOT / "dist", help="built renderer directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--coordination-data", type=Path, default=None, help="Profile directory. Defaults to ~/.goalport/linux-coordinate, the same place as the CLI.")
    parser.add_argument("--core-binary", type=Path, default=None, help="Absolute goalport-core executable used when the page starts or continues a goal.")
    args = parser.parse_args(argv)
    if args.host != "127.0.0.1":
        raise SystemExit("The workbench bridge listens on 127.0.0.1 only")
    dist = args.dist.resolve()
    index = dist / "index.html"
    if not index.is_file():
        raise SystemExit(f"Built renderer not found at {index}. Run pnpm build first.")
    unix_client = load_unix_client()
    endpoint = unix_client.resolve(args.endpoint)
    coordination_data = (args.coordination_data or (Path.home() / ".goalport" / "linux-coordinate")).resolve()
    core_binary = str(args.core_binary.resolve()) if args.core_binary else None

    def continue_runner(argv: list[str]) -> tuple[int, str, str]:
        import subprocess
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=60, env=coordination_child_env())
        return completed.returncode, completed.stdout, completed.stderr

    handler = make_handler(endpoint, dist, unix_client, args.timeout, coordination_data, continue_runner, core_binary)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"GoalPort workbench http://{args.host}:{args.port}  core {endpoint}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
