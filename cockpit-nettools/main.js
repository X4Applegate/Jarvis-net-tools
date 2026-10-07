const output = document.getElementById("output");
const status = document.getElementById("status");
const buttons = document.querySelectorAll("button");

function setRunning(label) {
  buttons.forEach(b => b.disabled = true);
  status.classList.add("working");
  status.textContent = "⏳ " + label + " — working, please wait…";
  output.textContent = "Working…";
}
function done() {
  buttons.forEach(b => b.disabled = false);
  status.classList.remove("working");
  status.textContent = "";
}

// Root commands run through Cockpit's own privilege escalation (the
// "Administrative access" toggle at the top of the page), NOT by embedding
// "sudo" in a shell -- this account requires a password for sudo, and there
// is no terminal for a spawned process to type it into. superuser:"require"
// uses Cockpit's already-authenticated root bridge instead.
function spawnOpts(root) {
  const o = { err: "out" };
  if (root) o.superuser = "require";
  return o;
}

function rootHint(ex) {
  const m = (ex && (ex.message || ex.problem)) || "";
  if (/not-authorized|not-found|access-denied|Administrator|superuser|permission/i.test(m)) {
    return "\n\n[needs admin] Click \"Administrative access\" at the very top of Cockpit, then run this again.";
  }
  return "";
}

// Appends a timestamped record of a run to a persistent history log on the
// Pi. Uses stdin (proc.input) rather than embedding text in a shell command,
// so it's safe regardless of what characters are in the captured output.
function logHistory(label, target, text) {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const header = "\n===== [" + ts + "] " + label + (target ? " -> " + target : "") + " =====\n";
  const proc = cockpit.spawn(
    ["/bin/sh", "-c", "mkdir -p ~/.nettools && cat >> ~/.nettools/history.log"],
    { err: "ignore" }
  );
  proc.input(header + text, false);
}

// Runs a fixed shell command line via /bin/sh -c, streaming output live and
// recording it in history. opts.root=true escalates via Cockpit.
function runShell(label, shellLine, opts) {
  opts = opts || {};
  setRunning(label);
  let first = true;
  const proc = cockpit.spawn(["/bin/sh", "-c", shellLine], spawnOpts(opts.root));
  proc.stream(data => {
    if (first) { output.textContent = ""; first = false; }
    output.textContent += data;
  });
  proc.then(() => { if (!opts.skipLog) logHistory(label, null, output.textContent); done(); })
      .catch(ex => {
        output.textContent += "\n\n[error] " + (ex.message || JSON.stringify(ex)) + rootHint(ex);
        if (!opts.skipLog) logHistory(label, null, output.textContent);
        done();
      });
}

// Runs argv directly (NOT through a shell) so a user-supplied value can never
// be interpreted as shell syntax. opts.root=true escalates via Cockpit.
function runArgv(label, argv, target, opts) {
  opts = opts || {};
  setRunning(label + (target ? " -> " + target : ""));
  const proc = cockpit.spawn(argv, spawnOpts(opts.root));
  proc.stream(data => { output.textContent += data; });
  proc.then(() => { if (!opts.skipLog) logHistory(label, target, output.textContent); done(); })
      .catch(ex => {
        output.textContent += "\n\n[error] " + (ex.message || JSON.stringify(ex)) + rootHint(ex);
        if (!opts.skipLog) logHistory(label, target, output.textContent);
        done();
      });
}

// Reads and validates the target-input box. Only letters, digits, dots,
// hyphens, and colons (for IPv6) allowed, and must not start with "-" so it
// can never be mistaken for a flag by ping/dig/nmap/mtr.
function getTarget() {
  const raw = document.getElementById("target-input").value.trim();
  if (!raw) {
    output.textContent = "Enter a hostname or IP in the box first.";
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$/.test(raw)) {
    output.textContent = "[blocked] Invalid target — only letters, numbers, dots, hyphens, or colons allowed.";
    return null;
  }
  return raw;
}

document.getElementById("btn-wifi").onclick = () =>
  runShell("WiFi Status",
    "echo '--- interface ---'; /usr/sbin/iw dev; echo; echo '--- link ---'; /usr/sbin/iw dev wlan0 link");

document.getElementById("btn-scan").onclick = () => {
  setRunning("Find Devices + identify (~30s)");
  ntApi.post("/api/devices", "{}", { "Content-Type": "application/json" }).then(txt => {
    const h = (JSON.parse(txt).hosts || []);
    output.textContent = h.length ? "Devices (" + h.length + "):\n\n" + h.map(x => x.ip.padEnd(16) + (x.name || "—").slice(0, 24).padEnd(26) + (x.type || "").slice(0, 26).padEnd(28) + x.vendor.slice(0, 26) + "\n" + " ".repeat(16) + x.mac + (x.info ? "  · " + x.info : "")).join("\n") : "none found";
    logHistory("Find Devices", null, output.textContent); done();
  }).catch(ex => { output.textContent = "[error] " + (ex.message || ex.problem) + "\n\nIs the Jarvis Net Tools service running?  sudo systemctl status jarvis-nettools"; done(); });
};

