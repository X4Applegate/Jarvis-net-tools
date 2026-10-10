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
  wifi: { title: "Signal", actions: () => [scanning ? { text: "Scanning…", label: "Scanning", busy: true, fn: () => {} } : { text: "Scan", fn: () => $("wifi-scan-btn").click() }] },
  network: { title: "LAN", actions: () => [lanScanning ? { text: "Scanning…", label: "Scanning", busy: true, fn: () => {} } : { text: "Scan", fn: () => $("btn-devices2").click() }] },
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
    if (a.busy) { b.disabled = true; b.innerHTML = "<span class='spin'></span>" + esc(a.text); }
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
  if (page === "network") { renderSavedDevices(); lanShowLast(); }
  if (page === "tools") { iperfInfo(); toolHint(); }
  if (page === "monitor") { refreshNetmon(); spKick(); }
  if (page === "settings") { loadSettings(); refreshHotspot(); loadReports(); loadMail(); }
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
$("finish-share").onclick = () => { if (finishReport) { finishDlg.close(); openShare(finishReport, "Site report"); } };

// The report is the Pi's own HTML (inline styles only); a shadow root keeps its styles off the app, and the app's CSP
// still applies (no scripts).
const reportDlg = $("report-dlg");
let reportName = "";
async function openReport(name, title) {
  const url = "/api/reports/" + encodeURIComponent(name);
  const r = await fetch(url, { cache: "no-store" });
  if (r.status === 401) { showLogin(); return; }
  if (!r.ok) { show("That report is gone."); loadReports(); return; }
  const body = $("report-body"), root = body.shadowRoot || body.attachShadow({ mode: "open" });
  // In a shadow root there is no <html>/<body>, so the report's own body{...} rule (dark text on white) would match
  // nothing and the app's light text colour would show through: re-aim html/body rules at a wrapper div.
  const doc = new DOMParser().parseFromString(await r.text(), "text/html");
  const css = [...doc.querySelectorAll("style")].map(s => s.textContent).join("\n").replace(/(^|[},\s])(html|body)(?=\s*[{,])/g, "$1.rep-doc");
  root.innerHTML = "<style>:host{display:block;color:#111;background:#fff} .rep-doc{color:#111;background:#fff;margin:16px;" +
    "font:15px -apple-system,'Segoe UI',Roboto,sans-serif}</style><style>" + css + "</style><div class='rep-doc'>" + doc.body.innerHTML + "</div>";
  $("report-title").textContent = title; reportName = name;
  reportDlg.showModal(); body.scrollTop = 0;
}
$("report-close").onclick = () => reportDlg.close();
$("report-share").onclick = () => { reportDlg.close(); openShare(reportName, $("report-title").textContent); };

// ---------- Share a saved report: USB stick / email / download ----------
// Each option says whether it can be used right now; a USB stick plugged in while the dialog is open is picked up.
const shareDlg = $("share-dlg");
const onPi = ["127.0.0.1", "localhost"].includes(location.hostname);     // the touch screen: downloading makes no sense
let share = { name: "", dev: "", timer: null, busy: false };
function usbLabel(d) { return (d.label || d.model || d.dev) + " (" + (d.size / 1e9).toFixed(d.size >= 1e10 ? 0 : 1) + " GB, " + (d.fstype === "vfat" ? "FAT32" : "exFAT") + ")"; }
async function shareUsbCheck() {
  clearTimeout(share.timer);
  if (!shareDlg.open || share.busy) return;
  try {
    const drives = (await api("/api/usb")).drives || [];
    share.dev = drives.length ? drives[0].dev : "";
    $("share-usb").classList.toggle("off", !share.dev); $("share-usb-go").disabled = !share.dev;
    $("share-usb-st").textContent = share.dev ? "Ready: " + usbLabel(drives[0]) : "Plug in a USB stick (FAT32 or exFAT). It shows up here by itself.";
  } catch (e) { $("share-usb-st").textContent = e.message; }
  if (!share.dev) share.timer = setTimeout(shareUsbCheck, 3000);
}
async function openShare(name, title) {
  share.name = name; share.busy = false;
  $("share-what").textContent = title || name;
  $("share-usb-st").textContent = "Looking for a USB stick…"; $("share-usb-go").disabled = true;
  $("share-mail-st").textContent = ""; $("share-dl").classList.toggle("hidden", onPi);
  $("share-dl-html").href = "/api/reports/" + encodeURIComponent(name) + "?download=1";
  $("share-dl-pdf").href = "/api/reports/" + encodeURIComponent(name.replace(/\.html$/, ".pdf"));
  shareDlg.showModal(); shareUsbCheck();
  try {
    const m = await api("/api/mail");
    $("share-mail").classList.toggle("off", !m.ready); $("share-mail-go").disabled = !m.ready; $("share-mail-to").disabled = !m.ready;
    $("share-mail-to").value = (m.to || []).join(", ");
    $("share-mail-st").textContent = m.ready ? "" : "Set up email first: Settings > Email Reports.";
  } catch (e) { $("share-mail-st").textContent = e.message; }
}
$("share-close").onclick = () => { clearTimeout(share.timer); shareDlg.close(); };
shareDlg.addEventListener("close", () => clearTimeout(share.timer));
$("share-usb-go").onclick = async () => {
  share.busy = true; $("share-usb-go").disabled = true; $("share-usb-st").textContent = "Saving the report (PDF + HTML)… don't unplug yet.";
  try {
    const d = await api("/api/reports/usb", { name: share.name, dev: share.dev });
    $("share-usb-st").textContent = d.ok ? "✅ Saved to " + (d.label || d.model || "the USB stick") + " in the " + d.folder + " folder.\nSafe to unplug now."
                                         : "❌ " + (d.error || "Could not save.");
  } catch (e) { $("share-usb-st").textContent = e.message; }
  share.busy = false; $("share-usb-go").disabled = !share.dev;
};
$("share-mail-go").onclick = async () => {
  $("share-mail-go").disabled = true; $("share-mail-st").textContent = "Making the PDF and sending…";
  try {
    const d = await api("/api/reports/email", { name: share.name, to: $("share-mail-to").value });
    $("share-mail-st").textContent = d.ok ? "✅ Sent to " + d.to.join(", ") + "." : "❌ " + (d.error || "Could not send.");
  } catch (e) { $("share-mail-st").textContent = e.message; }
  $("share-mail-go").disabled = false;
};

// ---------- Settings > Email Reports ----------
async function loadMail() {
  try {
    const m = await api("/api/mail");
    $("mail-host").value = m.host; $("mail-sec").value = m.security; $("mail-port").value = m.port;
    $("mail-user").value = m.user; $("mail-from").value = m.from; $("mail-to").value = (m.to || []).join(", ");
    $("mail-pass").value = ""; $("mail-pass").placeholder = m.password_set ? "Password (saved - leave empty to keep it)" : "Password";
    $("mail-state").textContent = m.ready ? "ready" : "not set up";
  } catch (e) {}
}
$("mail-sec").onchange = () => { $("mail-port").value = $("mail-sec").value === "ssl" ? 465 : 587; };
$("mail-save").onclick = async () => {
  const body = { host: $("mail-host").value.trim(), security: $("mail-sec").value, port: $("mail-port").value, user: $("mail-user").value.trim(),
    password: $("mail-pass").value, from: $("mail-from").value.trim(), to: $("mail-to").value };
  try { const d = await api("/api/mail", body); show(d.ok ? "✅ Email settings saved." : "❌ " + (d.error || "Could not save.")); if (d.ok) loadMail(); }
  catch (e) { show(e.message); }
};
$("mail-test").onclick = async () => {
  show("Sending a test email…");
  try { const d = await api("/api/mail/test", {}); show(d.ok ? "✅ Test email sent to " + d.to.join(", ") + "." : "❌ " + (d.error || "Could not send.")); }
  catch (e) { show(e.message); }
};

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
      const sh = document.createElement("button"); sh.className = "tiny util"; sh.textContent = "Share";
      sh.onclick = () => openShare(r.name, r.site + " · " + fmtTs(r.ts));
      const del = document.createElement("button"); del.className = "tiny danger"; del.textContent = "Delete";
      del.onclick = async () => {
        if (!window.confirm("Delete the report " + r.site + " (" + fmtTs(r.ts) + ")?")) return;
        try { await api("/api/reports/delete", { name: r.name }); } catch (e) {}
        loadReports();
      };
      row.appendChild(open); row.appendChild(sh); row.appendChild(del); box.appendChild(row);
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
$("btn-ports").onclick = () => tvOpen("Open Ports (this Pi)", portsLoad);
$("btn-bw").onclick = () => { Object.assign(bw, { prev: null, hist: {}, peak: {}, total: {}, sel: null }); tvOpen("Bandwidth Now", bwLoad, 1000); };
$("btn-mtr").onclick = () => liveTrace("8.8.8.8", { title: "Path to Internet", fallback: () => tool("Path to Internet", "/api/mtr", {}) });
$("btn-pubip").onclick = () => tvOpen("Public IP & ISP", pubipLoad);
$("btn-dnscheck").onclick = () => tvOpen("DNS Check", dnsCheckLoad);
$("btn-dhcp").onclick = () => tvOpen("Rogue DHCP Check", dhcpLoad);
$("btn-jack").onclick = () => tvOpen("Ethernet Jack Test", jackLoad);
$("btn-services").onclick = () => services(); $("btn-services2").onclick = () => services();
const history = () => { hist.q = ""; hist.f = "All"; tvOpen("History", histLoad); };
$("btn-history").onclick = history; $("btn-history2").onclick = history;

