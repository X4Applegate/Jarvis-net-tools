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
const st = (page, id) => page.locator("#" + id).textContent();
const json = (b, s = 200) => ({ status: s, contentType: "application/json", body: JSON.stringify(b) });

// the shared mock's saved reports depend on which suites ran before: work with whatever is on top
const first = (await (await fetch("http://127.0.0.1:8099/api/reports")).json()).reports[0];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- the touch screen (800x480): share from Saved Reports ----
const ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
let drives = [];
const usbSaves = [], mails = [];
await page.route("**/api/usb", r => r.fulfill(json({ drives })));
await page.route("**/api/reports/usb", r => { const b = r.request().postDataJSON(); usbSaves.push(b);
  r.fulfill(json({ ok: true, copied: [b.name, b.name.replace(".html", ".pdf")], folder: "JarvisReports", label: "STICK", model: "SanDisk", unmounted: true })); });
await page.route("**/api/reports/email", r => { const b = r.request().postDataJSON(); mails.push(b);
  r.fulfill(b.to.includes("@") ? json({ ok: true, to: b.to.split(",").map(x => x.trim()) }) : json({ error: "check the To addresses" }, 400)); });
await page.goto("http://127.0.0.1:8099/?kiosk=1#settings"); await settle(page, 1000);
const btns = await page.$$eval("#rep-list .item button", bs => bs.map(b => b.textContent));
ok(btns.slice(0, 3).join() === "Open,Share,Delete", "Saved Reports rows: Open / Share / Delete: " + btns.join(","));
await page.locator("#rep-list .item").first().locator("button", { hasText: "Share" }).tap(); await settle(page, 700);
ok(await page.locator("#share-dlg").evaluate(d => d.open) && new RegExp(esc(first.site)).test(await st(page, "share-what")), "Share opens for that report: " + await st(page, "share-what"));
ok(/Plug in a USB stick/.test(await st(page, "share-usb-st")) && await page.locator("#share-usb-go").isDisabled(), "no stick: says to plug one in, Save disabled");
ok(/Set up email first/.test(await st(page, "share-mail-st")) && await page.locator("#share-mail-go").isDisabled(), "email not set up: points to Settings, Send disabled");
ok(!(await page.locator("#share-dl").isVisible()), "touch screen: no Download option (nowhere to download to)");
await page.screenshot({ path: `${SHOTS}/share-nothing.png` });
drives = [{ dev: "/dev/sda1", label: "STICK", size: 32015998976, fstype: "exfat", model: "SanDisk Ultra Fit" }];
await settle(page, 3500);                                       // plugged in while the dialog is open
ok(/Ready: STICK \(32 GB, exFAT\)/.test(await st(page, "share-usb-st")) && !(await page.locator("#share-usb-go").isDisabled()), "stick plugged in: picked up by itself: " + await st(page, "share-usb-st"));
await page.locator("#share-usb-go").tap(); await settle(page, 600);
ok(usbSaves.length === 1 && usbSaves[0].dev === "/dev/sda1" && usbSaves[0].name === first.name, "Save sends the report + stick: " + JSON.stringify(usbSaves));
ok(/✅ Saved to STICK in the JarvisReports folder/.test(await st(page, "share-usb-st")) && /Safe to unplug/.test(await st(page, "share-usb-st")), "saved: where, and safe to unplug");
await page.screenshot({ path: `${SHOTS}/share-usb.png` });
await page.locator("#share-close").tap(); await settle(page, 300);

// set up email in Settings, test it, then send a report
await page.locator("#mail-host").fill("mail.example.com"); await page.locator("#mail-sec").selectOption("ssl"); await settle(page, 100);
ok((await page.locator("#mail-port").inputValue()) === "465", "choosing SSL/TLS sets port 465");
await page.locator("#mail-user").fill("pi@example.com"); await page.locator("#mail-pass").fill("s3cret");
await page.locator("#mail-from").fill("pi@example.com"); await page.locator("#mail-to").fill("boss@example.com, me@example.com");
await page.locator("#mail-save").tap(); await settle(page, 700);
ok((await st(page, "mail-state")) === "ready" && (await page.locator("#mail-pass").inputValue()) === "" && /saved/.test(await page.locator("#mail-pass").getAttribute("placeholder")),
  "saved: ready, password field emptied and marked as saved");
await page.locator("#mail-test").tap(); await settle(page, 600);
ok(/Test email sent to boss@example.com, me@example.com/.test(await page.evaluate(() => [...document.querySelectorAll(".res-out, #out")].map(e => e.textContent).join())), "Send test reports where it went");
await page.locator("#rep-list .item").first().locator("button", { hasText: "Share" }).tap(); await settle(page, 700);
ok((await page.locator("#share-mail-to").inputValue()) === "boss@example.com, me@example.com" && !(await page.locator("#share-mail-go").isDisabled()), "email ready: To prefilled with the saved addresses");
await page.locator("#share-mail-to").fill("manager@example.com"); await page.locator("#share-mail-go").tap(); await settle(page, 600);
ok(mails.length === 1 && mails[0].to === "manager@example.com" && /✅ Sent to manager@example.com/.test(await st(page, "share-mail-st")), "Send emails it to the address typed: " + JSON.stringify(mails));
await page.locator("#share-mail-to").fill("nope"); await page.locator("#share-mail-go").tap(); await settle(page, 600);
ok(/❌ check the To addresses/.test(await st(page, "share-mail-st")), "a bad address: the error is shown");
await page.screenshot({ path: `${SHOTS}/share-ready.png` });
const fits = await page.evaluate(() => { const r = document.querySelector("#share-dlg").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; });
ok(fits, "touch screen: the Share dialog fits (scrolls inside if needed)");
await page.locator("#share-close").tap(); await settle(page, 300);

// the report viewer has Share too
await page.locator("#rep-list .item").first().locator("button", { hasText: "Open" }).tap(); await settle(page, 600);
await page.locator("#report-share").tap(); await settle(page, 600);
ok(!(await page.locator("#report-dlg").evaluate(d => d.open)) && await page.locator("#share-dlg").evaluate(d => d.open), "viewer > Share: the viewer closes, Share opens");
await page.locator("#share-close").tap(); await settle(page, 300);
await ctx.close();

// ---- a phone over the VPN: Download links are offered ----
const b2 = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--host-resolver-rules=MAP nettools.test 127.0.0.1"] });
const pctx = await b2.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const p2 = await pctx.newPage(); watch(p2);
await p2.route("**/api/usb", r => r.fulfill(json({ drives: [] })));
await p2.goto("http://nettools.test:8099/index.html#settings"); await settle(p2, 1000);
await p2.locator("#rep-list .item").first().locator("button", { hasText: "Share" }).tap(); await settle(p2, 700);
const dl = await p2.evaluate(() => ({ vis: !document.getElementById("share-dl").classList.contains("hidden"),
  pdf: document.getElementById("share-dl-pdf").getAttribute("href"), html: document.getElementById("share-dl-html").getAttribute("href") }));
ok(dl.vis && dl.pdf === "/api/reports/" + first.name.replace(".html", ".pdf") && dl.html === "/api/reports/" + first.name + "?download=1", "phone: Download PDF / HTML offered: " + JSON.stringify(dl));
await p2.screenshot({ path: `${SHOTS}/share-phone.png` });
await pctx.close(); await b2.close();

// put the shared mock's email settings back (later suites expect "not set up")
await fetch("http://127.0.0.1:8099/api/mail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: "", from: "", to: "" }) });

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