document.getElementById("btn-ports").onclick = () =>
  runShell("Open Ports", "ss -tulpn", { root: true });

document.getElementById("btn-ping").onclick = () =>
  runShell("Ping Gateway",
    "GW=$(ip route | awk '/default/ {print $3; exit}'); echo Gateway: $GW; ping -c 5 $GW");

document.getElementById("btn-bw").onclick = () =>
  runShell("Bandwidth Right Now", "vnstat -tr 5 -i wlan1");

document.getElementById("btn-mtr").onclick = () =>
  runShell("Path to Internet", "mtr -r -c 5 8.8.8.8");

document.getElementById("btn-speed").onclick = () =>
  runShell("Speed Test (~30s)",
    "echo 'Running official Ookla speed test (picks a nearby server)…'; echo; " +
    "speedtest --accept-license --accept-gdpr --progress=no 2>&1");

document.getElementById("btn-wifiscan").onclick = () =>
  runShell("Scan All WiFi Networks (Alfa wlan1)",
`nmcli -t -f SIGNAL,CHAN,SSID dev wifi list ifname wlan1 --rescan yes 2>&1 | awk -F: '{sig=$1; ch=$2; ssid=$3; for(i=4;i<=NF;i++) ssid=ssid":"$i; printf "ch %-4s  %-5s  %s\\n", ch, sig"%", (ssid==""?"(hidden)":ssid)}' | sort -k3 -rn -u
echo
echo "(Uses nmcli on the Alfa — works while connected. Signal shown as a 0-100% strength.)"`,
    { root: true });

// --- WiFi channel analyzer ---
// Scans on wlan1 (Alfa, so wlan0's real connection is untouched), groups
// access points by channel, and renders a text congestion chart per band with
// a best-channel recommendation. Emits one "freq signal" pair per AP; all the
// grouping/rendering happens here in JS.

function analyzeChannels(pairs) {
  // pairs: array of [freqMHz, signalDbm]
  const chan24 = {}, chan5 = {};   // channel -> {count, best}
  function bump(map, ch, sig) {
    if (!map[ch]) map[ch] = { count: 0, best: -999 };
    map[ch].count++;
    if (sig > map[ch].best) map[ch].best = sig;
  }
  pairs.forEach(([f, s]) => {
    if (f >= 2400 && f < 2500) {
      const ch = (f === 2484) ? 14 : Math.round((f - 2407) / 5);
      bump(chan24, ch, s);
    } else if (f >= 5000 && f < 5900) {
      const ch = Math.round((f - 5000) / 5);
      bump(chan5, ch, s);
    }
  });

  function bar(n, max) {
    const width = 22;
    const len = max > 0 ? Math.round((n / max) * width) : 0;
    return "#".repeat(Math.max(len, n > 0 ? 1 : 0)).padEnd(width, ".");
  }

  function renderBand(title, map, order) {
    const chans = order || Object.keys(map).map(Number).sort((a, b) => a - b);
    if (chans.length === 0) return title + "\n  (no networks seen)\n";
    const max = Math.max(...chans.map(c => (map[c] ? map[c].count : 0)), 1);
    let out = title + "\n";
    chans.forEach(c => {
      const info = map[c] || { count: 0, best: null };
      const sig = info.best && info.best > 0 ? "  strongest " + info.best + "%" : "";
      out += "  ch " + String(c).padStart(3) + "  " + bar(info.count, max) +
             "  " + info.count + (info.count === 1 ? " AP" : " APs") + sig + "\n";
    });
    return out;
  }

  // 2.4GHz recommendation: among non-overlapping 1/6/11, least overlap-weighted.
  function best24() {
    const cands = [1, 6, 11];
    let bestCh = null, bestScore = Infinity;
    cands.forEach(c => {
      let score = 0;
      Object.keys(chan24).forEach(k => {
        const ch = +k, overlap = 5 - Math.abs(ch - c);   // channels overlap within ~4
        if (overlap > 0) score += chan24[k].count * overlap;
      });
      if (score < bestScore) { bestScore = score; bestCh = c; }
    });
    return bestCh;
  }

  // 5GHz recommendation: least-used among common 20MHz UNII channels.
  function best5() {
    const cands = [36, 40, 44, 48, 149, 153, 157, 161];
    let bestCh = null, bestScore = Infinity;
    cands.forEach(c => {
      const score = chan5[c] ? chan5[c].count : 0;
      if (score < bestScore) { bestScore = score; bestCh = c; }
    });
    return bestCh;
  }

  let out = "";
  out += renderBand("=== 2.4 GHz (channels 1-14) ===", chan24,
                    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].filter(c => chan24[c]));
  out += "  >> Best 2.4GHz channel: " + best24() + " (use 1, 6, or 11 only)\n\n";
  out += renderBand("=== 5 GHz ===", chan5);
  out += "  >> Suggested 5GHz channel: " + best5() + " (least busy of the common ones)\n";
  return out;
}

