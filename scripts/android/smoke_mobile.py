#!/usr/bin/env python3
"""Smoke da UI mobile no S24 via CDP (roda NA CMR-AUTO: scp este arquivo + cdp_eval.py pra /tmp; app aberto na Home, aparelho DESBLOQUEADO).

Cobre: versão, tabbar (CMR-213), shuffle de playlist com continuidade off
(CMR-211), linha tocada = head manual + cauda playlist (CMR-211), shuffle do
restante (CMR-218), like -> journal (CMR-220), Recently played (CMR-215),
capas do export (CMR-212, só depois do push das covers).

Uso: ~/.local/bin/uv run --with websocket-client smoke_mobile.py [--no-recents]  (recents espera 23 s)
"""
import json, subprocess, sys, time
import urllib.request
from websocket import create_connection  # websocket-client

PKG = "dev.cmr.rustifyplayer"
PORT = 9333


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()


def setup_forward():
    pid = sh(f"adb shell pidof {PKG}")
    if not pid:
        sys.exit("app nao esta rodando")
    sh(f"adb forward --remove tcp:{PORT}")
    sh(f"adb forward tcp:{PORT} localabstract:webview_devtools_remote_{pid}")
    return pid


def ws_url():
    for _ in range(20):
        try:
            for p in json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5)):
                if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
                    return p["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.5)
    sys.exit("nenhuma page no CDP")


class CDP:
    def __init__(self, url):
        self.ws = create_connection(url, suppress_origin=True, timeout=40)
        self.i = 0

    def eval(self, expr, awaitp=True):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": "Runtime.evaluate",
                                 "params": {"expression": expr, "returnByValue": True, "awaitPromise": awaitp}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.i:
                r = msg.get("result", {})
                if "exceptionDetails" in r:
                    return {"__error": str(r["exceptionDetails"])[:400]}
                return r.get("result", {}).get("value")


INV = "window.__TAURI__.core.invoke"
Q = f"{INV}('plugin:rustify-audio|get_queue')"
ST = f"{INV}('continuity_status')"


def journal_tail(n=3):
    return sh(f"adb shell run-as {PKG} tail -n {n} files/play_events.jsonl")


def main():
    no_recents = "--no-recents" in sys.argv
    setup_forward()
    c = CDP(ws_url())
    out = {}
    ok = lambda k, cond: out.__setitem__(k, "OK" if cond else "FALHOU")

    out["version"] = c.eval(f"{INV}('app_version')")
    out["tabbar"] = c.eval("[...document.querySelectorAll('.tabbar .tab span')].map(e => e.textContent)")
    ok("CMR-213 tabbar", out["tabbar"] == ["Home", "Search", "Library", "Queue"])

    # pasta com >= 8 faixas
    folder = c.eval(f"{INV}('lib_list_folders').then(fs => (fs.find(f => f.track_count >= 8) || fs[0]).name)")
    out["folder"] = folder
    c.eval(f"(async () => window.__mobileStore.shuffleFolder(await {INV}('lib_list_folder_tracks', {{name: {json.dumps(folder)}}}), {json.dumps(folder)}))()")
    time.sleep(2.5)
    q = c.eval(f"{Q}.then(q => ({{n: q.items.length, index: q.index, origins: [...new Set(q.items.map(i => i.origin))], ctx: [...new Set(q.items.map(i => i.contextId))]}}))")
    st = c.eval(ST)
    out["shuffleFolder.queue"] = q
    out["shuffleFolder.status"] = {k: st.get(k) for k in ("mode", "contextId", "enabled")} if isinstance(st, dict) else st
    ok("CMR-211 shuffle: continuidade off + contexto", isinstance(st, dict) and st.get("mode") == "off" and q and q["ctx"] == [folder] and q["origins"] == ["autoplay"])

    # linha tocada: head manual + cauda playlist
    c.eval(f"(async () => window.__mobileStore.playFolderFrom(await {INV}('lib_list_folder_tracks', {{name: {json.dumps(folder)}}}), 2, {json.dumps(folder)}))()")
    time.sleep(2.5)
    q = c.eval(f"{Q}.then(q => ({{index: q.index, head: q.items[q.index], others: [...new Set(q.items.filter((_, i) => i !== q.index).map(i => i.origin))], headCtx: q.items[q.index].contextId}}))")
    out["playFolderFrom.queue"] = q
    ok("CMR-211 linha: head manual + cauda playlist", q and q["index"] == 2 and q["head"]["origin"] == "manual" and q["headCtx"] == folder and q["others"] == ["playlist"])
    out["badge"] = c.eval("document.querySelector('.dock .srcbadge')?.textContent")

    # shuffle do restante: mesma corrente, mesmo multiset, origin por item preservado
    before = c.eval(f"{Q}.then(q => ({{index: q.index, cur: q.items[q.index].trackId, ids: q.items.map(i => i.trackId).sort(), byId: Object.fromEntries(q.items.map(i => [i.trackId, i.origin + '|' + i.contextId]))}}))")
    pos0 = c.eval(f"{INV}('plugin:rustify-audio|get_state').then(s => s.positionMs)")
    r = c.eval("window.__mobileStore.shuffleUpcoming()")
    time.sleep(1.5)
    after = c.eval(f"{Q}.then(q => ({{index: q.index, cur: q.items[q.index].trackId, ids: q.items.map(i => i.trackId).sort(), byId: Object.fromEntries(q.items.map(i => [i.trackId, i.origin + '|' + i.contextId])), order: q.items.map(i => i.trackId)}}))")
    pos1 = c.eval(f"{INV}('plugin:rustify-audio|get_state').then(s => s.positionMs)")
    out["shuffleUpcoming"] = {"index": (before["index"], after["index"]), "cur_igual": before["cur"] == after["cur"],
                              "multiset_igual": before["ids"] == after["ids"], "meta_igual": before["byId"] == after["byId"],
                              "pos": (pos0, pos1), "toast": c.eval("document.querySelector('.toast')?.textContent")}
    ok("CMR-218 shuffle do restante", before["cur"] == after["cur"] and before["ids"] == after["ids"] and before["byId"] == after["byId"] and pos1 >= pos0)
    out["np.ctrls"] = c.eval("(() => { location.hash = '#/np'; return new Promise(r => setTimeout(() => r({ctrls: document.querySelectorAll('.np .ctrls button').length, heart: !!document.querySelector('.nphead [aria-label=\"Curtir\"]'), shuffle: !!document.querySelector('.np .ctrls [aria-label=\"Embaralhar o restante\"]'), repeatHeader: !!document.querySelector('.nphead [aria-label*=\"epet\"]')}), 600)); })()")
    ok("CMR-218/220 layout NP", out["np.ctrls"] and out["np.ctrls"]["ctrls"] == 5 and out["np.ctrls"]["heart"] and out["np.ctrls"]["shuffle"] and not out["np.ctrls"]["repeatHeader"])

    # like -> journal
    liked0 = c.eval(f"(async () => {{ const q = await {Q}; const t = (await {INV}('lib_get_tracks_by_ids', {{ids: [q.items[q.index].trackId]}}))[0]; window.__smokeTrack = t; return window.__mobileStore.isLiked(t); }})()")
    c.eval("window.__mobileStore.toggleLike(window.__smokeTrack)")
    time.sleep(1.2)
    l1 = journal_tail(1)
    c.eval("window.__mobileStore.toggleLike(window.__smokeTrack)")
    time.sleep(1.2)
    l2 = journal_tail(2)
    out["like.journal"] = {"liked_antes": liked0, "linha1": l1[:160], "linhas2": l2[:340]}
    exp1, exp2 = ("like", "unlike") if not liked0 else ("unlike", "like")
    ok("CMR-220 like/unlike no journal", f'"event_type":"{exp1}"' in l1 and f'"event_type":"{exp2}"' in l2.splitlines()[-1] and "started_at" in l1 and "duration_ms" in l1)

    # capas do export (só significa algo depois do push das covers)
    cov = c.eval(f"{INV}('lib_list_folder_tracks', {{name: 'Rap & Hip-Hop'}}).then(ts => ({{n: ts.length, export: ts.filter(t => (t.album_cover_path||'').includes('.rustify/covers/')).length, distintas: new Set(ts.map(t => t.album_cover_path)).size}})).catch(e => String(e))")
    out["covers"] = cov

    # recently played: precisa de >= 20s de escuta
    if not no_recents:
        c.eval("location.hash = '#/home'", awaitp=False)
        c.eval(f"(async () => window.__mobileStore.playFolder(await {INV}('lib_list_folder_tracks', {{name: {json.dumps(folder)}}}), {json.dumps(folder)}))()")
        time.sleep(23)
        c.eval("window.__mobileStore.next()")
        time.sleep(2.5)
        rec = c.eval("window.__mobileStore.loadRecents().then(() => [...document.querySelectorAll('.sec')].map(s => ({sec: s.querySelector('.sec-head .eyebrow')?.textContent?.trim(), cards: s.querySelectorAll('.card').length})))")
        rec2 = c.eval(f"{INV}('lib_recent_plays', {{limit: 8}}).then(l => l.map(t => t.title))")
        out["recents"] = {"secoes": rec, "lib_recent_plays": rec2}
        ok("CMR-215 recents", isinstance(rec2, list) and len(rec2) >= 1)

    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
