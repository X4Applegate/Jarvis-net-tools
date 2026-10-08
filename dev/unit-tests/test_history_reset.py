"""Unit tests for scripts/jarvis-history-reset (empty history at every power-on, kept across a restart).

Plain Python, no Flask, works on temp files only:
    python3 -m unittest -v dev/unit-tests/test_history_reset.py        (from the repo root)
"""
import importlib.machinery
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "..", "scripts", "jarvis-history-reset")
loader = importlib.machinery.SourceFileLoader("jarvis_history_reset", SCRIPT)
spec = importlib.util.spec_from_loader("jarvis_history_reset", loader)
hr = importlib.util.module_from_spec(spec)
loader.exec_module(hr)

# `systemctl list-jobs --no-legend` while shutting down
JOBS_REBOOT = "1123 reboot.target start waiting\n1180 systemd-reboot.service start waiting\n1099 jarvis-netmon.service stop running\n"
JOBS_POWEROFF = "1123 poweroff.target start waiting\n1180 systemd-poweroff.service start waiting\n"
JOBS_HALT = "77 halt.target start waiting\n"


class Files(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp(prefix="nt-hr-")
        self.db, self.log = os.path.join(d, "netmon.db"), os.path.join(d, "history.log")
        self.marker, self.since = os.path.join(d, "keep-history-once"), os.path.join(d, "history-since.json")
        c = sqlite3.connect(self.db)
        with c:                                            # the monitor's schema, with some history in it
            c.execute("CREATE TABLE speed(ts INTEGER, source TEXT, server TEXT, isp TEXT, ping REAL, jitter REAL, down REAL, up REAL, "
                      "down_lat REAL, up_lat REAL, loss REAL, grade TEXT, url TEXT)")
            c.execute("CREATE TABLE samples(ts INTEGER PRIMARY KEY, iface TEXT, ssid TEXT, gw TEXT, gw_ok INTEGER, gw_ms REAL, "
                      "inet_ok INTEGER, inet_ms REAL, dns_ok INTEGER)")
            c.execute("CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts INTEGER, end_ts INTEGER, kind TEXT, detail TEXT)")
            c.executemany("INSERT INTO speed(ts, down, up) VALUES(?,?,?)", [(1, 500.0, 300.0), (2, 734.0, 354.0)])
            c.executemany("INSERT INTO samples(ts, inet_ok) VALUES(?,1)", [(i,) for i in range(100)])
            c.execute("INSERT INTO events(start_ts, end_ts, kind) VALUES(5, 9, 'internet')")
        c.close()
        with open(self.log, "w") as f:
            f.write("===== [2026-10-08 10:11:31] Speed Test =====\n733.9 / 354.3\n")
        os.chmod(self.log, 0o640)
        self.kw = dict(db_path=self.db, history=self.log, since=self.since, now=lambda: 1791480000)

    def counts(self):
        c = sqlite3.connect(self.db)
        try:
            return {t: c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("speed", "samples", "events")}
        finally:
            c.close()

    def test_wipe_empties_history_keeps_schema_and_file(self):
        removed = hr.wipe("power-on", **self.kw)
        self.assertEqual(removed, {"speed": 2, "samples": 100, "events": 1})
        self.assertEqual(self.counts(), {"speed": 0, "samples": 0, "events": 0})   # tables still there for the app
        self.assertEqual(os.path.getsize(self.log), 0)
        self.assertEqual(os.stat(self.log).st_mode & 0o777, 0o640)                # truncated in place
        with open(self.since) as f:
            self.assertEqual(json.load(f), {"ts": 1791480000, "reason": "power-on"})
        with open(self.db, "rb") as f:
            self.assertNotIn(b"733.9", f.read())                                    # vacuumed: not in the file either

    def test_wipe_without_any_history_yet(self):
        os.remove(self.db)
        os.remove(self.log)
        self.assertEqual(hr.wipe("power-on", **self.kw), {})
        self.assertFalse(os.path.exists(self.db))       # nothing created; the app makes its own DB
        self.assertTrue(os.path.exists(self.since))

    def test_boot_after_power_off_clears(self):
        self.assertIsNotNone(hr.boot(marker=self.marker, **self.kw))
        self.assertEqual(self.counts()["speed"], 0)

    def test_boot_after_restart_keeps_once(self):
        hr.keep_next_boot(True, self.marker)
        self.assertIsNone(hr.boot(marker=self.marker, **self.kw))
        self.assertEqual(self.counts()["speed"], 2)
        self.assertFalse(os.path.exists(self.marker))    # used up: the boot after that clears again
        hr.boot(marker=self.marker, **self.kw)
        self.assertEqual(self.counts()["speed"], 0)

    def test_shutdown_kind(self):
        self.assertEqual(hr.shutdown_kind(JOBS_REBOOT), "restart")
        self.assertEqual(hr.shutdown_kind(JOBS_POWEROFF), "poweroff")
        self.assertEqual(hr.shutdown_kind(JOBS_HALT), "poweroff")
        self.assertEqual(hr.shutdown_kind(""), "")
        self.assertEqual(hr.shutdown_kind("No jobs running.\n"), "")
        self.assertEqual(hr.shutdown_kind("12 reboot.target.wants-not start\n"), "")    # exact unit names only

    def test_shutdown_marks_restart_and_clears_marker_on_power_off(self):
        with mock.patch.object(hr, "MARKER", self.marker):
            with mock.patch.object(hr, "shutdown_kind", return_value="restart"):
                self.assertEqual(hr.main(["x", "--shutdown"]), 0)
            self.assertTrue(os.path.exists(self.marker))
            with mock.patch.object(hr, "shutdown_kind", return_value=""):           # unknown: leave the app's choice alone
                hr.main(["x", "--shutdown"])
            self.assertTrue(os.path.exists(self.marker))
            with mock.patch.object(hr, "shutdown_kind", return_value="poweroff"):
                hr.main(["x", "--shutdown"])
            self.assertFalse(os.path.exists(self.marker))

    def test_boot_never_fails_the_boot(self):
        with open(self.db, "wb") as f:
            f.write(b"this is not a database")
        with mock.patch.object(hr, "DB_PATH", self.db), mock.patch.object(hr, "MARKER", self.marker), \
                mock.patch.object(hr, "HISTORY", self.log), mock.patch.object(hr, "SINCE", self.since):
            self.assertEqual(hr.main(["x", "--boot"]), 0)

    def test_usage(self):
        self.assertEqual(hr.main(["x"]), 64)
        self.assertEqual(hr.main(["x", "--wipe-everything"]), 64)


if __name__ == "__main__":
    unittest.main()
