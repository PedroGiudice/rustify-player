#!/usr/bin/env python3
"""cdp_eval.py "<expressão JS>" — avalia no WebView do rustify (S24) e imprime JSON. Roda NA CMR-AUTO."""
import json, subprocess, sys, time
import urllib.request
from websocket import create_connection

PKG = "dev.cmr.rustifyplayer"
PORT = 9333


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()


def main():
    expr = sys.argv[1]
    pid = sh(f"adb shell pidof {PKG}")
    if not pid:
        sys.exit("app nao esta rodando")
    sh(f"adb forward --remove tcp:{PORT}")
    sh(f"adb forward tcp:{PORT} localabstract:webview_devtools_remote_{pid}")
    url = None
    for _ in range(30):
        try:
            for p in json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5)):
                if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
                    url = p["webSocketDebuggerUrl"]; break
        except Exception:
            pass
        if url: break
        time.sleep(0.5)
    if not url:
        sys.exit("nenhuma page no CDP")
    ws = create_connection(url, suppress_origin=True, timeout=90)
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == 1:
            r = m.get("result", {})
            if "exceptionDetails" in r:
                print(json.dumps({"__error": r["exceptionDetails"].get("exception", {}).get("value") or str(r["exceptionDetails"])[:400]}, ensure_ascii=False))
            else:
                print(json.dumps(r.get("result", {}).get("value"), ensure_ascii=False, indent=1))
            return


if __name__ == "__main__":
    main()
