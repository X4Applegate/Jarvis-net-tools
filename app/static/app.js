/* Jarvis Net Tools — phone app (v2, multi-page). All tools call the Pi's API. */
const $ = (id) => document.getElementById(id);
const out = $("out");
const statusLine = $("status-line");
let settings = { site_name: "", speed_interval_min: 60, service_checks: [], saved_devices: [] };

// ---------- plumbing ----------
async function api(path, body, method) {
  const opts = { method: method || (body ? "POST" : "GET"), headers: {} };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  if (r.status === 401) { showLogin(); throw new Error("Locked — please log in."); }
  const txt = await r.text();
  try { return JSON.parse(txt); }
  catch (e) { throw new Error("The Pi didn't answer properly (HTTP " + r.status + ") — it may be rebooting or reconnecting. Try again in a few seconds."); }
}
// Tool output goes ON THE PAGE (a "Result" card right under the section you tapped) by default;
// Settings > Display can switch it back to the old pinned bottom console. Stored per device (localStorage).
const outMode = () => (localStorage.getItem("outMode") === "dock" ? "dock" : "inline");
function applyOutMode() { $("app").classList.toggle("inline-out", outMode() === "inline"); }
let outPage = "home", anchorSect = null, busyPg = null;
const resEls = {};
function resPanel(pg) {
  if (resEls[pg]) return resEls[pg];
  const el = document.createElement("section"); el.className = "sect result hidden"; el.id = "res-" + pg;
  el.innerHTML = "<h2 class='sect-h'><span class='res-title'>Result</span><span class='res-btns'><button class='mini res-copy'>Copy</button><button class='mini res-close' aria-label='Close result'>✕</button></span></h2><div class='res-status hidden'></div><canvas class='res-spark hidden'></canvas><div class='res-rich hidden'></div><pre class='res-out hidden'></pre>";
  el.querySelector(".res-close").onclick = () => el.classList.add("hidden");
  el.querySelector(".res-copy").onclick = async (ev) => {
    const b = ev.currentTarget; let msg = "Copied";
    try { await navigator.clipboard.writeText(el.dataset.copy != null ? el.dataset.copy : el.querySelector(".res-out").textContent); } catch (e) { msg = "Can't copy"; }
    b.textContent = msg; setTimeout(() => { b.textContent = "Copy"; }, 1500);
  };
  resEls[pg] = el; return el;
}
function placePanel(pg, el) {
  const main = $("page-" + pg); let moved = false;
  const a = (anchorSect && main.contains(anchorSect)) ? anchorSect : (pg === "tools" ? main.querySelector(".sect") : null);
  if (a) { if (a.nextElementSibling !== el) { a.after(el); moved = true; } }
  else if (main.firstElementChild !== el) { main.prepend(el); moved = true; }
  return moved;
}
function reveal(pg) {   // show the page's result card (placed under the tapped section) and scroll to it the first time
  const el = resPanel(pg), wasHidden = el.classList.contains("hidden");
  el.classList.remove("hidden");
  const moved = placePanel(pg, el);
  if ((wasHidden || moved) && pg === curPage) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
  return el;
}
function ensureVisible(el) {   // the card grows when the result lands — make sure it isn't left half under the tab bar
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect(), topEdge = $("appbar").getBoundingClientRect().bottom - 2, bottomEdge = $("tabs").getBoundingClientRect().top;
    if (r.top < topEdge || r.bottom > bottomEdge) el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
function setStatus(el, msg, kind) { const st = el.querySelector(".res-status"); st.textContent = msg || ""; st.classList.toggle("hidden", !msg); st.classList.toggle("live", kind === "live"); st.classList.toggle("done", kind === "done"); }
function plainCard(el) { el.querySelector(".res-spark").classList.add("hidden"); const r = el.querySelector(".res-rich"); r.classList.add("hidden"); r.innerHTML = ""; el.querySelector(".res-out").classList.remove("scroll"); delete el.dataset.copy; }
function setTitle(el, t) { el.querySelector(".res-title").textContent = t || "Result"; }
const cleanTitle = (m) => String(m || "").replace(/^[^\p{L}\p{N}]+/u, "").split(" — ")[0].replace(/\s*\(.*?\)\s*$/, "").trim() || "Result";
function toggleDock(collapse) {
  const dock = $("console-dock"), appEl = $("app"), btn = $("dock-toggle");
  const c = collapse === undefined ? !dock.classList.contains("collapsed") : collapse;
  dock.classList.toggle("collapsed", c); appEl.classList.toggle("dock-collapsed", c);
  btn.textContent = c ? "Output ▴" : "Output ▾";
}
function expandDock() { if (outMode() === "dock" && $("console-dock").classList.contains("collapsed")) toggleDock(false); }
function busy(msg) {
  if (outMode() === "dock") {
    statusLine.textContent = msg ? "⏳ " + msg + " — working, please wait…" : "";
    statusLine.classList.toggle("working", !!msg);
    if (msg) { out.textContent = "Working…"; expandDock(); }
    return;
  }
  if (msg) {
    if (liveOn && livePg === outPage) stopLive();
    busyPg = outPage; const el = reveal(busyPg); plainCard(el);
    setTitle(el, cleanTitle(msg)); setStatus(el, "⏳ " + msg + " — working, please wait…");
    const pre = el.querySelector(".res-out"); pre.textContent = ""; pre.classList.add("hidden");
  } else { setStatus(resPanel(busyPg || outPage), ""); busyPg = null; }
}
// show(text)      = a user-triggered result: opens the card.   show(text, pg) = a live update (monitor / meter): only refreshes the card if it is open.
function show(text, pg) {
  if (outMode() === "dock") { out.textContent = text; expandDock(); return; }
  const live = !!pg, p = pg || busyPg || outPage;
  const el = live ? resPanel(p) : reveal(p);
  if (live && el.classList.contains("hidden")) return;
  if (!live) plainCard(el);
  const pre = el.querySelector(".res-out"); pre.textContent = text; pre.classList.toggle("hidden", !text);
  if (!live && !busyPg) setTitle(el, "Result");
  if (!live && p === curPage) ensureVisible(el);
}
function liveStatus(msg) {
  if (outMode() === "dock") { statusLine.textContent = msg || ""; statusLine.classList.toggle("working", !!msg); if (msg) expandDock(); return; }
  if (!msg) { Object.values(resEls).forEach(el => setStatus(el, "")); return; }
  if (liveOn && livePg === outPage) stopLive();
  const el = reveal(outPage); plainCard(el); setTitle(el, cleanTitle(msg)); setStatus(el, msg);
}
async function tool(label, path, body) {
  busy(label);
  try { const d = await api(path, body || {}); show(d.output || d.error || JSON.stringify(d, null, 2)); return d; }
  catch (e) { show(e.message); }
  finally { busy(""); }
}
function fmtTs(t) { const d = new Date(t * 1000); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
function fmtDur(s) { s = Math.max(0, Math.round(s)); return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : (s / 3600).toFixed(1) + "h"; }
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- navigation ----------
const PAGES = ["home", "wifi", "network", "tools", "monitor", "settings"];
const ICON = (id) => '<svg viewBox="0 0 24 24"><use href="#i-' + id + '"/></svg>';
// per-page app-bar title + actions (icon or text), like the reference app's top bar
const PAGE_META = {
  home: { title: "Info", actions: () => [{ icon: "refresh", label: "Refresh", fn: () => refreshHome() }, { icon: "power", label: "Power", fn: () => openPower() },
    { icon: "lock", label: "Lock", fn: () => $("logout-btn").click() }] },
  wifi: { title: "Signal", actions: () => [{ text: "Scan", fn: () => $("wifi-scan-btn").click() }] },
  network: { title: "LAN", actions: () => [{ text: "Scan", fn: () => $("btn-devices2").click() }] },
  tools: { title: "Tools", actions: () => [{ text: liveOn ? "Stop" : "Start", fn: () => startTool() }] },
  monitor: { title: "Speed", actions: () => [{ text: speedOn ? "Stop" : "Test", fn: () => startSpeed() }] },
  settings: { title: "Settings", actions: () => [] },
};
let curPage = "home";
function renderHeader() {
  const m = PAGE_META[curPage]; $("hdr-title").textContent = m.title;
  const box = $("hdr-actions"); box.innerHTML = "";
  m.actions().forEach(a => {
    const b = document.createElement("button"); b.setAttribute("aria-label", a.label || a.text);
    if (a.icon) b.innerHTML = ICON(a.icon); else { b.textContent = a.text; b.className = "txt"; }
    b.onclick = a.fn; box.appendChild(b);
  });
}
function goto(page) {
  if (!PAGES.includes(page)) page = "home";
  curPage = page; outPage = page; renderHeader();
  PAGES.forEach(p => $("page-" + p).classList.toggle("hidden", p !== page));
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  if (location.hash !== "#" + page) window.history.replaceState(null, "", "#" + page);
  window.scrollTo(0, 0);
  if (page === "home") { HG.dispF = 0; HG.num = 0; refreshHome(); }   // replay the sweep on every visit
  if (page === "wifi") { refreshStatus(); loadSaved(); autoScan(); drawSignalGraph(); }
  if (page === "network") renderSavedDevices();
  if (page === "tools") { iperfInfo(); toolHint(); }
  if (page === "monitor") { refreshNetmon(); spKick(); }
  if (page === "settings") { loadSettings(); refreshHotspot(); loadReports(); }
}
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => goto(b.dataset.page));
document.addEventListener("click", (e) => {
  const t = e.target; if (!t || !t.closest || !e.isTrusted) return;   // real taps only: the header buttons .click() inner buttons programmatically
  if (t.closest("#hdr-actions")) { outPage = curPage; anchorSect = null; return; }
  const sec = t.closest("main.page .sect");
  if (sec && !sec.classList.contains("result")) { outPage = curPage; anchorSect = sec; }
}, true);
window.addEventListener("hashchange", () => goto(location.hash.slice(1)));
$("home-go-wifi").onclick = () => goto("wifi");

// ---------- auth ----------
function showLogin() { if (typeof stopLive === "function") stopLive(); $("login").classList.remove("hidden"); $("app").classList.add("hidden"); }
async function showApp() {
  $("login").classList.add("hidden"); $("app").classList.remove("hidden");
  await loadSettings(true);
  goto(location.hash.slice(1) || "home");
  try { const v = await api("/api/visit"); if (v.needed) openWizard(v); } catch (e) {}   // first start of the day
}
// ---------- setup wizard: company -> location -> Wi-Fi -> main page ----------
// Shown on the first start of each day (one visit = one day, like the history) and from Settings > Start New Visit.
// The visit is saved after step 2, so skipping the Wi-Fi step still names the site.
const wz = { company: "", location: "", companies: [], ssid: "", saved: [], pick: "" };
const bars = (n) => n.signal >= 70 ? "▂▄▆█" : n.signal >= 50 ? "▂▄▆" : n.signal >= 30 ? "▂▄" : "▂";
function wzStep(n, title) {
  [1, 2, 3].forEach(i => $("wz-p" + i).classList.toggle("hidden", i !== n));
  $("wz-step").textContent = "Step " + n + " of 3";
  $("wz-title").textContent = title || ["Who is this visit for?", "Which location?", "Connect to Wi-Fi"][n - 1];
  window.scrollTo(0, 0);
}
function wzChips(box, names, current, onPick) {
  box.innerHTML = "";
  names.forEach(name => {
    const b = document.createElement("button"); b.textContent = name; b.classList.toggle("on", name === current);
    b.onclick = () => onPick(name); box.appendChild(b);
  });
}
async function openWizard(v) {
  try { v = v || await api("/api/visit"); } catch (e) { show(e.message); return; }
  wz.companies = v.companies || []; wz.ssid = v.ssid || "";
  const last = v.visit && !v.visit.skipped ? v.visit : null;
  wz.company = last ? last.company : ""; wz.location = last ? last.location : "";
  $("app").classList.add("hidden"); $("wizard").classList.remove("hidden");
  $("wz-company").value = ""; $("wz-location").value = ""; $("wz-msg").textContent = "";
  wzChips($("wz-companies"), wz.companies.map(c => c.name), wz.company, (name) => { wz.company = name; wzLocations(); });
  wzStep(1);
}
function closeWizard() {
  $("wizard").classList.add("hidden"); $("app").classList.remove("hidden");
  loadSettings(true); goto("home");
}
function wzLocations() {
  const c = wz.companies.find(x => x.name.toLowerCase() === wz.company.toLowerCase());
  $("wz-location").value = "";
  wzChips($("wz-locations"), c ? c.locations : [], wz.location, (name) => { wz.location = name; wzSave(); });
  wzStep(2, wz.company + ": which location?");
}
$("wz-next1").onclick = () => {
  const typed = $("wz-company").value.trim();
  if (typed) wz.company = typed;
  if (!wz.company) { $("wz-company").placeholder = "Type the company name first"; $("wz-company").focus(); return; }
  wz.location = ""; wzLocations();
};
$("wz-company").onkeydown = (e) => { if (e.key === "Enter") $("wz-next1").click(); };
$("wz-back2").onclick = () => wzStep(1);
$("wz-next2").onclick = () => { wz.location = $("wz-location").value.trim() || wz.location || ""; wzSave(); };
$("wz-location").onkeydown = (e) => { if (e.key === "Enter") $("wz-next2").click(); };
async function wzSave() {
  try {
    const d = await api("/api/visit", { company: wz.company, location: wz.location });
    if (!d.ok) { $("wz-msg").textContent = d.error || "Could not save."; return; }
    wz.companies = d.companies || wz.companies; wz.ssid = d.ssid || "";
  } catch (e) { return; }
  wzStep(3); wzWifi();
}
$("wz-skip").onclick = async () => {
  if ($("wz-p3").classList.contains("hidden")) { try { await api("/api/visit", { skip: true }); } catch (e) {} }
  closeWizard();
};
function wzNow() {
  $("wz-now").innerHTML = wz.ssid ? "Connected to <b>" + esc(wz.ssid) + "</b><i class='dot ok'></i>" : "Not connected to Wi-Fi yet<i class='dot warn'></i>";
  $("wz-done").textContent = wz.ssid ? "Continue" : "Continue without Wi-Fi";
}
async function wzWifi() {
  wzNow(); $("wz-join").classList.add("hidden"); $("wz-nets").innerHTML = "<div class='muted small'>Scanning for networks…</div>";
  try {
    const [s, saved] = await Promise.all([api("/api/wifi/scan", {}), api("/api/wifi/saved")]);
    wz.saved = saved.profiles || [];
    const box = $("wz-nets"); box.innerHTML = "";
    (s.networks || []).slice(0, 12).forEach(n => {
      const b = document.createElement("button"); b.className = "net";
      const isSaved = wz.saved.includes(n.ssid), cur = n.ssid === wz.ssid;
      b.innerHTML = "<span class='n'>" + esc(n.ssid) + "</span>" + (cur ? "<span class='tag'>connected</span>" : isSaved ? "<span class='tag'>saved</span>" : "") +
        "<span class='s'>" + (n.security && n.security !== "--" ? "🔒 " : "") + bars(n) + "</span>";
      b.onclick = () => wzPick(n, isSaved);
      box.appendChild(b);
    });
    if (!box.children.length) box.innerHTML = "<div class='muted small'>No networks found. Scan again, or continue with Ethernet.</div>";
  } catch (e) { $("wz-nets").textContent = e.message; }
}
function wzPick(n, isSaved) {
  wz.pick = n.ssid;
  if (n.ssid === wz.ssid) { $("wz-msg").textContent = "Already connected to " + n.ssid + "."; return; }
  if (isSaved || !n.security || n.security === "--") { wzJoin(""); return; }
  $("wz-join-ssid").textContent = n.ssid; $("wz-pass").value = ""; $("wz-join").classList.remove("hidden"); $("wz-pass").focus();
}
async function wzJoin(pw) {
  $("wz-join").classList.add("hidden"); $("wz-msg").textContent = "Connecting to " + wz.pick + "… (up to 45 s)";
  $("wz-done").disabled = true;
  try {
    const d = await api("/api/wifi/join", { ssid: wz.pick, password: pw });
    if (d.ok) {
      try { wz.ssid = (await api("/api/visit")).ssid || wz.pick; } catch (e) { wz.ssid = wz.pick; }
      $("wz-msg").textContent = "✅ Connected to " + wz.ssid + "."; wzNow();
    } else {
      $("wz-msg").textContent = "❌ " + String(d.output || d.error || "Could not connect.").split("\n")[0];
      if (!wz.saved.includes(wz.pick)) { $("wz-join-ssid").textContent = wz.pick; $("wz-join").classList.remove("hidden"); }
    }
  } catch (e) { $("wz-msg").textContent = e.message; }
  $("wz-done").disabled = false;
}
$("wz-connect").onclick = () => wzJoin($("wz-pass").value);
$("wz-pass").onkeydown = (e) => { if (e.key === "Enter") $("wz-connect").click(); };
$("wz-join-cancel").onclick = () => $("wz-join").classList.add("hidden");
$("wz-rescan").onclick = () => wzWifi();
$("wz-done").onclick = () => closeWizard();
$("set-new-visit").onclick = () => openWizard();

// ---------- Finish Visit: save the site report, clear the history, next start = setup wizard ----------
const finishDlg = $("finish-dlg");
let finishBusy = false, finishReport = "";
finishDlg.addEventListener("cancel", (e) => { if (finishBusy) e.preventDefault(); });
$("set-finish-visit").onclick = async () => {
  if (!window.confirm("Finish this visit?\n\nThe site report is saved on the Pi, then the history is cleared.\nThe next start shows the setup wizard.")) return;
  finishBusy = true; $("finish-btns").classList.add("hidden");
  $("finish-title").textContent = "Finishing the visit…";
  $("finish-msg").textContent = "Building and saving the site report (about 20-30 s). Keep the Pi on.";
  finishDlg.showModal();
  try {
    const d = await api("/api/visit/finish", {});
    if (!d.ok) throw new Error(d.error || "Could not finish the visit.");
    finishReport = d.report;
    $("finish-title").textContent = "✅ Visit finished";
    $("finish-msg").textContent = "Report saved: " + d.site + "\nThe history is cleared. You can turn the Pi off now: the next start shows the setup wizard.";
    $("finish-btns").classList.remove("hidden"); $("finish-view").classList.remove("hidden");
    loadSettings(true); loadReports();
  } catch (e) {
    $("finish-title").textContent = "Couldn't finish";
    $("finish-msg").textContent = e.message + "\nNothing was cleared.";
    $("finish-btns").classList.remove("hidden"); $("finish-view").classList.add("hidden");
  }
  finishBusy = false;
};
$("finish-off").onclick = () => { finishDlg.close(); openPower(); $("power-off").click(); };
$("finish-view").onclick = () => { if (finishReport) { finishDlg.close(); openReport(finishReport, "Site report"); } };
$("finish-next").onclick = () => { finishDlg.close(); openWizard(); };

// The report is the Pi's own HTML (inline styles only); a shadow root keeps its styles off the app, and the app's CSP
// still applies (no scripts).
const reportDlg = $("report-dlg");
async function openReport(name, title) {
  const url = "/api/reports/" + encodeURIComponent(name);
  const r = await fetch(url, { cache: "no-store" });
  if (r.status === 401) { showLogin(); return; }
  if (!r.ok) { show("That report is gone."); loadReports(); return; }
  const body = $("report-body"), root = body.shadowRoot || body.attachShadow({ mode: "open" });
  root.innerHTML = await r.text();
  $("report-title").textContent = title; $("report-dl").href = url + "?download=1"; $("report-dl").setAttribute("download", name);
  reportDlg.showModal(); body.scrollTop = 0;
}
$("report-close").onclick = () => reportDlg.close();

async function loadReports() {
  const box = $("rep-list");
  try {
    const list = (await api("/api/reports")).reports || [];
    box.innerHTML = list.length ? "" : "<div class='empty'>No saved reports yet.</div>";
    list.forEach(r => {
      const row = document.createElement("div"); row.className = "item";
      row.innerHTML = "<div class='txt'><div class='n'>" + esc(r.site) + "</div><div class='s'>" + esc(fmtTs(r.ts)) + "</div></div>";
      const open = document.createElement("button"); open.className = "tiny util"; open.textContent = "Open";
      open.onclick = () => openReport(r.name, r.site + " · " + fmtTs(r.ts));
      const del = document.createElement("button"); del.className = "tiny danger"; del.textContent = "Delete";
      del.onclick = async () => {
        if (!window.confirm("Delete the report " + r.site + " (" + fmtTs(r.ts) + ")?")) return;
        try { await api("/api/reports/delete", { name: r.name }); } catch (e) {}
        loadReports();
      };
      row.appendChild(open); row.appendChild(del); box.appendChild(row);
    });
  } catch (e) { box.textContent = e.message; }
}
$("login-btn").onclick = async () => {
  $("login-err").textContent = "";
  try {
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("login-pass").value }) });
    if (r.ok) { $("login-pass").value = ""; showApp(); }
    else if (r.status === 429) { let m = "Too many wrong passwords - wait a bit and try again."; try { m = (await r.json()).error || m; } catch (e) {} $("login-err").textContent = m; }
    else { $("login-err").textContent = "Wrong password."; }
  } catch (e) { $("login-err").textContent = "Connection error."; }
};
$("login-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("login-btn").click(); });
$("logout-btn").onclick = async () => { await fetch("/api/logout", { method: "POST" }); showLogin(); };

// ---------- status / home ----------
const kv = (l, v) => "<div class='row'><span class='lbl'>" + l + "</span><span class='val'>" + v + "</span></div>";
function parseLink(link) {
  return { ssid: (link.match(/SSID:\s*(.+)/) || [])[1], sig: (link.match(/signal:\s*(-?\d+)/) || [])[1],
    rate: (link.match(/rx bitrate:\s*([\d.]+ \S+)/) || [])[1] || "?", freq: (link.match(/freq:\s*([\d.]+)/) || [])[1] };
}
const bandOf = (f) => !f ? "" : f < 3000 ? "2.4 GHz" : f < 5925 ? "5 GHz" : "6 GHz";
// header line under the page title: site + battery, visible on every page (the Battery row can be below the fold)
let lastBattery = null;
function renderSub() {
  const parts = [];
  if (settings.site_name) parts.push("📍 " + settings.site_name);
  if (lastBattery) parts.push((lastBattery.source === "mains" ? "🔌 " : "🔋 ") + lastBattery.percent + "%");
  $("hdr-site").textContent = parts.join("  ·  ");
}
// Argon UPS battery (only when one is connected): green on mains or with charge to spare, amber when low, red near
// the automatic safe shutdown
function batteryRow(b) {
  const onMains = b.source === "mains", dot = b.shutting_down || (!onMains && b.level === "critical") ? "bad" : !onMains && b.level === "low" ? "warn" : "ok";
  const what = b.shutting_down ? "shutting down safely" : onMains ? (b.percent >= 100 ? "plugged in, full" : "plugged in, charging") : "on battery";
  let r = "<div class='row' id='home-battery'><span class='lbl'>Battery</span><span class='val'>" + esc(String(b.percent)) + "% <span class='muted'>· " +
    esc(what) + "</span><i class='dot " + dot + "'></i></span></div>";
  if (!onMains && !b.shutting_down && (b.level === "low" || b.level === "critical"))
    r += "<div class='row note' id='home-battery-hint'><span class='small nm-warn'>⚠ Plug in soon: the Pi shuts down safely at " + esc(String(b.critical)) + "%.</span></div>";
  return r;
}
// USB link of the Wi-Fi adapter: green at USB 3; amber + what to do when a USB 3 adapter fell back to USB 2 (480 Mbps)
function usbRows(u) {
  const warn = u.status === "warn", dot = u.status === "ok" ? "ok" : warn ? "warn" : "";
  let r = "<div class='row' id='home-usb'><span class='lbl'>USB Link</span><span class='val'>" + esc(u.label) +
    " <span class='muted'>· " + esc(u.gen) + "</span><i class='dot " + dot + "'></i></span></div>";
  if (u.hint && u.status !== "ok") r += "<div class='row note' id='home-usb-hint'><span class='small " + (warn ? "nm-warn" : "muted") + "'>" + (warn ? "⚠ " : "") + esc(u.hint) + "</span></div>";
  return r;
}
async function refreshStatus() {
  try {
    const d = await api("/api/status"); const p = parseLink(d.link);
    $("wifi-current").innerHTML = (d.net && d.net.type === "ethernet" ? "<div class='muted small'>🔌 Pi is using Ethernet right now (" + esc(d.net.ip) + "); this is the WiFi radio:</div>" : "") + "Currently connected: <span class='live'>" + esc(p.ssid || "(not on WiFi)") + "</span>" + (p.sig ? " <span class='muted small'>" + p.sig + " dBm · " + bandOf(+p.freq) + "</span>" : "");
    if (p && p.ssid) currentSsid = p.ssid;
    return p;
  } catch (e) { $("wifi-current").textContent = e.message; return null; }
}
async function refreshHome() {
  try {
    const [st, nm, sp] = await Promise.all([api("/api/status"), api("/api/netmon/status?hours=24"), api("/api/netmon/speed?hours=168")]);
    const p = parseLink(st.link);
    const net = st.net || {};
    const up = !!(net.type === "ethernet" || p.ssid);
    const kind = net.type === "ethernet" ? "Ethernet" : p.ssid ? "Wi-Fi" : "Not connected";
    const inetOn = nm.last && nm.last.inet_ok;
    let r = kv("Connection Type", esc(kind) + "<i class='dot " + (up ? "ok" : "bad") + "'></i>");
    if (net.type === "ethernet" && net.speed) r += kv("Link", esc(net.speed + " Mb/s " + (net.duplex || "")));
    if (net.type !== "ethernet" && p.ssid) {
      r += kv("Network", esc(p.ssid)) + kv("Band", bandOf(+p.freq) || "—") + kv("Signal", esc(p.sig) + " dBm") + kv("Link Rate", esc(p.rate));
    } else if (p.ssid) r += kv("WiFi radio", "on " + esc(p.ssid));
    if (st.usb) r += usbRows(st.usb);
    if (st.battery) r += batteryRow(st.battery);
    lastBattery = st.battery || null; renderSub();
    r += kv("IP Address", esc(net.ip || "N/A")) + kv("Default Gateway", esc(net.gw || "N/A"));
    r += kv("Internet", nm.last ? (inetOn ? "<span class='nm-ok'>online</span>" : "<span class='nm-bad'>OFFLINE</span>") + (nm.last.inet_ms ? " <span class='muted'>" + nm.last.inet_ms + " ms</span>" : "") : "<span class='muted'>unknown</span>");
    r += kv("Monitor", nm.running ? "<span class='nm-ok'>running</span>" : "<span class='nm-bad'>stopped</span>");
    if (nm.current_outage) r += "<div class='row note'><span class='nm-bad small'>⚠ Outage in progress since " + fmtTs(nm.current_outage.start_ts) + "</span></div>";
    $("home-conn").innerHTML = r;
    $("home-uptime").textContent = nm.uptime_pct == null ? "—" : nm.uptime_pct + "%";
    const ended = (nm.outages || []).filter(o => o.end_ts);
    $("home-outages").textContent = nm.samples ? String(ended.length) : "—";
    homeSpeed((sp.rows || []).slice(-1)[0]);
    $("home-live").textContent = "live · " + new Date().toLocaleTimeString();
  } catch (e) { $("home-conn").textContent = e.message; }
}

// ---------- live auto-refresh (visible page only, paused while the tab is hidden) ----------
let liveBusy = false;
const pageShown = (p) => !$("page-" + p).classList.contains("hidden");
async function liveTick() {
  if (document.hidden || liveBusy) return;
  liveBusy = true;
  try {
    if (pageShown("home")) await refreshHome();
    else if (pageShown("wifi")) await refreshStatus();
    else if (pageShown("monitor")) await refreshNetmon();
  } finally { liveBusy = false; }
}
setInterval(liveTick, 5000);
document.addEventListener("visibilitychange", liveTick);

// ---------- quick / simple tools ----------
// the speed test lives on the Speed tab (speedometer); the Info quick action just jumps there and starts it
$("btn-speed").onclick = () => { goto("monitor"); startSpeed(); }; $("btn-speed2").onclick = () => startSpeed();
const pingGw = () => livePing("@gateway", 10, { title: "Ping Gateway", fallback: () => tool("Ping Gateway", "/api/pinggw") });
$("btn-pinggw").onclick = pingGw; $("btn-pinggw2").onclick = pingGw;
$("btn-ports").onclick = () => tool("Open Ports", "/api/ports");
$("btn-bw").onclick = () => tool("Bandwidth (5s sample)", "/api/bandwidth");
$("btn-mtr").onclick = () => liveTrace("8.8.8.8", { title: "Path to Internet", fallback: () => tool("Path to Internet", "/api/mtr", {}) });
$("btn-pubip").onclick = () => tool("Public IP & ISP", "/api/pubip");
$("btn-dnscheck").onclick = () => tool("DNS Check", "/api/dnscheck");
$("btn-dhcp").onclick = () => tool("Rogue DHCP check (~10s)", "/api/dhcp");
$("btn-jack").onclick = () => tool("Ethernet jack test (~10s)", "/api/jack");
const services = () => tool("Service / POS check", "/api/services");
$("btn-services").onclick = services; $("btn-services2").onclick = services;
const history = async () => { busy("Loading history"); try { const d = await api("/api/history"); show(d.output); } catch (e) { show(e.message); } busy(""); };
$("btn-history").onclick = history; $("btn-history2").onclick = history;

// ---------- devices ----------
let lastHosts = [];
function renderDevList(hosts) {
  const box = $("dev-list"); box.innerHTML = "";
  hosts.forEach(h => {
    const row = document.createElement("div"); row.className = "item";
    row.innerHTML = "<div class='txt'><div class='n'>" + esc(h.name || h.type || h.vendor || h.ip) + " <span class='muted small'>" + esc(h.ip) + "</span></div><div class='s'>" + esc([h.type, h.vendor, h.mac].filter(Boolean).join(" · ")) + "</div></div>";
    const b = document.createElement("button"); b.className = "tiny util"; b.textContent = "＋ save";
    b.onclick = () => addSavedDevice(h.name || h.type || h.vendor || h.ip, h.mac, h.ip);
    row.appendChild(b); box.appendChild(row);
  });
}
async function findDevices() {
  busy("Find & identify devices (~30s)");
  try {
    const d = await api("/api/devices", {});
    lastHosts = d.hosts || [];
    show(lastHosts.length ? "Devices (" + lastHosts.length + "):\n\n" + lastHosts.map(h => h.ip.padEnd(16) + (h.name || "—").slice(0, 24).padEnd(26) + (h.type || "").slice(0, 26).padEnd(28) + h.vendor.slice(0, 26) + "\n" + " ".repeat(16) + h.mac + (h.info ? "  · " + h.info : "")).join("\n") + "\n\n(list also shown on the Network page — tap ＋ save to bookmark one)" : "none found");
    renderDevList(lastHosts);
  } catch (e) { show(e.message); }
  busy("");
}
$("btn-devices").onclick = () => { goto("network"); findDevices(); };
$("btn-devices2").onclick = findDevices;

// ---------- saved devices (wake / ping) ----------
async function saveSettings(patch) {
  const d = await api("/api/settings", patch);
  if (d.ok) { settings = d; applySettings(); }
  return d;
}
async function addSavedDevice(name, mac, ip) {
  if (!/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac || "")) { show("That entry has no usable MAC address."); return; }
  const n = window.prompt("Name for this device:", name || "") || name;
  if (!n) return;
  const list = (settings.saved_devices || []).filter(x => x.mac.toUpperCase() !== mac.toUpperCase());
  list.push({ name: n, mac: mac.toUpperCase(), ip: ip || "" });
  await saveSettings({ saved_devices: list });
  renderSavedDevices(); show("Saved “" + n + "” (" + mac + ") — find it under Saved Devices.");
}
function renderSavedDevices() {
  const boxes = [$("saved-devices"), $("set-devices")];
  const list = settings.saved_devices || [];
  boxes.forEach((box, i) => {
    box.innerHTML = list.length ? "" : "<div class='empty'>No saved devices yet.</div>";
    list.forEach((d, idx) => {
      const row = document.createElement("div"); row.className = "item";
      row.innerHTML = "<div class='txt'><div class='n'>" + esc(d.name) + "</div><div class='s'>" + esc(d.mac) + (d.ip ? " · " + esc(d.ip) : "") + "</div></div>";
      if (i === 0) {
        const w = document.createElement("button"); w.className = "tiny"; w.textContent = "⚡ wake";
        w.onclick = () => tool("Wake " + d.name, "/api/wake", { mac: d.mac, ip: d.ip, name: d.name });
        row.appendChild(w);
        if (d.ip) { const p = document.createElement("button"); p.className = "tiny accent"; p.textContent = "↔ ping"; p.onclick = () => tool("Ping " + d.name, "/api/ping", { target: d.ip }); row.appendChild(p); }
      } else {
        const x = document.createElement("button"); x.className = "tiny danger"; x.textContent = "remove";
        x.onclick = async () => { if (!confirm("Remove " + d.name + "?")) return; await saveSettings({ saved_devices: list.filter((_, j) => j !== idx) }); renderSavedDevices(); };
        row.appendChild(x);
      }
      box.appendChild(row);
    });
  });
}
$("dev-add").onclick = async () => {
  const name = $("dev-name").value.trim(), mac = $("dev-mac").value.trim(), ip = $("dev-ip").value.trim();
  if (!name || !/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)) { show("Need a name and a MAC like AA:BB:CC:DD:EE:FF."); return; }
  await saveSettings({ saved_devices: [...(settings.saved_devices || []), { name, mac: mac.toUpperCase().replace(/-/g, ":"), ip }] });
  $("dev-name").value = $("dev-mac").value = $("dev-ip").value = ""; renderSavedDevices(); show("Saved " + name + ".");
};
$("btn-wol-manual").onclick = () => {
  const mac = (window.prompt("MAC address to wake (AA:BB:CC:DD:EE:FF):", "") || "").trim();
  if (!mac) return;
  if (!/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)) { show("That's not a valid MAC address."); return; }
  tool("Wake " + mac, "/api/wake", { mac: mac.toUpperCase().replace(/-/g, ":"), ip: "", name: "" });
};

