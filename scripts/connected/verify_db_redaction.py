import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description="DAT-01 redaction check over this-run SQLite only")
parser.add_argument("--inputs", nargs="+", required=True, help="this-run sqlite files")
parser.add_argument("--out", required=True, help="privacy report path")
parser.add_argument("--operation-id", required=True, help="L6 operation id")
args = parser.parse_args()
if not args.operation_id or args.operation_id.startswith("-"):
    print("missing --operation-id", file=sys.stderr)
    raise SystemExit(2)

forbidden = "goalport-connected-dual-desktop"
this_run = "goalport-stable-v1-closure"
# preserved RC folder goalport-electron-stable-v1
rc_preserve = "-".join(["goalport", "electron", "stable", "v1"])
terms = [r"C:\Users", "rateLimits", "sourcePath", "tokenUsage", "USERPROFILE", "APPDATA"]
databases = []
for relative in args.inputs:
    path = Path(relative)
    if not path.is_absolute():
        path = root / relative
    resolved = str(path.resolve())
    norm = resolved.replace("\\", "/")
    if forbidden in norm or rc_preserve in norm:
        print(f"refusing preserved sqlite input: {resolved}", file=sys.stderr)
        raise SystemExit(2)
    if f"goal-runs/{this_run}" not in norm:
        print(f"DAT-01 inputs must be this-run SQLite: {resolved}", file=sys.stderr)
        raise SystemExit(2)
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    payloads = [row[0] or "" for row in connection.execute("select payload_json from events")]
    counts = {
        term: connection.execute(
            "select count(*) from events where payload_json like ?", (f"%{term}%",)
        ).fetchone()[0]
        for term in terms
    }
    generic_counts = {
        "emailLikeValue": sum(bool(re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", payload)) for payload in payloads),
        "windowsUserProfilePath": sum(bool(re.search(r"[A-Za-z]:\\Users\\[^\\\"/]+", payload, re.IGNORECASE)) for payload in payloads),
    }
    counts.update(generic_counts)
    events = connection.execute("select count(*) from events").fetchone()[0]
    connection.close()
    databases.append({"path": str(path), "events": events, "forbiddenTermCounts": counts})

semantic = {
    "schemaVersion": 2,
    "kind": "persisted-runtime-redaction",
    "databases": databases,
    "status": "PASS"
    if databases and all(all(count == 0 for count in item["forbiddenTermCounts"].values()) for item in databases)
    else "UNMET",
}

output = Path(args.out)
if not output.is_absolute():
    output = root / output
out_norm = str(output.resolve()).replace("\\", "/")
if forbidden in out_norm or rc_preserve in out_norm:
    print(f"refusing preserved privacy out: {output}", file=sys.stderr)
    raise SystemExit(2)

evid = output.parent
artifact_path = evid / "electron-artifact.json"
core_sha = None
exe_sha = None
if artifact_path.exists():
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    core_sha = artifact.get("coreSha256")
    exe_sha = artifact.get("exeSha256")

raw_dir = evid / "raw-run" / "dat-01"
raw_dir.mkdir(parents=True, exist_ok=True)
stdout_path = raw_dir / f"{args.operation_id}.stdout.json"
stdout_path.write_text(json.dumps(semantic) + "\n", encoding="utf-8")
stdout_sha = hashlib.sha256(stdout_path.read_bytes()).hexdigest()

cim = {"ProcessId": os.getpid(), "ExecutablePath": sys.executable, "CommandLine": subprocess.list2cmdline([sys.executable, *sys.argv])}
try:
    script = f"Get-CimInstance Win32_Process -Filter \"ProcessId={os.getpid()}\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
    parsed = json.loads(subprocess.check_output(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], text=True, timeout=8) or "{}")
    row = parsed[0] if isinstance(parsed, list) else parsed
    cim = {
        "ProcessId": int(row.get("ProcessId") or os.getpid()),
        "ExecutablePath": str(row.get("ExecutablePath") or sys.executable),
        "CommandLine": str(row.get("CommandLine") or cim["CommandLine"]),
    }
except Exception:
    pass

sidecar = {
    "evidenceClass": "dat-01",
    "operationId": args.operation_id,
    "argv": [sys.executable, *sys.argv],
    "stdoutPath": str(stdout_path),
    "stdoutSha256": stdout_sha,
    "closedAtUtc": datetime.now(timezone.utc).isoformat(),
    "sidecarClosed": True,
    "cimCapture": cim,
}
sidecar_path = raw_dir / f"{args.operation_id}.json"
sidecar_path.write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")
sidecar_sha = hashlib.sha256(sidecar_path.read_bytes()).hexdigest()
time.sleep(0.05)
report = {
    **semantic,
    "operationId": args.operation_id,
    "sidecarSha256": sidecar_sha,
    "coreSha256": core_sha,
    "exeSha256": exe_sha,
    "host": "electron-packaged",
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report))
raise SystemExit(0 if report["status"] == "PASS" else 1)
