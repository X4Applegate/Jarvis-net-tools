"""Unit tests for scripts/jarvis-hotspot-auto (the setup-hotspot fallback service) against a fake NetworkManager.

Plain Python, no Flask, never touches a real radio:
    python3 -m unittest -v dev/unit-tests/test_hotspot_auto.py        (from the repo root)
"""
import importlib.machinery
import importlib.util
import json
import os
import stat
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "..", "scripts", "jarvis-hotspot-auto")
loader = importlib.machinery.SourceFileLoader("jarvis_hotspot_auto", SCRIPT)
spec = importlib.util.spec_from_loader("jarvis_hotspot_auto", loader)
ha = importlib.util.module_from_spec(spec)
loader.exec_module(ha)


class FakeNM:
    """Just enough nmcli / iw / ip for the service. wlan1 = the client radio, wlan0 = the hotspot radio."""

    def __init__(self):
        self.online = True
        self.managed = True          # wlan0 managed by NetworkManager
        self.link = True             # wlan0 link up
        self.active = False          # the hotspot profile is active on wlan0
        self.other = ""              # some other connection active on wlan0 (a mis-named radio)
        self.stations = 0
        self.autoconnect = "yes"
        self.profile = True
        self.radio = True
        self.fail_up = False
        self.calls = []

    def __call__(self, argv, timeout=20):
        self.calls.append(list(argv))
        a = list(argv)
        if a == ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device"]:
            rows = [f"wlan1:wifi:{'connected' if self.online else 'disconnected'}", "eth0:ethernet:unavailable",
                    "wg1:wireguard:connected (externally)", "lo:loopback:connected (externally)", "p2p-dev-wlan1:wifi-p2p:disconnected"]
            if self.radio:
                rows.append("wlan0:wifi:" + ("unmanaged" if not self.managed else "connected" if (self.active or self.other) else "disconnected"))
            return 0, "\n".join(rows) + "\n"
        if a == ["nmcli", "-t", "-f", "NAME,DEVICE", "connection", "show", "--active"]:
            rows = ["Cafe\\:Guest:wlan1" if self.online else "", "wg1:wg1", "lo:lo"]
            if self.active:
                rows.append("JarvisPi-Manage:wlan0")
            if self.other:
                rows.append(self.other + ":wlan0")
            return 0, "\n".join(r for r in rows if r) + "\n"
        if a == ["nmcli", "-t", "-f", "connection.id", "connection", "show", "JarvisPi-Manage"]:
            return (0, "connection.id:JarvisPi-Manage\n") if self.profile else (10, "")
        if a == ["nmcli", "-t", "-f", "connection.autoconnect", "connection", "show", "JarvisPi-Manage"]:
            return 0, f"connection.autoconnect:{self.autoconnect}\n"
        if a == ["nmcli", "connection", "modify", "JarvisPi-Manage", "connection.autoconnect", "no"]:
            self.autoconnect = "no"
            return 0, ""
        if a[:4] == ["nmcli", "device", "set", "wlan0"]:
            self.managed = a[5] == "yes"
            if not self.managed:                     # NetworkManager lets go of the radio: its connections end
                self.active, self.other = False, ""
            return 0, ""
        if a == ["nmcli", "connection", "up", "JarvisPi-Manage", "ifname", "wlan0"]:
            if self.fail_up or not self.managed:
                return 4, "Error: Connection activation failed: no country set"
            self.active, self.link = True, True
            return 0, "Connection successfully activated"
        if a == ["nmcli", "connection", "down", "JarvisPi-Manage"]:
            was, self.active = self.active, False
            return (0, "deactivated") if was else (10, "Error: not an active connection")
        if a == ["iw", "dev", "wlan0", "station", "dump"]:
            return 0, "".join(f"Station 02:00:00:00:00:0{i} (on wlan0)\n\tsignal: -40 dBm\n" for i in range(self.stations))
        if a == ["ip", "link", "set", "wlan0", "down"]:
            self.link = False
            return 0, ""
        raise AssertionError("unexpected command: %r" % (a,))

    def did(self, *argv):
        return list(argv) in self.calls


class Clock:
    t = 1000.0

    def __call__(self):
        return self.t


