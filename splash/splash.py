#!/usr/bin/env python3
"""Jarvis Pi captive splash — WiFi onboarding page on the JarvisPi-Manage hotspot.

Listens ONLY on the hotspot address (10.42.0.1:80). When a phone joins the hotspot,
its captive-portal probe (Android/iOS/Windows/Firefox) is DNS-redirected here by
NetworkManager's dnsmasq; we answer with a redirect to the splash page, which makes
the phone pop the "Sign in to network" sheet automatically. Once the user taps Done
(or a join succeeds) we answer the probes with the platform's expected "success"
response so the phone stops nagging.

Runs as the unprivileged 'nettools' user. WiFi actions go through the same narrow
sudo allowlist as the main app (nmcli only). All commands are argv lists; inputs
are validated; nothing typed here can be run as a command.
"""
import json
import os
import re
import socket
import subprocess
import time
from flask import Flask, request, jsonify, redirect, Response

BIND = "10.42.0.1"
VPN_PEER = os.environ.get("JARVIS_VPN_PEER", "")      # optional: an address on your VPN to ping for the "VPN up" indicator
PORT = 80
WLAN = "wlan1"                 # the Alfa AWUS036AXML — connection radio (hotspot is wlan0)
PROTECTED = re.compile(r"JarvisPi", re.I)   # never forget the hotspot itself
VALID_SSID = re.compile(r"^[^\x00-\x1f]{1,32}$")
VALID_NAME = re.compile(r"^[^\x00-\x1f]{1,64}$")
DONE_TTL = 12 * 3600           # after Done, probes succeed for this long (per client IP)

app = Flask(__name__)
done = {}                      # client ip -> timestamp


def run(argv, timeout=45):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return "[timed out]"
    except Exception as e:  # noqa: BLE001
        return f"[error] {e}"


def is_done(ip):
    t = done.get(ip)
    return bool(t) and (time.time() - t) < DONE_TTL


# ---- captive-portal probe handling ----------------------------------------

@app.before_request
def captive_probe():
    host = (request.host or "").split(":")[0].lower()
    if host == BIND:
        return None                       # a real request to the splash / API
    ip = request.remote_addr or ""
    if not is_done(ip):
        # Not signed in yet: redirect every probe to the splash. This is what
        # makes the phone show the sign-in sheet.
        return redirect(f"http://{BIND}/", code=302)
    # Signed in: give each platform the exact response it expects.
    if "apple.com" in host:
        return Response("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>",
                        mimetype="text/html")
    if "msftconnecttest" in host:
        return Response("Microsoft Connect Test", mimetype="text/plain")
    if "msftncsi" in host:
        return Response("Microsoft NCSI", mimetype="text/plain")
    if "firefox" in host:
        return Response("success", mimetype="text/plain")
    return Response(status=204)           # Android / gstatic / ubuntu / gnome


# ---- status ------------------------------------------------------------------

AP_NAMES_PATH = "/var/lib/jarvis-nettools/ap-names.json"   # names saved in the main app
VALID_MAC = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")


def band_of(freq_mhz):
    return "2.4" if freq_mhz < 3000 else "5" if freq_mhz < 5925 else "6"


def ap_names():
    try:
        d = json.load(open(AP_NAMES_PATH))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def current_bssid():
    m = re.search(r"Connected to\s+([0-9a-fA-F:]{17})", run(["/usr/sbin/iw", "dev", WLAN, "link"], timeout=10))
    return m.group(1).upper() if m else ""


def ap_rows(ssid, rescan=False):
    """Every access point broadcasting `ssid`: bssid, name (if saved), band, channel, signal %."""
    out = run(["sudo", "nmcli", "-t", "-f", "SSID,BSSID,SIGNAL,CHAN,FREQ", "dev", "wifi", "list",
               "ifname", WLAN, "--rescan", "yes" if rescan else "no"], timeout=45)
    names, cur, rows = ap_names(), current_bssid(), []
    for line in out.splitlines():
        m = re.match(r"^(.*?):((?:[0-9A-Fa-f]{2}\\:){5}[0-9A-Fa-f]{2}):(\d+):(\d+):(\d+) MHz$", line)
        if not m or m.group(1).replace("\\:", ":") != ssid:
            continue
        b = m.group(2).replace("\\", "").upper()
        rows.append({"bssid": b, "name": names.get(b, ""), "signal": int(m.group(3)), "ch": m.group(4),
                     "band": band_of(int(m.group(5))), "current": b == cur})
    return sorted(rows, key=lambda r: -r["signal"])


