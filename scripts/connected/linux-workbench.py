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
_spec = importlib.util.spec_from_file_location("goalport_saved_targets", Path(__file__).with_name("saved_targets.py"))
_saved_targets = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_saved_targets)
SavedTargets = _saved_targets.SavedTargets


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


def activity_line(progress: dict, pid: object, alive=worker_alive, is_revoked: bool = False) -> str | None:
    if isinstance(pid, int) and pid > 0 and not alive(pid):
        return "The worker is gone. Its exit is not confirmed, so another goal cannot start yet."
    outcome = progress.get("outcome")
    outcome_status = outcome.get("status") if isinstance(outcome, dict) else outcome
    if progress.get("state") == "unconfirmed" or outcome_status == "unconfirmed":
        return "This goal's exit is not confirmed, so another goal cannot start yet."
    revoked = is_revoked or progress.get("revoked") is True or progress.get("state") == "revoked"
    if revoked:
        if progress.get("pendingCommand"):
            return "Access stopped; the current turn may finish, but no further turn was sent."
        if outcome_status == "stopped" or progress.get("state") == "stopped":
            return "Stopped. No further turn was sent. Existing workspace edits remain."
        return "Access stopped; no further turn was sent."
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
    revocation_path = data_dir / "coordination-jobs" / "jobs" / job_id / "revocation.json"
    is_revoked = revocation_path.is_file()
    line = activity_line(progress, pid, is_revoked=is_revoked)
    if not line:
        return None
    return {"line": line, "jobId": job_id}


def live_fields(data_dir: Path | None) -> dict:
    job = current_job(data_dir) if data_dir is not None else None
    fields = {"line": job["line"] if job else None, "jobId": job["jobId"] if job else None}
    held = leftover_left_job(data_dir) if job is None else None
    if held:
        job = {"jobId": held, "line": "This interrupted work still holds the slot. Leave it unreplayed before starting another goal."}
    if job and data_dir is not None:
        try:
            admission = json.loads((data_dir / "coordination-jobs" / "jobs" / job["jobId"] / "admission.json").read_text(encoding="utf-8"))
            identity = admission.get("input", {}) if isinstance(admission, dict) else {}
            if isinstance(identity.get("goal"), str) and isinstance(identity.get("workspacePath"), str):
                fields["currentGoal"] = {"goal": identity["goal"], "workspacePath": identity["workspacePath"]}
        except (OSError, json.JSONDecodeError, TypeError, AttributeError):
            pass  # Missing identity is unknown, never a fabricated saved result.
    current = None
    if job:
        current = {"jobId": job["jobId"], "line": job["line"], "identityConfirmed": False}
        try:
            admission = json.loads((data_dir / "coordination-jobs" / "jobs" / job["jobId"] / "admission.json").read_text(encoding="utf-8"))
            identity = admission.get("input", {})
            if (_saved_targets.valid_id(identity.get("requestId")) and isinstance(identity.get("goal"), str)
                    and isinstance(identity.get("workspacePath"), str)):
                current.update({"requestId": identity["requestId"], "goal": identity["goal"], "workspacePath": identity["workspacePath"], "identityConfirmed": True})
                descriptor = identity.get("continuation")
                if "continuation" not in identity:
                    current["rootRequestId"] = identity["requestId"]
                elif _saved_targets.valid_descriptor(descriptor):
                    targets = SavedTargets(read_saved_records(data_dir))
                    parent = targets.selected(descriptor["parentRequestId"])
                    if parent and parent["rootRequestId"] == descriptor["rootRequestId"] and identity["goal"] == descriptor["originalGoal"] and descriptor["originalGoal"] == str((targets.unique(descriptor["rootRequestId"]) or {}).get("goal", "")).strip() and _saved_targets.workspace_key(parent["record"].get("workspacePath")) == _saved_targets.workspace_key(identity["workspacePath"]):
                        current["rootRequestId"] = descriptor["rootRequestId"]
        except (OSError, json.JSONDecodeError, TypeError, AttributeError):
            pass
    fields["currentJob"] = current
    return fields


