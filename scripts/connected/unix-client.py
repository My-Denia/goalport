#!/usr/bin/env python3
"""Operate GoalPort through its production Linux Unix socket protocol.

Examples (global options precede the command):
  unix-client.py --endpoint /tmp/goalport.sock diagnose
  unix-client.py --endpoint /tmp/goalport.sock new --workspace . --runtime codex -m 'Fix the failing test'
  unix-client.py --endpoint /tmp/goalport.sock send --campaign ID -m 'Explain the change'
  unix-client.py --endpoint /tmp/goalport.sock decision --decision ID --allow

Closing this client leaves Core and the Runtime running. Stop interrupts a turn;
close-session explicitly asks Core to end an idle session. No command is retried
automatically. A timed-out mutation may already have been delivered: inspect its
request ID and current state before taking another action.

Endpoint resolution mirrors Core (`resolve_unix_socket` / `endpoint_socket_leaf_name`):
  GOALPORT_SOCK override, else absolute --pipe/--endpoint, else
  ~/.goalport/runtime/<ascii-prefix>--<sha256[:16]>.sock

ASCII sanitize matches Rust `char::is_ascii_alphanumeric` (not Unicode isalnum).
The truncated sha256 suffix makes endpoint collisions unlikely (`a/b` ≠ `a?b` in this case).
"""
import argparse
import hashlib
import json
import math
import os
import socket
import struct
import sys
import time
import uuid

# Linux sockaddr_un.sun_path is typically 108 bytes including NUL.
LINUX_UNIX_SOCKET_PATH_MAX_BYTES = 107
ENDPOINT_NAME_HASH_HEX_LEN = 16
ENDPOINT_NAME_HASH_SEP = "--"
PROTOCOL_VERSION = "goalport.ipc.v2"
MAX_FRAME_BYTES = 16 * 1024 * 1024


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
    if endpoint is not None and not endpoint.strip():
        raise ValueError("Unix socket endpoint is empty")
    override = os.environ.get("GOALPORT_SOCK")
    if override:
        return override
    name = (
        endpoint if endpoint is not None else os.environ.get("GOALPORT_PIPE") or "goalport-core-v1"
    ).strip()
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


class ClientError(Exception):
    """A failed exchange, with no claim that a sent mutation was refused."""

    def __init__(self, message, request_id, delivery_state):
        super().__init__(message)
        self.request_id = request_id
        self.delivery_state = delivery_state

    def as_dict(self):
        return {"ok": False, "error": str(self), "requestId": self.request_id,
                "deliveryState": self.delivery_state, "automaticallyRetried": False}


def recv_exact(sock, n, deadline=None):
    chunks = bytearray()
    while len(chunks) < n:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Core response deadline exceeded")
            sock.settimeout(remaining)
        chunk = sock.recv(n - len(chunks))
        if not chunk:
            raise EOFError(f"truncated Core response ({len(chunks)}/{n} bytes)")
        chunks.extend(chunk)
    return bytes(chunks)


def call(endpoint=None, message_type="snapshot", payload=None, *, timeout=30,
         request_id=None):
    """One production exchange. Never reconnect or replay a mutation implicitly."""
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout must be finite and positive")
    request_id = request_id or str(uuid.uuid4())
    if not request_id.strip() or len(request_id.encode()) > 256:
        raise ValueError("request ID must contain 1–256 bytes")
    request = {"protocolVersion": PROTOCOL_VERSION, "requestId": request_id,
               "entityVersion": 1, "messageType": message_type,
               "payload": {} if payload is None else payload}
    encoded = json.dumps(request, ensure_ascii=False).encode()
    if len(encoded) > MAX_FRAME_BYTES:
        raise ValueError("request exceeds the Core frame limit")
    sent = False
    try:
        deadline = time.monotonic() + timeout
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(resolve(endpoint))
            # sendall may fail after a partial write. The result is unknown from
            # this point until a correlated response arrives.
            sent = True
            sock.settimeout(max(0.001, deadline - time.monotonic()))
            sock.sendall(struct.pack("<I", len(encoded)) + encoded)
            length = struct.unpack("<I", recv_exact(sock, 4, deadline))[0]
            if not 0 < length <= MAX_FRAME_BYTES:
                raise ValueError(f"Core response length {length} exceeds frame bounds")
            response = json.loads(recv_exact(sock, length, deadline))
            if not isinstance(response, dict):
                raise ValueError("Core response must be an object")
            if response.get("requestId", response.get("request_id")) != request_id:
                raise ValueError("Core response belongs to a different request")
            if response.get("protocolVersion", response.get("protocol_version")) != PROTOCOL_VERSION:
                raise ValueError("Core response uses an incompatible protocol")
            if not isinstance(response.get("ok"), bool):
                raise ValueError("Core response has no success/refusal status")
            return response
    except (OSError, EOFError, ValueError) as error:
        read_only = message_type in {"snapshot", "snapshot_if_changed", "history_page", "get_startup_receipt",
                                     "get_close_choice_receipt"}
        state = "READ_FAILED" if read_only else "UNKNOWN" if sent else "NOT_SENT"
        raise ClientError(str(error), request_id, state) from error


