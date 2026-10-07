import { chromium } from "playwright-core";
const exe = process.env.CHROME_PATH || undefined;   // unset = the browser installed by `npx playwright-core install chromium`
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:8099" }).catch(() => {});
const page = await ctx.newPage(); const errors = []; page.on("console", m => { if (/Content Security Policy|Refused to (load|apply|execute|connect|frame)/.test(m.text())) errors.push("CSP: " + m.text()); });
page.on("pageerror", e => errors.push("pageerror: " + e.message));
const calls = []; page.on("request", r => { if (r.url().includes("/api/")) calls.push(r.method() + " " + new URL(r.url()).pathname); });
const shot = (n) => page.screenshot({ path: `${process.env.SHOTS_DIR || "./shots"}/${n}.png` });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const tab = async (pg) => { await page.locator(`#tabs button[data-page=${pg}]`).tap(); await page.waitForTimeout(450); };
const inView = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight - 100; }, sel);

await page.goto("http://127.0.0.1:8099/index.html"); await page.waitForTimeout(800);
ok(await page.locator("#console-dock").isHidden(), "bottom console hidden in inline mode");

// Info: a quick action puts its result card right after the Quick Actions section, scrolled into view
await page.locator("#btn-pinggw").tap(); await page.waitForTimeout(1500);
ok(await page.locator("#res-home:not(.hidden)").count() === 1, "info: result card shown");
ok(await page.evaluate(() => document.querySelector("#res-home").previousElementSibling.querySelector("#btn-pinggw") !== null), "info: card sits under Quick Actions section");
ok((await page.locator("#res-home .res-title").textContent()) === "Ping Gateway", "info: card titled by tool: " + await page.locator("#res-home .res-title").textContent());
ok((await page.locator("#res-home .res-out").textContent()).includes(" ttl "), "info: live result text present");
ok(await inView("#res-home"), "info: card scrolled into view");
await page.locator("#hdr-actions button").nth(0).tap().catch(() => {});
await shot("inline-info");
await page.evaluate(() => stopLive()); await page.waitForTimeout(400);   // end the gateway ping (its last repaint lands after the abort)
await page.evaluate(() => { resPanel("home").querySelector(".res-out").textContent = ""; });   // clear the card for the later leak check

// Tools: Start with empty target; DNS result under the control section; Quick Test row puts card under Quick Tests
await tab("tools");
await page.locator("#tool-seg button[data-tool=dns]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(500);
ok((await page.locator("#res-tools .res-out").textContent()).includes("Enter a host"), "tools: empty-target message in card");
ok(await page.evaluate(() => document.querySelector("#res-tools").previousElementSibling.querySelector("#tool-start") !== null), "tools: card directly under the tool box");
await page.fill("#target", "google.com"); await page.locator("#tool-start").tap(); await page.waitForTimeout(700);
ok((await page.locator("#res-tools .res-title").textContent()) === "DNS Lookup google.com", "tools: title " + await page.locator("#res-tools .res-title").textContent());
await page.locator("#btn-bw").tap(); await page.waitForTimeout(700);
ok(await page.evaluate(() => document.querySelector("#res-tools").previousElementSibling.querySelector("#btn-bw") !== null), "tools: card moves under Quick Tests when a quick test is tapped");
ok((await page.locator("#res-tools .res-title").textContent()) === "Bandwidth", "tools: title Bandwidth: " + await page.locator("#res-tools .res-title").textContent());
await shot("inline-tools");

// live ping monitor: updates its own card; leaving the page doesn't leak output elsewhere; close doesn't get re-opened by live updates
await page.locator("#tool-seg button[data-tool=monitor]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(900);
ok((await page.locator("#res-tools .res-status").textContent()).includes("LIVE"), "monitor: live status in card");
ok((await page.locator("#res-tools .res-out").textContent()).includes(" ttl "), "monitor: live output in card");
await tab("home"); await page.waitForTimeout(1500);
ok(!(await page.locator("#res-home .res-out").textContent()).includes(" ttl "), "monitor output does not leak onto Info");
await tab("tools");
ok((await page.locator("#res-tools .res-out").textContent()).includes(" ttl "), "monitor card still there when returning");
await page.locator("#res-tools .res-close").tap(); await page.waitForTimeout(250);
ok(await page.locator("#res-tools.hidden").count() === 1, "close hides the card");
await page.waitForTimeout(6500);
ok(await page.locator("#res-tools.hidden").count() === 1, "live updates do not re-open a closed card");
await page.locator("#tool-start").tap(); await page.waitForTimeout(400);  // stop monitor
ok((await page.locator("#tool-start").textContent()) === "Start", "monitor stopped");

// copy button
await page.locator("#tool-seg button[data-tool=ping]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(600);
await page.locator("#res-tools .res-copy").tap(); await page.waitForTimeout(300);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => "ERR"));
ok(clip.includes(" ttl ") || clip === "ERR", "copy puts result text on clipboard (or clipboard unavailable in test): " + clip.slice(0, 40));

// LAN header Scan: card at top of page (no tapped section)
await tab("network"); await page.locator("#hdr-actions button").tap(); await page.waitForTimeout(700);
ok(await page.evaluate(() => document.querySelector("#page-network").firstElementChild.id === "res-network"), "lan: header action puts card at page top");

// Settings: switch to Bottom console
await tab("settings");
await page.selectOption("#set-output", "dock"); await page.waitForTimeout(300);
ok(await page.locator("#console-dock").isVisible(), "dock mode: console visible");
await tab("tools"); await page.fill("#target", "1.1.1.1"); await page.locator("#tool-seg button[data-tool=ping]").tap(); await page.locator("#tool-start").tap(); await page.waitForTimeout(700);
ok((await page.locator("#out").textContent()).includes(" ttl "), "dock mode: live ping output goes to console");
await shot("dock-mode");
await page.reload(); await page.waitForTimeout(900);
ok(await page.locator("#console-dock").isVisible(), "dock mode persists across reload");
await tab("settings"); await page.selectOption("#set-output", "inline"); await page.waitForTimeout(200);
ok(await page.locator("#console-dock").isHidden(), "back to inline mode");
ok(!errors.some(e => e.startsWith("CSP")), "no Content-Security-Policy violations: " + errors.filter(e => e.startsWith("CSP")).join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