// ---------- LAN: device list with badges (like a network analyzer app); tap a device for its details page ----------
let lastHosts = [], lanMeta = {}, lanScanning = false;
const savedName = (h) => { const s = (settings.saved_devices || []).find(x => h.mac && x.mac.toUpperCase() === h.mac.toUpperCase()); return s ? s.name : ""; };
const devTitle = (h) => savedName(h) || h.name || (h.upnp && h.upnp.friendly) || "";
const ipHtml = (ip) => { const i = ip.lastIndexOf("."); return esc(ip.slice(0, i + 1)) + "<b>" + esc(ip.slice(i + 1)) + "</b>"; };
const BADGE_CLS = { G: "G", W: "W", U: "U", B: "B", 6: "v6", P: "P", S: "S" };
const badges = (h) => (h.flags || []).map(f => "<i class='bd " + BADGE_CLS[f] + "' title='" + esc(f) + "'>" + esc(f) + "</i>").join("");
function renderDevList(hosts) {
  const box = $("dev-list"), q = $("lan-search").value.trim().toLowerCase();
  const shown = hosts.filter(h => !q || [devTitle(h), h.ip, h.vendor, h.mac, h.type].join(" ").toLowerCase().includes(q));
  $("lan-net").textContent = (lanMeta.network || "This network") + " (" + hosts.length + ")";
  $("lan-when").textContent = lanMeta.ts ? "scanned " + new Date(lanMeta.ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  box.innerHTML = "";
  if (!hosts.length && !lanScanning) box.innerHTML = "<div class='tv-empty'>No scan yet. Tap <b>Scan</b> to find every device on this network.</div>";
  else if (!shown.length && q) box.innerHTML = "<div class='tv-empty'>Nothing matches “" + esc(q) + "”.</div>";
  shown.forEach(h => {
    const b = document.createElement("button"); b.className = "dev-row"; b.dataset.ip = h.ip;
    const t = devTitle(h);
    b.innerHTML = "<div class='dr-l'><div class='dr-name" + (t ? "" : " none") + "'>" + esc(t || "(no name)") + "</div><div class='dr-ip'>" + ipHtml(h.ip) + "</div><div class='dr-ven'>" +
      esc([h.vendor, h.type].filter(Boolean).join(" · ") || "unknown vendor") + "</div></div><div class='dr-r'><div class='dr-ms'>" + (h.ping != null ? esc(String(h.ping)) + " ms" : "—") +
      "</div><div class='badges'>" + badges(h) + "</div></div><span class='chev'>›</span>";
    b.onclick = () => openDevice(h.ip);
    box.appendChild(b);
  });
  $("lan-legend").classList.toggle("hidden", !hosts.length);
}
$("lan-search").addEventListener("input", () => renderDevList(lastHosts));
async function lanShowLast() {
  if (lastHosts.length || lanScanning) { renderDevList(lastHosts); return; }
  try { const d = await api("/api/devices/last"); lastHosts = d.hosts || []; lanMeta = d; } catch (e) {}
  renderDevList(lastHosts);
}
async function findDevices() {
  if (lanScanning) return;                               // one scan at a time
  lanScanning = true; $("lan-scanning").classList.remove("hidden"); $("btn-devices2").disabled = true; if (curPage === "network") renderHeader();
  renderDevList(lastHosts);
  try {
    const d = await api("/api/devices", {});
    lastHosts = d.hosts || []; lanMeta = d;
  } catch (e) { $("lan-scanning").querySelector("b").textContent = "Scan failed: " + e.message; }
  lanScanning = false; $("lan-scanning").classList.add("hidden"); $("btn-devices2").disabled = false; if (curPage === "network") renderHeader();
  renderDevList(lastHosts);
}

// device details: what the scan found, every name source, and actions (Tools with this IP, Wake on LAN, web page, save)
function ddRow(k, v, ok) {
  const na = v == null || v === "" || (Array.isArray(v) && !v.length);
  return "<div class='dd-row'><span class='k'>" + esc(k) + "</span><span class='v" + (na ? " na" : "") + "'>" + (na ? "N/A" : v) + "</span><i class='dot " + (na ? "" : ok === false ? "bad" : "ok") + "'></i></div>";
}
function ddAction(id, label, value) { return "<button class='dd-row' id='" + id + "'><span class='k'>" + esc(label) + "</span><span class='v na'>" + (value || "") + "</span><span class='chev'>›</span></button>"; }
function goTool(tool, ip) {
  tvClose(); goto("tools"); $("target").value = ip;
  const b = document.querySelector("#tool-seg button[data-tool='" + tool + "']"); if (b) b.click();
  startTool();
}
function openDevice(ip) {
  tvOpen("Details", async () => {
    const h = lastHosts.find(x => x.ip === ip); if (!h) throw new Error("that device is not in the last scan");
    $("tv-title").textContent = devTitle(h) || h.ip;
    const n = h.names || {}, u = h.upnp || {};
    $("tv-body").innerHTML =
      "<div class='dd-sect'>Actions</div>" +
      ddAction("dd-ping", "Ping", "live") + ddAction("dd-trace", "Route (traceroute)", "") + ddAction("dd-ports", "Scan ports", "top 100") +
      (h.mac ? ddAction("dd-wol", "Wake on LAN", esc(h.mac)) : "") +
      (h.web ? "<a class='dd-row' id='dd-web' href='" + esc(h.web) + "' target='_blank' rel='noopener'><span class='k'>Web interface</span><span class='v'>" + esc(h.web) + "</span><span class='chev'>›</span></a>" : ddRow("Web interface", "")) +
      ddAction("dd-save", savedName(h) ? "Rename saved device" : "Save / name this device", esc(savedName(h))) +
      "<div id='dd-msg' class='dd-msg'></div>" +
      "<div class='dd-sect'>Device</div>" +
      ddRow("IP Address", esc(h.ip)) + ddRow("IPv6 Addresses", (h.ipv6 || []).map(esc).join("<br>")) + ddRow("MAC", esc(h.mac || "")) + ddRow("Vendor", esc(h.vendor || "")) +
      ddRow("Type", esc(h.type || "")) + ddRow("Pingable", h.ping != null ? "Yes · " + esc(String(h.ping)) + " ms" : "No reply (many devices ignore ping)", h.ping != null) +
      ddRow("Open ports", (h.ports || []).map(p => "<span class='port-chip'>" + esc(p) + "</span>").join("")) +
      "<div class='dd-sect'>Device Names</div>" +
      ddRow("Saved name", esc(savedName(h))) + ddRow("mDNS Name", esc(n.mdns || "")) + ddRow("NetBIOS Name", esc(n.netbios || "")) + ddRow("DNS Name", esc(n.dns || "")) +
      ddRow("UPnP Name", esc(u.friendly || "")) + ddRow("UPnP Model", esc([u.manufacturer, u.model].filter(Boolean).join(" "))) + ddRow("Web page title", esc(h.title || "")) +
      ddRow("Bonjour services", esc((h.services || []).join(", ")));
    $("dd-ping").onclick = () => goTool("ping", h.ip);
    $("dd-trace").onclick = () => goTool("trace", h.ip);
    $("dd-ports").onclick = () => goTool("ports", h.ip);
    if ($("dd-wol")) $("dd-wol").onclick = async () => {
      $("dd-msg").textContent = "Sending the wake-up packet…";
      try { const d = await api("/api/wol", { mac: h.mac }); $("dd-msg").textContent = d.error ? "❌ " + d.error : "✅ Wake-up packet sent to " + h.mac + ". It can take a minute to start."; }
      catch (e) { $("dd-msg").textContent = e.message; }
    };
    $("dd-save").onclick = async () => { await addSavedDevice(devTitle(h) || h.vendor || h.ip, h.mac, h.ip); renderDevList(lastHosts); tvRun(); };
  }, 0);
  $("tv-refresh").classList.add("hidden");
}
$("tv").addEventListener("close", () => $("tv-refresh").classList.remove("hidden"));
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
// a scan only feeds the channel graph and the Join dropdown (no text survey: the graph says the same, more clearly)
function renderScan() {
  const sel = $("wifi-list"), b = wantBand();
  const nets = lastNets.filter(n => b === "auto" || n.band === b);
  const seen = new Set(); sel.innerHTML = ""; netInfo = {};
  nets.forEach(n => { netInfo[n.ssid] = n; if (!n.ssid || n.ssid === "(hidden)" || seen.has(n.ssid)) return; seen.add(n.ssid);
    const o = document.createElement("option"); o.value = n.ssid; o.textContent = n.ssid + "  (" + n.sig + "%, " + n.band + "G ch " + n.ch + ")"; sel.appendChild(o); });
  if (!sel.options.length) sel.innerHTML = "<option>No named networks</option>";
  else if (currentSsid && [...sel.options].some(o => o.value === currentSsid)) sel.value = currentSsid;
  loadAps(false); drawSignalGraph();
}
// entering the WiFi page scans on its own (reuses a scan younger than 20 s instead of rescanning)
let lastScanTs = 0, scanning = false;
async function autoScan() {
  if (!currentSsid) await refreshStatus();
  if (lastNets.length && Date.now() - lastScanTs < 20000) { renderScan(); return; }
  $("wifi-scan-btn").click();
}
$("wifi-band").onchange = () => { if (lastNets.length) renderScan(); };   // (no text output either)
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
function scanBusy(on) {
  scanning = on;
  const b = $("wifi-scan-btn"); b.disabled = on;
  if (on) b.innerHTML = "<span class='spin'></span>Scanning…"; else b.textContent = "Scan Networks";
  $("sig-scanning").classList.toggle("hidden", !on); $("sig-graph").classList.toggle("dim", on);
  if (curPage === "wifi") renderHeader();
}
$("wifi-scan-btn").onclick = async () => {
  if (scanning) return;                                  // one scan at a time, however often it is tapped
  scanBusy(true);
  const sel = $("wifi-list"); sel.innerHTML = "<option>Scanning…</option>"; $("sig-note").textContent = "Scanning…";
  try {
    const d = await api("/api/scanall", {}); lastNets = d.networks || []; lastScanTs = Date.now(); renderScan();
  } catch (e) { $("sig-note").textContent = e.message; sel.innerHTML = "<option>Scan failed - tap Scan again</option>"; }
  scanBusy(false);
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
// ---------- full-screen tool page: open(title, {load, every}) -> load() runs now and every `every` ms while open ----------
const tv = { timer: null, load: null, every: 0, busy: false, paused: false };
function tvOpen(title, load, every) {
  tvClose(true);
  tv.load = load; tv.every = every || 0; tv.paused = false; tv.loaded = false;
  $("tv-title").textContent = title; $("tv-body").innerHTML = "<div class='tv-empty'><span class='spin'></span> Loading…</div>";
  $("tv-refresh").textContent = every ? "Pause" : "Refresh";
  $("tv").showModal(); tvRun();
}
async function tvRun() {
  clearTimeout(tv.timer);
  if (!$("tv").open || !tv.load) return;
  if (!tv.busy) {
    tv.busy = true;
    if (!tv.every || tv.every >= 3000 || !tv.loaded)          // a page that updates every second would just blink
      $("tv-live").innerHTML = "<span class='spin'></span> " + (tv.every ? "Live · updating…" : "Scanning…");
    tv.loaded = true;
    try { await tv.load(); $("tv-live").innerHTML = (tv.every && !tv.paused ? "<span class='on'>● Live</span> · " : "") + "updated " + new Date().toLocaleTimeString(); }
    catch (e) { $("tv-live").textContent = "⚠ " + e.message; }
    tv.busy = false;
  }
  if (tv.every && !tv.paused && $("tv").open) tv.timer = setTimeout(tvRun, tv.every);
}
function tvClose(quiet) { clearTimeout(tv.timer); tv.load = null; if (!quiet && $("tv").open) $("tv").close(); }
$("tv-close").onclick = () => tvClose();
$("tv").addEventListener("close", () => { clearTimeout(tv.timer); tv.load = null; });
$("tv-refresh").onclick = () => {
  if (!tv.every) return tvRun();
  tv.paused = !tv.paused; $("tv-refresh").textContent = tv.paused ? "Resume" : "Pause";
  if (tv.paused) { clearTimeout(tv.timer); $("tv-live").textContent = "Paused · " + $("tv-live").textContent.replace(/^.*?updated/, "updated"); } else tvRun();
};
const chOf = (f) => !f ? null : f < 3000 ? Math.round((f - 2407) / 5) : f < 5925 ? Math.round((f - 5000) / 5) : Math.round((f - 5950) / 5);

// ---------- Channel Analyzer: crowding per channel, best channel, the one you're on (live every 20 s) ----------
let chBand = "2.4", chOpen = {};
function chRows(map, list, you, best) {
  const chans = [...new Set([...Object.keys(map).map(Number), ...list])].sort((a, b) => a - b);
  const max = Math.max(4, ...chans.map(c => (map[c] || {}).count || 0));
  return chans.map(c => {
    const e = map[c] || { count: 0, best: 0, ssids: [] }, n = e.count;
    const cls = n === 0 ? "free" : n <= 2 ? "" : n <= 5 ? "mid" : "busy";
    const nets = chOpen[chBand + c] && e.ssids.length ? "<div class='ch-nets'>" + e.ssids.map(x => esc(x.ssid) + " " + x.sig + "%").join(" · ") + "</div>" : "";
    const tags = (c === best ? "<span class='ch-tag best'>BEST</span>" : "") + (c === you ? "<span class='ch-tag you'>YOU</span>" : "");
    return "<div class='ch-row " + cls + "' data-ch='" + c + "'><div class='ch-num'><span>ch " + c + "</span>" + (tags ? "<span>" + tags + "</span>" : "") + "</div><div class='ch-bar'><div class='ch-fill' style='width:" + Math.round(100 * n / max) + "%'></div></div>" +
      "<div class='ch-cnt'><b>" + n + "</b> " + (n === 1 ? "network" : "networks") + (n ? "<br>strongest " + e.best + "%" : "") + "</div>" + nets + "</div>";
  }).join("");
}
async function chLoad() {
  const [d, st] = await Promise.all([api("/api/channel", {}), api("/api/status").catch(() => ({}))]);
  chRender(d, st);
}
function chRender(d, st) {
  const lk = parseLink((st && st.link) || ""), f = parseFloat(lk.freq), you = chOf(f), youBand = f ? (f < 3000 ? "2.4" : f < 5925 ? "5" : "6") : "";
  const maps = { "2.4": d.band24 || {}, "5": d.band5 || {}, "6": d.band6 || {} };
  const b24 = best24(maps["2.4"]), b5 = best5(maps["5"]), n6 = Object.values(maps["6"]).reduce((a, e) => a + e.count, 0);
  const tot = (m) => Object.values(m).reduce((a, e) => a + e.count, 0);
  const card = (k, v, s, cls) => "<div class='tv-card " + (cls || "") + "'><div class='k'>" + k + "</div><div class='v'>" + v + "</div><div class='s'>" + s + "</div></div>";
  const youTxt = you ? "ch " + you + " · " + youBand + " GHz" : "not connected";
  const lists = { "2.4": [1, 6, 11], "5": [36, 40, 44, 48, 149, 153, 157, 161], "6": [] };
  const best = { "2.4": b24, "5": b5, "6": null }[chBand];
  $("tv-body").innerHTML =
    "<div class='tv-cards'>" + card("Best 2.4 GHz", "ch " + b24, "least crowded of 1 / 6 / 11", "good") + card("Suggested 5 GHz", "ch " + b5, "fewest networks", "good") +
      card("6 GHz (Wi-Fi 6E)", n6 ? n6 + " nets" : "empty", n6 ? "still far less crowded" : "a clean band for a 6E AP", n6 ? "" : "good") +
      card("You are on", you ? "ch " + you : "—", (lk.ssid ? esc(lk.ssid) + " · " : "") + youTxt) + "</div>" +
    "<div class='seg slim' id='ch-seg'>" + ["2.4", "5", "6"].map(b => "<button data-b='" + b + "' class='" + (b === chBand ? "on" : "") + "'>" + b + " GHz · " + tot(maps[b]) + "</button>").join("") + "</div>" +
    "<div class='tv-h'>Tap a channel to see its networks. Green = room to spare, amber = busy, red = crowded.</div>" +
    (Object.keys(maps[chBand]).length || lists[chBand].length ? chRows(maps[chBand], lists[chBand], youBand === chBand ? you : null, best)
      : "<div class='tv-empty'>No " + chBand + " GHz networks here.</div>");
  document.querySelectorAll("#ch-seg button").forEach(b => b.onclick = () => { chBand = b.dataset.b; chRender(d, st); });
  document.querySelectorAll("#tv-body .ch-row").forEach(r => r.onclick = () => { const k = chBand + r.dataset.ch; chOpen[k] = !chOpen[k]; chRender(d, st); });
}
$("btn-chan").onclick = () => { chOpen = {}; tvOpen("Channel Analyzer", chLoad, 20000); };

// APs & roaming
$("btn-aps").onclick = () => tvOpen("APs for this SSID", apsLoad, 20000);
// ---------- Watch Roaming: the AP you're on, every AP of this network, a signal trace with roam marks (live every 5 s) ----------
const roam = { last: null, log: [], trace: [], n: 0, sticky: 0, start: 0 };
const apLabel = (a) => (a.name ? esc(a.name) + " <small>" + esc(a.bssid.slice(-8)) + "</small>" : "AP <small>" + esc(a.bssid.slice(-8)) + "</small>");   // name it in Signal > AP picker
function roamDraw() {
  const c = $("roam-graph"); if (!c) return;
  const w = c.clientWidth, h = c.clientHeight, x = c.getContext("2d"), dpr = devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr; x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
  x.strokeStyle = "rgba(147,161,189,.18)"; x.lineWidth = 1; x.fillStyle = "rgba(147,161,189,.7)"; x.font = "11px sans-serif";
  [25, 50, 75].forEach(p => { const y = h - p / 100 * h; x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke(); x.fillText(p + "%", 4, y - 3); });
  const pts = roam.trace.slice(-60); if (pts.length < 1) return;
  const step = w / Math.max(pts.length - 1, 12);              // fills the width as it grows, max 60 readings (5 min)
  pts.forEach((p, i) => { if (p.roam) { x.strokeStyle = "#f97316"; x.lineWidth = 2; x.beginPath(); x.moveTo(i * step, 0); x.lineTo(i * step, h); x.stroke(); } });
  x.strokeStyle = "#60a5fa"; x.lineWidth = 2.5; x.beginPath();
  pts.forEach((p, i) => { const y = h - (p.sig / 100) * h; i ? x.lineTo(i * step, y) : x.moveTo(i * step, y); }); x.stroke();
}
async function roamLoad() {
  roam.n++;
  const d = await api("/api/aps", { rescan: roam.n % 6 === 1 });        // fresh neighbour scan every ~30 s, cheap reads in between
  const aps = d.aps || [], cur = aps.find(a => a.current), now = new Date().toLocaleTimeString();
  const roamed = cur && roam.last && cur.bssid !== roam.last.bssid;
  if (roamed) roam.log.unshift({ t: now, from: roam.last, to: cur });
  if (cur) { roam.trace.push({ sig: cur.signal, roam: roamed }); roam.last = cur; }
  const better = cur && aps.find(a => !a.current && a.signal >= cur.signal + 15);
  roam.sticky = better ? roam.sticky + 1 : 0;
  const mins = Math.max(1, Math.round((Date.now() - roam.start) / 60000));
  const card = (k, v, s, cls) => "<div class='tv-card " + (cls || "") + "'><div class='k'>" + k + "</div><div class='v'>" + v + "</div><div class='s'>" + s + "</div></div>";
  const q = cur ? (cur.signal >= 70 ? "good" : cur.signal >= 45 ? "warn" : "bad") : "bad";
  $("tv-body").innerHTML =
    "<div class='tv-cards'>" + card("Connected to", cur ? apLabel(cur) : "—", cur ? cur.band + " GHz · ch " + cur.ch : "not connected", "") +
      card("Signal", cur ? cur.signal + "%" : "—", cur ? (q === "good" ? "strong" : q === "warn" ? "okay" : "weak") : "", q) +
      card("Roams", String(roam.log.length), "in " + mins + " min of watching", "") + card("APs of “" + esc(d.ssid || "?") + "”", String(aps.length), "broadcasting nearby", "") + "</div>" +
    (roam.sticky >= 2 ? "<div class='roam-warn'>⚠ " + apLabel(better) + " is " + (better.signal - cur.signal) + "% stronger but the Pi stays on " + apLabel(cur) +
      ". Sticky client, or the APs' roaming settings (minimum RSSI / 802.11k/v/r) need work.</div>" : "") +
    "<div class='tv-h'>Signal of the AP you're on (orange line = a roam). Walk the site; the Pi roams like a phone would.</div>" +
    "<canvas id='roam-graph' class='roam-graph'></canvas>" +
    "<div class='tv-h'>Access points of this network</div>" +
    (aps.length ? aps.map(a => "<div class='ap-row" + (a.current ? " cur" : "") + "'><div class='ap-name'>" + (a.current ? "▶ " : "") + apLabel(a) + " <small>· " + a.band + "G ch " + a.ch + "</small></div>" +
      "<div class='ch-bar'><div class='ch-fill' style='width:" + a.signal + "%'></div></div><div class='ap-sig'>" + a.signal + "%</div></div>").join("")
      : "<div class='tv-empty'>No access points seen for this network.</div>") +
    "<div class='tv-h'>Roam log</div>" +
    (roam.log.length ? roam.log.map(e => "<div class='roam-ev'>" + esc(e.t) + " · <b>roamed</b> " + apLabel(e.from) + " (" + e.from.signal + "%) → " + apLabel(e.to) + " (" + e.to.signal + "%)</div>").join("")
      : "<div class='tv-empty'>No roams yet: walk around the site.</div>");
  roamDraw();
}
$("btn-roam").onclick = () => { Object.assign(roam, { last: null, log: [], trace: [], n: 0, sticky: 0, start: Date.now() }); tvOpen("Watch Roaming", roamLoad, 5000); };

// ---------- shared bits for the tool pages ----------
const tvCard = (k, v, s, cls) => "<div class='tv-card " + (cls || "") + "'><div class='k'>" + k + "</div><div class='v'>" + v + "</div><div class='s'>" + (s || "") + "</div></div>";
const verdict = (cls, head, sub) => "<div class='svc-sum " + cls + "'>" + head + (sub ? "<small>" + sub + "</small>" : "") + "</div>";
const tvWait = (msg) => { if ($("tv-body").querySelector(".tv-empty")) $("tv-body").innerHTML = "<div class='tv-empty'><span class='spin'></span> " + msg + "</div>"; };

// ---------- APs for this SSID: every access point of the network you're on, strongest first (live every 20 s) ----------
async function apsLoad() {
  tvWait("Scanning for every access point of this network (a few seconds)…");
  const d = await api("/api/aps", {}), aps = d.aps || [], cur = aps.find(a => a.current), best = aps[0];
  const better = cur && aps.find(a => !a.current && a.signal >= cur.signal + 15);
  const bands = [...new Set(aps.map(a => a.band))].sort().map(b => b + " GHz").join(" + ");
  $("tv-body").innerHTML =
    (!d.ssid ? verdict("bad", "Not connected to Wi-Fi", "join a network on the Signal page first")
      : better ? verdict("bad", "⚠ A stronger AP is right here", apLabel(better) + " is " + (better.signal - cur.signal) + "% stronger than " + apLabel(cur) + " (the one the Pi is on): a sticky client, or the APs' roaming settings need work")
      : verdict("", "✅ " + aps.length + " access point" + (aps.length === 1 ? "" : "s") + " broadcast “" + esc(d.ssid) + "”", cur ? "you're on the " + (cur === best ? "strongest" : "a good") + " one: " + apLabel(cur) + " · " + cur.signal + "% · " + cur.band + " GHz ch " + cur.ch : "")) +
    "<div class='tv-cards'>" + tvCard("Access points", String(aps.length), bands || "—") + tvCard("You're on", cur ? apLabel(cur) : "—", cur ? cur.band + " GHz · ch " + cur.ch : "") +
      tvCard("Signal", cur ? dbmOf(cur.signal) + " <small>dBm</small>" : "—", cur ? cur.signal + "%" : "", cur ? (cur.signal >= 70 ? "good" : cur.signal >= 45 ? "warn" : "bad") : "") +
      tvCard("Strongest", best ? best.signal + "%" : "—", best ? apLabel(best) : "") + "</div>" +
    "<div class='tv-h'>Strongest first (signal in dBm) · ▶ = the one the Pi is on · rescans every 20 s</div>" +
    (aps.length ? aps.map(a => "<div class='ap-row" + (a.current ? " cur" : "") + "'><div class='ap-name'>" + (a.current ? "▶ " : "") + apLabel(a) + " <small>· " + a.band + "G ch " + a.ch + " · " + esc(a.bssid) + "</small></div>" +
      "<div class='ch-bar'><div class='ch-fill' style='width:" + a.signal + "%'></div></div><div class='ap-sig'>" + dbmOf(a.signal) + "</div></div>").join("")
      : "<div class='tv-empty'>No access points seen for this network.</div>") +
    "<div class='res-foot'>Name an AP in Signal › Name APs and it shows here. dBm estimated from signal %.</div>";
}

// ---------- Public IP & ISP ----------
async function pubipLoad() {
  const d = await api("/api/pubip", {}), i = d.info || {};
  if (!i.ip) { $("tv-body").innerHTML = verdict("bad", "Couldn't look up the public IP", "no internet, or the lookup service didn't answer") + "<pre class='tv-pre'>" + esc(d.output || "") + "</pre>"; return; }
  const place = [i.city, i.region, i.country_name || i.country].filter(Boolean).join(", ");
  $("tv-body").innerHTML =
    "<div class='pip-hero'><div class='k'>The internet sees this site as</div><div class='ip' id='pip-ip'>" + esc(i.ip) + "</div>" +
      "<div class='s'>" + esc(i.isp || "") + (i.asn ? " · " + esc(i.asn) : "") + "</div></div>" +
    "<div class='tv-cards'>" + tvCard("Internet provider", esc(i.isp || "—"), esc([i.asn, i.domain].filter(Boolean).join(" · "))) +
      tvCard("Location", esc(i.city || i.country || "—"), esc(place) + " (approximate)") +
      tvCard("IPv6", d.ipv6 ? "Yes" : "No", d.ipv6 ? esc(d.ipv6) : "this network only gives IPv4", d.ipv6 ? "good" : "") +
      (i.hostname ? tvCard("Reverse name", "<span class='sm'>" + esc(i.hostname) + "</span>", "") : "") +
      (i.timezone ? tvCard("Time zone", esc(i.timezone.split("/").pop().replace(/_/g, " ")), esc(i.timezone)) : "") + "</div>" +
    "<div class='pad'><button id='pip-copy' class='block'>Copy IP</button></div>" +
    "<div class='res-foot'>Use it for firewall / POS allow-lists, or tell the ISP. A different IP than the router's WAN page usually means the ISP uses CGNAT.</div>";
  $("pip-copy").onclick = async () => { const b = $("pip-copy"); try { await navigator.clipboard.writeText(i.ip); b.textContent = "Copied ✓"; } catch (e) { b.textContent = "Can't copy"; } setTimeout(() => { b.textContent = "Copy IP"; }, 1500); };
}

// ---------- DNS Check: this network's DNS side by side with public DNS ----------
async function dnsCheckLoad() {
  tvWait("Asking your DNS and 3 public DNS servers the same questions…");
  const d = await api("/api/dnscheck", {}), rows = d.rows || [], mine = rows.filter(r => r.mine), pub = rows.filter(r => !r.mine);
  const fastPub = Math.min(...pub.filter(r => r.avg != null).map(r => r.avg), Infinity), m = mine[0] || rows[0];
  let v;
  if (!m || m.avg == null) v = verdict("bad", "❌ Your DNS server isn't answering", (m ? esc(m.server) : "") + " — websites won't load even though the internet is up. Check the router's DNS, or set 1.1.1.1 / 8.8.8.8.");
  else if (m.avg > 150) v = verdict("bad", "⚠ DNS is slow · " + m.avg + " ms", "every new website waits this long before loading. Public DNS answered in " + (isFinite(fastPub) ? fastPub + " ms" : "—") + ".");
  else if (isFinite(fastPub) && m.avg > fastPub * 3 + 30) v = verdict("bad", "⚠ Your DNS is slower than public DNS", m.avg + " ms vs " + fastPub + " ms — consider pointing the router at 1.1.1.1 or 8.8.8.8.");
  else if (m.fail) v = verdict("bad", "⚠ Some lookups failed", m.fail + " of " + (m.ok + m.fail) + " questions got no answer from " + esc(m.server));
  else v = verdict("", "✅ DNS is healthy · " + m.avg + " ms", "your DNS (" + esc(m.server) + ") answers every question" + (isFinite(fastPub) ? "; public DNS: " + fastPub + " ms" : ""));
  const scale = Math.max(100, ...rows.map(r => r.max || 0));
  const tile = (r) => { const w = r.avg == null ? 0 : Math.max(3, Math.round(r.avg / scale * 100)), cls = r.avg == null ? "" : r.avg > 150 ? "slow" : r.avg > 60 ? "mid" : "";
    return "<div class='svc-tile" + (r.avg == null || r.fail ? " down" : r.mine ? " mine" : "") + "'><div class='n'><span>" + esc(r.mine ? "Your DNS" : r.label) + "</span><b>" + (r.avg == null ? "no answer" : r.avg + " ms") + "</b></div>" +
      "<div class='d'>" + esc(r.server) + (r.avg != null ? " · " + r.min + "–" + r.max + " ms" : "") + (r.fail ? " · " + r.fail + " failed" : "") + "</div><div class='lat'><i class='" + cls + "' style='width:" + w + "%'></i></div></div>"; };
  const names = d.names || [];
  $("tv-body").innerHTML = v +
    "<div class='tv-h'>Average answer time (same " + names.length + " names to each server)</div><div class='svc-grid'>" + rows.map(tile).join("") + "</div>" +
    "<div class='tv-h'>Typo protection</div>" +
    (d.hijack ? "<div class='roam-warn'>⚠ This DNS answers names that don't exist (ISP “search help” / ad redirect, or a filter). Apps that check for errors can misbehave.</div>"
      : "<div class='svc-ev'>✅ Made-up names get “doesn't exist” (" + esc(d.nx_status || "NXDOMAIN") + ") — no hijacking.</div>") +
    "<div class='tv-h'>Every answer (ms)</div><table class='dns dnsc'><thead><tr><th>Server</th>" + names.map(n => "<th>" + esc(n.replace(/\.com$/, "")) + "</th>").join("") + "</tr></thead><tbody>" +
      rows.map(r => "<tr><td class='t'>" + esc(r.label) + "<small>" + esc(r.server) + "</small></td>" + r.results.map(x => "<td class='" + (x.ms == null ? "bad" : "") + "'>" + (x.ms == null ? esc(x.status) : x.ms) + "</td>").join("") + "</tr>").join("") +
    "</tbody></table><div class='res-foot'>Your DNS: " + esc((d.resolvers || []).join(", ") || "system") + " (from this network's DHCP). Tap Refresh to run it again — the second run shows cached speed.</div>";
}

// ---------- Rogue DHCP Check ----------
async function dhcpLoad() {
  tvWait("Asking every DHCP server on this network to answer (~10 s)…");
  const d = await api("/api/dhcp", {}), offers = d.offers || [], srv = d.servers || [];
  const v = !srv.length ? verdict("bad", "No DHCP server answered on " + esc(d.iface || "?"), "a network with static addresses, or the DHCP server is slow / filtered. Try again.")
    : d.rogue ? verdict("bad", "⚠ Rogue DHCP suspected · " + srv.length + " servers answered", "only one device should hand out addresses. The extra one (often a home router plugged in backwards, or an AP in router mode) gives devices wrong settings at random.")
    : verdict("", "✅ One DHCP server · no rogue", esc(srv[0]) + " is the only one handing out addresses on " + esc(d.iface || "?"));
  const row = (k, val) => val ? "<div class='dd-row'><span class='k'>" + k + "</span><span class='v'>" + esc(val) + "</span></div>" : "";
  $("tv-body").innerHTML = v + (offers.length ? offers.map((o, i) => {
    const gwOk = d.gateway && o.router && o.router.split(/[ ,]+/).includes(d.gateway);
    return "<div class='tv-h'>Server " + (i + 1) + (d.rogue ? (gwOk ? " · <span class='nm-ok'>matches your gateway</span>" : " · <span class='nm-bad'>NOT your gateway — likely the rogue</span>") : "") + "</div><div class='kv'>" +
      row("DHCP server", o.server) + row("Offered address", o.offered) + row("Gateway (router)", o.router) + row("DNS", o.dns) + row("Subnet mask", o.mask) + row("Lease time", o.lease) + row("Domain", o.domain) + "</div>"; }).join("") : "") +
    "<div class='res-foot'>The Pi sends one DHCP discover on " + esc(d.iface || "?") + " and lists every answer; it does not take an address.</div>";
}

// ---------- Ethernet Jack Test: waits for a cable, then link / DHCP / switch port / VLAN / internet ----------
const JACK_ICON = { ok: "✓", warn: "!", bad: "✕", info: "i" };
async function jackLoad() {
  const l = await api("/api/jack/link");
  if (!l.link) {
    $("tv-body").innerHTML = "<div class='jack-wait'><div class='plug'>🔌</div><div class='h'>Plug the Pi's Ethernet port into the wall jack</div>" +
      "<div class='s'><span class='spin'></span> Waiting for a link on " + esc(l.iface) + "… the test starts by itself.</div></div>" +
      "<div class='res-foot'>No link after a minute = a dead jack, an unpatched port, or a switch port that's shut down.</div>";
    clearTimeout(tv.timer); tv.timer = setTimeout(() => { if ($("tv").open && tv.load === jackLoad) tvRun(); }, 2000);
    return;
  }
  $("tv-body").innerHTML = verdict("", "Link up · " + esc(l.speed) + " Mb/s " + esc(l.duplex), "<span class='spin'></span> testing DHCP, switch port, VLAN tags and internet (~15 s)…");
  const d = await api("/api/jack", {}), ch = d.checks || [];
  const bad = ch.find(c => c.state === "bad"), warn = ch.find(c => c.state === "warn");
  $("tv-body").innerHTML = (bad ? verdict("bad", "❌ " + esc(bad.title), esc(bad.detail)) : warn ? verdict("bad", "⚠ Works, but: " + esc(warn.title), esc(warn.detail)) : verdict("", "✅ This jack is good", "link, address, and internet all work")) +
    "<div class='chk'>" + ch.map(c => "<div class='chk-row " + c.state + "'><i>" + JACK_ICON[c.state] + "</i><div><b>" + esc(c.title) + "</b>" + (c.detail ? "<small>" + esc(c.detail) + "</small>" : "") + "</div></div>").join("") + "</div>" +
    "<div class='res-foot'>Move to the next jack and tap Refresh. The switch name / port needs LLDP or CDP on the switch (Omada: on by default).</div>";
}

// ---------- Open Ports (this Pi): what's listening, who can reach it ----------
const PORT_NAMES = { 22: "SSH", 53: "DNS", 67: "DHCP server", 68: "DHCP client", 80: "Web", 123: "Time (NTP)", 443: "Web (HTTPS)", 631: "Printing", 1900: "UPnP", 5201: "iPerf3 speed server",
  5353: "Bonjour (mDNS)", 8086: "InfluxDB", 8088: "InfluxDB admin", 8092: "Jarvis Net Tools (this app)", 34001: "Pironman case dashboard", 51820: "WireGuard VPN" };
async function portsLoad() {
  const d = await api("/api/ports", {}), ls = d.listeners || [];
  const temp = (r) => r.proto === "udp" && r.port >= 32768 && !PORT_NAMES[r.port];
  const net = ls.filter(r => r.scope !== "local" && !temp(r)), loc = ls.filter(r => r.scope === "local" && !temp(r)), tmp = ls.filter(temp);
  const row = (r) => "<div class='port-row'><span class='pn'>" + r.port + "<small>/" + r.proto + "</small></span><span class='pd'><b>" + esc(PORT_NAMES[r.port] || r.process || "unknown") + "</b><small>" +
    esc((r.process ? r.process + " · " : "") + (r.scope === "all" ? "every network" + (r.iface ? " (" + r.iface + ")" : "") : r.scope === "one" ? "only on " + r.addr : "this Pi only")) + "</small></span></div>";
  $("tv-body").innerHTML = verdict("", net.length + " service" + (net.length === 1 ? "" : "s") + " reachable from the network", "what this Pi itself answers on — the firewall still decides who gets in") +
    "<div class='tv-h'>Reachable from the network</div>" + (net.map(row).join("") || "<div class='tv-empty'>none</div>") +
    "<div class='tv-h'>Only on this Pi (localhost)</div>" + (loc.map(row).join("") || "<div class='tv-empty'>none</div>") +
    (tmp.length ? "<details class='hist'><summary>" + tmp.length + " temporary UDP ports (apps talking out — normal)</summary>" + tmp.map(row).join("") + "</details>" : "") +
    "<div class='res-foot'>To scan another device's ports use Tools › Ports.</div>";
}

// ---------- Bandwidth Now: live Mbps through this Pi, per interface (every second) ----------
const bw = { prev: null, hist: {}, peak: {}, total: {}, sel: null };
const IF_LABEL = (n) => n === "eth0" ? "Ethernet" : n === "wlan1" ? "Wi-Fi" : n === "wlan0" ? "Setup hotspot" : /^wg/.test(n) ? "VPN" : /^usb/.test(n) ? "USB" : n;
const fmtMbps = (v) => v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
const fmtBytes = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " kB";
function bwDraw() {
  const c = $("bw-graph"); if (!c) return;
  const { g, W, H, d } = prep(c), pts = (bw.hist[bw.sel] || []).slice(-120), mx = Math.max(1, ...pts.map(p => Math.max(p.rx, p.tx))) * 1.15;
  g.strokeStyle = GRID; g.lineWidth = 1; g.fillStyle = AXIS; g.font = 11 * d + "px sans-serif";
  [0.5, 1].forEach(k => { const y = H - (H - 14 * d) * k; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText(fmtMbps(mx * k) + " Mbps", 4 * d, y + 12 * d); });
  if (pts.length < 2) return;
  const step = W / Math.max(pts.length - 1, 30), Y = (v) => H - (v / mx) * (H - 14 * d);
  [["rx", "#f97316"], ["tx", "#3b82f6"]].forEach(([k, col]) => { g.strokeStyle = col; g.lineWidth = 2.5 * d; g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(i * step, Y(p[k])) : g.moveTo(0, Y(p[k]))); g.stroke(); });
}
async function bwLoad() {
  const d = await api("/api/bandwidth/now"), ifs = d.ifaces || {};
  if (bw.prev) {
    const dt = Math.max(0.2, d.ts - bw.prev.ts);
    Object.keys(ifs).forEach(n => { const a = ifs[n], b = bw.prev.ifaces[n]; if (!b) return;
      const rx = Math.max(0, a.rx - b.rx) * 8 / dt / 1e6, tx = Math.max(0, a.tx - b.tx) * 8 / dt / 1e6;
      (bw.hist[n] = bw.hist[n] || []).push({ rx, tx }); if (bw.hist[n].length > 300) bw.hist[n].shift();
      const pk = bw.peak[n] = bw.peak[n] || { rx: 0, tx: 0 }; pk.rx = Math.max(pk.rx, rx); pk.tx = Math.max(pk.tx, tx);
      const t = bw.total[n] = bw.total[n] || { rx: 0, tx: 0 }; t.rx += Math.max(0, a.rx - b.rx); t.tx += Math.max(0, a.tx - b.tx); });
  }
  bw.prev = d;
  const names = Object.keys(ifs).filter(n => ifs[n].rx + ifs[n].tx > 0 || n === d.default);
  if (!bw.sel || !ifs[bw.sel]) bw.sel = ifs[d.default] ? d.default : names[0];
  if (!$("bw-graph")) $("tv-body").innerHTML = "<div class='pills bw-ifs' id='bw-ifs'></div><div class='tv-cards' id='bw-cards'></div>" +
    "<div class='tv-h'><span class='key' style='background:#f97316'></span> Download &nbsp; <span class='key' style='background:#3b82f6'></span> Upload · last 2 minutes</div><canvas id='bw-graph' class='sm-graph'></canvas>" +
    "<div class='res-foot'>Traffic through this Pi only — not the whole network. Start a speed test or a download and watch it move.</div>";
  const box = $("bw-ifs"), sig = names.join(",") + "|" + bw.sel;
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = names.map(n => "<button type='button' data-n='" + esc(n) + "' class='" + (n === bw.sel ? "on" : "") + "'>" + esc(IF_LABEL(n)) + (n === d.default ? " ★" : "") + "</button>").join("");
    box.querySelectorAll("button").forEach(b => b.onclick = () => { bw.sel = b.dataset.n; box.dataset.sig = ""; bwLoad(); });
  }
  const h = bw.hist[bw.sel] || [], last = h[h.length - 1] || { rx: 0, tx: 0 }, pk = bw.peak[bw.sel] || { rx: 0, tx: 0 }, t = bw.total[bw.sel] || { rx: 0, tx: 0 };
  $("bw-cards").innerHTML = tvCard("Download", h.length ? fmtMbps(last.rx) + " <small>Mbps</small>" : "…", "peak " + fmtMbps(pk.rx) + " Mbps", "dn") +
    tvCard("Upload", h.length ? fmtMbps(last.tx) + " <small>Mbps</small>" : "…", "peak " + fmtMbps(pk.tx) + " Mbps", "up") +
    tvCard("Since opened", fmtBytes(t.rx + t.tx), "↓ " + fmtBytes(t.rx) + " · ↑ " + fmtBytes(t.tx)) + tvCard("Interface", esc(IF_LABEL(bw.sel)), esc(bw.sel) + (bw.sel === d.default ? " · internet goes here" : ""));
  bwDraw();
}

