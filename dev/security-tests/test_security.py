"""Security regression tests for the Jarvis Net Tools backend.

Needs Flask (apt: python3-flask). Uses a throw-away config in a temp folder - never touches a real install.
    python3 -m unittest -v dev/security-tests/test_security.py        (from the repo root)
"""
import importlib.machinery
import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
import unittest
import warnings

warnings.simplefilter("ignore", ResourceWarning)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
APP_DIR = os.environ.get("NT_APP_DIR") or os.path.join(ROOT, "app")
PW = "correct horse battery"


def load_app(extra=None):
    d = tempfile.mkdtemp(prefix="nt-test-")
    path = os.path.join(d, "config.json")
    cfg = {"password": PW, "secret_key": "k" * 64, "site_name": "Test site", "service_checks": [{"name": "x", "type": "ping", "target": "1.1.1.1"}]}
    cfg.update(extra or {})
    json.dump(cfg, open(path, "w"))
    os.chmod(path, 0o644)
    os.environ["NETTOOLS_CONFIG"] = path
    if APP_DIR not in sys.path:
        sys.path.insert(0, APP_DIR)
    for m in ("nt_auth", "nt_app"):
        sys.modules.pop(m, None)
    spec = importlib.util.spec_from_file_location("nt_app", os.path.join(APP_DIR, "app.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, path


def remote(addr):
    return {"REMOTE_ADDR": addr}


class Fake:
    t = 1000.0

    def __call__(self):
        return self.t


class Auth(unittest.TestCase):
    def test_plaintext_password_is_migrated_to_a_hash(self):
        mod, path = load_app()
        disk = json.load(open(path))
        self.assertNotIn("password", disk)
        self.assertTrue(disk["password_hash"].startswith("scrypt$"))
        self.assertEqual(disk["secret_key"], "k" * 64)
        self.assertEqual(disk["site_name"], "Test site")                      # nothing else lost
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertNotIn(PW, open(path).read())

    def test_login_works_and_cookie_is_locked_down(self):
        mod, _ = load_app()
        c = mod.app.test_client()
        r = c.post("/api/login", json={"password": PW}, environ_base=remote("198.51.100.9"))
        self.assertEqual(r.status_code, 200)
        cookie = r.headers.get("Set-Cookie", "")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        self.assertTrue(c.get("/api/me", environ_base=remote("198.51.100.9")).get_json()["auth"])

    def test_me_trusts_loopback_only(self):
        # the Pi's own touch-screen kiosk talks to 127.0.0.1 and needs no login; nobody else gets that
        mod, _ = load_app({"trusted_proxies": ["203.0.113.1"]})
        c = mod.app.test_client()
        self.assertTrue(c.get("/api/me", environ_base=remote("127.0.0.1")).get_json()["auth"])
        self.assertFalse(c.get("/api/me", environ_base=remote("198.51.100.9")).get_json()["auth"])
        # a request through the reverse proxy can't claim to be loopback via X-Forwarded-For
        r = c.get("/api/me", environ_base=remote("203.0.113.1"), headers={"X-Forwarded-For": "127.0.0.1"})
        self.assertFalse(r.get_json()["auth"])

    def test_wrong_password_is_refused_then_throttled(self):
        mod, _ = load_app()
        clock = Fake()
        mod.login_throttle = mod.nt_auth.LoginThrottle(clock=clock)
        c = mod.app.test_client()
        for _ in range(5):
            self.assertEqual(c.post("/api/login", json={"password": "nope"}, environ_base=remote("198.51.100.9")).status_code, 401)
        r = c.post("/api/login", json={"password": PW}, environ_base=remote("198.51.100.9"))     # even the right one is refused while locked
        self.assertEqual(r.status_code, 429)
        self.assertGreater(int(r.headers["Retry-After"]), 0)
        clock.t += 40                                                                         # lock-out (30 s) is over
        self.assertEqual(c.post("/api/login", json={"password": PW}, environ_base=remote("198.51.100.9")).status_code, 200)

    def test_lockout_grows_and_is_capped(self):
        t = Fake()
        th = load_app()[0].nt_auth.LoginThrottle(clock=t)
        for _ in range(5):
            th.fail("a")
        first = th.wait("a")
        th.fail("a")
        self.assertGreater(th.wait("a"), first)
        for _ in range(30):
            th.fail("a")
        self.assertLessEqual(th.wait("a"), 900)
        th.ok("a")
        self.assertEqual(th.wait("a"), 0)

    def test_forwarded_header_is_trusted_only_from_a_configured_proxy(self):
        mod, _ = load_app({"trusted_proxies": ["198.51.100.1"]})
        mod.login_throttle = mod.nt_auth.LoginThrottle(clock=Fake())
        c = mod.app.test_client()
        for _ in range(5):                                                                    # one real client fails 5x behind the proxy
            c.post("/api/login", json={"password": "x"}, environ_base=remote("198.51.100.1"), headers={"X-Forwarded-For": "1.1.1.1"})
        self.assertEqual(c.post("/api/login", json={"password": PW}, environ_base=remote("198.51.100.1"), headers={"X-Forwarded-For": "1.1.1.1"}).status_code, 429)
        self.assertEqual(c.post("/api/login", json={"password": PW}, environ_base=remote("198.51.100.1"), headers={"X-Forwarded-For": "203.0.113.22"}).status_code, 200)   # others unaffected
        for i in range(5):                                                                    # a direct attacker cannot dodge the lock by faking the header
            c.post("/api/login", json={"password": "x"}, environ_base=remote("198.51.100.99"), headers={"X-Forwarded-For": "5.5.5.%d" % i})
        self.assertEqual(c.post("/api/login", json={"password": PW}, environ_base=remote("198.51.100.99"), headers={"X-Forwarded-For": "203.0.113.66"}).status_code, 429)

    def test_password_change_stores_only_a_hash(self):
        mod, path = load_app()
        c = mod.app.test_client()
        kw = {"environ_base": remote("198.51.100.9")}
        c.post("/api/login", json={"password": PW}, **kw)
        self.assertEqual(c.post("/api/password", json={"current": "wrong", "new": "another long one"}, **kw).status_code, 403)
        self.assertEqual(c.post("/api/password", json={"current": PW, "new": "short"}, **kw).status_code, 400)
        self.assertEqual(c.post("/api/password", json={"current": PW, "new": "another long one"}, **kw).status_code, 200)
        disk = json.load(open(path))
        self.assertNotIn("password", disk)
        self.assertNotIn("another long one", open(path).read())
        fresh = mod.app.test_client()
        self.assertEqual(fresh.post("/api/login", json={"password": PW}, **kw).status_code, 401)
        self.assertEqual(fresh.post("/api/login", json={"password": "another long one"}, **kw).status_code, 200)

    def test_hub_trust_comes_from_the_config(self):
        mod, _ = load_app()
        c = mod.app.test_client()
        self.assertEqual(c.get("/api/settings", environ_base=remote("203.0.113.5")).status_code, 401)        # nothing hard-coded
        mod2, _ = load_app({"trusted_hub_ip": "203.0.113.5"})
        c2 = mod2.app.test_client()
        self.assertEqual(c2.get("/api/settings", environ_base=remote("203.0.113.5")).status_code, 200)
        self.assertEqual(c2.post("/api/shutdown", json={}, environ_base=remote("203.0.113.5")).status_code, 401)   # read-only trust only
        self.assertEqual(c2.get("/api/settings", environ_base=remote("203.0.113.6")).status_code, 401)

    def test_unauthenticated_callers_get_nothing(self):
        mod, _ = load_app()
        c = mod.app.test_client()
        for method, path in [("get", "/api/status"), ("post", "/api/ping/stream"), ("post", "/api/trace/stream"), ("post", "/api/portscan/stream"),
                             ("post", "/api/speedtest/stream"), ("post", "/api/wifi/join"), ("post", "/api/shutdown"), ("get", "/api/devices.csv"),
                             ("get", "/api/hotspot"), ("post", "/api/hotspot"), ("post", "/api/history/clear")]:
            r = getattr(c, method)(path, json={}, environ_base=remote("198.51.100.9")) if method == "post" else c.get(path, environ_base=remote("198.51.100.9"))
            self.assertEqual(r.status_code, 401, path)


class Hardening(unittest.TestCase):
    def test_headers(self):
        mod, _ = load_app()
        c = mod.app.test_client()
        r = c.get("/", environ_base=remote("198.51.100.9"))
        self.assertEqual(r.headers["X-Frame-Options"], "DENY")
        self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("frame-ancestors 'none'", r.headers["Content-Security-Policy"])
        self.assertIn("script-src 'self'", r.headers["Content-Security-Policy"])
        a = c.get("/api/me", environ_base=remote("198.51.100.9"))
        self.assertEqual(a.headers["Cache-Control"], "no-store")
        self.assertNotIn("Content-Security-Policy", c.get("/app.js", environ_base=remote("198.51.100.9")).headers)

    def test_oversized_bodies_are_never_accepted(self):
        mod, _ = load_app()
        c = mod.app.test_client()
        big = json.dumps({"password": PW, "pad": "x" * 300000}).encode()      # correct password, but a body over the 256 KB cap
        r = c.post("/api/login", data=big, content_type="application/json", environ_base=remote("198.51.100.9"))
        self.assertEqual(r.status_code, 413)        # enforced by the app itself, so Flask 2.x (Debian 12) behaves like Flask 3
        self.assertFalse(c.get("/api/me", environ_base=remote("198.51.100.9")).get_json()["auth"])

    def test_builtin_checks_are_public_services_only(self):
        mod, _ = load_app()
        for s in mod.DEFAULT_SERVICES:
            target = s.get("target", "")
            self.assertTrue(s["type"] in ("gw", "ping", "dns") or target.startswith("https://"), s)

    def test_every_sudo_call_goes_through_the_helper(self):
        src = open(os.path.join(APP_DIR, "app.py")).read()
        allowed = {"PRIV", '"nmcli"', '"/usr/local/bin/wifi-clear"', '"shutdown"'}
        calls = re.findall(r'\["sudo",\s*([^,\]]+)', src)
        self.assertTrue(calls)
        for first in calls:
            self.assertIn(first.strip(), allowed, "raw sudo call: " + first)

    @unittest.skipUnless(os.path.exists(os.path.join(ROOT, "install", "install-pi.sh")), "installer is not part of this tree")
    def test_installer_sudoers_is_minimal(self):
        inst = open(os.path.join(ROOT, "install", "install-pi.sh")).read()
        line = re.search(r"nettools ALL=\(root\) NOPASSWD: (.+)", inst).group(1)
        for bad in ("nmap", "tcpdump", "timeout", "bin/ip", "ethtool", "arp-scan", "lldpcli", "/iw"):
            self.assertNotIn(bad, line)
        self.assertIn("/usr/local/bin/jarvis-priv", line)


class RootHelper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        loader = importlib.machinery.SourceFileLoader("jarvis_priv", os.path.join(ROOT, "scripts", "jarvis-priv"))
        spec = importlib.util.spec_from_loader("jarvis_priv", loader)
        cls.m = importlib.util.module_from_spec(spec)
        loader.exec_module(cls.m)

    def test_allowed_operations(self):
        for a in (["nmap", "-Pn", "-T4", "--open", "-p", "22,80", "-oG", "-", "198.51.100.5", "198.51.100.6"],
                  ["nmap", "-Pn", "-T4", "--top-ports", "100", "example.com"],
                  ["nmap", "--script", "broadcast-dhcp-discover", "-e", "eth0", "--script-args", "broadcast-dhcp-discover.timeout=8"],
                  ["nmap", "-Pn", "-T4", "--open", "-p", "80,443", "-oG", "-", "192.168.1.0/24"],
                  ["arp-scan", "wlan1"], ["ss"], ["lldp", "eth0"], ["vlan-sniff", "eth0"]):
            cmd, _ = self.m.build(a)
            self.assertTrue(cmd[0].startswith("/usr/"))

    def test_everything_else_is_refused(self):
        for a in (["nmap", "--script", "http-shellshock"], ["nmap", "--script=vuln", "1.2.3.4"], ["nmap", "-oN", "/etc/passwd", "1.1.1.1"],
                  ["nmap", "-iL", "/etc/shadow"], ["nmap", "--datadir", "/tmp"], ["nmap", "-p", "80;id", "1.1.1.1"], ["nmap", "-e", "../x", "1.1.1.1"],
                  ["nmap", "-oG", "/root/x", "1.1.1.1"], ["nmap", "-Pn", "--interactive"], ["nmap", "-Pn", "-1.1.1.1"], ["nmap"],
                  ["arp-scan", "-W", "/etc/x"], ["arp-scan", "eth0", "extra"], ["ss", "-K"], ["lldp", "eth0;id"], ["vlan-sniff", "Eth0"],
                  ["tcpdump", "-z", "sh"], ["timeout", "1", "sh"], [], ["nmap", "--script", "broadcast-dhcp-discover", "--script-args", "x=1"]):
            with self.assertRaises(self.m.Refused, msg=str(a)):
                self.m.build(a)


if __name__ == "__main__":
    unittest.main()
