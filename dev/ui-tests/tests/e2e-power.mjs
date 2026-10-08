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

const dlg = (page) => page.evaluate(() => {
  const d = document.getElementById("power-dlg"), btns = document.getElementById("power-btns");
  return { open: d.open, title: document.getElementById("power-title").textContent, msg: document.getElementById("power-msg").textContent,
    btns: !btns.classList.contains("hidden") && btns.getBoundingClientRect().height > 0, focus: document.activeElement && document.activeElement.id };
});
// record /api/shutdown calls and answer them like the Pi would (nothing really powers off: this is the mock)
const powerRoute = async (page, reply, status = 200) => {
  const bodies = [];
  await page.route("**/api/shutdown", (r) => { bodies.push(r.request().postDataJSON()); r.fulfill({ status, contentType: "application/json", body: JSON.stringify(reply) }); });
  return bodies;
};
const waitText = async (page, re, ms = 8000) => {      // Node-side polling: works with the page's fake clock too
  for (let t = 0; t < ms; t += 100) { const d = await dlg(page); if (re.test(d.title + "\n" + d.msg)) return d; await page.waitForTimeout(100); }
  return dlg(page);
};
const openPower = (page) => page.locator('#hdr-actions button[aria-label="Power"]').tap();

// ---- phone, 390x844 ----
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
let bodies = await powerRoute(page, { error: "should not be called" }, 500);
await page.goto("http://127.0.0.1:8099/index.html#home"); await page.waitForTimeout(900);
const labels = await page.$$eval("#hdr-actions button", bs => bs.map(b => b.getAttribute("aria-label")));
ok(labels.join(",") === "Refresh,Power,Lock", "Info header: power sits right after refresh: " + labels.join(","));
ok(await page.locator('#hdr-actions button[aria-label="Power"] use').getAttribute("href") === "#i-power", "power button shows the power icon");

await openPower(page); await page.waitForTimeout(200);
let d = await dlg(page);
ok(d.open && d.title === "Turn off the Pi?" && d.btns, "tap ⏻ opens the confirm dialog with its buttons: " + JSON.stringify(d));
ok(d.focus === "power-cancel", "Cancel has the focus, so Enter can't shut it down (" + d.focus + ")");
const fit = await page.evaluate(() => {
  const r = document.querySelector("#power-dlg").getBoundingClientRect();
  const bs = [...document.querySelectorAll("#power-btns button")];
  return { inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
    textFits: bs.every(b => b.scrollWidth <= b.clientWidth + 1), minH: Math.min(...bs.map(b => b.getBoundingClientRect().height)) };
});
ok(fit.inView && fit.textFits && fit.minH >= 48, "phone: dialog inside the screen, button labels fit, buttons >= 48 px: " + JSON.stringify(fit));
await page.screenshot({ path: `${SHOTS}/power-dialog.png` });
await page.locator("#power-cancel").tap(); await page.waitForTimeout(200);
ok(!(await dlg(page)).open, "Cancel closes it");

await openPower(page); await page.waitForTimeout(150); await page.keyboard.press("Escape"); await page.waitForTimeout(150);
ok(!(await dlg(page)).open, "Esc closes it");
await openPower(page); await page.waitForTimeout(150); await page.mouse.click(8, 8); await page.waitForTimeout(150);
ok(!(await dlg(page)).open, "tapping the dimmed backdrop closes it");
await openPower(page); await page.waitForTimeout(150); await page.locator("#power-title").click(); await page.waitForTimeout(150);
ok((await dlg(page)).open, "tapping inside the dialog keeps it open");
await page.locator("#power-cancel").tap(); await page.waitForTimeout(150);
ok(bodies.length === 0, "nothing was sent while only opening/closing (" + bodies.length + ")");

await page.locator('#tabs button[data-page=settings]').tap(); await page.waitForTimeout(400);
await page.locator("#btn-shutdown").tap(); await page.waitForTimeout(200);
d = await dlg(page);
ok(d.open && d.btns, "Settings > Shut Down Pi opens the same dialog (no browser confirm)");
await page.locator("#power-cancel").tap(); await page.waitForTimeout(150);
await page.locator('#tabs button[data-page=home]').tap(); await page.waitForTimeout(500);

