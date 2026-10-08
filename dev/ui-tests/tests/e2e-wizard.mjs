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
const today = new Date().toISOString().slice(0, 10);

// a fake Pi whose visit is NOT done today: the wizard must appear; records what is sent
const fakePi = async (page, opts = {}) => {
  const st = { visit: { date: "2001-01-01", company: "Demo Coffee", location: "Main St" }, ssid: opts.ssid ?? "",
    companies: [{ name: "Demo Coffee", locations: ["Main St", "Airport"] }, { name: "Example Tea", locations: ["Harbor"] }], posts: [], joins: [] };
  const reply = () => ({ ok: true, needed: st.visit.date !== today, visit: st.visit, companies: st.companies, ssid: st.ssid, site_name: "" });
  await page.route("**/api/visit", (r) => {
    if (r.request().method() === "POST") {
      const b = r.request().postDataJSON(); st.posts.push(b);
      if (b.skip) st.visit = { date: today, company: "", location: "", skipped: true };
      else {
        st.visit = { date: today, company: b.company, location: b.location };
        st.companies = [{ name: b.company, locations: b.location ? [b.location] : [] }, ...st.companies.filter(c => c.name !== b.company)];
      }
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reply()) });
  });
  await page.route("**/api/wifi/join", (r) => {
    const b = r.request().postDataJSON(); st.joins.push(b);
    const good = b.ssid !== "Store Guest" || b.password === "right-password";
    if (good) st.ssid = b.ssid;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(good ? { ok: true, output: "connected" } : { ok: false, output: "Secrets were required, but not provided\nmore" }) });
  });
  return st;
};
const vis = (page, id) => page.locator("#" + id).isVisible();
const title = (page) => page.locator("#wz-title").textContent();

// ---- phone: full walk-through with a saved company, a new location, a password network ----
let ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
let page = await ctx.newPage(); watch(page);
let st = await fakePi(page);
await page.goto("http://127.0.0.1:8099/index.html"); await settle(page, 1000);
ok(await vis(page, "wizard") && !(await vis(page, "app")), "first start of the day: the wizard covers the app");
ok((await page.locator("#wz-step").textContent()) === "Step 1 of 3" && /Who is this visit for/.test(await title(page)), "step 1 asks for the company");
const chips = await page.$$eval("#wz-companies button", bs => bs.map(b => [b.textContent, b.classList.contains("on")]));
ok(chips.length === 2 && chips[0][0] === "Demo Coffee" && chips[0][1], "saved companies as buttons, yesterday's preselected: " + JSON.stringify(chips));
await page.screenshot({ path: `${SHOTS}/wizard-1-company.png` });
await page.locator("#wz-companies button", { hasText: "Example Tea" }).tap(); await settle(page, 300);
ok(/Example Tea: which location/.test(await title(page)) && (await page.locator("#wz-step").textContent()) === "Step 2 of 3", "tap a company -> step 2 for that company");
ok((await page.$$eval("#wz-locations button", bs => bs.map(b => b.textContent))).join() === "Harbor", "its saved locations are offered");
await page.locator("#wz-back2").tap(); await settle(page, 200);
ok(/Who is this visit for/.test(await title(page)), "Back returns to the company step");
await page.locator("#wz-company").fill("New Roasters"); await page.locator("#wz-next1").tap(); await settle(page, 300);
ok(/New Roasters: which location/.test(await title(page)) && (await page.locator("#wz-locations button").count()) === 0, "a typed new company works, no locations yet");
await page.locator("#wz-location").fill("Pike Place"); await page.locator("#wz-next2").tap(); await settle(page, 800);
ok(st.posts.length === 1 && st.posts[0].company === "New Roasters" && st.posts[0].location === "Pike Place", "the visit is saved after step 2: " + JSON.stringify(st.posts));
ok((await page.locator("#wz-step").textContent()) === "Step 3 of 3" && /Not connected/.test(await page.locator("#wz-now").textContent()), "step 3 shows Wi-Fi status");
const nets = await page.$$eval("#wz-nets .net .n", ns => ns.map(n => n.textContent));
ok(nets.length === 3 && nets[0] === "Example WiFi", "scanned networks listed, strongest first: " + nets.join(","));
ok(/saved/.test(await page.locator("#wz-nets .net").first().textContent()), "the saved network is marked");
await page.screenshot({ path: `${SHOTS}/wizard-3-wifi.png` });
await page.locator("#wz-nets .net", { hasText: "Store Guest" }).tap(); await settle(page, 300);
ok(await vis(page, "wz-join") && (await page.locator("#wz-join-ssid").textContent()) === "Store Guest", "a locked, unsaved network asks for the password");
await page.locator("#wz-pass").fill("wrong"); await page.locator("#wz-connect").tap(); await settle(page, 600);
ok(/❌ Secrets were required/.test(await page.locator("#wz-msg").textContent()) && !/more/.test(await page.locator("#wz-msg").textContent()) && await vis(page, "wz-join"), "a wrong password: one-line error, asks again");
await page.locator("#wz-pass").fill("right-password"); await page.locator("#wz-connect").tap(); await settle(page, 800);
ok(/✅ Connected to Store Guest/.test(await page.locator("#wz-msg").textContent()) && /Connected to Store Guest/.test(await page.locator("#wz-now").textContent()), "right password: connected");
ok((await page.locator("#wz-done").textContent()) === "Continue", "Continue once connected");
await page.locator("#wz-done").tap(); await settle(page, 700);
ok(!(await vis(page, "wizard")) && await vis(page, "page-home"), "Continue -> main page (Info)");
await page.reload(); await settle(page, 1000);
ok(!(await vis(page, "wizard")), "same day again (e.g. after moving rooms): no wizard");
await page.locator('#tabs button[data-page=settings]').tap(); await settle(page, 400);
await page.locator("#set-new-visit").tap(); await settle(page, 600);
const c2 = await page.$$eval("#wz-companies button", bs => bs.map(b => [b.textContent, b.classList.contains("on")]));
ok(await vis(page, "wizard") && c2[0][0] === "New Roasters" && c2[0][1], "Settings > Start New Visit reopens it, the new company remembered first: " + JSON.stringify(c2));
await page.locator("#wz-companies button", { hasText: "New Roasters" }).tap(); await settle(page, 300);
await page.locator("#wz-locations button", { hasText: "Pike Place" }).tap(); await settle(page, 800);
ok(st.posts.at(-1).location === "Pike Place" && (await page.locator("#wz-step").textContent()) === "Step 3 of 3", "tap a saved location -> straight to Wi-Fi");
await page.locator("#wz-nets .net", { hasText: "Example WiFi" }).tap(); await settle(page, 800);
ok(st.joins.at(-1).ssid === "Example WiFi" && st.joins.at(-1).password === "" && !(await vis(page, "wz-join")), "a saved network connects without asking for a password");
await ctx.close();