document.getElementById("btn-chan").onclick = () => {
  setRunning("Channel Analyzer (Alfa wlan1)");
  const bar2 = (n, max) => { const w = 18, len = max > 0 ? Math.round((n / max) * w) : 0; return "#".repeat(Math.max(len, n > 0 ? 1 : 0)).padEnd(w, "."); };
  const band = (title, map) => {
    const chans = Object.keys(map).map(Number).sort((x, y) => x - y);
    if (!chans.length) return title + "\n  (none seen)\n";
    const max = Math.max(...chans.map(c => map[c].count), 1);
    return title + "\n" + chans.map(c => { const e = map[c]; const names = (e.ssids || []).map(x => x.ssid + " " + x.sig + "%").join(", ");
      return "  ch " + String(c).padStart(3) + "  " + bar2(e.count, max) + "  " + e.count + (e.count === 1 ? " AP " : " APs") + (names ? "\n         " + names : ""); }).join("\n") + "\n";
  };
  const best24 = m => { let bc = null, bs = Infinity; [1, 6, 11].forEach(c => { let sc = 0; Object.keys(m).forEach(k => { const ov = 5 - Math.abs(+k - c); if (ov > 0) sc += m[k].count * ov; }); if (sc < bs) { bs = sc; bc = c; } }); return bc; };
  const best5 = m => { let bc = null, bs = Infinity; [36, 40, 44, 48, 149, 153, 157, 161].forEach(c => { const sc = m[c] ? m[c].count : 0; if (sc < bs) { bs = sc; bc = c; } }); return bc; };
  ntApi.post("/api/channel", "{}", { "Content-Type": "application/json" }).then(txt => {
    const d = JSON.parse(txt);
    let s = band("=== 2.4 GHz ===", d.band24 || {}) + "  >> Best 2.4GHz: channel " + best24(d.band24 || {}) + " (1/6/11 only)\n\n";
    s += band("=== 5 GHz ===", d.band5 || {}) + "  >> Suggested 5GHz: channel " + best5(d.band5 || {}) + "\n\n";
    s += band("=== 6 GHz (WiFi 6E) ===", d.band6 || {});
    output.textContent = s; logHistory("Channel Analyzer", null, s); done();
  }).catch(ex => { output.textContent = "[error] " + (ex.message || ex.problem); done(); });
};

document.getElementById("btn-monitor").onclick = () =>
  runShell("Monitor-Mode Capture (30s) — borrows the Alfa briefly",
`set +e
mkdir -p /var/lib/jarvis-nettools/captures
FILE=/var/lib/jarvis-nettools/captures/capture-$(date +%Y%m%d-%H%M%S).pcap
# Remember which network wlan1 is on so we can put it back afterwards.
PREV=$(nmcli -t -f NAME,DEVICE connection show --active | awk -F: '$2=="wlan1"{print $1; exit}')
echo "Borrowing the Alfa (wlan1) for monitor mode — its WiFi link drops for ~30s,"
echo "then reconnects to: \${PREV:-(nothing was connected)}"
nmcli device disconnect wlan1 >/dev/null 2>&1
ip link set wlan1 down
iw dev wlan1 set type monitor
ip link set wlan1 up
echo "Capturing raw 802.11 frames for 30 seconds..."
timeout 30 tcpdump -i wlan1 -w "$FILE" 2>&1 | tail -5
# Restore managed mode and reconnect to whatever was active before.
ip link set wlan1 down
iw dev wlan1 set type managed
ip link set wlan1 up
[ -n "$PREV" ] && nmcli connection up "$PREV" ifname wlan1 >/dev/null 2>&1
chmod 644 "$FILE"
echo
echo "Saved: $FILE"
echo "Packets: $(tcpdump -r "$FILE" 2>/dev/null | wc -l)"
echo "Alfa reconnected\${PREV:+ to $PREV}. Open the file via the Navigator tab (/var/lib/jarvis-nettools/captures) for Wireshark."`,
    { root: true });

// --- Search / custom-target tools ---