def folded_text(record: dict, key: str, outcome: str | None) -> str | None:
    text = record.get(key)
    if not isinstance(text, str):
        return None
    line = text.strip()
    if not line or line == outcome:
        return None
    return line if len(line) <= 600 else line[:597] + "..."


def check_detail(record: dict, outcome: str | None) -> str | None:
    for key in ("auditText", "reviewText"):
        text = record.get(key)
        if isinstance(text, str) and text.strip() and text.strip() != outcome:
            detail = text.strip()
            return detail if len(detail) <= 24000 else detail[:24000] + "\n[Check text truncated for display.]"
    return None


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


def disk_unconfirmed(data_dir: Path | None, request_id: str | None = None) -> bool:
    jobs = data_dir / "coordination-jobs" / "jobs" if data_dir is not None else None
    if jobs is None or not jobs.is_dir():
        return False
    active_id = None
    if not request_id:
        try:
            active = json.loads((data_dir / "coordination-jobs" / "active-admission.json").read_text(encoding="utf-8"))
            active_id = active.get("jobId") if isinstance(active, dict) else None
        except (OSError, json.JSONDecodeError):
            active_id = None
        if not isinstance(active_id, str) or not active_id:
            return False
    for job_dir in jobs.iterdir():
        if not job_dir.is_dir():
            continue
        if active_id and job_dir.name != active_id:
            continue
        if request_id:
            try:
                admission = json.loads((job_dir / "admission.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            found = admission.get("input", {}).get("requestId") if isinstance(admission, dict) else None
            if found != request_id:
                continue
        try:
            progress = json.loads((job_dir / "progress.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(progress, dict):
            continue
        outcome = progress.get("outcome")
        outcome_status = outcome.get("status") if isinstance(outcome, dict) else outcome
        if progress.get("state") == "unconfirmed" or outcome_status == "unconfirmed":
            return True
    return False


def newest_saved_record(records: list) -> dict | None:
    """The record a person just finished. saveRecord puts that one first and stamps savedAt."""
    dated = None
    dated_at = ""
    undated = None
    for item in records:
        if not isinstance(item, dict):
            continue
        stamp = item.get("savedAt")
        if isinstance(stamp, str) and stamp:
            if stamp >= dated_at:
                dated = item
                dated_at = stamp
            continue
        if undated is None:
            undated = item
    if dated is not None:
        return dated
    if undated is not None:
        for item in reversed(records):
            if isinstance(item, dict):
                return item
    return None


def find_matching_admission(data_dir: Path | None, request_id: object, workspace_path: object) -> tuple[dict | None, Path | None]:
    """Find the single immutable admission matching requestId and workspacePath."""
    if data_dir is None or not isinstance(request_id, str) or not request_id or not isinstance(workspace_path, str) or not workspace_path:
        return None, None
    jobs_dir = data_dir / "coordination-jobs" / "jobs"
    if not jobs_dir.is_dir():
        return None, None
    matches = []
    try:
        for job in jobs_dir.iterdir():
            if not job.is_dir():
                continue
            admission_file = job / "admission.json"
            if not admission_file.is_file():
                continue
            try:
                admission = json.loads(admission_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            candidate = admission.get("input", {}) if isinstance(admission, dict) else {}
            if (isinstance(candidate, dict)
                    and candidate.get("requestId") == request_id
                    and candidate.get("workspacePath") == workspace_path):
                matches.append((candidate, job))
    except (OSError, AttributeError):
        return None, None
    if len(matches) != 1:
        return None, None
    return matches[0]


def project_remembered_intent(candidate: dict | None, workspace_path: object) -> dict | None:
    """Project {background, write} from the record's own immutable admission.

    No tokens, no scope generation, no remaining budget. Literal background true,
    supported browser writer (Codex), matching workspace root, positive bounded integer turns.
    """
    if not isinstance(candidate, dict) or not isinstance(workspace_path, str) or not workspace_path:
        return None
    if candidate.get("backgroundConsent") is not True:
        return None
    background = True
    write_auth = candidate.get("writeAuthorization")
    write_valid = False
    if isinstance(write_auth, dict):
        instances = write_auth.get("instances")
        root = write_auth.get("workspaceRoot")
        max_turns = write_auth.get("maxTurns")
        if (isinstance(instances, list)
                and len(instances) > 0
                and all(x == "codex" for x in instances)
                and isinstance(root, str)
                and root == workspace_path
                and isinstance(max_turns, int)
                and not isinstance(max_turns, bool)
                and 1 <= max_turns <= 8):
            write_valid = True
        else:
            return None
    elif write_auth is not None:
        return None
    return {
        "background": background,
        "write": write_valid,
        **({"piCapacity": candidate["piCapacity"]} if "piCapacity" in candidate else {}),
        **({"legacyPi": True} if "piCapacity" not in candidate and "pi" in candidate.get("allowedInstances", []) else {}),
    }


def retained_continuation_result(data_dir: Path, last: dict, records: list) -> dict:
    """Retain evidence through proven stopped continuations, never their options."""
    current_record = last
    seen = set()
    for _ in range(len(records) + 1):
        if current_record.get("executionEvidence") is not None:
            return current_record
        request_id = current_record.get("requestId")
        if not isinstance(request_id, str) or request_id in seen:
            return last
        seen.add(request_id)
        try:
            current, job = find_matching_admission(data_dir, request_id, current_record.get("workspacePath"))
            if current is None or job is None:
                return last
            progress = json.loads((job / "progress.json").read_text(encoding="utf-8"))
            if not isinstance(progress, dict) or progress.get("state") != "stopped" or progress.get("pendingCommand"):
                return last
            feedback = current.get("executionFeedback")
            if not isinstance(feedback, dict) or not feedback.get("previousPlan"):
                return last
            parents = [item for item in records if isinstance(item, dict)
                       and item.get("requestId") not in seen
                       and item.get("workspacePath") == last.get("workspacePath")
                       and item.get("planText") == feedback.get("previousPlan")
                       and item.get("auditText") == feedback.get("previousExecutionAudit")]
            parent = newest_saved_record(parents)
            if parent is None:
                return last
            current_record = parent
        except (OSError, json.JSONDecodeError, KeyError, TypeError, AttributeError):
            return last
    return last


def read_saved_records(data_dir: Path | None) -> list:
    if data_dir is None:
        return []
    try:
        records = json.loads((data_dir / "coordination-records.json").read_text(encoding="utf-8"))
        return records if isinstance(records, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def saved_status_label(data_dir: Path, record: dict) -> str:
    """Plain saved-result status, not provider prose or a live permission claim."""
    _admission, job = find_matching_admission(data_dir, record.get("requestId"), record.get("workspacePath"))
    if job is not None:
        try:
            progress = json.loads((job / "progress.json").read_text(encoding="utf-8"))
            if progress.get("state") == "stopped":
                return "Stopped; existing changes remain"
            if progress.get("state") == "unconfirmed":
                return "Not confirmed"
        except (OSError, ValueError, AttributeError):
            pass
    verdict = record.get("verdict")
    return {"verified": "Changes verified", "checked": "Plan checked", "revise": "Needs revision", "stopped": "Stopped; existing changes remain", "failed": "Failed; see check details", "unconfirmed": "Not confirmed"}.get(verdict, "Saved result") if isinstance(verdict, str) else "Saved result"


def project_saved_record(data_dir: Path, entry: dict, records: list, targets: SavedTargets) -> dict:
    last = entry["record"]
    admission, _job = find_matching_admission(data_dir, last.get("requestId"), last.get("workspacePath"))
    retained = retained_continuation_result(data_dir, last, records)
    projected = {key: last.get(key) for key in ("requestId", "goal", "workspacePath", "savedAt", "verdict", "stopReason", "planningHarness", "reviewHarness", "messageDispatched")}
    projected.update({key: entry[key] for key in ("rootRequestId", "relationStatus", "relationUnavailableReason")})
    if "continuation" in entry:
        projected["continuation"] = entry["continuation"]
    root_id = entry["rootRequestId"]
    projected.update({
        "rootLatestId": targets.head(root_id) if root_id else None,
        "retainedFromRequestId": retained.get("requestId") if retained is not last else None,
        "outcome": short_outcome(last), "statusLabel": saved_status_label(data_dir, last), "detail": check_detail(retained, short_outcome(retained)),
        "change": folded_text(retained, "executionText", short_outcome(retained)),
        "executionEvidence": retained.get("executionEvidence"),
        "auditInputEvidenceCoverage": retained.get("auditInputEvidenceCoverage"),
        "auditInputEvidenceText": retained.get("auditInputEvidenceText"),
        "rememberedIntent": project_remembered_intent(admission, last.get("workspacePath")),
        **({"piCapacity": last["piCapacity"]} if "piCapacity" in last else {}),
        **({"requestedPiCapacity": last["requestedPiCapacity"]} if "requestedPiCapacity" in last else {}),
    })
    return projected


def latest_coordination_record(data_dir: Path | None, request_id: object = None) -> dict:
    """Shared list/detail projection. An explicit ID never falls back to latest."""
    if data_dir is None:
        return {"ok": True, "record": None, "reason": "no coordination profile configured"}
    path = data_dir / "coordination-records.json"
    if not path.is_file():
        return {"ok": True, "record": None, "leftRequestIds": left_request_ids(data_dir), "unconfirmedGoal": disk_unconfirmed(data_dir), "leftoverHeld": leftover_left_job(data_dir) is not None, **live_fields(data_dir), "reason": "no coordinated result saved"}
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"ok": False, "record": None, "leftRequestIds": left_request_ids(data_dir), "unconfirmedGoal": disk_unconfirmed(data_dir), "leftoverHeld": leftover_left_job(data_dir) is not None, **live_fields(data_dir), "reason": "coordinated result could not be read"}
    targets = SavedTargets(records)
    summaries = []
    seen = set()
    for entry in targets.entries:
        item = entry["record"]
        root_id = entry["rootRequestId"]
        key = root_id or item.get("requestId")
        if not isinstance(key, str) or key in seen:
            continue
        seen.add(key)
        root = targets.unique(root_id) if root_id else item
        head_id = targets.head(root_id) if root_id else None
        head = targets.unique(head_id) if head_id else item
        summaries.append({"rootRequestId": root_id, "requestId": head_id or root_id or item.get("requestId"), "title": root.get("goal"), "workspacePath": root.get("workspacePath"), "outcome": short_outcome(head), "statusLabel": saved_status_label(data_dir, head), "relationStatus": entry["relationStatus"], "reason": entry["relationUnavailableReason"] or ("The latest result cannot be identified." if root_id and not head_id else None)})
    last = targets.unique(request_id) if request_id is not None else newest_saved_record(records)
    selected = targets.selected(last.get("requestId")) if isinstance(last, dict) else None
    common = {"roots": summaries, "profileLatestId": (newest_saved_record(records) or {}).get("requestId"), "leftRequestIds": left_request_ids(data_dir), "unconfirmedGoal": disk_unconfirmed(data_dir), "leftoverHeld": leftover_left_job(data_dir) is not None, **live_fields(data_dir)}
    if selected is None:
        return {"ok": True, "record": None, **common, "reason": "That saved goal is no longer available or cannot be identified." if request_id is not None else "No coordinated result saved."}
    history = [{"requestId": e["record"].get("requestId"), "savedAt": e["record"].get("savedAt"), "outcome": short_outcome(e["record"])} for e in targets.entries if selected["rootRequestId"] and e["rootRequestId"] == selected["rootRequestId"]]
    return {"ok": True, "record": project_saved_record(data_dir, selected, records, targets), "history": history, "reason": None, **common}


def pi_capacity_snapshot(stdout: str) -> dict | None:
    """Typed secretless CLI projection; never infer billing from credential type."""
    for line in stdout.splitlines():
        if line.startswith("pi capacity: "):
            try:
                value = json.loads(line.removeprefix("pi capacity: "))
                if isinstance(value, dict) and value.get("instanceId") == "pi" and isinstance(value.get("piCapacity"), dict):
                    return value
            except json.JSONDecodeError:
                pass
    return None


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
    return "No signed-in subscription harness was found on this machine, so nothing will be sent."


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


def coordination_acknowledge_command(data_dir: Path | None, repo_root: Path, endpoint: str | None = None, core_binary: str | None = None, database: str | None = None, expected_job_id: object = None) -> tuple[list[str] | None, str | None]:
    job = current_job(data_dir) if data_dir is not None else None
    job_id = job.get("jobId") if isinstance(job, dict) else leftover_left_job(data_dir)
    if not isinstance(job_id, str) or not job_id:
        return None, "No coordinated goal to leave."
    if expected_job_id is not None and expected_job_id != job_id:
        return None, "Current work changed. Read its status before leaving it."
    if not all(character.isalnum() or character in "._-" for character in job_id):
        return None, "The goal id is invalid, so it was not left."
    prefix, error = coordination_cli_prefix(data_dir, repo_root, endpoint, core_binary, "it was not left.", database)
    if error:
        return None, error
    return [*prefix, "acknowledge", "--job", job_id], None


def coordination_grant_command(data_dir: Path | None, repo_root: Path, endpoint: str | None = None, core_binary: str | None = None, database: str | None = None) -> tuple[list[str] | None, str | None]:
    prefix, error = coordination_cli_prefix(data_dir, repo_root, endpoint, core_binary, "Background Send was not allowed.", database)
    if error:
        return None, error
    return [*prefix, "grant-access"], None


def coordination_cli_prefix(data_dir: Path, repo_root: Path, endpoint: str | None, core_binary: str | None, refused: str = "nothing was admitted.", database: str | None = None) -> tuple[list[str] | None, str | None]:
    if not endpoint:
        return None, f"The Core socket is required, so {refused}"
    if not core_binary or not (core_binary.startswith("/") or Path(core_binary).is_absolute()):
        return None, f"The Core executable is required: pass --core-binary with an absolute path, so {refused}"
    argv = [
        "node", str(repo_root / "scripts" / "connected" / "linux-coordinate.mjs"),
        "--data-dir", str(data_dir), "--pipe", endpoint, "--core-binary", core_binary,
    ]
    # The admission check compares this path with the database Core was started
    # with. The profile directory is not that database when they differ.
    if database:
        argv.extend(["--database", database])
    return argv, None


KEEP_RUNNING_SENTENCE = "Keep working after closing must be explicitly selected."
PI_CAPACITY_ABSENT = object()


def checked_instances(instances: object) -> tuple[str | None, str | None]:
    if instances is None or instances == "":
        return None, None
    if not isinstance(instances, str):
        return None, "A harness id is invalid, so nothing was admitted."
    names = [part.strip() for part in instances.split(",") if part.strip()]
    if not names or any(not all(character.isalnum() or character in "._-" for character in name) for name in names):
        return None, "A harness id is invalid, so nothing was admitted."
    return ",".join(names), None


def coordination_continue_command(data_dir: Path | None, repo_root: Path, endpoint: str | None = None, core_binary: str | None = None, follow_up: object = None, write: object = False, background: object = False, instances: object = None, database: str | None = None, from_request_id: object = None) -> tuple[list[str] | None, str | None]:
    if background is not True:
        return None, KEEP_RUNNING_SENTENCE
    if not _saved_targets.valid_id(from_request_id):
        return None, "Choose an available saved result before continuing."
    found = latest_coordination_record(data_dir, from_request_id)
    record = found.get("record") if isinstance(found, dict) else None
    request_id = record.get("requestId") if isinstance(record, dict) else None
    if data_dir is None or not isinstance(request_id, str) or not request_id:
        return None, "No saved coordinated goal to continue."
    if request_id in left_request_ids(data_dir):
        return None, "The interrupted job stays unreplayed; the same request id cannot be admitted again."
    prefix, error = coordination_cli_prefix(data_dir, repo_root, endpoint, core_binary, database=database)
    if error:
        return None, error
    if not record.get("rootRequestId"):
        return None, record.get("relationUnavailableReason") or "The saved goal relationship is unavailable."
    if record.get("rootLatestId") != request_id:
        return None, "Open the latest result and choose Continue again."
    if current_job(data_dir) is not None or disk_unconfirmed(data_dir) or leftover_left_job(data_dir):
        return None, "Current work has not settled, so nothing was admitted."
    if follow_up is not None and not isinstance(follow_up, str):
        return None, "The follow-up must be text, so nothing was admitted."
    argv = [*prefix, "continue", "--from", request_id, "--background"]
    if isinstance(follow_up, str) and follow_up.strip():
        argv.extend(["--goal", follow_up.strip()])
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


def coordination_start_command(data_dir: Path | None, repo_root: Path, goal: object, workspace: object, write: object = False, endpoint: str | None = None, core_binary: str | None = None, background: object = False, instances: object = None, database: str | None = None, pi_capacity: object = PI_CAPACITY_ABSENT) -> tuple[list[str] | None, str | None]:
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
    prefix, error = coordination_cli_prefix(data_dir, repo_root, endpoint, core_binary, database=database)
    if error:
        return None, error
    argv = [*prefix, "run", "--goal", goal.strip(), "--workspace", workspace, "--background"]
    if pi_capacity is not PI_CAPACITY_ABSENT:
        argv.extend(["--pi-capacity", json.dumps(pi_capacity, ensure_ascii=False, separators=(",", ":"))])
    if write is True:
        argv.extend(["--write-instances", "codex", "--write-turns", "1"])
    names, names_error = checked_instances(instances)
    if names_error:
        return None, names_error
    if names:
        argv.extend(["--instances", names])
    return argv, None


def coordination_stop_command(data_dir: Path | None, repo_root: Path, endpoint: str | None = None, core_binary: str | None = None, database: str | None = None, expected_job_id: object = None) -> tuple[list[str] | None, str | None]:
    job = current_job(data_dir) if data_dir is not None else None
    job_id = job.get("jobId") if isinstance(job, dict) else None
    if not isinstance(job_id, str) or not job_id:
        return None, "No running coordinated goal to stop."
    if expected_job_id is not None and expected_job_id != job_id:
        return None, "Current work changed. Read its status before stopping it."
    if not all(character.isalnum() or character in "._-" for character in job_id):
        return None, "The running goal id is invalid, so nothing was stopped."
    prefix, error = coordination_cli_prefix(data_dir, repo_root, endpoint, core_binary, "nothing was stopped.", database)
    if error:
        return None, error
    return [*prefix, "stop", "--job", job_id], None


def make_handler(endpoint: str, dist: Path, unix_client, timeout: float, coordination_data: Path | None = None, continue_runner=None, core_binary: str | None = None, database: str | None = None):
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
                prefix, error = coordination_cli_prefix(coordination_data, ROOT, endpoint, core_binary, "the signed-in harnesses could not be checked.", database)
                if error:
                    self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                    return
                if continue_runner is None:
                    self._send(200, json.dumps({"ok": False, "error": "Discover is not wired on this workbench."}).encode(), "application/json")
                    return
                payload = request.get("payload") if isinstance(request.get("payload"), dict) else {}
                workspace = payload.get("workspaceRoot")
                args = [*prefix, "discover"]
                if isinstance(workspace, str) and workspace.strip():
                    args.extend(["--workspace", expand_workspace(workspace.strip())])
                code, out, err = continue_runner(args)
                pi = pi_capacity_snapshot(out)
                self._send(200, json.dumps({"ok": code == 0, "payload": {"sentence": None if pi else subscription_harness_sentence(out), "harnesses": subscription_harnesses(out), "pi": pi, "consentMissing": consent_missing(out), "stderr": err}}).encode(), "application/json")
                return
            if message_type == "coordination_acknowledge":
                argv, error = coordination_acknowledge_command(coordination_data, ROOT, endpoint, core_binary, database, (request.get("payload") or {}).get("jobId"))
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
                prefix, error = coordination_grant_command(coordination_data, ROOT, endpoint, core_binary, database)
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
            if message_type in {"coordination_latest", "coordination_list", "coordination_detail"}:
                payload = request.get("payload")
                if not isinstance(payload, dict) or ((message_type == "coordination_detail" or "requestId" in payload) and not _saved_targets.valid_id(payload.get("requestId"))):
                    self._send(200, json.dumps({"ok": False, "error": "Choose an exact saved result before opening it.", "payload": {"record": None}}).encode(), "application/json")
                    return
                self._send(200, json.dumps({
                    "ok": True,
                    "payload": latest_coordination_record(coordination_data, payload.get("requestId")),
                }).encode(), "application/json")
                return
            if message_type == "coordination_start":
                payload = request.get("payload") if isinstance(request.get("payload"), dict) else {}
                argv, error = coordination_start_command(
                    coordination_data, ROOT, payload.get("goal"), payload.get("workspaceRoot"), payload.get("write") is True, endpoint, core_binary, payload.get("background") is True, payload.get("instances"), database, payload.get("piCapacity", PI_CAPACITY_ABSENT),
                )
                if error:
                    self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                    return
                if continue_runner is None:
                    self._send(200, json.dumps({"ok": False, "error": "Start is not wired on this workbench."}).encode(), "application/json")
                    return
                left_job = leftover_left_job(coordination_data)
                if left_job:
                    prefix, error = coordination_cli_prefix(coordination_data, ROOT, endpoint, core_binary, "nothing was sent.", database)
                    if error:
                        self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                        return
                    code, _out, err = continue_runner([*prefix, "acknowledge", "--job", left_job])
                    if code != 0:
                        failure = err.strip() if isinstance(err, str) else ""
                        self._send(200, json.dumps({"ok": False, "error": failure or "The left goal could not be released, so nothing was sent."}).encode(), "application/json")
                        return
                code, out, err = continue_runner(argv)
                if isinstance(err, str) and "Run acknowledge before starting another" in err:
                    err = "The left goal could not be released, so nothing was sent."
                self._send(200, json.dumps({"ok": code == 0, "payload": {"exitCode": code, "stdout": out, "stderr": err}}).encode(), "application/json")
                return
            if message_type == "coordination_stop":
                argv, error = coordination_stop_command(coordination_data, ROOT, endpoint, core_binary, database, (request.get("payload") or {}).get("jobId"))
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
                if "piCapacity" in payload:
                    self._send(200, json.dumps({"ok": False, "error": "Continue retains the saved goal's Pi route; it cannot be edited here."}).encode(), "application/json")
                    return
                argv, error = coordination_continue_command(coordination_data, ROOT, endpoint, core_binary, payload.get("followUp"), payload.get("write") is True, payload.get("background") is True, payload.get("instances"), database, payload.get("fromRequestId"))
                if error:
                    self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                    return
                if continue_runner is None:
                    self._send(200, json.dumps({
                        "ok": False,
                        "error": "Continue is not wired on this workbench.",
                    }).encode(), "application/json")
                    return
                left_job = leftover_left_job(coordination_data)
                if left_job:
                    prefix, error = coordination_cli_prefix(coordination_data, ROOT, endpoint, core_binary, "nothing was sent.", database)
                    if error:
                        self._send(200, json.dumps({"ok": False, "error": error}).encode(), "application/json")
                        return
                    code, _out, err = continue_runner([*prefix, "acknowledge", "--job", left_job])
                    if code != 0:
                        failure = err.strip() if isinstance(err, str) else ""
                        self._send(200, json.dumps({"ok": False, "error": failure or "The left goal could not be released, so nothing was sent."}).encode(), "application/json")
                        return
                code, out, err = continue_runner(argv)
                if isinstance(err, str) and "Run acknowledge before starting another" in err:
                    err = "The left goal could not be released, so nothing was sent."
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
    parser.add_argument("--database", type=Path, default=None, help="Absolute Core database, the same --db the running Core was started with.")
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
    database = str(args.database.resolve()) if args.database else None

    def continue_runner(argv: list[str]) -> tuple[int, str, str]:
        import subprocess
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=60, env=coordination_child_env())
        return completed.returncode, completed.stdout, completed.stderr

    handler = make_handler(endpoint, dist, unix_client, args.timeout, coordination_data, continue_runner, core_binary, database)
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
