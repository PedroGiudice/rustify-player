#!/usr/bin/env python3
"""E2E do auto-update no S24 (CMR-210), dirigido por CDP + adb. Roda NA CMR-AUTO, aparelho DESBLOQUEADO (com keyguard o app fica sem rede).

Cenários numa única subida 0.2.76 -> 0.2.77:
  1. check manual -> `available` com a versão nova
  2. install com o app INVISÍVEL durante o download (HOME) -> fase confirm_pending
     -> ao reabrir o app, o diálogo do sistema aparece
  3. cancelar o diálogo (BACK) -> fase failed + "Tentar de novo"
  4. retry -> diálogo -> aceitar (tap no botão via uiautomator) -> app reinstala
  5. reabrir -> app_version 0.2.77; device.json e journal intactos

Uso: uv run --with websocket-client e2e_updater.py [--accept-manual]
  --accept-manual: no passo 4 espera o CEO tocar em "Atualizar" em vez de tentar o tap.
"""
import json, re, subprocess, sys, time
import urllib.request
from websocket import create_connection

PKG = "dev.cmr.rustifyplayer"
PORT = 9333
INV = "window.__TAURI__.core.invoke"


def sh(cmd, timeout=60):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def pid():
    return sh(f"adb shell pidof {PKG}")


def launch():
    sh(f"adb shell monkey -p {PKG} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1")


def forward():
    p = pid()
    if not p:
        launch(); time.sleep(6); p = pid()
    if not p:
        sys.exit("app nao subiu")
    sh(f"adb forward --remove tcp:{PORT}")
    sh(f"adb forward tcp:{PORT} localabstract:webview_devtools_remote_{p}")
    return p


def ws_url():
    for _ in range(30):
        try:
            for pg in json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list")):
                if pg.get("type") == "page" and pg.get("webSocketDebuggerUrl"):
                    return pg["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.5)
    sys.exit("nenhuma page no CDP")


class CDP:
    def __init__(self):
        forward()
        self.ws = create_connection(ws_url(), suppress_origin=True, timeout=60)
        self.i = 0

    def eval(self, expr, awaitp=True):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": "Runtime.evaluate",
                                 "params": {"expression": expr, "returnByValue": True, "awaitPromise": awaitp}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.i:
                r = m.get("result", {})
                if "exceptionDetails" in r:
                    return {"__error": str(r["exceptionDetails"])[:400]}
                return r.get("result", {}).get("value")


def updbar(c):
    c.eval("location.hash = '#/settings'", awaitp=False)
    time.sleep(0.6)
    return c.eval("document.querySelector('.updbar')?.innerText ?? document.body.innerText.match(/Atualiza[^\\n]*\\n[^\\n]*\\n[^\\n]*/)?.[0]")


def logcat_updater(n=12):
    return sh(f"adb logcat -d -s RustifyUpdater:* PackageInstaller:* | tail -n {n}")


def tap_install_button():
    """Acha o botão de confirmar no diálogo do PackageInstaller via uiautomator e toca."""
    sh("adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1")
    xml = sh("adb shell cat /sdcard/ui.xml")
    for label in ("Atualizar", "Update", "Instalar", "Install", "Reinstalar"):
        m = re.search(r'text="' + label + r'"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
        if m:
            x = (int(m.group(1)) + int(m.group(3))) // 2
            y = (int(m.group(2)) + int(m.group(4))) // 2
            sh(f"adb shell input tap {x} {y}")
            return label, (x, y)
    return None, xml[:300]


def main():
    manual = "--accept-manual" in sys.argv
    out = {}
    sh("adb shell svc power stayon usb")
    sh("adb logcat -c")
    c = CDP()
    out["versao_antes"] = c.eval(f"{INV}('app_version')")

    # 1. check manual
    chk = c.eval(f"{INV}('plugin:rustify-audio|updater_check', {{manifestUrl: null}})")
    out["check"] = chk
    if not (isinstance(chk, dict) and chk.get("available")):
        print(json.dumps(out, ensure_ascii=False, indent=1)); sys.exit("sem update disponivel")

    # 2. install com o app invisível durante o download
    st = c.eval(f"{INV}('plugin:rustify-audio|updater_install', {{url: {json.dumps(chk['apkUrl'])}, sha256: {json.dumps(chk['sha256'])}, size: {chk['size']}}})")
    out["install_1"] = st
    time.sleep(1.5)
    sh("adb shell input keyevent KEYCODE_HOME")   # app vai pro background no meio do download
    time.sleep(30)                                 # download (37 MB) + sha256 + commit da session
    out["logcat_apos_home"] = logcat_updater(8)
    launch(); time.sleep(4)                        # onResume -> confirmação diferida dispara
    out["ui_dialog_1"] = sh("adb shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -2")
    time.sleep(2)

    # 3. cancelar o diálogo
    sh("adb shell input keyevent KEYCODE_BACK")
    time.sleep(3)
    c = CDP()
    out["fase_apos_cancel"] = updbar(c)
    out["logcat_apos_cancel"] = logcat_updater(6)

    # 4. retry e aceitar
    st2 = c.eval(f"{INV}('plugin:rustify-audio|updater_install', {{url: {json.dumps(chk['apkUrl'])}, sha256: {json.dumps(chk['sha256'])}, size: {chk['size']}}})")
    out["install_2"] = st2
    time.sleep(30)
    out["ui_dialog_2"] = sh("adb shell dumpsys window | grep -E 'mCurrentFocus' | head -1")
    if manual:
        print("Toque em Atualizar no S24 (60s)..."); time.sleep(60)
    else:
        out["tap"] = tap_install_button()
        time.sleep(25)

    # 5. reabrir e conferir
    launch(); time.sleep(8)
    c = CDP()
    out["versao_depois"] = c.eval(f"{INV}('app_version')")
    out["versionName"] = sh(f"adb shell dumpsys package {PKG} | grep versionName").strip()
    out["device_json"] = sh(f"adb shell run-as {PKG} cat device.json")
    out["journal_linhas"] = sh(f"adb shell run-as {PKG} wc -l files/play_events.jsonl")
    out["updbar_final"] = updbar(c)
    out["logcat_final"] = logcat_updater(10)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
