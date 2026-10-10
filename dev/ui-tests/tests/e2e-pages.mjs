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
const tvOpen = (page) => page.locator("#tv").evaluate(d => d.open);
const inked = (page, id) => page.evaluate((id) => { const c = document.getElementById(id), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; }, id);

const ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);

// --- Live Signal Meter: signal changes every reading ---
const sigs = [-48, -55, -63, -71, -82, -58];
let n = 0;
await page.route("**/api/signal", r => { const s = sigs[Math.min(n++, sigs.length - 1)];
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ link: "Connected to 02:00:5e:00:00:01 (on wlan1)\n\tSSID: Example WiFi\n\tfreq: 5745.0\n\tsignal: " + s + " dBm\n\trx bitrate: 866.7 MBit/s VHT-MCS 9 80MHz\n\ttx bitrate: 780.0 MBit/s\n" }) }); });
await page.goto("http://127.0.0.1:8099/?kiosk=1#wifi"); await settle(page, 1000);
await page.locator("#btn-signal2").scrollIntoViewIfNeeded(); await page.locator("#btn-signal2").tap(); await settle(page, 600);
ok(await tvOpen(page) && (await page.locator("#tv-title").textContent()) === "Live Signal Meter", "Signal Meter opens its own page");
ok(/Excellent/.test(await page.locator("#sm-q").textContent()) && /Example WiFi/.test(await page.locator("#sm-q").textContent()), "quality word + network: " + await page.locator("#sm-q").textContent());
ok((await inked(page, "sm-gauge")) > 2000, "the gauge is drawn");
await page.waitForTimeout(4300);
const cards = await page.$$eval("#sm-cards .tv-card", cs => cs.map(c => c.querySelector(".k").textContent + "=" + c.querySelector(".v").textContent));
ok(/Band=5 GHz/.test(cards[0]) && /Link rate=866\.7/.test(cards[1]) && /Min \/ Avg \/ Max=-82 \/ -\d+ \/ -48/.test(cards[2]) && /Access point=00:00:01/i.test(cards[3]), "cards: band, rates, min/avg/max, AP: " + cards.join(" | "));
ok(/Very weak|Weak/.test(await page.locator("#sm-q").textContent()), "quality follows the signal down: " + await page.locator("#sm-q").textContent());
ok((await inked(page, "sm-graph")) > 300 && n >= 5, "the 2-minute graph is drawn, updated every second (" + n + " readings)");
await page.screenshot({ path: `${SHOTS}/pages-signal.png` });
await page.locator("#tv-close").tap(); const n0 = n; await page.waitForTimeout(2200);
ok(n === n0, "Close stops the meter");

// --- Service / POS Check: tiles, groups, LAN, change log ---
await page.locator('#tabs button[data-page=monitor]').tap(); await settle(page, 400);
await page.goto("http://127.0.0.1:8099/?kiosk=1#home"); await settle(page, 900);
await page.locator("#btn-services").scrollIntoViewIfNeeded(); await page.locator("#btn-services").tap(); await settle(page, 900);
ok(await tvOpen(page) && (await page.locator("#tv-title").textContent()) === "Service / POS Check", "Service check opens its own page");
const sum1 = await page.locator(".svc-sum").textContent();
const groups = await page.$$eval("#tv-body .tv-h", hs => hs.map(h => h.textContent));
ok(groups.slice(0, 4).join() === "Network,Payments,Apps,Your checks" && /On this LAN \(192\.168\.88\.0\/24\)/.test(groups[4]), "grouped: Network / Payments / Apps / Your checks, then the LAN: " + groups.join(" | "));
const tiles = await page.$$eval(".svc-tile", ts => ts.map(t => t.querySelector(".n span").textContent + (t.classList.contains("down") ? "!" : "")));
ok(tiles.length === 7, "one tile per check: " + tiles.join(","));
ok(/IPP printer/.test(await page.locator(".svc-lan").textContent()) && /192\.168\.88\.77/.test(await page.locator(".svc-lan").textContent()), "printers / controller found on the LAN");
await page.screenshot({ path: `${SHOTS}/pages-services.png` });
// second round (Toast goes down): summary turns red and the change is logged
await page.locator("#tv-refresh").tap(); await page.locator("#tv-refresh").tap(); await settle(page, 900);   // pause+resume = check now
const sum2 = await page.locator(".svc-sum").textContent();
ok((/All good/.test(sum1) && /1 of 7 failed/.test(sum2)) || (/1 of 7 failed/.test(sum1) && /All good/.test(sum2)), "the summary follows the result: " + sum1 + " -> " + sum2);
ok(/Toast POS (went DOWN|is back up)/.test(await page.locator("#tv-body").textContent()), "a change while watching is logged");
await page.screenshot({ path: `${SHOTS}/pages-services-down.png` });
await page.locator("#tv-close").tap();
await ctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