def set_pin(profile, ssid, bssid):
    """Pin a saved profile to one access point ('' = clear any pin/band lock = Auto). '' on success."""
    if bssid and not any(r["bssid"] == bssid.upper() for r in ap_rows(ssid)):
        return f"That access point isn't visible right now - tap Scan again."
    out = run(["sudo", "nmcli", "connection", "modify", profile, "802-11-wireless.band", "",
               "802-11-wireless.bssid", bssid.upper()], timeout=20)
    return out.strip() if "error" in out.lower() else ""


def link_status():
    link = run(["/usr/sbin/iw", "dev", WLAN, "link"], timeout=10)
    ssid = (re.search(r"SSID:\s*(.+)", link) or [None, None])[1]
    sig = (re.search(r"signal:\s*(-?\d+)", link) or [None, None])[1]
    route = run(["/bin/sh", "-c", f"ip route show default dev {WLAN} 2>/dev/null | head -1"]).strip()
    internet = "1 received" in run(["ping", "-c", "1", "-W", "2", "1.1.1.1"], timeout=5) if route else False
    vpn = bool(VPN_PEER) and "1 received" in run(["ping", "-c", "1", "-W", "2", VPN_PEER], timeout=5) if internet else False
    b = current_bssid()
    return {"ssid": ssid, "signal": sig, "internet": internet, "vpn": vpn, "ap": ap_names().get(b, "") if b else ""}


@app.get("/api/status")
def status():
    return jsonify(link_status())


# ---- wifi --------------------------------------------------------------------

@app.post("/api/scan")
def scan():
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
            nets[ssid] = {"ssid": ssid, "signal": s, "secured": bool(sec.strip())}
    return jsonify({"networks": sorted(nets.values(), key=lambda n: -n["signal"])})


def wifi_profiles():
    """name -> ssid for every saved WiFi profile."""
    prof = {}
    for line in run(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"]).splitlines():
        if line.endswith(":802-11-wireless"):
            name = line[: -len(":802-11-wireless")]
            s = run(["nmcli", "-t", "-f", "802-11-wireless.ssid", "connection", "show", name]).strip()
            prof[name] = s.split(":", 1)[1] if ":" in s else s
    return prof


def active_ssid():
    return (re.search(r"SSID:\s*(.+)", run(["/usr/sbin/iw", "dev", WLAN, "link"], timeout=10)) or [None, None])[1]


def security_of(ssid, rescan=False):
    """SECURITY string for an in-range SSID ('' = open), or None if not seen."""
    out = run(["sudo", "nmcli", "-t", "-f", "SSID,SECURITY", "dev", "wifi", "list",
               "ifname", WLAN, "--rescan", "yes" if rescan else "no"], timeout=40)
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) >= 2 and ":".join(parts[:-1]) == ssid:
            return parts[-1].strip()
    return None