// ---------- History: today's tool runs, filter by tool, search, tap to open ----------
const hist = { entries: [], q: "", f: "All" };
const histKind = (l) => { l = l.replace(/\s*\(.*\)\s*$/, ""); return /^DNS (?!Check)/.test(l) ? "DNS lookup" : l; };
function histRender() {
  const q = hist.q.toLowerCase(), list = hist.entries.filter(e => (hist.f === "All" || histKind(e.label) === hist.f) && (!q || (e.label + " " + e.target + " " + e.text).toLowerCase().includes(q)));
  $("hist-list").innerHTML = list.length ? list.map(e => "<details class='hist'><summary><span class='ht'>" + esc(e.ts.slice(11, 16)) + "</span><b>" + esc(e.label) + "</b>" + (e.target ? "<span class='hg'>" + esc(e.target) + "</span>" : "") +
    "<small>" + esc((e.text.split("\n").find(x => x.trim()) || "").slice(0, 90)) + "</small></summary><pre>" + esc(e.text) + "</pre></details>").join("")
    : "<div class='tv-empty'>" + (hist.entries.length ? "Nothing matches." : "No history yet — run a test first.") + "</div>";
}
async function histLoad() {
  const d = await api("/api/history"); hist.entries = d.entries || [];
  const kinds = {}; hist.entries.forEach(e => { const k = histKind(e.label); kinds[k] = (kinds[k] || 0) + 1; });
  if (hist.f !== "All" && !kinds[hist.f]) hist.f = "All";
  $("tv-body").innerHTML = "<div class='pad tight'><input type='search' id='hist-q' placeholder='Search history (IP, name, tool…)' autocapitalize='off' spellcheck='false'></div>" +
    "<div class='pills hist-f' id='hist-f'>" + [["All", hist.entries.length]].concat(Object.entries(kinds).sort((a, b) => b[1] - a[1])).map(([k, n]) =>
      "<button type='button' data-k='" + esc(k) + "' class='" + (k === hist.f ? "on" : "") + "'>" + esc(k) + " <small>" + n + "</small></button>").join("") + "</div>" +
    "<div id='hist-list'></div><div class='res-foot'>Today only: the history empties on a new day and when you tap Finish Visit (the report keeps it).</div>";
  $("hist-q").value = hist.q; $("hist-q").oninput = () => { hist.q = $("hist-q").value; histRender(); };
  $("hist-f").querySelectorAll("button").forEach(b => b.onclick = () => { hist.f = b.dataset.k; $("hist-f").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); histRender(); });
  histRender();
}