// ---------- wifi ----------
let selected = null, savedNames = new Set(), currentSsid = null, netInfo = {};
async function loadSaved() {
  const sel = $("saved-list");
  try {
    const d = await api("/api/wifi/saved"); sel.innerHTML = "";
    (d.profiles || []).forEach(n => { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
    savedNames = new Set(d.profiles || []);
    if (!sel.options.length) sel.innerHTML = "<option>No saved profiles</option>";
  } catch (e) { sel.innerHTML = "<option>Error loading</option>"; }
  const p = await refreshStatus(); currentSsid = p ? p.ssid : null;
}
$("saved-refresh").onclick = loadSaved;
$("saved-connect").onclick = async () => {
  const name = $("saved-list").value;
  if (!name || name.startsWith("No saved") || name.startsWith("Error")) return;
  await tool("Switch WiFi → " + name, "/api/wifi/switch", { name }); loadSaved();
};
$("saved-forget").onclick = async () => {
  const name = $("saved-list").value;
  if (!name || name.startsWith("No saved") || name.startsWith("Error")) return;
  if (!confirm("Forget \"" + name + "\"?" + (name === currentSsid ? "\n\nYou're connected to it — the Pi will disconnect (and you may lose this app until it's back on a network)." : ""))) return;
  await tool("Forget " + name, "/api/wifi/forget", { name }); loadSaved();
};
const clearVisited = async () => {
  if (!window.confirm("Delete saved WiFi for visited sites?\n\nKeeps your home/management networks and your current connection.")) return;
  await tool("Clear Visited WiFi", "/api/wifi/clear"); loadSaved();
};
$("wifi-clear-btn").onclick = clearVisited; $("wifi-clear-btn2").onclick = clearVisited;
let lastNets = [];
const wantBand = () => $("wifi-band").value;
function renderScan(quiet) {
  const sel = $("wifi-list"), b = wantBand();
  const nets = lastNets.filter(n => b === "auto" || n.band === b);
  const label = b === "auto" ? "every network in range" : b + " GHz networks only";
  if (!quiet) show(nets.length ? "Survey - " + label + ":\n\n" + nets.map(n => (n.band + "G").padEnd(5) + "ch " + String(n.ch).padEnd(4) + "  " + (n.sig + "%").padEnd(6) + n.ssid).join("\n") + "\n\n(named networks added to the dropdown - pick one and Join)" : "No " + (b === "auto" ? "" : b + " GHz ") + "networks seen.");
  const seen = new Set(); sel.innerHTML = ""; netInfo = {};
  nets.forEach(n => { netInfo[n.ssid] = n; if (!n.ssid || n.ssid === "(hidden)" || seen.has(n.ssid)) return; seen.add(n.ssid);
    const o = document.createElement("option"); o.value = n.ssid; o.textContent = n.ssid + "  (" + n.sig + "%, " + n.band + "G ch " + n.ch + ")"; sel.appendChild(o); });
  if (!sel.options.length) sel.innerHTML = "<option>No named networks</option>";
  else if (currentSsid && [...sel.options].some(o => o.value === currentSsid)) sel.value = currentSsid;
  loadAps(false); drawSignalGraph();
}
// entering the WiFi page scans on its own (reuses a scan younger than 20 s instead of rescanning)
let lastScanTs = 0, scanQuiet = false;
async function autoScan() {
  if (!currentSsid) await refreshStatus();
  if (lastNets.length && Date.now() - lastScanTs < 20000) { renderScan(true); return; }
  scanQuiet = true; $("wifi-scan-btn").click();
}
$("wifi-band").onchange = () => { if (lastNets.length) renderScan(); };
// ---- pick a specific access point (BSSID) of the chosen network, e.g. the AP in the room being tested
// names live on the Pi (survive cleared browser data); any names saved by older versions in this browser are uploaded once
async function fetchApNames() {
  let names = (await api("/api/apnames")).names || {};
  try {
    const old = JSON.parse(localStorage.getItem("apNames") || "{}");
    const missing = Object.fromEntries(Object.entries(old).filter(([b]) => !names[b]));
    if (Object.keys(missing).length) names = (await api("/api/apnames", { names: missing })).names || names;
    localStorage.removeItem("apNames");
  } catch (e) { /* keep going with server names */ }
  return names;
}
async function loadAps(rescan) {
  const ssid = $("wifi-list").value, sel = $("wifi-ap"), prev = sel.value;
  sel.innerHTML = "<option value=''>AP: Auto (best signal, roams)</option>";
  $("wifi-ap-note").textContent = "";
  if (!ssid || /^(No |Scan|Tap )/.test(ssid)) return;
  try {
    const d = await api("/api/aps", { ssid, rescan: !!rescan }); const names = await fetchApNames();
    (d.aps || []).forEach(a => { const o = document.createElement("option"); o.value = a.bssid;
      o.textContent = (names[a.bssid] ? names[a.bssid] + " · " : "") + a.bssid.slice(-8) + " · " + a.band + "G ch" + a.ch + " · " + a.signal + "%" + (a.current ? " ◀ connected" : ""); sel.appendChild(o); });
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    $("wifi-ap-note").textContent = (d.aps || []).length + " AP(s) broadcasting “" + ssid + "”. Pinning one stops roaming until you pick Auto again.";
  } catch (e) { $("wifi-ap-note").textContent = e.message; }
}
$("wifi-list").onchange = () => loadAps(false);
$("wifi-ap-refresh").onclick = () => loadAps(true);
// choosing an AP switches to it right away (same path as the Join button); skip if it is already the connected one
$("wifi-ap").onchange = () => {
  const o = $("wifi-ap").selectedOptions[0];
  if (!o || o.textContent.includes("◀ connected")) return;
  $("wifi-join-btn").click();
};
$("wifi-ap-name").onclick = () => {
  const b = $("wifi-ap").value; if (!b) { show("Pick an access point first, then name it (e.g. “Warehouse”)."); return; }
  fetchApNames().then(async (names) => {
    const n = window.prompt("Name for " + b + " (blank = remove):", names[b] || "");
    if (n === null) return;
    try {
      const saved = (await api("/api/apnames", { bssid: b, name: n.trim() })).names || {};
      const want = n.trim().slice(0, 30);
      if ((saved[b] || "") !== want) throw new Error("the Pi did not keep the name");
      await loadAps(false);
      $("wifi-ap-note").textContent = want ? "✔ Saved “" + want + "” on the Pi for " + b : "✔ Removed the name for " + b;
    } catch (e) { $("wifi-ap-note").textContent = "❌ Could not save the name: " + e.message; }
  }).catch(e => { $("wifi-ap-note").textContent = "❌ " + e.message; });
};
$("wifi-scan-btn").onclick = async () => {
  const quiet = scanQuiet; scanQuiet = false;   // the automatic scan on entering the page just feeds the graph, it doesn't pop the console open
  if (!quiet) busy("Scanning networks"); const sel = $("wifi-list"); sel.innerHTML = "<option>Scanning…</option>"; $("sig-note").textContent = "Scanning…";
  try {
    const d = await api("/api/scanall", {}); lastNets = d.networks || []; lastScanTs = Date.now(); renderScan(quiet);
  } catch (e) { if (!quiet) show(e.message); else $("sig-note").textContent = e.message; }
  if (!quiet) busy("");
};
$("wifi-join-btn").onclick = async () => {
  const ssid = $("wifi-list").value;
  if (!ssid || ssid.startsWith("No ") || ssid.startsWith("Scan") || ssid.startsWith("Tap ")) { show("Tap Scan Networks and pick one first."); return; }
  busy("Connecting to " + ssid + " (10–30s)"); show("Connecting to " + ssid + " …\nThis takes 10–30 seconds while it authenticates. Please wait.");
  try {
    const d = await api("/api/wifi/join", { ssid, password: $("wifi-pass").value, band: wantBand(), bssid: $("wifi-ap").value }); $("wifi-pass").value = "";
    const o = d.output || d.error || ""; const ok = (typeof d.ok === "boolean") ? d.ok : /successfully activated/i.test(o);
    show(ok ? "✅ Connected to " + ssid + "\n\n" + o : "❌ Could not connect to " + ssid + "\n\n" + (o || "no response") + "\n\n(Wrong password? Out of range?)");
    loadSaved(); loadAps(false);
  } catch (e) { show("⚠️ Status unknown — the app briefly lost its own link while the Pi switched networks.\n\nThat usually means the join is actually happening. Wait ~20s, then tap Refresh.\n\n" + e.message); }
  busy("");
};

// channel analyzer
function bar(n, max) { const w = 18, len = max > 0 ? Math.round((n / max) * w) : 0; return "#".repeat(Math.max(len, n > 0 ? 1 : 0)).padEnd(w, "."); }
function renderBand(title, map) {
  const chans = Object.keys(map).map(Number).sort((a, b) => a - b);
  if (!chans.length) return title + "\n  (none seen)\n";
  const max = Math.max(...chans.map(c => map[c].count), 1);
  return title + "\n" + chans.map(c => { const e = map[c]; const names = (e.ssids || []).map(x => x.ssid + " " + x.sig + "%").join(", ");
    return "  ch " + String(c).padStart(3) + "  " + bar(e.count, max) + "  " + e.count + (e.count === 1 ? " AP " : " APs") + (names ? "\n         " + names : ""); }).join("\n") + "\n";
}
function best24(m) { let bc = null, bs = Infinity; [1, 6, 11].forEach(c => { let sc = 0; Object.keys(m).forEach(k => { const ov = 5 - Math.abs(+k - c); if (ov > 0) sc += m[k].count * ov; }); if (sc < bs) { bs = sc; bc = c; } }); return bc; }
function best5(m) { let bc = null, bs = Infinity; [36, 40, 44, 48, 149, 153, 157, 161].forEach(c => { const sc = m[c] ? m[c].count : 0; if (sc < bs) { bs = sc; bc = c; } }); return bc; }
$("btn-chan").onclick = async () => {
  busy("Channel Analyzer");
  try {
    const d = await api("/api/channel", {});
    let s = renderBand("=== 2.4 GHz ===", d.band24 || {}) + "  >> Best 2.4GHz: channel " + best24(d.band24 || {}) + " (1/6/11 only)\n\n";
    s += renderBand("=== 5 GHz ===", d.band5 || {}) + "  >> Suggested 5GHz: channel " + best5(d.band5 || {}) + "\n\n";
    const b6 = d.band6 || {}; s += renderBand("=== 6 GHz (WiFi 6E) ===", b6);
    s += Object.keys(b6).length ? "  >> 6 GHz is nearly empty almost everywhere — a 6E-capable AP here gets a clean band.\n" : "  (no 6 GHz networks here — nobody's using WiFi 6E yet)\n";
    show(s);
  } catch (e) { show(e.message); }
  busy("");
};

// APs & roaming
function apsText(d) {
  if (!d.aps || !d.aps.length) return "No APs seen for " + (d.ssid || "(not connected)") + ".";
  return "APs broadcasting \"" + d.ssid + "\" (" + d.aps.length + "):\n\n" + d.aps.map(a => (a.current ? "▶ " : "  ") + (a.name ? a.name + " · " : "") + a.bssid + "  " + String(a.signal + "%").padStart(4) + "  " + a.band + "G ch " + String(a.ch).padEnd(4) + (a.current ? "  ← connected here" : "")).join("\n") +
    "\n\n▶ = the AP you're on. If a stronger one is listed, the client is sticky or the AP's roaming settings need work.";
}
$("btn-aps").onclick = async () => { busy("Scanning APs"); try { show(apsText(await api("/api/aps", {}))); } catch (e) { show(e.message); } busy(""); };
let roamTimer = null, roamLast = null, roamLog = [];
$("btn-roam").onclick = async () => {
  const b = $("btn-roam");
  if (roamTimer) { clearInterval(roamTimer); roamTimer = null; b.textContent = "Watch Roaming"; liveStatus(""); return; }
  b.textContent = "Stop Watching"; liveStatus("📡 Watching for AP roams — every 6s"); roamLog = []; roamLast = null; const pg = outPage, showL = (t) => show(t, pg);
  const poll = async () => { try {
    const d = await api("/api/aps", { rescan: false }); const cur = d.aps.find(a => a.current); const now = new Date().toLocaleTimeString();
    if (cur && roamLast && cur.bssid !== roamLast.bssid) roamLog.push(now + "  ROAMED " + roamLast.bssid + " (" + roamLast.signal + "%) → " + cur.bssid + " (" + cur.signal + "%)");
    if (cur) roamLast = cur;
    showL((cur ? "Now on " + cur.bssid + "  " + cur.signal + "%  " + cur.band + "G ch " + cur.ch : "Not connected") + "\n\n" + (roamLog.length ? "Roam log:\n" + roamLog.join("\n") : "No roams yet — walk around the site.") + "\n\n" + apsText(d).split("\n\n").slice(0, 2).join("\n\n"));
  } catch (e) {} };
  poll(); roamTimer = setInterval(poll, 6000);
};

// live signal meter (two buttons, one state)
let signalTimer = null;
function toggleSignal() {
  const btns = [$("btn-signal"), $("btn-signal2")];
  if (signalTimer) { clearInterval(signalTimer); signalTimer = null; btns.forEach(b => b.textContent = "Live Signal Meter"); liveStatus(""); return; }
  btns.forEach(b => b.textContent = "Stop Signal Meter"); liveStatus("📶 Live signal — updating every 2s"); const pg = outPage, showL = (t) => show(t, pg);
  const poll = async () => { try {
    const d = await api("/api/signal"); const p = parseLink(d.link);
    if (!p.sig) { showL("Not connected to WiFi."); return; }
    const n = parseInt(p.sig, 10), pct = Math.max(0, Math.min(100, 2 * (n + 100))), q = n >= -60 ? "STRONG" : n >= -70 ? "OK" : "WEAK";
    showL(p.ssid + "  (" + bandOf(+p.freq) + ")\n\nsignal: " + p.sig + " dBm  (" + q + ")\n[" + "#".repeat(Math.round(pct / 5)).padEnd(20, ".") + "] " + pct + "%\nrx rate: " + p.rate + "\n\n(tap Stop to end)");
  } catch (e) {} };
  poll(); signalTimer = setInterval(poll, 2000);
}
$("btn-signal").onclick = toggleSignal; $("btn-signal2").onclick = toggleSignal;

// ---------- target tools ----------
function target() { const t = $("target").value.trim(); if (!t) { goto("tools"); $("target").focus(); show("Enter a host or IP in the target box first."); return null; } return t; }
$("btn-ping").onclick = () => { const t = target(); if (t) livePing(t, 10, { fallback: () => tool("Ping " + t, "/api/ping", { target: t }) }); };
$("btn-dns").onclick = () => { const t = target(); if (t) tool("DNS Lookup " + t, "/api/dns", { target: t }); };
$("btn-iperf").onclick = () => { const t = target(); if (t) tool("LAN speed test to " + t + " (~15s)", "/api/iperf", { target: t }); };
async function iperfInfo() {
  try { const d = await api("/api/iperf/info");
    $("iperf-info").innerHTML = (d.server ? "<span class='nm-ok'>iperf3 server running</span> on the Pi — " : "<span class='nm-bad'>iperf3 server not running</span> — ") + "from a laptop: <code>iperf3 -c " + (d.ips[0] || "<pi-ip>") + "</code>. Or run <code>iperf3 -s</code> on the laptop, put its IP in the target box and tap LAN Speed.";
  } catch (e) { $("iperf-info").textContent = ""; }
}
// ---------- live tools: the Pi streams a tool's output line by line (Server-Sent Events) and the card fills in as it arrives ----------
let liveOn = null, liveCtl = null, livePg = null;   // liveOn = truthy while a streamed tool runs (drives the header/Start "Stop")
function stopLive() { if (liveCtl) liveCtl.abort(); }
async function streamSSE(url, body, signal, onLine) {   // POST + read the event stream; "unsupported" = the Pi app is older and has no such endpoint
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (r.status === 401) { showLogin(); throw new Error("Locked — please log in."); }
  if (r.status === 404) return "unsupported";
  if (!r.ok || !r.body) { let m = "HTTP " + r.status; try { m = (await r.json()).error || m; } catch (e) {} throw new Error(m); }
  const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const name = (ev.match(/^event: (.+)$/m) || [])[1], data = (ev.match(/^data: (.*)$/m) || [])[1];
      if (!name && data !== undefined) { try { onLine(JSON.parse(data)); } catch (e) {} }   // ": keepalive" comment frames carry no data and are ignored
    }
  }
  return "done";
}
const headOf = (state, note) => state === "live" ? "● LIVE" : state === "done" ? "✔ Finished" : state === "stopped" ? "■ Stopped" : "⚠ " + (note || "Connection lost");
// spec: { url, body, title, fallback, spark, scroll, onLine(line), view(state, note) -> { status, text, html?, copy? }, after(card), onEnd(state) }
async function runLive(spec) {
  stopLive();                                                    // one live tool at a time
  const ctl = liveCtl = new AbortController(); liveOn = ctl; livePg = outPage; const pg = livePg;
  renderHeader(); startBtnLabel();
  const inline = outMode() === "inline";
  show(""); const el = inline ? resPanel(pg) : null;             // opens the card where the tool was started
  if (el) { setTitle(el, spec.title); el.querySelector(".res-out").classList.toggle("scroll", !!spec.scroll); el.querySelector(".res-spark").classList.toggle("hidden", !spec.spark); }
  let state = "live", note = "", timer = null;
  const paint = () => {
    timer = null; const v = spec.view(state, note);
    if (inline) {
      if (el.classList.contains("hidden")) return;               // closed by the user: keep running, stay quiet
      setStatus(el, v.status, state === "live" ? "live" : "done");
      const pre = el.querySelector(".res-out"), rich = el.querySelector(".res-rich");
      pre.textContent = v.text || ""; pre.classList.toggle("hidden", !v.text); if (spec.scroll) pre.scrollTop = pre.scrollHeight;
      if (v.html != null) { rich.innerHTML = v.html; rich.classList.remove("hidden"); } else { rich.innerHTML = ""; rich.classList.add("hidden"); }
      el.dataset.copy = v.copy != null ? v.copy : (v.text || "");
      if (spec.after) spec.after(el);
    } else { out.textContent = v.copy != null ? v.copy : (v.text || ""); statusLine.textContent = v.status; statusLine.classList.remove("working"); }
  };
  const later = () => { if (!timer) timer = setTimeout(paint, 90); };   // coalesce bursts (mtr sends dozens of events a second)
  try {
    const res = await streamSSE(spec.url, spec.body, ctl.signal, (line) => { spec.onLine(line); later(); });
    if (res === "unsupported" && spec.fallback) { if (liveCtl === ctl) liveCtl = liveOn = livePg = null; renderHeader(); startBtnLabel(); return spec.fallback(); }
    state = "done";
  } catch (e) { state = e.name === "AbortError" ? "stopped" : "lost"; note = e.name === "AbortError" ? "" : e.message; }
  if (timer) { clearTimeout(timer); timer = null; }
  if (liveCtl === ctl) liveCtl = liveOn = livePg = null;
  if (spec.onEnd) spec.onEnd(state);
  paint(); renderHeader(); startBtnLabel();
}