def do_join(ssid, pw, bssid=""):
    """Returns (ok, message). Handles the nmcli traps:
    - a network that's already SAVED must be activated (not re-created), or nmcli
      fails with '802-11-wireless-security.key-mgmt: property is missing'
    - never send a password to an OPEN network (same error)
    - a secured network with no password fails later with a confusing message
    """
    profiles = wifi_profiles()
    saved_name = next((n for n, s in profiles.items() if n == ssid or s == ssid), None)

    if saved_name:
        if ssid == active_ssid() and not pw and (current_bssid() == bssid.upper() if bssid else True):
            if not bssid:
                set_pin(saved_name, ssid, "")
            return True, f"Already connected to {ssid}."
        if pw:
            km = run(["nmcli", "-t", "-f", "802-11-wireless-security.key-mgmt",
                      "connection", "show", saved_name]).strip()
            if km and not km.endswith(":"):
                m = run(["sudo", "nmcli", "connection", "modify", saved_name,
                         "802-11-wireless-security.psk", pw], timeout=20)
                if "error" in m.lower():
                    return False, "Couldn't update the saved password:\n" + m.strip()
        err = set_pin(saved_name, ssid, bssid)
        if err:
            return False, err
        out = run(["sudo", "nmcli", "connection", "up", saved_name, "ifname", WLAN], timeout=45)
        ok = "successfully activated" in out.lower()
        if not ok and bssid:
            set_pin(saved_name, ssid, "")
            run(["sudo", "nmcli", "connection", "up", saved_name, "ifname", WLAN], timeout=45)
            return False, "Couldn't connect to that access point - went back to Auto.\n" + out.strip()
        return ok, out.strip()

    sec = security_of(ssid)
    if sec is None:
        sec = security_of(ssid, rescan=True)
    if sec is None:
        return False, f"'{ssid}' isn't in range right now — tap Scan again."
    if "802.1X" in sec:
        return False, "That's an enterprise (802.1X) network — it needs a username/certificate, which this page can't do."
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
        # NM couldn't infer the security type; build the profile explicitly.
        km = "sae" if ("WPA3" in sec and "WPA2" not in sec and "WPA1" not in sec) else "wpa-psk"
        run(["sudo", "nmcli", "connection", "delete", ssid], timeout=20)
        run(["sudo", "nmcli", "connection", "add", "type", "wifi", "ifname", WLAN,
             "con-name", ssid, "ssid", ssid, "wifi-sec.key-mgmt", km, "wifi-sec.psk", pw], timeout=20)
        out = run(["sudo", "nmcli", "connection", "up", ssid, "ifname", WLAN], timeout=45)
        ok = "successfully activated" in out.lower()
    if not ok:
        run(["sudo", "nmcli", "connection", "delete", ssid], timeout=20)   # drop the half-made profile
    elif bssid and current_bssid() != bssid.upper():
        err = set_pin(ssid, ssid, bssid)
        if err:
            return True, out.strip() + "\n[!] Connected, but could not use that access point: " + err
        out2 = run(["sudo", "nmcli", "connection", "up", ssid, "ifname", WLAN], timeout=45)
        if "successfully activated" in out2.lower():
            out = out2
        else:
            set_pin(ssid, ssid, "")
            run(["sudo", "nmcli", "connection", "up", ssid, "ifname", WLAN], timeout=45)
            out = out.strip() + "\n[!] Couldn't move to that access point - staying on Auto."
    return ok, out.strip()


@app.post("/api/join")
def join():
    data = request.get_json(silent=True) or {}
    ssid, pw = str(data.get("ssid", "")), str(data.get("password", ""))
    if not VALID_SSID.match(ssid):
        return jsonify({"error": "invalid ssid"}), 400
    bssid = str(data.get("bssid", "")).strip().replace("-", ":")
    if bssid and not VALID_MAC.match(bssid):
        return jsonify({"error": "invalid access point"}), 400
    ok, msg = do_join(ssid, pw, bssid)
    if ok:
        done[request.remote_addr or ""] = time.time()   # stop the sign-in nag
    b = current_bssid() if ok else ""
    return jsonify({"ok": ok, "output": msg, "ap": ap_names().get(b, "") if b else "", "bssid": b})


@app.post("/api/aps")
def aps():
    data = request.get_json(silent=True) or {}
    ssid = str(data.get("ssid", ""))
    if not VALID_SSID.match(ssid):
        return jsonify({"error": "invalid ssid"}), 400
    return jsonify({"aps": ap_rows(ssid, bool(data.get("rescan")))})


