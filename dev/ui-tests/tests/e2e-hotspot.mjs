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

// a fake Pi: GET /api/hotspot answers `hs`, POST stores the mode (and records the bodies)
const base = { mode: "auto", service: true, ssid: "JarvisPi-Manage", active: false, clients: 0, online: true, fallback_in: null, error: "", note: "" };
const fakePi = async (page, hs) => {
  const posts = [], gets = [];
  await page.route("**/api/hotspot", (r) => {
    if (r.request().method() === "POST") {
      const b = r.request().postDataJSON(); posts.push(b);
      if (!["auto", "on", "off"].includes(b.mode)) return r.fulfill({ status: 400, contentType: "application/json", body: '{"error":"mode must be auto, on or off"}' });
      hs.mode = b.mode;
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, ...hs }) });
    }
    gets.push(Date.now());
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hs) });
  });
  return { posts, gets };
};
const ui = (page) => page.evaluate(() => {
  const bs = [...document.querySelectorAll("#hs-seg button")];
  const now = document.getElementById("hs-now"), d = now.querySelector(".dot");
  return { on: bs.filter(b => b.classList.contains("on")).map(b => b.dataset.m), aria: bs.map(b => b.getAttribute("aria-checked")).join(","),
    now: now.textContent, dot: d ? d.className : "", hint: document.getElementById("hs-hint").textContent,
    ssid: document.getElementById("hs-ssid").textContent, html: now.innerHTML, imgs: document.querySelectorAll("#hs-now img").length };
});
const settle = (page, ms = 400) => page.waitForTimeout(ms);

// ---- phone, 390x844 ----
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
const hs = { ...base };
const pi = await fakePi(page, hs);
await page.goto("http://127.0.0.1:8099/index.html#home"); await settle(page, 800);
ok(pi.gets.length === 0, "nothing asks for the hotspot outside Settings (" + pi.gets.length + ")");
await page.locator('#tabs button[data-page=settings]').tap(); await settle(page, 600);
let s = await ui(page);
const order = await page.$$eval("#page-settings .sect-h", hs => hs.map(h => h.firstChild.textContent.trim()));
ok(order[0] === "Site" && order[1] === "Setup Hotspot", "Setup Hotspot sits right under Site: " + order.join(" | "));
ok(s.on.join() === "auto" && s.aria === "false,true,false", "Auto is selected (and announced): " + s.on + " / " + s.aria);
ok(s.ssid === "JarvisPi-Manage", "header shows the hotspot name");
ok(/Off · the Pi has a network/.test(s.now), "auto + online: off, says why: " + s.now);
ok(/turns on by itself/.test(s.hint), "auto hint explains the fallback");
await page.screenshot({ path: `${SHOTS}/hotspot-auto.png` });

// polls every 3 s while Settings is open, and stops when you leave
const g0 = pi.gets.length; await settle(page, 3300);
ok(pi.gets.length > g0, "refreshes itself while Settings is open");
hs.online = false; hs.fallback_in = 83; await settle(page, 3200);
s = await ui(page);
ok(/no network: turns on in 1:23/.test(s.now) && /\bwarn\b/.test(s.dot), "auto + offline: countdown to the fallback, amber: " + s.now);
hs.online = true; hs.fallback_in = null;

// tap On: POST {mode:on}, "Turning on…" until the service reports it, then "On · 1 phone connected"
await page.locator('#hs-seg button[data-m="on"]').tap(); await settle(page, 300);
s = await ui(page);
ok(pi.posts.length === 1 && pi.posts[0].mode === "on", "tap On sends {mode: on}: " + JSON.stringify(pi.posts));
ok(s.on.join() === "on" && /Turning on…/.test(s.now), "On selected, waiting for the service: " + s.now);
ok(/Always on/.test(s.hint) && /JarvisPi-Manage/.test(s.hint), "on hint names the hotspot: " + s.hint);
hs.active = true; hs.clients = 1; await settle(page, 3200);
s = await ui(page);
ok(/On · 1 phone connected/.test(s.now) && /\bok\b/.test(s.dot), "service reports it: On · 1 phone, green: " + s.now);
await page.screenshot({ path: `${SHOTS}/hotspot-on.png` });

// tap Off while it's on: "Turning off…" then "Off"
await page.locator('#hs-seg button[data-m="off"]').tap(); await settle(page, 300);
s = await ui(page);
ok(pi.posts.at(-1).mode === "off" && /Turning off…/.test(s.now), "tap Off: Turning off… while still up: " + s.now);
ok(/Never on/.test(s.hint), "off hint says there is no fallback");
hs.active = false; hs.clients = 0; await settle(page, 3200);
s = await ui(page);
ok(s.now.startsWith("Off") && !/network/.test(s.now), "then plain Off: " + s.now);

// service problems
hs.service = false; await settle(page, 3200);
s = await ui(page);
ok(/service not running/.test(s.now) && /\bwarn\b/.test(s.dot), "service down is shown: " + s.now);
hs.service = true; hs.error = "could not turn the hotspot on: <img src=x onerror=alert(1)>"; await settle(page, 3200);
s = await ui(page);
ok(/could not turn the hotspot on/.test(s.now) && /\bbad\b/.test(s.dot) && s.imgs === 0 && /&lt;img/.test(s.html), "service error shown in red, escaped: " + s.html);
hs.error = "";

// leaving Settings stops the polling
await page.locator('#tabs button[data-page=home]').tap(); await settle(page, 300);
const g1 = pi.gets.length; await settle(page, 4000);
ok(pi.gets.length === g1, "no more polling after leaving Settings (" + (pi.gets.length - g1) + " extra)");
await ctx.close();

// ---- the real mock server end to end (no route): the choice sticks across a reload ----
const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const p2 = await c2.newPage(); watch(p2);
await p2.goto("http://127.0.0.1:8099/index.html#settings"); await settle(p2, 900);
await p2.locator('#hs-seg button[data-m="off"]').tap(); await settle(p2, 500);
await p2.reload(); await settle(p2, 900);
ok((await ui(p2)).on.join() === "off", "mock server: Off is still selected after a reload");
await p2.locator('#hs-seg button[data-m="auto"]').tap(); await settle(p2, 500);   // leave the mock as we found it
ok((await ui(p2)).on.join() === "auto", "and back to Auto");
await c2.close();

// ---- the Pi's 4.3" touch screen, 800x480 ----
const kctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const kpage = await kctx.newPage(); watch(kpage);
await fakePi(kpage, { ...base });
await kpage.goto("http://127.0.0.1:8099/?kiosk=1#settings"); await settle(kpage, 900);
await kpage.locator("#hs-seg").scrollIntoViewIfNeeded();
const k = await kpage.evaluate(() => {
  const bs = [...document.querySelectorAll("#hs-seg button")].map(b => b.getBoundingClientRect());
  const row = document.getElementById("hs-now");
  return { minH: Math.min(...bs.map(r => r.height)), minW: Math.min(...bs.map(r => r.width)), right: Math.max(...bs.map(r => r.right)),
    rowFits: row.scrollWidth <= row.clientWidth + 1 };
});
ok(k.minH >= 38 && k.minW >= 200 && k.right <= 800 && k.rowFits, "touch screen: big Off/Auto/On targets, status fits: " + JSON.stringify(k));
await kpage.screenshot({ path: `${SHOTS}/hotspot-kiosk.png` });
await kctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