// ---- ping: a line + a latency bar per reply
function drawSpark(canvas, rtts) {
  const { g, W, H, d } = prep(canvas), f = (n) => n * d, N = 60, vals = rtts.slice(-N), good = vals.filter(v => v != null);
  const mx = Math.max(20, ...good) * 1.15, B = f(16), T = f(6), PH = H - B - T, slot = W / N;
  g.strokeStyle = GRID; g.lineWidth = 1; [0, 0.5, 1].forEach(k => { const y = T + PH * k; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); });
  g.fillStyle = AXIS; g.font = f(10) + "px sans-serif"; g.fillText(Math.round(mx) + " ms", f(6), f(14)); g.fillText("0", f(6), H - f(4));
  vals.forEach((v, i) => { const x = W - (vals.length - i) * slot + slot * 0.15, w = Math.max(2, slot * 0.7);
    if (v == null) { g.fillStyle = "#dc2626"; g.fillRect(x, T, w, PH); }
    else { const h = Math.max(f(2), (v / mx) * PH); g.fillStyle = v > mx * 0.7 ? "#f59e0b" : "#60a5fa"; g.fillRect(x, T + PH - h, w, h); } });
}
function livePing(target, count, opts) {
  opts = opts || {};
  const lines = [], rtts = []; let sent = 0, recv = 0, sum = 0, min = Infinity, max = 0;
  // phone-width friendly: one short line per reply instead of ping's long raw line (header + summary lines stay as the Pi sent them)
  const pretty = (line) => {
    const r = line.match(/^\d+ bytes from ([^:\s]+).*?icmp_seq=(\d+).*?ttl=(\d+).*?time=([\d.]+) ms/), t = line.match(/no answer yet for icmp_seq=(\d+)/);
    if (r) return ("#" + r[2]).padEnd(5) + (r[4] + " ms").padStart(10) + "   ttl " + r[3] + "   " + r[1];
    if (t) return ("#" + t[1]).padEnd(5) + "   no reply (timeout)";
    return line;
  };
  return runLive({
    url: "/api/ping/stream", body: { target, count }, title: opts.title || "Ping " + target, fallback: opts.fallback, spark: true, scroll: true,
    onLine(line) {
      lines.push(pretty(line));
      const m = line.match(/icmp_seq=(\d+).*?time=([\d.]+)\s*ms/), to = line.match(/no answer yet for icmp_seq=(\d+)/);
      if (m) { const v = +m[2]; recv++; sent = Math.max(sent, +m[1]); rtts.push(v); sum += v; min = Math.min(min, v); max = Math.max(max, v); }
      else if (to) { sent = Math.max(sent, +to[1]); rtts.push(null); }
    },
    view(state, note) {
      const loss = sent ? Math.round(((sent - recv) / sent) * 100) : 0;
      return { text: lines.slice(count ? -300 : -150).join("\n"),
        status: headOf(state, note) + " · " + sent + " sent · " + recv + (recv === 1 ? " reply · " : " replies · ") + loss + "% loss" + (recv ? " · " + (sum / recv).toFixed(1) + " ms avg (" + min.toFixed(1) + "–" + max.toFixed(1) + ")" : "") };
    },
    after(el) { drawSpark(el.querySelector(".res-spark"), rtts); }
  });
}

