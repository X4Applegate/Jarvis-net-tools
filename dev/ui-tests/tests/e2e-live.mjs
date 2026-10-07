import { chromium } from "playwright-core";
const exe = process.env.CHROME_PATH || undefined;   // unset = the browser installed by `npx playwright-core install chromium`
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await ctx.newPage(); const errors = []; page.on("console", m => { if (/Content Security Policy|Refused to (load|apply|execute|connect|frame)/.test(m.text())) errors.push("CSP: " + m.text()); });
page.on("pageerror", e => errors.push("pageerror: " + e.message));
const calls = [], bodies = []; page.on("request", r => { if (r.url().includes("/api/")) { calls.push(r.method() + " " + new URL(r.url()).pathname); if (r.url().includes("ping/stream")) bodies.push(r.postData()); } });
const shot = (n) => page.screenshot({ path: `${process.env.SHOTS_DIR || "./shots"}/${n}.png` });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const tab = async (pg) => { await page.locator(`#tabs button[data-page=${pg}]`).tap(); await page.waitForTimeout(450); };
const nLines = async () => (await page.locator("#res-tools .res-out").textContent()).split("\n").filter(l => l.includes(" ttl ")).length;
const status = () => page.locator("#res-tools .res-status").textContent();

await page.goto("http://127.0.0.1:8099/index.html#tools"); await page.waitForTimeout(800);
await page.fill("#target", "google.com");

// 1) Ping shows replies INCREMENTALLY while still running
await page.locator("#tool-start").tap();
await page.waitForTimeout(900);
const a = await nLines(), st1 = await status();
ok(a >= 1 && a <= 6, "ping: some replies already visible mid-run (" + a + ")");
ok(st1.includes("LIVE"), "ping: banner says LIVE mid-run: " + st1);
ok(await page.locator("#res-tools .res-spark:not(.hidden)").count() === 1, "ping: latency graph shown");
ok((await page.locator("#tool-start").textContent()) === "Stop", "ping: Start becomes Stop while running");
await page.waitForTimeout(700); const b = await nLines();
ok(b > a, "ping: more replies arrived later (" + a + " -> " + b + ")");
await shot("live-ping-mid");
await page.waitForTimeout(2600);
ok((await status()).includes("Finished"), "ping: finishes by itself: " + await status());
ok((await status()).includes("10 sent") && (await status()).includes("0% loss"), "ping: final stats: " + await status());
ok((await page.locator("#res-tools .res-title").textContent()) === "Ping google.com", "ping: title");
ok((await page.locator("#tool-start").textContent()) === "Start", "ping: Start restored after finish");
await shot("live-ping-done");

// 2) Stop mid-run via the header action
await page.locator("#tool-start").tap(); await page.waitForTimeout(700);
await page.locator("#hdr-actions button").tap(); await page.waitForTimeout(500);
ok((await status()).includes("Stopped"), "stop: banner says Stopped: " + await status());
const c1 = await nLines(); await page.waitForTimeout(900); ok((await nLines()) === c1, "stop: no more lines after Stop");

// 3) Continuous monitor
await page.locator("#tool-seg button[data-tool=monitor]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(2300);
ok((await nLines()) >= 6, "monitor: keeps streaming (" + await nLines() + ")");
ok((await page.locator("#res-tools .res-title").textContent()).startsWith("Ping Monitor"), "monitor: title");
await shot("live-monitor");
await page.locator("#tool-start").tap(); await page.waitForTimeout(500);
ok((await status()).includes("Stopped"), "monitor: Stop works");

// 4) Gateway quick test sends @gateway and streams
await page.locator("#btn-pinggw2").tap(); await page.waitForTimeout(900);
ok(bodies.some(x => x && x.includes("@gateway")), "gateway: @gateway requested");
ok((await page.locator("#res-tools .res-title").textContent()) === "Ping Gateway", "gateway: title");
ok((await nLines()) >= 1, "gateway: lines arriving");
await page.waitForTimeout(3000);

// 5) starting another tool while a monitor is live stops the monitor and takes over the card
await page.locator("#tool-seg button[data-tool=monitor]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(800);
await page.locator("#btn-bw").tap(); await page.waitForTimeout(900);
ok((await page.locator("#res-tools .res-title").textContent()) === "Bandwidth", "takeover: card now shows Bandwidth");
ok((await page.locator("#tool-start").textContent()) === "Start", "takeover: monitor was stopped");
const txt = await page.locator("#res-tools .res-out").textContent(); await page.waitForTimeout(800);
ok((await page.locator("#res-tools .res-out").textContent()) === txt && !txt.includes(" ttl "), "takeover: no ping lines leak into the new result");

// 6) timeouts rendered (unreachable host)
await page.fill("#target", "192.0.2.1"); await page.locator("#tool-seg button[data-tool=ping]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(2200);
ok((await page.locator("#res-tools .res-out").textContent()).includes("no reply (timeout)"), "timeouts: no-reply lines shown");
ok(!/ 0% loss/.test(await status()) || (await status()).includes("sent"), "timeouts: stats present: " + await status());
await shot("live-timeouts"); await page.waitForTimeout(2500);

// 7) fallback when the Pi app has no streaming endpoint (older build)
await page.route("**/api/ping/stream", r => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
await page.fill("#target", "google.com"); await page.locator("#tool-start").tap(); await page.waitForTimeout(900);
ok(calls.includes("POST /api/ping"), "fallback: old /api/ping used when streaming unavailable");
ok((await page.locator("#res-tools .res-out").textContent()).includes("(mock)"), "fallback: result shown");
await page.unroute("**/api/ping/stream");

// 8) Settings: console mode streams into the dock
await tab("settings"); await page.selectOption("#set-output", "dock"); await tab("tools");
await page.locator("#tool-start").tap(); await page.waitForTimeout(800);
ok((await page.locator("#out").textContent()).includes(" ttl "), "dock: lines stream into the console");
ok((await page.locator("#status-line").textContent()).includes("LIVE"), "dock: live stats in the status line");
await page.locator("#tool-start").tap(); await page.waitForTimeout(300);
ok(!errors.some(e => e.startsWith("CSP")), "no Content-Security-Policy violations: " + errors.filter(e => e.startsWith("CSP")).join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