document.getElementById("btn-ping-custom").onclick = () => {
  const t = getTarget();
  if (t) runArgv("Ping", ["ping", "-c", "5", t], t);
};

document.getElementById("btn-portscan-custom").onclick = () => {
  const t = getTarget();
  if (t) runArgv("Port Scan", ["nmap", "-Pn", "-T4", "--top-ports", "100", t], t, { root: true });
};

document.getElementById("btn-dns-custom").onclick = () => {
  const t = getTarget();
  if (t) runArgv("DNS Lookup", ["dig", t], t);
};

document.getElementById("btn-traceroute-custom").onclick = () => {
  const t = getTarget();
  if (t) runArgv("Traceroute", ["mtr", "-r", "-c", "5", t], t);
};

// --- History ---

document.getElementById("btn-history").onclick = () =>
  runShell("History",
    "test -s ~/.nettools/history.log && tail -n 500 ~/.nettools/history.log || echo 'No history yet -- run a tool first.'",
    { skipLog: true });

// --- Clear visited-site WiFi ---
// Runs the wifi-clear helper as root. It keeps your own networks + the active
// connection and removes visited-site saved WiFi. Confirms first since it deletes.
document.getElementById("btn-wifi-clear").onclick = () => {
  if (!window.confirm("Delete saved WiFi for visited sites?\n\nKeeps your home/management networks and the connection you're using right now.")) return;
  runShell("Clear Visited WiFi", "/usr/local/bin/wifi-clear", { root: true });
};

// --- Shared engine: the Jarvis Net Tools API (same backend as the phone app) ---
// Reached over loopback through Cockpit's HTTP bridge; the API trusts 127.0.0.1.
const ntApi = cockpit.http(8092);
function ntCall(label, path, body) {
  setRunning(label);
  const p = body === undefined ? ntApi.get(path)
          : ntApi.post(path, JSON.stringify(body), { "Content-Type": "application/json" });
  p.then(txt => {
      let d; try { d = JSON.parse(txt); } catch (e) { d = { output: txt }; }
      output.textContent = d.output || d.error || JSON.stringify(d, null, 2);
      logHistory(label, null, output.textContent); done();
    })
    .catch(ex => {
      output.textContent = "[error] " + (ex.message || ex.problem || JSON.stringify(ex)) +
        "\n\nIs the Jarvis Net Tools service running?  sudo systemctl status jarvis-nettools";
      done();
    });
}
function fmtT(t) { const d = new Date(t * 1000); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }

document.getElementById("nt-dhcp").onclick = () => ntCall("Rogue DHCP check", "/api/dhcp", {});
document.getElementById("nt-services").onclick = () => ntCall("Service / POS check", "/api/services", {});
document.getElementById("nt-jack").onclick = () => ntCall("Ethernet jack test", "/api/jack", {});
document.getElementById("nt-report").onclick = () => ntCall("Site report", "/api/report?format=md&site=" + encodeURIComponent(window.prompt("Site name for the report:", "") || ""));
document.getElementById("nt-iperf").onclick = () => { const t = getTarget(); if (t) ntCall("iperf3 LAN test -> " + t, "/api/iperf", { target: t }); };
document.getElementById("nt-aps").onclick = () => {
  setRunning("APs & roaming");
  ntApi.post("/api/aps", "{}", { "Content-Type": "application/json" }).then(txt => {
    const d = JSON.parse(txt);
    output.textContent = !d.aps.length ? "No APs seen for " + (d.ssid || "(not connected)") :
      "APs broadcasting \"" + d.ssid + "\":\n\n" + d.aps.map(a => (a.current ? "▶ " : "  ") + a.bssid + "  " + String(a.signal + "%").padStart(4) + "  " + a.band + "G ch " + String(a.ch).padEnd(4) + (a.current ? "  ← connected here" : "")).join("\n") +
      "\n\n▶ = the AP you're on. A stronger one listed above it = sticky client / roaming worth tuning.";
    logHistory("APs & roaming", null, output.textContent); done();
  }).catch(ex => { output.textContent = "[error] " + (ex.message || ex.problem); done(); });
};
document.getElementById("nt-monitor").onclick = () => {
  setRunning("Network Monitor (24h)");
  ntApi.get("/api/netmon/status?hours=24").then(txt => {
    const s = JSON.parse(txt), l = s.last;
    let t = (s.running ? "● monitor running" : "● monitor NOT running") + "\n\n";
    t += s.uptime_pct == null ? "No samples yet.\n" : "Internet up " + s.uptime_pct + "% of the last 24h · avg " + (s.avg_ms || "?") + " ms · gateway up " + s.gateway_pct + "%\n";
    if (l) t += "Last check " + fmtT(l.ts) + ": " + (l.inet_ok ? "online" : "OFFLINE") + (l.ssid ? " via " + l.ssid : "") + (l.inet_ms ? " " + l.inet_ms + " ms" : "") + "\n";
    if (s.current_outage) t += "\n⚠ OUTAGE IN PROGRESS since " + fmtT(s.current_outage.start_ts) + " — " + s.current_outage.detail + "\n";
    const ev = (s.outages || []).filter(o => o.end_ts);
    t += "\nOutages:\n" + (ev.length ? ev.map(o => "  " + fmtT(o.start_ts) + "  " + Math.round((o.end_ts - o.start_ts) / 60) + " min  " + o.kind + " — " + o.detail).join("\n") : "  none recorded");
    output.textContent = t; done();
  }).catch(ex => { output.textContent = "[error] " + (ex.message || ex.problem); done(); });
};
document.getElementById("nt-speedhist").onclick = () => {
  setRunning("Speed history");
  ntApi.get("/api/netmon/speed?hours=168").then(txt => {
    const r = JSON.parse(txt).rows || [];
    output.textContent = !r.length ? "No speed tests logged yet." :
      "Last 7 days (" + r.length + " tests):\n\n" + "when              down     up     ping   grade  source\n" +
      r.slice(-30).reverse().map(x => fmtT(x.ts).padEnd(18) + String(x.down).padStart(6) + String(x.up).padStart(7) + String(x.ping).padStart(8) + "  " + String(x.grade).padEnd(5) + "  " + x.source).join("\n");
    done();
  }).catch(ex => { output.textContent = "[error] " + (ex.message || ex.problem); done(); });
};
// Speed Test now goes through the engine too (graded + logged to history).
document.getElementById("btn-speed").onclick = () => ntCall("Speed Test (~30s, graded)", "/api/speedtest", {});