// ---- route: a live hop table (mtr raw events: x = probe sent, h = hop host, p = reply, hops are 0-based)
function liveTrace(target, opts) {
  opts = opts || {}; const passes = 10, hops = new Map(), firstSeen = {}; let ghostFrom = Infinity;
  const hop = (n) => { let h = hops.get(n); if (!h) { h = { host: "", sent: 0, recv: 0, sum: 0, best: Infinity, worst: 0, last: null, t: new Map(), ok: new Set() }; hops.set(n, h); } return h; };
  const f1 = (v) => v == null ? "—" : v.toFixed(1);
  const lossCls = (l) => l >= 50 ? "bad" : l > 0 ? "warn" : "";
  return runLive({
    url: "/api/trace/stream", body: { target, count: passes }, title: opts.title || "Route to " + target, fallback: opts.fallback,
    onLine(line) {
      const p = line.split(" "), n = +p[1]; if (!/^[xhp]$/.test(p[0]) || isNaN(n)) return;
      const h = hop(n);
      if (p[0] === "x") { h.sent++; h.t.set(p[2], Date.now()); }
      else if (p[0] === "h") { h.host = p[2]; if (firstSeen[p[2]] === undefined) firstSeen[p[2]] = n; else if (firstSeen[p[2]] < n) ghostFrom = Math.min(ghostFrom, n); }   // same host again further out = past the destination
      else { const ms = (+p[2]) / 1000; h.recv++; h.ok.add(p[3]); h.last = ms; h.sum += ms; h.best = Math.min(h.best, ms); h.worst = Math.max(h.worst, ms); }
    },
    view(state, note) {
      const nums = [...hops.keys()].sort((a, b) => a - b).filter(n => n < ghostFrom), lastHost = Math.max(-1, ...nums.filter(n => hops.get(n).host)), now = Date.now();
      const rows = nums.filter(n => n <= lastHost).map(n => {
        const h = hops.get(n), lost = [...h.t].filter(([seq, t]) => !h.ok.has(seq) && (state !== "live" || now - t > 3000)).length, tot = lost + h.recv;   // a probe still in flight is not a loss yet
        return { n: n + 1, host: h.host || "???", loss: tot ? Math.round((lost / tot) * 100) : 0, last: h.last, avg: h.recv ? h.sum / h.recv : null, best: h.recv ? h.best : null, worst: h.recv ? h.worst : null };
      });
      const end = rows[rows.length - 1], pass = hops.has(0) ? hops.get(0).sent : 0;
      const status = headOf(state, note) + " · " + (state === "live" ? "pass " + Math.min(pass, passes) + "/" + passes + " · " : "") + rows.length + (rows.length === 1 ? " hop" : " hops") + (end && end.avg != null && state !== "live" ? " · " + end.avg.toFixed(1) + " ms to " + target : "");
      const text = ["#  " + "Host".padEnd(16) + "Loss".padStart(5) + "Last".padStart(7) + "Avg".padStart(7) + "Best".padStart(7) + "Wrst".padStart(7)]
        .concat(rows.map(r => String(r.n).padEnd(3) + r.host.slice(0, 16).padEnd(16) + (r.loss + "%").padStart(5) + f1(r.last).padStart(7) + f1(r.avg).padStart(7) + f1(r.best).padStart(7) + f1(r.worst).padStart(7))).join("\n");
      const html = rows.length ? "<table class='hops'><thead><tr><th>#</th><th>Host</th><th>Loss</th><th>Last</th><th>Avg</th><th>Best</th><th>Wrst</th></tr></thead><tbody>" +
        rows.map((r, i) => "<tr" + (i === rows.length - 1 ? " class='dest'" : "") + "><td class='n'>" + r.n + "</td><td class='h" + (r.host === "???" ? " muted" : "") + "'>" + esc(r.host) + "</td><td class='" + lossCls(r.loss) + "'>" + r.loss + "%</td><td>" + f1(r.last) + "</td><td>" + f1(r.avg) + "</td><td>" + f1(r.best) + "</td><td>" + f1(r.worst) + "</td></tr>").join("") +
        "</tbody></table><div class='res-foot'>times in ms · ??? = that hop doesn't answer probes (common, usually harmless)</div>" : "<div class='res-wait'>Waiting for the first hops…</div>";
      return { status, text: "", html, copy: rows.length ? text : "" };   // the table is the display; text is only for Copy / the console mode
    }
  });
}