// live signal meter (two buttons, one state)
// ---------- Live Signal Meter: a dBm gauge, quality, 2-minute graph, min / avg / max (every second) ----------
const sm = { pts: [] };
const SQ = [[-50, "Excellent", "#4ade80"], [-60, "Good", "#4ade80"], [-67, "Fair", "#a3e635"], [-75, "Weak", "#fbbf24"], [-200, "Very weak", "#f87171"]];
const sq = (d) => SQ.find(([lim]) => d >= lim);
function smGauge(dbm) {
  const c = $("sm-gauge"); if (!c) return;
  const w = c.clientWidth, h = c.clientHeight, x = c.getContext("2d"), dpr = devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr; x.scale(dpr, dpr);
  const cx = w / 2, cy = h - 18, r = Math.min(w / 2 - 20, h - 40), a0 = Math.PI, a1 = 2 * Math.PI;
  const at = (v) => a0 + (Math.max(-100, Math.min(-30, v)) + 100) / 70 * Math.PI;
  [[-100, -75, "#f87171"], [-75, -67, "#fbbf24"], [-67, -60, "#a3e635"], [-60, -30, "#4ade80"]].forEach(([s, e, col]) => {
    x.beginPath(); x.arc(cx, cy, r, at(s), at(e)); x.strokeStyle = col; x.globalAlpha = .28; x.lineWidth = 18; x.stroke(); x.globalAlpha = 1; });
  if (dbm != null) { x.beginPath(); x.arc(cx, cy, r, a0, at(dbm)); x.strokeStyle = sq(dbm)[2]; x.lineWidth = 18; x.lineCap = "round"; x.stroke(); x.lineCap = "butt"; }
  x.fillStyle = "rgba(147,161,189,.85)"; x.font = "12px sans-serif"; x.textAlign = "center";
  [-100, -80, -60, -40].forEach(v => { const a = at(v); x.fillText(String(v), cx + Math.cos(a) * (r + 22), cy + Math.sin(a) * (r + 22) + 4); });
  x.fillStyle = "#e6ecf5"; x.font = "700 44px sans-serif"; x.fillText(dbm == null ? "—" : String(dbm), cx, cy - 28);
  x.font = "15px sans-serif"; x.fillStyle = "rgba(147,161,189,.95)"; x.fillText("dBm", cx, cy - 6);
}
function smGraph() {
  const c = $("sm-graph"); if (!c) return;
  const w = c.clientWidth, h = c.clientHeight, x = c.getContext("2d"), dpr = devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr; x.scale(dpr, dpr);
  const y = (v) => h - (Math.max(-100, Math.min(-30, v)) + 100) / 70 * h;
  x.strokeStyle = "rgba(147,161,189,.18)"; x.fillStyle = "rgba(147,161,189,.7)"; x.font = "11px sans-serif";
  [-90, -75, -60, -45].forEach(v => { x.beginPath(); x.moveTo(0, y(v)); x.lineTo(w, y(v)); x.stroke(); x.fillText(v + "", 4, y(v) - 3); });
  const pts = sm.pts.slice(-120); if (!pts.length) return;
  const step = w / Math.max(pts.length - 1, 30);
  x.lineWidth = 2.5; x.beginPath(); pts.forEach((v, i) => i ? x.lineTo(i * step, y(v)) : x.moveTo(0, y(v)));
  x.strokeStyle = sq(pts[pts.length - 1])[2]; x.stroke();
}
async function smLoad() {
  const link = (await api("/api/signal")).link || "", p = parseLink(link);
  const tx = (link.match(/tx bitrate:\s*([\d.]+ \S+)/) || [])[1] || "?", bssid = ((link.match(/Connected to\s+([0-9a-f:]{17})/i) || [])[1] || "").toUpperCase();
  const dbm = p.sig ? parseInt(p.sig, 10) : null;
  if (dbm != null) sm.pts.push(dbm);
  const pts = sm.pts.slice(-120), q = dbm != null ? sq(dbm) : null;
  const card = (k, v, s) => "<div class='tv-card'><div class='k'>" + k + "</div><div class='v'>" + v + "</div><div class='s'>" + s + "</div></div>";
  if (!$("sm-gauge")) $("tv-body").innerHTML = "<canvas id='sm-gauge' class='sm-gauge'></canvas><div id='sm-q' class='sm-q'></div><div id='sm-cards' class='tv-cards'></div>" +
    "<div class='tv-h'>Last 2 minutes. Walk around: it updates every second.</div><canvas id='sm-graph' class='sm-graph'></canvas>";
  $("sm-q").innerHTML = q ? "<b style='color:" + q[2] + "'>" + q[1] + "</b> · " + esc(p.ssid || "") : "Not connected to Wi-Fi";
  const f = parseFloat(p.freq), avg = pts.length ? Math.round(pts.reduce((a, b) => a + b, 0) / pts.length) : null;
  $("sm-cards").innerHTML = card("Band", f ? bandOf(f) : "—", f ? "ch " + chOf(f) + " · " + f + " MHz" : "") +
    card("Link rate", esc(p.rate.replace(" MBit/s", "")), "down · up " + esc(tx.replace(" MBit/s", "")) + " Mbit/s") +
    card("Min / Avg / Max", pts.length ? "<span class='mam'>" + Math.min(...pts) + " / " + avg + " / " + Math.max(...pts) + "</span>" : "—", "dBm this session") +
    card("Access point", bssid ? esc(bssid.slice(-8)) : "—", bssid ? "BSSID " + esc(bssid) : "");
  smGauge(dbm); smGraph();
}
function toggleSignal() { sm.pts = []; tvOpen("Live Signal Meter", smLoad, 1000); }
$("btn-signal").onclick = toggleSignal; $("btn-signal2").onclick = toggleSignal;