@app.get("/api/saved")
def saved():
    active = set()
    for line in run(["nmcli", "-t", "-f", "NAME,DEVICE", "connection", "show", "--active"]).splitlines():
        if line.endswith(":" + WLAN):
            active.add(line[: -(len(WLAN) + 1)])
    names = []
    for line in run(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"]).splitlines():
        if line.endswith(":802-11-wireless"):
            n = line[: -len(":802-11-wireless")]
            if not PROTECTED.search(n):
                names.append({"name": n, "active": n in active})
    names.sort(key=lambda x: (not x["active"], x["name"].lower()))
    return jsonify({"profiles": names})


@app.post("/api/forget")
def forget():
    """Force-delete a saved network — even if it's the one currently connected.
    Safe from the hotspot: your phone stays on wlan0 while wlan1 drops."""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", ""))
    if not VALID_NAME.match(name) or PROTECTED.search(name):
        return jsonify({"error": "refused"}), 400
    out = run(["sudo", "nmcli", "connection", "delete", name], timeout=20)
    return jsonify({"ok": "deleted" in out.lower(), "output": out.strip()})


@app.post("/api/done")
def mark_done():
    done[request.remote_addr or ""] = time.time()
    return jsonify({"ok": True})


# ---- the page ----------------------------------------------------------------

PAGE = r"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jarvis Pi — WiFi Setup</title>
<style>
  :root{--bg:#0a1424;--panel:#14223c;--border:#27395a;--text:#e6ecf5;--muted:#93a1bd;
        --orange:#f97316;--blue:#3b82f6;--grey:#4a5b76;--red:#dc2626;--green:#4ade80}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:16px -apple-system,"Segoe UI",Roboto,sans-serif;padding:14px}
  h1{font-size:20px;margin:6px 0 2px;border-left:4px solid var(--orange);padding-left:10px}
  .sub{color:var(--muted);font-size:13px;margin:0 0 14px 14px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:14px}
  .t{font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:var(--orange);font-weight:700;margin-bottom:10px}
  button{width:100%;padding:14px;font-size:16px;font-weight:600;border:0;border-radius:10px;background:var(--orange);color:#10151f;margin-top:8px}
  button.b{background:var(--blue);color:#fff}button.g{background:var(--grey);color:#fff}button.r{background:var(--red);color:#fff}
  button:disabled{background:#2a3450;color:var(--muted)}
  select{width:100%;padding:13px;font-size:16px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);margin-top:8px}
  input{width:100%;padding:13px;font-size:16px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);margin-top:8px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);margin-top:8px}
  .row.sel{border-color:var(--orange);box-shadow:0 0 0 1px var(--orange) inset}
  .row .n{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .s{color:var(--muted);font-size:13px;flex:0 0 auto}
  .row button{width:auto;margin:0;padding:8px 12px;font-size:14px;flex:0 0 auto}
  .ok{color:var(--green);font-weight:600}.bad{color:#f87171;font-weight:600}.muted{color:var(--muted)}
  #msg{margin-top:10px;white-space:pre-wrap;font-size:14px}
  #nets{max-height:260px;overflow-y:auto;-webkit-overflow-scrolling:touch}
  .bar{height:8px;background:#1b2a48;border-radius:6px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--orange)}
</style></head><body>
<h1>Jarvis Pi — WiFi Setup</h1>
<p class="sub">Get the Pi online, then use the Jarvis Net Tools app<br>This hotspot is for setup only — it has no internet. When you're finished, tap Done, then switch your phone back to its normal WiFi.</p>

<div class="card"><div class="t">Pi status</div>
  <div id="status" class="muted">Checking…</div>
  <button id="refresh" class="g">Refresh</button>
</div>

<div class="card"><div class="t">Nearby networks</div>
  <div id="nets" class="muted">Scanning…</div>
  <button id="rescan" class="b">Scan again</button>
  <div id="apbox"><div class="muted" style="font-size:13px;margin-top:12px">Access point (optional) — pick the room you are in</div>
    <select id="ap" disabled><option value="">Tap a network above first</option></select></div>
  <input type="password" id="pw" placeholder="Password for the selected network (blank = open)">
  <button id="join" disabled>Join selected network</button>
  <div id="msg"></div>
</div>

<div class="card"><div class="t">Saved networks</div>
  <div id="saved" class="muted">Loading…</div>
  <p class="muted" style="font-size:13px;margin:10px 0 0">Forget deletes the password from the Pi — even if it's the one connected right now. (Your phone stays on the hotspot.)</p>
</div>

<button id="done" class="g">Done — close this</button>
<script>
const $=id=>document.getElementById(id);
let selected=null, savedNames=new Set(), currentSsid=null, netInfo={};
async function api(p,b){const r=await fetch(p,{method:b?'POST':'GET',headers:b?{'Content-Type':'application/json'}:{},body:b?JSON.stringify(b):undefined});return r.json();}
async function status(){
  $('status').innerHTML='Checking…';
  try{const s=await api('/api/status');currentSsid=s.ssid||null;
    const line=s.ssid?`<span class="ok">Connected to ${s.ssid}</span> <span class="muted">(${s.signal} dBm${s.ap?' · '+s.ap:''})</span>`:`<span class="bad">Not on WiFi</span>`;
    $('status').innerHTML=line+`<div class="muted" style="margin-top:6px">Internet: ${s.internet?'<span class="ok">yes</span>':'<span class="bad">no</span>'} · Jarvis link: ${s.vpn?'<span class="ok">up — app ready</span>':'<span class="muted">down</span>'}</div>`;
  }catch(e){$('status').textContent='Could not read status.';}
}
function pick(el,ssid){document.querySelectorAll('.row.sel').forEach(x=>x.classList.remove('sel'));el.classList.add('sel');selected=ssid;$('join').disabled=false;
  const open=netInfo[ssid]&&!netInfo[ssid].secured, saved=savedNames.has(ssid);
  $('pw').disabled=open;$('pw').value='';
  $('pw').placeholder=open?'Open network — no password needed':saved?'Saved — password only if it changed':'Password for '+ssid;
  loadAps(ssid);
  $('join').textContent=ssid===currentSsid?'Already connected — reconnect '+ssid:saved?'Connect '+ssid+' (saved)':'Join '+ssid;}
async function loadAps(ssid){
  const sel=$('ap');sel.disabled=true;sel.innerHTML='<option value="">Loading access points…</option>';
  try{const d=await api('/api/aps',{ssid});const aps=d.aps||[];sel.innerHTML='<option value="">Auto (best signal)</option>';
    aps.forEach(a=>{const o=document.createElement('option');o.value=a.bssid;
      o.textContent=(a.name?a.name+' · ':'')+a.bssid.slice(-8)+' · '+a.band+'G ch'+a.ch+' · '+a.signal+'%'+(a.current?' ◀ connected':'');sel.appendChild(o);});
    sel.disabled=false;
    if(aps.length<2)sel.options[0].textContent='Auto (only one access point seen)';
  }catch(e){sel.innerHTML='<option value="">Auto (best signal)</option>';sel.disabled=false;}
}
async function scan(){
  $('nets').textContent='Scanning… (about 10s)';$('join').disabled=true;selected=null;
  try{const d=await api('/api/scan',{});const nets=d.networks||[];
    if(!nets.length){$('nets').textContent='No networks found. Try Scan again.';return;}
    $('nets').innerHTML='';netInfo={};
    nets.forEach(n=>{netInfo[n.ssid]=n;const r=document.createElement('div');r.className='row';
      r.innerHTML=`<div style="flex:1;min-width:0"><div class="n">${n.secured?'🔒 ':''}${n.ssid}</div><div class="bar"><i style="width:${n.signal}%"></i></div></div><div class="s">${n.signal}%</div>`;
      r.onclick=()=>{pick(r,n.ssid);$('apbox').scrollIntoView({block:'nearest',behavior:'smooth'});};$('nets').appendChild(r);
      if(n.ssid===currentSsid&&!selected)pick(r,n.ssid);});
  }catch(e){$('nets').textContent='Scan failed — try again.';}
}
async function join(){
  if(!selected)return;$('join').disabled=true;$('msg').textContent='Connecting to '+selected+' … (10–30s)';
  try{const d=await api('/api/join',{ssid:selected,password:$('pw').value,bssid:$('ap').value});$('pw').value='';
    $('msg').innerHTML=d.ok?`<span class="ok">✅ Connected to ${selected}${d.ap?' · '+d.ap:''}.</span>\nThis page stays open — tap “Done — close this” when you're finished. Then open the Jarvis Net Tools app`:`<span class="bad">❌ Could not connect.</span>\n${d.output||''}\n(Wrong password? Out of range?)`;
    saved();setTimeout(status,3000);
  }catch(e){$('msg').textContent='Request failed — the Pi may be switching networks. Tap Refresh in a moment.';}
  $('join').disabled=false;
}
async function saved(){
  try{const d=await api('/api/saved');const p=d.profiles||[];
    savedNames=new Set(p.map(x=>x.name));
    if(!p.length){$('saved').textContent='Nothing saved.';return;}
    $('saved').innerHTML='';
    p.forEach(x=>{const r=document.createElement('div');r.className='row';
      r.innerHTML=`<div class="n" style="flex:1;min-width:0">${x.name}${x.active?' <span class="ok">• connected</span>':''}</div>`;
      if(!x.active){const c=document.createElement('button');c.className='b';c.textContent='Connect';
        c.onclick=async()=>{c.disabled=true;c.textContent='…';$('msg').textContent='Connecting to '+x.name+' … (10–30s)';
          try{const d=await api('/api/join',{ssid:x.name,password:''});$('msg').innerHTML=d.ok?`<span class="ok">✅ Connected to ${x.name}.</span>`:`<span class="bad">❌ Could not connect.</span>\n${d.output||''}`;}catch(e){$('msg').textContent='Request failed — the Pi may be switching networks. Tap Refresh in a moment.';}
          saved();setTimeout(status,3000);};
        r.appendChild(c);}
      const b=document.createElement('button');b.className='r';b.textContent='Forget';
      b.onclick=async()=>{if(!confirm('Forget "'+x.name+'"?'+(x.active?'\n\nIt is connected right now — the Pi will disconnect from it.':'')))return;
        b.disabled=true;b.textContent='…';const res=await api('/api/forget',{name:x.name});
        if(!res.ok){alert('Could not forget: '+(res.output||res.error||''));}saved();setTimeout(status,2000);};
      r.appendChild(b);$('saved').appendChild(r);});
  }catch(e){$('saved').textContent='Could not load.';}
}
$('refresh').onclick=status;$('rescan').onclick=scan;$('join').onclick=join;
// Captive mini-browsers only re-test the network after a page LOAD, so after
// signing in we navigate (not just fetch) — the phone re-probes, gets "success",
// and closes the sheet (Android) or enables its Done button (iPhone).
async function signedIn(){try{await api('/api/done',{});}catch(e){}location.replace('/?signedin=1');}
$('done').onclick=()=>{$('done').textContent='Closing…';$('done').disabled=true;signedIn();};
if(location.search.indexOf('signedin=1')>=0){
  const b=document.createElement('div');b.className='card';b.style.borderColor='#4ade80';
  b.innerHTML='<div class="t" style="color:#4ade80">✅ Signed in</div>You can close this window now, then disconnect from JarvisPi-Manage in your phone WiFi settings (this hotspot has no internet).<div class="muted" style="font-size:13px;margin-top:8px">If it stays open: <b>iPhone</b> → tap <b>Done</b> at the top · <b>Android</b> → tap <b>⋮</b> → <b>Use this network as is</b></div>';
  document.body.insertBefore(b,document.body.children[2]);
  $('done').textContent='Signed in — safe to close';$('done').disabled=true;
}
status();scan();saved();
</script></body></html>"""


@app.get("/")
def page():
    return Response(PAGE, mimetype="text/html")


@app.route("/<path:_any>")
def fallback(_any):
    # Any unknown path on the splash host -> the page (keeps mini-browsers happy).
    return redirect("/", code=302)


if __name__ == "__main__":
    # The hotspot address only exists while the AP is up; wait for it.
    while True:
        try:
            s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((BIND, PORT)); s.close()
            break
        except OSError:
            time.sleep(3)
    app.run(host=BIND, port=PORT, threaded=True)
