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
const settle = (page, ms = 500) => page.waitForTimeout(ms);
const rows = (page) => page.$$eval("#dev-list .dev-row", rs => rs.map(r => ({ name: r.querySelector(".dr-name").textContent, ip: r.querySelector(".dr-ip").textContent,
  b: [...r.querySelectorAll(".bd")].map(x => x.textContent).join(""), ms: r.querySelector(".dr-ms").textContent })));

// ---- phone 390x844 ----
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
let scans = 0, release;
await page.route("**/api/devices", async r => { scans++; await new Promise(res => { release = res; setTimeout(res, 2500); }); r.continue(); });
const sent = []; page.on("request", r => { if (r.method() === "POST" && /\/api\/(wol|ping\/stream|settings)$/.test(new URL(r.url()).pathname)) sent.push(new URL(r.url()).pathname + " " + r.postData()); });
await page.goto("http://127.0.0.1:8099/index.html#network"); await settle(page, 900);
let r = await rows(page);
ok(r.length === 4 && /Example WiFi \(4\)/.test(await page.locator("#lan-net").textContent()) && /scanned/.test(await page.locator("#lan-when").textContent()),
  "opening LAN shows the last scan straight away: network, count, time");
ok(r[0].name === "Omada Gateway" && r[0].ip === "192.168.88.1" && r[0].b === "GWUP" && r[0].ms === "1.2 ms", "gateway row: name, IP, badges G W U P, ping: " + JSON.stringify(r[0]));
ok(r[1].b === "B6PS" && r[3].name === "(no name)" && r[3].ms === "—", "this Pi has S; a nameless device says so; no ping reply = —: " + JSON.stringify([r[1], r[3]]));
ok(await page.locator("#dev-list .dr-ip b").first().textContent() === "1", "the last part of the IP is bold");
ok(await page.locator("#lan-legend").isVisible() && /Gateway/.test(await page.locator("#lan-legend").textContent()), "the legend explains the badges");
ok(await page.locator("#res-network:not(.hidden)").count() === 0, "no console card");
await page.screenshot({ path: `${SHOTS}/lan-list.png`, fullPage: false });
await page.locator("#lan-search").fill("printer"); await settle(page, 200);
ok((await rows(page)).length === 1 && (await rows(page))[0].ip === "192.168.88.77", "search filters (by type too)");
await page.locator("#lan-search").fill("zzz"); await settle(page, 200);
ok(/Nothing matches/.test(await page.locator("#dev-list").textContent()), "no match: says so");
await page.locator("#lan-search").fill(""); await settle(page, 200);

// scan: hard-to-miss state, no double scans
await page.locator("#hdr-actions button").tap(); await settle(page, 300);
ok(await page.locator("#lan-scanning").isVisible() && (await page.locator("#hdr-actions button").textContent()) === "Scanning…" && await page.locator("#hdr-actions button").isDisabled(), "Scan: big Scanning card, header disabled");
ok(await page.locator("#btn-devices2").isDisabled(), "the Scan for Devices button is disabled too");
await page.evaluate(() => { for (let i = 0; i < 4; i++) document.getElementById("btn-devices2").onclick(); });   // even if a tap got through
await page.waitForTimeout(3000);
ok(scans === 1 && !(await page.locator("#lan-scanning").isVisible()) && (await rows(page)).length === 4, "one scan for many taps; list refreshed (" + scans + ")");

// device details
await page.locator("#dev-list .dev-row[data-ip='192.168.88.1']").tap(); await settle(page, 600);
ok(await page.locator("#tv").evaluate(d => d.open) && (await page.locator("#tv-title").textContent()) === "Omada Gateway", "tap a device: its Details page");
const sects = await page.$$eval("#tv-body .dd-sect", s => s.map(x => x.textContent));
ok(sects.join() === "Actions,Device,Device Names", "sections: Actions / Device / Device Names");
const kv = await page.$$eval("#tv-body .dd-row", rs => Object.fromEntries(rs.map(r => [r.querySelector(".k").textContent, r.querySelector(".v") ? r.querySelector(".v").textContent : ""])));
ok(kv["IP Address"] === "192.168.88.1" && kv["MAC"] === "02:00:5E:00:00:03" && kv["Vendor"] === "TP-Link" && /Yes · 1\.2 ms/.test(kv["Pingable"]) && kv["DNS Name"] === "router.lan" &&
   kv["UPnP Model"] === "TP-Link ER605" && kv["mDNS Name"] === "N/A" && kv["Open ports"] === "2280443", "device facts + every name source (N/A when empty): " + JSON.stringify(kv));
ok((await page.locator("#dd-web").getAttribute("href")) === "https://192.168.88.1", "website: Web interface link");
await page.screenshot({ path: `${SHOTS}/lan-details.png` });
await page.locator("#dd-wol").tap(); await settle(page, 500);
ok(sent.some(s => s.startsWith("/api/wol") && s.includes("02:00:5E:00:00:03")) && /Wake-up packet sent/.test(await page.locator("#dd-msg").textContent()), "Wake on LAN sends to its MAC");
page.once("dialog", d => d.accept("Main Router"));
await page.locator("#dd-save").tap(); await settle(page, 700);
ok((await page.locator("#tv-title").textContent()) === "Main Router" && (await rows(page))[0].name === "Main Router", "Save names it: the page and the list use the saved name");
await page.locator("#dd-ping").tap(); await settle(page, 700);
ok(!(await page.locator("#tv").evaluate(d => d.open)) && await page.locator("#page-tools").isVisible() && (await page.locator("#target").inputValue()) === "192.168.88.1"
   && (await page.locator("#tool-seg button.on").textContent()) === "Ping", "Ping: jumps to Tools with that IP, Ping selected and started");
await ctx.close();

// ---- the touch screen 800x480 ----
const k = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const kp = await k.newPage(); watch(kp);
await kp.goto("http://127.0.0.1:8099/?kiosk=1#network"); await settle(kp, 900);
const fit = await kp.evaluate(() => [...document.querySelectorAll(".dev-row")].every(r => r.scrollWidth <= r.clientWidth + 1));
ok(fit, "touch screen: rows fit");
await kp.screenshot({ path: `${SHOTS}/lan-kiosk.png` });
await kp.locator("#dev-list .dev-row[data-ip='192.168.88.34']").tap(); await settle(kp, 600);
await kp.screenshot({ path: `${SHOTS}/lan-kiosk-details.png` });
ok(/2001:db8::34/.test(await kp.locator("#tv-body").textContent()) && /jarvis-pi\.local/.test(await kp.locator("#tv-body").textContent()), "IPv6 + mDNS name shown");
await k.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