class Decide(unittest.TestCase):
    def test_table(self):
        d = ha.decide
        self.assertEqual(d("on", False, True, 999, 0, 0, False), "up")
        self.assertIsNone(d("on", True, True, 999, 999, 0, False))
        self.assertEqual(d("off", True, False, 999, 5, 3, True), "down")        # off means off, phones or not
        self.assertIsNone(d("off", False, False, 999, 0, 0, False))
        self.assertIsNone(d("auto", False, False, 119, 0, 0, False))             # offline, not long enough yet
        self.assertEqual(d("auto", False, False, 120, 0, 0, False), "up")
        self.assertIsNone(d("auto", False, True, 9999, 0, 0, False))             # online: stays off
        self.assertIsNone(d("auto", True, True, 29, 999, 0, True))               # online only 29 s
        self.assertIsNone(d("auto", True, True, 999, 999, 1, True))              # a phone is connected
        self.assertIsNone(d("auto", True, True, 999, 60, 0, True))               # fallback hotspot up < MIN_UP
        self.assertEqual(d("auto", True, True, 999, 120, 0, True), "down")
        self.assertEqual(d("auto", True, True, 30, 1, 0, False), "down")         # switched on -> auto: MIN_UP n/a
        self.assertIsNone(d("auto", True, False, 999, 999, 0, True))             # still offline: keep it up


class ReadMode(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="nt-hs-")
        self.p = os.path.join(self.d, "hotspot-mode")

    def write(self, text):
        with open(self.p, "w") as f:
            f.write(text)

    def test_values(self):
        self.assertEqual(ha.read_mode(self.p), "auto")                       # missing
        for text, want in (("on\n", "on"), ("off", "off"), ("auto\n", "auto"), ("ON", "auto"), ("", "auto"),
                           ("on; rm -rf /", "auto"), ("\x00\xff", "auto"), ("onn", "auto")):
            self.write(text)
            self.assertEqual(ha.read_mode(self.p), want, repr(text))

    def test_not_a_regular_file(self):
        real = os.path.join(self.d, "real")
        with open(real, "w") as f:
            f.write("on")
        os.symlink(real, self.p)                     # the folder belongs to the app user: never follow links
        self.assertEqual(ha.read_mode(self.p), "auto")
        os.remove(self.p)
        os.mkfifo(self.p)                            # and never block on a FIFO
        self.assertEqual(ha.read_mode(self.p), "auto")
        os.remove(self.p)
        os.mkdir(self.p)
        self.assertEqual(ha.read_mode(self.p), "auto")