// --- Safe shutdown with countdown ---
document.getElementById("btn-shutdown").onclick = () => {
  if (!window.confirm("Shut down the Pi now?\n\nAll access stops. To turn it back on you'll unplug and re-plug the power.")) return;
  // Fire the poweroff (the Pi halts a few seconds later); count down client-side.
  cockpit.spawn(["shutdown", "-h", "now"], { superuser: "require", err: "out" }).catch(() => {});
  buttons.forEach(b => b.disabled = true);
  let n = 30;
  const tick = () => {
    if (n <= 0) {
      clearInterval(t);
      status.classList.remove("working");
      status.textContent = "";
      output.textContent = "✅ SAFE TO UNPLUG NOW.\n\nThe Pi should be fully off (green LED dark).\nTo restart: unplug the power, wait a few seconds, plug back in.";
      return;
    }
    status.classList.add("working");
    status.textContent = "Shutting down…";
    output.textContent = "⏻ Pi is shutting down — do NOT unplug yet.\n\n" +
      "SAFE TO UNPLUG IN:  " + n + "s\n\n" +
      "(or the instant the Pi's green ACT LED stops flashing and goes dark — that's the true signal)\n\n" +
      "To turn it back on later: unplug, wait a few seconds, plug the power back in.";
    n--;
  };
  tick(); const t = setInterval(tick, 1000);
};

// --- Saved WiFi profile switcher ---
// Reads saved WiFi profiles and the active connection straight from
// NetworkManager, so this always reflects reality. Add profiles anytime and
// hit "Refresh List".

const wifiSelect = document.getElementById("wifi-select");
const wifiCurrent = document.getElementById("wifi-current");

function refreshWifiCurrent() {
  cockpit.spawn(["nmcli", "-t", "-f", "NAME,DEVICE", "connection", "show", "--active"], { err: "ignore" })
    .then(data => {
      // wlan1 (Alfa) is the real connection; wlan0 is the management AP.
      const line = data.split("\n").find(l => l.endsWith(":wlan1"));
      wifiCurrent.innerHTML = line
        ? "Currently connected: <span class=\"live\">" + line.slice(0, -(":wlan1".length)) + "</span>"
        : "Currently connected: <span class=\"live\">(not on WiFi)</span>";
    })
    .catch(() => { wifiCurrent.textContent = "Currently connected: (unable to check)"; });
}

