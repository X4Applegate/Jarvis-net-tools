import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage(); const errs = [];
p.on("pageerror", e => errs.push("pageerror " + e.message)); p.on("response", r => { if (r.status() >= 400 && !r.url().includes("favicon")) errs.push(r.status() + " " + r.url()); });
await p.goto(process.argv[2]); await p.waitForTimeout(1500);
console.log("login visible:", await p.locator("#login").isVisible(), "| tabs in DOM:", await p.locator("#tabs button").count(), "| css loaded:", (await p.evaluate(() => getComputedStyle(document.body).backgroundColor)));
await p.screenshot({ path: (process.env.SHOTS_DIR || "./shots") + "/live-login.png" });
console.log("errors:", JSON.stringify(errs)); await b.close();
