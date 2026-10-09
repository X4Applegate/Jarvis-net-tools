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

const base = { link: "Connected to 02:00:5e:00:00:01 (on wlan1)\n\tSSID: Example WiFi\n\tfreq: 5745.0\n\tsignal: -52 dBm\n\trx bitrate: 866.7 MBit/s VHT-MCS 9 80MHz\n",
  net: { iface: "wlan1", type: "wifi", ip: "192.168.88.34", gw: "192.168.88.1", speed: "", duplex: "" }, active: "Example WiFi:wlan1",
  usb: { iface: "wlan1", mbps: 5000, label: "5 Gbps", gen: "USB 3", usb3_capable: true, port_usb3: true, status: "ok", hint: "" } };
const B = (percent, source, level, extra = {}) => ({ percent, source, level, shutting_down: false, critical: 10, ...extra });
const withBattery = (battery) => (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...base, battery }) });
const reopen = async (page) => { await page.locator('#tabs button[data-page=tools]').tap(); await page.locator('#tabs button[data-page=home]').tap(); await page.waitForTimeout(700); };
const row = (page) => page.evaluate(() => {
  const r = document.getElementById("home-battery"), h = document.getElementById("home-battery-hint"), d = r && r.querySelector(".dot");
  return { row: !!r, text: r ? r.textContent : "", dot: d ? d.className : "", hint: h ? h.textContent : null, html: r ? r.innerHTML : "",
    fits: !r || r.scrollWidth <= r.clientWidth + 1, order: [...document.querySelectorAll("#home-conn .row .lbl")].map(x => x.textContent) };
});

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
await page.goto("http://127.0.0.1:8099/index.html#home"); await page.waitForTimeout(900);
let s = await row(page);
ok(s.row && /87%/.test(s.text) && /plugged in, charging/.test(s.text) && /\bok\b/.test(s.dot), "mock UPS: 87% · plugged in, charging, green: " + s.text);
ok(s.order.indexOf("Battery") === s.order.indexOf("USB Link") + 1, "Battery sits right after USB Link: " + s.order.join(" | "));
ok(/📍 Demo site\s+·\s+🔌 87%/.test(await page.locator("#hdr-site").textContent()), "header: site + plug + percent: " + await page.locator("#hdr-site").textContent());
await page.screenshot({ path: `${SHOTS}/battery-mains.png` });
const cases = [
  [B(100, "mains", "mains"), /100%.*plugged in, full/, "ok", null],
  [B(9, "mains", "mains"), /9%.*plugged in, charging/, "ok", null],            // low but plugged in: nothing to worry about
  [B(64, "battery", "battery"), /64%.*on battery/, "ok", null],
  [B(22, "battery", "low"), /22%.*on battery/, "warn", /Plug in soon: the Pi shuts down safely at 10%/],
  [B(9, "battery", "critical"), /9%.*on battery/, "bad", /shuts down safely at 10%/],
  [B(8, "battery", "critical", { shutting_down: true }), /8%.*shutting down safely/, "bad", null],
];
for (const [b, re, dot, hint] of cases) {
  await page.route("**/api/status", withBattery(b)); await reopen(page);
  s = await row(page);
  ok(re.test(s.text) && new RegExp("\\b" + dot + "\\b").test(s.dot) && (hint ? hint.test(s.hint || "") : s.hint === null) && s.fits,
    `${b.percent}% ${b.source}${b.shutting_down ? " shutting down" : ""}: "${s.text}" dot=${s.dot} hint=${s.hint}`);
  if (b.level === "low") await page.screenshot({ path: `${SHOTS}/battery-low.png` });
  await page.unroute("**/api/status");
}
await page.route("**/api/status", withBattery(null)); await reopen(page);
ok(!(await row(page)).row, "no UPS: no Battery row");
await page.unroute("**/api/status");
await page.route("**/api/status", withBattery({ percent: "<img src=x onerror=alert(1)>", source: "battery", level: "low", critical: "<b>10</b>" })); await reopen(page);
s = await row(page);
ok(!/<img/.test(s.html) && /&lt;img/.test(s.html) && (await page.locator("#home-battery-hint b").count()) === 0, "values are escaped");
await page.unroute("**/api/status");
await ctx.close();

// ---- the Pi's 4.3" touch screen, 800x480 ----
const kctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const kpage = await kctx.newPage(); watch(kpage);
await kpage.route("**/api/status", withBattery(B(22, "battery", "low")));
await kpage.goto("http://127.0.0.1:8099/?kiosk=1#home"); await kpage.waitForTimeout(900);
const k = await kpage.evaluate(() => {
  const r = document.getElementById("home-battery").getBoundingClientRect(), tabs = document.getElementById("tabs").getBoundingClientRect();
  return { bottom: Math.round(r.bottom), tabsTop: Math.round(tabs.top) };
});
const sub = await kpage.locator("#hdr-site").textContent();
ok(/🔋 22%/.test(sub), "touch screen: battery always visible in the header line: " + sub + " (row at " + JSON.stringify(k) + ")");
await kpage.locator('#tabs button[data-page=settings]').tap(); await kpage.waitForTimeout(400);
ok(/🔋 22%/.test(await kpage.locator("#hdr-site").textContent()), "and still there on other pages");
await kpage.screenshot({ path: `${SHOTS}/battery-kiosk.png` });
await kctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
