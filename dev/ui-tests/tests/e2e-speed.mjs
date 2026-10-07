import { chromium } from "playwright-core";
const exe = process.env.CHROME_PATH || undefined;   // unset = the browser installed by `npx playwright-core install chromium`
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await ctx.newPage(); const errors = []; page.on("console", m => { if (/Content Security Policy|Refused to (load|apply|execute|connect|frame)/.test(m.text())) errors.push("CSP: " + m.text()); });
page.on("pageerror", e => errors.push("pageerror: " + e.message));
const calls = []; page.on("request", r => { if (r.url().includes("/api/")) calls.push(r.method() + " " + new URL(r.url()).pathname); });
const shot = (n) => page.screenshot({ path: `${process.env.SHOTS_DIR || "./shots"}/${n}.png` });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
// fingerprint of the gauge canvas + count of "orange" pixels (the active arc / needle glow)
const gauge = () => page.evaluate(() => { const c = document.getElementById("sp-gauge"), x = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let h = 0, or = 0, bl = 0; for (let i = 0; i < x.length; i += 4) { h = (h * 31 + x[i] + x[i + 1] * 3 + x[i + 2] * 7) >>> 0; if (x[i] > 220 && x[i + 1] > 90 && x[i + 1] < 140 && x[i + 2] < 60) or++; if (x[i] < 90 && x[i + 1] > 100 && x[i + 1] < 150 && x[i + 2] > 220) bl++; } return { h, or, bl, w: c.width, hgt: c.height }; });
const tile = (k) => page.locator(`#sp-tiles .tile[data-k=${k}] b`).textContent();

await page.goto("http://127.0.0.1:8099/index.html#monitor"); await page.waitForTimeout(1200);
// idle: gauge drawn, last result in the tiles
const g0 = await gauge(); ok(g0.w > 600 && g0.hgt > 400, "gauge canvas sized: " + g0.w + "x" + g0.hgt);
ok(g0.or === 0, "idle gauge has no coloured arc");
ok(/^last:/.test(await page.locator("#sp-note").textContent()), "idle note shows last test: " + await page.locator("#sp-note").textContent());
ok((await tile("down")) !== "—" && (await tile("up")) !== "—", "idle tiles hold the last test numbers");
ok((await page.locator("#btn-speed2").textContent()) === "Start Test", "start button label");
await shot("speed-idle");

// run: needle + arc come alive while the stream is still running
await page.locator("#btn-speed2").tap(); await page.waitForTimeout(500);
ok((await page.locator("#btn-speed2").textContent()) === "Stop", "button becomes Stop");
ok((await page.locator("#hdr-actions button").textContent()) === "Stop", "header action becomes Stop");
await page.waitForTimeout(900);
const g1 = await gauge(), n1 = await page.locator("#sp-note").textContent();
ok(n1.includes("DOWNLOAD"), "note says DOWNLOAD mid-run: " + n1);
ok(g1.or > 300, "orange arc is drawn while downloading (" + g1.or + " px)");
ok(g1.h !== g0.h, "gauge changed vs idle");
ok(await page.locator("#sp-tiles .tile.dn.on").count() === 1, "download tile highlighted");
const d1 = parseFloat(await tile("down")); ok(d1 > 50, "download tile shows a live value: " + d1);
ok(await page.locator("#sp-trace:not(.hidden)").count() === 1, "speed-over-time trace visible");
await page.waitForTimeout(500); const g2 = await gauge(); ok(g2.h !== g1.h, "needle keeps moving between samples");
await shot("speed-download");
await page.waitForTimeout(1200);
const n2 = await page.locator("#sp-note").textContent(); ok(n2.includes("UPLOAD") || n2.includes("✔"), "reaches upload: " + n2);
const g3 = await gauge(); if (n2.includes("UPLOAD")) { ok(g3.bl > 200, "blue arc while uploading (" + g3.bl + " px)"); await shot("speed-upload"); }
await page.waitForTimeout(2600);
ok((await page.locator("#sp-note").textContent()).includes("✔ 650.2"), "finished note: " + await page.locator("#sp-note").textContent());
ok(await page.locator("#sp-result:not(.hidden)").count() === 1, "result details shown");
ok((await page.locator("#sp-result .gradechip").textContent()) === "B", "grade chip B");
ok((await page.locator("#sp-result").textContent()).includes("Example Net") && (await page.locator("#sp-result").textContent()).includes("USB bus speed"), "server + wifi note in details");
ok((await tile("down")) === "650" || (await tile("down")) === "650.2", "final download tile: " + await tile("down"));
ok((await tile("up")) === "339", "final upload tile: " + await tile("up"));
ok((await page.locator("#btn-speed2").textContent()) === "Start Test", "button restored");
ok((await page.locator("#hdr-actions button").textContent()) === "Test", "header action restored");
await page.waitForTimeout(800);
const gEnd = await gauge(); ok(gEnd.or < 100, "needle/arc settled back to rest after the test (" + gEnd.or + " px)");
ok(calls.filter(c => c === "GET /api/netmon/speed").length >= 2, "history refreshed after the test");
await shot("speed-done");

