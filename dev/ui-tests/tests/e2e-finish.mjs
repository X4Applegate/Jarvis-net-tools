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
const vis = (page, id) => page.locator("#" + id).isVisible();
const reps = (page) => page.$$eval("#rep-list .item .n", ns => ns.map(n => n.textContent));
// uses the shared mock's state (visit, reports); puts a visit back at the end so later suites see a normal day

// ---- the Pi's touch screen, 800x480 ----
const ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
const sent = []; page.on("request", r => { if (/\/api\/(visit\/finish|reports\/delete|shutdown)/.test(r.url())) sent.push(r.method() + " " + new URL(r.url()).pathname); });
await page.route("**/api/shutdown", r => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"action":"shutdown","power_button":true}' }));
await page.goto("http://127.0.0.1:8099/?kiosk=1#settings"); await settle(page, 1000);
ok(!(await vis(page, "wizard")), "a normal day: no wizard");
let r0 = await reps(page);
ok(r0.length === 1 && r0[0] === "Example Tea Harbor", "Saved Reports lists the earlier report: " + r0.join(","));
const order = await page.$$eval("#page-settings .sect:first-child button", bs => bs.map(b => b.textContent));
ok(order.indexOf("Finish Visit") >= 0 && order.indexOf("Finish Visit") < order.indexOf("Start New Visit"), "Finish Visit sits above Start New Visit: " + order.join(" | "));

// Cancel in the confirm: nothing happens
page.once("dialog", d => d.dismiss());
await page.locator("#set-finish-visit").tap(); await settle(page, 400);
ok(sent.length === 0 && !(await page.locator("#finish-dlg").evaluate(d => d.open)), "Cancel: nothing sent, no dialog");

// OK: progress -> finished screen
let asked = "";
page.once("dialog", d => { asked = d.message(); d.accept(); });
await page.locator("#set-finish-visit").tap(); await settle(page, 900);
ok(/report is saved on the Pi, then the history is cleared/.test(asked) && /setup wizard/.test(asked), "the confirm says what happens: " + JSON.stringify(asked));
ok(sent.includes("POST /api/visit/finish"), "POST /api/visit/finish sent");
ok(/✅ Visit finished/.test(await page.locator("#finish-title").textContent()) && /Report saved: Demo Coffee - Main St/.test(await page.locator("#finish-msg").textContent()), "finished screen names the saved report");
const b = await page.$$eval("#finish-btns button", bs => bs.filter(x => x.offsetParent).map(x => [x.textContent, Math.round(x.getBoundingClientRect().height)]));
ok(b.map(x => x[0]).join() === "Shut Down,View Report,Next Visit" && b.every(x => x[1] >= 48), "buttons: Shut Down / View Report / Next Visit, big: " + JSON.stringify(b));
await page.screenshot({ path: `${SHOTS}/finish-done.png` });
ok((await reps(page))[0] === "Demo Coffee Main St", "the new report tops the Saved Reports list");

// View Report: in-app viewer, its styles stay inside, Close returns
await page.locator("#finish-view").tap(); await settle(page, 600);
const v = await page.evaluate(() => {
  const root = document.getElementById("report-body").shadowRoot, h1 = root && root.querySelector("h1");
  return { open: document.getElementById("report-dlg").open, h1: h1 && h1.textContent, red: h1 && getComputedStyle(h1).color,
    appH1: getComputedStyle(document.getElementById("hdr-title")).color, scrolls: document.getElementById("report-body").scrollHeight > innerHeight };
});
ok(v.open && v.h1 === "Site report" && v.red === "rgb(200, 0, 0)" && v.appH1 !== "rgb(200, 0, 0)", "report opens inside the app, its styles don't leak: " + JSON.stringify(v));
ok(v.scrolls, "a long report scrolls inside the viewer");
await page.screenshot({ path: `${SHOTS}/finish-report.png` });
ok(await vis(page, "report-close"), "Close is visible on the touch screen");
await page.locator("#report-close").tap(); await settle(page, 300);
ok(!(await page.locator("#report-dlg").evaluate(d => d.open)), "Close returns to the app");

// next start (reload stands in for power off/on): the setup wizard
await page.reload(); await settle(page, 1200);
ok(await vis(page, "wizard"), "after Finish Visit the next start shows the setup wizard");
await page.locator("#wz-skip").tap(); await settle(page, 600);       // (marks the day done again)

// History since now says visit finished; Saved Reports: open from the list, delete with confirm
await page.locator('#tabs button[data-page=settings]').tap(); await settle(page, 700);
await page.locator("#rep-list .item").first().locator("button", { hasText: "Open" }).tap(); await settle(page, 600);
ok(await page.locator("#report-dlg").evaluate(d => d.open), "Open from Saved Reports uses the same viewer");
await page.locator("#report-close").tap(); await settle(page, 300);
page.once("dialog", d => d.dismiss());
await page.locator("#rep-list .item").nth(1).locator("button", { hasText: "Delete" }).tap(); await settle(page, 400);
ok((await reps(page)).length === 2 && !sent.includes("POST /api/reports/delete"), "Delete asks first; Cancel keeps it");
page.once("dialog", d => d.accept());
await page.locator("#rep-list .item").nth(1).locator("button", { hasText: "Delete" }).tap(); await settle(page, 600);
ok((await reps(page)).join() === "Demo Coffee Main St" && sent.includes("POST /api/reports/delete"), "Delete removes it: " + (await reps(page)).join());

// Shut Down from the finished screen goes through the normal safe shutdown
page.once("dialog", d => d.accept());
await page.locator("#set-finish-visit").tap(); await settle(page, 900);
await page.locator("#finish-off").tap(); await settle(page, 600);
ok(sent.includes("POST /api/shutdown") && /Shutting down/.test(await page.locator("#power-title").textContent()), "Shut Down = the safe shutdown countdown");
await ctx.close();

// leave the shared mock with a normal (started, not finished) visit for any later suite
await fetch("http://127.0.0.1:8099/api/visit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company: "Demo Coffee", location: "Main St" }) });

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
