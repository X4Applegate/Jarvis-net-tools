"""Unit tests for the visual tool pages' data: open ports, bandwidth counters, public IP, DNS check, rogue DHCP offers,
jack test checks and the history entries.

Needs Flask (apt: python3-flask). Temp files only; every command is faked.
    python3 -m unittest -v dev/unit-tests/test_tool_pages.py        (from the repo root)
"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "security-tests"))
from test_security import load_app, remote  # noqa: E402

KIOSK = remote("127.0.0.1")

SS = """Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess
udp   UNCONN 0      0            0.0.0.0:5353       0.0.0.0:*    users:(("avahi-daemon",pid=727,fd=12))
udp   UNCONN 0      0               [::]:5353          [::]:*    users:(("avahi-daemon",pid=727,fd=13))
udp   UNCONN 0      0            0.0.0.0:46169      0.0.0.0:*    users:(("speedtest",pid=1,fd=4))
udp   UNCONN 0      0      0.0.0.0%wlan0:67         0.0.0.0:*    users:(("dnsmasq",pid=5,fd=4))
tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=944,fd=6))
tcp   LISTEN 0      128             [::]:22            [::]:*    users:(("sshd",pid=944,fd=7))
tcp   LISTEN 0      128       203.0.113.15:8092     0.0.0.0:*    users:(("python3",pid=2,fd=4))
tcp   LISTEN 0      128        127.0.0.1:8092       0.0.0.0:*    users:(("python3",pid=2,fd=3))
tcp   LISTEN 0      4096           [::1]:631           [::]:*    users:(("cupsd",pid=3,fd=7))
tcp   ESTAB  0      0      192.0.2.5:22    192.0.2.9:5555        users:(("sshd",pid=9,fd=4))
"""

DHCP = """Starting Nmap 7.93
Pre-scan script results:
| broadcast-dhcp-discover:
|   Response 1 of 2:
|     Interface: wlan1
|     IP Offered: 192.168.88.150
|     DHCP Message Type: DHCPOFFER
|     Server Identifier: 192.168.88.1
|     IP Address Lease Time: 2h00m00s
|     Subnet Mask: 255.255.255.0
|     Router: 192.168.88.1
|     Domain Name Server: 192.168.88.1, 1.1.1.1
|     Domain Name: lan
|   Response 2 of 2:
|     Interface: wlan1
|     IP Offered: 192.168.0.23
|     Server Identifier: 192.168.0.1
|     Subnet Mask: 255.255.255.0
|_    Router: 192.168.0.1
"""

HIST = """
===== [2026-10-10 09:05:33] Rogue DHCP check -> wlan1 =====
OK

===== [2026-10-10 09:31:47] Ping (live) -> 1.1.1.1 =====
PING 1.1.1.1
10 packets transmitted

