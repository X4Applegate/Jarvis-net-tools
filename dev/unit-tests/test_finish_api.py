"""Unit tests for Finish Visit (/api/visit/finish) and the saved reports API.

Needs Flask (apt: python3-flask), like the security tests. Temp files only; the report builder and wifi-clear are faked.
    python3 -m unittest -v dev/unit-tests/test_finish_api.py        (from the repo root)
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "security-tests"))
from test_security import load_app, remote  # noqa: E402

KIOSK = remote("127.0.0.1")
REPORT = "<!doctype html><html><head><style>h1{color:red}</style></head><body><h1>Site report</h1><p>734 / 354</p></body></html>"


class Finish(unittest.TestCase):
    def setUp(self):
        self.mod, self.cfg = load_app()
        d = tempfile.mkdtemp(prefix="nt-finish-")
        for k, v in (("DB_PATH", "netmon.db"), ("HISTORY", "history.log"), ("HISTORY_SINCE", "history-since.json"),
                     ("VISIT_PATH", "visit.json"), ("REPORTS_DIR", "reports")):
            setattr(self.mod, k, os.path.join(d, v))
        self.calls = []
        for name, fake in (("gather_report", lambda site: {"site": site}), ("report_html", lambda d: REPORT),
                           ("active_ssid", lambda: "Example WiFi"), ("run", lambda argv, timeout=45: self.calls.append(argv) or "")):
            p = mock.patch.object(self.mod, name, fake)
            p.start()
            self.addCleanup(p.stop)
        self.c = self.mod.app.test_client()
        self.c.post("/api/visit", json={"company": "Demo Coffee", "location": "Main St"}, environ_base=KIOSK)
        r = {"ts": 100, "server": "s", "isp": "i", "ping": 1.0, "jitter": 1.0, "down": 734.0, "up": 354.0,
             "down_lat": 1.0, "up_lat": 1.0, "loss": 0.0, "grade": "A", "url": ""}
        self.mod.db_insert_speed(r, "manual")
        self.mod.log_history("Speed Test", None, "734 / 354")

    def finish(self):
        r = self.c.post("/api/visit/finish", json={}, environ_base=KIOSK)
        self.assertEqual(r.status_code, 200)
        return r.get_json()

    def test_finish_saves_report_clears_history_and_asks_the_wizard_next(self):
        self.assertFalse(self.c.get("/api/visit", environ_base=KIOSK).get_json()["needed"])
        d = self.finish()
        self.assertTrue(d["ok"])
        self.assertEqual(d["site"], "Demo Coffee - Main St")
        self.assertRegex(d["report"], r"^\d{4}-\d{2}-\d{2}_\d{4}_Demo-Coffee-Main-St\.html$")
        with open(os.path.join(self.mod.REPORTS_DIR, d["report"])) as f:
            self.assertEqual(f.read(), REPORT)
        with self.mod.db() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM speed").fetchone()[0], 0)
        self.assertEqual(os.path.getsize(self.mod.HISTORY), 0)
        self.assertEqual(self.mod.history_since()["reason"], "finished")
        self.assertIn(["sudo", "/usr/local/bin/wifi-clear"], self.calls)
        v = self.c.get("/api/visit", environ_base=KIOSK).get_json()
        self.assertTrue(v["needed"])                                   # next start -> setup wizard
        self.assertTrue(v["visit"]["finished"])
        self.assertEqual(v["companies"][0]["name"], "Demo Coffee")     # still remembered for the wizard
        self.c.post("/api/visit", json={"company": "Demo Coffee", "location": "Airport"}, environ_base=KIOSK)
        self.assertFalse(self.c.get("/api/visit", environ_base=KIOSK).get_json()["needed"])   # new visit started

    def test_reports_list_view_delete(self):
        a = self.finish()["report"]
        b = self.finish()["report"]                                    # same minute: still two files
        self.assertNotEqual(a, b)
        lst = self.c.get("/api/reports", environ_base=KIOSK).get_json()["reports"]
        self.assertEqual({r["name"] for r in lst}, {a, b})
        self.assertEqual(lst[0]["site"], "Demo Coffee Main St")
        r = self.c.get("/api/reports/" + a, environ_base=KIOSK)
        self.assertEqual((r.status_code, r.mimetype), (200, "text/html"))
        self.assertIn("default-src 'none'", r.headers["Content-Security-Policy"])
        self.assertIn("Site report", r.get_data(as_text=True))
        self.assertIn("attachment", self.c.get("/api/reports/" + a + "?download=1", environ_base=KIOSK).headers["Content-Disposition"])
        d = self.c.post("/api/reports/delete", json={"name": a}, environ_base=KIOSK).get_json()
        self.assertEqual([r["name"] for r in d["reports"]], [b])
        self.assertEqual(self.c.post("/api/reports/delete", json={"name": a}, environ_base=KIOSK).status_code, 404)

    def test_names_cannot_escape_the_reports_folder(self):
        self.finish()
        for bad in ("../history.log", "..%2Fvisit.json", "x.html", "2026-10-09_1200_a/../../b.html", "visit.json",
                    "2026-10-09_1200_.html", ".report.tmp"):
            self.assertEqual(self.c.get("/api/reports/" + bad, environ_base=KIOSK).status_code, 404, bad)
            self.assertEqual(self.c.post("/api/reports/delete", json={"name": bad}, environ_base=KIOSK).status_code, 404, bad)
        for body in (None, [], "x", {"name": 5}):
            self.assertEqual(self.c.post("/api/reports/delete", json=body, environ_base=KIOSK).status_code, 404, body)
        self.assertTrue(os.path.exists(self.mod.VISIT_PATH))

    def test_remote_callers_need_a_login(self):
        out = remote("198.51.100.9")
        self.assertEqual(self.c.post("/api/visit/finish", json={}, environ_base=out).status_code, 401)
        self.assertFalse(os.path.exists(self.mod.REPORTS_DIR))
        with self.mod.db() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM speed").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
