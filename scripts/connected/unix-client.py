#!/usr/bin/env python3
"""Production-shaped local client. Talks only to the Linux Unix socket.

Endpoint resolution mirrors Core (`resolve_unix_socket` / `endpoint_socket_leaf_name`):
  GOALPORT_SOCK override, else absolute --pipe/--endpoint, else
  ~/.goalport/runtime/<ascii-prefix>--<sha256[:16]>.sock

ASCII sanitize matches Rust `char::is_ascii_alphanumeric` (not Unicode isalnum).
The truncated sha256 suffix makes endpoint collisions unlikely (`a/b` ≠ `a?b` in this case).
"""
import hashlib
import json
import os
import socket
import struct
import sys

# Linux sockaddr_un.sun_path is typically 108 bytes including NUL.
LINUX_UNIX_SOCKET_PATH_MAX_BYTES = 107
ENDPOINT_NAME_HASH_HEX_LEN = 16
ENDPOINT_NAME_HASH_SEP = "--"


def _ascii_sanitize_char(c: str) -> str:
    if c.isascii() and (c.isalnum() or c in "-_."):
        return c
    return "_"


def endpoint_socket_leaf_name(endpoint: str, parent_dir: str) -> str:
    """Mirror Rust `endpoint_socket_leaf_name` exactly."""
    digest = hashlib.sha256(endpoint.encode("utf-8")).hexdigest()
    hash16 = digest[:ENDPOINT_NAME_HASH_HEX_LEN]
    suffix = f"{ENDPOINT_NAME_HASH_SEP}{hash16}.sock"
    parent_len = len(os.fsencode(parent_dir)) + 1  # + '/'
    max_leaf = LINUX_UNIX_SOCKET_PATH_MAX_BYTES - parent_len
    if max_leaf < len(suffix):
        raise ValueError(
            f"Unix socket path would exceed Linux sun_path capacity "
            f"({LINUX_UNIX_SOCKET_PATH_MAX_BYTES} bytes)"
        )
    max_prefix = max_leaf - len(suffix)
    prefix = "".join(_ascii_sanitize_char(c) for c in endpoint)
    if not prefix:
        prefix = "endpoint"
    if len(prefix) > max_prefix:
        prefix = prefix[:max_prefix]
    return f"{prefix}{suffix}"


def sanitize(endpoint: str) -> str:
    """Leaf name under a placeholder short parent (for display/tests). Prefer resolve()."""
    return endpoint_socket_leaf_name(endpoint.strip(), "/tmp")


def resolve(endpoint: str | None = None) -> str:
    override = os.environ.get("GOALPORT_SOCK")
    if override:
        return override
    name = (endpoint or os.environ.get("GOALPORT_PIPE") or "goalport-core-v1").strip()
    if not name:
        raise ValueError("Unix socket endpoint is empty")
    if os.path.isabs(name):
        encoded = os.fsencode(name)
        if len(encoded) > LINUX_UNIX_SOCKET_PATH_MAX_BYTES:
            raise ValueError(
                f"Unix socket path is {len(encoded)} bytes; "
                f"Linux sun_path capacity is {LINUX_UNIX_SOCKET_PATH_MAX_BYTES} bytes"
            )
        return name
    home = os.path.expanduser("~")
    directory = os.path.join(home, ".goalport", "runtime")
    leaf = endpoint_socket_leaf_name(name, directory)
    path = os.path.join(directory, leaf)
    encoded = os.fsencode(path)
    if len(encoded) > LINUX_UNIX_SOCKET_PATH_MAX_BYTES:
        raise ValueError(
            f"Unix socket path is {len(encoded)} bytes; "
            f"Linux sun_path capacity is {LINUX_UNIX_SOCKET_PATH_MAX_BYTES} bytes"
        )
    return path


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--resolve-only":
        endpoint = sys.argv[2] if len(sys.argv) > 2 else None
        print(resolve(endpoint))
        raise SystemExit(0)

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