def snapshot_from(response):
    payload = response.get("payload", {})
    if not isinstance(payload, dict):
        return {}
    return payload.get("snapshot", payload)


def diagnostics(response):
    """A small read-only view of the same projection the desktop displays."""
    if not response.get("ok"):
        return response
    snapshot = snapshot_from(response)
    conversation = snapshot.get("productConversation") or {}
    turn = conversation.get("turn") or {}
    attempt = snapshot.get("attempt") or {}
    decisions = snapshot.get("decisions") or []
    # Native output arrives as deltas. Six delta records may be only six words;
    # show the recent logical messages instead, using the IDs supplied by Core.
    recent = []
    for item in conversation.get("items", []):
        logical_id = item.get("logicalItemId") or item.get("id")
        if (recent and logical_id
                and (recent[-1].get("logicalItemId") or recent[-1].get("id")) == logical_id
                and recent[-1].get("kind") == item.get("kind")):
            recent[-1]["body"] += item.get("body", "")
            recent[-1]["continuesAfter"] = item.get("continuesAfter", False)
        else:
            recent.append(dict(item))
        if len(recent) > 6:
            recent.pop(0)
        if len(recent[-1].get("body", "")) > 4096:
            recent[-1]["body"] = recent[-1]["body"][-4096:]
            recent[-1]["continuesBefore"] = True
    return {
        "ok": True,
        "connection": snapshot.get("connection"),
        "campaignId": snapshot.get("activeCampaignId"),
        "title": conversation.get("title"),
        "runtime": conversation.get("runtime"),
        "session": conversation.get("session", {
            "attemptId": attempt.get("id"), "state": "unknown",
            "reason": "Core has not provided independent session facts",
        }),
        "turn": turn,
        "canSend": turn.get("canSend", False),
        "canStop": turn.get("canStop", False),
        "reason": turn.get("reason"),
        "reasonCode": turn.get("reasonCode"),
        "actions": turn.get("actions", []),
        "pendingDecisions": [d for d in decisions if d.get("state") == "pending"],
        "recentMessages": recent,
        "resultSummary": conversation.get("resultSummary"),
        "notices": snapshot.get("notices", []),
        "cursor": snapshot.get("cursor"),
    }


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--endpoint", "-e", help="socket path or Core endpoint name")
    result.add_argument("--timeout", type=float, default=30, help="whole exchange deadline in seconds")
    result.add_argument("--request-id", help="explicit request identity; no automatic retries")
    result.add_argument("--pretty", action="store_true", help="indent JSON output")
    commands = result.add_subparsers(dest="action")
    commands.add_parser("snapshot", help="read the current desktop projection")
    commands.add_parser("diagnose", help="explain send/stop availability and pending permissions")
    watch = commands.add_parser("watch", help="read changed diagnostics using short polling exchanges")
    watch.add_argument("--interval", type=float, default=0.75)
    watch.add_argument("--count", type=int, default=0, help="number of samples; 0 runs until interrupted")
    for action in ("new", "send"):
        sub = commands.add_parser(action, help="start a goal" if action == "new" else "send another turn")
        message = sub.add_mutually_exclusive_group(required=True)
        message.add_argument("--message", "-m")
        message.add_argument("--message-file", help="UTF-8 file, or - for stdin")
        if action == "new":
            sub.add_argument("--workspace", required=True)
            sub.add_argument("--runtime", default="codex", choices=["codex", "claude", "grok", "scenario"])
        else:
            sub.add_argument("--campaign", required=True)
            sub.add_argument("--attempt")
    select = commands.add_parser("select", help="explicitly select a goal")
    select.add_argument("--campaign", required=True)
    runtime = commands.add_parser("runtime", help="select a Runtime through normal admission")
    runtime.add_argument("--campaign", required=True)
    runtime.add_argument("--runtime", required=True, choices=["codex", "claude", "grok", "scenario"])
    runtime.add_argument("--attempt")
    decision = commands.add_parser("decision", help="respond to one pending permission")
    decision.add_argument("--decision", required=True)
    answer = decision.add_mutually_exclusive_group(required=True)
    answer.add_argument("--allow", action="store_true")
    answer.add_argument("--deny", action="store_true")
    for action in ("stop", "resume", "close-session"):
        sub = commands.add_parser(action)
        sub.add_argument("--attempt", required=True)
    rename = commands.add_parser("rename")
    rename.add_argument("--campaign", required=True)
    rename.add_argument("--title", required=True)
    raw = commands.add_parser("command", help="send one production command without bypassing Core validation")
    raw.add_argument("message_type")
    data = raw.add_mutually_exclusive_group()
    data.add_argument("--payload", default="{}", help="JSON payload object")
    data.add_argument("--payload-file", help="JSON file, or - for stdin")
    return result