// ---- ports: open ports pop in as chips the moment nmap finds them, with a progress bar
function livePorts(target, opts) {
  opts = opts || {}; const open = new Map(), raw = []; let pct = 0;
  const ordered = () => [...open].sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10));
  const report = () => {   // the useful part of nmap's output: from the scan report to the "Nmap done" line (everything, if there was no report e.g. host not found)
    const i = raw.findIndex(l => /^Nmap scan report/.test(l)); if (i < 0) return raw.filter(l => l.trim()).join("\n");
    const j = raw.findIndex((l, k) => k > i && /^Read data files/.test(l));
    return raw.slice(i, j < 0 ? raw.length : j).concat(raw.filter(l => /^Nmap done/.test(l))).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  };
  return runLive({
    url: "/api/portscan/stream", body: { target }, title: opts.title || "Ports " + target, fallback: opts.fallback,
    onLine(line) {
      raw.push(line); let m;
      if ((m = line.match(/^Discovered open port (\d+\/\w+)/))) { if (!open.has(m[1])) open.set(m[1], ""); }
      else if ((m = line.match(/Timing: About ([\d.]+)% done/))) pct = Math.max(pct, +m[1]);
      else if (/^Completed (SYN|Connect) .*Scan/.test(line)) pct = 100;
      else if ((m = line.match(/^(\d+\/\w+)\s+open\S*\s+(\S+)/))) open.set(m[1], m[2]);
    },
    view(state, note) {
      const list = ordered(), n = list.length, live = state === "live";
      const status = headOf(state, note) + " · " + (live ? "scanning top 100 ports" + (pct ? " · " + Math.round(pct) + "%" : "") + " · " + n + " open" : n ? n + " open port" + (n === 1 ? "" : "s") + " found" : "no open ports found");
      const chips = list.map(([k, svc]) => { const [pt, pr] = k.split("/"); return "<span class='chip'><b>" + esc(pt) + "</b>/" + esc(pr) + (svc ? "<i>" + esc(svc) + "</i>" : "") + "</span>"; }).join("");
      const html = (live ? "<div class='pbar'><i style='width:" + Math.max(3, Math.round(pct)) + "%'></i></div>" : "") +
        "<div class='chips'>" + (chips || "<span class='res-wait'>" + (live ? "No open ports yet…" : "No open ports found in the top 100.") + "</span>") + "</div>";
      return { status, text: live ? "" : report(), html, copy: live ? (n ? "Open so far: " + list.map(x => x[0]).join(", ") : "") : report() };
    }
  });
}

$("btn-pingmon").onclick = () => {
  const b = $("btn-pingmon");
  if (liveOn) { stopLive(); return; }
  const t = target(); if (!t) return;
  b.textContent = "Stop Ping Monitor";
  livePing(t, 0, { title: "Ping Monitor " + t }).finally(() => { b.textContent = "Ping Monitor"; });
};
$("btn-trace").onclick = () => { const t = target(); if (t) liveTrace(t, { fallback: () => tool("Traceroute " + t, "/api/mtr", { target: t }) }); };
$("btn-portscan").onclick = () => { const t = target(); if (t) livePorts(t, { fallback: () => tool("Port Scan " + t, "/api/portscan", { target: t }) }); };
let devTimer = null, devPrev = null;
$("btn-devwatch").onclick = async () => {
  const b = $("btn-devwatch");
  if (devTimer) { clearInterval(devTimer); devTimer = null; devPrev = null; b.textContent = "Device Watch"; liveStatus(""); return; }
  b.textContent = "Stop Device Watch"; liveStatus("👀 Watching the LAN — rescans every 25s"); const pg = outPage, showL = (t) => show(t, pg);
  const scan = async () => { try {
    const d = await api("/api/devices", {}); const now = new Map((d.hosts || []).map(h => [h.ip, h]));
    let s = "Devices on LAN (" + now.size + "):\n" + [...now.values()].map(h => h.ip.padEnd(16) + (h.name || h.type || "").slice(0, 24).padEnd(26) + h.vendor).join("\n");
    if (devPrev) { const joined = [...now.keys()].filter(ip => !devPrev.has(ip)), left = [...devPrev.keys()].filter(ip => !now.has(ip));
      if (joined.length) s += "\n\n+ JOINED: " + joined.join(", "); if (left.length) s += "\n- LEFT: " + left.join(", "); if (!joined.length && !left.length) s += "\n\n(no changes since last scan)"; }
    devPrev = now; showL(s + "\n\n(tap Stop to end)");
  } catch (e) { showL(e.message); } };
  scan(); devTimer = setInterval(scan, 25000);
};

