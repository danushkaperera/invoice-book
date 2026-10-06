"""Local account file for Invoice Book. No database: users live in data/users.json."""

import hashlib
import hmac
import json
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
USERS_PATH = DATA / "users.json"
SESSIONS_PATH = DATA / "sessions.json"
HOST = "127.0.0.1"
PORT = 4173
ITERATIONS = 200_000
SESSION_DAYS = 30
MAX_BODY = 1_500_000
STATIC = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}

LOCK = threading.Lock()
USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$")
LOGO_RE = re.compile(r"^data:image/(png|jpeg|jpg|webp|gif);base64,", re.I)
THEME_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def now():
    return datetime.now(timezone.utc)


def iso(value):
    return value.replace(microsecond=0).isoformat()


def read_json(path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def write_json(path, payload):
    DATA.mkdir(exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary.replace(path)


def load_users():
    payload = read_json(USERS_PATH, {"users": []})
    users = payload.get("users")
    return users if isinstance(users, list) else []


def save_users(users):
    write_json(USERS_PATH, {"users": users})


def load_sessions():
    payload = read_json(SESSIONS_PATH, {"sessions": []})
    sessions = payload.get("sessions")
    if not isinstance(sessions, list):
        return []
    cutoff = iso(now())
    kept = [item for item in sessions if isinstance(item, dict) and item.get("expires", "") > cutoff]
    if len(kept) != len(sessions):
        save_sessions(kept)
    return kept


def save_sessions(sessions):
    write_json(SESSIONS_PATH, {"sessions": sessions})


def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return digest.hex(), salt.hex()


def text_field(source, key, limit):
    value = source.get(key, "")
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def clean_company(raw):
    source = raw if isinstance(raw, dict) else {}
    logo = source.get("logo", "")
    if not isinstance(logo, str) or len(logo) > 600_000 or not LOGO_RE.match(logo):
        logo = ""
    template = source.get("template")
    if template not in ("classic", "banner", "editorial"):
        template = "classic"
    theme = source.get("theme")
    if not isinstance(theme, str) or not THEME_RE.match(theme):
        theme = "#1e4d3a"
    return {
        "name": text_field(source, "name", 120),
        "abn": text_field(source, "abn", 20),
        "address": text_field(source, "address", 500),
        "phone": text_field(source, "phone", 40),
        "email": text_field(source, "email", 120),
        "logo": logo,
        "template": template,
        "theme": theme.lower(),
    }


def public_user(user):
    return {"id": user["id"], "username": user["username"], "company": user["company"]}


def find_user(users, username):
    folded = username.casefold()
    for user in users:
        if str(user.get("username", "")).casefold() == folded:
            return user
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/me":
            self.handle_me()
            return
        self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/register":
            self.handle_register()
        elif path == "/api/login":
            self.handle_login()
        elif path == "/api/logout":
            self.handle_logout()
        else:
            self.send_json(404, {"error": "Not found."})

    def do_PUT(self):
        path = urlparse(self.path).path
        if path == "/api/profile":
            self.handle_profile()
        else:
            self.send_json(404, {"error": "Not found."})

    def read_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length < 0 or length > MAX_BODY:
            return None
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def current_user(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return None
        token = header[7:].strip()
        if not token:
            return None
        with LOCK:
            sessions = load_sessions()
            match = next((item for item in sessions if hmac.compare_digest(item.get("token", ""), token)), None)
            if not match:
                return None
            users = load_users()
            return next((user for user in users if user.get("id") == match.get("userId")), None)

    def issue_session(self, user):
        token = secrets.token_urlsafe(32)
        record = {"token": token, "userId": user["id"], "expires": iso(now() + timedelta(days=SESSION_DAYS))}
        with LOCK:
            sessions = load_sessions()
            sessions.append(record)
            save_sessions(sessions)
        return token

    def handle_register(self):
        payload = self.read_body()
        if payload is None:
            self.send_json(400, {"error": "Could not read that account."})
            return
        username = text_field(payload, "username", 40)
        password = payload.get("password")
        if not isinstance(password, str):
            password = ""
        company = clean_company(payload.get("company"))
        if not USERNAME_RE.match(username):
            self.send_json(400, {"error": "Username must be 3–40 characters and use letters, numbers, dots, or dashes."})
            return
        if len(password) < 8 or len(password) > 200:
            self.send_json(400, {"error": "Password must be at least 8 characters."})
            return
        if not company["name"]:
            self.send_json(400, {"error": "Add the company name."})
            return
        digest, salt = hash_password(password)
        user = {
            "id": secrets.token_hex(16),
            "username": username,
            "passwordHash": digest,
            "passwordSalt": salt,
            "iterations": ITERATIONS,
            "company": company,
            "createdAt": iso(now()),
        }
        with LOCK:
            users = load_users()
            if find_user(users, username):
                self.send_json(409, {"error": "That username is already used."})
                return
            users.append(user)
            save_users(users)
        token = self.issue_session(user)
        self.send_json(201, {"token": token, "user": public_user(user)})

    def handle_login(self):
        payload = self.read_body()
        if payload is None:
            self.send_json(400, {"error": "Could not read that sign-in."})
            return
        username = text_field(payload, "username", 40)
        password = payload.get("password")
        if not isinstance(password, str):
            password = ""
        with LOCK:
            user = find_user(load_users(), username)
        valid = False
        if user and user.get("passwordSalt") and user.get("passwordHash"):
            try:
                digest, _salt = hash_password(password, bytes.fromhex(user["passwordSalt"]))
                valid = hmac.compare_digest(digest, user["passwordHash"])
            except ValueError:
                valid = False
        if not valid:
            self.send_json(401, {"error": "Username or password is incorrect."})
            return
        token = self.issue_session(user)
        self.send_json(200, {"token": token, "user": public_user(user)})

    def handle_logout(self):
        header = self.headers.get("Authorization", "")
        token = header[7:].strip() if header.startswith("Bearer ") else ""
        if token:
            with LOCK:
                sessions = [
                    item for item in load_sessions()
                    if not hmac.compare_digest(item.get("token", ""), token)
                ]
                save_sessions(sessions)
        self.send_json(200, {"ok": True})

    def handle_me(self):
        user = self.current_user()
        if not user:
            self.send_json(401, {"error": "Sign in again."})
            return
        self.send_json(200, {"user": public_user(user)})

    def handle_profile(self):
        user = self.current_user()
        if not user:
            self.send_json(401, {"error": "Sign in again."})
            return
        payload = self.read_body()
        if payload is None:
            self.send_json(400, {"error": "Could not read those company details."})
            return
        company = clean_company(payload.get("company"))
        if not company["name"]:
            self.send_json(400, {"error": "Company name is required."})
            return
        with LOCK:
            users = load_users()
            current = next((item for item in users if item.get("id") == user["id"]), None)
            if not current:
                self.send_json(401, {"error": "Sign in again."})
                return
            current["company"] = company
            save_users(users)
        self.send_json(200, {"user": public_user(current)})

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
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Invoice Book account file is ready at http://%s:%s" % (HOST, PORT))
    print("Accounts are stored in %s" % USERS_PATH)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")
