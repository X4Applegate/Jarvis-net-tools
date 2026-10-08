"""Unit tests for /api/hotspot (Settings > Setup Hotspot): the app only writes the mode file and reads the state file.

Needs Flask (apt: python3-flask), like the security tests. Never touches a radio.
    python3 -m unittest -v dev/unit-tests/test_hotspot_api.py        (from the repo root)
"""
import json
import os
import stat
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "security-tests"))
from test_security import load_app, remote  # noqa: E402  (throw-away config, same loader as the security tests)

KIOSK = remote("127.0.0.1")


class HotspotApi(unittest.TestCase):
    def setUp(self):
        self.mod, _ = load_app()
        d = tempfile.mkdtemp(prefix="nt-hs-")
        self.mod.HOTSPOT_MODE_PATH = os.path.join(d, "hotspot-mode")
        self.mod.HOTSPOT_STATE_PATH = os.path.join(d, "state.json")
        self.mod.HISTORY = os.path.join(d, "history.log")
        self.c = self.mod.app.test_client()

    def state(self, **kw):
        st = {"mode": "auto", "profile": "JarvisPi-Manage", "iface": "wlan0", "ts": int(time.time()), "active": False,
              "clients": 0, "online": True, "fallback_in": None, "error": "", "note": ""}
        st.update(kw)
        with open(self.mod.HOTSPOT_STATE_PATH, "w") as f:
            json.dump(st, f)

    def get(self):
        r = self.c.get("/api/hotspot", environ_base=KIOSK)
        self.assertEqual(r.status_code, 200)
        return r.get_json()

    def test_no_service_yet(self):
        d = self.get()
        self.assertEqual(d["mode"], "auto")                 # no file = auto, like the service
        self.assertFalse(d["service"])
        self.assertIsNone(d["active"])

    def test_fresh_state(self):
        self.state(active=True, clients=2, online=False)
        d = self.get()
        self.assertTrue(d["service"] and d["active"])
        self.assertEqual((d["clients"], d["online"], d["ssid"]), (2, False, "JarvisPi-Manage"))

    def test_stale_or_broken_state_means_service_down(self):
        self.state(ts=int(time.time()) - 120, active=True)
        d = self.get()
        self.assertFalse(d["service"])
        self.assertIsNone(d["active"])
        for junk in ("not json", "[1, 2]", '{"ts": "soon"}', '{"ts": null}'):
            with open(self.mod.HOTSPOT_STATE_PATH, "w") as f:
                f.write(junk)
            self.assertFalse(self.get()["service"], junk)
        self.state(clients="lots", fallback_in="soon")     # wrong types never crash the endpoint
        d = self.get()
        self.assertEqual((d["clients"], d["fallback_in"]), (0, None))

    def test_set_mode(self):
        for m in ("on", "off", "auto"):
            r = self.c.post("/api/hotspot", json={"mode": m}, environ_base=KIOSK)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.get_json()["mode"], m)
            with open(self.mod.HOTSPOT_MODE_PATH) as f:
                self.assertEqual(f.read(), m + "\n")
            self.assertEqual(stat.S_IMODE(os.stat(self.mod.HOTSPOT_MODE_PATH).st_mode), 0o644)
        with open(self.mod.HISTORY) as f:
            self.assertIn("mode set to auto", f.read())

    def test_bad_modes_change_nothing(self):
        self.c.post("/api/hotspot", json={"mode": "off"}, environ_base=KIOSK)
        for body in ({"mode": "ON"}, {"mode": "on\nauto"}, {"mode": ["on"]}, {"mode": None}, {}, ["on"], "on"):
            r = self.c.post("/api/hotspot", json=body, environ_base=KIOSK)
            self.assertEqual(r.status_code, 400, body)
        with open(self.mod.HOTSPOT_MODE_PATH) as f:
            self.assertEqual(f.read(), "off\n")

    def test_garbage_mode_file_reads_as_auto(self):
        with open(self.mod.HOTSPOT_MODE_PATH, "w") as f:
            f.write("<script>")
        self.assertEqual(self.get()["mode"], "auto")

    def test_remote_callers_need_a_login(self):
        self.assertEqual(self.c.get("/api/hotspot", environ_base=remote("198.51.100.9")).status_code, 401)
        r = self.c.post("/api/hotspot", json={"mode": "on"}, environ_base=remote("198.51.100.9"))
        self.assertEqual(r.status_code, 401)
        self.assertFalse(os.path.exists(self.mod.HOTSPOT_MODE_PATH))


if __name__ == "__main__":
    unittest.main()
