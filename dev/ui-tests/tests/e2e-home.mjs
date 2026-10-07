import { chromium } from "playwright-core";
const exe = process.env.CHROME_PATH || undefined;   // unset = the browser installed by `npx playwright-core install chromium`
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await ctx.newPage(); const errors = []; page.on("console", m => { if (/Content Security Policy|Refused to (load|apply|execute|connect|frame)/.test(m.text())) errors.push("CSP: " + m.text()); });
page.on("pageerror", e => errors.push("pageerror: " + e.message));
const shot = (n) => page.screenshot({ path: `${process.env.SHOTS_DIR || "./shots"}/${n}.png` });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const px = () => page.evaluate(() => { const c = document.getElementById("home-gauge"), x = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let or = 0, h = 0; for (let i = 0; i < x.length; i += 4) { h = (h * 31 + x[i] + x[i + 1] * 3 + x[i + 2] * 7) >>> 0; if (x[i] > 220 && x[i + 1] > 90 && x[i + 1] < 140 && x[i + 2] < 60) or++; } return { or, h, w: c.width, hgt: c.height, f: HG.dispF, v: HG.value }; });

await page.goto("http://127.0.0.1:8099/index.html#home"); await page.waitForTimeout(250);
const early = await px();                         // mid-sweep: needle still on its way
await page.waitForTimeout(1800);
const late = await px();
ok(late.w > 200 && late.hgt > 150, "mini gauge sized: " + late.w + "x" + late.hgt);
ok(late.v > 0 && late.f > 0.5, "needle swept to the last download speed (frac " + late.f.toFixed(2) + " for " + late.v + " Mbps)");
ok(late.or > 400, "orange arc drawn (" + late.or + " px)");
ok(early.f < late.f - 0.05 || early.h !== late.h, "the needle sweeps (animated), not a jump: " + early.f.toFixed(2) + " -> " + late.f.toFixed(2));
const down = await page.locator("#hs-down").textContent(), up = await page.locator("#hs-up").textContent(), ping = await page.locator("#hs-ping").textContent();
ok(/^\d+$/.test(down) && /^\d+$/.test(up) && /^\d+$/.test(ping), "numbers filled: ↓" + down + " ↑" + up + " ping " + ping);
ok(await page.locator("#hs-grade:not(.hidden)").count() === 1, "grade chip shown: " + await page.locator("#hs-grade").textContent());
ok(/ago|just now/.test(await page.locator("#hs-when").textContent()), "when: " + await page.locator("#hs-when").textContent());
ok(await page.locator("#home-speed, #home-grade").count() === 0, "old duplicate rows removed from Health");
await shot("home-minigauge");

// leaving and coming back replays the sweep
await page.locator('#tabs button[data-page=tools]').tap(); await page.waitForTimeout(300);
await page.locator('#tabs button[data-page=home]').tap(); await page.waitForTimeout(150);
const re = await px(); ok(re.f < late.f - 0.05, "sweep replays when the Info tab is reopened (" + re.f.toFixed(2) + ")");
await page.waitForTimeout(1800);

// tapping the card opens the Speed tab
await page.locator("#home-speedcard").tap(); await page.waitForTimeout(500);
ok(await page.locator("#page-monitor:not(.hidden)").count() === 1, "tap opens the Speed tab");
ok((await page.locator("#btn-speed2").textContent()) === "Start Test", "…and does not start a test by itself");

// empty state: no stored tests yet
await page.route("**/api/netmon/speed*", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: [] }) }));
await page.locator('#tabs button[data-page=tools]').tap(); await page.locator('#tabs button[data-page=home]').tap(); await page.waitForTimeout(1500);
ok((await page.locator("#hs-when").textContent()) === "no test yet", "empty state text: " + await page.locator("#hs-when").textContent());
ok((await page.locator("#hs-down").textContent()) === "—", "empty state dashes");
ok(await page.locator("#hs-grade.hidden").count() === 1, "empty state hides grade");
const emp = await px(); ok(emp.or < 150 && emp.f < 0.02, "empty state: needle at rest, no coloured arc (" + emp.or + " px)");
await shot("home-minigauge-empty");
await page.unroute("**/api/netmon/speed*");
ok(!errors.some(e => e.startsWith("CSP")), "no Content-Security-Policy violations: " + errors.filter(e => e.startsWith("CSP")).join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