// ---------- signal graph (channel view, like Network Analyzer's Wi-Fi Signal tab) ----------
let sigBand = "2.4";
const SIG_COLORS = ["#3b82f6", "#22c55e", "#eab308", "#ec4899", "#22d3ee", "#a78bfa", "#ef4444", "#14b8a6", "#a3e635", "#f472b6", "#38bdf8", "#fb7185"];
const CH5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165];
const hashStr = (t) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return h; };
const dbmOf = (pct) => Math.max(-100, Math.min(-30, Math.round(pct / 2 - 100)));   // NetworkManager % = 2 x (dBm + 100)
function drawSignalGraph() {
  const c = $("sig-graph"); if (!c || !c.clientWidth) return;
  const { g, W, H, d } = prep(c); const f = (n) => n * d;
  const nets = lastNets.filter(n => n.band === sigBand).map(n => ({ ssid: n.ssid === "(hidden)" ? "<hidden>" : n.ssid, ch: +n.ch, dbm: dbmOf(+n.sig) })).filter(n => n.ch > 0);
  const L = f(40), B = f(24), T = f(8), R = f(10), PW = W - L - R, PH = H - B - T;
  // x axis: 2.4 GHz is one channel every 5 MHz (13 channels); 5 / 6 GHz use one slot per 20 MHz channel
  let slots, pos, half;
  if (sigBand === "2.4") { slots = Array.from({ length: 13 }, (_, i) => i + 1); pos = (ch) => ch; half = { base: 2.3, top: 1.7 }; }
  else {
    const seen = nets.map(n => n.ch);
    if (sigBand === "5") slots = [...new Set([...CH5, ...seen])].sort((a, b) => a - b);
    else { const lo = Math.min(...seen, 1) , hi = Math.max(...seen, 1); slots = []; for (let ch = Math.max(1, lo - 8); ch <= hi + 8; ch += 4) slots.push(ch); }
    const idx = new Map(slots.map((ch, i) => [ch, i + 1])); pos = (ch) => idx.get(ch) ?? 1; half = { base: 1.05, top: 0.8 };
  }
  const lo = sigBand === "2.4" ? -1 : -0.6, hi = (sigBand === "2.4" ? 14 : slots.length + 1.6);
  const X = (v) => L + ((v - lo) / (hi - lo)) * PW, Y = (dbm) => T + ((-30 - dbm) / 70) * PH;
  // grid + axis labels
  g.font = f(11) + "px sans-serif"; g.textBaseline = "middle"; g.textAlign = "right";
  for (let v = -30; v >= -100; v -= 10) { g.strokeStyle = GRID; g.lineWidth = 1; g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(W - R, Y(v)); g.stroke(); g.fillStyle = AXIS; g.fillText(String(v), L - f(6), Y(v)); }
  g.textAlign = "center"; g.textBaseline = "top";
  slots.forEach((ch, i) => { const x = X(sigBand === "2.4" ? ch : i + 1); g.strokeStyle = "rgba(147,161,189,.09)"; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + PH); g.stroke();
    if (sigBand === "2.4" || slots.length < 14 || i % 2 === 0) { g.fillStyle = AXIS; g.fillText(String(ch), x, T + PH + f(5)); } });
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  const note = $("sig-note");
  if (!nets.length) { g.fillStyle = AXIS; g.font = f(14) + "px sans-serif"; g.textAlign = "center"; g.fillText(lastNets.length ? "No " + sigBand + " GHz networks seen" : "Tap Scan to survey networks", L + PW / 2, T + PH / 2); g.textAlign = "left";
    note.textContent = lastNets.length ? "No " + sigBand + " GHz networks in range." : "Scanning for networks…"; return; }
  // shapes: weakest first so the strong ones sit on top; the network we're connected to is always orange
  const shown = nets.slice().sort((a, b) => a.dbm - b.dbm);
  const colorOf = (n) => n.ssid === currentSsid ? "#f97316" : SIG_COLORS[hashStr(n.ssid) % SIG_COLORS.length];
  shown.forEach(n => {
    const cx = pos(n.ch), col = colorOf(n), x0 = X(cx - half.base), x1 = X(cx - half.top), x2 = X(cx + half.top), x3 = X(cx + half.base), yb = T + PH, yt = Y(n.dbm);
    g.beginPath(); g.moveTo(x0, yb); g.lineTo(x1, yt); g.lineTo(x2, yt); g.lineTo(x3, yb);
    g.globalAlpha = .16; g.fillStyle = col; g.fill(); g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = n.ssid === currentSsid ? f(2.5) : f(1.5); g.stroke();
  });
  // labels: strongest first, nudged down inside their shape when they'd overlap an earlier label
  const boxes = []; g.font = "500 " + f(11) + "px sans-serif"; g.textBaseline = "alphabetic";
  shown.slice().reverse().forEach(n => {
    const w = g.measureText(n.ssid).width, cx = Math.max(L + w / 2, Math.min(W - R - w / 2, X(pos(n.ch)))); let y = Y(n.dbm) - f(4);
    for (let k = 0; k < 10; k++) { const hit = boxes.some(b => cx - w / 2 < b.x1 && cx + w / 2 > b.x0 && y - f(11) < b.y1 && y > b.y0); if (!hit) break; y += f(13); }
    if (y > T + PH - f(2)) return; boxes.push({ x0: cx - w / 2, x1: cx + w / 2, y0: y - f(11), y1: y });
    g.fillStyle = colorOf(n); g.textAlign = "center"; g.fillText(n.ssid, cx, y);
  });
  g.textAlign = "left";
  note.textContent = nets.length + " network" + (nets.length === 1 ? "" : "s") + " on " + sigBand + " GHz · orange = the one this Pi is on · dBm estimated from signal %";
}
document.querySelectorAll("#sig-seg button").forEach(b => b.onclick = () => {
  sigBand = b.dataset.b; document.querySelectorAll("#sig-seg button").forEach(x => x.classList.toggle("on", x === b)); drawSignalGraph();
});
window.addEventListener("resize", () => { if (pageShown("wifi")) drawSignalGraph(); });

// ---------- tools tab: pick a tool, type a target, Start ----------
const TOOL_BTN = { ping: "btn-ping", monitor: "btn-pingmon", trace: "btn-trace", ports: "btn-portscan", dns: "btn-dns", iperf: "btn-iperf" };
const TOOL_HINTS = { ping: "Live ping — 10 probes, each reply appears as it arrives.", monitor: "Live continuous ping — every reply appears instantly until you tap Stop.", trace: "Live route — each hop fills in as it answers (10 passes). Tap Stop to end early.", ports: "Live port scan (top 100) — open ports pop in the moment they're found.", dns: "Look the name up (A / AAAA / reverse).", iperf: "LAN speed test against an iperf3 server at the target." };
let toolSel = "ping";
function startBtnLabel() { $("tool-start").textContent = liveOn ? "Stop" : "Start"; }
function toolHint() { $("tool-hint").textContent = TOOL_HINTS[toolSel]; $("iperf-info").classList.toggle("hidden", toolSel !== "iperf"); startBtnLabel(); }
function startTool() { if (liveOn) { stopLive(); return; } $(TOOL_BTN[toolSel]).click(); }
document.querySelectorAll("#tool-seg button").forEach(b => b.onclick = () => {
  toolSel = b.dataset.tool; document.querySelectorAll("#tool-seg button").forEach(x => x.classList.toggle("on", x === b)); toolHint();
});
$("tool-start").onclick = startTool;
$("target").addEventListener("keydown", (e) => { if (e.key === "Enter") startTool(); });

// admin finder
const ADMIN = { "443": ["https", "https"], "8443": ["https", "https-alt"], "8043": ["https", "Omada?"], "80": ["http", "http"], "8080": ["http", "http-alt"], "8088": ["http", "Omada?"] };
$("admin-btn").onclick = async () => {
  busy("Scanning LAN for admin pages");
  try {
    const d = await api("/api/admin/find", {}); const box = $("admin-links"); box.innerHTML = "";
    if (!d.hosts || !d.hosts.length) { show("None found."); busy(""); return; }
    d.hosts.forEach(h => h.ports.forEach(p => { const [scheme, label] = ADMIN[p]; const a = document.createElement("a");
      a.href = scheme + "://" + h.ip + (p === "80" || p === "443" ? "" : ":" + p); a.target = "_blank"; a.rel = "noopener noreferrer";
      a.innerHTML = esc(h.ip + ":" + p) + "<span class='tag'>" + label + "</span>"; box.appendChild(a); }));
    show("Found " + d.hosts.length + " device(s) with admin pages (links on the Network page). 8043/8088 = likely Omada.");
  } catch (e) { show(e.message); }
  busy("");
};

