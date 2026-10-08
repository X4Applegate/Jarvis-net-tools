"""Unit tests for the setup wizard's /api/visit (company + location remembered, one visit per day).

Needs Flask (apt: python3-flask), like the security tests. Works on temp files only.
    python3 -m unittest -v dev/unit-tests/test_visit_api.py        (from the repo root)
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


class VisitApi(unittest.TestCase):
    def setUp(self):
        self.mod, self.cfg = load_app()
        d = tempfile.mkdtemp(prefix="nt-visit-")
        self.mod.VISIT_PATH = os.path.join(d, "visit.json")
        self.mod.HISTORY = os.path.join(d, "history.log")
        p = mock.patch.object(self.mod, "active_ssid", return_value="Example WiFi")
        p.start()
        self.addCleanup(p.stop)
        self.c = self.mod.app.test_client()

    def get(self):
        return self.c.get("/api/visit", environ_base=KIOSK).get_json()

    def post(self, body):
        return self.c.post("/api/visit", json=body, environ_base=KIOSK)

    def test_first_start_needs_the_wizard(self):
        d = self.get()
        self.assertTrue(d["needed"])
        self.assertEqual((d["companies"], d["ssid"]), ([], "Example WiFi"))

    def test_visit_remembers_company_and_location(self):
        r = self.post({"company": "Demo  Coffee", "location": "Main St"})
        self.assertEqual(r.status_code, 200)
        d = r.get_json()
        self.assertFalse(d["needed"])
        self.assertEqual(d["visit"]["company"], "Demo Coffee")                  # spaces tidied
        self.assertEqual(d["companies"], [{"name": "Demo Coffee", "locations": ["Main St"]}])
        self.assertEqual(json.load(open(self.cfg))["site_name"], "Demo Coffee - Main St")
        self.post({"company": "Example Tea", "location": ""})
        self.post({"company": "demo coffee", "location": "Airport"})            # same company, any case
        d = self.get()
        self.assertEqual([c["name"] for c in d["companies"]], ["demo coffee", "Example Tea"])   # most recent first
        self.assertEqual(d["companies"][0]["locations"], ["Airport", "Main St"])
        self.assertEqual(json.load(open(self.cfg))["site_name"], "demo coffee - Airport")
        self.assertFalse(self.get()["needed"])

    def test_new_day_needs_it_again(self):
        self.post({"company": "Demo Coffee", "location": "Main St"})
        with mock.patch.object(self.mod, "today", return_value="2099-01-01"):
            self.assertTrue(self.get()["needed"])
        self.assertEqual(self.get()["companies"][0]["name"], "Demo Coffee")     # still remembered

    def test_skip(self):
        d = self.post({"skip": True}).get_json()
        self.assertFalse(d["needed"])
        self.assertTrue(d["visit"]["skipped"])
        self.assertEqual(d["companies"], [])

    def test_bad_input(self):
        for body in ({}, {"company": ""}, {"company": "   "}, {"company": "<>;"}, {"skip": "yes"}, ["x"], "x"):
            self.assertEqual(self.post(body).status_code, 400, body)
        self.post({"company": "<b>Evil</b> Co; rm -rf", "location": "../../etc"})
        d = self.get()["visit"]
        self.assertEqual(d["company"], "bEvil/b Co rm -rf")                      # only letters, digits, space . & ' ( ) / -
        self.assertNotIn("<", json.dumps(self.get()))
        self.post({"company": "x" * 200})
        self.assertEqual(len(self.get()["visit"]["company"]), 40)

    def test_garbage_visit_file(self):
        for junk in ("nope", "[1]", "{}"):
            with open(self.mod.VISIT_PATH, "w") as f:
                f.write(junk)
            self.assertTrue(self.get()["needed"], junk)

    def test_remote_callers_need_a_login(self):
        self.assertEqual(self.c.get("/api/visit", environ_base=remote("198.51.100.9")).status_code, 401)
        self.assertEqual(self.c.post("/api/visit", json={"company": "X"}, environ_base=remote("198.51.100.9")).status_code, 401)
        self.assertFalse(os.path.exists(self.mod.VISIT_PATH))


if __name__ == "__main__":
    unittest.main()
