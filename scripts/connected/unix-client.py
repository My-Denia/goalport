#!/usr/bin/env python3
"""Production-shaped local client. Talks only to the Linux Unix socket.

Endpoint resolution mirrors Core:
  GOALPORT_SOCK override, else absolute --pipe/--endpoint, else
  ~/.goalport/runtime/<sanitized>.sock
"""
import json, os, socket, struct, sys

def sanitize(endpoint: str) -> str:
    out = "".join(
        c if (c.isalnum() or c in "-_.") else "_" for c in endpoint.strip()
    )
    return (out or "endpoint")[:200]

def resolve(endpoint: str | None = None) -> str:
    override = os.environ.get("GOALPORT_SOCK")
    if override:
        return override
    name = endpoint or os.environ.get("GOALPORT_PIPE") or "goalport-core-v1"
    if os.path.isabs(name):
        return name
    return os.path.expanduser(f"~/.goalport/runtime/{sanitize(name)}.sock")

def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf

endpoint = sys.argv[1] if len(sys.argv) > 1 else None
path = resolve(endpoint)
request = {
    "protocol_version": "goalport.ipc.v2",
    "request_id": "client-1",
    "entity_version": 1,
    "message_type": "snapshot",
    "payload": {},
}
payload = json.dumps(request).encode()
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(path)
sock.sendall(struct.pack("<I", len(payload)) + payload)
header = recv_exact(sock, 4)
if len(header) != 4:
    sys.exit("truncated header")
n = struct.unpack("<I", header)[0]
body = recv_exact(sock, n)
if len(body) != n:
    sys.exit(f"truncated body {len(body)}/{n}")
print(body.decode())