// ---------- speedometer (Speed tab): the Pi streams the Ookla test live (POST /api/speedtest/stream) and the needle follows it ----------
const GSTOPS = [0, 5, 10, 25, 50, 100, 250, 500, 750, 1000];          // non-linear dial: slow links stay readable, gigabit still fits
const gFrac = (v) => { v = Math.max(0, +v || 0); if (v >= 1000) return 1; for (let i = 1; i < GSTOPS.length; i++) if (v <= GSTOPS[i]) return (i - 1 + (v - GSTOPS[i - 1]) / (GSTOPS[i] - GSTOPS[i - 1])) / (GSTOPS.length - 1); return 1; };
const SP_DN = "#f97316", SP_UP = "#3b82f6", SP_PING = "#22d3ee", SP_REST = "#64748b";   // orange = download, blue = upload, cyan = ping, slate = at rest
const SP = { phase: "idle", target: 0, num: 0, dispF: 0, label: "READY", color: SP_REST, ping: null, jitter: null, down: null, up: null, prog: 0, samples: [], t0: 0, res: null };
let spRaf = 0, spLast = 0, speedOn = false;
function spReadout() {
  if (SP.phase === "idle") return "—";
  if (SP.phase === "ping") return SP.ping == null ? "…" : SP.ping.toFixed(0);
  if (SP.phase === "done") return "✓";
  if (SP.phase === "failed") return "!";
  return SP.num < 10 ? SP.num.toFixed(1) : String(Math.round(SP.num));
}
// one dial renderer for both gauges: the big speedometer (Speed tab) and the mini "last speed test" dial (Info)
// st = { fr: needle position 0..1, color, readout, label, idle, failed }
function drawDial(c, st, mini) {
  if (!c || !c.clientWidth) return;
  const { g, W, H, d } = prep(c), f = (n) => n * d, k = mini ? 0.5 : 1, cx = W / 2, cy = H * (mini ? 0.5 : 0.54), R = mini ? Math.min(W * 0.36, H * 0.38) : Math.min(W * 0.355, H * 0.40);
  const A0 = (135 * Math.PI) / 180, SWP = (270 * Math.PI) / 180, ang = (fr) => A0 + SWP * fr, n = GSTOPS.length;
  g.lineCap = "round";
  // track + the coloured arc up to the needle
  g.lineWidth = f(15 * k); g.strokeStyle = "#13233f"; g.beginPath(); g.arc(cx, cy, R, A0, A0 + SWP); g.stroke();
  const fr = st.fr;
  if (fr > 0.003) { g.save(); g.shadowColor = st.color; g.shadowBlur = f(14 * k); g.strokeStyle = st.color; g.beginPath(); g.arc(cx, cy, R, A0, ang(fr)); g.stroke(); g.restore(); }
  // ticks (+ the scale labels on the big dial only)
  g.lineWidth = f(1.5 * (mini ? 0.8 : 1)); g.lineCap = "butt";
  for (let i = 0; i < n; i++) {
    const a = ang(i / (n - 1)), cos = Math.cos(a), sin = Math.sin(a), t0 = R + f(12 * k), t1 = R + f(18 * k);
    g.strokeStyle = "rgba(147,161,189,.55)"; g.beginPath(); g.moveTo(cx + cos * t0, cy + sin * t0); g.lineTo(cx + cos * t1, cy + sin * t1); g.stroke();
    if (!mini) { g.fillStyle = "#93a1bd"; g.font = f(11) + "px Roboto, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(GSTOPS[i]), cx + cos * (R + f(31)), cy + sin * (R + f(31))); }
    if (!mini && i < n - 1) { const m = ang((i + 0.5) / (n - 1)); g.strokeStyle = "rgba(147,161,189,.28)"; g.beginPath(); g.moveTo(cx + Math.cos(m) * (R + f(12)), cy + Math.sin(m) * (R + f(12))); g.lineTo(cx + Math.cos(m) * (R + f(16)), cy + Math.sin(m) * (R + f(16))); g.stroke(); }
  }
  // the needle (tapered, glowing in the phase colour) + hub
  g.save(); g.translate(cx, cy); g.rotate(ang(fr));
  g.shadowColor = st.color; g.shadowBlur = f(10 * k); g.fillStyle = "#f1f5f9";
  g.beginPath(); g.moveTo(R + f(2 * k), 0); g.lineTo(-f(14 * k), -f(4.5 * k)); g.lineTo(-f(14 * k), f(4.5 * k)); g.closePath(); g.fill(); g.restore();
  g.fillStyle = "#0b1730"; g.strokeStyle = st.color; g.lineWidth = f(3 * k); g.beginPath(); g.arc(cx, cy, f(11 * k), 0, Math.PI * 2); g.fill(); g.stroke();
  // readout in the gap at the bottom of the dial
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  g.fillStyle = st.failed ? "#f87171" : st.idle ? "#475569" : "#f8fafc"; g.font = "700 " + f(mini ? 21 : 50) + "px Roboto, system-ui, sans-serif"; g.fillText(st.readout, cx, cy + R * (mini ? 0.82 : 0.66));
  g.fillStyle = st.color; g.font = "600 " + f(mini ? 9 : 12) + "px Roboto, system-ui, sans-serif";
  g.fillText(mini ? st.label : st.label.split("").join(String.fromCharCode(8202)), cx, cy + R * (mini ? 0.82 : 0.66) + f(mini ? 12 : 22));
}
function drawGauge() {
  const unit = SP.phase === "ping" ? "ms" : (SP.phase === "download" || SP.phase === "upload") ? "Mbps" : "";
  drawDial($("sp-gauge"), { fr: SP.dispF, color: SP.color, readout: spReadout(), label: SP.label + (unit ? " · " + unit : ""), idle: SP.phase === "idle", failed: SP.phase === "failed" }, false);
}
function spKick() { if (!spRaf) { spLast = performance.now(); spRaf = requestAnimationFrame(spAnimate); } }
function spAnimate(ts) {
  spRaf = 0; const dt = Math.min(0.1, Math.max(0, (ts - spLast) / 1000)); spLast = ts;
  const tf = gFrac(SP.target);
  SP.dispF += (tf - SP.dispF) * (1 - Math.exp(-dt * 6));     // the needle glides toward the live value
  SP.num += (SP.target - SP.num) * (1 - Math.exp(-dt * 9));
  drawGauge();
  if (speedOn || Math.abs(tf - SP.dispF) > 0.002 || Math.abs(SP.target - SP.num) > 0.1) spKick();
}
function spTiles() {
  const val = { ping: SP.ping, jitter: SP.jitter, down: SP.down, up: SP.up };
  document.querySelectorAll("#sp-tiles .tile").forEach(t => {
    const k = t.dataset.k, v = val[k];
    t.querySelector("b").textContent = v == null ? "—" : v >= 100 ? String(Math.round(v)) : v.toFixed(1);
    t.classList.toggle("on", SP.phase === (k === "down" ? "download" : k === "up" ? "upload" : "ping") && (k === "ping" || k === "down" || k === "up"));
  });
}
function drawTrace() {
  const c = $("sp-trace"); if (!c || !c.clientWidth || !SP.samples.length) return;
  const { g, W, H, d } = prep(c), f = (n) => n * d, L = f(40), B = f(16), T = f(8), R = f(8), PW = W - L - R, PH = H - B - T;
  const tmax = Math.max(10000, ...SP.samples.map(x => x.t)), sc = niceScale(Math.max(10, ...SP.samples.map(x => x.v))), X = (t) => L + (t / tmax) * PW, Y = (v) => T + PH - (v / sc.top) * PH;
  g.font = f(10) + "px sans-serif"; g.textAlign = "right"; g.textBaseline = "middle";
  for (let i = 0; i <= sc.n; i++) { const v = sc.step * i; g.strokeStyle = GRID; g.lineWidth = 1; g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(W - R, Y(v)); g.stroke(); g.fillStyle = AXIS; g.fillText(String(Math.round(v)), L - f(5), Y(v)); }
  g.textAlign = "left"; g.textBaseline = "alphabetic"; g.fillStyle = AXIS; g.fillText("Mbps over time", L + f(4), H - f(3));
  ["download", "upload"].forEach(ph => {
    const pts = SP.samples.filter(x => x.ph === ph); if (pts.length < 2) return; const col = ph === "download" ? SP_DN : SP_UP;
    g.beginPath(); g.moveTo(X(pts[0].t), Y(0)); pts.forEach(x => g.lineTo(X(x.t), Y(x.v))); g.lineTo(X(pts[pts.length - 1].t), Y(0)); g.closePath(); g.globalAlpha = .16; g.fillStyle = col; g.fill(); g.globalAlpha = 1;
    g.beginPath(); pts.forEach((x, i) => i ? g.lineTo(X(x.t), Y(x.v)) : g.moveTo(X(x.t), Y(x.v))); g.strokeStyle = col; g.lineWidth = f(2); g.lineJoin = "round"; g.stroke();
  });
}
function spMsg(text, cls) { const m = $("sp-msg"); m.textContent = text || ""; m.className = "sp-msg small " + (cls || "muted"); }
function spNote(text) { $("sp-note").textContent = text; }
function speedIdle(row) {   // resting state: show the last test's numbers (never while a test runs or right after one finished)
  if (speedOn || SP.phase !== "idle" || !row) return;
  SP.down = row.down; SP.up = row.up; SP.ping = row.ping; SP.jitter = null; spTiles();
  spNote("last: " + fmtTs(row.ts) + " · grade " + row.grade);
}
function spResult(r) {
  const rise = (ms, rs) => (ms == null ? "—" : ms + " ms") + (rs > 0 ? " (+" + rs + ")" : "");
  const box = $("sp-result");
  box.innerHTML = "<div class='row grade-row'><span class='lbl'><b>Bufferbloat grade</b><br><span class='muted small'>A+/A clean · B fine · C/D lag when busy · F badly buffered</span></span><span class='val'><span class='gradechip g-" + esc(String(r.grade || "").replace("+", "")) + "'>" + esc(r.grade) + "</span></span></div>" +
    kv("Server", esc(r.server || "—")) + kv("ISP", esc(r.isp || "—")) + kv("Latency under load", "↓ " + esc(rise(r.down_lat, r.rise_down)) + " · ↑ " + esc(rise(r.up_lat, r.rise_up))) +
    kv("Packet loss", r.loss == null ? "n/a" : esc(r.loss + "%")) + (r.note ? "<div class='row note'><span class='muted small' style='white-space:pre-line'>" + esc(r.note) + "</span></div>" : "") +
    (r.url ? "<div class='row'><span class='lbl'>Result page</span><span class='val'><a href='" + esc(r.url) + "' target='_blank' rel='noopener noreferrer'>open ↗</a></span></div>" : "");
  box.classList.remove("hidden");
}
function spEvent(ev) {
  const mbps = (b) => (b * 8) / 1e6;
  switch (ev.type) {
    case "testStart": spMsg(ev.server ? "Server: " + ev.server.name + " — " + ev.server.location : "Starting…", "live"); break;
    case "ping": SP.phase = "ping"; SP.label = "PING"; SP.color = SP_PING; SP.target = 0; SP.ping = ev.ping.latency; SP.jitter = ev.ping.jitter; SP.prog = ev.ping.progress; spNote("● PING"); break;
    case "download": case "upload": {
      const ph = ev.type, d = ev[ph];
      if (SP.phase !== ph) { SP.phase = ph; SP.label = ph.toUpperCase(); SP.color = ph === "download" ? SP_DN : SP_UP; spMsg(ph === "download" ? "Measuring download…" : "Measuring upload…", "live"); }
      SP.target = mbps(d.bandwidth); SP[ph === "download" ? "down" : "up"] = SP.target; SP.prog = d.progress;
      SP.samples.push({ t: performance.now() - SP.t0, v: SP.target, ph }); drawTrace(); $("sp-trace").classList.remove("hidden");
      spNote("● " + SP.label + " · " + Math.round(d.progress * 100) + "%"); break;
    }
    case "retry": spMsg("First attempt didn't work (common right after a WiFi change) — retrying…", "err"); SP.samples = []; break;
    case "log": if (ev.level === "error") spMsg("⚠ " + ev.message, "err"); break;
    case "failed": SP.phase = "failed"; SP.label = "FAILED"; SP.color = "#f87171"; SP.target = 0; spMsg("Speed test failed — check the WiFi link, then try again.", "err"); break;
    case "summary": SP.res = ev; SP.phase = "done"; SP.label = "DONE"; SP.color = SP_REST; SP.target = 0; SP.down = ev.down; SP.up = ev.up; SP.ping = ev.ping; SP.jitter = ev.jitter;
      spMsg(""); spNote("✔ " + ev.down + " ↓ / " + ev.up + " ↑ Mbps · grade " + ev.grade); spResult(ev); break;
  }
  spTiles(); spKick();
}
async function startSpeed() {
  if (speedOn) { stopLive(); return; }                          // the button doubles as Stop
  if (curPage !== "monitor") goto("monitor");
  stopLive();
  const ctl = liveCtl = new AbortController(); liveOn = ctl; livePg = "monitor"; speedOn = true;
  Object.assign(SP, { phase: "ping", target: 0, num: 0, dispF: 0, label: "PING", color: SP_PING, ping: null, jitter: null, down: null, up: null, prog: 0, samples: [], t0: performance.now(), res: null });
  $("sp-result").classList.add("hidden"); $("sp-trace").classList.add("hidden"); $("btn-speed2").textContent = "Stop"; spMsg("Connecting…", "live"); spNote("● starting"); spTiles(); renderHeader(); spKick();
  let outcome = "done";
  try {
    const res = await streamSSE("/api/speedtest/stream", {}, ctl.signal, spEvent);
    if (res === "unsupported") outcome = "unsupported";
    else if (SP.phase !== "done" && SP.phase !== "failed") outcome = "lost";
  } catch (e) { outcome = e.name === "AbortError" ? "stopped" : "error:" + e.message; }
  speedOn = false; if (liveCtl === ctl) liveCtl = liveOn = livePg = null;
  $("btn-speed2").textContent = "Start Test"; renderHeader();
  if (outcome === "unsupported") { Object.assign(SP, { phase: "idle", target: 0, label: "READY", color: SP_REST }); spMsg(""); spNote("—"); spTiles(); spKick(); await tool("Speed Test (~30s)", "/api/speedtest"); }
  else if (outcome === "stopped") { Object.assign(SP, { phase: "idle", target: 0, label: "STOPPED", color: SP_REST }); spMsg("Stopped — nothing was saved.", "muted"); spNote("stopped"); }
  else if (outcome === "lost" || outcome.startsWith("error:")) { Object.assign(SP, { phase: "failed", target: 0, label: "INTERRUPTED", color: "#f87171" }); spMsg("⚠ " + (outcome.startsWith("error:") ? outcome.slice(6) : "Connection to the Pi was lost mid-test."), "err"); spNote("interrupted"); }
  spTiles(); spKick();
  if (pageShown("monitor")) refreshNetmon(); if (pageShown("home")) refreshHome();
}
window.addEventListener("resize", () => { if (pageShown("monitor")) { drawGauge(); drawTrace(); } if (pageShown("home")) hgDraw(); });
// ---- "Last Speed Test" card on Info: the mini dial sweeps to the last stored download speed each time the page opens
const HG = { value: 0, num: 0, dispF: 0, has: false, raf: 0, last: 0 };
function hgDraw() { drawDial($("home-gauge"), { fr: HG.dispF, color: HG.has ? SP_DN : SP_REST, readout: HG.has ? (HG.num < 10 ? HG.num.toFixed(1) : String(Math.round(HG.num))) : "—", label: HG.has ? "↓ Mbps" : "no test yet", idle: !HG.has }, true); }
function hgKick() { if (!HG.raf) { HG.last = performance.now(); HG.raf = requestAnimationFrame(hgAnimate); } }
function hgAnimate(ts) {
  HG.raf = 0; const dt = Math.min(0.1, Math.max(0, (ts - HG.last) / 1000)); HG.last = ts;
  const tf = HG.has ? gFrac(HG.value) : 0;
  HG.dispF += (tf - HG.dispF) * (1 - Math.exp(-dt * 4.5)); HG.num += ((HG.has ? HG.value : 0) - HG.num) * (1 - Math.exp(-dt * 5.5));
  hgDraw();
  if (Math.abs(tf - HG.dispF) > 0.002 || Math.abs((HG.has ? HG.value : 0) - HG.num) > 0.1) hgKick();
}
const ago = (ts) => { const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60)); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
function homeSpeed(row) {
  HG.has = !!row; HG.value = row ? row.down : 0; document.querySelector(".hs-vals").classList.toggle("empty", !row);
  $("hs-when").textContent = row ? ago(row.ts) + (row.source ? " · " + row.source : "") : "no test yet";
  $("hs-down").textContent = row ? String(Math.round(row.down)) : "—"; $("hs-up").textContent = row ? String(Math.round(row.up)) : "—"; $("hs-ping").textContent = row ? String(Math.round(row.ping)) : "—";
  const gr = $("hs-grade"); gr.classList.toggle("hidden", !row || !row.grade); if (row && row.grade) { gr.textContent = row.grade; gr.className = "gradechip sm g-" + String(row.grade).replace("+", ""); }
  hgKick();
}
$("home-speedcard").onclick = () => goto("monitor");


// ---------- monitor ----------
let nmHours = 24;
const DPR = () => Math.min(window.devicePixelRatio || 1, 3);
function prep(c) { const d = DPR(); const W = c.width = Math.max(1, Math.round(c.clientWidth * d)); const H = c.height = Math.max(1, Math.round(c.clientHeight * d)); const g = c.getContext("2d"); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); return { g, W, H, d }; }
const GRID = "rgba(147,161,189,.16)", AXIS = "#93a1bd";
// round axis: pick a 1/2/2.5/5 x 10^n step so the top tick is a clean number (e.g. 0 / 250 / 500 / 750)
function niceScale(v) { const raw = v / 4, pw = Math.pow(10, Math.floor(Math.log10(raw))); const step = [1, 2, 2.5, 5, 10].map(m => m * pw).find(x => x >= raw); const top = Math.ceil(v / step) * step; return { step, top, n: Math.round(top / step) }; }
function drawTimeline(points, hours) {
  const c = $("nm-timeline"); const { g, W, H, d } = prep(c); const f = (n) => n * d;
  g.strokeStyle = GRID; g.lineWidth = 1; [0.25, 0.5, 0.75].forEach(y => { g.beginPath(); g.moveTo(0, H * y); g.lineTo(W, H * y); g.stroke(); });
  if (!points.length) { g.fillStyle = AXIS; g.font = f(13) + "px sans-serif"; g.fillText("no data yet", f(16), H / 2); return; }
  const t0 = Date.now() / 1000 - hours * 3600, span = hours * 3600; const bw = Math.max(2, W * (points.length > 1 ? (points[1].t - points[0].t) : 60) / span); const maxMs = Math.max(50, ...points.map(p => p.ms || 0));
  points.forEach(p => { const x = (p.t - t0) / span * W; g.fillStyle = p.pct >= 99 ? "#16a34a" : p.pct >= 50 ? "#f59e0b" : "#dc2626"; g.fillRect(x, H * 0.62, bw + 1, H * 0.38);
    if (p.ms != null) { g.fillStyle = "#60a5fa"; g.fillRect(x, H * 0.58 - (p.ms / maxMs) * H * 0.5, bw + 1, f(2)); } });
  g.fillStyle = AXIS; g.font = f(11) + "px sans-serif"; g.fillText(Math.round(maxMs) + " ms", f(8), f(14));
}
function drawSpeed(rows) {
  const c = $("nm-speed"); const { g, W, H, d } = prep(c); const f = (n) => n * d;
  const L = f(44), B = f(22), T = f(10), R = f(8); const PH = H - B - T, PW = W - L - R;
  const sc = niceScale(Math.max(10, ...rows.map(r => Math.max(r.down, r.up)))), max = sc.top; const y = (v) => T + PH - (v / max) * PH;
  g.font = f(11) + "px sans-serif"; g.textAlign = "right"; g.textBaseline = "middle";
  for (let i = 0; i <= sc.n; i++) { const v = sc.step * i; g.strokeStyle = GRID; g.lineWidth = 1; g.beginPath(); g.moveTo(L, y(v)); g.lineTo(W - R, y(v)); g.stroke(); g.fillStyle = AXIS; g.fillText(String(Math.round(v)), L - f(6), y(v)); }
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  if (!rows.length) { g.fillStyle = AXIS; g.font = f(13) + "px sans-serif"; g.fillText("no speed tests logged yet", L + f(12), H / 2); return; }
  const n = rows.length, slot = PW / n, bw = Math.max(3, slot * 0.36);
  rows.forEach((r, i) => { const x = L + i * slot + slot * 0.12; g.fillStyle = "#f97316"; g.fillRect(x, y(r.down), bw, T + PH - y(r.down));
    g.fillStyle = "#3b82f6"; g.fillRect(x + bw + 1, y(r.up), bw, T + PH - y(r.up));
    if (slot > f(14)) { g.fillStyle = "#e6ecf5"; g.font = f(10) + "px sans-serif"; g.fillText(r.grade || "", x, H - f(7)); } });
}
async function refreshNetmon() {
  try {
    const [st, tl, sp] = await Promise.all([api("/api/netmon/status?hours=" + nmHours), api("/api/netmon/timeline?hours=" + nmHours), api("/api/netmon/speed?hours=" + Math.max(nmHours, 168))]);
    $("nm-state").innerHTML = st.running ? "<span class='nm-ok'>● monitoring</span>" : "<span class='nm-bad'>● monitor not running</span>";
    const last = st.last;
    $("nm-summary").innerHTML = (st.uptime_pct == null ? "No samples yet." : "<b>Internet up " + st.uptime_pct + "%</b> of the last " + nmHours + " h" + (st.avg_ms ? " · avg " + st.avg_ms + " ms" : "") + " · gateway up " + st.gateway_pct + "% · " + st.outages.filter(o => o.end_ts).length + " outage(s)") +
      (last ? "<br><span class='small'>last check " + fmtTs(last.ts) + ": " + (last.inet_ok ? "<span class='nm-ok'>online</span>" : "<span class='nm-bad'>OFFLINE</span>") + (last.ssid ? " via " + esc(last.ssid) : last.iface ? " via " + esc(last.iface) : "") + (last.inet_ms ? " " + last.inet_ms + " ms" : "") + "</span>" : "") +
      (st.current_outage ? "<br><span class='nm-bad'>⚠ OUTAGE IN PROGRESS since " + fmtTs(st.current_outage.start_ts) + " — " + esc(st.current_outage.detail) + "</span>" : "");
    drawTimeline(tl.points || [], nmHours);
    const ev = (st.outages || []).filter(o => o.end_ts);
    $("nm-outages").innerHTML = ev.length ? "<div><b>Outages</b></div>" + ev.slice(0, 12).map(o => "<div>" + fmtTs(o.start_ts) + " — " + fmtDur(o.end_ts - o.start_ts) + " — " + esc(o.kind) + " (" + esc(o.detail) + ")</div>").join("") : "<div>No outages recorded in this window. 🎉</div>";
    const rows = sp.rows || []; drawSpeed(rows.slice(-40)); speedIdle(rows[rows.length - 1]);
    $("nm-speedlist").innerHTML = rows.slice(-6).reverse().map(r => "<div>" + fmtTs(r.ts) + " — <b>" + r.down + "</b> ↓ / <b>" + r.up + "</b> ↑ Mbps · " + r.ping + " ms · grade <b>" + r.grade + "</b> · " + r.source + "</div>").join("");
  } catch (e) { $("nm-state").textContent = "(unavailable)"; }
}
const nmSeg = () => { $("nm-24").classList.toggle("on", nmHours === 24); $("nm-7d").classList.toggle("on", nmHours === 168); };
$("nm-24").onclick = () => { nmHours = 24; nmSeg(); refreshNetmon(); };
$("nm-7d").onclick = () => { nmHours = 168; nmSeg(); refreshNetmon(); };