class Service(unittest.TestCase):
    def setUp(self):
        self.nm, self.clk = FakeNM(), Clock()
        self.d = tempfile.mkdtemp(prefix="nt-hs-")
        self.mode = os.path.join(self.d, "hotspot-mode")
        self.h = ha.Hotspot(cmd=self.nm, clock=self.clk, wall=lambda: 1.7e9, mode_path=self.mode, state_dir=os.path.join(self.d, "run"))
        self.h.link_up = lambda: self.nm.link

    def set_mode(self, m):
        with open(self.mode, "w") as f:
            f.write(m + "\n")

    def run_for(self, seconds):
        st = None
        for _ in range(int(seconds // ha.TICK)):
            self.clk.t += ha.TICK
            st = self.h.tick()
        return st

    def state_file(self):
        p = os.path.join(self.d, "run", "state.json")
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o644)
        with open(p) as f:
            return json.load(f)

    def test_startup_turns_profile_autoconnect_off(self):
        self.h.startup()
        self.assertEqual(self.nm.autoconnect, "no")
        self.nm.calls.clear()
        self.h.startup()
        self.assertFalse(any(c[:3] == ["nmcli", "connection", "modify"] for c in self.nm.calls))

    def test_online_radio_is_released_and_link_down(self):
        st = self.h.tick()
        self.assertFalse(st["active"])
        self.assertFalse(self.nm.managed)
        self.assertFalse(self.nm.link)
        self.assertTrue(st["online"])
        self.assertIsNone(st["fallback_in"])
        self.nm.calls.clear()
        self.h.tick()                                # idempotent: nothing more to do
        self.assertFalse(any(c[:3] in (["nmcli", "device", "set"], ["ip", "link", "set"]) for c in self.nm.calls))

    def test_old_autoconnected_hotspot_goes_off_when_online(self):
        self.nm.active = True                        # the profile used to autoconnect at boot
        st = self.h.tick()
        self.assertTrue(st["active"])
        st = self.run_for(30)
        self.assertFalse(st["active"])
        self.assertTrue(self.nm.did("nmcli", "connection", "down", "JarvisPi-Manage"))
        self.assertFalse(self.nm.managed)
        self.assertIn("back online", st["note"])

    def test_fallback_after_two_minutes_offline_then_off_again(self):
        self.h.tick()
        self.nm.online = False
        st = self.run_for(60)                        # the first check (+5 s) notices the network is gone
        self.assertFalse(st["active"])
        self.assertEqual(st["fallback_in"], 65)
        self.assertFalse(self.nm.managed)            # stays released while waiting
        st = self.run_for(60)
        self.assertFalse(st["active"])               # 115 s without a network
        st = self.run_for(5)
        self.assertTrue(st["active"])
        self.assertTrue(self.nm.did("nmcli", "device", "set", "wlan0", "managed", "yes"))
        self.assertIn("no network", st["note"])
        self.assertIsNone(st["fallback_in"])
        # a phone joins, the Pi gets a network again: stays up while the phone is connected
        self.nm.stations = 1
        self.nm.online = True
        st = self.run_for(300)
        self.assertTrue(st["active"])
        self.assertEqual(st["clients"], 1)
        self.nm.stations = 0
        st = self.run_for(5)
        self.assertFalse(st["active"])
        self.assertFalse(self.nm.managed)
        self.assertFalse(self.nm.link)

    def test_fallback_stays_up_at_least_min_up(self):
        self.h.tick()
        self.nm.online = False
        self.run_for(125)
        self.assertTrue(self.nm.active)
        self.nm.online = True                        # network back right away
        st = self.run_for(60)
        self.assertTrue(st["active"])                # online 60 s, but the fallback has been up < 2 min
        st = self.run_for(65)
        self.assertFalse(st["active"])

    def test_mode_on_and_off_win(self):
        self.h.tick()
        self.set_mode("on")
        st = self.h.tick()
        self.assertTrue(st["active"])                # immediately, even though the Pi is online
        st = self.run_for(600)
        self.assertTrue(st["active"])
        self.nm.stations = 2
        self.set_mode("off")
        st = self.h.tick()
        self.assertFalse(st["active"])               # off means off, even with phones connected
        self.assertFalse(self.nm.managed)
        self.nm.online = False
        st = self.run_for(600)
        self.assertFalse(st["active"])               # no fallback in "off"
        self.assertIsNone(st["fallback_in"])

    def test_on_then_auto_goes_off_without_waiting_min_up(self):
        self.run_for(60)                             # online for a while
        self.set_mode("on")
        self.h.tick()
        self.set_mode("auto")
        st = self.h.tick()
        self.assertFalse(st["active"])

    def test_failed_start_is_reported_released_and_retried_later(self):
        self.nm.fail_up = True
        self.set_mode("on")
        st = self.h.tick()
        self.assertFalse(st["active"])
        self.assertIn("no country set", st["error"])
        self.assertFalse(self.nm.managed)            # released again, not left managed
        ups = lambda: sum(c[:3] == ["nmcli", "connection", "up"] for c in self.nm.calls)
        n = ups()
        self.run_for(55)
        self.assertEqual(ups(), n)                   # no retry storm
        self.nm.fail_up = False
        st = self.run_for(10)
        self.assertTrue(st["active"])
        self.assertEqual(st["error"], "")

    def test_the_pis_only_network_is_never_touched(self):
        self.nm.online = False                       # wlan1 has nothing ...
        self.nm.other = "preconfigured"              # ... and wlan0 is a client (e.g. radios named the wrong way round)
        self.set_mode("off")
        st = self.run_for(600)
        self.assertIn("only network ('preconfigured') - left alone", st["note"])
        self.assertTrue(self.nm.managed)
        self.assertEqual(self.nm.other, "preconfigured")
        self.assertFalse(any(c[:3] in (["nmcli", "device", "set"], ["ip", "link", "set"]) or c[:2] == ["nmcli", "connection"] and c[2] in ("up", "down")
                             for c in self.nm.calls))

    def test_a_second_client_on_the_hotspot_radio_is_released(self):
        self.nm.other = "Home WiFi"                  # NetworkManager autoconnected a saved Wi-Fi on wlan0 at boot
        st = self.h.tick()                           # wlan1 is online, so wlan0 is not needed as a client
        self.assertFalse(self.nm.managed)
        self.assertEqual(self.nm.other, "")
        self.assertFalse(self.nm.link)
        self.assertIn("released 'Home WiFi' from wlan0", st["note"])
        self.assertFalse(st["active"])

    def test_no_radio_or_no_profile(self):
        self.nm.radio = False
        self.assertIn("no wlan0 radio", self.h.tick()["note"])
        self.nm.radio, self.nm.profile = True, False
        self.assertIn("no JarvisPi-Manage profile", self.h.tick()["note"])
        self.assertTrue(self.nm.managed)

    def test_state_file(self):
        self.nm.online = False
        self.run_for(10)
        st = self.state_file()
        self.assertEqual(st["mode"], "auto")
        self.assertIs(st["online"], False)
        self.assertEqual(st["fallback_in"], 115)
        self.assertEqual(st["profile"], "JarvisPi-Manage")
        self.assertEqual(st["ts"], 1700000000)


if __name__ == "__main__":
    unittest.main()