// stop mid-run: nothing saved, clean state
await page.locator("#btn-speed2").tap(); await page.waitForTimeout(900);
await page.locator("#hdr-actions button").tap(); await page.waitForTimeout(600);
ok((await page.locator("#sp-msg").textContent()).includes("Stopped"), "stop message: " + await page.locator("#sp-msg").textContent());
ok(await page.locator("#sp-result.hidden").count() === 1, "stop: no result details");
ok((await page.locator("#btn-speed2").textContent()) === "Start Test", "stop: button restored");

// Info quick action jumps to the Speed tab and starts
await page.locator('#tabs button[data-page=home]').tap(); await page.waitForTimeout(500);
const before = calls.filter(c => c === "POST /api/speedtest/stream").length;
await page.locator("#btn-speed").tap(); await page.waitForTimeout(900);
ok(await page.locator("#page-monitor:not(.hidden)").count() === 1, "info quick action opens the Speed tab");
ok(calls.filter(c => c === "POST /api/speedtest/stream").length === before + 1, "info quick action started a test");
ok((await page.locator("#btn-speed2").textContent()) === "Stop", "running after quick action");
await page.locator("#btn-speed2").tap(); await page.waitForTimeout(500);   // stop it

// failure / retry shown honestly
const sse = (evs) => "event: start\ndata: {}\n\n" + evs.map(e => "data: " + JSON.stringify(e) + "\n\n").join("") + "event: done\ndata: {}\n\n";
await page.route("**/api/speedtest/stream", r => r.fulfill({ status: 200, contentType: "text/event-stream", body: sse([{ type: "retry" }, { type: "log", level: "error", message: "Latency test failed" }, { type: "failed" }]) }));
await page.locator("#btn-speed2").tap(); await page.waitForTimeout(700);
ok((await page.locator("#sp-msg").textContent()).includes("failed"), "failed run message: " + await page.locator("#sp-msg").textContent());
ok(await page.locator("#sp-result.hidden").count() === 1, "failed run shows no result");
await shot("speed-failed");
await page.unroute("**/api/speedtest/stream");

// old Pi app (no stream endpoint) -> falls back to the one-shot test
await page.route("**/api/speedtest/stream", r => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
await page.locator("#btn-speed2").tap(); await page.waitForTimeout(900);
ok(calls.includes("POST /api/speedtest"), "fallback: old /api/speedtest used");
ok((await page.locator("#btn-speed2").textContent()) === "Start Test", "fallback: button restored");
await page.unroute("**/api/speedtest/stream");
ok(!errors.some(e => e.startsWith("CSP")), "no Content-Security-Policy violations: " + errors.filter(e => e.startsWith("CSP")).join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
