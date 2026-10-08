"""Unit tests for Settings > Clear History (/api/history/clear) and the "History since" value in /api/settings.

Needs Flask (apt: python3-flask), like the security tests. Works on temp files only.
    python3 -m unittest -v dev/unit-tests/test_history_api.py        (from the repo root)
"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "security-tests"))
from test_security import load_app, remote  # noqa: E402  (throw-away config, same loader as the security tests)

KIOSK = remote("127.0.0.1")


class HistoryApi(unittest.TestCase):
    def setUp(self):
        self.mod, _ = load_app()
        d = tempfile.mkdtemp(prefix="nt-hist-")
        self.mod.DB_PATH = os.path.join(d, "netmon.db")
        self.mod.HISTORY = os.path.join(d, "history.log")
        self.mod.HISTORY_SINCE = os.path.join(d, "history-since.json")
        self.mod.HISTORY_MARKER = os.path.join(d, "keep-history-once")
        self.c = self.mod.app.test_client()
        r = {"ts": 100, "server": "s", "isp": "i", "ping": 1.0, "jitter": 1.0, "down": 734.0, "up": 354.0,
             "down_lat": 1.0, "up_lat": 1.0, "loss": 0.0, "grade": "A", "url": ""}
        self.mod.db_insert_speed(r, "manual")
        with self.mod.db() as c:
            c.execute("INSERT INTO samples(ts, inet_ok) VALUES(1, 1)")
            c.execute("INSERT INTO events(start_ts, end_ts, kind) VALUES(1, 2, 'internet')")
        self.mod.log_history("Speed Test", None, "734 / 354")
        self.mod._last_devices = [{"ip": "192.0.2.10"}]

    def counts(self):
        with self.mod.db() as c:
            return [c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("speed", "samples", "events")]

    def test_clear(self):
        self.assertEqual(self.counts(), [1, 1, 1])
        r = self.c.post("/api/history/clear", json={}, environ_base=KIOSK)
        self.assertEqual(r.status_code, 200)
        d = r.get_json()
        self.assertTrue(d["ok"])
        self.assertEqual(d["history_since"]["reason"], "manual")
        self.assertEqual(self.counts(), [0, 0, 0])
        self.assertEqual(os.path.getsize(self.mod.HISTORY), 0)
        self.assertEqual(self.mod._last_devices, [])                 # the site report scans afresh
        self.assertEqual(self.c.get("/api/settings", environ_base=KIOSK).get_json()["history_since"], d["history_since"])
        self.assertIn("No history yet", self.c.get("/api/history", environ_base=KIOSK).get_json()["output"])

    def test_settings_history_since(self):
        self.assertIsNone(self.c.get("/api/settings", environ_base=KIOSK).get_json()["history_since"])
        with open(self.mod.HISTORY_SINCE, "w") as f:
            json.dump({"ts": 1791480000, "reason": "power-on"}, f)
        self.assertEqual(self.c.get("/api/settings", environ_base=KIOSK).get_json()["history_since"],
                         {"ts": 1791480000, "reason": "power-on"})
        for junk in ("nope", "[]", '{"reason": "power-on"}', '{"ts": "soon"}'):
            with open(self.mod.HISTORY_SINCE, "w") as f:
                f.write(junk)
            self.assertIsNone(self.c.get("/api/settings", environ_base=KIOSK).get_json()["history_since"], junk)

    def test_remote_callers_need_a_login(self):
        r = self.c.post("/api/history/clear", json={}, environ_base=remote("198.51.100.9"))
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.counts(), [1, 1, 1])


if __name__ == "__main__":
    unittest.main()
