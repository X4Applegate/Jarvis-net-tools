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
const settle = (page, ms = 300) => page.waitForTimeout(ms);

// the touch screen; /api/scanall is held for 3 s so the "Scanning…" state can be checked
const ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
let scans = 0, release = null;
await page.route("**/api/scanall", async (r) => {
  scans++;
  await new Promise(res => { release = res; setTimeout(res, 3000); });
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ networks: [
    { ch: "149", sig: "86", ssid: "Example WiFi", band: "5", freq: 5745 }, { ch: "6", sig: "70", ssid: "Store Guest", band: "2.4", freq: 2437 }] }) });
});
const state = () => page.evaluate(() => ({
  banner: !document.getElementById("sig-scanning").classList.contains("hidden"), dim: document.getElementById("sig-graph").classList.contains("dim"),
  hdr: document.querySelector("#hdr-actions button").textContent, hdrOff: document.querySelector("#hdr-actions button").disabled,
  btn: document.getElementById("wifi-scan-btn").textContent, btnOff: document.getElementById("wifi-scan-btn").disabled }));

await page.goto("http://127.0.0.1:8099/?kiosk=1#wifi"); await settle(page, 800);     // entering Signal scans by itself
let s = await state();
ok(s.banner && s.dim, "while scanning: the banner shows over a dimmed graph");
ok(s.hdr === "Scanning…" && s.hdrOff && s.btn === "Scanning…" && s.btnOff, "header Scan and Scan Networks both say Scanning… and can't be tapped: " + JSON.stringify(s));
const box = await page.locator("#sig-scanning").boundingBox();
ok(box && box.width > 250 && box.height >= 40 && box.y > 0 && box.y + box.height < 480, "the banner is big and on screen: " + JSON.stringify(box));
await page.screenshot({ path: `${SHOTS}/scan-busy.png` });
for (let i = 0; i < 5; i++) { await page.locator("#hdr-actions button").tap({ force: true }); await page.locator("#wifi-scan-btn").tap({ force: true }); }
ok(scans === 1, "tapping 10 times starts no extra scans (" + scans + ")");
await page.waitForTimeout(3300);
s = await state();
ok(!s.banner && !s.dim && s.hdr === "Scan" && !s.hdrOff && s.btn === "Scan Networks" && !s.btnOff, "done: banner gone, buttons back: " + JSON.stringify(s));
ok((await page.locator("#wifi-list option").count()) === 2, "the Join list is filled");
await page.locator("#hdr-actions button").tap(); await settle(page, 300);
ok(scans === 2 && (await state()).banner, "Scan again works and shows the banner again");
await page.waitForTimeout(3300);
await ctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
