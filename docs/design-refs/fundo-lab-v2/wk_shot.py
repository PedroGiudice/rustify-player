import gi, sys
gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib
url, out, wait = sys.argv[1], sys.argv[2], int(sys.argv[3])
s = WebKit2.Settings(); s.set_enable_webgl(True)
s.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
s.set_enable_write_console_messages_to_stdout(True)
wv = WebKit2.WebView.new_with_settings(s)
win = Gtk.OffscreenWindow(); win.set_default_size(1400, 1000); win.add(wv); win.show_all()
def done(_wv, res):
    surf = wv.get_snapshot_finish(res); surf.write_to_png(out); print("SHOT ok"); Gtk.main_quit()
def shoot():
    wv.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT, WebKit2.SnapshotOptions.NONE, None, done); return False
wv.load_uri(url)
GLib.timeout_add_seconds(wait, shoot)
GLib.timeout_add_seconds(wait + 60, lambda: (print("TIMEOUT"), Gtk.main_quit()))
Gtk.main()
