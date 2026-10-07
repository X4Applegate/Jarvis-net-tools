import { chromium } from "playwright-core";
const exe = process.env.CHROME_PATH || undefined;   // unset = the browser installed by `npx playwright-core install chromium`
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8099" }).catch(() => {});
const page = await ctx.newPage(); const errors = []; page.on("console", m => { if (/Content Security Policy|Refused to (load|apply|execute|connect|frame)/.test(m.text())) errors.push("CSP: " + m.text()); });
page.on("pageerror", e => errors.push("pageerror: " + e.message));
const calls = []; page.on("request", r => { if (r.url().includes("/api/")) calls.push(r.method() + " " + new URL(r.url()).pathname); });
const shot = (n) => page.screenshot({ path: `${process.env.SHOTS_DIR || "./shots"}/${n}.png` });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const card = "#res-tools";
const status = () => page.locator(card + " .res-status").textContent();
const rowsCount = () => page.locator(card + " table.hops tbody tr").count();
const chips = () => page.locator(card + " .chip").count();

await page.goto("http://127.0.0.1:8099/index.html#tools"); await page.waitForTimeout(800);
await page.fill("#target", "1.1.1.1");

// ---- ROUTE: table builds up live
await page.locator("#tool-seg button[data-tool=trace]").tap();
ok((await page.locator("#tool-hint").textContent()).includes("Live route"), "route: hint updated");
await page.locator("#tool-start").tap(); await page.waitForTimeout(1100);
const r1 = await rowsCount(), s1 = await status();
ok(r1 >= 2 && r1 <= 8, "route: hops already visible mid-run (" + r1 + ")");
ok(s1.includes("LIVE") && s1.includes("pass"), "route: live banner with pass counter: " + s1);
ok(await page.locator(card + " .res-out:not(.hidden)").count() === 0, "route: no duplicate plain-text block");
ok((await page.locator("#tool-start").textContent()) === "Stop", "route: Start->Stop");
await page.waitForTimeout(1200); const r2 = await rowsCount();
ok(r2 >= r1, "route: table keeps growing/refreshing (" + r1 + " -> " + r2 + ")");
await shot("live-route-mid");
await page.waitForTimeout(3600);
ok((await status()).includes("Finished"), "route: finishes: " + await status());
const rows = await page.locator(card + " table.hops tbody tr").allInnerTexts();
ok(rows.length === 8, "route: 8 real hops, ghost repeats of the destination hidden (" + rows.length + ")");
ok(rows[4].includes("???"), "route: silent hop shows ???: " + rows[4].replace(/\s+/g, " "));
ok(rows[4].includes("100%"), "route: silent hop shows 100% loss: " + rows[4].replace(/\s+/g, " "));
ok(await page.locator(card + " table.hops tr.dest").count() === 1, "route: destination row marked");
ok((await status()).includes("ms to 1.1.1.1"), "route: end-to-end summary: " + await status());
await shot("live-route-done");
// copy gives a text table
await page.locator(card + " .res-copy").tap(); await page.waitForTimeout(300);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => "ERR"));
ok(clip === "ERR" || (clip.includes("Host") && clip.includes("192.168.88.1")), "route: copy gives a text table: " + clip.slice(0, 30).replace(/\n/g, "|"));

// ---- Path to Internet quick test uses the same live table
await page.locator("#btn-mtr").tap(); await page.waitForTimeout(900);
ok((await page.locator(card + " .res-title").textContent()) === "Path to Internet", "path: title");
ok((await rowsCount()) >= 2, "path: live rows");
await page.locator("#hdr-actions button").tap(); await page.waitForTimeout(500);   // header Stop
ok((await status()).includes("Stopped"), "path: header Stop works: " + await status());
ok((await rowsCount()) >= 2, "path: table stays after Stop");

// ---- PORTS: chips pop in live with a progress bar
await page.locator("#tool-seg button[data-tool=ports]").tap();
ok((await page.locator("#tool-hint").textContent()).includes("Live port scan"), "ports: hint");
await page.locator("#tool-start").tap(); await page.waitForTimeout(1300);
ok((await status()).includes("LIVE") && (await status()).includes("%"), "ports: live banner with %: " + await status());
ok(await page.locator(card + " .pbar").count() === 1, "ports: progress bar");
ok((await chips()) >= 1, "ports: first open port already shown (" + await chips() + ")");
await shot("live-ports-mid");
await page.waitForTimeout(2600);
ok((await status()).includes("3 open ports found"), "ports: final summary: " + await status());
ok(await page.locator(card + " .pbar").count() === 0, "ports: progress bar gone when done");
const chipTxt = (await page.locator(card + " .chip").allInnerTexts()).join("|").replace(/\s+/g, " ");
ok(chipTxt.includes("22") && chipTxt.includes("ssh") && chipTxt.includes("443") && chipTxt.includes("https"), "ports: chips carry service names: " + chipTxt);
const rep = await page.locator(card + " .res-out").textContent();
ok(rep.includes("Nmap scan report") && rep.includes("PORT") && !rep.includes("Initiating"), "ports: tidy nmap report shown");
await shot("live-ports-done");

// ---- fallbacks when the Pi app is old (no stream endpoints)
await page.route("**/api/trace/stream", r => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
await page.route("**/api/portscan/stream", r => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
await page.locator("#tool-seg button[data-tool=trace]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(900);
ok(calls.includes("POST /api/mtr"), "fallback: route uses old /api/mtr");
await page.locator("#tool-seg button[data-tool=ports]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(900);
ok(calls.includes("POST /api/portscan"), "fallback: ports uses old /api/portscan");
await page.unroute("**/api/trace/stream"); await page.unroute("**/api/portscan/stream");

// ---- console mode: text versions stream into the dock
await page.locator('#tabs button[data-page=settings]').tap(); await page.selectOption("#set-output", "dock");
await page.locator('#tabs button[data-page=tools]').tap(); await page.waitForTimeout(300);
await page.locator("#tool-seg button[data-tool=trace]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(1200);
ok((await page.locator("#out").textContent()).includes("192.168.88.1"), "dock: route table text in console");
await page.locator("#tool-start").tap(); await page.waitForTimeout(300);
await page.locator("#tool-seg button[data-tool=ports]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(1300);
ok((await page.locator("#out").textContent()).includes("Open so far") || (await page.locator("#status-line").textContent()).includes("open"), "dock: ports progress in console");
await page.locator("#tool-start").tap();
ok(!errors.some(e => e.startsWith("CSP")), "no Content-Security-Policy violations: " + errors.filter(e => e.startsWith("CSP")).join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