def read_text(path):
    if path == "-":
        return sys.stdin.read()
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def command_for(args):
    action = args.action or "snapshot"
    if action == "watch":
        return "snapshot_if_changed", {}
    if action in {"snapshot", "diagnose"}:
        return "snapshot", {}
    if action in {"new", "send"}:
        message = args.message if args.message is not None else read_text(args.message_file)
        if not message.strip():
            raise ValueError("message cannot be empty")
        payload = {"message": message}
        if action == "new":
            payload.update(workspaceRoot=os.path.abspath(args.workspace), provider=args.runtime)
            return "start_conversation", payload
        payload["campaignId"] = args.campaign
        if args.attempt:
            payload["attemptId"] = args.attempt
        return "conversation_send", payload
    if action == "select":
        return "select_campaign", {"campaignId": args.campaign}
    if action == "runtime":
        payload = {"campaignId": args.campaign, "provider": args.runtime}
        if args.attempt:
            payload["attemptId"] = args.attempt
        return "select_runtime", payload
    if action == "decision":
        return "resolve_decision", {"decisionId": args.decision, "allow": args.allow}
    if action in {"stop", "resume", "close-session"}:
        message_type = {"stop": "interrupt", "resume": "resume_native_session",
                        "close-session": "close_session"}[action]
        return message_type, {"attemptId": args.attempt}
    if action == "rename":
        return "rename_conversation", {"campaignId": args.campaign, "title": args.title}
    payload = json.loads(read_text(args.payload_file) if args.payload_file else args.payload)
    if not isinstance(payload, dict):
        raise ValueError("command payload must be a JSON object")
    return args.message_type, payload


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # Preserve the original resolution probe and endpoint-only snapshot entry.
    if argv and argv[0] == "--resolve-only":
        print(resolve(argv[1] if len(argv) > 1 else None))
        return 0
    actions = {"snapshot", "diagnose", "watch", "new", "send", "select", "runtime",
               "decision", "stop", "resume", "close-session", "rename", "command"}
    if argv and not argv[0].startswith("-") and argv[0] not in actions:
        argv = ["--endpoint", argv[0], *argv[1:]]
    args = parser().parse_args(argv)
    try:
        message_type, payload = command_for(args)
        if args.action == "watch" and (not math.isfinite(args.interval) or args.interval <= 0 or args.count < 0):
            raise ValueError("watch interval must be positive and count non-negative")
        if args.action == "watch" and args.request_id:
            raise ValueError("watch assigns a fresh request ID to each read; omit --request-id")
        previous = None
        sample = 0
        while True:
            response = call(args.endpoint, message_type, payload, timeout=args.timeout,
                            request_id=args.request_id)
            unchanged = False
            if args.action == "watch" and response["ok"]:
                update = response.get("payload", {})
                revision = update.get("revision")
                if not isinstance(revision, str) or not revision:
                    raise ClientError("Core refresh has no revision", response.get("requestId"), "READ_FAILED")
                payload = {"revision": revision}
                unchanged = update.get("unchanged") is True
            value = diagnostics(response) if args.action in {"diagnose", "watch"} else response
            encoded = json.dumps(value, ensure_ascii=False, indent=2 if args.pretty else None)
            if not unchanged and (args.action != "watch" or encoded != previous):
                print(encoded, flush=True)
                previous = encoded
            if not response["ok"]:
                return 2
            sample += 1
            if args.action != "watch" or (args.count and sample >= args.count):
                return 0
            time.sleep(args.interval)
    except ClientError as error:
        print(json.dumps(error.as_dict(), ensure_ascii=False), file=sys.stderr)
        return 3
    except (OSError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error), "deliveryState": "NOT_SENT"}), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
