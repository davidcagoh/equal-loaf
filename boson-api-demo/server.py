"""Local smoke-test server for Boson TTS, Realtime, and Avatar APIs (Python 3.10+)."""

from __future__ import annotations

import base64
from collections import deque
import json
import math
import os
import re
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).parent
API = "https://api.boson.ai/v1"
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_AVATAR_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TEXT_LENGTH = 5000
VOICE_NAMES = {"default", "chloe", "eleanor", "jake", "marcus", "nora", "oliver"}
GOAL_KINDS = {"follow", "stop", "approach", "gather", "give", "defend", "retreat", "report"}
RATE_LIMITS = {
    "/api/tts": (10, 3600),
    "/api/realtime-key": (5, 3600),
    "/api/avatar": (3, 3600),
    "/api/game-goal": (30, 3600),
}
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
IMAGE_DATA_URI = re.compile(r"^data:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$")
SSL = ssl.create_default_context(
    cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None
)


def load_api_key() -> str:
    for name in ("BOSON_API_KEY", "BOSON_API_KEY_100"):
        key = os.environ.get(name, "").strip()
        if key:
            return key

    root = ROOT.parent
    key = ""
    for key_path in (root / ".env", root / ".api", ROOT / ".api"):
        try:
            if key_path.name == ".env":
                for line in key_path.read_text(encoding="utf-8").splitlines():
                    name, separator, value = line.partition("=")
                    if separator and name.strip() in {"BOSON_API_KEY", "BOSON_API_KEY_100"}:
                        key = value.strip().strip("'\"")
                        if key:
                            break
            else:
                key = key_path.read_text(encoding="utf-8").strip()
            if key:
                return key
        except OSError:
            continue
    if not key:
        raise SystemExit("Set BOSON_API_KEY or BOSON_API_KEY_100, or place the key in project-root .env/.api before starting.")
    return key


KEY = load_api_key()


def boson(method: str, path: str, body: dict | None = None) -> tuple[int, str, bytes]:
    """Call a fixed Boson API route and return its response."""
    request = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300, context=SSL) as response:
            return response.status, response.headers.get("Content-Type", "application/octet-stream"), response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("Content-Type", "application/json"), error.read()


def parse_json_object(data: bytes) -> dict:
    payload = json.loads(data)
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    return payload


def require_text(payload: dict) -> str:
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH:
        raise ValueError(f"Text must contain 1 to {MAX_TEXT_LENGTH} characters.")
    return text


def require_voice(payload: dict) -> str:
    voice = payload.get("voice", "default")
    if not isinstance(voice, str) or voice not in VOICE_NAMES:
        raise ValueError("Choose a supported voice.")
    return voice


