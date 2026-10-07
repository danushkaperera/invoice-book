import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import accountlib


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        accountlib.handle_http(self, "me")
