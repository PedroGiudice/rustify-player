#!/usr/bin/env python3
"""Login PKCE na Tidal (o OAuth de device code só entrega HIGH/AAC para faixas sem hi-res;
python-tidal #404). Imprime a URL de login, espera a URL de redirecionamento no stdin e grava
a sessão no formato do próprio tidalapi em ~/.secrets/tidal-pkce.json (is_pkce=true, refresh
com o client certo). Roda NA cmr-auto, dentro de um tmux: a URL de retorno entra por send-keys.
"""
import os
import sys
from pathlib import Path

import tidalapi

OUT = Path(os.path.expanduser("~/.secrets/tidal-pkce.json"))
OUT.parent.mkdir(mode=0o700, exist_ok=True)
sess = tidalapi.Session()
ok = sess.login_session_file(OUT, do_pkce=True, fn_print=lambda s: print(s, flush=True))
if not ok:
    print("LOGIN FALHOU", flush=True)
    sys.exit(1)
os.chmod(OUT, 0o600)
print("PKCE OK | is_pkce=%s | user=%s | client=%s" % (sess.is_pkce, sess.user.id, sess.config.client_id[:4] + "..."), flush=True)
sess.audio_quality = tidalapi.Quality.hi_res_lossless
for tid in (388205996, 283696304):
    st = sess.track(tid).get_stream()
    print("faixa %s -> %s %s/%s %s" % (tid, st.audio_quality, getattr(st, "bit_depth", "?"), getattr(st, "sample_rate", "?"), st.manifest_mime_type), flush=True)
