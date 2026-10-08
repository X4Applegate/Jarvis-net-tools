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
const since = (page) => page.locator("#hist-since").textContent();
const outText = (page) => page.evaluate(() => [...document.querySelectorAll(".res-out, #out")].map(e => e.textContent).join("\n"));

// ---- phone, 390x844 ----
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
const posts = []; page.on("request", r => { if (r.url().includes("/api/history/clear")) posts.push(r.method()); });
await page.goto("http://127.0.0.1:8099/index.html#settings"); await settle(page, 900);
let s = await since(page);
ok(/·\s*new day$/.test(s) && /\d/.test(s), "History since shows when the new day started it: " + s);
const rows = await page.$$eval("#page-settings .sect", ss => { const m = ss.find(x => /Maintenance/.test(x.textContent)); return [...m.querySelectorAll(".rowbtn, .row .lbl")].map(e => e.textContent.trim()); });
ok(rows[0] === "History since" && rows.at(-1) === "Clear History Now", "Maintenance: History since first, Clear History Now last: " + rows.join(" | "));
ok(await page.locator("#btn-hist-clear").evaluate(b => b.classList.contains("danger-text")), "Clear History Now is shown as a danger action");
await page.locator("#btn-hist-clear").scrollIntoViewIfNeeded();
await page.screenshot({ path: `${SHOTS}/history-settings.png` });

// Cancel in the confirm: nothing is sent
let asked = "";
page.once("dialog", d => { asked = d.message(); d.dismiss(); });
await page.locator("#btn-hist-clear").tap(); await settle(page);
ok(/Clear all history now\?/.test(asked) && /Settings, saved devices and Wi-Fi networks stay/.test(asked), "asks first and says what stays: " + JSON.stringify(asked));
ok(posts.length === 0, "Cancel sends nothing (" + posts.length + ")");

// OK: POST, row updates, confirmation shown
page.once("dialog", d => d.accept());
await page.locator("#btn-hist-clear").tap(); await settle(page, 700);
s = await since(page);
ok(posts.length === 1 && posts[0] === "POST", "OK sends one POST /api/history/clear (" + posts.join(",") + ")");
ok(/·\s*cleared by hand$/.test(s), "History since now says cleared by hand: " + s);
ok(/History cleared/.test(await outText(page)), "a confirmation is shown");
await page.reload(); await settle(page, 900);
ok(/cleared by hand$/.test(await since(page)), "still shown after a reload (comes from the Pi)");
await ctx.close();

// ---- the Pi's 4.3" touch screen, 800x480 ----
const kctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const kpage = await kctx.newPage(); watch(kpage);
await kpage.goto("http://127.0.0.1:8099/?kiosk=1#settings"); await settle(kpage, 900);
await kpage.locator("#btn-hist-clear").scrollIntoViewIfNeeded();
const k = await kpage.evaluate(() => {
  const b = document.getElementById("btn-hist-clear").getBoundingClientRect(), v = document.getElementById("hist-since");
  return { h: b.height, w: b.width, fits: v.scrollWidth <= v.clientWidth + 1 };
});
ok(k.h >= 44 && k.w >= 700 && k.fits, "touch screen: full-width button, History since fits: " + JSON.stringify(k));
await kpage.screenshot({ path: `${SHOTS}/history-kiosk.png` });
await kctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
