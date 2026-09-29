#!/usr/bin/env python3
"""Production-shaped local client. Talks only to the Unix socket."""
import json, os, socket, struct, sys

def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf

path = os.environ.get("GOALPORT_SOCK") or os.path.expanduser("~/.goalport/runtime/core.sock")
request = {
    "protocol_version": "goalport.ipc.v1",
    "request_id": "client-1",
    "entity_version": 1,
    "command": {"type": "Operation", "operation": "Snapshot"},
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
