"""Local account file for Invoice Book. No database: users live in data/users.json."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import accountlib

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
HOST = "127.0.0.1"
PORT = 4173
STORE = accountlib.FileStore(DATA)
STATIC = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/me":
            self.respond(lambda: accountlib.me(STORE, self.headers.get("Authorization", "")))
            return
        self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/register":
            self.respond(lambda payload: accountlib.register(STORE, payload), body=True)
        elif path == "/api/login":
            self.respond(lambda payload: accountlib.login(STORE, payload), body=True)
        elif path == "/api/logout":
            self.respond(lambda: accountlib.logout(STORE, self.headers.get("Authorization", "")))
        else:
            accountlib.send_json(self, 404, {"error": "Not found."})

    def do_PUT(self):
        path = urlparse(self.path).path
        if path == "/api/profile":
            self.respond(
                lambda payload: accountlib.profile(STORE, self.headers.get("Authorization", ""), payload),
                body=True,
            )
        else:
            accountlib.send_json(self, 404, {"error": "Not found."})

    def respond(self, action, body=False):
        try:
            if body:
                payload = accountlib.read_body(self)
                if payload is None:
                    accountlib.send_json(self, 400, {"error": "Could not read that request."})
                    return
                status, result = action(payload)
            else:
                status, result = action()
            accountlib.send_json(self, status, result)
        except accountlib.AccountError as exc:
            accountlib.send_json(self, exc.status, {"error": exc.message})
        except Exception:
            accountlib.send_json(self, 500, {"error": "Could not save the account."})

    def serve_static(self, path):
        cleaned = unquote(path.split("?", 1)[0])
        if cleaned in ("", "/"):
            cleaned = "/index.html"
        relative = cleaned.lstrip("/")
        if relative.startswith("data/") or ".." in relative.replace("\\", "/").split("/"):
            self.send_error(404)
            return
        file_path = (ROOT / relative).resolve()
        if ROOT not in file_path.parents and file_path != ROOT:
            self.send_error(404)
            return
        if not file_path.is_file():
            self.send_error(404)
            return
        content_type = STATIC.get(file_path.suffix.lower(), "application/octet-stream")
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Invoice Book account file is ready at http://%s:%s" % (HOST, PORT))
    print("Accounts are stored in %s" % (DATA / "users.json"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")