// ---------- Service / POS Check: tiles per group, latency bars, what is on the LAN; re-checks every 30 s ----------
const svc = { prev: {}, log: [] };
async function svcLoad() {
  const d = await api("/api/services", {});
  const res = d.results || [], bad = res.filter(r => !r.ok), now = new Date().toLocaleTimeString();
  res.forEach(r => { const was = svc.prev[r.name]; if (was !== undefined && was !== r.ok) svc.log.unshift(now + " · " + r.name + (r.ok ? " is back up" : " went DOWN")); svc.prev[r.name] = r.ok; });
  const ms = (r) => { const m = /([\d.]+) ms/.exec(r.detail || ""); return m ? parseFloat(m[1]) : null; };
  const groups = ["Network", "Payments", "Apps", "Your checks"];
  const tile = (r) => { const t = ms(r), w = t == null ? 0 : Math.min(100, Math.round(t / 10)), cls = t == null ? "" : t < 150 ? "" : t < 500 ? "mid" : "slow";
    return "<div class='svc-tile" + (r.ok ? "" : " down") + "'><div class='n'><span>" + esc(r.name) + "</span><i class='dot " + (r.ok ? "ok" : "bad") + "'></i></div><div class='d'>" + esc(r.detail || "") +
      "</div><div class='lat'><i class='" + cls + "' style='width:" + (r.ok ? Math.max(w, 3) : 0) + "%'></i></div></div>"; };
  const lan = d.lan || { found: {} };
  $("tv-body").innerHTML =
    "<div class='svc-sum" + (bad.length ? " bad" : "") + "'>" + (bad.length ? "⚠ " + bad.length + " of " + res.length + " failed" : "✅ All good · " + res.length + " of " + res.length + " reachable") +
      "<small>" + (bad.length ? esc(bad.map(r => r.name).join(", ")) : "gateway, internet, DNS, payment and app services all answer") + "</small></div>" +
    groups.map(g => { const rs = res.filter(r => (r.group || "Apps") === g); return rs.length ? "<div class='tv-h'>" + g + "</div><div class='svc-grid'>" + rs.map(tile).join("") + "</div>" : ""; }).join("") +
    "<div class='tv-h'>On this LAN" + (lan.subnet ? " (" + esc(lan.subnet) + ")" : "") + "</div><div class='svc-lan rows'>" +
      Object.entries(lan.found || {}).map(([k, v]) => "<div class='row'><span class='lbl'>" + esc(k) + "</span><span class='val'>" + (v && v.length ? esc(v.join(", ")) : "<span class='muted'>none found</span>") +
        "<i class='dot " + (v && v.length ? "ok" : "") + "'></i></span></div>").join("") + "</div>" +
    (svc.log.length ? "<div class='tv-h'>Changes while watching</div>" + svc.log.map(e => "<div class='svc-ev'>" + esc(e) + "</div>").join("") : "");
}
const services = () => { svc.prev = {}; svc.log = []; tvOpen("Service / POS Check", svcLoad, 30000); };

