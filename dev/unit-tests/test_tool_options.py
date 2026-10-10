"""Unit tests for the Tools page options: ping / route / port-scan arguments, DNS (record types + server) and Whois (RDAP).

Needs Flask (apt: python3-flask). Nothing is run for real: the command runner and the live-stream helper are faked.
    python3 -m unittest -v dev/unit-tests/test_tool_options.py        (from the repo root)
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "security-tests"))
from test_security import load_app, remote  # noqa: E402

KIOSK = remote("127.0.0.1")

DIG_A = """;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 4242
;; flags: qr rd ra; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1

example.com.\t\t300\tIN\tA\t192.0.2.14
example.com.\t\t300\tIN\tA\t192.0.2.15
;; Query time: 12 msec
;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
"""
DIG_EMPTY = """;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1
;; Query time: 9 msec
;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
"""
DIG_NX = DIG_EMPTY.replace("NOERROR", "NXDOMAIN")
DIG_PTR = """;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 7
8.8.8.8.in-addr.arpa.\t3600\tIN\tPTR\tdns.google.
;; Query time: 20 msec
;; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)
"""
DIG_TXT = """;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 8
example.com.\t3600\tIN\tTXT\t"v=spf1 -all" "second string"
;; Query time: 5 msec
;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
"""
WHOIS_IO = """Domain Name: example.io
Registry Domain ID: REDACTED
Registrar WHOIS Server: http://whois.example
Updated Date: 2026-08-12T02:32:48Z
Creation Date: 2022-04-27T18:20:44Z
Registry Expiry Date: 2027-04-27T18:20:44Z
Registrar: Example Registrar, Inc
Registrar Abuse Contact Email: abuse@registrar.example
Domain Status: clientTransferProhibited https://icann.org/epp#clientTransferProhibited
Registrant Name: REDACTED
Registrant Organization: Example Org
Name Server: NS1.EXAMPLE.NET
Name Server: ns2.example.net
DNSSEC: signedDelegation
>>> Last update of WHOIS database: 2026-10-10T04:32:55Z <<<
"""
RDAP_DOMAIN = {
    "handle": "123_DOMAIN_COM-VRSN", "status": ["client transfer prohibited"],
    "events": [{"eventAction": "registration", "eventDate": "1997-09-15T04:00:00Z"}, {"eventAction": "expiration", "eventDate": "2028-09-14T04:00:00Z"}],
    "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar, Inc."]]],
                  "entities": [{"roles": ["abuse"], "vcardArray": ["vcard", [["email", {}, "text", "abuse@registrar.example"]]]}]}],
    "nameservers": [{"ldhName": "NS1.EXAMPLE.NET"}, {"ldhName": "ns2.example.net"}],
    "secureDNS": {"delegationSigned": True},
}
RDAP_IP = {
    "handle": "NET-198-51-100-0-2", "startAddress": "198.51.100.0", "endAddress": "198.51.100.255", "name": "GOGL", "country": "US",
    "events": [{"eventAction": "registration", "eventDate": "2023-12-28T17:24:33-05:00"}],
    "entities": [{"roles": ["registrant"], "vcardArray": ["vcard", [["fn", {}, "text", "Google LLC"]]]},
                 {"roles": ["abuse"], "vcardArray": ["vcard", [["email", {}, "text", "network-abuse@google.com"]]]}],
}


class ToolOptions(unittest.TestCase):
    def setUp(self):
        self.mod, self.cfg = load_app()
        self.mod.HISTORY = os.devnull
        self.c = self.mod.app.test_client()
        self.streams, self.runs = [], []
        self.mod.stream_command = lambda label, t, argv, limit, meta, **kw: (self.streams.append((argv, limit, meta)), self.mod.jsonify({"ok": True}))[1]
        self.answers = {}

        def fake_run(argv, timeout=45, cwd=None):
            self.runs.append(argv)
            if argv[0] == "curl":
                return self.answers.get("curl", "")
            key = "PTR" if "-x" in argv else argv[-1]
            return self.answers.get(key, DIG_EMPTY)
        self.mod.run = fake_run

    def post(self, path, body):
        return self.c.post(path, json=body, environ_base=KIOSK)

    # ---- ping
    def test_ping_defaults(self):
        self.post("/api/ping/stream", {"target": "1.1.1.1", "count": 10})
        argv, limit, meta = self.streams[-1]
        self.assertEqual(argv, ["ping", "-n", "-O", "-i", "1", "-W", "2", "-s", "56", "-c", "10", "1.1.1.1"])
        self.assertFalse(meta["df"])

    def test_ping_options_and_clamps(self):
        self.post("/api/ping/stream", {"target": "1.1.1.1", "count": 5, "interval": 0.2, "size": 1472, "df": True})
        argv, limit, _ = self.streams[-1]
        self.assertEqual(argv, ["ping", "-n", "-O", "-i", "0.2", "-W", "2", "-s", "1472", "-M", "do", "-c", "5", "1.1.1.1"])
        self.post("/api/ping/stream", {"target": "1.1.1.1", "count": 3, "interval": 0.01, "size": 99999, "df": "yes"})
        argv, _, _ = self.streams[-1]
        self.assertIn("0.2", argv)                   # faster than an unprivileged ping may go -> 0.2 s
        self.assertIn("1472", argv)                  # bigger than one 1500-byte packet -> 1472
        self.assertNotIn("-M", argv)                 # only a real true turns on don't-fragment
        self.post("/api/ping/stream", {"target": "1.1.1.1", "interval": "x"})
        self.assertIn("1", self.streams[-1][0])

    def test_ping_monitor_has_no_count(self):
        self.post("/api/ping/stream", {"target": "1.1.1.1", "count": 0, "interval": 2})
        argv, limit, _ = self.streams[-1]
        self.assertNotIn("-c", argv)
        self.assertEqual(limit, 1800)

    # ---- route
    def test_route_options(self):
        self.post("/api/trace/stream", {"target": "1.1.1.1", "count": 5, "max_hops": 15, "proto": "tcp"})
        argv = self.streams[-1][0]
        self.assertEqual(argv[-6:], ["-m", "15", "-T", "-P", "443", "1.1.1.1"])
        self.post("/api/trace/stream", {"target": "1.1.1.1", "proto": "udp", "max_hops": 999})
        argv = self.streams[-1][0]
        self.assertEqual(argv[-4:], ["-m", "64", "-u", "1.1.1.1"])
        self.post("/api/trace/stream", {"target": "1.1.1.1", "proto": "; rm -rf /"})
        argv = self.streams[-1][0]
        self.assertEqual(argv[-3:], ["-m", "30", "1.1.1.1"])      # unknown protocol = ICMP, nothing passed through

    # ---- ports
    def test_ports_modes(self):
        self.post("/api/portscan/stream", {"target": "192.0.2.1"})
        self.assertIn("100", self.streams[-1][0])
        self.post("/api/portscan/stream", {"target": "192.0.2.1", "mode": "top1000"})
        argv, limit, _ = self.streams[-1]
        self.assertIn("1000", argv)
        self.assertEqual(limit, 600)
        self.post("/api/portscan/stream", {"target": "192.0.2.1", "mode": "range", "start": 20, "end": 450})
        argv = self.streams[-1][0]
        self.assertEqual(argv[argv.index("-p") + 1], "20-450")

    def test_ports_bad_ranges(self):
        for body in ({"start": 450, "end": 20}, {"start": 0, "end": 10}, {"start": 1, "end": 70000}, {"start": "a", "end": 5}):
            r = self.post("/api/portscan/stream", dict(body, target="192.0.2.1", mode="range"))
            self.assertEqual(r.status_code, 400, body)
        self.assertEqual(self.streams, [])
        self.post("/api/portscan/stream", {"target": "192.0.2.1", "mode": "range", "start": 1, "end": 65535})
        self.assertEqual(self.streams[-1][1], 1800)                # the whole range gets the longest time limit

    # ---- DNS
    def test_dns_one_type_with_server(self):
        self.answers["A"] = DIG_A
        d = self.post("/api/dns/query", {"target": "example.com", "type": "a", "server": "1.1.1.1"}).get_json()
        self.assertEqual(self.runs, [["dig", "+noall", "+answer", "+comments", "+stats", "+time=3", "+tries=1", "@1.1.1.1", "example.com", "A"]])
        self.assertEqual([r["value"] for r in d["rows"]], ["192.0.2.14", "192.0.2.15"])
        self.assertEqual(d["rows"][0], {"name": "example.com", "ttl": 300, "type": "A", "value": "192.0.2.14"})
        self.assertEqual((d["server"], d["results"][0]["status"], d["results"][0]["ms"]), ("1.1.1.1", "NOERROR", 12))

    def test_dns_all(self):
        self.answers.update(A=DIG_A, TXT=DIG_TXT)
        d = self.post("/api/dns/query", {"target": "example.com", "type": "ALL"}).get_json()
        self.assertEqual([x["type"] for x in d["results"]], ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA"])
        self.assertTrue(all("@" not in " ".join(a) for a in self.runs))          # no server = the system resolver
        txt = [r for r in d["rows"] if r["type"] == "TXT"][0]
        self.assertEqual(txt["value"], '"v=spf1 -all" "second string"')          # spaces inside the value survive

    def test_dns_reverse_and_nxdomain(self):
        self.answers["PTR"] = DIG_PTR
        d = self.post("/api/dns/query", {"target": "8.8.8.8"}).get_json()
        self.assertEqual(self.runs[-1][-2:], ["-x", "8.8.8.8"])
        self.assertEqual((d["rows"][0]["type"], d["rows"][0]["value"]), ("PTR", "dns.google."))
        self.answers["MX"] = DIG_NX
        d = self.post("/api/dns/query", {"target": "nope.invalid", "type": "MX"}).get_json()
        self.assertEqual((d["results"][0]["status"], d["rows"]), ("NXDOMAIN", []))

    def test_dns_rejects_bad_input(self):
        self.assertEqual(self.post("/api/dns/query", {"target": "example.com", "type": "ANY;ls"}).status_code, 400)
        self.assertEqual(self.post("/api/dns/query", {"target": "example.com", "server": "1.1.1.1 +tcp"}).status_code, 400)
        self.assertEqual(self.post("/api/dns/query", {"target": "-x"}).status_code, 400)
        self.assertEqual(self.runs, [])

    # ---- Whois
    def test_whois_domain(self):
        self.answers["curl"] = json.dumps(RDAP_DOMAIN)
        d = self.post("/api/whois", {"target": "example.com"}).get_json()
        self.assertEqual(self.runs[-1][-1], "https://rdap.org/domain/example.com")
        self.assertEqual(d["kind"], "domain")
        self.assertEqual(d["registrar"], "Example Registrar, Inc.")
        self.assertEqual(d["events"], {"registration": "1997-09-15", "expiration": "2028-09-14"})
        self.assertEqual(d["nameservers"], ["ns1.example.net", "ns2.example.net"])
        self.assertTrue(d["dnssec"])
        self.assertEqual(d["abuse"], "abuse@registrar.example")     # nested under the registrar

    def test_whois_ip(self):
        self.answers["curl"] = json.dumps(RDAP_IP)
        d = self.post("/api/whois", {"target": "8.8.8.8"}).get_json()
        self.assertEqual(self.runs[-1][-1], "https://rdap.org/ip/8.8.8.8")
        self.assertEqual((d["kind"], d["range"], d["netname"], d["org"], d["country"], d["abuse"]),
                         ("ip", "198.51.100.0 - 198.51.100.255", "GOGL", "Google LLC", "US", "network-abuse@google.com"))

    def test_whois_errors(self):
        self.mod.whois43 = lambda server, q, timeout=10: (_ for _ in ()).throw(OSError("offline"))
        self.answers["curl"] = ""
        self.assertEqual(self.post("/api/whois", {"target": "example.com"}).status_code, 502)    # no RDAP and no whois server reachable
        self.answers["curl"] = json.dumps({"errorCode": 404, "title": "Not Found"})
        r = self.post("/api/whois", {"target": "192.0.2.1"})
        self.assertEqual(r.status_code, 404)
        self.assertIn("Not Found", r.get_json()["error"])
        self.answers["curl"] = ""
        self.assertEqual(self.post("/api/whois", {"target": "192.0.2.1"}).status_code, 502)
        self.assertEqual(self.post("/api/whois", {"target": "a b"}).status_code, 400)

    def fake_whois43(self, answers):
        self.asked = []

        def f(server, q, timeout=10):
            self.asked.append((server, q))
            return answers[server]
        self.mod.whois43 = f

    def test_whois_classic_fallback(self):
        """.io has no RDAP: rdap.org says 404, so the TLD's classic whois server answers instead."""
        self.answers["curl"] = json.dumps({"errorCode": 404, "title": "No RDAP service is available for this resource"})
        self.fake_whois43({"whois.iana.org": "domain:       IO\nwhois:        whois.nic.io\n", "whois.nic.io": WHOIS_IO})
        r = self.post("/api/whois", {"target": "example.io"})
        self.assertEqual(r.status_code, 200)
        d = r.get_json()
        self.assertEqual(self.asked, [("whois.iana.org", "io"), ("whois.nic.io", "example.io")])
        self.assertEqual((d["kind"], d["registrar"], d["registrant"], d["abuse"], d["source"]),
                         ("domain", "Example Registrar, Inc", "Example Org", "abuse@registrar.example", "whois.nic.io"))
        self.assertEqual(d["events"], {"last changed": "2026-08-12", "registration": "2022-04-27", "expiration": "2027-04-27"})
        self.assertEqual(d["status"], ["client transfer prohibited"])
        self.assertEqual(d["nameservers"], ["ns1.example.net", "ns2.example.net"])
        self.assertTrue(d["dnssec"])

    def test_whois_classic_not_found(self):
        self.answers["curl"] = json.dumps({"errorCode": 404, "title": "No RDAP service"})
        self.fake_whois43({"whois.iana.org": "refer:        whois.nic.io\n", "whois.nic.io": "Domain not found.\n"})
        r = self.post("/api/whois", {"target": "nope-nope.io"})
        self.assertEqual(r.status_code, 404)
        self.assertIn("not found at whois.nic.io", r.get_json()["error"])
        self.fake_whois43({"whois.iana.org": "% no such TLD\n"})
        self.assertEqual(self.post("/api/whois", {"target": "x.zzzz"}).status_code, 404)

if __name__ == "__main__":
    unittest.main()
