#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""静态服务器（多线程）。

用法:
    python serve.py [port] [host]        默认 8100 / 0.0.0.0

目录约定:
    /            -> index.html
    /lib/…       -> lib/
    /vendor/…    -> vendor/
    /data/…      -> data/
    /ui/…        -> assets/ui/…        (官方 HUD / 音频 / 场景贴图，见 assets/README.md)
    /chibi/…     -> assets/chibi/…     (官方小人骨骼)
    /__chibi?dir=<id>  -> 列出该小人目录里的 skel/atlas/png
"""
import http.server, socketserver, sys, os, json
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"


class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = unquote(path.split("?", 1)[0])
        if p in ("/", ""):
            return str(ROOT / "index.html")
        if p.startswith("/ui/"):
            return str(ASSETS / "ui" / p[len("/ui/"):])
        if p.startswith("/chibi/"):
            return str(ASSETS / p.lstrip("/"))
        return str(ROOT / p.lstrip("/"))

    def do_GET(self):
        if self.path.startswith("/__chibi"):
            qs = parse_qs(urlparse(self.path).query)
            d = ASSETS / "chibi" / qs.get("dir", [""])[0]
            out = {"skel": None, "atlas": None, "png": [], "missing": not d.is_dir()}
            if d.is_dir():
                for f in sorted(os.listdir(d)):
                    if f.endswith(".skel"): out["skel"] = f
                    elif f.endswith(".atlas"): out["atlas"] = f
                    elif f.endswith(".png"): out["png"].append(f)
            body = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8100
    host = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"
    Cls = socketserver.ThreadingTCPServer
    Cls.daemon_threads = True
    Cls.allow_reuse_address = True
    with Cls((host, port), H) as httpd:
        print(f"cujong football standalone -> http://{host}:{port}")
        if not (ASSETS / "chibi").is_dir():
            print("assets/ is empty: chibi & official HUD will not render. See assets/README.md")
        httpd.serve_forever()
