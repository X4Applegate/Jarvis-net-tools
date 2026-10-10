#!/usr/bin/env python3
"""Throwaway mock of the Jarvis Pi API so the new UI can be screenshotted without touching the real Pi."""
import json, time, random, math, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
random.seed(7)
NOW = int(time.time())
NETS = [("Example WiFi",5,149,86),("Example WiFi",2.4,6,70),("ExampleSetup",2.4,6,76),("ExampleSetup",5,44,60),("OfficeNet",2.4,1,72),("HomeNet-43B0",2.4,2,86),
        ("Corner Cafe",2.4,1,58),("Suite-715",2.4,9,62),("Guest-Network",2.4,11,52),("CityNet",2.4,11,45),("Bakery",2.4,4,50),
        ("Neighbor-A",2.4,6,32),("Neighbor-B",2.4,6,30),("Camera-5744",2.4,9,60),("(hidden)",2.4,12,28),("Guest-2G",2.4,1,54),
        ("Mesh-5G",5,36,64),("Mesh-5G",5,157,52),("ShopNet-5G",5,100,44),("Example-6E",6,37,70),("Example-6E",6,101,48)]
def band_freq(b,ch):
    return 2412+(ch-1)*5 if b==2.4 else (5000+ch*5 if b==5 else 5950+ch*5)