// ---------- target tools ----------
function target() { const t = $("target").value.trim(); if (!t) { goto("tools"); $("target").focus(); show("Enter a host or IP in the target box first."); return null; } return t; }
$("btn-ping").onclick = () => { const t = target(), o = topt("ping"); if (t) livePing(t, o.count, { ping: { interval: o.interval, size: o.size, df: o.df }, fallback: () => tool("Ping " + t, "/api/ping", { target: t }) }); };
$("btn-dns").onclick = () => { const t = target(); if (t) dnsLookup(t); };
$("btn-whois").onclick = () => { const t = target(); if (t) whoisLookup(t); };
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
    url: "/api/ping/stream", body: Object.assign({ target, count }, opts.ping || {}), title: opts.title || "Ping " + target, fallback: opts.fallback, spark: true, scroll: true,
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
  opts = opts || {}; const o = opts.route || {}, passes = o.passes || 10, hops = new Map(), firstSeen = {}; let ghostFrom = Infinity;
  const hop = (n) => { let h = hops.get(n); if (!h) { h = { host: "", sent: 0, recv: 0, sum: 0, best: Infinity, worst: 0, last: null, t: new Map(), ok: new Set() }; hops.set(n, h); } return h; };
  const f1 = (v) => v == null ? "—" : v.toFixed(1);
  const lossCls = (l) => l >= 50 ? "bad" : l > 0 ? "warn" : "";
  return runLive({
    url: "/api/trace/stream", body: { target, count: passes, max_hops: o.max_hops || 30, proto: o.proto || "icmp" }, title: opts.title || "Route to " + target, fallback: opts.fallback,
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
  opts = opts || {}; const o = opts.ports || { mode: "top100" }, open = new Map(), raw = []; let pct = 0;
  const what = o.mode === "top1000" ? "the top 1000 ports" : o.mode === "range" ? "ports " + o.start + "–" + o.end : "the top 100 ports";
  const ordered = () => [...open].sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10));
  const report = () => {   // the useful part of nmap's output: from the scan report to the "Nmap done" line (everything, if there was no report e.g. host not found)
    const i = raw.findIndex(l => /^Nmap scan report/.test(l)); if (i < 0) return raw.filter(l => l.trim()).join("\n");
    const j = raw.findIndex((l, k) => k > i && /^Read data files/.test(l));
    return raw.slice(i, j < 0 ? raw.length : j).concat(raw.filter(l => /^Nmap done/.test(l))).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  };
  return runLive({
    url: "/api/portscan/stream", body: Object.assign({ target }, o), title: opts.title || "Ports " + target, fallback: opts.fallback,
    onLine(line) {
      raw.push(line); let m;
      if ((m = line.match(/^Discovered open port (\d+\/\w+)/))) { if (!open.has(m[1])) open.set(m[1], ""); }
      else if ((m = line.match(/Timing: About ([\d.]+)% done/))) pct = Math.max(pct, +m[1]);
      else if (/^Completed (SYN|Connect) .*Scan/.test(line)) pct = 100;
      else if ((m = line.match(/^(\d+\/\w+)\s+open\S*\s+(\S+)/))) open.set(m[1], m[2]);
    },
    view(state, note) {
      const list = ordered(), n = list.length, live = state === "live";
      const status = headOf(state, note) + " · " + (live ? "scanning " + what + (pct ? " · " + Math.round(pct) + "%" : "") + " · " + n + " open" : n ? n + " open port" + (n === 1 ? "" : "s") + " found" : "no open ports found");
      const chips = list.map(([k, svc]) => { const [pt, pr] = k.split("/"); return "<span class='chip'><b>" + esc(pt) + "</b>/" + esc(pr) + (svc ? "<i>" + esc(svc) + "</i>" : "") + "</span>"; }).join("");
      const html = (live ? "<div class='pbar'><i style='width:" + Math.max(3, Math.round(pct)) + "%'></i></div>" : "") +
        "<div class='chips'>" + (chips || "<span class='res-wait'>" + (live ? "No open ports yet…" : "No open ports found in " + what + ".") + "</span>") + "</div>";
      return { status, text: live ? "" : report(), html, copy: live ? (n ? "Open so far: " + list.map(x => x[0]).join(", ") : "") : report() };
    }
  });
}

