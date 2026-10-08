#!/usr/bin/env python3
"""Jarvis Net Tools — standalone VPN-only mobile app for the troubleshooting Pi.

Runs as the dedicated 'nettools' user. Privileged tools go through sudo with a
NOPASSWD allowlist of specific binaries only (see install.sh). Every command is
an argv list — never a shell string — and user input is validated, so nothing
typed in the UI can be interpreted as a command.

Radios: wlan1 (Alfa AWUS036AXML, WiFi 6E) is the real connection AND the scanner. wlan0 is the
management access point, so it can never scan.
"""
import hashlib
import hmac
import html
import json
import os
import queue
import re
import secrets
import socket
import sys
import sqlite3
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from functools import wraps
from flask import Flask, request, session, jsonify, send_from_directory, Response, g

CONFIG_PATH = os.environ.get("NETTOOLS_CONFIG", "/etc/jarvis-nettools/config.json")
BASE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE, "static")
HISTORY = os.path.join(BASE, "history.log")
WLAN = "wlan1"

import nt_auth                                    # password hashing + login throttle (same folder)

app = Flask(__name__, static_folder=None)
cfg = json.load(open(CONFIG_PATH))
app.secret_key = cfg["secret_key"]
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",                                         # a cookie is never sent on cross-site POSTs
    SESSION_COOKIE_SECURE=os.environ.get("NETTOOLS_COOKIE_SECURE") == "1",  # set to 1 when the app is only reached over https
    MAX_CONTENT_LENGTH=256 * 1024,                                         # no multi-megabyte request bodies
)
PRIV = "/usr/local/bin/jarvis-priv"             # root helper (scripts/jarvis-priv): the only privileged scanner/sniffer entry in sudoers


