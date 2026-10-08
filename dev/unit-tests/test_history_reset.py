"""Unit tests for scripts/jarvis-history-reset (the history lasts one day: kept all day, emptied on a new day).

Plain Python, no Flask, works on temp files only:
    python3 -m unittest -v dev/unit-tests/test_history_reset.py        (from the repo root)
"""
import importlib.machinery
import importlib.util
import json
import os
import sqlite3
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "..", "scripts", "jarvis-history-reset")
loader = importlib.machinery.SourceFileLoader("jarvis_history_reset", SCRIPT)
spec = importlib.util.spec_from_loader("jarvis_history_reset", loader)
hr = importlib.util.module_from_spec(spec)
loader.exec_module(hr)



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
        self.forgot = 0

    def forget(self):
        self.forgot += 1

    def fill(self):
        c = sqlite3.connect(self.db)
        with c:
            c.executemany("INSERT INTO speed(ts, down, up) VALUES(?,?,?)", [(1, 500.0, 300.0), (2, 734.0, 354.0)])
        c.close()
        with open(self.log, "a") as f:
            f.write("tool output\n")

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

    def day(self, y, m, d, hh=12):
        return time.mktime((y, m, d, hh, 0, 0, 0, 0, -1))      # local time, like the Pi

    def test_same_day_keeps_everything(self):
        hr.wipe("new-day", **dict(self.kw, now=lambda: self.day(2026, 10, 8, 7)))
        self.fill()
        for hh in (8, 12, 18, 23):                                 # power-offs, restarts, timer runs all day long
            self.assertIsNone(hr.check(forget=self.forget, since=self.since, now=lambda: self.day(2026, 10, 8, hh), db_path=self.db, history=self.log))
        self.assertEqual(self.counts()["speed"], 2)
        self.assertGreater(os.path.getsize(self.log), 0)

    def test_new_day_clears(self):
        hr.wipe("new-day", **dict(self.kw, now=lambda: self.day(2026, 10, 8, 23)))
        self.fill()
        removed = hr.check(forget=self.forget, since=self.since, now=lambda: self.day(2026, 10, 9, 0), db_path=self.db, history=self.log)
        self.assertEqual(removed["speed"], 2)
        self.assertEqual(self.counts(), {"speed": 0, "samples": 0, "events": 0})
        with open(self.since) as f:
            self.assertEqual(json.load(f)["reason"], "new-day")
        self.assertIsNone(hr.check(forget=self.forget, since=self.since, now=lambda: self.day(2026, 10, 9, 9), db_path=self.db, history=self.log))
        self.assertEqual(self.forgot, 1)                           # visited Wi-Fi forgotten once, on the new day only

    def test_off_for_days_or_never_reset_clears(self):
        self.assertIsNotNone(hr.check(forget=self.forget, since=self.since, now=lambda: self.day(2026, 10, 8), db_path=self.db, history=self.log))
        self.fill()
        self.assertIsNotNone(hr.check(forget=self.forget, since=self.since, now=lambda: self.day(2026, 10, 12), db_path=self.db, history=self.log))
        self.assertEqual(self.counts()["speed"], 0)

    def test_clock_behind_at_boot_keeps(self):
        hr.wipe("new-day", **dict(self.kw, now=lambda: self.day(2026, 10, 9, 8)))
        self.fill()
        # no RTC battery: right after a power cut the clock can say "yesterday" until it is set - never clear then
        self.assertIsNone(hr.check(forget=self.forget, since=self.since, now=lambda: self.day(2026, 10, 8, 22), db_path=self.db, history=self.log))
        self.assertEqual(self.counts()["speed"], 2)

    def test_forget_visited_wifi_uses_the_sudo_rule(self):
        calls = []

        class P:
            stdout = "Clearing visited-site WiFi...\n  deleted: Cafe Guest\n  kept (in use): Office\n  deleted: Store 12\n"

        def run(argv, **kw):
            calls.append(argv)
            return P()
        self.assertEqual(hr.forget_visited_wifi(run), ["Cafe Guest", "Store 12"])
        self.assertEqual(calls, [["sudo", "-n", "/usr/local/bin/wifi-clear"]])

        def broken(argv, **kw):
            raise OSError("no sudo")
        self.assertIsNone(hr.forget_visited_wifi(broken))         # a failure never breaks the reset

    def test_main_check_removes_the_old_marker_and_never_fails(self):
        marker = os.path.join(os.path.dirname(self.db), "keep-history-once")
        with open(marker, "w") as f:
            f.write("restart\n")
        with open(self.db, "wb") as f:
            f.write(b"this is not a database")
        with mock.patch.object(hr, "DB_PATH", self.db), mock.patch.object(hr, "OLD_MARKER", marker), \
                mock.patch.object(hr, "forget_visited_wifi", lambda: None), \
                mock.patch.object(hr, "HISTORY", self.log), mock.patch.object(hr, "SINCE", self.since):
            self.assertEqual(hr.main(["x", "--check"]), 0)
            self.assertEqual(hr.main(["x", "--boot"]), 0)          # the earlier unit's names still work
            self.assertEqual(hr.main(["x", "--shutdown"]), 0)
        self.assertFalse(os.path.exists(marker))

    def test_usage(self):
        self.assertEqual(hr.main(["x"]), 64)
        self.assertEqual(hr.main(["x", "--wipe-everything"]), 64)


if __name__ == "__main__":
    unittest.main()