function refreshWifiList() {
  wifiSelect.innerHTML = "<option>Loading saved networks...</option>";
  cockpit.spawn(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"], { err: "ignore" })
    .then(data => {
      const suffix = ":802-11-wireless";
      const names = data.split("\n").filter(l => l.endsWith(suffix)).map(l => l.slice(0, -suffix.length));
      wifiSelect.innerHTML = "";
      if (names.length === 0) {
        wifiSelect.innerHTML = "<option>No saved WiFi profiles found</option>";
        return;
      }
      names.forEach(n => {
        const opt = document.createElement("option");
        opt.value = n; opt.textContent = n;
        wifiSelect.appendChild(opt);
      });
    })
    .catch(() => { wifiSelect.innerHTML = "<option>Error loading list</option>"; });
  refreshWifiCurrent();
}

document.getElementById("btn-wifi-refresh").onclick = refreshWifiList;

document.getElementById("btn-wifi-connect").onclick = () => {
  const name = wifiSelect.value;
  if (!name || name.startsWith("No saved") || name.startsWith("Loading") || name.startsWith("Error")) return;
  setRunning("Switch WiFi -> " + name);
  const proc = cockpit.spawn(["nmcli", "connection", "up", name], spawnOpts(true));
  proc.stream(d => { output.textContent += d; });
  proc.then(() => { logHistory("Switch WiFi", name, output.textContent); refreshWifiCurrent(); done(); })
      .catch(ex => {
        output.textContent += "\n\n[error] " + (ex.message || JSON.stringify(ex)) + rootHint(ex);
        logHistory("Switch WiFi", name, output.textContent);
        done();
      });
};

// --- Scan & join a NEW WiFi network ---
// Lists in-range networks on wlan0 (no root needed for the scan) and lets you
// join one by typing its password. The SSID + password are passed to nmcli as
// separate arguments (never a shell string), so nothing in them can be treated
// as a command. The password is NOT written to the history log.

const scanSelect = document.getElementById("scan-select");

document.getElementById("btn-wifi-rescan").onclick = () => {
  scanSelect.innerHTML = "<option>Scanning...</option>";
  status.textContent = "Scanning for WiFi networks...";
  cockpit.spawn(["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "dev", "wifi", "list", "ifname", "wlan1", "--rescan", "yes"], { err: "out" })
    .then(data => {
      status.textContent = "";
      const seen = {};
      data.split("\n").forEach(line => {
        if (!line) return;
        // SSID may contain colons; SIGNAL and SECURITY are the last two fields.
        const parts = line.split(":");
        const security = parts.pop();
        const signal = parts.pop();
        const ssid = parts.join(":");
        if (!ssid) return;                       // skip hidden/blank SSIDs
        if (seen[ssid] && seen[ssid] >= +signal) return;
        seen[ssid] = +signal;
      });
      const rows = Object.keys(seen).map(s => ({ ssid: s, sig: seen[s] }))
        .sort((a, b) => b.sig - a.sig);
      scanSelect.innerHTML = "";
      if (rows.length === 0) {
        scanSelect.innerHTML = "<option>No networks found</option>";
        return;
      }
      rows.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r.ssid;
        opt.textContent = r.ssid + "  (" + r.sig + "%)";
        scanSelect.appendChild(opt);
      });
    })
    .catch(ex => {
      status.textContent = "";
      scanSelect.innerHTML = "<option>Scan failed</option>";
      output.textContent = "[error] " + (ex.message || JSON.stringify(ex)) + rootHint(ex);
    });
};

document.getElementById("btn-wifi-join").onclick = () => {
  const ssid = scanSelect.value;
  const pw = document.getElementById("scan-pass").value;
  if (!ssid || ssid.startsWith("No networks") || ssid.startsWith("Scanning") || ssid.startsWith("Scan failed")) {
    output.textContent = "Pick a network from the scan list first (hit \"Scan\" if it's empty).";
    return;
  }
  setRunning("Join WiFi -> " + ssid);
  // argv form: SSID and password are separate args, never shell-interpreted.
  const argv = ["nmcli", "dev", "wifi", "connect", ssid, "ifname", "wlan1"];
  if (pw) { argv.push("password"); argv.push(pw); }
  const proc = cockpit.spawn(argv, spawnOpts(true));
  proc.stream(d => { output.textContent += d; });
  proc.then(() => {
        // Log the join WITHOUT the password.
        logHistory("Join WiFi", ssid, output.textContent);
        document.getElementById("scan-pass").value = "";
        refreshWifiCurrent();
        refreshWifiList();
        done();
      })
      .catch(ex => {
        output.textContent += "\n\n[error] " + (ex.message || JSON.stringify(ex)) + rootHint(ex);
        logHistory("Join WiFi", ssid, output.textContent);
        done();
      });
};

refreshWifiList();

// --- Admin Access: quick links + LAN admin-page finder ---
// Renders clickable links to admin web UIs. Quick links (gateway, ISP modem)
// populate on load; "Find Admin Pages" scans the local subnet for common web
// admin ports and lists whatever answers as clickable links. Opening these is
// just navigation to a device you're already on the network with.

const adminLinks = document.getElementById("admin-links");

// Port -> {scheme, label}. https-ish ports get https; Omada ports get flagged.
const ADMIN_PORTS = {
  "443":  { scheme: "https", label: "https" },
  "8443": { scheme: "https", label: "https-alt" },
  "8043": { scheme: "https", label: "Omada?" },
  "80":   { scheme: "http",  label: "http" },
  "8080": { scheme: "http",  label: "http-alt" },
  "8088": { scheme: "http",  label: "Omada?" },
};

function makeLink(url, text, tag) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  if (tag) {
    const s = document.createElement("span");
    s.className = "tag";
    s.textContent = tag;
    a.appendChild(s);
  }
  return a;
}