def jr(o,code=200): return code, json.dumps(o).encode()
class H(SimpleHTTPRequestHandler):
    hs_mode="auto"   # setup hotspot mode, shared by all requests (a real Pi keeps it in a file)
    hist_since={"ts":NOW-5400,"reason":"new-day"}   # when the history was last emptied
    visit={"date":time.strftime("%Y-%m-%d"),"company":"Demo Coffee","location":"Main St","ts":NOW-3600}   # today's visit already done
    companies=[{"name":"Demo Coffee","locations":["Main St","Airport"]},{"name":"Example Tea","locations":["Harbor"]}]
    reports=[{"name":"2026-10-01_0930_Example-Tea-Harbor.html","ts":NOW-7*86400,"size":9000,"site":"Example Tea Harbor"}]
    usb=[]       # USB sticks the Pi sees (tests set this through page.route; default none)
    mail={"host":"","port":587,"security":"starttls","user":"","from":"","to":[],"password_set":False,"ready":False}
    saved=[{"name":"Office PC","mac":"AA:BB:CC:DD:EE:01","ip":"192.168.88.50"},{"name":"Store NVR","mac":"AA:BB:CC:DD:EE:02","ip":""}]
    def path_body(self):
        try: b=json.loads(getattr(self,"body",b"") or b"{}"); return b if isinstance(b,dict) else {}
        except Exception: return {}
    def log_message(self,*a): pass
    def hotspot(self):
        return {"mode":H.hs_mode,"service":True,"ssid":"JarvisPi-Manage","active":H.hs_mode=="on","clients":0,"online":True,"fallback_in":None,"error":"","note":""}
    def do_API(self,method):
        path=self.path.split("?")[0]
        if path=="/api/usb": return jr({"drives":H.usb})
        if path=="/api/mail":
            if method=="POST":
                try: b=json.loads(getattr(self,"body",b"") or b"{}")
                except Exception: b={}
                to=[x.strip() for x in str(b.get("to","")).split(",") if x.strip()]
                H.mail=dict(H.mail,host=b.get("host",""),port=int(b.get("port") or 587),security=b.get("security","starttls"),user=b.get("user",""),
                            to=to,password_set=H.mail["password_set"] or bool(b.get("password")))
                H.mail["from"]=b.get("from",""); H.mail["ready"]=bool(H.mail["host"] and H.mail["from"] and H.mail["password_set"])
                return jr({"ok":True,**H.mail})
            return jr(H.mail)
        if path=="/api/mail/test" and method=="POST":
            return jr({"ok":True,"to":H.mail["to"] or [H.mail["from"]]}) if H.mail["ready"] else jr({"error":"fill in the server, From address and password first"},400)
        if path=="/api/visit/finish" and method=="POST":
            site=(H.visit.get("company","") + (" - "+H.visit["location"] if H.visit.get("location") else "")) or "site"
            import re as _re; slug=_re.sub(r"[^A-Za-z0-9._]+","-",site).strip("-.")
            name=time.strftime("%Y-%m-%d_%H%M")+"_"+slug+".html"
            H.reports=[{"name":name,"ts":int(time.time()),"size":12000,"site":slug.replace("-"," ")}]+[r for r in H.reports if r["name"]!=name]
            H.visit=dict(H.visit,finished=True,report=name); H.hist_since={"ts":int(time.time()),"reason":"finished"}
            return jr({"ok":True,"report":name,"site":site})
        if path=="/api/dns/query" and method=="POST":
            b=self.path_body(); t=b.get("target",""); ty=b.get("type","ALL"); srv=b.get("server") or "127.0.0.53"
            if t=="nope.invalid": return jr({"name":t,"type":ty,"server":srv,"results":[{"type":"A","status":"NXDOMAIN","ms":9,"server":srv,"rows":[]}],"rows":[]})
            recs={"A":[("192.0.2.14",300)],"AAAA":[("2001:db8::14",300)],"CNAME":[],"MX":[("10 mail.example.com.",3600)],
                  "NS":[("a.iana-servers.net.",86400),("b.iana-servers.net.",86400)],"TXT":[('"v=spf1 -all"',3600)],"SOA":[("ns.icann.org. noc.dns.icann.org. 2024081455 7200 3600 1209600 3600",3600)],"CAA":[]}
            types=["PTR"] if t[:1].isdigit() else (list(recs) if ty=="ALL" else [ty])
            res=[]
            for q in types:
                vals=[("dns.example.",3600)] if q=="PTR" else recs.get(q,[])
                res.append({"type":q,"status":"NOERROR","ms":12,"server":srv,"rows":[{"name":t,"ttl":v[1],"type":q,"value":v[0]} for v in vals]})
            return jr({"name":t,"type":ty,"server":srv,"results":res,"rows":[r for x in res for r in x["rows"]]})
        if path=="/api/whois" and method=="POST":
            t=self.path_body().get("target","")
            if t=="nope.invalid": return jr({"error":"nope.invalid: not found"},404)
            if t[:1].isdigit():
                return jr({"kind":"ip","name":t,"handle":"NET-198-51-100-0-1","status":["active"],"events":{"registration":"2014-03-14","last changed":"2024-01-02"},"registrar":"","registrant":"",
                           "abuse":"abuse@example.net","nameservers":[],"dnssec":False,"range":"198.51.100.0 - 198.51.100.255","netname":"EXAMPLE-NET","country":"US","org":"Example Networks LLC","source":"rdap.org"})
            return jr({"kind":"domain","name":t,"handle":"2336799_DOMAIN_COM-VRSN","status":["client delete prohibited","client transfer prohibited"],
                       "events":{"registration":"1995-08-14","last changed":"2026-08-14","expiration":"2027-08-13"},"registrar":"Example Registrar, Inc.","registrant":"",
                       "abuse":"abuse@registrar.example","nameservers":["a.iana-servers.net","b.iana-servers.net"],"dnssec":True,"range":"","netname":"","country":"","org":"","source":"rdap.org"})
        if path=="/api/reports": return jr({"reports":H.reports})
        if path=="/api/reports/delete" and method=="POST":
            try: n=json.loads(getattr(self,"body",b"") or b"{}").get("name")
            except Exception: n=None
            if not any(r["name"]==n for r in H.reports): return jr({"error":"no such report"},404)
            H.reports=[r for r in H.reports if r["name"]!=n]; return jr({"ok":True,"reports":H.reports})
        if path.startswith("/api/reports/"):
            n=path[len("/api/reports/"):]
            if not any(r["name"]==n for r in H.reports): return jr({"error":"no such report"},404)
            return 200, ("<!doctype html><html><head><style>body{margin:24px;color:#111} h1{color:rgb(200,0,0)}</style></head><body><h1>Site report</h1><p id=\"who\">"+n+"</p>"+"<p>line</p>"*80+"</body></html>").encode()
        if path=="/api/visit":
            if method=="POST":
                try: b=json.loads(getattr(self,"body",b"") or b"{}")
                except Exception: b={}
                if b.get("skip") is True: H.visit={"date":time.strftime("%Y-%m-%d"),"company":"","location":"","skipped":True}
                elif not str(b.get("company","")).strip(): return jr({"error":"enter the company"},400)
                else:
                    c,l=str(b["company"]).strip(),str(b.get("location","")).strip()
                    H.visit={"date":time.strftime("%Y-%m-%d"),"company":c,"location":l}
                    old=next((x for x in H.companies if x["name"]==c),{"locations":[]})
                    H.companies=[{"name":c,"locations":([l] if l else [])+[x for x in old["locations"] if x!=l]}]+[x for x in H.companies if x["name"]!=c]
            v=H.visit; return jr({"ok":True,"needed":not v or v.get("date")!=time.strftime("%Y-%m-%d") or bool(v.get("finished")),"visit":v,"companies":H.companies,"ssid":"Example WiFi","site_name":"Demo site"})
        if path=="/api/wifi/scan" and method=="POST":
            return jr({"networks":[{"ssid":"Example WiFi","signal":86,"security":"WPA2"},{"ssid":"Store Guest","signal":64,"security":"WPA2"},{"ssid":"Open Cafe","signal":40,"security":""}]})
        if path=="/api/hotspot":
            if method=="POST":
                try: m=json.loads(getattr(self,"body",b"") or b"{}").get("mode")
                except Exception: m=None
                if m not in ("auto","on","off"): return jr({"error":"mode must be auto, on or off"},400)
                H.hs_mode=m; return jr({"ok":True,**self.hotspot()})
            return jr(self.hotspot())
        if path=="/api/me": return jr({"auth":True})
        if path=="/api/status":
            link="Connected to 02:00:5e:00:00:01 (on wlan1)\n\tSSID: Example WiFi\n\tfreq: 5745.0\n\tRX: 1234 bytes\n\tsignal: -52 dBm\n\trx bitrate: 866.7 MBit/s VHT-MCS 9 80MHz\n\ttx bitrate: 780.0 MBit/s\n"
            usb={"iface":"wlan1","mbps":5000,"label":"5 Gbps","gen":"USB 3","usb3_capable":True,"port_usb3":True,"status":"ok","hint":"","id":"0e8d:7961","product":"Wireless_Device","usb_path":"2-1"}
            return jr({"link":link,"net":{"iface":"wlan1","type":"wifi","ip":"192.168.88.34","gw":"192.168.88.1","speed":"","duplex":""},"usb":usb,"active":"Example WiFi:wlan1",
                       "battery":{"percent":87,"source":"mains","level":"mains","shutting_down":False,"critical":10}})
        if path=="/api/signal": return jr({"link":"Connected to x\n\tSSID: Example WiFi\n\tfreq: 5745.0\n\tsignal: -52 dBm\n\trx bitrate: 866.7 MBit/s"})
        if path=="/api/netmon/status":
            return jr({"running":True,"uptime_pct":99.82,"avg_ms":18.4,"gateway_pct":100,"samples":1440,"last":{"ts":NOW-30,"inet_ok":True,"inet_ms":17,"ssid":"Example WiFi","iface":"wlan1"},
                "outages":[{"start_ts":NOW-7200,"end_ts":NOW-7110,"kind":"internet","detail":"no reply from 1.1.1.1"},{"start_ts":NOW-40000,"end_ts":NOW-39800,"kind":"wifi","detail":"link dropped"}],"current_outage":None})
        if path=="/api/netmon/timeline":
            pts=[]
            for i in range(288):
                t=NOW-86400+i*300; pct=100
                if 200<i<203: pct=0
                if 90<i<93: pct=60
                pts.append({"t":t,"pct":pct,"ms":None if pct==0 else round(15+8*math.sin(i/9)+random.random()*10,1)})
            return jr({"points":pts})
        if path=="/api/netmon/speed":
            rows=[]
            for i in range(20):
                d=random.choice([718,392,331,150,640,720,455]); rows.append({"ts":NOW-(20-i)*3600*3,"down":d,"up":round(d*random.uniform(.4,.9)),"ping":random.randint(12,30),"grade":random.choice("ABBCD"),"source":"auto","server":"Seattle"})
            return jr({"rows":rows})
        if path=="/api/settings":
            if method=="POST" and "saved_devices" in self.path_body():          # remember saved devices (the Pi does)
                H.saved=self.path_body()["saved_devices"]
            return jr({"ok":True,"site_name":"Demo site","speed_interval_min":60,"service_checks":[{"name":"Online ordering","type":"https","target":"https://shop.example.com"}],
                       "saved_devices":H.saved,"version":"3.0","hostname":"jarvis-pi","ipinfo_token_set":True,
                       "history_since":H.hist_since})
        if path=="/api/scanall":
            return jr({"networks":[{"ch":str(c),"sig":str(s),"ssid":n,"band":("%g"%b),"freq":band_freq(b,c)} for n,b,c,s in NETS]})
        if path=="/api/wifi/saved": return jr({"profiles":["Example WiFi","ShopNet-Admin","Backup-2.4GHz","Home WiFi"]})
        if path=="/api/services":
            H.svc_n=getattr(H,"svc_n",0)+1
            res=[{"name":"Gateway","type":"gw","group":"Network","target":"192.168.88.1","ok":True,"detail":"1.8 ms"},
                 {"name":"Internet (1.1.1.1)","type":"ping","group":"Network","target":"1.1.1.1","ok":True,"detail":"14.2 ms"},
                 {"name":"DNS resolve (google.com)","type":"dns","group":"Network","target":"google.com","ok":True,"detail":"192.0.2.80 (22 ms)"},
                 {"name":"Square POS","type":"https","group":"Payments","target":"https://squareup.com","ok":True,"detail":"HTTP 200 in 210 ms"},
                 {"name":"Toast POS","type":"https","group":"Payments","target":"https://pos.toasttab.com","ok":H.svc_n%2==1,"detail":"HTTP 200 in 640 ms" if H.svc_n%2==1 else "unreachable / timeout"},
                 {"name":"Spotify","type":"https","group":"Apps","target":"https://api.spotify.com","ok":True,"detail":"HTTP 401 in 95 ms"},
                 {"name":"Online ordering","type":"https","group":"Your checks","target":"https://shop.example.com","ok":True,"detail":"HTTP 200 in 330 ms"}]
            return jr({"output":"(mock)","results":res,"failed":sum(1 for r in res if not r["ok"]),"lan":{"subnet":"192.168.88.0/24","found":{"Omada controller":["192.168.88.5"],"Receipt / label printer":[],"IPP printer":["192.168.88.77"]}}})
        if path=="/api/channel":
            bands={"2.4":{},"5":{},"6":{}}
            for n,b,c,s in NETS:
                e=bands["%g"%b].setdefault(str(c),{"count":0,"best":0,"ssids":[]}); e["count"]+=1; e["best"]=max(e["best"],s); e["ssids"].append({"ssid":n,"sig":s})
            return jr({"band24":bands["2.4"],"band5":bands["5"],"band6":bands["6"]})
        if path=="/api/aps": return jr({"ssid":"Example WiFi","aps":[{"bssid":"02:00:5E:00:00:01","signal":86,"band":"5","ch":149,"current":True,"name":"Office AP"},
                                       {"bssid":"02:00:5E:00:00:04","signal":70,"band":"2.4","ch":6,"current":False,"name":""},
                                       {"bssid":"02:00:5E:00:00:02","signal":44,"band":"5","ch":36,"current":False,"name":"Back Room"}]})
        if path=="/api/pubip": return jr({"output":"{}","info":{"ip":"203.0.113.45","hostname":"203-0-113-45.example-isp.net","isp":"Example ISP","asn":"AS64500","domain":"example-isp.net",
                                       "city":"Metro","region":"State","country":"US","country_name":"","timezone":"America/Los_Angeles"},"ipv6":"2001:db8:1::45"})
        if path=="/api/dnscheck":
            names=["google.com","cloudflare.com","microsoft.com","squareup.com"]
            def row(label,srv,mine,ms): return {"label":label,"server":srv,"mine":mine,"avg":round(sum(ms)/len(ms)),"min":min(ms),"max":max(ms),"ok":4,"fail":0,
                                                 "results":[{"name":n,"status":"NOERROR","ms":m,"answers":1} for n,m in zip(names,ms)]}
            return jr({"output":"(mock)","resolvers":["192.168.88.1"],"names":names,"hijack":False,"nx_status":"NXDOMAIN",
                       "rows":[row("This network","192.168.88.1",True,[12,18,25,9]),row("Cloudflare","1.1.1.1",False,[14,11,16,13]),row("Google","8.8.8.8",False,[22,19,28,21]),row("Quad9","9.9.9.9",False,[30,26,41,33])]})
        if path=="/api/dhcp":
            o=lambda s,r: {"server":s,"offered":"192.168.88.150","router":r,"dns":"192.168.88.1","mask":"255.255.255.0","lease":"2h00m00s","domain":"lan"}
            return jr({"output":"(mock)","servers":["192.168.88.1","192.168.0.1"],"rogue":True,"iface":"wlan1","gateway":"192.168.88.1","offers":[o("192.168.88.1","192.168.88.1"),o("192.168.0.1","192.168.0.1")]})
        if path=="/api/jack/link": return jr({"iface":"eth0","link":True,"speed":"1000","duplex":"full"})
        if path=="/api/jack":
            return jr({"output":"(mock)","iface":"eth0","link":True,"speed":"1000","ip":"192.168.88.61","checks":[
                {"k":"link","state":"ok","title":"Link up \u00b7 1000 Mb/s full","detail":""},
                {"k":"dhcp","state":"ok","title":"Got an address \u00b7 192.168.88.61","detail":"gateway 192.168.88.1 \u00b7 DNS 192.168.88.1"},
                {"k":"switch","state":"ok","title":"Switch Core-SW \u00b7 port gi1/0/12","detail":"Front desk"},
                {"k":"vlan","state":"ok","title":"No VLAN tags","detail":"an access port: normal for a device jack"},
                {"k":"internet","state":"ok","title":"Internet through this jack \u00b7 14 ms","detail":""}]})
        if path=="/api/ports":
            L=lambda pr,po,a,proc,sc: {"proto":pr,"port":po,"addr":a,"iface":"","process":proc,"scope":sc}
            return jr({"output":"(mock)","listeners":[L("tcp",22,"0.0.0.0","sshd","all"),L("tcp",5201,"*","iperf3","all"),L("tcp",8092,"203.0.113.15","python3","one"),
                       L("udp",5353,"0.0.0.0","avahi-daemon","all"),L("tcp",8092,"127.0.0.1","python3","local"),L("tcp",8088,"127.0.0.1","influxd","local"),L("udp",46169,"0.0.0.0","speedtest","all")]})
        if path=="/api/bandwidth/now":
            H.bw_n=getattr(H,"bw_n",0)+1; t=time.time(); k=H.bw_n
            return jr({"ts":t,"default":"wlan1","ifaces":{"wlan1":{"rx":k*k*2500000,"tx":k*k*600000},"eth0":{"rx":0,"tx":0},"wg1":{"rx":5000+k*1000,"tx":2000+k*500}}})
        if path=="/api/history":
            E=[{"ts":"2026-10-10 09:42:11","label":"Whois","target":"example.com","text":"registrar: Example Registrar, Inc."},
               {"ts":"2026-10-10 09:40:02","label":"DNS MX","target":"example.com","text":"MX   3600  10 mail.example.com."},
               {"ts":"2026-10-10 09:31:47","label":"Ping (live)","target":"1.1.1.1","text":"10 packets transmitted, 10 received, 0% packet loss"},
               {"ts":"2026-10-10 09:20:05","label":"Ping (live)","target":"192.168.88.1","text":"10 packets transmitted, 9 received, 10% packet loss"},
               {"ts":"2026-10-10 09:05:33","label":"Rogue DHCP check","target":"wlan1","text":"OK \u2014 exactly one DHCP server: 192.168.88.1"}]
            return jr({"output":"(mock history)","entries":E})
        if path=="/api/apnames": return jr({"names":{"02:00:5E:00:00:01":"Office AP"}})
        if path=="/api/iperf/info": return jr({"server":True,"ips":["192.168.88.34"]})
        if path=="/api/shutdown": return jr({"ok":True,"action":"shutdown","power_button":True})   # mock: nothing powers off
        if path=="/api/history/clear" and method=="POST":
            H.hist_since={"ts":int(time.time()),"reason":"manual"}; return jr({"ok":True,"history_since":H.hist_since})
        if path in ("/api/devices","/api/devices/last"):
            hosts=[{"ip":"192.168.88.1","name":"Omada Gateway","type":"Router","vendor":"TP-Link","mac":"02:00:5E:00:00:03","info":"","ping":1.2,"ports":["22","80","443"],
                    "web":"https://192.168.88.1","title":"Omada Gateway","ipv6":[],"services":[],"upnp":{"friendly":"Omada Gateway","manufacturer":"TP-Link","model":"ER605"},
                    "names":{"mdns":"","netbios":"","dns":"router.lan"},"flags":["G","W","U","P"]},
                   {"ip":"192.168.88.34","name":"jarvis-pi","type":"","vendor":"Jarvis Net Tools (this Pi)","mac":"AA:BB:CC:DD:EE:34","info":"","ping":0.1,"ports":[],"web":"","title":"",
                    "ipv6":["2001:db8::34"],"services":["ssh"],"upnp":{},"names":{"mdns":"jarvis-pi.local","netbios":"","dns":""},"flags":["B","6","P","S"],"self":True},
                   {"ip":"192.168.88.50","name":"Office PC","type":"Laptop","vendor":"Intel Corporate","mac":"AA:BB:CC:DD:EE:01","info":"","ping":3.4,"ports":["445"],"web":"","title":"",
                    "ipv6":[],"services":[],"upnp":{},"names":{"mdns":"","netbios":"OFFICE-PC","dns":""},"flags":["P"]},
                   {"ip":"192.168.88.77","name":"","type":"Printer","vendor":"HP","mac":"AA:BB:CC:DD:EE:77","info":"","ping":None,"ports":["631","9100"],"web":"","title":"",
                    "ipv6":[],"services":["ipp","printer"],"upnp":{},"names":{"mdns":"","netbios":"","dns":""},"flags":["B"]}]
            return jr({"hosts":hosts,"network":"Example WiFi","gw":"192.168.88.1","ts":NOW-120})
        return jr({"ok":True,"output":"(mock) %s %s\nPING 1.1.1.1: 5 packets transmitted, 5 received, 0%% packet loss\nrtt min/avg/max = 14.2/17.9/22.0 ms"%(method,path)})
    def _send(self,code,body,ct="application/json"):
        self.send_response(code); self.send_header("Content-Type",ct); self.send_header("Content-Length",str(len(body))); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(body)
    CSP = ("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
           "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")   # keep in sync with app.py
    def end_headers(self):
        if self.path.split("?")[0] in ("/", "/index.html"): self.send_header("Content-Security-Policy", self.CSP)
        self.send_header("X-Content-Type-Options", "nosniff"); super().end_headers()
    def do_GET(self):
        if self.path.startswith("/api/"):
            c,b=self.do_API("GET"); return self._send(c,b)
        return super().do_GET()
    def stream_ping(self, body):
        """Mimics the Pi's /api/ping/stream: SSE lines trickling in (0.25 s apart here so tests stay fast)."""
        req=json.loads(body or b"{}"); tgt=req.get("target","?"); count=int(req.get("count",5));
        self.send_response(200); self.send_header("Content-Type","text/event-stream"); self.send_header("Cache-Control","no-cache"); self.end_headers()
        def w(txt): self.wfile.write(txt.encode()); self.wfile.flush()
        try:
            w('event: start\ndata: %s\n\n'%json.dumps({"target":tgt,"count":count}))
            w('data: %s\n\n'%json.dumps("PING %s (1.1.1.1) 56(84) bytes of data."%tgt))
            i=0
            while count==0 or i<count:
                i+=1; time.sleep(0.25)
                if tgt=="192.0.2.1" and i>1: w('data: %s\n\n'%json.dumps("no answer yet for icmp_seq=%d"%(i-1)))
                else: w('data: %s\n\n'%json.dumps("64 bytes from 1.1.1.1: icmp_seq=%d ttl=54 time=%.1f ms"%(i,12+random.random()*20)))
            w('data: %s\n\n'%json.dumps("")); w('data: %s\n\n'%json.dumps("--- %s ping statistics ---"%tgt)); w('event: done\ndata: {"code": 0}\n\n')
        except (BrokenPipeError, ConnectionResetError): pass
    def _sse_begin(self):
        self.send_response(200); self.send_header("Content-Type","text/event-stream"); self.send_header("Cache-Control","no-cache"); self.end_headers()
    def _w(self,txt): self.wfile.write(txt.encode()); self.wfile.flush()
    def stream_trace(self, body):
        """mtr --raw look-alike: 0-based hops, hop 4 never answers, hop 3 is lossy, hops 8-9 are 'ghost' repeats of the destination."""
        req=json.loads(body or b"{}"); count=int(req.get("count",10)); self._sse_begin()
        hosts=["192.168.88.1","198.51.100.7","198.51.100.23","203.0.113.12",None,"203.0.113.40","198.51.100.99","1.1.1.1","1.1.1.1","1.1.1.1"]
        try:
            self._w('event: start\ndata: %s\n\n'%json.dumps({"target":req.get("target"),"count":count}))
            seq=33000
            for c in range(count):
                for hop,h in enumerate(hosts):
                    self._w('data: %s\n\n'%json.dumps("x %d %d"%(hop,seq)))
                    if h and not (hop==3 and random.random()<0.3):
                        self._w('data: %s\n\n'%json.dumps("h %d %s"%(hop,h))); self._w('data: %s\n\n'%json.dumps("p %d %d %d"%(hop,int((2+hop*3+random.random()*4)*1000),seq)))
                    seq+=1; time.sleep(0.03)
                time.sleep(0.25)
                self._w(": keepalive\n\n")
            self._w('event: done\ndata: {"code": 0}\n\n')
        except (BrokenPipeError, ConnectionResetError): pass
    def stream_ports(self, body):
        req=json.loads(body or b"{}"); tgt=req.get("target","?"); self._sse_begin()
        L=lambda t: self._w('data: %s\n\n'%json.dumps(t))
        try:
            self._w('event: start\ndata: %s\n\n'%json.dumps({"target":tgt}))
            L("Starting Nmap 7.95 ( https://nmap.org ) at 2026-10-06 15:09 PDT"); L("Initiating Connect Scan at 15:09"); L("Scanning %s (1.2.3.4) [100 ports]"%tgt)
            for pct in (10,25,40,60,80):
                time.sleep(0.35)
                if pct==25: L("Discovered open port 22/tcp on 1.2.3.4")
                if pct==60: L("Discovered open port 443/tcp on 1.2.3.4")
                L("Connect Scan Timing: About %d.00%% done; ETC: 15:10 (0:00:03 remaining)"%pct)
            time.sleep(0.35); L("Discovered open port 80/tcp on 1.2.3.4"); L("Completed Connect Scan at 15:09, 2.10s elapsed (100 total ports)")
            L("Nmap scan report for %s (1.2.3.4)"%tgt); L("Host is up (0.012s latency)."); L("Not shown: 97 closed tcp ports (conn-refused)"); L("PORT    STATE SERVICE")
            L("22/tcp  open  ssh"); L("80/tcp  open  http"); L("443/tcp open  https"); L(""); L("Read data files from: /usr/bin/../share/nmap"); L("Nmap done: 1 IP address (1 host up) scanned in 2.14 seconds")
            self._w('event: done\ndata: {"code": 0}\n\n')
        except (BrokenPipeError, ConnectionResetError): pass
    def stream_speed(self, body):
        """Ookla --format=jsonl look-alike (bandwidth is bytes/s, running average), ~60 ms apart so tests stay fast."""
        self._sse_begin(); L=lambda o: self._w('data: %s\n\n'%json.dumps(o))
        try:
            self._w('event: start\ndata: {"attempts": 2}\n\n')
            L({"type":"testStart","server":{"name":"Example Net","location":"Metro, ST"}})
            for i in range(1,6): time.sleep(0.04); L({"type":"ping","ping":{"jitter":1.0,"latency":14+i,"progress":i/5}})
            for i in range(1,36):
                time.sleep(0.06); v=650*(1-math.exp(-i/6))+random.random()*8; L({"type":"download","download":{"bandwidth":v*1e6/8,"bytes":i*1000000,"elapsed":i*60,"progress":i/35}})
            time.sleep(0.15)
            for i in range(1,26):
                time.sleep(0.06); v=340*(1-math.exp(-i/4))+random.random()*5; L({"type":"upload","upload":{"bandwidth":v*1e6/8,"bytes":i*500000,"elapsed":i*60,"progress":i/25}})
            L({"type":"result"})
            L({"type":"summary","ts":NOW,"server":"Example Net \u2014 Metro, ST","isp":"Example ISP","ping":17.1,"jitter":3.7,"down":650.2,"up":338.9,"down_lat":154.4,"up_lat":24.0,"loss":None,"url":"https://www.speedtest.net/result/c/mock","grade":"B","grade_down":"B","grade_up":"A","rise_down":37,"rise_up":7,"note":"Wi-Fi link (wlan1): rx 864.8 / tx 720.6 Mbps, signal -34 dBm\nUSB bus speed: 5000 Mbps"})
            self._w('event: done\ndata: {"code": 0}\n\n')
        except (BrokenPipeError, ConnectionResetError): pass
    def do_POST(self):
        n=int(self.headers.get("Content-Length") or 0); body=self.rfile.read(n); self.body=body
        if self.path=="/api/speedtest/stream": return self.stream_speed(body)
        if self.path=="/api/trace/stream": return self.stream_trace(body)
        if self.path=="/api/portscan/stream": return self.stream_ports(body)
        if self.path=="/api/ping/stream": return self.stream_ping(body)
        c,b=self.do_API("POST"); return self._send(c,b)
if __name__=="__main__":
    import os; os.chdir(sys.argv[1]); ThreadingHTTPServer(("127.0.0.1",int(sys.argv[2])),H).serve_forever()
