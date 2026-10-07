"""Account file for Invoice Book.

Local runs keep users in data/users.json. On Vercel the same records live in a
private Blob file, because the function filesystem is not kept between requests.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ITERATIONS = 200_000
SESSION_DAYS = 30
MAX_BODY = 1_500_000
BLOB_API = "https://vercel.com/api/blob"
BLOB_PATH = "invoice-book/accounts.json"
USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$")
LOGO_RE = re.compile(r"^data:image/(png|jpeg|jpg|webp|gif);base64,", re.I)
THEME_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
TEMPLATES = ("classic", "banner", "editorial", "soft", "trade")
LOCK = threading.Lock()


class AccountError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def now():
    return datetime.now(timezone.utc)


def iso(value):
    return value.replace(microsecond=0).isoformat()


def same(left, right):
    if not isinstance(left, str) or not isinstance(right, str) or len(left) != len(right):
        return False
    return hmac.compare_digest(left, right)


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
    if template not in TEMPLATES:
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


def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return digest.hex(), salt.hex()


def empty_book():
    return {"users": [], "sessions": []}


def live_sessions(sessions):
    cutoff = iso(now())
    return [item for item in sessions if isinstance(item, dict) and item.get("expires", "") > cutoff]


class FileStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.users_path = self.directory / "users.json"
        self.sessions_path = self.directory / "sessions.json"

    def read_json(self, path, fallback):
        if not path.exists():
            return fallback
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return fallback

    def write_json(self, path, payload):
        self.directory.mkdir(exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        temporary.replace(path)

    def read(self):
        users_payload = self.read_json(self.users_path, {"users": []})
        sessions_payload = self.read_json(self.sessions_path, {"sessions": []})
        users = users_payload.get("users") if isinstance(users_payload, dict) else []
        sessions = sessions_payload.get("sessions") if isinstance(sessions_payload, dict) else []
        if not isinstance(users, list):
            users = []
        if not isinstance(sessions, list):
            sessions = []
        sessions = live_sessions(sessions)
        return {"users": users, "sessions": sessions}

    def write(self, book):
        self.write_json(self.users_path, {"users": book.get("users", [])})
        self.write_json(self.sessions_path, {"sessions": book.get("sessions", [])})


_REQUEST = threading.local()


def bind_request(headers):
    _REQUEST.headers = headers


def request_headers():
    return getattr(_REQUEST, "headers", None)


def env_named(name):
    direct = os.environ.get(name, "")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    for key, value in os.environ.items():
        if key == name or key.endswith("_" + name):
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def header_named(headers, name):
    if headers is None:
        return ""
    value = headers.get(name, "")
    if isinstance(value, str) and value.strip():
        return value.strip()
    keys = headers.keys() if hasattr(headers, "keys") else []
    for key in keys:
        if isinstance(key, str) and key.lower() == name.lower():
            found = headers.get(key, "")
            if isinstance(found, str) and found.strip():
                return found.strip()
    return ""


def blob_credentials():
    headers = request_headers()
    store_id = env_named("BLOB_STORE_ID")
    token = env_named("BLOB_READ_WRITE_TOKEN")
    oidc = header_named(headers, "x-vercel-oidc-token") or env_named("VERCEL_OIDC_TOKEN")
    options = []
    if oidc and store_id:
        options.append(("oidc", oidc, store_id))
    if token:
        options.append(("token", token, store_id))
    return options


def missing_blob_message():
    if env_named("BLOB_STORE_ID"):
        return "The account file is connected to the Blob store, but this deployment did not receive an access token. Redeploy, then register again."
    return "Connect a Blob store to this Vercel project and redeploy. Open Storage, create a Blob store, and connect it to the project."


def blob_headers(kind, secret, store_id, extra=None):
    headers = {
        "authorization": "Bearer %s" % secret,
        "x-api-version": "12",
    }
    if kind == "oidc" and store_id:
        headers["x-vercel-blob-store-id"] = store_id
    if extra:
        headers.update(extra)
    return headers


def blob_request(method, url, headers, body=None):
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:240]
        raise AccountError(exc.code, detail or "The account file rejected the request.")
    except urllib.error.URLError as exc:
        raise AccountError(502, "The account file could not be reached.") from exc


class BlobStore:
    def read(self):
        options = blob_credentials()
        if not options:
            raise AccountError(503, missing_blob_message())
        last_error = None
        for kind, secret, store_id in options:
            try:
                return self._read_with(kind, secret, store_id)
            except AccountError as exc:
                last_error = exc
                if exc.status not in (401, 403):
                    raise
        raise last_error

    def _read_with(self, kind, secret, store_id):
        headers = blob_headers(kind, secret, store_id)
        listed = BLOB_API + "/?" + urllib.parse.urlencode({"prefix": BLOB_PATH, "limit": "20"})
        try:
            _status, raw = blob_request("GET", listed, headers)
        except AccountError as exc:
            if exc.status == 404:
                return empty_book()
            raise
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AccountError(502, "The account file returned an unreadable list.") from exc
        blobs = payload.get("blobs") if isinstance(payload, dict) else None
        match = None
        if isinstance(blobs, list):
            match = next((item for item in blobs if isinstance(item, dict) and item.get("pathname") == BLOB_PATH), None)
        if not match or not match.get("url"):
            return empty_book()
        file_headers = blob_headers(kind, secret, store_id, {"cache-control": "no-store"})
        try:
            _status, body = blob_request("GET", match["url"], file_headers)
        except AccountError as exc:
            if exc.status == 404:
                return empty_book()
            raise
        try:
            book = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return empty_book()
        if not isinstance(book, dict):
            return empty_book()
        users = book.get("users")
        sessions = book.get("sessions")
        return {
            "users": users if isinstance(users, list) else [],
            "sessions": live_sessions(sessions if isinstance(sessions, list) else []),
        }

    def write(self, book):
        options = blob_credentials()
        if not options:
            raise AccountError(503, missing_blob_message())
        body = json.dumps({"users": book.get("users", []), "sessions": book.get("sessions", [])}).encode("utf-8")
        extra = {
            "content-type": "application/json",
            "x-content-type": "application/json",
            "x-add-random-suffix": "0",
            "x-allow-overwrite": "1",
            "x-cache-control-max-age": "0",
            "x-vercel-blob-access": "private",
        }
        url = BLOB_API + "/?" + urllib.parse.urlencode({"pathname": BLOB_PATH})
        last_error = None
        for kind, secret, store_id in options:
            headers = blob_headers(kind, secret, store_id, extra)
            try:
                blob_request("PUT", url, headers, body)
                return
            except AccountError as exc:
                last_error = exc
                if exc.status in (400, 401, 403) and "x-vercel-blob-access" in headers:
                    public_headers = blob_headers(kind, secret, store_id, {key: value for key, value in extra.items() if key != "x-vercel-blob-access"})
                    try:
                        blob_request("PUT", url, public_headers, body)
                        return
                    except AccountError as retry:
                        last_error = retry
                        if retry.status not in (401, 403):
                            raise
                elif exc.status not in (401, 403):
                    raise
        message = last_error.message if last_error else "The account file could not be saved."
        raise AccountError(502, "The account file could not be saved. " + message)


def password_of(payload):
    password = payload.get("password") if isinstance(payload, dict) else ""
    return password if isinstance(password, str) else ""


def register(store, payload):
    if not isinstance(payload, dict):
        return 400, {"error": "Could not read that account."}
    username = text_field(payload, "username", 40)
    password = password_of(payload)
    company = clean_company(payload.get("company"))
    if not USERNAME_RE.match(username):
        return 400, {"error": "Username must be 3–40 characters and use letters, numbers, dots, or dashes."}
    if len(password) < 8 or len(password) > 200:
        return 400, {"error": "Password must be at least 8 characters."}
    if not company["name"]:
        return 400, {"error": "Add the company name."}
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
        book = store.read()
        if find_user(book["users"], username):
            return 409, {"error": "That username is already used."}
        book["users"].append(user)
        token = add_session(book, user)
        store.write(book)
    return 201, {"token": token, "user": public_user(user)}


def login(store, payload):
    if not isinstance(payload, dict):
        return 400, {"error": "Could not read that sign-in."}
    username = text_field(payload, "username", 40)
    password = password_of(payload)
    with LOCK:
        book = store.read()
        user = find_user(book["users"], username)
        valid = False
        if user and user.get("passwordSalt") and user.get("passwordHash"):
            try:
                digest, _salt = hash_password(password, bytes.fromhex(user["passwordSalt"]))
                valid = same(digest, user["passwordHash"])
            except ValueError:
                valid = False
        if not valid:
            return 401, {"error": "Username or password is incorrect."}
        token = add_session(book, user)
        store.write(book)
    return 200, {"token": token, "user": public_user(user)}


def logout(store, authorization):
    token = bearer(authorization)
    if token:
        with LOCK:
            book = store.read()
            book["sessions"] = [item for item in book["sessions"] if not same(item.get("token", ""), token)]
            store.write(book)
    return 200, {"ok": True}


def me(store, authorization):
    user = current_user(store, authorization)
    if not user:
        return 401, {"error": "Sign in again."}
    return 200, {"user": public_user(user)}


def profile(store, authorization, payload):
    user = current_user(store, authorization)
    if not user:
        return 401, {"error": "Sign in again."}
    if not isinstance(payload, dict):
        return 400, {"error": "Could not read those company details."}
    company = clean_company(payload.get("company"))
    if not company["name"]:
        return 400, {"error": "Company name is required."}
    with LOCK:
        book = store.read()
        current = next((item for item in book["users"] if item.get("id") == user["id"]), None)
        if not current:
            return 401, {"error": "Sign in again."}
        current["company"] = company
        store.write(book)
    return 200, {"user": public_user(current)}


def add_session(book, user):
    token = secrets.token_urlsafe(32)
    book["sessions"].append({
        "token": token,
        "userId": user["id"],
        "expires": iso(now() + timedelta(days=SESSION_DAYS)),
    })
    return token


def bearer(authorization):
    if not isinstance(authorization, str) or not authorization.startswith("Bearer "):
        return ""
    return authorization[7:].strip()


def current_user(store, authorization):
    token = bearer(authorization)
    if not token:
        return None
    with LOCK:
        book = store.read()
    match = next((item for item in book["sessions"] if same(item.get("token", ""), token)), None)
    if not match:
        return None
    return next((user for user in book["users"] if user.get("id") == match.get("userId")), None)


def read_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length < 0 or length > MAX_BODY:
        return None
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def send_json(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def hosted_store():
    return BlobStore()


def handle_http(handler, action):
    bind_request(handler.headers)
    try:
        authorization = handler.headers.get("Authorization", "")
        if action in ("me", "logout"):
            payload = None
        else:
            payload = read_body(handler)
            if payload is None:
                send_json(handler, 400, {"error": "Could not read that request."})
                return
        store = hosted_store()
        status, body = {
            "register": lambda: register(store, payload),
            "login": lambda: login(store, payload),
            "logout": lambda: logout(store, authorization),
            "me": lambda: me(store, authorization),
            "profile": lambda: profile(store, authorization, payload),
        }[action]()
        send_json(handler, status, body)
    except AccountError as exc:
        message = exc.message
        if exc.status >= 500 and not message.startswith("The account file") and "Connect a Blob store" not in message:
            message = "The account file could not be saved. " + message
        send_json(handler, exc.status if exc.status >= 400 else 502, {"error": message[:300]})
    except Exception:
        send_json(handler, 500, {"error": "Could not save the account."})
    finally:
        bind_request(None)