function renderQuickLinks() {
  adminLinks.textContent = "";
  // Default gateway of whatever interface currently carries the default route.
  cockpit.spawn(["/bin/sh", "-c", "ip route | awk '/default/{print $3; exit}'"], { err: "ignore" })
    .then(gw => {
      gw = gw.trim();
      if (gw) {
        adminLinks.appendChild(makeLink("http://" + gw, "Gateway " + gw, "http"));
        adminLinks.appendChild(makeLink("https://" + gw, "Gateway " + gw, "https"));
      }
      // Common ISP modem address.
      adminLinks.appendChild(makeLink("http://192.168.100.1", "ISP Modem", "192.168.100.1"));
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = 'Hit "Find Admin Pages on LAN" to discover the Omada controller, APs, switches, etc.';
      adminLinks.appendChild(note);
    })
    .catch(() => { adminLinks.textContent = "Quick links unavailable."; });
}

document.getElementById("btn-find-admin").onclick = () => {
  setRunning("Find Admin Pages on LAN");
  // Scan the subnet of the interface with the default route (the LAN we're on).
  // Prefer the wlan0 (WiFi we're troubleshooting) subnet; fall back to whatever
  // interface carries the default route.
  const cmd =
    "IF=wlan1; SUB=$(ip -o -f inet addr show \"$IF\" 2>/dev/null | awk '{print $4}' | head -1); " +
    "if [ -z \"$SUB\" ]; then IF=$(ip route | awk '/default/{print $5; exit}'); " +
    "SUB=$(ip -o -f inet addr show \"$IF\" | awk '{print $4}' | head -1); fi; " +
    "echo SUBNET=$SUB on $IF; " +
    "nmap -Pn -T4 --open -p 80,443,8080,8443,8043,8088 -oG - \"$SUB\"";
  const proc = cockpit.spawn(["/bin/sh", "-c", cmd], { err: "out" });
  let raw = "";
  proc.stream(d => { raw += d; });
  proc.then(() => {
        adminLinks.textContent = "";
        const hosts = [];
        raw.split("\n").forEach(line => {
          const m = line.match(/^Host:\s+(\S+).*Ports:\s+(.+)$/);
          if (!m) return;
          const ip = m[1];
          const ports = m[2].split(",").map(p => p.trim())
            .map(p => p.split("/")[0])            // "80/open/tcp//http" -> "80"
            .filter(p => ADMIN_PORTS[p]);
          if (ports.length) hosts.push({ ip, ports });
        });
        if (hosts.length === 0) {
          adminLinks.textContent = "No admin web pages found on this LAN.";
          renderQuickLinks();
          return;
        }
        hosts.forEach(h => {
          h.ports.forEach(p => {
            const cfg = ADMIN_PORTS[p];
            const url = cfg.scheme + "://" + h.ip + (p === "80" || p === "443" ? "" : ":" + p);
            adminLinks.appendChild(makeLink(url, h.ip + ":" + p, cfg.label));
          });
        });
        const summary = "Found " + hosts.length + " device(s) with admin pages. Ports 8043/8088 are likely the Omada controller.";
        output.textContent = summary;
        logHistory("Find Admin Pages", null, raw);
        done();
      })
      .catch(ex => {
        output.textContent = "[error] " + (ex.message || JSON.stringify(ex)) + rootHint(ex);
        done();
      });
};

renderQuickLinks();

// --- More Tools ---------------------------------------------------------

// Public IP + ISP (one-shot).
document.getElementById("btn-pubip").onclick = () =>
  runShell("Public IP & ISP",
    "curl -s --max-time 10 https://ipinfo.io/json || echo 'Lookup failed (no internet?)'");

// DNS resolvers + resolve timing (one-shot).
document.getElementById("btn-dns").onclick = () =>
  runShell("DNS Check",
    "echo '--- resolvers in use ---'; grep -E '^nameserver' /etc/resolv.conf; " +
    "echo; echo '--- resolve google.com ---'; dig google.com | grep -E 'SERVER:|Query time:'");