// ---------- settings ----------
function applySettings() {
  renderSub();
  $("set-site").value = settings.site_name || "";
  $("set-interval").value = String(settings.speed_interval_min ?? 60);
  $("about").innerHTML = "Jarvis Net Tools v" + esc(settings.version || "?") + " · Pi: " + esc(settings.hostname || "?") + "<br>Dashboard: Cockpit on port 9090 · Hotspot: JarvisPi-Manage";
  $("set-ipinfo").innerHTML = "ipinfo token: " + (settings.ipinfo_token_set ? "<span class='nm-ok'>configured</span>" : "<span class='nm-bad'>not set</span> — run <code>sudo nettools-set-ipinfo</code> on the Pi");
  renderHistorySince(settings.history_since);
  renderServiceChecks(); renderSavedDevices();
}
function renderHistorySince(h) {
  const why = { "new-day": "new day", "power-on": "power-on", manual: "cleared by hand", finished: "visit finished" };
  $("hist-since").textContent = h && h.ts ? fmtTs(h.ts) + " · " + (why[h.reason] || "cleared") : "—";
}
$("btn-hist-clear").onclick = async () => {
  if (!window.confirm("Clear all history now?\n\nSpeed tests, uptime and outages and the tool results are deleted.\nSettings, saved devices and Wi-Fi networks stay.")) return;
  try {
    const d = await api("/api/history/clear", {});
    if (!d.ok) { show("❌ " + (d.error || "Could not clear the history.")); return; }
    renderHistorySince(d.history_since); settings.history_since = d.history_since;
    show("✅ History cleared. The next site report starts from now.");
  } catch (e) { show(e.message); }
};
async function loadSettings(quiet) {
  try { settings = await api("/api/settings"); applySettings(); } catch (e) { if (!quiet) show(e.message); }
}
$("set-save-site").onclick = async () => {
  const d = await saveSettings({ site_name: $("set-site").value.trim(), speed_interval_min: parseInt($("set-interval").value, 10) });
  show(d.ok ? "Saved. Site: " + (d.site_name || "(none)") + " · auto speed test: " + (d.speed_interval_min ? "every " + d.speed_interval_min + " min" : "off") : "Could not save.");
};
function renderServiceChecks() {
  const box = $("svc-list"); const list = settings.service_checks || []; box.innerHTML = list.length ? "" : "<div class='empty'>No custom checks yet.</div>";
  list.forEach((s, idx) => {
    const row = document.createElement("div"); row.className = "item";
    row.innerHTML = "<div class='txt'><div class='n'>" + esc(s.name) + "</div><div class='s'>" + esc(s.type) + " · " + esc(s.target) + "</div></div>";
    const x = document.createElement("button"); x.className = "tiny danger"; x.textContent = "remove";
    x.onclick = async () => { await saveSettings({ service_checks: list.filter((_, j) => j !== idx) }); };
    row.appendChild(x); box.appendChild(row);
  });
}
$("svc-add").onclick = async () => {
  const name = $("svc-name").value.trim(), type = $("svc-type").value, t = $("svc-target").value.trim();
  if (!name || !t) { show("Need a name and a target."); return; }
  const before = (settings.service_checks || []).length;
  const d = await saveSettings({ service_checks: [...(settings.service_checks || []), { name, type, target: t }] });
  if ((d.service_checks || []).length > before) { $("svc-name").value = $("svc-target").value = ""; show("Added check “" + name + "”. It runs with every Service / POS Check."); }
  else show("That target wasn't accepted — https needs a full URL, tcp needs host:port, ping/dns need a hostname or IP.");
};
$("pw-change").onclick = async () => {
  const cur = $("pw-cur").value, n1 = $("pw-new").value, n2 = $("pw-new2").value;
  if (n1 !== n2) { show("New passwords don't match."); return; }
  try { const d = await api("/api/password", { current: cur, new: n1 }); show(d.ok ? "✅ Password changed. Use the new one next time you unlock." : "❌ " + (d.error || "failed")); if (d.ok) $("pw-cur").value = $("pw-new").value = $("pw-new2").value = ""; }
  catch (e) { show(e.message); }
};
const report = () => { const site = settings.site_name || ""; liveStatus("📄 Building the site report (~20s) — it opens in a new tab");
  const w = window.open("/api/report?site=" + encodeURIComponent(site), "_blank"); if (!w) show("Pop-up blocked — allow pop-ups for this app."); setTimeout(() => liveStatus(""), 25000); };
$("btn-report").onclick = report; $("btn-report2").onclick = report;

// ---------- setup hotspot (Settings) ----------
// The root service jarvis-hotspot-auto does the switching: we save the mode and show what it reports (every 3 s
// while Settings is open).
const HS_HINT = {
  auto: "Off while the Pi has a network. If it has none for 2 minutes (e.g. at a new site) the hotspot turns on by itself so you can set up Wi-Fi from your phone, and turns off again once the Pi is back online.",
  on: "Always on: phones can join {ssid} any time. It adds a network to the air you are testing and uses a little power.",
  off: "Never on, not even when the Pi has no network. Join Wi-Fi from this touch screen instead.",
};
let hsTimer = null, hsWant = null, hsUntil = 0;
const mmss = (s) => s == null ? "a moment" : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
function renderHotspot(d) {
  document.querySelectorAll("#hs-seg button").forEach(b => { const on = b.dataset.m === d.mode; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
  $("hs-ssid").textContent = d.ssid || "";
  $("hs-hint").textContent = HS_HINT[d.mode].replace("{ssid}", d.ssid || "the hotspot");
  const pending = hsWant === d.mode && Date.now() < hsUntil && ((d.mode === "on" && !d.active) || (d.mode === "off" && d.active));
  let txt, dot = "";
  if (!d.service) { txt = "Hotspot service not running"; dot = "warn"; }
  else if (d.error) { txt = d.error; dot = "bad"; }
  else if (pending) { txt = d.mode === "on" ? "Turning on…" : "Turning off…"; dot = "warn"; }
  else if (d.active) { txt = "On · " + d.clients + (d.clients === 1 ? " phone" : " phones") + " connected"; dot = "ok"; }
  else if (d.mode === "auto" && d.online === false) { txt = "Off · no network: turns on in " + mmss(d.fallback_in); dot = "warn"; }
  else if (d.mode === "auto") txt = "Off · the Pi has a network";
  else txt = "Off";
  $("hs-now").innerHTML = esc(txt) + "<i class='dot " + dot + "'></i>";
}
async function refreshHotspot() {
  clearTimeout(hsTimer);
  if (curPage !== "settings") return;
  try { renderHotspot(await api("/api/hotspot")); } catch (e) { $("hs-now").textContent = e.message; }
  if (curPage === "settings") hsTimer = setTimeout(refreshHotspot, 3000);
}
document.querySelectorAll("#hs-seg button").forEach(b => b.onclick = async () => {
  hsWant = b.dataset.m; hsUntil = Date.now() + 60000;
  try {
    const d = await api("/api/hotspot", { mode: hsWant });
    if (!d.ok) { show("❌ " + (d.error || "Could not change the hotspot.")); return; }
    renderHotspot(d);
  } catch (e) { show(e.message); return; }
  refreshHotspot();
});

// ---------- power ----------
// One dialog for the Info header ⏻ and Settings > Power. Nothing happens until a second tap on Shut Down / Restart;
// once a command is sent the dialog stays up (Esc / tapping outside can't close it) and shows what to do next.
const powerDlg = $("power-dlg");
let powerBusy = false;
function powerText(title, msg) { $("power-title").textContent = title; $("power-msg").textContent = msg; }
function openPower() {
  if (powerBusy) { if (!powerDlg.open) powerDlg.showModal(); return; }
  powerText("Turn off the Pi?", "Shuts down cleanly so the disk is safe. Restart brings it back by itself in about a minute.");
  $("power-btns").classList.remove("hidden");
  powerDlg.showModal(); $("power-cancel").focus();
}
$("btn-shutdown").onclick = openPower;
$("power-cancel").onclick = () => powerDlg.close();
powerDlg.addEventListener("click", (e) => { if (e.target === powerDlg && !powerBusy) powerDlg.close(); });   // tap on the dimmed backdrop = Cancel
powerDlg.addEventListener("cancel", (e) => { if (powerBusy) e.preventDefault(); });
powerDlg.addEventListener("close", () => { if (powerBusy) powerDlg.showModal(); });
$("power-off").onclick = () => powerDo("shutdown");
$("power-restart").onclick = () => powerDo("restart");

async function powerDo(action) {
  const restart = action === "restart";
  powerBusy = true; $("power-btns").classList.add("hidden");
  powerText(restart ? "Restarting…" : "Shutting down…", "Sending the command…");
  let d = {};
  try { d = await api("/api/shutdown", { action }); }
  catch (e) {
    if ($("app").classList.contains("hidden")) { powerBusy = false; powerDlg.close(); return; }   // 401: the login screen took over
    // otherwise the Pi may already be dropping the connection on its way down
  }
  if (d.error) {
    powerBusy = false; $("power-btns").classList.remove("hidden");
    powerText("Couldn't " + (restart ? "restart" : "shut down"), d.error); return;
  }
  if (restart) return powerWaitBack();
  const back = d.power_button ? "To turn it back on: press the power button on the case."
                              : "To turn it back on: unplug the power, wait a few seconds, plug it back in.";
  let n = 30;
  const tick = () => {
    if (n <= 0) { clearInterval(t); powerText("✅ Safe to unplug", "The Pi is off (green LED dark).\n" + back); return; }
    powerText("Shutting down…", "Do NOT unplug yet: safe in " + n + " s (or as soon as the green LED goes dark).\n" + back); n--;
  };
  tick(); const t = setInterval(tick, 1000);
}

// Restart: wait until the Pi has gone away and answers again, then reload (the touch screen's kiosk restarts with the Pi).
function powerWaitBack() {
  const t0 = Date.now(); let seenDown = false;
  const poll = async () => {
    const s = Math.round((Date.now() - t0) / 1000);
    let up = false;
    try {
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 2500);
      up = (await fetch("/api/me", { cache: "no-store", signal: ac.signal })).ok; clearTimeout(to);
    } catch (e) { up = false; }
    if (!up) seenDown = true;
    if (up && seenDown) { location.reload(); return; }
    if (up && s > 60) {
      powerBusy = false; $("power-btns").classList.remove("hidden");
      powerText("Still running", "The Pi didn't restart. Try again, or use the power button on the case."); return;
    }
    if (s > 300) { powerText("Not back yet", "The Pi hasn't come back after 5 minutes. Check its power and network, then reload this page."); return; }
    powerText("Restarting…", (seenDown ? "The Pi is restarting. This page reconnects by itself" : "Waiting for the Pi to go down") + " (" + s + " s)");
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
}

// ---------- boot ----------
$("dock-toggle").onclick = () => toggleDock();
toggleDock(true);   // console mode starts collapsed: it opens itself the moment a tool produces output
applyOutMode();
$("set-output").value = outMode();
$("set-output").onchange = () => { localStorage.setItem("outMode", $("set-output").value); applyOutMode(); toggleDock(true); };
fetch("/api/me").then(r => r.json()).then(d => { if (d.auth) showApp(); else showLogin(); }).catch(showLogin);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