$("btn-pingmon").onclick = () => {
  const b = $("btn-pingmon");
  if (liveOn) { stopLive(); return; }
  const t = target(); if (!t) return;
  b.textContent = "Stop Ping Monitor";
  const o = topt("monitor");
  livePing(t, 0, { title: "Ping Monitor " + t, ping: { interval: o.interval, size: o.size, df: o.df } }).finally(() => { b.textContent = "Ping Monitor"; });
};
$("btn-trace").onclick = () => { const t = target(); if (t) liveTrace(t, { route: topt("trace"), fallback: () => tool("Traceroute " + t, "/api/mtr", { target: t }) }); };
$("btn-portscan").onclick = () => {
  const t = target(), o = topt("ports"); if (!t) return;
  if (o.mode === "range" && !(o.start >= 1 && o.start <= o.end && o.end <= 65535)) { show("Port range: pick a start and end between 1 and 65535 (start first)."); return; }
  livePorts(t, { ports: o.mode === "range" ? { mode: "range", start: o.start, end: o.end } : { mode: o.mode }, fallback: () => tool("Port Scan " + t, "/api/portscan", { target: t }) }); };
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
const TOOL_BTN = { ping: "btn-ping", monitor: "btn-pingmon", trace: "btn-trace", ports: "btn-portscan", dns: "btn-dns", whois: "btn-whois", iperf: "btn-iperf" };
// per-tool options (remembered on this device): [key, label, [[value, text], ...]]
const P_INT = ["interval", "Every", [[0.2, "0.2 s"], [0.5, "0.5 s"], [1, "1 s"], [2, "2 s"]]], P_SIZE = ["size", "Size", [[56, "56 B"], [512, "512 B"], [1472, "1472 B"]]],
  P_DF = ["df", "Don't fragment", [[false, "Off"], [true, "On"]]];