def require_image(payload: dict) -> str | None:
    image = payload.get("image")
    if image is None:
        return None
    if not isinstance(image, str):
        raise ValueError("Image must be a PNG, JPEG, or WebP data URI.")
    match = IMAGE_DATA_URI.fullmatch(image)
    if not match:
        raise ValueError("Image must be a base64 PNG, JPEG, or WebP data URI.")
    encoded = match.group(1)
    if len(encoded) > (MAX_AVATAR_IMAGE_BYTES * 4 // 3) + 8:
        raise ValueError("Image must be 8 MB or smaller.")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise ValueError("Image data is not valid base64.") from error
    if len(decoded) > MAX_AVATAR_IMAGE_BYTES:
        raise ValueError("Image must be 8 MB or smaller.")
    return image


class LocalServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int]):
        super().__init__(server_address, Handler)
        self.api_token = secrets.token_urlsafe(32)
        self.request_times = {path: deque() for path in RATE_LIMITS}
        self.rate_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server: LocalServer

    def send_body(
        self,
        status: int,
        content_type: str,
        data: bytes,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def send_json(
        self,
        status: int,
        payload: dict,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.send_body(
            status,
            "application/json; charset=utf-8",
            json.dumps(payload).encode(),
            extra_headers,
        )

    def _trusted_request(self, require_token: bool = False) -> bool:
        host = self.headers.get("Host", "").lower()
        port = self.server.server_address[1]
        allowed_hosts = {f"localhost:{port}", f"127.0.0.1:{port}"}
        if host not in allowed_hosts:
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin != f"http://{host}":
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            return False
        return not require_token or secrets.compare_digest(
            self.headers.get("X-Local-Token", ""), self.server.api_token
        )

    def _json_request(self) -> dict:
        if self.headers.get_content_type() != "application/json":
            raise ValueError("Submit a JSON request.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid request length.") from error
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("Request body is empty or exceeds the 12 MB limit.")
        return parse_json_object(self.rfile.read(length))

    def _consume_rate_slot(self, path: str) -> int | None:
        limit, period = RATE_LIMITS[path]
        now = time.monotonic()
        with self.server.rate_lock:
            requests = self.server.request_times[path]
            while requests and now - requests[0] >= period:
                requests.popleft()
            if len(requests) >= limit:
                return max(1, math.ceil(period - (now - requests[0])))
            requests.append(now)
            return None

    def do_GET(self) -> None:
        parsed_path = urlsplit(self.path)
        path = parsed_path.path
        result_match = re.fullmatch(r"/api/results/([A-Za-z0-9_-]{1,120})", path)
        if not self._trusted_request(require_token=path == "/api/status" or result_match is not None):
            self.send_json(403, {"error": "Request origin is not allowed."})
            return
        if path in {"/", "/index.html"}:
            html = (ROOT / "index.html").read_text(encoding="utf-8")
            html = html.replace("__LOCAL_API_TOKEN__", self.server.api_token)
            self.send_body(200, "text/html; charset=utf-8", html.encode("utf-8"))
            return
        if path == "/api/status":
            request = urllib.request.Request("http://127.0.0.1:8001/status")
            try:
                with urllib.request.urlopen(request, timeout=2) as response:
                    self.send_body(response.status, response.headers.get("Content-Type", "application/json"), response.read())
            except urllib.error.HTTPError as error:
                self.send_body(error.code, error.headers.get("Content-Type", "application/json"), error.read())
            except OSError:
                self.send_json(503, {"error": "The local goal scheduler is not running."})
            return
        if result_match:
            query = parse_qs(parsed_path.query)
            kinds = query.get("kind", [])
            if len(kinds) != 1 or kinds[0] not in GOAL_KINDS:
                self.send_json(400, {"error": "A valid goal kind is required."})
                return
            target = f"http://127.0.0.1:8001/results/{result_match.group(1)}?{urlencode({'kind': kinds[0]})}"
            try:
                with urllib.request.urlopen(target, timeout=2) as response:
                    self.send_body(response.status, response.headers.get("Content-Type", "application/json"), response.read())
            except urllib.error.HTTPError as error:
                self.send_body(error.code, error.headers.get("Content-Type", "application/json"), error.read())
            except OSError:
                self.send_json(503, {"error": "The local goal scheduler is not running."})
            return
        match = re.fullmatch(r"/api/avatar/([A-Za-z0-9_-]{1,120})(/content)?", path)
        if match:
            suffix = "/content" if match.group(2) else ""
            try:
                self.send_body(*boson("GET", f"/videos/{match.group(1)}{suffix}"))
            except OSError:
                self.send_json(502, {"error": "Boson API could not be reached."})
            return
        self.send_json(404, {"error": "Not found."})

    def do_POST(self) -> None:
        if not self._trusted_request(require_token=True):
            self.send_json(403, {"error": "Request origin or local token is not allowed."})
            return
        path = urlsplit(self.path).path
        if path not in {"/api/tts", "/api/realtime-key", "/api/avatar", "/api/game-goal", "/api/game-stop"}:
            self.send_json(404, {"error": "Not found."})
            return
        try:
            payload = self._json_request()
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
            self.send_json(400, {"error": str(error)[:200]})
            return

        try:
            if path == "/api/game-stop":
                if payload:
                    raise ValueError("Stop request does not accept fields.")
                endpoint = "/stop"
                request_body = {}
            elif path == "/api/game-goal":
                endpoint = "/goals"
                request_body = payload
            elif path == "/api/tts":
                text = require_text(payload)
                voice = require_voice(payload)
                endpoint = "/audio/speech"
                request_body = {
                    "model": "higgs-tts-3",
                    "input": text,
                    "voice": voice,
                    "normalize": True,
                    "language": "eng",
                }
            elif path == "/api/realtime-key":
                endpoint = "/realtime/client_secrets"
                request_body = {"expires_after": {"seconds": 600}}
            else:
                text = require_text(payload)
                voice = require_voice(payload)
                image = require_image(payload)
                endpoint = "/videos"
                request_body = {
                    "model": "higgs-avatar",
                    "ref_image": image or "https://docs.boson.ai/public/avatar/sample.jpg",
                    "input_tts": {
                        "model": "higgs-tts-3",
                        "input": text,
                        "voice": voice,
                        "normalize": True,
                        "language": "eng",
                    },
                    "size": "640x640",
                }
        except ValueError as error:
            self.send_json(400, {"error": str(error)[:200]})
            return

        retry_after = self._consume_rate_slot(path) if path in RATE_LIMITS else None
        if retry_after:
            self.send_json(
                429,
                {"error": "Local request limit reached; try again later."},
                {"Retry-After": str(retry_after)},
            )
            return
        try:
            if path in {"/api/game-goal", "/api/game-stop"}:
                request = urllib.request.Request(
                    f"http://127.0.0.1:8001{endpoint}",
                    method="POST",
                    data=json.dumps(request_body).encode(),
                    headers={"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.send_body(response.status, response.headers.get("Content-Type", "application/json"), response.read())
            else:
                self.send_body(*boson("POST", endpoint, request_body))
        except urllib.error.HTTPError as error:
            self.send_body(error.code, error.headers.get("Content-Type", "application/json"), error.read())
        except OSError:
            if path in {"/api/game-goal", "/api/game-stop"}:
                self.send_json(503, {"error": "The local goal scheduler is not running."})
            else:
                self.send_json(502, {"error": "Boson API could not be reached."})

    def log_message(self, fmt: str, *args) -> None:
        print(self.address_string(), fmt % args)


def main() -> None:
    server = LocalServer(("127.0.0.1", 8000))
    server.daemon_threads = True
    print("Boson dry run on http://127.0.0.1:8000")
    print("A per-run local request token protects paid API routes.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBoson dry run stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