// Wake-on-LAN (one-shot; MAC validated so it can't be anything but a MAC).
document.getElementById("btn-wol").onclick = () => {
  const mac = document.getElementById("wol-mac").value.trim();
  if (!/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)) {
    output.textContent = "Enter a valid MAC address, e.g. AA:BB:CC:DD:EE:FF";
    return;
  }
  runArgv("Wake-on-LAN", ["wakeonlan", mac], mac);
};

// Live WiFi signal meter (polls wlan1 every 2s; same button toggles stop).
let signalTimer = null;
document.getElementById("btn-signal").onclick = () => {
  const btn = document.getElementById("btn-signal");
  if (signalTimer) { clearInterval(signalTimer); signalTimer = null; btn.textContent = "Live Signal Meter"; status.classList.remove("working"); status.textContent = ""; return; }
  btn.textContent = "Stop Signal Meter";
  status.classList.add("working"); status.textContent = "Live signal — updating every 2s...";
  const poll = () => {
    cockpit.spawn(["/bin/sh", "-c", "/usr/sbin/iw dev wlan1 link"], { err: "out" }).then(d => {
      const sig = (d.match(/signal:\s*(-?\d+)/) || [])[1];
      const ssid = (d.match(/SSID:\s*(.+)/) || [])[1] || "(not connected)";
      const rate = (d.match(/rx bitrate:\s*([\d.]+ \S+)/) || [])[1] || "?";
      if (sig) {
        const n = parseInt(sig, 10);
        const pct = Math.max(0, Math.min(100, 2 * (n + 100)));
        const bar = "#".repeat(Math.round(pct / 5)).padEnd(20, ".");
        const q = n >= -60 ? "STRONG" : n >= -70 ? "OK" : "WEAK";
        output.textContent = ssid + "\n\nsignal: " + sig + " dBm  (" + q + ")\n[" + bar + "] " + pct + "%\nrx rate: " + rate + "\n\n(press Stop Signal Meter to end)";
      } else {
        output.textContent = "wlan1 not connected to WiFi.";
      }
    }).catch(() => {});
  };
  poll(); signalTimer = setInterval(poll, 2000);
};

// Continuous ping monitor (streams until stopped; uses the target box).
let pingProc = null;
document.getElementById("btn-pingmon").onclick = () => {
  const btn = document.getElementById("btn-pingmon");
  if (pingProc) { try { pingProc.close(); } catch (e) {} pingProc = null; btn.textContent = "Ping Monitor"; status.classList.remove("working"); status.textContent = ""; return; }
  const t = getTarget();
  if (!t) return;
  btn.textContent = "Stop Ping Monitor";
  status.classList.add("working"); status.textContent = "Pinging " + t + " continuously...";
  output.textContent = "";
  pingProc = cockpit.spawn(["ping", t], { err: "out" });
  pingProc.stream(d => { output.textContent += d; output.scrollTop = output.scrollHeight; });
  pingProc.catch(() => {});
};

// Device watch (rescans the LAN every 25s, shows who joined/left; toggle).
let devTimer = null;
document.getElementById("btn-devwatch").onclick = () => {
  const btn = document.getElementById("btn-devwatch");
  if (devTimer) { clearInterval(devTimer); devTimer = null; btn.textContent = "Device Watch"; status.classList.remove("working"); status.textContent = ""; return; }
  btn.textContent = "Stop Device Watch";
  status.classList.add("working"); status.textContent = "Watching the LAN — rescans every 25s...";
  let prev = null;
  const scan = () => {
    cockpit.spawn(["/bin/sh", "-c", "IF=$(ip route | awk '/default/{print $5; exit}'); cd /usr/share/arp-scan && arp-scan --localnet --interface=\"${IF:-wlan1}\""], spawnOpts(true)).then(d => {
      const now = new Map();
      const lines = [];
      d.split("\n").forEach(l => {
        const m = l.match(/^(\d+\.\d+\.\d+\.\d+)\s+(\S+)\s+(.*)$/);
        if (m) { now.set(m[1], m[2]); lines.push(m[1].padEnd(16) + m[2] + "  " + m[3]); }
      });
      let out = "Devices on LAN (" + now.size + "):\n" + lines.join("\n");
      if (prev) {
        const joined = [...now.keys()].filter(ip => !prev.has(ip));
        const left = [...prev.keys()].filter(ip => !now.has(ip));
        if (joined.length) out += "\n\n+ JOINED: " + joined.join(", ");
        if (left.length) out += "\n- LEFT: " + left.join(", ");
        if (!joined.length && !left.length) out += "\n\n(no changes since last scan)";
      }
      prev = now;
      output.textContent = out + "\n\n(press Stop Device Watch to end)";
    }).catch(ex => { output.textContent = "[error] " + (ex.message || ex) + rootHint(ex); });
  };
  scan(); devTimer = setInterval(scan, 25000);
};
