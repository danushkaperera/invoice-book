"""Local account file for Invoice Book. No database: users live in data/users.json.

This file is named local_server.py on purpose. Vercel treats a root file named
server.py as the application and runs it during the build. This server stays
running, so that build never finishes. On Vercel, accounts are handled by api/.

Mail sent from this computer is delivered to a mailbox on 127.0.0.1 so it can
be opened and checked. It is not sent on to the internet.
"""

import base64
import re
import smtplib
import socketserver
import threading
from datetime import datetime, timezone
from email.message import EmailMessage
from email.parser import BytesParser
from email.policy import default
from email.utils import formataddr, parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import accountlib

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
HOST = "127.0.0.1"
PORT = 4173
MAIL_PORT = 1025
MAILBOX = DATA / "mailbox"
STORE = accountlib.FileStore(DATA)
MAIL_LOCK = threading.Lock()
SINK = None
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
STATIC = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}


class MailSink(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b"220 localhost Invoice Book\r\n")
        collecting = False
        lines = []
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if collecting:
                if line == ".":
                    save_mail("\r\n".join(lines).encode("utf-8"))
                    lines = []
                    collecting = False
                    self.wfile.write(b"250 Ok\r\n")
                else:
                    if line.startswith(".."):
                        line = line[1:]
                    lines.append(line)
                continue
            command = line.upper()
            if command.startswith("EHLO") or command.startswith("HELO"):
                self.wfile.write(b"250-localhost\r\n250 HELP\r\n")
            elif command == "DATA":
                collecting = True
                self.wfile.write(b"354 End data with <CR><LF>.<CR><LF>\r\n")
            elif command == "QUIT":
                self.wfile.write(b"221 Bye\r\n")
                return
            else:
                self.wfile.write(b"250 Ok\r\n")


class MailServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def save_mail(raw):
    MAILBOX.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
    with MAIL_LOCK:
        (MAILBOX / ("%s.eml" % stamp)).write_bytes(raw)
    return stamp


def mail_path(mail_id):
    if not re.fullmatch(r"\d{20,32}", mail_id or ""):
        return None
    path = (MAILBOX / ("%s.eml" % mail_id)).resolve()
    if MAILBOX.resolve() not in path.parents or not path.is_file():
        return None
    return path


def parse_mail(path):
    return BytesParser(policy=default).parsebytes(path.read_bytes())


def mail_summary(path):
    message = parse_mail(path)
    plain = message.get_body(preferencelist=("plain",))
    text = plain.get_content() if plain is not None else ""
    sent = ""
    try:
        sent = parsedate_to_datetime(message.get("Date")).isoformat()
    except (TypeError, ValueError, IndexError):
        sent = ""
    return {
        "id": path.stem,
        "to": str(message.get("To", "")),
        "from": str(message.get("From", "")),
        "subject": str(message.get("Subject", "")),
        "date": sent,
        "text": text[:4000],
    }


def list_mail():
    if not MAILBOX.is_dir():
        return []
    paths = sorted(MAILBOX.glob("*.eml"), reverse=True)[:20]
    messages = []
    for path in paths:
        try:
            messages.append(mail_summary(path))
        except Exception:
            continue
    return messages


def deliver_mail(payload):
    to = str(payload.get("to", "")).strip()
    subject = str(payload.get("subject", "")).replace("\r", " ").replace("\n", " ").strip()
    text = str(payload.get("text", "")).replace("\r\n", "\n").replace("\r", "\n")
    filename = str(payload.get("filename", "invoice.pdf")).strip() or "invoice.pdf"
    from_name = str(payload.get("fromName", "")).replace("\r", " ").replace("\n", " ").strip()
    from_email = str(payload.get("fromEmail", "")).strip()
    if not EMAIL_RE.match(to):
        return 400, {"error": "Enter the client's email address."}
    if not subject or len(subject) > 200:
        return 400, {"error": "The email subject is missing."}
    if not text or len(text) > 8000:
        return 400, {"error": "The email message is missing."}
    if not re.fullmatch(r"[\w.-]{1,80}", filename):
        filename = "invoice.pdf"
    try:
        pdf = base64.b64decode(str(payload.get("pdf", "")), validate=True)
    except Exception:
        return 400, {"error": "The invoice attachment could not be read."}
    if len(pdf) < 8 or not pdf.startswith(b"%PDF") or len(pdf) > 1_000_000:
        return 400, {"error": "The invoice attachment could not be read."}
    if not EMAIL_RE.match(from_email):
        from_email = "invoice@localhost"
    message = EmailMessage()
    message["From"] = formataddr((from_name or "Invoice", from_email))
    message["To"] = to
    message["Subject"] = subject
    message["Date"] = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
    message.set_content(text)
    message.add_attachment(pdf, maintype="application", subtype="pdf", filename=filename)
    raw = message.as_bytes()
    try:
        if SINK is not None:
            with smtplib.SMTP(HOST, MAIL_PORT, timeout=5) as smtp:
                smtp.send_message(message)
        else:
            save_mail(raw)
    except Exception:
        return 500, {"error": "Could not send the email."}
    return 200, {"ok": True, "messages": list_mail()}


def start_mail():
    global SINK
    try:
        SINK = MailServer((HOST, MAIL_PORT), MailSink)
    except OSError as exc:
        SINK = None
        print("Local mail port %s is busy (%s). Messages are still saved in the mailbox folder." % (MAIL_PORT, exc))
        return
    threading.Thread(target=SINK.serve_forever, daemon=True).start()
    print("Local mailbox is ready. Test mail stays on this computer.")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/me":
            self.respond(lambda: accountlib.me(STORE, self.headers.get("Authorization", "")))
            return
        if path == "/api/mail":
            accountlib.send_json(self, 200, {"messages": list_mail()})
            return
        pdf_match = re.fullmatch(r"/api/mail/(\d+)\.pdf", path)
        if pdf_match:
            self.serve_mail_pdf(pdf_match.group(1))
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
        elif path == "/api/mail":
            self.respond(lambda payload: deliver_mail(payload), body=True)
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

    def serve_mail_pdf(self, mail_id):
        path = mail_path(mail_id)
        if path is None:
            self.send_error(404)
            return
        message = parse_mail(path)
        pdf = None
        filename = "invoice.pdf"
        for part in message.walk():
            if part.get_content_type() == "application/pdf":
                pdf = part.get_payload(decode=True)
                filename = part.get_filename() or filename
                break
        if not pdf:
            self.send_error(404)
            return
        safe_name = filename.replace('"', "")
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(pdf)))
        self.send_header("Content-Disposition", 'inline; filename="%s"' % safe_name)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(pdf)


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    start_mail()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Invoice Book account file is ready at http://%s:%s" % (HOST, PORT))
    print("Accounts are stored in %s" % (DATA / "users.json"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")