// the Pi refuses (e.g. a bad action): say so and give the buttons back
await page.unroute("**/api/shutdown"); bodies = await powerRoute(page, { error: "action must be shutdown or restart" }, 400);
await openPower(page); await page.waitForTimeout(150); await page.locator("#power-off").tap();
d = await waitText(page, /Couldn't/);
ok(d.open && /Couldn't shut down/.test(d.title) && /action must be/.test(d.msg) && d.btns, "error: shown in the dialog, buttons back: " + JSON.stringify(d));
await page.locator("#power-cancel").tap(); await page.waitForTimeout(150);
ok(!(await dlg(page)).open, "after an error Cancel works again");

// restart: sends {action:"restart"}, survives Esc, waits for the Pi to go away and come back, then reloads
await page.unroute("**/api/shutdown"); bodies = await powerRoute(page, { ok: true, action: "restart", power_button: true });
let down = 0;
await page.evaluate(() => { window.__beforeReload = 1; });
await openPower(page); await page.waitForTimeout(150);
await page.route("**/api/me", (r) => { if (down < 2) { down++; return r.abort(); } return r.fulfill({ status: 200, contentType: "application/json", body: '{"auth": true}' }); });
await page.locator("#power-restart").tap();
d = await waitText(page, /Restarting/);
ok(bodies.length === 1 && bodies[0].action === "restart", "restart sends {action: restart}: " + JSON.stringify(bodies));
ok(d.open && /Restarting/.test(d.title) && !d.btns, "restart: progress shown, buttons hidden");
await page.keyboard.press("Escape"); await page.waitForTimeout(150);
ok((await dlg(page)).open, "Esc can't close it while restarting");
await page.screenshot({ path: `${SHOTS}/power-restarting.png` });
let reloaded = false;
for (let t = 0; t < 15000 && !reloaded; t += 250) { await page.waitForTimeout(250); reloaded = await page.evaluate(() => window.__beforeReload === undefined).catch(() => false); }
ok(reloaded && down === 2, "restart: page reloads once the Pi went down and answers again (down polls: " + down + ")");
await page.waitForTimeout(700);
ok(!(await dlg(page)).open && await page.locator("#page-home").isVisible(), "after the reload the app is back on Info, dialog closed");
await ctx.close();

// ---- shutdown countdown + "didn't restart", on a fake clock ----
for (const pb of [true, false]) {
  const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const p2 = await c2.newPage(); watch(p2);
  await p2.clock.install();
  const b2 = await powerRoute(p2, { ok: true, action: "shutdown", power_button: pb });
  await p2.goto("http://127.0.0.1:8099/index.html#home"); await p2.waitForTimeout(900);
  await openPower(p2); await p2.waitForTimeout(150); await p2.locator("#power-off").tap();
  d = await waitText(p2, /safe in 30 s/);
  ok(b2.length === 1 && b2[0].action === "shutdown", "shutdown sends {action: shutdown}: " + JSON.stringify(b2));
  ok(d.open && /Do NOT unplug yet: safe in 30 s/.test(d.msg) && !d.btns, "shutdown: countdown starts at 30 s, buttons hidden: " + d.msg);
  ok(pb ? /press the power button on the case/.test(d.msg) : /unplug the power, wait a few seconds/.test(d.msg),
    (pb ? "Pi 5" : "older Pi") + ": tells how to turn it back on: " + d.msg);
  await p2.keyboard.press("Escape"); await p2.waitForTimeout(100);
  ok((await dlg(p2)).open, "Esc can't close it while shutting down");
  if (pb) await p2.screenshot({ path: `${SHOTS}/power-shutting-down.png` });
  await p2.clock.runFor(31000);
  d = await waitText(p2, /Safe to unplug/);
  ok(/Safe to unplug/.test(d.title) && (pb ? /power button on the case/ : /unplug the power/).test(d.msg), "after 30 s: safe to unplug + how to turn it on: " + d.title + " / " + d.msg);
  await c2.close();
}
{
  const c3 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const p3 = await c3.newPage(); watch(p3);
  await p3.clock.install();
  await powerRoute(p3, { ok: true, action: "restart", power_button: true });
  await p3.goto("http://127.0.0.1:8099/index.html#home"); await p3.waitForTimeout(900);
  await openPower(p3); await p3.waitForTimeout(150); await p3.locator("#power-restart").tap();
  await waitText(p3, /Waiting for the Pi to go down/);   // the command went through and polling has started
  await p3.clock.fastForward(61000);                 // the Pi kept answering for a minute: it never went down
  d = await waitText(p3, /Still running/);
  ok(/Still running/.test(d.title) && d.btns, "restart that never happened: says so and gives the buttons back: " + d.title);
  await c3.close();
}

// ---- the Pi's 4.3" touch screen, 800x480 (kiosk) ----
const kctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const kpage = await kctx.newPage(); watch(kpage);
const kb = await powerRoute(kpage, { error: "should not be called" }, 500);
await kpage.goto("http://127.0.0.1:8099/?kiosk=1#home"); await kpage.waitForTimeout(900);
const hdr = await kpage.evaluate(() => [...document.querySelectorAll("#hdr-actions button")].map(b => { const r = b.getBoundingClientRect(); return { l: b.getAttribute("aria-label"), w: r.width, h: r.height, right: r.right }; }));
ok(hdr.length === 3 && hdr.every(b => b.w >= 40 && b.h >= 40 && b.right <= 800), "touch screen: 3 header icons, each >= 40x40 px, on screen: " + JSON.stringify(hdr));
await kpage.screenshot({ path: `${SHOTS}/power-kiosk-header.png` });
await openPower(kpage); await kpage.waitForTimeout(200);
const kf = await kpage.evaluate(() => {
  const r = document.querySelector("#power-dlg").getBoundingClientRect();
  const bs = [...document.querySelectorAll("#power-btns button")];
  return { inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, h: Math.round(r.height),
    textFits: bs.every(b => b.scrollWidth <= b.clientWidth + 1), minH: Math.min(...bs.map(b => b.getBoundingClientRect().height)),
    minW: Math.min(...bs.map(b => b.getBoundingClientRect().width)) };
});
ok(kf.inView && kf.textFits && kf.minH >= 48 && kf.minW >= 100, "touch screen: dialog fits 800x480, big buttons: " + JSON.stringify(kf));
await kpage.screenshot({ path: `${SHOTS}/power-kiosk-dialog.png` });
await kpage.locator("#power-cancel").tap(); await kpage.waitForTimeout(150);
ok(!(await dlg(kpage)).open && kb.length === 0, "touch screen: Cancel closes, nothing sent");
await kctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
