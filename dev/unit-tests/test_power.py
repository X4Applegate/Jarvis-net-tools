"""Unit tests for /api/shutdown (shut down / restart) and has_power_button, with subprocess.Popen faked.

Needs Flask (apt: python3-flask), like the security tests. Never powers anything off.
    python3 -m unittest -v dev/unit-tests/test_power.py        (from the repo root)
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "security-tests"))
from test_security import load_app, remote  # noqa: E402  (throw-away config, same loader as the security tests)

PI5 = "Raspberry Pi 5 Model B Rev 1.1\x00"
PI500 = "Raspberry Pi 500 Rev 1.0\x00"
PI4 = "Raspberry Pi 4 Model B Rev 1.5\x00"


def model_file(text):
    f = tempfile.NamedTemporaryFile("w", prefix="nt-model-", delete=False)
    f.write(text)
    f.close()
    return f.name


class Power(unittest.TestCase):
    def setUp(self):
        self.mod, _ = load_app()
        self.mod.HISTORY = os.path.join(tempfile.mkdtemp(prefix="nt-hist-"), "history.log")
        self.mod.MODEL_PATH = model_file(PI5)
        self.mod.HISTORY_MARKER = os.path.join(tempfile.mkdtemp(prefix="nt-mark-"), "keep-history-once")
        self.c = self.mod.app.test_client()
        p = mock.patch.object(self.mod.subprocess, "Popen")
        self.popen = p.start()
        self.addCleanup(p.stop)

    def post(self, body, **kw):
        kw.setdefault("environ_base", remote("127.0.0.1"))   # the touch-screen kiosk
        return self.c.post("/api/shutdown", json=body, **kw)

    def test_shutdown_is_a_clean_poweroff(self):
        r = self.post({"action": "shutdown"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json(), {"ok": True, "action": "shutdown", "power_button": True})
        self.popen.assert_called_once_with(["sudo", "shutdown", "-h", "now"])

    def test_restart(self):
        r = self.post({"action": "restart"})
        self.assertEqual(r.get_json()["action"], "restart")
        self.popen.assert_called_once_with(["sudo", "shutdown", "-r", "now"])

    def test_restart_keeps_history_shutdown_does_not(self):
        self.post({"action": "restart"})
        self.assertTrue(os.path.exists(self.mod.HISTORY_MARKER))        # the boot service keeps the history once
        self.post({"action": "shutdown"})
        self.assertFalse(os.path.exists(self.mod.HISTORY_MARKER))       # next power-on starts empty

    def test_empty_body_still_shuts_down(self):
        # older cached app versions send {}
        self.assertEqual(self.post({}).get_json()["action"], "shutdown")
        self.popen.assert_called_once_with(["sudo", "shutdown", "-h", "now"])

    def test_unknown_action_does_nothing(self):
        for bad in ("halt", "reboot now", "", None, 1, ["restart"]):
            r = self.post({"action": bad})
            self.assertEqual(r.status_code, 400, bad)
        self.popen.assert_not_called()

    def test_logged_to_history(self):
        self.post({"action": "restart"})
        with open(self.mod.HISTORY) as f:
            self.assertIn("Restart", f.read())

    def test_power_button_by_model(self):
        for text, want in ((PI5, True), (PI500, True), (PI4, False), ("Raspberry Pi 3 Model B Plus Rev 1.3\x00", False),
                           ("Raspberry Pi Compute Module 4 Rev 1.0\x00", False)):
            self.mod.MODEL_PATH = model_file(text)
            self.assertIs(self.mod.has_power_button(), want, text)
        self.mod.MODEL_PATH = "/nonexistent/model"
        self.assertFalse(self.mod.has_power_button())
        self.assertFalse(self.post({"action": "shutdown"}).get_json()["power_button"])

    def test_remote_callers_need_a_login(self):
        r = self.post({"action": "restart"}, environ_base=remote("198.51.100.9"))
        self.assertEqual(r.status_code, 401)
        self.popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