def save_cfg(c):
    """Atomic config write (temp file in the same folder, mode 600, then rename) so a crash never leaves a half-written file."""
    tmp = os.path.join(os.path.dirname(CONFIG_PATH) or ".", ".config.json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(c, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, CONFIG_PATH)


def verify_cfg_password(pw, c):
    h = c.get("password_hash")
    if h:
        return nt_auth.verify_password(pw, h)
    legacy = c.get("password")                   # only present if the migration below could not write the file
    return bool(legacy) and secrets.compare_digest(pw, str(legacy))


def migrate_password():
    """Config files written by older versions keep the login password in plain text: replace it with a salted scrypt hash."""
    if cfg.get("password_hash") or "password" not in cfg:
        return
    try:
        plain = str(cfg["password"])
        h = nt_auth.hash_password(plain)
        if not nt_auth.verify_password(plain, h):
            return
        new = {k: v for k, v in cfg.items() if k != "password"}
        new["password_hash"] = h
        save_cfg(new)
        cfg.clear()
        cfg.update(new)
    except Exception as e:                       # keep working with the plain-text copy rather than lock the owner out
        sys.stderr.write("password migration skipped: %s\n" % e)


migrate_password()
login_throttle = nt_auth.LoginThrottle()

VALID_TARGET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$")
VALID_SSID = re.compile(r"^[^\x00-\x1f]{1,32}$")
VALID_MAC = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")
VALID_NAME = re.compile(r"^[^\x00-\x1f]{1,64}$")


# ---- helpers -------------------------------------------------------------

def run(argv, timeout=45, cwd=None):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return "[timed out]"
    except Exception as e:  # noqa: BLE001
        return f"[error] {e}"


def log_history(label, target, text):
    try:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(HISTORY, "a") as f:
            f.write(f"\n===== [{ts}] {label}{' -> ' + target if target else ''} =====\n{text}\n")
    except Exception:
        pass


# ---- agent access (bearer tokens) -------------------------------------------
# Other agents / services get their own token: "read" can only look; "act" can also run a speed test.
# Only SHA-256 hashes are stored (/var/lib/jarvis-nettools/agent-tokens.json, managed by `nettools-agent-token`).
# A token can never reach settings, passwords, joins or any other endpoint: everything not listed here is 403.
AGENT_TOKENS_PATH = "/var/lib/jarvis-nettools/agent-tokens.json"
AGENT_LOG = "/var/lib/jarvis-nettools/agent-access.log"
AGENT_READ = {("GET", "/api/agent/summary"), ("GET", "/api/status"), ("GET", "/api/signal"), ("GET", "/api/wifi/saved"),
              ("GET", "/api/apnames"), ("GET", "/api/netmon/status"), ("GET", "/api/netmon/timeline"),
              ("GET", "/api/netmon/speed"), ("GET", "/api/report"), ("POST", "/api/aps"), ("POST", "/api/scanall")}
AGENT_ACT = AGENT_READ | {("POST", "/api/speedtest")}
AGENT_CONTROL = AGENT_ACT | {("POST", "/api/agent/ap")}   # may pin an access point / band (temporary, auto-reverts)
AGENT_MIN_GAP = {"/api/report": 20, "/api/aps": 10, "/api/scanall": 20, "/api/speedtest": 60, "/api/agent/ap": 30}   # seconds between calls
AGENT_RATE = 60                                                                                  # requests/minute per token
_agent_hits, _agent_last = {}, {}


def agent_log(tid, status, note=""):
    try:
        with open(AGENT_LOG, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {tid} {request.remote_addr} {request.method} {request.path} {status} {note}\n")
        if os.path.getsize(AGENT_LOG) > 1_000_000:   # keep it small: drop the oldest half
            lines = open(AGENT_LOG).read().splitlines()[-2000:]
            open(AGENT_LOG, "w").write("\n".join(lines) + "\n")
    except OSError:
        pass


def agent_token(raw):
    digest = hashlib.sha256(raw.encode()).hexdigest()
    try:
        toks = json.load(open(AGENT_TOKENS_PATH)).get("tokens", [])
    except Exception:
        return None
    for t in toks:
        if hmac.compare_digest(str(t.get("hash", "")), digest):
            return t
    return None


def agent_gate(fn, a, k):
    """Run `fn` for a Bearer-token request after scope + rate checks (once per request)."""
    t = agent_token(request.headers.get("Authorization", "")[7:].strip())
    if not t:
        agent_log("?", 401, "bad token")
        return jsonify({"error": "invalid token"}), 401
    tid, key = t.get("id", "?"), (request.method, request.path)
    if key not in {"act": AGENT_ACT, "control": AGENT_CONTROL}.get(t.get("scope"), AGENT_READ):
        agent_log(tid, 403, "out of scope")
        return jsonify({"error": "this token is not allowed to do that"}), 403
    now = time.time()
    hits = [x for x in _agent_hits.get(tid, []) if now - x < 60]
    gap = AGENT_MIN_GAP.get(request.path, 0)
    wait = max(0, gap - (now - _agent_last.get(request.path, 0))) if gap else 0
    if len(hits) >= AGENT_RATE or wait > 0:
        agent_log(tid, 429, "rate limit")
        r = jsonify({"error": "slow down", "retry_after_seconds": int(wait) + 1})
        r.status_code = 429; r.headers["Retry-After"] = str(int(wait) + 1)
        return r
    hits.append(now); _agent_hits[tid] = hits
    if gap:
        _agent_last[request.path] = now
    g.agent_ok = True
    resp = fn(*a, **k)
    agent_log(tid, resp[1] if isinstance(resp, tuple) else getattr(resp, "status_code", 200))
    return resp


def require_login(fn):
    @wraps(fn)
    def wrapper(*a, **k):
        if getattr(g, "agent_ok", False):          # nested call inside an already-authorised agent request
            return fn(*a, **k)
        if request.headers.get("Authorization", "").startswith("Bearer "):
            return agent_gate(fn, a, k)
        # Loopback is trusted: the Cockpit page (already behind Cockpit's own
        # login) reaches this API over 127.0.0.1 via cockpit.http().
        # The configured hub (config.json "trusted_hub_ip") is trusted for READ-ONLY calls: its alert
        # watcher polls the monitor. WireGuard's cryptokey routing guarantees a
        # packet with that source really came from the hub.
        ra = request.remote_addr
        hub = str(cfg.get("trusted_hub_ip", "")).strip()           # optional: a monitoring hub allowed to GET without a login
        if ra == "127.0.0.1" or (hub and ra == hub and request.method == "GET") or session.get("auth"):
            return fn(*a, **k)
        return jsonify({"error": "not logged in"}), 401
    return wrapper


def band_of(freq_mhz):
    if freq_mhz < 3000:
        return "2.4"
    if freq_mhz < 5925:
        return "5"
    return "6"


def default_iface():
    i = run(["/bin/sh", "-c", "ip route | awk '/default/{print $5; exit}'"]).strip()
    return i if re.match(r"^[a-z0-9]+$", i) else WLAN


def default_gw():
    return run(["/bin/sh", "-c", "ip route | awk '/default/{print $3; exit}'"]).strip()


def text_tool(label, argv, target=None, timeout=45, sub=None):
    out = run(argv, timeout=timeout)
    if sub:
        out = out.replace(*sub)
    log_history(label, target, out)
    return jsonify({"output": out})


def target_from_request():
    data = request.get_json(silent=True) or {}
    t = str(data.get("target", "")).strip()
    return t if VALID_TARGET.match(t) else None


# ---- auth ----------------------------------------------------------------

def client_ip():
    """The caller's address. X-Forwarded-For is believed only when the TCP peer is a configured reverse proxy
    (config.json "trusted_proxies"); the proxy appends the real client as the LAST entry."""
    ra = request.remote_addr or ""
    if ra in set(cfg.get("trusted_proxies") or []):
        xff = request.headers.get("X-Forwarded-For", "")
        if xff:
            return xff.split(",")[-1].strip() or ra
    return ra


@app.post("/api/login")
def login():
    key = client_ip()
    wait = login_throttle.wait(key)
    if wait:
        r = jsonify({"error": "Too many wrong passwords - try again in %d s." % wait})
        r.status_code = 429
        r.headers["Retry-After"] = str(wait)
        return r
    data = request.get_json(silent=True) or {}
    if verify_cfg_password(str(data.get("password", "")), cfg):
        login_throttle.ok(key)
        session["auth"] = True
        session.permanent = True
        return jsonify({"ok": True})
    login_throttle.fail(key)
    return jsonify({"error": "wrong password"}), 401


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
def me():
    # Loopback is already trusted by require_login (Cockpit page, the Pi's own touch-screen kiosk),
    # so tell the UI the same instead of showing it a login screen it doesn't need.
    return jsonify({"auth": bool(session.get("auth")) or request.remote_addr == "127.0.0.1"})


# ---- connection / status -------------------------------------------------

def net_info():
    """What the Pi is actually using to reach the network: Ethernet or WiFi, plus link speed/IP."""
    iface = default_iface()
    kind = "wifi" if iface.startswith("wl") else "ethernet" if iface.startswith(("eth", "en")) else "other"
    def sysfs(n):
        try:
            return open(f"/sys/class/net/{iface}/{n}").read().strip()
        except Exception:
            return ""
    ip = (re.search(r"inet (\S+?)/", run(["ip", "-4", "-o", "addr", "show", "dev", iface])) or [None, ""])[1]
    speed = sysfs("speed")
    return {"iface": iface, "type": kind, "ip": ip, "gw": default_gw(),
            "speed": speed if speed and speed != "-1" else "", "duplex": sysfs("duplex")}


USB_GENS = {1.5: "USB 1.0", 12: "USB 1.1", 480: "USB 2.0", 5000: "USB 3", 10000: "USB 3.2 Gen 2", 20000: "USB 3.2 Gen 2x2"}


def usb_superspeed_capable(bos):
    """From a device's raw BOS descriptor: True if it lists a SuperSpeed or SuperSpeedPlus capability (a USB 3 device,
    even while it runs at USB 2 speed), False if it lists neither, None if there is no usable BOS."""
    if len(bos) < 5 or bos[0] < 5 or bos[1] != 0x0F:
        return None
    i, end = bos[0], min(len(bos), bos[2] | bos[3] << 8)
    while i + 3 <= end and bos[i] >= 3:
        if bos[i + 1] == 0x10 and bos[i + 2] in (0x03, 0x0A):
            return True
        i += bos[i]
    return False


def usb_link(iface=WLAN, sys_root="/sys"):
    """USB link of the Wi-Fi adapter for the Info screen: negotiated speed, whether the adapter and its port can do
    USB 3, and a status + hint. A USB 3 adapter that only gets its USB 2 contacts (USB-C plug the wrong way round, plug
    not fully in, USB 2 port/cable/hub) runs at 480 Mbps, which caps Wi-Fi at roughly 150-250 Mbps. None if not USB."""
    try:
        return _usb_link(iface, sys_root)
    except Exception:
        return None


def _usb_link(iface, sys_root):
    def rd(name):
        try:
            return open(os.path.join(dev, name)).read().strip()
        except Exception:
            return ""
    dev = os.path.realpath(f"{sys_root}/class/net/{iface}/device")
    for _ in range(4):                       # interface dir (2-1:1.3) -> USB device dir (2-1), which has speed + idVendor
        dev = os.path.dirname(dev)
        if rd("speed") and rd("idVendor"):
            break
    else:
        return None
    mbps = float(rd("speed"))
    try:
        bos = open(os.path.join(dev, "bos_descriptors"), "rb").read()
    except Exception:
        bos = b""
    capable = usb_superspeed_capable(bos)
    if capable is None and re.match(r"^[3-9]\.", rd("version")):
        capable = True                       # running at USB 3 right now
    port = os.path.join(dev, "port")         # a port with a "peer" is one half of a USB 3 port (blue)
    port_usb3 = True if mbps >= 5000 else os.path.exists(os.path.join(port, "peer")) if os.path.isdir(port) else None
    if mbps >= 5000:
        state, hint = "ok", ""
    elif capable and port_usb3 is False:     # hints stay one line on the 800 px touch screen
        state, hint = "warn", "USB 3 adapter on a USB 2 port or hub (Wi-Fi max ~200 Mbps): move it to a blue USB 3 port."
    elif capable:
        state, hint = "warn", "USB 3 adapter on USB 2 (Wi-Fi max ~200 Mbps): flip the USB-C plug 180°, push both ends fully in."
    elif capable is False:
        state, hint = "info", "USB 2 adapter: 480 Mbps is its maximum."
    else:
        state, hint = "unknown", "If this adapter is USB 3, re-plug it firmly into a blue USB 3 port."
    n = int(mbps) if mbps == int(mbps) else mbps
    return {"iface": iface, "mbps": n, "label": f"{n / 1000:g} Gbps" if n >= 1000 else f"{n:g} Mbps",
            "gen": USB_GENS.get(n, "USB"), "usb3_capable": capable, "port_usb3": port_usb3, "status": state,
            "hint": hint, "id": rd("idVendor") + ":" + rd("idProduct"), "product": rd("product"),
            "usb_path": os.path.basename(dev)}


@app.get("/api/status")
@require_login
def status():
    return jsonify({"link": run(["/usr/sbin/iw", "dev", WLAN, "link"]), "net": net_info(), "usb": usb_link(),
                    "active": run(["nmcli", "-t", "-f", "NAME,DEVICE", "connection", "show", "--active"])})


@app.get("/api/signal")
@require_login
def signal():
    return jsonify({"link": run(["/usr/sbin/iw", "dev", WLAN, "link"], timeout=10)})


# ---- wifi ----------------------------------------------------------------

@app.post("/api/wifi/scan")
@require_login
def wifi_scan():
    out = run(["sudo", "nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY",
               "dev", "wifi", "list", "ifname", WLAN, "--rescan", "yes"], timeout=40)
    nets = {}
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) < 3:
            continue
        sec, sig, ssid = parts[-1], parts[-2], ":".join(parts[:-2])
        if not ssid:
            continue
        try:
            s = int(sig)
        except ValueError:
            continue
        if ssid not in nets or nets[ssid]["signal"] < s:
            nets[ssid] = {"ssid": ssid, "signal": s, "security": sec}
    return jsonify({"networks": sorted(nets.values(), key=lambda r: -r["signal"])})


def wifi_profiles():
    """name -> ssid for every saved WiFi client profile usable on the client radio. Profiles pinned to
    another interface (e.g. the one Raspberry Pi Imager creates for the built-in wlan0) and hotspot
    (AP-mode) profiles are skipped: `nmcli connection up <them> ifname wlan1` can only fail."""
    prof = {}
    for line in run(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"]).splitlines():
        if line.endswith(":802-11-wireless"):
            name = line[: -len(":802-11-wireless")]
            out = run(["nmcli", "-t", "-f", "802-11-wireless.ssid,802-11-wireless.mode,connection.interface-name",
                       "connection", "show", name])
            f = dict(l.split(":", 1) for l in out.splitlines() if ":" in l)
            if f.get("connection.interface-name", "") not in ("", WLAN) or f.get("802-11-wireless.mode") == "ap":
                continue
            prof[name] = f.get("802-11-wireless.ssid", "")
    return prof


def active_ssid():
    return (re.search(r"SSID:\s*(.+)", run(["/usr/sbin/iw", "dev", WLAN, "link"], timeout=10)) or [None, None])[1]


def security_of(ssid, rescan=False):
    out = run(["sudo", "nmcli", "-t", "-f", "SSID,SECURITY", "dev", "wifi", "list",
               "ifname", WLAN, "--rescan", "yes" if rescan else "no"], timeout=40)
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) >= 2 and ":".join(parts[:-1]) == ssid:
            return parts[-1].strip()
    return None


VALID_BANDS = ("auto", "2.4", "5", "6")


def ap_rows(ssid):
    """BSSID/signal/frequency of every AP currently broadcasting `ssid` (cached scan)."""
    out = run(["sudo", "nmcli", "-t", "-f", "SSID,BSSID,SIGNAL,FREQ", "dev", "wifi", "list",
               "ifname", WLAN, "--rescan", "no"], timeout=40)
    rows = []
    for line in out.splitlines():
        m = re.match(r"^(.*):((?:[0-9A-Fa-f]{2}\\:){5}[0-9A-Fa-f]{2}):(\d+):(\d+) MHz$", line)
        if m and m.group(1).replace("\\:", ":") == ssid:
            rows.append({"bssid": m.group(2).replace("\\", ""), "sig": int(m.group(3)), "freq": int(m.group(4))})
    return rows


def apply_band(profile, ssid, band, bssid=""):
    """Lock a saved profile to a band ('auto' clears the lock). NetworkManager's band
    property only knows 2.4/5 GHz, so 6 GHz is pinned to the strongest 6 GHz BSSID.
    A BSSID pins the profile to one specific access point (no roaming) and overrides the band.
    Returns an error string, or '' on success."""
    if bssid:
        if not any(r["bssid"].upper() == bssid.upper() for r in ap_rows(ssid)):
            return f"Access point {bssid} isn't visible for '{ssid}' right now - refresh the AP list."
        props = ("", bssid.upper())
    elif band == "6":
        aps = [r for r in ap_rows(ssid) if r["freq"] >= 5925]
        if not aps:
            return f"No 6 GHz access point for '{ssid}' in range - scan again, or pick another band."
        props = ("", max(aps, key=lambda r: r["sig"])["bssid"])
    else:
        props = {"2.4": ("bg", ""), "5": ("a", "")}.get(band, ("", ""))
    out = run(["sudo", "nmcli", "connection", "modify", profile,
               "802-11-wireless.band", props[0], "802-11-wireless.bssid", props[1]], timeout=20)
    return out.strip() if "error" in out.lower() else ""


def current_bssid():
    m = re.search(r"Connected to\s+([0-9a-fA-F:]{17})", run(["/usr/sbin/iw", "dev", WLAN, "link"], timeout=10))
    return m.group(1).upper() if m else ""


def current_band():
    m = re.search(r"freq:\s*(\d+)", run(["/usr/sbin/iw", "dev", WLAN, "link"], timeout=10))
    return band_of(int(m.group(1))) if m else ""


def do_join(ssid, pw, band="auto", bssid=""):
    """(ok, message). Activates SAVED profiles instead of re-creating them (nmcli
    otherwise fails with 'key-mgmt: property is missing'), never sends a password
    to an open network, and refuses a secured network without one."""
    profiles = wifi_profiles()
    saved_name = next((n for n, s in profiles.items() if n == ssid or s == ssid), None)
    if saved_name:
        if ssid == active_ssid() and not pw and (
                bssid.upper() == current_bssid() if bssid else (band == "auto" or band == current_band())):
            if band == "auto" and not bssid:
                apply_band(saved_name, ssid, "auto")
            return True, f"Already connected to {ssid}" + (f" on {bssid.upper()}." if bssid else ".")
        if pw:
            km = run(["nmcli", "-t", "-f", "802-11-wireless-security.key-mgmt",
                      "connection", "show", saved_name]).strip()
            if km and not km.endswith(":"):
                m = run(["sudo", "nmcli", "connection", "modify", saved_name,
                         "802-11-wireless-security.psk", pw], timeout=20)
                if "error" in m.lower():
                    return False, "Couldn't update the saved password:\n" + m.strip()
        err = apply_band(saved_name, ssid, band, bssid)
        if err:
            return False, err
        out = run(["sudo", "nmcli", "connection", "up", saved_name, "ifname", WLAN], timeout=45)
        ok = "successfully activated" in out.lower()
        if not ok and (band != "auto" or bssid):
            apply_band(saved_name, ssid, "auto")
            run(["sudo", "nmcli", "connection", "up", saved_name, "ifname", WLAN], timeout=45)
            return False, ("Couldn't connect to that access point - went back to Auto.\n" if bssid else f"Couldn't connect on {band} GHz - went back to Auto.\n") + out.strip()
        return ok, out.strip()
    sec = security_of(ssid)
    if sec is None:
        sec = security_of(ssid, rescan=True)
    if sec is None:
        return False, f"'{ssid}' isn't in range right now — scan again."
    if "802.1X" in sec:
        return False, "Enterprise (802.1X) network — needs a username/certificate; not supported here."
    is_open = (sec == "")
    if is_open:
        argv = ["sudo", "nmcli", "dev", "wifi", "connect", ssid, "ifname", WLAN]
    elif not pw:
        return False, f"'{ssid}' is secured ({sec}) — enter its password first."
    else:
        argv = ["sudo", "nmcli", "dev", "wifi", "connect", ssid, "ifname", WLAN, "password", pw]
    out = run(argv, timeout=45)
    ok = "successfully activated" in out.lower()
    if not ok and not is_open and "key-mgmt" in out:
        km = "sae" if ("WPA3" in sec and "WPA2" not in sec and "WPA1" not in sec) else "wpa-psk"
        run(["sudo", "nmcli", "connection", "delete", ssid], timeout=20)
        run(["sudo", "nmcli", "connection", "add", "type", "wifi", "ifname", WLAN,
             "con-name", ssid, "ssid", ssid, "wifi-sec.key-mgmt", km, "wifi-sec.psk", pw], timeout=20)
        out = run(["sudo", "nmcli", "connection", "up", ssid, "ifname", WLAN], timeout=45)
        ok = "successfully activated" in out.lower()
    if not ok:
        run(["sudo", "nmcli", "connection", "delete", ssid], timeout=20)
    elif bssid or (band != "auto" and band != current_band()):
        err = apply_band(ssid, ssid, band, bssid)
        if err:
            return True, out.strip() + "\n[!] Connected, but could not switch access point/band: " + err
        out2 = run(["sudo", "nmcli", "connection", "up", ssid, "ifname", WLAN], timeout=45)
        if "successfully activated" in out2.lower():
            out = out2
        else:
            apply_band(ssid, ssid, "auto")
            run(["sudo", "nmcli", "connection", "up", ssid, "ifname", WLAN], timeout=45)
            out = out.strip() + "\n[!] Couldn't move to that access point/band - staying on Auto."
    return ok, out.strip()


@app.post("/api/wifi/join")
@require_login
def wifi_join():
    data = request.get_json(silent=True) or {}
    ssid, pw = str(data.get("ssid", "")), str(data.get("password", ""))
    if not VALID_SSID.match(ssid):
        return jsonify({"error": "invalid ssid"}), 400
    band = str(data.get("band", "auto"))
    if band not in VALID_BANDS:
        band = "auto"
    bssid = str(data.get("bssid", "")).strip()
    if bssid and not VALID_MAC.match(bssid):
        return jsonify({"error": "invalid bssid"}), 400
    ok, msg = do_join(ssid, pw, band, bssid.replace("-", ":"))
    log_history("Join WiFi", ssid, msg)
    return jsonify({"ok": ok, "output": msg})


@app.get("/api/wifi/saved")
@require_login
def wifi_saved():
    out = run(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"])
    names = [l[:-len(":802-11-wireless")] for l in out.splitlines() if l.endswith(":802-11-wireless")]
    return jsonify({"profiles": sorted(set(names))})


@app.post("/api/wifi/switch")
@require_login
def wifi_switch():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", ""))
    if not VALID_NAME.match(name):
        return jsonify({"error": "invalid name"}), 400
    return text_tool("Switch WiFi", ["sudo", "nmcli", "connection", "up", name], name, timeout=40)


@app.post("/api/wifi/forget")
@require_login
def wifi_forget():
    """Delete a saved WiFi profile — even the active one. Never the management hotspot."""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", ""))
    if not VALID_NAME.match(name) or re.search(r"JarvisPi", name, re.I):
        return jsonify({"ok": False, "output": "Refused — that profile is protected."}), 400
    out = run(["sudo", "nmcli", "connection", "delete", name], timeout=20)
    log_history("Forget WiFi", name, out)
    return jsonify({"ok": "deleted" in out.lower(), "output": out.strip()})


@app.post("/api/wifi/clear")
@require_login
def wifi_clear():
    return text_tool("Clear Visited WiFi", ["sudo", "/usr/local/bin/wifi-clear"], timeout=40)


@app.post("/api/scanall")
@require_login
def scan_all():
    # nmcli coordinates with the active connection, so it works on wlan1 without
    # the "resource busy" error that a raw `iw scan` hits on a connected radio.
    out = run(["sudo", "nmcli", "-t", "-f", "SSID,SIGNAL,CHAN,FREQ",
               "dev", "wifi", "list", "ifname", WLAN, "--rescan", "yes"], timeout=45)
    uniq = {}
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) < 4:
            continue
        freq, chan, sig, ssid = parts[-1], parts[-2], parts[-3], ":".join(parts[:-3]) or "(hidden)"
        try:
            s = int(sig)
            f = int(freq.split()[0]) if freq.strip() else 0
        except ValueError:
            continue
        k = (ssid, chan)
        if k not in uniq or int(uniq[k]["sig"]) < s:
            uniq[k] = {"ch": chan, "sig": str(s), "ssid": ssid, "band": band_of(f), "freq": f}
    result = sorted(uniq.values(), key=lambda r: -int(r["sig"]))
    log_history("Scan All WiFi", None, "\n".join(f"{r['band']:>3}G ch {r['ch']:<4} {r['sig']}%  {r['ssid']}" for r in result))
    return jsonify({"networks": result})


@app.post("/api/channel")
@require_login
def channel():
    # nmcli (robust on a connected radio). Fields: CHAN, FREQ, SIGNAL(%).
    out = run(["sudo", "nmcli", "-t", "-f", "SSID,SIGNAL,CHAN,FREQ",
               "dev", "wifi", "list", "ifname", WLAN, "--rescan", "yes"], timeout=45)
    chan24, chan5, chan6 = {}, {}, {}
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) < 4:
            continue
        try:
            f = int(parts[-1].split()[0]) if parts[-1].strip() else 0
            ch = int(parts[-2]); sig = int(parts[-3])
        except (ValueError, IndexError):
            continue
        ssid = ":".join(parts[:-3]) or "(hidden)"
        d = {"2.4": chan24, "5": chan5, "6": chan6}[band_of(f)]
        e = d.setdefault(ch, {"count": 0, "best": 0, "ssids": {}})
        e["count"] += 1
        e["best"] = max(e["best"], sig)
        e["ssids"][ssid] = max(e["ssids"].get(ssid, 0), sig)
    for d in (chan24, chan5, chan6):
        for e in d.values():
            e["ssids"] = [{"ssid": k, "sig": v} for k, v in sorted(e["ssids"].items(), key=lambda kv: -kv[1])]
    return jsonify({"band24": chan24, "band5": chan5, "band6": chan6})