// ---- Skip on step 1: nothing named, marked done for today ----
ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
page = await ctx.newPage(); watch(page);
st = await fakePi(page, { ssid: "Example WiFi" });
await page.goto("http://127.0.0.1:8099/index.html"); await settle(page, 1000);
await page.locator("#wz-skip").tap(); await settle(page, 600);
ok(st.posts.length === 1 && st.posts[0].skip === true && !(await vis(page, "wizard")), "Skip: marks today done, goes to the app");
await page.reload(); await settle(page, 1000);
ok(!(await vis(page, "wizard")), "after Skip it doesn't come back the same day");
await ctx.close();

// ---- the 4.3" touch screen, 800x480, and with the on-screen keyboard up (800x283) ----
ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
page = await ctx.newPage(); watch(page);
st = await fakePi(page, { ssid: "Example WiFi" });
await page.goto("http://127.0.0.1:8099/?kiosk=1"); await settle(page, 1000);
let k = await page.evaluate(() => {
  const r = (id) => document.getElementById(id).getBoundingClientRect();
  return { next: r("wz-next1").bottom, h: innerHeight, chipH: Math.min(...[...document.querySelectorAll("#wz-companies button")].map(b => b.getBoundingClientRect().height)) };
});
ok(k.next <= k.h && k.chipH >= 44, "touch screen: company buttons + Next fit on one screen, big targets: " + JSON.stringify(k));
await page.screenshot({ path: `${SHOTS}/wizard-kiosk-1.png` });
await page.setViewportSize({ width: 800, height: 283 });          // squeekboard up
await page.locator("#wz-company").tap(); await page.locator("#wz-company").fill("Keyboard Test"); await settle(page, 200);
const inView = await page.evaluate(() => { const r = document.getElementById("wz-company").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
ok(inView, "with the keyboard up the input stays visible");
await page.keyboard.press("Enter"); await settle(page, 300);
ok(/Keyboard Test: which location/.test(await title(page)), "Enter on the keyboard moves on");
await page.setViewportSize({ width: 800, height: 480 });
await page.locator("#wz-next2").tap(); await settle(page, 900);
ok(/Connected to Example WiFi/.test(await page.locator("#wz-now").textContent()) && /connected/.test(await page.locator("#wz-nets .net").first().textContent()), "already-connected network shown as such");
await page.screenshot({ path: `${SHOTS}/wizard-kiosk-3.png` });
await page.locator("#wz-done").tap(); await settle(page, 700);
ok(await vis(page, "page-home"), "touch screen: Continue -> Info");
await ctx.close();

// ---- the shared mock: visit already done today -> no wizard (so the other suites are unaffected) ----
ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
page = await ctx.newPage(); watch(page);
await page.goto("http://127.0.0.1:8099/index.html"); await settle(page, 1000);
ok(!(await vis(page, "wizard")) && await vis(page, "app"), "visit already done today: straight to the app");
await ctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
