"""Unit tests for sharing saved reports: email settings, test mail, email a report, save to USB, PDF on demand.

Needs Flask (apt: python3-flask). Temp files only; SMTP, Chromium and the root helper are faked.
    python3 -m unittest -v dev/unit-tests/test_share_api.py        (from the repo root)
"""
import json
import os
import smtplib
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "security-tests"))
from test_security import load_app, remote  # noqa: E402

KIOSK = remote("127.0.0.1")
NAME = "2026-10-09_1716_Demo-Coffee-Main-St.html"
FAKE_PW = "s3cret-pass"                                  # a made-up test password
MAIL = {"host": "mail.example.com", "port": 587, "security": "starttls", "user": "pi@example.com", "password": FAKE_PW,
        "from": "pi@example.com", "to": "boss@example.com, me@example.com"}


class FakeSMTP:
    sent = []

    def __init__(self, host, port, timeout=None):
        self.host, self.port = host, port

    def starttls(self):
        self.tls = True

    def login(self, user, pw):
        if pw != "s3cret-pass":
            raise smtplib.SMTPAuthenticationError(535, b"bad password")

    def send_message(self, msg):
        FakeSMTP.sent.append(msg)

    def quit(self):
        pass


class Share(unittest.TestCase):
    def setUp(self):
        self.mod, self.cfg = load_app()
        d = tempfile.mkdtemp(prefix="nt-share-")
        self.mod.REPORTS_DIR = os.path.join(d, "reports")
        self.mod.HISTORY = os.path.join(d, "history.log")
        os.makedirs(self.mod.REPORTS_DIR)
        with open(os.path.join(self.mod.REPORTS_DIR, NAME), "w") as f:
            f.write("<html><body><h1>Site report</h1></body></html>")
        FakeSMTP.sent = []
        self.chromium = []

        def fake_chromium(argv, **kw):                          # "prints" the PDF the way Chromium would
            self.chromium.append(argv)
            out = [a for a in argv if a.startswith("--print-to-pdf=")][0].split("=", 1)[1]
            with open(out, "wb") as f:
                f.write(b"%PDF-1.4 fake")
        for target, fake in ((smtplib, "SMTP"), (smtplib, "SMTP_SSL")):
            p = mock.patch.object(target, fake, FakeSMTP)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(self.mod.subprocess, "run", side_effect=fake_chromium)
        self.run_mock = p.start()
        self.addCleanup(p.stop)
        self.c = self.mod.app.test_client()

    def post(self, url, body):
        return self.c.post(url, json=body, environ_base=KIOSK)

    def test_mail_settings_never_return_the_password(self):
        self.assertFalse(self.c.get("/api/mail", environ_base=KIOSK).get_json()["ready"])
        d = self.post("/api/mail", MAIL).get_json()
        self.assertTrue(d["ok"] and d["ready"] and d["password_set"])
        self.assertNotIn("s3cret-pass", json.dumps(d))
        self.assertNotIn("s3cret-pass", json.dumps(self.c.get("/api/mail", environ_base=KIOSK).get_json()))
        self.assertNotIn("s3cret-pass", json.dumps(self.c.get("/api/settings", environ_base=KIOSK).get_json()))
        self.assertEqual(d["to"], ["boss@example.com", "me@example.com"])
        self.post("/api/mail", dict(MAIL, password=""))              # empty = keep
        self.assertEqual(json.load(open(self.cfg))["mail"]["password"], "s3cret-pass")
        self.assertEqual(os.stat(self.cfg).st_mode & 0o777, 0o600)

    def test_mail_settings_validation(self):
        for bad in ({"host": "bad host;rm"}, {"port": "x"}, {"port": 70000}, {"from": "not-an-address"},
                    {"to": "a@b.c, nope"}, {"to": ",".join("u%d@example.com" % i for i in range(11))}):
            self.assertEqual(self.post("/api/mail", dict(MAIL, **bad)).status_code, 400, bad)

    def test_test_mail_and_report_email(self):
        self.assertEqual(self.post("/api/reports/email", {"name": NAME}).status_code, 400)   # not set up yet
        self.post("/api/mail", MAIL)
        self.assertEqual(self.post("/api/mail/test", {}).get_json()["to"], ["boss@example.com", "me@example.com"])
        d = self.post("/api/reports/email", {"name": NAME, "to": "site.manager@example.com"}).get_json()
        self.assertEqual(d, {"ok": True, "to": ["site.manager@example.com"]})
        msg = FakeSMTP.sent[-1]
        self.assertEqual(msg["To"], "site.manager@example.com")
        self.assertIn("Demo Coffee Main St", msg["Subject"])
        att = [p for p in msg.iter_attachments()]
        self.assertEqual((att[0].get_filename(), att[0].get_content_type()), (NAME[:-5] + ".pdf", "application/pdf"))
        self.assertTrue(os.path.exists(os.path.join(self.mod.REPORTS_DIR, NAME[:-5] + ".pdf")))
        self.post("/api/reports/email", {"name": NAME})
        self.assertEqual(len(self.chromium), 1)                       # the PDF is made once
        self.post("/api/mail", dict(MAIL, password="wrong"))
        r = self.post("/api/reports/email", {"name": NAME})
        self.assertEqual(r.status_code, 502)
        self.assertIn("bad password", r.get_json()["error"])
        for body in ({"name": "../x.html"}, {"name": NAME, "to": "nope"}, {}):
            self.assertIn(self.post("/api/reports/email", body).status_code, (400, 404), body)

    def test_usb(self):
        with mock.patch.object(self.mod, "priv_json", return_value=[{"dev": "/dev/sda1", "label": "STICK", "size": 32e9, "fstype": "exfat", "model": "SanDisk"}]):
            self.assertEqual(self.c.get("/api/usb", environ_base=KIOSK).get_json()["drives"][0]["dev"], "/dev/sda1")
        calls = []

        def fake_priv(args, timeout):
            calls.append(args)
            return {"ok": True, "copied": args[2:], "folder": "JarvisReports", "label": "STICK", "model": "SanDisk", "unmounted": True}
        with mock.patch.object(self.mod, "priv_json", side_effect=fake_priv):
            d = self.post("/api/reports/usb", {"name": NAME, "dev": "/dev/sda1"}).get_json()
        self.assertTrue(d["ok"])
        self.assertEqual(calls, [["usb-save", "/dev/sda1", NAME, NAME[:-5] + ".pdf"]])
        for body in ({"name": NAME, "dev": "/dev/nvme0n1p1"}, {"name": NAME, "dev": "/dev/sda1; reboot"}, {"name": NAME}):
            self.assertEqual(self.post("/api/reports/usb", body).status_code, 400, body)
        self.assertEqual(self.post("/api/reports/usb", {"name": "../../etc/passwd", "dev": "/dev/sda1"}).status_code, 404)
        with mock.patch.object(self.mod, "priv_json", return_value={"ok": False, "error": "could not open the USB drive"}):
            self.assertEqual(self.post("/api/reports/usb", {"name": NAME, "dev": "/dev/sda1"}).status_code, 400)

    def test_pdf_download_and_delete_removes_it(self):
        r = self.c.get("/api/reports/" + NAME[:-5] + ".pdf", environ_base=KIOSK)
        self.assertEqual((r.status_code, r.mimetype), (200, "application/pdf"))
        self.assertEqual(self.c.get("/api/reports/2026-10-09_1716_nothing.pdf", environ_base=KIOSK).status_code, 404)
        self.post("/api/reports/delete", {"name": NAME})
        self.assertEqual(os.listdir(self.mod.REPORTS_DIR), [])

    def test_remote_callers_need_a_login(self):
        out = remote("198.51.100.9")
        for m, url in (("get", "/api/usb"), ("post", "/api/reports/usb"), ("get", "/api/mail"), ("post", "/api/mail"),
                       ("post", "/api/mail/test"), ("post", "/api/reports/email")):
            r = getattr(self.c, m)(url, json={}, environ_base=out) if m == "post" else self.c.get(url, environ_base=out)
            self.assertEqual(r.status_code, 401, url)


if __name__ == "__main__":
    unittest.main()
