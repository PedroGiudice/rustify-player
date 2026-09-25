# Mede o lab no WebKitGTK do sistema (o mesmo que o Tauri usa), numa janela
# offscreen: nada aparece na tela do usuário.
import gi, sys
gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib
mode, url = sys.argv[1], sys.argv[2]
s = WebKit2.Settings()
s.set_enable_webgl(True)
s.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
s.set_enable_write_console_messages_to_stdout(True)
feats = WebKit2.Settings.get_all_features()
names = [feats.get(i).get_identifier() for i in range(feats.get_length())]
print("features com GPU/WebGL:", [n for n in names if "GPU" in n or "WebGL" in n], file=sys.stderr)
if mode == "nogpuproc":
    for i in range(feats.get_length()):
        f = feats.get(i)
        if f.get_identifier() == "UseGPUProcessForWebGL":
            s.set_feature_enabled(f, False); print("UseGPUProcessForWebGL = off", file=sys.stderr)
wv = WebKit2.WebView.new_with_settings(s)
win = Gtk.OffscreenWindow(); win.set_default_size(1400, 900); win.add(wv); win.show_all()
def on_title(*_):
    t = wv.get_title() or ""
    if t.startswith("BENCH "):
        print("RESULT " + t[6:]); sys.stdout.flush(); Gtk.main_quit()
wv.connect("notify::title", on_title)
GLib.timeout_add_seconds(240, lambda: (print("TIMEOUT"), Gtk.main_quit()))
wv.load_uri(url)
Gtk.main()
