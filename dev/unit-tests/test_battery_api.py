"""Unit tests for the UPS battery in /api/status (read from jarvis-ups' state file).

Needs Flask (apt: python3-flask), like the security tests.
    python3 -m unittest -v dev/unit-tests/test_battery_api.py        (from the repo root)
"""
import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "security-tests"))
from test_security import load_app  # noqa: E402


class Battery(unittest.TestCase):
    def setUp(self):
        self.mod, _ = load_app()
        self.mod.UPS_STATE_PATH = os.path.join(tempfile.mkdtemp(prefix="nt-ups-"), "state.json")

    def write(self, **kw):
        st = {"ts": int(time.time()), "present": True, "percent": 9, "source": "mains", "level": "mains",
              "firmware": 113, "low": 25, "critical": 10, "shutting_down": False}
        st.update(kw)
        with open(self.mod.UPS_STATE_PATH, "w") as f:
            json.dump(st, f)

    def test_no_ups(self):
        self.assertIsNone(self.mod.ups_battery())                    # no service / no file
        self.write(present=False)
        self.assertIsNone(self.mod.ups_battery())

    def test_fresh_reading(self):
        self.write()
        self.assertEqual(self.mod.ups_battery(), {"percent": 9, "source": "mains", "level": "mains",
                                                  "shutting_down": False, "critical": 10})
        self.write(percent=64, source="battery", level="battery")
        self.assertEqual(self.mod.ups_battery()["source"], "battery")

    def test_stale_or_broken(self):
        self.write(ts=int(time.time()) - 120)
        self.assertIsNone(self.mod.ups_battery())                    # service stopped: don't show old numbers
        for junk in ("nope", "[]", '{"present": true}', '{"present": true, "ts": 1e12, "percent": "lots"}'):
            with open(self.mod.UPS_STATE_PATH, "w") as f:
                f.write(junk)
            self.assertIsNone(self.mod.ups_battery(), junk)
        self.write(percent=250, source="<b>")
        b = self.mod.ups_battery()
        self.assertEqual((b["percent"], b["source"]), (100, "mains"))


if __name__ == "__main__":
    unittest.main()
