#!/usr/bin/env python3
"""Roda o bench offscreen do motor WebGL2 no WebKitGTK do sistema.

É o mesmo motor que o app Tauri usa no Linux (WebKit2GTK 4.1), numa
Gtk.OffscreenWindow: nada aparece na tela do usuário. Adaptado de
docs/design-refs/fundo-lab-v2/wk_bench.py.

Uso (na cmr-auto, com as variáveis do README):
    python3 run_bench.py <dir-do-build> [--query 'full&shots'] [--shots-dir DIR]
                         [--nogpuproc] [--timeout 300] [--json]

Serve o build num http.server em 127.0.0.1 (porta livre, só loopback),
abre index.html e espera o título "BENCH {json}". Com --shots-dir os
PNGs que a página envia (POST /shot?name=...) são gravados lá.
"""
import argparse
import http.server
import json
import os
import sys
import threading
import urllib.parse

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402


def make_handler(root, shots_dir):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, *_):
            pass

        def do_POST(self):
            u = urllib.parse.urlparse(self.path)
            name = os.path.basename(urllib.parse.parse_qs(u.query).get("name", ["shot.png"])[0])
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n)
            if shots_dir and u.path == "/shot" and name.endswith(".png"):
                os.makedirs(shots_dir, exist_ok=True)
                with open(os.path.join(shots_dir, name), "wb") as f:
                    f.write(body)
            self.send_response(204)
            self.end_headers()

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", help="diretório do build (npx vite build --config scripts/gl-bench/vite.config.ts)")
    ap.add_argument("--query", default="", help="query string da página, ex.: 'full&shots'")
    ap.add_argument("--shots-dir", default="", help="onde gravar os PNGs de ?shots")
    ap.add_argument("--nogpuproc", action="store_true", help="desliga UseGPUProcessForWebGL")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--json", action="store_true", help="imprime só o JSON")
    a = ap.parse_args()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), make_handler(os.path.abspath(a.root), a.shots_dir))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html" + (f"?{a.query}" if a.query else "")

    s = WebKit2.Settings()
    s.set_enable_webgl(True)
    s.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
    s.set_enable_write_console_messages_to_stdout(not a.json)
    if a.nogpuproc:
        feats = WebKit2.Settings.get_all_features()
        for i in range(feats.get_length()):
            f = feats.get(i)
            if f.get_identifier() == "UseGPUProcessForWebGL":
                s.set_feature_enabled(f, False)
                print("UseGPUProcessForWebGL = off", file=sys.stderr)
    wv = WebKit2.WebView.new_with_settings(s)
    win = Gtk.OffscreenWindow()
    win.set_default_size(1400, 900)
    win.add(wv)
    win.show_all()

    result = {"data": None}

    def on_title(*_):
        t = wv.get_title() or ""
        if t.startswith("BENCH "):
            result["data"] = json.loads(t[6:])
            Gtk.main_quit()

    def on_timeout():
        print("TIMEOUT", file=sys.stderr)
        Gtk.main_quit()
        return False

    wv.connect("notify::title", on_title)
    GLib.timeout_add_seconds(a.timeout, on_timeout)
    wv.load_uri(url)
    Gtk.main()
    srv.shutdown()

    data = result["data"]
    if data is None:
        sys.exit(2)
    if a.json:
        print(json.dumps(data, ensure_ascii=False))
        return
    print(f"renderer: {data.get('renderer')} · {data.get('size')} · {data.get('method')}")
    if data.get("error"):
        print("ERRO:", data["error"])
    for r in data.get("results", []):
        if r.get("error"):
            print(f"  {r['label']:<32} ERRO: {r['error']}")
            continue
        pct = r["ms"] / (1000 / 60) * 100
        print(
            f"  {r['label']:<32} {r['ms']:6.2f} ms ({pct:4.0f}% de 16,7 ms)"
            f"  min {r['min']:.2f}  max {r['max']:.2f}  saída {r['out']}"
            f"  acesos {r['lit'] * 100:.1f}%  glError {r['glError']}"
        )
    print("RESULT " + json.dumps(data, ensure_ascii=False))


if __name__ == "__main__":
    main()
