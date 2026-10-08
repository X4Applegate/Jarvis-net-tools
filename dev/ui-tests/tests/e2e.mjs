import { chromium } from "playwright-core";
const exe = process.env.CHROME_PATH || undefined;   // unset = the browser installed by `npx playwright-core install chromium`
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = []; page.on("console", m => { if (/Content Security Policy|Refused to (load|apply|execute|connect|frame)/.test(m.text())) errors.push("CSP: " + m.text()); }); page.on("response", r => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); }); page.on("pageerror", e => errors.push("pageerror: " + e.message)); page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
const calls = []; page.on("request", r => { if (r.url().includes("/api/")) calls.push(r.method() + " " + new URL(r.url()).pathname); });
const shot = (n) => page.screenshot({ path: `${process.env.SHOTS_DIR || "./shots"}/${n}.png` });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

await page.goto("http://127.0.0.1:8099/index.html"); await page.waitForTimeout(800);
ok(await page.locator("#page-home").isVisible(), "home visible on boot");
ok((await page.locator("#hdr-title").textContent()) === "Info", "title Info");
ok((await page.locator("#hdr-actions button").count()) === 3, "info has 3 header actions (refresh, power, lock)");

// nav through all 6 tabs, check title + page visibility + active pill
for (const [pg, title] of [["wifi","Signal"],["network","LAN"],["tools","Tools"],["monitor","Speed"],["settings","Settings"],["home","Info"]]) {
  await page.locator(`#tabs button[data-page=${pg}]`).tap(); await page.waitForTimeout(500);
  ok(await page.locator(`#page-${pg}`).isVisible(), pg + " visible");
  ok((await page.locator("#hdr-title").textContent()) === title, "title " + title);
  ok(await page.locator(`#tabs button[data-page=${pg}].active`).count() === 1, pg + " tab active");
  ok((await page.locator(".page:not(.hidden)").count()) === 1, "exactly one page shown");
}

// signal graph: band segments redraw, scan header action works
await page.locator('#tabs button[data-page=wifi]').tap(); await page.waitForTimeout(1200);
ok((await page.locator("#sig-note").textContent()).includes("networks on 2.4"), "2.4 note: " + await page.locator("#sig-note").textContent());
await page.locator('#sig-seg button[data-b="5"]').tap(); await page.waitForTimeout(300);
ok((await page.locator("#sig-note").textContent()).includes("5 GHz"), "5 GHz note"); await shot("sig5");
await page.locator('#sig-seg button[data-b="6"]').tap(); await page.waitForTimeout(300); await shot("sig6");
ok((await page.locator("#sig-seg button.on").textContent()) === "6 GHz", "6 seg on");
// auto scan must not have popped the console open
ok(await page.locator("#res-wifi:not(.hidden)").count() === 0, "auto-scan does not open a result card");
await page.locator("#hdr-actions button").tap(); await page.waitForTimeout(1200);
ok(await page.locator("#res-wifi:not(.hidden)").count() === 1, "manual Scan opens an on-page result card");
ok((await page.locator("#res-wifi .res-out").textContent()).includes("Survey"), "survey text in card");

// tools: select tool, empty target warning, run ping + dns + monitor start/stop
await page.locator('#tabs button[data-page=tools]').tap(); await page.waitForTimeout(400);
await page.locator('#tool-seg button[data-tool="dns"]').tap();
ok((await page.locator("#tool-hint").textContent()).includes("Look the name up"), "dns hint");
await page.locator("#tool-start").tap(); await page.waitForTimeout(300);
ok((await page.locator("#res-tools .res-out").textContent()).includes("Enter a host"), "empty-target warning in card");
await page.fill("#target", "google.com");
await page.locator("#tool-start").tap(); await page.waitForTimeout(800);
ok(calls.includes("POST /api/dns"), "dns call made: " + calls.slice(-4));
await page.locator('#tool-seg button[data-tool="ping"]').tap(); await page.locator("#hdr-actions button").tap(); await page.waitForTimeout(600);
ok(calls.includes("POST /api/ping/stream"), "ping via header Start streams");
await page.waitForTimeout(3000);   // let the 10-probe ping finish (while it runs, Start means Stop)
await page.locator('#tool-seg button[data-tool="monitor"]').tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(700);
ok((await page.locator("#tool-start").textContent()) === "Stop", "Start->Stop while monitoring");
ok((await page.locator("#hdr-actions button").textContent()) === "Stop", "header Stop while monitoring");
await shot("tools-running");
await page.locator("#hdr-actions button").tap(); await page.waitForTimeout(300);
ok((await page.locator("#tool-start").textContent()) === "Start", "Stop->Start after stopping");
await page.locator('#tool-seg button[data-tool="iperf"]').tap();
ok(await page.locator("#iperf-info").isVisible(), "iperf info visible for iPerf");

// speed: 7-day segment toggles
await page.locator('#tabs button[data-page=monitor]').tap(); await page.waitForTimeout(600);
await page.locator("#nm-7d").tap(); await page.waitForTimeout(400);
ok(await page.locator("#nm-7d.on").count() === 1 && await page.locator("#nm-24.on").count() === 0, "7d segment on");
await page.locator("#hdr-actions button").tap(); await page.waitForTimeout(500);
ok(calls.includes("POST /api/speedtest/stream"), "Test header runs the live speedtest");

// LAN scan + settings forms render
await page.locator('#tabs button[data-page=network]').tap(); await page.locator("#hdr-actions button").tap(); await page.waitForTimeout(600);
ok((await page.locator("#dev-list .item").count()) === 2, "device list rendered");
await page.locator('#tabs button[data-page=settings]').tap(); await page.waitForTimeout(500);
ok((await page.locator("#set-devices .item").count()) === 2, "saved devices in settings");
// lock button on Info
await page.locator('#tabs button[data-page=home]').tap(); await page.waitForTimeout(300);
await page.locator('#hdr-actions button[aria-label="Lock"]').tap(); await page.waitForTimeout(400);
ok(await page.locator("#login").isVisible(), "Lock shows login");
await shot("login");
ok(!errors.some(e => e.startsWith("CSP")), "no Content-Security-Policy violations: " + errors.filter(e => e.startsWith("CSP")).join(" | "));
console.log(JSON.stringify({ pass, fail, errors: [...new Set(errors)] }, null, 1));
await browser.close();