# ---- quick tools ---------------------------------------------------------

@app.post("/api/devices")
@require_login
def devices():
    # Scan the LAN we're actually on (the interface holding the default route),
    # NOT the management hotspot's subnet, which arp-scan would otherwise pick
    # first. arp-scan resolves vendor names from a file relative to its cwd.
    hosts = scan_devices()
    log_history("Find Devices", None, "\n".join(f"{h['ip']:<16}{h['name'][:24]:<26}{h['type'][:26]:<28}{h['vendor'][:24]:<26}{h['mac']}" for h in hosts))
    return jsonify({"hosts": hosts})


_last_devices = []


def resolve_name(ip):
    """Best-effort device name: mDNS (.local) -> NetBIOS -> reverse DNS."""
    out = run(["avahi-resolve-address", ip], timeout=3)
    if "\t" in out:
        n = out.split("\t")[1].strip()
        if n:
            return n
    out = run(["nbtscan", "-q", "-t", "800", ip], timeout=4)
    for line in out.splitlines():
        p = line.split()
        if len(p) >= 2 and p[0] == ip and p[1] not in ("<unknown>",):
            return p[1]
    out = run(["dig", "+short", "+time=1", "+tries=1", "-x", ip], timeout=3).strip()
    if out and "timed out" not in out and ";" not in out:
        return out.splitlines()[0].rstrip(".")
    return ""


OUI_CACHE = "/var/lib/jarvis-nettools/oui-cache.json"
ID_PORTS = "22,23,80,443,139,445,515,554,631,1900,5000,8008,8043,8080,8443,9100,32400"


def avahi_unescape(t):
    """avahi-browse -p escapes non-ASCII/space bytes as \\DDD (decimal); decode them as UTF-8."""
    try:
        return re.sub(r"\\(\d{3})", lambda m: chr(int(m.group(1))), t).encode("latin-1").decode("utf-8")
    except Exception:
        return t.replace("\\032", " ")


def mdns_browse():
    """ip -> [(friendly name, service type)] via avahi-browse (Chromecast, AirPlay, printers, Sonos, ...)."""
    out = run(["avahi-browse", "-a", "-t", "-r", "-p"], timeout=12)
    found = {}
    for line in out.splitlines():
        p = line.split(";")
        if line.startswith("=") and len(p) >= 9 and ":" not in p[7]:
            found.setdefault(p[7], []).append((avahi_unescape(p[3]), p[4]))
    return found


def ssdp_discover(local_ip):
    """ip -> {server, model, manufacturer, friendly} via UPnP M-SEARCH (TVs, cameras, routers, Sonos...)."""
    res = {}
    try:
        msg = b'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n'
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(local_ip))
        s.settimeout(1.0)
        for _ in range(2):
            s.sendto(msg, ("239.255.255.250", 1900))
        end = time.time() + 3.5
        while time.time() < end:
            try:
                data, (ip, _) = s.recvfrom(4096)
            except socket.timeout:
                continue
            hdr = {}
            for l in data.decode(errors="ignore").split("\r\n"):
                if ":" in l:
                    k, v = l.split(":", 1); hdr[k.strip().upper()] = v.strip()
            r = res.setdefault(ip, {})
            r.setdefault("server", hdr.get("SERVER", ""))
            if hdr.get("LOCATION") and "location" not in r:
                r["location"] = hdr["LOCATION"]
        s.close()
    except Exception:
        return res

    def desc(ip):
        loc = res[ip].get("location")
        if not loc:
            return
        x = run(["curl", "-s", "-k", "-m", "3", loc], timeout=5)
        for tag, key in (("friendlyName", "friendly"), ("modelName", "model"), ("manufacturer", "manufacturer")):
            m = re.search(rf"<{tag}>([^<]{{1,80}})</{tag}>", x)
            if m:
                res[ip][key] = m.group(1).strip()
    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(desc, list(res)))
    return res


def http_title(ip, ports):
    for scheme, port in (("http", "80"), ("https", "443"), ("http", "8080"), ("https", "8443")):
        if port in ports:
            x = run(["curl", "-s", "-k", "-L", "-m", "3", f"{scheme}://{ip}:{port}/"], timeout=5)
            m = re.search(r"<title[^>]*>\s*([^<]{1,80}?)\s*</title>", x, re.I | re.S)
            if m:
                t = re.sub(r"\s+", " ", html.unescape(m.group(1))).strip()
                return re.sub(r"\s*\d+\.\d+\.\d+\.\d+$", "", t)
    return ""


def vendor_online(macs):
    """Look up vendors the local OUI table doesn't know (macvendors.com, cached, rate-limited)."""
    try:
        cache = json.load(open(OUI_CACHE))
    except Exception:
        cache = {}
    out = {}
    looked = 0
    for mac in macs:
        key = mac.upper()[:8]
        if key in cache:
            out[mac] = cache[key]; continue
        if looked >= 12:
            continue
        v = run(["curl", "-s", "-m", "4", "https://api.macvendors.com/" + mac], timeout=6).strip()
        v = "" if (not v or v.startswith("{") or "<" in v) else v
        cache[key] = v; out[mac] = v; looked += 1
        time.sleep(1.1)
    try:
        json.dump(cache, open(OUI_CACHE, "w"))
    except Exception:
        pass
    return out


def classify(h, ports, mdns, ssdp, title, gw):
    v = h["vendor"].lower(); svc = " ".join(s for _, s in mdns).lower()
    model = ((ssdp.get("manufacturer", "") + " " + ssdp.get("model", "")).strip())
    blob = (title + " " + model + " " + v + " " + ssdp.get("server", "")).lower()
    private = len(h["mac"]) > 1 and h["mac"][1].lower() in "26ae"
    if h["ip"] == gw:                                   return "Router / gateway"
    if "8043" in ports or "omada" in blob:              return "Omada controller"
    if "_googlecast" in svc:                            return "Chromecast / Google TV"
    if "_airplay" in svc or "_raop" in svc:             return "Apple TV / AirPlay"
    if "_printer" in svc or "_ipp" in svc or ports & {"9100", "631", "515"} or any(k in v for k in ("star micronics", "epson", "zebra", "brother", "bixolon", "citizen")):
        return "Printer"
    if "554" in ports or "camera" in blob or "owl labs" in v or "nvr" in blob or "hikvision" in v or "dahua" in v or "axis" in v:
        return "Camera / NVR"
    if "sonos" in blob:                                 return "Sonos speaker"
    if "raspberry" in v:                                return "Raspberry Pi"
    if any(k in v for k in ("espressif", "tuya", "shelly", "sonoff", "wyze", "tp-link smart")): return "IoT / smart device"
    if any(k in v for k in ("square", "clover", "verifone", "ingenico", "pax ", "elo touch")): return "POS / payment terminal"
    if "_hap" in svc or "homekit" in blob:              return "HomeKit accessory"
    if "roku" in blob or "samsung" in v and "tv" in blob or "lg electronics" in v or "_tv" in svc or "32400" in ports: return "TV / media player"
    if any(k in v for k in ("tp-link", "ubiquiti", "cisco", "netgear", "mikrotik", "aruba", "meraki", "ruckus")): return "Network gear"
    if ports & {"445", "139"}:                          return "Windows PC"
    if "intel corporate" in v and ports <= {"22", "5000"}: return "Laptop (Intel WiFi)"
    if "apple" in v:                                    return "Apple device"
    if private:                                         return "Phone / laptop (private MAC)"
    if model:                                           return model[:40]
    if "22" in ports:                                   return "Linux / embedded"
    return "unknown"


def scan_devices():
    """arp-scan the real LAN, then identify every device from six sources: local OUI,
    online OUI, mDNS/NetBIOS/rDNS names, mDNS services, UPnP/SSDP, open ports + web titles."""
    global _last_devices
    iface, gw = default_iface(), default_gw()
    local_ip = (re.search(r"inet (\d+\.\d+\.\d+\.\d+)", run(["ip", "-4", "-o", "addr", "show", iface])) or [None, ""])[1]
    out = run(["sudo", PRIV, "arp-scan", iface], timeout=60)
    hosts, seen = [], set()
    for line in out.splitlines():
        m = re.match(r"^(\d+\.\d+\.\d+\.\d+)\s+(\S+)\s*(.*)$", line)
        if m and m.group(1) not in seen:          # arp-scan repeats hosts that answer twice
            seen.add(m.group(1))
            hosts.append({"ip": m.group(1), "mac": m.group(2), "vendor": re.sub(r"\s*\(DUP: \d+\)", "", m.group(3)).strip(), "name": "", "type": "", "info": ""})
    if not hosts:
        _last_devices = hosts
        return hosts
    ips = [h["ip"] for h in hosts]
    unknown_macs = [h["mac"] for h in hosts if "unknown" in h["vendor"].lower() and "locally administered" not in h["vendor"].lower()]
    with ThreadPoolExecutor(max_workers=24) as ex:
        f_names = [ex.submit(resolve_name, ip) for ip in ips]
        f_mdns = ex.submit(mdns_browse)
        f_ssdp = ex.submit(ssdp_discover, local_ip) if local_ip else None
        f_ports = ex.submit(run, ["sudo", PRIV, "nmap", "-Pn", "-T4", "--open", "-p", ID_PORTS, "-oG", "-"] + ips, 90)
        f_oui = ex.submit(vendor_online, unknown_macs)
        names = [f.result() for f in f_names]
        mdns, ssdp = f_mdns.result(), (f_ssdp.result() if f_ssdp else {})
        ports_by_ip = {}
        for line in f_ports.result().splitlines():
            m = re.match(r"^Host:\s+(\S+).*Ports:\s+(.+)$", line)
            if m:
                ports_by_ip[m.group(1)] = {p.strip().split("/")[0] for p in m.group(2).split(",") if "/open/" in p}
        oui = f_oui.result()
        f_titles = {h["ip"]: ex.submit(http_title, h["ip"], ports_by_ip.get(h["ip"], set())) for h in hosts if ports_by_ip.get(h["ip"], set()) & {"80", "443", "8080", "8443"}}
        titles = {ip: f.result() for ip, f in f_titles.items()}
    for h, n in zip(hosts, names):
        if h["mac"] in oui and oui[h["mac"]]:
            h["vendor"] = oui[h["mac"]]
        ports, md, sd, title = ports_by_ip.get(h["ip"], set()), mdns.get(h["ip"], []), ssdp.get(h["ip"], {}), titles.get(h["ip"], "")
        friendly = sd.get("friendly") or (md[0][0] if md else "")
        h["name"] = n or friendly
        h["type"] = classify(h, ports, md, sd, title, gw)
        bits = []
        if friendly and friendly != h["name"]: bits.append(friendly)
        if sd.get("model"): bits.append((sd.get("manufacturer", "") + " " + sd["model"]).strip())
        if title: bits.append("web: " + title)
        if md: bits.append("mDNS: " + ", ".join(sorted({s.lstrip("_").split(".")[0] for _, s in md}))[:60])
        if ports: bits.append("ports " + ",".join(sorted(ports, key=int)))
        h["info"] = " · ".join(bits)[:160]
    hosts.sort(key=lambda h: [int(x) for x in h["ip"].split(".")])
    _last_devices = hosts
    return hosts