const TOPT_DEF = {
  ping: [["count", "Count", [[5, "5"], [10, "10"], [20, "20"], [50, "50"], [100, "100"]]], P_INT, P_SIZE, P_DF],
  monitor: [P_INT, P_SIZE, P_DF],
  trace: [["passes", "Passes", [[5, "5"], [10, "10"], [20, "20"], [30, "30"]]], ["proto", "Protocol", [["icmp", "ICMP"], ["udp", "UDP"], ["tcp", "TCP 443"]]], ["max_hops", "Max hops", [[15, "15"], [30, "30"], [64, "64"]]]],
  ports: [["mode", "Ports", [["top100", "Common 100"], ["top1000", "Top 1000"], ["range", "Range"]]]],
  dns: [["type", "Record", ["ALL", "A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "PTR", "SRV", "CAA"].map(x => [x, x])],
    ["server", "Server", [["", "System"], ["1.1.1.1", "Cloudflare"], ["8.8.8.8", "Google"], ["9.9.9.9", "Quad9"], ["custom", "Other…"]]]],
};
const TOPT_DEFAULT = { ping: { count: 10, interval: 1, size: 56, df: false }, monitor: { interval: 1, size: 56, df: false }, trace: { passes: 10, proto: "icmp", max_hops: 30 },
  ports: { mode: "top100", start: 1, end: 1024 }, dns: { type: "ALL", server: "", custom: "" } };
let toptStore = {}; try { toptStore = JSON.parse(localStorage.getItem("nt-topts") || "{}") || {}; } catch (e) {}
function topt(tool) {
  const o = Object.assign({}, TOPT_DEFAULT[tool] || {}, toptStore[tool] || {});
  if (tool === "dns") o.dnsServer = o.server === "custom" ? (o.custom || "").trim() : o.server;
  return o;
}
function setTopt(tool, k, v) { toptStore[tool] = Object.assign({}, toptStore[tool] || {}, { [k]: v }); try { localStorage.setItem("nt-topts", JSON.stringify(toptStore)); } catch (e) {} }
function renderTopts() {
  const box = $("tool-opts"), def = TOPT_DEF[toolSel], o = topt(toolSel);
  if (!def) { box.innerHTML = ""; box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  let h = def.map(([k, label, vals]) => "<div class='topt'><span class='tl'>" + esc(label) + "</span><div class='pills'>" +
    vals.map(([v, t], i) => "<button type='button' data-k='" + k + "' data-i='" + i + "' class='" + (o[k] === v ? "on" : "") + "'>" + esc(t) + "</button>").join("") + "</div></div>").join("");
  if (toolSel === "ports" && o.mode === "range")
    h += "<div class='topt'><span class='tl'>From</span><div class='pills nums'><input type='number' inputmode='numeric' min='1' max='65535' id='topt-start' value='" + o.start + "'><span class='muted'>to</span>" +
      "<input type='number' inputmode='numeric' min='1' max='65535' id='topt-end' value='" + o.end + "'></div></div>";
  if (toolSel === "dns" && o.server === "custom")
    h += "<div class='topt'><span class='tl'>DNS server</span><div class='pills nums'><input type='text' id='topt-custom' placeholder='e.g. 192.168.1.1' autocapitalize='off' spellcheck='false' value='" + esc(o.custom || "") + "'></div></div>";
  box.innerHTML = h;
  box.querySelectorAll(".pills button").forEach(b => b.onclick = () => {
    const k = b.dataset.k, v = def.find(d => d[0] === k)[2][+b.dataset.i][0]; setTopt(toolSel, k, v); renderTopts(); toolHint();
    if (k === "server" && v === "custom") { const c = $("topt-custom"); if (c) c.focus(); }
  });
  [["topt-start", "start"], ["topt-end", "end"]].forEach(([id, k]) => { const el = $(id); if (el) el.oninput = () => { setTopt("ports", k, parseInt(el.value, 10) || 0); toolHint(); }; });
  const c = $("topt-custom"); if (c) c.oninput = () => { setTopt("dns", "custom", c.value.trim()); toolHint(); };
}
function hintFor(t) {
  const o = topt(t), pkt = (o.size || 56) + "-byte packets" + (o.df ? ", don't fragment" : ""), every = o.interval === 1 ? "every second" : "every " + o.interval + " s";
  if (t === "ping") return "Live ping — " + o.count + " probes " + every + ", " + pkt + ".";
  if (t === "monitor") return "Non-stop ping " + every + " (" + pkt + ") until you tap Stop.";
  if (t === "trace") return "Live route — " + o.passes + " passes over " + (o.proto === "tcp" ? "TCP port 443 (gets through most firewalls)" : o.proto.toUpperCase()) + ", up to " + o.max_hops + " hops.";
  if (t === "ports") return o.mode === "range" ? "Scan ports " + o.start + "–" + o.end + " — open ports pop in as they're found." : "Live port scan (" + (o.mode === "top1000" ? "top 1000, ~1 min" : "top 100") + ") — open ports pop in as they're found.";
  if (t === "dns") return (o.type === "ALL" ? "All common records" : o.type + " records") + " via " + (o.dnsServer || "the system resolver") + ". An IP address gives its reverse name (PTR).";
  if (t === "whois") return "Who owns a domain (registrar, dates, name servers) or an IP address (network, organisation, abuse contact).";
  return "LAN speed test against an iperf3 server at the target.";
}
let toolSel = "ping";
function startBtnLabel() { $("tool-start").textContent = liveOn ? "Stop" : "Start"; }
function toolHint() { $("tool-hint").textContent = hintFor(toolSel); $("iperf-info").classList.toggle("hidden", toolSel !== "iperf"); startBtnLabel(); }
function startTool() { if (liveOn) { stopLive(); return; } $(TOOL_BTN[toolSel]).click(); }
document.querySelectorAll("#tool-seg button").forEach(b => b.onclick = () => {
  toolSel = b.dataset.tool; document.querySelectorAll("#tool-seg button").forEach(x => x.classList.toggle("on", x === b)); renderTopts(); toolHint();
});
renderTopts();

// rich (table / card) result in the page's result card; the copy text goes to Copy and to the console mode
function showRich(title, status, html, copy, bad) {
  if (outMode() === "dock") { show(copy); return; }
  const el = reveal(outPage); plainCard(el); setTitle(el, title); setStatus(el, status, bad ? "" : "done");
  const pre = el.querySelector(".res-out"); pre.textContent = ""; pre.classList.add("hidden");
  const rich = el.querySelector(".res-rich"); rich.innerHTML = html; rich.classList.remove("hidden"); el.dataset.copy = copy;
  ensureVisible(el);
}
const DNS_ORDER = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "PTR", "SRV", "CAA"];
async function dnsLookup(t) {
  const o = topt("dns");
  if (o.server === "custom" && !o.dnsServer) { show("Type the DNS server's IP in Tools > DNS > Other… first."); return; }
  busy("DNS " + o.type + " " + t); let d;
  try { d = await api("/api/dns/query", { target: t, type: o.type, server: o.dnsServer }); } catch (e) { busy(""); show(e.message); return; }
  busy("");
  if (d.error) { show(d.error); return; }
  const rows = (d.rows || []).slice().sort((a, b) => DNS_ORDER.indexOf(a.type) - DNS_ORDER.indexOf(b.type)), res = d.results || [];
  const ms = res.map(r => r.ms).filter(v => v != null), failed = res.filter(r => r.status !== "NOERROR");
  const nx = res.some(r => r.status === "NXDOMAIN"), timeout = res.length && res.every(r => r.status === "TIMEOUT");
  const badge = (r) => { const n = r.rows.length, cls = r.status === "NOERROR" ? (n ? "ok" : "none") : "bad";
    return "<span class='dchip " + cls + "'><b>" + esc(r.type) + "</b>" + (r.status === "NOERROR" ? (n ? n : "none") : esc(r.status)) + "</span>"; };
  const status = (timeout ? "⚠ No answer from " + esc(d.server) : nx ? "⚠ " + t + " does not exist (NXDOMAIN)" : "✔ " + rows.length + " record" + (rows.length === 1 ? "" : "s")) +
    " · via " + d.server + (ms.length ? " · " + Math.max(...ms) + " ms" : "");
  const html = "<div class='dchips'>" + res.map(badge).join("") + "</div>" +
    (rows.length ? "<table class='dns'><thead><tr><th>Type</th><th>Value</th><th>TTL</th></tr></thead><tbody>" +
      rows.map(r => "<tr><td class='t'>" + esc(r.type) + "</td><td class='v'>" + esc(r.value) + (r.name.toLowerCase() !== t.toLowerCase().replace(/\.$/, "") && r.type !== "PTR" ? "<small>" + esc(r.name) + "</small>" : "") +
        "</td><td class='ttl'>" + (r.ttl != null ? fmtTtl(r.ttl) : "") + "</td></tr>").join("") + "</tbody></table>"
      : "<div class='res-wait'>" + (timeout ? "The DNS server didn't answer — try another server." : nx ? "That name isn't registered / doesn't exist." : "No " + (o.type === "ALL" ? "" : o.type + " ") + "records for this name.") + "</div>") +
    "<div class='res-foot'>Server " + esc(d.server) + (ms.length ? " · slowest answer " + Math.max(...ms) + " ms" : "") + (failed.length && !nx && !timeout ? " · " + failed.map(r => r.type + " " + r.status).join(", ") : "") + "</div>";
  const copy = "DNS " + d.type + " " + t + " via " + d.server + "\n" + (rows.map(r => r.type.padEnd(6) + String(r.ttl ?? "").padStart(7) + "  " + r.value).join("\n") || "no records");
  showRich("DNS " + t, status, html, copy, nx || timeout);
}
function fmtTtl(s) { return s < 120 ? s + "s" : s < 7200 ? Math.round(s / 60) + "m" : s < 172800 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d"; }
async function whoisLookup(t) {
  busy("Whois " + t); let d;
  try { d = await api("/api/whois", { target: t }); } catch (e) { busy(""); show(e.message); return; }
  busy("");
  if (d.error) { show(d.error); return; }
  const ev = d.events || {}, rows = [];
  const add = (k, v) => { if (v != null && v !== "" && !(Array.isArray(v) && !v.length)) rows.push([k, v]); };
  let expHtml = "";
  if (ev.expiration) {
    const days = Math.round((new Date(ev.expiration) - Date.now()) / 86400000);
    expHtml = esc(ev.expiration) + " <span class='" + (days < 0 ? "nm-bad" : days < 30 ? "nm-warn" : "muted") + "'>(" + (days < 0 ? "expired " + -days + " days ago" : "in " + days + " days") + ")</span>";
  }
  if (d.kind === "domain") {
    add("Registrar", esc(d.registrar)); add("Registrant", esc(d.registrant)); add("Registered", esc(ev.registration || ""));
    add("Updated", esc(ev["last changed"] || "")); if (expHtml) rows.push(["Expires", expHtml]);
    add("Name servers", (d.nameservers || []).map(esc).join("<br>")); add("DNSSEC", d.dnssec ? "<span class='nm-ok'>signed</span>" : "not signed");
    add("Status", (d.status || []).map(esc).join("<br>")); add("Abuse", esc(d.abuse));
  } else {
    add("Network", esc(d.netname)); add("Organisation", esc(d.org)); add("Range", esc(d.range)); add("Country", esc(d.country)); add("Handle", esc(d.handle));
    add("Registered", esc(ev.registration || "")); add("Updated", esc(ev["last changed"] || "")); add("Abuse", esc(d.abuse));
  }
  const html = "<div class='kv'>" + rows.map(([k, v]) => "<div class='dd-row'><span class='k'>" + k + "</span><span class='v'>" + v + "</span></div>").join("") + "</div>" +
    "<div class='res-foot'>" + (/^rdap/.test(d.source || "rdap") ? "From RDAP (" + esc(d.source || "rdap.org") + ") — the modern whois." : "From the classic whois server " + esc(d.source) + " (this domain has no RDAP).") + "</div>";
  const tmp = document.createElement("div");
  const copy = "Whois " + t + "\n" + rows.map(([k, v]) => { tmp.innerHTML = String(v).replace(/<br>/g, ", "); return k.padEnd(14) + tmp.textContent; }).join("\n");
  showRich("Whois " + t, "✔ " + (d.kind === "domain" ? (d.registrar || "registered") + (ev.expiration ? " · expires " + ev.expiration : "") : (d.org || d.netname || "IP network") + (d.country ? " · " + d.country : "")), html, copy);
}
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

// ---------- show / hide password (an eye button in every password box) ----------
document.querySelectorAll("input[type=password]").forEach(inp => {
  const wrap = document.createElement("span"); wrap.className = "pw-wrap";
  inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
  const eye = document.createElement("button"); eye.type = "button"; eye.className = "pw-eye"; eye.textContent = "Show";
  eye.setAttribute("aria-label", "Show password"); eye.setAttribute("aria-pressed", "false");
  eye.onclick = () => {
    const show = inp.type === "password"; inp.type = show ? "text" : "password";
    eye.textContent = show ? "Hide" : "Show"; eye.setAttribute("aria-pressed", String(show)); eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
    inp.focus();
  };
  wrap.appendChild(eye);
  // hidden again whenever the box is emptied (after a join / save), so a password is never left on screen
  inp.addEventListener("input", () => { if (!inp.value && inp.type === "text") eye.click(); });
});

// ---------- boot ----------
$("dock-toggle").onclick = () => toggleDock();
toggleDock(true);   // console mode starts collapsed: it opens itself the moment a tool produces output
applyOutMode();
$("set-output").value = outMode();
$("set-output").onchange = () => { localStorage.setItem("outMode", $("set-output").value); applyOutMode(); toggleDock(true); };
fetch("/api/me").then(r => r.json()).then(d => { if (d.auth) showApp(); else showLogin(); }).catch(showLogin);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
