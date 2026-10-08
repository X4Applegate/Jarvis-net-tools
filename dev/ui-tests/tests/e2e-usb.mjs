import { chromium } from "playwright-core";
const exe = process.env.CHROME_PATH || undefined;   // unset = the browser installed by `npx playwright-core install chromium`
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const errors = [];
const watch = (page) => {
  page.on("console", m => { if (/Content Security Policy|Refused to (load|apply|execute|connect|frame)/.test(m.text())) errors.push("CSP: " + m.text()); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
};
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const SHOTS = process.env.SHOTS_DIR || "./shots";

// /api/status as the mock sends it, with the "usb" object swapped
const base = { link: "Connected to 02:00:5e:00:00:01 (on wlan1)\n\tSSID: Example WiFi\n\tfreq: 5745.0\n\tsignal: -52 dBm\n\trx bitrate: 866.7 MBit/s VHT-MCS 9 80MHz\n",
  net: { iface: "wlan1", type: "wifi", ip: "192.168.88.34", gw: "192.168.88.1", speed: "", duplex: "" }, active: "Example WiFi:wlan1" };
const USB = {
  warn: { iface: "wlan1", mbps: 480, label: "480 Mbps", gen: "USB 2.0", usb3_capable: true, port_usb3: true, status: "warn",
    hint: "USB 3 adapter on USB 2 (Wi-Fi max ~200 Mbps): flip the USB-C plug 180°, push both ends fully in.", id: "0e8d:7961", product: "Wireless_Device", usb_path: "1-1" },
  info: { iface: "wlan1", mbps: 480, label: "480 Mbps", gen: "USB 2.0", usb3_capable: false, port_usb3: true, status: "info",
    hint: "USB 2 adapter: 480 Mbps is its maximum.", id: "0bda:8179", product: "802.11n NIC", usb_path: "1-1" },
  evil: { iface: "wlan1", mbps: 480, label: "<b>480</b>", gen: "USB 2.0", status: "warn", hint: "<img src=x onerror=alert(1)>" },
};
const statusWith = (usb) => (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...base, usb }) });
const reopenHome = async (page) => {               // switching tabs re-runs the Info refresh
  await page.locator('#tabs button[data-page=tools]').tap(); await page.locator('#tabs button[data-page=home]').tap(); await page.waitForTimeout(700);
};
const row = (page) => page.evaluate(() => {
  const r = document.getElementById("home-usb"), h = document.getElementById("home-usb-hint");
  const d = r && r.querySelector(".dot"), s = h && h.querySelector("span");
  return { row: !!r, text: r ? r.textContent : "", dot: d ? d.className : "", hint: h ? h.textContent : null, hintCls: s ? s.className : "",
    hintFits: !h || h.scrollWidth <= h.clientWidth + 1, rowFits: !r || r.scrollWidth <= r.clientWidth + 1,
    html: r ? r.innerHTML : "", imgs: document.querySelectorAll("#home-conn img").length,
    order: [...document.querySelectorAll("#home-conn .row .lbl")].map(x => x.textContent) };
});

// ---- phone, 390x844 ----
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
await page.goto("http://127.0.0.1:8099/index.html#home"); await page.waitForTimeout(900);
let s = await row(page);
ok(s.row && /5 Gbps/.test(s.text) && /USB 3/.test(s.text), "USB 3: row shows the speed and generation: " + s.text);
ok(/\bok\b/.test(s.dot), "USB 3: green dot (" + s.dot + ")");
ok(s.hint === null, "USB 3: no hint row");
ok(s.order.indexOf("USB Link") > s.order.indexOf("Link Rate") && s.order.indexOf("USB Link") < s.order.indexOf("IP Address"), "row sits after the Wi-Fi rows: " + s.order.join(" | "));
await page.screenshot({ path: `${SHOTS}/usb-ok.png` });

await page.route("**/api/status", statusWith(USB.warn)); await reopenHome(page);
s = await row(page);
ok(/480 Mbps/.test(s.text) && /USB 2\.0/.test(s.text), "fallback: row shows 480 Mbps · USB 2.0: " + s.text);
ok(/\bwarn\b/.test(s.dot), "fallback: amber dot (" + s.dot + ")");
ok(s.hint && /flip the USB-C plug/.test(s.hint) && s.hint.startsWith("⚠"), "fallback: hint tells what to do: " + s.hint);
ok(/nm-warn/.test(s.hintCls), "fallback: hint is amber (" + s.hintCls + ")");
ok(s.hintFits && s.rowFits, "fallback: row and hint wrap inside the phone width");
await page.screenshot({ path: `${SHOTS}/usb-warn.png` });

// live: re-plugging fixes it and the 5 s auto-refresh picks that up without touching the screen
await page.unroute("**/api/status"); await page.waitForTimeout(6000);
s = await row(page);
ok(/5 Gbps/.test(s.text) && /\bok\b/.test(s.dot) && s.hint === null, "live refresh turns it green again after a re-plug: " + s.text);

await page.route("**/api/status", statusWith(USB.info)); await reopenHome(page);
s = await row(page);
ok(/480 Mbps/.test(s.text) && !/\b(ok|warn)\b/.test(s.dot.replace("dot", "")), "USB 2-only adapter: neutral dot (" + s.dot + ")");
ok(s.hint && !s.hint.startsWith("⚠") && /muted/.test(s.hintCls), "USB 2-only adapter: quiet note, no warning: " + s.hint);

await page.unroute("**/api/status"); await page.route("**/api/status", statusWith(null)); await reopenHome(page);
s = await row(page);
ok(!s.row && s.hint === null, "built-in (non-USB) radio: no USB row");

await page.unroute("**/api/status"); await page.route("**/api/status", statusWith(USB.evil)); await reopenHome(page);
s = await row(page);
ok(s.imgs === 0 && /&lt;b&gt;480/.test(s.html) && s.hint.includes("<img"), "values are escaped, not rendered as HTML");
await page.unroute("**/api/status");
await ctx.close();

// ---- the Pi's 4.3" touch screen, 800x480 (kiosk) ----
const kctx = await browser.newContext({ viewport: { width: 800, height: 480 }, serviceWorkers: "block" });
const kpage = await kctx.newPage(); watch(kpage);
await kpage.route("**/api/status", statusWith(USB.warn));
await kpage.goto("http://127.0.0.1:8099/?kiosk=1#home"); await kpage.waitForTimeout(900);
s = await row(kpage);
ok(s.row && /\bwarn\b/.test(s.dot) && s.hintFits && s.rowFits, "touch screen: amber row + hint fit the 800 px width");
const k = await kpage.evaluate(() => {               // glanceable: row + whole hint above the tab bar, without scrolling
  const sp = document.querySelector("#home-usb-hint span"), t = sp.getBoundingClientRect(), tabs = document.getElementById("tabs").getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(sp).lineHeight) || 18;
  return { bottom: t.bottom, tabsTop: tabs.top, lines: Math.round(t.height / lh) };
});
ok(k.bottom <= k.tabsTop, "touch screen: whole hint visible above the tab bar without scrolling (" + Math.round(k.bottom) + " <= " + Math.round(k.tabsTop) + ")");
ok(k.lines === 1, "touch screen: hint is one line (" + k.lines + ")");
await kpage.screenshot({ path: `${SHOTS}/usb-warn-kiosk.png` });
await kctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