@app.get("/api/devices.csv")
@require_login
def devices_csv():
    rows = _last_devices or scan_devices()
    def cell(x):
        return '"' + str(x).replace('"', "'") + '"'
    csv = "ip,name,type,vendor,mac,info\n" + "".join(
        f"{h['ip']},{cell(h['name'])},{cell(h.get('type', ''))},{cell(h['vendor'])},{h['mac']},{cell(h.get('info', ''))}\n" for h in rows)
    return Response(csv, mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=devices-" + time.strftime("%Y%m%d-%H%M") + ".csv"})


@app.post("/api/ports")
@require_login
def ports():
    return text_tool("Open Ports", ["sudo", PRIV, "ss"])


@app.post("/api/bandwidth")
@require_login
def bandwidth():
    return text_tool("Bandwidth", ["vnstat", "-tr", "5", "-i", WLAN], timeout=30)


@app.post("/api/mtr")
@require_login
def mtr():
    t = target_from_request() or "8.8.8.8"
    return text_tool("Path / Traceroute", ["mtr", "-r", "-c", "5", t], t, timeout=60)


@app.post("/api/ping")
@require_login
def ping():
    t = target_from_request()
    if not t:
        return jsonify({"error": "invalid target"}), 400
    return text_tool("Ping", ["ping", "-c", "5", t], t, timeout=20)


# ---- live tools (streamed) ----------------------------------------------------
# One request = one run; every line the tool prints is pushed to the phone the moment it appears (Server-Sent Events:
# `data:` = one output line as a JSON string, `event: start` / `event: done` frame the run), instead of the phone waiting
# for the whole run to finish. The process is stopped when the phone disconnects (Stop / app closed) or at the time cap.
# SIGTERM first: `sudo` relays it to the root command it started (it cannot be SIGKILLed by this user).
_live_slots = threading.BoundedSemaphore(4)          # all streamed tools share these slots


def _read_lines(proc):
    """Yield each output line of `proc`; yields None once a second while it is quiet, so the caller can write a keepalive frame
    (that write is what fails - and triggers cleanup - the moment the phone has disconnected)."""
    q, eof = queue.Queue(), object()

    def pump():
        try:
            for ln in proc.stdout:
                q.put(ln)
        finally:
            q.put(eof)
    threading.Thread(target=pump, daemon=True).start()
    while True:
        try:
            ln = q.get(timeout=1.0)
        except queue.Empty:
            yield None
            continue
        if ln is eof:
            return
        yield ln


def _sse(obj, event=None):
    return (f"event: {event}\n" if event else "") + "data: " + json.dumps(obj) + "\n\n"


def stream_command(label, target, argv, cap, info, log_tail=True, idle_done=0):
    """idle_done > 0: once the tool has printed something and then stays silent that many seconds, end the run (mtr lingers ~5 s
    after its last probe; its passes are 1 s apart so a longer silence really means it is finished)."""
    if not _live_slots.acquire(blocking=False):
        return jsonify({"error": "too many live tools are already running"}), 429

    def gen():
        proc, timer, tail, idle = None, None, [], False
        got, last = False, time.time()
        try:
            proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            timer = threading.Timer(cap, proc.terminate)                   # hard cap, whatever the phone does
            timer.daemon = True
            timer.start()
            yield _sse(info, "start")
            for line in _read_lines(proc):
                if line is None:
                    if idle_done and got and time.time() - last > idle_done:
                        idle = True
                        break
                    yield ": keepalive\n\n"
                    continue
                got, last = True, time.time()
                line = line.rstrip("\n")
                if log_tail:
                    tail = (tail + [line])[-60:]
                yield _sse(line)
            if idle:
                proc.terminate()
            proc.wait()
            yield _sse({"code": proc.returncode}, "done")
        finally:                                                           # also runs when the phone disconnects mid-stream
            if timer:
                timer.cancel()
            if proc:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                try:
                    proc.stdout.close()
                    proc.wait(timeout=3)
                except Exception:
                    pass
            _live_slots.release()
            if log_tail:
                log_history(label, target, "\n".join(tail))

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


def _stream_target(data, default=None):
    t = str(data.get("target", "")).strip() or default or ""
    return t if VALID_TARGET.match(t) else None


@app.post("/api/ping/stream")
@require_login
def ping_stream():
    """count 1..100 stops by itself; count 0 runs until the phone disconnects (30-min cap). target "@gateway" = default gateway."""
    data = request.get_json(silent=True) or {}
    t = default_gw() if str(data.get("target", "")).strip() == "@gateway" else _stream_target(data)
    if not t:
        return jsonify({"error": "invalid target" if data.get("target") != "@gateway" else "No default gateway found."}), 400
    try:
        count = int(data.get("count", 5))
    except (TypeError, ValueError):
        count = 5
    count = 0 if count <= 0 else min(count, 100)
    argv = ["ping", "-n", "-O", "-i", "1", "-W", "2"] + (["-c", str(count)] if count else []) + [t]
    return stream_command("Ping (live)", t, argv, 200 if count else 1800, {"target": t, "count": count})


@app.post("/api/trace/stream")
@require_login
def trace_stream():
    """Live route: mtr in --raw mode (probe events as they happen: `x hop seq` sent, `h hop ip` host, `p hop usec seq` reply);
    the phone assembles the hop table. Hops are 0-based."""
    data = request.get_json(silent=True) or {}
    t = _stream_target(data, "8.8.8.8")
    if not t:
        return jsonify({"error": "invalid target"}), 400
    try:
        count = max(1, min(int(data.get("count", 10)), 60))
    except (TypeError, ValueError):
        count = 10
    return stream_command("Route (live)", t, ["mtr", "-n", "--raw", "-c", str(count), "-i", "1", "-Z", "2", t], count + 45,
                          {"target": t, "count": count}, log_tail=False, idle_done=2.0)


@app.post("/api/portscan/stream")
@require_login
def portscan_stream():
    """Live port scan: nmap -v prints `Discovered open port N/tcp` the moment it finds one and --stats-every gives progress.
    Uses an unprivileged TCP-connect scan (-sT, no sudo) on purpose: a root nmap started through sudo cannot be signalled by this
    user, so it would keep running after the phone disconnects. Same top-100 ports and open/closed results as the SYN scan."""
    t = _stream_target(request.get_json(silent=True) or {})
    if not t:
        return jsonify({"error": "invalid target"}), 400
    argv = ["/usr/bin/nmap", "-sT", "-Pn", "-T4", "--top-ports", "100", "-v", "--stats-every", "1s", t]
    return stream_command("Port Scan (live)", t, argv, 180, {"target": t})


@app.post("/api/pinggw")
@require_login
def ping_gw():
    gw = run(["/bin/sh", "-c", "ip route | awk '/default/{print $3; exit}'"]).strip()
    if not gw:
        return jsonify({"output": "No default gateway found."})
    out = "Gateway: " + gw + "\n" + run(["ping", "-c", "5", gw], timeout=20)
    log_history("Ping Gateway", gw, out)
    return jsonify({"output": out})


@app.post("/api/portscan")
@require_login
def portscan():
    t = target_from_request()
    if not t:
        return jsonify({"error": "invalid target"}), 400
    return text_tool("Port Scan", ["sudo", PRIV, "nmap", "-Pn", "-T4", "--top-ports", "100", t], t, timeout=120)


@app.post("/api/dns")
@require_login
def dns():
    t = target_from_request()
    if not t:
        return jsonify({"error": "invalid target"}), 400
    return text_tool("DNS Lookup", ["dig", t], t, timeout=20)


def bufferbloat_grade(idle, loaded):
    """dslreports-style grade from the latency rise under load (ms)."""
    rise = max(0.0, (loaded or 0) - (idle or 0))
    g = "A+" if rise < 5 else "A" if rise < 30 else "B" if rise < 60 else "C" if rise < 200 else "D" if rise < 400 else "F"
    return g, rise


def _run_speedtest_once(iface=None):
    """Official Ookla CLI, JSON mode. Returns (result_dict_or_None, raw_text)."""
    argv = ["speedtest", "--accept-license", "--accept-gdpr", "--format=json"]
    if iface:
        argv += ["-I", iface]
    raw = run(argv, timeout=150)
    try:
        j = json.loads(raw[raw.index("{"):])
    except Exception:
        return None, raw
    return _speedtest_result(j), raw


def _speedtest_result(j):
    """Ookla result JSON (the final `result` object) -> our result dict, incl. the bufferbloat grade."""
    dl = j.get("download", {}); ul = j.get("upload", {}); ping = j.get("ping", {})
    r = {
        "ts": int(time.time()),
        "server": f"{j.get('server', {}).get('name', '?')} — {j.get('server', {}).get('location', '?')}",
        "isp": j.get("isp", ""),
        "ping": round(ping.get("latency", 0), 1), "jitter": round(ping.get("jitter", 0), 1),
        "down": round(dl.get("bandwidth", 0) * 8 / 1e6, 1), "up": round(ul.get("bandwidth", 0) * 8 / 1e6, 1),
        "down_lat": round((dl.get("latency") or {}).get("iqm", 0), 1), "up_lat": round((ul.get("latency") or {}).get("iqm", 0), 1),
        "loss": j.get("packetLoss"), "url": (j.get("result") or {}).get("url", ""),
    }
    gd, rd = bufferbloat_grade(r["ping"], r["down_lat"]); gu, ru = bufferbloat_grade(r["ping"], r["up_lat"])
    r["grade"] = max(gd, gu, key=lambda g: ["A+", "A", "B", "C", "D", "F"].index(g))
    r["grade_down"], r["grade_up"], r["rise_down"], r["rise_up"] = gd, gu, round(rd), round(ru)
    return r


def wifi_link_note():
    """Wi-Fi radio link rate, signal and USB bus speed, so a slow speed test can be told apart from a slow adapter."""
    try:
        link = run(["iw", "dev", WLAN, "link"])
        def g(pat):
            m = re.search(pat, link)
            return m.group(1) if m else ""
        rx, tx, sig = g(r"rx bitrate:\s*([\d.]+)"), g(r"tx bitrate:\s*([\d.]+)"), g(r"signal:\s*(-?\d+)")
        if not (rx or tx):
            return ""
        usb = usb_link()
        note = f"\nWi-Fi link ({WLAN}): rx {rx or '?'} / tx {tx or '?'} Mbps, signal {sig or '?'} dBm"
        if usb:
            note += f"\nUSB bus speed: {usb['mbps']} Mbps ({usb['gen']})" + (f"  ⚠ {usb['hint']}" if usb["status"] == "warn" else "")
        return note + "\n"
    except Exception:
        return ""


def _dns_ready(host="www.speedtest.net", wait=12):
    """Right after a band switch / reconnect the resolver is briefly unreachable (speedtest: 'Try again')."""
    end = time.time() + wait
    while time.time() < end:
        try:
            socket.getaddrinfo(host, 443)
            return True
        except OSError:
            time.sleep(1)
    return False


def run_speedtest(iface=None, attempts=3):
    """Speed test with retries: a fresh WiFi (re)connect often fails the first run with
    'Latency test failed' / 'Cannot open socket', or returns an all-zero result."""
    r, raw = None, ""
    for i in range(attempts):
        _dns_ready()
        r, raw = _run_speedtest_once(iface)
        if r and r["down"] > 0 and r["up"] > 0:
            return r, raw
        time.sleep(3)
    return None, (raw or "speed test failed") + f"\n(failed after {attempts} attempts - check the WiFi link, then retry)"


def format_speedtest(r):
    loss = "n/a" if r["loss"] is None else f"{r['loss']}%"
    return (f"Server:   {r['server']}\nISP:      {r['isp']}\n"
            f"Ping:     {r['ping']} ms (jitter {r['jitter']} ms)\n\n"
            f"DOWNLOAD: {r['down']} Mbps   (latency under load {r['down_lat']} ms, +{r['rise_down']} ms)\n"
            f"UPLOAD:   {r['up']} Mbps   (latency under load {r['up_lat']} ms, +{r['rise_up']} ms)\n"
            f"Packet loss: {loss}\n\n"
            f"BUFFERBLOAT GRADE: {r['grade']}   (down {r['grade_down']}, up {r['grade_up']})\n"
            f"  A+/A = router handles load cleanly · B = fine · C/D = calls/POS lag when busy · F = badly buffered\n"
            f"{wifi_link_note()}"
            f"\nResult: {r['url']}")


@app.post("/api/speedtest")
@require_login
def speedtest():
    r, raw = run_speedtest()
    if not r:
        log_history("Speed Test", None, raw)
        return jsonify({"output": raw or "speed test failed"})
    try:
        db_insert_speed(r, "manual")
    except Exception:
        pass
    out = format_speedtest(r)
    log_history("Speed Test", None, out)
    return jsonify({"output": out, "result": r})


_speedtest_lock = threading.Lock()


@app.post("/api/speedtest/stream")
@require_login
def speedtest_stream():
    """Live speed test for the speedometer: the Ookla CLI in jsonl mode prints ping / download / upload progress ~10x a second
    (bandwidth in bytes/s, running average); every event is forwarded as one SSE `data:` JSON object. The final `result` is turned
    into our usual result (bufferbloat grade etc.), saved to the history DB like a manual test, and sent as `{"type":"summary",...}`.
    One test at a time. A failed first run (common right after a WiFi reconnect) is retried once. Stopping = disconnecting."""
    if not _speedtest_lock.acquire(blocking=False):
        return jsonify({"error": "a speed test is already running"}), 429
    if not _live_slots.acquire(blocking=False):
        _speedtest_lock.release()
        return jsonify({"error": "too many live tools are already running"}), 429

    def gen():
        proc, timer, done_ok = None, None, False
        try:
            yield _sse({"attempts": 2}, "start")
            for attempt in (1, 2):
                if attempt == 2:
                    yield _sse({"type": "retry"})
                    time.sleep(3)
                if not _dns_ready(wait=8):
                    yield _sse({"type": "log", "level": "error", "message": "no DNS yet - is the WiFi connected?"})
                    continue
                proc = subprocess.Popen(["speedtest", "--accept-license", "--accept-gdpr", "--format=jsonl", "--progress-update-interval=100"],
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
                timer = threading.Timer(150, proc.terminate)
                timer.daemon = True
                timer.start()
                final = None
                for line in _read_lines(proc):
                    if line is None:
                        yield ": keepalive\n\n"
                        continue
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        ev = {"type": "log", "level": "info", "message": line.strip()}
                    if ev.get("type") == "result":
                        final = ev
                    yield _sse(ev)
                timer.cancel()
                proc.wait()
                r = _speedtest_result(final) if final else None
                if r and r["down"] > 0 and r["up"] > 0:
                    try:
                        db_insert_speed(r, "manual")
                    except Exception:
                        pass
                    out = format_speedtest(r)
                    log_history("Speed Test (live)", None, out)
                    yield _sse(dict(r, type="summary", note=wifi_link_note().strip()))
                    done_ok = True
                    break
            if not done_ok:
                yield _sse({"type": "failed"})
            yield _sse({"code": 0 if done_ok else 1}, "done")
        finally:
            if timer:
                timer.cancel()
            if proc:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                try:
                    proc.stdout.close()
                    proc.wait(timeout=3)
                except Exception:
                    pass
            _live_slots.release()
            _speedtest_lock.release()

    return Response(gen(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


# ---- site diagnostics ----------------------------------------------------

AP_NAMES_PATH = "/var/lib/jarvis-nettools/ap-names.json"


def load_ap_names():
    try:
        d = json.load(open(AP_NAMES_PATH))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def ap_name(bssid):
    return load_ap_names().get(str(bssid).upper(), "")


@app.get("/api/apnames")
@require_login
def apnames_get():
    return jsonify({"names": load_ap_names()})


@app.post("/api/apnames")
@require_login
def apnames_set():
    """Names for access points (BSSID -> label), kept on the Pi so they survive cleared browser data."""
    data = request.get_json(silent=True) or {}
    names = load_ap_names()
    pairs = data.get("names") if isinstance(data.get("names"), dict) else {str(data.get("bssid", "")): data.get("name", "")}
    for b, n in pairs.items():
        b = str(b).strip().upper().replace("-", ":")
        if not VALID_MAC.match(b):
            return jsonify({"error": "invalid bssid"}), 400
        n = re.sub(r"[\x00-\x1f]", "", str(n)).strip()[:30]
        if n:
            names[b] = n
        else:
            names.pop(b, None)
    tmp = AP_NAMES_PATH + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(names, f, indent=1, ensure_ascii=False)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, AP_NAMES_PATH)
    except OSError as e:
        return jsonify({"error": f"could not save: {e}"}), 500
    return jsonify({"names": load_ap_names()})


@app.post("/api/aps")
@require_login
def aps():
    """Every access point (BSSID) broadcasting the SSID we're on, with the one
    we're connected to flagged — finds the weak AP in multi-AP sites."""
    link = run(["/usr/sbin/iw", "dev", WLAN, "link"], timeout=10)
    cur_ssid = (re.search(r"SSID:\s*(.+)", link) or [None, None])[1]
    cur_bssid = (re.search(r"Connected to\s+([0-9a-f:]{17})", link) or [None, None])[1]
    cur_bssid = cur_bssid.upper() if cur_bssid else None
    data = request.get_json(silent=True) or {}
    want = str(data.get("ssid") or cur_ssid or "")
    out = run(["sudo", "nmcli", "-t", "-f", "SSID,BSSID,SIGNAL,CHAN,FREQ",
               "dev", "wifi", "list", "ifname", WLAN, "--rescan", "yes" if data.get("rescan", True) else "no"], timeout=45)
    rows = []
    for line in out.splitlines():
        # nmcli escapes the colons inside the BSSID as "\:"
        m = re.match(r"^(.*?):((?:[0-9A-F]{2}\\:){5}[0-9A-F]{2}):(\d+):(\d+):(\d+) MHz$", line)
        if not m:
            continue
        ssid, bssid, sig, ch, freq = m.group(1), m.group(2).replace("\\:", ":"), int(m.group(3)), m.group(4), int(m.group(5))
        if want and ssid != want:
            continue
        rows.append({"ssid": ssid, "bssid": bssid, "signal": sig, "ch": ch, "band": band_of(freq),
                     "current": bssid == cur_bssid, "name": ap_name(bssid)})
    rows.sort(key=lambda r: -r["signal"])
    return jsonify({"ssid": want, "current_bssid": cur_bssid, "aps": rows})


@app.post("/api/dhcp")
@require_login
def dhcp_check():
    """Rogue-DHCP detector: broadcast a DHCPDISCOVER and list every server that answers."""
    iface = default_iface()
    out = run(["sudo", PRIV, "nmap", "--script", "broadcast-dhcp-discover", "-e", iface,
               "--script-args", "broadcast-dhcp-discover.timeout=8"], timeout=40)
    servers = re.findall(r"Server Identifier:\s*([\d.]+)", out)
    routers = re.findall(r"Router:\s*([\d.]+)", out)
    offered = re.findall(r"IP Offered:\s*([\d.]+)", out)
    dns = re.findall(r"Domain Name Server:\s*([\d., ]+)", out)
    uniq = sorted(set(servers))
    if not uniq:
        verdict = "No DHCP server answered on " + iface + " (static network, or the server is slow)."
    elif len(uniq) == 1:
        verdict = f"OK — exactly one DHCP server: {uniq[0]}"
    else:
        verdict = f"⚠ ROGUE DHCP SUSPECTED — {len(uniq)} different servers answered: {', '.join(uniq)}"
    text = verdict + "\n\n" + "\n".join(
        f"server {s}  router {routers[i] if i < len(routers) else '?'}  offered {offered[i] if i < len(offered) else '?'}  dns {dns[i].strip() if i < len(dns) else '?'}"
        for i, s in enumerate(servers)) + ("\n\n" + out.strip() if not servers else "")
    log_history("Rogue DHCP check", iface, text)
    return jsonify({"output": text, "servers": uniq, "rogue": len(uniq) > 1})


DEFAULT_SERVICES = [
    {"name": "Gateway", "type": "gw"},
    {"name": "Internet (1.1.1.1)", "type": "ping", "target": "1.1.1.1"},
    {"name": "Internet (8.8.8.8)", "type": "ping", "target": "8.8.8.8"},
    {"name": "DNS resolve (google.com)", "type": "dns", "target": "google.com"},
    {"name": "Google", "type": "https", "target": "https://www.google.com/generate_204"},
    {"name": "Cloudflare", "type": "https", "target": "https://www.cloudflare.com/cdn-cgi/trace"},
    {"name": "Square POS", "type": "https", "target": "https://squareup.com"},
    {"name": "Square API", "type": "https", "target": "https://connect.squareup.com"},
    {"name": "Toast POS", "type": "https", "target": "https://pos.toasttab.com"},
    {"name": "Clover POS", "type": "https", "target": "https://www.clover.com"},
    {"name": "Spotify", "type": "https", "target": "https://api.spotify.com"},
    {"name": "YoDeck signage", "type": "https", "target": "https://app.yodeck.com"},
    {"name": "Omada cloud", "type": "https", "target": "https://omada.tplinkcloud.com"},
]


def check_service(s):
    t, target = s.get("type"), s.get("target", "")
    t0 = time.time()
    try:
        if t == "gw":
            gw = default_gw()
            if not gw:
                return {**s, "ok": False, "detail": "no default gateway"}
            out = run(["ping", "-c", "1", "-W", "2", gw], timeout=5)
            ok = "1 received" in out
            ms = re.search(r"time=([\d.]+)", out)
            return {**s, "target": gw, "ok": ok, "detail": f"{ms.group(1)} ms" if ms else "no reply"}
        if t == "ping":
            out = run(["ping", "-c", "1", "-W", "2", target], timeout=5)
            ms = re.search(r"time=([\d.]+)", out)
            return {**s, "ok": "1 received" in out, "detail": f"{ms.group(1)} ms" if ms else "no reply"}
        if t == "dns":
            out = run(["dig", "+short", "+time=2", "+tries=1", target], timeout=6).strip()
            ok = bool(out) and ";" not in out
            return {**s, "ok": ok, "detail": (out.splitlines()[0] if ok else "no answer") + f" ({int((time.time()-t0)*1000)} ms)"}
        if t == "https" or t == "http":
            out = run(["curl", "-s", "-o", "/dev/null", "--max-time", "6", "-w", "%{http_code} %{time_total}", target], timeout=10).split()
            code = out[0] if out else "000"
            ok = code != "000"
            return {**s, "ok": ok, "detail": (f"HTTP {code} in {int(float(out[1])*1000)} ms" if ok and len(out) > 1 else "unreachable / timeout")}
        if t == "tcp":
            host, port = target.rsplit(":", 1)
            with socket.create_connection((host, int(port)), timeout=4):
                return {**s, "ok": True, "detail": f"port {port} open ({int((time.time()-t0)*1000)} ms)"}
    except Exception as e:  # noqa: BLE001
        return {**s, "ok": False, "detail": str(e)[:60] or "failed"}
    return {**s, "ok": False, "detail": "unknown check type"}


@app.post("/api/services")
@require_login
def services():
    try:
        extra = json.load(open(CONFIG_PATH)).get("service_checks") or []
    except Exception:
        extra = []
    checks = DEFAULT_SERVICES + [c for c in extra if isinstance(c, dict) and c.get("name")]
    with ThreadPoolExecutor(max_workers=8) as ex:
        fut = ex.submit(lan_services)
        results = list(ex.map(check_service, checks))
        lan = fut.result()
    bad = [r for r in results if not r["ok"]]
    head = "ALL GOOD — every service reachable." if not bad else f"⚠ {len(bad)} of {len(results)} checks FAILED: " + ", ".join(r["name"] for r in bad)
    text = head + "\n\n" + "\n".join(f"{'✅' if r['ok'] else '❌'} {r['name']:<26} {r['detail']}" for r in results)
    text += "\n\nOn this LAN (" + lan["subnet"] + "):\n" + "\n".join(
        f"{'🟢' if v else '⚪'} {k:<26} {', '.join(v) if v else 'none found'}" for k, v in lan["found"].items())
    log_history("Service / POS check", None, text)
    return jsonify({"output": text, "results": results, "failed": len(bad), "lan": lan})


LAN_PORTS = {"8043": "Omada controller", "9100": "Receipt / label printer", "631": "IPP printer"}


def lan_services():
    """Auto-discover site gear on the current LAN by port: Omada (8043), printers (9100/631)."""
    iface = default_iface()
    cidr = run(["/bin/sh", "-c", f"ip -o -f inet addr show {iface} | awk '{{print $4}}' | head -1"]).strip()
    found = {v: [] for v in LAN_PORTS.values()}
    if not re.match(r"^\d+\.\d+\.\d+\.\d+/\d+$", cidr):
        return {"subnet": cidr or "?", "found": found}
    out = run(["sudo", PRIV, "nmap", "-Pn", "-T4", "--open", "-p", ",".join(LAN_PORTS), "-oG", "-", cidr], timeout=60)
    names = {h["ip"]: h["name"] for h in _last_devices if h.get("name")}
    for line in out.splitlines():
        m = re.match(r"^Host:\s+(\S+).*Ports:\s+(.+)$", line)
        if not m:
            continue
        ip = m.group(1)
        for p in m.group(2).split(","):
            port, state = p.strip().split("/")[0], p.strip().split("/")[1]
            if state == "open" and port in LAN_PORTS:
                found[LAN_PORTS[port]].append(ip + (f" ({names[ip]})" if ip in names else ""))
    return {"subnet": cidr, "found": found}


@app.post("/api/jack")
@require_login
def jack_test():
    """Ethernet jack tester: link, DHCP, LLDP switch/port, VLAN tags, internet via eth0."""
    iface = "eth0"
    sysfs = lambda f: run(["cat", f"/sys/class/net/{iface}/{f}"]).strip()  # noqa: E731
    carrier = sysfs("carrier") == "1"
    lines = [f"Jack test on {iface}"]
    if not carrier:
        text = "\n".join(lines + ["", "❌ NO LINK — nothing on the other end. Dead jack, unpatched port, or the port is shut down."])
        log_history("Jack test", iface, text)
        return jsonify({"output": text, "link": False})
    speed, duplex = sysfs("speed"), sysfs("duplex")
    lines.append(f"✅ LINK UP — {speed} Mb/s {duplex} duplex" + ("  ⚠ (only 100 Mb/s: bad cable/pair or a 100M port)" if speed == "100" else "") + ("  ⚠ (10 Mb/s: damaged cable)" if speed == "10" else ""))
    # DHCP / addressing (NetworkManager has usually already configured eth0)
    dev = run(["nmcli", "-t", "-f", "IP4.ADDRESS,IP4.GATEWAY,IP4.DNS,DHCP4.OPTION", "device", "show", iface])
    addr = re.findall(r"IP4\.ADDRESS\[\d+\]:(\S+)", dev); gw = re.findall(r"IP4\.GATEWAY:(\S+)", dev)
    dnsl = re.findall(r"IP4\.DNS\[\d+\]:(\S+)", dev); srv = re.findall(r"dhcp_server_identifier = (\S+)", dev)
    dom = re.findall(r"domain_name = (\S+)", dev)
    if addr:
        lines.append(f"✅ DHCP OK — got {addr[0]}  gateway {gw[0] if gw else '?'}  dns {', '.join(dnsl) or '?'}"
                     + (f"  (server {srv[0]})" if srv else "") + (f"  domain {dom[0]}" if dom else ""))
    else:
        lines.append("❌ NO IP — link is up but DHCP gave nothing. Wrong VLAN, port isolated, or no DHCP on this segment.")
    # LLDP / CDP neighbor (lldpd listens continuously; ~30 s after link-up it knows)
    ll = run(["sudo", PRIV, "lldp", iface], timeout=10)
    sysname = re.search(r"SysName:\s*(.+)", ll); portid = re.search(r"PortID:\s*(.+)", ll); portd = re.search(r"PortDescr:\s*(.+)", ll)
    if sysname or portid:
        lines.append(f"🔌 SWITCH: {sysname.group(1).strip() if sysname else '?'}  PORT: {portid.group(1).strip() if portid else '?'}"
                     + (f"  ({portd.group(1).strip()})" if portd else ""))
    else:
        lines.append("ℹ no LLDP/CDP neighbor yet (switch may not send it, or wait ~30 s after plugging in and re-test)")
    # VLAN tags seen on the wire (a trunk port shows tagged frames)
    vl = run(["sudo", PRIV, "vlan-sniff", iface], timeout=12)
    tags = sorted(set(re.findall(r"vlan (\d+)", vl)), key=int)
    lines.append(f"🏷 VLAN tags seen: {', '.join(tags)}  (tagged traffic = trunk port)" if tags else "🏷 no tagged VLAN frames seen (access port — normal for a device jack)")
    # Internet through this jack specifically
    pg = run(["ping", "-I", iface, "-c", "2", "-W", "2", "1.1.1.1"], timeout=8)
    lines.append("✅ INTERNET via this jack: yes" if "received" in pg and " 0 received" not in pg else "❌ INTERNET via this jack: no")
    text = "\n".join(lines)
    log_history("Jack test", iface, text)
    return jsonify({"output": text, "link": True, "speed": speed, "ip": addr[0] if addr else None})


@app.get("/api/iperf/info")
@require_login
def iperf_info():
    ips = re.findall(r"inet (\d+\.\d+\.\d+\.\d+)", run(["ip", "-4", "-o", "addr"]))
    ips = [i for i in ips if not i.startswith("127.") and not i.startswith("10.42.")]
    active = run(["systemctl", "is-active", "iperf3"]).strip() == "active"
    return jsonify({"server": active, "ips": ips, "port": 5201})


@app.post("/api/iperf")
@require_login
def iperf_client():
    """LAN throughput: Pi -> host and host -> Pi against an iperf3 server at host."""
    t = target_from_request()
    if not t:
        return jsonify({"error": "invalid target"}), 400
    res = []
    for label, extra in (("Pi → " + t + " (upload from Pi)", []), (t + " → Pi (download to Pi)", ["-R"])):
        raw = run(["iperf3", "-c", t, "-t", "6", "-J"] + extra, timeout=30)
        try:
            j = json.loads(raw)
            if "error" in j:
                hint = ""
                if "refused" in j["error"].lower():
                    hint = f"\n   → {t} is reachable but nothing is listening on port 5201. Run `iperf3 -s` on that computer (allow port 5201 in its firewall) and test again. Access points, routers and printers can't be iperf3 targets."
                res.append(f"❌ {label}: {j['error']}{hint}")
                continue
            mbps = j["end"]["sum_received"]["bits_per_second"] / 1e6
            retr = j["end"].get("sum_sent", {}).get("retransmits")
            res.append(f"✅ {label}: {mbps:.0f} Mbps" + (f"  ({retr} retransmits)" if retr is not None else ""))
        except Exception:
            res.append(f"❌ {label}: {raw.strip()[:160] or 'no response — is iperf3 -s running on ' + t + '?'}")
    text = "\n".join(res)
    log_history("iperf3 LAN test", t, text)
    return jsonify({"output": text})


@app.post("/api/pubip")
@require_login
def pubip():
    # Re-read config each call so an added token takes effect without restart.
    try:
        token = json.load(open(CONFIG_PATH)).get("ipinfo_token", "")
    except Exception:
        token = ""
    if token:
        url = "https://api.ipinfo.io/lite/me?token=" + token
    else:
        url = "https://ipinfo.io/json"
    out = run(["curl", "-s", "--max-time", "10", url], timeout=15)
    return jsonify({"output": out or "Lookup failed (no internet?)"})


@app.post("/api/dnscheck")
@require_login
def dnscheck():
    resolvers = run(["/bin/sh", "-c", "grep -E '^nameserver' /etc/resolv.conf"])
    timing = run(["/bin/sh", "-c", "dig google.com | grep -E 'SERVER:|Query time:'"], timeout=20)
    out = "--- resolvers in use ---\n" + resolvers + "\n--- resolve google.com ---\n" + timing
    log_history("DNS Check", None, out)
    return jsonify({"output": out})


@app.post("/api/wol")
@require_login
def wol():
    data = request.get_json(silent=True) or {}
    mac = str(data.get("mac", "")).strip()
    if not VALID_MAC.match(mac):
        return jsonify({"error": "invalid mac"}), 400
    return text_tool("Wake-on-LAN", ["wakeonlan", mac], mac, timeout=10)


@app.post("/api/admin/find")
@require_login
def admin_find():
    cidr = run(["/bin/sh", "-c",
                f"ip -o -f inet addr show {WLAN} | awk '{{print $4}}' | head -1"]).strip()
    if not cidr:
        return jsonify({"error": f"no {WLAN} subnet"}), 400
    out = run(["sudo", PRIV, "nmap", "-Pn", "-T4", "--open", "-p",
               "80,443,8080,8443,8043,8088", "-oG", "-", cidr], timeout=120)
    hosts = []
    for line in out.splitlines():
        m = re.match(r"^Host:\s+(\S+).*Ports:\s+(.+)$", line)
        if not m:
            continue
        ps = [p.strip().split("/")[0] for p in m.group(2).split(",")]
        ps = [p for p in ps if p in {"80", "443", "8080", "8443", "8043", "8088"}]
        if ps:
            hosts.append({"ip": m.group(1), "ports": ps})
    log_history("Find Admin Pages", None, out)
    return jsonify({"hosts": hosts, "subnet": cidr})


@app.get("/api/history")
@require_login
def history():
    try:
        with open(HISTORY) as f:
            lines = f.readlines()[-500:]
        return jsonify({"output": "".join(lines) or "No history yet."})
    except FileNotFoundError:
        return jsonify({"output": "No history yet — run a tool first."})


MODEL_PATH = "/proc/device-tree/model"


def has_power_button():
    """Pi 5 / Pi 500 (and cases wired to their button, e.g. the Pironman 5) turn back on with a button press;
    older Pis need the power unplugged and plugged back in."""
    try:
        with open(MODEL_PATH) as f:
            model = f.read()
    except OSError:
        return False
    return bool(re.search(r"Raspberry Pi (5|500)\b", model))


@app.post("/api/shutdown")
@require_login
def shutdown():
    # Fire-and-forget clean poweroff (or restart); response returns before the Pi halts.
    # An empty body still means "shut down" (older cached app versions send {}).
    action = (request.get_json(silent=True) or {}).get("action", "shutdown")
    if action not in ("shutdown", "restart"):
        return jsonify({"error": "action must be shutdown or restart"}), 400
    restart = action == "restart"
    log_history("Restart" if restart else "Shutdown", None, "clean %s requested from the app" % action)
    keep_history_next_boot(restart)       # a restart keeps the history; the next power-on after a shut down starts empty
    subprocess.Popen(["sudo", "shutdown", "-r" if restart else "-h", "now"])
    return jsonify({"ok": True, "action": action, "power_button": has_power_button()})


# ---- history reset ---------------------------------------------------------
# Every power-on starts with an empty history so a site report covers this visit only: jarvis-history-reset.service
# empties it at boot unless the Pi was only restarted (the marker below), and Settings > Clear History does it by hand.
HISTORY_MARKER = "/var/lib/jarvis-nettools/keep-history-once"
HISTORY_SINCE = "/var/lib/jarvis-nettools/history-since.json"


def keep_history_next_boot(keep):
    try:
        if keep:
            with open(HISTORY_MARKER, "w") as f:
                f.write("restart\n")
        elif os.path.exists(HISTORY_MARKER):
            os.remove(HISTORY_MARKER)
    except OSError:
        pass                              # the boot service decides on its own then (reboot vs power-off)


def history_since():
    try:
        with open(HISTORY_SINCE) as f:
            d = json.load(f)
        return {"ts": int(d["ts"]), "reason": str(d.get("reason", ""))[:20]}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def clear_history(reason):
    """Same as `jarvis-history-reset --now`: speed tests, monitor samples, outages, the tool log, the last device scan."""
    global _last_devices
    with db() as c:
        for t in ("speed", "samples", "events"):
            c.execute(f"DELETE FROM {t}")
    c = sqlite3.connect(DB_PATH, timeout=10)
    try:
        c.execute("VACUUM")
    finally:
        c.close()
    with open(HISTORY, "w"):
        pass
    _last_devices = []
    tmp = HISTORY_SINCE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"ts": int(time.time()), "reason": reason}, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, HISTORY_SINCE)


@app.post("/api/history/clear")
@require_login
def history_clear():
    try:
        clear_history("manual")
    except (OSError, sqlite3.Error) as e:
        return jsonify({"error": "could not clear the history: %s" % e}), 500
    return jsonify({"ok": True, "history_since": history_since()})


# ---- setup hotspot (built-in radio) ----------------------------------------
# The root service jarvis-hotspot-auto does the switching (no sudo needed here): the app only writes the chosen mode
# to a file the service reads, and shows the state the service reports.
HOTSPOT_MODE_PATH = "/var/lib/jarvis-nettools/hotspot-mode"
HOTSPOT_STATE_PATH = "/run/jarvis-hotspot-auto/state.json"
HOTSPOT_MODES = ("auto", "on", "off")


def hotspot_status():
    try:
        with open(HOTSPOT_MODE_PATH) as f:
            mode = f.read(16).strip()
    except OSError:
        mode = ""
    try:
        with open(HOTSPOT_STATE_PATH) as f:
            st = json.load(f)
    except (OSError, ValueError):
        st = {}
    if not isinstance(st, dict):
        st = {}
    try:
        fresh = time.time() - float(st.get("ts", 0)) < 30       # the service rewrites it every 5 s
    except (TypeError, ValueError):
        fresh = False
    fb = st.get("fallback_in")
    return {"mode": mode if mode in HOTSPOT_MODES else "auto", "service": fresh,
            "ssid": str(st.get("profile") or "JarvisPi-Manage")[:40],
            "active": bool(st.get("active")) if fresh else None,
            "clients": int(st.get("clients") or 0) if fresh and str(st.get("clients", "0")).isdigit() else 0,
            "online": bool(st.get("online")) if fresh and st.get("online") is not None else None,
            "fallback_in": int(fb) if fresh and isinstance(fb, (int, float)) else None,
            "error": str(st.get("error") or "")[:300] if fresh else "", "note": str(st.get("note") or "")[:200] if fresh else ""}


@app.get("/api/hotspot")
@require_login
def hotspot_get():
    return jsonify(hotspot_status())


@app.post("/api/hotspot")
@require_login
def hotspot_set():
    data = request.get_json(silent=True)
    mode = data.get("mode") if isinstance(data, dict) else None
    if mode not in HOTSPOT_MODES:
        return jsonify({"error": "mode must be auto, on or off"}), 400
    try:
        tmp = HOTSPOT_MODE_PATH + ".tmp"
        with open(tmp, "w") as f:
            f.write(mode + "\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, HOTSPOT_MODE_PATH)
    except OSError as e:
        return jsonify({"error": "could not save the setting: %s" % e.strerror}), 500
    log_history("Setup hotspot", None, "mode set to " + mode)
    return jsonify({"ok": True, **hotspot_status()})


# ---- monitoring DB (shared with the jarvis-netmon daemon) ----------------

DB_PATH = "/var/lib/jarvis-nettools/netmon.db"


def db():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("""CREATE TABLE IF NOT EXISTS speed(ts INTEGER, source TEXT, server TEXT, isp TEXT, ping REAL, jitter REAL,
                 down REAL, up REAL, down_lat REAL, up_lat REAL, loss REAL, grade TEXT, url TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS samples(ts INTEGER PRIMARY KEY, iface TEXT, ssid TEXT, gw TEXT, gw_ok INTEGER,
                 gw_ms REAL, inet_ok INTEGER, inet_ms REAL, dns_ok INTEGER)""")
    c.execute("""CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts INTEGER, end_ts INTEGER,
                 kind TEXT, detail TEXT)""")
    return c


def db_insert_speed(r, source):
    with db() as c:
        c.execute("INSERT INTO speed VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (r["ts"], source, r["server"], r["isp"], r["ping"], r["jitter"], r["down"], r["up"],
                   r["down_lat"], r["up_lat"], r["loss"], r["grade"], r["url"]))


@app.get("/api/netmon/status")
@require_login
def netmon_status():
    hours = int(request.args.get("hours", 24))
    since = int(time.time()) - hours * 3600
    with db() as c:
        last = c.execute("SELECT * FROM samples ORDER BY ts DESC LIMIT 1").fetchone()
        tot, ok = c.execute("SELECT COUNT(*), COALESCE(SUM(inet_ok),0) FROM samples WHERE ts>=?", (since,)).fetchone()
        gwok = c.execute("SELECT COALESCE(SUM(gw_ok),0) FROM samples WHERE ts>=?", (since,)).fetchone()[0]
        avg = c.execute("SELECT AVG(inet_ms) FROM samples WHERE ts>=? AND inet_ok=1", (since,)).fetchone()[0]
        events = [dict(e) for e in c.execute("SELECT * FROM events WHERE start_ts>=? OR end_ts IS NULL ORDER BY start_ts DESC LIMIT 50", (since,))]
    running = run(["systemctl", "is-active", "jarvis-netmon"]).strip() == "active"
    stale = (not last) or (time.time() - last["ts"] > 60)
    return jsonify({
        "running": running and not stale,
        "last": dict(last) if last else None,
        "hours": hours, "samples": tot,
        "uptime_pct": round(100.0 * ok / tot, 2) if tot else None,
        "gateway_pct": round(100.0 * gwok / tot, 2) if tot else None,
        "avg_ms": round(avg, 1) if avg else None,
        "outages": events,
        "current_outage": next((e for e in events if e["end_ts"] is None), None),
    })


@app.get("/api/netmon/timeline")
@require_login
def netmon_timeline():
    hours = int(request.args.get("hours", 24))
    bucket = max(60, int(hours * 3600 / 144))        # ~144 points across the window
    since = int(time.time()) - hours * 3600
    with db() as c:
        rows = c.execute("""SELECT (ts/?)*? AS b, AVG(inet_ok)*100 AS pct, AVG(CASE WHEN inet_ok=1 THEN inet_ms END) AS ms,
                            AVG(gw_ok)*100 AS gwpct FROM samples WHERE ts>=? GROUP BY b ORDER BY b""", (bucket, bucket, since)).fetchall()
    return jsonify({"bucket": bucket, "points": [{"t": r["b"], "pct": round(r["pct"] or 0, 1), "ms": round(r["ms"], 1) if r["ms"] else None, "gw": round(r["gwpct"] or 0, 1)} for r in rows]})


@app.get("/api/netmon/speed")
@require_login
def netmon_speed():
    hours = int(request.args.get("hours", 168))
    since = int(time.time()) - hours * 3600
    with db() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM speed WHERE ts>=? ORDER BY ts", (since,))]
    return jsonify({"rows": rows})


@app.post("/api/netmon/config")
@require_login
def netmon_config():
    data = request.get_json(silent=True) or {}
    try:
        cfgd = json.load(open(CONFIG_PATH))
        if "speed_interval_min" in data:
            cfgd["speed_interval_min"] = max(0, min(1440, int(data["speed_interval_min"])))
        json.dump(cfgd, open(CONFIG_PATH, "w"))
        return jsonify({"ok": True, "speed_interval_min": cfgd.get("speed_interval_min", 60)})
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/api/netmon/config")
@require_login
def netmon_config_get():
    try:
        return jsonify({"speed_interval_min": json.load(open(CONFIG_PATH)).get("speed_interval_min", 60)})
    except Exception:
        return jsonify({"speed_interval_min": 60})


# ---- settings ----------------------------------------------------------------

APP_VERSION = "2.0.0"
VALID_MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")
SERVICE_TYPES = {"https", "http", "ping", "dns", "tcp"}


def load_cfg():
    try:
        return json.load(open(CONFIG_PATH))
    except Exception:
        return {}


def public_settings(c):
    return {"site_name": c.get("site_name", ""), "speed_interval_min": c.get("speed_interval_min", 60),
            "service_checks": c.get("service_checks", []), "saved_devices": c.get("saved_devices", []),
            "ipinfo_token_set": bool(c.get("ipinfo_token")), "version": APP_VERSION, "history_since": history_since(),
            "hostname": run(["hostname"]).strip(), "default_checks": [s["name"] for s in DEFAULT_SERVICES]}


@app.get("/api/settings")
@require_login
def settings_get():
    return jsonify(public_settings(load_cfg()))


@app.post("/api/settings")
@require_login
def settings_set():
    data = request.get_json(silent=True) or {}
    c = load_cfg()
    if "site_name" in data:
        c["site_name"] = re.sub(r"[^\w .&'()/-]", "", str(data["site_name"]))[:60]
    if "speed_interval_min" in data:
        try:
            c["speed_interval_min"] = max(0, min(1440, int(data["speed_interval_min"])))
        except (TypeError, ValueError):
            pass
    if "service_checks" in data and isinstance(data["service_checks"], list):
        clean = []
        for s in data["service_checks"][:40]:
            if not isinstance(s, dict):
                continue
            name = re.sub(r"[^\w .&'()/:-]", "", str(s.get("name", "")))[:40]
            typ = str(s.get("type", "https")).lower()
            target = str(s.get("target", "")).strip()[:200]
            if not name or typ not in SERVICE_TYPES:
                continue
            if typ in ("https", "http") and not re.match(r"^https?://[\w.-]+(:\d+)?(/[^\s]*)?$", target):
                continue
            if typ in ("ping", "dns") and not VALID_TARGET.match(target):
                continue
            if typ == "tcp" and not re.match(r"^[\w.-]+:\d{1,5}$", target):
                continue
            clean.append({"name": name, "type": typ, "target": target})
        c["service_checks"] = clean
    if "saved_devices" in data and isinstance(data["saved_devices"], list):
        clean = []
        for d in data["saved_devices"][:60]:
            if not isinstance(d, dict):
                continue
            name = re.sub(r"[^\w .&'()/-]", "", str(d.get("name", "")))[:40]
            mac = str(d.get("mac", "")).strip().upper().replace("-", ":")
            ip = str(d.get("ip", "")).strip()
            if not name or not VALID_MAC_RE.match(mac):
                continue
            if ip and not VALID_TARGET.match(ip):
                ip = ""
            clean.append({"name": name, "mac": mac, "ip": ip})
        c["saved_devices"] = clean
    save_cfg(c)
    return jsonify({"ok": True, **public_settings(c)})


@app.post("/api/password")
@require_login
def change_password():
    data = request.get_json(silent=True) or {}
    cur, new = str(data.get("current", "")), str(data.get("new", ""))
    c = load_cfg()
    if not verify_cfg_password(cur, c):
        return jsonify({"ok": False, "error": "Current password is wrong."}), 403
    if len(new) < 8:
        return jsonify({"ok": False, "error": "New password must be at least 8 characters."}), 400
    c.pop("password", None)
    c["password_hash"] = nt_auth.hash_password(new)
    save_cfg(c)
    cfg.pop("password", None)
    cfg["password_hash"] = c["password_hash"]      # the in-memory copy used by /api/login
    log_history("Settings", None, "app password changed")
    return jsonify({"ok": True})


@app.post("/api/wake")
@require_login
def wake_saved():
    """Wake a saved device by name (or a raw MAC) and, if it has an IP, report when it answers."""
    data = request.get_json(silent=True) or {}
    mac, ip, label = str(data.get("mac", "")).strip(), str(data.get("ip", "")).strip(), str(data.get("name", ""))[:40]
    if not VALID_MAC_RE.match(mac):
        return jsonify({"error": "invalid mac"}), 400
    out = run(["wakeonlan", mac], timeout=10).strip()
    text = f"Magic packet sent to {label or mac} ({mac}).\n{out}"
    if ip and VALID_TARGET.match(ip):
        for i in range(6):
            time.sleep(5)
            if "1 received" in run(["ping", "-c", "1", "-W", "2", ip], timeout=5):
                text += f"\n\n✅ {ip} is answering after ~{(i + 1) * 5}s — it's awake."
                break
        else:
            text += f"\n\n⏳ {ip} not answering yet after 30s. Full boot can take longer — ping it again in a minute. (Won't work from a full shutdown unless the BIOS allows it.)"
    log_history("Wake device", label or mac, text)
    return jsonify({"output": text})


# ---- site report -----------------------------------------------------------

def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def gather_report(site):
    link = run(["/usr/sbin/iw", "dev", WLAN, "link"], timeout=10)
    g = lambda rx, src=link: (re.search(rx, src) or [None, ""])[1].strip()  # noqa: E731
    freq = g(r"freq:\s*([\d.]+)")
    conn = {"ssid": g(r"SSID:\s*(.+)"), "bssid": g(r"Connected to\s+([0-9a-f:]{17})").upper(), "signal": g(r"signal:\s*(-?\d+)"),
            "band": band_of(float(freq)) if freq else "", "rx": g(r"rx bitrate:\s*([\d.]+ MBit/s)"), "tx": g(r"tx bitrate:\s*([\d.]+ MBit/s)")}
    dev = run(["nmcli", "-t", "-f", "IP4.ADDRESS,IP4.GATEWAY,IP4.DNS", "device", "show", default_iface()])
    conn["ip"] = ", ".join(re.findall(r"IP4\.ADDRESS\[\d+\]:(\S+)", dev)); conn["gw"] = g(r"IP4\.GATEWAY:(\S+)", dev)
    conn["dns"] = ", ".join(re.findall(r"IP4\.DNS\[\d+\]:(\S+)", dev)); conn["iface"] = default_iface()
    try:
        token = json.load(open(CONFIG_PATH)).get("ipinfo_token", "")
    except Exception:
        token = ""
    pub = run(["curl", "-s", "--max-time", "8", ("https://api.ipinfo.io/lite/me?token=" + token) if token else "https://ipinfo.io/json"], timeout=12)
    try:
        pj = json.loads(pub); conn["public_ip"] = pj.get("ip", ""); conn["isp"] = pj.get("as_name") or pj.get("org", "")
    except Exception:
        conn["public_ip"] = conn["isp"] = ""
    with db() as c:
        speed = c.execute("SELECT * FROM speed ORDER BY ts DESC LIMIT 1").fetchone()
        speed = dict(speed) if speed else None
        since = int(time.time()) - 86400
        tot, ok = c.execute("SELECT COUNT(*), COALESCE(SUM(inet_ok),0) FROM samples WHERE ts>=?", (since,)).fetchone()
        outages = [dict(e) for e in c.execute("SELECT * FROM events WHERE start_ts>=? OR end_ts IS NULL OR end_ts>=? ORDER BY start_ts DESC LIMIT 20", (since, since))]
    # samples are taken every 10 s while the monitor runs; the rest of the window is unmonitored
    # (Pi off, asleep or the service stopped), so say how much of the day the uptime figure covers.
    cover = min(100.0, round(100.0 * tot / (86400 / 10), 1))
    mon = {"uptime": round(100.0 * ok / tot, 2) if tot else None, "samples": tot, "outages": outages, "coverage": cover}
    apsd = aps().get_json()            # same request context: auth already passed
    checks = services().get_json()["results"]
    if checks and sum(1 for c in checks if not c["ok"]) > len(checks) / 2:
        # most/all failing at once = the link dropped mid-report (e.g. a band switch), not 15 separate faults
        time.sleep(4)
        checks = services().get_json()["results"]
    devs = _last_devices or scan_devices()
    chan = channel().get_json()
    return {"site": site, "host": run(["hostname"]).strip(), "when": time.strftime("%Y-%m-%d %H:%M %Z"), "conn": conn,
            "speed": speed, "mon": mon, "aps": apsd["aps"], "checks": checks, "devices": devs,
            "chan": {k: len(v) for k, v in chan.items()}}


def report_html(d):
    c, s, m = d["conn"], d["speed"], d["mon"]
    row = lambda k, v: f"<tr><th>{_esc(k)}</th><td>{_esc(v)}</td></tr>"  # noqa: E731
    h = [f"""<!doctype html><html><head><meta charset="utf-8"><title>Site Report — {_esc(d['site'])}</title>
<style>body{{font:14px -apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:24px;max-width:900px}}h1{{margin:0 0 4px}}h2{{border-bottom:2px solid #f97316;padding-bottom:4px;margin-top:28px}}
table{{border-collapse:collapse;width:100%;margin:8px 0}}th,td{{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}}th{{background:#f4f4f4;width:220px}}
.ok{{color:#15803d;font-weight:600}}.bad{{color:#b91c1c;font-weight:600}}.muted{{color:#666}}.grade{{font-size:28px;font-weight:800}}
@media print{{body{{margin:10mm}}}}</style></head><body>
<h1>Network Site Report — {_esc(d['site'])}</h1><div class="muted">Generated {_esc(d['when'])} by {_esc(d['host'])} (Jarvis Pi)</div>"""]
    h.append("<h2>Connection</h2><table>" + row("Network", f"{c['ssid']} ({c['band']} GHz, AP {c['bssid']})") + row("Signal / link", f"{c['signal']} dBm · rx {c['rx']} · tx {c['tx']}")
             + row("Address", f"{c['ip']} via {c['iface']} · gateway {c['gw']} · DNS {c['dns']}") + row("Public IP / ISP", f"{c['public_ip']} · {c['isp']}") + "</table>")
    if s:
        tested = time.strftime('%Y-%m-%d %H:%M', time.localtime(s['ts'])) + ' (' + s['source'] + ')'
        dl = f"{s['down']} Mbps (latency under load {s['down_lat']} ms)"
        ul = f"{s['up']} Mbps (latency under load {s['up_lat']} ms)"
        pj = f"{s['ping']} ms / {s['jitter']} ms"
        loss = 'n/a' if s['loss'] is None else str(s['loss']) + '%'
        h.append("<h2>Speed test</h2><table>" + row('Tested', tested) + row('Server / ISP', s['server'] + ' · ' + str(s['isp']))
                 + row('Download', dl) + row('Upload', ul) + row('Ping / jitter', pj) + row('Packet loss', loss)
                 + f"<tr><th>Bufferbloat grade</th><td><span class='grade'>{_esc(s['grade'])}</span> &nbsp;<span class='muted'>A+/A clean · B fine · C/D lag under load · F badly buffered</span></td></tr></table>")
    else:
        h.append("<h2>Speed test</h2><p class='muted'>No speed test recorded yet.</p>")
    h.append("<h2>Services reachability</h2><table>" + "".join(f"<tr><th>{_esc(r['name'])}</th><td class='{'ok' if r['ok'] else 'bad'}'>{'OK' if r['ok'] else 'FAILED'} <span class='muted'>— {_esc(r['detail'])}</span></td></tr>" for r in d["checks"]) + "</table>")
    h.append("<h2>Access points for this network</h2><table><tr><th>BSSID</th><td><b>Signal · band · channel</b></td></tr>" + "".join(
        f"<tr><th>{_esc((a['name'] + ' · ' if a.get('name') else '') + a['bssid'])}{' ◀ connected' if a['current'] else ''}</th><td>{a['signal']}% · {a['band']} GHz · ch {a['ch']}</td></tr>" for a in d["aps"]) + "</table>"
             + f"<p class='muted'>Channel occupancy seen: 2.4 GHz {d['chan'].get('band24', 0)} channels in use · 5 GHz {d['chan'].get('band5', 0)} · 6 GHz {d['chan'].get('band6', 0)}</p>")
    h.append(f"<h2>Devices on the LAN ({len(d['devices'])})</h2><table><tr><th>IP</th><td><b>Name · MAC · vendor</b></td></tr>" + "".join(
        f"<tr><th>{_esc(x['ip'])}</th><td>{_esc(x['name'] or '—')} · {_esc(x['mac'])} · {_esc(x['vendor'])}</td></tr>" for x in d["devices"]) + "</table>")
    h.append("<p class='muted'>Jarvis Pi — portable network toolbox. Print this page to PDF to share.</p></body></html>")
    return "".join(h)


def report_md(d):
    c, s, m = d["conn"], d["speed"], d["mon"]
    L = [f"# Site Report — {d['site']}", f"_{d['when']} · {d['host']}_", "", "## Connection",
         f"- Network: {c['ssid']} ({c['band']} GHz, AP {c['bssid']})", f"- Signal: {c['signal']} dBm · rx {c['rx']} · tx {c['tx']}",
         f"- Address: {c['ip']} via {c['iface']} · gw {c['gw']} · DNS {c['dns']}", f"- Public: {c['public_ip']} · {c['isp']}", ""]
    if s:
        L += ["## Speed test", f"- {time.strftime('%Y-%m-%d %H:%M', time.localtime(s['ts']))} · {s['server']}",
              f"- Download {s['down']} Mbps (loaded latency {s['down_lat']} ms) · Upload {s['up']} Mbps (loaded {s['up_lat']} ms)",
              f"- Ping {s['ping']} ms · jitter {s['jitter']} ms · loss {s['loss'] if s['loss'] is not None else 'n/a'}", f"- **Bufferbloat grade: {s['grade']}**", ""]
    L += ["", "## Services"] + [f"- {'OK ' if r['ok'] else 'FAIL'} {r['name']} — {r['detail']}" for r in d["checks"]]
    L += ["", "## Access points"] + [f"- {(a['name'] + ' · ') if a.get('name') else ''}{a['bssid']} {a['signal']}% {a['band']}G ch{a['ch']}{' ◀ connected' if a['current'] else ''}" for a in d["aps"]]
    L += ["", f"## Devices ({len(d['devices'])})"] + [f"- {x['ip']:<15} {x['name'] or '—':<24} {x['mac']}  {x['vendor']}" for x in d["devices"]]
    return "\n".join(L) + "\n"


@app.get("/api/agent/summary")
@require_login
def agent_summary():
    """One call for other agents: how the Pi is connected, which AP, signal, last speed test, APs in range."""
    link = run(["/usr/sbin/iw", "dev", WLAN, "link"], timeout=10)
    def gl(pat, cast=str):
        m = re.search(pat, link)
        try:
            return cast(m.group(1)) if m else None
        except ValueError:
            return None
    bssid = (gl(r"Connected to\s+([0-9a-fA-F:]{17})") or "").upper()
    freq = gl(r"freq:\s*(\d+)", int)
    ssid = gl(r"SSID:\s*(.+)")
    names = load_ap_names()
    usb = usb_link()
    try:
        with db() as c:
            row = c.execute("SELECT * FROM speed ORDER BY ts DESC LIMIT 1").fetchone()
            last = dict(row) if row else None
    except Exception:
        last = None
    return jsonify({
        "time": time.strftime("%Y-%m-%d %H:%M:%S %Z"), "host": run(["hostname"]).strip(),
        "net": net_info(),
        "wifi": {"connected": bool(ssid), "ssid": ssid, "bssid": bssid or None, "ap_name": names.get(bssid, "") if bssid else "",
                 "band_ghz": band_of(freq) if freq else None, "freq_mhz": freq, "signal_dbm": gl(r"signal:\s*(-?\d+)", int),
                 "rx_mbps": gl(r"rx bitrate:\s*([\d.]+)", float), "tx_mbps": gl(r"tx bitrate:\s*([\d.]+)", float),
                 "adapter_usb_mbps": usb["mbps"] if usb else None, "adapter_usb": usb},
        "last_speedtest": ({k: last[k] for k in ("ts", "source", "server", "ping", "jitter", "down", "up", "down_lat", "up_lat", "grade")} if last else None),
        "aps_in_range": ap_rows_api(ssid) if ssid else [],
        "monitor_running": run(["systemctl", "is-active", "jarvis-netmon"]).strip() == "active"})


def ap_rows_api(ssid):
    out = run(["sudo", "nmcli", "-t", "-f", "SSID,BSSID,SIGNAL,CHAN,FREQ", "dev", "wifi", "list", "ifname", WLAN, "--rescan", "no"], timeout=30)
    names, cur, rows = load_ap_names(), current_bssid(), []
    for line in out.splitlines():
        m = re.match(r"^(.*?):((?:[0-9A-F]{2}\\:){5}[0-9A-F]{2}):(\d+):(\d+):(\d+) MHz$", line)
        if m and m.group(1).replace("\\:", ":") == ssid:
            b = m.group(2).replace("\\:", ":")
            rows.append({"bssid": b, "name": names.get(b, ""), "signal_pct": int(m.group(3)), "channel": int(m.group(4)),
                         "band_ghz": band_of(int(m.group(5))), "connected": b == cur})
    return sorted(rows, key=lambda r: -r["signal_pct"])


AGENT_PIN_PATH = "/var/lib/jarvis-nettools/agent-pin.json"
_agent_pin_timer = None
_agent_pin_lock = threading.Lock()


def agent_pin_clear(rejoin=True):
    """Drop an agent-set AP/band pin and (optionally) go back to Auto. Safe to call from the timer thread."""
    global _agent_pin_timer
    with _agent_pin_lock:
        if _agent_pin_timer:
            _agent_pin_timer.cancel(); _agent_pin_timer = None
        try:
            st = json.load(open(AGENT_PIN_PATH))
        except Exception:
            st = None
        try:
            os.remove(AGENT_PIN_PATH)
        except OSError:
            pass
    if st and rejoin:
        ok, msg = do_join(st.get("ssid", ""), "", "auto", "")
        log_history("Agent pin expired -> Auto", st.get("ssid"), msg)


def agent_pin_arm(until):
    global _agent_pin_timer
    with _agent_pin_lock:
        if _agent_pin_timer:
            _agent_pin_timer.cancel()
        _agent_pin_timer = threading.Timer(max(1, until - time.time()), agent_pin_clear)
        _agent_pin_timer.daemon = True
        _agent_pin_timer.start()


def agent_pin_resume():
    """After a restart: finish an interrupted hold (re-arm it, or release it if it already ran out)."""
    try:
        st = json.load(open(AGENT_PIN_PATH))
    except Exception:
        return
    if st.get("until", 0) <= time.time():
        agent_pin_clear()
    else:
        agent_pin_arm(st["until"])


@app.post("/api/agent/ap")
@require_login
def agent_set_ap():
    """control-scope tokens only. Pin the Pi to one AP and/or band on the network it is already on.
    The pin is temporary (hold_minutes, default 15, max 60) and reverts to Auto by itself. No passwords, no new networks."""
    data = request.get_json(silent=True) or {}
    ssid = active_ssid()
    if not ssid:
        return jsonify({"error": "the Pi is not on WiFi right now"}), 409
    if data.get("ssid") and str(data["ssid"]) != ssid:
        return jsonify({"error": f"can only change the access point of the network the Pi is on ({ssid})"}), 400
    bssid = str(data.get("bssid", "")).strip().replace("-", ":")
    if bssid and not VALID_MAC.match(bssid):
        return jsonify({"error": "invalid bssid"}), 400
    band = str(data.get("band", "auto"))
    if band not in VALID_BANDS:
        return jsonify({"error": "band must be one of auto, 2.4, 5, 6"}), 400
    try:
        hold = max(1, min(60, int(data.get("hold_minutes", 15))))
    except (TypeError, ValueError):
        return jsonify({"error": "hold_minutes must be a number"}), 400
    ok, msg = do_join(ssid, "", band, bssid.upper())
    pinned = bool(bssid) or band != "auto"
    until = None
    if ok and pinned:
        until = int(time.time() + hold * 60)
        with open(AGENT_PIN_PATH, "w") as f:
            json.dump({"ssid": ssid, "bssid": bssid.upper(), "band": band, "until": until}, f)
        agent_pin_arm(until)
    elif ok:
        agent_pin_clear(rejoin=False)
    log_history("Agent AP change", ssid, f"bssid={bssid or '-'} band={band} hold={hold} -> {msg[:80]}")
    cur = current_bssid()
    return jsonify({"ok": ok, "message": msg[:200], "ssid": ssid,
                    "now_on": {"bssid": cur, "ap_name": load_ap_names().get(cur, ""), "band_ghz": current_band()},
                    "pinned": pinned and ok, "reverts_to_auto_at": time.strftime("%H:%M:%S", time.localtime(until)) if until else None})


@app.get("/api/report")
@require_login
def report():
    site = re.sub(r"[^\w .&'()/-]", "", request.args.get("site", "") or "")[:60] or load_cfg().get("site_name") or (active_ssid() or "site")
    d = gather_report(site)
    log_history("Site report", site, "generated")
    if request.args.get("format") == "md":
        return Response(report_md(d), mimetype="text/markdown; charset=utf-8")
    html = report_html(d)
    headers = {"Content-Disposition": f"{'attachment' if request.args.get('download') else 'inline'}; filename=site-report-{time.strftime('%Y%m%d-%H%M')}.html"}
    return Response(html, mimetype="text/html", headers=headers)


# ---- static PWA ----------------------------------------------------------

@app.before_request
def limit_body_size():
    """Enforce the request-size cap ourselves: Flask 2.x (Debian 12) ignores MAX_CONTENT_LENGTH for JSON bodies."""
    cl = request.content_length
    if cl is not None and cl > app.config["MAX_CONTENT_LENGTH"]:
        return jsonify({"error": "request too large"}), 413


@app.after_request
def secure_headers(resp):
    h = resp.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Referrer-Policy", "no-referrer")
    if request.path.startswith("/api/"):
        h.setdefault("Cache-Control", "no-store")
    return resp


# the app is one same-origin page: scripts only from itself, no inline script, nothing may frame it
CSP = ("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
       "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


def _static(path):
    r = send_from_directory(STATIC_DIR, path)
    if path.endswith(".html"):
        r.headers["Content-Security-Policy"] = CSP
    return r


@app.get("/")
def index():
    return _static("index.html")


@app.get("/<path:path>")
def static_files(path):
    return _static(path)


if __name__ == "__main__":
    # Serve on the VPN address (phone app) AND loopback (Cockpit page via cockpit.http).
    from werkzeug.serving import make_server
    threading.Thread(target=agent_pin_resume, daemon=True).start()
    port = int(os.environ.get("NETTOOLS_PORT", "8092"))
    bind = os.environ.get("NETTOOLS_BIND", "127.0.0.1")

    def serve_when_ready(host):
        # The VPN address only exists once Wi-Fi and the VPN are up (a minute or more after boot): the touch screen
        # uses loopback and must not wait for that, so the VPN listener keeps retrying in the background.
        logged = False
        while True:
            try:
                srv = make_server(host, port, app, threaded=True)
                break
            except OSError as e:
                if not logged:
                    print(f"{host}:{port} not available yet ({e.strerror}); retrying every 3 s", flush=True)
                    logged = True
                time.sleep(3)
        if logged:
            print(f"now also listening on {host}:{port}", flush=True)
        srv.serve_forever()

    if bind not in ("127.0.0.1", "0.0.0.0"):
        threading.Thread(target=serve_when_ready, args=(bind,), daemon=True).start()
    make_server(bind if bind == "0.0.0.0" else "127.0.0.1", port, app, threaded=True).serve_forever()
