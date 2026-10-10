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

// ---- the touch screen, 800x480 ----
const ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
let chanCalls = 0; page.on("request", r => { if (r.url().endsWith("/api/channel")) chanCalls++; });
await page.goto("http://127.0.0.1:8099/?kiosk=1#wifi"); await settle(page, 1200);

// --- Channel Analyzer: its own page, no console ---
await page.locator("#btn-chan").scrollIntoViewIfNeeded(); await page.locator("#btn-chan").tap(); await settle(page, 900);
ok(await tvOpen(page) && (await page.locator("#tv-title").textContent()) === "Channel Analyzer", "Channel Analyzer opens its own full-screen page");
ok(await page.locator("#res-wifi:not(.hidden)").count() === 0, "nothing goes to the console");
const cards = await page.$$eval("#tv-body .tv-card", cs => cs.map(c => c.querySelector(".k").textContent + "=" + c.querySelector(".v").textContent));
ok(cards.length === 4 && /^Best 2\.4 GHz=ch (1|6|11)$/.test(cards[0]) && /^Suggested 5 GHz=ch \d+$/.test(cards[1]) && /^You are on=ch 149$/.test(cards[3]), "summary cards: best 2.4, suggested 5, 6 GHz, you: " + cards.join(" | "));
let rows = await page.$$eval("#tv-body .ch-row", rs => rs.map(r => r.querySelector(".ch-num").textContent));
const has = (c) => rows.some(r => new RegExp("^ch " + c + "(\\D|$)").test(r));
ok(has(1) && has(6) && has(11) && rows.some(r => /BEST/.test(r)), "2.4 GHz rows include 1/6/11 and a BEST tag: " + rows.join(","));
const crowded = await page.$$eval("#tv-body .ch-row", rs => rs.map(r => [r.dataset.ch, r.className]));
ok(crowded.some(([c, k]) => /busy|mid/.test(k)), "crowded channels are coloured: " + JSON.stringify(crowded));
await page.screenshot({ path: `${SHOTS}/tools-channel-24.png` });
await page.locator("#ch-seg button[data-b='5']").tap(); await settle(page, 300);
rows = await page.$$eval("#tv-body .ch-row .ch-num", rs => rs.map(r => r.textContent));
ok(rows.some(r => /^ch 149.*YOU/.test(r)), "5 GHz: the channel you're on is tagged YOU: " + rows.join(","));
const lap = await page.evaluate(() => { const r = document.querySelector("#tv-body .ch-row[data-ch='149']"), t = r.querySelector(".ch-tag.you").getBoundingClientRect(), b = r.querySelector(".ch-bar").getBoundingClientRect(); return t.right <= b.left; });
ok(lap, "the YOU / BEST tags don't overlap the bar");
await page.locator("#tv-body .ch-row[data-ch='149']").tap(); await settle(page, 300);
ok(/Example WiFi/.test(await page.locator("#tv-body .ch-row[data-ch='149'] .ch-nets").textContent()), "tapping a channel lists its networks");
await page.screenshot({ path: `${SHOTS}/tools-channel-5.png` });
ok(/● Live/.test(await page.locator("#tv-live").textContent()), "it says Live with the update time");
await page.locator("#tv-refresh").tap(); await settle(page, 200);
ok((await page.locator("#tv-refresh").textContent()) === "Resume" && /Paused/.test(await page.locator("#tv-live").textContent()), "Pause stops the live updates");
await page.locator("#tv-close").tap(); await settle(page, 300);
const n0 = chanCalls; await page.waitForTimeout(1500);
ok(!(await tvOpen(page)) && chanCalls === n0, "Close: page gone, no more scans");

// --- Watch Roaming: live page with a roam and a sticky-client warning ---
const seq = [
  [["AA", 80, true], ["BB", 40, false]],
  [["AA", 62, false], ["BB", 78, true]],                // roamed AA -> BB
  [["AA", 90, false], ["BB", 50, true]],                // AA 40% stronger, still on BB
  [["AA", 91, false], ["BB", 48, true]],
];
let polls = 0;
await page.route("**/api/aps", r => {
  const s = seq[Math.min(polls++, seq.length - 1)];
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ssid: "Example WiFi", aps: s.map(([b, sig, cur], i) => (
    { bssid: "02:00:5E:00:00:" + b, signal: sig, band: "5", ch: i ? "36" : "149", current: cur, name: i ? "" : "Lobby" })) }) });
});
await page.locator("#btn-roam").scrollIntoViewIfNeeded(); await page.locator("#btn-roam").tap(); await settle(page, 800);
ok(await tvOpen(page) && (await page.locator("#tv-title").textContent()) === "Watch Roaming", "Watch Roaming opens its own page");
ok(/Lobby/.test(await page.locator("#tv-body .tv-card").first().textContent()), "shows the AP you're on (by its saved name)");
ok((await page.locator("#tv-body .ap-row").count()) === 2 && (await page.locator("#tv-body .ap-row.cur").count()) === 1, "every AP of the network, the current one marked");
await page.waitForTimeout(5300);
ok(/roamed/.test(await page.locator("#tv-body .roam-ev").first().textContent()) && (await page.locator("#tv-body .tv-card").nth(2).locator(".v").textContent()) === "1",
  "a roam shows in the log and the count: " + await page.locator("#tv-body .roam-ev").first().textContent());
await page.waitForTimeout(10500);
ok(/Sticky client/.test(await page.locator("#tv-body .roam-warn").textContent() || ""), "a much stronger AP for 2 readings: sticky-client warning");
const px = await page.evaluate(() => { const c = document.getElementById("roam-graph"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
ok(px > 500, "the signal trace is drawn (" + px + " px)");
await page.screenshot({ path: `${SHOTS}/tools-roaming.png` });
await page.locator("#tv-close").tap(); const p0 = polls; await page.waitForTimeout(6000);
ok(polls === p0, "Close stops watching (" + (polls - p0) + " extra polls)");
await page.unroute("**/api/aps");

// --- show / hide password ---
await page.locator("#wifi-pass").scrollIntoViewIfNeeded(); await page.locator("#wifi-pass").fill("Correct-Horse-9");
const eye = page.locator("#wifi-pass + .pw-eye");
ok((await eye.textContent()) === "Show" && (await page.locator("#wifi-pass").getAttribute("type")) === "password", "Wi-Fi password hidden by default with a Show button");
await eye.tap(); await settle(page, 100);
ok((await page.locator("#wifi-pass").getAttribute("type")) === "text" && (await eye.textContent()) === "Hide" && (await eye.getAttribute("aria-pressed")) === "true", "Show reveals it (to check before Join)");
await page.screenshot({ path: `${SHOTS}/tools-password.png` });
await eye.tap(); await settle(page, 100);
ok((await page.locator("#wifi-pass").getAttribute("type")) === "password", "Hide hides it again");
const eyes = await page.$$eval("input", is => is.filter(i => i.closest(".pw-wrap")).map(i => i.id));
ok(["login-pass", "wz-pass", "wifi-pass", "pw-cur", "pw-new", "pw-new2", "mail-pass"].every(id => eyes.includes(id)), "every password box has the eye: " + eyes.join(","));
await ctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
