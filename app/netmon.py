#!/usr/bin/env python3
"""jarvis-netmon — background network monitor for the Jarvis Pi.

Every 10 s: ping the default gateway and the internet, resolve a DNS name, and
record a sample. Three straight internet failures open an outage event; two
straight successes close it. Runs a scheduled Ookla speed test every
`speed_interval_min` minutes (config.json; default 60; 0 disables). Keeps 7 days.
Runs as the unprivileged 'nettools' user; shares the SQLite DB with the app.
"""
import json
import re
import sqlite3
import subprocess
import time

DB_PATH = "/var/lib/jarvis-nettools/netmon.db"
CONFIG_PATH = "/etc/jarvis-nettools/config.json"
INTERVAL = 10
FAIL_OPEN, OK_CLOSE = 3, 2
KEEP_DAYS = 7


def run(argv, timeout=20):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return (p.stdout or "") + (p.stderr or "")
    except Exception:  # noqa: BLE001
        return ""


def db():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.execute("""CREATE TABLE IF NOT EXISTS speed(ts INTEGER, source TEXT, server TEXT, isp TEXT, ping REAL, jitter REAL,
                 down REAL, up REAL, down_lat REAL, up_lat REAL, loss REAL, grade TEXT, url TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS samples(ts INTEGER PRIMARY KEY, iface TEXT, ssid TEXT, gw TEXT, gw_ok INTEGER,
                 gw_ms REAL, inet_ok INTEGER, inet_ms REAL, dns_ok INTEGER)""")
    c.execute("""CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts INTEGER, end_ts INTEGER,
                 kind TEXT, detail TEXT)""")
    return c


def ping(host, iface=None):
    argv = ["ping", "-c", "1", "-W", "2"] + (["-I", iface] if iface else []) + [host]
    out = run(argv, timeout=5)
    m = re.search(r"time=([\d.]+)", out)
    return ("1 received" in out), (float(m.group(1)) if m else None)


def sample():
    route = run(["/bin/sh", "-c", "ip route | awk '/default/{print $5, $3; exit}'"]).split()
    iface, gw = (route + ["", ""])[:2]
    ssid = ""
    if iface.startswith("wlan"):
        ssid = (re.search(r"SSID:\s*(.+)", run(["/usr/sbin/iw", "dev", iface, "link"], timeout=5)) or [None, ""])[1]
    gw_ok, gw_ms = ping(gw) if gw else (False, None)
    inet_ok, inet_ms = ping("1.1.1.1")
    if not inet_ok:
        inet_ok, inet_ms = ping("8.8.8.8")
    dns = run(["dig", "+short", "+time=2", "+tries=1", "google.com"], timeout=6).strip()
    dns_ok = bool(dns) and ";" not in dns
    return {"ts": int(time.time()), "iface": iface, "ssid": ssid, "gw": gw, "gw_ok": int(gw_ok),
            "gw_ms": gw_ms, "inet_ok": int(inet_ok), "inet_ms": inet_ms, "dns_ok": int(dns_ok)}


def speed_interval():
    try:
        return int(json.load(open(CONFIG_PATH)).get("speed_interval_min", 60))
    except Exception:
        return 60


def grade(idle, loaded):
    rise = max(0.0, (loaded or 0) - (idle or 0))
    return "A+" if rise < 5 else "A" if rise < 30 else "B" if rise < 60 else "C" if rise < 200 else "D" if rise < 400 else "F"


def speedtest(c):
    raw = run(["speedtest", "--accept-license", "--accept-gdpr", "--format=json"], timeout=150)
    try:
        j = json.loads(raw[raw.index("{"):])
    except Exception:
        return
    dl, ul, pg = j.get("download", {}), j.get("upload", {}), j.get("ping", {})
    if not (dl.get("bandwidth") and ul.get("bandwidth")):
        return  # failed/partial run: do not record zeros as a perfect A+ grade
    dlat = (dl.get("latency") or {}).get("iqm", 0); ulat = (ul.get("latency") or {}).get("iqm", 0)
    g = max(grade(pg.get("latency", 0), dlat), grade(pg.get("latency", 0), ulat), key=lambda x: ["A+", "A", "B", "C", "D", "F"].index(x))
    c.execute("INSERT INTO speed VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        int(time.time()), "scheduled",
        f"{j.get('server', {}).get('name', '?')} — {j.get('server', {}).get('location', '?')}", j.get("isp", ""),
        round(pg.get("latency", 0), 1), round(pg.get("jitter", 0), 1),
        round(dl.get("bandwidth", 0) * 8 / 1e6, 1), round(ul.get("bandwidth", 0) * 8 / 1e6, 1),
        round(dlat, 1), round(ulat, 1), j.get("packetLoss"), g, (j.get("result") or {}).get("url", "")))
    c.commit()


def main():
    fails = oks = 0
    open_event = None
    last_prune = 0
    with db() as c:
        row = c.execute("SELECT id, kind FROM events WHERE end_ts IS NULL ORDER BY id DESC LIMIT 1").fetchone()
        if row:
            open_event = row[0]
    while True:
        t0 = time.time()
        s = sample()
        with db() as c:
            c.execute("INSERT OR REPLACE INTO samples VALUES(?,?,?,?,?,?,?,?,?)",
                      (s["ts"], s["iface"], s["ssid"], s["gw"], s["gw_ok"], s["gw_ms"], s["inet_ok"], s["inet_ms"], s["dns_ok"]))
            if s["inet_ok"]:
                oks += 1; fails = 0
                if open_event and oks >= OK_CLOSE:
                    c.execute("UPDATE events SET end_ts=? WHERE id=?", (s["ts"], open_event)); open_event = None
            else:
                fails += 1; oks = 0
                if not open_event and fails >= FAIL_OPEN:
                    kind = "gateway" if not s["gw_ok"] else "internet"
                    detail = (f"{s['iface']} {s['ssid']}".strip() + (" — local link/gateway down" if kind == "gateway" else " — gateway fine, internet down"))
                    cur = c.execute("INSERT INTO events(start_ts,end_ts,kind,detail) VALUES(?,NULL,?,?)",
                                    (s["ts"] - (FAIL_OPEN - 1) * INTERVAL, kind, detail))
                    open_event = cur.lastrowid
            # scheduled speed test
            iv = speed_interval()
            if iv > 0 and s["inet_ok"]:
                last = c.execute("SELECT MAX(ts) FROM speed").fetchone()[0] or 0
                if time.time() - last >= iv * 60:
                    c.commit()
                    speedtest(c)
            if time.time() - last_prune > 3600:
                c.execute("DELETE FROM samples WHERE ts < ?", (int(time.time()) - KEEP_DAYS * 86400,))
                c.execute("DELETE FROM events WHERE end_ts IS NOT NULL AND end_ts < ?", (int(time.time()) - 30 * 86400,))
                last_prune = time.time()
            c.commit()
        time.sleep(max(1, INTERVAL - (time.time() - t0)))


if __name__ == "__main__":
    main()