===== [2026-10-10 09:40:02] DNS Check =====
This network  192.168.88.1  avg 12 ms
"""


def dig_answer(status="NOERROR", ms=12, answer=True):
    return (";; ->>HEADER<<- opcode: QUERY, status: %s, id: 1\n" % status
            + ("x.com.\t60\tIN\tA\t192.0.2.1\n" if answer and status == "NOERROR" else "")
            + ";; Query time: %d msec\n" % ms)


class Pages(unittest.TestCase):
    def setUp(self):
        self.mod, self.cfg = load_app()
        self.tmp = tempfile.mkdtemp(prefix="nt-pages-")
        self.mod.HISTORY = os.path.join(self.tmp, "history.log")
        self.c = self.mod.app.test_client()
        self.runs = []
        self.fake = lambda argv: ""

        def fake_run(argv, timeout=45, cwd=None):
            self.runs.append(argv)
            return self.fake(argv)
        self.mod.run = fake_run

    def post(self, path, body=None):
        return self.c.post(path, json=body or {}, environ_base=KIOSK).get_json()

    # ---- open ports
    def test_parse_ss(self):
        rows = self.mod.parse_ss(SS)
        got = [(r["proto"], r["port"], r["scope"], r["process"]) for r in rows]
        self.assertEqual(got, [("tcp", 22, "all", "sshd"), ("udp", 67, "all", "dnsmasq"), ("udp", 5353, "all", "avahi-daemon"), ("udp", 46169, "all", "speedtest"),
                               ("tcp", 8092, "one", "python3"), ("tcp", 631, "local", "cupsd"), ("tcp", 8092, "local", "python3")])
        self.assertEqual([r["iface"] for r in rows if r["port"] == 67], ["wlan0"])
        self.assertEqual([r["addr"] for r in rows if r["scope"] == "one"], ["203.0.113.15"])

    def test_ports_endpoint(self):
        self.fake = lambda argv: SS
        d = self.post("/api/ports")
        self.assertEqual(self.runs[-1][-1], "ss")
        self.assertEqual(len(d["listeners"]), 7)
        self.assertIn("sshd", open(self.mod.HISTORY).read())

    # ---- bandwidth
    def test_net_counters(self):
        p = os.path.join(self.tmp, "dev")
        with open(p, "w") as f:
            f.write("Inter-|   Receive |  Transmit\n face |bytes packets|bytes\n"
                    "    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n"
                    " wlan1: 1348854331  969854    0    0    0     0          0         0 549195912  727272    0    0    0     0       0          0\n"
                    "  eth0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n")
        self.mod.PROC_NET_DEV = p
        self.mod.default_iface = lambda: "wlan1"
        d = self.c.get("/api/bandwidth/now", environ_base=KIOSK).get_json()
        self.assertEqual(d["ifaces"], {"wlan1": {"rx": 1348854331, "tx": 549195912}, "eth0": {"rx": 0, "tx": 0}})
        self.assertEqual(d["default"], "wlan1")
        self.mod.PROC_NET_DEV = os.path.join(self.tmp, "missing")
        self.assertEqual(self.mod.net_counters(), {})

    # ---- public IP
    def test_pubip_free_ipinfo_and_ipv6(self):
        def fake(argv):
            if "-6" in argv:
                return "2001:db8::45\n"
            return json.dumps({"ip": "203.0.113.45", "hostname": "h.example.net", "city": "Metro", "region": "State", "country": "US",
                               "org": "AS64500 Example ISP, Inc.", "timezone": "America/Los_Angeles"})
        self.fake = fake
        d = self.post("/api/pubip")
        self.assertEqual(d["info"]["isp"], "Example ISP, Inc.")
        self.assertEqual(d["info"]["asn"], "AS64500")
        self.assertEqual(d["info"]["country"], "US")
        self.assertEqual(d["ipv6"], "2001:db8::45")

    def test_pubip_lite_and_no_ipv6(self):
        def fake(argv):
            if "-6" in argv:
                return "curl: (7) Couldn't connect"
            return json.dumps({"ip": "203.0.113.45", "asn": "AS64500", "as_name": "Example ISP", "as_domain": "isp.example", "country_code": "US", "country": "United States"})
        self.fake = fake
        d = self.post("/api/pubip")
        self.assertEqual((d["info"]["isp"], d["info"]["asn"], d["info"]["country"], d["info"]["country_name"]), ("Example ISP", "AS64500", "US", "United States"))
        self.assertEqual(d["ipv6"], "")

    def test_pubip_offline(self):
        self.fake = lambda argv: ""
        d = self.post("/api/pubip")
        self.assertEqual(d["info"], {})
        self.assertIn("failed", d["output"])

    # ---- DNS check
    def test_dnscheck(self):
        rc = os.path.join(self.tmp, "resolv.conf")
        with open(rc, "w") as f:
            f.write("# generated\nnameserver 192.168.88.1\nnameserver 1.1.1.1\n")
        self.mod.RESOLV_CONF = rc

        def fake(argv):
            if argv[-2].startswith("jarvis-nx-"):
                return dig_answer("NXDOMAIN")
            return dig_answer(ms=40 if "@192.168.88.1" in argv else 10)
        self.fake = fake
        d = self.post("/api/dnscheck")
        self.assertEqual([(r["label"], r["server"], r["mine"]) for r in d["rows"]],
                         [("This network", "192.168.88.1", True), ("This network", "1.1.1.1", True), ("Google", "8.8.8.8", False), ("Quad9", "9.9.9.9", False)])
        self.assertEqual((d["rows"][0]["avg"], d["rows"][0]["ok"], d["rows"][0]["fail"]), (40, 4, 0))
        self.assertFalse(d["hijack"])
        nx = [a for a in self.runs if a[-2].startswith("jarvis-nx-")]
        self.assertEqual(len(nx), 1)
        self.assertIn("@192.168.88.1", nx[0])                              # asked of the network's own DNS

    def test_dnscheck_hijack_and_timeouts(self):
        self.mod.RESOLV_CONF = os.path.join(self.tmp, "none")

        def fake(argv):
            if argv[-2].startswith("jarvis-nx-"):
                return dig_answer("NOERROR")                                # a made-up name got an answer
            if "@9.9.9.9" in argv:
                return ";; connection timed out; no servers could be reached\n"
            return dig_answer()
        self.fake = fake
        d = self.post("/api/dnscheck")
        self.assertEqual(d["rows"][0]["label"], "System")
        self.assertTrue(d["rows"][0]["mine"])
        q9 = [r for r in d["rows"] if r["server"] == "9.9.9.9"][0]
        self.assertEqual((q9["avg"], q9["fail"], q9["results"][0]["status"]), (None, 4, "TIMEOUT"))
        self.assertTrue(d["hijack"])

    # ---- rogue DHCP
    def test_dhcp_offers(self):
        offers = self.mod.parse_dhcp_offers(DHCP)
        self.assertEqual(len(offers), 2)
        self.assertEqual(offers[0], {"server": "192.168.88.1", "offered": "192.168.88.150", "router": "192.168.88.1", "dns": "192.168.88.1, 1.1.1.1",
                                     "mask": "255.255.255.0", "lease": "2h00m00s", "domain": "lan"})
        self.assertEqual((offers[1]["server"], offers[1]["router"], offers[1]["dns"], offers[1]["domain"]), ("192.168.0.1", "192.168.0.1", "", ""))
        self.mod.default_iface = lambda: "wlan1"
        self.mod.default_gw = lambda: "192.168.88.1"
        self.fake = lambda argv: DHCP
        d = self.post("/api/dhcp")
        self.assertTrue(d["rogue"])
        self.assertEqual((d["gateway"], d["iface"], len(d["offers"])), ("192.168.88.1", "wlan1", 2))

    # ---- jack test
    def sysfs(self, carrier, speed="1000", duplex="full"):
        self.mod.jack_sysfs = lambda f: {"carrier": carrier, "speed": speed, "duplex": duplex}[f]

    def test_jack_no_link(self):
        self.sysfs("0")
        l = self.c.get("/api/jack/link", environ_base=KIOSK).get_json()
        self.assertEqual((l["link"], l["speed"]), (False, ""))
        d = self.post("/api/jack")
        self.assertEqual([(c["k"], c["state"]) for c in d["checks"]], [("link", "bad")])
        self.assertEqual(self.runs, [])                                      # nothing else is tried without a cable

    def test_jack_good(self):
        self.sysfs("1")
        self.assertEqual(self.c.get("/api/jack/link", environ_base=KIOSK).get_json()["speed"], "1000")

        def fake(argv):
            if argv[0] == "nmcli":
                return "IP4.ADDRESS[1]:192.168.88.61/24\nIP4.GATEWAY:192.168.88.1\nIP4.DNS[1]:192.168.88.1\nDHCP4.OPTION[3]:dhcp_server_identifier = 192.168.88.1\n"
            if "lldp" in argv:
                return "    SysName:      Core-SW\n    PortID:       ifname gi1/0/12\n    PortDescr:    Front desk\n"
            if "vlan-sniff" in argv:
                return ""
            return "2 packets transmitted, 2 received, 0% packet loss\nrtt min/avg/max/mdev = 12.1/14.2/16.3/2.1 ms\n"
        self.fake = fake
        d = self.post("/api/jack")
        self.assertEqual([(c["k"], c["state"]) for c in d["checks"]], [("link", "ok"), ("dhcp", "ok"), ("switch", "ok"), ("vlan", "ok"), ("internet", "ok")])
        self.assertIn("192.168.88.61", d["checks"][1]["title"])
        self.assertIn("Core-SW", d["checks"][2]["title"])
        self.assertIn("14 ms", d["checks"][4]["title"])
        self.assertEqual(d["ip"], "192.168.88.61/24")
        self.assertIn("Jack test on eth0", d["output"])

    def test_jack_problems(self):
        self.sysfs("1", speed="100")

        def fake(argv):
            if "vlan-sniff" in argv:
                return "vlan 10, p 0\nvlan 20, p 0\nvlan 10, p 0\n"
            if argv[0] == "ping":
                return "2 packets transmitted, 0 received, 100% packet loss"
            return ""
        self.fake = fake
        d = self.post("/api/jack")
        self.assertEqual([(c["k"], c["state"]) for c in d["checks"]], [("link", "warn"), ("dhcp", "bad"), ("switch", "info"), ("vlan", "info"), ("internet", "bad")])
        self.assertEqual(d["checks"][3]["title"], "Tagged VLANs: 10, 20")

    # ---- history
    def test_history_entries(self):
        with open(self.mod.HISTORY, "w") as f:
            f.write(HIST)
        d = self.c.get("/api/history", environ_base=KIOSK).get_json()
        self.assertEqual([(e["ts"][11:16], e["label"], e["target"]) for e in d["entries"]],
                         [("09:40", "DNS Check", ""), ("09:31", "Ping (live)", "1.1.1.1"), ("09:05", "Rogue DHCP check", "wlan1")])
        self.assertEqual(d["entries"][1]["text"], "PING 1.1.1.1\n10 packets transmitted")
        os.remove(self.mod.HISTORY)
        self.assertEqual(self.c.get("/api/history", environ_base=KIOSK).get_json()["entries"], [])


if __name__ == "__main__":
    unittest.main()
