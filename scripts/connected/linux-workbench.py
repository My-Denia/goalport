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


def make_handler(endpoint: str, dist: Path, unix_client, timeout: float):
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
    args = parser.parse_args(argv)
    if args.host != "127.0.0.1":
        raise SystemExit("The workbench bridge listens on 127.0.0.1 only")
    dist = args.dist.resolve()
    index = dist / "index.html"
    if not index.is_file():
        raise SystemExit(f"Built renderer not found at {index}. Run pnpm build first.")
    unix_client = load_unix_client()
    endpoint = unix_client.resolve(args.endpoint)
    handler = make_handler(endpoint, dist, unix_client, args.timeout)
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
